// 把原型的演示数据（src/fixtures.ts）导出成 设计文档/演示数据.json：原型与实现取证用同一份数据。
//   node tools/export-demo-data.mjs --checkout <仓库根>
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const i = argv.indexOf('--checkout');
const checkout = path.resolve(i >= 0 ? argv[i + 1] : path.join(dir, '..', '..'));
const req = createRequire(path.join(checkout, 'prd-admin', 'package.json'));
const esbuild = createRequire(req.resolve('vite'))('esbuild');
/* fixtures.ts 转成 JS 后直接执行。风格目录内联进来；海报在原型里是内嵌图片，导出时写成包内相对路径（src/opuscar/posters/<编号>.webp） */
const source = readFileSync(path.join(dir, 'src/fixtures.ts'), 'utf8')
  .replace("import catalog from './opuscar/catalog.json';", `const catalog = ${readFileSync(path.join(dir, 'src/opuscar/catalog.json'), 'utf8')};`)
  .replace(/import\.meta\.glob<string>\([^)]*\)/, "new Proxy({}, { get: (_, key) => String(key).replace('./', 'src/') })");
const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'esm' });
const tmp = path.join(dir, 'tools', '.fixtures.tmp.mjs');
writeFileSync(tmp, code);
const m = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
const data = {
  note: '虚构演示数据：稿件、成员与作品均为示例。原型 dist/index.html 与实现取证共用这一份（源文件 src/fixtures.ts）。',
  templateCategories: m.templateCategories,
  templateSource: m.templateSource,
  templates: m.templates,
  attachments: [m.sampleDoc, ...m.attachmentQueue],
  runs: m.fixedRuns,
  works: m.works,
  assets: m.assets,
};
mkdirSync(path.join(dir, '设计文档'), { recursive: true });
writeFileSync(path.join(dir, '设计文档/演示数据.json'), JSON.stringify(data, null, 1) + '\n');
unlinkSync(tmp);
console.log(JSON.stringify({ templates: data.templates.length, attachments: data.attachments.length, runs: Object.keys(data.runs).length, works: data.works.length }));
