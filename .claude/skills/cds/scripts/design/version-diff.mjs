#!/usr/bin/env node
// 版本差异（程序算，不靠智能体）。
// 任意两个版本之间的净变化：升级（from < to）和回退（from > to）同一个算法，中间加了又删的东西不会出现。
//
// 用法（--dir 是稿件目录，默认当前目录；--out 按稿件目录算，--from-dir、--to-dir 按当前目录算）：
//   node version-diff.mjs --dir <稿件目录> --from v11 --to v17 [--out changes/v11-v17]
//   node version-diff.mjs --dir <稿件目录> --from-dir <解开的旧版归档> --to-dir <解开的新版归档> [--out ...]
//   node version-diff.mjs --dir <稿件目录> --from v16 --to-dir . --to-version 17   （和当前工作区比）
//   node version-diff.mjs --dir <稿件目录> --register 17 --commit <sha> [--design <稿件编号>]   （发布后登记版本，写 versions.json 并打本地 tag）
// 版本号 vN 按 versions.json 解析成提交；也可以直接给提交或 tag。没有 git 时，用 CDS 下载的两版归档目录比较，结果一样。
// 输出：summary.json（结构化，供程序和智能体读）、changes.md（给人读）、source.diff（源码差异，目录取 design.json 的 source，默认 src/）。
// 退出码：0 成功；2 参数或版本无法解析。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((list, value, index, all) => {
  if (value.startsWith('--')) list.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return list;
}, []));
const here = path.resolve(String(args.dir ?? '.'));
const fail = message => { console.error(message); process.exit(2); };
const git = (argv, opts = {}) => execFileSync('git', argv, { cwd: here, maxBuffer: 1 << 28, ...opts });
const registryPath = path.join(here, 'versions.json');
const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { versions: [] };
let topCache;
const top = () => topCache ??= git(['rev-parse', '--show-toplevel']).toString().trim();
const repoPath = () => registry.path ?? path.relative(top(), here).split(path.sep).join('/');

if (args.register) {
  const version = Number(args.register), commit = String(args.commit ?? '');
  if (!Number.isInteger(version) || version < 1 || !/^[0-9a-f]{40}$/.test(commit)) fail('--register 需要版本号和 40 位提交');
  const prev = registry.versions.at(-1);
  if (prev && version !== prev.version + 1) fail(`版本号必须接着 V${prev.version}`);
  if (args.design) { if (registry.design && registry.design !== args.design) fail(`versions.json 登记的是 ${registry.design}，不是 ${args.design}`); registry.design = String(args.design); }
  if (!/^DSN-[0-9A-F]+$/.test(registry.design ?? '')) fail('第一次登记要用 --design <稿件编号>（发布结果里的 DSN-…）');
  registry.path ??= repoPath();
  registry.note ??= '版本登记由程序写入（version-diff.mjs --register）。commit 是发布时的来源提交；tag 只在本地，供 git 计算差异。';
  const tag = `design/${registry.design}/v${version}`;
  git(['tag', '-f', tag, commit]);
  registry.versions.push({ version, commit, tag, committedAt: git(['show', '-s', '--format=%cI', commit]).toString().trim(),
    subject: git(['show', '-s', '--format=%s', commit]).toString('utf8').trim() });
  const { design, path: repo, note, versions, ...rest } = registry;
  writeFileSync(registryPath, JSON.stringify({ design, path: repo, note, ...rest, versions }, null, 1) + '\n');
  console.log(`登记 V${version} → ${commit.slice(0, 10)}（${tag}）`);
  process.exit(0);
}

/* 解析一个版本：目录直接用；版本号或提交用 git archive 解到临时目录 */
const temps = [];
function materialize(ref, dir) {
  if (dir) { const full = path.resolve(dir); if (!existsSync(path.join(full, 'design.json'))) fail(`${dir} 里没有 design.json`); return { label: dir === '.' ? '工作区' : dir, dir: full }; }
  if (!ref) fail('需要 --from/--to 或 --from-dir/--to-dir');
  const hit = /^v\d+$/i.test(ref) ? registry.versions.find(row => row.version === Number(ref.slice(1))) : undefined;
  if (/^v\d+$/i.test(ref) && !hit) fail(`versions.json 里没有 ${ref}`);
  const commit = hit?.commit ?? ref;
  const out = mkdtempSync(path.join(os.tmpdir(), 'vdiff-')); temps.push(out);
  /* 只用 git 自己：临时索引读入那一版的目录，再整体检出到临时目录（不碰工作区和真实索引，不依赖 tar） */
  const index = path.join(out, '.index'), dest = path.join(out, 'pkg');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try { git(['read-tree', `${commit}:${repoPath()}`], { env }); } catch { fail(`git 里找不到 ${ref}（${commit}）`); }
  git(['checkout-index', '-a', `--prefix=${dest.split(path.sep).join('/')}/`], { env, cwd: top() }); rmSync(index);
  return { label: hit ? `V${hit.version}` : ref, version: hit?.version, commit, dir: dest };
}

