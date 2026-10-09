#!/usr/bin/env node
/**
 * 每日核心功能验收 —— 断言「产物真的出现在屏幕上 / 后端真的答得上来」，不是「代码写对了」。
 *
 * 覆盖面：业务功能台账（.claude/skills/stable-smoke/reference/business-function-catalog.json）
 * 里的**全部**核心功能线，每条至少一项每日检查，或在 DAILY_EXEMPT 里写明为什么交给 48 小时那一轮。
 * 功能清单只认台账这一份：每日清单挂在台账之外的功能线上，报告直接拒收
 * （守卫 scripts/tests/daily-acceptance-coverage.test.mjs 会在 CI 上把漏掉的功能线报红）。
 *
 * 输出：一张「核心功能一览」红绿表（异常置顶，每条异常带下一步）+ 逐项明细 + 截图。
 *   --json  原始结果   --md  给 Routine 回复与推送用的表格   --html  本地看的完整报告（含截图）
 *   --archive  把完整版（明细 + 异常截图）归档进 CDS 验收中心并打印直达深链（需要 CDS 凭据，cdscli 自己处理）
 *
 * 为什么需要它：2026-08-23~25 白屏缺陷连续三轮才修好，而仓库里 1500+ 条测试全绿。
 * 原因是那些测试测的都是源码与纯函数，而白屏的形态恰恰是**源码全对、产物没出来**。
 * 2026-10-03 又暴露了另一半：main 预览所有容器崩溃时，旧版例程只回一句「环境不可达」就收工，
 * 没有表、没有下一步；而后端深度自检早就报着模型目录契约失配，没有任何每日判据读它。
 *
 * 交互一律走**真实指针序列**：程序化 `.click()` 会绕过命中测试
 * （「批量勾选框被 hover 条整条盖住」就是这么溜过去的）。
 *
 * 用法：
 *   node scripts/smoke/daily-acceptance.mjs --base http://127.0.0.1:7801 \
 *     --public-base https://main-prd-agent.miduo.org --md out.md --html out.html [--archive]
 *
 * --base 指向**能被浏览器打开**的地址。沙箱里公网域名浏览器直连会 ERR_CONNECTION_RESET，
 * 先用 .claude/skills/sandbox-net 起两跳隧道，再把 --base 指到本地端口。
 * --public-base 只用于报告里「打开这一屏」的链接（读报告的人点的是公网地址，不是隧道）。
 *
 * 凭据只从环境变量取（MAP_USER / MAP_PASSWORD），不写进文件、不打印。
 * 退出码：0 全部正常 / 1 有异常或需关注 / 2 被测环境或前置条件不可用（报告照样产出）。
 *
 * 已排进计划任务：Routine `trig_017sNsVhR9oSVa5SKbVLwC8i`「每日核心功能验收」，
 * 每天 01:00 UTC（北京时间 09:00）在一个全新会话里跑，失败推送 + 邮件。
 * 被测环境钉死在 https://main-prd-agent.miduo.org（main 分支预览）——不跟着功能分支跑，
 * 否则分支一合并这条例程就永远拿不到地址。同一环境上还有 48 小时一轮的稳定冒烟
 * （走 .claude/skills/stable-smoke）。分工：本脚本只跑只读、零成本的检查，
 * 真生成（出图、出视频、转录、解析）的完整闭环归 48 小时那一轮；本脚本反过来盯着
 * 「48 小时那一轮自己还在不在跑」（stability-foundation 那一行）。
 *
 * 加一条用例的成本：往 PAGES / API_CHECKS / DEEP_CHECK_MAP 加一行（形态类），
 * 或往主流程加一个 checkXxx（交互类）。加之前先问一句：**这条断言能被测红吗？**
 * 不能测红的用例比没有更糟——它会让下一个人以为这件事已经验过了。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readScoped } from './lib/scoped-text.mjs';
import { outcome, summarize, renderMarkdown, renderHtml, archiveTitle } from './lib/daily-report.mjs';
import { DAILY_EXEMPT, EXTRA_LINES, DEEP_CHECK_MAP, deepCheckOutcome } from './lib/daily-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = JSON.parse(fs.readFileSync(
  path.join(REPO, '.claude/skills/stable-smoke/reference/business-function-catalog.json'), 'utf8',
));

const require_ = createRequire(path.join(process.cwd(), 'noop.js'));
let chromium;
// 先找工作目录里的，再找全局装的（云端会话的 Node 全局目录里自带 playwright）
const globalRoot = (() => { try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
for (const req of [require_, globalRoot && createRequire(path.join(globalRoot, 'playwright', 'noop.js'))].filter(Boolean)) {
  for (const mod of ['playwright-core', 'playwright']) {
    if (chromium) break;
    try { ({ chromium } = req(mod)); } catch { /* 下面统一报 */ }
  }
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const BASE = (arg('--base') || '').replace(/\/$/, '');
const PUBLIC = (arg('--public-base') || BASE).replace(/\/$/, '');
const JSON_OUT = arg('--json', null);
const MD_OUT = arg('--md', null);
const HTML_OUT = arg('--html', null);
const ARCHIVE = process.argv.includes('--archive');
const KEEP = process.argv.includes('--keep-fixtures');
if (!BASE) {
  console.error('必填：--base <浏览器能打开的地址>');
  process.exit(2);
}
// 缺凭据 / 缺浏览器不再直接退出：照样产出整张表，全部标「未执行」并写清缺什么。
// 只回一句话就收工，读的人看不出哪些功能没被验、该找谁补。
const PRECONDITION = !process.env.MAP_USER || !process.env.MAP_PASSWORD
  ? '缺少 MAP_USER / MAP_PASSWORD 环境变量，没有登录态就只能测到匿名那一层'
  : (!chromium ? '找不到 playwright / playwright-core，这条验收必须真的开浏览器，不许降级成 curl' : null);
const CHROME = process.env.CHROME_BIN
  || (fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-'))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
    : undefined);

/** 验收用的站点形态。加一种形态 = 加一行，不用改流程。
 *  html 与 markdown 是本次事故的两条真实分叉（前者走 srcDoc、后者曾被判据排除掉）。 */
const FORMS = [
  {
    key: 'html',
    title: '[每日验收] HTML 站',
    file: 'acceptance-html.html',
    body: '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>验收 HTML</title></head>'
      + '<body><h1>每日验收 · HTML 站</h1><p>这一段文字就是判据：它必须出现在分享页的 iframe 里。</p>'
      + '<p>如果这里是空的，说明托管站点的渲染链断了。</p></body></html>',
    // 判据从「字数够」升级为「我上传的那句话真的出现在里面」——
    // 跨源存储返回的 403/404 错误文档也有字，字数够不能证明托管站点还活着。
    marker: '这一段文字就是判据',
    minChars: 30,
    // 文本形态：必须真的读出那句话才算数，不许退到像素证据蒙混过关。
    // 像素兜底是给 PDF / 视频这类插件渲染的包装站留的（innerText 本来就是空的），
    // 用在文本形态上等于把「一张彩色的 200 占位页」也判成健康。
    textual: true,
  },
  {
    key: 'markdown',
    title: '[每日验收] Markdown 站',
    file: 'acceptance-md.md',
    body: '# 每日验收 · Markdown 站\n\n这一段文字就是判据：它必须出现在分享页的 iframe 里。\n\n'
      + '- MD 站会被后端包装成一层 HTML 壳子\n- 这层壳子曾经被判据一刀切排除，导致整页白屏\n\n'
      + '> 如果这里是空的，说明包装站的取正文链路又断了。\n',
    marker: '这一段文字就是判据',
    minChars: 30,
    textual: true,
  },
];

