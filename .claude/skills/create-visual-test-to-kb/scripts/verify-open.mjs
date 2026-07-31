// 验收 · 归档后「自查能否打开」(项目无关，存储无关)
// 用途：归档拿到可达链接后，headless 打开真页面断言报告确实渲染（标题 + 正文 + 截图），
//       并全量核对交互报告的内部链接目标，真实点击当前桌面路径可见链接验证章节滚动。
//       而不是"建了条目但点开空白"。空/打不开 → 退出码 2，调用方据此重新推送验收。
// 链接来源（任选其一，脚本本身不关心存储）：
//   - CDS 匿名分享链 /r/<token>（E6，无需登录，headless 可直接断言——首选）。
//   - CDS 验收中心直达深链 /reports?project=&folder=&report=（登录态；headless 需带 CDS 会话，
//     或改用 cds/cli/acceptance 的 proxyroute harness 认证打开）。
//   - 旧 MAP 知识库分享链 /s/lib/<token>（mode=doc-store 向后兼容路径）。
// 用法：PWPATH=$(npm root -g)/playwright node verify-open.mjs <url> "<标题或正文里必现的一段文字>" [最少图片数=1]
//   例：node verify-open.mjs https://<cds-host>/r/<report-id> "SaaS空间模型" 4
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
// CDS 登录态深链的安全回退：匿名分享不适合内部报告时，允许调用方仅通过环境变量
// 注入 CDS access key。密钥不写入 URL、日志或报告。
// 与 archive_report.py 的 _cds_auth_headers 一致：项目级 CDS_PROJECT_KEY 优先，
// 否则回退全局 AI_ACCESS_KEY，避免只配了项目级 key 的环境验证时漏带鉴权而 exit 2。
const cdsAccessKey = (process.env.CDS_PROJECT_KEY || process.env.AI_ACCESS_KEY || '').trim();
let targetHost = '';
try { targetHost = new URL(url).host; } catch {}
const isCdsHost = (host) => /(^|\.)cds\.miduo\.org$/i.test(host || '');
// 关键：ctx.setExtraHTTPHeaders 会给 context 内「所有」请求带上 header，
// 报告页里的外链图片 / iframe / 三方子资源都会被附上密钥，造成密钥泄漏到非 CDS host。
// 改用 route 逐请求判定：仅当该请求的 host 是目标 CDS host 时才注入密钥头。
if (cdsAccessKey && isCdsHost(targetHost)) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    let reqHost = '';
    try { reqHost = new URL(req.url()).host; } catch {}
    if (isCdsHost(reqHost)) {
      const headers = { ...req.headers(), 'x-ai-access-key': cdsAccessKey };
      await route.continue({ headers });
    } else {
      await route.continue();
    }
  });
}
const page = await ctx.newPage();
const attempts = [];

async function inspectRenderedContent() {
  const texts = [];
  let imgCount = 0;
  for (const frame of page.frames()) {
    try {
      texts.push(await frame.locator('body').innerText());
      imgCount += await frame.locator('img').count();
    } catch {
      // 跨代切换或 iframe 导航期间 frame 可能瞬时销毁；下一轮轮询会重新读取。
    }
  }
  return { text: texts.join('\n'), imgCount };
}

async function waitForRenderedContent(text, minImages) {
  const deadline = Date.now() + settleTimeoutMs;
  let snapshot = { text: '', imgCount: 0 };
  while (Date.now() < deadline) {
    snapshot = await inspectRenderedContent();
    const hasText = text ? snapshot.text.includes(text) : snapshot.text.trim().length > 200;
    if (hasText && snapshot.imgCount >= minImages) return snapshot;
    await sleep(500);
  }
  return snapshot;
}

