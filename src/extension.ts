import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ensureGlobalTemplates } from './globalTemplates';
import { describeError, Session } from './session';
import { clearStatementCache } from './statementCache';
import { ContestsProvider } from './views/contests';
import { ProblemsProvider } from './views/problems';
import { StatementPanel } from './views/statementPanel';
import { SubmissionsProvider } from './views/submissions';
import { WorkbooksProvider } from './views/workbooks';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ExtensionController(context);
  context.subscriptions.push(controller);
  void controller.activate();
}

export function deactivate(): void {
  // 资源由 ExtensionController.dispose 统一释放
}

class ExtensionController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('VJudge');
  private readonly session: Session;
  private readonly statement: StatementPanel;
  private readonly problems: ProblemsProvider;
  private readonly contests: ContestsProvider;
  private readonly submissions: SubmissionsProvider;
  private readonly workbooks: WorkbooksProvider;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.session = new Session(context, this.output);
    this.statement = new StatementPanel(this.session);
    this.problems = new ProblemsProvider(this.session, context.extensionUri);
    this.contests = new ContestsProvider(this.session, context.extensionUri);
    this.submissions = new SubmissionsProvider(this.session, context.extensionUri);
    this.workbooks = new WorkbooksProvider(this.session, context.extensionUri);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  }

  async activate(): Promise<void> {
    void ensureGlobalTemplates(this.context).catch((error) => {
      this.output.appendLine(`[VJudge] 创建全局语言模板失败：${describeError(error)}`);
    });
    this.disposables.push(
      this.output,
      this.session,
      this.statement,
      this.problems,
      this.contests,
      this.submissions,
      this.workbooks,
      this.statusBar,
      vscode.window.createTreeView('vjudge.problems', {
        treeDataProvider: this.problems,
        showCollapseAll: false,
      }),
      vscode.window.createTreeView('vjudge.contests', {
        treeDataProvider: this.contests,
        showCollapseAll: false,
      }),
      vscode.window.createTreeView('vjudge.submissions', {
        treeDataProvider: this.submissions,
        showCollapseAll: false,
      }),
      vscode.window.createTreeView('vjudge.workbooks', {
        treeDataProvider: this.workbooks,
        showCollapseAll: false,
      }),
      ...registerCommands({
        context: this.context,
        session: this.session,
        problems: this.problems,
        contests: this.contests,
        submissions: this.submissions,
        workbooks: this.workbooks,
        statement: this.statement,
        output: this.output,
      }),
      vscode.commands.registerCommand('vjudge.statusBar', () => this.showStatusMenu()),
      this.session.onDidChangeLogin((loggedIn) => {
        this.updateStatusBar();
        this.problems.refresh();
        this.contests.refresh();
        this.submissions.refresh();
        this.workbooks.refresh();
        clearStatementCache();
        if (loggedIn) {
          void this.submissions.reload(true);
        }
      }),
      this.session.onDidChangeSolveStates(() => {
        this.problems.refreshSolveStates();
        this.contests.refreshSolveStates();
        this.workbooks.refreshSolveStates();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vjudge.requestTimeout')) {
          this.session.reloadConfiguration();
        }
        if (event.affectsConfiguration('vjudge.statusRefreshInterval')) {
          this.submissions.startAutoRefresh();
        }
      }),
    );

    this.statusBar.command = 'vjudge.login';
    this.statusBar.show();
    this.updateStatusBar();

    try {
      await this.session.initialize();
    } catch (error) {
      this.output.appendLine(`[VJudge] 初始化登录状态失败：${describeError(error)}`);
    }
    this.updateStatusBar();
    this.submissions.startAutoRefresh();
    if (this.session.isLoggedIn) {
      void this.submissions.reload(true);
    }
  }

  private updateStatusBar(): void {
    const loggedIn = this.session.isLoggedIn;
    if (loggedIn) {
      this.statusBar.text = `$(account) VJudge: ${this.session.username ?? '已登录'}`;
      this.statusBar.tooltip = 'VJudge 已登录，点击打开菜单';
      this.statusBar.command = 'vjudge.statusBar';
    } else {
      this.statusBar.text = '$(account) VJudge 未登录';
      this.statusBar.tooltip = '点击登录 VJudge';
      this.statusBar.command = 'vjudge.login';
    }
  }

  private async showStatusMenu(): Promise<void> {
    if (!this.session.isLoggedIn) {
      await vscode.commands.executeCommand('vjudge.login');
      return;
    }
    const items: vscode.QuickPickItem[] = [
      { label: '$(search) 搜索题目', description: 'vjudge.searchProblem' },
      { label: '$(book) 搜索题单', description: 'vjudge.searchWorkbooks' },
      { label: '$(refresh) 刷新提交记录', description: 'vjudge.refreshSubmissions' },
      { label: '$(output) 显示输出日志', description: 'vjudge.showOutput' },
      { label: '$(sign-out) 注销', description: 'vjudge.logout' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `VJudge：${this.session.username ?? '已登录'}`,
      placeHolder: '选择操作',
    });
    if (!picked?.description) {
      return;
    }
    await vscode.commands.executeCommand(picked.description);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
