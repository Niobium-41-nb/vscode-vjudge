# AGENTS.md — VJudge VS Code 插件开发指南

面向后续接手本项目的 agent。先读本文，再改代码；本文描述的是**当前实现**，不是设想。

## 1. 项目概览

- 目标：在 VS Code 中完成 VJudge（https://vjudge.net/）的题目浏览/搜索、题面阅读、代码提交、评测轮询、提交记录、比赛题目、题单（workbook）和本地样例测试。
- 技术栈：TypeScript + VS Code Extension API，CommonJS 输出到 `out/`，入口 `out/extension.js`。
- 运行时零第三方依赖；只用 Node 内置模块（`https`、`child_process`、`fs`、`crypto` 等）。
- 当前版本 `0.2.5`，产物 `vjudge-0.2.5.vsix`（不纳入版本控制）。
- 所有界面文案、错误提示、注释使用中文；不要引入 emoji。

## 2. 常用命令

```bash
npm install            # 只安装 devDependencies（typescript、@types/*）
npm run compile        # tsc -p ./，输出到 out/
npm run watch          # 增量编译
npm run check:parsers  # 用真实页面 fixture 验证解析器（见第 12 节）
npm run package        # npx @vscode/vsce package --no-dependencies，生成 VSIX
```

调试：在 VS Code 打开本目录，按 F5（`.vscode/launch.json`，preLaunchTask 会自动 compile）。
扩展开发宿主中登录真实账号后才能完整手动验证。

## 3. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | `ExtensionController`：创建 Session、四个 TreeView、题面面板、状态栏、命令；监听登录/配置变化；统一 dispose |
| `src/commands.ts` | 全部命令编排：搜索、打开题面、新建文件、提交、验证码、轮询、查看提交、浏览器打开、复制链接、样例测试、题单搜索/创建/加入退出/添加题目 |
| `src/session.ts` | 登录状态机、SecretStorage、自动恢复登录、用户名维护、做题状态缓存、`describeError` |
| `src/api/client.ts` | VJudge HTTP 客户端：Cookie 容器、重定向、各接口、响应归一化、登录态判定 |
| `src/api/http.ts` | 裸 `https.request`，只允许 HTTPS；收集 body/headers/set-cookie；超时 |
| `src/api/parser.ts` | 比赛页/题目页/题面页解析、样例提取、HTML 清洗、实体解码 |
| `src/api/markdown.ts` | VJudge 题面的零依赖 Markdown 子集渲染（`format: MD`）；公式原样保留 |
| `src/api/errors.ts` | `VJudgeError`（kind: normal/login/captcha）、i18n key 提取与中文翻译 |
| `src/api/types.ts` | 全部数据模型；核心是 `ProblemRef` |
| `src/statementCache.ts` | 题面 5 分钟缓存 + 并发去重；`statementKey`/`problemUrl` |
| `src/problemFiles.ts` | 题目与本地文件的映射（**仅内存**） |
| `src/cphFormat.ts` | CPH `.prob` JSON 解析与生成、保存路径/文件名、VJudge 链接 → `ProblemRef` |
| `src/cph.ts` | 扫描 `.cph`/自定义保存目录、用题面样例生成 `.prob`、持久化 CPH 题目路径、按源文件匹配 |
| `src/templates.ts` | OJ 语言名 → 文件扩展名/代码模板；自定义模板键匹配与占位符替换；内置全局模板文件清单；文件名安全化 |
| `src/globalTemplates.ts` | 在扩展全局存储目录创建/读取可编辑的语言模板文件 |
| `src/fileTransfer.ts` | 题面附件的 HTTPS 流式下载、保存对话框、进度与取消、`revealFileInOS` |
| `src/sampleRunner.ts` | 本地编译/运行、逐样例比较、超时杀进程树、输出日志 |
| `src/views/problems.ts` | 题目搜索分页 TreeDataProvider |
| `src/views/contests.ts` | 我的比赛及按需加载赛题 |
| `src/views/workbooks.ts` | 题单四个分类（加入/创建/关注/公开）、分页加载、按需加载题单题目 |
| `src/views/submissions.ts` | 提交记录 + 定时静默刷新 |
| `src/views/items.ts` | 各类 TreeItem 构造（图标、tooltip、命令、contextValue） |
| `src/views/statementPanel.ts` | 单例题面 Webview：工具栏、样例、复制、链接拦截、CSP |
| `src/utils.ts` | 时间/内存/运行时间格式化、状态图标、配置读取 |
| `scripts/check-parsers.js` | 解析器回归检查（读取 out/ 与 fixture） |
| `resources/` | 图标（活动栏、绿/红/灰状态） |

## 4. 运行时结构

```text
VS Code UI（TreeView / Webview / Notification / StatusBar）
        │
   commands.ts  ──────────────┐
        │                     │
        ├── views/* providers │  数据加载、状态、刷新
        ├── statementPanel    │  HTML 渲染与消息协议
        ├── sampleRunner      │  本地进程执行
        ├── statementCache    │  缓存（5 分钟，按题目+比赛去重）
        ├── problemFiles      │  ref ⇄ 文件（内存）
        ├── templates         │  语言映射与内置模板
        └── globalTemplates   │  全局可编辑模板文件
        │
     session.ts ── VJudgeClient ── http.ts / parser.ts / errors.ts
        │
   SecretStorage + globalState + workspace configuration
```

关键设计：

- **`ProblemRef` 是全局通行证**。`oj + probNum` 必填；存在 `contestId` 时表示比赛上下文，`contestNum` 是比赛内题号（用于提交路径和 URL），`languages/descBriefs/enabledDescKeys` 可避免额外请求。
- 比赛题目**不走** `/problem/{oj}-{probNum}`（该页要求登录且可能改变比赛上下文），而是直接用比赛页 JSON 里的 `descBriefs` 拉公开题面。
- 所有 TreeView 在未登录时返回空数组；登录状态变化由 `extension.ts` 统一触发刷新、清空题面缓存并重新加载提交记录。
- 只有 `vjudge.requestTimeout` 与 `vjudge.statusRefreshInterval` 支持热更新；其余配置按使用时机读取。

## 5. 核心数据模型（`src/api/types.ts`）

- `ProblemRef`：`oj`、`probNum`、`title?`、`source?`、`problemId?`、`contestId?`、`contestNum?`、`languages?`（code→显示名）、`descBriefs?`、`enabledDescKeys?`、`properties?`、`solvedState?`。`solvedState` 取值：`1` 已通过、`0` 尝试过但未通过、`-1` 未做（当前账号无提交）、`undefined` 状态未知（未登录、拉取失败或尚未加载）。
- `SolveRecords`：`{ accepted: Set<string>; attempted: Set<string> }`，键由 `solveStatusKey(oj, probNum)` 生成（小写并去掉空格/下划线/连字符）。
- `DescriptionBrief`：`key`（描述 ID）、`version`（时间戳），可带 `author/lang/type`。
- `Statement`：`oj/probNum/title/html/samples/languages`。
- `Sample`：`{ input, output }`，均为纯文本。
- `SubmissionSummary`：状态列表行；`Solution`：单次评测详情（含 `code`/`source`/`additionalInfo`，索引签名允许额外字段）。
- `ContestDetail.problems[].num` 是**比赛内题号**，映射为 `ProblemRef.contestNum`；`pid` 映射为 `problemId`。
- `WorkbookCategory`：`joined | created | followed | all`；`WorkbookSummary` 是列表行；`WorkbookDetail` 额外保留 `content`（原始正文，含 `[problem:...]` 标记）与 `nodeId`（更新时必须回传）；`WorkbookDetail.problems` 是 `ProblemRef[]`（题单题目不带比赛上下文）。`WorkbookInput` 用于创建/更新题单：`title/content/openness/nodeId?`。

