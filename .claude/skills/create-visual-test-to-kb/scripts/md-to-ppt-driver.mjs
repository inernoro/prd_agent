// 联调验收:Markdown→网页PPT 智能体(文本输入→生成→预览→发布UI) + 顺带验 CDS Agent 知识库选择器
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_ppt';
const { browser, page } = await launch(cfg);
const MD = '# 产品介绍\n\n- 第一点：价值主张\n- 第二点：核心能力\n\n---\n\n# 路线图\n\n- Q1 上线\n- Q2 扩展';
try {
  await login(page, BASE, cfg);
  // 先试点击导航进入(百宝箱→PPT),点不到则直达(验收脚本可直达,正式归档走点击)
  let nav = await gotoByClick(page, '百宝箱').catch(() => ({ found: false }));
  let entered = await gotoByClick(page, 'Markdown 转网页 PPT').catch(() => ({ found: false }));
  if (!entered.found) entered = await gotoByClick(page, 'PPT').catch(() => ({ found: false }));
  const reachedByClick = entered.found;
  if (!reachedByClick) { await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  await page.waitForTimeout(2000);
  await shot(page, OUT, '01-landing', 'MD转PPT 落地(空状态/引导 + 三通道输入)');

  const landing = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      hasTextInput: !!document.querySelector('textarea'),
      hasKbChannel: /知识库/.test(txt),
      hasFileChannel: /上传文件|上传内容/.test(txt),
      hasGenerate: /生成/.test(txt),
      hasPublish: /发布到网页托管/.test(txt),
    };
  });
  console.log('PPT_LANDING', JSON.stringify({ reachedByClick, ...landing }));

  // 输入 markdown 文本到主输入框
  const ta = page.locator('textarea').first();
  await ta.fill(MD, { timeout: 15000 });
  await shot(page, OUT, '02-text-filled', '文本通道:粘贴 markdown');
  // 点生成
  const genBtn = page.locator('button:has-text("生成")').first();
  await genBtn.click({ timeout: 8000 }).catch((e) => console.log('GEN_CLICK_ERR', e.message));
  // 等生成(LLM 流式),最多 90s,出现幻灯片/section/预览
  let generated = false;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const g = await page.evaluate(() => {
      const txt = document.body.innerText;
      return /产品介绍|路线图|价值主张|核心能力/.test(txt) || document.querySelectorAll('section, .reveal, [class*="slide"]').length > 0;
    });
    if (g) { generated = true; break; }
    const err = await page.evaluate(() => /生成失败|失败/.test(document.body.innerText));
    if (err) { console.log('GEN_REPORTED_FAIL'); break; }
  }
  await shot(page, OUT, '03-generated', '生成后:幻灯片预览应出现');
  const after = await page.evaluate(() => ({
    publishBtnPresent: !!Array.from(document.querySelectorAll('button')).find(b => /发布到网页托管/.test(b.textContent||'')),
    slideish: document.querySelectorAll('section, .reveal, [class*="slide"]').length,
  }));
  console.log('PPT_VERDICT', JSON.stringify({ generated, ...after }));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
