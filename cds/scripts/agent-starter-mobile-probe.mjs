#!/usr/bin/env node
/*
 * 「接入 Agent」上手向导的窄屏可达性判据。
 *
 * 为什么要用真浏览器：这一屏的既有守卫（tests/web/agent-starter-skill-library-contract）
 * 只能扫源码，能证明「主按钮写在 JSX 里」，证明不了「主按钮在手机上够不够得着」。
 * 2026-09-03 用户在手机上打开步骤 03，屏幕上没有任何前进出口，也滑不动——
 * 当时按钮确实在 DOM 里（源码守卫全绿），rect 却落在 y=961、视口只有 844，
 * 而整条祖先链上没有一个可滚容器。编译、类型、单测、源码守卫全都拦不住，
 * 只有真浏览器量得出来。
 *
 * 判据（每一步的主操作 = 这一步唯一的前进出口），四道，各挡一种失效形态：
 *   1. inBox —— 矩形四边都在视口内。**两轴都查**：只查上下的话，出口被推过
 *      左右边界或被内层容器横向裁掉时会误判为可见。
 *   2. hitTested —— 那个坐标上最顶层的元素就是它自己，不是盖在上面的别人。
 *   3. reachable —— 兜底：万一 1 挂了，至少要能滚到，绝不允许「既看不见又滚不到」。
 *   4. 推进用真实指针点击（带 actionability 检查），不用合成 el.click()——
 *      合成事件不管元素在哪、有没有被挡住，照样能把流程推下去。
 *
 * 为什么四道都要：每一道单独看都能被另一种形态绕过。窄屏 CSS 里那条兜底
 * overflow-y:auto 让 3 恒真；只查上下的 1 拦不住横向出界；1 和 3 都拦不住遮挡；
 * 而 2 拦不住「元素在视口里、没被挡，但整体不可点」的情况——那是 4 的活。
 *
 * 红绿闭环（每道都验过能红）：
 *   删掉 index.css 里 `[data-agent-starter-slot='true']` 那条选择器 → step03 红（1）；
 *   给出口加 translateX(-3000px) → 报 left=-2978 出界（1 的横向分量）；
 *   给面板加一层 ::after 全屏遮罩 → 报「被别的元素盖住」（2）与点击超时（4）；
 *   给前两步的卡片加 margin-top:1200px → step01/02 报既看不见也滚不到（3）。
 *
 * 用法：node scripts/agent-starter-mobile-probe.mjs [baseUrl]
 * 不给 baseUrl 就自己起一个 vite dev server（需要 cds/web 已装依赖）。
 */
import { createRequire } from 'node:module';

import { startViteDevServer } from './lib/vite-dev-server.mjs';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  // 沙箱与 CI 装 playwright 的位置不同，允许显式指定（同 mobile-layout-smoke.mjs）。
  const candidates = [process.env.PWPATH, 'playwright', 'playwright-core'].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      failures.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`找不到 Playwright。已尝试 ${failures.join('; ')}`);
}

/** 真机常见的窄屏档；640 是窄屏样式的断点，四档都在它以下。 */
const VIEWPORTS = [
  { label: '360x640', width: 360, height: 640 },
  { label: '390x660', width: 390, height: 660 },
  { label: '390x844', width: 390, height: 844 },
  { label: '430x760', width: 430, height: 760 },
];

/*
 * 向导每一步的前进出口。判据锁的是「这一步有没有够得着的出口」这个不变量，
 * 不锁它长什么样。
 *
 * 前两步的出口是卡片而不是按钮——早先这里写成 action: null，于是量测直接跳过、
 * 只用 DOM click() 往下走。DOM click 不管元素在不在视口里，所以「开头两步的卡片
 * 被裁到屏幕外」这种回归会一路绿到底，而探针还声称自己验过每一步（Codex P2）。
 * 现在两类出口走同一套量测。
 */
const STEPS = [
  { id: '01', heading: '你希望 Agent 怎么跟你说话？', exit: { card: '经验', label: '经验档卡片' } },
  { id: '02', heading: '你主要负责什么？', exit: { card: '产品|前端|后端|全栈|测试|运维', label: '角色卡片' } },
  { id: '03', heading: '带上哪些工作方法？', exit: { button: '确认这些技能' } },
  { id: '04', heading: '改完以后，怎么交给你？', exit: { button: '生成我的上手包' } },
  { id: '05', heading: '你的 Agent 上手包已经配好', exit: { button: '复制启动提示词' }, last: true },
];

/*
 * 出口定位收敛成一个函数，量测与点击共用——两处各写一份找法，就会出现
 * 「量的是 A、点的是 B」（predicate-and-wiring-discipline 形状 3）。
 * 传给浏览器的是纯数据，函数体在页面里重建。
 */
