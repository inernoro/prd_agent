/** 从实际路由登记、导出定义与 JSX 引用生成维护目录；不保存真实业务响应。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditLoadingCoverage } from './loading-coverage-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../web/src');
const scenes = JSON.parse(fs.readFileSync(path.join(root, 'components/skeletons/loading-scenes.json'), 'utf8'));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const sourceFiles = walk(root).filter(f => /\.tsx?$/.test(f));
const definitions = new Map();
const imports = new Map();
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/export\s+(?:function|const)\s+(\w+(?:Skeleton|Loading)|LoadingBlock)\b/g)) {
    definitions.set(match[1], { file: path.relative(root, file), line: text.slice(0, match.index).split('\n').length });
  }
  const dependencies = [];
  for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1];
    if (!spec.startsWith('@/') && !spec.startsWith('.')) continue;
    const base = spec.startsWith('@/') ? path.join(root, spec.slice(2)) : path.resolve(path.dirname(file), spec);
    const resolved = [base, base + '.tsx', base + '.ts', path.join(base, 'index.tsx'), path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (resolved) dependencies.push(resolved);
  }
  imports.set(file, dependencies);
}
function dependenciesOf(start) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of imports.get(file) ?? []) {
      const rel = path.relative(root, next);
      // 外壳/骨架登记会反向引用多个页面组件，不能据此把每个等待误归到所有页面。
      if (/^(?:components\/(?:layout|skeletons|ui)\/|lib\/)/.test(rel) || rel === 'pages/cds-settings/components.tsx') continue;
      if (/^pages\/[^/]+Page\.tsx$/.test(rel) && next !== start) continue;
      visit(next);
    }
  }
  visit(start); return seen;
}
const reachability = scenes.map(scene => ({ ...scene, dependencies: dependenciesOf(path.join(root, scene.page)) }));
const audit = auditLoadingCoverage(root);
const sites = audit.sharedSites.map(site => ({ ...site,
  definition: definitions.get(site.component) ?? null,
  routes: reachability.filter(scene => scene.dependencies.has(path.join(root, site.file))).map(scene => scene.route),
}));
const flag = process.argv.indexOf('--out');
const out = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(os.tmpdir(), 'cds-loading-inventory'));
fs.mkdirSync(out, { recursive: true });
const result = { generatedFrom: 'current source; lines recomputed on every run', scenes, sites, waits: audit.waits, uncovered: audit.uncovered };
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(result, null, 2));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const table = (headers, rows) => `<table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(v => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CDS 骨架维护目录</title><style>body{font:14px system-ui;margin:28px;color:#332f2b;background:#f7f5f2}table{border-collapse:collapse;width:100%;margin:18px 0 30px}td,th{border:1px solid #d9d2ca;padding:10px;text-align:left;overflow-wrap:anywhere}th{background:#eae4dc}h1{font-size:24px}p{line-height:1.7}</style><h1>CDS 骨架维护目录</h1><p>本表由当前源码生成。路由数、JSX 引用数和业务加载场景数分别统计；一个组件在多个页面复用时会列出多个入口。静态分类通过不能替代真实浏览器验收。</p><p>维护说明：仓库 doc/guide.cds.loading.md。改外观：index.css 的 cds-loading-skeleton-*；改轮廓：下表“定义”；改加载触发：下表“引用位置”。新增控制台路由必须登记 loading-scenes.json，CI 自动校验。</p><h2>路由登记（${scenes.length} 个入口）</h2>${table(['页面', '路径', '首次加载轮廓', '实现位置', '外壳布局'], scenes.map(s => [s.name, s.route, s.kind, s.page, s.workspace]))}<h2>骨架引用位置（${sites.length} 处 JSX，含预览和复用）</h2>${table(['骨架', '读取内容', '引用位置 / 函数', '定义位置', '可达路由'], sites.map(s => [s.component, s.label, `${s.file}:${s.line} / ${s.owner}`, s.definition ? `${s.definition.file}:${s.definition.line}` : '本文件或外部导出', s.routes.join('\n') || '共享组件 / 路由骨架 / 预览']))}<h2>加载分支分类（${audit.waits.length}）</h2>${table(['位置', '条件', '分类', '原因'], audit.waits.map(s => [`${s.file}:${s.line} / ${s.owner}`, s.condition, s.category, s.reason]))}<p>未分类内容等待：${audit.uncovered.length}。完整数据：inventory.json。仅包含源码信息，无用户数据和凭据。</p></html>`);
console.log(JSON.stringify({ scenes: scenes.length, sites: sites.length, waits: audit.waits.length, uncovered: audit.uncovered.length, directory: out }));
if (audit.uncovered.length) process.exitCode = 1;
