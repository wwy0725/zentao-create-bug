---
name: zentao-create-bug
description: 自动创建禅道（ZenTao）Bug。当用户说"提个bug / 创建bug / 提交bug / 报个bug / 登记bug / 禅道提bug"，或给出缺陷描述、截图、录屏并要求提到禅道时使用。以专业测试人员视角从用户输入推断 Bug 类型、标题、重现步骤，按项目配置自动填单，提交前自检。
---

# 禅道自动提 Bug

以专业测试人员身份，把用户的缺陷输入（一句话描述 / 描述+截图 / 描述+录屏）转化为规范的禅道 Bug 单，通过 `mcp__playwright__*` 工具在禅道 Web 表单自动填写并提交。

链路：独立 Playwright 浏览器（自带持久 profile）→ 一次登录后 cookie 常驻免登 → 表单自动化。**不使用 playwright-extension 扩展桥接模式**（它无法接管文件选择器，传不了截图）。

## 0. 前置检查

1. **读配置**：读取本 skill 目录下的 `config.json`（每次执行都重读，用户改完即生效）。文件不存在时，指引用户从 `config.example.json` 复制一份并填好必填项（baseUrl / productID / openedBuild 等），不要替用户编造这些值。
2. **浏览器**：使用 `mcp__playwright__*` 工具（全局 `~/.claude.json` 定义的 playwright server，profile 在 `~/.claude/playwright-mcp/browser-data`，禅道登录态持久保存在该 profile 里）。不要用扩展模式的 `mcp__playwright-extension__*`。
3. **有头/无头**：由全局配置 `~/.claude/playwright-mcp/config.json` 的 `browser.launchOptions.headless` 控制（`false`=有头，默认；`true`=无头）。切换 = 改该字段后杀 MCP 的 node 进程让 IDE 重拉（cookie 在持久 profile 里，重启不丢登录态）。⚠️ 无头模式下"请用户在浏览器窗口手动登录"流程走不通：无头 + 会话过期 + 未配账密时，切回有头让用户登录，不要卡在无头里重试。
4. **故障处理**：
   - `mcp__playwright__*` 工具不存在（MCP server 没起来）→ 常见原因：没装 Node/npx，或 npx 首次拉包网络不通。指引用户确认 `node -v` 有输出、能访问 npm registry，修好后重启会话。
   - 首次调用浏览器报 launch/浏览器找不到类错误 → 本机没装 Chrome（配置 `channel: "chrome"` 用系统 Chrome）。指引用户安装 Google Chrome 后重试。
   - 页面跳到 `user-login`（禅道会话过期）→ 见下方"登录态处理"，不要自己猜账号密码。
   - 页面 alert "您无权访问该产品" → 接受弹窗，告知用户 config.json 里的 productID 无权限，让用户改成一个有权限的产品 ID。
   - MCP 禁止 `file://` 协议；本地文件要用本地 HTTP 服务（见录屏抽帧）。

### 登录态处理

- profile 里 cookie 持久保存，正常情况下长期免登。
- 会话过期时：若 config.json 配置了 `username`/`password`（见下"自动登录"），按该流程自动登录；否则请用户在 Playwright 浏览器窗口里登录一次禅道，然后重试。

### 自动登录（免登方案）

config.json 可配置 `username` / `password`（明文存本机，用户自行决定是否填）。检测到登录页时：

1. `input[name="account"]` 填账号、`input[name="password"]` 填密码（native setter + input/change 事件）。
2. 点登录按钮，等待跳转回目标页后重试原操作。
3. 登录失败（页面提示账号密码错误）→ 停下来告知用户，不要重试。

未配置账密时退回"请用户手动登录一次"。

## 1. 解析输入，推断 Bug 要素

输入三种形态：
- 纯文字描述
- 文字 + 截图文件路径：用 Read 工具查看图片，从图中提取页面名称、报错文案、异常表现；截图**内嵌到重现步骤**（见下）
- 文字 + 录屏文件路径：先按下面的"录屏抽帧"流程看视频还原操作步骤，再提炼步骤；录屏作为附件上传

**信息不足时**（无法判断操作路径、期望行为）：先问用户补齐，不要编造业务细节。

按专业测试规范推断四个核心要素：

### Bug 类型

打开表单后先读"Bug类型"下拉的**实际选项**（公司实例的类型是自定义的，语义和标准禅道不同），按语义就近匹配。已知产品 209 的选项：designdefect:服务端问题，frontfeatureerror:前端问题，pcbug:PC客户端问题，appbug:APP问题，codeerror:需求问题，suggest:建议性问题，depend:外部依赖，security:安全问题，compatibility:兼容性问题，invalid:无效问题，others:其他，newfeature:新增需求。

