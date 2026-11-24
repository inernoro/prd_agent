/**
 * 取一个能用的 chromium，以及浏览器可执行文件路径。
 *
 * 为什么不直接 `require('playwright')`：`playwright` 这个包会连带下载浏览器二进制，
 * 在本仓库的容器里那一步要么很慢、要么被 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过，
 * 于是装完也没有浏览器可用。容器里真正现成的是 **`playwright-core` + 预装在
 * `/opt/pw-browsers` 的 chromium** —— 两者 API 一致，缺的只是「自己下浏览器」那部分，
 * 而那部分我们本来就不要。
 *
 * 所以顺序是：先试 `playwright-core`，再退回 `playwright`。两个都没有才报错，
 * 且要说清该装哪个 —— 而不是抛一句 `Cannot find module 'playwright'` 让人去装那个更重的。
 *
 * （scripts/smoke/daily-acceptance.mjs 早就是这么做的；这里之前没跟上，
 * 表现是 setup.sh 卡在 npm i 上不动。）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/** 依赖装在工作目录里、脚本住在技能目录里：必须从 cwd 解析 */
const requireFromCwd = createRequire(path.join(process.cwd(), 'noop.js'));

export function loadChromium() {
  for (const pkg of ['playwright-core', 'playwright']) {
    try {
      return requireFromCwd(pkg).chromium;
    } catch { /* 下一个 */ }
  }
  console.error('找不到 playwright-core（也没有 playwright）。在工作目录里装一个：');
  console.error('  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright-core --no-save');
  console.error('浏览器用容器预装的 /opt/pw-browsers，不需要再下载。');
  process.exit(2);
}

/**
 * 浏览器可执行文件。按目录名探测，不写死版本号——写死会在升级后静默退化成
 * 「用默认下载路径」，而那里根本没下载过，报出来是一句莫名其妙的 launch 失败。
 */
export function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (!fs.existsSync('/opt/pw-browsers')) return undefined;
  return fs.readdirSync('/opt/pw-browsers')
    .filter((d) => d.startsWith('chromium-'))
    .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)
    .find((p) => fs.existsSync(p));
}

/** 起浏览器。用 playwright-core 时必须显式给 executablePath，它自己不带浏览器。 */
export async function launch(opts = {}) {
  const chromium = loadChromium();
  const exe = chromePath();
  return chromium.launch(exe ? { executablePath: exe, ...opts } : opts);
}
