import * as vscode from 'vscode';
import { CollectorResult } from './referenceCollector';
import { ReferenceKind } from './referenceNode';

// ── Сериализуемые типы ────────────────────────────────────────────────────────

interface SerialRef {
  uriString:     string;
  startLine:     number;
  startChar:     number;
  endLine:       number;
  endChar:       number;
  kind:          ReferenceKind;
  snippet:       string;
  snippetIndent: number; // кол-во пробелов, обрезанных слева — для точной позиции подсветки
}

interface SerialGroup {
  relativePath: string;
  references:   SerialRef[];
}

interface SerialResult {
  symbolName:  string;
  totalCount:  number;
  fileGroups:  SerialGroup[];
  sourceFile:  string;   // URI файла, в котором был курсор — выводится первым в списке
}

// ── История поиска ────────────────────────────────────────────────────────────

// Одна запись в истории поиска
interface HistoryEntry {
  id:          string;       // уникальный идентификатор (строка временной метки)
  symbolName:  string;       // имя найденного символа
  totalCount:  number;       // количество найденных ссылок
  timestamp:   number;       // время поиска в мс (Date.now())
  data:        SerialResult; // полный результат для восстановления
}

// Максимальное число записей в истории (без пинов)
const HISTORY_MAX = 50;

// Ключи для хранения в globalState
const STORAGE_HISTORY = 'reflens.history';
const STORAGE_PINS    = 'reflens.pins';

type WebviewMsg =
  | { type: 'results';     data: SerialResult }
  | { type: 'loading';     symbolName: string }
  | { type: 'clear' }
  | { type: 'historyData'; entries: HistoryEntry[]; pins: string[] };

// ── Провайдер ─────────────────────────────────────────────────────────────────

export class ReferencesWebviewProvider implements vscode.WebviewViewProvider {

  static readonly viewType = 'reflens.resultsView';

  private _view?: vscode.WebviewView;
  private _lastMsg: WebviewMsg = { type: 'clear' };

  // Контекст расширения — нужен для доступа к globalState (история и пины)
  constructor(private readonly _ctx: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveCtx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();
    this._post(this._lastMsg);
    this._postHistory(); // отправляем историю и пины сразу после открытия панели

    webviewView.webview.onDidReceiveMessage((msg: {
      type: string;
      id?: string;
      uriString?: string;
      startLine?: number; startChar?: number;
      endLine?:   number; endChar?:   number;
    }) => {
      if (msg.type === 'openFile') {
        const uri   = vscode.Uri.parse(msg.uriString!);
        const range = new vscode.Range(msg.startLine!, msg.startChar!, msg.endLine!, msg.endChar!);
        vscode.window.showTextDocument(uri, { selection: range, preserveFocus: false, preview: true });
        return;
      }
      if (msg.type === 'addPin' && msg.id) {
        const pins = this._loadPins();
        if (!pins.includes(msg.id)) { pins.unshift(msg.id); } // пин добавляется в начало
        this._ctx.globalState.update(STORAGE_PINS, pins);
        this._postHistory();
        return;
      }
      if (msg.type === 'removePin' && msg.id) {
        const pins = this._loadPins().filter(p => p !== msg.id);
        this._ctx.globalState.update(STORAGE_PINS, pins);
        this._postHistory();
        return;
      }
      if (msg.type === 'clearHistory') {
        // Удаляем записи истории, которые не запинованы
        const pins    = this._loadPins();
        const history = this._loadHistory().filter(e => pins.includes(e.id));
        this._ctx.globalState.update(STORAGE_HISTORY, history);
        this._postHistory();
        return;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._post(this._lastMsg);
        this._postHistory();
      }
    });
  }

  // Читает историю из globalState (массив записей, сортированный от новых к старым)
  private _loadHistory(): HistoryEntry[] {
    return this._ctx.globalState.get<HistoryEntry[]>(STORAGE_HISTORY, []);
  }

  // Читает список ID пинов из globalState
  private _loadPins(): string[] {
    return this._ctx.globalState.get<string[]>(STORAGE_PINS, []);
  }

  // Отправляет текущую историю и пины в webview
  private _postHistory(): void {
    const entries = this._loadHistory();
    const pins    = this._loadPins();
    this._view?.webview.postMessage({ type: 'historyData', entries, pins });
  }

  // Добавляет новую запись в историю и сохраняет в globalState
  private _addToHistory(data: SerialResult): void {
    const entry: HistoryEntry = {
      id:         Date.now().toString(),
      symbolName: data.symbolName,
      totalCount: data.totalCount,
      timestamp:  Date.now(),
      data,
    };
    const history = this._loadHistory();
    // Удаляем предыдущий поиск того же символа из того же файла — не дублируем
    const filtered = history.filter(e =>
      !(e.symbolName === entry.symbolName && e.data.sourceFile === entry.data.sourceFile)
    );
    filtered.unshift(entry); // новая запись — в начало списка
    // Ограничиваем размер: сохраняем пины в любом случае, остальные — до HISTORY_MAX
    const pins      = this._loadPins();
    const pinSet    = new Set(pins);
    const pinned    = filtered.filter(e => pinSet.has(e.id));
    const unpinned  = filtered.filter(e => !pinSet.has(e.id)).slice(0, HISTORY_MAX);
    this._ctx.globalState.update(STORAGE_HISTORY, [...pinned, ...unpinned]);
    this._postHistory();
  }

  setResults(result: CollectorResult): void {
    const data: SerialResult = {
      symbolName: result.symbolName,
      totalCount: result.totalCount,
      sourceFile: result.sourceUri.toString(),
      fileGroups: result.fileGroups.map(fg => ({
        relativePath: fg.relativePath,
        references:   fg.references.map(ref => ({
          uriString: ref.uri.toString(),
          startLine: ref.range.start.line,
          startChar: ref.range.start.character,
          endLine:   ref.range.end.line,
          endChar:   ref.range.end.character,
          kind:          ref.kind,
          snippet:       ref.snippet,
          snippetIndent: ref.snippetIndent,
        })),
      })),
    };
    const msg: WebviewMsg = { type: 'results', data };
    this._lastMsg = msg;
    this._post(msg);
    if (result.totalCount > 0) { this._addToHistory(data); } // сохраняем только непустые результаты
    if (this._view) {
      this._view.title = result.totalCount === 0
        ? `References — "${result.symbolName}" (none)`
        : `References — "${result.symbolName}" (${result.totalCount})`;
    }
  }

  setLoading(symbolName: string): void {
    const msg: WebviewMsg = { type: 'loading', symbolName };
    this._lastMsg = msg;
    this._post(msg);
    if (this._view) { this._view.title = `References — searching "${symbolName}"…`; }
  }

  clear(): void {
    const msg: WebviewMsg = { type: 'clear' };
    this._lastMsg = msg;
    this._post(msg);
    if (this._view) { this._view.title = 'References'; }
  }

  private _post(msg: WebviewMsg): void {
    this._view?.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    const nonce = getNonce();
    // Читаем настройку по умолчанию — передаём в HTML как JS-константу,
    // чтобы webview использовал её при первом открытии (до сохранения состояния)
    const dedupDefault = vscode.workspace
      .getConfiguration('reflens')
      .get<boolean>('deduplicateLines', false);
    const collapseDefault = vscode.workspace
      .getConfiguration('reflens')
      .get<boolean>('collapseAll', false);
    const showFullPathDefault = vscode.workspace
      .getConfiguration('reflens')
      .get<boolean>('showFullPath', false);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src 'nonce-${nonce}';
               script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
/* ── Сброс и базовые стили ─────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family:     var(--vscode-font-family);
  font-size:       var(--vscode-font-size);
  color:           var(--vscode-foreground);
  background:      transparent;
  display:         flex;
  flex-direction:  column;
}
/* Обёртка под тулбаром — занимает всё оставшееся место */
#main-content {
  flex:           1;
  display:        flex;
  flex-direction: column;
  overflow:       hidden;
  min-height:     0;
}
/* Блок результатов — высота задаётся JS (перетаскиванием) */
#root {
  overflow-y:  auto;
  flex-shrink: 0;
  min-height:  40px;
}
/* Разделитель — перетаскиваемая линия */
#resizer {
  flex-shrink:  0;
  height:       5px;
  cursor:       row-resize;
  border-top:   2px solid var(--vscode-panel-border);
  border-bottom: 1px solid transparent;
  user-select:  none;
  transition:   border-color 0.12s;
}
#resizer:hover, #resizer.dragging { border-top-color: var(--vscode-focusBorder); }
/* Зона истории и пинов — занимает остаток */
#history-zone {
  flex:        1;
  overflow-y:  auto;
  min-height:  40px;
}
#pins-root:not(:empty) { border-top: 1px solid var(--vscode-panel-border); }
#history-root:not(:empty) { border-top: 1px solid var(--vscode-panel-border); }

