// Импортируем весь API расширений VSCode под псевдонимом vscode
import * as vscode from 'vscode';
// Импортируем стандартный модуль Node.js для работы с путями к файлам
import * as path from 'path';

// ── Словарь типов ссылок ──────────────────────────────────────────────────────

// Тип-объединение: перечисляет все возможные виды ссылки на символ
export type ReferenceKind =
  | 'Definition'      // место, где символ объявлен с телом (функция, класс и т.д.)
  | 'Implementation'  // конкретная реализация интерфейса или абстрактного метода
  | 'Declaration'     // объявление без тела (forward-declaration, заголовочный файл)
  | 'TypeDefinition'  // место, где определён тип символа
  | 'Read'            // чтение значения символа
  | 'Write'           // запись / изменение значения символа
  | 'Reference';      // любое другое использование (запасной вариант)

// Массив приоритетов: чем меньше индекс — тем важнее тип.
// Используется при слиянии результатов от разных провайдеров языка:
// если одна позиция попала и в Definition, и в Reference — побеждает Definition.
export const KIND_PRIORITY: ReferenceKind[] = [
  'Definition',      // приоритет 0 — самый высокий
  'Implementation',  // приоритет 1
  'Declaration',     // приоритет 2
  'TypeDefinition',  // приоритет 3
  'Read',            // приоритет 4
  'Write',           // приоритет 5
  'Reference',       // приоритет 6 — самый низкий (запасной)
];

// Короткие метки для отображения в колонке «тип» дерева
export const KIND_LABELS: Record<ReferenceKind, string> = {
  Definition:     'Def',     // сокращение для Definition
  Implementation: 'Impl',   // сокращение для Implementation
  Declaration:    'Decl',   // сокращение для Declaration
  TypeDefinition: 'TypeDef',// сокращение для TypeDefinition
  Read:           'Read',   // оставляем как есть — достаточно коротко
  Write:          'Write',  // оставляем как есть
  Reference:      'Ref',    // сокращение для Reference
};

// Идентификаторы иконок из набора Codicon (встроенные иконки VSCode)
export const KIND_ICONS: Record<ReferenceKind, string> = {
  Definition:     'symbol-method',    // иконка метода — визуально означает «тело функции»
  Implementation: 'arrow-right',      // стрелка вправо — «следует из интерфейса»
  Declaration:    'symbol-interface', // иконка интерфейса — объявление без реализации
  TypeDefinition: 'symbol-class',     // иконка класса — описание типа
  Read:           'eye',              // глаз — только чтение, наблюдение
  Write:          'edit',             // карандаш — запись, изменение
  Reference:      'references',       // стандартная иконка ссылки
};

// Идентификаторы цветов из встроенной палитры charts.* (работает во всех темах VSCode)
export const KIND_COLORS: Record<ReferenceKind, string> = {
  Definition:     'charts.blue',    // синий — определение (главная точка входа)
  Implementation: 'charts.green',   // зелёный — реализация
  Declaration:    'charts.purple',  // фиолетовый — объявление
  TypeDefinition: 'charts.orange',  // оранжевый — тип
  Read:           'charts.yellow',  // жёлтый — чтение
  Write:          'charts.red',     // красный — запись (изменение, потенциально опасно)
  Reference:      'foreground',     // цвет текста по умолчанию — нейтральная ссылка
};

// ── Модель данных ─────────────────────────────────────────────────────────────

// Одна найденная ссылка на символ после обработки и классификации
export interface ResolvedReference {
  uri: vscode.Uri;        // URI файла, в котором найдена ссылка
  range: vscode.Range;    // диапазон (строка:колонка начала — строка:колонка конца)
  kind: ReferenceKind;    // тип ссылки (Definition, Read, Write и т.д.)
  snippet: string;        // текст строки кода, обрезанный слева от пробелов (для отображения)
  snippetIndent: number;  // кол-во пробельных символов, обрезанных слева — нужно для точной подсветки
}

// Группа ссылок, находящихся в одном файле (соответствует узлу-файлу в дереве)
export interface FileGroup {
  uri: vscode.Uri;                  // URI файла
  relativePath: string;             // относительный путь от корня рабочего пространства
  references: ResolvedReference[];  // все ссылки внутри этого файла
}

// Дискриминированное объединение узлов дерева:
// либо узел-файл (верхний уровень), либо узел-ссылка (дочерний)
export type TreeNode =
  | { type: 'file';      data: FileGroup }          // узел верхнего уровня — файл
  | { type: 'reference'; data: ResolvedReference }; // дочерний узел — конкретная ссылка

// ── Вспомогательные функции ───────────────────────────────────────────────────

// Возвращает путь к файлу относительно корня рабочего пространства.
// Если файл находится вне рабочего пространства — возвращает только имя файла.
export function makeRelativePath(uri: vscode.Uri): string {
  // Получаем список всех открытых папок рабочего пространства
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    // Перебираем каждую папку рабочего пространства
    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath; // абсолютный путь папки рабочего пространства
      const filePath   = uri.fsPath;        // абсолютный путь искомого файла
      // Проверяем, находится ли файл внутри данной папки рабочего пространства
      if (filePath.startsWith(folderPath)) {
        // Вычисляем относительный путь и заменяем обратные слэши на прямые (для Windows)
        return path.relative(folderPath, filePath).replace(/\\/g, '/');
      }
    }
  }
  // Файл вне рабочего пространства — возвращаем только имя файла без пути
  return path.basename(uri.fsPath);
}
