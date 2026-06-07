// CDS Agent 验收 driver — 取证本分支已部署的 UX 修复（前端 + MAP 自动部署层）
// 运行: node cds-agent-driver.mjs <预览域名>
import {
  loadConfig, launch, login, gotoByClick, click, type, shot, writeManifest,
} from './harness.mjs';

const CFG_PATH = new URL('../acceptance.config.json', import.meta.url).pathname;
const cfg = loadConfig(CFG_PATH);
const BASE = process.argv[2];
const OUT = cfg.screenshot.outDir;
if (!BASE) { console.error('用法: node cds-agent-driver.mjs <预览域名>'); process.exit(1); }

const { browser, page } = await launch(cfg);
const notes = [];
try {
  await login(page, BASE, cfg);
  await shot(page, OUT, '01-after-login', '登录后落地首页');

  // 进百宝箱（CDS Agent 是 wip 工具，挂在百宝箱）
  let nav = await gotoByClick(page, '百宝箱');
  if (!nav.found) nav = await gotoByClick(page, '工具箱');
  await shot(page, OUT, '02-toolbox', '百宝箱页（CDS Agent 入口所在）');
  notes.push(`toolbox-entry-found=${nav.found}`);

  // 点 CDS Agent
  let enter = await gotoByClick(page, 'CDS Agent');
  if (!enter.found) {
    // 兜底直达（记录为导航缺口）
    notes.push('nav-gap: 百宝箱内点不到 CDS Agent，回退 goto /cds-agent');
    await page.goto(BASE.replace(/\/+$/, '') + '/cds-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(1500);
  await shot(page, OUT, '03-cds-agent-landing', 'CDS Agent 落地：空状态/引导 + 干净输入区（验收 #1 输入框、#12 极简、#13 模型选择器）');

  // 取证输入区：是否有清晰输入框 + 模型选择器，且无一堆杂物
  const probe = await page.evaluate(() => {
    const txt = document.querySelector('textarea');
    const hasModelPicker = !!Array.from(document.querySelectorAll('button,select,[role=button]'))
      .find(el => /模型|model|deepseek|claude|gpt/i.test(el.textContent || ''));
    // 噪音气泡：检查是否有"后台状态/dispatching run/传输内幕"等内部日志直接渲染在对话流
    const noise = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0)
      .some(el => /dispatching run|后台状态|transport|cds-session-transport|operator-debug/i.test(el.textContent || ''));
    return {
      hasTextarea: !!txt,
      textareaPlaceholder: txt ? (txt.getAttribute('placeholder') || '') : null,
      hasModelPicker,
      hasNoiseBubble: noise,
    };
  });
  notes.push(`probe=${JSON.stringify(probe)}`);
  console.log('PROBE', JSON.stringify(probe));

  // 在输入框打字（验证可输入 + 自动聚焦），不一定发送（发送依赖共享边车）
  if (probe.hasTextarea) {
    await type(page, 'textarea', '你好，请用一句话介绍你自己');
    await shot(page, OUT, '04-typed', '输入框可正常输入文本（验收 #1 真输入框 + #7 自动聚焦）');
  }

  writeManifest(OUT);
  console.log('NOTES', JSON.stringify(notes));
  console.log('取证完成 ->', OUT);
} catch (e) {
  console.error('DRIVER_ERROR', e.message);
  try { await shot(page, OUT, '99-error', '出错时的页面状态: ' + e.message); } catch {}
  writeManifest(OUT);
  process.exitCode = 2;
} finally {
  await browser.close();
}
