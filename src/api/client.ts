import { rawRequest, RawResponse } from './http';
import {
  buildStatement,
  isChallengePage,
  parseContestDetail,
  parseDescriptionPage,
  parseProblemDetail,
  parseWorkbookDetail,
  stripTags,
} from './parser';
import {
  CaptchaRequiredError,
  extractI18nKey,
  makeClientError,
  translateI18n,
  VJudgeError,
} from './errors';
import {
  ContestDetail,
  ContestSummary,
  DescriptionRef,
  ProblemDetail,
  ProblemRef,
  ProblemSummary,
  RemoteAccountBinding,
  Sample,
  SearchProblemOptions,
  Solution,
  SolveRecords,
  Statement,
  SubmissionSummary,
  SubmitOptions,
  WorkbookCategory,
  WorkbookDetail,
  WorkbookInput,
  WorkbookListResult,
  WorkbookSummary,
} from './types';

export const VJUDGE_BASE = 'https://vjudge.net';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string | number | boolean | undefined>;
  body?: string | Buffer;
  html?: boolean;
  ajax?: boolean;
  headers?: Record<string, string>;
  retries?: number;
}

interface ClientResponse extends RawResponse {
  finalUrl: string;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function solveStatusKey(oj: string, probNum: string): string {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  return `${normalize(oj)}\u0000${normalize(probNum)}`;
}

function readSolveRecords(value: unknown, target: Set<string>): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [oj, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const probNum = String(item ?? '').trim();
      if (probNum) {
        target.add(solveStatusKey(oj, probNum));
      }
    }
  }
}

function descriptionsFromRef(ref: ProblemRef): DescriptionRef[] {
  const briefs = ref.descBriefs ?? [];
  if (briefs.length === 0) {
    return [];
  }
  const enabled = ref.enabledDescKeys;
  const filtered =
    enabled && enabled.length > 0
      ? briefs.filter((brief) => enabled.includes(Number(brief.key)))
      : briefs;
  const rank = (item: DescriptionRef): number =>
    Number(Boolean(item.official)) * 2 + (item.lang?.toLowerCase() === 'en' ? 1 : 0);
  const chosen = [...(filtered.length > 0 ? filtered : briefs)].map((brief) => ({
    id: Number(brief.key),
    version: Number(brief.version),
    author: brief.author,
    official: brief.official,
    lang: brief.lang,
    langDisplay: brief.langDisplay,
    type: brief.type,
    updateDate: brief.updateDate,
  }));
  chosen.sort((left, right) => rank(right) - rank(left));
  const seen = new Set<number>();
  const descriptions: DescriptionRef[] = [];
  for (const item of chosen) {
    const id = item.id;
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    descriptions.push({
      ...item,
      version: Number.isFinite(item.version) ? item.version : 0,
    });
  }
  return descriptions;
}

export class VJudgeClient {
  private readonly cookies = new Map<string, string>();
  public timeoutMs = 20000;
  onCookiesChanged?: () => void;

  constructor(timeoutMs?: number) {
    if (timeoutMs) {
      this.timeoutMs = timeoutMs;
    }
  }

