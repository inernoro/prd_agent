import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

/*
 * 用法：
 *   LANDING_URL=https://<预览域名>/home node scripts/landing-seam-audit.mjs
 * 可选：SEAM_SECONDS（每幕录多久，默认 32s，够跑完最长的一轮循环）
 *      SEAM_OUT（事件流 JSON 落盘目录，默认系统临时目录）
 */
const URL = process.env.LANDING_URL || 'http://localhost:8000/home';
const OUT = process.env.SEAM_OUT || os.tmpdir();

/**
 * 衔接录像机 —— 把「所见即所得，点了才所得」变成可机器判定的东西。
 *
 * 做法：在页面里以 ~70ms 采样每一幕的整棵子树，记下每个元素「从看不见变成看得见 /
 * 从看得见变成看不见」的时刻，同时记指针的落点与按下。然后把相近的变化聚成一道
 * **衔接（seam）**，问一句：这道衔接之前 1.2s 内，指针按下过吗？
 *
 * 没按过 = 东西自己变了（要么该补一次点击，要么它本来就是系统在回应上一次点击，
 * 得人来判）。这比「每次点击都截图」省一百倍，而且给的是清单不是一堆图。
 */

const SECONDS = Number(process.env.SEAM_SECONDS || 32);

const SCENES = [
  ['#hero', '视觉创作'],
  ['#literary', '文学创作'],
  ['#knowledge', '知识库'],
  ['#pillars', '三层底座'],
  ['#agents', '六个 Agent'],
  ['#workflow', '工作流'],
  ['#voc', '用户之声'],
  ['#cds', 'CDS'],
];

