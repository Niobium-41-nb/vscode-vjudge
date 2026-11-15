import * as vscode from 'vscode';
import { normalizeUsername, solveStatusKey, VJudgeClient } from './api/client';
import { VJudgeError } from './api/errors';
import { ProblemRef, SolveRecords } from './api/types';

const SECRET_COOKIE = 'vjudge.cookies';
const SECRET_PASSWORD = 'vjudge.password';
const STATE_USERNAME = 'vjudge.username';
const SOLVE_RECORDS_TTL = 5 * 60 * 1000;
const SOLVE_RECORDS_RETRY = 60 * 1000;

export class Session implements vscode.Disposable {
  readonly client: VJudgeClient;
  private loggedInFlag = false;
  private usernameValue?: string;
  private solveRecords?: SolveRecords;
  private solveRecordsUser?: string;
  private solveRecordsAt = 0;
  private solveFailureUser?: string;
  private solveFailureAt = 0;
  private solveLoading?: Promise<void>;
  private solveGeneration = 0;
  private readonly changeEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeLogin = this.changeEmitter.event;
  private readonly solveChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSolveStates = this.solveChangeEmitter.event;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.client = new VJudgeClient();
    this.refreshTimeout();
  }

  get isLoggedIn(): boolean {
    return this.loggedInFlag;
  }

  get username(): string | undefined {
    return this.usernameValue;
  }

  private refreshTimeout(): void {
    const seconds = vscode.workspace.getConfiguration('vjudge').get<number>('requestTimeout', 20);
    this.client.timeoutMs = Math.max(5, seconds) * 1000;
  }

  reloadConfiguration(): void {
    this.refreshTimeout();
  }

  private async setLoggedIn(value: boolean): Promise<void> {
    if (this.loggedInFlag === value) {
      return;
    }
    this.loggedInFlag = value;
    if (!value) {
      this.resetSolveRecords();
    }
    await vscode.commands.executeCommand('setContext', 'vjudge.loggedIn', value);
    this.changeEmitter.fire(value);
  }

  private async setUsername(username: string | undefined): Promise<void> {
    const normalized = normalizeUsername(username);
    if (normalized !== this.usernameValue) {
      this.resetSolveRecords();
    }
    this.usernameValue = normalized;
    await this.context.globalState.update(STATE_USERNAME, normalized);
    const config = vscode.workspace.getConfiguration('vjudge');
    if (config.get<string>('username', '') !== (normalized ?? '')) {
      await config.update('username', normalized ?? '', vscode.ConfigurationTarget.Global);
    }
  }

  async initialize(): Promise<void> {
    this.refreshTimeout();
    this.usernameValue =
      normalizeUsername(this.context.globalState.get<string>(STATE_USERNAME)) ||
      normalizeUsername(vscode.workspace.getConfiguration('vjudge').get<string>('username', '')) ||
      undefined;

    const cookie = await this.context.secrets.get(SECRET_COOKIE);
    if (cookie) {
      this.client.importCookies(cookie);
    }

    try {
      if (this.client.hasCookies() && (await this.client.checkLoginStatus())) {
        const name = await this.client.getUsername();
        if (name) {
          await this.setUsername(name);
        }
        await this.setLoggedIn(true);
        this.output.appendLine('[VJudge] 已通过保存的会话恢复登录。');
      } else {
        const password = await this.context.secrets.get(SECRET_PASSWORD);
        if (this.usernameValue && password) {
          try {
            await this.client.login(this.usernameValue, password);
            await this.setLoggedIn(true);
            this.output.appendLine('[VJudge] 已使用保存的账号密码自动登录。');
          } catch (error) {
            this.output.appendLine(`[VJudge] 自动登录失败：${describeError(error)}`);
            await this.setLoggedIn(false);
          }
        } else {
          await this.setLoggedIn(false);
        }
      }
    } catch (error) {
      this.output.appendLine(`[VJudge] 检查登录状态失败：${describeError(error)}`);
      await this.setLoggedIn(false);
    }
    await this.persistCookies();
  }

  async persistCookies(): Promise<void> {
    const cookies = this.client.exportCookies();
    if (cookies) {
      await this.context.secrets.store(SECRET_COOKIE, cookies);
    }
  }

  async login(): Promise<boolean> {
    this.refreshTimeout();
    const username = await vscode.window.showInputBox({
      title: 'VJudge 登录',
      prompt: '输入 VJudge 用户名',
      value: this.usernameValue ?? '',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请输入用户名'),
    });
    if (username === undefined) {
      return false;
    }
    const password = await vscode.window.showInputBox({
      title: 'VJudge 登录',
      prompt: '输入 VJudge 密码（保存在 VS Code 安全存储中）',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value ? undefined : '请输入密码'),
    });
    if (password === undefined) {
      return false;
    }

    try {
      await this.client.login(username.trim(), password);
    } catch (error) {
      const message = describeError(error);
      const key = error instanceof VJudgeError ? error.i18nKey : undefined;
      const needsHumanVerification =
        (key && /human_verification|turnstile|captcha/i.test(key)) ||
        (error instanceof VJudgeError && error.status === 403);
      const choice = await vscode.window.showErrorMessage(
        needsHumanVerification
          ? `登录失败：${message}（VJudge 可能要求人机验证，可改用 Cookie 登录）`
          : `登录失败：${message}`,
        '使用 Cookie 登录',
      );
      if (choice === '使用 Cookie 登录') {
        return this.loginWithCookie();
      }
      return false;
    }

    this.resetSolveRecords();
    await this.setUsername(username.trim());
    await this.context.secrets.store(SECRET_PASSWORD, password);
    await this.persistCookies();
    await this.setLoggedIn(true);
    void vscode.window.showInformationMessage(`已登录 VJudge：${username.trim()}`);
    return true;
  }

  async loginWithCookie(): Promise<boolean> {
    this.refreshTimeout();
    const username = await vscode.window.showInputBox({
      title: '使用 Cookie 登录',
      prompt: '用于显示提交记录的用户名（可留空自动获取）',
      value: this.usernameValue ?? '',
      ignoreFocusOut: true,
    });
    if (username === undefined) {
      return false;
    }
    const cookie = await vscode.window.showInputBox({
      title: '使用 Cookie 登录',
      prompt: '在浏览器登录 vjudge.net 后，从开发者工具复制完整的 Cookie 请求头（不要只复制 JSESSIONID 的值）',
      placeHolder: 'JSESSIONID=xxxxxxxx',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请粘贴 Cookie'),
    });
    if (cookie === undefined) {
      return false;
    }

    this.client.clearCookies();
    this.client.importCookies(cookie);
    try {
      if (!(await this.client.checkLoginStatus())) {
        this.client.clearCookies();
        void vscode.window.showErrorMessage(
          'Cookie 未通过登录校验：VJudge 判定当前 Cookie 未登录。请确认浏览器中已登录 vjudge.net，刷新页面后重新复制完整 Cookie；若仍失败，可改用用户名密码登录。',
        );
        return false;
      }
    } catch (error) {
      this.client.clearCookies();
      void vscode.window.showErrorMessage(`Cookie 登录失败：${describeError(error)}`);
      return false;
    }

    let finalName = normalizeUsername(username);
    const detected = normalizeUsername(await this.client.getUsername());
    if (detected) {
      finalName = detected;
    }
    this.resetSolveRecords();
    await this.setUsername(finalName);
    await this.persistCookies();
    await this.setLoggedIn(true);
    void vscode.window.showInformationMessage(
      finalName ? `已通过 Cookie 登录 VJudge：${finalName}` : '已通过 Cookie 登录 VJudge。',
    );
    return true;
  }

  async logout(): Promise<void> {
    this.refreshTimeout();
    try {
      await this.client.logout();
    } catch {
      // 忽略注销请求错误
    }
    this.client.clearCookies();
    await this.context.secrets.delete(SECRET_COOKIE);
    await this.context.secrets.delete(SECRET_PASSWORD);
    await this.setUsername(undefined);
    await this.setLoggedIn(false);
    void vscode.window.showInformationMessage('已注销 VJudge 登录。');
  }

  async ensureLoggedIn(): Promise<void> {
    if (this.loggedInFlag) {
      this.refreshTimeout();
      return;
    }

    if (this.client.hasCookies()) {
      try {
        if (await this.client.checkLoginStatus()) {
          await this.setLoggedIn(true);
          return;
        }
      } catch (error) {
        this.output.appendLine(`[VJudge] 恢复登录失败：${describeError(error)}`);
      }
    }

    const choice = await vscode.window.showInformationMessage(
      '此操作需要登录 VJudge。',
      '用户名密码登录',
      '使用 Cookie 登录',
    );
    if (choice === '用户名密码登录') {
      await this.login();
    } else if (choice === '使用 Cookie 登录') {
      await this.loginWithCookie();
    }
    if (!this.loggedInFlag) {
      throw new VJudgeError('操作已取消：未登录 VJudge。');
    }
  }

  private resetSolveRecords(): void {
    this.solveGeneration += 1;
    this.solveRecords = undefined;
    this.solveRecordsUser = undefined;
    this.solveRecordsAt = 0;
    this.solveFailureUser = undefined;
    this.solveFailureAt = 0;
    this.solveLoading = undefined;
  }

  private solveRecordsForCurrentUser(): SolveRecords | undefined {
    if (!this.loggedInFlag || !this.usernameValue) {
      return undefined;
    }
    if (!this.solveRecords || this.solveRecordsUser !== this.usernameValue) {
      return undefined;
    }
    return this.solveRecords;
  }

  private async ensureSolveRecords(): Promise<void> {
    if (!this.loggedInFlag || !this.usernameValue) {
      return;
    }
    const username = this.usernameValue;
    if (
      this.solveRecords &&
      this.solveRecordsUser === username &&
      Date.now() - this.solveRecordsAt < SOLVE_RECORDS_TTL
    ) {
      return;
    }
    if (
      this.solveFailureUser === username &&
      this.solveFailureAt > 0 &&
      Date.now() - this.solveFailureAt < SOLVE_RECORDS_RETRY
    ) {
      return;
    }
    if (this.solveLoading) {
      return this.solveLoading;
    }
    const generation = this.solveGeneration;
    const loading = (async () => {
      try {
        const records = await this.client.getUserSolveRecords(username);
        if (generation !== this.solveGeneration || this.usernameValue !== username) {
          return;
        }
        this.solveRecords = records;
        this.solveRecordsUser = username;
        this.solveRecordsAt = Date.now();
        this.solveFailureUser = undefined;
        this.solveFailureAt = 0;
        this.solveChangeEmitter.fire();
      } catch (error) {
        this.solveFailureUser = username;
        this.solveFailureAt = Date.now();
        this.output.appendLine(`[VJudge] 获取做题状态失败：${describeError(error)}`);
      }
    })();
    this.solveLoading = loading;
    void loading.finally(() => {
      if (this.solveLoading === loading) {
        this.solveLoading = undefined;
      }
    });
    return loading;
  }

  async prefetchSolveStates(): Promise<void> {
    await this.ensureSolveRecords();
  }

  applyCachedSolveStates(refs: ProblemRef[]): void {
    const records = this.solveRecordsForCurrentUser();
    for (const ref of refs) {
      if (!records) {
        ref.solvedState = undefined;
        continue;
      }
      const key = solveStatusKey(ref.oj, ref.probNum);
      if (records.accepted.has(key)) {
        ref.solvedState = 1;
      } else if (records.attempted.has(key)) {
        ref.solvedState = 0;
      } else {
        ref.solvedState = -1;
      }
    }
  }

  noteSubmissionResult(ref: ProblemRef, statusType: number): void {
    const records = this.solveRecordsForCurrentUser();
    if (!records) {
      return;
    }
    const key = solveStatusKey(ref.oj, ref.probNum);
    if (statusType === 0) {
      records.accepted.add(key);
    } else if (!records.accepted.has(key)) {
      records.attempted.add(key);
    }
    this.applyCachedSolveStates([ref]);
  }

  async requireUsername(): Promise<string> {
    if (this.usernameValue) {
      return this.usernameValue;
    }
    const name = await vscode.window.showInputBox({
      title: 'VJudge 用户名',
      prompt: '查看提交记录需要用户名',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请输入用户名'),
    });
    if (!name) {
      throw new VJudgeError('缺少用户名，无法获取提交记录。');
    }
    await this.setUsername(name.trim());
    return name.trim();
  }

  async updateUsername(username: string | undefined): Promise<void> {
    await this.setUsername(username);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.persistCookies();
    this.changeEmitter.dispose();
    this.solveChangeEmitter.dispose();
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
