#!/usr/bin/env node
// 设计稿件发布的固定流程（程序串起来，智能体不用记步骤、不用算版本号）。
//
//   node release.mjs check    [--dir <稿件目录>] [--full 1,11] [--baseline <实施基线>] [--checkout <CDS 检出>]
//     有交互验收项或交接场景时，先用 CDS 同一个运行器在本地跑场景（handoff-run.mjs，检出取 --checkout 或 CDS_WEB_CHECKOUT），再跑门禁；门禁 G-12 核对回执。
//     还会生成 交接清单.md（handoff.mjs）：按目标列验收项、相对实施基线的变化、源码和回复模板。
//     版本号 = versions.json 最后一版 + 1（没有登记过就是 V1；新稿件先写一份空的 versions.json）。
//     先生成 changes/（每个旧版本到这一版的净变化，V1 时为空索引；--full 列出的起点附完整源码差异），再跑门禁 G-01 到 G-09。
//     CDS 发布接口按同样的规则复核：版本登记和差异索引必须覆盖 CDS 里的全部历史，并指向这一版。
//     通过后打印这次该用的发布命令；驳回就按规则编号修，修完重跑。
//
//   node release.mjs register [--workspace-credential] --commit <来源提交> [--design <稿件编号>] [--dir <稿件目录>]
//     发布成功后登记：核对来源提交里的稿件目录和工作区一致，写 versions.json，打本地 tag design/<稿件编号>/v<N>。
//     登记前由程序确认这一版真的完整（不靠智能体自觉）：
//       1. 回读：CDS 上这一版的来源提交等于 --commit，交付文件逐个和来源提交里的字节一致（cdscli design delivery）；
//       2. 交接：有交互验收项或交接场景时，CDS 的交接检查回执是「通过」（cdscli design handoff）。
//     任何一条不满足就不登记：这一版不算完成。
//     第一次登记（首发后，或给已有稿件补登记）要带 --design；给已有稿件补登记时再加 --version <已发布的最新版>。
//
// 退出码：0 成功；1 门禁驳回或核对不一致；2 参数错误。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  /* 交接场景先在本地用 CDS 同一个运行器跑；门禁 G-12 只认这份回执 */
  const manifest = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
  if (manifest.handoff || (manifest.acceptance ?? []).some(rule => rule.interaction)) {
    const checkout = opt('checkout') ?? process.env.CDS_WEB_CHECKOUT;
    if (!checkout) fail('这份稿件有交互验收项：要用 --checkout <CDS 检出>（或 CDS_WEB_CHECKOUT）在本地跑交接场景，跑通了门禁才放行', 1);
    run('handoff-run.mjs', ['--dir', dir, '--checkout', checkout]);
  }
  if (run('gate.mjs', ['--dir', dir, '--expect', String(version)])) process.exit(1);
  const rel = path.relative(process.cwd(), dir).split(path.sep).join('/') || '.';
  console.log(last
    ? `门禁通过。发布：cdscli --workspace-credential design publish ${registry.design} --private --intent revise --expected-version ${last} --dir ${rel} --note "<本版修改>"`
    : '门禁通过。首发：cdscli --workspace-credential design publish --private --intent create --design-key <模块>/<稿件> --dir ' + rel + ' --note "<本版修改>"（或按已有稿件的接入口令续版）');
  console.log('沿用默认 CLI 自检通过的环境凭据时，在同一环境执行并省略 --workspace-credential。');
  console.log(`发布成功后：node ${path.join(tools, 'release.mjs').split(path.sep).join('/')} register --workspace-credential --dir ${rel} --commit <来源提交>${registry.design ? '' : ' --design <发布结果里的稿件编号>'}${last ? '' : ' [--version <已发布的最新版，仅补登记时>]'}`);
} else if (command === 'register') {
  const commit = String(opt('commit') ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(commit)) fail('register 需要 --commit <来源提交>');
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, maxBuffer: 1 << 26 }).toString('utf8').trim();
  let full;
  try { full = git(['rev-parse', '--verify', `${commit}^{commit}`]); } catch { fail(`git 里找不到提交 ${commit}`); }
  /* 来源提交里的稿件目录必须和工作区一致：登记的就是发布的那一份 */
  const changed = git(['status', '--porcelain', '--', '.']) || git(['diff', '--name-only', full, '--', '.']);
  if (changed) fail(`来源提交 ${full.slice(0, 10)} 和工作区的稿件目录不一致（先提交，再用发布时的提交登记）：\n${changed}`, 1);
  const version = opt('version') ? Number(opt('version')) : last + 1;
  if (last && version !== last + 1) fail(`版本号必须接着 V${last}`);
  const useWorkspace = argv.includes('--workspace-credential');
  let host = process.env.CDS_HOST, project = process.env.CDS_PROJECT_ID;
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    if (useWorkspace && root !== git(['rev-parse', '--show-toplevel'], process.cwd())) {
      fail('请在已通过自检的稿件工作区登记。');
    }
    const { host: savedHost, projectId } = JSON.parse(readFileSync(path.join(root, '.cds', 'credentials.json'), 'utf8'));
    if (useWorkspace) {
      if (typeof savedHost !== 'string' || typeof projectId !== 'string' || !projectId.trim()) throw new Error();
      const url = new URL(savedHost.includes('://') ? savedHost : 'https://' + savedHost);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      if (JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8')).project !== projectId) {
        fail('稿件项目与工作区绑定不同，请核对发布回执后登记。');
      }
      host = url.origin;
      project = projectId;
    } else {
      host ??= savedHost;
      project ??= projectId;
    }
  } catch {
    if (useWorkspace) fail('当前工作区缺少有效的 CDS 主机或项目绑定，请在自检通过的工作区登记。');
  }
  /* 登记前确认这一版完整：回读逐文件一致 + CDS 交接回执通过。cdscli 在稿件工作区里用同一份凭据读 */
  {
    const designId = registry.design ?? opt('design');
    if (!designId) fail('登记要知道稿件编号：首次登记带 --design');
    const root = git(['rev-parse', '--show-toplevel']);
    const cli = path.join(tools, '..', '..', 'cli', 'cdscli.py');
    const python = process.env.CDSCLI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const cds = (...args) => {
      const out = spawnSync(python, ['-I', '-X', 'utf8', cli, ...(useWorkspace ? ['--workspace-credential'] : []), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, CDSCLI_NO_DRIFT_CHECK: '1' } });
      let body; try { body = JSON.parse(out.stdout); } catch { fail(`读取 CDS 失败：${(out.stderr || out.stdout || '').trim().slice(0, 300)}`, 1); }
      if (!body.ok) fail(`读取 CDS 失败：${body.error ?? '未知错误'}`, 1);
      return body.data ?? body;
    };
    const delivered = cds('design', 'delivery', designId, '--version', String(version));
    if (!String(delivered.sourceCommit ?? '').startsWith(full.slice(0, 10)) || !full.startsWith(String(delivered.sourceCommit ?? '').slice(0, 10))) {
      fail(`CDS 上 V${version} 的来源提交是 ${String(delivered.sourceCommit ?? '').slice(0, 10)}，不是 ${full.slice(0, 10)}：登记的必须是发布的那一份`, 1);
    }
    const rel = path.relative(root, dir).split(path.sep).join('/');
    /* 中文文件名：关掉 git 的路径转义，按 NUL 分隔 */
    const tracked = git(['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', full, '--', rel], root).split('\0').filter(Boolean).map(name => name.slice(rel.length + 1));
    const remote = new Map(((delivered.delivery ?? {}).files ?? []).map(file => [file.path, file.sha256]));
    const bad = [];
    for (const name of tracked) {
      const bytes = execFileSync('git', ['-c', 'core.autocrlf=false', 'show', `${full}:${rel}/${name}`], { cwd: root, maxBuffer: 1 << 28 });
      const local = createHash('sha256').update(bytes).digest('hex');
      if (!remote.has(name)) bad.push(`CDS 上缺少 ${name}`);
      else if (remote.get(name) !== local) bad.push(`${name} 和来源提交不一致`);
    }
    for (const name of remote.keys()) if (!tracked.includes(name)) bad.push(`CDS 上多出 ${name}`);
    if (bad.length) fail(`回读不一致（${bad.length} 处），这一版不算完成：\n  ${bad.slice(0, 12).join('\n  ')}`, 1);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
    if (manifest.handoff || (manifest.acceptance ?? []).some(rule => rule.interaction)) {
      const handoff = cds('design', 'handoff', designId, '--version', String(version)).handoff ?? {};
      if (handoff.status !== 'passed') {
        const how = ['pending', 'running', 'unavailable'].includes(handoff.status)
          ? `先运行 cdscli design handoff ${designId} --version ${version} --run，等回执是「通过」再登记`
          : '在同一稿件续版修好场景或原型，按新版的回执登记';
        fail(`CDS 交接检查是「${handoff.status ?? '没有'}」，这一版不算完成。${how}`, 1);
      }
    }
    console.log(JSON.stringify({ readback: 'identical', files: tracked.length, handoff: manifest.handoff ? 'passed' : 'none' }));
  }
  const status = run('version-diff.mjs', ['--dir', dir, '--register', String(version), '--commit', full, ...(opt('design') ? ['--design', opt('design')] : [])]);
  if (status) process.exit(status);
  const design = JSON.parse(readFileSync(registryPath, 'utf8')).design ?? opt('design');
  console.log(host && project && design
    ? `稿件地址：${String(host).replace(/\/+$/, '')}/design?project=${encodeURIComponent(project)}&design=${encodeURIComponent(design)}&version=${version}`
    : '没有拿到 CDS 地址或项目编号（CDS_HOST、CDS_PROJECT_ID 或 .cds/credentials.json），稿件地址请从 cdscli design list 的结果里取，并交给用户。');
} else {
  fail('用法：node release.mjs check [--dir <稿件目录>] [--full 1,11]\n      node release.mjs register [--workspace-credential] --commit <来源提交> [--design <稿件编号>] [--version <N>] [--dir <稿件目录>]');
}
