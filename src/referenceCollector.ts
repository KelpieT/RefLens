// Импортируем API VSCode
import * as vscode from 'vscode';
// Импортируем типы и константы из модели данных
import {
  ResolvedReference, // интерфейс одной обработанной ссылки
  FileGroup,         // интерфейс группы ссылок одного файла
  ReferenceKind,     // тип-объединение всех видов ссылок
  KIND_PRIORITY,     // массив приоритетов для разрешения конфликтов
  makeRelativePath,  // функция для построения относительного пути
} from './referenceNode';

// ── Вспомогательные функции ───────────────────────────────────────────────────

// Строит уникальный строковый ключ для позиции в файле.
// Используется как ключ Map, чтобы дедублировать одинаковые позиции
// из разных провайдеров (например, Definition и Reference на одной строке).
function locationKey(uri: vscode.Uri, position: vscode.Position): string {
  // Формат: "file:///path/to/file.ts#10:5" (URI + номер строки + номер колонки)
  return `${uri.toString()}#${position.line}:${position.character}`;
}

// Форма «сырого» объекта Location, которую возвращает executeCommand.
// VSCode возвращает простые объекты, а не экземпляры класса vscode.Location,
// поэтому мы описываем ожидаемую форму вручную.
interface RawLocation {
  uri: vscode.Uri; // URI файла
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

// Универсальная обёртка для вызова любого языкового провайдера через executeCommand.
// Возвращает пустой массив вместо исключения, если провайдер недоступен.
async function runProvider(
  command: string,           // идентификатор команды VSCode (например 'vscode.executeDefinitionProvider')
  uri: vscode.Uri,           // URI файла, в котором стоит курсор
  position: vscode.Position  // позиция курсора в файле
): Promise<vscode.Location[]> {
  try {
    // Вызываем встроенную команду VSCode и ожидаем массив Location или null
    const result = await vscode.commands.executeCommand<(vscode.Location | RawLocation)[] | null | undefined>(
      command, uri, position
    );
    // Если провайдер вернул null/undefined или не массив — возвращаем пустой массив
    if (!result || !Array.isArray(result)) { return []; }
    // Нормализуем каждый элемент: если это уже экземпляр vscode.Location — оставляем,
    // иначе создаём новый экземпляр из «сырого» объекта
    return result.map(loc => {
      if (loc instanceof vscode.Location) { return loc; } // уже правильный тип
      const raw = loc as RawLocation; // приводим к сырой форме
      return new vscode.Location(     // создаём настоящий экземпляр Location
        raw.uri,
        new vscode.Range(
          new vscode.Position(raw.range.start.line, raw.range.start.character), // начало диапазона
          new vscode.Position(raw.range.end.line,   raw.range.end.character)    // конец диапазона
        )
      );
    });
  } catch {
    // Провайдер бросил исключение (например, не поддерживается для данного языка) — игнорируем
    return [];
  }
}

// Форма «сырого» объекта DocumentHighlight, возвращаемого executeDocumentHighlights.
// kind: 0=Text (нейтральный), 1=Read (чтение), 2=Write (запись)
interface RawHighlight {
  range: { start: { line: number; character: number } }; // позиция подсветки
  kind?: number; // тип подсветки (0/1/2), может отсутствовать
}

// Запрашивает подсветку символа в ТЕКУЩЕМ файле через провайдер DocumentHighlights.
// Это единственный способ получить Read/Write для символов в том же файле.
// Возвращает Map: ключ позиции → тип Read или Write (Text и нейтральные пропускаем).
async function getDocumentHighlights(
  uri: vscode.Uri,           // URI текущего файла
  position: vscode.Position  // позиция курсора
): Promise<Map<string, ReferenceKind>> {
  const kindMap = new Map<string, ReferenceKind>(); // пустая карта — вернём если провайдер недоступен
  try {
    // Запрашиваем подсветки документа для позиции курсора
    const highlights = await vscode.commands.executeCommand<RawHighlight[] | null | undefined>(
      'vscode.executeDocumentHighlights', uri, position
    );
    if (!highlights) { return kindMap; } // провайдер ничего не вернул
    for (const h of highlights) {
      // Переводим числовой kind в наш ReferenceKind
      const kind: ReferenceKind =
        h.kind === 2 ? 'Write' :  // 2 = запись значения
        h.kind === 1 ? 'Read'  :  // 1 = чтение значения
        'Reference';              // 0 или undefined = нейтральное использование
      // Сохраняем только Read и Write — нейтральные нам не нужны здесь
      if (kind === 'Read' || kind === 'Write') {
        kindMap.set(
          locationKey(uri, new vscode.Position(h.range.start.line, h.range.start.character)),
          kind
        );
      }
    }
  } catch { /* провайдер отсутствует для данного языка — не страшно */ }
  return kindMap;
}

// Запускает массив промисов параллельно с общим таймаутом.
// Если таймаут срабатывает раньше — возвращает пустой массив вместо результатов.
// Незавершённые задачи продолжают работать в фоне, но их результаты игнорируются.
async function allWithTimeout<T>(tasks: Promise<T>[], timeoutMs: number): Promise<T[]> {
  const timeout = new Promise<T[]>(resolve => setTimeout(() => resolve([]), timeoutMs));
  return Promise.race([Promise.all(tasks), timeout]);
}

// ── Извлечение сниппета (строки кода) ────────────────────────────────────────

// Результат чтения сниппета: текст строки и кол-во обрезанных слева символов.
// indent нужен, чтобы вычислить точную позицию символа внутри обрезанного текста.
interface SnippetResult { text: string; indent: number; }

// Читает текст строки из файла для отображения рядом с ссылкой.
// Возвращает обрезанный текст и длину удалённого отступа слева.
// Сначала ищет уже открытый документ в памяти VSCode — это быстро и бесплатно.
// Если документ не открыт — открывает файл с диска (VSCode кэширует его).
async function readSnippet(
  uri: vscode.Uri, // URI файла
  line: number,    // номер строки (0-based)
  maxLen: number   // максимальная длина сниппета в символах
): Promise<SnippetResult> {
  try {
    // Ищем документ среди уже открытых в редакторе (нет I/O)
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    // Если не найден — открываем с диска (VSCode кэширует результат)
    const doc    = openDoc ?? await vscode.workspace.openTextDocument(uri);
    const raw    = doc.lineAt(line).text;             // оригинальная строка с отступом
    const ltrim  = raw.trimStart();                   // убираем только левый отступ
    const indent = raw.length - ltrim.length;         // кол-во обрезанных слева символов
    const text   = ltrim.trimEnd();                   // убираем правые пробелы
    // Обрезаем строку, если она длиннее maxLen, добавляем многоточие
    return { text: text.length <= maxLen ? text : text.slice(0, maxLen - 1) + '…', indent };
  } catch {
    // Файл недоступен (удалён, бинарный и т.д.) — возвращаем пустой результат
    return { text: '', indent: 0 };
  }
}

// ── Публичный API ─────────────────────────────────────────────────────────────

// Результат, который collectReferences возвращает вызывающему коду
export interface CollectorResult {
  fileGroups:  FileGroup[];    // все ссылки, сгруппированные по файлам
  totalCount:  number;         // общее количество найденных ссылок
  symbolName:  string;         // имя символа под курсором (для заголовка панели)
  sourceUri:   vscode.Uri;     // URI файла, в котором был курсор при запуске поиска
}

// Главная функция: собирает все ссылки на символ под курсором.
// Параллельно вызывает все языковые провайдеры, затем объединяет и классифицирует результаты.
export async function collectReferences(
  document: vscode.TextDocument,    // открытый документ, в котором стоит курсор
  position: vscode.Position,        // позиция курсора
  token: vscode.CancellationToken   // токен отмены — позволяет прервать поиск при движении курсора
): Promise<CollectorResult> {

  // Определяем диапазон слова под курсором и извлекаем его текст как имя символа
  const wordRange  = document.getWordRangeAtPosition(position);
  const symbolName = wordRange ? document.getText(wordRange) : '<unknown>';
  // Читаем настройку максимальной длины сниппета (по умолчанию 120 символов)
  const maxLen     = vscode.workspace.getConfiguration('reflens').get<number>('maxSnippetLength', 120);

  // Параллельно запускаем все 6 провайдеров — не ждём каждый по очереди.
  // Promise.all завершится, когда ответят все (или вернут пустой массив при ошибке).
  const [allRefs, defs, impls, decls, typeDefs, highlights] = await Promise.all([
    runProvider('vscode.executeReferenceProvider',      document.uri, position), // все ссылки (без типа)
    runProvider('vscode.executeDefinitionProvider',     document.uri, position), // определения
    runProvider('vscode.executeImplementationProvider', document.uri, position), // реализации
    runProvider('vscode.executeDeclarationProvider',    document.uri, position), // объявления
    runProvider('vscode.executeTypeDefinitionProvider', document.uri, position), // определения типа
    getDocumentHighlights(document.uri, position),                               // Read/Write в текущем файле
  ]);

  // Проверяем отмену сразу после завершения провайдеров — пользователь мог переместить курсор
  if (token.isCancellationRequested) {
    return { fileGroups: [], totalCount: 0, symbolName, sourceUri: document.uri };
  }

  // Строим карту: ключ позиции → тип ссылки с учётом приоритета.
  // Если одна позиция вернулась из нескольких провайдеров — победит тот, у кого меньше индекс в KIND_PRIORITY.
  const kindMap = new Map<string, ReferenceKind>();

  // Вспомогательная функция: записывает тип в kindMap только если он важнее уже записанного
  function assignIfHigherPriority(locs: vscode.Location[], kind: ReferenceKind): void {
    const newPri = KIND_PRIORITY.indexOf(kind); // индекс нового типа в массиве приоритетов
    for (const loc of locs) {
      const key = locationKey(loc.uri, loc.range.start); // уникальный ключ позиции
      const existing = kindMap.get(key);                  // уже записанный тип (если есть)
      // Записываем, если позиция ещё не занята или новый тип важнее существующего
      if (existing === undefined || newPri < KIND_PRIORITY.indexOf(existing)) {
        kindMap.set(key, kind);
      }
    }
  }

  // Применяем провайдеры в порядке убывания приоритета (Definition первым)
  assignIfHigherPriority(defs,     'Definition');      // определения — наивысший приоритет
  assignIfHigherPriority(impls,    'Implementation');  // реализации
  assignIfHigherPriority(decls,    'Declaration');     // объявления
  assignIfHigherPriority(typeDefs, 'TypeDefinition');  // определения типов

  // Применяем Read/Write из DocumentHighlights (работают только для текущего файла)
  for (const [key, kind] of highlights) {
    const existing = kindMap.get(key);
    // Записываем только если Read/Write важнее уже записанного типа
    if (existing === undefined || KIND_PRIORITY.indexOf(kind) < KIND_PRIORITY.indexOf(existing)) {
      kindMap.set(key, kind);
    }
  }

  // Все позиции из allRefs, не попавшие ни в один типизированный провайдер, получают тип Reference
  for (const loc of allRefs) {
    const key = locationKey(loc.uri, loc.range.start);
    if (!kindMap.has(key)) {
      kindMap.set(key, 'Reference'); // запасной тип — просто ссылка
    }
  }

  // ── Read/Write для ссылок в других файлах ────────────────────────────────
  // executeDocumentHighlights работает для любого URI, не только текущего документа.
  // Для каждого файла (кроме текущего), где есть ссылки с типом Reference,
  // передаём позицию первой такой ссылки — провайдер вернёт Read/Write по всему файлу.
  // Все запросы идут параллельно; общий таймаут 5 с не блокирует основной результат.
  if (!token.isCancellationRequested) {
    // Собираем уникальные чужие URI и позицию первой Reference-ссылки в каждом
    const foreignFileMap = new Map<string, vscode.Position>();
    for (const loc of allRefs) {
      const uriStr = loc.uri.toString();
      if (uriStr === document.uri.toString()) { continue; } // текущий файл уже обработан
      const key = locationKey(loc.uri, loc.range.start);
      if (kindMap.get(key) === 'Reference' && !foreignFileMap.has(uriStr)) {
        foreignFileMap.set(uriStr, loc.range.start); // первая Reference-позиция в файле
      }
    }

    if (foreignFileMap.size > 0) {
      // Параллельно запрашиваем highlights для каждого чужого файла (таймаут 5 с)
      const tasks = Array.from(foreignFileMap.entries()).map(([uriStr, pos]) =>
        getDocumentHighlights(vscode.Uri.parse(uriStr), pos)
      );
      const hwMaps = await allWithTimeout(tasks, 5000);

      // Применяем результаты: повышаем Reference → Read/Write там, где возможно
      for (const hwMap of hwMaps) {
        for (const [key, kind] of hwMap) {
          if (kindMap.get(key) === 'Reference') {
            kindMap.set(key, kind); // Read или Write важнее Reference
          }
        }
      }
    }
  }

  // Дедублируем: собираем все позиции без повторов.
  // Сначала идут ссылки из allRefs (сохраняем исходный порядок),
  // затем позиции из типизированных провайдеров, которых не было в allRefs (редко, но возможно).
  const seenKeys = new Set<string>();                                                          // уже добавленные ключи
  const allLocations: Array<{ uri: vscode.Uri; range: vscode.Range; kind: ReferenceKind }> = []; // итоговый список

  for (const loc of [...allRefs, ...defs, ...impls, ...decls, ...typeDefs]) {
    const key = locationKey(loc.uri, loc.range.start);
    if (!seenKeys.has(key)) {                           // пропускаем дубликаты
      seenKeys.add(key);                                // запоминаем ключ
      allLocations.push({
        uri:   loc.uri,
        range: loc.range,
        kind:  kindMap.get(key) ?? 'Reference',         // берём тип из карты (или Reference по умолчанию)
      });
    }
  }

  // Снова проверяем отмену перед медленной операцией чтения файлов
  if (token.isCancellationRequested) {
    return { fileGroups: [], totalCount: 0, symbolName, sourceUri: document.uri };
  }

  // Параллельно читаем строки кода для всех найденных позиций
  const resolved: ResolvedReference[] = await Promise.all(
    allLocations.map(async loc => {
      const sr = await readSnippet(loc.uri, loc.range.start.line, maxLen);
      return {
        uri:           loc.uri,
        range:         loc.range,
        kind:          loc.kind,
        snippet:       sr.text,    // текст строки без отступа
        snippetIndent: sr.indent,  // кол-во обрезанных слева символов
      };
    })
  );

  // Группируем ссылки по файлам: ключ Map = строковый URI файла
  const groupMap = new Map<string, FileGroup>();
  for (const ref of resolved) {
    const key = ref.uri.toString(); // уникальный ключ файла
    if (!groupMap.has(key)) {
      // Первая ссылка из этого файла — создаём новую группу
      groupMap.set(key, { uri: ref.uri, relativePath: makeRelativePath(ref.uri), references: [] });
    }
    groupMap.get(key)!.references.push(ref); // добавляем ссылку в группу файла
  }

  // Сортируем группы: файлы с большим количеством ссылок — вверху списка
  const fileGroups = [...groupMap.values()].sort((a, b) => b.references.length - a.references.length);
  for (const group of fileGroups) {
    // Внутри каждого файла сортируем ссылки по номеру строки (по возрастанию)
    group.references.sort((a, b) => a.range.start.line - b.range.start.line);
  }

  return { fileGroups, totalCount: resolved.length, symbolName, sourceUri: document.uri };
}
