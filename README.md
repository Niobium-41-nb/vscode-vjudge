# VJudge for VS Code

在 VS Code 中完成 VJudge（https://vjudge.net/）的日常刷题流程：搜索题目、阅读题面、新建代码文件、本地测试、提交代码、查看评测结果和提交记录，并支持比赛题目、题单与 CPH 测试数据导入。

## 功能

- 题目搜索：按 OJ、题号、标题、来源检索，支持分页“加载更多”。
- 题面阅读：多份题面切换（官方/翻译）、Markdown 渲染、TeX 子集公式、图片与 PDF 附件下载、在浏览器打开。
- 做题状态：题目旁显示已通过 / 尝试过 / 未做的状态圆点。
- 比赛题目：列出我参与的比赛并按需加载赛题，可直接打开题面或提交。
- 题单（Workbook）：加入/创建/关注的题单浏览、创建题单、追加题目、加入或退出题单。
- 提交与评测：选择语言提交、Turnstile 之外的验证码处理、自动轮询评测结果、展示编译错误等详细信息。
- 提交记录：侧边栏查看最近提交并定时静默刷新，可打开提交代码。
- 本地测试：按题面样例或已导入的 CPH 测试数据运行本地程序并逐样例比对。
- 语言模板：内置常用语言模板，支持全局可编辑模板文件与按语言/扩展名自定义模板。
- CPH 兼容：扫描 `.cph` 目录与 CPH 自定义保存目录，导入 `.prob` 测试数据；新建文件时自动生成 CPH 数据。

## 安装

在扩展视图搜索 “VJudge” 安装，或从 VSIX 安装：

```bash
code --install-extension niobium-41-nb.vjudge
```

## 使用

1. 打开命令面板，执行 `VJudge: 登录`。账号密码登录可能被人机验证拦截时，可使用 `VJudge: 使用 Cookie 登录`：在浏览器登录 VJudge 后复制 `JSESSIONID` 即可。
2. 在活动栏的 VJudge 视图中搜索题目、展开比赛或题单。
3. 打开题面后，可直接提交、新建代码文件或本地测试样例。
4. 提交后自动等待评测结果，失败时可查看详情；结果同时出现在“提交记录”中。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `vjudge.username` | 空 | 用户名，登录成功后自动写入 |
| `vjudge.defaultLanguage` | 空 | 默认提交语言，可填语言名称或代码 |
| `vjudge.solutionsDirectory` | 空 | 新建代码文件目录，留空表示工作区根目录 |
| `vjudge.problemPageSize` | 50 | 题目搜索每页数量 |
| `vjudge.submissionPageSize` | 30 | 提交记录条数 |
| `vjudge.statusRefreshInterval` | 30 | 提交记录自动刷新间隔（秒），0 关闭 |
| `vjudge.requestTimeout` | 20 | HTTP 请求超时（秒） |
| `vjudge.openCodePublicly` | false | 提交时是否公开代码 |
| `vjudge.testTimeout` | 10 | 单个样例的本地运行超时（秒） |
| `vjudge.testCommands` | 内置 cpp/c/py/java/js/go/rs | 文件扩展名到编译运行命令的映射，支持 `{file}`、`{dir}`、`{exe}`、`{in}`、`{out}` |
| `vjudge.languageTemplates` | 空 | 语言到模板文件路径的映射，优先级高于全局模板文件 |

语言模板还可以通过 `VJudge: 编辑语言模板` 命令直接编辑全局模板目录中的文件，保存即生效。

## 隐私与安全

- 密码与 Cookie 只保存在 VS Code 的 SecretStorage 中，不会写入日志、输出通道或配置文件。
- Cookie 只发送给 `vjudge.net` 及其子域，所有请求仅使用 HTTPS。
- 题面 HTML 进入 Webview 前会经过清洗，并启用 CSP 限制脚本执行。
- 除 VJudge 及其题面 CDN 外不发起网络请求，不收集遥测。

## 已知限制

- 密码登录可能被 VJudge 的人机验证（Turnstile）拦截，此时请使用 Cookie 登录。
- Codeforces 等平台要求使用自己在 VJudge 绑定的远程账号提交，请先在 VJudge 的“远程账号”页面完成绑定并保持登录。
- 本地测试只比较标准输出，忽略行尾空白与末尾换行差异。
- 数学公式为 TeX 子集渲染，复杂宏、TikZ 等不被支持。
- CPH 的 custom checker 与交互题 checker 未接入。
- 题单编辑只支持创建与追加题目，删除题目等操作需在浏览器完成。

## 反馈

问题与建议请提交到 GitHub Issues：https://github.com/Niobium-41-nb/vscode-vjudge/issues

## 许可

[MIT](LICENSE)
