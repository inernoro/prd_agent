/** 固定版本的配对 A/B：正常登录与导航；原始记录不含认证头或正文。
 * KB_AB_CONFIG=/tmp/config.json MAP_USER=... MAP_PASSWORD=... OUT_DIR=/tmp/ab node e2e/knowledge-base-scale-ab.mjs
 * config: {versions:{before:{base,commit},after:{base,commit}},fixture,seed,pairsPerScale,environment}
 */
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const config = JSON.parse(fs.readFileSync(process.env.KB_AB_CONFIG));
const fixture = JSON.parse(fs.readFileSync(config.fixture));
const out = process.env.OUT_DIR || '/tmp/kb-scale-ab';
if (!process.env.MAP_USER || !process.env.MAP_PASSWORD) throw Error('需要正常登录凭据');
for (const v of Object.values(config.versions)) {
  if (!/^[a-f0-9]{40}$/.test(v.commit)) throw Error('版本必须固定完整提交');
  if (process.env.MAP_PROD_HOST && new URL(v.base).host === new URL(process.env.MAP_PROD_HOST).host) throw Error('禁止在生产运行规模实验');
}
if (config.pairsPerScale < 10) throw Error('每档至少10对');
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'samples.jsonl'))) throw Error('输出已有样本，请使用新目录，禁止覆盖实验');
fs.writeFileSync(path.join(out, 'protocol.json'), JSON.stringify({ ...config, fixture, startedAt: new Date().toISOString(), browser: 'Chromium', viewport: { width: 1440, height: 1000 }, warmupsPerVariantAndScale: 1, timing: '真实click/input事件到双RAF后的可见结果；界面确认含自动化观测开销', pairing: '每档10对；AB/BA各5对；每个区组打乱规模顺序', exclusions: '仅预声明预热；任何失败保留并终止，禁止挑选较快样本' }, null, 2));
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: process.env.NO_PROXY } : undefined });
const sessions = {};
const frame = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const append = (file, value) => fs.appendFileSync(path.join(out, file), JSON.stringify(value) + '\n');
const run = promisify(execFile);
async function guard(label) {
  if (!config.runtimeGuard?.command) return;
  const [command, ...args] = config.runtimeGuard.command;
  const { stdout } = await run(command, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
  append('runtime-guards.jsonl', { label, ...JSON.parse(stdout) });
}
let randomState = config.seed;
function random() { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; }
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
const deltaMetrics = (a, b) => Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(k => [k, (b[k] || 0) - (a[k] || 0)]));

async function session(mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__kbLongTasks = [];
    try { new PerformanceObserver(list => window.__kbLongTasks.push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true }); } catch { /* 浏览器不支持时由协议标注 */ }
    performance.setResourceTimingBufferSize(10000);
  });
  const p = await context.newPage(); p.setDefaultTimeout(45000);
  const cdp = await context.newCDPSession(p); await cdp.send('Performance.enable');
  const state = { mode, context, p, cdp, active: 'setup', requests: [], pending: [], nav: new Map(), duplicates: 0, errors: [] };
  p.on('pageerror', e => state.errors.push(e.message));
  const base = config.versions[mode].base;
  p.on('response', response => {
    const u = new URL(response.url());
    if (u.origin !== new URL(base).origin || !u.pathname.startsWith('/api/document-store/')) return;
    const stage = state.active;
    state.pending.push((async () => {
      await response.finished();
      const request = response.request(), timing = request.timing();
      const bytes = (await response.body()).length;
      state.requests.push({ stage, method: request.method(), path: u.pathname, query: u.search, status: response.status(), timing, responseBodyBytes: bytes });
      if (u.pathname.endsWith(`/stores/${state.storeId}/entries`) && !u.searchParams.has('keyword')) {
        const data = (await response.json()).data;
        for (const e of data?.items || []) { if (state.nav.has(e.id)) state.duplicates++; state.nav.set(e.id, { id: e.id, parentId: e.parentId, sourceType: e.sourceType, isFolder: e.isFolder }); }
      }
    })().catch(error => { state.requests.push({ stage, method: response.request().method(), path: u.pathname, query: u.search, status: response.status(), observationError: String(error) }); }));
  });
  await p.goto(new URL('/login', base).href, { waitUntil: 'domcontentloaded' });
  await p.getByPlaceholder('admin', { exact: true }).fill(process.env.MAP_USER);
  await p.locator('input[type=password]').fill(process.env.MAP_PASSWORD);
  const loginResponse = p.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/login' && r.request().method() === 'POST');
  await p.getByRole('button', { name: '进入控制台' }).click();
  state.token = (await (await loginResponse).json()).data.accessToken;
  await p.waitForURL(u => !u.pathname.includes('/login'));
  sessions[mode] = state; return state;
}

