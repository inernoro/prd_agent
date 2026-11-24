#!/usr/bin/env node
// 设计稿件发布的固定流程（程序串起来，智能体不用记步骤、不用算版本号）。
//
//   node release.mjs check    [--dir <稿件目录>] [--full 1,11]
//     版本号 = versions.json 最后一版 + 1（没有登记过就是 V1）。
//     有旧版本时先生成 changes/（每个旧版本到这一版的净变化；--full 列出的起点附完整源码差异），再跑门禁 G-01 到 G-09。
//     通过后打印这次该用的发布命令；驳回就按规则编号修，修完重跑。
//
//   node release.mjs register --commit <来源提交> [--design <稿件编号>] [--dir <稿件目录>]
//     发布成功后登记：核对来源提交里的稿件目录和工作区一致，写 versions.json，打本地 tag design/<稿件编号>/v<N>。
//     第一次登记（首发后，或给已有稿件补登记）要带 --design；给已有稿件补登记时再加 --version <已发布的最新版>。
//
// 退出码：0 成功；1 门禁驳回或核对不一致；2 参数错误。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  if (last) {
    const full = opt('full') ?? String(registry.versions[0].version);
    if (run('changes-index.mjs', ['--dir', dir, '--to', String(version), '--full', full])) fail('生成版本差异失败', 1);
  }
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
  process.exit(run('version-diff.mjs', ['--dir', dir, '--register', String(version), '--commit', full, ...(opt('design') ? ['--design', opt('design')] : [])]));
} else {
  fail('用法：node release.mjs check [--dir <稿件目录>] [--full 1,11]\n      node release.mjs register --commit <来源提交> [--design <稿件编号>] [--version <N>] [--dir <稿件目录>]');
}
