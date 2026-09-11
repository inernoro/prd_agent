const pw = (await import('/home/user/prd_agent/cds/node_modules/playwright/index.js')).default;
const { chromium } = pw;
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7852';
const OUT = process.env.UAT_OUT;
const facts = {}; let clicks = 0;
const log = (...a) => console.log('[verify]', ...a);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
// 全新 context = 真冷启动：localStorage 没有存过的 scope
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); log('shot', n); };
const click = async (l, label) => { await l.click(); clicks++; log('click ->', label); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.locator('input[autocomplete=username]').first().fill(process.env.CDS_USERNAME);
await page.locator('input[type=password]').first().fill(process.env.CDS_PASSWORD);
await page.locator('button[type=submit]').first().click();
await page.waitForTimeout(4000);

// 确认跑的是新版
facts.buildSha = await page.evaluate(async () => {
  try { const r = await fetch('/api/self-status', { credentials: 'include' }); const j = await r.json(); return j.headSha || j.commitHash || null; } catch { return null; }
});
log('CDS headSha =', facts.buildSha);

// ---- 角色 A：冷启动第一屏 ----
const enter = Date.now();
await click(page.locator('a[href="/status"], a:has-text("监控")').first(), '侧栏 监控中心');
await page.getByText('我盯的业务').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(3000);
facts.firstPaintMs = Date.now() - enter;
await shot('H1-cold-first-screen');
facts.coldBoard = await page.evaluate(() => {
  const t = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean);
  const cards = [...document.querySelectorAll('button')].filter(b => /窗口内|环境都通过判据|没读到样本/.test(b.innerText || '')).map(b => b.innerText.replace(/\n/g, ' | '));
  return { headline: t.slice(t.indexOf('我的项目'), t.indexOf('我的项目') + 24), cardCount: cards.length, cards, saysNone: document.body.innerText.includes('还没有一条业务监控') };
});
facts.coldClicks = clicks;
log('冷启动：', JSON.stringify(facts.coldBoard).slice(0, 600));

// ---- 角色 B / D：全部项目下两块还在不在 ----
const body1 = await page.evaluate(() => document.body.innerText);
facts.allProjects = { hasDiscovery: body1.includes('自检端点'), hasPublic: body1.includes('公开面板'), hint: (body1.match(/[^\n]*先选一个项目[^\n]*/g) || []) };
log('全部项目下：', JSON.stringify(facts.allProjects));
const strip = page.getByText('自检端点').first();
if (await strip.count()) { await strip.scrollIntoViewIfNeeded(); await page.waitForTimeout(600); await shot('H2-need-project-rows'); }

// ---- 「看这些环境」：手动取消勾选分支预览，看空态说什么 ----
clicks = 0;
const prevChip = page.getByRole('button', { name: /分支预览/ }).first();
if (await prevChip.count()) {
  await click(prevChip, '取消勾选 分支预览');
  await page.waitForTimeout(2500);
  await shot('H3-filtered-out');
  facts.filteredOut = await page.evaluate(() => {
    const t = document.body.innerText;
    return { saysNone: t.includes('还没有一条业务监控'), headlineHit: (t.match(/[^\n]*不在当前环境筛选里[^\n]*/g) || [])[0] || null, hasButton: t.includes('看这些环境') };
  });
  log('挡住时：', JSON.stringify(facts.filteredOut));
  const reveal = page.locator('button:has-text("看这些环境")').first();
  if (await reveal.count()) {
    await click(reveal, '看这些环境');
    await page.waitForTimeout(2500);
    await shot('H4-revealed');
    facts.revealed = await page.evaluate(() => ({
      cardCount: [...document.querySelectorAll('button')].filter(b => /窗口内|环境都通过判据|没读到样本/.test(b.innerText || '')).length,
      headline: (document.body.innerText.match(/[^\n]*项业务在[^\n]*/g) || [])[0] || null,
    }));
    facts.revealClicks = clicks;
    log('一键切换后：', JSON.stringify(facts.revealed));
  } else { facts.revealed = { error: '没有「看这些环境」按钮' }; }
}

// ---- 白天主题（真实切换按钮）----
const themeBtn = page.locator('button:has-text("黑天"), button:has-text("白天")').first();
if (await themeBtn.count()) { await themeBtn.click(); await page.waitForTimeout(1500); await shot('H5-light-theme'); }

fs.writeFileSync(`${OUT}/verify-facts.json`, JSON.stringify(facts, null, 2));
await browser.close();