/* ── Тулбар ─────────────────────────────────────────────────────────── */
.toolbar {
  display:         flex;
  align-items:     center;
  gap:             4px;
  padding:         4px 8px;
  border-bottom:   1px solid var(--vscode-panel-border);
  background:      var(--vscode-sideBar-background, var(--vscode-editor-background));
  flex-wrap:       nowrap;
  flex-shrink:     0;
}
.settings-panel {
  display:         flex;
  align-items:     center;
  gap:             4px;
  padding:         3px 8px;
  border-bottom:   1px solid var(--vscode-panel-border);
  background:      var(--vscode-sideBar-background, var(--vscode-editor-background));
  flex-shrink:     0;
}
.settings-panel.hidden { display: none; }
.tb-label {
  font-size:  0.8em;
  color:      var(--vscode-descriptionForeground);
  flex-shrink: 0;
}
.tb-sep { flex: 1; }
.tb-btn {
  font-family:    var(--vscode-font-family);
  font-size:      0.8em;
  padding:        1px 7px;
  border:         1px solid var(--vscode-contrastBorder, var(--vscode-button-secondaryBorder, transparent));
  background:     var(--vscode-button-secondaryBackground, transparent);
  color:          var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  cursor:         pointer;
  border-radius:  2px;
  white-space:    nowrap;
}
.tb-btn:hover  { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.tb-btn.active {
  background: var(--vscode-button-background);
  color:      var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

/* ── Состояния-заглушки ──────────────────────────────────────────────── */
.state-msg {
  padding:    12px 16px;
  color:      var(--vscode-descriptionForeground);
  font-style: italic;
  line-height: 1.5;
}

/* ── Группа файла ────────────────────────────────────────────────────── */
.file-group, .kind-group { margin-top: 2px; }

.file-header, .kind-header {
  display:     flex;
  align-items: center;
  gap:         5px;
  padding:     3px 8px;
  cursor:      pointer;
  user-select: none;
  font-weight: 600;
}
.file-header:hover,  .file-header:focus-visible,
.kind-header:hover,  .kind-header:focus-visible {
  background: var(--vscode-list-hoverBackground);
  outline:    none;
}

/* Стрелка сворачивания */
.chevron { font-size: 9px; width: 10px; flex-shrink: 0; }
.file-group.collapsed .chevron::before,
.kind-group.collapsed .chevron::before { content: '▶'; }
.file-group:not(.collapsed) .chevron::before,
.kind-group:not(.collapsed) .chevron::before { content: '▼'; }

.hdr-icon { flex-shrink: 0; }   /* иконка в заголовке группы */

.hdr-name {
  flex:          1;
  overflow:      hidden;
  text-overflow: ellipsis;
  white-space:   nowrap;
}

.ref-count {
  font-size:   0.82em;
  font-weight: normal;
  color:       var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

/* Скрытие содержимого свёрнутой группы */
.file-group.collapsed .file-refs,
.kind-group.collapsed .kind-refs { display: none; }

.file-refs, .kind-refs { padding-left: 8px; }

/* ── Метка исходного файла ──────────────────────────────────────────── */
.src-badge {
  font-size:    0.72em;
  font-weight:  700;
  padding:      0 4px;
  border-radius: 3px;
  flex-shrink:  0;
  background:   var(--vscode-badge-background);
  color:        var(--vscode-badge-foreground);
}

/* ── Строка ссылки ───────────────────────────────────────────────────── */
.ref-row {
  display:     flex;
  align-items: baseline;
  gap:         6px;
  padding:     2px 8px 2px 20px;
  cursor:      pointer;
  white-space: nowrap;
  overflow:    hidden;
  border:      1px solid transparent; /* занимает место, чтобы не прыгало при focus */
}
.ref-row:hover        { background: var(--vscode-list-hoverBackground); }
.ref-row:focus-visible { outline: none; border-color: var(--vscode-focusBorder); }

/* Плоский список — строки без отступа */
.flat-list .ref-row { padding-left: 8px; }

/* ── Колонка Kind (иконка + метка) ──────────────────────────────────── */
.kind {
  display:     flex;
  align-items: baseline;
  gap:         3px;
  font-weight: 700;
  font-size:   0.8em;
  flex-shrink: 0;
  min-width:   5em;      /* фиксированная ширина — все сниппеты начинаются в одном месте */
  /* color задаётся inline-стилем на каждой строке */
}
.kind-icon { font-size: 0.85em; }   /* иконка чуть меньше метки */

/* ── Имя файла в режимах «по виду» и «плоский» ──────────────────────── */
.file-tag {
  font-size:   0.8em;
  color:       var(--vscode-descriptionForeground);
  flex-shrink: 0;
  min-width:   6em;
  overflow:    hidden;
  text-overflow: ellipsis;
}

/* ── Сниппет ────────────────────────────────────────────────────────── */
.snippet {
  flex:          1;
  font-family:   var(--vscode-editor-font-family);
  font-size:     var(--vscode-editor-font-size, 12px);
  overflow:      hidden;
  text-overflow: ellipsis;
  white-space:   nowrap;
}
.hl { color: var(--vscode-list-highlightForeground); font-weight: bold; }
/* Fuzzy-search match in snippets — background selection style */
.hl-search {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33));
  border-radius: 2px;
  outline: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent);
}
/* Both symbol highlight AND fuzzy match */
.hl.hl-search { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33)); }

/* ── Строка:колонка ─────────────────────────────────────────────────── */
.loc {
  font-size:   0.82em;
  color:       var(--vscode-descriptionForeground);
  flex-shrink: 0;
  margin-left: auto;
  white-space: nowrap;
}

