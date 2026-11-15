const path = require('path');

const root = path.join(__dirname, '..');
const templates = require(path.join(root, 'out', 'templates.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  失败 ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

console.log('语言模板设置');
const settings = {
  'GNU G++17': 'C:/templates/main.cpp',
  '.Py': 'templates/main.py',
  ' main.cpp ': ' C:/templates/other.cpp ',
};
check(
  '按语言名称匹配',
  templates.templateSettingValue(settings, ['GNU G++17', 'cpp']) === 'C:/templates/main.cpp',
);
check(
  '扩展名忽略大小写与前导点',
  templates.templateSettingValue(settings, ['PY']) === 'templates/main.py',
);
check(
  '候选键按顺序优先',
  templates.templateSettingValue(settings, ['Java', 'main.cpp']) === 'C:/templates/other.cpp',
);
check('未配置返回空', templates.templateSettingValue(settings, ['rs', 'rust']) === undefined);
check('空值被忽略', templates.templateSettingValue({ cpp: '   ' }, ['cpp']) === undefined);

console.log('模板占位符');
check(
  '替换题目信息',
  templates.applyTemplateVariables('// ${title} ${oj}-${probNum} // ${title}', {
    title: 'A. Watermelon',
    oj: 'CodeForces',
    probNum: '4A',
  }) === '// A. Watermelon CodeForces-4A // A. Watermelon',
);
check('无占位符保持原样', templates.applyTemplateVariables('#include <bits/stdc++.h>\n', { title: 'x', oj: 'y', probNum: 'z' }) === '#include <bits/stdc++.h>\n');

console.log('内置模板');
const cpp = templates.buildCodeTemplate('GNU G++17', 'A. Watermelon');
check('识别 C++', cpp.recognized && cpp.extension === 'cpp');
check('内置模板带标题注释', cpp.content.startsWith('// A. Watermelon'));
check('未知语言需要手动扩展名', !templates.buildCodeTemplate('Weird Lang', 'x').recognized);

console.log('全局模板文件');
const files = templates.builtinTemplateFiles();
const extensions = files.map((file) => file.extension);
check('覆盖常见语言', ['cpp', 'c', 'py', 'java', 'go', 'rs', 'js', 'ts'].every((ext) => extensions.includes(ext)));
check('扩展名不重复', new Set(extensions).size === extensions.length, `${extensions.length} 个文件`);
check('不含兜底 txt', !extensions.includes('txt'));
check('文件内容保留标题占位符', files.every((file) => file.content.includes('${title}')));
check(
  'Java 模板文件名为 Main.java',
  files.find((file) => file.extension === 'java')?.fileName === 'Main.java',
);
check(
  'Python 标题注释使用井号',
  files.find((file) => file.extension === 'py')?.content.startsWith('# ${title}'),
);
check(
  '空模板也有标题占位符',
  templates.builtinTemplateFiles().find((file) => file.extension === 'scala')?.content === '// ${title}\n',
);
const rendered = templates.applyTemplateVariables(
  files.find((file) => file.extension === 'cpp')?.content ?? '',
  { title: 'A. Watermelon', oj: 'CodeForces', probNum: '4A' },
);
check('全局模板可替换题目信息', rendered.startsWith('// A. Watermelon') && rendered.includes('int main()'));

if (failures > 0) {
  console.log(`\n${failures} 项检查失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部检查通过');
}
