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
//   不是 git 检出、离线、本地有未提交改动 → 退出码 0 并说明原因（不拦）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const say = (code, text, extra = {}) => { console.log(JSON.stringify({ fresh: code === 0, ...extra })); console.log(text); process.exit(code); };

const root = tryGit(skillDir, 'rev-parse', '--show-toplevel');
if (!root) say(0, '技能不在 git 检出里，跳过新旧检查。', { reason: 'not-git' });
const rel = path.relative(root, skillDir).split(path.sep).join('/');
if (tryGit(root, 'fetch', '--quiet', 'origin', 'main') === null) say(0, '连不上 origin，跳过新旧检查（用的是本地技能）。', { reason: 'offline' });
const local = tryGit(root, 'rev-parse', `HEAD:${rel}`);
const remote = tryGit(root, 'rev-parse', `origin/main:${rel}`);
if (!local || !remote) say(0, '找不到技能目录的版本记录，跳过新旧检查。', { reason: 'no-tree' });
if (local === remote) say(0, '技能是最新的。', { skillDir });
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
