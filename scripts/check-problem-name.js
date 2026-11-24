const path = require('path');

const root = path.join(__dirname, '..');
const names = require(path.join(root, 'out', 'problemName.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function ref(fsPath, known) {
  return names.problemRefFromPath(fsPath, known);
}

const work = process.platform === 'win32' ? 'C:\\work' : '/work';

console.log('从文件名识别题目');
let value = ref(path.join(work, 'CodeForces-4A.cpp'));
check('默认命名 OJ-题号', value?.oj === 'CodeForces' && value?.probNum === '4A', JSON.stringify(value));
value = ref(path.join(work, '洛谷-P1000.py'));
check('中文 OJ', value?.oj === '洛谷' && value?.probNum === 'P1000', JSON.stringify(value));
value = ref(path.join(work, '51Nod-1000.cpp'));
check('数字开头的 OJ', value?.oj === '51Nod' && value?.probNum === '1000', JSON.stringify(value));
value = ref(path.join(work, 'CodeForces-1285-A.cpp'));
check('题号含连字符', value?.oj === 'CodeForces' && value?.probNum === '1285-A', JSON.stringify(value));
value = ref(path.join(work, 'e-olymp-101.cpp'), ['e-olymp']);
check('已知 OJ 名称含连字符', value?.oj === 'e-olymp' && value?.probNum === '101', JSON.stringify(value));
value = ref(path.join(work, 'Library-Checker-abc123.cpp'), ['Library Checker']);
check(
  'OJ 空格安全化后还原',
  value?.oj === 'Library Checker' && value?.probNum === 'abc123',
  JSON.stringify(value),
);
value = ref(path.join(work, 'codeforces-4A.cpp'), ['CodeForces']);
check('已知 OJ 恢复大小写', value?.oj === 'CodeForces' && value?.probNum === '4A', JSON.stringify(value));

console.log('Java 目录命名');
value = ref(path.join(work, 'CodeForces-4A', 'Main.java'), ['CodeForces']);
check('上级目录为题号', value?.oj === 'CodeForces' && value?.probNum === '4A', JSON.stringify(value));
value = ref(path.join(work, 'Kattis-hello', 'Main.java'), ['Kattis']);
check('已知 OJ 的目录', value?.oj === 'Kattis' && value?.probNum === 'hello', JSON.stringify(value));
check(
  '普通工程目录不误判',
  ref(path.join(work, 'my-project', 'Main.java')) === undefined,
);
check(
  '未知 OJ 的目录不误判',
  ref(path.join(work, 'lab-3', 'Main.java'), ['CodeForces']) === undefined,
);

console.log('拒绝无法识别的文件名');
check('无连字符', ref(path.join(work, 'solution.cpp')) === undefined);
check('日期样式', ref(path.join(work, '2024-11-24.md')) === undefined);
check('隐藏文件', ref(path.join(work, '.main_hash.prob')) === undefined);
check('题号含空格', ref(path.join(work, 'CodeForces-4 A.cpp')) === undefined);

if (failures > 0) {
  console.log(`\n${failures} 项检查失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部检查通过');
}