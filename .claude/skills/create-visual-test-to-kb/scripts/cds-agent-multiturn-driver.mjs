// 验证会话生命周期修复:发送→回复→追问,历史应跨轮保留(同一会话复用,不新建、不超时)
import { loadConfig, launch, login, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots6';
const U1 = `多轮验证-第一问-${Date.now()}`;
const U2 = `多轮验证-第二问-${Date.now()}`;
const { browser, page } = await launch(cfg);
const waitForAssistant = async (afterText, timeoutMs = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate((u) => {
      const txt = document.body.innerText;
      // 用户气泡在场 + 出现了 Agent 回复(简单判据:有“Agent ·”时间戳且非“正在生成”)
      const hasUser = txt.includes(u);
      const generating = /正在生成回复|正在思考/.test(txt);
      const hasAgent = /Agent\s*·/.test(txt);
      return hasUser && hasAgent && !generating;
    }, afterText);
    if (done) return true;
    await page.waitForTimeout(2000);
  }
  return false;
};
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/, '') + '/cds-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  // 新建干净会话
  await page.locator('button[aria-label="新建任务"]').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const ta = page.locator('textarea').first();
  await ta.fill(U1, { timeout: 15000 });
  await ta.press('Enter');
  const r1 = await waitForAssistant(U1);
  await shot(page, OUT, '01-turn1-reply', '第一轮回复完成');
  // 回复后会话应转 idle:不应出现「正在生成」,且不应有刚冒出来的「已超时」
  const afterT1 = await page.evaluate((u1) => ({
    user1Visible: document.body.innerText.includes(u1),
    generating: /正在生成回复|正在思考/.test(document.body.innerText),
  }), U1);

  // 第二轮追问(同一会话)
  await ta.fill(U2, { timeout: 15000 });
  await ta.press('Enter');
  const r2 = await waitForAssistant(U2);
  await page.waitForTimeout(1500);
  await shot(page, OUT, '02-turn2-reply', '第二轮回复完成:两轮历史都应在场');

  const afterT2 = await page.evaluate(([u1, u2]) => ({
    user1StillVisible: document.body.innerText.includes(u1), // 关键:第一轮历史是否还在(修复前会消失)
    user2Visible: document.body.innerText.includes(u2),
  }), [U1, U2]);

  console.log('VERDICT6', JSON.stringify({
    turn1Replied: r1, turn2Replied: r2,
    afterT1, afterT2,
    HISTORY_PRESERVED: afterT2.user1StillVisible && afterT2.user2Visible,
  }));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
