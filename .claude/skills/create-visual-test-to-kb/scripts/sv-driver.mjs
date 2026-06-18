// 短视频解析（链接转文案）全链路视觉验收 driver
// 真人路径：登录 → 知识库 → 进入「短视频素材库」→ + → 解析短视频 → 粘贴链接 → 观察阶段 → 闭环取证
import {
  loadConfig, launch, login, gotoByClick, shot, writeManifest,
} from './harness.mjs';

const CFG_PATH = new URL('../acceptance.config.json', import.meta.url).pathname;
const cfg = loadConfig(CFG_PATH);
const BASE = process.argv[2];
const LINK = process.argv[3] || 'https://v.douyin.com/U0M7XB_qgL0/';
const OUT = cfg.screenshot.outDir;
if (!BASE) { console.error('用法: node sv-driver.mjs <预览域名> [链接]'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { browser, page } = await launch(cfg);
try {
  // 1. 登录
  await login(page, BASE, cfg);
  await shot(page, OUT, '01-after-login', '表单登录后落地首页（非 token 注入）');

  // 2. 点击导航进入知识库（模拟人类，非地址栏直达）
  const nav = await gotoByClick(page, '知识库');
  console.log('nav 知识库:', JSON.stringify(nav));
  await sleep(2500);
  await shot(page, OUT, '02-kb-list', '经导航进入知识库列表');

  // 3. 进入「短视频素材库」(API 跑批已自动创建并存入两条视频)
  const enter = await gotoByClick(page, '短视频素材库', { timeout: 10000 });
  console.log('enter store:', JSON.stringify(enter));
  await sleep(2500);
  await shot(page, OUT, '03-store-entries', '进入短视频素材库：左栏已有解析入库的原始视频条目（source 阶段闭环证据）');

  // 4. 打开「+」新建菜单 → 解析短视频
  const plus = page.locator('button[title="新建"]').first();
  await plus.waitFor({ state: 'visible', timeout: 8000 });
  await plus.click();
  await sleep(800);
  await shot(page, OUT, '04-add-menu', '「+」菜单出现「解析短视频」入口');

  const svItem = page.locator('button:has-text("解析短视频")').first();
  await svItem.waitFor({ state: 'visible', timeout: 6000 });
  await svItem.click();
  await sleep(1500);
  await shot(page, OUT, '05-sv-drawer', '短视频解析抽屉打开：说明默认先入库视频再转写');

  // 5. 粘贴链接并发送
  const ta = page.locator('textarea[placeholder*="短视频链接"], textarea[placeholder*="粘贴抖音"]').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.fill(LINK);
  await sleep(500);
  await shot(page, OUT, '06-link-filled', `已粘贴链接：${LINK}`);
  await ta.press('Enter');
  await sleep(3000);
  await shot(page, OUT, '07-submitted-running', '提交后：阶段进度开始推进（解析链接 / 保存原始视频 …）');

  // 6. 轮询过程截图（直到出现完成或失败态）
  const deadline = Date.now() + 180000; // 最多等 180s
  let n = 0;
  let terminal = false;
  while (Date.now() < deadline) {
    await sleep(12000);
    n++;
    await shot(page, OUT, `08-progress-${String(n).padStart(2,'0')}`, `处理中第 ${n} 次取证（约 ${n*12}s）`);
    const body = await page.locator('body').innerText().catch(() => '');
    if (/转写失败|失败|未返回|调度失败/.test(body)) { terminal = true; console.log('detected failure text'); break; }
    if (/准备继续加工|视频已入库|打开视频|打开原始文字/.test(body) && /done|完成|失败/.test(body)) { /* maybe done */ }
    if (n >= 10) break;
  }
  await sleep(1500);
  await shot(page, OUT, '09-final-state', terminal ? '终态：转写阶段失败可见（链接转文案核心环节未产出文字）' : '终态截图');

  // 7. 全文截图兜底：抓 drawer 全文供报告引用
  const finalText = await page.locator('body').innerText().catch(() => '');
  console.log('=== FINAL BODY TEXT (trimmed) ===');
  console.log(finalText.split('\n').filter(l => l.trim()).slice(0, 80).join('\n'));

  writeManifest(OUT);
  console.log('取证完成 ->', OUT);
} catch (e) {
  console.error('DRIVER ERROR:', e.message);
  await shot(page, OUT, '99-error', '驱动异常时的页面状态').catch(()=>{});
  writeManifest(OUT);
} finally {
  await browser.close();
}
