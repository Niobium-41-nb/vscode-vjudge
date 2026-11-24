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
  'submit.error.source_too_short': '代码长度至少需要 20 个字符。',
  'submit.error.source_too_large': '代码 UTF-8 长度最多只能为 30000 字节。',
  'submit.error.source_illegal_characters': '代码包含非法字符，请检查后重试。',
  'submit.error.source_not_text': '代码不是纯文本，请检查文件内容。',
  'submit.error.illegal_language': '提交语言不合法，请重新选择语言。',
  'submit.error.duplicate_code': 'VJudge 判定这份代码与该题之前提交过的代码完全相同，已拒绝重复提交。请修改代码（例如加一行注释或空行）或更换提交语言后再试。',
  'submit.error.source_submit_not_supported': '这道题不支持提交源码。',
  'submit.error.default_account_submit_not_supported': '这道题不支持用 VJudge 默认通道提交，请使用绑定的远程账号提交。',
  'submit.error.own_account_not_supported': '这道题暂不支持使用自己的远程账号提交。',
  'submit.error.no_submitter': '该 OJ 暂无可用提交器，请稍后重试。',
  'submit.error.problem_unavailable': '这道题已经长期不可用，无法提交。',
  'submit.error.frequency_exceeded': '提交过于频繁，请稍后再试。',
  'submit.error.challenge_required': 'VJudge 要求先完成人机验证。请先在浏览器中向该题提交一次并完成验证，再回到编辑器重试。',
  'submit.error.challenge_frequency': '最近提交较为频繁，请先在浏览器完成人机验证后重试。',
  'submit.error.challenge_source_length': '提交的源码较长，请先在浏览器完成人机验证后重试。',
  'submit.error.problem_set_updated': '题面集合已更新，请刷新题面后重新提交。',
  'submit.error.archive_reverify_required': '绑定的远程账号会话已失效，请在 VJudge 重新验证该账号后再试。',
  'submit.error.archive_not_allowed': '当前不允许使用归档提交。',
  'submit.error.archive_processing': '目标 OJ 当前繁忙，请稍后再试。',
  'submit.error.archive_query_failed': '获取最近归档提交失败，请稍后再试。',
  'submit.error.no_recent_submissions_found': '没有找到最近提交。请先在原 OJ 提交该题，并确认远程账号与 VJudge 绑定的一致。',
  'submit.error.contest_not_begun': '比赛尚未开始，暂时不能提交。',
  'submit.error.problem_not_found': '题目不存在或不可提交。',
  'submit.error.submit_method_not_allowed': '该平台需要通过绑定的远程账号提交，VJudge 不允许使用默认通道。',
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
  if (key.endsWith('submit_method_not_allowed')) {
    return '该平台需要通过绑定的远程账号提交，VJudge 不允许使用默认通道。';
  }
  if (key.endsWith('no_recent_submissions_found')) {
    return '没有找到最近提交。请先在原 OJ 提交该题，并确认远程账号与 VJudge 绑定的一致。';
  }
  if (key.endsWith('archive_not_allowed')) {
    return '当前不允许使用归档提交。';
  }
  if (key.endsWith('archive_processing')) {
    return '目标 OJ 当前繁忙，请稍后再试。';
  }
  if (key.endsWith('archive_query_failed')) {
    return '获取最近归档提交失败，请稍后再试。';
  }
  if (key.endsWith('duplicate_code')) {
    return 'VJudge 判定这份代码与该题之前提交过的代码完全相同，已拒绝重复提交。请修改代码（例如加一行注释或空行）或更换提交语言后再试。';
  }
  return 'VJudge 返回了未识别的错误。请稍后重试；如反复出现，可在“VJudge”输出面板查看错误键并反馈。';
}

export function extractI18nKey(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.i18nKey === 'string') {
    return record.i18nKey;
  }
  if (typeof record.errorKey === 'string') {
    return record.errorKey;
  }
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.i18nKey === 'string') {
      return error.i18nKey;
    }
  }
  return undefined;
}

const errorCodeMessages: Record<string, string> = {
  bind_account_missing: '未绑定可用的远程账号，请先在 VJudge 绑定该 OJ 的账号。',
  bind_account_invalid: '绑定的远程账号已失效，请在 VJudge 重新登录该账号。',
  bind_account_locked: '绑定的远程账号处于锁定状态，请先在 VJudge 解锁。',
  bind_account_disconnected: '绑定的远程账号连接已断开，请在 VJudge 重新登录该账号。',
  duplicate_code: 'VJudge 判定这份代码与该题之前提交过的代码完全相同，已拒绝重复提交。请修改代码或更换提交语言后再试。',
};

export function extractErrorCode(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const code = (data as Record<string, unknown>).errorCode;
  return typeof code === 'string' && code ? code : undefined;
}

export function makeClientError(data: unknown, status: number, fallback: string): VJudgeError {
  const key = extractI18nKey(data);
  const code = extractErrorCode(data);
  const message = translateI18n(key) ?? (code ? errorCodeMessages[code] : undefined) ?? fallback;
  if (key && key.endsWith('login_required')) {
    return new VJudgeError(message, key, status, data, 'login');
  }
  if (key && /captcha/i.test(key)) {
    return new CaptchaRequiredError(message, key, status, data);
  }
  return new VJudgeError(message, key ?? code, status, data);
}
