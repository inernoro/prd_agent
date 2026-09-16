// 公共藏书阁闭环验收：入口 -> 展开卷 -> 书目可见 -> 开考 -> 答题 -> 交卷 -> 分数与解析可见。
// 断言的是「产物真的出现在页面上」，不是「点击没报错」（.claude/rules/closed-loop-acceptance.md）。
// 双主题各跑一遍（.claude/rules/admin-dual-theme.md 第三节：只在单主题下测过的 UI 不许声称完成）。
//
// 用法：cd prd-admin && pnpm build && node ../e2e/bookshelf-acceptance.mjs
// 可选环境变量：BOOKSHELF_DIST / BOOKSHELF_OUT / BOOKSHELF_PORT / BOOKSHELF_CHROMIUM
//
// 路径一律从本文件位置推导，不写死任何机器的绝对路径（照抄 llmgw-page-acceptance.mjs 的教训：
// 写死作者机器路径后换个 checkout 就静态服务器指空目录、首次导航直接白屏）。
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.BOOKSHELF_DIST || path.join(REPO_ROOT, 'prd-admin', 'dist');
const OUT = process.env.BOOKSHELF_OUT || path.join(os.tmpdir(), 'bookshelf-acceptance');
const PORT = Number(process.env.BOOKSHELF_PORT || 5799);
const CHROMIUM = process.env.BOOKSHELF_CHROMIUM || undefined;