## 6. VJudge 接口契约（已按线上行为验证，可能随站点改版变化）

全部走 `https://vjudge.net`；除登录外默认带 `X-Requested-With: XMLHttpRequest`（HTML 页面显式 `ajax:false`）。`Accept-Encoding: identity`，客户端**没有解压逻辑**，不要贸然开启 gzip。HTTP 层使用 `keepAlive:false` 的专用 Agent：VJudge 会主动关闭空闲连接，复用套接字时容易出现 `ECONNRESET`。所有 GET 请求默认最多重试 2 次（间隔 300ms），`checkLogInStatus` 这类幂等 POST 也显式重试；提交等非幂等 POST 不自动重试。

| 方法/路径 | 说明 | 关键点 |
| --- | --- | --- |
| `POST /user/login` | 表单 `username,password,token=''` | 成功返回文本 `success`；失败可能是 JSON（`i18nKey`）或 403；Turnstile 可能拦截 |
| `POST /user/checkLogInStatus` | 返回 `true`/`false` | 用于恢复 Cookie 登录 |
| `POST /user/logout` | 注销 | 失败也继续清本地 Cookie |
| `GET /`（登录后主页） | HTML | `getUsername()` 从页面里的 `/user/{name}` 链接提取当前用户名；`/user/`（带斜杠）线上返回 404，不能用于识别用户名 |
| `GET /problem/data` | 题目搜索 DataTables | 参数 `draw,start,length,OJId,probNum,title,source,category=all,sortCol=7,sortDir=desc`；行是对象；未登录会返回 `data:[]` + `recordsTotal:9999999` |
| `GET /contest/data` | 比赛列表 | `category=mine/all`；行是**数组**：`[id,title,type,begin,end,openness,contestants,managerName,groupName,groupShortName,isFav,avatar]` |
| `GET /contest/{id}` | 比赛详情 HTML | `<textarea>` 内 JSON，`problems[]` 含 `pid,oj,probNum,num,title,languages,descBriefs,enabledDescKeys,properties`；公开比赛可匿名访问 |
| `GET /problem/{oj}-{probNum}` | 题目详情 HTML | **通常要求登录**（重定向含 `login=1`）；解析 title/languages/descriptions |
| `GET /problem/description/{key}?{version}` | 题面 HTML | 公开题面可匿名；版本号直接拼在 `?` 后，可省略；正常页面可能内联 Cloudflare 探测脚本 |
| `POST /problem/submit/{oj}-{probNum}` 或 `/contest/submit/{contestId}/{num}` | 提交 | 表单 `method=0,language,open=0/1,source=源码原文,captcha,password=''`（`source` 直接传原文，仅由表单做 URL 编码；2026-11 起网页端不再 base64 编码，传 base64 会被当成源码导致 CE）；`method=1` 时额外带 `bindingId`（使用自己绑定的远程 OJ 账号）；提交方式以题目/比赛 JSON 的 `submitMethods` 为准（数组顺序为默认通道、个人账号、归档），Codeforces 等平台返回 `[false,true,true]`，插件据此直接走个人账号；仍收到 `submit_method_not_allowed` 时回退重试；相同代码重复提交返回 `submit.error.duplicate_code`（“这份代码之前已经提交过。”）；返回 `{runId}`、`{captcha:true}` 或错误 |
| `GET /user/remoteAccounts/list?oj=CF` | 远程 OJ 账号列表 | 返回 `{groups:{<OJ>:{bindings:[{id,accountId,accountDisplay,runtimeStatus,healthStatus,statusReason,...}]}}}`；按 `oj` 过滤，客户端优先取同名 group，否则合并全部 group；只有 `runtimeStatus=READY` 的绑定可提交；未登录返回 `{"errorKey":"user.remote_accounts.error.login_required"}` |
| `GET /util/captcha?{timestamp}` | 验证码图片 | 需要登录；必须校验 `Content-Type: image/*`（未登录会返回 HTML） |
| `GET /solution/data/{runId}` | 评测详情 JSON | 含 `status,statusType,processing,runtime,memory,additionalInfo,code/source` |
| `GET /status/data` | 提交列表 DataTables | 参数 `draw,start,length,un,OJId,probNum,res,language,onlyFollowee`；行是对象（`runId,status,statusType,processing,oj,probNum,time,language,...`）；`oj` 是显示名（如“洛谷”） |
| `GET /user/solveDetail/{username}` | 做题状态 JSON | `{acRecords, failRecords}`，按 OJ 显示名分组，值为题号数组；实测可匿名请求。客户端归一化为 `Set<string>`，用于标记已通过/尝试过/未做 |
| `GET /workbook/data` | 题单列表 DataTables | 参数 `draw,start,length,title,category(all/joined/created/followed),author`；行是对象（`id,title,problemCount,joinedUsers,activeUsers,viewCnt,author,openness,updateTime`）；`recordsTotal/recordsFiltered` 恒为哨兵 `9999999`，不能当真实总数 |
| `GET /article/{id}` | 题单详情 HTML | `<textarea name="dataJson">` 内 JSON：`isWorkbook`、`id/title/author/openness/content`、`workbook.joined`、`workbook.problemsBrief`（**JSON 字符串**，键为 `"OJ-probNum"`，值为 `[title, solvedUsers, sourceHtml, ...]`）；公开题单可匿名访问 |
| `POST /workbook/join/{id}` / `POST /workbook/leave/{id}` | 加入/退出题单 | 需要登录；成功可能返回空体，失败可能是 `{error}`/i18n |
| `POST /article/create` / `POST /article/{id}/update` | 创建/保存题单 | 表单 `title`、`content`、`openness`、`nodeId`（已有题单传详情中的 `nodeId`，新建传 0）；`content` 中的 `[problem:OJ-probNum]` 标记决定题单包含的题目；未登录返回 200 JSON `article.error.login_required`，无权限返回 `article.error.update_forbidden`；成功后可能返回 `{id}`、`success:true` 或重定向到 `/article/{id}` |

状态语义：`statusType === 0` 通过；`1` 失败；`2` 或 `processing === true` 表示评测中。
比赛 `type`：0 标准、1 练习、2 回放（`utils.contestTypeLabel`）。
题单 `openness`：0 私密、1 不公开、2 公开（`utils.workbookOpennessLabel`）。

防御性约定：

