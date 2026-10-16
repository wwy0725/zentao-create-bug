#!/usr/bin/env node
/**
 * 禅道免浏览器提 Bug（经典 MVC 接口直提）
 *
 * 鉴权：config.json 的 username/password，HTTP 重放禅道登录（password = md5(md5(明文) + verifyRand)）。
 * 流程：登录 → GET bug-create 页解析 select 名称→ID → 上传截图（KindEditor 端点）→ POST 表单保存 bug。
 * 零第三方依赖，Node >= 18。
 *
 * 用法：
 *   node create-bug.mjs --title "【20261029】【一】xxx" [--steps-file steps.html]
 *       [--screenshots a.png,b.png] [--type codeerror|服务端问题] [--severity 3] [--pri 3]
 *       [--module "/财赢/企业端"] [--execution "代账合规26年10月迭代"]
 *       [--opened-build "代账合规-20261029"] [--assigned-to "韩冬"] [--story 252180]
 *       [--attachments rec.mp4] [--config ../config.json] [--dry-run]
 *
 * steps HTML 里用 {{IMG:截图绝对路径}} 占位符内嵌截图（占位符独立一个 <p>），脚本上传后替换为服务端 <img>。
 * --screenshots 传入的图在上传后统一追加到步骤末尾（应优先用占位符就近插入）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const args = { config: path.join(scriptDir, '..', 'config.json') };
  const flagsWithValue = new Set([
    '--config', '--title', '--steps', '--steps-file', '--screenshots', '--type',
    '--severity', '--pri', '--module', '--execution', '--opened-build',
    '--assigned-to', '--story', '--attachments',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (!flagsWithValue.has(a)) fail(`未知参数：${a}（--help 查看用法）`);
    const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[++i];
    if (args[key] === undefined) fail(`参数 ${a} 缺少取值`);
  }
  return args;
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

/* ---------- HTML 工具 ---------- */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 在 html 里找 <select id="..."> 的全部 option，返回 [{value, text}]。
 *  页面 JS 模板里也含空的同名 select（无 option），取第一个有内容的。 */
function parseSelect(html, selectId) {
  const idEsc = selectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<select[^>]*id=["']${idEsc}["'][^>]*>`, 'gi');
  let start;
  while ((start = re.exec(html))) {
    const rest = html.slice(start.index + start[0].length);
    const end = rest.indexOf('</select>');
    if (end < 0) continue;
    const opts = [];
    const optRe = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = optRe.exec(rest.slice(0, end)))) opts.push({ value: m[1], text: stripTags(m[2]) });
    if (opts.length > 0) return opts;
    if (!/id=["']${idEsc}["']/.test(rest)) return opts;
  }
  return null;
}

/** 定位包含 id="title" 的表单片段，返回其中的 hidden input [{name, value}] */
function parseFormHiddens(html) {
  const formStart = html.slice(0, html.indexOf('id="title"')).lastIndexOf('<form');
  if (formStart < 0) return [];
  const formEndIdx = html.indexOf('</form>', formStart);
  const slice = html.slice(formStart, formEndIdx < 0 ? undefined : formEndIdx);
  const hiddens = [];
  const re = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(slice))) {
    const tag = m[0];
    const name = tag.match(/name=["']([^"']*)["']/i)?.[1];
    const value = tag.match(/value=["']([^"']*)["']/i)?.[1] ?? '';
    if (name) hiddens.push({ name, value });
  }
  return hiddens;
}

/* ---------- HTTP 客户端（带 cookie jar） ---------- */

class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(url, opts = {}) {
    const res = await fetch(url.startsWith('http') ? url : this.baseUrl + url, {
      ...opts,
      headers: { Cookie: this.cookieHeader(), ...(opts.headers || {}) },
    });
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const line of setCookies) {
      const m = line.match(/^([^=;]+)=([^;]*)/);
      if (m) this.cookies.set(m[1].trim(), m[2]);
    }
    return res;
  }
}

/* ---------- 登录 ---------- */

function passwordStrength(pwd) {
  let s = 0;
  if (pwd.length >= 6) s = 1;
  if (pwd.length >= 10 && /[a-z]/i.test(pwd) && /\d/.test(pwd)) s = 2;
  return s;
}