/**
 * 页面级「有没有东西」判据。按业务功能台账（stable-smoke/reference/business-function-catalog.json）
 * 里的 P0 功能线挑，再按真实数据量排序 —— 只挑读路径，写入与计费类不放进日常例程
 * （生图/视频要花钱、要清理，属于 48 小时那一轮的事）。
 *
 * anchor 是这一屏「渲染成功才会出现」的字样。选常驻文案，不要选依赖数据的字段：
 * 数据一变判据就假红，假红几次之后没人再看这份报告。
 */
//
// anchor 一律不许为 null。原先这三条写 null + minChars 60，判据数的又是整个
// document.body —— 而常驻外壳（顶部告警条 + 左侧那一排导航）本身就远超 60 字，
// 于是这三项**无论路由自己渲没渲染出来都是绿的**。
// 采样坐实过：/document-store 在等待 9 秒时 main 里只有 6 个字（工作区还没出来），
// 整页 103 字照样判通过；/visual-agent 连 main 元素都没有，也照样通过。
//
// 所以锚点必须是「这一屏自己渲染成功才会出现」的字样，且不能出现在外壳里
// （外壳只有告警条与导航：首页/百宝箱/工作流/统计/市场/资源/涌现/模型/团队/
// 知识库/网页/设置/海报/VOC —— 下面这些都不在其中）。
//
// 锚点还必须是**这条路由自己的**字样，不能与外壳导航重名。/web-pages 原先用「网页托管」，
// 而 navRegistry 里这一项的 label 逐字就是「网页托管」——左侧导航常驻渲染，
// 于是路由渲不渲染这条锚点都命中，80 字门槛也由外壳独自满足。判据换成路由内才有的
// 「资产库」，并把取证范围收进 scope 里（见下面 checkPageAlive）。
// 同类交叉核对由 scripts/tests/daily-acceptance-anchors.test.mjs 机械保证。
const PAGES = [
  { key: 'shell',      route: '/',               anchor: '选一个智能体开始创作',   minChars: 60, label: '首页与导航外壳',
    featureLine: 'navigation-shell', id: 'DAILY-SHELL-01' },
  { key: 'web-pages',  route: '/web-pages',      anchor: '资产库',               minChars: 80, label: '网页托管主控台',
    scope: '[data-acceptance-scope="web-pages"]', featureLine: 'web-hosting-sharing', id: 'DAILY-WEB-01' },
  { key: 'doc-store',  route: '/document-store', anchor: '新建知识库',           minChars: 60, label: '知识库首页',
    featureLine: 'knowledge-assets', id: 'DAILY-KB-01' },
  { key: 'defect',     route: '/defect-agent',   anchor: '提交缺陷',             minChars: 60, label: '缺陷管理',
    featureLine: 'defect-management', id: 'DAILY-DEFECT-01' },
  // 锚点跟着改版走：旧文案「AI 驱动的设计助手，让创作更简单」在视觉创作改版时被删掉了
  // （理由见 .design/visual-agent-home/canvas.json：放到任何产品上都成立，等于没说），
  // 而这里没跟着改，于是页面好好的却天天判红。换成改版后的主标题——它是这条路由独有的。
  { key: 'visual',     route: '/visual-agent',   anchor: '今天做什么图？',         minChars: 60, label: '视觉创作工作区',
    featureLine: 'visual-creation', id: 'DAILY-VISUAL-01' },
  // 以下 2026-10-03 随「每日验收覆盖全部核心功能线」补上。锚点取自各页面自己的标题 / 按钮，
  // 都不在左侧导航 label 里（守卫会交叉核对）。
  { key: 'video',      route: '/video-agent',    anchor: '先看见故事，再开始生成', minChars: 40, label: '视频创作工作台',
    featureLine: 'video-creation', id: 'DAILY-VIDEO-01' },
  { key: 'literary',   route: '/literary-agent', anchor: '新建文件夹和文章',       minChars: 40, label: '文学创作作品列表',
    featureLine: 'literary-creation', id: 'DAILY-LIT-01' },
  { key: 'open-platform', route: '/open-platform', anchor: '邮箱通道',            minChars: 40, label: '开放平台',
    featureLine: 'llm-gateway', id: 'DAILY-GW-01' },
  { key: 'notifications', route: '/?panel=notifications', anchor: '站内通知、待处理事项与外部推送订阅', minChars: 40,
    label: '站内通知面板', featureLine: 'map-notifications', id: 'DAILY-NOTIFY-01' },
];

/**
 * 只读接口判据：每条都断言到「业务数据真的回来了」，不是只看 HTTP 200。
 * assert 返回 null 表示通过，返回字符串就是给人读的失败原因。
 * 选的都是会真打 Mongo / 真解析模型池的接口——后端一崩、模型池一空，这里立刻红。
 */
const API_CHECKS = [
  { id: 'DAILY-AUTH-02', featureLine: 'identity-access', title: '登录后能取到当前用户与权限',
    path: '/api/authz/me',
    assert: (d) => (d?.username === process.env.MAP_USER ? null : `返回的用户是「${d?.username}」，不是登录的那个账号`),
    observed: (d) => `当前用户 ${d.displayName || d.username}，${(d.effectivePermissions || []).length} 项权限`,
    next: '会话建立了却取不到用户：查 authz 接口与 users 集合' },
  { id: 'DAILY-KB-02', featureLine: 'knowledge-assets', title: '知识库列表能从数据库读出来',
    path: '/api/document-store/stores?page=1&pageSize=5',
    assert: (d) => (typeof d?.total === 'number' ? null : '响应里没有 total，列表结构变了'),
    observed: (d) => `共 ${d.total} 个知识库`,
    next: '列表读不出来：查文档空间接口日志与 Mongo 连接' },
  { id: 'DAILY-REC-02', featureLine: 'recording', title: '录音转写的整理风格能取到',
    path: '/api/document-store/transcribe-styles',
    assert: (d) => ((d?.items || []).length ? null : '整理风格是空的，录音结束后无从选择'),
    observed: (d) => `${d.items.length} 种整理风格`,
    next: '风格注册表为空：查 DocumentStore 转写风格的配置' },
  { id: 'DAILY-VIDEO-02', featureLine: 'video-creation', title: '视频项目能读出来、视频模型池非空',
    path: '/api/video-agent/models',
    assert: (d) => (Array.isArray(d) && d.length ? null : '视频模型池是空的，点生成必然失败'),
    observed: (d) => `视频模型 ${d.length} 个`,
    next: '去模型网关给视频创作挂上可用的逻辑模型' },
  { id: 'DAILY-VIDEO-03', featureLine: 'video-creation', title: '视频生成记录能读出来',
    path: '/api/video-agent/runs?limit=5',
    assert: (d) => (typeof d?.total === 'number' ? null : '响应里没有 total'),
    observed: (d) => `历史生成 ${d.total} 次`,
    next: '查 video-agent runs 接口日志' },
  { id: 'DAILY-LIT-02', featureLine: 'literary-creation', title: '文学创作作品能读出来、对话模型池非空',
    path: '/api/literary-agent/config/models/chat',
    assert: (d) => (Array.isArray(d) && d.length ? null : '文学创作的对话模型池是空的，流式创作必然失败'),
    observed: (d) => `对话模型 ${d.length} 个`,
    next: '去模型网关给文学创作挂上可用的对话模型' },
  { id: 'DAILY-VISUAL-02', featureLine: 'visual-creation', title: '生图模型池非空',
    path: '/api/visual-agent/image-gen/models',
    assert: (d) => (Array.isArray(d) && d.length ? null : '生图模型池是空的，点生成必然失败'),
    observed: (d) => `生图模型 ${d.length} 个`,
    next: '去模型网关给视觉创作挂上可用的生图模型（返回 503 时先看网关是否在线）' },
  { id: 'DAILY-VISUAL-03', featureLine: 'visual-creation', title: '视觉创作工作区能读出来',
    path: '/api/visual-agent/image-master/workspaces?limit=5',
    assert: (d) => (Array.isArray(d?.items) ? null : '响应里没有 items'),
    observed: (d) => `读到 ${d.items.length} 个工作区`,
    next: '查 image-master 工作区接口日志与 Mongo' },
  { id: 'DAILY-MULTI-01', featureLine: 'multi-image-creation', title: '多图参考（视觉理解 + 图生图）模型池非空',
    path: '/api/visual-agent/image-gen/models/vision',
    assert: (d) => (Array.isArray(d) && d.length ? null : '多图参考用的视觉模型池是空的'),
    observed: (d) => `视觉理解模型 ${d.length} 个`,
    next: '去模型网关给视觉创作的 vision 场景挂上模型' },
  { id: 'DAILY-MULTI-02', featureLine: 'multi-image-creation', title: '图生图模型池非空',
    path: '/api/visual-agent/image-gen/models/img2img',
    assert: (d) => (Array.isArray(d) && d.length ? null : '图生图模型池是空的，带参考图生成必然失败'),
    observed: (d) => `图生图模型 ${d.length} 个`,
    next: '去模型网关给视觉创作的 img2img 场景挂上模型' },
  { id: 'DAILY-WEB-05', featureLine: 'web-hosting-sharing', title: '托管站点列表能读出来',
    path: '/api/web-pages?limit=5',
    assert: (d) => (typeof d?.total === 'number' ? null : '响应里没有 total'),
    observed: (d) => `共 ${d.total} 个站点`,
    next: '查 web-pages 列表接口日志' },
  { id: 'DAILY-NOTIFY-02', featureLine: 'map-notifications', title: '站内通知列表能读出来',
    path: '/api/dashboard/notifications',
    assert: (d) => (Array.isArray(d?.items) ? null : '响应里没有 items'),
    observed: (d) => `${d.items.length} 条通知`,
    next: '查 dashboard/notifications 接口与 admin_notifications 集合' },
];

