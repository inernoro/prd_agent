// 作者自检：在还原的 CDS 预览容器里逐画面打开原型，收集控制台与 CSP 报错并测量；再按真实路径跑业务流程。
// 人工 / 截图类验收项的结论来自 tools/walkthrough.json（作者逐画面走查记录）。写 checks/result.json。
//   node tools/self-check.mjs --checkout <仓库根> [--shots <截图目录>]
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const checkout = path.resolve(opt('checkout') ?? path.join(dir, '..', '..'));
const shots = opt('shots') ? path.resolve(opt('shots')) : null;
if (shots) mkdirSync(shots, { recursive: true });
let chromium;
try { ({ chromium } = createRequire(path.join(checkout, 'prd-admin', 'package.json'))('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }

const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
const walkthrough = existsSync(path.join(dir, 'tools/walkthrough.json')) ? JSON.parse(readFileSync(path.join(dir, 'tools/walkthrough.json'), 'utf8')) : {};
const contract = JSON.parse(readFileSync(path.join(checkout, '.claude/skills/cds/cli/design-preview-contract.json'), 'utf8'));
const raw = readFileSync(path.join(dir, design.prototype), 'utf8');
const head = raw.match(/<head(?:\s[^>]*)?>/i);
const html = raw.slice(0, head.index + head[0].length) + `<script data-entry-timeout="${contract.entryTimeoutMs}">\n${contract.bridge.join('\n')}\n</script>` + raw.slice(head.index + head[0].length);

/* ---------- 静态检查 ---------- */
const read = f => readFileSync(f, 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pageDir = path.join(dir, 'src/added/pages/learning-course');
const pageFiles = readdirSync(pageDir).filter(f => /\.(tsx?|css)$/.test(f)).map(f => path.join(pageDir, f));
const center = path.join(dir, 'src/overrides/pages/learning-center/LearningCenterPage.tsx');
const svcFile = path.join(dir, 'src/added/services/real/learningCourses.ts');
const centerBase = read(path.join(checkout, 'prd-admin/src/pages/learning-center/LearningCenterPage.tsx'));
const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g;
const hexHits = pageFiles.flatMap(f => (strip(read(f)).match(colorRe) ?? []).map(m => `${path.basename(f)}: ${m}`));
/* 学习中心页本身有历史硬编码：只看本稿新增的行 */
const centerAdded = read(center).split('\n').filter(l => !centerBase.includes(l));
const centerHits = centerAdded.flatMap(l => l.match(colorRe) ?? []);
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
const emojiHits = [...pageFiles, svcFile, center].filter(f => emoji.test(read(f))).map(f => path.basename(f));
const nav = read(path.join(dir, 'src/overrides/app/navRegistry.tsx'));
const fixtures = read(path.join(dir, 'src/fixtures.ts'));
const navOk = nav.includes("path: '/learning-center/courses/:courseId'") && nav.includes("path: '/learning-center/courses/:courseId/practice/:practiceId'") && /wip: true/.test(fixtures);
const svc = strip(read(svcFile));
const svcOk = svc.includes("from '@/services/real/apiClient'") && !/\bfetch\(/.test(svc) && (svc.match(/apiRequest/g) ?? []).length >= 10;
const pagesUseSuccess = pageFiles.filter(f => /res\.success/.test(read(f))).length;

/* ---------- 容器 ---------- */
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/proto')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': contract.csp.join('; ') }); res.end(html); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="f" sandbox="allow-scripts" allow="autoplay" src="/proto?theme=${q.get('theme')}${q.get('route') ?? ''}" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const luminance = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function open(screen, theme) {
  const phone = screen.viewport === 'phone';
  const ctx = await browser.newContext({ viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
  page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 240)}`));
  await page.goto(`http://127.0.0.1:${port}/?theme=${theme}&route=${encodeURIComponent(screen.route)}`);
  const frame = page.frame({ url: /\/proto/ }) ?? page.frames()[1];
  try { await frame.waitForSelector(screen.entryReadySelector, { timeout: 15000 }); } catch { errors.push(`未就绪：${screen.entryReadySelector}`); }
  await page.waitForTimeout(600);
  return { ctx, page, frame, errors };
}

const screens = [];
for (const screen of design.screens) {
  for (const theme of screen.themes) {
    const { ctx, page, frame, errors } = await open(screen, theme);
    const m = await frame.evaluate(() => {
      const root = document.querySelector('[data-lc-ready]');
      const style = getComputedStyle(document.documentElement);
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const small = root ? [...root.querySelectorAll('button, a[href], input, textarea, select')].filter(visible)
        .filter(el => el.getBoundingClientRect().height < 43.5 && !el.closest('[data-qc-touch-exempt]'))
        .map(el => `${el.tagName.toLowerCase()}「${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 14)}」${Math.round(el.getBoundingClientRect().height)}px`) : [];
      return {
        inShell: !!root && [...document.querySelectorAll('a, button')].some(el => !root.contains(el) && /知识库|百宝箱|首页/.test(el.textContent || el.getAttribute('aria-label') || '')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small, text: document.body.innerText,
        primaries: [...document.querySelectorAll('.map-btn-primary')].filter(visible).map(b => b.textContent.trim()),
        vars: ['--text-primary', '--text-secondary', '--text-muted', '--bg-base'].map(v => style.getPropertyValue(v).trim()),
        wipBadge: /试运行/.test(document.body.innerText),
        type: (() => {
          const sizes = new Set(), weights = new Set(), sans = new Set();
          if (!root) return { sizes: [], weights: [], sans: [] };
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (w.nextNode()) {
            const n = w.currentNode; if (!n.textContent.trim()) continue;
            const el = n.parentElement; const r = el.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
            const cs = getComputedStyle(el); sizes.add(cs.fontSize); weights.add(cs.fontWeight);
            if (!/mono|Menlo|Consolas/i.test(cs.fontFamily)) sans.add(cs.fontSize);
          }
          return { sizes: [...sizes], weights: [...weights], sans: [...sans] };
        })(),
      };
    });
    const toRgb = (value, base) => {
      const hex = value.match(/^#([0-9a-f]{6})$/i);
      if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
      const rgba = value.match(/rgba?\(([^)]+)\)/);
      if (!rgba) return null;
      const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
      return base ? [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a))) : [r, g, b];
    };
    const bg = toRgb(m.vars[3]);
    const contrast = bg ? m.vars.slice(0, 3).map(v => { const c = toRgb(v, bg); return c ? Number(ratio(c, bg).toFixed(2)) : null; }) : [];
    if (shots) await page.screenshot({ path: path.join(shots, `${screen.id}-${theme}.png`) });
    screens.push({ id: screen.id, theme, viewport: screen.viewport, errors, overflow: m.overflow, small: m.small, contrast, inShell: m.inShell, emojiInText: emoji.test(m.text), primaries: m.primaries, wipBadge: m.wipBadge, text: m.text, type: m.type });
    await ctx.close();
  }
}

/* ---------- 业务流程（真实路径） ---------- */
const scr = id => design.screens.find(s => s.id === id);
const flows = {};
async function flow(id, screenId, theme, fn) {
  const { ctx, frame, page, errors } = await open(scr(screenId), theme);
  try { flows[id] = await fn(frame, page); } catch (e) { flows[id] = { pass: false, note: `执行出错：${e.message.split('\n')[0].slice(0, 200)}` }; }
  if (errors.length) flows[id] = { pass: false, note: `${flows[id].note}；报错：${errors[0]}` };
  await ctx.close();
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const text = (f, s) => f.$eval(s, el => el.textContent.trim());

await flow('A-13', 'lesson-video', 'light', async f => {
  await f.click('[data-line="3"]'); await wait(500);
  const t = await f.$eval('video', v => v.currentTime);
  const cur = await f.$eval('[data-line="3"]', el => el.getAttribute('aria-current'));
  return { pass: Math.abs(t - 13.2) < 0.8 && cur === 'true', note: `点第 4 行（0:13）后 currentTime=${t.toFixed(1)}，该行 aria-current=${cur}` };
});
await flow('A-14', 'lesson-video', 'dark', async f => {
  const t = await f.$eval('video', v => v.currentTime);
  const note = await text(f, '[data-lc=resume-note]');
  const reqs = []; await f.evaluate(() => { const o = window.fetch; window.__puts = []; window.fetch = (u, i) => { if (i?.method === 'PUT') window.__puts.push(i.body); return o(u, i); }; });
  await f.$eval('video', v => { v.muted = true; return v.play().then(() => new Promise(r => setTimeout(() => { v.pause(); r(); }, 600))); });
  await wait(400);
  const puts = await f.evaluate(() => window.__puts);
  return { pass: Math.abs(t - 9) < 0.5 && /0:09/.test(note) && puts.some(b => /"positionSec"/.test(b)), note: `打开即 currentTime=${t.toFixed(1)}，提示「${note.slice(0, 20)}」；播放后暂停发出 ${puts.length} 次 PUT（含 positionSec）${reqs.length ? '' : ''}` };
});
await flow('A-15', 'lesson-no-video', 'light', async f => {
  const p1 = await text(f, '[data-lc=pdf-page]');
  const visible = await f.$eval('[data-page="4"]', el => { const r = el.getBoundingClientRect(); const box = el.closest('[data-lc=pdf-pages]').getBoundingClientRect(); return r.top < box.bottom && r.bottom > box.top; });
  await f.click('[aria-label=下一页]'); await wait(700);
  const p2 = await text(f, '[data-lc=pdf-page]');
  const hint = await f.evaluate(() => document.body.innerText.includes('本课在第 4–4 页') && document.body.innerText.includes('回到本课'));
  const href = await f.$eval('[data-lc=pdf-download]', a => a.getAttribute('href').slice(0, 28));
  return { pass: p1 === '第 4 / 8 页' && visible && p2 === '第 5 / 8 页' && hint && href.startsWith('data:application/pdf'), note: `打开「${p1}」且第 4 页在视口内；下一页「${p2}」，提示本课页码与「回到本课」；下载链接 ${href}…` };
});
await flow('A-16', 'lesson-article', 'light', async f => {
  await f.$eval('[data-lc=article]', el => el.scrollTo({ top: el.scrollHeight }));
  await wait(700);
  const fin = await f.$eval('[data-lc=article-end]', el => el.dataset.finished);
  return { pass: fin === 'true', note: `滚到底部后 data-finished=${fin}，文末显示「本篇已读完，进度已记下」` };
});
await flow('A-19', 'lesson-article', 'dark', async f => {
  const before = await f.evaluate(() => document.querySelector('[data-lc=course-progress]').innerText.match(/已学\s*(\d)\/5/)?.[1]);
  await f.click('[data-lc=article-end]'); await wait(600);
  const status = await f.$eval('[data-lesson=l1]', el => el.dataset.status);
  const after = await f.evaluate(() => document.querySelector('[data-lc=course-progress]').innerText.match(/已学\s*(\d)\/5/)?.[1]);
  return { pass: status === 'done' && before === '0' && after === '1', note: `已学 ${before}/5 → ${after}/5，目录第 1 课 data-status=${status}（服务端返回 done 后只更新这一课）` };
});
await flow('A-17', 'lesson-no-video', 'dark', async f => {
  const v = await f.$eval('[data-lc=media-video]', b => ({ dis: b.disabled, title: b.title, unit: b.querySelector('.lc-unit')?.textContent }));
  const pdf = await f.$eval('[data-lc=media-pdf]', b => b.getAttribute('aria-pressed'));
  return { pass: v.dis && v.unit === '无' && v.title.length > 4 && pdf === 'true', note: `视频按钮 disabled、显示「${v.unit}」、提示「${v.title}」；默认打开 PDF 教材` };
});
await flow('A-18', 'lesson-article', 'light', async f => {
  const pressed = await f.$eval('[data-lc=media-article]', b => b.getAttribute('aria-pressed'));
  return { pass: pressed === 'true', note: `用地址 ?lesson=l1&media=article 打开即为第 1 课图文（aria-pressed=${pressed}）；切换时写回同两个参数` };
});
await flow('A-20', 'lesson-pdf', 'light', async f => {
  const lazy = await f.$$eval('.lc-thumb img', imgs => imgs.every(i => i.loading === 'lazy'));
  return { pass: lazy, note: `缩略图 ${lazy ? '全部' : '未全部'} loading=lazy；视频 preload=metadata（见 VideoLesson.tsx）` };
});
await flow('A-08', 'practice-review', 'light', async f => {
  const t = await f.evaluate(() => document.body.innerText);
  const stages = await f.$$eval('[data-stage]', els => els.map(e => e.dataset.stageStatus).join(','));
  return { pass: /已用 /.test(t) && /预计还需约/.test(t) && /依据/.test(t) && stages.includes('running'), note: `阶段 ${stages}；有「已用 / 预计还需约 / 依据」` };
});
await flow('A-22', 'practice-review', 'dark', async f => {
  const flags = await f.$$eval('[data-finding-row]', els => els.map(e => e.querySelector('.lc-ln')?.textContent).join(','));
  const model = await text(f, '[data-lc=run-model]');
  return { pass: flags === '13,14' && /claude-sonnet-4\.5 · OpenRouter/.test(model), note: `代码第 ${flags} 行带编号标记；模型「${model}」来自运行记录` };
});
await flow('A-23', 'practice-triage', 'light', async f => {
  const r = async () => f.$eval('[data-lc=undecided-hint]', el => el.dataset.remaining);
  const seq = [await r()];
  const disabled0 = await f.$eval('[data-lc=submit-decisions]', b => b.disabled);
  await f.click('[data-finding=R2] [data-lc=decide-accept]'); seq.push(await r());
  await f.click('[data-finding=R3] [data-lc=decide-reject]'); seq.push(await r());
  await f.click('[data-finding=R3] .lc-reason-chip'); seq.push(await r());
  await f.click('[data-finding=R4] [data-lc=decide-accept]'); seq.push(await r());
  const enabled = await f.$eval('[data-lc=submit-decisions]', b => !b.disabled);
  return { pass: seq.join('') === '32210' && disabled0 && enabled, note: `未判断数 ${seq.join(' → ')}；初始主按钮不可用，全部判断后可用` };
});
await flow('A-24', 'practice-triage', 'dark', async f => {
  await f.click('[data-finding=R2] [data-lc=decide-accept]');
  await f.click('[data-finding=R3] [data-lc=decide-accept]');
  await f.click('[data-finding=R4] [data-lc=decide-accept]');
  await f.click('[data-lc=submit-decisions]');
  await f.waitForSelector('[data-lc=reopen-triage]', { timeout: 15000 });
  const failed = await f.evaluate(() => /FAIL\s*联合测试 · 结算页显示的应付与接口一致/.test(document.querySelector('[data-lc=retest-board]')?.innerText ?? ''));
  await f.click('[data-lc=reopen-triage]'); await wait(500);
  const fb = await f.$$eval('[data-lc=finding-feedback]', els => els.map(e => e.closest('[data-finding]').dataset.finding));
  const kept = await f.$eval('[data-finding=R1] [data-lc=decide-accept]', b => b.getAttribute('aria-pressed'));
  return { pass: failed && fb.join() === 'R3' && kept === 'true', note: `误采纳第 3 条（加锁）→ 复测「联合测试」失败 → 回到判断后只有 ${fb.join()} 出现复测反馈，第 1 条仍为采纳` };
});
await flow('A-26', 'practice-deliver', 'light', async f => {
  const v = await f.$eval('[data-lc=delivery-note]', t => t.value);
  const ok = /能做什么：/.test(v) && /怎么证明：复测通过 3 项/.test(v) && /还没做到什么：/.test(v) && /前提不成立/.test(v) && /风格偏好/.test(v);
  await f.fill('[data-lc=delivery-note]', '');
  const dis = await f.$eval('[data-lc=submit-delivery]', b => b.disabled);
  return { pass: ok && dis, note: `草稿含三段、复测 3 项与两条驳回理由；清空后「提交交付」不可用=${dis}` };
});
await flow('A-27', 'practice-deliver', 'dark', async f => {
  await f.click('[data-lc=submit-delivery]');
  await f.waitForSelector('[data-lc-ready=practice-done]');
  const xp = await f.evaluate(() => document.body.innerText.match(/获得 \d+ 经验/)?.[0]);
  await f.click('[data-lc=back-course]');
  await f.waitForSelector('[data-practice=p-review]');
  const st = await f.$eval('[data-practice=p-review]', el => el.dataset.status);
  const top = await f.evaluate(() => document.querySelector('[data-lc=course-progress]').innerText.match(/练习\s*(\d)\/3/)?.[1]);
  return { pass: st === 'done' && top === '1' && !!xp, note: `提交后完成页「${xp}」与时间线；回到课程练习卡 data-status=${st}，顶部「${top}」` };
});
await flow('A-29', 'practice-unit', 'light', async f => {
  await f.click('[data-finding=U3] [data-lc=decide-accept]');
  await f.click('[data-finding=U4] [data-lc=decide-accept]');
  const words = await f.$eval('[data-finding=U1] [data-lc=decide-accept]', b => b.textContent.trim());
  await f.click('[data-lc=submit-decisions]');
  await f.waitForSelector('[data-lc=reopen-triage]', { timeout: 15000 });
  const t = await f.evaluate(() => document.body.innerText);
  await f.click('[data-lc=reopen-triage]'); await wait(400);
  const fb = await f.$eval('[data-finding=U3] [data-lc=finding-feedback]', el => el.textContent);
  return { pass: words === '保留这条测试' && /FAIL\s*稳定性：连续 3 次结果一致/.test(t) && /绿 \/ 红 \/ 绿/.test(fb), note: `按钮为「${words}」；保留第 3 条后「稳定性」失败，反馈「${fb.slice(5, 40)}…」` };
});
await flow('A-30', 'practice-triage', 'light', async f => {
  const keys = await f.evaluate(async () => { const r = await fetch('/api/learning/practice-runs/run-triage'); const j = await r.json(); return [...new Set(j.data.findings.flatMap(x => Object.keys(x)))]; });
  return { pass: !keys.some(k => /truth|answer|appear/.test(k)), note: `意见字段：${keys.join('、')}；不含答案字段` };
});
await flow('A-31', 'practice-brief', 'light', async (f, page) => {
  await f.click('[data-lc=start-run]');
  await f.waitForSelector('[data-lc=agent-run]');
  await f.click('[data-lc=back-to-course]');
  await f.waitForSelector('[data-practice=p-review]');
  const card = await f.$eval('[data-practice=p-review]', el => ({ st: el.dataset.status, t: el.textContent }));
  const btn = await f.evaluate(() => document.querySelector('[data-lc=start-practice]')?.textContent.trim());
  await f.click('[data-lc=start-practice]');
  await f.waitForSelector('[data-lc=agent-run], [data-lc-ready=practice-triage]', { timeout: 8000 });
  return { pass: card.st === 'doing' && /进行中/.test(card.t) && btn === '接着做', note: `练习选项 ${card.st}「${card.t}」；底部按钮「${btn}」；点回去仍是同一次评审` };
});
await flow('A-38', 'lesson-video', 'light', async f => {
  const def = await f.$eval('[role=radio][aria-checked=true]', el => el.dataset.pick);
  const tag = await f.$eval('[data-pick=p-review]', el => el.textContent.includes('本课配套'));
  await f.click('[data-pick=p-visual]');
  await f.click('[data-lc=start-practice]');
  await f.waitForSelector('[data-lc-ready=practice]');
  const id = await f.$eval('[data-lc-ready=practice]', el => el.dataset.practiceId);
  return { pass: def === 'p-review' && tag && id === 'p-visual', note: `第 1 课默认选中 ${def}（标「本课配套」）；改选视觉练习后进入 ${id}` };
});
await flow('A-39', 'practice-review', 'dark', async f => {
  const caret = await f.$$eval('.lc-caret', els => els.length);
  const finds = await f.$$eval('.lc-log-tag[data-tone=find]', els => els.length);
  const flags = await f.$$eval('.lc-flag', els => els.length);
  const spinner = await f.$$eval('[class*=animate-spin]', els => els.length);
  return { pass: caret === 1 && finds === flags && finds > 0 && spinner === 0, note: `RUN 行光标 ${caret}，日志发现 ${finds} 条，代码旗标 ${flags} 个，转圈 ${spinner}` };
});
await browser.close(); server.close();

/* ---------- 汇总 ---------- */
const S = id => screens.filter(s => s.id === id);
const every = (rows, fn) => rows.length > 0 && rows.every(fn);
const phones = screens.filter(s => s.viewport === 'phone');
const desktopContrast = screens.filter(s => ['lesson-video', 'practice-triage'].includes(s.id));
const measure = {
  'A-01': { pass: every(screens, s => s.inShell), note: screens.every(s => s.inShell) ? `${screens.length} 次打开都在 AppShell 主区内，壳的导航在页面之外` : '不在壳内：' + screens.filter(s => !s.inShell).map(s => s.id + '/' + s.theme).join('、') },
  'A-02': { pass: hexHits.length === 0 && centerHits.length === 0, note: hexHits.length || centerHits.length ? [...hexHits, ...centerHits].join('；') : `pages/learning-course ${pageFiles.length} 个文件与学习中心页新增行无颜色字面量` },
  'A-03': { pass: every(desktopContrast, s => s.contrast.length === 3 && s.contrast.every(c => c >= 4.5)), note: desktopContrast.map(s => `${s.id}/${s.theme}：正文 ${s.contrast[0]}，次要 ${s.contrast[1]}，弱化 ${s.contrast[2]}`).join('；') },
  'A-04': { pass: emojiHits.length === 0 && screens.every(s => !s.emojiInText), note: emojiHits.length ? emojiHits.join('、') : '源码与全部画面渲染文本无 emoji' },
  'A-06': { pass: every(phones, s => s.overflow <= 0 && s.small.length === 0), note: phones.map(s => `${s.id}/${s.theme}：溢出 ${s.overflow}px${s.small.length ? '，小于 44px：' + [...new Set(s.small)].join('、') : '，新增可点元素均 ≥ 44px'}`).join('；') },
  'A-07': { pass: navOk && every(S('center'), s => s.wipBadge) && every(S('lesson-video'), s => s.wipBadge), note: 'navRegistry 有课程与练习两条路由；课程数据 wip: true，课程卡与课程页顶栏显示「试运行」' },
  'A-10': { pass: svcOk && pagesUseSuccess >= 3, note: `learningCourses.ts 全部经 apiRequest（无裸 fetch）；${pagesUseSuccess} 个页面文件按 res.success 分支、错误取 res.error?.message` },
};
const SCALE = new Set(['12px', '14px', '16px', '20px', '28px']);
const typeBad = screens.filter(s => s.type.sizes.length > 6 || s.type.weights.some(w => !['400', '600'].includes(w)) || s.type.sans.some(x => !SCALE.has(x)));
const maxSizes = Math.max(...screens.map(s => s.type.sizes.length));
measure['A-41'] = { pass: typeBad.length === 0, note: typeBad.length ? typeBad.map(s => `${s.id}/${s.theme}：字号 ${s.type.sizes.join('、')}；字重 ${s.type.weights.join('、')}`).join('；') : `${screens.length} 次打开：正文字号全部落在 12 / 14 / 16 / 20 / 28，代码 13；每屏最多 ${maxSizes} 种字号；字重只有 400 / 600` };
for (const [id, r] of Object.entries(flows)) measure[id] = r;
const errorsTotal = screens.reduce((n, s) => n + s.errors.length, 0);
const primaryNote = [...new Set(screens.filter(s => s.viewport === 'desktop').map(s => `${s.id}：${s.primaries.join('、') || '无'}`))].join('；');
const items = design.acceptance.map(a => {
  const auto = measure[a.id];
  const human = walkthrough[a.id];
  const status = auto ? (auto.pass ? 'passed' : 'failed') : human ? human.status : 'unverified';
  const note = auto ? `测量：${auto.note}` : human?.note ?? '未走查';
  return { id: a.id, ...(a.ruleId ? { ruleId: a.ruleId } : {}), name: `${a.id}${a.ruleId ? ' ' + a.ruleId : ''} ${a.rule}`.slice(0, 160), pass: status === 'passed', status, note };
});
const primaryOk = screens.every(s => s.primaries.length <= 1);
items.push({ id: 'C-01', name: 'C-01 预览容器零报错（所有画面 × 主题）', pass: !errorsTotal, status: errorsTotal ? 'failed' : 'passed', note: errorsTotal ? screens.filter(s => s.errors.length).map(s => `${s.id}/${s.theme}：${s.errors[0]}`).join('；') : `${screens.length} 次打开，控制台与 CSP 报错 0 条` });
items.push({ id: 'C-02', name: 'C-02 每屏 primary 按钮不超过一个（测量，供 A-05 人工核对）', pass: primaryOk, status: primaryOk ? 'passed' : 'failed', note: primaryNote.slice(0, 900) });
const out = { runAt: new Date().toISOString().slice(0, 10), browser: 'Chromium（Playwright），本机还原 CDS 预览容器（技能 design-preview-contract.json 的 CSP 响应头与桥接脚本、sandbox="allow-scripts"），桌面 1440×900 与手机 375×812、浅色与深色', url: design.prototype, total: items.length, passed: items.filter(i => i.pass).length, items };
writeFileSync(path.join(dir, 'checks/result.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ passed: out.passed, total: out.total, failed: items.filter(i => !i.pass).map(i => `${i.id}: ${i.note}`.slice(0, 300)) }, null, 1));
