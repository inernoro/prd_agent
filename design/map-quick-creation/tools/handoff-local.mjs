// 交接场景本机预跑：按 design.json.handoff.cases 在还原的 CDS 预览容器里逐步执行，发布前先发现选择器、时序与恢复问题。
// 语义按技能 design-intake.md「交接检查」：选择器须在本画面唯一；expect 支持 text / value / attribute / visible / enabled 与 sameAs；
// remember 记住已完成的状态；media-playing 检查媒体在走，audio-playing 还检查音轨已解码。结论以 CDS 服务端回执为准。
//   node tools/handoff-local.mjs --checkout <仓库根> [--case <编号>]
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const checkout = path.resolve(opt('checkout') ?? path.join(dir, '..', '..'));
const only = opt('case');
const req = createRequire(path.join(checkout, 'prd-admin', 'package.json'));
let chromium; try { ({ chromium } = req('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }
const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
const contract = JSON.parse(readFileSync(path.join(checkout, '.claude/skills/cds/cli/design-preview-contract.json'), 'utf8'));
const raw = readFileSync(path.join(dir, design.prototype), 'utf8');
const head = raw.match(/<head(?:\s[^>]*)?>/i);
const html = raw.slice(0, head.index + head[0].length) + `<script data-entry-timeout="${contract.entryTimeoutMs}">\n${contract.bridge.join('\n')}\n</script>` + raw.slice(head.index + head[0].length);
const server = http.createServer((rq, res) => {
  if (rq.url.startsWith('/proto')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': contract.csp.join('; ') }); res.end(html); return; }
  const q = new URL(rq.url, 'http://x').searchParams;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><iframe id="f" sandbox="allow-scripts" allow="autoplay" src="/proto?theme=${q.get('theme')}${q.get('route') ?? ''}" style="border:0;width:100vw;height:100vh"></iframe>`);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const screens = new Map(design.screens.map(s => [s.id, s]));
const results = [];

async function only1(frame, selector) {
  const n = await frame.$$eval(selector, els => els.length);
  if (n !== 1) throw new Error(`选择器须唯一，实际 ${n} 个：${selector}`);
  return frame.$(selector);
}
async function readCheck(frame, step) {
  const el = await only1(frame, step.selector);
  if (step.check === 'attribute') return el.getAttribute(step.attribute);
  if (step.check === 'value') return el.inputValue();
  if (step.check === 'text') return (await el.innerText()).trim();
  if (step.check === 'visible') return String(await el.isVisible());
  if (step.check === 'enabled') return String(await el.isEnabled());
  throw new Error(`不支持的检查：${step.check}`);
}
/* 等待上限取 3 秒：比 CDS 交接检查更严，避免本机预跑放过只在宽松等待下才通过的场景（V2 回执的 retry-failed-scene 就是这样） */
const WAIT_MS = Number(opt('wait') ?? 3000);
async function until(fn, ms = WAIT_MS) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const r = await fn(); if (r === true) return; last = r; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 150)); }
  throw new Error(typeof last === 'string' ? last : `超时：${JSON.stringify(last)}`);
}

for (const c of design.handoff.cases) {
  if (only && c.id !== only) continue;
  const screen = screens.get(c.screenId);
  const phone = screen.viewport === 'phone';
  const ctx = await browser.newContext({ viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/?theme=${c.theme}&route=${encodeURIComponent(screen.route)}`);
  const frame = page.frames()[1];
  const memory = {};
  let failed = null;
  try {
    await frame.waitForSelector('[data-qc-ready]', { timeout: 15000 });
    for (const a of screen.entryActions ?? []) { await frame.click(a, { timeout: 5000 }); await page.waitForTimeout(250); }
    await frame.waitForSelector(screen.entryReadySelector, { timeout: 8000 });
    for (const [k, step] of c.steps.entries()) {
      try {
        if (step.action === 'click') { const el = await only1(frame, step.selector); await el.click({ timeout: 5000 }); }
        else if (step.action === 'fill') { const el = await only1(frame, step.selector); await el.fill(step.value); }
        else if (step.action === 'select') { const el = await only1(frame, step.selector); await el.selectOption(step.value); }
        else if (step.action === 'attach') { const el = await only1(frame, step.selector); await el.setInputFiles({ name: step.name, mimeType: /\.md$/.test(step.name) ? 'text/markdown' : 'text/plain', buffer: Buffer.from(step.value) }); }
        else if (step.action === 'remember') memory[step.as] = await readCheck(frame, step);
        else if (step.action === 'expect') {
          if (step.check === 'media-playing' || step.check === 'audio-playing') {
            await only1(frame, step.selector);
            const t0 = await frame.$eval(step.selector, v => v.currentTime);
            await until(async () => {
              const s = await frame.$eval(step.selector, v => ({ paused: v.paused, t: v.currentTime, audio: v.webkitAudioDecodedByteCount ?? (v.mozHasAudio ? 1 : 0), ready: v.readyState }));
              const moving = !s.paused && s.t > t0 + 0.3;
              return (step.check === 'media-playing' ? moving : moving && s.audio > 0) || s;
            });
          } else {
            const want = step.sameAs !== undefined ? memory[step.sameAs] : step.equals !== undefined ? String(step.equals) : 'true';
            await until(async () => { const got = await readCheck(frame, step); return got === want || { want, got }; });
          }
        } else if (step.action === 'media-playing' || step.action === 'audio-playing') {
          await only1(frame, step.selector);
          const t0 = await frame.$eval(step.selector, v => v.currentTime);
          await until(async () => {
            const s = await frame.$eval(step.selector, v => ({ paused: v.paused, t: v.currentTime, audio: v.webkitAudioDecodedByteCount ?? (v.mozHasAudio ? 1 : 0), ready: v.readyState }));
            const moving = !s.paused && s.t > t0 + 0.3;
            return (step.action === 'media-playing' ? moving : moving && s.audio > 0) || s;
          });
        } else throw new Error(`不支持的动作：${step.action}`);
        await page.waitForTimeout(150);
      } catch (e) { failed = { step: k + 1, action: step.action, selector: step.selector, reason: e.message.split('\n')[0].slice(0, 240) }; break; }
    }
  } catch (e) { failed = failed ?? { step: 0, reason: `进入画面失败：${e.message.split('\n')[0]}` }; }
  results.push({ id: c.id, status: failed ? 'failed' : 'passed', ...(failed ? { failed } : {}), errors: errors.slice(0, 3) });
  await ctx.close();
}
await browser.close(); server.close();
writeFileSync(path.join(dir, 'checks/handoff-local.json'), JSON.stringify({ runAt: new Date().toISOString().slice(0, 10), note: '本机预跑，结论以 CDS 交接检查回执为准', results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(r => ({ id: r.id, status: r.status, ...(r.failed ? { failed: r.failed } : {}), ...(r.errors.length ? { errors: r.errors } : {}) })), null, 1));