| 用户描述特征 | 类型 |
|---|---|
| 某端（APP/PC/前端页面）功能不可用、逻辑错误、接口报错 | 按出问题的端选：APP问题 / 前端问题 / PC客户端问题 / 服务端问题 |
| 操作系统/浏览器/设备兼容导致（如仅鸿蒙、仅某浏览器出现） | 兼容性问题 |
| 需求描述有歧义、需求本身前后矛盾、理解偏差 | 需求问题 |
| 响应慢、超时、卡顿 | 服务端问题或其他，按语义就近 |
| 环境/账号/权限配置导致 | 外部依赖或其他 |
| 无法归入以上 | 其他 |

### 标题

格式 `【迭代日期】【测试轮次】具体现象`（例：`【20261029】【二】鸿蒙app不支持AI开票里的安全认证`）：
- 前两段从 config.json 的 `iterationTag` / `testRound` 取；用户描述里明确指定了轮次或迭代时以用户为准
- 标题正文不超过 40 字，不用"有问题 / 不对 / 异常"等模糊词，写具体现象
- 好的例子：`【20261029】【三】[发票列表] 筛选2026年10月后点查询结果仍显示全年数据`
- 坏的例子：`发票筛选有问题`

### 严重程度（默认 3；下拉只有 1-4 档）

| 级别 | 判断标准 |
|---|---|
| 1 | 系统崩溃、数据丢失、主流程完全阻塞 |
| 2 | 主要功能失效，但有绕行方案 |
| 3 | 一般功能缺陷（默认值） |
| 4 | 界面、文案、体验类小问题 |

### 重现步骤（严格三段式，必须换行）

标签独占一行，内容另起一行；多个步骤一条一行：

```
[步骤]
1. 前置条件（如有）
2. 进入xx页面
3. 点击xx
4. 输入xx
[结果]
实际观察到的现象（引用截图/录屏中的报错原文更佳）
[期望]
按需求合理预期的行为
```

HTML 写法对应 `<p>[步骤]</p><p>1. xxx</p><p>2. xxx</p><p>[结果]</p><p>xxx</p><p>[期望]</p><p>xxx</p>`，禁止把编号步骤挤在同一行。步骤必须编号、可独立执行、包含入口路径。截图/录屏中的信息写进对应步骤。

## 2. 填单

1. `browser_navigate` 打开：`{baseUrl}/pro/bug-create-{productID}-0-moduleID=0.html`
2. 逐字段填写，**取值优先级：用户描述中明确指定的 > config.json 配置 > 页面默认值**：

| 字段 | 底层元素 | 取值 | 操作方式 |
|---|---|---|---|
| 所属模块 | `select#module` | 用户指定的模块 > 配置 `module`（`/`=根不选） | option 按 text 精确匹配（如 `/财赢/企业端`），匹配不到把可选项列给用户问 |
| 所属迭代 | `select#project` | 配置 `execution`，为空则不填 | option 按 text 匹配 |
| 影响版本 | `select#openedBuild[]`（multiple） | 配置 `openedBuild`，必填 | option 按 text 包含匹配（如 `20261029`），`val([v])` 数组赋值 |
| 当前指派 | `select#assignedTo` | 配置 `assignedTo`，空=页面默认 | option text 包含匹配显示名 |
| Bug类型 | `select#type` | 就近匹配（见上表） | value 赋值 |
| 严重程度 / 优先级 | labelSelector 按钮组 | 按推断，默认 3 | **不是 chosen**，是 `.pri-selector` 里的 select（display:none）+ 按钮 UI，select.value 赋值后按钮按 `data-severity` 渲染 |
| Bug标题 | `input#title` | 推断生成 | native setter + input/change 事件 |
| 相关需求 | `select#story` | 配置 `story`，空不填 | value 赋值 |
| 重现步骤 | KindEditor iframe | 推断生成的三段式 | `document.querySelector('iframe').contentDocument.body.innerHTML` 写入 |

⚠️ **chosen/picker 增强组件**：赋值统一用 `jQuery(s).val(v).trigger('change').trigger('chosen:updated')`，然后回读 UI 显示文本确认。直接改底层 select 的 value 后界面显示不一定跟着变。

⚠️ **字段会被重置**：打开图片对话框、点页面其他区域等交互可能把已填的 chosen 字段重置（实际发生过 assignedTo/openedBuild 被清空）。**任何弹窗操作后必须重新自检所有字段**。

标题输入框赋值模板：