/* ── Цвета видов ссылок — CSS-классы, чтобы обойти блокировку inline style CSP ── */
/* Nonce-protected <style> разрешён CSP; style="" атрибуты — нет при наличии nonce  */
.c-Definition     { color: var(--vscode-charts-blue,   #3794ff); }
.c-Implementation { color: var(--vscode-charts-green,  #89d185); }
.c-Declaration    { color: var(--vscode-charts-purple, #b180d7); }
.c-TypeDefinition { color: var(--vscode-charts-orange, #d18616); }
.c-Read           { color: var(--vscode-charts-yellow, #cca700); }
.c-Write          { color: var(--vscode-charts-red,    #f14c4c); }
.c-Reference      { color: var(--vscode-foreground);             }

/* ── Линии сетки (включаются классом show-lines на body) ─────────────── */
body.show-lines .ref-row                          { border-bottom-color: var(--vscode-panel-border); }
body.show-lines .kind                             { border-right: 1px solid var(--vscode-panel-border); padding-right: 6px; }
body.show-lines .file-tag                         { border-right: 1px solid var(--vscode-panel-border); padding-right: 6px; }
body.show-lines .loc                              { border-left:  1px solid var(--vscode-panel-border); padding-left:  6px; }
body.show-lines .file-header,
body.show-lines .kind-header                      { border-bottom: 1px solid var(--vscode-panel-border); }

/* ── История и пины ─────────────────────────────────────────────────── */
/* Borders handled by #pins-root/:empty and #history-root/:empty rules in base CSS */
.section-header {
  display:    flex;
  align-items: center;
  gap:        6px;
  padding:    4px 8px 2px;
  position:   sticky;
  top:        0;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  z-index:    5;
}
.section-title {
  flex:         1;
  font-size:    0.75em;
  font-weight:  700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color:        var(--vscode-descriptionForeground);
}
.section-btn {
  font-size:   0.75em;
  padding:     1px 6px;
  border:      1px solid transparent;
  background:  transparent;
  color:       var(--vscode-descriptionForeground);
  cursor:      pointer;
  border-radius: 2px;
  font-family: var(--vscode-font-family);
}
.section-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }

.history-item, .pin-item {
  display:     flex;
  align-items: center;
  gap:         5px;
  padding:     2px 8px;
  cursor:      pointer;
  font-size:   0.85em;
  white-space: nowrap;
  overflow:    hidden;
}
.history-item:hover, .pin-item:hover { background: var(--vscode-list-hoverBackground); }

.pin-indicator { width: 14px; flex-shrink: 0; text-align: center; }
.hist-name {
  font-weight:   600;
  flex-shrink:   0;
  max-width:     45%;
  overflow:      hidden;
  text-overflow: ellipsis;
}
.pin-item .hist-name { color: var(--vscode-charts-orange, #d18616); }
.hist-meta {
  flex:          1;
  color:         var(--vscode-descriptionForeground);
  overflow:      hidden;
  text-overflow: ellipsis;
}
.hist-pin-btn {
  flex-shrink: 0;
  background:  transparent;
  border:      none;
  cursor:      pointer;
  padding:     0 2px;
  color:       var(--vscode-descriptionForeground);
  font-size:   0.9em;
  opacity:     0.5;
  font-family: var(--vscode-font-family);
}
.hist-pin-btn:hover { opacity: 1; }

/* ── Поисковые строки ────────────────────────────────────────────────── */
.search-bar {
  display:       flex;
  align-items:   center;
  gap:           4px;
  padding:       3px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background:    var(--vscode-sideBar-background, var(--vscode-editor-background));
  flex-shrink:   0;
}
.search-input {
  width:         100%;
  font-family:   var(--vscode-font-family);
  font-size:     var(--vscode-font-size);
  color:         var(--vscode-input-foreground);
  background:    var(--vscode-input-background);
  border:        1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  padding:       2px 6px;
  outline:       none;
}
.search-input:focus { border-color: var(--vscode-focusBorder); }
.search-input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 0.7; }
.history-search-bar {
  display:       flex;
  align-items:   center;
  gap:           4px;
  position:      sticky;
  top:           0;
  z-index:       6;
  padding:       3px 8px;
  background:    var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border);
}
.search-type-select {
  flex-shrink:  0;
  font-family:  var(--vscode-font-family);
  font-size:    0.78em;
  color:        var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background:   var(--vscode-dropdown-background, var(--vscode-input-background));
  border:       1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 2px;
  padding:      2px 3px;
  cursor:       pointer;
  outline:      none;
  max-width:    9em;
}
.search-type-select:focus { border-color: var(--vscode-focusBorder); }
</style>
</head>
<body>
<div class="toolbar">
  <span class="tb-label">Group:</span>
  <button class="tb-btn" data-mode="file">By File</button>
  <button class="tb-btn" data-mode="kind">By Kind</button>
  <button class="tb-btn" data-mode="none">None</button>
  <span class="tb-sep"></span>
  <span class="tb-label">Sort:</span>
  <button class="tb-btn" data-sort="line">Line</button>
  <button class="tb-btn" data-sort="kind">Kind</button>
  <span class="tb-sep"></span>
  <button class="tb-btn" id="collapseAllBtn" title="Collapse All">⊟ All</button>
  <button class="tb-btn" id="settingsToggle" title="Toggle settings">⚙</button>
</div>
<div class="settings-panel hidden" id="settingsPanel">
  <button class="tb-btn" id="linesToggle">Lines: OFF</button>
  <button class="tb-btn" id="dedupToggle">Dedup: OFF</button>
  <button class="tb-btn" id="collapseToggle">Collapse: OFF</button>
  <button class="tb-btn" id="fullPathToggle">Full Path: OFF</button>
</div>
<div class="search-bar">
  <input type="text" class="search-input" id="resultsSearchInput" placeholder="Filter snippets\u2026" spellcheck="false">
  <select class="search-type-select" id="searchTypeSelect" title="Search algorithm">
    <option value="fuzzy">Fuzzy</option>
    <option value="bmh">BMH exact</option>
    <option value="bmhi">BMH ignore case</option>
    <option value="levenshtein">Levenshtein</option>
  </select>
</div>
<div id="main-content">
  <div id="root"><div class="state-msg">Run Find References to see results.</div></div>
  <div id="resizer" title="Drag to resize"></div>
  <div id="history-zone">
    <div class="history-search-bar">
      <input type="text" class="search-input" id="historySearchInput" placeholder="Filter history &amp; pins\u2026" spellcheck="false">
      <select class="search-type-select" id="historySearchTypeSelect" title="Search algorithm">
        <option value="fuzzy">Fuzzy</option>
        <option value="bmh">BMH exact</option>
        <option value="bmhi">BMH ignore case</option>
        <option value="levenshtein">Levenshtein</option>
      </select>
    </div>
    <div id="pins-root"></div>
    <div id="history-root"></div>
  </div>
</div>

<script nonce="${nonce}">
// ── Константы — зеркало referenceNode.ts ──────────────────────────────────

var KIND_LABELS = {
  TypeDefinition: 'TypeDef',
  Definition:     'Def',
  Implementation: 'Impl',
  Declaration:    'Decl',
  Read:           'Read',
  Write:          'Write',
  Reference:      'Ref'
};

// Unicode-иконки — геометрические символы из BMP, рендерятся без внешних шрифтов
var KIND_ICONS = {
  Definition:     '\u25C6',  // ◆ заполненный ромб — полное определение
  Implementation: '\u25B6',  // ▶ треугольник — «запускает» интерфейс
  Declaration:    '\u25C7',  // ◇ пустой ромб — скелет без тела
  TypeDefinition: '\u25C8',  // ◈ ромб с точкой — тип
  Read:           '\u25CE',  // ◎ мишень — чтение/наблюдение
  Write:          '\u25CF',  // ● круг — изменение
  Reference:      '\u25CB'   // ○ пустой круг — общая ссылка
};

// Порядок видов для режима группировки «By Kind»
var KIND_ORDER = ['TypeDefinition','Definition','Implementation','Declaration','Read','Write','Reference'];

// ── Состояние ─────────────────────────────────────────────────────────────
// vscode.getState()/setState() сохраняют состояние между скрытиями/показами панели
var vscode = acquireVsCodeApi();
var _saved = vscode.getState() || {};
// Значения настроек по умолчанию, прочитанные расширением при открытии панели
var DEDUP_DEFAULT          = ${dedupDefault};
var COLLAPSE_DEFAULT       = ${collapseDefault};
var SHOW_FULL_PATH_DEFAULT = ${showFullPathDefault};
var state = {
  groupMode:     _saved.groupMode     || 'file',
  sortMode:      _saved.sortMode      || 'line',
  showLines:     _saved.showLines     || false,
  dedupLines:    _saved.dedupLines    !== undefined ? _saved.dedupLines    : DEDUP_DEFAULT,
  collapseAll:   _saved.collapseAll   !== undefined ? _saved.collapseAll   : COLLAPSE_DEFAULT,
  showFullPath:  _saved.showFullPath  !== undefined ? _saved.showFullPath  : SHOW_FULL_PATH_DEFAULT,
  settingsOpen:  _saved.settingsOpen  || false,
  resultsHeight: _saved.resultsHeight || 0,   // 0 = авто (50% при первом открытии)
  resultsFilter: _saved.resultsFilter || '',  // строка фильтра сниппетов
  historyFilter: _saved.historyFilter || '',  // строка фильтра истории / пинов
  searchType:        _saved.searchType        || 'fuzzy', // алгоритм для сниппетов
  historySearchType: _saved.historySearchType || 'fuzzy'  // алгоритм для истории / пинов
};

var currentData = null; // последний полученный SerialResult
var refStore    = [];   // плоский массив SerialRef — индексируется data-idx строк

// ── Применяем начальное состояние к тулбару ───────────────────────────────
applyState();

// ── Поисковые строки — инициализация и обработчики ───────────────────────
(function() {
  var SEARCH_LABELS = {
    fuzzy:       'Fuzzy',
    bmh:         'BMH exact',
    bmhi:        'BMH no case',
    levenshtein: 'Levenshtein'
  };

  function updatePlaceholders() {
    var rLabel = SEARCH_LABELS[state.searchType]        || 'Fuzzy';
    var hLabel = SEARCH_LABELS[state.historySearchType] || 'Fuzzy';
    var rInput = document.getElementById('resultsSearchInput');
    var hInput = document.getElementById('historySearchInput');
    if (rInput) { rInput.placeholder = 'Filter snippets \u2014 ' + rLabel + '\u2026'; }
    if (hInput) { hInput.placeholder = 'Filter history & pins \u2014 ' + hLabel + '\u2026'; }
  }

  // Селектор алгоритма для сниппетов
  var sel = document.getElementById('searchTypeSelect');
  if (sel) {
    sel.value = state.searchType || 'fuzzy';
    sel.addEventListener('change', function() {
      state.searchType = this.value;
      vscode.setState(state);
      updatePlaceholders();
      applyResultsFilter();
    });
  }

  // Селектор алгоритма для истории / пинов
  var hSel = document.getElementById('historySearchTypeSelect');
  if (hSel) {
    hSel.value = state.historySearchType || 'fuzzy';
    hSel.addEventListener('change', function() {
      state.historySearchType = this.value;
      vscode.setState(state);
      updatePlaceholders();
      renderPinsSection();
      renderHistorySection();
    });
  }

  var rInput = document.getElementById('resultsSearchInput');
  if (rInput) {
    rInput.value = state.resultsFilter || '';
    rInput.addEventListener('input', function() {
      state.resultsFilter = this.value;
      vscode.setState(state);
      applyResultsFilter();
    });
  }
  var hInput = document.getElementById('historySearchInput');
  if (hInput) {
    hInput.value = state.historyFilter || '';
    hInput.addEventListener('input', function() {
      state.historyFilter = this.value;
      vscode.setState(state);
      renderPinsSection();
      renderHistorySection();
    });
  }

  updatePlaceholders();
})();

// ── Перетаскиваемый разделитель ───────────────────────────────────────────
(function() {
  var resizer  = document.getElementById('resizer');
  var rootEl   = document.getElementById('root');
  var mainEl   = document.getElementById('main-content');
  if (!resizer || !rootEl || !mainEl) { return; }

  // Устанавливает высоту блока результатов в пикселях
  function setHeight(h) {
    // Ограничиваем: не меньше 40px и не больше высоты контейнера минус 40px
    var maxH = mainEl.clientHeight - 40;
    h = Math.max(40, Math.min(h, maxH));
    rootEl.style.height = h + 'px';
    return h;
  }

  // При первом открытии (resultsHeight === 0) — ставим 50% доступного пространства.
  // requestAnimationFrame даёт браузеру время посчитать реальную высоту mainEl.
  requestAnimationFrame(function() {
    var h = state.resultsHeight || Math.floor(mainEl.clientHeight * 0.5);
    setHeight(h);
  });

  var startY, startH;

  resizer.addEventListener('mousedown', function(e) {
    startY = e.clientY;
    startH = rootEl.offsetHeight;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';  // курсор на всём документе во время перетаскивания
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    setHeight(startH + (e.clientY - startY));
  }

  function onUp(e) {
    var finalH = setHeight(startH + (e.clientY - startY));
    state.resultsHeight = finalH;     // сохраняем только при отпускании мыши
    vscode.setState(state);
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
})();

// ── Обработчик сообщений от расширения ───────────────────────────────────
window.addEventListener('message', function(event) { render(event.data); });

// ── Диспетчер отрисовки ───────────────────────────────────────────────────
function render(msg) {
  // Сообщение истории обрабатывается отдельно — не трогает основной root
  if (msg.type === 'historyData') { onHistoryData(msg); return; }

  var root = document.getElementById('root');
  refStore = [];

  if (msg.type === 'clear') {
    currentData = null;
    root.innerHTML = '<div class="state-msg">Run Find References to see results.</div>';
    return;
  }
  if (msg.type === 'loading') {
    currentData = null;
    // Сбрасываем фильтр сниппетов при каждом новом поиске
    state.resultsFilter = '';
    vscode.setState(state);
    var rInput = document.getElementById('resultsSearchInput');
    if (rInput) { rInput.value = ''; }
    root.innerHTML = '<div class="state-msg">Searching for <em>' + escHtml(msg.symbolName) + '</em>\u2026</div>';
    return;
  }
  if (msg.type === 'results') {
    currentData = msg.data;
    renderData(root);
  }
}

// ── Отрисовка текущих данных в выбранном режиме группировки ──────────────
function renderData(root) {
  if (!currentData || currentData.totalCount === 0) {
    root.innerHTML = '<div class="state-msg">No references found for <em>' +
      escHtml(currentData ? currentData.symbolName : '') + '</em>.</div>';
    return;
  }
  refStore = [];
  var html = '';
  if      (state.groupMode === 'kind') { html = renderByKind(currentData); }
  else if (state.groupMode === 'none') { html = renderFlat(currentData);   }
  else                                  { html = renderByFile(currentData); }
  root.innerHTML = html;
  attachListeners(root);
  applyResultsFilter(); // применяем текущий фильтр после перерисовки
}

// ── Сортировка ссылок внутри группы ─────────────────────────────────────
// sortMode='line'  — по номеру строки (затем по колонке)
// sortMode='kind'  — по приоритету вида (KIND_ORDER), затем по строке
// Убирает ссылки, указывающие на ту же строку того же файла, что уже встречалась.
// Вызывается после sortRefs — поэтому при sortMode='kind' остаётся вид с наивысшим приоритетом.
// При слиянии сохраняет все колонки в поле hlCols — для подсветки всех вхождений на строке.
function dedupByLine(refs) {
  if (!state.dedupLines) { return refs; } // фильтрация выключена — возвращаем как есть
  var seen = Object.create(null);         // ключ: uriString + '#' + startLine → объект-победитель
  var result = [];
  for (var i = 0; i < refs.length; i++) {
    var ref = refs[i];
    var key = ref.uriString + '#' + ref.startLine;
    // Позиция и длина подсвечиваемого идентификатора в обрезанном сниппете.
    // endChar - startChar даёт точную длину идентификатора из range провайдера —
    // для TypeDefinition это длина имени типа, для остальных — длина символа.
    var col = ref.startChar - (ref.snippetIndent || 0);
    var len = ref.endChar - ref.startChar;
    if (seen[key]) {
      // Строка уже представлена — добавляем пару {col, len} в список подсветок победителя
      seen[key].hlPairs.push({ col: col, len: len });
    } else {
      // Первое вхождение на строке — клонируем ref и инициализируем список пар
      var merged = Object.assign({}, ref);
      merged.hlPairs = [{ col: col, len: len }]; // массив всех подсветок на строке
      seen[key] = merged;
      result.push(merged);
    }
  }
  return result;
}

function sortRefs(refs) {
  var arr = refs.slice(); // не мутируем исходный массив
  if (state.sortMode === 'kind') {
    arr.sort(function(a, b) {
      var ka = KIND_ORDER.indexOf(a.kind);
      var kb = KIND_ORDER.indexOf(b.kind);
      if (ka === -1) { ka = KIND_ORDER.length; }
      if (kb === -1) { kb = KIND_ORDER.length; }
      if (ka !== kb) { return ka - kb; }
      if (a.startLine !== b.startLine) { return a.startLine - b.startLine; }
      return a.startChar - b.startChar;
    });
  } else {
    // sortMode='line' — основной порядок (по строке, затем по колонке)
    arr.sort(function(a, b) {
      if (a.startLine !== b.startLine) { return a.startLine - b.startLine; }
      return a.startChar - b.startChar;
    });
  }
  return arr;
}

// ── Режим «By File» (группировка по файлу) ───────────────────────────────
function renderByFile(data) {
  // Исходный файл поиска — выводим первым; остальные идут в исходном порядке
  var groups = data.fileGroups.slice();
  if (data.sourceFile) {
    groups.sort(function(a, b) {
      var aIsSource = a.references.length > 0 && a.references[0].uriString === data.sourceFile;
      var bIsSource = b.references.length > 0 && b.references[0].uriString === data.sourceFile;
      if (aIsSource && !bIsSource) { return -1; }
      if (!aIsSource && bIsSource) { return  1; }
      return 0;
    });
  }
  var html = '';
  for (var i = 0; i < groups.length; i++) {
    html += buildFileGroup(groups[i], data.symbolName, i === 0 && !!data.sourceFile);
  }
  return html;
}

function buildFileGroup(fg, symbolName, isSource) {
  var count     = fg.references.length;
  // collapseAll — постоянная настройка; >20 ссылок — эвристика; isSource — никогда не сворачиваем
  var collapsed = (!isSource && (state.collapseAll || count > 20)) ? ' collapsed' : '';
  var sorted = dedupByLine(sortRefs(fg.references)); // сортируем и дедублируем внутри файла
  var rows = '';
  for (var i = 0; i < sorted.length; i++) {
    var idx = refStore.length;
    refStore.push(sorted[i]);
    rows += buildRefRow(sorted[i], idx, symbolName, false);
  }
  var displayName = state.showFullPath
    ? fg.relativePath
    : (fg.relativePath.split('/').pop() || fg.relativePath);
  return (
    '<div class="file-group' + collapsed + '">' +
      '<div class="file-header" tabindex="0" role="button">' +
        '<span class="chevron"></span>' +
        (isSource ? '<span class="src-badge" title="Source file">src</span>' : '') +
        '<span class="hdr-name" title="' + escHtml(fg.relativePath) + '">' + escHtml(displayName) + '</span>' +
        '<span class="ref-count">' + count + ' ref' + (count !== 1 ? 's' : '') + '</span>' +
      '</div>' +
      '<div class="file-refs">' + rows + '</div>' +
    '</div>'
  );
}

// Строка ссылки для режимов «By File» и «By Kind»
// showFile — показывать ли имя файла вместо kind (используется в «By Kind»)
function buildRefRow(ref, idx, symbolName, showFile) {
  var line    = ref.startLine + 1;
  var col     = ref.startChar + 1;
  var label   = KIND_LABELS[ref.kind] || ref.kind;
  var icon    = KIND_ICONS[ref.kind]  || '\u25CB';
  // Длина подсвечиваемого идентификатора из range: для TypeDefinition это имя типа,
  // для остальных — имя символа (совпадает с symbolName.length в большинстве случаев)
  var symLen = ref.endChar - ref.startChar;
  // При dedup: подсвечиваем все слитые пары {col,len}; иначе — только точную позицию
  var snippet = ref.hlPairs
    ? highlightMultiple(ref.snippet, ref.hlPairs)
    : highlightAt(ref.snippet, ref.startChar - (ref.snippetIndent || 0), symLen);

  var leftCol = '';
  if (showFile) {
    // В режиме «By Kind» показываем имя файла вместо kind-бейджа
    var ftext = ref.relativePath
      ? (state.showFullPath ? ref.relativePath : (ref.relativePath.split('/').pop() || ref.relativePath))
      : '';
    leftCol = '<span class="file-tag" title="' + escHtml(ref.relativePath || '') + '">' + escHtml(ftext) + '</span>';
  } else {
    // Стандартный вид: иконка + метка, окрашенные в цвет типа
    leftCol = '<span class="kind c-' + ref.kind + '">' +
                '<span class="kind-icon">' + icon + '</span>' +
                '<span class="kind-label">' + escHtml(label) + '</span>' +
              '</span>';
  }

  return (
    '<div class="ref-row" tabindex="0" role="button" data-idx="' + idx + '"' +
        ' title="' + escHtml(ref.kind) + ' \u2014 ' + line + ':' + col + '">' +
      leftCol +
      '<span class="snippet">' + snippet + '</span>' +
      '<span class="loc">' + line + ':' + col + '</span>' +
    '</div>'
  );
}

// ── Режим «By Kind» (группировка по виду ссылки) ─────────────────────────
function renderByKind(data) {
  // Собираем все ссылки в плоский массив с добавлением relativePath
  var byKind = {};
  for (var k = 0; k < KIND_ORDER.length; k++) { byKind[KIND_ORDER[k]] = []; }

  for (var i = 0; i < data.fileGroups.length; i++) {
    var fg = data.fileGroups[i];
    for (var j = 0; j < fg.references.length; j++) {
      var ref = fg.references[j];
      // Добавляем relativePath к ссылке (нужен для отображения имени файла)
      var augmented = {
        uriString:     ref.uriString,
        startLine:     ref.startLine,
        startChar:     ref.startChar,
        endLine:       ref.endLine,
        endChar:       ref.endChar,
        kind:          ref.kind,
        snippet:       ref.snippet,
        snippetIndent: ref.snippetIndent || 0,
        relativePath:  fg.relativePath
      };
      if (byKind[ref.kind]) { byKind[ref.kind].push(augmented); }
      else { byKind['Reference'].push(augmented); }
    }
  }

  var html = '';
  for (var k = 0; k < KIND_ORDER.length; k++) {
    var kind = KIND_ORDER[k];
    var refs = byKind[kind];
    if (!refs || refs.length === 0) { continue; }

    var label   = KIND_LABELS[kind] || kind;
    var icon    = KIND_ICONS[kind]  || '\u25CB';
    var count   = refs.length;
    var rows    = '';
    var sorted  = dedupByLine(sortRefs(refs)); // сортируем и дедублируем внутри группы вида

    for (var r = 0; r < sorted.length; r++) {
      var idx = refStore.length;
      refStore.push(sorted[r]);
      rows += buildRefRow(sorted[r], idx, data.symbolName, true); // showFile=true
    }

    html += (
      '<div class="kind-group' + (state.collapseAll ? ' collapsed' : '') + '">' +
        '<div class="kind-header c-' + kind + '" tabindex="0" role="button">' +
          '<span class="chevron"></span>' +
          '<span class="hdr-icon">' + icon + '</span>' +
          '<span class="hdr-name">' + escHtml(label) + '</span>' +
          '<span class="ref-count">' + count + '</span>' +
        '</div>' +
        '<div class="kind-refs">' + rows + '</div>' +
      '</div>'
    );
  }
  return html;
}

// ── Режим «None» (плоский список без группировки) ────────────────────────
function renderFlat(data) {
  // Сортируем: сначала по имени файла, затем по строке
  var flat = [];
  for (var i = 0; i < data.fileGroups.length; i++) {
    var fg = data.fileGroups[i];
    for (var j = 0; j < fg.references.length; j++) {
      flat.push({
        uriString:     fg.references[j].uriString,
        startLine:     fg.references[j].startLine,
        startChar:     fg.references[j].startChar,
        endLine:       fg.references[j].endLine,
        endChar:       fg.references[j].endChar,
        kind:          fg.references[j].kind,
        snippet:       fg.references[j].snippet,
        snippetIndent: fg.references[j].snippetIndent || 0,
        relativePath:  fg.relativePath
      });
    }
  }
  // Исходный файл поиска — его строки всегда идут первыми (в любом режиме сортировки)
  var sourceFile = data.sourceFile || '';
  function isSource(ref) { return ref.uriString === sourceFile; }

  if (state.sortMode === 'kind') {
    // Сортировка: источник → вид → файл → строка
    flat.sort(function(a, b) {
      var as = isSource(a) ? 0 : 1, bs = isSource(b) ? 0 : 1;
      if (as !== bs) { return as - bs; }
      var ka = KIND_ORDER.indexOf(a.kind);
      var kb = KIND_ORDER.indexOf(b.kind);
      if (ka === -1) { ka = KIND_ORDER.length; }
      if (kb === -1) { kb = KIND_ORDER.length; }
      if (ka !== kb) { return ka - kb; }
      if (a.relativePath < b.relativePath) { return -1; }
      if (a.relativePath > b.relativePath) { return  1; }
      if (a.startLine !== b.startLine) { return a.startLine - b.startLine; }
      return a.startChar - b.startChar;
    });
  } else {
    // Сортировка: источник → файл → строка → колонка
    flat.sort(function(a, b) {
      var as = isSource(a) ? 0 : 1, bs = isSource(b) ? 0 : 1;
      if (as !== bs) { return as - bs; }
      if (a.relativePath < b.relativePath) { return -1; }
      if (a.relativePath > b.relativePath) { return  1; }
      if (a.startLine !== b.startLine) { return a.startLine - b.startLine; }
      return a.startChar - b.startChar;
    });
  }
  flat = dedupByLine(flat); // убираем дубли строк после сортировки

  var html = '<div class="flat-list">';
  for (var i = 0; i < flat.length; i++) {
    var ref     = flat[i];
    var line    = ref.startLine + 1;
    var col     = ref.startChar + 1;
    var label   = KIND_LABELS[ref.kind] || ref.kind;
    var icon    = KIND_ICONS[ref.kind]  || '\u25CB';
    var symLen  = ref.endChar - ref.startChar;
    var snippet = ref.hlPairs
      ? highlightMultiple(ref.snippet, ref.hlPairs)
      : highlightAt(ref.snippet, ref.startChar - (ref.snippetIndent || 0), symLen);
    var fname   = escHtml(ref.relativePath
      ? (state.showFullPath ? ref.relativePath : (ref.relativePath.split('/').pop() || ref.relativePath))
      : '');
    var idx     = refStore.length;
    refStore.push(ref);

    html += (
      '<div class="ref-row" tabindex="0" role="button" data-idx="' + idx + '"' +
          ' title="' + escHtml(ref.kind) + ' \u2014 ' + line + ':' + col + '">' +
        '<span class="file-tag" title="' + escHtml(ref.relativePath || '') + '">' + fname + '</span>' +
        '<span class="kind c-' + ref.kind + '">' +
          '<span class="kind-icon">' + icon + '</span>' +
          '<span class="kind-label">' + escHtml(label) + '</span>' +
        '</span>' +
        '<span class="snippet">' + snippet + '</span>' +
        '<span class="loc">' + line + ':' + col + '</span>' +
      '</div>'
    );
  }
  html += '</div>';
  return html;
}

// ── Подсветка символа в сниппете ─────────────────────────────────────────
// Подсвечивает несколько вхождений в строке по массиву пар {col, len} (режим Dedup).
// Каждая пара хранит свою длину — TypeDefinition подсвечивает имя типа, остальные — имя символа.
function highlightMultiple(snippet, pairs) {
  if (!pairs || pairs.length === 0) { return escHtml(snippet); }
  // Сортируем пары по col, чтобы обходить строку слева направо
  var sorted = pairs.slice().sort(function(a, b) { return a.col - b.col; });
  var result = '';
  var pos    = 0; // текущая позиция курсора в строке
  for (var i = 0; i < sorted.length; i++) {
    var col = sorted[i].col;
    var len = sorted[i].len;
    if (len <= 0 || col < pos) { continue; }              // нулевая длина или перекрытие — пропускаем
    if (col + len > snippet.length) { continue; }          // выходит за пределы — пропускаем
    result += escHtml(snippet.slice(pos, col));             // текст до вхождения
    result += '<span class="hl">' + escHtml(snippet.slice(col, col + len)) + '</span>';
    pos = col + len;                                        // сдвигаемся за подсвеченный идентификатор
  }
  result += escHtml(snippet.slice(pos));                    // остаток строки
  return result;
}

// Подсвечивает одно конкретное вхождение символа по позиции колонки.
// col = ref.startChar - ref.snippetIndent (смещение внутри обрезанного текста).
// Если позиция выходит за пределы строки — возвращаем текст без подсветки.
function highlightAt(snippet, col, symLen) {
  var escaped = escHtml(snippet);
  if (symLen <= 0 || col < 0) { return escaped; }
  // Убеждаемся, что вхождение не выходит за пределы строки
  if (col + symLen > snippet.length) { return escaped; }
  return (
    escHtml(snippet.slice(0, col)) +
    '<span class="hl">' + escHtml(snippet.slice(col, col + symLen)) + '</span>' +
    escHtml(snippet.slice(col + symLen))
  );
}

// ── Экранирование HTML ────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Алгоритмы поиска ──────────────────────────────────────────────────────
// Каждый возвращает массив {start, len} непересекающихся диапазонов совпадений
// в порядке возрастания start. Пустой массив = нет совпадения.

// — Fuzzy: все символы query встречаются в text по порядку (subsequence) ─
function fuzzyRanges(text, query) {
  var lt = text.toLowerCase(), lq = query.toLowerCase();
  var ranges = [], qi = 0;
  for (var i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) { ranges.push({ start: i, len: 1 }); qi++; }
  }
  return qi === lq.length ? ranges : [];
}

// — Boyer-Moore-Horspool: все вхождения подстроки ─────────────────────────
function bmhRanges(text, query, ignoreCase) {
  var t = ignoreCase ? text.toLowerCase() : text;
  var q = ignoreCase ? query.toLowerCase() : query;
  var n = t.length, m = q.length;
  if (m === 0 || m > n) { return []; }
  // Таблица сдвигов «плохого символа» (по последнему символу окна)
  var skip = Object.create(null);
  for (var i = 0; i < m - 1; i++) { skip[q[i]] = m - 1 - i; }
  var ranges = [], k = m - 1;
  while (k < n) {
    var j = m - 1, ci = k;
    while (j >= 0 && t[ci] === q[j]) { j--; ci--; }
    if (j < 0) {
      ranges.push({ start: ci + 1, len: m });
      k += m; // непересекающиеся вхождения
    } else {
      var sh = skip[t[k]];
      k += (sh !== undefined ? sh : m);
    }
  }
  return ranges;
}

// — Расстояние Левенштейна между двумя строками ───────────────────────────
function levenshteinDist(a, b) {
  var la = a.length, lb = b.length;
  if (la === 0) { return lb; }
  if (lb === 0) { return la; }
  var prev = [], curr = [];
  for (var j = 0; j <= lb; j++) { prev[j] = j; }
  for (var i = 1; i <= la; i++) {
    curr[0] = i;
    for (var j = 1; j <= lb; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lb];
}

// — Levenshtein: лучшее скользящее окно в тексте ──────────────────────────
// Порог: не более ⌊m/3⌋ правок (минимум 1 при m ≥ 3)
function levenshteinRanges(text, query) {
  var q  = query.toLowerCase();
  var t  = text.toLowerCase();
  var m  = q.length;
  if (m === 0) { return []; }
  var threshold = m >= 3 ? Math.floor(m / 3) : 0;
  var best = { dist: threshold + 1, start: -1, len: m };
  var minW = Math.max(1, m - threshold);
  var maxW = m + threshold;
  for (var wlen = minW; wlen <= maxW; wlen++) {
    for (var s = 0; s + wlen <= t.length; s++) {
      var d = levenshteinDist(q, t.slice(s, s + wlen));
      if (d < best.dist) { best = { dist: d, start: s, len: wlen }; }
    }
  }
  return best.start >= 0 ? [{ start: best.start, len: best.len }] : [];
}

// — Диспетчер: возвращает диапазоны для указанного алгоритма ─────────────
// type: 'fuzzy' | 'bmh' | 'bmhi' | 'levenshtein' (по умолчанию — state.searchType)
function getMatchRanges(text, query, type) {
  if (!query) { return []; }
  var t = type || state.searchType;
  switch (t) {
    case 'bmh':         return bmhRanges(text, query, false);
    case 'bmhi':        return bmhRanges(text, query, true);
    case 'levenshtein': return levenshteinRanges(text, query);
    default:            return fuzzyRanges(text, query); // 'fuzzy'
  }
}

// Возвращает true, если текст совпадает с запросом по указанному алгоритму
function textMatches(text, query, type) {
  if (!query) { return true; }
  return getMatchRanges(text, query, type).length > 0;
}

// Рендерит HTML с подсветкой .hl-search по найденным диапазонам
function highlightMatch(text, query, type) {
  if (!query) { return escHtml(text); }
  var ranges = getMatchRanges(text, query, type);
  if (ranges.length === 0) { return escHtml(text); }
  var result = '', pos = 0;
  for (var i = 0; i < ranges.length; i++) {
    var s = ranges[i].start, l = ranges[i].len;
    if (s < pos) { continue; }
    result += escHtml(text.slice(pos, s));
    result += '<span class="hl-search">' + escHtml(text.slice(s, s + l)) + '</span>';
    pos = s + l;
  }
  result += escHtml(text.slice(pos));
  return result;
}

// ── Построение HTML сниппета с объединёнными метками ─────────────────────
// Совмещает подсветку позиции символа (.hl) и поискового запроса (.hl-search).
// marks[i]: 0=none  1=symbol  2=search  3=both
// Возвращает { html, matched } — matched=true если поисковый запрос нашёл совпадение.
function buildSnippetHtml(ref, searchQuery) {
  var snippet = ref.snippet || '';
  var n = snippet.length;
  var marks = new Array(n);
  for (var i = 0; i < n; i++) { marks[i] = 0; }

  // Метки символа (бит 1) — позиция из range провайдера
  var pairs = ref.hlPairs;
  if (pairs) {
    for (var p = 0; p < pairs.length; p++) {
      var c = pairs[p].col, l = pairs[p].len;
      for (var j = c; j < c + l && j < n; j++) { marks[j] |= 1; }
    }
  } else {
    var sc = ref.startChar - (ref.snippetIndent || 0);
    var sl = ref.endChar - ref.startChar;
    if (sc >= 0 && sl > 0 && sc + sl <= n) {
      for (var j = sc; j < sc + sl; j++) { marks[j] |= 1; }
    }
  }

  // Метки поискового запроса (бит 2) — диапазоны от выбранного алгоритма
  var matched = false;
  if (searchQuery) {
    var ranges = getMatchRanges(snippet, searchQuery);
    matched = ranges.length > 0;
    for (var r = 0; r < ranges.length; r++) {
      var rs = ranges[r].start, rl = ranges[r].len;
      for (var j = rs; j < rs + rl && j < n; j++) { marks[j] |= 2; }
    }
  }

  // Рендер: прогоны с одинаковой меткой → один span
  var result = '', pos = 0;
  while (pos < n) {
    var m   = marks[pos];
    var end = pos + 1;
    while (end < n && marks[end] === m) { end++; }
    var chunk = escHtml(snippet.slice(pos, end));
    if      (m === 0) { result += chunk; }
    else if (m === 1) { result += '<span class="hl">'           + chunk + '</span>'; }
    else if (m === 2) { result += '<span class="hl-search">'    + chunk + '</span>'; }
    else              { result += '<span class="hl hl-search">' + chunk + '</span>'; }
    pos = end;
  }
  return { html: result, matched: matched };
}

// ── Применение фильтра сниппетов к текущим результатам ───────────────────
function applyResultsFilter() {
  var q = state.resultsFilter || '';
  var rows = document.querySelectorAll('#root .ref-row');
  for (var i = 0; i < rows.length; i++) {
    var idx = parseInt(rows[i].getAttribute('data-idx'), 10);
    var ref = refStore[idx];
    var visible = true;
    if (ref) {
      var res = buildSnippetHtml(ref, q);
      var snippetEl = rows[i].querySelector('.snippet');
      if (snippetEl) { snippetEl.innerHTML = res.html; }
      visible = !q || res.matched;
    } else {
      visible = !q;
    }
    rows[i].style.display = visible ? '' : 'none';
  }
  // Скрываем группу, если все её строки скрыты
  var groups = document.querySelectorAll('#root .file-group, #root .kind-group');
  for (var j = 0; j < groups.length; j++) {
    var groupRows = groups[j].querySelectorAll('.ref-row');
    var anyVisible = false;
    for (var k = 0; k < groupRows.length; k++) {
      if (groupRows[k].style.display !== 'none') { anyVisible = true; break; }
    }
    groups[j].style.display = anyVisible ? '' : 'none';
  }
}

// ── Открытие файла в редакторе ────────────────────────────────────────────
function openRef(idx) {
  var ref = refStore[idx];
  if (!ref) { return; }
  vscode.postMessage({
    type:      'openFile',
    uriString: ref.uriString,
    startLine: ref.startLine,
    startChar: ref.startChar,
    endLine:   ref.endLine,
    endChar:   ref.endChar
  });
}

// ── Навешивание обработчиков событий ─────────────────────────────────────
function attachListeners(root) {
  // Строки ссылок
  var rows = root.querySelectorAll('.ref-row');
  for (var i = 0; i < rows.length; i++) {
    (function(row) {
      var idx = parseInt(row.getAttribute('data-idx'), 10);
      row.addEventListener('click', function() { openRef(idx); });
      row.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRef(idx); }
      });
    })(rows[i]);
  }
  // Заголовки групп (файлов и видов)
  var headers = root.querySelectorAll('.file-header, .kind-header');
  for (var j = 0; j < headers.length; j++) {
    headers[j].addEventListener('click', toggleCollapse);
    headers[j].addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse.call(this); }
    });
  }
}

function toggleCollapse() {
  var group = this.closest('.file-group, .kind-group');
  if (group) { group.classList.toggle('collapsed'); }
}

// ── Тулбар: кнопки группировки и линий ───────────────────────────────────
document.querySelectorAll('.tb-btn[data-mode]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    state.groupMode = this.getAttribute('data-mode');
    vscode.setState(state);   // сохраняем в состоянии webview (переживает скрытие панели)
    applyState();
    var root = document.getElementById('root');
    renderData(root);
  });
});

document.querySelectorAll('.tb-btn[data-sort]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    state.sortMode = this.getAttribute('data-sort');
    vscode.setState(state);
    applyState();
    var root = document.getElementById('root');
    renderData(root);
  });
});

document.getElementById('linesToggle').addEventListener('click', function() {
  state.showLines = !state.showLines;
  vscode.setState(state);
  applyState();
});

document.getElementById('dedupToggle').addEventListener('click', function() {
  state.dedupLines = !state.dedupLines;
  vscode.setState(state);
  applyState();
  var root = document.getElementById('root');
  renderData(root);
});

// Постоянная настройка: новые результаты рендерятся свёрнутыми/развёрнутыми
document.getElementById('collapseToggle').addEventListener('click', function() {
  state.collapseAll = !state.collapseAll;
  vscode.setState(state);
  applyState();
  var root = document.getElementById('root');
  renderData(root); // перерисовываем с новым начальным состоянием групп
});

// Одноразовое действие: свернуть или развернуть все текущие группы
document.getElementById('collapseAllBtn').addEventListener('click', function() {
  var groups = document.querySelectorAll('.file-group, .kind-group');
  // Определяем целевое состояние: если хоть одна группа раскрыта — сворачиваем все
  var anyExpanded = false;
  for (var i = 0; i < groups.length; i++) {
    if (!groups[i].classList.contains('collapsed')) { anyExpanded = true; break; }
  }
  for (var j = 0; j < groups.length; j++) {
    groups[j].classList.toggle('collapsed', anyExpanded);
  }
  // Обновляем текст кнопки одноразового действия
  var btn = document.getElementById('collapseAllBtn');
  if (btn) { btn.textContent = anyExpanded ? '⊞ All' : '⊟ All'; }
});

document.getElementById('settingsToggle').addEventListener('click', function() {
  state.settingsOpen = !state.settingsOpen;
  vscode.setState(state);
  applyState();
});

document.getElementById('fullPathToggle').addEventListener('click', function() {
  state.showFullPath = !state.showFullPath;
  vscode.setState(state);
  applyState();
  var root = document.getElementById('root');
  renderData(root);
});

// ── История и пины ───────────────────────────────────────────────────────────

var historyEntries = []; // массив HistoryEntry, отсортированный от новых к старым
var pinIds         = []; // массив ID запинованных записей (порядок задаёт порядок в списке)

// Обрабатывает сообщение historyData от расширения
function onHistoryData(msg) {
  historyEntries = msg.entries || [];
  pinIds         = msg.pins    || [];
  renderPinsSection();
  renderHistorySection();
}

// Форматирует временную метку в строку ЧЧ:ММ:СС
function formatTime(ts) {
  var d = new Date(ts);
  var pad = function(n) { return n.toString().padStart(2, '0'); };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// Форматирует временную метку в строку ДД.ММ ЧЧ:ММ (для пинов — дата важна)
function formatDateTime(ts) {
  var d = new Date(ts);
  var pad = function(n) { return n.toString().padStart(2, '0'); };
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' +
         pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ── Рендер секции пинов ───────────────────────────────────────────────────────
function renderPinsSection() {
  var root = document.getElementById('pins-root');
  if (!root) { return; }
  var pinSet = new Set(pinIds);
  var pins = historyEntries.filter(function(e) { return pinSet.has(e.id); });
  // Сортируем по порядку в pinIds (пользовательский порядок)
  pins.sort(function(a, b) { return pinIds.indexOf(a.id) - pinIds.indexOf(b.id); });

  // Фильтруем по алгоритму истории
  var q  = state.historyFilter || '';
  var ht = state.historySearchType || 'fuzzy';
  if (q) {
    pins = pins.filter(function(e) {
      var fname = e.data.sourceFile ? (e.data.sourceFile.split('/').pop() || '') : '';
      return textMatches(e.symbolName, q, ht) || textMatches(fname, q, ht);
    });
  }

  if (pins.length === 0) { root.innerHTML = ''; return; }

  var html = '<div class="section-header">' +
    '<span class="section-title">📌 Pins</span>' +
  '</div>';

  for (var i = 0; i < pins.length; i++) {
    var e = pins[i];
    var fnameRaw = e.data.sourceFile ? (e.data.sourceFile.split('/').pop() || e.data.sourceFile) : '';
    var fnameHl  = q ? highlightMatch(fnameRaw, q, ht) : escHtml(fnameRaw);
    html += '<div class="pin-item" data-hid="' + escHtml(e.id) + '">' +
      '<span class="hist-name">' + highlightMatch(e.symbolName, q, ht) + '</span>' +
      '<span class="hist-meta">' + e.totalCount + ' refs' +
        (fnameRaw ? ' \u2014 ' + fnameHl : '') +
        ' · ' + formatDateTime(e.timestamp) +
      '</span>' +
      '<button class="hist-pin-btn" data-unpin="' + escHtml(e.id) + '" title="Unpin">✕</button>' +
    '</div>';
  }
  root.innerHTML = html;
  attachHistoryListeners(root);
}

// ── Рендер секции истории ─────────────────────────────────────────────────────
function renderHistorySection() {
  var root = document.getElementById('history-root');
  if (!root) { return; }

  if (historyEntries.length === 0) { root.innerHTML = ''; return; }

  // Фильтруем по алгоритму истории
  var q  = state.historyFilter || '';
  var ht = state.historySearchType || 'fuzzy';
  var pinSet = new Set(pinIds);
  var entries = historyEntries;
  if (q) {
    entries = entries.filter(function(e) {
      var fname = e.data.sourceFile ? (e.data.sourceFile.split('/').pop() || '') : '';
      return textMatches(e.symbolName, q, ht) || textMatches(fname, q, ht);
    });
  }

  if (entries.length === 0) { root.innerHTML = ''; return; }

  var html = '<div class="section-header">' +
    '<span class="section-title">History</span>' +
    '<button class="section-btn" id="clearHistoryBtn">Clear</button>' +
  '</div>';

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var isPinned = pinSet.has(e.id);
    html += '<div class="history-item" data-hid="' + escHtml(e.id) + '">' +
      '<span class="pin-indicator">' + (isPinned ? '📌' : '') + '</span>' +
      '<span class="hist-name">' + highlightMatch(e.symbolName, q, ht) + '</span>' +
      '<span class="hist-meta">' + e.totalCount + ' refs · ' + formatTime(e.timestamp) + '</span>' +
      '<button class="hist-pin-btn"' +
        (isPinned ? ' data-unpin="' + escHtml(e.id) + '" title="Unpin">\u2716'
                  : ' data-pin="'   + escHtml(e.id) + '" title="Pin">\u{1F4CC}') +
      '</button>' +
    '</div>';
  }
  root.innerHTML = html;

  var clearBtn = document.getElementById('clearHistoryBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'clearHistory' });
    });
  }
  attachHistoryListeners(root);
}