const walk = (root, rel = '') => readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(entry => {
  const sub = rel ? `${rel}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return ['node_modules', '.git', 'changes'].includes(entry.name) && !rel ? [] : walk(root, sub);
  return [sub];
});
const fileMap = root => Object.fromEntries(walk(root).map(rel => [rel, createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex')]));
const json = (root, rel) => { try { return JSON.parse(readFileSync(path.join(root, rel), 'utf8')); } catch { return undefined; } };
const byId = list => Object.fromEntries((list ?? []).map(row => [row.id, row]));
function diffRows(a, b, fields) {
  const A = byId(a), B = byId(b);
  const added = Object.keys(B).filter(id => !A[id]).sort(), removed = Object.keys(A).filter(id => !B[id]).sort();
  const changed = Object.keys(B).filter(id => A[id]).map(id => ({ id, fields: fields.filter(key => JSON.stringify(A[id][key] ?? null) !== JSON.stringify(B[id][key] ?? null)) }))
    .filter(row => row.fields.length).sort((x, y) => x.id.localeCompare(y.id));
  return { added: added.map(id => ({ id, ...pick(B[id], fields) })), removed: removed.map(id => ({ id, ...pick(A[id], fields) })),
    changed: changed.map(row => ({ id: row.id, fields: row.fields, from: pick(A[row.id], row.fields), to: pick(B[row.id], row.fields) })) };
}
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const heading = file => { const text = existsSync(file) ? readFileSync(file, 'utf8') : ''; return text.match(/^#\s+(.+)$/m)?.[1] ?? ''; };

const from = materialize(args.from, args['from-dir']);
const to = materialize(args.to, args['to-dir']);
/* 和工作区比较时，用 --to-version 写明这是要发布的哪一版，方向才算得出来 */
if (args['to-version']) { to.version = Number(args['to-version']); to.label = `V${to.version}`; }
const A = json(from.dir, 'design.json'), B = json(to.dir, 'design.json');
if (!A || !B) fail('design.json 无法解析');
const fa = fileMap(from.dir), fb = fileMap(to.dir);
const files = {
  added: Object.keys(fb).filter(f => !fa[f]).sort(), removed: Object.keys(fa).filter(f => !fb[f]).sort(),
  changed: Object.keys(fb).filter(f => fa[f] && fa[f] !== fb[f]).sort(),
};
const sourceDir = String(B.source ?? A.source ?? 'src').replace(/\/+$/, '') + '/';
const area = f => f.startsWith(sourceDir) ? '源码' : f.startsWith('设计文档/') || /\.md$/.test(f) ? '文档'
  : f.startsWith('screens/') || f.startsWith('compare/') ? '截图' : f.startsWith('dist/') ? '原型' : f.startsWith('checks/') ? '自检' : f.startsWith('tools/') ? '工具' : '其他';
const checksOf = dir => { const r = json(dir, 'checks/result.json'); return r ? { passed: r.passed, total: r.total, failed: (r.items ?? []).filter(x => !x.pass).map(x => x.name) } : undefined; };
const ruleFields = ['rule', 'expected', 'how', 'screenId', 'priority', 'slots'];
const summary = {
  from: { label: from.label, version: from.version ?? null, commit: from.commit ?? null, title: heading(path.join(from.dir, '交付说明.md')) },
  to: { label: to.label, version: to.version ?? null, commit: to.commit ?? null, title: heading(path.join(to.dir, '交付说明.md')) },
  direction: from.version && to.version ? (from.version < to.version ? 'upgrade' : from.version > to.version ? 'rollback' : 'same') : 'unknown',
  acceptance: diffRows(A.acceptance, B.acceptance, ruleFields),
  screens: diffRows(A.screens, B.screens, ['name', 'route', 'viewport', 'entryActions']),
  docs: { added: (B.docs ?? []).filter(d => !(A.docs ?? []).includes(d)), removed: (A.docs ?? []).filter(d => !(B.docs ?? []).includes(d)) },
  meta: Object.fromEntries(['framework', 'frameworkVersion', 'prototypeVersion'].filter(k => A[k] !== B[k]).map(k => [k, { from: A[k], to: B[k] }])),
  files: Object.fromEntries(Object.entries(files).map(([kind, list]) => [kind, list.map(f => ({ path: f, area: area(f) }))])),
  checks: { from: checksOf(from.dir), to: checksOf(to.dir) },
};
/* 源码差异：用 git 的 diff 引擎比较两个目录里的源码目录 */
/* 逐个文件比较，头部统一写成 a/src/… b/src/…，不带临时目录；新增、删除的一边用空文件比较，头部写 /dev/null */
const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'vdiff-empty-')); temps.push(emptyDir);
const empty = path.join(emptyDir, 'empty'); writeFileSync(empty, '');
const sourceFiles = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter(f => f.startsWith(sourceDir) && fa[f] !== fb[f]).sort();
const sourceDiff = sourceFiles.map(rel => {
  const a = fa[rel] ? path.join(from.dir, rel) : empty, b = fb[rel] ? path.join(to.dir, rel) : empty;
  let out = '';
  try { out = execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', a, b], { maxBuffer: 1 << 28 }).toString('utf8'); }
  catch (error) { out = error.stdout?.toString('utf8') ?? ''; }
  const lines = out.split('\n'); const start = lines.findIndex(line => line.startsWith('@@') || line.startsWith('Binary files'));
  const body = start < 0 ? '' : lines.slice(start).join('\n').replace(/^Binary files .*$/m, `Binary files ${fa[rel] ? `a/${rel}` : '/dev/null'} and ${fb[rel] ? `b/${rel}` : '/dev/null'} differ`);
  return `diff --git a/${rel} b/${rel}\n${!fa[rel] ? 'new file mode 100644\n' : !fb[rel] ? 'deleted file mode 100644\n' : ''}--- ${fa[rel] ? `a/${rel}` : '/dev/null'}\n+++ ${fb[rel] ? `b/${rel}` : '/dev/null'}\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}).join('');
