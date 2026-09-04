#!/usr/bin/env node
/*
 * 窄屏布局冒烟，两种模式：
 *
 *   真实实例模式（默认，给 baseUrl 或 CDS_HOST）——打一个跑着的 CDS，数据是真的，
 *     覆盖登录之后的页面。本地排障和部署后巡检用它。
 *   离线模式（--offline）——自起 vite dev、把 /api/* 换成合成数据。不需要 Docker、
 *     不需要 Mongo、不需要项目数据，所以它能进每个 PR 的 CI。
 *
 * 为什么要有离线模式：这个脚本写好之后很长一段时间没有被任何 workflow 调用过
 * （2026-09-03 查证：搜它的名字在 .github/ 下零命中），因为它的前置在 CI 上凑不齐。
 * 一条从不运行的守卫等于没有守卫，所以把数据依赖拆掉，让判据本身跑起来。
 *
 * 离线模式测得到什么、测不到什么，说清楚：布局判据（横向溢出 / 文字被压成竖排 /
 * 可点目标被遮挡）量的是元素怎么排，合成数据一样成立；测不到的是「真实数据的
 * 长度与数量把布局撑成什么样」——那仍然要靠真实实例模式或视觉验收。
 */
import { createRequire } from 'node:module';

import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [process.env.PWPATH, 'playwright'].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      failures.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(`Unable to load Playwright. Tried ${failures.join('; ')}`);
}

const { chromium } = loadPlaywright();

const OFFLINE = process.argv.includes('--offline');
const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
let baseUrl = (positional || process.env.CDS_HOST || 'http://127.0.0.1:9900').replace(/\/+$/, '');

/*
 * 离线模式把 /api/* 全部接管。装在 context 上而不是 page 上：一个 context 里
 * 后开的页面同样要被喂到，漏一个就是半条链路走真网络、然后在 CI 里超时。
 */
/*
 * 认不出的路径要留痕。原来一律回 {} 让页面走空态，而空态照样能满足
 * 「文字够多」那条判据（常驻导航就有一百五十多字），于是新增或改名的端点
 * 漏登记之后冒烟仍然全绿，量的却是一个空页面（Codex P2）。
 */
const unregisteredPaths = new Set();

async function installFixtures(context) {
  await context.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (isEventStream(pathname)) {
      // EventSource 拿到非 text/event-stream 会立刻 abort 并刷一条控制台错误。
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    }
    const body = resolveFixture(pathname);
    if (body === null) unregisteredPaths.add(pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    });
  });
}
const viewports = [
  { label: '390', width: 390, height: 844 },
  { label: '600', width: 600, height: 844 },
  { label: '760', width: 760, height: 844 },
];

function assertOk(condition, message, details = {}) {
  if (!condition) {
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    throw new Error(`${message}${suffix}`);
  }
}

async function getFirstProject(page) {
  if (OFFLINE) return { id: FIXTURE_PROJECT_ID };
  const response = await page.request.get(`${baseUrl}/api/projects`);
  assertOk(response.ok(), 'GET /api/projects failed', { status: response.status() });
  const body = await response.json();
  const project = body?.data?.[0] || body?.data?.items?.[0] || body?.projects?.[0];
  assertOk(project?.id, 'No project available for mobile layout smoke');
  return project;
}

