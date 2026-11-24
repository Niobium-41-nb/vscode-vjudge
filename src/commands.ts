import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { CaptchaRequiredError, VJudgeError } from './api/errors';
import { sanitizeStatementHtml } from './api/parser';
import { ProblemRef, RemoteAccountBinding, SearchProblemOptions, Solution, SubmissionSummary, WorkbookCategory, WorkbookSummary } from './api/types';
import { CphFileProblem, CphStore } from './cph';
import { cphProblemRef } from './cphFormat';
import { ensureGlobalHeaders, globalHeaderFile, globalHeadersDirectory } from './globalHeaders';
import { ensureGlobalTemplates, globalTemplateFile, globalTemplatesDirectory } from './globalTemplates';
import { problemFile, problemForFile, rememberProblemFile } from './problemFiles';
import { problemRefFromPath } from './problemName';
import { runImportedSamples, runSamples } from './sampleRunner';
import { describeError, Session } from './session';
import {
  clearStatementCache,
  fetchStatement,
  problemUrl,
  statementKey,
} from './statementCache';
import {
  applyLanguageHeader,
  applyTemplateVariables,
  buildCodeTemplate,
  builtinHeaderFiles,
  builtinTemplateFiles,
  safeFileBase,
  templateForLanguage,
  templateSettingValue,
} from './templates';
import { getConfiguration } from './utils';
import { ContestsProvider } from './views/contests';
import { ProblemsProvider } from './views/problems';
import { StatementPanel } from './views/statementPanel';
import { SubmissionsProvider } from './views/submissions';
import { WorkbooksProvider } from './views/workbooks';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  session: Session;
  problems: ProblemsProvider;
  contests: ContestsProvider;
  submissions: SubmissionsProvider;
  workbooks: WorkbooksProvider;
  statement: StatementPanel;
  output: vscode.OutputChannel;
}

interface RecentProblem {
  label: string;
  description: string;
  ref: ProblemRef;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProblemRef(value: unknown): value is ProblemRef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.oj === 'string' && typeof record.probNum === 'string';
}

function sameProblem(a: ProblemRef, b: ProblemRef): boolean {
  return (
    a.oj.toLowerCase() === b.oj.toLowerCase() &&
    a.probNum.toLowerCase() === b.probNum.toLowerCase()
  );
}