async function auditInteractiveReports() {
  const reports = [];
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('#reportBody').count() === 0) continue;
      const staticAudit = await frame.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href^="#"]'))
          .map((link) => ({
            href: link.getAttribute('href') || '',
            text: (link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          }))
          .filter((link) => link.href.length > 1);
        const broken = links.filter((link) => {
          let id = link.href.slice(1);
          try { id = decodeURIComponent(id); } catch { return true; }
          return document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length !== 1;
        });
        return { linkCount: links.length, broken };
      });

      const clickErrors = [];
      const links = frame.locator('a[href^="#"]');
      const count = await links.count();
      let clicked = 0;
      for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        const href = await link.getAttribute('href');
        if (!href || href.length <= 1 || !(await link.isVisible())) continue;
        let targetId = href.slice(1);
        try { targetId = decodeURIComponent(targetId); } catch {
          clickErrors.push(`${href}: 锚点编码无效`);
          continue;
        }
        const targetCount = await frame.evaluate(
          (id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length,
          targetId,
        );
        if (targetCount !== 1) continue;
        const label = ((await link.innerText().catch(() => '')) || href).trim().replace(/\s+/g, ' ').slice(0, 80);
        try {
          await link.click({ timeout: 5000 });
          clicked += 1;
          await sleep(50);
          const targetVisible = await frame.evaluate((id) => {
            const target = document.getElementById(id);
            if (!target) return false;
            const rect = target.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }, targetId);
          if (!targetVisible) clickErrors.push(`${label}: 点击后目标 #${targetId} 未进入可视区`);
        } catch (error) {
          clickErrors.push(`${label}: ${error && error.message ? error.message.split('\n')[0] : String(error)}`);
        }
      }
      reports.push({ ...staticAudit, clicked, clickErrors });
    } catch (error) {
      reports.push({ linkCount: 0, clicked: 0, broken: [], clickErrors: [String(error)] });
    }
  }
  const broken = reports.flatMap((report) => report.broken || []);
  const clickErrors = reports.flatMap((report) => report.clickErrors || []);
  return {
    reportCount: reports.length,
    linkCount: reports.reduce((sum, report) => sum + (report.linkCount || 0), 0),
    clicked: reports.reduce((sum, report) => sum + (report.clicked || 0), 0),
    broken,
    clickErrors,
    ok: broken.length === 0 && clickErrors.length === 0,
  };
}

async function runAttempt(attempt) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);
  // 分享是库级目录页：若给了必现文字，点左侧目录里匹配的那篇打开
  if (mustText) {
    await page.getByText(new RegExp(mustText)).first().click({ timeout: 8000 }).catch(() => {});
    await page.getByText(new RegExp(mustText)).first().waitFor({ state: 'visible', timeout: settleTimeoutMs }).catch(() => {});
  }
  const rendered = await waitForRenderedContent(mustText, minImg);
  await sleep(1000);
  const finalRendered = await inspectRenderedContent();
  const txt = finalRendered.text || rendered.text;
  const imgCount = Math.max(finalRendered.imgCount, rendered.imgCount);
  const hasText = mustText ? txt.includes(mustText) : txt.length > 200;
  const okImg = imgCount >= minImg;
  const interaction = await auditInteractiveReports();
  // 死页判定只在「内容没渲染出来」时才有意义：报告正文完全可能合法地包含
  // "不存在 / 已失效" 等词（如缺陷描述、整改记录），全文扫词会把正常报告误杀。
  // 故仅当 必现文字未命中 或 图片数不达标 时，才用关键词区分"死页"与"内容缺失"。
  const deadKeywordHit = ['暂无可预览', '未对外开放', '页面不存在', '链接已失效', '无权访问', '404'].some((k) => txt.includes(k));
  const dead = (!hasText || !okImg) && deadKeywordHit;
  return { attempt, hasText, imgCount, minImg, dead, interaction, ok: !dead && hasText && okImg && interaction.ok };
}

let code = 2;
try {
  console.log(`[verify-open] url=${url}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runAttempt(attempt);
      attempts.push(result);
      console.log(`  第${attempt}次：必现文字命中=${result.hasText}  图片数=${result.imgCount}(需≥${result.minImg})  死页提示=${result.dead}`);
      console.log(`  第${attempt}次交互：报告=${result.interaction.reportCount}  内部链接=${result.interaction.linkCount}  已点击=${result.interaction.clicked}  断链=${result.interaction.broken.length}  点击失败=${result.interaction.clickErrors.length}`);
      if (result.interaction.broken.length) {
        console.log(`  断链明细：${result.interaction.broken.map((item) => `${item.text || item.href} -> ${item.href}`).join(' | ')}`);
      }
      if (result.interaction.clickErrors.length) console.log(`  点击失败明细：${result.interaction.clickErrors.join(' | ')}`);
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
    console.log('  结论：报告可正常打开，正文、截图和内部链接交互齐全（exit 0）');
  } else {
    console.log('  结论：打不开、空白、截图缺失或内部链接不可用；已完成允许的重试，验收不算落地（exit 2）');
  }
} finally {
  await browser.close();
}
process.exit(code);