const results = [];
/** 所有结果都经由 outcome() 构造：异常 / 未执行不写下一步，直接抛错（见 lib/daily-report.mjs）。 */
const record = (p) => {
  const r = outcome(p);
  results.push(r);
  console.log(`[${{ pass: '正常', fail: '异常', warn: '需关注', 'not-run': '未执行' }[r.status]}] ${r.title}${r.observed ? ` —— ${r.observed}` : ''}`);
  return r;
};
const link = (route) => `${PUBLIC}${route}`;

/** 截一张小图进报告。截不到不影响判定（截图是证据，不是判据）。 */
async function thumb(page) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 45 });
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch { return ''; }
}

async function api(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

async function login() {
  const r = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: process.env.MAP_USER, password: process.env.MAP_PASSWORD, clientType: 'admin' },
  });
  const d = r.json?.data;
  if (!r.json?.success || !d?.accessToken) {
    throw new Error(`登录失败（HTTP ${r.status}）：${r.json?.error?.message || '无响应体'}`);
  }
  return d;
}

/** 找到（或建出）这一形态的验收站点。复用已有的，避免每天堆一堆垃圾站点。 */
async function ensureSite(token, form) {
  // 按标题让服务端筛，不要拉一页回来自己找。
  // 这里原先写的是 `?pageSize=200`——而这个端点的参数叫 `limit`，`pageSize` 被直接忽略，
  // 实际只拿回默认的 50 条最新站点。等验收站点被新站点挤出这 50 条，这里就找不到它，
  // 于是每天再建一个同名的：账号越攒越脏，而且验收的是随便哪一个重名副本。
  // keyword 走服务端正则匹配 Title，不受窗口大小影响。
  const q = new URLSearchParams({ keyword: form.title, limit: '200' });
  const list = await api(`/api/web-pages?${q}`, { token });
  const hit = (list.json?.data?.items || []).find((s) => s.title === form.title);
  if (hit) return hit;

  const tmp = path.join(os.tmpdir(), form.file);
  fs.writeFileSync(tmp, form.body);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(tmp)]), form.file);
  fd.append('title', form.title);
  const up = await api('/api/web-pages/upload', { method: 'POST', token, form: fd });
  if (!up.json?.success) throw new Error(`上传 ${form.key} 验收站点失败：${up.json?.error?.message || up.status}`);
  return up.json.data;
}

/** 找到（或建出）一条**公开**分享链接：验收要覆盖匿名访客真正走的那条路。 */
async function ensureShare(token, site) {
  // 必须按站点问。这个端点不带 siteId 时按时间只返回最近 100 条（服务端 Limit(100)），
  // 这个站点的分享落在窗口外就会被当成「没有」，下面 forceNew 每天再建一条公开链接：
  // 账号越攒越脏，而且验的是随便哪一条重复链接。原先还带了个 pageSize，那个端点根本不认。
  const mine = await api(`/api/web-pages/shares?siteId=${encodeURIComponent(site.id)}`, { token });
  // 查不通就停手，别把「没查到」和「没查成」混成一件事：后者往下走 forceNew 会每天
  // 多建一条公开链接，而这正是上面按站点查要防的。一步分享面板那边是同样的处置。
  if (!mine.json?.success) {
    throw new Error(`查分享链接失败：${mine.json?.error?.message || mine.status}`);
  }
  const hit = (mine.json?.data?.items || []).find(
    (l) => l.siteId === site.id && l.visibility === 'public' && !l.isRevoked && !l.isExpired,
  );
  if (hit) return hit;
  const created = await api('/api/web-pages/share', {
    method: 'POST', token,
    body: { siteId: site.id, shareType: 'single', title: site.title, expiresInDays: 30, visibility: 'public', forceNew: true },
  });
  if (!created.json?.success) throw new Error(`建分享链接失败：${created.json?.error?.message || created.status}`);
  return created.json.data;
}