- 匿名/受限响应的 `recordsTotal` 常见哨兵值 `9999999`。搜索接口在“0 行 + 该值”时抛 `kind:'login'`；题单列表只在该值小于 `9999999` 时才作为总数；比赛/提交列表不使用该 total。
- 响应字段可能有多套命名，客户端已兼容 `originOJ/originProb`、`oj/probNum`、`id/problemId` 等；新增解析时保持宽松。
- 登录失效可能表现为重定向 `?login=1`、HTML 页面或 `i18nKey`，统一抛 `VJudgeError.kind='login'`，命令层由 `reportError` 提供“重新登录”。

## 7. 关键流程

### 7.1 登录与会话恢复（`src/session.ts`）

1. `initialize()`：读取 globalState/配置中的用户名（`404`、`user` 等无效值会被丢弃）→ 导入 SecretStorage Cookie → `checkLogInStatus`；Cookie 有效时再请求登录后主页校正用户名（避免沿用错误的缓存名）。
2. Cookie 无效时，若存在已保存的用户名+密码则自动登录；失败只记录日志。
3. 登录成功后：用户名写入 globalState 与 `vjudge.username` 配置，密码写入 SecretStorage，Cookie 持久化，触发 `vjudge.loggedIn` 上下文与 `onDidChangeLogin`。
4. Cookie 登录：清空现有 Cookie → 导入用户粘贴串（支持 `JSESSIONID=...; ...` 或裸 JSESSIONID）→ 验证 → **优先使用服务端自动识别到的用户名**，识别失败才用输入值。
5. 注销：请求服务端注销、清 Cookie、删密码/用户名、更新上下文。
6. `ensureLoggedIn()` 在命令入口兜底：Cookie 可用则静默恢复，否则弹“用户名密码登录 / 使用 Cookie 登录”；取消则抛错。
7. `getUsername()` 先请求登录后主页，从 `/user/{name}` 链接取用户名；再退回 `/user/` 的 finalUrl/标题。`404`、`Not Found`、`login` 等候选一律拒绝，`setUsername()` 也会做同样清洗，避免把错误页当成用户名。

### 7.2 题面获取与缓存（`statementCache.ts` + `client.getStatement`）

1. 优先使用 `ProblemRef.descBriefs`（若给了 `enabledDescKeys` 则过滤；过滤后为空则回退全部 briefs）。引用按 `official` 与 `en` 语言排序（官方英文优先），默认尝试前 5 个；用户在题面列表中点选后只请求该描述。
2. 仅当题面引用或标题缺失时，才请求 `/problem/{oj}-{probNum}` 补全（该步通常需要登录）；**语言列表为空不再触发该请求**。已有引用时补全失败只忽略标题/语言，不阻断题面。
3. 逐个请求描述页，`parseDescriptionPage` 解析 `<textarea>` JSON sections；失败继续下一个；全部失败抛最后一个错误。题面版本号允许为 0（URL 不带 `?version`）。
4. 单题页的静态 HTML 通常只有空壳，题面引用在 `<textarea name="dataJson">` 的 `descBriefs`（条目含 `key/version/official/author/lang/langDisplay/type/updateDate/remarks`）；解析器会合并 dataJson、任意带 `data-key/data-version` 的元素、`/problem/description/{id}` iframe 或链接，保留元数据并排序。`enabledDescKeys` 只作为无 briefs 时的兜底。
5. 题面/题目页会识别真正的 Cloudflare 验证页（`Just a moment...`、`_cf_chl_opt` 等）；正常页面内联的 `__CF$cv$params` 探测脚本不会误判。
6. `buildStatement` 清洗 HTML 并再次提取样例；解析器已提取到样例时以其为准。清洗时把 VJudge 题面占位符 `CDN_BASE_URL/` 替换为 `https://cdn.vjudge.net.cn/`（网页端由前端脚本完成，扩展必须自行替换，否则 Webview 会把占位符当相对路径导致图片不显示）。
7. 缓存键 = `oj-probNum[@contestId/contestNum]#描述ID`（小写），TTL 5 分钟，并发请求合并；切换题面复用同一缓存，登录变化/注销时清空。
8. 题面 Webview 渲染前**再清洗一次**；若已有独立样例区，移除正文中的 `vjudge_sample`/`sample-test` 表格，避免重复。
9. 题面 Webview 顶部渲染“题面列表（N）”，显示作者、官方标记、语言与更新日期，点击通过 `{type:'description', id}` 切换；当前描述高亮。加载失败时列表仍可用，同时保留“在浏览器打开 / 复制题目链接 / 刷新题面”。
10. 数学公式由 Webview 内置的 TeX 子集渲染器处理（`\(...\)`、`\[...\]`、`$...$`、`$$...$$`），支持常用符号、上下标、分式、根号、`\sum`/`\int`、`\text`、`cases` 等环境；不引入 KaTeX/MathJax，不联网。正文跳过 `script/style/textarea/.samples/.mj`；`pre`/`code` 内只识别显式 `\(...\)`、`\[...\]`，不解析 `$`，避免误伤代码与 shell 变量。渲染后的节点加 `.mj` 防止重复处理。新增符号改 `statementPanel.ts` 的 `SYMBOLS` 或 `parseCommand`。Codeforces 题面用 `$$$...$$$`（行内）和 `$$$$$$...$$$$$$`（行间）作定界符，`sanitizeStatementHtml` 会先把它们归一化成 `\(...\)` / `\[...\]`（跳过 `pre`/`code` 段），Webview 不直接处理三重美元符号；否则 `$$` 会被误判成行间公式，把正文切碎并吞掉词间空格。
11. 描述的每个 section 带 `value.format`（线上常见 `MD` 与 `HTML`）。`parseDescriptionPage` 对 `MD` 调用 `markdown.ts#renderMarkdown` 转成 HTML，`HTML` 原样保留；转换发生在样例提取之前，因此 Markdown 中的 `vjudge_sample` 原始表格与代码块都能正常解析。Markdown 渲染器是零依赖子集实现，支持标题、粗斜体、删除线、行内代码、围栏代码块、有序/无序列表与嵌套、引用、分隔线、GFM 表格、链接/图片、原始 HTML 块；公式 `$...$`/`$$...$$`（以及 Codeforces 的 `$$$...$$$`/`$$$$$$...$$$$$$`）原样输出给 Webview 渲染，行内代码与代码块内的内容只转义不解析。输出仍是未净化 HTML，最终必须经过 `sanitizeStatementHtml`。
12. 题面附件使用 VJudge 前端同款标记 `[pdf:CDN_BASE_URL/hash?N]`。`sanitizeStatementHtml` 在清洗前把所有 `[pdf:...]` 转为文件卡片（`.vj-file`），`data-vj-url` 保存解析后的绝对地址、`data-vj-index` 记录顺序；`CDN_BASE_URL/`、`//host`、`/path` 分别补全为 CDN、HTTPS、`https://vjudge.net`，非 HTTP(S) 地址原样保留不生成卡片。Webview 点击按钮发送 `{type:'file', action, url, index}`：`preview` 走原有的链接白名单后用系统浏览器打开（浏览器内预览 PDF），`download` 调用 `fileTransfer.downloadStatementFile`，默认文件名为“题目标题-附件N.pdf”。下载只允许 HTTPS、不携带 Cookie、上限 50 MB、30 秒超时、最多 3 次重定向，`text/html` 响应视为失败；写入前弹出保存对话框，完成后可“在文件管理器中显示”。

