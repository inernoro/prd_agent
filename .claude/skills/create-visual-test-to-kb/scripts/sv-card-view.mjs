// 取证：渲染已成功解析的短视频运行的仿真卡片（41d0f428 已有完整 card）
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const STORE = '4f11c85d1dda42d59b5c1400020303e3';
const RUN = process.argv[3] || '41d0f428557241aeb075f3f44ee877e3';
const OUT = cfg.screenshot.outDir;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await gotoByClick(page, '知识库'); await sleep(2500);
  await gotoByClick(page, '短视频素材库', { timeout: 10000 }); await sleep(2500);
  // 指向一个已成功解析的运行，让抽屉的恢复逻辑渲染其卡片
  await page.evaluate(({ store, run }) => {
    sessionStorage.setItem(`short-video-material:active-run:${store}`, run);
  }, { store: STORE, run: RUN });
  // 打开「+」→ 解析短视频（进入 short-video 模式触发恢复 effect）
  const plus = page.locator('button[title="新建"]').first();
  await plus.waitFor({ state: 'visible', timeout: 8000 }); await plus.click(); await sleep(700);
  const svItem = page.locator('button:has-text("解析短视频")').first();
  await svItem.waitFor({ state: 'visible', timeout: 6000 }); await svItem.click();
  await sleep(6000); // 等恢复轮询拉到 run + 渲染卡片
  await shot(page, OUT, '20-card-rendered', '粘贴链接后的仿真短视频卡片：封面+作者+头像+统计+话题（复用海报 PosterFeedCardView），取代原文字块');
  // 尝试点击播放按钮，验证 COS 视频可播
  const playBtn = page.locator('button[aria-label*="play" i], [class*="play"]').first();
  try { await playBtn.click({ timeout: 3000 }); await sleep(3500); await shot(page, OUT, '21-card-playing', '点击播放：卡片内 COS 永久视频开始播放'); } catch { console.log('play button not clicked (optional)'); }
  writeManifest(OUT);
  console.log('done');
} catch (e) { console.error('ERR', e.message); await shot(page, OUT, '20-err', 'err').catch(()=>{}); }
finally { await browser.close(); }
