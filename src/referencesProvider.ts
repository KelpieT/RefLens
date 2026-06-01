// Импортируем API расширений VSCode
import * as vscode from 'vscode';
// Импортируем типы и таблицы констант из модели данных
import {
  TreeNode,          // дискриминированное объединение узлов дерева (файл | ссылка)
  FileGroup,         // группа ссылок одного файла
  ResolvedReference, // одна обработанная ссылка с типом и сниппетом
  KIND_LABELS,       // короткие текстовые метки типов (Def, Ref и т.д.)
  KIND_ICONS,        // идентификаторы иконок Codicon для каждого типа
  KIND_COLORS,       // идентификаторы цветов темы для каждого типа
} from './referenceNode';
// Импортируем тип результата сборщика ссылок
import { CollectorResult } from './referenceCollector';

// URI-заглушка для узла загрузки — используем несуществующую схему,
// чтобы отличить его от реальных файлов при сравнении
const LOADING_URI = vscode.Uri.parse('myreferences://loading');

// Объект-заглушка ResolvedReference, отображаемый пока идёт поиск.
// Имеет пустой диапазон и специальный URI — по нему мы его распознаём в _makeReferenceItem.
const LOADING_REF: ResolvedReference = {
  uri:     LOADING_URI,              // фиктивный URI — не указывает на реальный файл
  range:   new vscode.Range(0, 0, 0, 0), // нулевой диапазон (строка 0, колонка 0)
  kind:    'Reference',              // тип не важен для заглушки
  snippet: 'Searching…',            // текст, который будет показан в дереве
};

// Класс провайдера данных дерева — реализует интерфейс VSCode TreeDataProvider.
// Именно этот класс VSCode вызывает, чтобы получить узлы для отображения в панели.
export class ReferencesProvider implements vscode.TreeDataProvider<TreeNode> {

  // ── Внутреннее состояние ──────────────────────────────────────────────────

  private _fileGroups: FileGroup[] = []; // текущие группы файлов с найденными ссылками
  private _symbolName  = '';             // имя символа, по которому шёл поиск
  private _totalCount  = 0;             // общее количество найденных ссылок
  private _isLoading   = false;         // true пока идёт поиск — показываем спиннер

  // EventEmitter используется для уведомления VSCode о том, что данные изменились
  // и дерево нужно перерисовать. undefined/null/void = обновить всё дерево целиком.
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TreeNode | undefined | null | void>();
  // Публичное событие — VSCode подписывается на него автоматически через интерфейс TreeDataProvider
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // ── Публичный API ─────────────────────────────────────────────────────────

  // Вызывается из extension.ts после успешного завершения сбора ссылок.
  // Сохраняет результаты и перерисовывает дерево.
  setResults(result: CollectorResult): void {
    this._fileGroups = result.fileGroups; // сохраняем группы файлов
    this._symbolName = result.symbolName; // сохраняем имя найденного символа
    this._totalCount = result.totalCount; // сохраняем общее количество ссылок
    this._isLoading  = false;             // поиск завершён — скрываем спиннер
    this._onDidChangeTreeData.fire();     // сообщаем VSCode: перерисуй дерево
  }

  // Вызывается в момент запуска поиска — до получения результатов.
  // Очищает дерево и показывает анимацию загрузки.
  setLoading(symbolName: string): void {
    this._fileGroups = [];            // убираем старые результаты
    this._symbolName = symbolName;    // сохраняем имя символа для заголовка панели
    this._totalCount = 0;             // сбрасываем счётчик
    this._isLoading  = true;          // включаем режим загрузки
    this._onDidChangeTreeData.fire(); // перерисовываем дерево (покажется спиннер)
  }