// ── Навешивает обработчики на элементы истории/пинов ─────────────────────────
function attachHistoryListeners(container) {
  // Клик по строке (кроме кнопки) — восстановить результаты
  var items = container.querySelectorAll('.history-item, .pin-item');
  for (var i = 0; i < items.length; i++) {
    (function(item) {
      item.addEventListener('click', function(evt) {
        if (evt.target.closest('.hist-pin-btn')) { return; }
        var id    = item.getAttribute('data-hid');
        var entry = null;
        for (var j = 0; j < historyEntries.length; j++) {
          if (historyEntries[j].id === id) { entry = historyEntries[j]; break; }
        }
        if (entry) { render({ type: 'results', data: entry.data }); }
      });
    })(items[i]);
  }
  // Кнопки «запинить»
  var pinBtns = container.querySelectorAll('.hist-pin-btn[data-pin]');
  for (var p = 0; p < pinBtns.length; p++) {
    (function(btn) {
      btn.addEventListener('click', function(evt) {
        evt.stopPropagation();
        vscode.postMessage({ type: 'addPin', id: btn.getAttribute('data-pin') });
      });
    })(pinBtns[p]);
  }
  // Кнопки «открепить»
  var unpinBtns = container.querySelectorAll('.hist-pin-btn[data-unpin]');
  for (var u = 0; u < unpinBtns.length; u++) {
    (function(btn) {
      btn.addEventListener('click', function(evt) {
        evt.stopPropagation();
        vscode.postMessage({ type: 'removePin', id: btn.getAttribute('data-unpin') });
      });
    })(unpinBtns[u]);
  }
}

