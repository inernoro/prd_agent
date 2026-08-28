/**
 * 本地跑通「知识库逐句修改」并逐步取证。
 *
 * 前端是真实的 prd-admin（vite dev），后端是 mock-kb-server：
 * 划词捕获、选区定位、SSE 流、就地 diff、采纳写回全部走产品代码，
 * 只有「文档数据」和「模型输出」是造的。
 *
 * 用法：
 *   node mock-kb-server.mjs 5001 &
 *   npx vite --port 8000            （在 prd-admin 目录）
 *   E2E_BASE_URL=http://127.0.0.1:8000 OUT_DIR=/tmp/shots node local-kb-sentence-edit-shots.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8000';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:5001';
const OUT = process.env.OUT_DIR || '/tmp/kb-local-shots';
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let n = 0;
const shot = async (page, name) => {
  const f = `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f });
  log('shot', f);
};

const AUTH = {
  state: {
    isAuthenticated: true,
    user: { userId: 'u1', username: 'demo', displayName: '演示用户', role: 'ADMIN' },
    token: 'mock-token',
    refreshToken: 'mock-refresh',
    sessionKey: 'mock-session',
    permissions: ['access', 'document-store.read', 'document-store.write'],
    permissionsLoaded: true,
    isRoot: true,
    menuCatalog: [],
    menuCatalogLoaded: true,
    cdnBaseUrl: '',
    permFingerprint: 'mock',
  },
  version: 0,
};

/**
 * 在正文里选中一段文字：真实 Range + 真实事件，走产品自己的 useContentSelection。
 * 支持跨 text node（一句话里有加粗/行内代码/链接时，DOM 会把它拆成好几个文本节点，
 * 真人拖选跨过它们毫无障碍，脚本也必须能做到，否则测的就不是真实场景）。
 */
async function selectText(page, target) {
  return page.evaluate((t) => {
    const root = document.querySelector('.prose-invert') ?? document.body;
    // 把正文所有 text node 拼成一条扁平字符串，同时记住每个字符属于哪个节点的哪一位
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let flat = '';
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? '';
      if (!text) continue;
      nodes.push({ node, start: flat.length, len: text.length });
      flat += text;
    }
    const norm = (s) => s.replace(/\s+/g, ' ');
    // 先精确找；找不到就在「空白折叠」后的坐标系里找，再映射回原始下标
    let idx = flat.indexOf(t);
    let len = t.length;
    if (idx < 0) {
      const map = [];
      let collapsed = '';
      let prevSpace = false;
      for (let i = 0; i < flat.length; i++) {
        const ch = flat[i];
        if (/\s/.test(ch)) {
          if (!prevSpace) { collapsed += ' '; map.push(i); prevSpace = true; }
        } else { collapsed += ch; map.push(i); prevSpace = false; }
      }
      const hit = collapsed.indexOf(norm(t).trim());
      if (hit < 0) return null;
      const needle = norm(t).trim();
      idx = map[hit];
      len = map[hit + needle.length - 1] + 1 - idx;
    }
    const locate = (pos) => {
      for (const n of nodes) if (pos >= n.start && pos <= n.start + n.len) return { node: n.node, offset: pos - n.start };
      return null;
    };
    const a = locate(idx);
    const b = locate(idx + len);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();
  }, target);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((auth) => {
  localStorage.setItem('prd-admin-auth', JSON.stringify(auth));
}, AUTH);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text().slice(0, 160)); });

const results = {};

