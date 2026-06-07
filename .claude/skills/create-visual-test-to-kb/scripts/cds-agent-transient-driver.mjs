// 高频取证：发送后每 100ms 采样 DOM，专门逮「消息闪一下消失/空状态回闪/诊断卡」的瞬时中间态。
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots4';
const UNIQUE = `瞬时态验证-${Date.now()}`;
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  // 验证脚本直达 /cds-agent(百宝箱卡片是 div 非 a/button，gotoByClick 点不到;正式验收才走点击导航)。
  await page.goto(BASE.replace(/\/+$/, '') + '/cds-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // 图1 取证：刷新落地态是否还卡「请先同步系统主模型」
  const landing = await page.evaluate(() => ({
    syncWarning: /请先同步系统主模型/.test(document.body.innerText),
  }));
  console.log('LANDING', JSON.stringify(landing));
  await shot(page, OUT, '01-landing', '刷新落地：是否还卡「请先同步系统主模型」');

  // 不点「+」(易 disabled/触发新建态),直接用落地会话。fill 自动等待可见可编辑,无需单独 click。
  const ta = page.locator('textarea').first();
  await ta.fill(UNIQUE, { timeout: 15000 });
  const filled = await ta.inputValue();
  console.log('FILLED_OK', filled === UNIQUE, JSON.stringify(filled.slice(0, 40)));

  // 发送前快照(应为空状态 emptyHeading=true,或刚建会话的空对话)
  const pre = await page.evaluate((u) => ({
    emptyHeading: /想让 Agent 做什么|要在这个仓库里检查什么/.test(document.body.innerText),
    userBubble: document.body.innerText.includes(u),
  }), UNIQUE);
  console.log('PRE_SEND', JSON.stringify(pre));

  // 回车发送，随后高频采样 30 次 × 100ms
  await ta.press('Enter');
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const s = await page.evaluate((u) => {
      const txt = document.body.innerText;
      return {
        emptyHeading: /想让 Agent 做什么|要在这个仓库里检查什么/.test(txt),
        userBubble: txt.includes(u),
        sendingCard: /正在发送任务|等待 CDS runtime 接受 prompt/.test(txt),
      };
    }, UNIQUE);
    samples.push({ t: i * 100, ...s });
    await page.waitForTimeout(100);
  }
  // 第一次出现用户气泡的时刻；出现后是否曾经丢失(=闪屏)
  const firstBubbleIdx = samples.findIndex((s) => s.userBubble);
  const lostAfterAppear = firstBubbleIdx >= 0
    ? samples.slice(firstBubbleIdx).filter((s) => !s.userBubble).length
    : -1;
  const flashedEmptyAfterBubble = firstBubbleIdx >= 0
    ? samples.slice(firstBubbleIdx).filter((s) => s.emptyHeading).length
    : samples.filter((s) => s.emptyHeading).length;
  console.log('VERDICT', JSON.stringify({
    firstBubbleAt_ms: firstBubbleIdx >= 0 ? firstBubbleIdx * 100 : 'never',
    lostBubbleAfterAppear: lostAfterAppear,        // 期望 0 = 出现后没再消失(无闪屏)
    flashedEmptyAfterBubble,                        // 期望 0 = 气泡出现后无空状态回闪
    everShowedSendingCard: samples.filter((s) => s.sendingCard).length, // 期望 0
  }));
  await shot(page, OUT, '02-after-send-3s', '发送后约3s：用户气泡应全程在场，无空状态回闪/诊断卡');
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