// Применяет state к тулбару и body (active-классы кнопок, класс show-lines)
function applyState() {
  // Кнопки группировки
  var btns = document.querySelectorAll('.tb-btn[data-mode]');
  for (var i = 0; i < btns.length; i++) {
    var active = btns[i].getAttribute('data-mode') === state.groupMode;
    btns[i].classList.toggle('active', active);
  }
  // Кнопки сортировки
  var sbtns = document.querySelectorAll('.tb-btn[data-sort]');
  for (var j = 0; j < sbtns.length; j++) {
    var sactive = sbtns[j].getAttribute('data-sort') === state.sortMode;
    sbtns[j].classList.toggle('active', sactive);
  }
  // Кнопка линий
  var linesBtn = document.getElementById('linesToggle');
  if (linesBtn) {
    linesBtn.classList.toggle('active', state.showLines);
    linesBtn.textContent = state.showLines ? 'Lines: ON' : 'Lines: OFF';
  }
  // Кнопка дедубликации строк
  var dedupBtn = document.getElementById('dedupToggle');
  if (dedupBtn) {
    dedupBtn.classList.toggle('active', state.dedupLines);
    dedupBtn.textContent = state.dedupLines ? 'Dedup: ON' : 'Dedup: OFF';
  }
  // Постоянная настройка сворачивания
  var collapseBtn = document.getElementById('collapseToggle');
  if (collapseBtn) {
    collapseBtn.classList.toggle('active', state.collapseAll);
    collapseBtn.textContent = state.collapseAll ? 'Collapse: ON' : 'Collapse: OFF';
  }
  // Кнопка показа полного пути
  var fullPathBtn = document.getElementById('fullPathToggle');
  if (fullPathBtn) {
    fullPathBtn.classList.toggle('active', state.showFullPath);
    fullPathBtn.textContent = state.showFullPath ? 'Full Path: ON' : 'Full Path: OFF';
  }
  // Панель настроек
  var settingsPanel = document.getElementById('settingsPanel');
  if (settingsPanel) { settingsPanel.classList.toggle('hidden', !state.settingsOpen); }
  var settingsBtn = document.getElementById('settingsToggle');
  if (settingsBtn) { settingsBtn.classList.toggle('active', state.settingsOpen); }
  // Выпадающие списки алгоритмов поиска
  var searchTypeSel = document.getElementById('searchTypeSelect');
  if (searchTypeSel) { searchTypeSel.value = state.searchType || 'fuzzy'; }
  var historySearchTypeSel = document.getElementById('historySearchTypeSelect');
  if (historySearchTypeSel) { historySearchTypeSel.value = state.historySearchType || 'fuzzy'; }
  // Класс на body включает/выключает CSS-правила сетки
  document.body.classList.toggle('show-lines', state.showLines);
  // Восстанавливаем высоту разделителя (актуально при повторном показе панели)
  if (state.resultsHeight) {
    var rootEl  = document.getElementById('root');
    var mainEl  = document.getElementById('main-content');
    if (rootEl && mainEl) {
      var maxH = mainEl.clientHeight - 40;
      rootEl.style.height = Math.max(40, Math.min(state.resultsHeight, maxH)) + 'px';
    }
  }
}
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