if (!fs.existsSync(DIST)) {
  console.error(`未找到构建产物：${DIST}\n请先在 prd-admin 执行 pnpm build，或用 BOOKSHELF_DIST 指定目录。`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml',
               '.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.json':'application/json' };
// 藏书阁的两个接口在这里照线上真实响应作答。
// 以前这里跟着 SPA fallback 返回 HTML，解析必失败、store 永远停在初始值——
// 于是「服务端真的返回了进度」这条线上唯一会走的路径，本地一次都没跑过。
const BOOKSHELF_DATA = {
  '/api/bookshelf/progress': { readBookIds: [], examResults: {}, updatedAt: null },
  '/api/bookshelf/team': { members: [], memberCount: 0, passedByVolume: {} },
};
// legacy = 后端曾经那种缺 error 键的返回。它不满足 apiClient 的 ApiResponse 判据，
// 2026-09-11 把整个藏书阁炸成「页面渲染出错」。留着当守卫：降级可以，崩掉不行。
let apiShape = 'ok';
function bookshelfBody(u) {
  const data = BOOKSHELF_DATA[u];
  return apiShape === 'legacy' ? { success: true, data } : { success: true, data, error: null };
}

// 卷面图那条路径要单独测：无图时回落汉字方块、有图时换成图，是两棵不同的节点树。
// 只跑无图那一档等于新代码零覆盖 —— 把 CoverBox 的有图分支整个删掉，验收照样全绿。
const VOLUME_SLOTS = ['boot', 'rules', 'domain', 'design', 'review', 'ai', 'stage']
  .map((k) => `bookshelf.vol.${k}`);
const COVER_URL = '/e2e-cover.svg';
// 用 SVG 当假卷面：一张真 JPG 要么进仓库、要么现编码，而这里只需要「background-image 真的
// 加载出了东西」这一个事实。渐变在截图里也看得出是一块图而不是纯色兜底方块。
const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0%" stop-color="#2a2620"/><stop offset="55%" stop-color="#6b4f38"/>'
  + '<stop offset="100%" stop-color="#a8825a"/></linearGradient></defs>'
  + '<rect width="480" height="320" fill="url(#g)"/></svg>';
let coversOn = false;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === COVER_URL) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(COVER_SVG);
  }
  if (u === '/api/homepage/assets') {
    const data = {};
    if (coversOn) {
      VOLUME_SLOTS.forEach((slot) => { data[slot] = { url: COVER_URL, mime: 'image/svg+xml' }; });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, data, error: null }));
  }
  if (BOOKSHELF_DATA[u]) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(bookshelfBody(u)));
  }
  let f = path.join(DIST, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const report = [];
let allOk = true;

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  // 藏书阁不依赖后端数据，注入一个已登录态即可渲染；顺带清掉进度，保证每次从零开始。
  await page.addInitScript((t) => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(600);

  const step = {};
  // 粗野版这句回到 h1，且「看到我，」与「算你有福了」被 <br> 分成两行，
  // 整串匹配必失败 —— 按 h1 + 后半句断言。
  step['落地页大标题'] = await page.locator('h1').filter({ hasText: '算你有福了' }).first().isVisible();
  step['痛点药方表'] = await page.locator('text=代码规范、构建发布，没人告诉我该怎么做').first().isVisible();
  step['默认卷书目可见'] = await page.locator('text=《你的灯亮着吗？》').first().isVisible();
  await page.screenshot({ path: `${OUT}/01-landing-${theme}.png` });

  // 痛点卡必须落到各自对应的卷 —— 全都跳同一处等于药方表没接线。
  /*
   * 点了痛点卡必须真的「去」到书目区。
   * 2026-09-14 用户在桌面档点「去 懂业务 →」后反馈「除了变了颜色，没有效果呢」——
   * 书目区在下面两屏之外，屏幕上确实什么都没动。
   * 判据量的是**书目区在不在视口里**，不是「有没有报错」：源码守卫只能证明
   * scrollIntoView 写着，证明不了它真的滚到了。
   */
  {
    const painCard = page.locator('button', { hasText: '不熟业务的人被推去出方案' }).first();
    await painCard.scrollIntoViewIfNeeded();
    const booksSel = 'section.scroll-mt-6';
    const before = await page.locator(booksSel).first().evaluate((el) => el.getBoundingClientRect().top);
    await painCard.click();
    await page.waitForTimeout(1200); // smooth 滚动要跑完
    const after = await page.locator(booksSel).first().evaluate((el) => el.getBoundingClientRect().top);
    const vh = await page.evaluate(() => window.innerHeight);
    step['点痛点卡后书目区进入视口'] = after >= -4 && after < vh * 0.5;
    step['点痛点卡后页面真的动了'] = Math.abs(after - before) > 40;
    // 书名取 catalog 里卷三的首本，逐字对齐（不是「领域驱动设计」这种截断猜测）
    step['滚到的是那一卷的书目'] = await page.locator(booksSel).first()
      .locator('text=领域驱动设计：软件核心复杂性应对之道').first().isVisible().catch(() => false);
    await page.screenshot({ path: `${OUT}/02d-pain-goto-${theme}.png` });
  }

  await page.locator('button', { hasText: '评审派给了看不出问题的人' }).first().click();
  await page.waitForTimeout(700);
  step['痛点跳到卷七'] = await page.locator('text=上台面').first().isVisible();
  step['卷七书目出现'] = await page.locator('text=《金字塔原理》').first().isVisible();
  await page.locator('button', { hasText: '代码越改越乱，不想再打开' }).first().click();
  await page.waitForTimeout(700);
  step['另一痛点跳到卷五'] = await page.locator('text=《修改代码的艺术》').first().isVisible();
  // 卷六要治的是「AI 在乱写、没人看」——它必须给得出「怎么审」的书，
  // 不能整卷都是模型原理。这一条盯着那批实操书，被删掉就会红。
  await page.locator('button', { hasText: 'AI 生成的代码没人细看就合进去了' }).first().click();
  await page.waitForTimeout(700);
  step['痛点跳到卷六'] = await page.locator('text=驭 AI').first().isVisible();
  step['卷六有怎么审 AI 的书'] = await page.locator('text=你的代码就是犯罪现场').first().isVisible()
    && await page.locator('text=代码阅读方法与实践').first().isVisible();
  await page.screenshot({ path: `${OUT}/02b-volume-ai-${theme}.png` });

  await page.screenshot({ path: `${OUT}/02-volume-expanded-${theme}.png` });

  // 藏书阁此前只有「我点了已读」这个自我声明，一个勾证明不了读进去没有。
  // 写一句「打算在哪用它」才是真痕迹 —— 入口、编辑、回显三步都要在。
  const noteEntry = page.locator('button', { hasText: '写一句：打算在哪用它' }).first();
  step['每本书有写一句的入口'] = (await noteEntry.count()) > 0;
  await noteEntry.click();
  await page.waitForTimeout(400);
  await page.locator('textarea').first().fill('先用在这条主流程的评审清单上');
  await page.locator('button', { hasText: '记下' }).first().click();
  await page.waitForTimeout(600);
  step['心得写完回显在书卡上'] =
    (await page.locator('text=先用在这条主流程的评审清单上').first().isVisible().catch(() => false))
    && (await page.locator('text=我的一句话').first().isVisible().catch(() => false));
  step['顶部计数跟着涨'] = /心得\s*1/.test(await page.evaluate(() => document.body.innerText));
  await page.screenshot({ path: `${OUT}/02c-book-note-${theme}.png` });

  // 一本没读时入口必须说自己是摸底 —— 「赴考/通关」那套关卡话术配上零门槛才是漏洞。
  step['没读时入口叫摸底不叫赴考'] =
    (await page.locator('button').filter({ hasText: '先摸个底' }).count()) > 0
    && (await page.locator('button').filter({ hasText: /赴\s*考/ }).count()) === 0;

  const examBtn = page.locator('button').filter({ hasText: /先摸个底|赴\s*考|再考/ }).first();
  await examBtn.scrollIntoViewIfNeeded();
  await examBtn.click();
  await page.waitForTimeout(800);
  step['考卷弹出'] = await page.locator('text=摸底测').first().isVisible();
  await page.screenshot({ path: `${OUT}/03-exam-open-${theme}.png` });

  // 全选 A 再交卷：故意不全对，好让解析出场（解析才是这套题存在的理由）。
  const opts = page.locator('button:has-text("A")');
  for (let i = 0; i < (await opts.count()); i++) {
    const o = opts.nth(i);
    if (await o.isVisible()) await o.click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: '交卷' }).first().click();
  await page.waitForTimeout(900);

  const body = await page.evaluate(() => document.body.innerText);
  step['交卷后出分'] = /\d+\s*\/\s*\d+\s*题\s*——\s*(通过|未通过|底子在|有缺口)/.test(body);
  step['解析出现'] = body.includes('答对了。') || body.includes('为什么不是你选的那个');
  // 裸考的结果页必须说清「这次量的是什么」并给出下一步该读哪本，否则考试还是个出口而非入口。
  step['裸考结果说清上下文'] = body.includes('一本没读的情况下考的');
  step['裸考结果给出先读哪本'] = body.includes('建议从这两本开始');
  await page.screenshot({ path: `${OUT}/04-exam-result-${theme}.png`, fullPage: true });

  const fails = Object.entries(step).filter(([, v]) => !v).map(([k]) => k);
  if (fails.length) allOk = false;
  report.push({ theme, step });
  await ctx.close();
}

