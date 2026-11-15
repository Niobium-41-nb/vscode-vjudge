const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const cph = require(path.join(root, 'out', 'cphFormat.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

console.log('CPH 题目格式');
const raw = JSON.stringify({
  name: 'A. Watermelon',
  url: 'https://vjudge.net/problem/CodeForces-4A',
  interactive: false,
  memoryLimit: 256,
  timeLimit: 2000,
  group: 'Codeforces',
  srcPath: 'C:\\work\\main.cpp',
  tests: [
    { input: '8', output: 'YES', id: 1 },
    { input: '3', output: '', id: 2 },
    { input: 123, output: 'ignored', id: 3 },
  ],
});
const problem = cph.parseCphProblem(raw);
check('解析题目名称', problem?.name === 'A. Watermelon', problem?.name);
check('解析测试数量', problem?.tests.length === 2, `${problem?.tests.length} 个`);
check('保留空输出', problem?.tests[1]?.input === '3' && problem?.tests[1]?.output === '');
check('解析源文件', problem?.srcPath === 'C:\\work\\main.cpp');
check('解析分组', problem?.group === 'Codeforces');
check('解析交互标记', problem?.interactive === false);

check('拒绝非法 JSON', cph.parseCphProblem('{') === undefined);
check('兼容 BOM', cph.parseCphProblem('\uFEFF' + raw)?.name === 'A. Watermelon');
check('拒绝空对象', cph.parseCphProblem('{}') === undefined);
check('拒绝 null', cph.parseCphProblem('null') === undefined);
check(
  '无测试但保留题目信息',
  cph.parseCphProblem(JSON.stringify({ name: '本地题', url: '', tests: [] }))?.name === '本地题',
);

console.log('CPH 保存格式');
const sourcePath = 'C:\\work\\main.cpp';
const digest = crypto.createHash('md5').update(sourcePath).digest('hex');
check(
  '文件名与 CPH 一致',
  cph.cphProbFileName(sourcePath) === `.main.cpp_${digest}.prob`,
  cph.cphProbFileName(sourcePath),
);
check(
  '默认保存到源文件旁的 .cph',
  cph.cphProbPath(sourcePath) === path.join('C:\\work', '.cph', `.main.cpp_${digest}.prob`),
  cph.cphProbPath(sourcePath),
);
check(
  '遵循 cph.general.saveLocation',
  cph.cphProbPath(sourcePath, 'D:\\cph-data') ===
    path.join(path.resolve('D:\\cph-data'), `.main.cpp_${digest}.prob`),
  cph.cphProbPath(sourcePath, 'D:\\cph-data'),
);
const savedText = cph.buildCphProblem({
  name: 'A. Watermelon',
  url: 'https://vjudge.net/problem/CodeForces-4A',
  group: 'Codeforces',
  tests: [
    { input: '8', output: 'YES' },
    { input: '3', output: 'NO' },
  ],
  srcPath: sourcePath,
  interactive: false,
});
const saved = JSON.parse(savedText);
check('写入测试数量', saved.tests.length === 2, `${saved.tests.length} 个`);
check('写入测试编号', saved.tests[0].id === 0 && saved.tests[1].id === 1);
check(
  '写入题目与源文件',
  saved.name === 'A. Watermelon' &&
    saved.url === 'https://vjudge.net/problem/CodeForces-4A' &&
    saved.srcPath === sourcePath &&
    saved.group === 'Codeforces',
);
check('写入限制默认值', saved.memoryLimit === 1024 && saved.timeLimit === 3000);
check('写入内容可被解析', cph.parseCphProblem(savedText)?.tests.length === 2);

console.log('VJudge 链接');
const ref = cph.cphProblemRef('https://vjudge.net/problem/CodeForces-4A?foo=bar#x');
check('解析题目 OJ 与编号', ref?.oj === 'CodeForces' && ref?.probNum === '4A', JSON.stringify(ref));
const wwwRef = cph.cphProblemRef('https://www.vjudge.net/problem/%E6%B4%9B%E8%B0%B7-P1000/');
check(
  '解析 www 与编码 OJ',
  wwwRef?.oj === '洛谷' && wwwRef?.probNum === 'P1000',
  JSON.stringify(wwwRef),
);
check('拒绝非 VJudge 链接', cph.cphProblemRef('https://codeforces.com/contest/4/problem/A') === undefined);
check('拒绝比赛链接', cph.cphProblemRef('https://vjudge.net/contest/803029#problem/A') === undefined);
check('拒绝非法链接', cph.cphProblemRef('not-a-url') === undefined);

if (failures > 0) {
  console.log(`\n${failures} 项检查失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部检查通过');
}