/** 分享页的产物判据：iframe 不能停在 about:blank，里面必须真的有字。 */
async function checkShareArtifact(ctx, form, token4Url) {
  const shareUrl = `${BASE}/s/wp/${token4Url}`;
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() < 400) return;
    // 本站的失败照记；**跨源的也要记**，只要它是某个 frame 的主文档。
    // 原先只认 u.startsWith(BASE)：直连 iframe 指向 COS，那边回 403/404 错误文档时
    // 这里视而不见，而错误文档本身也有字、字数还能超过下限——于是托管站点明明打不开，
    // 这条验收照样绿。把「不是我们家的响应」等同于「与我们无关」是错的。
    const isFrameDoc = r.request().resourceType() === 'document';
    if (u.startsWith(BASE)) bad.push(`${r.status()} ${u.slice(BASE.length).slice(0, 60)}`);
    else if (isFrameDoc) bad.push(`${r.status()} 跨源文档 ${u.slice(0, 60)}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 60)}`));
  await page.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  // LLM 无关的静态站点，但服务端要去 COS 取原文；给足时间，别用超时假装成失败
  await page.waitForTimeout(12000);
  const mode = await page.evaluate(() => {
    const f = document.querySelector('iframe');
    if (!f) return 'no-iframe';
    return f.getAttribute('srcdoc') != null ? 'srcDoc' : (f.getAttribute('src') ? 'direct' : 'about:blank');
  });

  // 正文字数**必须**真的数出来，两种 mode 都一样。
  //
  // 原先走 iframe.contentDocument：直连（跨源）那一支必然抛异常、被记成 'cross-origin'，
  // 而判据把「mode === 'direct'」本身当成通过——于是这个脚本要防的那条回归
  // （直连 iframe 白屏）它自己永远抓不到：只要没有同源请求报错就是绿的。
  // 拿一份不成立的证据当成了「已渲染」的证明。
  //
  // Playwright 的 frame 是跨源可进的（和页面里的 JS 不同），所以直接问那一帧要正文，
  // 两种 mode 同一个判据，不再有「这一支免检」的后门。
  //
  // 字数与标记**一次读完**：认的是「我上传的那句话」，不是「有多少字」——错误文档、
  // 占位页、别人的内容都可能字数够，只有这句话出现才证明我传上去的那份正文被渲染了。
  // 两件事读同一帧、同一时刻，就不会出现「字数是这一帧的、标记是另一时刻的」这种错位；
  // 分两次读还多一个必须自己守住的顺序（上一版就是把第二次读排到了 page.close() 之后，
  // 于是它必然抛异常、markerHit 恒为 false，每条文本形态的验收永远红）。
  const inner = page.frames().find((f) => f !== page.mainFrame());
  let chars = null;
  let markerHit = false;
  if (inner) {
    try {
      const read = await inner.evaluate((m) => {
        const t = document.body.innerText.replace(/\s+/g, '');
        return { chars: t.length, markerHit: m ? t.includes(m) : false };
      }, form.marker ? form.marker.replace(/\s+/g, '') : null);
      chars = read.chars;
      markerHit = read.markerHit;
    } catch (e) {
      chars = `读不到(${String(e.message).slice(0, 40)})`;
    }
  }

  // 文字够了就算数；一个字都取不到时**不能直接判绿，也不能直接判红**——
  // direct 这一支用于 PDF / 视频这类包装站，它们在 iframe 里是插件渲染，
  // innerText 本来就是空的。对它们要求文字会造成假红（比漏判更烦人：
  // 假红几次之后没人再看这份报告）。所以退到像素证据：把 iframe 那块截下来，
  // 看它是不是一整片同色。白屏 = 一种颜色；真渲染出东西 = 必然有多种颜色。
  let pixels = null;
  if (!form.textual && (typeof chars !== 'number' || chars < form.minChars)) {
    const el = await page.$('iframe');
    if (el) pixels = await distinctColorCount(el);
  }
  const probe = { mode, chars, pixels };
  const shot = await thumb(page);
  // 关页必须排在**所有**取证之后：页一关，帧就没了，之后任何 evaluate 都只会抛异常，
  // 而那种异常长得跟「页面真的没内容」一模一样，判据会永远红。
  await page.close();

  const textOk = markerHit && typeof chars === 'number' && chars >= form.minChars;
  // 像素兜底只对**非文本形态**开放。文本形态的正文本来就该读得出来，一旦读不出就是坏了；
  // 允许它退到「有 8 种颜色」会让一张彩色的 HTTP 200 占位页、客户端错误页、甚至别人的文档
  // 都判成健康——那正是这条验收要防的形态。
  const pixelOk = !form.textual && typeof pixels === 'number' && pixels >= 8;
  const ok = mode !== 'about:blank' && mode !== 'no-iframe' && (textOk || pixelOk);
  const pass = ok && bad.length === 0;
  record({
    id: `DAILY-WEB-SHARE-${form.key}`,
    featureLine: 'web-hosting-sharing',
    title: `匿名访客打开 ${form.key === 'html' ? 'HTML' : 'Markdown'} 站的分享链接能看到正文`,
    method: '以未登录访客打开公开分享链接，读 iframe 里的正文，必须出现上传时写进去的那句话',
    status: pass ? 'pass' : 'fail',
    observed: pass ? `正文 ${probe.chars} 字，上传的那句话出现了`
      : (markerHit ? `正文出来了但页面有异常：${bad.slice(0, 2).join(' / ')}` : `分享页里没有看到上传的正文（${probe.mode === 'about:blank' || probe.mode === 'no-iframe' ? '内容框是空的' : `正文 ${probe.chars} 字`}）`),
    next: '这是白屏回归：先看分享页的托管内容能否从对象存储取到，再看渲染链路（srcDoc / 直连）',
    link: `${PUBLIC}/s/wp/${token4Url}`,
    shot,
    tech: `mode=${probe.mode} chars=${probe.chars} marker=${markerHit}${probe.pixels != null ? ` pixels=${probe.pixels}` : ''}${bad.length ? ` errors=${bad.join(' / ')}` : ''}`,
  });
}

const checkboxResult = (ok, observed, shot) => ({
  id: 'DAILY-WEB-02', featureLine: 'web-hosting-sharing', title: '主控台的批量勾选框真的点得动',
  method: '用真实鼠标移到勾选框上按下再松开（不用程序化点击，它会绕过遮挡判断），看右栏是否进入「选中的站点」',
  status: ok ? 'pass' : 'fail', observed,
  next: '勾选框可能又被悬浮条盖住了：在主控台上手点一次复现，再查卡片悬浮条的层级',
  link: link('/web-pages'), shot,
});
const popoverResult = (ok, observed, shot) => ({
  id: 'DAILY-WEB-03', featureLine: 'web-hosting-sharing', title: '站点卡上的「分享」能就地展开下拉',
  method: '鼠标移到站点卡上，在悬浮条里用真实鼠标点「分享」，下拉里必须出现生成链接或分享设置',
  status: ok ? 'pass' : 'fail', observed,
  next: '在主控台上手点一次「分享」复现，再查悬浮条按钮与下拉的挂载',
  link: link('/web-pages'), shot,
});

/**
 * 主控台的批量勾选：必须用真实指针序列。
 * 程序化 `.click()` 会绕过命中测试 —— 上一次就是这样让「勾选框被 hover 条盖死」溜过去的。
 */
