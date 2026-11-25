#!/usr/bin/env node
// 设计稿件发布门禁（程序判定，不靠智能体）。智能体只负责产出稿件包；不满足规则，程序直接驳回，不发布。
// 用法：node gate.mjs --expect <这次要发布的版本号> [--dir <稿件目录>]（默认当前目录）
// 退出码：0 通过；1 驳回（逐条列出违反的规则）；2 参数错误。
// 规则编号固定（G-01 到 G-10，G-10 是应用框架），驳回信息里写编号，智能体按编号修，修完重跑，直到通过。
// 规则和 CDS 发布接口的 G-01 到 G-09 一致（技能 reference/design-intake.md「发布门禁」），本地先驳回，省一次往返。
// 稿件自己的例外登记在 <稿件目录>/tools/gate-allow.json（CDS 只认这个位置）。
// 不能出现在稿件包里的真实站点，用环境变量 CDS_DESIGN_FORBIDDEN_HOSTS（逗号分隔）传入，不必写进稿件包。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

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
}
const rationale = d?.rationale ?? '思路.md';
const prototype = d?.prototype ?? 'dist/index.html';
const checksFile = d?.checks ?? (files.includes('checks/result.json') ? 'checks/result.json' : undefined);

/* G-02 画面：编号唯一、地址以 #/ 开头、视口和主题合法、交互入口是选择器列表。规则和 CDS 服务端（design-package.ts）一致 */
const screens = Array.isArray(d?.screens) ? d.screens : [];
const screenIds = new Set();
if (d && !screens.length) reject('G-02', '至少要有一个画面');
for (const s of screens) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id ?? '')) reject('G-02', `画面编号不合法：${s.id}`);
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120) reject('G-02', `${s.id} 的名称要有，且不超过 120 字`);
  if (screenIds.has(s.id)) reject('G-02', `画面编号重复：${s.id}`); screenIds.add(s.id);
  if (typeof s.route !== 'string' || !s.route.startsWith('#/')) reject('G-02', `${s.id} 的地址要以 #/ 开头`);
  if (!['desktop', 'phone'].includes(s.viewport)) reject('G-02', `${s.id} 的视口只能是 desktop 或 phone`);
  if (!Array.isArray(s.themes) || !s.themes.length || s.themes.some(t => !['light', 'dark'].includes(t))) reject('G-02', `${s.id} 的主题只能是 light、dark`);
  if (s.entryActions !== undefined && (!Array.isArray(s.entryActions) || s.entryActions.length > 6 || s.entryActions.some(a => typeof a !== 'string' || !a.trim() || a.length > 300))) reject('G-02', `${s.id} 的 entryActions 必须是不超过 6 个、每个不超过 300 字的选择器`);
  /* CDS 服务端要求每个画面都有就绪选择器（2026-11-25 DSN-2A3B7293 首发被拒），不只是有交互入口的画面 */
  if (typeof s.entryReadySelector !== 'string' || !s.entryReadySelector.trim()) reject('G-02', `${s.id} 要写 entryReadySelector（每个画面都要，CDS 用它判断画面已就绪）`);
}

/* G-03 验收项：不超过 60 条（CDS 上限）、编号唯一、指向存在的画面、写了规则；测量项写清楚测什么。级别、适用视口、文字长度和 CDS 服务端一致 */
const slotIds = ['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark'];
const acceptance = Array.isArray(d?.acceptance) ? d.acceptance : [];
if (acceptance.length > 60) reject('G-03', `验收项 ${acceptance.length} 条，超过 CDS 上限 60`);
const ruleIds = new Set();
for (const a of acceptance) {
  /* 和 CDS 服务端一致：编号是 A-xx；每条都要引用画面、写预期和适用视口（2026-11-25 DSN-2A3B7293 首发被拒） */
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
const secret = /(cdsk_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
/* 写成赋值的凭据（Bearer 头、apiKey/secret/token/password/projectKey = "…"），不区分大小写；和上面分开，免得把上面的规则也变成不区分大小写 */
const assigned = /(Bearer\s+[A-Za-z0-9._~+/-]{24,}|(?:api[_-]?key|secret|token|password|projectKey)["']?\s*[:=]\s*["'][A-Za-z0-9._~+/-]{16,}["'])/i;
const email = /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[a-z]{2,}/g;
/* 真实站点：除了环境变量和例外登记，默认禁止本机授权里的 CDS 地址（2026-11-25 DSN-2A3B7293 把带正式站点地址的框架资料
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

/* G-10 应用框架（硬性条件）。2026-11-25 DSN-2A3B7293 的原型是手写 HTML、自己抄了一份令牌，框架规则 R-01、R-03、R-11 还被登记成了例外，
 * 门禁全部放行。现在由程序判定「应用了框架」：
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

const digest = createHash('sha256').update(files.map(rel => rel + ':' + createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex')).join('\n')).digest('hex');
if (errors.length) {
  console.error(`驳回：${errors.length} 条不满足（V${expect}）`);
  errors.forEach(line => console.error('  ' + line));
  process.exit(1);
}
console.log(JSON.stringify({ gate: 'passed', version: expect, files: files.length, screens: screens.length, acceptance: acceptance.length,
  checks: r ? `${r.passed}/${r.total}` : null, zipMiB: Number((zipped / 1048576).toFixed(2)), digest: digest.slice(0, 16) }));
