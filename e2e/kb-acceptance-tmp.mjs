/**
 * 知识库「逐句修改」真视觉验收：真人路径走一遍，产物必须真的出现在截图里。
 * 用一份自建的临时文档做实验（共享 Mongo，跑完删掉），不碰任何真实资料。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL;
const USER = process.env.MAP_USER;
const PASS = process.env.MAP_PASSWORD;
const OUT = process.env.OUT_DIR || '/tmp/kb-acceptance';
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let shotN = 0;
const shot = async (page, name) => {
  const file = `${OUT}/${String(++shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  log('shot', file);
  return file;
};

const TEST_DOC = `# 逐句修改验收样例

第一阶段建议至少形成以下成果：

1. 《真实工作能力基准标准》，定义任务来源、任务分级、验证方式、入库和退役规则；
2. 《真实任务制作模板》，统一问题说明、代码版本、环境、验收条件、测试和任务元数据；
3. 《能力评价标准》，统一通过、部分通过、失败以及各能力维度的判断方式。

结尾段落保持不变，用来确认改写没有越界。
`;

// 沙箱里预装的是 1194 版浏览器，@playwright/test 期望 1217——显式指向已装的可执行文件，
// 不联网重下（环境约定：PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1）
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  // 沙箱出站走 agent proxy，Chromium 直连会被 reset：只在浏览器进程内绕开代理，
  // 由本机 relay（Node 做 TLS）转发到真实预览域名（sandbox-net 技能方案 B）
  args: ['--no-proxy-server'],
});
const ctx = await browser.newContext({ viewport: { width: 1520, height: 940 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text().slice(0, 200)); });

let createdEntryId = null;
let token = null;
let storeId = null;

try {
  // ── 登录 ──
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // 预览环境把管理员凭据注入到了登录表单里；只有空着时才自己填
  const userInput = page.locator('input:not([type="checkbox"])').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 30_000 });
  await userInput.fill(USER);
  await passInput.fill(PASS);
  await page.locator('button', { hasText: '进入控制台' }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  log('logged in →', page.url());

  token = await page.evaluate(() => {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const raw = store.getItem(store.key(i));
        if (!raw || !raw.includes('token')) continue;
        try {
          const parsed = JSON.parse(raw);
          const t = parsed?.state?.token || parsed?.token;
          if (typeof t === 'string' && t.length > 20) return t;
        } catch { /* 非 JSON 条目 */ }
      }
    }
    return null;
  });
  if (!token) throw new Error('拿不到会话 token，无法准备临时文档');

  // ── 准备：建一份临时文档（跑完删除），不在真实资料上做破坏性实验 ──
  const api = async (path, init = {}) => {
    const res = await page.request.fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* 非 JSON */ }
    return { status: res.status(), json, body };
  };

  const stores = await api('/api/document-store/stores');
  const list = stores.json?.data?.items ?? stores.json?.data ?? [];
  const writable = list.find((s) => s.canWrite !== false) ?? list[0];
  if (!writable) throw new Error(`没有可写知识库：${stores.status} ${stores.body.slice(0, 200)}`);
  storeId = writable.id;
  log('store', storeId, writable.name);

  const created = await api(`/api/document-store/stores/${storeId}/entries`, {
    method: 'POST',
    data: JSON.stringify({
      title: `逐句修改验收-${Date.now()}`,
      sourceType: 'upload',
      contentType: 'text/markdown',
      summary: '临时验收样例，跑完即删',
    }),
  });
  createdEntryId = created.json?.data?.id;
  if (!createdEntryId) throw new Error(`建临时文档失败：${created.status} ${created.body.slice(0, 300)}`);
  const filled = await api(`/api/document-store/entries/${createdEntryId}/content`, {
    method: 'PUT',
    data: JSON.stringify({ content: TEST_DOC, contentType: 'text/markdown' }),
  });
  if (filled.status >= 300) throw new Error(`写入样例正文失败：${filled.status} ${filled.body.slice(0, 200)}`);
  log('temp entry', createdEntryId);

  // ── 真人路径：点导航进知识库（禁地址栏直达） ──
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const navItem = page.locator('a, button, [role="button"]').filter({ hasText: /^知识库$/ }).first();
  await navItem.waitFor({ state: 'visible', timeout: 20_000 });
  await navItem.click();
  await page.waitForURL(/document-store/, { timeout: 20_000 });
  await page.waitForTimeout(3000);
  await shot(page, 'knowledge-base');

  // 打开刚建的文档
  const docLink = page.locator('text=逐句修改验收-').first();
  await docLink.waitFor({ state: 'visible', timeout: 20_000 });
  await docLink.click();
  await page.waitForTimeout(2500);
  await page.waitForSelector('text=第一阶段建议至少形成以下成果', { timeout: 20_000 });
  await shot(page, 'doc-opened');

  // ── 划词：在正文里选中那一句（模拟真实 DOM Range + mouseup） ──
  const selected = await page.evaluate(() => {
    const target = '第一阶段建议至少形成以下成果：';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = (node.textContent ?? '').indexOf(target);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + target.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return sel.toString();
    }
    return null;
  });
  log('selected:', JSON.stringify(selected));
  await page.waitForTimeout(800);
  await shot(page, 'selection-toolbar');

  // ── 点「AI 改写」→ 就地指令条 ──
  await page.locator('button', { hasText: 'AI 改写' }).first().click();
  await page.waitForSelector('text=让 AI 修改选中的', { timeout: 10_000 });
  await shot(page, 'prompt-bar');

  const input = page.locator('input[placeholder*="想怎么改"]').first();
  await input.fill('能否细化一些？');
  await shot(page, 'prompt-typed');
  await input.press('Enter');

  // ── 流式：正文里必须真的出现变化，而不是只有状态条在转 ──
  await page.waitForSelector('.doc-inline-diff del', { timeout: 30_000 });
  log('del 已出现（原文挂删除线）');
  await page.waitForSelector('.doc-inline-diff ins', { timeout: 180_000 });
  log('ins 已出现（新内容标蓝）');
  await page.waitForTimeout(1500);
  await shot(page, 'streaming-inline-diff');

  // ── 闭环：等到产物真的写完（出现「采纳」）才截图，不拿超时冒充完成 ──
  const acceptBtn = page.locator('button', { hasText: '采纳' }).first();
  await acceptBtn.waitFor({ state: 'visible', timeout: 600_000 });
  await page.waitForTimeout(1200);
  const insCount = await page.locator('.doc-inline-diff ins').count();
  const delCount = await page.locator('.doc-inline-diff del').count();
  const insText = (await page.locator('.doc-inline-diff ins').allInnerTexts()).join(' ').slice(0, 400);
  log(`diff 元素：ins=${insCount} del=${delCount}`);
  log('ins 文本样例：', insText);
  await shot(page, 'review-dark');

  // 结尾段落必须逐字保留（改动范围 = 指令范围）
  const tailIntact = await page.locator('text=结尾段落保持不变，用来确认改写没有越界。').count();
  log('结尾段落仍在：', tailIntact > 0);

  // ── 浅色主题看一眼（双主题都要过）──
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(900);
  await shot(page, 'review-light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(600);

  // ── 采纳：落库 + 刷新后仍在 ──
  await acceptBtn.click();
  await page.waitForTimeout(4000);
  await shot(page, 'accepted');
  const saved = await api(`/api/document-store/entries/${createdEntryId}/content`);
  const savedText = saved.json?.data?.content ?? saved.body;
  const keptTail = savedText.includes('结尾段落保持不变');
  const noMarkup = !savedText.includes('<ins>') && !savedText.includes('<del>');
  const changed = !savedText.includes('第一阶段建议至少形成以下成果：\n\n1. 《真实工作能力基准标准》，定义任务来源');
  log(`落库校验：结尾保留=${keptTail} 无标记残留=${noMarkup} 正文已变=${changed}`);
  log('落库正文前 300 字：', savedText.slice(0, 300).replace(/\n/g, '\\n'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await shot(page, 'after-reload');

  console.log('\nRESULT ' + JSON.stringify({ insCount, delCount, tailIntact: tailIntact > 0, keptTail, noMarkup, changed }));
} catch (e) {
  log('FAILED:', e.message);
  await shot(page, 'failure').catch(() => {});
  process.exitCode = 1;
} finally {
  // 清理临时文档（共享 Mongo，不留垃圾）
  if (createdEntryId && token) {
    const res = await page.request.fetch(`${BASE}/api/document-store/entries/${createdEntryId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    log('cleanup entry', createdEntryId, res.status());
  }
  await browser.close();
}
