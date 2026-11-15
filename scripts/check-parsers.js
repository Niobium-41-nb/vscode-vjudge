const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const parser = require(path.join(root, 'out', 'api', 'parser.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function fixture(name) {
  const candidates = [
    process.env.VJUDGE_FIXTURE_DIR && path.join(process.env.VJUDGE_FIXTURE_DIR, name),
    path.join(os.tmpdir(), name),
    path.join('/tmp', name),
  ].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    console.log(`跳过：未找到 ${name}（可设置 VJUDGE_FIXTURE_DIR）`);
    return undefined;
  }
  return fs.readFileSync(file, 'utf8');
}

const contestHtml = fixture('c803029b.html');
if (contestHtml) {
  console.log('比赛页面');
  const detail = parser.parseContestDetail(contestHtml);
  check('解析到题目', detail.problems.length > 0, `${detail.problems.length} 题`);
  const first = detail.problems[0];
  if (first) {
    check('题目含 OJ 与编号', Boolean(first.oj && first.probNum), `${first.oj}-${first.probNum}`);
    check('题目含标题', Boolean(first.title), first.title);
    check('题目含语言列表', Object.keys(first.languages).length > 0, `${Object.keys(first.languages).length} 种`);
    check(
      '题目含题面引用',
      Array.isArray(first.descBriefs) && first.descBriefs.length > 0,
      `${first.descBriefs ? first.descBriefs.length : 0} 个题面`,
    );
  }
}

