#!/usr/bin/env node
// 设计稿件发布门禁（程序判定，不靠智能体）。智能体只负责产出稿件包；不满足规则，程序直接驳回，不发布。
// 用法：node gate.mjs --expect <这次要发布的版本号> [--dir <稿件目录>]（默认当前目录）
// 退出码：0 通过；1 驳回（逐条列出违反的规则）；2 参数错误。
// 规则编号固定（G-01 到 G-12），驳回信息里写编号，智能体按编号修，修完重跑，直到通过。
// G-12 交接场景：标了 interaction 的验收项都要有场景覆盖，结构和 CDS 服务端（design-package.ts 的 parseDesignHandoffPlan）一致，
//   并且本地已用 CDS 同一个运行器跑通（handoff-run.mjs 写的 checks/handoff.json，绑定这份原型和这组场景）。
// G-01 到 G-09 按 CDS 发布接口校验，G-11 共用同一程序（技能 reference/design-intake.md「发布门禁」），本地先驳回，省一次往返。
// 稿件自己的例外登记在 <稿件目录>/tools/gate-allow.json（CDS 只认这个位置）。
// 不能出现在稿件包里的真实站点，用环境变量 CDS_DESIGN_FORBIDDEN_HOSTS（逗号分隔）传入，不必写进稿件包。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { designAcceptancePolicy, inspectDesignAcceptance } from '../../cli/design-acceptance-standard.mjs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(opt('dir') ?? '.');
const expect = Number(opt('expect'));
if (!Number.isInteger(expect) || expect < 1) { console.error('用法：node gate.mjs --expect <版本号> [--dir <稿件目录>]'); process.exit(2); }
if (!existsSync(path.join(root, 'design.json'))) { console.error(`${root} 里没有 design.json`); process.exit(2); }

const errors = [];
const reject = (rule, message) => errors.push(`${rule} ${message}`);
const read = rel => readFileSync(path.join(root, rel), 'utf8');
const readJson = rel => { try { return JSON.parse(read(rel)); } catch { return undefined; } };
const walk = (rel = '') => readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(entry => {
  const sub = rel ? `${rel}/${entry.name}` : entry.name;
  return entry.isDirectory() ? (['node_modules', '.git'].includes(entry.name) ? [] : walk(sub)) : [sub];
});
const files = walk();
const allowFile = files.includes('tools/gate-allow.json') ? 'tools/gate-allow.json' : undefined;
if (files.includes('gate-allow.json')) reject('G-05', '例外登记要放在 tools/gate-allow.json，CDS 不认根目录的 gate-allow.json');
const allow = (allowFile && readJson(allowFile)) ?? { checks: [] };

/* G-01 稿件清单能解析，必填字段齐全、类型正确（CDS 必需：project、title、framework、screens；思路和原型有默认路径） */
const d = readJson('design.json');
if (!d) reject('G-01', 'design.json 无法解析');
const required = { project: 'string', title: 'string', framework: 'string', prototypeVersion: 'number', date: 'string', screens: 'array', acceptance: 'array' };
const optional = { id: 'string', frameworkVersion: 'number', rationale: 'string', prototype: 'string',
  checks: 'string', docs: 'array', notes: 'string', source: 'string' };
