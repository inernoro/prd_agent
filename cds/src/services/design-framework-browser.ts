import { createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import { designViewports, type DesignFrameworkMeasurement, type DesignScreen, type DesignTheme } from '../shared/design-workspace.js';
import type { DesignFrameworkProbe } from './design-framework-check.js';
import { decorateDesignPrototype, designPrototypeCsp } from './design-prototype.js';
import { rejectPlanning } from './engineering-planning-input.js';

const prototypeOrigin = 'https://cds-design-prototype.invalid';
const pageTimeout = 3500;

async function measure(browser: Browser, html: string, screen: DesignScreen, theme: DesignTheme): Promise<DesignFrameworkMeasurement | undefined> {
  const entry = new URL('/prototype', prototypeOrigin);
  entry.searchParams.set('theme', theme);
  const target = new URL(entry);
  target.hash = screen.route;
  const context = await browser.newContext({
    viewport: designViewports.phone, hasTouch: true, colorScheme: theme, offline: true, serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    let served = false;
    await context.route('**/*', async route => {
      const request = route.request();
      if (served || request.method() !== 'GET' || request.url() !== entry.href
        || !request.isNavigationRequest() || request.frame() !== page.mainFrame()) return route.abort();
      served = true;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html,
        headers: { 'Content-Security-Policy': designPrototypeCsp, 'X-Content-Type-Options': 'nosniff' } });
    });
    await page.goto(target.href, { timeout: pageTimeout, waitUntil: 'load' });
    if (screen.readySelector) await page.locator(`css=${screen.readySelector}`).first().waitFor({ state: 'visible', timeout: pageTimeout });
    await page.waitForFunction(() => document.body && document.fonts.status === 'loaded'
      && ![...document.querySelectorAll('[data-content-loading], [aria-busy="true"]')].some(element =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'), undefined, { timeout: pageTimeout });
    if (!served || page.url() !== target.href) return undefined;
    const session = await context.newCDPSession(page);
    const geometry = await session.send('Page.getLayoutMetrics');
    const width = geometry.cssLayoutViewport.clientWidth;
    const contentWidth = Math.max(width, Math.ceil(geometry.cssContentSize.width));
    return { screenId: screen.id, slot: `phone-${theme}`, width, contentWidth };
  } catch {
    return undefined;
  } finally {
    await context.close();
  }
}

async function measurePrototype(browserPath: string, prototype: Buffer, screens: DesignScreen[]) {
  let browser: Browser | undefined;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ executablePath: browserPath, chromiumSandbox: true, timeout: 5000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      args: ['--disable-background-networking', '--no-proxy-server'] });
    const html = decorateDesignPrototype(prototype.toString('utf8'));
    const deadline = Date.now() + 25_000;
    const measurements: DesignFrameworkMeasurement[] = [];
    for (const screen of screens) {
      for (const theme of screen.themes) {
        if (Date.now() >= deadline) return measurements;
        const measurement = await measure(browser, html, screen, theme);
        if (measurement) measurements.push(measurement);
      }
    }
    return measurements;
  } catch {
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function createDesignFrameworkBrowser(executablePath?: string): DesignFrameworkProbe | undefined {
  const browserPath = executablePath?.trim();
  if (!browserPath) return undefined;
  let active: { fingerprint: string; result: Promise<DesignFrameworkMeasurement[]> } | undefined;
  return (prototype, screens) => {
    const fingerprint = createHash('sha256').update(prototype).update('\0').update(JSON.stringify(screens)).digest('hex');
    if (active) {
      if (active.fingerprint === fingerprint) return active.result;
      return rejectPlanning(503, 'design_probe_busy', '正在检查另一份稿件，请稍候并沿用原请求编号发布。');
    }
    const result = measurePrototype(browserPath, prototype, screens).finally(() => { active = undefined; });
    active = { fingerprint, result };
    return result;
  };
}
