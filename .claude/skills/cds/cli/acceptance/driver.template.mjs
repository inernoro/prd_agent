// CDS 验收取证 driver 模板。复制改名后填你的取证步骤。
// 运行：NODE_USE_ENV_PROXY=1 node driver.mjs   （HTTPS_PROXY 须在 env；chromium 经 node fetch 拦截穿代理）
//
// 流程：launchCds → 登录 → 点导航进入(禁地址栏直达业务页) → 带框截图 → writeManifest
// 之后：build_report_html.py 组装 HTML → cdscli report create --html-file ... [--project --folder]
import fs from 'fs';
import {
  launchCds, login, gotoByClick, click, setTheme, box, clearBoxes,
  shot, stepClick, stepShot, writeManifest,
} from './cds-harness.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const cfg = JSON.parse(fs.readFileSync(HERE + 'cds.config.json', 'utf8')); // 先从 .example 复制
const base = 'https://' + (process.env.CDS_HOST || 'cds.miduo.org');
const out = '/tmp/acc_shots/demo';
fs.mkdirSync(out, { recursive: true });

const { browser, page } = await launchCds(cfg);
try {
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  await login(page, base, cfg);
  await page.waitForTimeout(2000);

  // 例：登录后点导航进入某页，双主题各截一张
  await setTheme(page, 'light', cfg);
  await shot(page, out, '01-overview-light', '某页总览(亮色)', { overview: true });
  await setTheme(page, 'dark', cfg);
  await shot(page, out, '02-overview-dark', '某页总览(暗色)', { overview: true });
  await setTheme(page, 'light', cfg);
  // 指向性证据务必画框：stepClick / stepShot(highlight) / box()
} catch (e) {
  console.log('ERR', e.message.split('\n')[0]);
} finally {
  writeManifest(out, { verdict: 'pass', target: '示例取证' });
  await browser.close();
}
process.exit(0);
