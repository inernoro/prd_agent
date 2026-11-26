#!/usr/bin/env node
// 用正式前端构建原型（应用框架的唯一做法）：原型就是正式代码 + 稿件的改动副本 + 演示数据，框架的壳、组件和令牌都来自正式代码。
//
//   node prototype-build.mjs --dir design/<目录> --checkout <正式仓库检出>
//
// 读 <稿件目录>/prototype.json：
//   {
//     "web": "cds/web",                 正式前端在检出里的位置
//     "baseline": "<提交>",             检出必须和这个提交一致（只看前端和共享源码），保证原型 = 基线 + 稿件改动
//     "entry": "src/main.tsx",          稿件的入口：挂载要演示的正式页面，装上演示数据
//     "overrides": { "src/pages/X.tsx": "src/overrides/X.tsx" },   正式文件 → 稿件里的改动副本（改动副本和原文件的差异就是源码差异）
//     "added": { "src/pages/design-workspace/": "src/overrides/" }, 稿件新增的正式文件：按正式路径引用，构建时指到稿件
//                                       （键是目录前缀时值是目录；键是单个文件时值是文件）
//     "stubs": { "src/pages/X.tsx": "src/stubs/X.tsx" },  只用于原型的占位：本次没改、但会被一起打包的正式模块
//                                       （例如懒加载的其他页签）。占位不是设计改动，不进源码差异
//     "shared": "cds/src/shared",       @shared 别名（可选）
//     "skipPreloads": ["@/pages/X"],    原型用不到的正式预加载（可选）
//     "shellFile": "src/components/layout/AppShell.tsx",
//     "title": "原型标题"
//   }
// 输出 <稿件目录>/dist/index.html，单文件内联。head 里写构建指纹 <meta name="cds-prototype-build" content='{...}'>，
// 门禁 G-10 用它判定原型是不是由正式前端构建的。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const draft = path.resolve(opt('dir') ?? '.');
const checkout = path.resolve(opt('checkout') ?? '');
const fail = message => { console.error(message); process.exit(1); };
if (!existsSync(path.join(draft, 'prototype.json'))) fail(`${draft} 里没有 prototype.json，请按本脚本开头的字段配置正式基线和入口`);
const config = JSON.parse(readFileSync(path.join(draft, 'prototype.json'), 'utf8'));
const web = path.join(checkout, config.web ?? 'cds/web');
if (!existsSync(path.join(web, 'package.json'))) fail(`检出里找不到正式前端：${web}`);
if (!existsSync(path.join(web, 'node_modules'))) fail(`正式前端还没装依赖：先在 ${web} 运行 pnpm install（或 npm install）`);
const posix = file => file.split(path.sep).join('/');
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();

/* 检出必须是基线：原型 = 基线 + 稿件改动。检出里自己改过正式代码的话，改动应该放进稿件的 overrides */
const baseline = config.baseline;
if (!/^[0-9a-f]{7,40}$/.test(baseline ?? '')) fail('prototype.json 要写 baseline（正式代码的基线提交）');
const watched = [config.web ?? 'cds/web', ...(config.shared ? [config.shared] : [])];
try { execFileSync('git', ['-C', checkout, 'diff', '--quiet', baseline, '--', ...watched], { stdio: 'ignore' }); }
catch { fail(`检出的 ${watched.join('、')} 和基线 ${baseline} 不一致。改动请放进稿件的 overrides，再在基线上构建`); }
const commit = git('rev-parse', `${baseline}^{commit}`);

const overrides = new Map(Object.entries(config.overrides ?? {}).map(([from, to]) => [posix(path.join(web, from)), path.join(draft, to)]));
for (const [from, to] of overrides) {
  if (!existsSync(from)) fail(`overrides 里的正式文件不存在：${from}（新增文件写在 added 里）`);
  if (!existsSync(to)) fail(`overrides 里的稿件文件不存在：${to}`);
}
/* 占位和改动副本走同一个替换，但分开登记：占位只用于原型，不进源码差异 */
for (const [from, to] of Object.entries(config.stubs ?? {})) {
  const real = posix(path.join(web, from)), file = path.join(draft, to);
  if (!existsSync(real)) fail(`stubs 里的正式文件不存在：${real}`);
  if (!existsSync(file)) fail(`stubs 里的占位文件不存在：${file}`);
  if (overrides.has(real)) fail(`${from} 同时登记在 overrides 和 stubs 里`);
  overrides.set(real, file);
}
const draftRoot = posix(draft) + '/';
const added = Object.entries(config.added ?? {}).map(([from, to]) => [posix(path.join(web, from)), path.join(draft, to)]);
const shell = path.join(web, config.shellFile ?? 'src/components/layout/AppShell.tsx');