async function checkCheckboxHittable(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/web-pages`, { waitUntil: 'domcontentloaded' });
  // 等元素本身出现，别拿一个固定秒数当「加载好了」：8s 在慢一点的那次就不够，
  // 报出来是「页面上找不到勾选框」——一条会随网络快慢翻来翻去的判据，比没有更糟。
  const box = await page.waitForSelector('button[aria-label="选择"]', { timeout: 25000, state: 'visible' })
    .then((h) => h.boundingBox())
    .catch(() => null);
  if (!box) {
    record(checkboxResult(false, '等了 25 秒页面上仍然没有勾选框', await thumb(page)));
    await page.close();
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const railHead = await page.evaluate(() => {
    const aside = [...document.querySelectorAll('aside')].pop();
    return (aside?.innerText || '').split('\n')[0] || '';
  });
  const shot = await thumb(page);
  await page.close();
  record(checkboxResult(railHead.includes('选中的站点'), `点完后右栏首行是「${railHead}」`, shot));
}

/**
 * 分享入口：点卡片上的「分享」必须就地展开下拉，而且下拉里得有能拿到链接的东西。
 *
 * 这是网页托管最常走的那条路（分享是这个功能存在的理由）。同样用真实指针序列：
 * 下拉锚在 hover 条里的按钮上，程序化点击既不触发 hover 也绕过命中测试，
 * 测出来的绿灯不作数。
 */
async function checkSharePopover(ctx) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(e.message.slice(0, 60)));
  await page.goto(`${BASE}/web-pages`, { waitUntil: 'domcontentloaded' });

  const card = await page.waitForSelector('[data-hoverbar]', { timeout: 25000 })
    .then((h) => h.boundingBox())
    .catch(() => null);
  if (!card) {
    record(popoverResult(false, '等了 25 秒页面上仍然没有站点卡', await thumb(page)));
    await page.close();
    return;
  }
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.waitForTimeout(400);
  const btn = await page.locator('button[aria-label="分享"], button[aria-label^="管理分享"]').first().boundingBox().catch(() => null);
  if (!btn) {
    record(popoverResult(false, '鼠标移到站点卡上，悬浮条里没有分享按钮', await thumb(page)));
    await page.close();
    return;
  }
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const text = await page.evaluate(() => document.body.innerText);
  const shot = await thumb(page);
  await page.close();
  // 两种形态都算开：没链接时是「生成链接并复制」，有链接时是那几行设置
  const opened = text.includes('生成链接并复制') || text.includes('谁能打开');
  record(popoverResult(opened && bad.length === 0,
    opened ? (bad.length ? `下拉开了，但页面有脚本异常：${bad[0]}` : '下拉展开，能拿到分享链接') : '点完没有出现分享下拉', shot));
}

/**
 * 一屏「打开了但是空的」判据。
 * 只断言三件事：正文有字、自家域名没有 4xx、没有 pageerror。
 * 不断言具体数字或条数 —— 那些随数据变，会制造假红。
 */
/**
 * 一块区域到底渲染出东西没有——真解出像素，数有多少种不同颜色。
 *
 * 用途：给「取不到文字」的内容（PDF / 视频这类插件渲染，innerText 本来就是空的）
 * 当证据，替代原先「跨源读不到就当它是对的」那条免检后门。
 *
 * 为什么必须真解像素：先前写过一版偷懒的——在 PNG 压缩字节上取样数不同字节值。
 * 那是假判据：空白图压缩后的字节同样杂乱，照样会判成「有内容」，
 * 等于把这一轮要修的毛病原样又犯一次。所以这里老老实实解 zlib + 反滤波。
 *
 * 只回答「是不是一整片同色」，不做像素级比对——阈值取得很松。
 */
function distinctColors(png) {
  // IHDR 固定在文件头之后：宽高各 4 字节，随后位深、颜色类型
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  // Playwright 截图恒为 8 位、非隔行；不是这个形状就明说不支持，不猜
  if (bitDepth !== 8 || interlace !== 0) return { error: `不支持的PNG(bit=${bitDepth} interlace=${interlace})` };
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (channels < 0) return { error: `不支持的颜色类型(${colorType})` };

  // 把所有 IDAT 块拼起来再解压
  const chunks = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(png.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));

  // 逐扫描线反滤波（PNG 五种滤波器）
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }

  // 抽样数颜色：每隔若干像素取一个，够区分「纯色」与「有内容」即可
  const seen = new Set();
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let i = 0; i < width * height; i += step) {
    const o = i * channels;
    seen.add(channels === 1 ? out[o] : (out[o] << 16) | (out[o + 1] << 8) | out[o + 2]);
    if (seen.size >= 256) break;
  }
  return { colors: seen.size, width, height };
}

async function distinctColorCount(elementHandle) {
  const buf = await elementHandle.screenshot({ type: 'png' });
  const r = distinctColors(buf);
  return r.error ? r.error : r.colors;
}

async function checkPageAlive(ctx, page4) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && r.status() >= 400) bad.push(`${r.status()} ${u.slice(BASE.length).slice(0, 50)}`);
  });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message.slice(0, 50)}`));
  // 等锚点真的出现，而不是干等固定秒数。
  // 固定 9 秒有两种坏法：慢的路由还没渲染完就被判（/document-store 就是 9 秒时空的、
  // 20 秒才出来），快的路由白等。等锚点则「慢就多等一会儿、真没有才红」。
  //
  // scope 声明了「这一屏自己那块 DOM」。声明了就只在那里面找锚点、只数那里面的字：
  // 外壳（导航 + 告警条）本身有上百字，在 body 上数等于路由渲不渲染都够。
  // 没声明 scope 的路由退回整页——那是明确的降级，只在锚点确实为路由独有时才成立。
  const needle = page4.anchor.replace(/\s+/g, '');
  // readScoped 在 ./lib/scoped-text.mjs —— 拆出去是为了让守卫能真的执行它，
  // 而不是只能扫源码字面量。它会被序列化成源码丢进浏览器，约束见那个文件的注释。
  let appeared = false;
  let final = null;
  let shot = '';
  // 这一段任何一步抛出，page 都必须关掉：漏掉的页会把隧道连接一直攥着，
  // 于是「一条用例坏」滚成「后面每条都 goto 超时」，红的原因被彻底盖住。
  try {
    await page.goto(`${BASE}${page4.route}`, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const read = await page.evaluate(readScoped, [page4.scope || null, needle]);
      if (read?.hit) { appeared = true; break; }
      await page.waitForTimeout(500);
    }
    final = await page.evaluate(readScoped, [page4.scope || null, null]);
    shot = await thumb(page);
  } finally {
    await page.close().catch(() => {});
  }
  const text = { length: final?.chars ?? 0 };

  const enough = text.length >= page4.minChars;
  const anchored = appeared;
  const ok = enough && anchored && bad.length === 0;
  record({
    id: page4.id,
    featureLine: page4.featureLine,
    title: `${page4.label}能打开并渲染出内容`,
    method: `登录后打开 ${page4.route}，等这一屏自己才有的字样「${page4.anchor}」出现（最多 25 秒），且页面没有报错`,
    status: ok ? 'pass' : 'fail',
    observed: ok ? `「${page4.anchor}」出现，正文 ${text.length} 字`
      : (!anchored ? `等了 25 秒没看到「${page4.anchor}」，页面可能白屏或卡在加载`
        : (bad.length ? `内容出来了，但页面有报错：${bad.slice(0, 2).join(' / ')}` : `内容太少（${text.length} 字）`)),
    next: !anchored
      ? '先在浏览器里打开这一屏看是白屏还是改了文案；改了文案就同步本脚本 PAGES 里的锚点'
      : '按报错里的接口去 api 容器日志找对应请求',
    link: link(page4.route),
    shot,
    tech: `chars=${text.length} anchor=${anchored}${bad.length ? ` errors=${bad.join(' / ')}` : ''}`,
  });
}

/**
 * 知识库「+」菜单里的三个入口：录音转笔记、上传文件、解析短视频。
 * 这三条功能线（录音 / 文件解析 / 短视频解析）的每日判据就是「入口真的在、真的点得开」——
 * 真转录、真解析要花钱且要清理，归 48 小时那一轮。
 *
 * 只**单击**一次「+」：双击会直接开始录音（会去要麦克风权限）。
 * 菜单只在点开后才渲染，所以这一步同时证明了按钮没被遮挡、点击能响应。
 */
