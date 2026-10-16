---
name: zentao-create-bug
description: 自动创建禅道（ZenTao）Bug。当用户说"提个bug / 创建bug / 提交bug / 报个bug / 登记bug / 禅道提bug"，或给出缺陷描述、截图、录屏并要求提到禅道时使用。以专业测试人员视角从用户输入推断 Bug 类型、标题、重现步骤，按项目配置通过 HTTP 接口直接提交，无需打开浏览器。
---

# 禅道自动提 Bug（API 直提）

以专业测试人员身份，把用户的缺陷输入（一句话描述 / 描述+截图 / 描述+录屏）转化为规范的禅道 Bug 单，调用本 skill 的 `scripts/create-bug.mjs` 通过 HTTP 接口直接保存。

链路：**create-bug.mjs 脚本 → HTTP 重放禅道登录（config.json 账密）→ 拉取创建页解析下拉名称→ID → 上传截图 → POST 表单保存**。全程不开浏览器。

官方 REST API（api.php / zentao-cli 的 token 路线）已被公司 SSO 网关拦截，17work 网关建单接口后端故障，均不要尝试。

> 本文件主体为平台无关内容；仅"附录 A"依赖 Claude Code 专属环境（Playwright MCP），其他智能体平台可忽略该附录。

## 0. 前置检查

1. **读配置**：读取本 skill 目录下的 `config.json`（每次执行都重读，用户改完即生效）。文件不存在时，指引用户从 `config.example.json` 复制一份并填好必填项（baseUrl / productID / openedBuild / username / password），不要替用户编造这些值。
2. **凭据**：`username`/`password` 为 API 提单必填（禅道账号密码，明文只存本机，`.gitignore` 已排除不入库）。缺失时提示用户补填，不要替用户猜。
3. **Node**：脚本要求 Node ≥ 18（内置 fetch）。`node -v` 无输出或版本过低时指引用户先修环境。

## 1. 解析输入，推断 Bug 要素

输入三种形态：
- 纯文字描述
- 文字 + 截图文件路径：用读图能力查看图片，从图中提取页面名称、报错文案、异常表现；截图**内嵌到重现步骤**（见下）
- 文字 + 录屏文件路径：先按附录 A"录屏抽帧"流程看视频还原操作步骤（无此能力的平台让用户口述步骤），再提炼步骤；录屏走附件（`--attachments`，禅道上限 50M）

**信息不足时**（无法判断操作路径、期望行为）：先问用户补齐，不要编造业务细节。

按专业测试规范推断四个核心要素：

### Bug 类型

产品 209 的已知类型（value:显示名）：designdefect:服务端问题，frontfeatureerror:前端问题，pcbug:PC客户端问题，appbug:APP问题，codeerror:需求问题，suggest:建议性问题，depend:外部依赖，security:安全问题，compatibility:兼容性问题，invalid:无效问题，others:其他，newfeature:新增需求。

| 用户描述特征 | 类型 |
|---|---|
| 某端（APP/PC/前端页面）功能不可用、逻辑错误、接口报错 | 按出问题的端选：APP问题 / 前端问题 / PC客户端问题 / 服务端问题 |
| 操作系统/浏览器/设备兼容导致（如仅鸿蒙、仅某浏览器出现） | 兼容性问题 |
| 需求描述有歧义、需求本身前后矛盾、理解偏差 | 需求问题 |
| 响应慢、超时、卡顿 | 服务端问题或其他，按语义就近 |
| 环境/账号/权限配置导致 | 外部依赖或其他 |
| 无法归入以上 | 其他 |

`--type` 传 value（如 `codeerror`）或显示名（如"服务端问题"）都行，脚本按页面实际选项匹配；匹配不到会列出全部可选值。

### 标题

格式 `【迭代日期】【测试轮次】具体现象`（例：`【20261029】【二】鸿蒙app不支持AI开票里的安全认证`）：
- 前两段从 config.json 的 `iterationTag` / `testRound` 取；用户描述里明确指定了轮次或迭代时以用户为准
- 标题正文不超过 40 字，不用"有问题 / 不对 / 异常"等模糊词，写具体现象
- 好的例子：`【20261029】【三】[发票列表] 筛选2026年10月后点查询结果仍显示全年数据`
- 坏的例子：`发票筛选有问题`

