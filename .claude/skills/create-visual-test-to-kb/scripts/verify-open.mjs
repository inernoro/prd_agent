// 验收 · 归档后「自查能否打开」(项目无关，存储无关)
// 用途：归档拿到可达链接后，headless 打开真页面断言报告确实渲染（标题 + 正文 + 截图），
//       而不是"建了条目但点开空白"。空/打不开 → 退出码 2，调用方据此重新推送验收。
// 链接来源（任选其一，脚本本身不关心存储）：
//   - CDS 匿名分享链 /r/<token>（E6，无需登录，headless 可直接断言——首选）。
//   - CDS 验收中心直达深链 /reports?project=&folder=&report=（登录态；headless 需带 CDS 会话，
//     或改用 cds/cli/acceptance 的 proxyroute harness 认证打开）。
//   - 旧 MAP 知识库分享链 /s/lib/<token>（mode=doc-store 向后兼容路径）。
// 用法：PWPATH=$(npm root -g)/playwright node verify-open.mjs <url> "<标题或正文里必现的一段文字>" [最少图片数=1]
//   例：node verify-open.mjs https://cds.miduo.org/r/abc123 "SaaS空间模型" 4
// 默认最多尝试 3 次（首试 + 2 次重试），并打印每次结果；用 VERIFY_OPEN_MAX_ATTEMPTS=1 可关闭重试。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PW = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(PW);

const url = process.argv[2];
const mustText = process.argv[3] || '';
const minImg = parseInt(process.argv[4] || '1', 10);
if (!url) { console.error('用法: node verify-open.mjs <shareUrl> "<必现文字>" [最少图片数]'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maxAttempts = Math.max(1, parseInt(process.env.VERIFY_OPEN_MAX_ATTEMPTS || '3', 10) || 3);
const retryDelayMs = Math.max(0, parseInt(process.env.VERIFY_OPEN_RETRY_DELAY_MS || '10000', 10) || 10000);
const settleTimeoutMs = Math.max(5000, parseInt(process.env.VERIFY_OPEN_SETTLE_TIMEOUT_MS || '25000', 10) || 25000);

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const attempts = [];

async function runAttempt(attempt) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);
  // 分享是库级目录页：若给了必现文字，点左侧目录里匹配的那篇打开
  if (mustText) {
    await page.getByText(new RegExp(mustText)).first().click({ timeout: 8000 }).catch(() => {});
    await page.getByText(new RegExp(mustText)).first().waitFor({ state: 'visible', timeout: settleTimeoutMs }).catch(() => {});
  }
  await page.waitForFunction(
    ({ text, minImg }) => {
      const body = document.body && document.body.innerText || '';
      const hasText = text ? body.includes(text) || new RegExp(text).test(body) : body.trim().length > 200;
      const imgCount = document.querySelectorAll('img').length;
      return hasText && imgCount >= minImg;
    },
    { text: mustText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), minImg },
    { timeout: settleTimeoutMs, polling: 500 },
  ).catch(() => {});
  await sleep(1000);
  const txt = await page.locator('body').innerText();
  const imgCount = await page.locator('img').count();
  const hasText = mustText ? txt.includes(mustText.replace(/[.*+?^${}()|[\]\\]/g, '')) || new RegExp(mustText).test(txt) : txt.length > 200;
  const okImg = imgCount >= minImg;
  // 死页判定只在「内容没渲染出来」时才有意义：报告正文完全可能合法地包含
  // "不存在 / 已失效" 等词（如缺陷描述、整改记录），全文扫词会把正常报告误杀。
  // 故仅当 必现文字未命中 或 图片数不达标 时，才用关键词区分"死页"与"内容缺失"。
  const deadKeywordHit = ['暂无可预览', '未对外开放', '页面不存在', '链接已失效', '无权访问', '404'].some((k) => txt.includes(k));
  const dead = (!hasText || !okImg) && deadKeywordHit;
  return { attempt, hasText, imgCount, minImg, dead, ok: !dead && hasText && okImg };
}

let code = 2;
try {
  console.log(`[verify-open] url=${url}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runAttempt(attempt);
      attempts.push(result);
      console.log(`  第${attempt}次：必现文字命中=${result.hasText}  图片数=${result.imgCount}(需≥${result.minImg})  死页提示=${result.dead}`);
      if (result.ok) {
        code = 0;
        if (attempt > 1) {
          console.log(`  重试结果：前序尝试未通过，第${attempt}次通过；按偶发抖动记录，调用方需在报告中保留首试失败与重试通过。`);
        }
        break;
      }
      if (attempt < maxAttempts) {
        console.log(`  第${attempt}次未通过，${Math.round(retryDelayMs / 1000)}秒后重试一次。`);
        await sleep(retryDelayMs);
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      attempts.push({ attempt, error: message, ok: false });
      console.log(`  第${attempt}次：加载异常=${message}`);
      if (attempt < maxAttempts) {
        console.log(`  第${attempt}次异常，${Math.round(retryDelayMs / 1000)}秒后重试一次。`);
        await sleep(retryDelayMs);
      }
    }
  }
  if (code === 0) {
    console.log('  结论：报告可正常打开、正文 + 截图齐全（exit 0）');
  } else {
    console.log('  结论：打不开/空白/截图缺失；已完成允许的重试，验收不算落地（exit 2）');
  }
} finally {
  await browser.close();
}
process.exit(code);
