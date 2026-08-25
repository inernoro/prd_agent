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

await page.goto('http://localhost:8123/mock.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

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
    const file = `${OUT}/${id}.${theme}.png`;
    await board.screenshot({ path: file });
    manifest.push({ boardId: id, theme, image: file });
    console.log(id, theme);
  }
}

fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log('impl boards:', manifest.length, '| errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