### 7.3 提交与轮询（`commands.submitProblem` / `pollSolution`）

1. `resolveProblem`：直接参数 → 已映射文件 → 最近题目 QuickPick。
2. 取当前编辑器/映射文件，保存脏文件，代码不能为空。
3. 语言：`ProblemRef.languages` 或题面缓存；仍为空时 `languageForProblem` 再尝试一次题目详情页；QuickPick 记忆在 globalState `vjudge.lastLanguage`，优先于 `vjudge.defaultLanguage`；无列表时允许手输（默认 `GNU G++17`）。
4. 提交循环最多 3 次，遇 `CaptchaRequiredError` 弹验证码 Webview（可刷新/取消）；`open` 取 `vjudge.openCodePublicly`。
5. 提交方式以题目/比赛 JSON 的 `submitMethods`（`[默认通道, 个人账号, 归档]`）为准：`submitMethods[0] !== true`（Codeforces 为 `[false,true,true]`）或 globalState `vjudge.remoteRequired.<oj>` 为真时，直接 `method=1` 并带 `bindingId`，不再先发必被拒绝的 `method=0`（同一份源码先失败一次可能被服务端记为重复提交，随后报 `duplicate_code`）；只有仍返回 `submit_method_not_allowed` 时才回退重试。`bindingId` 来自 `/user/remoteAccounts/list` 中 `runtimeStatus=READY` 的绑定：只有一个时直接使用，多个时 QuickPick（按 OJ 记忆上次选择，globalState `vjudge.remoteAccount.<oj>`），没有可用绑定时提示到 `/user/remoteAccounts?oj=<oj>` 绑定账号。
6. 成功后每 1.2 秒轮询 `/solution/data/{runId}`，最长 5 分钟；非 `processing` 且 `statusType !== 2` 即结束。
7. 结果：通过弹信息；失败可“查看详情”（`additionalInfo` 经 `sanitizeStatementHtml` 后放入禁用脚本的 Webview）；无论结果如何都刷新提交列表。

### 7.4 查看提交（`commands.showSubmission`）

- 轮询拿到 `Solution` 后，`decodeCode` 先取 `code` 原文；否则把 `source` 当 Base64 解码，并在出现 `%XX` 时尝试 `decodeURIComponent`。
- 有代码则用对应语言 ID 打开 untitled 文档；有 `additionalInfo` 则并排打开详情；两者都没有时提示可能未公开代码。

### 7.5 本地样例测试（`sampleRunner.runSamples`）

1. 从题面取样例时需要登录；已导入的 CPH 测试不联网。解析目标文件：映射文件优先，否则当前编辑器。
2. 保存文件；按扩展名（小写、无点）查 `vjudge.testCommands`；缺失时提供“打开设置”。
3. 当前文件存在已导入 CPH 测试且题目不冲突时，优先运行 CPH 测试；否则从题面缓存取样例，无样例直接提示。
4. 每个样例写入临时目录 `vjudge-tests-*`，替换占位符并**自动加引号**：`{file}/{dir}/{exe}/{in}/{out}`。
5. `spawn(command, { shell:true, cwd:源码目录, env: UTF-8 })`，stdin 喂样例输入，stdout/stderr 各限制 1 MB。
6. 超时（`vjudge.testTimeout`，默认 10s）用 `taskkill /T /F`（Windows）或 `SIGKILL` 杀进程树。
7. 比较前归一化：CRLF→LF、逐行去行尾空白、去末尾多余换行；通过需退出码 0 且输出完全一致。
8. 结果写入 “VJudge” 输出通道；失败打印输入/期望/实际/stderr；临时目录 finally 删除。

注意：比较只使用 stdout；配置命令若把答案写入 `{out}` 不会自动读取。

### 7.6 导入 CPH 测试数据（`commands.importCph` + `cph.ts`）

1. 扫描所有工作区中的 `.cph` 目录，以及 CPH 配置 `cph.general.saveLocation` 指向目录中的 `*.prob`。
2. CPH 保存格式为 `.cph/.<源文件名>_<md5>.prob`，JSON 含 `name/url/group/tests/srcPath/interactive`；测试项为 `{input,output,id}`。
3. QuickPick 支持多选；导入时只持久化 `.prob` 文件路径到 `workspaceState` 的 `vjudge.cphFiles`，不复制测试数据。
4. URL 为 `https://vjudge.net/problem/{oj}-{probNum}` 时，建立 `ProblemRef` 与 `srcPath` 的文件映射并加入最近题目；其他 URL 只导入测试。
5. 运行“本地测试样例”时按当前文件匹配 CPH 记录（同一源文件有多条时取最新修改的一条），无需重新导入。
6. 新建代码文件（`newFile`，含文件已存在的情况）后先按题目 URL 查找现有 CPH 数据；找不到时从题面缓存取样例，按 CPH 格式写入 `.prob`，再打开文件。写入发生在打开之前，确保 CPH 的编辑器切换事件能立即读到测试数据。
7. `.prob` 位置与命名完全对齐 CPH：默认 `<源文件目录>/.cph/.<源文件名>_<md5(源文件绝对路径)>.prob`；配置了 `cph.general.saveLocation` 时写入该目录。已有测试的 `.prob` 不会被覆盖；写入后清空扫描缓存并建立文件关联（`workspaceState` 的 `vjudge.cphSources`）。
8. 关联查找顺序：`vjudge.cphSources` 的文件映射 → `.prob` 的 `srcPath` → 题目 URL；因此 CPH 记录的 `srcPath` 指向其他文件时，新建的文件仍能直接运行其中的测试。扫描结果缓存 15 秒，手动“导入 CPH 测试数据”会强制重新扫描。

### 7.7 题单（`views/workbooks.ts` + `client.listWorkbooks/getWorkbookDetail`）