/** 登录禅道。返回错误消息（null = 成功） */
async function login(client, username, password, createPath) {
  const loginUrl = '/pro/user-login.html';
  const page = await client.req(loginUrl);
  const html = await page.text();
  const rand =
    html.match(/name=["']verifyRand["'][^>]*value=["']([^"']*)["']/i)?.[1] ??
    html.match(/value=["']([^"']*)["'][^>]*name=["']verifyRand["']/i)?.[1];
  const referer =
    html.match(/name=["']referer["'][^>]*value=["']([^"']*)["']/i)?.[1] ??
    html.match(/value=["']([^"']*)["'][^>]*name=["']referer["']/i)?.[1] ?? '';

  const body = new URLSearchParams({
    account: username,
    password: md5(md5(password) + rand),
    passwordStrength: String(passwordStrength(password)),
    referer,
  });
  const post = await client.req(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const postHtml = await post.text();

  if (postHtml.includes('name="verifycode"') || postHtml.includes("name='verifycode'"))
    return '登录失败次数过多，禅道要求验证码。请在浏览器登录一次（或稍后再试），再跑本脚本。';

  // 终极验证：拉取创建页，仍是登录页则失败；同时把页面里的错误提示带出来
  const probe = await client.req(createPath, { redirect: 'manual' });
  const probeHtml = await probe.text();
  const stillLogin = probeHtml.includes('name="account"') && probeHtml.includes('name="password"');
  if (stillLogin) {
    const msg =
      postHtml.match(/class=["'][^"']*alert[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p)>/i)?.[1] ?? '';
    const clean = stripTags(msg);
    return clean || '账号或密码错误（或该账号被限制登录）。';
  }
  return null;
}

/* ---------- 名称 → ID 解析 ---------- */

function listOptions(opts, limit = 20) {
  const shown = opts.slice(0, limit).map((o) => o.text || o.value);
  const more = opts.length > limit ? ` …等共 ${opts.length} 项` : '';
  return `[${shown.join(' | ')}${more}]`;
}

function resolveExact(opts, name, label) {
  if (!name) return null;
  const hit = opts.find((o) => o.text === name || o.value === name);
  if (!hit)
    fail(`字段 ${label} 匹配不到 "${name}"，可选值：${listOptions(opts)}。请修正 config.json 或命令行参数。`);
  return hit.value;
}

function resolveContains(opts, name, label) {
  if (!name) return null;
  const hit =
    opts.find((o) => o.text === name || o.value === name) ??
    opts.find((o) => o.text.includes(name)) ??
    opts.find((o) => name.includes(o.text) && o.text);
  if (!hit)
    fail(`字段 ${label} 匹配不到 "${name}"，可选值：${listOptions(opts)}。请修正 config.json 或命令行参数。`);
  return hit.value;
}

function resolveType(opts, typeArg) {
  if (!typeArg) fail('缺少 Bug 类型（--type，可传 value 如 codeerror 或文本如"服务端问题"）');
  const hit =
    opts.find((o) => o.value === typeArg) ??
    opts.find((o) => o.text === typeArg) ??
    opts.find((o) => o.text.includes(typeArg));
  if (!hit)
    fail(`Bug 类型匹配不到 "${typeArg}"，可选值：${listOptions(opts)}（value:text 格式为 ${opts.map((o) => `${o.value}:${o.text}`).join(', ')}）`);
  return { value: hit.value, text: hit.text };
}

/* ---------- 截图上传 ---------- */

async function uploadImage(client, uploadUrl, filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('imgFile', new Blob([buf]), path.basename(filePath));
  fd.append('dir', 'image');
  const res = await client.req(uploadUrl, { method: 'POST', body: fd });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text.replace(/^<[^>]*>|<[^>]*>$/g, '').trim());
  } catch {
    return fail(`上传截图 ${filePath} 失败：服务端响应不是 JSON（可能上传端点不对或会话失效），响应前 300 字：${text.slice(0, 300)}`);
  }
  if (json.error !== 0) return fail(`上传截图 ${filePath} 失败：${json.message || JSON.stringify(json)}`);
  return json.url; // 形如 /pro/file-read-123.png
}

/* ---------- 主流程 ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法：node create-bug.mjs --title "【20261029】【一】具体现象" --steps-file steps.html --type codeerror
选项：
  --config <路径>        config.json 路径（默认本 skill 目录下）
  --title <标题>         Bug 标题（必填，dry-run 可省）
  --steps-file <路径>    三段式重现步骤 HTML 文件（或 --steps 直接传 HTML）
  --type <类型>          Bug 类型：value（codeerror）或显示名（"服务端问题"）
  --severity <1-4>       严重程度，默认 3
  --pri <1-4>            优先级，默认 3
  --screenshots <a,b>    截图路径（逗号分隔，追加到步骤末尾；建议改用 {{IMG:路径}} 占位符）
  --attachments <a,b>    附件路径（录屏等，单个 ≤ 50M）
  --module / --execution / --opened-build / --assigned-to / --story   覆盖 config.json 对应默认值
  --dry-run              只登录 + 解析字段 + 自检打印，不上传不提交`);
    process.exit(0);
  }
  if (!fs.existsSync(args.config)) fail(`找不到配置文件 ${args.config}`);
  const cfg = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (!cfg.baseUrl) fail('config.json 缺少 baseUrl');
  if (!cfg.username || !cfg.password)
    fail('config.json 缺少 username/password（HTTP 登录用，与浏览器自动登录同一套凭据）');

  const productID = Number(cfg.productID);
  if (!productID) fail('config.json 缺少 productID');
  const createPath = `/pro/bug-create-${productID}-0-moduleID=0.html`;

  const client = new Client(cfg.baseUrl);

  // 1. 登录
  const loginErr = await login(client, cfg.username, cfg.password, createPath);
  if (loginErr) fail(`登录失败：${loginErr}`);
  ok(`登录成功（${cfg.username}@${cfg.baseUrl}）`);

  // 2. 拉取创建页，解析下拉与隐藏字段
  const page = await client.req(createPath);
  const html = await page.text();
  if (html.includes('name="account"') && html.includes('name="password"'))
    fail('会话无效：登录后仍拿不到创建页（账号可能无权访问该产品，检查 productID）');
  if (html.includes('您无权访问该产品')) fail('config.json 的 productID=${productID} 无权限访问');

  const selects = {
    module: parseSelect(html, 'module'),
    execution: parseSelect(html, 'project'),
    openedBuild: parseSelect(html, 'openedBuild'),
    assignedTo: parseSelect(html, 'assignedTo'),
    type: parseSelect(html, 'type'),
    story: parseSelect(html, 'story'),
    severity: parseSelect(html, 'severity'),
    pri: parseSelect(html, 'pri'),
  };
  for (const [k, v] of Object.entries(selects))
    if (v === null) console.log(`⚠ 页面上没找到 select#${k}（不影响，可用页面默认值）`);
  const hiddens = parseFormHiddens(html);

  // KindEditor 上传端点：页面 JS 里 var kuid = 'xxx' + createLink('file','ajaxUpload','uid='+kuid)
  const kuid = html.match(/var kuid = ['"]([^'"]+)['"]/)?.[1];
  const uploadUrl = kuid ? `${cfg.baseUrl}/pro/file-ajaxUpload-uid=${kuid}.html` : null;

  // 3. 名称 → ID
  const moduleWanted = args.module ?? cfg.module ?? '';
  const executionWanted = args.execution ?? cfg.execution ?? '';
  const buildWanted = args.openedBuild ?? cfg.openedBuild ?? '';
  const assigneeWanted = args.assignedTo ?? cfg.assignedTo ?? '';
  const storyWanted = String(args.story ?? cfg.story ?? '');
  const severity = String(args.severity ?? 3);
  const pri = String(args.pri ?? 3);

  // module："/" = 根（value 0）
  const moduleValue = moduleWanted === '/' ? '0' : selects.module ? resolveExact(selects.module, moduleWanted, '所属模块') : undefined;
  const executionValue = executionWanted && selects.execution ? resolveExact(selects.execution, executionWanted, '所属迭代') : undefined;
  const buildValue = selects.openedBuild ? resolveContains(selects.openedBuild, buildWanted, '影响版本') : buildWanted;
  const assigneeValue = selects.assignedTo && assigneeWanted ? resolveContains(selects.assignedTo, assigneeWanted, '当前指派') : assigneeWanted || undefined;
  const typeHit = selects.type ? resolveType(selects.type, args.type ?? 'others') : { value: args.type ?? 'others', text: args.type ?? 'others' };
  const storyValue = storyWanted && selects.story ? resolveContains(selects.story, storyWanted, '相关需求') : storyWanted || undefined;

  // 4. steps 与截图
  let steps = args.steps ?? (args.stepsFile ? fs.readFileSync(args.stepsFile, 'utf8') : '');
  if (!steps.trim()) fail('缺少重现步骤（--steps-file 或 --steps 传三段式 HTML）');

  const resolveImgPath = (p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(args.stepsFile ? path.dirname(path.resolve(args.stepsFile)) : process.cwd(), p);
    if (!fs.existsSync(abs)) fail(`截图不存在：${p}（解析为 ${abs}）`);
    return abs;
  };

  const placeholders = [...steps.matchAll(/\{\{IMG:(.+?)\}\}/g)].map((m) => ({ mark: m[0], file: resolveImgPath(m[1].trim()) }));
  const extraShots = (args.screenshots ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(resolveImgPath);

  if (placeholders.length > 0 && !uploadUrl)
    fail('steps 里有截图占位符，但创建页 JS 里没找到 KindEditor 上传端点，无法上传截图。可去掉占位符改用附件/或走浏览器 fallback');
  if (extraShots.length > 0 && !uploadUrl)
    fail('传了 --screenshots，但创建页 JS 里没找到上传端点，无法上传截图。');
  if (extraShots.length > 0 && placeholders.length === 0)
    console.log('⚠ --screenshots 的图会追加到步骤末尾；建议改用 {{IMG:路径}} 占位符就近插入');

  // 5. 组装 payload
  const title = args.title ?? '';
  const fields = [...hiddens.map((h) => [h.name, h.value])];
  const set = (k, v) => {
    if (v !== undefined && v !== null && String(v) !== '') fields.push([k, String(v)]);
  };
  set('product', String(productID));
  set('module', moduleValue);
  set('project', executionValue);
  set('openedBuild[]', buildValue);
  set('assignedTo', assigneeValue);
  set('type', typeHit.value);
  set('severity', severity);
  set('pri', pri);
  set('title', title);
  set('story', storyValue);
  set('steps', steps);
  set('uid', kuid); // 服务端靠 uid 把已上传的临时图片/附件挂到新 bug 上（浏览器提交时 JS 也会注入）

  const attachments = (args.attachments ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of attachments) if (!fs.existsSync(f)) fail(`附件不存在：${f}`);

  const summary = {
    标题: title || '(未传)',
    类型: `${typeHit.value}:${typeHit.text}`,
    模块: moduleValue ?? '(页面默认)',
    迭代: executionValue ?? '(不填)',
    影响版本: buildValue ?? '(页面默认)',
    指派: assigneeValue ?? '(页面默认)',
    严重程度: severity,
    优先级: pri,
    相关需求: storyValue ?? '(不填)',
    截图: [...placeholders.map((p) => path.basename(p.file)), ...extraShots.map((s) => path.basename(s))].join(', ') || '(无)',
    附件: attachments.map((f) => path.basename(f)).join(', ') || '(无)',
    上传端点: uploadUrl || '(未发现)',
    步骤字数: steps.length,
  };

  console.log('\n===== 提单字段自检 =====');
  for (const [k, v] of Object.entries(summary)) console.log(`${k} = ${v}`);

  if (args.dryRun) {
    console.log('\n[dry-run] 未上传、未提交。确认无误后去掉 --dry-run 正式提交。');
    process.exit(0);
  }
  if (!title) fail('缺少 --title');

  // 6. 上传截图并替换占位符
  for (const p of placeholders) {
    const url = await uploadImage(client, uploadUrl, p.file);
    steps = steps.split(p.mark).join(`<img src="${url}" />`);
    ok(`截图已上传并插入：${path.basename(p.file)} → ${url}`);
  }
  for (const shot of extraShots) {
    const url = await uploadImage(client, uploadUrl, shot);
    steps += `<p><img src="${url}" /></p>`;
    ok(`截图已上传并追加：${path.basename(shot)} → ${url}`);
  }
  const stepsField = fields.find(([k]) => k === 'steps');
  if (stepsField) stepsField[1] = steps;

  // 7. 提交
  let res;
  if (attachments.length > 0) {
    const fd = new FormData();
    for (const [k, v] of fields) fd.append(k, v);
    for (const f of attachments) {
      fd.append('labels[]', '');
      fd.append('files[]', new Blob([fs.readFileSync(f)]), path.basename(f));
    }
    res = await client.req(createPath, { method: 'POST', redirect: 'manual', body: fd });
  } else {
    const body = fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    res = await client.req(createPath, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
  const loc = res.headers.get('location') || '';
  const respText = await res.text();
  const idMatch = loc.match(/bug-view-(\d+)/) || respText.match(/bug-view-(\d+)/);

  if (!idMatch) {
    const errMsg =
      respText.match(/class=["'][^"']*alert-danger[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const clean = stripTags(errMsg);
    fail(`保存失败（HTTP ${res.status}）。${clean || `响应前 400 字：${stripTags(respText).slice(0, 400)}`}`);
  }

  const bugID = idMatch[1];
  const url = `${cfg.baseUrl}/pro/bug-view-${bugID}.html`;
  ok(`Bug 已保存：ID ${bugID}`);
  console.log(url);
}

main().catch((e) => fail(e.stack || e.message || String(e)));
