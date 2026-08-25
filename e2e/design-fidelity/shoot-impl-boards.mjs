/**
 * 把对照台上带设计稿编号的画板逐块截出来，文件名与设计稿画板一一对应，
 * 供审查智能体配对打分。没有编号的画板（本次新增、设计稿里没有的）不参与打分。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = process.env.OUT_DIR || '/tmp/claude-0/-home-user-prd-agent/e94f0ca4-fb88-51cb-95f1-831ce61d00ee/scratchpad/impl-boards';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
// reducedMotion：组件挂载时会 smooth 滚到当前句，取证要的是这一屏顶部
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

/**
 * 两套配色各取一版：平台主题 vs 设计稿原色。同一批组件、同一批数据，
 * 只有 token 不同，比出来的差异才只归因于配色本身。
 */
const PALETTE = process.env.PALETTE === 'design' ? 'design' : 'platform';
const url = PALETTE === 'design'
  ? 'http://localhost:8123/mock.html?palette=design'
  : 'http://localhost:8123/mock.html';
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/**
 * 把画板驱动到它该有的状态。只认真实交互：输入框就真的输入，要进编辑态就真的点那一行。
 * 认不出的画板原样返回（大多数画板是静态的，不需要驱动）。
 */
async function driveBoardState(page, board, id) {
  if (id !== 'cap-B2') return;
  // 稿面 B2：搜索框里有「导入」，命中计数亮着，其中一句处于编辑态
  const search = board.locator('input[aria-label^="搜索"]').first();
  if (await search.count() === 0) return;
  await search.fill('导入');
  await page.waitForTimeout(400);
  // 点第三条原文进编辑态（稿面画的就是列表中段某一句在改）
  const rows = board.locator('[data-transcript-row]');
  const total = await rows.count();
  if (total >= 3) {
    await rows.nth(2).click();
    await page.waitForTimeout(400);
  }
}

const manifest = [];
// 设计稿的深浅两档要分别取证：只在一个主题下比对等于放过一半
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(700);
  const boards = await page.locator('[data-impl-board]').all();
  for (const board of boards) {
    const id = await board.getAttribute('data-impl-board');
    if (!id) continue;
    for (let r = 0; r < 3; r++) {
      await board.evaluate((el) => {
        el.querySelectorAll('*').forEach((n) => { if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = 0; });
      });
      await page.waitForTimeout(200);
    }
    /*
     * 有些画板画的是**某个交互之后**的状态（B2 是「搜了词 + 正在改一句」）。
     * 这类状态一律用真实交互驱动出来，不给组件开只给取证用的后门——
     * 后门做出来的图判的是后门，不是用户真能看到的那一屏。
     */
    await driveBoardState(page, board, id);

    const file = `${OUT}/${id}.${PALETTE}.${theme}.png`;
    await board.screenshot({ path: file });
    manifest.push({ boardId: id, palette: PALETTE, theme, image: file });
    console.log(id, PALETTE, theme);

    /*
     * 一屏装不下的画板还要给下滚证据。只截顶部等于把「下面那几块到底做没做」
     * 留成悬案——审查智能体只能按「拿不准算缺失」处理，分数白扣。
     * 锚点取画板内的区块标题，标题文本即证据文件名，增减区块自动跟上。
     */
    const headings = await board.locator('h3').all();
    for (const heading of headings) {
      const name = (await heading.innerText()).trim();
      if (!name) continue;
      await heading.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(250);
      const sectionFile = `${OUT}/${id}.${PALETTE}.${theme}.${name}.png`;
      await board.screenshot({ path: sectionFile });
      manifest.push({ boardId: id, palette: PALETTE, theme, section: name, image: sectionFile });
      console.log('  ↳', name);
    }
  }
}

fs.writeFileSync(`${OUT}/manifest.${PALETTE}.json`, JSON.stringify(manifest, null, 2));
console.log('impl boards:', manifest.length, '| errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