1. 根节点固定四个分类：`joined`（我加入的）、`created`（我创建的）、`followed`（我关注的）、`all`（公开题单）；未登录返回空数组。
2. 分类**首次展开时**才请求 `/workbook/data`（每页 50 条），之后展开只读缓存；“加载更多”按 `start=已加载条数` 追加，并按题单 id 去重。
3. 分类状态（items/total/hasMore/loaded/loading/error）按分类隔离；`refresh()`/`search()` 会重建状态并清空题单详情缓存，旧请求回来后用 `states.get(category) !== state` 丢弃。
4. “搜索题单”只过滤公开题单（`category=all`），关键字存在 provider 的 `searchTitle` 中，分类标题变为“公开题单：关键字”；空结果显示专用提示。
5. 展开题单时请求 `/article/{id}`，`parseWorkbookDetail` 先按 `content` 中 `[problem:OJ-probNum]` 的出现顺序生成题目，再追加只存在于 `problemsBrief` 的键；结果缓存为 `ProblemRef[]`，失败信息也缓存。
6. 题单题目直接复用 `createProblemItem`，因此打开题面、提交、新建文件、样例测试全部沿用现有命令，无需比赛上下文。
7. “加入/退出题单”先取详情得到 `joined` 再确认；调用 join/leave 后 `session.persistCookies()` 并 `workbooks.refresh()`。
8. 题单详情链接是 `https://vjudge.net/article/{id}`（不是 `/workbook/{id}`）；浏览器打开、复制链接都用该地址。
9. 创建题单：`vjudge.createWorkbook` 依次询问标题、可见性（公开/不公开/私密）和题目列表；题目按 `OJ-题号` 解析（支持空格、中英文逗号、分号、换行，自动去重），追加为 `[problem:OJ-probNum]` 标记后调用 `client.createWorkbook`。
10. 添加题目：`vjudge.addToWorkbook` 在题目节点上使用时把该题加入用户创建的某个题单（QuickPick 选择）；在题单节点上使用时输入一批题目。两者都会先取详情，按 `oj/probNum` 不区分大小写去重，确认后把新标记追加到 `detail.content`，并原样回传 `title/openness/nodeId` 调 `client.updateWorkbook`。若更新请求报错，会重新拉取详情确认题目是否已写入，避免“服务端已成功但连接中断”导致的误报。
11. 创建/更新成功后都 `session.persistCookies()`、刷新题单视图；更新不会删除或重排已有题目，只追加。私密（openness=0）题单可能不出现在“我创建的”列表中，创建提示会提醒用户通过“在浏览器打开”保留入口。

### 7.8 题目做题状态（`session.prefetchSolveStates` + `client.getUserSolveRecords`）

1. 登录后首次加载题目、展开比赛或题单时，`session` 请求 `/user/solveDetail/{username}`，把 `acRecords/failRecords` 归一化为 `SolveRecords` 缓存 5 分钟。
2. provider **不等待**状态接口：先 `applyCachedSolveStates(refs)` 用已有缓存标注，再 `void prefetchSolveStates()` 后台拉取，因此列表能立即显示。缓存命中时命中 `accepted` 写 `1`、命中 `attempted` 写 `0`、两者都未命中写 `-1`；未登录或拉取失败保持 `undefined`。
3. 状态拉取成功后 `session` 触发 `onDidChangeSolveStates`，`extension.ts` 调用三个 provider 的 `refreshSolveStates()` 重绘已加载节点；搜索、比赛、题单三条路径都复用 `createProblemItem` 的绿/红/灰圆点与“已通过 / 尝试过 / 未做”文案。
4. 做题状态接口失败只写输出日志，不阻塞题目/题单加载；同一账号失败后 60 秒内不重试，避免每次展开都等待超时。
5. 提交完成（且已终评）后 `session.noteSubmissionResult(ref, statusType)` 直接更新缓存，并调用同样三个 `refreshSolveStates()`，无需重新请求列表。
6. 登录、Cookie 登录、切换用户名、注销都会清空状态缓存；缓存过期后下一次加载重新拉取。

### 7.9 新建代码文件与语言模板（`commands.newFile`）

1. `resolveProblem` → `ensureLogin` → `languageForProblem` → `pickLanguage`，得到提交语言代码与显示名；标题取 `ref.title`，缺失时用 `oj-probNum`。
2. `buildCodeTemplate(displayName, title)` 决定扩展名/文件名（Java 固定 `Main.java`）和内置模板内容。
3. 模板内容查找顺序：`vjudge.languageTemplates` 显式配置 → 全局模板目录中的同名文件 → 内置模板。配置候选键依次为语言显示名、扩展名、带点扩展名；值按绝对路径或相对首个工作区根目录解析。命中文件时**完整替换**内置内容，不再自动加题目注释；读取 UTF-8（去 BOM）并替换 `${title}/${oj}/${probNum}`。
4. 全局模板目录为 `<globalStorage>/templates`（`context.globalStorageUri`）。激活时创建目录，并为 `templates.ts` 中所有唯一扩展名写入缺失的模板文件；已存在的文件绝不覆盖，用户修改会一直保留。Java 文件名为 `Main.java`，其余为 `main.<扩展名>`。每个文件预置 `${title}` 占位符，空模板也至少有标题注释。
5. “VJudge: 编辑语言模板”命令会先补齐缺失文件，再列出所有模板（含“打开模板目录”），选中后直接用 VS Code 编辑；保存即生效，无需重新加载窗口。
6. 无法识别的语言会询问扩展名，再用该扩展名重复一次模板查找。
7. 文件目录由 `vjudge.solutionsDirectory` 决定；写入后记录题目↔文件映射，先自动导入 CPH 测试数据，再打开文件，保证 CPH 能立即读到 `.prob`。

## 8. 安全与隐私（修改时不可破坏）

- **密码与 Cookie 只能进 `SecretStorage`**（键：`vjudge.password`、`vjudge.cookies`）；不得写入日志、输出通道、globalState 或配置。
- `describeError` 只输出 message；新增日志时不要打印请求表单或 Cookie。
- Cookie 只发送给 `vjudge.net` 及其子域；不要放宽到所有主机。HTTP 层只允许 `https:`。
- 服务端 HTML 必须经过 `sanitizeStatementHtml` 才能进入 Webview；Webview 必须保留 CSP nonce 方案，不得加 `unsafe-eval`。
- 题面链接只允许 `http/https`（客户端脚本与服务端 `openLink` 双重校验）；`javascript:` 一律拒绝。
- 题面附件下载与 `vjudge.net` 的 API 会话完全隔离：只接受 HTTPS，不带 Cookie/鉴权头，不写入固定目录（必须经保存对话框），`text/html` 响应按失败处理。
- 本地测试会执行工作区代码，因此 `package.json` 明确 `untrustedWorkspaces.supported = false`；不要移除。
- 不引入遥测；除 VJudge 外不发起网络请求。

## 9. 配置、状态与上下文键

