export type ErrorKind = 'normal' | 'login' | 'captcha';

export class VJudgeError extends Error {
  constructor(
    message: string,
    public readonly i18nKey?: string,
    public readonly status?: number,
    public readonly payload?: unknown,
    public readonly kind: ErrorKind = 'normal',
  ) {
    super(message);
    this.name = 'VJudgeError';
  }
}

export class CaptchaRequiredError extends VJudgeError {
  constructor(message = '提交需要输入验证码。', i18nKey?: string, status?: number, payload?: unknown) {
    super(message, i18nKey, status, payload, 'captcha');
    this.name = 'CaptchaRequiredError';
  }
}

const translations: Record<string, string> = {
  'user.auth.error.invalid_credentials': '用户名或密码错误。',
  'user.auth.error.human_verification_failed': 'VJudge 要求人机验证。请改用“使用 Cookie 登录”。',
  'user.auth.error.login_required': '请先登录 VJudge。',
  'user.error.human_verification_failed': 'VJudge 要求人机验证。请改用“使用 Cookie 登录”。',
  'user.auth.error.account_disabled': '账号已被禁用。',
  'toast.user.login_required': '请先登录 VJudge。',
  'toast.problem.login_required': '请先登录 VJudge 才能查看题目。',
  'problem.list.login_required': '请先登录 VJudge 才能查看题目。',
  'submit.error.login_required': '登录状态已失效，请重新登录。',
  'submit.error.captcha': '提交需要输入验证码。',
  'submit.error.captcha_wrong': '验证码错误，请重试。',
  'submit.error.invalid_captcha': '验证码错误，请重试。',
  'submit.error.source_too_long': '代码长度超出限制。',
  'submit.error.problem_not_found': '题目不存在或不可提交。',
  'submit.error.contest_not_started': '比赛尚未开始。',
  'submit.error.contest_ended': '比赛已经结束。',
  'own_account.error.invalid': '远程 OJ 账号未绑定或已失效，请先在 VJudge 绑定对应 OJ 账号。',
  'own_account.error.login_required': '远程 OJ 账号未登录，请先在 VJudge 绑定对应 OJ 账号。',
  'solution.error.crawler_blocked': '请求被 VJudge 拦截，请稍后重试或在浏览器中查看。',
  'solution.error.login_required': '登录状态已失效，请重新登录。',
  'article.error.login_required': '请先登录 VJudge。',
  'article.error.update_forbidden': '没有权限修改该题单。',
  'article.error.not_found': '题单不存在或已被删除。',
  'article.error.title_required': '题单标题不能为空。',
  'article.error.too_long': '题单内容或标题超出长度限制。',
};

export function translateI18n(key: string | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  if (translations[key]) {
    return translations[key];
  }
  if (key.endsWith('login_required')) {
    return '请先登录 VJudge。';
  }
  if (/captcha|human_verification|turnstile/i.test(key)) {
    return '需要人机验证或验证码，请稍后重试，或改用 Cookie 登录。';
  }
  if (key.endsWith('invalid_credentials')) {
    return '用户名或密码错误。';
  }
  const tail = key.split('.').filter(Boolean).pop();
  return tail ? `操作失败（${tail}）。` : '操作失败。';
}

export function extractI18nKey(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.i18nKey === 'string') {
    return record.i18nKey;
  }
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.i18nKey === 'string') {
      return error.i18nKey;
    }
  }
  return undefined;
}

export function makeClientError(data: unknown, status: number, fallback: string): VJudgeError {
  const key = extractI18nKey(data);
  const message = translateI18n(key) ?? fallback;
  if (key && key.endsWith('login_required')) {
    return new VJudgeError(message, key, status, data, 'login');
  }
  if (key && /captcha/i.test(key)) {
    return new CaptchaRequiredError(message, key, status, data);
  }
  return new VJudgeError(message, key, status, data);
}
