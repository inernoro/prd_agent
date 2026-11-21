import { createHash } from 'node:crypto';
import type { Browser, CDPSession } from 'playwright';
import { designViewports, type DesignFrameworkMeasurement, type DesignNestedScroll, type DesignScreen, type DesignTheme } from '../shared/design-workspace.js';
import type { DesignFrameworkProbe } from './design-framework-check.js';
import { decorateDesignPrototype, designPrototypeCsp } from './design-prototype.js';
import { rejectPlanning } from './engineering-planning-input.js';

const prototypeOrigin = 'https://cds-design-prototype.invalid';
const pageTimeout = 3500;

const nestedScrollExpression = `(() => {
  const controls = 'nav, form, button, input, select, textarea, a[href], [role="navigation"], [role="toolbar"], [role="tablist"], [role="menu"]';
  const exceptions = 'table, pre, code, [role="table"], [role="grid"], [role="treegrid"], [role="code"]';
  const chart = '[data-chart], .chart';
  const graphic = 'canvas, svg[viewBox]:not([aria-hidden="true"])';

  function protrudes(element, region, bounds) {
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible') return false;
    const box = element.getBoundingClientRect();
    const extra = style.overflowX === 'visible' ? Math.max(0, element.scrollWidth - element.clientWidth) : 0;
    return getComputedStyle(region).direction === 'rtl'
      ? box.left + region.scrollLeft - extra < bounds - 0.5
      : box.right + region.scrollLeft + extra > bounds + region.clientWidth + 0.5;
  }

  function classify(region) {
    const bounds = region.getBoundingClientRect().left + region.clientLeft;
    let owner = region;
    let markedChart = false;
    while (owner) {
      if (owner.matches(controls)) return 'failed';
      if (owner.matches(exceptions)
        || (owner.matches('.code') && getComputedStyle(owner).whiteSpace === 'pre' && !owner.querySelector(controls))) return 'passed';
      markedChart ||= owner.matches(chart);
      if (owner.matches(graphic)) return markedChart ? 'passed' : 'unverified';
      const parts = Array.from(owner.children).filter(child => protrudes(child, region, bounds));
      // Display:contents or an unstructured mixed region may need a reviewer to identify its purpose.
      if (parts.length !== 1 || Array.from(owner.childNodes).some(node => node.nodeType === 3 && node.textContent.trim())) break;
      owner = parts[0];
    }
    for (const control of region.querySelectorAll(controls)) {
      const exception = control.closest(exceptions);
      if ((!exception || !region.contains(exception)) && protrudes(control, region, bounds)) return 'failed';
    }
    return markedChart || region.querySelector(exceptions + ', ' + chart + ', ' + graphic + ', .code') ? 'unverified' : 'failed';
  }

  const roots = [document];
  let uncertain;
  for (const root of roots) {
    for (const region of root.querySelectorAll('*')) {
      if (region.shadowRoot) roots.push(region.shadowRoot);
      if (region === document.scrollingElement || region === document.documentElement) continue;
      const width = region.clientWidth, contentWidth = region.scrollWidth;
      if (width <= 0 || contentWidth <= width || !region.getClientRects().length) continue;
      const style = getComputedStyle(region);
      if (!['auto', 'scroll'].includes(style.overflowX) || style.visibility !== 'visible') continue;
      const status = classify(region);
      if (status === 'passed') continue;
      const tag = region.localName;
      const element = /^(main|body|header|footer|section|article|aside|div|figure|nav|form|ul|ol|p|span|canvas|svg)$/.test(tag) ? tag : '内部';
      const result = { status, element, width, contentWidth };
      if (status === 'failed') return result;
      uncertain ??= result;
    }
  }
  return uncertain ?? { status: 'passed' };
})()`;

async function measureNestedScroll(session: CDPSession): Promise<DesignNestedScroll | undefined> {
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'cds-framework-metrics' });
    // The prototype may run scripts. Read layout from a separate world with native DOM getters.
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: nestedScrollExpression, contextId: executionContextId, returnByValue: true, timeout: 1500,
    });
    return exceptionDetails ? undefined : result.value as DesignNestedScroll | undefined;
  } catch {
    return undefined;
  }
}

async function measure(browser: Browser, html: string, screen: DesignScreen, theme: DesignTheme,
  checkNestedScroll: boolean): Promise<DesignFrameworkMeasurement | undefined> {
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
    const nestedScroll = checkNestedScroll && width === designViewports.phone.width && contentWidth === width
      ? await measureNestedScroll(session) : undefined;
    if (page.url() !== target.href) return undefined;
    return { screenId: screen.id, slot: `phone-${theme}`, width, contentWidth, ...(nestedScroll ? { nestedScroll } : {}) };
  } catch {
    return undefined;
  } finally {
    await context.close();
  }
}

async function measurePrototype(browserPath: string, prototype: Buffer, screens: DesignScreen[], checkNestedScroll: boolean) {
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
        const measurement = await measure(browser, html, screen, theme, checkNestedScroll);
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
  return (prototype, screens, checkNestedScroll) => {
    const fingerprint = createHash('sha256').update(prototype).update('\0').update(JSON.stringify([screens, checkNestedScroll])).digest('hex');
    if (active) {
      if (active.fingerprint === fingerprint) return active.result;
      return rejectPlanning(503, 'design_probe_busy', '正在检查另一份稿件，请稍候并沿用原请求编号发布。');
    }
    const result = measurePrototype(browserPath, prototype, screens, checkNestedScroll).finally(() => { active = undefined; });
    active = { fingerprint, result };
    return result;
  };
}