async function start(state, name, locator, event = 'click') {
  state.active = name; const before = await metrics(state.cdp);
  await locator.evaluate((el, event) => el.addEventListener(event, () => { window.__kbStart = performance.now(); window.__kbStartEpoch = performance.timeOrigin + window.__kbStart; window.__kbMountedBefore = document.querySelectorAll('[data-entry-id]').length; }, { once: true, capture: true }), event);
  return before;
}
async function end(state, before) {
  await frame(state.p);
  const observed = await state.p.evaluate(() => ({ ms: performance.now() - window.__kbStart, startEpoch: window.__kbStartEpoch, mountedBefore: window.__kbMountedBefore, mountedAfter: document.querySelectorAll('[data-entry-id]').length, longTasks: (window.__kbLongTasks || []).filter(e => e.startTime >= window.__kbStart) }));
  return { ...observed, browserMainThread: deltaMetrics(before, await metrics(state.cdp)) };
}

async function trial(mode, store, block, warmup, order) {
  const state = sessions[mode], p = state.p;
  await p.bringToFront(); state.active = 'setup';
  await p.getByText('知识库', { exact: true }).first().click();
  await p.locator('[data-tour-id=library-toolbar]').waitFor();
  await p.getByPlaceholder('按名称或标签筛选…').fill(store.nameFilter || store.runId || store.name);
  const card = p.getByText(store.name, { exact: true }); await card.waitFor();
  if (await p.getByRole('button', { name: '我已学会' }).isVisible().catch(() => false)) await p.getByRole('button', { name: '我已学会' }).click();
  await Promise.all(state.pending); state.requests = []; state.pending = []; state.nav.clear(); state.duplicates = 0; state.storeId = store.id;
  const browseStart = await start(state, 'browse', card); await card.click();
  const search = p.getByPlaceholder('搜索标题或内容…'); await search.waitFor();
  await p.locator('[data-entry-id]').first().waitFor(); const browse = await end(state, browseStart);
  await expect(p.getByText(/正在补齐目录/)).toHaveCount(0, { timeout: 45000 });
  await expect(p.getByText('文档列表尚未加载完整', { exact: false })).toHaveCount(0);
  await Promise.all(state.pending);
  const completeNavigation = await end(state, browseStart);
  if (mode === 'after') { expect(state.nav.size).toBe(store.expectedEntries); expect(state.duplicates).toBe(0); }
  const navSnapshot = { uniqueEntries: state.nav.size, expectedEntries: store.expectedEntries, complete: state.nav.size === store.expectedEntries, duplicates: state.duplicates, folderChildren: [...state.nav.values()].filter(e => e.parentId === store.folderId).length };
  const folder = p.locator(`[data-entry-id="${store.folderId}"]`);
  if (!(await folder.count()) && await p.getByRole('button', { name: '从头浏览', exact: true }).isVisible().catch(() => false)) await p.getByRole('button', { name: '从头浏览', exact: true }).click();
  await folder.scrollIntoViewIfNeeded();
  if (await folder.locator('svg.lucide-chevron-down').count()) { await folder.click(); await folder.locator('svg.lucide-chevron-right').waitFor(); }
  const expandStart = await start(state, 'expand', folder); await folder.click(); await folder.locator('svg.lucide-chevron-down').waitFor(); const expand = await end(state, expandStart);
  const spinner = search.locator('..').getByRole('status', { name: '加载中', exact: true });
  const responsePromise = p.waitForResponse(r => { const u = new URL(r.url()); return u.pathname.endsWith(`/stores/${store.id}/entries`) && u.searchParams.get('keyword') === '样本文档'; });
  const searchStart = await start(state, 'search', search, 'input'); await search.fill('样本文档');
  const response = await responsePromise; await response.finished(); await expect(spinner).toHaveCount(0); const searchResult = await end(state, searchStart);
  const broad = (await response.json()).data;
  state.active = 'prepare-open';
  await search.fill('样本文档 00000'); const other = p.locator(`[data-entry-id="${store.firstEntryId}"]`); await other.waitFor();
  await expect(spinner).toHaveCount(0); await other.click(); await p.waitForFunction(t => document.body.innerText.includes(t), `文末唯一词 tail-${store.n}-0`);
  await search.fill(`样本文档 ${String(store.n - 1).padStart(5, '0')}`); const last = p.locator(`[data-entry-id="${store.lastEntryId}"]`); await last.waitFor(); await expect(spinner).toHaveCount(0);
  const contentResponsePromise = p.waitForResponse(r => new URL(r.url()).pathname.endsWith(`/entries/${store.lastEntryId}/content`));
  const openStart = await start(state, 'open', last); await last.click(); expect((await contentResponsePromise).status()).toBe(200);
  await p.waitForFunction(t => document.body.innerText.includes(t), store.tail); const open = await end(state, openStart);
  await Promise.all(state.pending);
  const openRequests = state.requests.filter(r => r.stage === 'open' && r.path.endsWith(`/entries/${store.lastEntryId}/content`)); expect(openRequests).toHaveLength(1);
  expect(state.requests.filter(r => r.status >= 400)).toEqual([]); expect(state.errors).toEqual([]);
  // 等量接口诊断与真人路径分开：同一授权主体、同一关键词、相同50条页大小。
  const query = new URLSearchParams({ all: 'true', navigation: 'true', pageSize: '50', keyword: '样本文档', searchContent: 'true' });
  const apiStart = performance.now();
  const api = await state.context.request.get(new URL(`/api/document-store/stores/${store.id}/entries?${query}`, config.versions[mode].base).href, { headers: { Authorization: `Bearer ${state.token}` } });
  const apiBody = await api.body(); const apiMs = performance.now() - apiStart; const apiData = JSON.parse(apiBody).data;
  expect(api.status()).toBe(200); expect(apiData.items).toHaveLength(50);
  const equalPageApi = { scope: 'API诊断，不计入UI耗时', query: query.toString(), ms: apiMs, returned: apiData.items.length, total: apiData.total, responseBodyBytes: apiBody.length };
  const record = { mode, commit: config.versions[mode].commit, n: store.n, block, order, warmup, timestamp: new Date().toISOString(), load: os.loadavg(), navigation: navSnapshot, broadSearch: { returned: broad.items.length, total: broad.total }, browse, completeNavigation, expand, search: searchResult, open, equalPageApi, requests: state.requests };
  append(warmup ? 'warmups.jsonl' : 'samples.jsonl', record);
  console.log(JSON.stringify({ mode, n: store.n, block, warmup, browseMs: browse.ms, completeMs: completeNavigation.ms, searchMs: searchResult.ms, expandMs: expand.ms, openMs: open.ms, navCount: state.nav.size }));
  return record;
}