try {
  // ── 打开知识库并进入文档 ──
  await page.goto(`${BASE}/document-store`, { waitUntil: 'domcontentloaded' });
  // 真人路径：先进知识库，再进文档
  await page.waitForSelector('text=产品评估知识库', { timeout: 30_000 });
  await page.waitForTimeout(600);
  await shot(page, '知识库列表');
  await page.locator('text=产品评估知识库').first().click();
  await page.waitForSelector('text=真实工作能力评估方案', { timeout: 20_000 });
  await page.waitForTimeout(800);
  await shot(page, '进入知识库');
  await page.locator('text=真实工作能力评估方案').first().click();
  await page.waitForSelector('text=第一阶段建议至少形成以下成果', { timeout: 20_000 });
  await page.waitForTimeout(800);
  await shot(page, '文档已打开');

  // ── 场景一：改写一整段（列表前面那句引导语 + 三条列表）──
  const picked = await selectText(page, '第一阶段建议至少形成以下成果：\n\n《真实工作能力基准标准》，定义任务来源、任务分级、验证方式、入库和退役规则；\n\n《真实任务制作模板》，统一问题说明、代码版本、环境、验收条件、测试和任务元数据；\n\n《能力评价标准》，统一通过、部分通过、失败以及各能力维度的判断方式。');
  results.selected = picked;
  log('选中:', JSON.stringify(picked));
  await page.waitForTimeout(700);
  await shot(page, '划词后的工具条');

  await page.locator('button', { hasText: 'AI 改写' }).first().click();
  await page.waitForSelector('text=让 AI 修改选中的', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot(page, '就地输入条');

  const input = page.locator('input[placeholder*="想怎么改"]').first();
  await input.fill('能否细化一些？');
  await page.waitForTimeout(300);
  await shot(page, '输入指令');
  await input.press('Enter');

  // 流式：正文里必须真的在长东西
  await page.waitForSelector('.doc-inline-diff ins', { timeout: 20_000 });
  await page.waitForTimeout(900);
  results.streamingIns = await page.locator('.doc-inline-diff ins').count();
  await shot(page, '流式改写中');
  await page.waitForTimeout(1200);
  await shot(page, '流式改写中-更多');

  // 闭环：等到真的写完
  const accept = page.locator('button', { hasText: '采纳' }).first();
  await accept.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(600);
  results.reviewIns = await page.locator('.doc-inline-diff ins').count();
  results.reviewDel = await page.locator('.doc-inline-diff del').count();
  results.tailIntact = (await page.locator('text=结尾段落逐字保留，用来确认改写没有越界。').count()) > 0;
  await shot(page, '改完待确认-撤销或采纳');

  // 浅色主题看一眼
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(700);
  await shot(page, '改完待确认-浅色');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400);

  // 采纳 → 落库
  await accept.click();
  await page.waitForTimeout(2500);
  await shot(page, '已采纳-正文已更新');

  const saved = await (await fetch(`${MOCK}/__mock/state`)).json();
  results.writes = saved.writes;
  results.savedHasNew = saved.content.includes('可落地成果');
  results.savedNoMarkup = !saved.content.includes('<ins>') && !saved.content.includes('<del>');
  results.savedTailIntact = saved.content.includes('结尾段落逐字保留');
  results.savedNoDupPrefix = !/^\s*\d+\.\s+\d+\.\s+/m.test(saved.content);
  log('落库校验:', JSON.stringify({ ...results }));

  // ── 场景二：选中「带加粗 + 行内代码 + 链接」的整句 —— 修复前这一类根本定位不到 ──
  await page.waitForTimeout(600);
  const picked2 = await selectText(page, '评估过程中所有任务都来自真实缺陷库，调用 taskRunner.execute 拉起隔离环境， 详细口径见评估实施细则。');
  results.selected2 = picked2;
  log('选中2:', JSON.stringify(picked2));
  await page.waitForTimeout(700);
  await shot(page, '场景二-选中带格式的句子');

  const rewriteBtn2 = page.locator('button', { hasText: 'AI 改写' }).first();
  results.entryShownForFormatted = await rewriteBtn2.isVisible().catch(() => false);
  if (results.entryShownForFormatted) {
    await rewriteBtn2.click();
    const promptVisible = await page.locator('text=让 AI 修改选中的').isVisible().catch(() => false);
    // 就地输入条出现 = 走的是新交互（能安全定位）；旧浮层出现 = 降级
    results.formattedUsesInlineFlow = promptVisible;
    await shot(page, '场景二-入口形态');
    if (promptVisible) {
      const input2 = page.locator('input[placeholder*="想怎么改"]').first();
      await input2.fill('把口径说得更严谨一点');
      await input2.press('Enter');
      await page.waitForSelector('.doc-inline-diff ins', { timeout: 20_000 });
      await page.locator('button', { hasText: '采纳' }).first().waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(600);
      await shot(page, '场景二-带格式句子的就地diff');
      await page.locator('button', { hasText: '采纳' }).first().click();
      await page.waitForTimeout(2000);
      await shot(page, '场景二-已采纳');
      const saved2 = await (await fetch(`${MOCK}/__mock/state`)).json();
      results.savedLinkIntact = saved2.content.includes('[评估实施细则](https://example.com/spec)');
      results.savedCodeIntact = saved2.content.includes('`taskRunner.execute`');
    }
  }

  console.log('\nRESULT ' + JSON.stringify(results, null, 2));
} catch (e) {
  log('FAILED:', e.message);
  await shot(page, '失败现场').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