| 位置 | 键 | 说明 |
| --- | --- | --- |
| 配置 | `vjudge.username` | 用户名，登录后自动写入 |
| 配置 | `vjudge.defaultLanguage` | 提交语言默认值（名称或代码） |
| 配置 | `vjudge.solutionsDirectory` | 新建文件目录；绝对路径或相对首个工作区 |
| 配置 | `vjudge.problemPageSize` | 搜索每页数量（代码内再取 `max(10, …)`） |
| 配置 | `vjudge.submissionPageSize` | 提交条数（代码内 `max(5, …)`） |
| 配置 | `vjudge.statusRefreshInterval` | 自动刷新秒数，0 关闭，最小实际 5s |
| 配置 | `vjudge.requestTimeout` | HTTP 超时秒数，最小 5s，支持热更新 |
| 配置 | `vjudge.openCodePublicly` | 提交时是否公开代码 |
| 配置 | `vjudge.testTimeout` | 单样例超时秒数 |
| 配置 | `vjudge.testCommands` | 扩展名→命令模板，默认覆盖 cpp/c/py/java/js/go/rs |
| 配置 | `vjudge.languageTemplates` | 语言→模板文件路径；键可为扩展名（`cpp`、`.py`）或提交语言名（`GNU G++17`），值为绝对路径或相对首个工作区的路径；优先级高于全局模板；支持 `${title}`、`${oj}`、`${probNum}` |
| 配置（CPH） | `cph.general.saveLocation` | 只读；CPH 自定义保存目录，导入时一并扫描 |
| SecretStorage | `vjudge.password` / `vjudge.cookies` | 敏感信息 |
| globalState | `vjudge.username` / `vjudge.lastLanguage` / `vjudge.remoteAccount.<oj>` / `vjudge.remoteRequired.<oj>` | 用户名缓存 / 上次提交语言 / 各 OJ 上次使用的远程账号绑定 ID / 该 OJ 只能使用个人账号提交（`submitMethods[0]` 为假或收到过 `submit_method_not_allowed`） |
| workspaceState | `vjudge.cphFiles` / `vjudge.cphSources` | 已导入 CPH `.prob` 文件路径数组 / 源码文件到 `.prob` 的关联 |
| 上下文键 | `vjudge.loggedIn` | 控制欢迎页和菜单 |
| contextValue | `vjudge.problem` / `vjudge.contest` / `vjudge.submission` / `vjudge.workbook` / `vjudge.workbookCategory` / `vjudge.info` | 右键/内联菜单匹配 |

## 10. 命令与 UI 映射

已注册命令（`package.json` + `commands.ts`）：

- 登录：`vjudge.login`、`vjudge.loginWithCookie`、`vjudge.logout`
- 视图：`vjudge.searchProblem`、`vjudge.refreshProblems`、`vjudge.refreshContests`、`vjudge.searchWorkbooks`、`vjudge.refreshWorkbooks`、`vjudge.refreshSubmissions`
- 题目：`vjudge.openProblem`、`vjudge.submit`、`vjudge.newFile`、`vjudge.testSamples`、`vjudge.importCph`
- 题单：`vjudge.toggleWorkbookMembership`（加入/退出）、`vjudge.copyWorkbookLink`、`vjudge.createWorkbook`、`vjudge.addToWorkbook`（题目节点或题单节点均可）
- 其他：`vjudge.openInBrowser`、`vjudge.showSubmission`、`vjudge.copyProblemLink`、`vjudge.showOutput`、`vjudge.editTemplate`（编辑全局语言模板）
- 内部：`vjudge.loadMoreProblems`、`vjudge.loadMoreWorkbooks`（参数：分类）、`vjudge.setUsername`、`vjudge.statusBar`

题面工具栏通过 `StatementPanel.onCommand` 回调 `submit/newFile/testSamples/openBrowser/copyLink`；`refresh` 在面板内部处理。题面列表与数学渲染都在面板内部完成：点击列表发送 `{type:'description', id}`，面板重新取题面并重绘。
状态栏未登录点击登录，已登录点击打开 QuickPick 菜单。

## 11. 修改指南

- **新增接口**：在 `api/types.ts` 定义模型 → `api/client.ts` 加方法（复用 `request`/`ensureSuccessJson`，必要时 `isLoginResponse`）→ 出错走 `makeClientError`/`VJudgeError` → 调用方 `await session.persistCookies()`。
- **新增设置**：`package.json` 的 `contributes.configuration` + 代码中 `getConfiguration`；若需即时生效，在 `extension.ts` 的 `onDidChangeConfiguration` 增加分支。
- **新增语言**：`templates.ts` 的 `RULES` 加正则→扩展名/模板；`commands.languageIdFor` 增加 VS Code languageId；必要时补 `vjudge.testCommands` 默认命令。新增扩展名会自动进入 `builtinTemplateFiles()`，下次激活时在全局模板目录补建对应文件（不覆盖已有文件）。模板优先级为 `vjudge.languageTemplates` → 全局模板文件 → 内置内容；`newFile` 读取后替换 `${title}/${oj}/${probNum}`，显式配置读取失败时警告并继续回退。
- **新增视图/节点**：`views/items.ts` 建 TreeItem → 新 Provider → `package.json` views/menus → `extension.ts` 创建 TreeView 并加入 dispose → 登录变化监听里刷新。
- **调整样例解析**：只改 `parser.extractSamples` 的策略顺序（表格→input/output div→dl→标题+pre）；保留 `dedupeSamples` 与文本归一化；更新 fixture 检查。
- **调整题面 UI**：`statementPanel.ts` 的 `TOOLBAR/STYLES/SCRIPT/shell`；所有动态文本必须 `escapeHtml`，保持 CSP 与链接白名单；新增按钮要同步 `StatementCommand` 与 `commands.ts` 回调。
- **调整题面图片**：VJudge 镜像题面的图片地址是占位符 `CDN_BASE_URL/...`，必须由 `sanitizeStatementHtml` 替换为实际 CDN（当前 `https://cdn.vjudge.net.cn/`）；Webview 的 `img-src` 已允许 https/http/data，不要收紧到只允许 data。
- **调整题面附件**：标记转换在 `parser.ts` 的 `resolveStatementFileUrl`/`statementFileHtml`（`sanitizeStatementHtml` 开头），按钮样式与点击处理在 `statementPanel.ts`（`.vj-file`、`data-vj-action`、`{type:'file'}`），下载逻辑在 `fileTransfer.ts`。新增文件类型时同时改卡片里的 `vj-file-kind` 文本与下载默认扩展名；注意 `[pdf:]` 替换必须发生在 HTML 清洗之前，且只对 HTTP(S) 生成卡片。回归检查在 `scripts/check-parsers.js` 的“题面文件附件”。
- **调整 Markdown 题面**：`api/markdown.ts#renderMarkdown` 是纯函数子集渲染器，`parseDescriptionPage` 只对 `format` 为 `MD`/`markdown` 的 section 调用；新增语法时同步 `scripts/check-parsers.js` 的“Markdown 题面”检查。公式必须在行内处理前保护成占位符再原样还原，代码围栏与行内代码只转义；原始 HTML 块直接透传，最终仍由 `sanitizeStatementHtml` 净化。
- **调整题面列表**：元数据在 `parser.ts#collectJsonDescriptionRefs`/`parseDescriptions` 收集与排序，`client.descriptionsFromRef` 再兜底排序；面板只消费 `DescriptionRef[]`，新增字段先改 `types.ts`，再改 `statementPanel.descriptionsHtml` 的展示。
- **调整数学渲染**：`statementPanel.ts` 的 `SCRIPT`（`SYMBOLS`、`parseCommand`、`parseEnvironment`）；保持 `String.raw` 写法避免转义丢失，渲染后加 `.mj` 类；正文跳过样例区，`pre/code` 只处理显式 `\(...\)`/`\[...\]`，不处理 `$`。Codeforces 的三重/六重美元定界符在 `parser.ts#normalizeCodeforcesMath`（由 `sanitizeStatementHtml` 调用）里归一化，新增定界符时同时改这里和 `scripts/check-parsers.js` 的“Codeforces 公式定界符”检查。
- **调整题单**：`views/workbooks.ts`（分类状态、分页、详情缓存）+ `api/parser.ts#parseWorkbookDetail`（正文顺序、brief 兜底、`content/nodeId`）；新增字段先改 `WorkbookSummary`/`WorkbookDetail`，再改 `client.listWorkbooks` 的行映射。创建/更新走 `client.createWorkbook/updateWorkbook`（共享 `saveWorkbook`），题目集合由 `content` 中的 `[problem:...]` 标记决定；`commands.ts` 的 `parseProblemTokens/appendProblemMarkers` 负责解析与追加，更新时必须回传 `nodeId`。
- **调整提交/轮询**：`client.submit`、`commands.pollSolution`；注意验证码重试上限与取消路径。
- **错误提示**：命令层统一用 `reportError(prefix, error)`，登录类错误会提示“重新登录”；新增错误 kind 时同步 `errors.ts`。面向用户的文案不得直接暴露服务端错误键（如 `duplicate_code`），未识别的键统一显示为通用提示，原始键与 HTTP 状态由 `reportError` 写入输出通道；`duplicate_code` 在提交命令里单独弹出带“查看提交记录”按钮的说明。