// 守卫：手机端左右留白必须相等。
// 2026-09-14 用户一眼看出「歪歪扭扭」，量出来是左 12 / 右 44 —— 根容器用 w-full 配负
// margin，宽度没跟着补回来，整块被往左拽了 32px。这种偏移人眼一看就别扭，却没有任何
// 判据在管，只能等人肉发现。现在量真实 boundingRect，偏差超过 2px 就红。
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
  });
  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  await page.waitForTimeout(800);
  const g = await page.evaluate(() => {
    const probe = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) };
    };
    return {
      标题: probe(document.querySelector('h1')),
      正文: probe(document.querySelector('h1')?.nextElementSibling),
      溢出: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  const even = (x) => x && Math.abs(x.left - x.right) <= 2;
  const pass = even(g.标题) && even(g.正文) && !g.溢出;
  if (!pass) allOk = false;
  console.log('');
  console.log('[手机端版式]');
  console.log(`  ${pass ? '通过' : '未通过'}  左右留白相等（标题 左${g.标题?.left}/右${g.标题?.right}，正文 左${g.正文?.left}/右${g.正文?.right}，横向溢出=${g.溢出}）`);
  await page.screenshot({ path: `${OUT}/05-mobile-gutter.png` });
  await ctx.close();
}

// 手机档两级导航闭环（390 终稿）：落地页 → 卷页 → 考试 → 结果 → 回落地页。
// 桌面是「同一屏换掉一段列表」，手机是「两层页面」——两棵不同的节点树，
// 桌面那一轮全绿证明不了手机这条路走得通（closed-loop-acceptance：产物要真的出现）。
// 双主题各跑一遍。
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  const m = {};
  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(600);

  // 落地页只放七卷清单，不该把某一卷的书目直接铺在上面（那就是改版前的单页形态）。
  m['落地页七卷清单在'] = (await page.locator('text=开机').first().isVisible())
    && (await page.locator('text=上台面').first().isVisible());
  m['落地页不预先摊开书目'] =
    !(await page.locator('text=《你的灯亮着吗？》').first().isVisible().catch(() => false));
  m['落地页有处境卡'] = await page.locator('text=这些处境，是不是很眼熟').first().isVisible();
  // 溢出要逐屏查。只在最后一屏查等于放过前面三屏——横滑卡组多加一个负边距
  // 就会把右边顶出去 20px，而那一屏的其它断言照样全绿。
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  m['落地页无横向溢出'] = await noOverflow();
  await page.screenshot({ path: `${OUT}/m1-landing-${theme}.png`, fullPage: true });

  // 进卷页：点七卷清单里的「驭 AI」那一行
  await page.locator('button', { hasText: '驭 AI' }).first().click();
  await page.waitForTimeout(700);
  m['卷页打开且书目出现'] = await page.locator('text=你的代码就是犯罪现场').first().isVisible();
  m['卷页有返回藏书阁'] = await page.locator('button', { hasText: '藏书阁' }).first().isVisible();
  m['卷页带上了深链'] = page.url().includes('vol=vol-ai');
  m['卷页无横向溢出'] = await noOverflow();
  await page.screenshot({ path: `${OUT}/m2-volume-${theme}.png`, fullPage: true });

  // 一本没读时入口必须说自己是摸底
  m['没读时入口叫摸底'] = (await page.locator('text=先摸个底').count()) > 0;

  await page.locator('button', { hasText: '开始' }).first().click();
  await page.waitForTimeout(700);
  m['答题屏出现且有题干'] = (await page.locator('text=选一个你认为对的').first().isVisible())
    && (await page.locator('text=交卷').first().isVisible());
  await page.screenshot({ path: `${OUT}/m3-exam-${theme}.png`, fullPage: true });

  // 每题选第一个选项，故意不全对，好让解析出场。
  // 按 data-exam-option 取，不按文字：`has-text("A")` 会误中返回钮「‹ 驭 AI」，
  // 点下去直接退出考试，而失败信息只会说「交卷按钮找不到」。
  const picks = page.locator('[data-exam-option="0"]');
  const pickCount = await picks.count();
  if (pickCount === 0) allOk = false;
  for (let i = 0; i < pickCount; i++) {
    const o = picks.nth(i);
    await o.scrollIntoViewIfNeeded().catch(() => {});
    if (await o.isVisible()) await o.click({ timeout: 3000 }).catch(() => {});
  }
  m['每题都有可选项'] = pickCount > 0;
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: '交卷' }).first().click();
  await page.waitForTimeout(1200);

  const mt = await page.evaluate(() => document.body.innerText);
  m['交卷后出分'] = /\d+\s*\/\s*\d+/.test(mt);
  m['裸考标明不计入通关'] = mt.includes('裸考不计入通关');
  m['结果说清这次量的是什么'] = mt.includes('一本没读的情况下考的');
  m['给出先读哪本'] = mt.includes('建议从这');
  m['逐题解析出现'] = mt.includes('错在哪、为什么') && mt.includes('正确');
  m['结果页无横向溢出'] = await noOverflow();
  await page.screenshot({ path: `${OUT}/m4-result-${theme}.png`, fullPage: true });

  // 回到这一卷 → 再回落地页，两级导航必须走得回来
  await page.locator('button', { hasText: '回到这一卷' }).first().click();
  await page.waitForTimeout(700);
  m['结果能退回卷页'] = await page.locator('text=你的代码就是犯罪现场').first().isVisible();
  await page.locator('button', { hasText: '藏书阁' }).first().click();
  await page.waitForTimeout(700);
  m['卷页能退回落地页'] = (await page.locator('h1:has-text("算你有福了")').first().isVisible())
    && !page.url().includes('vol=');

  // 团队看板是落地页的第二个入口，不能是个死行
  await page.locator('button', { hasText: '团队看板' }).first().click();
  await page.waitForTimeout(700);
  m['看板打开'] = await page.locator('text=谁在读什么').first().isVisible()
    || (await page.locator('text=还没有人开始读').first().isVisible().catch(() => false));
  await page.screenshot({ path: `${OUT}/m5-board-${theme}.png`, fullPage: true });

  m['看板页无横向溢出'] = await noOverflow();

  const mfails = Object.entries(m).filter(([, v]) => !v).map(([k]) => k);
  if (mfails.length) allOk = false;
  console.log('');
  console.log(`[手机档两级导航 · ${theme}]`);
  for (const [k, v] of Object.entries(m)) console.log(`  ${v ? '通过' : '失败'}  ${k}`);
  await ctx.close();
}