const typeOf = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
if (d) {
  for (const [key, type] of Object.entries(required)) if (typeOf(d[key]) !== type) reject('G-01', `design.json 缺少或类型不对：${key}（应为 ${type}）`);
  for (const [key, type] of Object.entries(optional)) if (d[key] !== undefined && typeOf(d[key]) !== type) reject('G-01', `design.json 类型不对：${key}（应为 ${type}）`);
  if (typeof d.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) reject('G-01', 'date 要用 YYYY-MM-DD');
  if (typeof d.prototypeVersion === 'number' && !(Number.isInteger(d.prototypeVersion) && d.prototypeVersion > 0)) reject('G-01', 'prototypeVersion 要是正整数');
  /* 有源码目录就要声明 source：CDS 按声明的目录算源码差异，没声明时本地按 src/ 算、服务端按无源码算，两边的差异摘要就对不上
   * （2026-11-27 DSN-2A3B7293 V2 被 G-07「差异摘要与实际稿件变化不符」拒绝） */
  if (d.source === undefined && files.some(f => f.startsWith('src/'))) reject('G-01', 'design.json 要写 source（源码目录，例如 "src"）：CDS 按它计算源码差异');
  if (typeof d.source === 'string' && !files.some(f => f.startsWith(d.source.replace(/\/+$/, '') + '/'))) reject('G-01', `source 指向的目录不存在：${d.source}`);
  /* 演示数据和 CDS 服务端的格式一致：{ files, sha256, note }，sha256 是各文件按 LF 规范化后依次拼接的摘要 */
  if (d.demoData !== undefined) {
    const demo = d.demoData;
    if (!Array.isArray(demo?.files) || !demo.files.length || typeof demo.sha256 !== 'string') reject('G-01', 'demoData 要写成 { files: [...], sha256, note }');
    else if (demo.files.some(f => !files.includes(f))) reject('G-01', `demoData 列的文件不存在：${demo.files.filter(f => !files.includes(f)).join('、')}`);
    else {
      const digest = createHash('sha256').update(Buffer.concat(demo.files.map(f => Buffer.from(read(f).replace(/\r\n/g, '\n'))))).digest('hex');
      if (digest !== demo.sha256) reject('G-01', `demoData.sha256 和文件内容对不上（应为 ${digest}）`);
    }
  }
}
const rationale = d?.rationale ?? '思路.md';
const prototype = d?.prototype ?? 'dist/index.html';
const checksFile = d?.checks ?? (files.includes('checks/result.json') ? 'checks/result.json' : undefined);

/* G-02 画面：编号唯一、地址以 #/ 开头、视口和主题合法、交互入口是选择器列表。规则和 CDS 服务端（design-package.ts）一致 */
const screens = Array.isArray(d?.screens) ? d.screens : [];
const screenIds = new Set();
if (d && !screens.length) reject('G-02', '至少要有一个画面');
/* CDS 服务端：画面清单最多 80 个（design-package.ts：list(input.screens, '画面清单', 80)） */
if (screens.length > 80) reject('G-02', `画面 ${screens.length} 个，超过 CDS 上限 80`);
for (const s of screens) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id ?? '')) reject('G-02', `画面编号不合法：${s.id}`);
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120) reject('G-02', `${s.id} 的名称要有，且不超过 120 字`);
  if (screenIds.has(s.id)) reject('G-02', `画面编号重复：${s.id}`); screenIds.add(s.id);
  if (typeof s.route !== 'string' || !s.route.startsWith('#/')) reject('G-02', `${s.id} 的地址要以 #/ 开头`);
  if (!['desktop', 'phone'].includes(s.viewport)) reject('G-02', `${s.id} 的视口只能是 desktop 或 phone`);
  if (!Array.isArray(s.themes) || !s.themes.length || s.themes.some(t => !['light', 'dark'].includes(t))) reject('G-02', `${s.id} 的主题只能是 light、dark`);
  if (s.entryActions !== undefined && (!Array.isArray(s.entryActions) || s.entryActions.length > 6 || s.entryActions.some(a => typeof a !== 'string' || !a.trim() || a.length > 300))) reject('G-02', `${s.id} 的 entryActions 必须是不超过 6 个、每个不超过 300 字的选择器`);
  /* CDS 服务端要求每个画面都有就绪选择器，不只是有交互入口的画面 */
  if (typeof s.entryReadySelector !== 'string' || !s.entryReadySelector.trim()) reject('G-02', `${s.id} 要写 entryReadySelector（每个画面都要，CDS 用它判断画面已就绪）`);
}

