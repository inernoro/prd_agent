// 验证 Codex 风改版：融合输入框 + 右栏可折叠 + 刷新加载态
import { loadConfig, launch, login, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots5';
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/, '') + '/cds-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 刷新加载态:立刻截一张(可能抓到 MapSectionLoader)
  await page.waitForTimeout(400);
  await shot(page, OUT, '01-boot', '刷新后首屏:应显示加载动画而非空白');
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, OUT, '02-input-default', '默认:融合输入框(模式/模型/发送一行)+右栏准备情况');

  // 折叠右栏
  const toggle = page.locator('button[aria-label*="右栏"], button[aria-label*="准备情况"]').first();
  const hadToggle = await toggle.count();
  if (hadToggle) { await toggle.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(800); }
  await shot(page, OUT, '03-panel-collapsed', '折叠右栏后:聊天主区占满宽度');

  const probe = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    // 输入框容器内是否同时含 模式按钮 + 发送(融合一行)
    const composer = ta ? ta.closest('div')?.parentElement : null;
    return {
      hasTextarea: !!ta,
      hint_present: /对话模式不要求仓库/.test(document.body.innerText), // 应已删除=false
      readinessVisible: /准备情况|运行进展/.test(document.body.innerText),
    };
  });
  console.log('PROBE5', JSON.stringify({ hadToggle: !!hadToggle, ...probe }));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