async function checkCreateMenu(ctx) {
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(e.message.slice(0, 60)));
  const seen = { rec: false, upload: false, video: false };
  let shot = '';
  let reason = '';
  let cover = null;
  let coverShot = '';
  let fabFound = false;
  try {
    await page.goto(`${BASE}/document-store`, { waitUntil: 'domcontentloaded' });
    const fab = await page.waitForSelector('[data-tour-id="doc-create-fab"]', { timeout: 25000, state: 'visible' })
      .then((h) => h.boundingBox()).catch(() => null);
    if (!fab) {
      reason = '等了 25 秒页面上没有右下角的「+」按钮';
    } else {
      fabFound = true;
      // 先问命中测试：鼠标落点上最顶层的元素是不是「+」自己。
      // 2026-10-03 实测「周报提交提醒」浮窗整块盖在「+」上，真实鼠标点进了浮窗，
      // 菜单当然不出来——那不是三个入口坏了，是一个遮挡问题，要单独报、写清是谁盖的。
      // 报完把那层浮窗挪开再验入口，免得一个提醒浮窗把三条功能线都误报成异常。
      const cx = fab.x + fab.width / 2;
      const cy = fab.y + fab.height / 2;
      cover = await page.evaluate(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        if (!top || top.closest('[data-tour-id="doc-create-fab"]')) return null;
        // 找到盖住它的那一整块浮层（最外层的 fixed 祖先），取它的首行字当名字
        let layer = top;
        for (let el = top; el && el !== document.body; el = el.parentElement) {
          if (getComputedStyle(el).position === 'fixed') layer = el;
        }
        const name = (layer.innerText || top.innerText || top.tagName).trim().split('\n').filter(Boolean).slice(0, 2).join(' ');
        layer.setAttribute('data-acceptance-cover', '1');
        return name.slice(0, 40) || top.tagName;
      }, [cx, cy]);
      if (cover) {
        coverShot = await thumb(page);
        await page.evaluate(() => document.querySelector('[data-acceptance-cover]')?.style.setProperty('display', 'none', 'important'));
      }
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(900);
      const hasText = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
      seen.rec = await hasText('录音转笔记');
      // 「上传与导入」是分组，子项要再点开一层
      const group = await page.getByText('上传与导入', { exact: true }).first().boundingBox().catch(() => null);
      if (group) {
        await page.mouse.move(group.x + group.width / 2, group.y + group.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(60);
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      seen.upload = await hasText('上传文件');
      seen.video = await hasText('解析短视频');
      if (!seen.rec && !group) reason = '点完「+」菜单没有展开';
      else if (!group) reason = '菜单里没有「上传与导入」分组';
    }
    shot = await thumb(page);
  } finally {
    await page.close().catch(() => {});
  }
  const common = {
    method: '在知识库首页用真实鼠标单击右下角「+」，菜单里必须出现这个入口（「上传与导入」分组要再点开一层）',
    link: link('/document-store'),
    shot,
    tech: `rec=${seen.rec} upload=${seen.upload} video=${seen.video}${bad.length ? ` errors=${bad.join(' / ')}` : ''}`,
  };
  const one = (id, featureLine, title, hit) => record({
    ...common, id, featureLine, title,
    status: hit && !bad.length ? 'pass' : 'fail',
    observed: hit ? (bad.length ? `入口在，但页面有脚本异常：${bad[0]}` : '入口在，点得开') : (reason || '点开「+」后菜单里没有这一项'),
    next: '在知识库首页手点一次「+」复现，再查 CreatePaletteFab 的菜单项与权限判断',
  });
  record({
    id: 'DAILY-KB-03', featureLine: 'knowledge-assets', title: '知识库右下角「+」没有被其他浮层盖住',
    method: '取「+」按钮中心点，问浏览器那个位置最上层的元素是不是它自己（真实用户点下去点到的就是那个元素）',
    // 按钮压根没出现时不能因为「没找到遮挡物」判成正常（Codex 在 PR #1655 指出）
    status: !fabFound ? 'fail' : (cover ? 'warn' : 'pass'),
    observed: !fabFound ? (reason || '页面上没有右下角的「+」按钮')
      : (cover ? `「+」被「${cover}」盖住，用户得先关掉它才点得到` : '「+」在最上层，点得到'),
    next: !fabFound
      ? '在知识库首页确认「+」是否还在；没了就查 CreatePaletteFab 的挂载条件与权限判断'
      : '让这个浮层避开右下角的主操作按钮（挪位置或在知识库页收起），否则用户点「+」会点进浮层',
    link: link('/document-store'),
    shot: coverShot,
    tech: cover ? `elementFromPoint 命中 ${cover}` : '',
  });
  one('DAILY-REC-01', 'recording', '知识库「+」里有「录音转笔记」入口', seen.rec);
  one('DAILY-FILE-01', 'file-parsing', '知识库「+」里有「上传文件」入口', seen.upload);
  one('DAILY-SHORTVIDEO-01', 'short-video-parsing', '知识库「+」里有「解析短视频」入口', seen.video);
}

/** checkCreateMenu 一次产出的全部结果。它整体抛异常时，这几项要一起记失败，不能只记第一项。 */
const CREATE_MENU_RESULTS = [
  { id: 'DAILY-KB-03', featureLine: 'knowledge-assets', title: '知识库右下角「+」没有被其他浮层盖住' },
  { id: 'DAILY-REC-01', featureLine: 'recording', title: '知识库「+」里有「录音转笔记」入口' },
  { id: 'DAILY-FILE-01', featureLine: 'file-parsing', title: '知识库「+」里有「上传文件」入口' },
  { id: 'DAILY-SHORTVIDEO-01', featureLine: 'short-video-parsing', title: '知识库「+」里有「解析短视频」入口' },
];

/** 只读接口：每条都断言业务数据，不止 HTTP 200。 */
async function runApiChecks(token) {
  for (const c of API_CHECKS) {
    let r;
    try {
      r = await api(c.path, { token });
    } catch (e) {
      record({ id: c.id, featureLine: c.featureLine, title: c.title, method: `登录后请求 ${c.path}`,
        status: 'fail', observed: `请求没发出去：${e.message.slice(0, 60)}`, next: '确认被测环境与隧道还在', tech: c.path });
      continue;
    }
    const why = r.json?.success ? c.assert(r.json.data) : `接口返回失败（HTTP ${r.status}）：${r.json?.error?.message || '无可读原因'}`;
    record({
      id: c.id, featureLine: c.featureLine, title: c.title,
      method: `登录后请求 ${c.path}，断言返回的业务数据（不只看 HTTP 200）`,
      status: why ? 'fail' : 'pass',
      observed: why || c.observed(r.json.data),
      next: c.next,
      tech: `GET ${c.path} -> ${r.status}${r.json?.error?.code ? ` ${r.json.error.code}` : ''}`,
    });
  }
}

/** 后端深度自检：服务自己跑一遍关键链路后申报的结论，逐项归到功能线。 */
async function checkDeepHealth() {
  const r = await api('/api/healthz/deep').catch((e) => ({ status: 0, json: null, text: e.message }));
  const checks = r.json?.checks;
  if (!checks || typeof checks !== 'object') {
    record({ id: 'DEEP-endpoint', featureLine: 'platform-runtime', title: '后端深度自检能读到',
      method: '请求 /api/healthz/deep（免登录，application/health+json）',
      status: 'fail', observed: `自检端点没有给出结论（HTTP ${r.status}）`,
      next: '后端可能没起来或版本太旧：看 CDS 上 api 容器的状态与日志', tech: String(r.text || '').slice(0, 120) });
    // 已登记的各项也要逐条落表：否则模型目录契约这类项整个消失，所在功能线会被
    // 其他检查判成「正常」（Codex 在 PR #1655 指出）
    for (const key of Object.keys(DEEP_CHECK_MAP)) record(deepCheckOutcome(key, undefined, { endpointDown: true }));
    return null;
  }
  for (const [key, val] of Object.entries(checks)) {
    for (const c of (Array.isArray(val) ? val : [val])) record(deepCheckOutcome(key, c));
  }
  // 已登记、但这次自检里没出现的项：不能静默跳过（Codex 在 PR #1655 指出）。
  // 否则自检一改名或删掉某项，同一功能线上的其他项照样把那一行判成「正常」。
  for (const key of Object.keys(DEEP_CHECK_MAP)) {
    if (!(key in checks)) record(deepCheckOutcome(key, undefined));
  }
  return r.json;
}

/**
 * 48 小时稳定冒烟自己还在不在跑。它是真生成闭环的唯一判据，它停了，
 * 「每日只读 + 48 小时真生成」这套分工就塌了一半，而且不会有任何东西变红。
 * 读 CDS 验收中心里最近一份「核心业务稳定冒烟」报告的时间与结论。
 */