/* G-03 验收项：不超过 60 条（CDS 上限）、编号唯一、指向存在的画面、写了规则；测量项写清楚测什么。级别、适用视口、文字长度和 CDS 服务端一致 */
const slotIds = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'];
const acceptance = Array.isArray(d?.acceptance) ? d.acceptance : [];
if (acceptance.length > 60) reject('G-03', `验收项 ${acceptance.length} 条，超过 CDS 上限 60`);
const ruleIds = new Set();
for (const a of acceptance) {
  /* 和 CDS 服务端一致：编号是 A-xx；每条都要引用画面、写预期和适用视口 */
  if (!/^A-\d{2,3}$/.test(a.id ?? '')) reject('G-03', `验收项编号要写成 A-01 这样：${a.id}`);
  if (ruleIds.has(a.id)) reject('G-03', `验收项编号重复：${a.id}`); ruleIds.add(a.id);
  if (!a.screenId) reject('G-03', `${a.id} 要引用一个画面（screenId）`);
  else if (!screenIds.has(a.screenId)) reject('G-03', `${a.id} 指向不存在的画面：${a.screenId}`);
  if (!(a.expected ?? '').trim()) reject('G-03', `${a.id} 要写预期（expected）`);
  if (!['measure', 'human', 'screenshot'].includes(a.how)) reject('G-03', `${a.id} 的检查方式只能是 measure、human、screenshot`);
  if (!(a.rule ?? '').trim()) reject('G-03', `${a.id} 要写规则`);
  if ((a.rule ?? '').length > 600 || (a.expected ?? '').length > 800) reject('G-03', `${a.id} 的规则不超过 600 字、预期不超过 800 字`);
  if (a.priority !== undefined && !['normal', 'high'].includes(a.priority)) reject('G-03', `${a.id} 的级别只能是 normal 或 high，现在是 ${a.priority}`);
  if (a.slots !== undefined && (!Array.isArray(a.slots) || !a.slots.length || a.slots.some(x => !slotIds.includes(x)))) reject('G-03', `${a.id} 的适用视口和主题只能是 ${slotIds.join('、')}`);
  if (a.probe !== undefined && (a.how !== 'measure' || a.probe?.type !== 'horizontal-overflow')) reject('G-03', `${a.id} 的 probe 只能用于测量项，类型是 horizontal-overflow`);
  if (a.how === 'measure' && !a.probe && !/检查：/.test(a.expected ?? '')) reject('G-03', `${a.id} 是测量项，要有 probe，或在预期里写「检查：」说明测什么`);
}

/* G-11 与 CDS 发布接口共用验收计划和覆盖检查。 */
if (d) for (const issue of inspectDesignAcceptance(d)) {
  reject(designAcceptancePolicy.gate, `${issue.field}${issue.ruleId ? '（' + issue.ruleId + '）' : ''} ${issue.message}`);
}

/* G-04 清单里引用的文件都在 */
for (const rel of [rationale, prototype, checksFile, d?.source, ...(Array.isArray(d?.docs) ? d.docs : [])].filter(Boolean)) {
  if (!files.includes(rel) && !files.some(f => f.startsWith(`${rel.replace(/\/$/, '')}/`))) reject('G-04', `清单引用的文件不存在：${rel}`);
}

/* G-05 自检：结果能解析，数目自洽；没通过（含未验证）的项必须在 gate-allow.json 里登记负责人和理由 */
let r;
if (checksFile) {
  r = readJson(checksFile);
  if (!r) reject('G-05', '自检结果无法解析');
  else {
    const items = Array.isArray(r.items) ? r.items : [];
    const passed = x => x.pass === true || ['pass', 'passed'].includes(x.status);
    const name = x => x.name ?? x.id ?? x.rule;
    if (r.total !== items.length || r.passed !== items.filter(passed).length) reject('G-05', `自检计数和条目对不上：${r.passed}/${r.total}，条目 ${items.filter(passed).length}/${items.length}`);
    for (const x of items.filter(x => !passed(x))) {
      const hit = (allow.checks ?? []).find(a => a.name === name(x));
      if (!hit) reject('G-05', `自检未通过且没有登记：${name(x)}${x.status ? `（${x.status}）` : ''}`);
      else if (!hit.owner || !hit.reason) reject('G-05', `登记的例外要写负责人和理由：${name(x)}`);
    }
  }
}

