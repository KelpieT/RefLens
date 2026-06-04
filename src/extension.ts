// Импортируем API расширений VSCode
import * as vscode from 'vscode';
// Импортируем функцию сбора ссылок — она обращается к языковым провайдерам
import { collectReferences } from './referenceCollector';
// Импортируем провайдер WebviewView (заменяет старый TreeDataProvider)
import { ReferencesWebviewProvider } from './referencesWebviewProvider';

// Функция активации расширения — VSCode вызывает её один раз при первом открытии панели.
// context — объект жизненного цикла: все подписки складываем сюда для автоматической очистки.
export function activate(context: vscode.ExtensionContext): void {

  // Создаём провайдер WebviewView — он управляет HTML-панелью в сайдбаре
  // context передаётся для доступа к globalState (история и пины)
  const provider = new ReferencesWebviewProvider(context);

  // Регистрируем провайдер для вида 'reflens.resultsView' (id из package.json).
  // retainContextWhenHidden: true — webview остаётся в памяти при скрытии панели,
  // избегая повторной отрисовки при переключении между вкладками Activity Bar.
  const webviewReg = vscode.window.registerWebviewViewProvider(
    ReferencesWebviewProvider.viewType,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // ── Внутреннее состояние ──────────────────────────────────────────────────

  // Источник токена отмены для текущего активного поиска.
  // null означает, что поиск сейчас не выполняется.
  let currentCancelSource: vscode.CancellationTokenSource | null = null;
  // Идентификатор таймера debounce для авто-обновления при движении курсора.
  let debounceTimer: ReturnType<typeof setTimeout> | null        = null;
  // Текущее состояние флага авто-обновления, читаем из настроек при старте
  let autoUpdateEnabled = vscode.workspace
    .getConfiguration('reflens')
    .get<boolean>('autoUpdate', false);

  // ── Основная функция запуска поиска ──────────────────────────────────────

  // Отменяет предыдущий поиск (если шёл), запускает новый и обновляет панель.
  async function triggerRefresh(editor: vscode.TextEditor, position: vscode.Position): Promise<void> {
    // Отменяем предыдущий незавершённый поиск — пользователь мог переместить курсор
    currentCancelSource?.cancel();
    currentCancelSource?.dispose();
    // Создаём новый источник токена отмены для этого поиска
    currentCancelSource = new vscode.CancellationTokenSource();
    const token = currentCancelSource.token;

    // Определяем слово под курсором для немедленного отображения в заголовке
    const wordRange  = editor.document.getWordRangeAtPosition(position);
    const symbolName = wordRange ? editor.document.getText(wordRange) : 'symbol';
    // Сразу показываем состояние «идёт поиск» — не ждём результатов
    provider.setLoading(symbolName);

    try {
      // Запускаем сбор ссылок — это асинхронная операция, может занять время
      const result = await collectReferences(editor.document, position, token);
      if (!token.isCancellationRequested) {
        provider.setResults(result); // передаём результаты в панель
      }
    } catch (err) {
      if (!token.isCancellationRequested) {
        vscode.window.showErrorMessage(`MyReferences: ${String(err)}`);
        provider.clear();
      }
    }
  }

  // ── Регистрация команд ────────────────────────────────────────────────────

  // Команда «Найти ссылки» — вызывается кнопкой в панели или из контекстного меню редактора
  context.subscriptions.push(
    vscode.commands.registerCommand('reflens.findReferences', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('MyReferences: No active editor.');
        return;
      }
      // Переключаем фокус на нашу панель, чтобы результаты были сразу видны
      vscode.commands.executeCommand('reflens.resultsView.focus');
      // Запускаем поиск от текущей позиции курсора
      triggerRefresh(editor, editor.selection.active);
    })
  );

  // Команда «Очистить результаты» — кнопка в заголовке панели
  context.subscriptions.push(
    vscode.commands.registerCommand('reflens.clearResults', () => {
      provider.clear();
    })
  );

  // ── Авто-обновление при движении курсора (с debounce) ────────────────────

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (!autoUpdateEnabled) { return; }
      // Пропускаем программные изменения курсора (от команд, а не от пользователя)
      if (event.kind === vscode.TextEditorSelectionChangeKind.Command) { return; }
      // Пропускаем мультивыделения — нас интересует только одна позиция курсора
      if (event.selections.length !== 1) { return; }

      // Сбрасываем предыдущий debounce-таймер если он ещё не сработал
      if (debounceTimer !== null) { clearTimeout(debounceTimer); }

      const editor   = event.textEditor;
      const position = event.selections[0].active;
      const ms       = vscode.workspace.getConfiguration('reflens').get<number>('debounceMs', 500);

      // Запускаем поиск только если курсор не двигался ms миллисекунд подряд
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        triggerRefresh(editor, position);
      }, ms);
    })
  );

  // ── Слушатель изменения настроек ─────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('reflens.autoUpdate')) {
        autoUpdateEnabled = vscode.workspace
          .getConfiguration('reflens')
          .get<boolean>('autoUpdate', false);
      }
    })
  );

  // ── Регистрация ресурсов для автоматической очистки ───────────────────────

  context.subscriptions.push(webviewReg); // VSCode освободит регистрацию провайдера при деактивации
  context.subscriptions.push(
    new vscode.Disposable(() => {
      currentCancelSource?.cancel();  // отменяем активный поиск при деактивации расширения
      currentCancelSource?.dispose();
      if (debounceTimer !== null) { clearTimeout(debounceTimer); } // очищаем таймер debounce
    })
  );
}

// Функция деактивации — VSCode освобождает все ресурсы из context.subscriptions автоматически.
export function deactivate(): void { /* обработано через context.subscriptions */ }
