#!/usr/bin/env node
// 在本地用 CDS 服务端同一个运行器（cds/src/services/design-handoff-browser.ts 的 runDesignHandoff）跑一遍稿件的交接场景，
// 结果写进 <稿件目录>/checks/handoff.json。门禁 G-12 核对这份回执：绑定的是这一份原型和这一组场景，且全部通过。
// 为什么要本地跑：标了 interaction 的验收项必须有能跑通的场景，否则 CDS 判「缺交接计划」或「交接未通过」，实施目标切不过去。
// 这件事不能交给智能体自觉，发布前由程序跑。
//
// 用法：node handoff-run.mjs [--dir <稿件目录>] [--checkout <CDS 检出>]
//   --checkout 默认取环境变量 CDS_WEB_CHECKOUT：正式 CDS 仓库的检出（要用里面的 cds/src 运行器）。
//   浏览器内核：CDS_PLAYWRIGHT 指向 playwright 或 playwright-core 的目录；不设时依次找 <检出>/cds/node_modules/playwright、playwright-core。
//   浏览器：CHROME_PATH；不设时用 playwright 自带的 Chromium，再找本机 Chrome。
// 退出码：0 全部通过；1 有场景没通过或跑不了；2 参数或环境问题。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(opt('dir') ?? '.');
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
const cases = design.handoff?.cases ?? [];
const interaction = (design.acceptance ?? []).filter(rule => rule.interaction).map(rule => rule.id);
if (!cases.length && !interaction.length) { console.log(JSON.stringify({ handoff: 'none' })); process.exit(0); }
if (!cases.length) fail(`有 ${interaction.length} 条交互验收项（${interaction.join('、')}），但 design.json 没有 handoff.cases`, 1);

const checkout = path.resolve(opt('checkout') ?? process.env.CDS_WEB_CHECKOUT ?? '');
const runnerFile = path.join(checkout, 'cds', 'src', 'services', 'design-handoff-browser.ts');
if (!existsSync(runnerFile)) fail(`找不到 CDS 的交接运行器：${runnerFile}（用 --checkout 或 CDS_WEB_CHECKOUT 指向正式 CDS 仓库的检出）`);
const pwDir = [process.env.CDS_PLAYWRIGHT, path.join(checkout, 'cds', 'node_modules', 'playwright'), path.join(checkout, 'cds', 'node_modules', 'playwright-core')]
  .find(candidate => candidate && existsSync(path.join(candidate, 'package.json')));
if (!pwDir) fail('找不到 playwright：在 CDS 检出的 cds 目录装好依赖，或用 CDS_PLAYWRIGHT 指向 playwright / playwright-core 的目录');

/* 运行器是 TypeScript：Node 去掉类型直接跑；源码里写的 .js 引用对应 .ts 文件 */
registerHooks({ resolve(spec, ctx, next) {
  if (spec.endsWith('.js') && spec.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
    const url = new URL(spec, ctx.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const ts = url.href.replace(/\.js$/, '.ts');
      if (existsSync(fileURLToPath(ts))) return next(ts, ctx);
    }
  }
  return next(spec, ctx);
} });
const { runDesignHandoff } = await import(pathToFileURL(runnerFile).href);
const { designHandoffFailureMessages } = await import(pathToFileURL(path.join(checkout, 'cds', 'src', 'shared', 'design-handoff.ts')).href);
const { chromium } = await import(pathToFileURL(path.join(pwDir, 'index.mjs')).href).catch(() => import(pathToFileURL(path.join(pwDir, 'index.js')).href));
const chromePaths = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'];
const launch = async () => {
  try { return await chromium.launch({ headless: true }); } catch { /* 没有自带的 Chromium，用本机 Chrome */ }
  const chrome = chromePaths.find(candidate => candidate && existsSync(candidate));
  if (!chrome) fail('没有可用的浏览器：装 playwright 的 Chromium，或用 CHROME_PATH 指向本机 Chrome');
  return chromium.launch({ headless: true, executablePath: chrome });
};

const prototypeFile = path.join(dir, design.prototype ?? 'dist/index.html');
const prototype = readFileSync(prototypeFile);
const used = new Set(cases.map(item => item.screenId));
const screens = (design.screens ?? []).filter(screen => used.has(screen.id));
/* 回执绑定这份原型和这组场景（含用到的画面声明）：原型或场景一改，回执就作废，门禁要求重跑 */
const binding = createHash('sha256').update(prototype).update(JSON.stringify({ cases, screens })).digest('hex');
const browser = await launch();
let results;
try {
  results = await runDesignHandoff(browser, { prototype, screens, cases: cases.map(item => ({ ...item, theme: item.theme ?? screens.find(s => s.id === item.screenId)?.themes?.[0] ?? 'light' })) });
} finally {
  await browser.close().catch(() => {});
}
const status = results.every(row => row.status === 'passed') ? 'passed' : results.some(row => row.status === 'failed') ? 'failed' : 'unavailable';
const receipt = { policy: 'local-prototype-v1', status, binding, runAt: new Date().toISOString(),
  runner: path.relative(checkout, runnerFile).split(path.sep).join('/'),
  cases: results.map(row => ({ ...row, ruleIds: cases.find(item => item.id === row.caseId)?.ruleIds ?? [], ...(row.code ? { message: designHandoffFailureMessages[row.code] } : {}) })) };
writeFileSync(path.join(dir, 'checks', 'handoff.json'), JSON.stringify(receipt, null, 1) + '\n');
for (const row of receipt.cases) if (row.status !== 'passed') console.error(`  ${row.caseId}：第 ${row.step ?? '?'} 步 ${row.code} · ${row.message}`);
console.log(JSON.stringify({ handoff: status, cases: results.length, passed: results.filter(row => row.status === 'passed').length }));
process.exit(status === 'passed' ? 0 : 1);