function checkStableSmokeFreshness() {
  const base = {
    id: 'DAILY-STABLE-01', featureLine: 'stability-foundation',
    title: '48 小时稳定冒烟按时跑了、且最近一轮通过',
    method: '查 CDS 验收中心里最近一份「核心业务稳定冒烟」报告：50 小时内没有就是停跑了；结论不通过算异常、部分通过算需关注',
  };
  let items;
  try {
    const out = execFileSync('python3', [path.join(REPO, '.claude/skills/cds/cli/cdscli.py'), 'report', 'list', '--project', 'prd-agent'],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = JSON.parse(out).data;
    items = Array.isArray(d) ? d : (d?.reports || d?.items || []);
  } catch (e) {
    record({ ...base, status: 'not-run', observed: '读不到 CDS 验收中心（缺 CDS 凭据或 CDS 不可达）',
      next: '确认运行环境里有 CDS_HOST 与 CDS 凭据，cdscli report list 能跑通', tech: String(e.message).slice(0, 160) });
    return;
  }
  const latest = items
    // 只认运行器自己的标题格式（scripts/stable-smoke-run.mjs：「核心业务稳定冒烟 <runId>」）。
    // 原先含「稳定冒烟」就算，会把「发布验收 · 核心业务稳定冒烟」这类别的报告当成心跳。
    // 已知边界：定时与手动运行的报告目前没有字段可区分，见 doc/debt.acceptance.daily-anchors.md
    .filter((x) => /^核心业务稳定冒烟 stsmk-/.test(x.title || ''))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!latest) {
    record({ ...base, status: 'fail', observed: 'CDS 验收中心里找不到任何稳定冒烟报告', next: '检查 stable-smoke-48h 本地自动化是否还在、是否改了报告标题' });
    return;
  }
  const hours = (Date.now() - Date.parse(latest.createdAt)) / 3600000;
  const verdict = { pass: '通过', conditional: '部分通过', fail: '不通过' }[latest.verdict] || latest.verdict || '未知';
  const stale = hours > 50;
  record({
    ...base,
    // 停跑或不通过 = 异常；按时跑了但只部分通过（有项没执行）= 需关注
    status: stale || latest.verdict === 'fail' ? 'fail' : (latest.verdict === 'pass' ? 'pass' : 'warn'),
    observed: `最近一轮在 ${hours.toFixed(0)} 小时前，结论「${verdict}」${stale ? '，已经超过 48 小时没跑' : ''}`,
    next: stale ? '48 小时那一轮停了：检查 stable-smoke-48h 本地自动化是否还在运行' : '打开那份报告看「执行覆盖账本」里没通过 / 没执行的项',
    link: cdsDeepLink(latest.id),
    tech: `${latest.title} · ${latest.createdAt}`,
  });
}

/** 被测环境本身：首页、版本、对象存储就绪。这一步不过，后面整张表都标「未执行」并写明原因。 */
async function checkEnvironment() {
  const head = await fetch(`${BASE}/`).then((r) => r.status).catch(() => 0);
  const ver = await api('/api/version').catch(() => ({ status: 0 }));
  const ready = await api('/api/health/ready').catch(() => ({ status: 0 }));
  const commit = ver.json?.commit ? String(ver.json.commit).slice(0, 8) : '';
  const up = head === 200 && ver.status === 200;
  record({
    id: 'ENV-01', featureLine: 'environment', title: '被测环境可达', fatal: true,
    method: '请求首页与 /api/version',
    status: up ? 'pass' : 'fail',
    observed: up ? `首页 200，运行版本 ${commit}` : `首页 HTTP ${head || '连不上'}，版本接口 HTTP ${ver.status || '连不上'}`,
    next: '去 CDS 看 main 分支预览的状态；容器崩了就重新部署（cdscli branch deploy prd-agent-main）',
    link: PUBLIC,
  });
  if (!up) return null;
  // 只认 asset-storage 这个组件自己的结论，外加写入与公网读取都真的验证过——不看顶层 status：
  // 那是应用级汇总（ApplicationReadiness），存储挂了它未必跟着变（Codex 在 PR #1655 指出）。
  // 专用的 /health/assets/ready 不走公网 /api 反代，打过去落到前端页面，所以从这里取组件明细。
  const comps = Array.isArray(ready.json?.components) ? ready.json.components : null;
  const storage = comps?.find((c) => c?.name === 'asset-storage');
  const notReady = (comps || []).filter((c) => c?.ready !== true).map((c) => c?.name);
  const storageOk = storage?.ready === true && ready.json?.writeVerified === true && ready.json?.publicReadVerified === true;
  record({
    id: 'ENV-02', featureLine: 'environment', title: '对象存储读写就绪',
    method: '请求 /api/health/ready，断言其中 asset-storage 组件就绪，且后端真写入、真经公网读回过一次',
    status: storageOk ? 'pass' : 'fail',
    observed: !comps ? `就绪接口没有给出组件明细（HTTP ${ready.status}）`
      : storageOk ? `${ready.json?.provider || ''} 写入与公网读取均已验证`
        : `对象存储未就绪${notReady.length ? `（未就绪组件：${notReady.join('、')}）` : ''}，写入验证=${ready.json?.writeVerified}，公网读取验证=${ready.json?.publicReadVerified}`,
    next: '对象存储不可用会让上传、托管、截图全部失败：查存储凭据与桶',
    tech: `GET /api/health/ready -> ${ready.status} status=${ready.json?.status}`,
  });
  return commit;
}

/** 前置失败时，把还没跑的检查项全部登记成「未执行」，整张表照样产出。 */
function markRemainingNotRun(reason, next) {
  const done = new Set(results.map((r) => r.id));
  const planned = [
    ...FORMS.map((f) => ({ id: `DAILY-WEB-SHARE-${f.key}`, featureLine: 'web-hosting-sharing', title: `匿名访客打开 ${f.key === 'html' ? 'HTML' : 'Markdown'} 站的分享链接能看到正文` })),
    ...PAGES.map((p4) => ({ id: p4.id, featureLine: p4.featureLine, title: `${p4.label}能打开并渲染出内容` })),
    { id: 'DAILY-AUTH-01', featureLine: 'identity-access', title: '验收账号能用账号密码登录' },
    ...API_CHECKS.map((c) => ({ id: c.id, featureLine: c.featureLine, title: c.title })),
    ...CREATE_MENU_RESULTS,
    { id: 'DAILY-WEB-02', featureLine: 'web-hosting-sharing', title: '主控台的批量勾选框真的点得动' },
    { id: 'DAILY-WEB-03', featureLine: 'web-hosting-sharing', title: '站点卡上的「分享」能就地展开下拉' },
    { id: 'DAILY-STABLE-01', featureLine: 'stability-foundation', title: '48 小时稳定冒烟按时跑了、且最近一轮通过' },
    // 自检读到了就有逐项结果、没有 DEEP-endpoint 那一行；一项都没读到才补「能读到」那一行
    ...(results.some((r) => r.id.startsWith('DEEP-'))
      ? [] : [{ id: 'DEEP-endpoint', featureLine: 'platform-runtime', title: '后端深度自检能读到' }]),
    ...Object.entries(DEEP_CHECK_MAP).map(([key, m]) => ({ id: `DEEP-${key}`, featureLine: m.featureLine, title: m.title })),
  ];
  for (const p of planned) {
    if (!done.has(p.id)) record({ ...p, method: '—', status: 'not-run', observed: reason, next });
  }
}

