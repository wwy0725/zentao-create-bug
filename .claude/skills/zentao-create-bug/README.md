# zentao-create-bug 使用文档

在 Claude Code 里对它说"提个 bug"，它会以专业测试人员视角把你的缺陷描述转成规范的禅道 Bug 单，**通过 HTTP 接口直接保存**（不开浏览器），回传 Bug 链接 + ID + 要素摘要。

## 工作原理

Claude 调用本 skill 的 `scripts/create-bug.mjs`（Node ≥ 18，零依赖）：

1. 用 config.json 里的 `username`/`password` HTTP 重放禅道登录（`md5(md5(密码)+verifyRand)`，与浏览器自动登录同一套凭据）
2. 拉取 bug-create 页面，把 config 里的模块/迭代/版本/指派人**名称解析成 ID**（匹配不到会列出可选值）
3. 截图上传到服务端后按占位符位置内嵌到重现步骤
4. POST 表单保存，返回 Bug ID

自动推断四个核心要素：

- **Bug 类型**：按描述推断（APP 问题 / 前端问题 / 服务端问题 / 兼容性 / 需求问题…），选项以禅道页面实际下拉为准
- **标题**：格式 `【迭代日期】【测试轮次】具体现象`，不超过 40 字
- **严重程度**：1（崩溃/数据丢失）～ 4（界面文案小问题），默认 3
- **重现步骤**：严格三段式 `[步骤] / [结果] / [期望]`

浏览器 Playwright 流程保留为 **fallback**（脚本不可用时才走，如服务端改了表单结构）。

## 环境要求

| 依赖 | 用途 | 缺了会怎样 |
|---|---|---|
| Claude Code | 运行 skill | — |
| Node.js ≥ 18 | 跑 create-bug.mjs（内置 fetch） | 脚本报错起不来 |
| 禅道可访问 | 内网地址，需在公司内网或 VPN | 接口连不上 |
| Google Chrome | 仅 fallback 浏览器流程需要 | fallback 不可用（不影响 API 提单） |
| Python（可选） | 只有处理**录屏**时用到（抽帧看视频） | 纯文字 / 截图提单不需要 |

## 安装步骤

1. 拿到整个项目目录（或 clone 仓库）
2. 复制本目录下 `config.example.json` 为同目录 `config.json`，填好必填项（baseUrl / productID / openedBuild / iterationTag / testRound / **username / password**）
3. 试一单：对 Claude 说 `提个bug：发票列表点查询没反应`

## config.json 字段说明

改完即生效（每次提单都会重读），随时手改。已列入 `.gitignore`，凭据不入库。

| 字段 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | ✅ | 禅道地址，如 `https://zentao.dc.servyou-it.com` |
| `productID` | ✅ | 目标产品数值 ID（禅道地址栏里能看到）；**你的账号必须对该产品有提 Bug 权限** |
| `productName` | 建议填 | 产品显示名，仅用于提示 |
| `openedBuild` | ✅ | 影响版本，**每轮迭代都要更新**（如 `代账合规-20261029`） |
| `module` | 选填 | 所属模块路径，`/` 表示根不选 |
| `execution` | 选填 | 所属迭代名称，空 = 不填 |
| `assignedTo` | 选填 | 默认指派人（显示名或账号），空 = 保持页面默认 |
| `story` | 选填 | 相关需求 ID |
| `iterationTag` / `testRound` | ✅ | 标题前缀【迭代日期】【测试轮次】，随迭代更新 |
| `username` / `password` | ✅ | 禅道账号密码，API 提单必填；也用于浏览器 fallback 自动登录 |
| `autoSubmit` | 选填 | `true` = 跳过提交前人工确认直接提交，默认 `false`（保持 false 时提交前会把自检清单贴给你确认） |

## 怎么用

三种输入形态都支持：

- 纯文字：`提个bug：鸿蒙app不支持AI开票里的安全认证`
- 文字 + 截图：截图**内嵌到重现步骤**（不是附件），如 `提个bug，截图在 D:\imgs\xxx.png`
- 文字 + 录屏：自动按帧还原操作步骤，录屏作为附件上传（>50M 不传），如 `录屏在 D:\rec\xxx.mp4`

一句话里的临时指定永远覆盖配置：`把这个bug提给张三`、`属于xx模块`、`轮次按三`。

也可以脱离对话直接用 CLI：

```powershell
node scripts/create-bug.mjs --title "【20261029】【一】xxx" --steps-file steps.html --type codeerror --dry-run
```

steps.html 里用 `<p>{{IMG:D:\path\shot.png}}</p>` 占位符就近插入截图。`--dry-run` 只登录+解析字段+自检，不提交。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `config.json 缺少 username/password` | API 提单必填，补上（凭据只存本机，不入库） |
| 登录失败：账号或密码错误 | 核对 config.json 账密；提示要验证码说明失败次数过多，去浏览器登一次再跑 |
| 字段匹配不到（脚本列出可选值） | 迭代/版本换了没更新 config.json，改配置或命令行覆盖 |
| 提示"您无权访问该产品" | config.json 的 `productID` 换成你有权限的产品 |
| 截图上传失败（响应非 JSON） | 会话失效或上传端点变了；重试一次仍失败则走浏览器 fallback |
| 录屏读不出来 | 仅支持 H.264 编码的 mp4（Windows 自带录屏就是）；HEVC 不支持 |
| 录屏超 50M | 超过禅道附件上限，不上传附件，但 bug 照常提交并明确告知你 |
| 保存时提示缺必填项 | 脚本报错误原文，补齐后重走自检再提交，不会编造内容凑必填 |

## 边界

- 本 skill 只管"创建 Bug"：改 Bug 状态、查 Bug 等不在范围内
- 信息不足时（判断不出操作路径、期望行为）会先问你，不编造业务细节
- 提单过程中产生的临时文件（steps.html、抽帧图片）提交完成后自动清理
