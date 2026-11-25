#!/usr/bin/env node
// 技能是不是最新的：开工前跑一次（用户说「获取最新代码」时也跑）。
//
//   node <技能根>/cds/scripts/skill-fresh.mjs
//
// 为什么需要：项目技能从主检出读取，在工作树里拉最新代码不会更新已经加载的技能。
// 2026-11-25 的教训：工作树已是最新，加载的却是主检出里落后 180 个提交的 v0.23.1，「提出设计」被当成了直接改代码。
//
// 做法：在技能所在的仓库 fetch origin/main，比较技能目录在 HEAD 和 origin/main 的树。
//   一致 → 退出码 0。
//   不一致且本地落后 → 退出码 1：先看当前工作目录（工作树）里有没有和 origin/main 一致的技能，有就给出路径；
//     没有就给用户一条 git pull 命令。不自己 pull，不改主检出。
//   不是 git 检出（通过「接入 CDS」下载安装的技能）或连不上 origin → 改问 CDS：比较本地 cdscli 版本和
//     <CDS>/api/agent/setup.json 的 cliVersion，落后就退出码 1，请运行 cdscli update。拿不到 CDS 地址时不拦。
//   和 origin/main 一致时也问 CDS：仓库里的 CLI 比线上旧时退出码 1，说清该用哪里的技能，或请用户同意一次下载。
//   本地有未提交改动 → 退出码 0 并说明原因（不拦）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const say = (code, text, extra = {}) => { console.log(JSON.stringify({ fresh: code === 0, ...extra })); console.log(text); process.exit(code); };

/* 外部接入：技能是从 CDS 下载的，对照 CDS 正在提供的技能包版本 */
async function againstCds(why, inGit = false) {
  let local;
  try { local = (readFileSync(path.join(skillDir, 'cli', 'cdscli.py'), 'utf8').match(/^VERSION = "([\d.]+)"/m) ?? [])[1]; } catch { /* 没有 CLI 就跳过 */ }
  let host = process.env.CDS_HOST;
  for (let dir = process.cwd(); !host; dir = path.dirname(dir)) {
    const file = path.join(dir, '.cds', 'credentials.json');
    if (existsSync(file)) { try { host = JSON.parse(readFileSync(file, 'utf8')).host; } catch { /* 读不了就当没有 */ } }
    if (path.dirname(dir) === dir) break;
  }
  if (!local || !host) say(0, `${why}，也拿不到 CDS 地址，跳过新旧检查。`, { reason: 'no-host' });
  let remote;
  try {
    const res = await fetch(`${String(host).replace(/\/+$/, '')}/api/agent/setup.json?target=system&skills=cds`, { signal: AbortSignal.timeout(15000) });
    remote = (await res.json()).cliVersion;
  } catch { say(0, `${why}，连不上 CDS，跳过新旧检查。`, { reason: 'offline' }); }
  const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };
  if (!remote || !older(local, remote)) say(0, '技能是最新的（对照 CDS 的技能包）。', { skillDir, local, remote });
  say(1, (inGit ? [`仓库里的 CLI 比 CDS 旧：本地 ${local}，CDS 提供 ${remote}。设计发布自检会拒绝。`,
    '先看仓库有没有更新的技能（main 或正在合并的技能 PR 分支），有就改用那里的技能目录。',
    `都没有时，请用户同意一次从 ${host}/api/skills/cds-pack/download 下载技能包到仓库外的临时目录，用那里的 cdscli；不要另找办法绕过。`]
    : [`技能过期：本地 ${local}，CDS 提供 ${remote}。不要用已加载的旧内容干活。`,
      '先运行 cdscli update 更新完整技能包（六个技能），再重新加载技能。']).join('\n'), { skillDir, local, remote, inGit });
}

const root = tryGit(skillDir, 'rev-parse', '--show-toplevel');
if (!root) await againstCds('技能不在 git 检出里（通过接入 CDS 安装）');
const rel = path.relative(root, skillDir).split(path.sep).join('/');
if (tryGit(root, 'fetch', '--quiet', 'origin', 'main') === null) await againstCds('连不上 origin');
const local = tryGit(root, 'rev-parse', `HEAD:${rel}`);
const remote = tryGit(root, 'rev-parse', `origin/main:${rel}`);
if (!local || !remote) say(0, '找不到技能目录的版本记录，跳过新旧检查。', { reason: 'no-tree' });
/* 和 origin/main 一致也要问 CDS：仓库里的 CLI 可能比线上旧（2026-11-25：main 0.26.10、线上 0.26.20，设计发布自检直接拒绝） */
if (local === remote) await againstCds('技能和 origin/main 一致', true);
if (tryGit(root, 'status', '--porcelain', '--untracked-files=no', '--', rel)) say(0, '技能目录有未提交的改动，按本地文件用。', { reason: 'local-edits', skillDir });
const behind = Number(tryGit(root, 'rev-list', '--count', 'HEAD..origin/main') ?? 0);

/* 当前工作目录（多半是工作树）里有没有最新的技能 */
const cwdRoot = tryGit(process.cwd(), 'rev-parse', '--show-toplevel');
const fresher = cwdRoot && cwdRoot !== root && existsSync(path.join(cwdRoot, rel)) && tryGit(cwdRoot, 'rev-parse', `HEAD:${rel}`) === remote
  && !tryGit(cwdRoot, 'status', '--porcelain', '--untracked-files=no', '--', rel) ? path.join(cwdRoot, rel) : null;
say(1, [
  `技能过期：加载的是 ${skillDir}，比 origin/main 落后 ${behind} 个提交。不要用已加载的旧内容干活。`,
  fresher ? `改读这里的最新文件：${fresher}（SKILL.md 和 reference/ 都从这里读）。` : '当前目录里没有最新的技能。',
  `请用户在主检出更新（技能不会自己改主检出）：git -C "${root}" pull --ff-only`,
].join('\n'), { skillDir, behind, fresher });
