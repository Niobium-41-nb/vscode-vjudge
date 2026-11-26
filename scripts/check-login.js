const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const { VJudgeClient } = require(path.join(root, 'out', 'api', 'client.js'));
const { VJudgeError } = require(path.join(root, 'out', 'api', 'errors.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function response(body, status = 200) {
  return {
    status,
    headers: {},
    setCookies: [],
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    finalUrl: 'https://vjudge.net',
  };
}

async function rejection(run) {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function checkClientLogin() {
  console.log('密码登录请求');
  const calls = [];
  const instance = new VJudgeClient();
  instance.request = async (method, urlPath, options) => {
    calls.push({ method, urlPath, options });
    return urlPath === '/user/login' ? response('success') : response('true');
  };
  await instance.login('alice', ' secret ');
  check('使用账号密码表单', calls[0]?.options.form.username === 'alice' && calls[0]?.options.form.password === ' secret ');
  check('登录请求不携带 AJAX 头', calls[0]?.options.ajax === false);
  check('登录 POST 不自动重试', calls[0]?.options.retries === undefined);
  check('登录成功后复核会话', calls.length === 2 && calls[1]?.urlPath === '/user/checkLogInStatus');
  check('会话复核使用安全重试', calls[1]?.options.retries === 2);

  const emptySuccess = new VJudgeClient();
  let emptySuccessChecks = 0;
  emptySuccess.request = async (method, urlPath) => {
    if (urlPath === '/user/login') {
      emptySuccess.importCookies('JSESSIONID=new');
      return response('');
    }
    emptySuccessChecks++;
    return response('true');
  };
  await emptySuccess.login('alice', 'secret');
  check('兼容空响应登录成功', emptySuccessChecks === 1);

  const emptyWithoutCookies = new VJudgeClient();
  emptyWithoutCookies.request = async () => response('');
  const emptyError = await rejection(() => emptyWithoutCookies.login('alice', 'secret'));
  check('无 Cookie 的空响应不误判成功', emptyError instanceof VJudgeError && /无法识别的响应/.test(emptyError.message));

  const falseSession = new VJudgeClient();
  falseSession.importCookies('JSESSIONID=stale');
  falseSession.request = async (method, urlPath) =>
    urlPath === '/user/login' ? response({ success: true }) : response('false');
  const falseSessionError = await rejection(() => falseSession.login('alice', 'wrong'));
  check('拒绝未生效的会话', falseSessionError instanceof VJudgeError && /仍未生效/.test(falseSessionError.message));
  check('失败时清除无效会话', !falseSession.hasCookies());

  const challenge = new VJudgeClient();
  let challengeRequests = 0;
  challenge.request = async () => {
    challengeRequests++;
    return response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', 403);
  };
  const challengeError = await rejection(() => challenge.login('alice', 'secret'));
  check('识别人机验证页面', challengeError instanceof VJudgeError && challengeError.kind === 'captcha');
  check('验证码页不输出原始 HTML', !challengeError?.message.includes('<html>'));
  check('验证码失败不继续复核会话', challengeRequests === 1);

  const captcha = new VJudgeClient();
  captcha.request = async () => response({ success: false, captcha: true });
  const captchaError = await rejection(() => captcha.login('alice', 'secret'));
  check('识别 JSON 人机验证标记', captchaError instanceof VJudgeError && captchaError.kind === 'captcha');

  const invalid = new VJudgeClient();
  invalid.request = async () => response({ i18nKey: 'user.auth.error.invalid_credentials' }, 401);
  const invalidError = await rejection(() => invalid.login('alice', 'wrong'));
  check('翻译错误凭据提示', invalidError?.message === '用户名或密码错误。');

  const throttled = new VJudgeClient();
  throttled.request = async () => response({}, 429);
  const throttledError = await rejection(() => throttled.login('alice', 'secret'));
  check('频率限制提供中文提示', /请求过于频繁/.test(throttledError?.message));

  const unknown = new VJudgeClient();
  unknown.request = async () => response('<html><body>unexpected private detail</body></html>');
  const unknownError = await rejection(() => unknown.login('alice', 'secret'));
  check('未知响应不暴露页面内容', /无法识别的响应/.test(unknownError?.message) && !unknownError?.message.includes('private detail'));
}

class MockEventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}

function vscodeMock(inputs, errorChoice) {
  const inputOptions = [];
  const errors = [];
  const configuration = {
    get: (key, fallback) => fallback,
    update: async () => {},
  };
  return {
    api: {
      EventEmitter: MockEventEmitter,
      ProgressLocation: { Notification: 15 },
      ConfigurationTarget: { Global: 1 },
      Uri: { parse: (value) => value },
      commands: { executeCommand: async () => {} },
      env: { openExternal: async () => true },
      workspace: { getConfiguration: () => configuration },
      window: {
        showInputBox: async (options) => {
          inputOptions.push(options);
          return inputs.shift();
        },
        showErrorMessage: async (message, ...actions) => {
          errors.push({ message, actions });
          return errorChoice;
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        withProgress: async (_options, task) => task(),
      },
    },
    inputOptions,
    errors,
  };
}

async function checkSessionLogin() {
  console.log('登录界面与会话');
  let activeMock = vscodeMock([' alice ', ' secret ']);
  const vscodeApi = {
    ...activeMock.api,
    window: {
      showInputBox: async (options) => activeMock.api.window.showInputBox(options),
      showErrorMessage: async (message, ...actions) => activeMock.api.window.showErrorMessage(message, ...actions),
      showInformationMessage: async (message) => activeMock.api.window.showInformationMessage(message),
      showWarningMessage: async (message, ...actions) => activeMock.api.window.showWarningMessage(message, ...actions),
      withProgress: async (options, task) => activeMock.api.window.withProgress(options, task),
    },
  };
  const originalLoad = Module._load;
  let Session;
  Module._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscodeApi : originalLoad.call(this, request, parent, isMain);
  };
  try {
    ({ Session } = require(path.join(root, 'out', 'session.js')));
  } finally {
    Module._load = originalLoad;
  }

  const state = new Map();
  const secrets = new Map();
  const output = { appendLine() {} };
  const context = {
    globalState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) },
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => secrets.set(key, value),
      delete: async (key) => secrets.delete(key),
    },
  };
  const session = new Session(context, output);
  session.client.importCookies('JSESSIONID=old');
  let loginCookies;
  let loginArguments;
  session.client.login = async (username, password) => {
    loginArguments = [username, password];
    loginCookies = session.client.hasCookies();
    session.client.importCookies('JSESSIONID=new');
  };
  check('密码登录成功', await session.login());
  check('用户名去除首尾空格', loginArguments?.[0] === 'alice');
  check('密码保留原始内容', loginArguments?.[1] === ' secret ');
  check('登录前清除旧 Cookie', loginCookies === false);
  check('成功后保存规范化用户名', session.username === 'alice');
  check('密码仅写入安全存储', secrets.get('vjudge.password') === ' secret ');
  check('成功后 Cookie 写入安全存储', secrets.get('vjudge.cookies') === 'JSESSIONID=new');
  check('界面进入已登录状态', session.isLoggedIn);
  check('纯空白用户名无法通过校验', activeMock.inputOptions[0]?.validateInput('   ') === '请输入用户名');
  session.dispose();

  const failedMock = vscodeMock(['alice', 'wrong']);
  activeMock = failedMock;
  const failedSession = new Session(context, output);
  failedSession.client.importCookies('JSESSIONID=working');
  failedSession.client.login = async () => {
    failedSession.client.importCookies('JSESSIONID=failed');
    throw new VJudgeError('网络请求失败。');
  };
  check('失败登录返回 false', !(await failedSession.login()));
  check('失败登录保留原有 Cookie', failedSession.client.exportCookies() === 'JSESSIONID=working');
  check('失败登录不覆盖已保存密码', secrets.get('vjudge.password') === ' secret ');
  check('失败登录显示可重试操作', failedMock.errors[0]?.actions.includes('重试'));
  failedSession.dispose();

  const retryMock = vscodeMock(['alice', 'wrong', 'alice', 'right'], '重试');
  activeMock = retryMock;
  const retrySession = new Session(context, output);
  let attempts = 0;
  retrySession.client.login = async () => {
    attempts++;
    if (attempts === 1) {
      throw new VJudgeError('网络请求超时。');
    }
  };
  check('普通失败可直接重试', await retrySession.login() && attempts === 2);
  retrySession.dispose();

  const verificationMock = vscodeMock(['alice', 'secret']);
  activeMock = verificationMock;
  const verificationSession = new Session(context, output);
  verificationSession.client.login = async () => {
    throw new VJudgeError('VJudge 要求人机验证。', 'user.auth.error.human_verification_failed', 403, undefined, 'captcha');
  };
  check('人机验证登录返回 false', !(await verificationSession.login()));
  check(
    '人机验证提供 Cookie 与浏览器入口',
    verificationMock.errors[0]?.actions.includes('使用 Cookie 登录') && verificationMock.errors[0]?.actions.includes('在浏览器中登录'),
  );
  verificationSession.dispose();

  const autoState = new Map([['vjudge.username', 'alice']]);
  const autoSecrets = new Map([
    ['vjudge.cookies', 'JSESSIONID=expired'],
    ['vjudge.password', 'secret'],
  ]);
  const autoContext = {
    globalState: { get: (key) => autoState.get(key), update: async (key, value) => autoState.set(key, value) },
    secrets: {
      get: async (key) => autoSecrets.get(key),
      store: async (key, value) => autoSecrets.set(key, value),
      delete: async (key) => autoSecrets.delete(key),
    },
  };
  activeMock = vscodeMock([]);
  const autoSession = new Session(autoContext, output);
  autoSession.client.checkLoginStatus = async () => false;
  let autoLoginHadCookies = true;
  autoSession.client.login = async () => {
    autoLoginHadCookies = autoSession.client.hasCookies();
  };
  await autoSession.initialize();
  check('自动登录前清除失效 Cookie', autoLoginHadCookies === false);
  check('自动登录成功恢复会话', autoSession.isLoggedIn);
  autoSession.dispose();
}

async function main() {
  await checkClientLogin();
  await checkSessionLogin();
}

main()
  .catch((error) => {
    failures++;
    console.error(error);
  })
  .finally(() => {
    if (failures > 0) {
      console.log(`\n${failures} 项检查失败`);
      process.exitCode = 1;
    } else {
      console.log('\n全部检查通过');
    }
  });