try {
  await guard('before-login');
  await session('before'); await session('after');
  for (const store of fixture) for (const mode of ['before', 'after']) await trial(mode, store, 0, true, ['before', 'after']);
  await guard('after-warmups');
  for (let block = 1; block <= config.pairsPerScale; block++) {
    const stores = [...fixture]; for (let i = stores.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [stores[i], stores[j]] = [stores[j], stores[i]]; }
    for (const store of stores) {
      await guard(`before-${block}-${store.n}`);
      const order = (block + fixture.findIndex(s => s.n === store.n)) % 2 ? ['before', 'after'] : ['after', 'before'];
      const records = [];
      for (const mode of order) records.push(await trial(mode, store, block, false, order));
      append('pairs.jsonl', { block, n: store.n, order, records });
      await guard(`after-${block}-${store.n}`);
    }
  }
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.txt'), String(error));
  fs.writeFileSync(path.join(out, 'failure-observations.json'), JSON.stringify(Object.fromEntries(Object.entries(sessions).map(([mode, s]) => [mode, { stage: s.active, requests: s.requests, navigationEntries: s.nav.size, errors: s.errors }])), null, 2));
  for (const [mode, s] of Object.entries(sessions)) await s.p.screenshot({ path: path.join(out, `failure-${mode}.png`) }).catch(() => {});
  throw error;
} finally { await browser.close(); }
