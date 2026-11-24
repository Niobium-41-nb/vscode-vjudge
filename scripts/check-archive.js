const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const client = require(path.join(root, 'out', 'api', 'client.js'));
const errors = require(path.join(root, 'out', 'api', 'errors.js'));
const parser = require(path.join(root, 'out', 'api', 'parser.js'));
const statementCache = require(path.join(root, 'out', 'statementCache.js'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain);
};
let commands;
try {
  commands = require(path.join(root, 'out', 'commands.js'));
} finally {
  Module._load = originalLoad;
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function capture(options) {
  const instance = new client.VJudgeClient();
  const captured = {};
  instance.request = async (method, urlPath, requestOptions) => {
    captured.method = method;
    captured.urlPath = urlPath;
    captured.options = requestOptions;
    return {
      status: 200,
      headers: {},
      setCookies: [],
      body: Buffer.from(JSON.stringify({ runId: 123 })),
      finalUrl: 'https://vjudge.net',
    };
  };
  const runId = await instance.submit(options);
  return { captured, runId };
}

async function main() {
  console.log('归档提交请求');
  let result = await capture({
    oj: '洛谷',
    probNum: 'P5318',
    language: 'cpp17',
    code: '',
    open: false,
    method: 2,
    bindingId: 42,
  });
  let form = result.captured.options.form;
  check('使用 POST 题目提交接口', result.captured.method === 'POST' && result.captured.urlPath === '/problem/submit/%E6%B4%9B%E8%B0%B7-P5318', result.captured.urlPath);
  check('提交方式为归档', form.method === 2, String(form.method));
  check('携带远程账号绑定', form.bindingId === 42, String(form.bindingId));
  check('不发送本地源码', form.source === '', JSON.stringify(form.source));
  check('解析运行 ID', result.runId === 123, String(result.runId));

  result = await capture({
    oj: 'CodeForces',
    probNum: '4A',
    contestId: 803029,
    contestNum: 'A',
    language: 'cpp17',
    code: '',
    method: 2,
    bindingId: 7,
  });
  form = result.captured.options.form;
  check('比赛使用比赛提交接口', result.captured.urlPath === '/contest/submit/803029/A', result.captured.urlPath);
  check('比赛归档同样携带绑定', form.method === 2 && form.bindingId === 7);

  console.log('归档语言元数据');
  const detailHtml = `<html><body><textarea name="dataJson">${JSON.stringify({
    problemId: 1,
    title: '测试题目',
    languages: { cpp17: 'GNU G++17' },
    submitMethods: [true, false, true],
    descBriefs: [{ key: 123, version: 0 }],
  })}</textarea></body></html>`;
  const detail = parser.parseProblemDetail(detailHtml, 'CodeForces', '4A');
  const ref = {
    oj: 'CodeForces',
    probNum: '4A',
    title: '测试题目',
    descBriefs: [{ key: 123, version: 0 }],
  };
  let detailRequests = 0;
  const statementErrors = [];
  const languages = await commands.loadProblemLanguages(
    {
      client: {
        getStatement: async () => ({ languages: {} }),
        getProblemDetail: async () => {
          detailRequests++;
          return detail;
        },
      },
    },
    ref,
    (error) => statementErrors.push(error),
  );
  check('题面无语言时补全题目详情', detailRequests === 1, String(detailRequests));
  check('空语言题面无需额外报错', statementErrors.length === 0, String(statementErrors.length));
  check('归档获得提交语言', languages.cpp17 === 'GNU G++17', JSON.stringify(languages));
  check('语言写回题目引用', ref.languages === languages);
  check('同步归档支持状态', JSON.stringify(ref.submitMethods) === '[true,false,true]');

  const fallbackRef = { oj: 'CodeForces', probNum: '5A' };
  const fallbackLanguages = await commands.loadProblemLanguages(
    {
      client: {
        getStatement: async () => {
          throw new Error('题面请求失败');
        },
        getProblemDetail: async () => detail,
      },
    },
    fallbackRef,
    () => {},
  );
  check('题面请求失败仍可补全语言', fallbackLanguages.cpp17 === 'GNU G++17');
  check('失败回退同样同步提交方式', JSON.stringify(fallbackRef.submitMethods) === '[true,false,true]');
  statementCache.clearStatementCache();

  console.log('归档错误提示');
  const expected = {
    'submit.error.archive_not_allowed': '当前不允许使用归档提交。',
    'submit.error.archive_processing': '目标 OJ 当前繁忙，请稍后再试。',
    'submit.error.archive_query_failed': '获取最近归档提交失败，请稍后再试。',
    'submit.error.no_recent_submissions_found': '没有找到最近提交。请先在原 OJ 提交该题，并确认远程账号与 VJudge 绑定的一致。',
  };
  for (const [key, message] of Object.entries(expected)) {
    check(key, errors.translateI18n(key) === message, errors.translateI18n(key));
  }
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