import { createRequire } from 'node:module';
import path from 'node:path';

function loadChromium() {
  const require = createRequire(path.resolve('package.json'));
  for (const source of [process.env.PWPATH, '/opt/node22/lib/node_modules/playwright', 'playwright']) {
    if (!source) continue;
    try { return require(source).chromium; } catch { /* Try the next installed Playwright. */ }
  }
  return undefined;
}

async function capture(browser, portal, cookie, shot, filename) {
  const target = new URL(shot.target);
  const entry = new URL(shot.entry);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || entry.origin !== target.origin) {
    return { reason: '预览入口与冻结的目标不同' };
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.hostname.endsWith('.localhost');
  const mobile = shot.viewport.width === 375;
  const context = await browser.newContext({ viewport: shot.viewport, colorScheme: shot.theme, deviceScaleFactor: 1,
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', ignoreHTTPSErrors: local });
  try {
    await context.addInitScript(theme => {
      if (window === window.top) try { localStorage.setItem('cds_theme', theme); } catch { /* Some preview origins do not expose storage. */ }
    }, shot.theme);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin === target.origin && (method === 'GET' || method === 'HEAD'
        || (url.pathname === '/api/auth/sso/exchange' && method === 'POST'))) {
        return route.continue();
      }
      if (cookie && url.origin === portal.origin && url.pathname === '/preview/authorize' && method === 'GET' && request.isNavigationRequest()) {
        try {
          // Fetch this hop only. Credentials are scoped to the parent CDS origin on every request.
          const response = await route.fetch({ headers: { ...request.headers(), cookie }, maxRedirects: 0, timeout: 8000 });
          return await route.fulfill({ response });
        } catch { return route.abort(); }
      }
      return route.abort();
    });
    const page = await context.newPage();
    const response = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!response || response.status() >= 400) return { reason: '预览入口未返回可访问的页面' };
    try { await page.waitForURL(target.href, { waitUntil: 'domcontentloaded', timeout: 8000 }); }
    catch { return { reason: '预览未返回到验收地址，请核对预览授权和实现地址' }; }
    try {
      await page.waitForLoadState('load', { timeout: 8000 });
      const scripted = shot.measure && await page.evaluate(() => [...document.scripts].some(script =>
        /^(?:module|(?:application|text)\/(?:java|ecma)script)?$/i.test(script.type)));
      const selector = shot.readySelector || (scripted ? '[data-cds-design-ready]' : undefined);
      if (selector) await page.locator(`css=${selector}`).first().waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForFunction(() => document.body && document.fonts.status === 'loaded'
        && ![...document.querySelectorAll('[data-content-loading], [aria-busy="true"]')].some(element =>
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'), undefined, { timeout: 8000 });
    } catch { return { reason: '验收画面尚未就绪，请核对加载状态和画面就绪标记' }; }
    const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    if ((actualTheme === 'dark' || actualTheme === 'light') && actualTheme !== shot.theme) return { reason: '预览没有切换到验收主题' };
    const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
      contentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) }));
    if (geometry.width !== shot.viewport.width || geometry.height !== shot.viewport.height) return { reason: '浏览器视口与声明的数据不符' };
    await page.screenshot({ path: filename, animations: 'disabled', scale: 'css', timeout: 6000 });
    return { captured: true, geometry };
  } catch { return { reason: '无法打开或截图，请回看预览状态' }; }
  finally { await context.close(); }
}

async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  const chromium = loadChromium();
  if (!chromium) return { error: '当前执行环境没有 Playwright 浏览器' };
  const portal = new URL(request.portal);
  const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH || undefined });
  try {
    const rows = [];
    for (const [index, shot] of request.shots.entries()) {
      const filename = path.join(request.directory, `screen-${index}.png`);
      rows.push(await capture(browser, portal, request.cookie, shot, filename));
    }
    return { rows };
  } finally { await browser.close(); }
}

main().then(result => process.stdout.write(JSON.stringify(result)),
  () => process.stdout.write(JSON.stringify({ error: '无法启动做法验收浏览器' })));