const LOCATE_EXIT = `(exit) => {
  const flat = (s) => (s || '').replace(/\\s+/g, '');
  if (exit.button) {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => flat(b.textContent).includes(flat(exit.button))) || null;
  }
  const rx = new RegExp(exit.card);
  return Array.from(document.querySelectorAll('button'))
    .filter((b) => b.getBoundingClientRect().height > 40)
    .find((b) => rx.test(b.textContent)) || null;
}`;

/*
 * 推进用**真实指针点击**，不用合成 el.click()。
 *
 * 合成 click 直接派发事件，不管元素在不在视口里、有没有被别的东西盖住——
 * 于是「出口被推出屏幕或被浮层挡住」这种回归照样能往下走（Codex P2）。
 * Playwright 的 click 带 actionability 检查（可见、稳定、能接收事件、未被遮挡），
 * 点不到就超时报错，正是这里要的判据。
 *
 * 定位仍走 LOCATE_EXIT，量测与点击共用同一个找法。
 */
const clickExit = async (page, exit) => {
  const handle = await page.evaluateHandle(([locateSrc, e]) => eval(locateSrc)(e), [LOCATE_EXIT, exit]);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return { ok: false, reason: '页面上找不到这个出口' };
  }
  try {
    await element.click({ timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `真实指针点不到它（${String(err.message || err).split('\n')[0]}）` };
  } finally {
    await handle.dispose();
  }
};

const measure = (page, exit, heading) => page.evaluate(([locateSrc, e, h]) => {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const onStep = Array.from(document.querySelectorAll('h4,h3,div,span'))
    .some((el) => el.textContent.trim() === h);
  const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  const t = e.button || e.label || e.card;

  const btn = eval(locateSrc)(e);
  if (!btn) return { onStep, overflowX, action: t, found: false };

  const before = btn.getBoundingClientRect();
  /*
   * 两轴都要查，还要做命中测试。
   *
   * 只查 top/bottom 的话，出口被推过左右边界、被内层滚动容器横向裁掉、或者被
   * 别的元素盖住时，判据照样判它在视口里（Codex P2）。文档级的横向溢出检查
   * 也照不到内层容器里发生的裁剪。
   */
  const centerX = before.left + before.width / 2;
  const centerY = before.top + before.height / 2;
  const inBox = before.height > 0 && before.width > 0
    && before.top >= 0 && before.bottom <= vh
    && before.left >= 0 && before.right <= vw;
  const topMost = inBox ? document.elementFromPoint(centerX, centerY) : null;
  /*
   * 命中测试：这个坐标上最顶层的元素必须是它自己，或它的后代（按钮里的
   * 图标、文字节点都算）。
   *
   * 这里**不能**放行「topMost 是 btn 的祖先」——祖先能出现在最顶层，恰恰
   * 说明它身上有东西盖住了按钮（伪元素遮罩、更高 z-index 的定位层），那正是
   * 要抓的遮挡。第一版把祖先也算作通过，结果拿 ::after 全屏遮罩做红绿闭环时
   * 这条判据判成绿，只有真实指针点击拦下来了。
   */
  const hitTested = Boolean(topMost) && (topMost === btn || btn.contains(topMost));
  const inViewport = inBox && hitTested;
  // 兜底：有没有任何祖先能把它滚进来。滚完要还原，免得污染后续步骤的量测。
  const scrollers = [];
  for (let a = btn.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (/auto|scroll/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1) {
      scrollers.push({ el: (a.className || a.tagName).toString().slice(0, 40), top: a.scrollTop });
    }
  }
  btn.scrollIntoView({ block: 'nearest' });
  const after = btn.getBoundingClientRect();
  const reachable = after.height > 0 && after.width > 0
    && after.top >= 0 && after.bottom <= vh
    && after.left >= 0 && after.right <= vw;
  return {
    onStep, overflowX, action: t, found: true,
    top: Math.round(before.top), bottom: Math.round(before.bottom),
    left: Math.round(before.left), right: Math.round(before.right),
    inBox, hitTested,
    coveredBy: hitTested ? null : (topMost ? (topMost.className || topMost.tagName || '').toString().slice(0, 40) : '视口外'),
    inViewport, reachable,
    scrollers: scrollers.map((s) => s.el),
  };
}, [LOCATE_EXIT, exit, heading]);