// ── 主流程 ──
let exitCode = 0;
const startedAt = new Date().toISOString();
let commit = '';
let browser;
try {
  commit = await checkEnvironment();
  if (commit === null) {
    checkStableSmokeFreshness(); // 查的是 CDS，不依赖被测环境
    markRemainingNotRun('被测环境不可达，没能开始验', '先恢复被测环境（见「被测环境可达」那一行），再手动重跑本脚本');
    exitCode = 2;
  } else {
    await checkDeepHealth();
    checkStableSmokeFreshness();
    if (PRECONDITION) {
      record({ id: 'ENV-03', featureLine: 'environment', title: '验收账号与浏览器就绪', method: '检查环境变量与 playwright',
        status: 'fail', observed: PRECONDITION, next: '在运行环境补齐凭据或依赖后重跑' });
      markRemainingNotRun(PRECONDITION, '补齐后重跑本脚本');
      exitCode = 2;
    } else {
      let session;
      try {
        session = await login();
        record({ id: 'DAILY-AUTH-01', featureLine: 'identity-access', title: '验收账号能用账号密码登录',
          method: '请求 /api/v1/auth/login，必须拿到访问令牌', status: 'pass',
          observed: `以 ${session.user?.displayName || session.user?.username} 登录成功` });
      } catch (e) {
        record({ id: 'DAILY-AUTH-01', featureLine: 'identity-access', title: '验收账号能用账号密码登录',
          method: '请求 /api/v1/auth/login，必须拿到访问令牌', status: 'fail', observed: e.message,
          next: '账号被锁 / 改密 / 关闭了密码登录：在用户管理里核对验收账号状态' });
        markRemainingNotRun('登录失败，后面的检查都需要登录态', '先修好登录（见「验收账号能用账号密码登录」那一行）');
        exitCode = 2;
      }
      if (session) {
        await runApiChecks(session.accessToken);
        browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
        const auth = {
          state: {
            isAuthenticated: true, user: session.user, token: session.accessToken,
            refreshToken: session.refreshToken, sessionKey: session.sessionKey,
            permissions: [], permissionsLoaded: false, isRoot: session.user?.role === 'ADMIN', menuCatalog: [],
          },
          version: 0,
        };
        const ctx = await browser.newContext({
          viewport: { width: 1600, height: 1000 },
          storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'prd-admin-auth', value: JSON.stringify(auth) }] }] },
        });
        // 每一步各自兜住：一条用例抛异常只让它自己那一行变红，不拖垮整张表
        // 一个检查可能产出多项结果：抛异常时它名下还没落表的每一项都记失败、带原因
        // （只记第一项，其余就成了没原因的空行——Codex 在 PR #1655 指出）
        const guard = async (fallbacks, fn) => {
          const list = Array.isArray(fallbacks) ? fallbacks : [fallbacks];
          try { await fn(); } catch (e) {
            const done = new Set(results.map((x) => x.id));
            for (const fb of list) {
              if (!done.has(fb.id)) record({ ...fb, method: '—', status: 'fail', observed: `检查过程抛异常：${e.message.slice(0, 80)}`, next: '先手动重跑一次排除抖动；稳定复现就按异常信息查' });
            }
          }
        };
        for (const form of FORMS) {
          await guard({ id: `DAILY-WEB-SHARE-${form.key}`, featureLine: 'web-hosting-sharing', title: `匿名访客打开 ${form.key === 'html' ? 'HTML' : 'Markdown'} 站的分享链接能看到正文` }, async () => {
            const site = await ensureSite(session.accessToken, form);
            const share = await ensureShare(session.accessToken, site);
            await checkShareArtifact(ctx, form, share.token);
          });
        }
        for (const p4 of PAGES) {
          await guard({ id: p4.id, featureLine: p4.featureLine, title: `${p4.label}能打开并渲染出内容` }, () => checkPageAlive(ctx, p4));
        }
        await guard(CREATE_MENU_RESULTS, () => checkCreateMenu(ctx));
        await guard({ id: 'DAILY-WEB-02', featureLine: 'web-hosting-sharing', title: '主控台的批量勾选框真的点得动' }, () => checkCheckboxHittable(ctx));
        await guard({ id: 'DAILY-WEB-03', featureLine: 'web-hosting-sharing', title: '站点卡上的「分享」能就地展开下拉' }, () => checkSharePopover(ctx));
        await ctx.close();
      }
    }
  }
} catch (e) {
  record({ id: 'ENV-99', featureLine: 'environment', title: '验收脚本自身运行', method: '—', status: 'fail',
    observed: `脚本在前置阶段抛异常：${e.message.slice(0, 120)}`, next: '这是验收工具的问题不是产品问题：按异常修脚本后重跑' });
  markRemainingNotRun('验收脚本前置阶段出错', '修好脚本后重跑');
  exitCode = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
}
// 兜底：无论走了哪条路径，计划里的每一项都必须出现在表里。没跑到的明说没跑到，
// 不许因为某段流程中途退出就从报告里静默消失（Codex 在 PR #1655 连续两轮指出同一形状）
markRemainingNotRun('本轮检查中途中断，这一项没跑到', '看本次运行日志里中断前的最后一条输出，修好后重跑');

const summary = summarize({
  results, catalog: CATALOG, exempt: DAILY_EXEMPT, extraLines: EXTRA_LINES,
  base: PUBLIC, at: startedAt, env: commit ? `运行版本 ${commit}` : '',
});
const failed = results.filter((r) => r.status !== 'pass');
console.log(`\n合计 ${results.length} 项检查，${failed.length} 项不是「正常」`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ base: PUBLIC, at: startedAt, verdict: summary.verdict, results }, null, 1));
let reportUrl = '';
// HTML 版只给本地看（CDS 对执行类 HTML 有模板准入）；归档进 CDS 的是完整版 Markdown。
if (HTML_OUT) fs.writeFileSync(HTML_OUT, renderHtml(summary));
if (ARCHIVE) {
  const fullPath = path.join(os.tmpdir(), `daily-acceptance-${Date.now()}.md`);
  fs.writeFileSync(fullPath, renderMarkdown(summary, { full: true }));
  reportUrl = archive(fullPath, summary, commit);
  fs.rmSync(fullPath, { force: true });
}
const md = renderMarkdown(summary, { reportUrl });
if (MD_OUT) fs.writeFileSync(MD_OUT, md);
console.log(`\n${md}`);
if (!KEEP) console.log('\n（网页托管的验收站点会复用，不重复创建；要清理就去主控台删掉标题带「[每日验收]」的那几个）');
if (exitCode === 0 && summary.verdict !== 'pass') exitCode = 1;
// 要求了归档却没归档成：证据没落地，计划任务不能当成功（Codex 在 PR #1655 指出）
if (ARCHIVE && !reportUrl && exitCode === 0) exitCode = 1;
process.exit(exitCode);

/** CDS 报告的直达深链只认 cdscli 给的（CLAUDE.md §11：不自己拼地址）。拿不到就留空。 */
function cdsDeepLink(id) {
  if (!id) return '';
  try {
    const out = execFileSync('python3', [path.join(REPO, '.claude/skills/cds/cli/cdscli.py'), 'report', 'deeplink', id],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out)?.data?.url || '';
  } catch { return ''; }
}

/** 归档进 CDS 验收中心，返回直达深链。归档失败如实报，不回退成本地文件交付。 */
function archive(mdPath, s, sha) {
  const cli = path.join(REPO, '.claude/skills/cds/cli/cdscli.py');
  const day = s.at.slice(0, 10);
  try {
    const out = execFileSync('python3', [cli, 'report', 'create',
      '--title', archiveTitle(s),
      '--html-file', mdPath, '--format', 'md', '--project', 'prd-agent', '--folder-path', `每日核心功能验收/${day.slice(0, 7)}`,
      '--verdict', s.verdict, '--tier', '每日只读冒烟', '--branch', 'main', ...(sha ? ['--commit', sha] : [])],
    { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = JSON.parse(out);
    const id = d?.data?.id || d?.data?.report?.id;
    const url = cdsDeepLink(id);
    console.log(url ? `已归档 CDS 验收中心：${url}` : `已归档，但没拿到深链：${out.slice(0, 200)}`);
    return url || '';
  } catch (e) {
    console.error(`归档 CDS 验收中心失败：${String(e.stderr || e.message).slice(0, 300)}`);
    return '';
  }
}