/* G-06 版本号一致：思路（和交付说明，如有）的一级标题写这次要发布的版本；交付说明里没有占位符 */
for (const rel of [rationale, '交付说明.md']) {
  if (!files.includes(rel)) continue;
  const title = read(rel).match(/^#\s+(.+)$/m)?.[1] ?? '';
  if (!title.includes(`（V${expect}）`)) reject('G-06', `${rel} 的一级标题要写「（V${expect}）」，现在是：${title || '没有一级标题'}`);
}
if (files.includes('交付说明.md') && /__[A-Z]+__|TODO|待填/.test(read('交付说明.md'))) reject('G-06', '交付说明里有占位符');

/* G-07 版本连续、差异齐全：版本号接着 versions.json；有旧版本时，changes/index.json 写到这一版，覆盖每个旧版本，文件都在 */
const registry = readJson('versions.json');
const registered = registry?.versions ?? [];
/* 和 CDS 发布接口一致：新稿件（V1）也要带 versions.json 和 changes/index.json，索引指向这一版、覆盖登记的全部历史（V1 时为空） */
if (!registry) reject('G-07', expect === 1 ? '缺少 versions.json：先运行 release.mjs check 生成' : `缺少 versions.json。已发布过的稿件先登记最新已发布版本：node release.mjs register --dir <稿件目录> --design <稿件编号> --version ${expect - 1} --commit <来源提交>`);
else {
  const last = registered.at(-1)?.version ?? 0;
  if (expect !== last + 1) reject('G-07', `要发布的版本必须是 V${last + 1}（versions.json 登记到 V${last}）`);
  {
    const index = readJson('changes/index.json');
    if (!index) reject('G-07', '缺少 changes/index.json（用 changes-index.mjs 生成）');
    else {
      if (index.to !== expect) reject('G-07', `changes/index.json 写的是到 V${index.to}，应为 V${expect}`);
      for (const v of registered) {
        const row = (index.from ?? []).find(x => x.version === v.version);
        if (!row) { reject('G-07', `changes/index.json 缺少 V${v.version} → V${expect}`); continue; }
        for (const rel of row.files ?? []) if (!files.includes(rel)) reject('G-07', `差异文件不存在：${rel}`);
      }
    }
  }
}

/* G-08 隐私：稿件包只放虚构数据。不出现真实站点、邮箱、密钥样式的字符串 */
const textExt = /\.(md|json|ts|tsx|jsx|mjs|js|css|html|diff|txt|ya?ml|svg)$/;
/* 和 CDS 服务端（cds/src/services/design-publication-gate.ts）逐字一致：只有 PEM 头也算。
 * 原型里带私钥占位提示的正式模块（例如没改动的设置页签），用 prototype.json 的 stubs 换成占位 */
const secret = /(?<![A-Za-z0-9_])(?:cds[kp]_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/* 写成赋值的凭据（Bearer 头、apiKey/secret/token/password/projectKey = "…"），不区分大小写；和上面分开，免得把上面的规则也变成不区分大小写 */
const assigned = /(Bearer\s+[A-Za-z0-9._~+/-]{24,}|(?:api[_-]?key|secret|token|password|projectKey)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{16,}["'])/i;
const email = /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[a-z]{2,}/g;
/* 真实站点：除了环境变量和例外登记，默认禁止本机授权里的 CDS 地址（把带正式站点地址的框架资料
 * 原样拷进了包，本地没拦住，CDS 拒绝）。只读 host 一项，不读密钥。 */
const cdsHosts = process.env.CDS_HOST ? [process.env.CDS_HOST] : [];
for (let at = root; ; at = path.dirname(at)) {
  const file = path.join(at, '.cds', 'credentials.json');
  if (existsSync(file)) { try { const host = JSON.parse(readFileSync(file, 'utf8')).host; if (host) cdsHosts.push(host); } catch { /* 读不了就跳过 */ } break; }
  if (path.dirname(at) === at) break;
}
const hostOf = value => { try { return new URL(value).host; } catch { return String(value).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); } };
const hosts = [...(allow.forbiddenHosts ?? []), ...String(process.env.CDS_DESIGN_FORBIDDEN_HOSTS ?? '').split(','), ...cdsHosts.map(hostOf)].map(h => h.trim()).filter(Boolean);
const realHost = hosts.length ? new RegExp(hosts.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
for (const rel of files.filter(f => textExt.test(f) && !/\.min\.js$/.test(f) && f !== allowFile)) {
  const text = read(rel);
  if (secret.test(text) || assigned.test(text)) reject('G-08', `${rel} 含有像密钥的字符串`);
  const mail = (text.match(email) ?? []).find(m => !(allow.emails ?? []).includes(m) && !/\.(png|jpe?g|svg|webp|gif)$/i.test(m));
  if (mail) reject('G-08', `${rel} 含有邮箱：${mail}`);
  if (realHost?.test(text)) reject('G-08', `${rel} 含有真实站点地址`);
}

/* G-09 归档大小：按 zip 压缩估算，不超过 CDS 上限 4 MiB（留 5% 余量） */
const zipped = files.reduce((sum, rel) => sum + deflateRawSync(readFileSync(path.join(root, rel)), { level: 9 }).length + 100 + Buffer.byteLength(rel) * 2, 22);
if (zipped > 4 * 1024 * 1024 * 0.95) reject('G-09', `压缩后约 ${(zipped / 1048576).toFixed(2)} MiB，超过 3.8 MiB`);

/* G-10 应用框架（硬性条件）。使用手写页面、抄录令牌或登记框架规则例外会导致交付偏差。
 * 程序判定「应用了框架」：
 *   1 原型由正式前端构建（prototype-build.mjs 写的构建指纹，带基线提交）；
 *   2 原型里有框架的正式壳体（FW-CDS-UI：AppShell 的 cds-main）；
 *   3 spec/rules.md 里的每条框架规则都有通过的自检项，框架规则不能登记为例外。 */
if (d?.framework) {
  const proto = typeof d.prototype === 'string' ? d.prototype : 'dist/index.html';
  const html = files.includes(proto) ? read(proto) : '';
  const meta = html.match(/<meta name="cds-prototype-build" content='([^']+)'>/);
  let fingerprint; try { fingerprint = meta && JSON.parse(meta[1].replace(/&#39;/g, "'")); } catch { /* 解析不了就当没有 */ }
  if (fingerprint?.builder !== 'cds-design/prototype-build' || !/^[0-9a-f]{40}$/.test(fingerprint?.baseline ?? ''))
    reject('G-10', `原型不是由正式前端构建的（${proto} 没有构建指纹）。用 scripts/design/prototype-build.mjs 在正式代码上构建，不要手写 HTML、不要自己抄令牌`);
  const shellMarker = { 'FW-CDS-UI': 'cds-main' }[d.framework];
  if (shellMarker && !html.includes(shellMarker)) reject('G-10', `原型里没有 ${d.framework} 的正式壳体（${shellMarker}）：要演示的页面挂在正式的 AppShell 里`);
  /* 框架规则编号：标题（### R-01 …）或表格行（| R-01 | …），两种写法都认 */
  const ruleIdsOfFramework = [...new Set([...(files.includes('spec/rules.md') ? read('spec/rules.md') : '').matchAll(/^(?:#{2,4}\s*|\|\s*)(R-\d{2})\b/gm)].map(m => m[1]))];
  if (!ruleIdsOfFramework.length) reject('G-10', `缺少框架规则 spec/rules.md（cdscli design scaffold 会从 ${d.framework} 取下来）`);
  const checkItems = Array.isArray(r?.items) ? r.items : [];
  const ok = x => x.pass === true || ['pass', 'passed'].includes(x.status);
  const mentions = (text, id) => new RegExp(`(^|[^A-Za-z0-9-])${id}([^0-9]|$)`).test(text ?? '');
  for (const id of ruleIdsOfFramework) {
    const hits = checkItems.filter(x => mentions(`${x.ruleId ?? ''} ${x.id ?? ''} ${x.name ?? ''}`, id));
    if (!hits.length) reject('G-10', `框架规则 ${id} 没有对应的自检项（自检项的 ruleId 或名称写上 ${id}）`);
    else if (!hits.some(ok)) reject('G-10', `框架规则 ${id} 的自检没有通过：框架规则必须通过`);
  }
  for (const entry of allow.checks ?? []) if (ruleIdsOfFramework.some(id => mentions(entry.name, id))) reject('G-10', `框架规则不能登记为例外：${entry.name}`);
}

/* G-12 交接场景。CDS 对标了 interaction 的验收项要求可运行的场景，缺了就是「缺交接计划」，实施目标切不过去。
 * 结构规则逐条照 design-package.ts 的 parseDesignHandoffPlan；能不能跑通由 handoff-run.mjs 用 CDS 同一个运行器在本地跑，这里核对它的回执。 */
{
  const interaction = acceptance.filter(a => a.interaction === true);
  for (const a of acceptance) if (a.interaction !== undefined && a.interaction !== true) reject('G-12', `${a.id} 的 interaction 只能是 true`);
  const plan = d?.handoff;
  if (plan !== undefined || interaction.length) {
    const cases = Array.isArray(plan?.cases) ? plan.cases : [];
    const css = /^(?:css|text|xpath|internal:[^=]+)=|>>|[\u0000-\u001f]/i;
    const checks = ['text', 'value', 'attribute', 'visible', 'enabled', 'media-playing', 'audio-playing', 'fullscreen'];
    const reads = ['text', 'value', 'attribute'];
    /* 和服务端 designId 一致：字母、数字、下划线、点、连字符，不超过 120 字，不能是 . 或 .. */
    const idOk = v => typeof v === 'string' && v.length <= 120 && /^[A-Za-z0-9_.-]+$/.test(v) && v !== '.' && v !== '..';
    if (plan !== undefined && (typeof plan !== 'object' || Object.keys(plan).some(k => k !== 'cases'))) reject('G-12', 'handoff 只能有 cases');
    if (!cases.length) reject('G-12', `有 ${interaction.length} 条交互验收项（${interaction.map(a => a.id).join('、')}），要在 design.json.handoff.cases 写能跑通的场景`);
    if (cases.length > 24) reject('G-12', `交接场景 ${cases.length} 个，超过 CDS 上限 24`);
    const caseIds = new Set();
    for (const c of cases) {
      const where = `场景 ${c?.id ?? '?'}`;
      if (!idOk(c?.id)) reject('G-12', `${where} 的编号不合法`);
      if (caseIds.has(c?.id)) reject('G-12', `${where} 编号重复`); caseIds.add(c?.id);
      if (typeof c?.title !== 'string' || !c.title.trim() || c.title.length > 120) reject('G-12', `${where} 要有不超过 120 字的标题`);
      const screen = screens.find(s => s.id === c?.screenId);
      if (!screen) reject('G-12', `${where} 引用了不存在的画面：${c?.screenId}`);
      else if (c.theme !== undefined && !screen.themes?.includes(c.theme)) reject('G-12', `${where} 的主题要来自画面 ${screen.id} 的主题`);
      const ids = Array.isArray(c?.ruleIds) ? c.ruleIds : [];
      if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length) reject('G-12', `${where} 要关联 1 到 12 条不重复的验收项`);
      for (const id of ids) if (!ruleIds.has(id)) reject('G-12', `${where} 引用了不存在的验收项：${id}`);
      const steps = Array.isArray(c?.steps) ? c.steps : [];
      if (!steps.length || steps.length > 24) reject('G-12', `${where} 要有 1 到 24 步`);
      const remembered = new Set();
      steps.forEach((s, i) => {
        const at = `${where} 第 ${i + 1} 步`;
        if (typeof s?.selector !== 'string' || !s.selector.trim() || s.selector.length > 240 || css.test(s.selector)) reject('G-12', `${at} 的选择器要是本画面内的 CSS 选择器（不超过 240 字）`);
        if (['fill', 'select'].includes(s?.action) && (typeof s.value !== 'string' || s.value.length > 1600)) reject('G-12', `${at} 要写不超过 1600 字的值`);
        else if (s?.action === 'remember') {
          if (!reads.includes(s.check)) reject('G-12', `${at} 的 remember 只能读 text、value、attribute`);
          if (!idOk(s.as) || remembered.has(s.as)) reject('G-12', `${at} 的 as 要是本场景里不重复的编号`); else remembered.add(s.as);
        } else if (s?.action === 'expect') {
          if (!checks.includes(s.check)) reject('G-12', `${at} 的检查方式不受支持：${s.check}`);
          if (s.sameAs !== undefined && (!reads.includes(s.check) || !remembered.has(s.sameAs) || s.equals !== undefined)) reject('G-12', `${at} 的 sameAs 要引用本场景前面 remember 过的状态`);
          if (s.sameAs === undefined && reads.includes(s.check) && typeof s.equals !== 'string') reject('G-12', `${at} 读文字、值或属性时要写 equals（文字）`);
          if (s.sameAs === undefined && !reads.includes(s.check) && s.equals !== undefined && typeof s.equals !== 'boolean') reject('G-12', `${at} 的 equals 只能是 true 或 false`);
        } else if (!['click', 'attach', 'fill', 'select'].includes(s?.action)) reject('G-12', `${at} 不支持的动作：${s?.action}`);
        if (s?.check === 'attribute' && !/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(s.attribute ?? '')) reject('G-12', `${at} 要写有效的属性名`);
      });
      const acts = steps.some(s => ['click', 'fill', 'select', 'attach'].includes(s?.action));
      if (steps.at(-1)?.action !== 'expect') reject('G-12', `${where} 最后一步要是结果检查（expect）`);
      if (!acts && ids.some(id => interaction.some(a => a.id === id))) reject('G-12', `${where} 覆盖交互验收项，至少要有一步操作（click、fill、select、attach）`);
    }
    for (const a of interaction) if (!cases.some(c => (c.ruleIds ?? []).includes(a.id))) reject('G-12', `交互验收项 ${a.id} 没有场景覆盖`);
    /* 本地跑通的回执：绑定这份原型和这组场景 */
    const receipt = readJson('checks/handoff.json');
    if (cases.length) {
      const proto = path.join(root, d?.prototype ?? 'dist/index.html');
      const used = new Set(cases.map(c => c.screenId));
      const binding = existsSync(proto) ? createHash('sha256').update(readFileSync(proto)).update(JSON.stringify({ cases, screens: screens.filter(s => used.has(s.id)) })).digest('hex') : '';
      if (!receipt) reject('G-12', '没有本地跑通的回执 checks/handoff.json：先运行 handoff-run.mjs（release.mjs check 带 --checkout 或设 CDS_WEB_CHECKOUT 时会自动跑）');
      else if (receipt.binding !== binding) reject('G-12', 'checks/handoff.json 不是这份原型和这组场景跑出来的（原型或场景改过），重跑 handoff-run.mjs');
      else if (receipt.status !== 'passed' || (receipt.cases ?? []).length !== cases.length) {
        const bad = (receipt.cases ?? []).filter(x => x.status !== 'passed').map(x => `${x.caseId} 第 ${x.step ?? '?'} 步 ${x.code}`);
        reject('G-12', `交接场景本地没有全部跑通：${bad.join('；') || receipt.status}`);
      }
    }
  }
}

const digest = createHash('sha256').update(files.map(rel => rel + ':' + createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex')).join('\n')).digest('hex');
if (errors.length) {
  console.error(`驳回：${errors.length} 条不满足（V${expect}）`);
  errors.forEach(line => console.error('  ' + line));
  process.exit(1);
}
console.log(JSON.stringify({ gate: 'passed', version: expect, files: files.length, screens: screens.length, acceptance: acceptance.length,
  checks: r ? `${r.passed}/${r.total}` : null, zipMiB: Number((zipped / 1048576).toFixed(2)), digest: digest.slice(0, 16) }));