## 12. 验证与打包

### 解析器检查

```bash
npm run compile
npm run check:parsers
npm run check:cph
```

fixture 文件名固定：`c803029b.html`（比赛页，如公开比赛 803029）与 `desc.html`（题面页）。查找顺序：`$VJUDGE_FIXTURE_DIR` → `os.tmpdir()` → `/tmp`。
iframe 题面引用、无版本号描述、Cloudflare 验证页识别、正常页面探测脚本不误判、空白页不出题面、题单正文与 `nodeId` 等检查使用内联 HTML，不依赖 fixture，始终运行。
**注意**：找不到 fixture 时脚本只打印“跳过”并仍然“全部检查通过”，不能当作验证成功。需要真实回归时设置：

```bash
VJUDGE_FIXTURE_DIR=/path/to/fixtures npm run check:parsers
```

历史验证过的公开样例：比赛 803029（“Lab 12 - Thursday”，2 题、43 种语言）；公开题面 key `291535908848976`、version `1746122778000`。这些 ID 可能失效，仅作抓取参考。

### 冒烟测试

临时 harness（不在仓库内，系统清理临时目录后可能消失）：
`C:\Users\14530\AppData\Local\Temp\vjudge-smoke.js`

```bash
node "C:/Users/14530/AppData/Local/Temp/vjudge-smoke.js" "D:/Program Files/vscode-vjudge"
```

它 mock 了 `vscode` API，覆盖：激活、全部命令注册、四个视图、未登录空态、树节点、题单分类/题单/题目节点、题单创建/追加题目（输入解析、去重、标记追加、回传 `nodeId`）、题面 HTML/安全（CSP、脚本清理、重复样例表移除、javascript 链接拒绝）、真实 Python 样例运行（通过/失败/差异展示）。若文件不存在，需要按这些断言重建；建议未来移入 `scripts/`（注意 `.vscodeignore` 已排除 `scripts/**`）。

### 手动验收（必须）

用 F5 启动扩展开发宿主，准备真实账号：

1. 密码登录（若被 Turnstile 拦截，改用 Cookie 登录）。
2. 搜索题目、连续“加载更多”、展开比赛、打开题面、刷新题面；展开题单四个分类、加载更多、打开题单题目。
3. 创建题单（建议选“私密”并只用于验收），确认出现在“我创建的”；展开确认题目齐全。再从题目节点右键“添加题目到题单”，以及在题单节点上添加题目，刷新后确认新题出现、重复题被跳过。
4. 新建代码文件 → 编辑 → 本地测试样例 → 提交 → 等待结果 → 查看提交详情/代码。
5. 注销后确认视图清空、欢迎页出现、状态栏变化。
6. 关闭重开窗口，确认登录恢复与提交记录自动刷新。

### 打包

```bash
npm run package
```

- `main` 指向 `out/extension.js`，打包前必须 compile。
- `.vscodeignore` 有意排除 `src/**`、`scripts/**`、`test/**`、`tsconfig.json`、lock 文件、sourcemap 和本文件；最终只发布 `out/`、`resources/`、`package.json` 等运行所需文件。
- `package.json` 已配置 `repository/bugs/homepage` 并附带 `README.md`、`LICENSE`（MIT），`vsce package` 不再有相关警告。
- 产物 `vjudge-*.vsix` 被 `.gitignore` 忽略。

## 13. 已知限制与易踩坑

