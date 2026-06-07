// 发送并捕获流式 → 验证 P3(markdown不硬切)/P4(右栏文案)/P5(等待文案)
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots3';
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  let nav = await gotoByClick(page, '百宝箱'); if (!nav.found) nav = await gotoByClick(page, '工具箱');
  await gotoByClick(page, 'CDS Agent');
  await page.waitForTimeout(1500);
  // 新建一个干净会话(点 + )以便看到完整空状态→发送过程
  const plus = page.locator('button:has(svg)').filter({ hasText: '' });
  // 直接在底部输入框打字并发送
  const ta = page.locator('textarea').first();
  await ta.click();
  await ta.fill('用三句话介绍你自己，每句话用 markdown 加粗开头词');
  await shot(page, OUT, '01-before-send', '发送前：输入框在底部(空状态也在底部，无跳变)');
  // 点发送
  await page.locator('button:has-text("发送")').first().click();
  await page.waitForTimeout(2500);
  await shot(page, OUT, '02-just-sent', '发送后~2.5s：用户气泡应立即上屏，输入框仍在底部不跳，等待文案=正在生成回复');
  await page.waitForTimeout(6000);
  await shot(page, OUT, '03-streaming-or-done', '约8.5s：流式中/完成，检查 markdown 渲染与右栏文案');
  await page.waitForTimeout(8000);
  await shot(page, OUT, '04-final', '最终：markdown 已渲染(无裸**)，右栏「结果可复盘=回复已生成」无原始事件数');
  // 取证右栏文案 + 是否有裸 markdown 残留
  const probe = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      rightPanelHasRawEventCount: /\d+\s*个事件\s*\/\s*\d+\s*条消息/.test(txt),
      rightPanelReplyGenerated: txt.includes('回复已生成'),
      bodyHasRawDoubleAsterisk: /\*\*[^*\n]{1,20}\*\*/.test(txt),
      waitingCopyScary: txt.includes('推理模型首字可能较慢'),
    };
  });
  console.log('PROBE3', JSON.stringify(probe));
  writeManifest(OUT);
  console.log('done ->', OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
