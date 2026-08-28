import { chromium } from 'playwright';

/**
 * 直接量用户看到的那件事：**效果出现的那一刻，指针到位了吗？**
 *
 * 做法：盯住视觉幕右侧对话里的用户气泡（「把主视觉改成雾天…」）。它一从看不见
 * 变成看得见，就记下此刻指针在不在发送键的框里。文学幕同理盯第一张配图卡。
 *
 * 判据只有一个：气泡出现的那一帧，指针必须已经落在它该在的目标框内。
 * 落在别处 = 用户会看到「还没点到就发出去了」。
 */
const URL = process.env.LANDING_URL || 'http://127.0.0.1:7801/home';

const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await p.goto(URL, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(2500);
await p.waitForSelector('#hero', { timeout: 60000 });
for (let y = 0; y < 9000; y += 600) { await p.evaluate((v) => window.scrollTo(0, v), y); await p.waitForTimeout(150); }
await p.waitForTimeout(1200);

async function watch(sceneSel, effectText, wantTarget, label, secs) {
  await p.evaluate((s) => {
    const e = document.querySelector(s); const r = e.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2);
  }, sceneSel);
  await p.waitForTimeout(900);

  const rows = await p.evaluate(async ({ sceneSel, effectText, secs }) => {
    const scene = document.querySelector(sceneSel);
    const out = [];
    let wasOn = null;
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      // 效果元素：文本命中的那个最深节点
      let eff = null;
      for (const el of scene.querySelectorAll('*')) {
        if (el.children.length) continue;
        // 取命中文本的那个元素**本身** —— 淡入是挂在它身上的；
        // 取 parentElement 会拿到永远不透明的外层容器，于是永远采不到「从无到有」那一帧
        if ((el.textContent || '').includes(effectText)) { eff = el; break; }
      }
      const on = !!eff && +getComputedStyle(eff).opacity > 0.5;
      if (wasOn === false && on) {
        // 就在这一帧，指针在哪个目标框里
        const cur = scene.querySelector('[data-scene-cursor-on="1"]');
        let hit = null;
        if (cur) {
          const r = cur.getBoundingClientRect();
          const tip = { x: r.left + 3, y: r.top + 3 };
          for (const t of scene.querySelectorAll('[data-cursor-target]')) {
            const q = t.getBoundingClientRect();
            if (!q.width) continue;
            if (tip.x >= q.left && tip.x <= q.right && tip.y >= q.top && tip.y <= q.bottom) {
              if (!hit || q.width * q.height < hit.a) hit = { n: t.getAttribute('data-cursor-target'), a: q.width * q.height };
            }
          }
        }
        out.push({ t: Math.round(performance.now() - t0), cursorOn: !!cur, hit: hit?.n ?? null });
      }
      wasOn = on;
      await new Promise((r) => setTimeout(r, 40));
    }
    return out;
  }, { sceneSel, effectText, secs });

  console.log(`\n== ${label} ==  期望效果出现时指针落在 [${wantTarget}]`);
  if (!rows.length) { console.log('   这一轮没捕捉到效果出现（可能没循环到）'); return; }
  let ok = 0;
  for (const r of rows) {
    const good = r.hit === wantTarget;
    if (good) ok += 1;
    console.log(`   t=${(r.t / 1000).toFixed(1)}s  指针可见=${r.cursorOn}  落在=[${r.hit ?? '空处'}]  ${good ? '到位' : '没到位'}`);
  }
  console.log(`   ${ok}/${rows.length} 次到位`);
}

/*
 * 期望值分两类，别搞混：
 *   · **点击的直接结果**（消息发出、两张都选中）→ 手必须在**被点的那个东西**上。
 *   · **点击之后的后果**（配图一张张落位）→ 手应该还在刚才点的按钮上，
 *     不该跑到结果上去 —— 跑过去反而是在假装「这张图是点出来的」。
 * 一轮 20.9s，给 52s 保证至少完整看到两次。
 */
await watch('#hero', '把主视觉改成雾天', 'chat-send', '视觉创作 · 消息发出的那一刻', 52);
await watch('#hero', '把这两张混一下', 'tile-b', '视觉创作 · 混合那句发出的那一刻', 52);
await watch('#literary', '配图 1 · 雾压山谷', 'generate-all', '文学创作 · 第一张配图落位时手应还在按钮上', 40);
await b.close();