// 卷面图配好之后那一档：同一套版式，图位有图。
//
// 这是一棵**不同的节点树**——CoverBox 换成带 background-image 的块、处境卡多出一条通栏、
// 卷页顶部多出一条通栏。上面那几轮跑的全是「没配图」那一档，把有图分支整段删掉照样全绿
// （predicate-and-wiring-discipline 形状 2：链路只建一半，编译过、测试绿、通读也挑不出）。
coversOn = true;
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  const c = {};
  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(900);

  // 数的是「真的引用了那张图的元素」，不是「有没有 background-image 属性」——
  // 页面上本来就有别的带背景图的东西，只查属性会把它们算进来，判据就永远为真。
  //
  // 而且必须**按位置分开数**。第一版只断言「总数 >= 8」，结果把七卷行那一组整个
  // 关掉（CoverBox 永远回落汉字方块）它依然绿：处境卡那 8 条自己就够数了。
  // 判据比它要管的范围窄/松，是本仓库反复踩的形状 1 —— 所以这里按实际渲染尺寸
  // 把两组分开：七卷行是 56 宽的小块，处境卡是 112 高的通栏。
  const countCovers = () => page.evaluate((url) => {
    const hit = (el) => (el.getAttribute('style') || '').includes(url);
    const els = [...document.querySelectorAll('[style]')].filter(hit);
    const size = (el) => el.getBoundingClientRect();
    return {
      total: els.length,
      rows: els.filter((el) => Math.round(size(el).width) === 56).length,
      banners: els.filter((el) => Math.round(size(el).height) === 112).length,
    };
  }, COVER_URL);

  const landing = await countCovers();
  // 七卷行必须是**七张**，一张不少：少一张说明某一卷的图位没接上，
  // 而那一卷会静默回落成汉字方块 —— 光看页面挑不出来。
  c['落地页七卷行都换成了卷面图'] = landing.rows === 7;
  c['落地页处境卡有通栏配图'] = landing.banners >= 1;
  await page.screenshot({ path: `${OUT}/m6-covers-landing-${theme}.png`, fullPage: true });

  // 有图之后仍不许横向溢出：通栏图用负边距顶掉外层 padding，算错一边就会顶出屏幕。
  const noOverflow = async () => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  c['落地页有图时无横向溢出'] = await noOverflow();

  // 进卷页：顶部那条通栏
  await page.locator('text=先把话说清楚').first().click();
  await page.waitForSelector('text=说的是不是你', { timeout: 20000 });
  await page.waitForTimeout(700);
  c['卷页通栏卷面图渲染出来了'] = (await countCovers()).total >= 1;
  c['卷页有图时无横向溢出'] = await noOverflow();
  await page.screenshot({ path: `${OUT}/m7-covers-volume-${theme}.png`, fullPage: true });

  const cfails = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (cfails.length) allOk = false;
  console.log('');
  console.log(`[手机档卷面图 · ${theme}]`);
  for (const [k, v] of Object.entries(c)) console.log(`  ${v ? '通过' : '失败'}  ${k}`);
  await ctx.close();
}
coversOn = false;

// 守卫：上游返回畸形（缺 error 键的旧格式）时，看板降级但书单不许被带走。
apiShape = 'legacy';
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
  });
  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  let survived = true;
  try {
    await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  } catch { survived = false; }
  const crashed = await page.locator('text=页面渲染出错').first().isVisible().catch(() => false);
  const shelfOk = await page.locator('text=《你的灯亮着吗？》').first().isVisible().catch(() => false);
  const pass = survived && !crashed && shelfOk;
  if (!pass) allOk = false;
  console.log('');
  console.log('[畸形上游响应]');
  console.log(`  ${pass ? '通过' : '未通过'}  看板拿到畸形数据时页面不崩、书单照常可读`);
  await page.screenshot({ path: `${OUT}/03-legacy-response.png` });
  await ctx.close();
}

await browser.close();
server.close();
for (const r of report) {
  console.log(`\n[${r.theme}]`);
  for (const [k, v] of Object.entries(r.step)) console.log(`  ${v ? '通过' : '失败'}  ${k}`);
}
console.log(`\n截图：${OUT}`);
process.exit(allOk ? 0 : 1);
