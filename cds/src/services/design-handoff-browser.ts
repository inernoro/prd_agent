import type { Browser, Frame, Locator, Page } from 'playwright';
import type { DesignHandoffCase, DesignHandoffCaseResult, DesignHandoffStep } from '../shared/design-handoff.js';
import { designViewports, type DesignScreen } from '../shared/design-workspace.js';
import { decorateDesignPrototype, designPrototypeCsp } from './design-prototype.js';

export type DesignHandoffInput = { prototype: Buffer; screens: DesignScreen[]; cases: DesignHandoffCase[] };
export type DesignHandoffExecutor = (input: DesignHandoffInput) => Promise<DesignHandoffCaseResult[] | undefined>;
const origin = 'https://cds-design.invalid';
const host = origin + '/workspace';
const stepMs = 2000;
const nativeChecks = ['media-playing', 'audio-playing', 'fullscreen'];
type CheckStep = Extract<DesignHandoffStep, { action: 'expect' | 'remember' }>;

async function isolatedObservation(page: Page, frame: Frame) {
  const ownSession = await page.context().newCDPSession(frame).catch(() => undefined);
  const cdp = ownSession ?? await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const frameId = ownSession ? frameTree.frame.id : frameTree.childFrames?.find(row => row.frame.url === frame.url())?.frame.id;
  if (!frameId) throw new Error('Missing prototype frame');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'cds-handoff-observer' });
  const observe = (selector: string) => {
    const nodes = document.querySelectorAll(selector);
    const node = nodes.length === 1 ? nodes[0] : undefined;
    const media = node instanceof HTMLMediaElement ? node as HTMLMediaElement & { webkitAudioDecodedByteCount?: number } : undefined;
    return { time: media?.currentTime, playing: Boolean(media && !media.paused && !media.ended && media.readyState >= 2),
      audible: Boolean(media && !media.muted && media.volume > 0 && (media.webkitAudioDecodedByteCount ?? 0) > 0),
      fullscreenEnabled: document.fullscreenEnabled, fullscreen: Boolean(node && document.fullscreenElement === node) };
  };
  return async (selector: string): Promise<ReturnType<typeof observe>> => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { contextId: executionContextId,
      expression: `(${observe.toString()})(${JSON.stringify(selector)})`, returnByValue: true, timeout: 1000 });
    if (exceptionDetails || !result.value) throw new Error('Browser observation failed');
    return result.value;
  };
}

async function read(locator: Locator, step: CheckStep, timeout: number) {
  const matches = await locator.count();
  if (matches !== 1) return step.check === 'visible' && matches === 0 ? false : undefined;
  switch (step.check) {
    case 'visible': return locator.isVisible();
    case 'enabled': return locator.isEnabled({ timeout });
    case 'text': return (await locator.innerText({ timeout })).trim();
    case 'value': return locator.inputValue({ timeout });
    case 'attribute': return await locator.getAttribute(step.attribute!, { timeout }) ?? undefined;
    default: return undefined;
  }
}