### 严重程度（默认 3；只有 1-4 档）

| 级别 | 判断标准 |
|---|---|
| 1 | 系统崩溃、数据丢失、主流程完全阻塞 |
| 2 | 主要功能失效，但有绕行方案 |
| 3 | 一般功能缺陷（默认值） |
| 4 | 界面、文案、体验类小问题 |

### 重现步骤（严格三段式，必须换行）

标签独占一行，内容另起一行；多个步骤一条一行。HTML 写法 `<p>[步骤]</p><p>1. xxx</p>...`，禁止把编号步骤挤在同一行。步骤必须编号、可独立执行、包含入口路径。截图/录屏中的信息写进对应步骤。

## 2. 生成步骤 HTML 与截图占位

1. 按三段式生成步骤 HTML，每个段落独立一个 `<p>`。
2. **截图用占位符就近插入**：在需要配图的段落位置放一个独立的 `<p>{{IMG:截图绝对路径}}</p>`。规则：
   - 页面表现图放对应步骤后、接口响应图放 [结果] 描述段后、日志图放报错列表后，**不盲目全堆末尾**
   - 步骤文字里不写"见截图N"，图放在哪就近说明在哪
   - 一张图可以重复引用（占位符写两处，同一文件会上传两次，无妨）
3. 把步骤 HTML 写到临时文件（如系统临时目录），截图路径必须真实存在（相对路径相对 steps 文件所在目录解析）。

## 3. 调脚本提交

工作目录任意，命令模板（Windows PowerShell，路径含空格要加引号）：

```powershell
node "<skill目录>/scripts/create-bug.mjs" --steps-file "<steps.html路径>" --title "<标题>" `
  --type <value> [--severity 3] [--screenshots "<图1>,<图2>"] [--attachments "<录屏>"]
