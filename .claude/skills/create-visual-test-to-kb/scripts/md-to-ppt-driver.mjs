// 联调验收: MD→网页PPT 端到端(文本→生成→客户端预览→发布到托管→拿站点URL)
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_ppt';
const { browser, page } = await launch(cfg);
const MD = '# 产品介绍\n\n- 价值主张：更快交付\n- 核心能力：AI 辅助\n\n---\n\n# 路线图\n\n- Q1 上线\n- Q2 扩展\n\n---\n\n# 总结\n\n- 一句话收尾';
let renderErr = false;
page.on('response', (r) => { if (r.url().includes('/api/md-to-ppt/render') && r.status() >= 400) renderErr = true; });
try {
  await login(page, BASE, cfg);
  let nav = await gotoByClick(page, '百宝箱').catch(() => ({found:false}));
  let entered = await gotoByClick(page, 'Markdown 转网页 PPT').catch(() => ({found:false}));
  const reachedByClick = entered.found;
  if (!reachedByClick) await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, OUT, '01-landing', '落地(三通道输入)');
  await page.locator('textarea').first().fill(MD);
  await page.locator('button:has-text("生成")').first().click({ timeout: 8000 }).catch((e)=>console.log('GEN_ERR',e.message));
  // 等生成完成(出现幻灯片编辑器条目)
  let generated = false;
  for (let i=0;i<45;i++){ await page.waitForTimeout(2000); if (await page.evaluate(()=>/产品介绍|路线图|价值主张/.test(document.body.innerText))) { generated = true; break; } }
  await page.waitForTimeout(2500); // 等客户端渲染 + iframe reveal.js
  await shot(page, OUT, '02-preview', '生成后:右侧 reveal.js 预览应渲染(客户端,无 render 400)');
  const hasIframe = await page.evaluate(()=>!!document.querySelector('iframe[title*="预览"], iframe'));
  // 发布
  let publishedUrl = '';
  const pubBtn = page.locator('button:has-text("一键发布到网页托管")').first();
  if (await pubBtn.count()) {
    await pubBtn.click({ timeout: 8000 }).catch((e)=>console.log('PUB_ERR',e.message));
    for (let i=0;i<20;i++){ await page.waitForTimeout(2000); publishedUrl = await page.evaluate(()=>{const a=Array.from(document.querySelectorAll('a')).find(a=>/miduo\.org/.test(a.href)&&!/x6rck/.test(a.href)); return a?a.href:'';}); const pe=await page.evaluate(()=>/发布失败/.test(document.body.innerText)); if (publishedUrl||pe) break; }
  }
  await shot(page, OUT, '03-published', '发布后:应出现托管站点链接');
  console.log('PPT_E2E', JSON.stringify({ reachedByClick, generated, hasIframe, renderErr, publishedUrl }));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try { await shot(page, OUT, '99-err', e.message); } catch {} }
finally { await browser.close(); }