  // Вызывается командой «Очистить» — сбрасывает всё состояние.
  clear(): void {
    this._fileGroups = [];            // очищаем список файлов
    this._symbolName = '';            // сбрасываем имя символа
    this._totalCount = 0;             // сбрасываем счётчик
    this._isLoading  = false;         // выключаем режим загрузки
    this._onDidChangeTreeData.fire(); // перерисовываем пустое дерево
  }

  // Формирует строку заголовка панели в зависимости от текущего состояния.
  // Заголовок отображается в верхней части сайдбара над деревом.
  getTitle(): string {
    if (this._isLoading)        { return `References — searching "${this._symbolName}"…`; } // идёт поиск
    if (!this._symbolName)      { return 'References'; }                                     // ничего не искали
    if (this._totalCount === 0) { return `References — "${this._symbolName}" (none)`; }      // ничего не найдено
    return `References — "${this._symbolName}" (${this._totalCount})`;                       // найдено N ссылок
  }

  // ── Реализация интерфейса TreeDataProvider ────────────────────────────────

  // VSCode вызывает этот метод для каждого узла, чтобы получить объект TreeItem для отображения.
  // element — узел из нашего массива (файл или ссылка).
  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.type === 'file'
      ? this._makeFileItem(element.data)      // узел верхнего уровня — файл
      : this._makeReferenceItem(element.data); // дочерний узел — конкретная ссылка
  }

  // VSCode вызывает этот метод, чтобы получить дочерние узлы.
  // element === undefined означает запрос корневых узлов (верхний уровень дерева).
  getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    if (!element) {
      // Корневой уровень: либо показываем спиннер, либо список файлов
      if (this._isLoading) {
        return [{ type: 'reference', data: LOADING_REF }]; // один узел-заглушка с анимацией
      }
      // Оборачиваем каждую FileGroup в узел типа 'file'
      return this._fileGroups.map(fg => ({ type: 'file', data: fg } as TreeNode));
    }
    if (element.type === 'file') {
      // Дочерние узлы файла — все ссылки внутри него, обёрнутые в узлы типа 'reference'
      return element.data.references.map(ref => ({ type: 'reference', data: ref } as TreeNode));
    }
    // Узлы-ссылки не имеют дочерних элементов
    return [];
  }

  // ── Построители TreeItem ──────────────────────────────────────────────────

  // Создаёт TreeItem для узла-файла (верхний уровень дерева).
  private _makeFileItem(fg: FileGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(
      fg.relativePath, // текст узла — относительный путь к файлу
      fg.references.length <= 20
        ? vscode.TreeItemCollapsibleState.Expanded  // ≤20 ссылок — раскрываем сразу
        : vscode.TreeItemCollapsibleState.Collapsed // >20 ссылок — сворачиваем, чтобы не перегружать UI
    );
    const count = fg.references.length; // количество ссылок в этом файле
    // Текст справа от имени файла — количество ссылок (менее заметный цвет)
    item.description  = `${count} reference${count !== 1 ? 's' : ''}`;
    // Всплывающая подсказка при наведении — показывает полный путь и количество
    item.tooltip      = new vscode.MarkdownString(`**${fg.relativePath}**\n\n${fg.uri.fsPath}\n\n${count} reference(s)`);
    // resourceUri позволяет VSCode применить иконку из активной темы файловых иконок
    item.resourceUri  = fg.uri;
    // Используем стандартную иконку файла из темы
    item.iconPath     = vscode.ThemeIcon.File;
    // contextValue позволяет привязывать команды меню только к узлам-файлам через when-clause
    item.contextValue = 'myreferences.fileNode';
    return item;
  }

  // Создаёт TreeItem для узла-ссылки (дочерний уровень дерева).
  private _makeReferenceItem(ref: ResolvedReference): vscode.TreeItem {
    // Проверяем: это заглушка загрузки (специальный URI) — показываем спиннер
    if (ref.uri.toString() === LOADING_URI.toString()) {
      const item = new vscode.TreeItem('Searching…'); // текст узла
      item.iconPath = new vscode.ThemeIcon('loading~spin'); // анимированная иконка загрузки
      return item;
    }

    const line      = ref.range.start.line + 1;      // переводим из 0-based в 1-based для отображения
    const col       = ref.range.start.character + 1; // аналогично для колонки
    const kindLabel = KIND_LABELS[ref.kind];          // короткая метка типа: "Def", "Read" и т.д.
    const sep       = '\t';                           // разделитель между Kind и сниппетом (2 пробела)
    const full      = sep + kindLabel + sep + ref.snippet;  // итоговая строка: "Def  const foo = bar()"

    // Строим массив диапазонов highlights:
    //   [sep.length, sep.length + kindLabel.length] — выделяет Kind (после первого таба)
    //   + вхождения символа в сниппете, начиная с позиции после второго таба
    // Выделяем только вхождения искомого символа в сниппете (Kind не выделяем)
    const symbolRanges = highlightOccurrences(full, sep.length + kindLabel.length + sep.length, this._symbolName);

    const item = new vscode.TreeItem(
      {
        label:      full,         // "\tDef\tconst foo = bar()"
        highlights: symbolRanges, // только диапазоны символа в сниппете
      },
      vscode.TreeItemCollapsibleState.None // узел-ссылка не раскрывается
    );

    // Правая колонка — строка:колонка (description отображается справа, тусклее)
    item.description  = `${line}:${col}`;
    // Всплывающая подсказка с полным названием типа и сниппетом в блоке кода
    item.tooltip      = new vscode.MarkdownString(
      `**${ref.kind}** — line ${line}, col ${col}\n\n\`\`\`\n${ref.snippet}\n\`\`\``
    );
    // Иконка с цветом, соответствующим типу ссылки (синий=Def, красный=Write и т.д.)
    item.iconPath     = new vscode.ThemeIcon(KIND_ICONS[ref.kind], new vscode.ThemeColor(KIND_COLORS[ref.kind]));
    // contextValue для привязки команд меню только к узлам-ссылкам
    item.contextValue = 'myreferences.referenceNode';
    // При клике на узел — открываем файл и перемещаем курсор к данной ссылке
    item.command      = {
      command:   'vscode.open',       // встроенная команда VSCode «открыть файл»
      title:     'Go to Reference',   // подпись команды (отображается в Command Palette)
      arguments: [
        ref.uri,                      // URI файла для открытия
        {
          selection:     ref.range,   // выделяем диапазон ссылки в редакторе
          preserveFocus: true,        // не переключаем фокус с панели на редактор
          preview:       true,        // открываем в режиме превью (курсивный заголовок вкладки)
        } as vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }
}

// ── Вспомогательная функция подсветки ────────────────────────────────────────

// Находит все вхождения строки symbol в строке text начиная с позиции searchFrom.
// Возвращает массив пар [начало, конец] — формат, который принимает TreeItemLabel.highlights.
// searchFrom используется для пропуска префикса "15:3  " — чтобы не подсвечивать цифры.
function highlightOccurrences(
  text: string,       // полная строка label (префикс + сниппет)
  searchFrom: number, // индекс символа, с которого начинать поиск (длина префикса)
  symbol: string      // искомое слово (имя символа под курсором)
): [number, number][] {
  if (!symbol) { return []; } // если символ пустой — нечего подсвечивать
  const ranges: [number, number][] = []; // накапливаем найденные диапазоны
  let idx = searchFrom; // начинаем поиск после префикса "15:3  "
  while (idx < text.length) {
    const found = text.indexOf(symbol, idx); // ищем следующее вхождение символа
    if (found === -1) { break; }             // вхождений больше нет — выходим из цикла
    ranges.push([found, found + symbol.length]); // запоминаем диапазон [начало, конец]
    idx = found + symbol.length;                 // сдвигаемся за найденное вхождение
  }
  return ranges; // возвращаем все найденные диапазоны для подсветки
}