const require = createRequire(path.join(web, 'package.json'));
const { build } = await import(pathToFileURL(path.join(web, 'node_modules', 'vite', 'dist', 'node', 'index.js')));
const tw = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const reactPlugin = require('@vitejs/plugin-react');
const react = reactPlugin.default ?? reactPlugin;
const tailwindConfig = require('tailwindcss/loadConfig')(path.join(web, 'tailwind.config.js'));
const result = await build({
  configFile: false, root: web, publicDir: false,
  plugins: [react(), {
    name: 'cds-design-overrides', enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.endsWith('?real')) return this.resolve(source.slice(0, -5), importer, { ...options, skipSelf: true });
      /* 稿件新增的正式文件按正式路径引用（别名先于插件生效，这里可能已是绝对路径） */
      const wanted = posix(source.startsWith('@/') ? path.join(web, 'src', source.slice(2)) : source);
      for (const [prefix, target] of added) {
        /* 键是单个文件：整条引用（不带或带扩展名）对上就指到那个文件 */
        if (/\.[cm]?[jt]sx?$/.test(prefix)) {
          if ([wanted, wanted + '.ts', wanted + '.tsx'].includes(prefix) && existsSync(target)) return target;
          continue;
        }
        if (!wanted.startsWith(prefix)) continue;
        const name = wanted.slice(prefix.length);
        if (!name) continue;
        for (const ext of ['', '.tsx', '.ts']) { const file = path.join(target, name + ext); if (existsSync(file) && !existsSync(wanted + ext)) return file; }
      }
      /* 改动副本放在稿件目录里，里面的裸包导入（react、devicon/... 等）按正式前端的依赖解析 */
      if (importer && posix(importer).startsWith(draftRoot) && !/^[./\\]|^@\//.test(source) && !/^[A-Za-z]:/.test(source))
        return this.resolve(source, path.join(web, 'src', '__draft_import__.ts'), { ...options, skipSelf: true });
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const target = overrides.get(posix(resolved.id.split('?')[0]));
      return target && posix(importer ?? '') !== posix(target) ? target : resolved;
    },
  }, {
    name: 'cds-design-skip-preloads', enforce: 'pre',
    transform(code, id) {
      if (posix(id.split('?')[0]) !== posix(shell)) return;
      for (const page of config.skipPreloads ?? []) code = code.replace(`import('${page}')`, 'Promise.resolve()');
      return code;
    },
  }],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: { ...(config.shared ? { '@shared': path.join(checkout, config.shared) } : {}), '@': path.join(web, 'src') },
    dedupe: ['react', 'react-dom', 'react-router-dom', 'lucide-react', 'marked'],
  },
  css: { postcss: { plugins: [
    tw({ ...tailwindConfig, content: [path.join(web, 'src/**/*.{ts,tsx}'), path.join(draft, 'src/**/*.{ts,tsx}')].map(posix) }),
    autoprefixer(),
  ] } },
  build: {
    write: false,
    lib: { entry: path.join(draft, config.entry ?? 'src/main.tsx'), name: 'CdsDesignPrototype', formats: ['iife'], fileName: 'prototype' },
    cssCodeSplit: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, minify: 'esbuild', sourcemap: false, target: 'es2022',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  logLevel: 'error',
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
const scripts = outputs.filter(item => item.type === 'chunk');
const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
if (scripts.length !== 1 || !styles.length) fail('原型应只包含一个脚本和内联样式');
const script = scripts[0].code.replace(/<\/script/gi, '<\\/script');
const css = styles.map(item => Buffer.from(item.source).toString()).join('\n').replace(/<\/style/gi, '<\\/style');
const fingerprint = JSON.stringify({ builder: 'cds-design/prototype-build', web: config.web ?? 'cds/web', baseline: commit, overrides: overrides.size, added: added.length })
  .replace(/'/g, '&#39;');
const html = '<!doctype html>\n<html lang="zh-CN" data-theme="light"><head>'
  + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + `<meta name="cds-prototype-build" content='${fingerprint}'>`
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src data:; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; font-src data:; img-src data: blob:; form-action \'none\'; base-uri \'none\'">'
  + `<title>${String(config.title ?? '设计原型').replace(/[<&]/g, '')}</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>\n`;
if (Buffer.byteLength(html) > 4 * 1024 * 1024) fail('原型超过 CDS 的 4 MiB 单文件上限');
const out = path.resolve(opt('out') ?? path.join(draft, 'dist', 'index.html'));
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, html);
console.log(JSON.stringify({ out: posix(path.relative(draft, out)), bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex'), baseline: commit }));
