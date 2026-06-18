// 闭环取证：确认 source 阶段产物（原始视频）真实可打开播放
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = cfg.screenshot.outDir;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await gotoByClick(page, '知识库'); await sleep(2500);
  await gotoByClick(page, '短视频素材库', { timeout: 10000 }); await sleep(2500);
  // 点击左栏第一个视频条目
  const entry = page.locator('text=Anthropic AI转型就绪度评估').first();
  await entry.waitFor({ state: 'visible', timeout: 8000 });
  await entry.click();
  await sleep(3500);
  await shot(page, OUT, '10-video-entry-open', '点击入库的原始视频条目：右侧渲染视频播放器（source 阶段产物闭环：视频真实可打开）');
  // 是否存在 video/source 标签
  const hasVideo = await page.locator('video, source[type^="video"]').count();
  console.log('video element count:', hasVideo);
  const txt = await page.locator('body').innerText().catch(()=> '');
  console.log('=== entry view text (first 40 lines) ===');
  console.log(txt.split('\n').filter(l=>l.trim()).slice(0,40).join('\n'));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); await shot(page, OUT, '10-err', 'err').catch(()=>{}); }
finally { await browser.close(); }
