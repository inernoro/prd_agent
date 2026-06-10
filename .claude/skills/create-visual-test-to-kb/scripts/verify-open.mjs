// MAP 验收 · 归档后「自查能否打开」(项目无关)
// 用途：归档拿到分享链后，headless 打开真页面断言报告确实渲染（标题 + 正文 + 截图），
//       而不是"建了条目但点开空白"。空/打不开 → 退出码 2，调用方据此重新推送验收。
// 用法：PWPATH=$(npm root -g)/playwright node verify-open.mjs <shareUrl> "<标题或正文里必现的一段文字>" [最少图片数=1]
//   例：node verify-open.mjs https://x.miduo.org/s/lib/abc123 "SaaS空间模型" 4
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PW = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(PW);

const url = process.argv[2];
const mustText = process.argv[3] || '';
const minImg = parseInt(process.argv[4] || '1', 10);
if (!url) { console.error('用法: node verify-open.mjs <shareUrl> "<必现文字>" [最少图片数]'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  // 分享是库级目录页：若给了必现文字，点左侧目录里匹配的那篇打开
  if (mustText) {
    await page.getByText(new RegExp(mustText)).first().click({ timeout: 8000 }).catch(() => {});
    await sleep(3500);
  }
  const txt = await page.locator('body').innerText();
  const imgCount = await page.locator('img').count();
  const hasText = mustText ? txt.includes(mustText.replace(/[.*+?^${}()|[\]\\]/g, '')) || new RegExp(mustText).test(txt) : txt.length > 200;
  const okImg = imgCount >= minImg;
  // 死页判定只在「内容没渲染出来」时才有意义：报告正文完全可能合法地包含
  // "不存在 / 已失效" 等词（如缺陷描述、整改记录），全文扫词会把正常报告误杀。
  // 故仅当 必现文字未命中 或 图片数不达标 时，才用关键词区分"死页"与"内容缺失"。
  const deadKeywordHit = ['暂无可预览', '未对外开放', '页面不存在', '链接已失效', '无权访问', '404'].some((k) => txt.includes(k));
  const dead = (!hasText || !okImg) && deadKeywordHit;
  console.log(`[verify-open] url=${url}`);
  console.log(`  必现文字命中=${hasText}  图片数=${imgCount}(需≥${minImg})  死页提示=${dead}`);
  if (dead || !hasText || !okImg) {
    console.log('  结论：打不开/空白/截图缺失 → 验收不算落地，需重新推送（exit 2）');
    code = 2;
  } else {
    console.log('  结论：报告可正常打开、正文 + 截图齐全（exit 0）');
  }
} catch (e) {
  console.error('[verify-open] 加载异常：', e && e.message ? e.message : e, '→ exit 2');
  code = 2;
} finally {
  await browser.close();
}
process.exit(code);