```

- 模块/迭代/影响版本/指派人/需求默认从 config.json 解析；用户一句话里指定的字段加 `--module`/`--execution`/`--opened-build`/`--assigned-to`/`--story` 覆盖，**永远优先于配置**。
- **先跑 `--dry-run` 自检一次**：脚本会登录、解析全部字段并打印 `字段 = 实际值` 清单。任何字段匹配不到时脚本会报错并列出可选值——修正（改参数或让用户改 config）后重跑，不要硬闯。
- dry-run 全部 ✓ 后去掉 `--dry-run` 正式提交。
- 截图已用占位符的就不用再传 `--screenshots`；`--screenshots` 传的图会追加到步骤末尾（占位符优先）。
- 录屏超 50M 时不要传 `--attachments`，提交时明确告知用户"录屏 xx MB 超过禅道 50M 附件上限，未能上传"。

## 4. 提交确认

1. 脚本成功输出 `Bug 已保存：ID xxx` + 链接。把 **Bug 链接 + ID + 要素摘要**（标题/类型/严重程度/指派/模块/截图说明）回传给用户。
2. config.json `autoSubmit: false` 时：dry-run 的自检清单必须先贴给用户确认，用户同意后才正式提交（不带 --dry-run 再跑一次）。`autoSubmit: true` 时可连续执行 dry-run→提交。
3. 脚本报"保存失败"时把错误原文报给用户；提示缺必填项就补齐后重走 dry-run，不要为凑必填项编造内容。
4. 完成后删除中间产物（steps.html、帧图、上传副本），工作区不留临时文件。

## 5. 其他约定

- config.json 的默认值用户随时手改，每次执行重读即可，无缓存。
- **用户提供的 curl、账号密码、token、Cookie 等凭据：原样完整写进重现步骤，不做脱敏、不省略、不写"略"**。SIT/测试环境的凭据就是要给开发直接复现用的，自行判断"敏感"而隐藏是错的。
- 未提及的字段（操作系统、浏览器、关键词、抄送等）一律不填，保持页面默认。
- 本 skill 只管"创建"。改 Bug 状态、查 Bug 等操作不在范围内。

---

## 附录 A：Claude Code 专属（其他平台可忽略）

### A1. Fallback：浏览器提单（Playwright）

仅当 API 脚本不可用时使用（如：服务端改了表单结构导致脚本解析失败、需要人工核对页面）。依赖 `mcp__playwright__*` 工具（全局 `~/.claude.json` 定义的 playwright server，profile 在 `~/.claude/playwright-mcp/browser-data`，登录态持久）。流程要点：

1. 打开 `{baseUrl}/pro/bug-create-{productID}-0-moduleID=0.html`。
2. 登录态过期：用 config.json 的 `username`/`password` 填 `input[name="account"]`/`input[name="password"]`（native setter + input/change 事件）后点登录；未配账密时请用户在浏览器窗口手动登录一次。登录失败（页面提示账密错误）→ 停下告知用户，不要重试。
3. 逐字段填写：module（`select#module` 文本精确匹配）、execution（`select#project`）、openedBuild（`select#openedBuild` multiple，包含匹配）、assignedTo（`select#assignedTo` 显示名包含匹配）、type（`select#type` value）、severity/pri（`.pri-selector` 里 display:none 的 select，默认 3）、title（`input#title`，native setter + input/change 事件）、story（`select#story` value）、steps（KindEditor iframe 的 `contentDocument.body.innerHTML`）。
4. ⚠️ **chosen 组件**：赋值统一 `jQuery(s).val(v).trigger('change').trigger('chosen:updated')` 后回读 UI 显示文本确认；弹窗操作可能重置已填字段，**任何弹窗操作后必须重新自检所有字段**。
5. 截图：KindEditor"图片"对话框本地上传（直接点透明 `input[name="imgFile"]` file input 传路径；MCP 只允许上传工作区内文件，工作区外的先拷进来）。全部传完后**重建整个 innerHTML**（用服务端 `/pro/file-read-<id>.png` src 按正确位置交错拼接），每张图独立一个 `<p>`。
6. 提交前逐字段回读 UI 展示文本自检，截图给用户确认（`autoSubmit: true` 可跳过），点"保存"，从 `/pro/bug-view-<id>.html` 提取 ID。
7. 结束后清理临时文件，并杀掉本次拉起的浏览器进程（只杀本项目 profile 的）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'playwright-mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
8. 有头/无头：由全局 `~/.claude/playwright-mcp/config.json` 的 `browser.launchOptions.headless` 控制。无头模式 + 会话过期 + 未配账密时，切回有头让用户登录。

### A2. 录屏抽帧（Playwright MCP 浏览器看视频）

机器没有 ffmpeg，用 Playwright MCP 浏览器原生解码抽帧，已验证可用：

1. python 先确认视频文件存在且大小 > 0（Windows 自带录屏常产生 0 字节空文件）。
2. 把本 skill 的 `scripts/frame_reader.html` 复制到**视频所在目录**，把其中 `__VIDEO_FILE__` 替换为视频文件名。
3. 在该目录起仅本机的 HTTP 服务：`python -m http.server <端口> --bind 127.0.0.1`（后台运行；必须 `--bind 127.0.0.1`，禁止 0.0.0.0 暴露局域网）。
4. 打开 `http://127.0.0.1:<端口>/__frame_reader.html`。
5. python http.server 不支持 Range，Chrome 会把 seekable 显示为 0 导致无法 seek——先整体 fetch 进内存换 blob src：
   `const buf = await (await fetch(v.src)).arrayBuffer(); v.src = URL.createObjectURL(new Blob([buf],{type:'video/mp4'}));`
   （64MB 级别没问题；之后 `v.currentTime = t` + 等 `onseeked` 即可任意定位。）
6. 按 5-6 秒间隔 seek + 截屏存帧，逐帧看图还原操作路径、页面文案、报错信息；可疑处再加密抽帧。
7. 结束后：停掉 HTTP 服务、删除复制过去的 `frame_reader.html`。

仅支持 Chrome 认的编码（H.264/mp4a 的 mp4 都行；HEVC 不行，可用 python 扫 fourcc 预判）。