summary.source = { files: sourceFiles.length, bytes: Buffer.byteLength(sourceDiff) };

const rule = row => `\`${row.id}\` ${row.rule ?? row.name ?? ''}`;
const md = [`# 版本差异：${summary.from.label} → ${summary.to.label}`, '',
  `> 程序生成（version-diff.mjs），不要手改。方向：${({ upgrade: '升级', rollback: '回退', same: '同一版', unknown: '按目录比较' })[summary.direction]}。只列净变化：中间版本加了又删的不出现。`, '',
  '## 一、验收项', '',
  `- 新增 ${summary.acceptance.added.length}：${summary.acceptance.added.map(rule).join('；') || '无'}`,
  `- 删除 ${summary.acceptance.removed.length}：${summary.acceptance.removed.map(rule).join('；') || '无'}`,
  `- 改写 ${summary.acceptance.changed.length}：${summary.acceptance.changed.map(row => `\`${row.id}\`（${row.fields.join('、')}）`).join('；') || '无'}`, '',
  '## 二、画面', '',
  `- 新增 ${summary.screens.added.length}：${summary.screens.added.map(row => `\`${row.id}\` ${row.name}`).join('；') || '无'}`,
  `- 删除 ${summary.screens.removed.length}：${summary.screens.removed.map(row => `\`${row.id}\` ${row.name}`).join('；') || '无'}`,
  `- 改动 ${summary.screens.changed.length}：${summary.screens.changed.map(row => `\`${row.id}\`（${row.fields.join('、')}）`).join('；') || '无'}`, '',
  '## 三、文件', '',
  ...['added', 'removed', 'changed'].map(kind => { const list = summary.files[kind]; const groups = {};
    list.forEach(f => { (groups[f.area] ??= []).push(f.path); });
    return `- ${({ added: '新增', removed: '删除', changed: '改动' })[kind]} ${list.length}：${Object.entries(groups).map(([g, l]) => `${g} ${l.length}（${l.slice(0, 6).join('、')}${l.length > 6 ? '…' : ''}）`).join('；') || '无'}`; }), '',
  !summary.source.files ? '源码没有变化。' : args['no-source'] ? `源码有 ${summary.source.files} 个文件变化，差异没有附在包里（见文末命令）。` : `源码差异在 \`source.diff\`：${summary.source.files} 个文件。`, '',
  '## 四、自检', '',
  `- ${summary.from.label}：${summary.checks.from ? `${summary.checks.from.passed}/${summary.checks.from.total}` : '无'}`,
  `- ${summary.to.label}：${summary.checks.to ? `${summary.checks.to.passed}/${summary.checks.to.total}` : '无'}${summary.checks.to?.failed?.length ? `；未过：${summary.checks.to.failed.join('；')}` : ''}`, ''];
if (Object.keys(summary.meta).length) md.push('## 五、稿件属性', '', ...Object.entries(summary.meta).map(([k, v]) => `- ${k}：${v.from} → ${v.to}`), '');

const outDir = path.resolve(here, String(args.out ?? `changes/${from.label}-${to.label}`.toLowerCase().replace(/[^a-z0-9/_-]+/g, '')));
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
if (args['no-source'] && summary.source.files) md.push(`源码差异没有附在包里（${summary.source.files} 个文件）。需要时运行 \`node version-diff.mjs --dir <稿件目录> --from ${summary.from.label.toLowerCase()} --to ${summary.to.label.toLowerCase()}\`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。`, '');
else if (!args['no-source']) writeFileSync(path.join(outDir, 'source.diff'), sourceDiff);
writeFileSync(path.join(outDir, 'changes.md'), md.join('\n'));
temps.forEach(dir => rmSync(dir, { recursive: true, force: true }));
console.log(JSON.stringify({ out: path.relative(here, outDir).replace(/\\/g, '/'), direction: summary.direction,
  acceptance: { added: summary.acceptance.added.length, removed: summary.acceptance.removed.length, changed: summary.acceptance.changed.length },
  screens: { added: summary.screens.added.length, removed: summary.screens.removed.length, changed: summary.screens.changed.length },
  files: Object.fromEntries(Object.entries(summary.files).map(([k, v]) => [k, v.length])), source: summary.source }));