```js
const el = document.getElementById('title');
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(el, '<标题>');
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

3. **截图处理（重要）**：用户提供的**截图不作为附件上传**，通过 KindEditor 图片对话框插入重现步骤（扩展桥接做不到、独立驱动可以）：

   1. 点工具栏"图片"按钮 → 对话框切到"本地上传"标签。
   2. 点"浏览..."会失败（透明 `input[name="imgFile"]` 拦截点击）——**直接点 Choose File 按钮（即该 file input 本身）**，文件选择器弹出后 `browser_file_upload` 传文件绝对路径。
   3. MCP 只允许上传工作区目录内的文件，工作区外的截图先拷贝到工作区（如 `.playwright-mcp/uploads/`）。
   4. 点"确定"——禅道会把图片传到服务端并插入编辑器（`/pro/file-read-xxx.png`）。
   5. **验证并整理位置**：回读 iframe，确认 `img` 存在且独占一个 `<p>`。**截图按内容插入对应段落（步骤/结果/期望）之后，不盲目全堆在末尾**——页面表现图放对应步骤后、接口响应图放 [结果] 对应描述段后、日志图放报错列表后。**步骤文字里不写"见截图N"这类引用**，图放在哪就近说明在哪；同一张图如有助理解可以在多处插入，按需即可。KindEditor 光标位置不可靠（新图常插到开头或顶掉段落），全部传完后**重建整个 innerHTML**（步骤文字 + 已上传的 img src 按正确位置交错拼接）最稳：
      - 重建时用已上传的服务端 src（`/pro/file-read-<id>.png`），不要用本地路径；
      - 每张图独立一个 `<p>`，前后不留空段落。

   录屏视频走附件（见下方附件规则）。

### 录屏抽帧（看视频内容的方法）

机器没有 ffmpeg，用 Playwright MCP 浏览器原生解码抽帧，已验证可用：

1. python 先确认视频文件存在且大小 > 0（Windows 自带录屏常产生 0 字节空文件）。
2. 把本 skill 的 `scripts/frame_reader.html` 复制到**视频所在目录**，把其中 `__VIDEO_FILE__` 替换为视频文件名。
3. 在该目录起仅本机的 HTTP 服务：`python -m http.server <端口> --bind 127.0.0.1`（后台运行；必须 `--bind 127.0.0.1`，禁止 0.0.0.0 暴露局域网）。
4. `browser_navigate` 打开 `http://127.0.0.1:<端口>/__frame_reader.html`。
5. python http.server 不支持 Range，Chrome 会把 seekable 显示为 0 导致无法 seek——先整体 fetch 进内存换 blob src：
   `const buf = await (await fetch(v.src)).arrayBuffer(); v.src = URL.createObjectURL(new Blob([buf], {type:'video/mp4'}));`
   （64MB 级别没问题；之后 `v.currentTime = t` + 等 `onseeked` 即可任意定位。）
6. 按 5-6 秒间隔 seek + `browser_take_screenshot` 存帧，`Read` 逐帧看图还原操作路径、页面文案、报错信息；可疑处再加密抽帧。
7. 结束后：停掉 HTTP 服务、删除复制过去的 `frame_reader.html`。帧图片、表单截图等中间产物在 bug 提交完成后全部删除，工作区不留临时文件。

仅支持 Chrome 认的编码（H.264/mp4a 的 mp4 都行；HEVC 不行，可用 python 扫 fourcc 预判）。

## 3. 提交前自检（强制，不许跳过）

点"保存"之前，**逐字段回读表单的实际状态并核对**，任何一项不符都要先修正：

1. 回读每个下拉的 **UI 展示文本**（不是只看 select.value）：module/project/type/assignedTo 用 `$(s).next('.chosen-container')` 里的显示文本；openedBuild 回读 `.search-choice` 项；severity/pri 回读 `.label-severity` 的 `data-severity` 属性
2. 回读标题 input 的 value、步骤 iframe 的 innerText（确认三段式完整、换行正确）+ 截图 `<img>` 存在、独立成段且插在内容对应的段落之后
3. 对照预期清单逐项核对，输出核对结果（`字段 = 实际值 ✓/✗`）
4. 有 ✗ 则修正后重新自检，**不许带着 ✗ 提交**

## 4. 确认与提交

1. 自检通过后**截图给用户看**，附摘要：标题 / 类型 / 严重程度 / 指派 / 模块 / 步骤内嵌截图说明。
2. **必须经用户确认后才点"保存"**。仅当 config.json `autoSubmit: true` 时可跳过人工确认直接提交（默认 false）。
3. 提交成功后页面跳转，从 URL 提取 bug ID（`/pro/bug-view-<id>.html`），给用户回传：**Bug 链接 + ID + 要素摘要**。
4. **附件告知义务**：录屏超过 50M（禅道附件上限）时不要尝试上传，提交时明确告知用户"录屏 xx MB 超过禅道 50M 附件上限，未能作为附件上传"。
5. 提交失败（页面红字提示缺必填项）：把提示原文报给用户，补齐后重新走一遍自检再提交。不要为凑必填项编造内容。
6. 提交完成后清理中间产物（上传副本、帧图、表单截图），工作区不留临时文件；**并杀掉本次拉起的浏览器进程**（只杀本项目 profile 的，别动用户自己开的 Chrome；异常中止也要清理）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'playwright-mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 5. 其他约定

- config.json 的默认值用户随时手改，每次执行重读即可，无缓存。
- 用户一句话里指定的字段（如"提给张三"、"属于xx模块"）永远覆盖配置。
- 未提及的字段（操作系统、浏览器、关键词、抄送等）一律不填，保持页面默认。
- 本 skill 只管"创建"。改 Bug 状态、查 Bug 等操作不在范围内。
