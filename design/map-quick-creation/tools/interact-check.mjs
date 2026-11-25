// 交互走查：在同样的 CDS 预览容器里点真实路径并读结果（作者自检的一部分，结论写进 tools/walkthrough.json）。
//   node tools/interact-check.mjs --checkout <仓库根>
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const i = argv.indexOf('--checkout');
const checkout = path.resolve(i >= 0 ? argv[i + 1] : path.join(dir, '..', '..'));
const req = createRequire(path.join(checkout, 'prd-admin', 'package.json'));
let chromium; try { ({ chromium } = req('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }
const ts = readFileSync(path.join(checkout, 'cds/src/services/design-prototype.ts'), 'utf8');
const csp = ts.match(/designPrototypeCsp = \[([\s\S]*?)\]\.join/)[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1)).join('; ');
const bridge = ts.match(/const prototypeBridge = `([\s\S]*?)`;\n/)[1];
const raw = readFileSync(path.join(dir, 'dist/index.html'), 'utf8');
const h = raw.match(/<head(?:\s[^>]*)?>/i);
const html = raw.slice(0, h.index + h[0].length) + bridge + raw.slice(h.index + h[0].length);
const server = http.createServer((rq, res) => {
  if (rq.url.startsWith('/proto')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }); res.end(html); return; }
  const q = new URL(rq.url, 'http://x').searchParams;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/proto?theme=dark${q.get('r') ?? ''}" style="border:0;width:100vw;height:100vh"></iframe>`);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const out = {};
async function open(route) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/?r=${encodeURIComponent(route)}`);
  await p.waitForTimeout(400);
  return { f: p.frames()[1], ctx };
}
const clock = f => f.$$eval('[data-qc=video-player] span', s => s.map(x => x.innerText).find(x => /\d:\d\d \/ /.test(x)));
const captions = f => f.$$eval('[data-qc=video-player] div', s => s.filter(x => x.className.includes('bg-black/75')).length);

{ const { f, ctx } = await open('#/quick-creation-agent?view=works');
  await f.waitForSelector('[data-qc-ready=works]');
  await f.click('[data-qc=works] li button');
  await f.waitForSelector('[data-qc-ready^=run-]', { timeout: 8000 }).catch(() => {});
  out['A-23'] = { title: await f.$eval('[data-qc=project-title]', e => e.innerText).catch(() => null), state: await f.$eval('[data-qc-ready]', e => e.getAttribute('data-qc-ready')) };
  await ctx.close(); }

{ const { f, ctx } = await open('#/quick-creation-agent?run=run-done');
  await f.waitForSelector('[data-qc=video-player]');
  const before = await clock(f);
  await f.click('[aria-label=下一幕]'); await f.waitForTimeout(200);
  const afterNext = await clock(f);
  const capOn = await captions(f);
  await f.click('[aria-label=关闭字幕]'); await f.waitForTimeout(100);
  const capOff = await captions(f);
  await f.click('[aria-label=播放]'); await f.waitForTimeout(2300);
  out['A-26'] = { before, afterNext, captionsBefore: capOn, captionsAfterToggle: capOff, afterPlay2s: await clock(f) };
  await ctx.close(); }

{ const { f, ctx } = await open('#/quick-creation-agent?run=run-done');
  await f.waitForSelector('[data-qc=publish]');
  await f.click('[data-qc=publish]');
  const failed = await f.waitForSelector('[data-qc=publish-failed]', { timeout: 6000 }).then(() => true).catch(() => false);
  await f.click('[data-qc=publish-failed] button');
  const done = await f.waitForSelector('[data-qc=published]', { timeout: 6000 }).then(() => true).catch(() => false);
  await f.click('[data-qc=published] button');
  const landed = await f.waitForSelector('[data-qc=focused-site]', { timeout: 6000 }).then(() => true).catch(() => false);
  out['A-30'] = { firstPublishFailed: failed, retryPublished: done, landedOnHostingRecord: landed };
  await ctx.close(); }

{ const { f, ctx } = await open('#/quick-creation-agent?run=run-web-done');
  await f.waitForSelector('[data-qc=web-preview]');
  const points = await f.$$('[data-qc=web-preview] > div:last-child button');
  await points[1].click(); await f.waitForTimeout(200);
  out['A-32'] = { scopeSectionOutline: await f.$eval('#qc-scope', e => getComputedStyle(e).outlineStyle) };
  await ctx.close(); }

{ const { f, ctx } = await open('#/quick-creation-agent?run=run-done');
  await f.waitForSelector('[data-qc=video-player]');
  await f.click('text=用这份稿件做网页');
  await f.waitForSelector('[data-qc-ready=compose]');
  out['A-33'] = {
    tray: await f.$eval('[data-qc=tray-toggle]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => null),
    ask: await f.$eval('#qc-ask', e => e.value),
    outputBadge: await f.$$eval('span', s => s.map(x => x.innerText).find(x => /^网页 · /.test(x)) ?? null),
  };
  await ctx.close(); }

console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