  importCookies(input: string): void {
    const trimmed = input.trim().replace(/^cookie\s*:\s*/i, '');
    if (!trimmed) {
      return;
    }
    if (!trimmed.includes('=')) {
      this.cookies.set('JSESSIONID', trimmed.replace(/^["']|["']$/g, ''));
      return;
    }
    for (const part of trimmed.split(/[;\n]+/)) {
      const pair = part.trim().replace(/^cookie\s*:\s*/i, '');
      if (!pair) {
        continue;
      }
      const index = pair.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      if (name && !/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name)) {
        this.cookies.set(name, value);
      }
    }
  }

  exportCookies(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  hasCookies(): boolean {
    return this.cookies.size > 0;
  }

  private cookieHeader(): string {
    return this.exportCookies();
  }

  private storeCookies(setCookies: string[]): void {
    if (setCookies.length === 0) {
      return;
    }
    const before = this.exportCookies();
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!name) {
        continue;
      }
      const expired = /max-age\s*=\s*0\b/i.test(cookie) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/i.test(cookie);
      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    if (this.exportCookies() !== before) {
      this.onCookiesChanged?.();
    }
  }

  private async request(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<ClientResponse> {
    let url = path.startsWith('http') ? path : `${VJUDGE_BASE}${path}`;
    if (options.query) {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          parsed.searchParams.set(key, String(value));
        }
      }
      url = parsed.toString();
    }

    let currentMethod = method;
    let body: string | Buffer | undefined =
      options.form !== undefined ? new URLSearchParams(
        Object.entries(options.form)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)] as [string, string]),
      ).toString() : options.body;

    const baseHeaders: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
      Referer: `${VJUDGE_BASE}/`,
      ...(options.html
        ? { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        : { Accept: 'application/json, text/javascript, */*; q=0.01' }),
      ...(options.ajax === false ? {} : { 'X-Requested-With': 'XMLHttpRequest' }),
      ...(options.form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      ...(options.headers ?? {}),
    };
    if (currentMethod === 'POST') {
      baseHeaders.Origin = VJUDGE_BASE;
    }

    for (let redirects = 0; redirects <= 6; redirects++) {
      let hostname = '';
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = '';
      }
      const sameSite = hostname === 'vjudge.net' || hostname.endsWith('.vjudge.net');
      const cookie = sameSite ? this.cookieHeader() : '';
      const headers = { ...baseHeaders, ...(cookie ? { Cookie: cookie } : {}) };
      const maxAttempts = options.retries ?? (currentMethod === 'GET' ? 2 : 0);
      let response: RawResponse | undefined;
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        try {
          response = await rawRequest(url, {
            method: currentMethod,
            headers,
            body,
            timeoutMs: this.timeoutMs,
          });
          break;
        } catch (error) {
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new VJudgeError(`网络请求失败：${message}`);
        }
      }
      if (!response) {
        throw new VJudgeError('网络请求失败：没有收到响应。');
      }
      if (sameSite) {
        this.storeCookies(response.setCookies);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.location;
        const locationValue = Array.isArray(location) ? location[0] : location;
        if (!locationValue) {
          return { ...response, finalUrl: url };
        }
        url = new URL(locationValue, url).toString();
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && currentMethod !== 'GET')
        ) {
          currentMethod = 'GET';
          body = undefined;
          delete baseHeaders['Content-Type'];
        }
        continue;
      }
      return { ...response, finalUrl: url };
    }
    throw new VJudgeError('请求重定向次数过多。');
  }

  private ensureSuccessJson(response: ClientResponse, fallback: string): unknown {
    const data = parseJsonBody(response.body);
    const text = response.body.toString('utf8').trim();
    if (data !== undefined) {
      return data;
    }
    if (/<!doctype|<html/i.test(text)) {
      if (/login=1|id=["']login-/i.test(text) || /login=1/.test(response.finalUrl)) {
        throw new VJudgeError('登录状态已失效，请重新登录。', undefined, response.status, undefined, 'login');
      }
      throw new VJudgeError(`${fallback}（服务器返回了网页而不是数据）。`, undefined, response.status);
    }
    throw new VJudgeError(fallback, undefined, response.status, text.slice(0, 300));
  }

  private isLoginResponse(response: ClientResponse): boolean {
    return /[?&]login=1/.test(response.finalUrl);
  }

  private assertUsableHtml(response: ClientResponse, html: string, action: string): void {
    if (isChallengePage(html)) {
      throw new VJudgeError(
        `${action}失败：VJudge 触发了人机验证。请在浏览器打开该页面完成验证后重试，或稍后再试。`,
        undefined,
        response.status,
      );
    }
    if (response.status === 429) {
      throw new VJudgeError(`${action}失败：请求过于频繁，请稍后再试。`, undefined, response.status);
    }
    if (response.status >= 400) {
      const detail =
        response.status === 401 || response.status === 403
          ? '访问被拒绝，可能需要登录或触发了访问限制'
          : response.status === 404
            ? '页面不存在'
            : `服务器返回 HTTP ${response.status}`;
      throw new VJudgeError(`${action}失败：${detail}。`, undefined, response.status);
    }
    if (!html.trim()) {
      throw new VJudgeError(`${action}失败：服务器返回了空页面。`, undefined, response.status);
    }
    const contentType = String(response.headers['content-type'] ?? '');
    if (/application\/json/i.test(contentType)) {
      const data = parseJsonBody(response.body);
      if (data && typeof data === 'object' && (data as Record<string, unknown>).error) {
        throw makeClientError(data, response.status, `${action}失败。`);
      }
    }
  }

  async login(username: string, password: string): Promise<void> {
    const response = await this.request('POST', '/user/login', {
      form: { username, password, token: '' },
      html: false,
    });
    const text = response.body.toString('utf8').trim();
    if (text === 'success' || text === '"success"') {
      return;
    }
    const data = parseJsonBody(response.body);
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (record.success === true) {
        return;
      }
    }
    const key = extractI18nKey(data);
    if (key) {
      throw makeClientError(data, response.status, '登录失败。');
    }
    if (response.status === 401 || response.status === 403) {
      throw new VJudgeError(
        response.status === 403 ? '登录被 VJudge 拒绝，请尝试使用 Cookie 登录。' : '用户名或密码错误。',
        key,
        response.status,
        data,
      );
    }
    const detail = data ? JSON.stringify(data).slice(0, 300) : text.slice(0, 300);
    throw new VJudgeError(`登录失败：${detail}`, key, response.status, data);
  }

  async checkLoginStatus(): Promise<boolean> {
    const response = await this.request('POST', '/user/checkLogInStatus', {
      html: false,
      retries: 2,
    });
    const text = response.body.toString('utf8').trim();
    if (text === 'true' || text === '"true"') {
      return true;
    }
    if (text === 'false' || text === '"false"') {
      return false;
    }
    const data = parseJsonBody(response.body);
    if (data === true) {
      return true;
    }
    if (data === false) {
      return false;
    }
    if (isChallengePage(text)) {
      throw new VJudgeError(
        '验证登录状态失败：VJudge 触发了人机验证。请在浏览器打开 vjudge.net 完成验证后重试。',
        undefined,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new VJudgeError('验证登录状态失败：VJudge 拒绝了请求。', undefined, response.status);
    }
    throw new VJudgeError(
      `验证登录状态失败：VJudge 返回了无法识别的响应（HTTP ${response.status}）。`,
      undefined,
      response.status,
      text.slice(0, 300),
    );
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/user/logout', { html: false });
    } catch {
      // 注销失败时仍然清除本地 Cookie
    } finally {
      this.clearCookies();
    }
  }

  async searchProblems(options: SearchProblemOptions = {}): Promise<{ problems: ProblemSummary[]; total: number }> {
    const ajaxHeaders = { Referer: `${VJUDGE_BASE}/problem` };
    const response = await this.request('GET', '/problem/data', {
      ajax: true,
      headers: ajaxHeaders,
      query: {
        draw: 1,
        start: options.start ?? 0,
        length: options.length ?? 50,
        OJId: options.oj || 'All',
        probNum: options.probNum ?? '',
        title: options.title ?? '',
        source: options.source ?? '',
        category: options.category ?? 'all',
        sortCol: 7,
        sortDir: 'desc',
      },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能搜索题目。', undefined, response.status, undefined, 'login');
    }
    const data = this.ensureSuccessJson(response, '无法获取题目列表') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取题目列表。');
    }
    const rows = Array.isArray(data.data) ? (data.data as unknown[]) : [];
    const problems: ProblemSummary[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const record = row as Record<string, unknown>;
      const oj = String(record.originOJ ?? record.oj ?? record.OJId ?? '');
      const probNum = String(record.originProb ?? record.probNum ?? '');
      if (!oj || !probNum) {
        continue;
      }
      problems.push({
        id: Number(record.id ?? record.problemId ?? 0),
        oj,
        probNum,
        title: stripTags(String(record.title ?? '')),
        source: stripTags(String(record.source ?? '')).trim(),
        available: record.available !== false,
        solvedUsers: Number(record.solvedUsers ?? 0),
      });
    }
    const total = Number(data.recordsFiltered ?? data.recordsTotal ?? problems.length);
    if (problems.length === 0 && rows.length === 0 && Number(data.recordsTotal) === 9999999) {
      throw new VJudgeError(
        '登录状态可能已失效，无法获取题目列表，请重新登录。',
        undefined,
        response.status,
        undefined,
        'login',
      );
    }
    return { problems, total: Number.isFinite(total) ? total : problems.length };
  }

  async listContests(category: 'mine' | 'all' = 'mine', length = 100): Promise<ContestSummary[]> {
    const response = await this.request('GET', '/contest/data', {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/contest` },
      query: {
        draw: 1,
        start: 0,
        length,
        sortDir: 'desc',
        sortCol: 0,
        category,
      },
    });
    const data = this.ensureSuccessJson(response, '无法获取比赛列表') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取比赛列表。');
    }
    const rows = Array.isArray(data.data) ? (data.data as unknown[]) : [];
    const contests: ContestSummary[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }
      const id = Number(row[0]);
      if (!Number.isFinite(id)) {
        continue;
      }
      contests.push({
        id,
        title: String(row[1] ?? ''),
        type: Number(row[2] ?? 0),
        begin: Number(row[3] ?? 0),
        end: Number(row[4] ?? 0),
        openness: Number(row[5] ?? 0),
        contestants: Number(row[6] ?? 0),
        managerName: String(row[7] ?? ''),
        groupName: row[8] ? String(row[8]) : undefined,
        isFav: Number(row[10] ?? 0),
      });
    }
    return contests;
  }

  async getContestDetail(contestId: number): Promise<ContestDetail> {
    const response = await this.request('GET', `/contest/${contestId}`, {
      html: true,
      ajax: false,
      headers: { Referer: `${VJUDGE_BASE}/contest` },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能查看比赛。', undefined, response.status, undefined, 'login');
    }
    try {
      return parseContestDetail(response.body.toString('utf8'));
    } catch (error) {
      throw new VJudgeError(error instanceof Error ? error.message : '解析比赛信息失败。');
    }
  }

  async listWorkbooks(
    category: WorkbookCategory = 'all',
    options: { start?: number; length?: number; title?: string; author?: string } = {},
  ): Promise<WorkbookListResult> {
    const length = options.length ?? 50;
    const start = options.start ?? 0;
    const response = await this.request('GET', '/workbook/data', {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/workbook` },
      query: {
        draw: 1,
        start,
        length,
        title: options.title ?? '',
        category,
        author: options.author ?? '',
      },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能查看题单。', undefined, response.status, undefined, 'login');
    }
    const data = this.ensureSuccessJson(response, '无法获取题单列表') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取题单列表。');
    }
    const rows = Array.isArray(data.data) ? (data.data as unknown[]) : [];
    const workbooks: WorkbookSummary[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const record = row as Record<string, unknown>;
      const id = Number(record.id);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }
      workbooks.push({
        id,
        title: stripTags(String(record.title ?? '')).trim(),
        problemCount: Number(record.problemCount ?? 0),
        joinedUsers: Number(record.joinedUsers ?? 0),
        activeUsers: Number(record.activeUsers ?? 0),
        viewCnt: Number(record.viewCnt ?? 0),
        author: String(record.author ?? ''),
        openness: Number(record.openness ?? 0),
        updateTime: Number(record.updateTime ?? 0),
      });
    }
    const rawTotal = Number(data.recordsFiltered ?? data.recordsTotal);
    const total =
      Number.isFinite(rawTotal) && rawTotal >= 0 && rawTotal < 9999999 ? rawTotal : undefined;
    const hasMore =
      workbooks.length >= length && (total === undefined || start + workbooks.length < total);
    return { workbooks, total, hasMore };
  }

  async getWorkbookDetail(id: number): Promise<WorkbookDetail> {
    const response = await this.request('GET', `/article/${id}`, {
      html: true,
      ajax: false,
      headers: { Referer: `${VJUDGE_BASE}/workbook` },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能查看题单。', undefined, response.status, undefined, 'login');
    }
    const html = response.body.toString('utf8');
    this.assertUsableHtml(response, html, '获取题单');
    let detail: WorkbookDetail;
    try {
      detail = parseWorkbookDetail(html);
    } catch (error) {
      throw new VJudgeError(error instanceof Error ? error.message : '解析题单信息失败。');
    }
    if (!detail.id) {
      detail.id = id;
    }
    return detail;
  }

  async createWorkbook(input: WorkbookInput): Promise<number | undefined> {
    return this.saveWorkbook('/article/create', input, '创建题单');
  }

  async updateWorkbook(id: number, input: WorkbookInput): Promise<void> {
    await this.saveWorkbook(`/article/${id}/update`, input, '保存题单');
  }

  private async saveWorkbook(
    path: string,
    input: WorkbookInput,
    action: string,
  ): Promise<number | undefined> {
    const response = await this.request('POST', path, {
      form: {
        title: input.title,
        content: input.content,
        openness: input.openness,
        nodeId: input.nodeId ?? 0,
      },
      html: false,
      headers: { Referer: `${VJUDGE_BASE}/article/create` },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError(`请先登录 VJudge 才能${action}。`, undefined, response.status, undefined, 'login');
    }
    const text = response.body.toString('utf8').trim();
    const data = parseJsonBody(response.body);
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (record.error) {
        throw makeClientError(data, response.status, `${action}失败。`);
      }
      const id = Number(record.id ?? record.articleId ?? record.articleID);
      if (Number.isFinite(id) && id > 0) {
        return id;
      }
      if (record.success === true) {
        return undefined;
      }
    }
    if (response.status >= 400) {
      throw new VJudgeError(`${action}失败。`, undefined, response.status, text.slice(0, 300));
    }
    const match = response.finalUrl.match(/\/article\/(\d+)/);
    if (match) {
      return Number(match[1]);
    }
    if (/^success$/i.test(text)) {
      return undefined;
    }
    if (/<!doctype|<html/i.test(text)) {
      throw new VJudgeError(`${action}失败：服务器返回了网页而不是结果。`, undefined, response.status);
    }
    return undefined;
  }

  private async workbookAction(id: number, action: 'join' | 'leave'): Promise<void> {    const response = await this.request('POST', `/workbook/${action}/${id}`, {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/article/${id}` },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能操作题单。', undefined, response.status, undefined, 'login');
    }
    const data = parseJsonBody(response.body);
    if (data && typeof data === 'object' && (data as Record<string, unknown>).error) {
      throw makeClientError(data, response.status, action === 'join' ? '加入题单失败。' : '退出题单失败。');
    }
    if (response.status >= 400) {
      throw new VJudgeError(
        action === 'join' ? '加入题单失败。' : '退出题单失败。',
        undefined,
        response.status,
      );
    }
  }

  async joinWorkbook(id: number): Promise<void> {
    await this.workbookAction(id, 'join');
  }

  async leaveWorkbook(id: number): Promise<void> {
    await this.workbookAction(id, 'leave');
  }

  async getProblemDetail(oj: string, probNum: string): Promise<ProblemDetail> {
    const response = await this.request(
      'GET',
      `/problem/${encodeURIComponent(oj)}-${encodeURIComponent(probNum)}`,
      {
        html: true,
        ajax: false,
        headers: { Referer: `${VJUDGE_BASE}/problem` },
      },
    );
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能查看题目。', undefined, response.status, undefined, 'login');
    }
    const html = response.body.toString('utf8');
    this.assertUsableHtml(response, html, '获取题目信息');
    return parseProblemDetail(html, oj, probNum);
  }

  private async fetchDescription(id: number, version: number, ref: ProblemRef): Promise<string> {
    const suffix = version > 0 ? `?${version}` : '';
    const referer =
      ref.contestId !== undefined
        ? `${VJUDGE_BASE}/contest/${ref.contestId}`
        : `${VJUDGE_BASE}/problem/${encodeURIComponent(ref.oj)}-${encodeURIComponent(ref.probNum)}`;
    const response = await this.request('GET', `/problem/description/${id}${suffix}`, {
      html: true,
      ajax: false,
      headers: { Referer: referer },
    });
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('请先登录 VJudge 才能查看题面。', undefined, response.status, undefined, 'login');
    }
    const html = response.body.toString('utf8');
    this.assertUsableHtml(response, html, '获取题面');
    return html;
  }

  async getStatement(ref: ProblemRef, descriptionId?: number): Promise<Statement> {
    let title = ref.title ?? '';
    let languages = ref.languages ?? {};
    let descriptions = descriptionsFromRef(ref);

    if (descriptions.length === 0 || !title) {
      try {
        const detail = await this.getProblemDetail(ref.oj, ref.probNum);
        title = title || detail.title;
        if (Object.keys(languages).length === 0) {
          languages = detail.languages;
        }
        if (descriptions.length === 0) {
          descriptions = detail.descriptions;
        }
        if (!ref.submitMethods && detail.submitMethods) {
          ref.submitMethods = detail.submitMethods;
        }
      } catch (error) {
        // 已有题面引用时，标题/语言补全失败不应阻断题面加载。
        if (descriptions.length === 0) {
          throw error;
        }
      }
    }

    if (descriptions.length === 0) {
      throw new VJudgeError(
        `未找到 ${ref.oj}-${ref.probNum} 的题面：题目页没有返回可用的题面引用。请确认登录状态有效，或在浏览器打开该题确认题面存在后重试。`,
      );
    }

    let candidates = descriptions.slice(0, 5);
    if (descriptionId !== undefined) {
      const chosen = descriptions.find((item) => item.id === descriptionId);
      candidates = chosen ? [chosen] : [{ id: descriptionId, version: 0 }];
    }

    let lastError: unknown;
    for (const description of candidates) {
      try {
        const html = await this.fetchDescription(description.id, description.version, ref);
        const parsed = parseDescriptionPage(html);
        if (parsed.sections.length === 0) {
          lastError = new VJudgeError(`题面 ${description.id} 内容为空或无法解析。`);
          continue;
        }
        const statement = buildStatement(
          ref.oj,
          ref.probNum,
          title || `${ref.oj}-${ref.probNum}`,
          languages,
          parsed.sections.map((section) => section.html).join('\n<hr class="vj-section-sep"/>\n'),
        );
        if (parsed.samples.length > 0) {
          statement.samples = parsed.samples;
        }
        statement.descriptions = descriptions;
        statement.descriptionId = description.id;
        return statement;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof VJudgeError) {
      throw lastError;
    }
    throw new VJudgeError(lastError instanceof Error ? lastError.message : '获取题面失败。');
  }

  async getSamples(ref: ProblemRef): Promise<Sample[]> {
    const statement = await this.getStatement(ref);
    return statement.samples;
  }

  async submit(options: SubmitOptions): Promise<number> {
    const path =
      options.contestId !== undefined
        ? `/contest/submit/${options.contestId}/${encodeURIComponent(options.contestNum ?? '')}`
        : `/problem/submit/${encodeURIComponent(options.oj)}-${encodeURIComponent(options.probNum)}`;
    const referer =
      options.contestId !== undefined
        ? `${VJUDGE_BASE}/contest/${options.contestId}`
        : `${VJUDGE_BASE}/problem/${options.oj}-${options.probNum}`;

    const response = await this.request('POST', path, {
      form: {
        method: options.method ?? 0,
        language: options.language,
        open: options.open ? 1 : 0,
        source: options.code,
        captcha: options.captcha ?? '',
        password: '',
        ...(options.bindingId !== undefined ? { bindingId: options.bindingId } : {}),
      },
      html: false,
      headers: { Referer: referer },
    });

    const text = response.body.toString('utf8').trim();
    const data = parseJsonBody(response.body);
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>;
      if (typeof record.runId === 'number') {
        return record.runId;
      }
      if (record.captcha === true) {
        throw new CaptchaRequiredError('提交需要输入验证码。', undefined, response.status, data);
      }
      if (record.error || typeof record.errorCode === 'string') {
        const key = extractI18nKey(data);
        if (key && /captcha/i.test(key)) {
          throw new CaptchaRequiredError(translateI18n(key) ?? '验证码错误，请重试。', key, response.status, data);
        }
        throw makeClientError(data, response.status, '提交失败。');
      }
    }
    if (text === 'success') {
      throw new VJudgeError('提交结果未知，请在浏览器中确认。', undefined, response.status, text);
    }
    if (/^\d+$/.test(text)) {
      return Number(text);
    }
    if (response.status === 400 || /<!doctype/i.test(text)) {
      throw new VJudgeError('提交失败，请确认比赛/题目是否允许提交。', undefined, response.status);
    }
    throw new VJudgeError(
      '提交失败：VJudge 返回了无法识别的内容，请稍后在网页端确认提交状态。',
      undefined,
      response.status,
      text,
    );
  }

  async listRemoteAccounts(oj: string): Promise<RemoteAccountBinding[]> {
    const response = await this.request('GET', '/user/remoteAccounts/list', {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/user/remoteAccounts?oj=${encodeURIComponent(oj)}` },
      query: { oj },
    });
    const data = this.ensureSuccessJson(response, '无法获取远程 OJ 账号列表');
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
    if (record && (record.error !== undefined || record.errorKey !== undefined)) {
      throw makeClientError(data, response.status, '无法获取远程 OJ 账号列表。');
    }
    const raw = this.remoteBindingRows(record, Array.isArray(data) ? data : [], oj);
    const bindings: RemoteAccountBinding[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const entry = item as Record<string, unknown>;
      const id = Number(entry.id);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }
      bindings.push({
        id,
        accountId: typeof entry.accountId === 'string' ? entry.accountId : undefined,
        accountDisplay: typeof entry.accountDisplay === 'string' ? entry.accountDisplay : undefined,
        runtimeStatus: typeof entry.runtimeStatus === 'string' ? entry.runtimeStatus : undefined,
        healthStatus: typeof entry.healthStatus === 'string' ? entry.healthStatus : undefined,
        statusReason: typeof entry.statusReason === 'string' ? entry.statusReason : undefined,
      });
    }
    return bindings;
  }

  private remoteBindingRows(
    record: Record<string, unknown> | undefined,
    fallback: unknown[],
    oj: string,
  ): unknown[] {
    const groups = record?.groups;
    if (groups && typeof groups === 'object') {
      const entries = Object.entries(groups as Record<string, unknown>);
      const matched = entries.find(([key]) => key.toLowerCase() === oj.toLowerCase());
      const rows: unknown[] = [];
      for (const [, group] of matched ? [matched] : entries) {
        const list = group && typeof group === 'object'
          ? (group as Record<string, unknown>).bindings
          : undefined;
        if (Array.isArray(list)) {
          rows.push(...list);
        }
      }
      if (entries.length > 0) {
        return rows;
      }
    }
    if (record && Array.isArray(record.bindings)) {
      return record.bindings;
    }
    return fallback;
  }

  async getCaptcha(): Promise<{ dataUrl: string; mime: string }> {
    const response = await this.request('GET', `/util/captcha?${Date.now()}`, {
      ajax: true,
      headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: `${VJUDGE_BASE}/` },
    });
    const contentType = String(response.headers['content-type'] ?? '');
    if (!/^image\//i.test(contentType)) {
      if (/text\/html/i.test(contentType) || this.isLoginResponse(response)) {
        throw new VJudgeError('获取验证码需要先登录 VJudge。', undefined, response.status, undefined, 'login');
      }
      throw new VJudgeError('验证码接口返回了非图片内容，请稍后重试。', undefined, response.status);
    }
    const mime = contentType.split(';')[0] || 'image/png';
    return {
      dataUrl: `data:${mime};base64,${response.body.toString('base64')}`,
      mime,
    };
  }

  async getSolution(runId: number): Promise<Solution> {
    const response = await this.request('GET', `/solution/data/${runId}`, {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/status` },
    });
    const data = this.ensureSuccessJson(response, '无法获取评测结果') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取评测结果。');
    }
    if (data.runId === undefined) {
      data.runId = runId;
    }
    return data as unknown as Solution;
  }

  async listSubmissions(
    username: string,
    length = 30,
    contestId?: number,
  ): Promise<SubmissionSummary[]> {
    const response = await this.request('GET', '/status/data', {
      ajax: true,
      headers: { Referer: `${VJUDGE_BASE}/status` },
      query: {
        draw: 1,
        start: 0,
        length,
        un: username,
        OJId: 'All',
        probNum: '',
        res: '',
        language: '',
        onlyFollowee: 'false',
        ...(contestId !== undefined ? { contestId } : {}),
      },
    });
    const data = this.ensureSuccessJson(response, '无法获取提交记录') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取提交记录。');
    }
    const rows = Array.isArray(data.data) ? (data.data as unknown[]) : [];
    const submissions: SubmissionSummary[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const record = row as Record<string, unknown>;
      const runId = Number(record.runId);
      if (!Number.isFinite(runId)) {
        continue;
      }
      submissions.push({
        runId,
        status: String(record.status ?? ''),
        statusType: Number(record.statusType ?? 0),
        processing: record.processing === true,
        runtime: Number(record.runtime ?? 0),
        memory: Number(record.memory ?? 0),
        language: String(record.language ?? ''),
        oj: String(record.oj ?? record.ojId ?? ''),
        probNum: String(record.probNum ?? ''),
        time: Number(record.time ?? record.submitTime ?? 0),
        userName: record.userName ? String(record.userName) : undefined,
        problemId: record.problemId !== undefined ? Number(record.problemId) : undefined,
        contestId: record.contestId !== undefined ? Number(record.contestId) : undefined,
        sourceLength: record.sourceLength !== undefined ? Number(record.sourceLength) : undefined,
      });
    }
    return submissions;
  }

  async getUserSolveRecords(username: string): Promise<SolveRecords> {
    const response = await this.request(
      'GET',
      `/user/solveDetail/${encodeURIComponent(username)}`,
      {
        ajax: true,
        retries: 0,
        headers: { Referer: `${VJUDGE_BASE}/user/${encodeURIComponent(username)}` },
      },
    );
    if (this.isLoginResponse(response)) {
      throw new VJudgeError('登录状态已失效，请重新登录。', undefined, response.status, undefined, 'login');
    }
    const data = this.ensureSuccessJson(response, '无法获取做题状态') as Record<string, unknown>;
    if (data.error) {
      throw makeClientError(data, response.status, '无法获取做题状态。');
    }
    const records: SolveRecords = {
      accepted: new Set<string>(),
      attempted: new Set<string>(),
    };
    readSolveRecords(data.acRecords, records.accepted);
    readSolveRecords(data.failRecords, records.attempted);
    return records;
  }

  async getUsername(): Promise<string | undefined> {
    for (const path of ['/', '/user/']) {
      try {
        const response = await this.request('GET', path, {
          html: true,
          ajax: false,
        });
        const finalMatch = response.finalUrl.match(/\/user\/([^/?#]+)/);
        const finalName = normalizeUsername(finalMatch ? decodeURIComponent(finalMatch[1]) : undefined);
        if (finalName) {
          return finalName;
        }
        const html = response.body.toString('utf8');
        const links = html.matchAll(/href=["']\/user\/([^"'/?#]+)/gi);
        for (const link of links) {
          const name = normalizeUsername(decodeURIComponent(link[1]));
          if (name) {
            return name;
          }
        }
        const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        if (title) {
          const name = normalizeUsername(
            stripTags(title[1]).replace(/\s*-\s*Virtual Judge\s*$/i, ''),
          );
          if (name) {
            return name;
          }
        }
      } catch {
        // 尝试下一个入口
      }
    }
    return undefined;
  }
}

export function normalizeUsername(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || /not\s*found/i.test(name)) {
    return undefined;
  }
  if (/^(?:user|login|logout|register|signup|setting|settings|404)$/i.test(name)) {
    return undefined;
  }
  return name;
}