const INSTALL = () => {
  window.__seam = { prev: new WeakMap(), events: [], t0: performance.now(), armed: false };
  window.__seamDescribe = (el) => {
    const tag = el.tagName.toLowerCase();
    const ct = el.getAttribute('data-cursor-target');
    if (ct) return `[${ct}]`;
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26);
    const cls = (typeof el.className === 'string' ? el.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return `${tag}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };
  window.__seamSample = (sel) => {
    const scene = document.querySelector(sel);
    if (!scene) return;
    const S = window.__seam;
    const now = Math.round(performance.now() - S.t0);

    // 指针：落在哪个目标里、这一刻有没有按下
    let cur = null;
    for (const span of scene.querySelectorAll('[data-scene-cursor-on]')) {
      if (span.getAttribute('data-scene-cursor-on') !== '1') break;
      const r = span.getBoundingClientRect();
      const tip = { x: r.left + 3, y: r.top + 3 };
      let hit = null;
      for (const el of scene.querySelectorAll('[data-cursor-target]')) {
        const t = el.getBoundingClientRect();
        if (!t.width) continue;
        if (tip.x >= t.left && tip.x <= t.right && tip.y >= t.top && tip.y <= t.bottom) {
          if (!hit || t.width * t.height < hit.a) hit = { n: el.getAttribute('data-cursor-target'), a: t.width * t.height };
        }
      }
      // 按下读属性，不读动画：点击手势只有 260ms，而无头浏览器（SwiftShader 软渲染）
      // 实测 rAF 约 400ms 才出一帧，挂在动画上的判据必然采空
      //（第一版就是这么把「按下 0 次」测出来的，还差点当成真结论）。
      cur = { on: hit?.n ?? null, press: span.getAttribute('data-scene-press') === '1' };
      break;
    }
    if (cur?.press && !S.lastPress) S.events.push({ t: now, kind: 'press', label: cur.on ?? '(空处)' });
    S.lastPress = !!cur?.press;

    // 可见集变化
    const sb = scene.getBoundingClientRect();
    for (const el of scene.querySelectorAll('*')) {
      if (el.tagName === 'PATH' || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      const cs = getComputedStyle(el);
      // 无限循环动画（星点呼吸、扫光、animate-ping）会一直在可见/不可见之间翻。
      // 那是装饰，不是衔接 —— 不滤掉的话它们能刷出几十条假的「凭空出现」。
      if (cs.animationIterationCount.includes('infinite')) continue;
      if (cs.display === 'none') { flip(el, false, now); continue; }
      const r = el.getBoundingClientRect();
      const inView = r.width > 2 && r.height > 2 && r.bottom > sb.top && r.top < sb.bottom;
      const vis = inView && +cs.opacity > 0.12 && cs.visibility !== 'hidden';
      flip(el, vis, now);
    }
    function flip(el, vis, now) {
      const S = window.__seam;
      const prev = S.prev.get(el);
      if (prev === undefined) { S.prev.set(el, vis); return; }
      if (prev === vis) return;
      S.prev.set(el, vis);
      if (!S.armed) return;
      S.events.push({ t: now, kind: vis ? 'appear' : 'vanish', label: window.__seamDescribe(el) });
    }
  };
};

const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await p.goto(URL, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
for (let y = 0; y < 9000; y += 600) { await p.evaluate((v) => window.scrollTo(0, v), y); await p.waitForTimeout(150); }
await p.waitForTimeout(1000);

const report = {};
for (const [sel, name] of SCENES) {
  const exists = await p.evaluate((s) => !!document.querySelector(s), sel);
  if (!exists) { report[name] = { skipped: '页面上没有这一幕' }; continue; }
  await p.evaluate((s) => {
    const e = document.querySelector(s); const r = e.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2);
  }, sel);
  await p.waitForTimeout(900);
  await p.evaluate(INSTALL);
  // 采样循环放进页面里跑：每采一次走一趟 CDP 的话，光往返就把采样间隔撑到几百毫秒，
  // 会漏掉短拍。页面内 setInterval 采完一次性读出来。
  await p.evaluate((s) => {
    window.__seamSample(s);            // 先空跑几轮把 prev 填满，否则第一帧全是「凭空出现」
    window.__seamSample(s);
    window.__seamSample(s);
    window.__seam.armed = true;
    window.__seam.t0 = performance.now();
    window.__seamTimer = setInterval(() => window.__seamSample(s), 70);
  }, sel);
  await p.waitForTimeout(SECONDS * 1000);
  report[name] = await p.evaluate(() => { clearInterval(window.__seamTimer); return window.__seam.events; });
}

const dump = path.join(OUT, 'landing-seams.json');
fs.writeFileSync(dump, JSON.stringify(report, null, 1));
console.log(`事件流已落盘：${dump}`);
await b.close();

// ── 离线分析：把事件聚成衔接，判定每道衔接有没有「因」 ──
const PRESS_WINDOW = 1400; // 一次按下能「解释」它之后这么久内出现的东西
for (const [name, ev] of Object.entries(report)) {
  if (!Array.isArray(ev)) { console.log(`\n== ${name} ==  ${ev.skipped}`); continue; }
  const seams = [];
  for (const e of ev) {
    if (e.kind === 'press') { seams.push({ t: e.t, press: e.label, items: [] }); continue; }
    const last = seams[seams.length - 1];
    if (last && e.t - (last.lastT ?? last.t) < 260) { last.items.push(e); last.lastT = e.t; }
    else seams.push({ t: e.t, press: null, items: [e], lastT: e.t });
  }
  let lastPressT = -1e9;
  let caused = 0, spontaneous = 0;
  const bad = [];
  for (const s of seams) {
    if (s.press !== null) { lastPressT = s.t; continue; }
    const appears = s.items.filter((i) => i.kind === 'appear');
    if (!appears.length) continue;               // 只有消失不算「凭空出现」
    if (s.t - lastPressT <= PRESS_WINDOW) caused += 1;
    else { spontaneous += 1; bad.push({ ...s, sincePress: lastPressT < -1e8 ? null : s.t - lastPressT }); }
  }
  const presses = ev.filter((e) => e.kind === 'press').length;
  console.log(`\n== ${name} ==`);
  console.log(`  按下 ${presses} 次｜有因的出现 ${caused} 处｜无因的出现 ${spontaneous} 处`);
  for (const s of bad.slice(0, 8)) {
    console.log(`   t=${(s.t / 1000).toFixed(1)}s  距上次按下 ${s.sincePress === null ? '从未按过' : (s.sincePress / 1000).toFixed(1) + 's'}  ` +
      s.items.filter((i) => i.kind === 'appear').slice(0, 4).map((i) => i.label).join(' / '));
  }
  if (bad.length > 8) console.log(`   …另有 ${bad.length - 8} 处`);
}