async function checkLayout(page, label, anchor) {
  const result = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bodyText = document.body.innerText || '';
    const root = document.querySelector('.cds-branch-detail-drawer')
      || Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
      || document.body;
    const overflow = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - vw;

    const squeezed = [];
    const textNodes = Array.from(root.querySelectorAll('button,a,h1,h2,h3,span,[role="button"],[role="tab"]'));
    for (const el of textNodes) {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim().replace(/\s+/g, '');
      if (!text || text.length < 2 || text.length > 12) continue;
      if (rect.width > 0 && rect.width < 24 && rect.height > 36) {
        squeezed.push({
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
    }

    const covered = [];
    const targets = Array.from(root.querySelectorAll('button:not([disabled]),a[href],[role="button"],[role="tab"]'));
    for (const el of targets) {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 30);
      if (rect.width < 28 || rect.height < 28) continue;
      if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) continue;
      const x = Math.min(vw - 1, Math.max(1, rect.left + rect.width / 2));
      const y = Math.min(vh - 1, Math.max(1, rect.top + rect.height / 2));
      // A target may sit below a scroll viewport (or to the side of a horizontal
      // scroller) until the user scrolls it into view. elementFromPoint() then
      // correctly returns the clipping sibling/footer, but that is not an
      // overlap: the target is not currently exposed at that coordinate.
      let clippedByAncestor = false;
      for (let ancestor = el.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        const clipsX = /auto|scroll|hidden|clip/.test(ancestorStyle.overflowX);
        const clipsY = /auto|scroll|hidden|clip/.test(ancestorStyle.overflowY);
        if ((clipsX && (x < ancestorRect.left || x > ancestorRect.right))
          || (clipsY && (y < ancestorRect.top || y > ancestorRect.bottom))) {
          clippedByAncestor = true;
          break;
        }
      }
      if (clippedByAncestor) continue;
      const top = document.elementFromPoint(x, y);
      if (!top) continue;
      if (el === top || el.contains(top) || top.contains(el)) continue;
      const pointerEvents = getComputedStyle(top).pointerEvents;
      if (pointerEvents === 'none') continue;
      covered.push({
        text,
        by: (top.textContent || top.getAttribute('aria-label') || top.className || top.tagName || '').toString().trim().slice(0, 60),
        x: Math.round(x),
        y: Math.round(y),
      });
    }

    return {
      url: location.href,
      bodyText,
      textLength: bodyText.trim().length,
      overflow,
      squeezed: squeezed.slice(0, 10),
      covered: covered.slice(0, 10),
    };
  });

  assertOk(result.textLength > 60, `${label}: page did not render enough text`, result);
  /*
   * 内容锚点：一段只有喂对数据才会出现的文字。
   *
   * 上面那条 textLength > 60 拦不住空页面——常驻导航就有一百五十多字，
   * 所以 fixture 过期、页面退化成空态时它照样绿，而冒烟量的是一个空布局
   * （Codex P2）。锚点把「量到的是有数据的那一版」这件事钉死。
   */
  if (anchor) {
    assertOk(
      result.bodyText.includes(anchor),
      `${label}: 页面上找不到内容锚点「${anchor}」——多半是 fixture 喂不动了，量到的是空页面`,
      { textLength: result.textLength, head: result.bodyText.slice(0, 160) },
    );
  }
  assertOk(result.overflow <= 2, `${label}: horizontal overflow detected`, result);
  assertOk(result.squeezed.length === 0, `${label}: text squeezed into vertical layout`, result);
  assertOk(result.covered.length === 0, `${label}: clickable target is covered`, result);
  console.log(`PASS ${label} ${result.url}`);
}

/*
 * 桌面高度契约：任务调度页的主操作「立即执行」必须在视野里，不能靠滚动去够。
 *
 * 它坏过一次，而且不是「偏下」这么轻：网格行是 auto，会长到最高那一栏的内容高
 * （实测 1027px）撑破 flex 容器，于是按钮被钉在 y=986 不随视口变；1536px 以下
 * 第三栏整个 `hidden`，rect 直接是 0x0——那台 14 寸笔记本上根本没有这个按钮。
 * 编译、类型、单测全都拦不住，只有真浏览器量得出来。
 *
 * 红绿闭环：把 Workspace 的 cds-workspace--fill 去掉，或把网格的
 * xl:grid-rows-[minmax(0,1fr)] 去掉，四档里至少两档立刻变红。
 */
const TASK_SCHEDULE_VIEWPORTS = [
  { label: '1280x720', width: 1280, height: 720 },
  { label: '1512x860', width: 1512, height: 860 },
  { label: '1920x860', width: 1920, height: 860 },
  { label: '1920x1080', width: 1920, height: 1080 },
];