const descriptionHtml = fixture('desc.html');
if (descriptionHtml) {
  console.log('题面页面');
  const parsed = parser.parseDescriptionPage(descriptionHtml);
  check('解析到题面段落', parsed.sections.length > 0, `${parsed.sections.length} 段`);
  const totalLength = parsed.sections.reduce((sum, section) => sum + section.html.length, 0);
  check('题面内容非空', totalLength > 100, `${totalLength} 字符`);
  check('解析到样例', parsed.samples.length > 0, `${parsed.samples.length} 组`);
  if (parsed.samples[0]) {
    check('样例输入非空', parsed.samples[0].input.length > 0, JSON.stringify(parsed.samples[0].input.slice(0, 40)));
    check('样例输出非空', parsed.samples[0].output.length > 0, JSON.stringify(parsed.samples[0].output.slice(0, 40)));
  }
  const joined = parsed.sections.map((section) => section.html).join('\n');
  const sanitized = parser.sanitizeStatementHtml(joined);
  check('清理脚本标签', !/<script/i.test(sanitized));
  check('清理事件属性', !/\son\w+\s*=/i.test(sanitized));
  check('清理 style 标签', !/<style/i.test(sanitized));
  check('图片链接被绝对化', !/\ssrc\s*=\s*(["'])\/(?!\/)/i.test(sanitized));
}

console.log('题面图片');
const cdnSanitized = parser.sanitizeStatementHtml(
  '<p><img src="CDN_BASE_URL/9bfcfa2c04f927659b197ee6d71211ae" style="max-width:100%"></p>',
);
check(
  '替换 CDN 图片占位符',
  cdnSanitized.includes('src="https://cdn.vjudge.net.cn/9bfcfa2c04f927659b197ee6d71211ae"') &&
    !cdnSanitized.includes('CDN_BASE_URL'),
  cdnSanitized,
);

console.log('Markdown 题面');
const markdownContent = [
  '### 样例 1 解释',
  '',
  '给定 $n$ 个数，满足 $a_i \\le 10^9$。',
  '',
  '另记 \\(N\\) 与 \\[x \\le y\\]。',
  '',
  '- 第一行：$n$',
  '- 第二行：$a_1, a_2$',
  '',
  '```cpp',
  'int main() { return 0; }',
  '```',
].join('\n');
const markdownPage = `<html><body><textarea class="data-json-container">${JSON.stringify({
  sections: [
    { title: '', value: { format: 'MD', content: markdownContent } },
    { title: '', value: { format: 'HTML', content: '<p><strong>原样 HTML</strong></p>' } },
  ],
})}</textarea></body></html>`;
const markdownSections = parser.parseDescriptionPage(markdownPage).sections;
const markdownHtml = markdownSections.map((section) => section.html).join('\n');
check('Markdown 标题渲染', markdownHtml.includes('<h3>样例 1 解释</h3>') && !/###\s*样例/.test(markdownHtml));
check('Markdown 列表渲染', markdownHtml.includes('<ul>') && markdownHtml.includes('<li>第一行：$n$</li>'));
check('Markdown 公式原样保留', markdownHtml.includes('$a_i \\le 10^9$'));
check(
  'Markdown 显式公式定界符保留',
  markdownHtml.includes('\\(N\\)') && markdownHtml.includes('\\[x \\le y\\]'),
);
check(
  'Markdown 代码块渲染',
  markdownHtml.includes('<pre><code class="language-cpp">int main() { return 0; }</code></pre>'),
);
check('HTML 段落不被转义', markdownHtml.includes('<p><strong>原样 HTML</strong></p>'));

const markdownSamplePage = `<html><body><textarea class="data-json-container">${JSON.stringify({
  sections: [
    {
      value: {
        format: 'MD',
        content: "样例：\n\n<table class='vjudge_sample'><tr><th>Input</th><th>Output</th></tr><tr><td><pre>1 2</pre></td><td><pre>3</pre></td></tr></table>",
      },
    },
  ],
})}</textarea></body></html>`;
const markdownSamples = parser.parseDescriptionPage(markdownSamplePage).samples;
check('Markdown 题面样例提取', markdownSamples.length === 1 && markdownSamples[0].input === '1 2');

console.log('题面引用兜底');
const iframePage = `<html><head><title>测试题</title></head><body>
<div id="frame-description-container"><iframe src="/problem/description/123456?789012"></iframe></div>
</body></html>`;
const iframeDetail = parser.parseProblemDetail(iframePage, 'OJ', '1');
check('iframe 题面引用', iframeDetail.descriptions.length === 1, `${iframeDetail.descriptions.length} 个`);
check(
  'iframe 题面 ID 与版本',
  iframeDetail.descriptions[0]?.id === 123456 && iframeDetail.descriptions[0]?.version === 789012,
  JSON.stringify(iframeDetail.descriptions[0]),
);

const bareIframePage = `<html><body><iframe src="https://vjudge.net/problem/description/654321"></iframe></body></html>`;
const bareDetail = parser.parseProblemDetail(bareIframePage, 'OJ', '2');
check(
  '无版本号 iframe 题面引用',
  bareDetail.descriptions.length === 1 && bareDetail.descriptions[0]?.version === 0,
  JSON.stringify(bareDetail.descriptions[0]),
);

console.log('单题页 dataJson 题面引用');
const standaloneData = {
  problemId: 4018982,
  title: 'Swaps 2',
  languages: { '5063': 'Python' },
  enabledDescKeys: [999],
  descBriefs: [
    { key: 111, version: 222, official: false },
    { key: 999, version: 1234567890123, official: true },
  ],
};
const standalonePage = `<html><head><title>Swaps 2 - Virtual Judge</title></head><body>
<textarea name="dataJson">${JSON.stringify(standaloneData)}</textarea>
<div id="prob-descs"></div>
</body></html>`;
const standaloneDetail = parser.parseProblemDetail(standalonePage, 'AtCoder', 'arc120_c');
check('dataJson 解析到题面引用', standaloneDetail.descriptions.length === 2, `${standaloneDetail.descriptions.length} 个`);
check(
  'official 题面排在前面并补全版本',
  standaloneDetail.descriptions[0]?.id === 999 &&
    standaloneDetail.descriptions[0]?.version === 1234567890123,
  JSON.stringify(standaloneDetail.descriptions[0]),
);
check('dataJson 解析标题与语言', standaloneDetail.title === 'Swaps 2' && Boolean(standaloneDetail.languages['5063']));

const descriptionListData = {
  problemId: 2,
  title: 'Swaps 2',
  languages: {},
  enabledDescKeys: [999, 111, 777],
  descBriefs: [
    { key: 999, version: 1, author: 'System', lang: 'ja', langDisplay: '日本語', official: true, updateDate: '2026-05-24' },
    { key: 111, version: 2, author: 'System', lang: 'en', langDisplay: 'English', official: true, updateDate: '2026-05-24' },
    { key: 777, version: 3, author: 'GPT', lang: 'zh', langDisplay: '中文', official: false, updateDate: '2026-11-14', remarks: 'Translated by gpt-6-luna' },
  ],
};
const descriptionListPage = `<html><body><textarea name="dataJson">${JSON.stringify(descriptionListData)}</textarea></body></html>`;
const descriptionList = parser.parseProblemDetail(descriptionListPage, 'AtCoder', 'arc120_c').descriptions;
check(
  '题面列表按官方与英文优先排序',
  descriptionList.map((item) => item.id).join(',') === '111,999,777',
  descriptionList.map((item) => item.id).join(','),
);
check(
  '题面列表保留作者与语言信息',
  descriptionList[0]?.author === 'System' &&
    descriptionList[0]?.langDisplay === 'English' &&
    descriptionList[2]?.remarks === 'Translated by gpt-6-luna',
  JSON.stringify(descriptionList),
);

const enabledOnlyPage = `<html><body><textarea name="dataJson">${JSON.stringify({
  problemId: 3,
  title: 'Enabled only',
  languages: {},
  enabledDescKeys: [9, 7],
})}</textarea></body></html>`;
check(
  '缺少 descBriefs 时用 enabledDescKeys 兜底',
  parser
    .parseProblemDetail(enabledOnlyPage, 'OJ', '1')
    .descriptions.map((item) => item.id)
    .join(',') === '9,7',
);

const escapedJsonPage = `<html><body><textarea name="dataJson">{&quot;problemId&quot;:1,&quot;descBriefs&quot;:[{&quot;key&quot;:777,&quot;version&quot;:888}]}</textarea></body></html>`;
check(
  '实体转义的 dataJson 也能解析',
  parser.parseProblemDetail(escapedJsonPage, 'OJ', '3').descriptions[0]?.id === 777,
);

const nonLiPage = `<html><body><div id="prob-descs">
<a class="problem-description-item active" data-key=555 data-version=666></a>
</div></body></html>`;
const nonLiDetail = parser.parseProblemDetail(nonLiPage, 'OJ', '4');
check(
  '题面列表不限于 li 标签',
  nonLiDetail.descriptions.length === 1 &&
    nonLiDetail.descriptions[0]?.id === 555 &&
    nonLiDetail.descriptions[0]?.version === 666,
  JSON.stringify(nonLiDetail.descriptions[0]),
);

const challengeHtml = `<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>`;
check('识别人机验证页', parser.isChallengePage(challengeHtml));
check('普通页面不误判', !parser.isChallengePage(iframePage));

const cfInjectedPage = `<html><body><div id="description-container"></div>
<textarea class="data-json-container">{"sections":[{"title":"","value":{"content":"<p>正文</p>"}}]}</textarea>
<script>window.__CF$cv$params={r:'x'};var u='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>
</body></html>`;
check('正常页面的 Cloudflare 探测脚本不误判', !parser.isChallengePage(cfInjectedPage));
const cfParsed = parser.parseDescriptionPage(cfInjectedPage);
check('正常页面仍能解析题面', cfParsed.sections.length === 1, `${cfParsed.sections.length} 段`);

const blankPage = '<html><head><title></title></head><body><script>void 0;</script><style>body{}</style></body></html>';
check('空白页面不产生题面', parser.parseDescriptionPage(blankPage).sections.length === 0);

console.log('题单页面');
const workbookData = {
  isWorkbook: true,
  id: 42,
  title: '测试题单',
  author: 'alice',
  openness: 1,
  viewCnt: 123,
  createTime: 1700000000000,
  updateTime: 1700000100000,
  content: '[problem:POJ-1000]\n[problem:CodeForces-1000-A]\n[problem:CodeForces-1A]',
  nodeId: 7,
  workbook: {
    joined: true,
    problemsBrief: JSON.stringify({
      'CodeForces-1A': ['Theatre Square', 100, '<div><a href="x">Codeforces Round 1</a></div>'],
      'CodeForces-1000-A': ['A+B', 5, ''],
      'POJ-1000': ['A+B Problem', 200, '<div>POJ Source</div>'],
      'UVA-100': ['Not In Content', 1, ''],
    }),
  },
};
const workbookHtml = `<html><body><textarea name="dataJson">${JSON.stringify(workbookData)}</textarea></body></html>`;
const workbook = parser.parseWorkbookDetail(workbookHtml);
check('解析题单标题', workbook.title === '测试题单', workbook.title);
check('解析题单作者与可见性', workbook.author === 'alice' && workbook.openness === 1);
check('解析题单加入状态', workbook.joined === true);
check('解析题单正文与节点', workbook.content.includes('[problem:CodeForces-1A]') && workbook.nodeId === 7);
check('解析题单题目数量', workbook.problems.length === 4, `${workbook.problems.length} 题`);
check('题单按正文顺序排列', workbook.problems[0]?.oj === 'POJ' && workbook.problems[1]?.probNum === '1000-A');
check('题单标题与来源', workbook.problems[2]?.title === 'Theatre Square' && workbook.problems[2]?.source === 'Codeforces Round 1');
check('题单保留正文外题目', workbook.problems.some((problem) => problem.probNum === '100'));
const workbookWithoutContent = parser.parseWorkbookDetail(
  `<textarea name="dataJson">${JSON.stringify({
    isWorkbook: true,
    id: 43,
    title: '空题单',
    workbook: { problemsBrief: '{}', joined: false },
  })}</textarea>`,
);
check('空题单不报错', workbookWithoutContent.problems.length === 0);
let nonWorkbookRejected = false;
try {
  parser.parseWorkbookDetail(
    `<textarea name="dataJson">${JSON.stringify({ isWorkbook: false, id: 1, title: '普通文章' })}</textarea>`,
  );
} catch {
  nonWorkbookRejected = true;
}
check('拒绝非题单文章', nonWorkbookRejected);

console.log('题面数学渲染');
const panelSource = fs.readFileSync(path.join(root, 'src', 'views', 'statementPanel.ts'), 'utf8');
const scriptMatch = panelSource.match(/const SCRIPT = String\.raw`([\s\S]*?)`;/);
if (!scriptMatch) {
  check('提取题面脚本', false);
} else {
  const script = scriptMatch[1];
  const start = script.indexOf('var SYMBOLS');
  const end = script.indexOf('function copyText');
  try {
    const transformText = new Function(
      script.slice(start, end) + '; return transformText;',
    )();
    const inline = transformText(String.raw`输入 \(N\) 和 \(A_1\)`, false);
    check(
      '正文公式渲染',
      inline.changed && inline.html.includes('class="mj"') && inline.html.includes('<sub>1</sub>'),
    );
    const codeMath = transformText(String.raw`\(N\)\n\(A_1\) \(\ldots\) \(A_N\)`, true);
    check(
      '代码块公式渲染',
      codeMath.changed &&
        codeMath.html.includes('<span class="mj">N</span>') &&
        codeMath.html.includes('…'),
      codeMath.html.slice(0, 80),
    );
    const codeDollar = transformText('echo $HOME and $((1+2))', true);
    check('代码块不解析美元符号', !codeDollar.changed && codeDollar.html === 'echo $HOME and $((1+2))');
  } catch (error) {
    check('执行题面脚本', false, error.message);
  }
}

if (failures > 0) {
  console.log(`\n${failures} 项检查失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部检查通过');
}
