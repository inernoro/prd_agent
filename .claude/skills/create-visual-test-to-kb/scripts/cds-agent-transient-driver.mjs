// 高频取证：发送后每 100ms 采样 DOM，专门逮「消息闪一下消失/空状态回闪」的瞬时中间态。
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots4';
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  let nav = await gotoByClick(page, '百宝箱'); if (!nav.found) nav = await gotoByClick(page, '工具箱');
  await gotoByClick(page, 'CDS Agent');
  await page.waitForTimeout(1500);

  // 图1 取证：刷新落地态(是否还卡「请先同步系统主模型」三连)
  const landing = await page.evaluate(() => ({
    syncWarning: /请先同步系统主模型/.test(document.body.innerText),
    modelPickerText: (Array.from(document.querySelectorAll('button,[role=button]'))
      .map(e => e.textContent || '').find(t => /deepseek|claude|gpt|模型\s*·/i.test(t)) || '').trim().slice(0,40),
  }));
  console.log('LANDING', JSON.stringify(landing));
  await shot(page, OUT, '01-landing', '刷新落地：是否还卡「请先同步系统主模型」');

  // 新建任务，走「新建会话」路径(最易触发发送闪屏)
  const plusBtn = page.locator('button[title*="新"], button:has-text("新建"), [aria-label*="新"]').first();
  // 直接在底部输入框打字
  const ta = page.locator('textarea').first();
  await ta.click();
  await ta.fill('用一句话告诉我现在几点的概念');

  // 点发送后立即高频采样 DOM 30 次 × 100ms = 3s
  const samples = [];
  await page.locator('button:has-text("发送"), button:has-text("运行")').first().click();
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate(() => {
      const txt = document.body.innerText;
      // 对话主区：是否显示空状态引导标题
      const emptyHeading = /想让 Agent 做什么|要在这个仓库里检查什么/.test(txt);
      // 用户气泡是否在场（我们刚发的内容）
      const userBubble = txt.includes('用一句话告诉我现在几点的概念');
      const sendingCard = /正在发送任务|等待 CDS runtime 接受 prompt/.test(txt);
      return { emptyHeading, userBubble, sendingCard };
    });
    samples.push({ t: i * 100, ...s });
    await page.waitForTimeout(100);
  }
  // 分析：发送后是否出现「空状态回闪」或「用户气泡消失」
  const flashEmpty = samples.filter(s => s.emptyHeading);
  const lostBubble = samples.filter(s => !s.userBubble);
  const sawSendingCard = samples.filter(s => s.sendingCard);
  console.log('SAMPLES', JSON.stringify(samples));
  console.log('VERDICT', JSON.stringify({
    everFlashedEmptyAfterSend: flashEmpty.length,
    everLostUserBubble: lostBubble.length,
    everShowedSendingCard: sawSendingCard.length,
    totalSamples: samples.length,
  }));
  await shot(page, OUT, '02-after-send-3s', '发送后约3s：用户气泡应全程在场，无空状态回闪');
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
