// 生成 设计文档/源码差异.diff：prototype.json 登记的改动副本与新增文件，相对正式基线的标准 git 差异（a/ b/ 文件头，可直接 git apply）。
//   node tools/source-diff.mjs --checkout <仓库根>
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const i = argv.indexOf('--checkout');
const checkout = path.resolve(i >= 0 ? argv[i + 1] : path.join(dir, '..', '..'));
const cfg = JSON.parse(readFileSync(path.join(dir, 'prototype.json'), 'utf8'));
const web = cfg.web;
const walk = p => statSync(p).isDirectory() ? readdirSync(p).flatMap(f => walk(path.join(p, f))) : [p];
const pairs = [];
for (const [from, to] of Object.entries(cfg.overrides ?? {})) pairs.push([`${web}/${from}`, path.join(dir, to)]);
for (const [from, to] of Object.entries(cfg.added ?? {})) {
  const src = path.join(dir, to);
  if (statSync(src).isDirectory()) for (const f of walk(src)) pairs.push([`${web}/${from}${path.relative(src, f).split(path.sep).join('/')}`, f]);
  else pairs.push([`${web}/${from}`, src]);
}
let out = '';
for (const [rel, file] of pairs.sort((a, b) => a[0].localeCompare(b[0]))) {
  const base = `${cfg.baseline}:${rel}`;
  let original = null;
  try { original = execFileSync('git', ['-C', checkout, 'show', base], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* 新增文件 */ }
  const tmp = path.join(dir, '.diff-base');
  writeFileSync(tmp, original ?? '');
  let d = '';
  try { execFileSync('git', ['diff', '--no-index', '--no-color', original == null ? '/dev/null' : tmp, file], { encoding: 'utf8' }); }
  catch (e) { d = e.stdout; }
  execFileSync('rm', ['-f', tmp]);
  if (!d) continue;
  const lines = d.split('\n');
  const body = lines.slice(lines.findIndex(l => l.startsWith('@@')));
  const header = original == null
    ? [`diff --git a/${rel} b/${rel}`, 'new file mode 100644', '--- /dev/null', `+++ b/${rel}`]
    : [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`];
  out += [...header, ...body].join('\n').replace(/\n*$/, '\n');
}
writeFileSync(path.join(dir, '设计文档/源码差异.diff'), out);
console.log(JSON.stringify({ files: pairs.length, bytes: out.length }));
