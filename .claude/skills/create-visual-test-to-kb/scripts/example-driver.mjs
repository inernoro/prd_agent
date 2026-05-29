// MAP 验收 · 取证 driver 示例骨架（复制本文件改成你本次验收的真人路径）
//
// 运行：
//   export PWPATH=$(npm root -g)/playwright
//   export MAP_AI_USER=inernoro MAP_ACCEPT_PASS='***'
//   node example-driver.mjs "<预览域名，如 https://xxx.miduo.org>"
//
// 产出：/tmp/acc_shots/*.png + /tmp/acc_shots/manifest.json（喂给 archive_report.py）
//
// 三条铁律（见 reference/standard-v2.md §4）：
//   1. 登录后用 gotoByClick(可见文本) 点击导航进入 app 内页，禁止 page.goto 直达内页
//      （goto 只许用于登录页 + 外部分享/深链）。点不到入口 = 记一条 P1 缺陷。
//   2. 每个关键步骤 shot(...)，caption 写"这张证明了什么"。
//   3. 跨用户前置（造数据/造分享链等）走 API，不在浏览器里硬凑。

import {
  loadConfig, launch, login, gotoByClick, click, type, setTheme, shot, writeManifest,
} from './harness.mjs';

const CFG_PATH = new URL('../acceptance.config.json', import.meta.url).pathname;
const cfg = loadConfig(CFG_PATH);
const BASE = process.argv[2];                 // 预览域名（必传）
const OUT = cfg.screenshot.outDir;            // 截图输出目录
if (!BASE) { console.error('用法: node example-driver.mjs <预览域名>'); process.exit(1); }

const { browser, page } = await launch(cfg);
try {
  // === 1. 登录（表单，不注入 token）===
  await login(page, BASE, cfg);
  await shot(page, OUT, '01-after-login', '登录后落地首页');

  // === 2. 点击导航进入目标页（核心：模拟人类，非地址栏直达）===
  const nav = await gotoByClick(page, '知识库');     // 改成你的目标菜单文本
  if (!nav.found) {
    console.log('!! 缺陷 P1：从导航点不到目标入口（未进菜单?）—— 这是 goto 直达测不出的真问题');
  }
  await shot(page, OUT, '02-target-page', '经侧边栏点击进入目标页（非地址栏直达），验证入口在导航里');

  // === 3. 执行核心操作（按你的功能改）===
  // const r = await click(page, '某按钮');
  // await type(page, 'input[name=xxx]', '内容');
  // await shot(page, OUT, '03-after-action', '执行核心动作后：断言区（toast/卡片/页签激活态）清晰入镜');

  // === 4. 双主题（仅当目标页支持亮色主题；prd-admin 多数页暗色 only，见 config._dualThemeNote）===
  // await setTheme(page, 'light', cfg);
  // await shot(page, OUT, '04-light', '亮色主题核查');
  // await setTheme(page, 'dark', cfg);

  // === 5. 写清单（必做，archive 脚本要读）===
  writeManifest(OUT);
  console.log('取证完成 ->', OUT);
} finally {
  await browser.close();
}
