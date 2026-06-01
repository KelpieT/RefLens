// Импортируем API расширений VSCode
import * as vscode from 'vscode';
// Импортируем функцию сбора ссылок — она обращается к языковым провайдерам
import { collectReferences } from './referenceCollector';
// Импортируем провайдер данных для дерева ссылок
import { ReferencesProvider } from './referencesProvider';

// Функция активации расширения — VSCode вызывает её один раз при первом открытии панели.
// context — объект жизненного цикла: в него складываем все подписки и ресурсы,
// чтобы VSCode автоматически освободил их при деактивации расширения.
export function activate(context: vscode.ExtensionContext): void {

  // Создаём экземпляр провайдера данных для дерева
  const provider = new ReferencesProvider();

  // Регистрируем дерево в панели с идентификатором из package.json.
  // createTreeView (в отличие от registerTreeDataProvider) возвращает объект TreeView,
  // через который можно управлять заголовком, фокусом и другими свойствами панели.
  const treeView = vscode.window.createTreeView('myreferences.resultsView', {
    treeDataProvider: provider, // провайдер, поставляющий узлы дерева
    showCollapseAll:  true,     // показывать встроенную кнопку «свернуть всё» в заголовке панели
  });

  // Подписываемся на событие изменения данных провайдера,
  // чтобы обновлять заголовок панели при каждом обновлении дерева
  provider.onDidChangeTreeData(() => {
    treeView.title = provider.getTitle(); // синхронизируем заголовок с текущим состоянием
  });
  treeView.title = 'References'; // начальный заголовок до первого поиска

  // ── Внутреннее состояние ──────────────────────────────────────────────────

  // Источник токена отмены для текущего активного поиска.
  // null означает, что поиск сейчас не выполняется.
  let currentCancelSource: vscode.CancellationTokenSource | null = null;
  // Идентификатор таймера debounce для авто-обновления при движении курсора.
  // null означает, что таймер сейчас не запущен.
  let debounceTimer: ReturnType<typeof setTimeout> | null        = null;
  // Текущее состояние флага авто-обновления, читаем из настроек при старте
  let autoUpdateEnabled = vscode.workspace
    .getConfiguration('myreferences')
    .get<boolean>('autoUpdate', false); // false по умолчанию

  // ── Основная функция запуска поиска ──────────────────────────────────────

  // Отменяет предыдущий поиск (если шёл), запускает новый и обновляет дерево.
  async function triggerRefresh(editor: vscode.TextEditor, position: vscode.Position): Promise<void> {
    // Отменяем предыдущий незавершённый поиск — пользователь мог переместить курсор
    currentCancelSource?.cancel();
    currentCancelSource?.dispose();
    // Создаём новый источник токена отмены для этого поиска
    currentCancelSource = new vscode.CancellationTokenSource();
    const token = currentCancelSource.token; // сам токен передаём в сборщик

    // Определяем слово под курсором для немедленного отображения в заголовке
    const wordRange  = editor.document.getWordRangeAtPosition(position);
    const symbolName = wordRange ? editor.document.getText(wordRange) : 'symbol';
    // Сразу показываем состояние «идёт поиск» — не ждём результатов
    provider.setLoading(symbolName);

    try {
      // Запускаем сбор ссылок — это асинхронная операция, может занять время
      const result = await collectReferences(editor.document, position, token);
      // Проверяем, не была ли операция отменена пока шёл поиск
      if (!token.isCancellationRequested) {
        provider.setResults(result); // передаём результаты в дерево
      }
    } catch (err) {
      // Поиск завершился с ошибкой (языковой сервер недоступен и т.д.)
      if (!token.isCancellationRequested) {
        vscode.window.showErrorMessage(`MyReferences: ${String(err)}`); // показываем уведомление об ошибке
        provider.clear(); // очищаем дерево
      }
    }
  }

  // ── Регистрация команд ────────────────────────────────────────────────────

  // Команда «Найти ссылки» — вызывается кнопкой в панели или из контекстного меню редактора
  context.subscriptions.push(
    vscode.commands.registerCommand('myreferences.findReferences', () => {
      const editor = vscode.window.activeTextEditor; // получаем активный редактор
      if (!editor) {
        // Нет открытого файла — предупреждаем пользователя
        vscode.window.showWarningMessage('MyReferences: No active editor.');
        return;
      }
      // Переключаем фокус на нашу панель, чтобы результаты сразу были видны
      vscode.commands.executeCommand('myreferences.resultsView.focus');
      // Запускаем поиск от текущей позиции курсора
      triggerRefresh(editor, editor.selection.active);
    })
  );

  // Команда «Очистить результаты» — кнопка в заголовке панели
  context.subscriptions.push(
    vscode.commands.registerCommand('myreferences.clearResults', () => {
      provider.clear(); // сбрасываем все данные и перерисовываем пустое дерево
    })
  );

  // Команда «Переключить авто-обновление» — включает/выключает обновление при движении курсора
  context.subscriptions.push(
    vscode.commands.registerCommand('myreferences.toggleAutoUpdate', () => {
      autoUpdateEnabled = !autoUpdateEnabled; // инвертируем текущее состояние
      // Сохраняем новое значение в глобальные настройки VSCode (persist между сессиями)
      vscode.workspace.getConfiguration('myreferences').update(
        'autoUpdate', autoUpdateEnabled, vscode.ConfigurationTarget.Global
      );
      // Показываем уведомление о новом состоянии
      vscode.window.showInformationMessage(
        `MyReferences: Auto-update ${autoUpdateEnabled ? 'ON' : 'OFF'}`
      );
    })
  );

  // ── Авто-обновление при движении курсора (с debounce) ────────────────────

  // Подписываемся на событие изменения выделения/курсора в любом редакторе
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (!autoUpdateEnabled) { return; } // авто-обновление выключено — игнорируем
      // Пропускаем программные изменения курсора (например, от других команд)
      if (event.kind === vscode.TextEditorSelectionChangeKind.Command) { return; }
      // Пропускаем мультивыделения — нас интересует только единственная позиция курсора
      if (event.selections.length !== 1) { return; }

      // Сбрасываем предыдущий debounce-таймер если он ещё не сработал
      if (debounceTimer !== null) { clearTimeout(debounceTimer); }

      const editor   = event.textEditor;           // редактор, в котором двигался курсор
      const position = event.selections[0].active; // новая позиция курсора
      // Читаем задержку debounce из настроек (по умолчанию 500 мс)
      const ms       = vscode.workspace.getConfiguration('myreferences').get<number>('debounceMs', 500);

      // Запускаем поиск только если курсор не двигался ms миллисекунд подряд
      debounceTimer = setTimeout(() => {
        debounceTimer = null;                    // таймер сработал — сбрасываем ссылку
        triggerRefresh(editor, position);        // запускаем поиск
      }, ms);
    })
  );

  // ── Слушатель изменения настроек ─────────────────────────────────────────

  // Подписываемся на изменение конфигурации VSCode — синхронизируем локальную переменную
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      // Проверяем, изменилась ли именно наша настройка autoUpdate
      if (e.affectsConfiguration('myreferences.autoUpdate')) {
        // Перечитываем актуальное значение из настроек
        autoUpdateEnabled = vscode.workspace
          .getConfiguration('myreferences')
          .get<boolean>('autoUpdate', false);
      }
    })
  );

  // ── Регистрация ресурсов для очистки ─────────────────────────────────────

  // Добавляем объект дерева в subscriptions — VSCode вызовет treeView.dispose() при деактивации
  context.subscriptions.push(treeView);
  // Добавляем кастомный Disposable для очистки того, что VSCode не знает об этом сам:
  // отмена текущего поиска и очистка debounce-таймера
  context.subscriptions.push(
    new vscode.Disposable(() => {
      currentCancelSource?.cancel();  // отменяем активный поиск если расширение деактивируется
      currentCancelSource?.dispose(); // освобождаем ресурсы CancellationTokenSource
      if (debounceTimer !== null) { clearTimeout(debounceTimer); } // очищаем таймер debounce
    })
  );
}

// Функция деактивации — вызывается VSCode при отключении расширения.
// Все ресурсы уже зарегистрированы в context.subscriptions, VSCode освободит их сам.
export function deactivate(): void { /* обработано через context.subscriptions */ }