async function main() {
  const explicitBase = process.argv[2];
  // 先解析 playwright 再起服务：它只是个模块解析、没有副作用，而放在起服务
  // 之后就多出一条「解析失败 → 服务已起 → 还没进 try」的泄漏路径（Codex P2）。
  const { chromium } = loadPlaywright();
  const server = explicitBase ? { url: explicitBase.replace(/\/+$/, ''), stop: () => {} } : await startViteDevServer();

  // 浏览器起不来（缺二进制、缺依赖）时，上面那个 dev server 也必须被收掉，
  // 否则端口一直被占——它是 strictPort，下一次跑会直接起不来（Codex P2）。
  const failures = [];
  let browser = null;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--no-proxy-server'],
      executablePath: process.env.CDS_CHROMIUM_PATH || undefined,
    });
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(`${server.url}/probe.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1200);

      for (const step of STEPS) {
        const m = await measure(page, step.exit, step.heading);
        const problems = [];
        if (!m.onStep) problems.push(`没停在这一步（找不到标题「${step.heading}」）`);
        if (m.overflowX > 2) problems.push(`横向溢出 ${m.overflowX}px`);
        if (!m.found) problems.push(`找不到出口「${m.action}」`);
        else if (m.inBox && !m.hitTested) problems.push(`出口「${m.action}」被别的元素盖住了（那个坐标上最顶层的是 ${m.coveredBy}）`);
        else if (!m.reachable) problems.push(`出口「${m.action}」既看不见也滚不到（rect top=${m.top} left=${m.left} right=${m.right}，视口 ${vp.width}x${vp.height}）`);
        else if (!m.inViewport) problems.push(`出口「${m.action}」不在视口里，要先滚动才看得见（rect top=${m.top} left=${m.left} right=${m.right}，视口 ${vp.width}x${vp.height}）`);

        const label = `${vp.label} step${step.id}`;
        if (problems.length) {
          failures.push(`${label}: ${problems.join('；')}`);
          console.log(`FAIL ${label} ${problems.join('；')}`);
        } else {
          console.log(`PASS ${label} 出口「${m.action}」 top=${m.top} 视口内`);
        }
        // 量过之后才点：DOM click 不管元素在不在视口里，先点后量等于放行不可达的出口。
        if (!step.last) {
          const advanced = await clickExit(page, step.exit);
          if (!advanced.ok) {
            failures.push(`${label}: 走不到下一步——${advanced.reason}`);
            console.log(`FAIL ${label} 走不到下一步——${advanced.reason}`);
            break;
          }
          await page.waitForTimeout(600);
        }
      }

      /*
       * 切走 tab 之后，上手助手必须真的从屏幕上消失。
       *
       * 窄屏那条高度链规则带 `display: flex !important`，打得过 Tailwind `hidden` 的
       * `display: none`；标记要是常驻，切到海鲜市场时两个 tab 会一起铺在屏幕上
       * （Codex P1，真机 390px 量到 slot 仍是 flex、高 465px、上手助手文案仍可见）。
       *
       * 判据量的是 slot 元素本身，不是 `[data-agent-starter]`——后者在切走时本就
       * 被卸载，两种情形下都是 0，拿它当判据会恒绿（形状 6：读的不是生效的那个值）。
       */
      const isolation = await page.evaluate(async () => {
        const slot = document.querySelector('[data-agent-starter-slot]');
        if (!slot) return { skipped: '找不到 starter slot' };
        const tab = Array.from(document.querySelectorAll('nav button'))
          .find((b) => b.textContent.includes('海鲜市场'));
        if (!tab) return { skipped: '找不到可切换的其它 tab' };
        tab.click();
        await new Promise((r) => setTimeout(r, 700));
        const rect = slot.getBoundingClientRect();
        return {
          display: getComputedStyle(slot).display,
          height: Math.round(rect.height),
          starterTextVisible: document.body.innerText.includes('一句话改项目'),
        };
      });
      const isoLabel = `${vp.label} tab 隔离`;
      if (isolation.skipped) {
        /*
         * 前置缺失当失败，不当跳过。
         *
         * 这里的两个前置——slot 标记在不在、切得走的 tab 找不找得到——**本身就是
         * 这条判据要守的东西**。它们不见了正是回归，不是「环境缺件」那种可以跳过
         * 的情况。原来写成 SKIP 打一行日志就放行，等于新加的 CI 步骤声称守着
         * tab 隔离，实际上覆盖已经悄悄没了（Codex P2）。
         *
         * 这条正是 predicate-and-wiring-discipline 形状 4b 说的：跳过要打印原因，
         * 但「一个不会红的证据比没有证据更糟」。我打了原因，却漏了后半句。
         */
        failures.push(`${isoLabel}: 判据跑不起来——${isolation.skipped}`);
        console.log(`FAIL ${isoLabel} 判据跑不起来——${isolation.skipped}`);
      } else if (isolation.height > 0 || isolation.starterTextVisible) {
        const msg = `切到别的 tab 后上手助手没消失（display=${isolation.display}，高 ${isolation.height}px，文案可见=${isolation.starterTextVisible}）`;
        failures.push(`${isoLabel}: ${msg}`);
        console.log(`FAIL ${isoLabel} ${msg}`);
      } else {
        console.log(`PASS ${isoLabel} 切走后上手助手 display=${isolation.display}、高 0`);
      }

      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    server.stop();
  }

  if (failures.length) {
    console.error(`\n${failures.length} 处窄屏可达性问题：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nALL PASS 上手向导每一步的出口在四档窄屏下都不滚动就可见，切走 tab 后也真的消失');
}

main().catch((err) => {
  console.error(`FAIL ${err.stack || err.message}`);
  process.exit(1);
});