async function checkTaskScheduleAction(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ignoreHTTPSErrors: true,
  });
  if (OFFLINE) await installFixtures(context);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/task-schedule`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  const label = `task-schedule:${viewport.label}`;

  /*
   * 主从布局的骨架判据。任务索引是这一屏的脊柱：它必须满高、必须在首屏上半部，
   * 不能像改版前那样被时间轴压到 y=445（52% 屏高）再挤成 280×367。
   * 红绿闭环：把左栏改回 `max-h-[60vh]` 且把时间轴搬回值班条下面（即改版前的样子），
   * 四档全红。
   */
  const spine = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '新建' && b.getBoundingClientRect().height > 0);
    const index = btn ? btn.closest('section') : null;
    if (!index) return { found: false };
    const rect = index.getBoundingClientRect();
    const groups = Array.from(index.querySelectorAll('span'))
      .filter((s) => ['需要注意', '即将触发', '正常运行'].includes(s.textContent.trim()));
    return {
      found: true,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      // 分组标题必须首屏就在视野里，不需要先在窄槽里滚动才能看见全部三组
      groupsInView: groups.length > 0 && groups.every((s) => {
        const r = s.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }),
      groupCount: groups.length,
      // 未选中任务时右侧是值班概览，时间轴在这里满高展开
      overviewBand: document.body.innerText.includes('今日调度轴'),
      rows: document.querySelectorAll('[data-job-row]').length,
      emptyState: document.body.innerText.includes('还没有定时任务'),
      overflowX: document.body.scrollWidth > window.innerWidth,
    };
  });
  assertOk(spine.found, `${label}: 找不到任务索引（以「新建」按钮所在的 section 为锚）`);
  assertOk(spine.top < spine.viewportHeight * 0.4, `${label}: 任务索引起点落在首屏下半部`, spine);
  assertOk(spine.height > spine.viewportHeight * 0.5, `${label}: 任务索引没有满高——脊柱被压扁了`, spine);
  assertOk(!spine.overflowX, `${label}: 出现横向溢出`, spine);

  /*
   * 空实例（全新装、还没建任何定时任务）是受支持的状态，页面渲染的是空状态。
   * 上一版把「三个分组首屏全露」「点任务行」当成无条件前提，于是这套冒烟在全新
   * 实例上会因为「没有数据」而红——那是判据坏了，不是页面坏了。
   * 现在按有没有任务分两条路走，并且**跳过时必须打印原因**：一个不会红也不说话的
   * 用例，比没有用例更糟（predicate-and-wiring 形状 4b）。
   */
  const hasJobs = spine.rows > 0;
  if (hasJobs) {
    assertOk(spine.groupsInView, `${label}: 分组标题没在首屏全部露出`, spine);
    assertOk(spine.overviewBand, `${label}: 未选中任务时右侧不是值班概览（找不到「今日调度轴」）`, spine);
  } else {
    console.log(`${label}: 实例里没有定时任务，跳过「分组/调度轴/两态切换」三组断言，只验空状态与新建浮层`);
    assertOk(spine.emptyState, `${label}: 没有任务时也没渲染空状态引导`, spine);
  }

  /*
   * 两态切换。点任务 → 右栏换成这一个任务（主操作「立即执行」出现，时间轴收成细带，
   * 概览的表头随之消失）；点「返回值班概览」→ 换回去。
   * 红绿闭环：把右栏改成恒为 JobOverview（不分两态），第二组断言里
   * bandCollapsed 立刻红——「今日调度轴」不会消失。
   */
  const detail = hasJobs ? await page.evaluate(async () => {
    const row = document.querySelector('[data-job-row]') || Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((el) => el.closest('section') && el.textContent.includes('每天'));
    if (!row) return { clicked: false };
    row.click();
    await new Promise((r) => setTimeout(r, 500));
    const find = (text) => Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim().startsWith(text) && b.getBoundingClientRect().height > 0);
    const act = find('立即执行');
    const back = find('返回值班概览');
    return {
      clicked: true,
      actionVisible: Boolean(act) && act.getBoundingClientRect().bottom <= window.innerHeight,
      backVisible: Boolean(back),
      bandCollapsed: !document.body.innerText.includes('今日调度轴'),
      runStream: document.body.innerText.includes('运行流'),
    };
  }) : null;
  if (detail) {
  assertOk(detail.clicked, `${label}: 左栏点不到任务行`);
  assertOk(detail.actionVisible, `${label}: 选中任务后「立即执行」不在视野里`, detail);
  assertOk(detail.backVisible, `${label}: 选中态没有「返回值班概览」的出口`, detail);
  assertOk(detail.bandCollapsed, `${label}: 选中后时间轴没有收成细带`, detail);
  assertOk(detail.runStream, `${label}: 选中态看不到运行流`, detail);

  const restored = detail ? await page.evaluate(async () => {
    const back = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '返回值班概览');
    if (!back) return { clicked: false };
    back.click();
    await new Promise((r) => setTimeout(r, 500));
    return { clicked: true, overviewBand: document.body.innerText.includes('今日调度轴') };
  }) : { clicked: true, overviewBand: true };
  assertOk(restored.clicked && restored.overviewBand, `${label}: 「返回值班概览」没有回到概览态`, restored);
  }

  /*
   * 「新建」曾经是死按钮：表单渲染在 2xl 才存在的第三栏里，1512px 下点它一个字都不出现。
   * 现在它开的是浮层，不依赖任何断点。红绿闭环：把浮层改回渲染在栏里，1512 与 1280 两档立刻红。
   */
  const created = await page.evaluate(async () => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '新建' && b.getBoundingClientRect().height > 0);
    if (!btn) return { clicked: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '保存');
    const rect = save ? save.getBoundingClientRect() : null;
    return {
      clicked: true,
      formVisible: document.body.innerText.includes('触发器启动任务'),
      saveVisible: rect ? rect.height > 0 && rect.bottom <= window.innerHeight : false,
    };
  });
  assertOk(created.clicked, `${label}: 页面上找不到「新建」按钮`);
  assertOk(created.formVisible, `${label}: 点了「新建」表单没出现——按钮是死的`, created);
  assertOk(created.saveVisible, `${label}: 新建表单的「保存」不在视野里`, created);
  // 通过时也要出声：一条只在失败时说话的检查，跑没跑过在 CI 日志里看不出来。
  console.log(`PASS ${label} ${hasJobs ? '脊柱 + 两态切换 + 新建浮层' : '空状态 + 新建浮层'}`);
  await context.close();
}

async function runViewport(browser, project, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  if (OFFLINE) await installFixtures(context);
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });

  const projectId = project.id;
  /*
   * 第三列是内容锚点：喂对数据才会出现的一段文字。离线模式下它挡住「fixture 过期
   * → 页面走空态 → 冒烟照常绿」；真实实例模式下锚点取自真实数据，所以只在离线
   * 模式断言（真实实例上的项目名不是「窄屏样例项目」）。
   */
  const pages = [
    ['project-list', `${baseUrl}/project-list`, '窄屏样例项目'],
    ['branch-list', `${baseUrl}/branches/${encodeURIComponent(projectId)}`, 'feature/alpha'],
    // 取 /api/env 里的键名，不取项目名：项目名只能证明共享的项目 fixture 到位了，
    // 证明不了这一页自己那个请求成功（Codex P2）。
    ['project-settings', `${baseUrl}/settings/${encodeURIComponent(projectId)}#env`, 'FIXTURE_SAMPLE_KEY'],
    // 取 /api/self-branches 里的分支名。原来用的「Docker 网络容量」是这一页
    // 硬编码的小标题，响应挂掉照样能过，等于没有锚点。
    ['cds-settings', `${baseUrl}/cds-settings#maintenance`, 'fixture-self-branch'],
    ['release-center', `${baseUrl}/release-center?project=${encodeURIComponent(projectId)}`, '窄屏样例项目（fixture-project）'],
  ];

  for (const [label, url, anchor] of pages) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await checkLayout(page, `${viewport.label}:${label}`, OFFLINE ? anchor : undefined);
  }

  await page.goto(`${baseUrl}/branches/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(800);
  const branchCard = page.locator('[aria-label^="打开 "][aria-label$=" 详情"]').first();
  await branchCard.click({ timeout: 10000 });
  await page.waitForTimeout(800);
  await checkLayout(page, `${viewport.label}:branch-detail-drawer`, OFFLINE ? 'feature/alpha' : undefined);

  const themeVisibleWhileDrawerOpen = await page.locator('.cds-theme-toggle').evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }).catch(() => false);
  assertOk(!themeVisibleWhileDrawerOpen, `${viewport.label}:branch-detail-drawer: theme toggle must hide while drawer is open`);

  await context.close();
}

async function main() {
  // 沙箱/CI 里 Playwright 自带的浏览器版本未必与镜像预装的一致，允许显式指定。
  const executablePath = process.env.CDS_CHROMIUM_PATH || undefined;
  const only = process.env.CDS_SMOKE_ONLY || '';
  let devServer = null;
  if (OFFLINE) {
    devServer = await startViteDevServer();
    baseUrl = devServer.url;
    console.log(`离线模式：前端起在 ${baseUrl}，/api/* 走合成数据`);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath });
  try {
    if (only !== 'task-schedule') {
      const probe = await browser.newPage();
      const project = await getFirstProject(probe);
      await probe.close();
      for (const viewport of viewports) {
        await runViewport(browser, project, viewport);
      }
    }
    for (const viewport of TASK_SCHEDULE_VIEWPORTS) {
      await checkTaskScheduleAction(browser, viewport);
    }
  } finally {
    await browser.close();
    if (devServer) devServer.stop();
  }

  if (OFFLINE && unregisteredPaths.size > 0) {
    const list = [...unregisteredPaths].sort();
    throw new Error(
      `${list.length} 条 API 路径没有登记 fixture，页面拿到的是空对象——量到的布局可能是空态而非真实内容。`
      + `请在 scripts/fixtures/mobile-layout-fixtures.mjs 里给它们登记数据，`
      + `或在 INTENTIONALLY_EMPTY 里声明「这里就该空」：\n  ${list.join('\n  ')}`,
    );
  }
}

main().catch(async (err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