1. **密码登录可能被人机验证拦截**：服务端 Turnstile 只在浏览器环境通过；Cookie 登录是正式支持的备用路径。
2. **真实提交/验证码未做端到端自动化**：历史上只用匿名请求验证过接口形状；不要声称已全流程验证。
3. **题目↔文件映射与“最近题目”只存在内存**：窗口重载后，从编辑器标题栏直接提交/测试可能不知道对应题目（需先从侧边栏或题面打开一次）。如需持久化，可把 `problemFiles` 写入 workspaceState，但要注意多工作区与文件移动。
4. **仅支持 HTTPS 直连 vjudge.net**：无代理、无 gzip 解压、Cookie 不区分 domain/path（只按主机白名单发送）。
5. **题面 HTML 清洗基于正则**，不是完整 HTML 解析器；CSP 是第二道防线。任何新注入路径都必须先清洗。
6. **题目详情页可能被登录或 Cloudflare 拦截**：已从比赛/搜索拿到 `descBriefs` 时，详情补全失败不会阻断题面；真正的人机验证页会提示在浏览器完成验证。不要把正常页面内联的 `__CF$cv$params` 当作验证页。
7. **未点选题面时按排序自动尝试前 5 个描述**（官方英文优先），超过 5 个且均失败时需用户手动选择；`enabledDescKeys` 仅在缺少 `descBriefs` 时兜底。题面列表依赖详情页/比赛页提供的元数据，若服务端只给 key/version，作者与语言会显示为 `VJudge`/空。
8. **数学渲染是 TeX 子集**：覆盖常见竞赛公式，但复杂宏、`\newcommand`、TikZ、自定义环境不保证正确；无法识别的命令按原文输出。公式在客户端渲染，不改变服务端 HTML 清洗与 CSP。
9. **样例提取是启发式**（表格 class/id、input/output div、dl、标题+pre）；特殊 OJ 页面可能漏提。修改时优先补策略，不要破坏现有顺序。
10. **提交记录无分页**，只显示最近 N 条；比赛只列 `category=mine`，无全部比赛/榜单/报名。
11. **`recordsTotal=9999999` 是匿名/受限哨兵**；不要把它当作真实题数展示给用户。
12. **自动刷新只刷新一次列表**，不做单条状态轮询；评测中的条目依赖下一次刷新。
13. **做题状态依赖 OJ 显示名匹配**：`/user/solveDetail` 按 OJ 显示名分组，客户端只做大小写、空格、下划线、连字符归一化；若 VJudge 改版导致搜索/比赛里的 OJ 名与通过记录键不一致，题目会显示“未做”而不是“未知”。比赛与题单共用全局通过记录，不区分具体比赛。
14. **页面大小下限不一致**：`package.json` 中 `problemPageSize` 最小 5，代码实际按 10 取；修改时统一。
15. **`reportError` 的“重新登录”固定走用户名密码登录**，没有提供 Cookie 选项；若密码登录被拦截，用户需手动执行 Cookie 登录命令。
16. **未使用代码**：`forgetProblemFile`、`invalidateStatement`、`originProblemUrl`、`ProblemsProvider.currentCriteria` 目前无调用方，可安全删除或接入。
17. **UI 未在真实 VS Code 中做过像素级验收**，布局调整后需手动检查窄面板与主题切换。
18. **CPH 导入只支持 `.prob`**：URL 为 VJudge `/problem/{oj}-{probNum}` 时才建立题目映射；比赛链接、非 VJudge 链接只导入测试。CPH 的 `customCheckerPath` 和交互题 checker 未接入，仍按 stdout 完全一致比较。
19. **CPH 源文件可能失效**：`srcPath` 指向的文件不存在时，手动导入仍会保存记录但无法直接运行；新建代码文件会按题目 URL 自动关联 CPH 测试（`vjudge.cphSources`），在该文件上运行“本地测试样例”可正常使用；找不到现有 CPH 数据时会用题面样例自动生成 `.prob`。生成依赖题面解析出的样例，题面没有样例或抓取失败时不会写入，并会提示原因。
20. **CPH 扫描有上限**：最大深度 8、5000 个目录、2000 个 `.prob`、单文件 8 MB；超出部分静默跳过，超大工作区可能扫不全。
21. **题单编辑只支持创建与追加题目**：没有删除题目、调整顺序、修改正文/可见性/标题的 UI；更新时保留原 `content` 只追加标记，去重按 `oj/probNum` 不区分大小写。删除等操作仍需在浏览器完成。创建题单必须至少输入一道题，否则不会提交。
22. **添加题目依赖题单可写**：更新接口需要登录且对题单有权限；他人的题单会返回 `article.error.update_forbidden`。`/article/{id}` 无法访问时（私密且未加入）也无法追加。
23. **题单只显示单题状态，无汇总进度**：题单题目会显示已通过/尝试过/未做，但不显示题单维度的通过率或总进度；`/user/solveDetail2` 的映射仍未验证。
24. **题单列表的“加载更多”依赖本页条数**：`recordsTotal/recordsFiltered` 恒为 `9999999`，`hasMore` 以“本页返回满 50 条”推断；最后一页恰好 50 条时会多请求一次空页。
25. **题单详情需要可访问**：私密题单或未加入的受限题单会解析失败并显示错误节点；未登录时整个题单视图为空。
26. **私密题单不保证出现在“我创建的”**：实测 `openness=0` 创建成功后 `/workbook/data?category=created` 可能不返回该题单；创建成功的提示会说明这一点，用户需用提示中的“在浏览器打开”或保存 id 访问。公开/不公开题单约 1–2 分钟后才出现在列表中。
27. **用户名识别依赖登录后主页**：`/user/`（带斜杠）线上返回 404；`getUsername()` 改为从主页的 `/user/{name}` 链接提取。若主页被 Cloudflare 拦截或结构改版，可能自动识别不到用户名，此时状态栏显示“已登录”，可用 `VJudge: 设置用户名` 手动填写；提交记录按该用户名查询。
28. **题单题数有服务端延迟**：向题单添加题目后，详情页（展开题单）立即能看到新题目，但 `/workbook/data` 返回的 `problemCount` 可能仍是旧值，稍后刷新才更新。
29. **语言模板按扩展名共享**：全局模板目录每个扩展名只有一个文件（`main.<扩展名>`，Java 为 `Main.java`），同一扩展名的不同提交语言共用内容；`vjudge.languageTemplates` 不支持直接写模板正文。相对路径固定相对**首个工作区根目录**，多根工作区不会按当前文件所属目录解析。`${title}` 等占位符只做简单字符串替换，不执行其他语法；模板内容原样写入，不再自动添加题目注释。全局模板只在缺失时创建，删除文件后下次激活或执行编辑命令会重新生成。
30. **Markdown 渲染是子集实现**：覆盖 VJudge/洛谷常见语法，但复杂表格、脚注、HTML 内嵌 Markdown、引用内多段惰性续行等不保证与网页端完全一致；无法识别的语法按普通文本输出。公式不做语法校验，仍交给 Webview 的 TeX 子集渲染器。
31. **题面附件只识别 `[pdf:]` 标记**：VJudge 前端只有这一种文件标记，普通正文里的 `<a href>` 仍按链接处理，不会生成下载卡片。“在线预览”调用系统浏览器（浏览器原生 PDF 查看器），扩展内不能内嵌 PDF。下载需要用户在保存对话框中确认路径，默认固定 `.pdf` 扩展名；上限 50 MB、30 秒超时、最多 3 次重定向，CDN 返回 HTML（如验证页/错误页）会判定失败。附件地址不携带登录 Cookie，私有资源可能无法下载。
32. **附件链接不受 Cookie 保护**：下载复用 `https` 直连与 `CDN_BASE_URL` 规则，仅限 HTTP(S)，不读取工作区设置中的代理；网络受限环境下需自行保证 CDN 可达。
33. **Codeforces 等平台必须用远程账号提交**：服务端对 `method=0` 返回 `submit_method_not_allowed`。插件优先读题目/比赛 JSON 的 `submitMethods` 直接选个人账号；元数据缺失且收到该错误时自动回退（`method=1` + `bindingId`），并把 OJ 记入 globalState `vjudge.remoteRequired.<oj>`。前提是已在 VJudge 的 `/user/remoteAccounts` 绑定对应 OJ 账号且状态为 `READY`；绑定账号在 OJ 端掉登录时提交会失败，需要重新在 VJudge 上登录该远程账号。
34. **相同代码会被拒绝**：VJudge 对同一用户同一题目的重复源码返回 `submit.error.duplicate_code`（“这份代码之前已经提交过。”），被拒的尝试也可能计入；插件已避免对需要个人账号的 OJ 先发 `method=0`。需要重试时修改一行注释或空行，或更换提交语言。

## 14. 术语

- OJ：原题平台（CodeForces、洛谷等），对应 `ProblemRef.oj`。
- 题面描述（description）：VJudge 存储的题目正文，带 `key` 与 `version`。
- 比赛内题号：`ContestProblem.num`，对应 `ProblemRef.contestNum`，不是 `probNum`。
- 运行 ID（runId）：一次提交的唯一编号，用于轮询 `/solution/data/{runId}`。
- 题单（workbook）：VJudge 的题目集合，详情页地址为 `/article/{id}`；`problemsBrief` 是键为 `OJ-probNum` 的 JSON 字符串，正文 `content` 决定展示顺序。
- 哨兵值：接口在匿名/受限时返回的占位总数 `9999999`。