async function enter(page: Page, frame: Frame, screen: DesignScreen) {
  const timeoutMs = screen.entryTimeoutMs ?? 8000;
  const reached = await page.evaluate(({ actions, ready, timeout }) => new Promise<boolean>(resolve => {
    const content = document.querySelector('iframe')?.contentWindow;
    if (!content) { resolve(false); return; }
    const requestId = 'handoff-' + String(performance.now());
    const listener = new AbortController();
    const timer = setTimeout(() => {
      listener.abort();
      resolve(false);
    }, timeout + 600);
    window.addEventListener('message', event => {
      if (event.source !== content || event.origin !== 'null' || event.data?.type !== 'cds-design-entry-result'
        || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      listener.abort();
      resolve(event.data.reached === true);
    }, { signal: listener.signal });
    content.postMessage({ type: 'cds-design-entry', requestId, actions, ready, timeoutMs: timeout }, '*');
  }), { actions: screen.entryActions, ready: screen.entryReadySelector, timeout: timeoutMs });
  if (!reached) throw new Error('Prototype entry did not settle');
  const ready = screen.entryReadySelector ?? screen.readySelector;
  if (ready) await frame.locator('css=' + ready).waitFor({ timeout: timeoutMs });
  await frame.waitForFunction(() => document.fonts.status === 'loaded' && !Array.from(document.querySelectorAll('[data-content-loading], [aria-busy="true"]'))
    .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'), undefined, { timeout: timeoutMs });
}

async function runCase(browser: Browser, html: string, screen: DesignScreen, test: DesignHandoffCase): Promise<DesignHandoffCaseResult> {
  const caseId = test.id;
  const context = await browser.newContext({ viewport: designViewports[screen.viewport], hasTouch: screen.viewport === 'phone',
    colorScheme: test.theme, offline: true, serviceWorkers: 'block' });
  let step = 0;
  let issue: 'entry' | 'control' | 'expectation' = 'entry';
  let page: Page | undefined;
  let crashed = false;
  try {
    page = await context.newPage();
    page.once('crash', () => { crashed = true; });
    const entry = new URL('/prototype', origin);
    entry.searchParams.set('theme', test.theme);
    const target = new URL(entry);
    target.hash = screen.route;
    let served = false;
    await context.route('**/*', route => {
      const request = route.request();
      if (request.method() !== 'GET' || !request.isNavigationRequest()) return route.abort();
      if (request.url() === host && request.frame() === page!.mainFrame() && !served) {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}iframe{display:block;width:100vw;height:100vh;border:0}</style><iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>' });
      }
      if (request.url() !== entry.href || request.frame().parentFrame() !== page!.mainFrame() || served) return route.abort();
      served = true;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html,
        headers: { 'Content-Security-Policy': designPrototypeCsp, 'X-Content-Type-Options': 'nosniff' } });
    });
    await page.goto(host, { timeout: 5000 });
    const handle = await page.locator('iframe').elementHandle({ timeout: 2000 });
    const frame = await handle?.contentFrame();
    if (!frame) return { caseId, status: 'unavailable', code: 'runtime' };
    await frame.goto(target.href, { waitUntil: 'load', timeout: 5000 });
    await enter(page, frame, screen);
    if (!served || frame.url().split('#')[0] !== entry.href) return { caseId, status: 'failed', step, code: 'entry' };

    const remembered = new Map<string, string>();
    let measure: Awaited<ReturnType<typeof isolatedObservation>> | undefined;
    for (const [index, change] of test.steps.entries()) {
      step = index + 1;
      const locator = frame.locator('css=' + change.selector);
      issue = 'control';
      if (change.action === 'click') {
        await locator.click({ timeout: stepMs });
      } else if (change.action === 'fill') {
        await locator.fill(change.value, { timeout: stepMs });
      } else if (change.action === 'select') {
        await locator.selectOption(change.value, { timeout: stepMs });
      } else if (change.action === 'attach') {
        await locator.setInputFiles({ name: change.name, mimeType: 'text/plain', buffer: Buffer.from(change.value) }, { timeout: stepMs });
      } else if (change.action === 'remember') {
        await locator.waitFor({ state: 'attached', timeout: stepMs });
        const value = await read(locator, change, stepMs);
        if (typeof value !== 'string' || !value.length) return { caseId, status: 'failed', step, code: 'expectation' };
        remembered.set(change.as, value);
      } else if (change.action === 'expect') {
        issue = 'expectation';
        const expected = change.sameAs ? remembered.get(change.sameAs) : change.equals ?? true;
        const deadline = Date.now() + stepMs;
        const isNative = nativeChecks.includes(change.check);
        if (isNative) {
          measure ??= await isolatedObservation(page, frame).catch(() => undefined);
          if (!measure) return { caseId, status: 'unavailable', step, code: 'runtime' };
        }
        const initial = isNative ? await measure!(change.selector) : undefined;
        if (change.check === 'fullscreen' && initial?.fullscreenEnabled === false) {
          return { caseId, status: 'unavailable', step, code: 'host-capability' };
        }
        let matched = false;
        do {
          const sample = isNative ? await measure!(change.selector) : undefined;
          const actual = change.check === 'fullscreen' ? sample?.fullscreen
            : sample ? Boolean(sample.playing && sample.time !== undefined && sample.time > (initial?.time ?? 0)
              && (change.check !== 'audio-playing' || sample.audible))
            : await read(locator, change, Math.max(1, deadline - Date.now()));
          if (actual !== undefined && actual === expected) { matched = true; break; }
          if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 70));
        } while (Date.now() < deadline);
        if (!matched) return { caseId, status: 'failed', step, code: issue };
      }
    }
    return { caseId, status: 'passed' };
  } catch {
    if (!browser.isConnected() || crashed || page?.isClosed()) return { caseId, status: 'unavailable', step, code: 'runtime' };
    return { caseId, status: 'failed', step, code: issue };
  } finally {
    await context.close().catch(() => {});
  }
}

// The only code from the package executes inside the offline sandboxed preview.
export async function runDesignHandoff(browser: Browser, input: DesignHandoffInput): Promise<DesignHandoffCaseResult[]> {
  const html = decorateDesignPrototype(input.prototype.toString('utf8'));
  const screensById = new Map(input.screens.map(screen => [screen.id, screen]));
  const deadline = setTimeout(() => void browser.close().catch(() => {}), 62_000);
  try {
    const results: DesignHandoffCaseResult[] = [];
    for (const test of input.cases) {
      const screen = screensById.get(test.screenId);
      if (!screen) throw new Error('Invalid screen binding');
      try {
        results.push(await runCase(browser, html, screen, test));
      } catch {
        results.push({ caseId: test.id, status: 'unavailable', code: 'runtime' });
      }
    }
    return results;
  } finally {
    clearTimeout(deadline);
  }
}
