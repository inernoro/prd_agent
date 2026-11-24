#!/usr/bin/env node
// 生成 changes/：从 versions.json 里登记的每个旧版本到这次版本（当前工作区）的净变化，加 changes/index.json。
// 用法：node changes-index.mjs --dir <稿件目录> --to <这次的版本号> [--full 1,11]
//   --full 列出的版本附完整源码差异（source.diff），其余只附结构化差异，控制归档大小。
// 由程序生成，门禁 G-07 检查它和 versions.json 对得上。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const tools = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2); const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const here = path.resolve(opt('dir') ?? '.');
const to = Number(opt('to')); if (!Number.isInteger(to)) { console.error('用法：node changes-index.mjs --dir <稿件目录> --to <版本号> [--full 1,11]'); process.exit(2); }
const full = new Set(String(opt('full') ?? '').split(',').filter(Boolean).map(Number));
const registry = existsSync(path.join(here, 'versions.json')) ? JSON.parse(readFileSync(path.join(here, 'versions.json'), 'utf8')) : { versions: [] };
rmSync(path.join(here, 'changes'), { recursive: true, force: true }); mkdirSync(path.join(here, 'changes'));
const rows = registry.versions.map(v => {
  const out = `changes/v${v.version}-v${to}`;
  const result = JSON.parse(execFileSync('node', [path.join(tools, 'version-diff.mjs'), '--dir', here, '--from', `v${v.version}`, '--to-dir', '.', '--to-version', String(to), '--out', out,
    ...(full.has(v.version) ? [] : ['--no-source'])], { cwd: here, maxBuffer: 1 << 26 }).toString('utf8').trim().split('\n').at(-1));
  const files = [`${out}/summary.json`, `${out}/changes.md`, ...(full.has(v.version) ? [`${out}/source.diff`] : [])];
  return { version: v.version, commit: v.commit, files, acceptance: result.acceptance, screens: result.screens, sourceFiles: result.source.files };
});
const index = { to, note: '从每个旧版本升级到这次版本的净变化（回退用反方向同一程序）。程序生成，不要手改。', from: rows };
writeFileSync(path.join(here, 'changes', 'index.json'), JSON.stringify(index, null, 1) + '\n');
const md = [`# 版本差异索引（到 V${to}）`, '', '> 程序生成（changes-index.mjs）。实现停在哪一版，就看从那一版到 V' + to + ' 的那一行。中间版本加了又删的不会出现。', '',
  '| 从 | 验收项 新增/删除/改写 | 画面 新增/删除/改动 | 源码文件 | 文件 |', '|---|---|---|---|---|',
  ...rows.map(r => `| V${r.version} | ${r.acceptance.added}/${r.acceptance.removed}/${r.acceptance.changed} | ${r.screens.added}/${r.screens.removed}/${r.screens.changed} | ${r.sourceFiles} | ${r.files.map(f => `\`${f}\``).join('、')} |`), ''];
writeFileSync(path.join(here, 'changes', 'README.md'), md.join('\n'));
console.log(JSON.stringify({ to, versions: rows.length, full: [...full] }));