function parseProblemTokens(input: string): ProblemRef[] {
  const tokens = input
    .replace(/\[problem:([^\]]+)\]/gi, '$1')
    .split(/[\s,，;；]+/)
    .map((token) => token.trim().replace(/^[[(]+|[)\]]+$/g, ''))
    .filter(Boolean);
  const seen = new Set<string>();
  const refs: ProblemRef[] = [];
  for (const token of tokens) {
    const dash = token.indexOf('-');
    if (dash <= 0 || dash >= token.length - 1) {
      continue;
    }
    const oj = token.slice(0, dash);
    const probNum = token.slice(dash + 1);
    if (/[\s[\]()]/.test(oj) || /[\s[\]()]/.test(probNum)) {
      continue;
    }
    const key = `${oj}-${probNum}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ oj, probNum });
  }
  return refs;
}

function appendProblemMarkers(content: string, refs: ProblemRef[]): string {
  const base = content.replace(/\s+$/, '');
  const block = refs.map((ref) => `[problem:${ref.oj}-${ref.probNum}]`).join('\n');
  return base ? `${base}\n\n${block}` : block;
}

function isSubmission(value: unknown): value is SubmissionSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return typeof (value as Record<string, unknown>).runId === 'number';
}

function isContest(value: unknown): value is { id: number; title?: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'number' &&
    typeof record.title === 'string' &&
    (typeof record.begin === 'number' ||
      typeof record.end === 'number' ||
      Array.isArray(record.problems))
  );
}

function isWorkbook(value: unknown): value is WorkbookSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'number' && typeof record.title === 'string' && typeof record.author === 'string';
}

function isWorkbookCategory(value: unknown): value is WorkbookCategory {
  return value === 'joined' || value === 'created' || value === 'followed' || value === 'all';
}

function unwrapNode(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.ref && isProblemRef(record.ref)) {
      return record.ref;
    }
    if (record.contest && isContest(record.contest)) {
      return record.contest;
    }
    if (record.submission && isSubmission(record.submission)) {
      return record.submission;
    }
    if (record.workbook && isWorkbook(record.workbook)) {
      return record.workbook;
    }
  }
  return value;
}

export async function loadProblemLanguages(
  session: Session,
  ref: ProblemRef,
  onError: (error: unknown) => void,
): Promise<Record<string, string>> {
  if (ref.languages && Object.keys(ref.languages).length > 0) {
    return ref.languages;
  }
  try {
    const statementInfo = await fetchStatement(session, ref);
    if (Object.keys(statementInfo.languages).length > 0) {
      ref.languages = statementInfo.languages;
      return statementInfo.languages;
    }
  } catch (error) {
    onError(error);
  }
  try {
    const detail = await session.client.getProblemDetail(ref.oj, ref.probNum);
    ref.languages = detail.languages;
    if (!ref.submitMethods && detail.submitMethods) {
      ref.submitMethods = detail.submitMethods;
    }
    return detail.languages;
  } catch (error) {
    onError(error);
    return {};
  }
}

function languageIdFor(language: string): string {
  switch (templateForLanguage(language).extension) {
    case 'cpp':
      return 'cpp';
    case 'c':
      return 'c';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'js':
      return 'javascript';
    case 'ts':
      return 'typescript';
    case 'kt':
      return 'kotlin';
    case 'cs':
      return 'csharp';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'hs':
      return 'haskell';
    case 'pas':
      return 'pascal';
    case 'swift':
      return 'swift';
    default:
      return 'plaintext';
  }
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, session, problems, contests, submissions, workbooks, statement, output } = deps;
  const cphStore = new CphStore(context);
  let lastProblem: ProblemRef | undefined;
  const recent: RecentProblem[] = [];
  const knownOjsKey = 'vjudge.knownOjs';

  const remember = (ref: ProblemRef): void => {
    lastProblem = ref;
    const key = statementKey(ref);
    const index = recent.findIndex((item) => statementKey(item.ref) === key);
    if (index >= 0) {
      recent.splice(index, 1);
    }
    recent.unshift({
      label: ref.title?.trim() || `${ref.oj}-${ref.probNum}`,
      description: `${ref.oj}-${ref.probNum}`,
      ref,
    });
    if (recent.length > 20) {
      recent.length = 20;
    }
    const knownOjs = context.globalState.get<string[]>(knownOjsKey, []);
    if (ref.oj && !knownOjs.some((name) => name.toLowerCase() === ref.oj.toLowerCase())) {
      void context.globalState.update(knownOjsKey, [...knownOjs, ref.oj].slice(-200));
    }
  };

  const ensureLogin = async (): Promise<boolean> => {
    try {
      await session.ensureLoggedIn();
      return session.isLoggedIn;
    } catch (error) {
      void vscode.window.showErrorMessage(describeError(error));
      return false;
    }
  };

  const reportError = async (prefix: string, error: unknown): Promise<void> => {
    const message = `${prefix}${describeError(error)}`;
    if (error instanceof VJudgeError && error.i18nKey) {
      output.appendLine(
        `[VJudge] ${prefix}错误键：${error.i18nKey}${error.status ? `（HTTP ${error.status}）` : ''}`,
      );
    }
    if (error instanceof VJudgeError && error.kind === 'login') {
      await session.handleLoginExpired(message);
      return;
    }
    void vscode.window.showErrorMessage(message);
  };

  const resolveProblem = async (
    arg: unknown,
    interactive = true,
    inferFromFileName = false,
  ): Promise<ProblemRef | undefined> => {
    const direct = unwrapNode(arg);
    if (isProblemRef(direct)) {
      return direct;
    }
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : vscode.window.activeTextEditor?.document.uri;
    if (uri) {
      const mapped = problemForFile(uri);
      if (mapped) {
        return mapped;
      }
      if (inferFromFileName && uri.scheme === 'file') {
        const inferred = problemRefFromPath(uri.fsPath, [
          ...recent.map((item) => item.ref.oj),
          ...context.globalState.get<string[]>(knownOjsKey, []),
        ]);
        if (inferred) {
          output.appendLine(`[VJudge] 已从文件名识别题目：${inferred.oj}-${inferred.probNum}`);
          return inferred;
        }
      }
    }
    if (!interactive) {
      return lastProblem;
    }
    if (recent.length === 0) {
      void vscode.window.showWarningMessage(
        '无法确定要操作的题目。请先从侧边栏打开一道题目，或将代码文件按“OJ-题号”命名（如 CodeForces-4A.cpp）。',
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      recent.map((item) => ({
        label: item.label,
        description: item.description,
        ref: item.ref,
      })),
      { title: '选择题目', placeHolder: '选择最近访问过的题目' },
    );
    return picked?.ref;
  };

  const pickLanguage = async (
    languages: Record<string, string>,
    title: string,
  ): Promise<string | undefined> => {
    const remembered = context.globalState.get<string>('vjudge.lastLanguage') ?? '';
    const configured = getConfiguration('defaultLanguage', '');
    const preferred = remembered || configured;
    const entries = Object.entries(languages);
    let code: string | undefined;
    if (entries.length === 0) {
      code = await vscode.window.showInputBox({
        title,
        prompt: '无法自动获取语言列表，请输入 VJudge 上的语言名称',
        value: preferred || 'GNU G++17',
        ignoreFocusOut: true,
      });
    } else {
      const items = entries
        .map(([value, label]) => ({
          label: label || value,
          description: label && label !== value ? value : undefined,
          value,
        }))
        .sort((a, b) => {
          const aPreferred = a.value === preferred || a.label === preferred ? 1 : 0;
          const bPreferred = b.value === preferred || b.label === preferred ? 1 : 0;
          return bPreferred - aPreferred;
        });
      const picked = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: '选择提交语言',
        matchOnDescription: true,
      });
      code = picked?.value;
    }
    const trimmed = code?.trim();
    if (trimmed) {
      await context.globalState.update('vjudge.lastLanguage', trimmed);
    }
    return trimmed || undefined;
  };

  const isMethodNotAllowed = (error: unknown): boolean => {
    const key = error instanceof VJudgeError ? (error.i18nKey ?? '') : '';
    return /submit_method_not_allowed$/i.test(key);
  };

  const remoteRequiredKey = (oj: string): string => `vjudge.remoteRequired.${oj.toLowerCase()}`;
  const markRemoteRequired = async (oj: string): Promise<void> => {
    await context.globalState.update(remoteRequiredKey(oj), true);
  };
  const requiresRemoteAccount = async (ref: ProblemRef): Promise<boolean> => {
    if (ref.submitMethods && ref.submitMethods.length > 0) {
      if (ref.submitMethods[0] !== true) {
        await markRemoteRequired(ref.oj);
        return true;
      }
      return false;
    }
    return context.globalState.get<boolean>(remoteRequiredKey(ref.oj)) === true;
  };

  const remoteStatusLabel = (item: RemoteAccountBinding): string => {
    const runtime = (item.runtimeStatus ?? '').toUpperCase();
    if (runtime === 'READY') {
      return '可用';
    }
    if (runtime === 'REQUIRES_UNLOCK') {
      return '已锁定';
    }
    const health = (item.healthStatus ?? '').toUpperCase();
    if (health === 'NORMAL') {
      return '正常';
    }
    if (health === 'WARNING') {
      return '异常';
    }
    if (health === 'BROKEN') {
      return '已失效';
    }
    if (health === 'INCOMPLETE') {
      return '信息不完整';
    }
    if (health === 'INVALID') {
      return item.statusReason ? `失效（${item.statusReason}）` : '失效';
    }
    return runtime || health || '状态未知';
  };

  const chooseRemoteAccount = async (oj: string): Promise<number | undefined> => {
    let bindings: RemoteAccountBinding[];
    try {
      bindings = await session.client.listRemoteAccounts(oj);
    } catch (error) {
      await reportError('获取远程 OJ 账号失败：', error);
      return undefined;
    }
    const ready = bindings.filter(
      (item) => !item.runtimeStatus || item.runtimeStatus.toUpperCase() === 'READY',
    );
    output.appendLine(
      `[VJudge] ${oj} 远程账号：${bindings.length > 0
        ? bindings.map((item) => `#${item.id} ${remoteStatusLabel(item)}`).join('，')
        : '未绑定'}`,
    );
    const manageUrl = `https://vjudge.net/user/remoteAccounts?oj=${encodeURIComponent(oj)}`;
    if (ready.length === 0) {
      const hint = bindings.length === 0
        ? `VJudge 不允许直接向 ${oj} 提交，需要先在 VJudge 绑定自己的 ${oj} 账号并保持登录状态。`
        : `已绑定 ${bindings.length} 个 ${oj} 账号，但当前都不可用（${bindings
            .map((item) => remoteStatusLabel(item))
            .join('、')}），请在 VJudge 重新登录或解锁该远程账号。`;
      const action = await vscode.window.showErrorMessage(hint, '打开账号管理');
      if (action === '打开账号管理') {
        void vscode.env.openExternal(vscode.Uri.parse(manageUrl));
      }
      return undefined;
    }
    const memoryKey = `vjudge.remoteAccount.${oj.toLowerCase()}`;
    const remembered = context.globalState.get<number>(memoryKey);
    const rememberedMatch = ready.find((item) => item.id === remembered);
    if (rememberedMatch) {
      return rememberedMatch.id;
    }
    if (ready.length === 1) {
      await context.globalState.update(memoryKey, ready[0].id);
      return ready[0].id;
    }
    const picked = await vscode.window.showQuickPick(
      ready.map((item) => ({
        label: item.accountDisplay || item.accountId || `账号 ${item.id}`,
        description: `绑定 ID ${item.id}`,
        id: item.id,
      })),
      { title: `选择 ${oj} 提交账号`, placeHolder: '使用哪个已绑定的远程账号提交' },
    );
    if (picked) {
      await context.globalState.update(memoryKey, picked.id);
    }
    return picked?.id;
  };

  const languageForProblem = (ref: ProblemRef): Promise<Record<string, string>> =>
    loadProblemLanguages(
      session,
      ref,
      (error) => output.appendLine(`[VJudge] 获取语言列表失败：${describeError(error)}`),
    );

  const resolveEditor = async (ref: ProblemRef): Promise<vscode.TextEditor | undefined> => {
    const uri = problemFile(ref);
    if (uri) {
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.toString() === uri.toString(),
      );
      if (document) {
        const editor = vscode.window.visibleTextEditors.find(
          (item) => item.document === document,
        );
        if (editor) {
          return editor;
        }
      }
      try {
        return await vscode.window.showTextDocument(uri, { preview: false });
      } catch {
        // 文件可能已被删除
      }
    }
    return vscode.window.activeTextEditor;
  };

  const openProblem = async (arg: unknown): Promise<void> => {
    const ref = await resolveProblem(arg);
    if (!ref) {
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    remember(ref);
    try {
      await statement.show(ref);
    } catch (error) {
      await reportError('打开题面失败：', error);
    }
  };

  const searchProblems = async (): Promise<void> => {
    if (!(await ensureLogin())) {
      return;
    }
    const keyword = await vscode.window.showInputBox({
      title: '搜索 VJudge 题目',
      prompt: '输入题号或标题关键词，留空浏览最新题目',
      placeHolder: '例如 1000、A+B 或 CodeForces-1A',
      ignoreFocusOut: true,
    });
    if (keyword === undefined) {
      return;
    }
    const criteria: SearchProblemOptions = {};
    const trimmed = keyword.trim();
    const direct = trimmed.match(/^([A-Za-z][\w.+-]*)-([\w.+-]+)$/);
    if (direct) {
      criteria.oj = direct[1];
      criteria.probNum = direct[2];
    } else if (trimmed) {
      criteria.title = trimmed;
    }
    await problems.search(criteria);
    try {
      await vscode.commands.executeCommand('vjudge.problems.focus');
    } catch {
      // 视图聚焦失败不影响搜索
    }
    await problems.loadMore();
  };

  const searchWorkbooks = async (): Promise<void> => {
    if (!(await ensureLogin())) {
      return;
    }
    const keyword = await vscode.window.showInputBox({
      title: '搜索 VJudge 题单',
      prompt: '输入题单标题关键词，留空浏览公开题单',
      placeHolder: '例如 紫书、计算几何',
      ignoreFocusOut: true,
    });
    if (keyword === undefined) {
      return;
    }
    workbooks.search(keyword);
    try {
      await vscode.commands.executeCommand('vjudge.workbooks.focus');
    } catch {
      // 视图聚焦失败不影响搜索
    }
    void workbooks.loadMore('all');
  };

  const toggleWorkbookMembership = async (arg: unknown): Promise<void> => {
    const direct = unwrapNode(arg);
    if (!isWorkbook(direct)) {
      void vscode.window.showWarningMessage('请从题单视图中选择要加入或退出的题单。');
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    let joined: boolean;
    try {
      const detail = await session.client.getWorkbookDetail(direct.id);
      joined = detail.joined;
    } catch (error) {
      await reportError('获取题单信息失败：', error);
      return;
    }
    const action = joined ? '退出' : '加入';
    const choice = await vscode.window.showWarningMessage(
      `确定${action}题单“${direct.title || direct.id}”吗？`,
      '确定',
    );
    if (choice !== '确定') {
      return;
    }
    try {
      if (joined) {
        await session.client.leaveWorkbook(direct.id);
      } else {
        await session.client.joinWorkbook(direct.id);
      }
      await session.persistCookies();
    } catch (error) {
      await reportError(`${action}题单失败：`, error);
      return;
    }
    workbooks.refresh();
    void vscode.window.showInformationMessage(`已${action}题单。`);
  };

  const copyWorkbookLink = async (arg: unknown): Promise<void> => {
    const direct = unwrapNode(arg);
    if (!isWorkbook(direct)) {
      void vscode.window.showWarningMessage('请从题单视图中选择要复制的题单。');
      return;
    }
    await vscode.env.clipboard.writeText(`https://vjudge.net/article/${direct.id}`);
    void vscode.window.showInformationMessage('已复制题单链接。');
  };

  const promptProblemRefs = async (): Promise<ProblemRef[] | undefined> => {
    const input = await vscode.window.showInputBox({
      title: '输入题目',
      prompt: '支持一次输入多个题目，用空格、逗号或换行分隔',
      placeHolder: '例如 CodeForces-1A POJ-1000',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.trim()) {
          return '请输入至少一个题目编号';
        }
        return parseProblemTokens(value).length > 0
          ? undefined
          : '无法识别题目编号，请使用“OJ-题号”格式，例如 CodeForces-1A';
      },
    });
    if (input === undefined) {
      return undefined;
    }
    return parseProblemTokens(input);
  };

  const pickCreatedWorkbook = async (): Promise<WorkbookSummary | undefined> => {
    let created: WorkbookSummary[];
    try {
      const result = await session.client.listWorkbooks('created', { length: 100 });
      created = result.workbooks;
    } catch (error) {
      await reportError('获取我创建的题单失败：', error);
      return undefined;
    }
    if (created.length === 0) {
      void vscode.window.showWarningMessage(
        '还没有创建题单。请先运行“VJudge: 创建题单”。',
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      created.map((workbook) => ({
        label: workbook.title || `题单 #${workbook.id}`,
        description: `#${workbook.id} · ${workbook.problemCount} 题`,
        workbook,
      })),
      {
        title: '选择题单',
        placeHolder: '选择要添加题目的题单',
        matchOnDescription: true,
      },
    );
    return picked?.workbook;
  };

  const createWorkbook = async (): Promise<void> => {
    if (!(await ensureLogin())) {
      return;
    }
    const title = await vscode.window.showInputBox({
      title: '创建 VJudge 题单',
      prompt: '输入题单标题',
      placeHolder: '例如 动态规划入门',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '题单标题不能为空'),
    });
    if (title === undefined) {
      return;
    }
    const visibility = await vscode.window.showQuickPick(
      [
        { label: '公开', description: '所有人可以搜索和查看', value: 2 },
        { label: '不公开', description: '不在公开列表中显示，可通过链接访问', value: 1 },
        { label: '私密', description: '仅自己可见', value: 0 },
      ],
      { title: '题单可见性', placeHolder: '选择题单可见性' },
    );
    if (!visibility) {
      return;
    }
    const refs = await promptProblemRefs();
    if (!refs || refs.length === 0) {
      return;
    }
    const content = appendProblemMarkers('', refs);
    let id: number | undefined;
    try {
      id = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '创建题单', cancellable: false },
        () =>
          session.client.createWorkbook({
            title: title.trim(),
            content,
            openness: visibility.value,
            nodeId: 0,
          }),
      );
      await session.persistCookies();
    } catch (error) {
      await reportError('创建题单失败：', error);
      return;
    }
    workbooks.refresh();
    try {
      await vscode.commands.executeCommand('vjudge.workbooks.focus');
    } catch {
      // 视图聚焦失败不影响创建结果
    }
    const suffix = id ? `（#${id}）` : '';
    const privateNote = visibility.value === 0 ? '私密题单不会出现在题单列表中。' : '';
    const choice = await vscode.window.showInformationMessage(
      `已创建题单“${title.trim()}”${suffix}，共 ${refs.length} 道题目。${privateNote}`,
      ...(id ? ['在浏览器打开'] : []),
    );
    if (choice === '在浏览器打开' && id) {
      await vscode.env.openExternal(vscode.Uri.parse(`https://vjudge.net/article/${id}`, true));
    }
  };

  const addProblemsToWorkbook = async (arg: unknown): Promise<void> => {
    if (!(await ensureLogin())) {
      return;
    }
    const direct = unwrapNode(arg);
    let workbook: WorkbookSummary | undefined;
    let refs: ProblemRef[] | undefined;
    if (isWorkbook(direct)) {
      workbook = direct;
      refs = await promptProblemRefs();
    } else {
      const ref = isProblemRef(direct) ? direct : await resolveProblem(arg);
      if (!ref) {
        return;
      }
      refs = [ref];
      workbook = await pickCreatedWorkbook();
    }
    if (!workbook || !refs || refs.length === 0) {
      return;
    }

    let detail;
    try {
      detail = await session.client.getWorkbookDetail(workbook.id);
    } catch (error) {
      await reportError('获取题单信息失败：', error);
      return;
    }
    const fresh = refs.filter(
      (ref) => !detail.problems.some((existing) => sameProblem(existing, ref)),
    );
    if (fresh.length === 0) {
      void vscode.window.showInformationMessage('这些题目已经在题单中了。');
      return;
    }
    const names = fresh.map((ref) => `${ref.oj}-${ref.probNum}`).join('、');
    const choice = await vscode.window.showWarningMessage(
      `向题单“${detail.title || workbook.title || `#${workbook.id}`}”添加 ${fresh.length} 道题目？\n${names}`,
      { modal: true },
      '添加',
    );
    if (choice !== '添加') {
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '添加题目到题单', cancellable: false },
        () =>
          session.client.updateWorkbook(workbook!.id, {
            title: detail.title || workbook!.title,
            content: appendProblemMarkers(detail.content, fresh),
            openness: detail.openness,
            nodeId: detail.nodeId,
          }),
      );
      await session.persistCookies();
    } catch (error) {
      // 连接可能在服务端已保存后中断，先确认结果再报错
      let applied = false;
      try {
        const current = await session.client.getWorkbookDetail(workbook!.id);
        applied = fresh.every((ref) =>
          current.problems.some((existing) => sameProblem(existing, ref)),
        );
      } catch {
        // 无法确认时按失败处理
      }
      if (!applied) {
        await reportError('添加题目失败：', error);
        return;
      }
      await session.persistCookies();
    }
    workbooks.refresh();
    const skipped = refs.length - fresh.length;
    const suffix = skipped > 0 ? `，跳过 ${skipped} 道已存在的题目` : '';
    void vscode.window.showInformationMessage(
      `已向题单添加 ${fresh.length} 道题目${suffix}。`,
    );
  };

  const autoLinkCph = async (ref: ProblemRef, target: vscode.Uri): Promise<void> => {
    try {
      let problem: CphFileProblem | undefined = (await cphStore.findForRef(ref)).filter(
        (item) => item.tests.length > 0,
      )[0];
      let created = false;
      if (!problem) {
        const statement = await fetchStatement(session, ref);
        problem = await cphStore.saveSamples(
          ref,
          target,
          statement.samples,
          statement.title || ref.title,
        );
        if (!problem) {
          output.appendLine('[VJudge] 题面没有可用样例，未写入 CPH 测试数据。');
          void vscode.window.showWarningMessage('题面没有可用样例，未导入 CPH 测试数据。');
          return;
        }
        created = true;
      }
      await cphStore.remember([problem]);
      await cphStore.linkSource(target, problem.probPath);
      void vscode.window.showInformationMessage(
        `${created ? '已导入' : '已关联'} CPH 测试数据（${problem.tests.length} 个测试）：${problem.name}`,
      );
    } catch (error) {
      output.appendLine(`[VJudge] 自动导入 CPH 失败：${describeError(error)}`);
      void vscode.window.showWarningMessage(`自动导入 CPH 失败：${describeError(error)}`);
    }
  };

  const readTemplateFile = async (
    ref: ProblemRef,
    uri: vscode.Uri,
    title: string,
  ): Promise<string> => {
    const data = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(data).toString('utf8').replace(/^\uFEFF/, '');
    return applyTemplateVariables(content, { title, oj: ref.oj, probNum: ref.probNum });
  };

  const loadLanguageTemplate = async (
    ref: ProblemRef,
    language: string,
    extension: string,
    title: string,
  ): Promise<string | undefined> => {
    const settings = getConfiguration<Record<string, string>>('languageTemplates', {});
    if (settings && typeof settings === 'object') {
      const value = templateSettingValue(settings, [language, extension, `.${extension}`]);
      if (value) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const filePath = path.isAbsolute(value)
          ? value
          : folder
            ? path.join(folder.uri.fsPath, value)
            : '';
        if (!filePath) {
          void vscode.window.showWarningMessage(
            `语言模板“${value}”是相对路径，请先打开工作区或改用绝对路径。`,
          );
        } else {
          try {
            return await readTemplateFile(ref, vscode.Uri.file(filePath), title);
          } catch (error) {
            void vscode.window.showWarningMessage(
              `读取语言模板失败：${describeError(error)}（${filePath}），将使用全局模板或内置模板。`,
            );
          }
        }
      }
    }
    const globalFile = globalTemplateFile(context, extension);
    if (!globalFile) {
      return undefined;
    }
    try {
      await ensureGlobalTemplates(context);
      return await readTemplateFile(ref, globalFile.uri, title);
    } catch {
      return undefined;
    }
  };

  const editLanguageTemplate = async (): Promise<void> => {
    try {
      await ensureGlobalTemplates(context, true);
    } catch (error) {
      void vscode.window.showErrorMessage(`创建全局模板失败：${describeError(error)}`);
      return;
    }
    const directory = globalTemplatesDirectory(context);
    const items: (vscode.QuickPickItem & { template?: string })[] = [
      {
        label: '$(folder-opened) 打开模板目录',
        description: directory.fsPath,
      },
      ...builtinTemplateFiles().map((file) => ({
        label: file.fileName,
        description: `.${file.extension}`,
        template: file.fileName,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: '编辑语言模板',
      placeHolder: '选择要编辑的模板文件，或打开模板目录',
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    if (!picked.template) {
      await vscode.env.openExternal(directory);
      return;
    }
    const target = vscode.Uri.joinPath(directory, picked.template);
    try {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      void vscode.window.showErrorMessage(`打开模板失败：${describeError(error)}`);
    }
  };

  const resolveHeaderFilePath = (value: string): string => {
    if (path.isAbsolute(value)) {
      return value;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, value) : '';
  };

  const readHeaderText = async (
    ref: ProblemRef,
    uri: vscode.Uri,
    title: string,
  ): Promise<string> => {
    const data = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(data).toString('utf8').replace(/^\uFEFF/, '');
    return applyTemplateVariables(content.replace(/\r\n?/g, '\n'), {
      title,
      oj: ref.oj,
      probNum: ref.probNum,
    });
  };

  const loadLanguageHeader = async (
    ref: ProblemRef,
    language: string,
    extension: string,
    title: string,
  ): Promise<string | undefined> => {
    const candidates = [language, extension, `.${extension}`];
    const settings = getConfiguration<Record<string, string>>('languageHeaders', {});
    if (settings && typeof settings === 'object') {
      const value = templateSettingValue(settings, candidates);
      if (value) {
        return applyTemplateVariables(value.replace(/\r\n?/g, '\n'), {
          title,
          oj: ref.oj,
          probNum: ref.probNum,
        });
      }
    }
    const fileSettings = getConfiguration<Record<string, string>>('languageHeaderFiles', {});
    if (fileSettings && typeof fileSettings === 'object') {
      const value = templateSettingValue(fileSettings, candidates);
      if (value) {
        const filePath = resolveHeaderFilePath(value);
        if (!filePath) {
          void vscode.window.showWarningMessage(
            `头文件“${value}”是相对路径，请先打开工作区或改用绝对路径。`,
          );
        } else {
          try {
            return await readHeaderText(ref, vscode.Uri.file(filePath), title);
          } catch (error) {
            void vscode.window.showWarningMessage(
              `读取头文件失败：${describeError(error)}（${filePath}），将使用全局头文件。`,
            );
          }
        }
      }
    }
    const globalFile = globalHeaderFile(context, extension);
    if (!globalFile) {
      return undefined;
    }
    try {
      await ensureGlobalHeaders(context);
      return await readHeaderText(ref, globalFile.uri, title);
    } catch {
      return undefined;
    }
  };

  const editLanguageHeader = async (): Promise<void> => {
    try {
      await ensureGlobalHeaders(context, true);
    } catch (error) {
      void vscode.window.showErrorMessage(`创建全局头文件失败：${describeError(error)}`);
      return;
    }
    const directory = globalHeadersDirectory(context);
    const items: (vscode.QuickPickItem & { header?: string })[] = [
      {
        label: '$(folder-opened) 打开头文件目录',
        description: directory.fsPath,
      },
      ...builtinHeaderFiles().map((file) => ({
        label: file.fileName,
        description: `.${file.extension}`,
        header: file.fileName,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: '编辑语言头文件',
      placeHolder: '选择要编辑的头文件，或打开头文件目录',
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    if (!picked.header) {
      await vscode.env.openExternal(directory);
      return;
    }
    const target = vscode.Uri.joinPath(directory, picked.header);
    try {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      void vscode.window.showErrorMessage(`打开头文件失败：${describeError(error)}`);
    }
  };

  const newFile = async (arg: unknown): Promise<void> => {
    const ref = await resolveProblem(arg);
    if (!ref) {
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    const languages = await languageForProblem(ref);
    const language = await pickLanguage(languages, '选择代码语言');
    if (!language) {
      return;
    }
    const displayName = languages[language] ?? language;
    const title = ref.title?.trim() || `${ref.oj}-${ref.probNum}`;
    let template = buildCodeTemplate(displayName, title);
    const configuredTemplate = await loadLanguageTemplate(ref, displayName, template.extension, title);
    if (configuredTemplate !== undefined) {
      template = { ...template, content: configuredTemplate };
    }
    if (!template.recognized) {
      const answer = await vscode.window.showInputBox({
        title: '指定文件扩展名',
        prompt: `未识别语言“${displayName}”，请输入文件扩展名`,
        placeHolder: '例如 cpp、py、java',
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^[A-Za-z0-9_+-]{1,12}$/.test(value.trim().replace(/^\./, ''))
            ? undefined
            : '扩展名只能包含字母、数字、下划线、加号或连字符',
      });
      if (answer === undefined) {
        return;
      }
      const extension = answer.trim().replace(/^\./, '').toLowerCase();
      template = {
        extension,
        content: '',
        recognized: true,
      };
      const fallback = await loadLanguageTemplate(ref, displayName, extension, title);
      if (fallback !== undefined) {
        template.content = fallback;
      }
    }

    const headerContent = await loadLanguageHeader(
      ref,
      displayName,
      template.extension,
      title,
    );
    if (headerContent?.trim()) {
      template = applyLanguageHeader(template, headerContent);
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const configured = getConfiguration('solutionsDirectory', '').trim();
    let directory: vscode.Uri | undefined;
    if (configured && path.isAbsolute(configured)) {
      directory = vscode.Uri.file(configured);
    } else if (folder) {
      directory = configured
        ? vscode.Uri.joinPath(folder.uri, configured)
        : folder.uri;
    }
    if (!directory) {
      void vscode.window.showWarningMessage(
        '请先打开一个文件夹工作区，或在设置中配置 vjudge.solutionsDirectory 的绝对路径。',
      );
      return;
    }

    const baseName = safeFileBase(`${ref.oj}-${ref.probNum}`, 'solution');
    if (template.fileName) {
      directory = vscode.Uri.joinPath(directory, baseName);
    }
    const fileName = template.fileName ?? `${baseName}.${template.extension}`;
    const target = vscode.Uri.joinPath(directory, fileName);

    let exists = false;
    try {
      await vscode.workspace.fs.stat(target);
      exists = true;
    } catch {
      // 文件不存在，继续创建
    }
    if (exists) {
      rememberProblemFile(ref, target);
      remember(ref);
      await autoLinkCph(ref, target);
      await vscode.window.showTextDocument(target, { preview: false });
      void vscode.window.showInformationMessage(`文件已存在：${fileName}`);
      return;
    }

    try {
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(target, Buffer.from(template.content, 'utf8'));
    } catch (error) {
      void vscode.window.showErrorMessage(`创建文件失败：${describeError(error)}`);
      return;
    }

    rememberProblemFile(ref, target);
    remember(ref);
    await autoLinkCph(ref, target);
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false });
  };

  const promptCaptcha = async (): Promise<string | undefined> => {
    let captcha: { dataUrl: string };
    try {
      captcha = await session.client.getCaptcha();
    } catch (error) {
      void vscode.window.showErrorMessage(`获取验证码失败：${describeError(error)}`);
      return undefined;
    }
    const nonce = randomBytes(16).toString('base64');
    const panel = vscode.window.createWebviewPanel(
      'vjudge.captcha',
      'VJudge 验证码',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );

    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
        panel.dispose();
      };
      panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; justify-content: center; padding-top: 48px; }
.card { min-width: 320px; padding: 24px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.4)); border-radius: 6px; text-align: center; }
h2 { margin-top: 0; font-size: 1.1em; }
img { width: 160px; height: 56px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.4)); border-radius: 4px; display: block; margin: 0 auto 12px; }
input { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
.row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
button { border: none; border-radius: 2px; padding: 6px 14px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: inherit; }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.hint { color: var(--vscode-descriptionForeground); font-size: .88em; margin-bottom: 0; }
</style>
</head>
<body>
<div class="card">
  <h2>输入验证码</h2>
  <img id="captcha" src="${captcha.dataUrl}" alt="验证码">
  <input id="code" maxlength="12" autofocus placeholder="验证码">
  <div class="row">
    <button id="submit">提交</button>
    <button id="refresh" class="secondary">换一张</button>
    <button id="cancel" class="secondary">取消</button>
  </div>
  <p class="hint">看不清可以点击“换一张”。</p>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('code');
  document.getElementById('submit').addEventListener('click', function () {
    vscode.postMessage({ type: 'submit', value: input.value.trim() });
  });
  document.getElementById('refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('cancel').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      vscode.postMessage({ type: 'submit', value: input.value.trim() });
    }
  });
  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'image') {
      document.getElementById('captcha').src = message.dataUrl;
      input.value = '';
      input.focus();
    }
  });
  input.focus();
})();
</script>
</body>
</html>`;
      panel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message.type !== 'string') {
          return;
        }
        if (message.type === 'submit') {
          const value = String(message.value ?? '').trim();
          if (value) {
            finish(value);
          }
        } else if (message.type === 'cancel') {
          finish(undefined);
        } else if (message.type === 'refresh') {
          try {
            const next = await session.client.getCaptcha();
            void panel.webview.postMessage({ type: 'image', dataUrl: next.dataUrl });
          } catch (error) {
            void vscode.window.showErrorMessage(`获取验证码失败：${describeError(error)}`);
          }
        }
      });
      panel.onDidDispose(() => finish(undefined));
    });
  };

  const pollSolution = async (
    runId: number,
    title = '等待评测结果',
  ): Promise<Solution | undefined> => {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${title}（#${runId}）`,
        cancellable: true,
      },
      async (progress, token) => {
        const deadline = Date.now() + 5 * 60 * 1000;
        let solution: Solution | undefined;
        while (Date.now() < deadline) {
          if (token.isCancellationRequested) {
            return undefined;
          }
          solution = await session.client.getSolution(runId);
          progress.report({ message: solution.status || '评测中…' });
          if (!solution.processing && solution.statusType !== 2) {
            return solution;
          }
          await delay(1200);
        }
        progress.report({ message: '评测时间较长，请稍后在提交记录中查看' });
        return solution;
      },
    );
  };

  const showAdditionalInfo = (runId: number, html: string): void => {
    const panel = vscode.window.createWebviewPanel(
      'vjudge.judgeInfo',
      `提交 #${runId} 详情`,
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );
    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; line-height: 1.6; }
pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.4)); padding: 4px 8px; }
a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>${sanitizeStatementHtml(html)}</body>
</html>`;
  };

  const waitForRun = async (
    ref: ProblemRef,
    runId: number,
    labels: { started: string; sent: string },
  ): Promise<void> => {
    output.appendLine(`[VJudge] ${labels.started}，运行 ID ${runId}`);
    let solution: Solution | undefined;
    try {
      solution = await pollSolution(runId);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `${labels.sent}，但获取评测结果失败：${describeError(error)}`,
      );
    }
    submissions.refresh();
    void submissions.reload(true);

    if (!solution) {
      void vscode.window.showInformationMessage(
        `${labels.sent}（#${runId}），结果请在提交记录中查看。`,
      );
      return;
    }
    if (!solution.processing && solution.statusType !== 2) {
      session.noteSubmissionResult(ref, solution.statusType);
      problems.refreshSolveStates();
      contests.refreshSolveStates();
      workbooks.refreshSolveStates();
    }
    output.appendLine(`[VJudge] #${runId} 结果：${solution.status}`);
    if (solution.statusType === 0) {
      void vscode.window.showInformationMessage(solution.status || '通过');
    } else {
      const actions = solution.additionalInfo ? ['查看详情'] : [];
      const choice = await vscode.window.showErrorMessage(
        solution.status || '评测未通过',
        ...actions,
      );
      if (choice === '查看详情' && solution.additionalInfo) {
        showAdditionalInfo(runId, solution.additionalInfo);
      }
    }
  };

  const submitProblem = async (arg: unknown): Promise<void> => {
    const ref = await resolveProblem(arg, true, true);
    if (!ref) {
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    const editor = await resolveEditor(ref);
    if (!editor || editor.document.uri.scheme === 'untitled') {
      void vscode.window.showWarningMessage(
        '请先打开要提交的代码文件（纯文本文件），并将其保存到磁盘。',
      );
      return;
    }
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    const code = editor.document.getText();
    if (!code.trim()) {
      void vscode.window.showWarningMessage('代码文件为空，无法提交。');
      return;
    }
    const languages = await languageForProblem(ref);
    const language = await pickLanguage(languages, '选择提交语言');
    if (!language) {
      return;
    }

    rememberProblemFile(ref, editor.document.uri);
    remember(ref);

    let runId: number | undefined;
    let captcha: string | undefined;
    let method = 0;
    let bindingId: number | undefined;
    let remoteAccountTried = false;
    if (await requiresRemoteAccount(ref)) {
      const accountId = await chooseRemoteAccount(ref.oj);
      if (accountId === undefined) {
        return;
      }
      method = 1;
      bindingId = accountId;
      remoteAccountTried = true;
    }
    try {
      for (let attempt = 0; attempt < 3 && runId === undefined; attempt++) {
        try {
          runId = await session.client.submit({
            oj: ref.oj,
            probNum: ref.probNum,
            title: ref.title,
            contestId: ref.contestId,
            contestNum: ref.contestNum,
            language,
            code,
            captcha,
            open: getConfiguration('openCodePublicly', false),
            method,
            bindingId,
          });
        } catch (error) {
          if (error instanceof CaptchaRequiredError) {
            captcha = await promptCaptcha();
            if (captcha === undefined) {
              void vscode.window.showWarningMessage('已取消提交。');
              return;
            }
            continue;
          }
          if (!remoteAccountTried && isMethodNotAllowed(error)) {
            remoteAccountTried = true;
            await markRemoteRequired(ref.oj);
            const accountId = await chooseRemoteAccount(ref.oj);
            if (accountId === undefined) {
              return;
            }
            method = 1;
            bindingId = accountId;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof VJudgeError && /duplicate_code$/i.test(error.i18nKey ?? '')) {
        output.appendLine(`[VJudge] 提交被判定为重复代码：${ref.oj}-${ref.probNum}`);
        const action = await vscode.window.showWarningMessage(
          '提交失败：VJudge 判定这份代码与该题之前提交过的代码完全相同，已拒绝重复提交。请修改代码（例如加一行注释或空行）或更换提交语言后再试。',
          '查看提交记录',
        );
        if (action === '查看提交记录') {
          submissions.refresh();
          void submissions.reload(true);
          await vscode.commands.executeCommand('vjudge.submissions.focus');
        }
        return;
      }
      await reportError('提交失败：', error);
      return;
    }
    if (runId === undefined) {
      void vscode.window.showErrorMessage('提交失败：验证码尝试次数过多。');
      return;
    }

    await waitForRun(ref, runId, {
      started: `已提交 ${ref.oj}-${ref.probNum}（${language}）`,
      sent: '提交已发送',
    });
  };

  const archiveLanguage = (languages: Record<string, string>): string => {
    const preferred =
      context.globalState.get<string>('vjudge.lastLanguage') ??
      getConfiguration('defaultLanguage', '');
    if (preferred) {
      if (languages[preferred]) {
        return preferred;
      }
      const byLabel = Object.entries(languages).find(([, label]) => label === preferred);
      if (byLabel) {
        return byLabel[0];
      }
    }
    return Object.keys(languages)[0] ?? '';
  };

  const archiveSubmission = async (arg: unknown): Promise<void> => {
    const ref = await resolveProblem(arg, true, true);
    if (!ref) {
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    const languages = await languageForProblem(ref);
    if (ref.submitMethods && ref.submitMethods[2] !== true) {
      void vscode.window.showWarningMessage(
        `${ref.oj} 的这道题不支持归档提交。请改用普通提交，或在浏览器打开题目确认可用的提交方式。`,
      );
      return;
    }
    const language = archiveLanguage(languages);
    if (!language) {
      void vscode.window.showWarningMessage(
        '无法获取该题的提交语言，请先打开一次题面后再归档。',
      );
      return;
    }

    const origin = `https://vjudge.net/problem/${encodeURIComponent(ref.oj)}-${encodeURIComponent(ref.probNum)}/origin`;
    const choice = await vscode.window.showWarningMessage(
      `归档提交不会上传本地代码，而是让 VJudge 收录已绑定的 ${ref.oj} 账号在 ${ref.oj}-${ref.probNum} 上最近一次提交。请先在原 OJ 完成提交，再继续。`,
      { modal: true },
      '继续归档',
      '打开原题',
    );
    if (choice === '打开原题') {
      void vscode.env.openExternal(vscode.Uri.parse(origin));
      return;
    }
    if (choice !== '继续归档') {
      return;
    }

    const accountId = await chooseRemoteAccount(ref.oj);
    if (accountId === undefined) {
      return;
    }

    let runId: number | undefined;
    let captcha: string | undefined;
    try {
      for (let attempt = 0; attempt < 3 && runId === undefined; attempt++) {
        try {
          runId = await session.client.submit({
            oj: ref.oj,
            probNum: ref.probNum,
            title: ref.title,
            contestId: ref.contestId,
            contestNum: ref.contestNum,
            language,
            code: '',
            captcha,
            open: getConfiguration('openCodePublicly', false),
            method: 2,
            bindingId: accountId,
          });
        } catch (error) {
          if (error instanceof CaptchaRequiredError) {
            captcha = await promptCaptcha();
            if (captcha === undefined) {
              void vscode.window.showWarningMessage('已取消归档。');
              return;
            }
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (
        error instanceof VJudgeError &&
        /no_recent_submissions_found$/i.test(error.i18nKey ?? '')
      ) {
        const action = await vscode.window.showWarningMessage(
          '归档失败：没有找到最近提交。请先在原 OJ 提交该题，并确认使用的远程账号与 VJudge 绑定的一致。',
          '打开原题',
        );
        if (action === '打开原题') {
          void vscode.env.openExternal(vscode.Uri.parse(origin));
        }
        return;
      }
      const key = error instanceof VJudgeError ? error.i18nKey ?? '' : '';
      if (/archive_reverify_required$|bind_account_(missing|invalid|locked|disconnected)$/i.test(key)) {
        const action = await vscode.window.showWarningMessage(
          describeError(error),
          '管理账号',
        );
        if (action === '管理账号') {
          void vscode.env.openExternal(
            vscode.Uri.parse(
              `https://vjudge.net/user/remoteAccounts?oj=${encodeURIComponent(ref.oj)}`,
            ),
          );
        }
        return;
      }
      await reportError('归档提交失败：', error);
      return;
    }
    if (runId === undefined) {
      void vscode.window.showErrorMessage('归档失败：验证码尝试次数过多。');
      return;
    }

    remember(ref);
    await waitForRun(ref, runId, {
      started: `已发起归档 ${ref.oj}-${ref.probNum}`,
      sent: '归档已发起',
    });
  };

  const decodeCode = (solution: Solution): string => {
    const record = solution as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code.length > 0) {
      return record.code;
    }
    const raw = typeof record.source === 'string' ? record.source : '';
    if (!raw) {
      return '';
    }
    const compact = raw.replace(/\s+/g, '');
    if (compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      try {
        let decoded = Buffer.from(compact, 'base64').toString('utf8');
        if (decoded && !decoded.includes('\uFFFD')) {
          if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
            try {
              decoded = decodeURIComponent(decoded);
            } catch {
              // 保留原始解码结果
            }
          }
          return decoded;
        }
      } catch {
        // 不是 Base64，按原文处理
      }
    }
    return raw;
  };

  const showSubmission = async (arg: unknown): Promise<void> => {
    const unwrapped = unwrapNode(arg);
    if (!isSubmission(unwrapped)) {
      return;
    }
    if (!(await ensureLogin())) {
      return;
    }
    let solution: Solution | undefined;
    try {
      solution = await pollSolution(unwrapped.runId, '获取提交详情');
    } catch (error) {
      await reportError('获取提交详情失败：', error);
      return;
    }
    if (!solution) {
      return;
    }
    const code = decodeCode(solution);
    const language = solution.language || solution.languageCanonical || '';
    let opened = false;
    if (code.trim()) {
      const document = await vscode.workspace.openTextDocument({
        content: code,
        language: languageIdFor(language),
      });
      await vscode.window.showTextDocument(document, { preview: false });
      opened = true;
    }
    if (solution.additionalInfo) {
      showAdditionalInfo(solution.runId, solution.additionalInfo);
      opened = true;
    }
    if (!opened) {
      void vscode.window.showInformationMessage(
        `提交 #${solution.runId}：${solution.status}。该提交可能未公开代码。`,
      );
    }
  };

  const openInBrowser = async (arg: unknown): Promise<void> => {
    const direct = unwrapNode(arg);
    let url: string | undefined;
    if (isProblemRef(direct)) {
      url = problemUrl(direct);
    } else if (isSubmission(direct)) {
      url = `https://vjudge.net/solution/${direct.runId}`;
    } else if (isWorkbook(direct)) {
      url = `https://vjudge.net/article/${direct.id}`;
    } else if (isContest(direct)) {
      url = `https://vjudge.net/contest/${direct.id}`;
    } else if (lastProblem) {
      url = problemUrl(lastProblem);
    }
    if (!url) {
      void vscode.window.showWarningMessage('没有可打开的 VJudge 页面。');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  };

  const copyProblemLink = async (arg: unknown): Promise<void> => {
    const direct = unwrapNode(arg);
    const ref = isProblemRef(direct) ? direct : lastProblem;
    if (!ref) {
      void vscode.window.showWarningMessage('没有可复制的题目链接。');
      return;
    }
    await vscode.env.clipboard.writeText(problemUrl(ref));
    void vscode.window.showInformationMessage('已复制题目链接。');
  };

  const importCph = async (): Promise<void> => {
    const found = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '扫描 CPH 测试数据',
        cancellable: false,
      },
      () => cphStore.scan(true),
    );
    if (found.length === 0) {
      void vscode.window.showInformationMessage(
        '未找到 CPH 测试数据。请确认工作区中存在 .cph 目录，或在 CPH 设置 cph.general.saveLocation 中指定了保存位置。',
      );
      return;
    }
    const items = found.map((problem) => {
      const sourceName = problem.srcPath ? path.basename(problem.srcPath) : '';
      const description = [
        problem.group,
        `${problem.tests.length} 个测试`,
        sourceName,
        problem.interactive ? '交互题' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        label: problem.name,
        description: description || problem.probPath,
        detail: problem.url || problem.probPath,
        problem,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: '导入 CPH 测试数据',
      placeHolder: '选择要导入的题目，可多选',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.length === 0) {
      return;
    }

    await cphStore.remember(picked.map((item) => item.problem));
    let linked = 0;
    let missing = 0;
    for (const item of picked) {
      const problem = item.problem;
      const sourceUri = cphStore.sourceUri(problem);
      if (!sourceUri) {
        missing++;
        continue;
      }
      try {
        await vscode.workspace.fs.stat(sourceUri);
      } catch {
        missing++;
        continue;
      }
      const ref = cphProblemRef(problem.url);
      if (!ref) {
        continue;
      }
      ref.title = problem.name;
      if (problem.group) {
        ref.source = problem.group;
      }
      rememberProblemFile(ref, sourceUri);
      remember(ref);
      linked++;
    }

    const totalTests = picked.reduce((sum, item) => sum + item.problem.tests.length, 0);
    const parts = [`已导入 ${picked.length} 个 CPH 题目（${totalTests} 个测试）`];
    if (linked > 0) {
      parts.push(`关联 ${linked} 个 VJudge 题目`);
    }
    if (missing > 0) {
      parts.push(`${missing} 个源文件不存在`);
    }
    void vscode.window.showInformationMessage(
      `${parts.join('，')}。打开源文件后可运行“本地测试样例”。`,
    );
  };

  const testSamples = async (arg: unknown): Promise<void> => {
    const direct = unwrapNode(arg);
    const refArg = isProblemRef(direct) ? direct : undefined;
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) {
      uri = arg;
    } else if (refArg) {
      uri = problemFile(refArg);
    } else {
      uri = vscode.window.activeTextEditor?.document.uri;
    }
    const currentRef = refArg ?? (uri ? problemForFile(uri) : undefined);
    const imported = uri ? await cphStore.forSourceFile(uri, currentRef) : undefined;
    const importedRef = imported ? cphProblemRef(imported.url) : undefined;
    const conflict = Boolean(currentRef && importedRef && !sameProblem(currentRef, importedRef));
    if (imported && !conflict) {
      const sourceUri = cphStore.sourceUri(imported);
      const sourcePath = uri?.scheme === 'file' ? uri.fsPath : sourceUri?.fsPath;
      if (sourcePath) {
        try {
          await runImportedSamples(
            { label: imported.name, sourcePath, samples: imported.tests },
            output,
          );
        } catch (error) {
          await reportError('CPH 样例测试失败：', error);
        }
        return;
      }
    }

    const ref = currentRef ?? (await resolveProblem(arg, true, true));
    if (!ref) {
      return;
    }
    try {
      await runSamples(session, ref, output);
    } catch (error) {
      await reportError('样例测试失败：', error);
    }
  };

  statement.onCommand = async (command, ref) => {
    remember(ref);
    switch (command) {
      case 'submit':
        await submitProblem(ref);
        break;
      case 'archive':
        await archiveSubmission(ref);
        break;
      case 'newFile':
        await newFile(ref);
        break;
      case 'testSamples':
        await testSamples(ref);
        break;
      case 'openBrowser':
        await openInBrowser(ref);
        break;
      case 'copyLink':
        await copyProblemLink(ref);
        break;
      default:
        break;
    }
  };

  return [
    vscode.commands.registerCommand('vjudge.login', async () => {
      await session.login();
    }),
    vscode.commands.registerCommand('vjudge.loginWithCookie', async () => {
      await session.loginWithCookie();
    }),
    vscode.commands.registerCommand('vjudge.logout', async () => {
      clearStatementCache();
      await session.logout();
      problems.refresh();
      contests.refresh();
      submissions.refresh();
      workbooks.refresh();
    }),
    vscode.commands.registerCommand('vjudge.searchProblem', searchProblems),
    vscode.commands.registerCommand('vjudge.searchWorkbooks', searchWorkbooks),
    vscode.commands.registerCommand('vjudge.refreshProblems', async () => {
      if (!(await ensureLogin())) {
        return;
      }
      await problems.reload();
    }),
    vscode.commands.registerCommand('vjudge.refreshWorkbooks', async () => {
      if (!(await ensureLogin())) {
        return;
      }
      await workbooks.reload();
    }),
    vscode.commands.registerCommand('vjudge.loadMoreWorkbooks', async (category: unknown) => {
      if (isWorkbookCategory(category)) {
        await workbooks.loadMore(category);
      }
    }),
    vscode.commands.registerCommand('vjudge.toggleWorkbookMembership', toggleWorkbookMembership),
    vscode.commands.registerCommand('vjudge.copyWorkbookLink', copyWorkbookLink),
    vscode.commands.registerCommand('vjudge.createWorkbook', createWorkbook),
    vscode.commands.registerCommand('vjudge.addToWorkbook', addProblemsToWorkbook),
    vscode.commands.registerCommand('vjudge.loadMoreProblems', async () => {
      await problems.loadMore();
    }),
    vscode.commands.registerCommand('vjudge.refreshContests', async () => {
      if (!(await ensureLogin())) {
        return;
      }
      await contests.reload();
    }),
    vscode.commands.registerCommand('vjudge.refreshSubmissions', async () => {
      if (!(await ensureLogin())) {
        return;
      }
      await submissions.reload(false);
    }),
    vscode.commands.registerCommand('vjudge.openProblem', openProblem),
    vscode.commands.registerCommand('vjudge.submit', submitProblem),
    vscode.commands.registerCommand('vjudge.archiveSubmit', archiveSubmission),
    vscode.commands.registerCommand('vjudge.newFile', newFile),
    vscode.commands.registerCommand('vjudge.testSamples', testSamples),
    vscode.commands.registerCommand('vjudge.importCph', importCph),
    vscode.commands.registerCommand('vjudge.openInBrowser', openInBrowser),
    vscode.commands.registerCommand('vjudge.showSubmission', showSubmission),
    vscode.commands.registerCommand('vjudge.copyProblemLink', copyProblemLink),
    vscode.commands.registerCommand('vjudge.setUsername', async () => {
      const name = await vscode.window.showInputBox({
        title: 'VJudge 用户名',
        prompt: '用于查询提交记录的用户名',
        value: session.username ?? '',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : '请输入用户名'),
      });
      if (name === undefined) {
        return;
      }
      await session.updateUsername(name.trim() || undefined);
      await submissions.reload(false);
    }),
    vscode.commands.registerCommand('vjudge.showOutput', () => output.show()),
    vscode.commands.registerCommand('vjudge.editTemplate', editLanguageTemplate),
    vscode.commands.registerCommand('vjudge.editHeader', editLanguageHeader),
  ];
}
