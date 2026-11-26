#!/usr/bin/env node
// 设计稿件发布的固定流程（程序串起来，智能体不用记步骤、不用算版本号）。
//
//   node release.mjs check    [--dir <稿件目录>] [--full 1,11] [--baseline <实施基线>]
//     还会生成 交接清单.md（handoff.mjs）：按目标列验收项、相对实施基线的变化、源码和回复模板。
//     版本号 = versions.json 最后一版 + 1（没有登记过就是 V1；新稿件先写一份空的 versions.json）。
//     先生成 changes/（每个旧版本到这一版的净变化，V1 时为空索引；--full 列出的起点附完整源码差异），再跑门禁 G-01 到 G-09。
//     CDS 发布接口按同样的规则复核：版本登记和差异索引必须覆盖 CDS 里的全部历史，并指向这一版。
//     通过后打印这次该用的发布命令；驳回就按规则编号修，修完重跑。
//
//   node release.mjs register --commit <来源提交> [--design <稿件编号>] [--dir <稿件目录>]
//     发布成功后登记：核对来源提交里的稿件目录和工作区一致，写 versions.json，打本地 tag design/<稿件编号>/v<N>。
//     第一次登记（首发后，或给已有稿件补登记）要带 --design；给已有稿件补登记时再加 --version <已发布的最新版>。
//
// 退出码：0 成功；1 门禁驳回或核对不一致；2 参数错误。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = path.dirname(fileURLToPath(import.meta.url));
const [command, ...argv] = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(opt('dir') ?? '.');
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
if (!existsSync(path.join(dir, 'design.json'))) fail(`${dir} 里没有 design.json`);
const registryPath = path.join(dir, 'versions.json');
const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { versions: [] };
const last = registry.versions.at(-1)?.version ?? 0;
const run = (script, args) => spawnSync(process.execPath, [path.join(tools, script), ...args], { stdio: 'inherit' }).status ?? 1;

if (command === 'check') {
  const version = last + 1;
  if (!existsSync(registryPath)) {
    /* 和 cdscli design scaffold 写的一样；稿件编号和路径到 register 时再写（CDS 不接受空的稿件编号） */
    writeFileSync(registryPath, JSON.stringify({ versions: [] }, null, 1) + '\n');
  }
  const full = opt('full') ?? (last ? String(registry.versions[0].version) : '');
  if (run('changes-index.mjs', ['--dir', dir, '--to', String(version), ...(full ? ['--full', full] : [])])) fail('生成版本差异失败', 1);
  /* 交接清单：按目标生成给实现方的唯一一份清单；基线取 --baseline，没给就取 --full 的第一个起点 */
  const baseline = Number(opt('baseline') ?? String(full).split(',')[0]);
  /* 首版（没有旧版本）也生成：基线记为 0，所有验收项算新增 */
  if (Number.isInteger(baseline) && baseline >= 0 && baseline < version && run('handoff.mjs', ['--dir', dir, '--to', String(version), '--from', String(baseline)])) process.exit(1);
  if (run('gate.mjs', ['--dir', dir, '--expect', String(version)])) process.exit(1);
  const rel = path.relative(process.cwd(), dir).split(path.sep).join('/') || '.';
  console.log(last
    ? `门禁通过。发布：cdscli design publish ${registry.design} --private --intent revise --expected-version ${last} --dir ${rel} --note "<本版修改>"`
    : '门禁通过。首发：cdscli design publish --private --intent create --design-key <模块>/<稿件> --dir ' + rel + ' --note "<本版修改>"（或按已有稿件的接入口令续版）');
  console.log(`发布成功后：node ${path.join(tools, 'release.mjs').split(path.sep).join('/')} register --dir ${rel} --commit <来源提交>${registry.design ? '' : ' --design <发布结果里的稿件编号>'}${last ? '' : ' [--version <已发布的最新版，仅补登记时>]'}`);
} else if (command === 'register') {
  const commit = String(opt('commit') ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(commit)) fail('register 需要 --commit <来源提交>');
  const git = args => execFileSync('git', args, { cwd: dir, maxBuffer: 1 << 26 }).toString('utf8').trim();
  let full;
  try { full = git(['rev-parse', '--verify', `${commit}^{commit}`]); } catch { fail(`git 里找不到提交 ${commit}`); }
  /* 来源提交里的稿件目录必须和工作区一致：登记的就是发布的那一份 */
  const changed = git(['status', '--porcelain', '--', '.']) || git(['diff', '--name-only', full, '--', '.']);
  if (changed) fail(`来源提交 ${full.slice(0, 10)} 和工作区的稿件目录不一致（先提交，再用发布时的提交登记）：\n${changed}`, 1);
  const version = opt('version') ? Number(opt('version')) : last + 1;
  if (last && version !== last + 1) fail(`版本号必须接着 V${last}`);
  const status = run('version-diff.mjs', ['--dir', dir, '--register', String(version), '--commit', full, ...(opt('design') ? ['--design', opt('design')] : [])]);
  if (status) process.exit(status);
  /* 设计这一轮的结果是 CDS 上的稿件地址：登记成功后打印出来，交给用户。
   * 地址和项目取环境变量 CDS_HOST / CDS_PROJECT_ID，或仓库根目录 .cds/credentials.json 里的 host、projectId（只读这两项，不读不打印密钥）。 */
  const design = JSON.parse(readFileSync(registryPath, 'utf8')).design ?? opt('design');
  let host = process.env.CDS_HOST, project = process.env.CDS_PROJECT_ID;
  try {
    const credentials = JSON.parse(readFileSync(path.join(git(['rev-parse', '--show-toplevel']), '.cds', 'credentials.json'), 'utf8'));
    host ??= credentials.host; project ??= credentials.projectId;
  } catch { /* 没有本地授权文件时只用环境变量 */ }
  console.log(host && project && design
    ? `稿件地址：${String(host).replace(/\/+$/, '')}/design?project=${encodeURIComponent(project)}&design=${encodeURIComponent(design)}&version=${version}`
    : '没有拿到 CDS 地址或项目编号（CDS_HOST、CDS_PROJECT_ID 或 .cds/credentials.json），稿件地址请从 cdscli design list 的结果里取，并交给用户。');
} else {
  fail('用法：node release.mjs check [--dir <稿件目录>] [--full 1,11]\n      node release.mjs register --commit <来源提交> [--design <稿件编号>] [--version <N>] [--dir <稿件目录>]');
}
