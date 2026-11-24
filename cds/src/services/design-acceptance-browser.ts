import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Browser, Page, Route } from 'playwright';
import { designPixelDifference } from '../shared/design-pixels.js';
import { designViewports, type DesignRule, type DesignScreen, type DesignTheme, type DesignVersion } from '../shared/design-workspace.js';
import { designBrowserPath, launchDesignBrowser, readPrototypeScreen } from './design-framework-browser.js';
import { designDigest, localDesignPath } from './design-package.js';
import { decorateDesignPrototype, designPrototypeCsp } from './design-prototype.js';
import { compareDesignObservations, measureDesignPage, observeDesignRules } from './design-acceptance-observations.js';
import { rejectPlanning } from './engineering-planning-input.js';

type PreviewBuildInput = { projectId: string; commit: string; preview: { pullRequest: number; url: string } };
type DesignBuild = { read: (file: string) => Promise<Buffer | undefined>; current: () => Promise<boolean> };
export type OpenDesignPreviewBuild = (input: PreviewBuildInput) => Promise<DesignBuild | undefined>;

type ProgramCaptureInput = {
  prototype: Buffer; screen: DesignScreen; theme: DesignTheme; rules: DesignRule[];
  commit: string; version: DesignVersion; projectId: string; preview?: PreviewBuildInput['preview'];
};
type ProgramCapture = {
  fixtureDigest: string; reference: Buffer; implementation: Buffer;
  checks: ReturnType<typeof compareDesignObservations>; rules: ReturnType<typeof observeDesignRules>;
};
export type DesignAcceptanceCapture = (input: ProgramCaptureInput) => Promise<ProgramCapture | undefined>;

const renderOrigin = 'https://cds-design-implementation.invalid';
const snapshotLimit = 2 * 1024 * 1024;
const captureTimeout = 5500;
const screenshotOptions = { animations: 'disabled', caret: 'hide', timeout: captureTimeout } as const;
// Rounded subpixel borders can rasterize differently across compositor runs.
// Use the same software rendering path for the two images and their exact replay.
const evidenceRenderArgs = [
  '--disable-gpu', '--disable-gpu-compositing', '--disable-partial-raster',
  '--disable-skia-runtime-opts', '--force-color-profile=srgb', '--run-all-compositor-stages-before-draw',
];
type FixtureSnapshot = { responses: Array<[string, unknown]>; artifacts: Record<string, string> };
const mimeTypes: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

async function takeScreenshot(page: Page) {
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('.dw-frame-loading')).some(element => {
    const box = element.getBoundingClientRect();
    return box.height > 0 && box.width > 0 && box.top < innerHeight && box.bottom > 0
      && getComputedStyle(element).visibility === 'visible';
  }), undefined, { timeout: captureTimeout });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images)
      .filter(image => image.getClientRects().length > 0 && image.getBoundingClientRect().top < innerHeight)
      .map(image => image.decode().catch(() => undefined)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return page.screenshot(screenshotOptions);
}

async function readDemoFixtures(page: Page, project: string): Promise<FixtureSnapshot> {
  return page.evaluate(async ({ project, snapshotLimit }) => {
    const base = '/api/projects/' + project + '/design';
    const reader = {
      async read(path: string) {
        const response = await fetch(path);
        if (!response.ok) return undefined;
        const value = await response.text();
        if (value.length > snapshotLimit) throw new Error('Fixture exceeds size limit');
        return JSON.parse(value) as unknown;
      },
    };
    const paths = ['/api/auth/status', '/api/auth/public-status', '/api/instance-mode',
      '/api/cluster/identity/status', '/api/self-status', '/api/projects', '/api/design-review-notices',
      '/api/preview-access/notices', '/cds-instances.json', base, base + '/reviewers', base + '/intake'];
    const responses = (await Promise.all(paths.map(async path => [path, await reader.read(path)] as [string, unknown])))
      .filter(([, value]) => value !== undefined);
    const artifacts = (window as { __CDS_ARTIFACTS__?: Record<string, string> }).__CDS_ARTIFACTS__ ?? {};
    const workspace = responses.find(([path]) => path === base)?.[1] as {
      projectId?: string;
      designs?: Array<{ versions?: Array<{ delivery?: { files: Array<{ id: string; text: boolean }> } }> }>;
    } | undefined;
    if (workspace?.projectId !== project || !Array.isArray(workspace.designs)
      || !responses.some(([path]) => path === '/api/auth/status') || !responses.some(([path]) => path === '/api/projects')) {
      throw new Error('Fixture workspace unavailable');
    }
    const files = [...new Set(workspace.designs.flatMap(draft => (draft.versions ?? []).flatMap(version =>
      (version.delivery?.files ?? []).filter(file => file.text).map(file => file.id))))];
    for (const id of files.slice(0, 160)) {
      if (!/^[a-z0-9_.-]{1,160}$/i.test(id)) continue;
      const path = base + '/artifacts/' + id;
      const value = await reader.read(path + '?view=text&offset=0');
      if (value !== undefined) responses.push([path + '?view=text&offset=0', value]);
    }
    const snapshot = { responses, artifacts };
    if (Object.keys(artifacts).length > 240 || JSON.stringify(snapshot).length > snapshotLimit) {
      throw new Error('Fixture exceeds size limit');
    }
    return snapshot;
  }, { project, snapshotLimit });
}

function fixtureAsset(value: unknown): { body: string; contentType: string } | undefined {
  if (typeof value !== 'string' || value.length > 320 * 1024) return undefined;
  const prefix = ['data:text/html;charset=utf-8,', 'data:image/svg+xml,', 'data:image/svg+xml;charset=utf-8,']
    .find(format => value.startsWith(format));
  if (!prefix) return undefined;
  const body = decodeURIComponent(value.slice(prefix.length));
  return prefix.startsWith('data:text/html')
    ? { body: decorateDesignPrototype(body), contentType: 'text/html; charset=utf-8' }
    : { body, contentType: 'image/svg+xml' };
}

async function openInstalledBuild(webDist: string, commit: string): Promise<DesignBuild | undefined> {
  const dist = await realpath(webDist).catch(() => undefined);
  if (!dist) return undefined;
  const read: DesignBuild['read'] = async file => {
    const path = await realpath(resolve(dist, file)).catch(() => undefined);
    return path?.startsWith(dist + sep) ? readFile(path).catch(() => undefined) : undefined;
  };
  return { read, current: async () => (await read('.build-sha'))?.toString('utf8').trim() === commit };
}

async function serveImplementation(route: Route, target: URL, build: DesignBuild, project: string, fixtures: FixtureSnapshot) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== renderOrigin || request.method() !== 'GET') return route.abort();
  if (request.isNavigationRequest() && url.href === target.href.split('#')[0]) {
    const body = await build.read('index.html');
    return body ? route.fulfill({ body, contentType: 'text/html; charset=utf-8' }) : route.abort();
  }
  const name = url.pathname.replace(/^\/_cds(?=\/api\/)/, '');
  const base = '/api/projects/' + project + '/design';
  if (name.startsWith(base + '/artifacts/')) {
    const id = name.slice((base + '/artifacts/').length);
    if (!/^[a-z0-9_.-]{1,160}$/i.test(id)) return route.abort();
    if (url.searchParams.get('view') !== 'text') {
      const file = Object.hasOwn(fixtures.artifacts, id) ? fixtureAsset(fixtures.artifacts[id]) : undefined;
      if (!file) return route.fulfill({ status: 404 });
      return route.fulfill({ ...file, headers: { 'Content-Security-Policy': designPrototypeCsp, 'X-Content-Type-Options': 'nosniff' } });
    }
  }
  if (name.startsWith('/api/') || name === '/cds-instances.json') {
    const key = url.searchParams.get('view') === 'text'
      ? name + '?view=text&offset=' + (url.searchParams.get('offset') ?? '0') : name;
    const found = fixtures.responses.find(([path]) => path === key);
    return route.fulfill(found ? { json: found[1] } : { status: 404, json: { error: 'fixture_only' } });
  }
  const type = mimeTypes[extname(name)];
  if (!type || !/^\/(?:assets\/)?[a-z0-9_.-]+$/i.test(name)) return route.abort();
  const body = await build.read(name.slice(1));
  return body ? route.fulfill({ body, contentType: type }) : route.abort();
}

async function readImplementation(browser: Browser, build: DesignBuild, target: URL, project: string,
  runtime: ProgramCaptureInput, fixtures: FixtureSnapshot, reference: Buffer, date: Date) {
  const { screen, theme } = runtime;
  const context = await browser.newContext({
    viewport: designViewports[screen.viewport], hasTouch: screen.viewport === 'phone', colorScheme: theme,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
    offline: true, serviceWorkers: 'block', deviceScaleFactor: 1,
  });
  try {
    await context.route('**/*', route => serveImplementation(route, target, build, project, fixtures).catch(() => route.abort()));
    await context.addInitScript(value => {
      try { localStorage.setItem('cds_theme', value); } catch { /* sandboxed documents have no storage */ }
    }, theme);
    const page = await context.newPage();
    await page.clock.setFixedTime(date);
    await page.goto(target.href, { timeout: captureTimeout, waitUntil: 'domcontentloaded' });
    // Reuse the implementation's ordinary entry controls. The browser has no connection to a write API.
    const entered = new URL(target);
    for (const selector of screen.entryActions ?? []) {
      const control = page.locator('css=' + selector);
      const transition = await control.evaluate(node => {
        const comparison = node.closest('.dw-vs-row[data-compare-slot]');
        return {
          action: node.getAttribute('data-action'),
          nextScreen: node.closest('.dw-sp-thumbs') ? node.getAttribute('data-screen') : null,
          comparedScreen: comparison?.getAttribute('data-screen'),
          comparedSlot: comparison?.getAttribute('data-compare-slot'),
        };
      }, undefined, { timeout: 1800 });
      await control.click({ timeout: 1800 });
      if (transition.nextScreen) {
        entered.searchParams.set('screen', transition.nextScreen);
        entered.searchParams.delete('comment');
        await control.and(page.locator('[aria-current="step"]')).waitFor({ state: 'visible', timeout: captureTimeout });
      } else if (transition.action === 'history-timeline') {
        entered.searchParams.set('log', 'timeline');
        await page.locator('[data-history-view="timeline"]').waitFor({ state: 'visible', timeout: captureTimeout });
      } else if (transition.action === 'disable-method') {
        entered.searchParams.set('panel', 'disable-method');
        await page.locator('.dw-disable-dialog').waitFor({ state: 'visible', timeout: captureTimeout });
      } else if (transition.action === 'show-demo' && target.searchParams.has('check')) {
        entered.searchParams.set('demo', target.searchParams.get('check')!);
      } else if (transition.action === 'visual-open' && transition.comparedScreen && transition.comparedSlot) {
        entered.searchParams.set('compare-screen', transition.comparedScreen);
        entered.searchParams.set('compare-slot', transition.comparedSlot);
        await page.locator('.dw-vc').waitFor({ state: 'visible', timeout: captureTimeout });
      }
    }
    const selectedTab = target.searchParams.get('tab');
    const selectedView = selectedTab === 'accept' ? '.dw-acceptance'
      : selectedTab === 'diff' ? '.dw-compare'
        : selectedTab === 'need' ? '.dw-need'
          : target.searchParams.get('part') ? '.dw-delivery-panel' : '.dw-head--draft';
    const view = target.searchParams.has('design') ? selectedView
      : target.searchParams.has('framework') ? '.dw-fw-head'
        : target.searchParams.has('brief') ? '.dw-brief' : '.dw-library';
    const ready = screen.entryReadySelector
      && !screen.entryReadySelector.startsWith('[data-cds-design-ready=') ? screen.entryReadySelector : view;
    await page.locator('css=' + ready).first().waitFor({ state: 'visible', timeout: captureTimeout });
    const expectedVersion = target.searchParams.get('version');
    if (target.searchParams.has('design') && expectedVersion) {
      await page.waitForFunction(version => document.querySelector<HTMLSelectElement>('.dw-version-select')?.value === version,
        expectedVersion, { timeout: captureTimeout });
    }
    await page.waitForFunction(() => document.fonts.status === 'loaded'
      && !Array.from(document.querySelectorAll('[data-content-loading],.dw-frame[data-preview-state="loading"]'))
        .some(element => element.getClientRects().length > 0), undefined, { timeout: captureTimeout });
    entered.searchParams.sort();
    const samePage = () => {
      const current = new URL(page.url());
      current.searchParams.sort();
      return current.href === entered.href;
    };
    if (!samePage() || await page.locator('.dw-frame[data-preview-state="failed"]').count()) return undefined;
    const image = await takeScreenshot(page);
    const difference = await page.evaluate(designPixelDifference, {
      before: `data:image/png;base64,${reference.toString('base64')}`, after: `data:image/png;base64,${image.toString('base64')}`,
    });
    const observed = await measureDesignPage(page, theme);
    return samePage() ? { observed, image, pixelDifference: difference.area } : undefined;
  } catch {
    return undefined;
  } finally {
    await context.close();
  }
}

export function createDesignAcceptanceBrowser(webDist: string, executablePath?: string,
  openPreviewBuild?: OpenDesignPreviewBuild): DesignAcceptanceCapture | undefined {
  const executable = designBrowserPath(executablePath);
  if (!executable) return undefined;
  return async input => {
    const { prototype, screen, theme, version, projectId, commit, rules, preview } = input;
    const accepted = new Set(version.delivery?.files.map(file => file.path));
    if (!accepted.has('src/fixtures.ts') || !accepted.has('src/data-design.ts')) {
      return rejectPlanning(422, 'design_capture_missing_fixture', '设计方需补齐稿件的两份虚构演示数据源。');
    }
    const demoPath = screen.route.replace(/^#/, '');
    localDesignPath(demoPath.split(/[?#]/, 1)[0]);
    if (!demoPath || !screen.impl) return undefined;
    const target = new URL(demoPath, renderOrigin);
    const project = target.searchParams.get('project') ?? '';
    const bound = new URL(screen.impl, renderOrigin);
    if (target.pathname !== '/design' || bound.pathname !== target.pathname || bound.origin !== renderOrigin
      || project === projectId || !/^[a-z0-9-]{1,100}$/.test(project)) {
      return rejectPlanning(422, 'design_capture_invalid_scene', '设计方需提供不同于实际项目的演示场景，且与实现绑定使用同一入口。');
    }
    const tab = (url: URL) => {
      const value = url.searchParams.get('tab');
      return value === 'preview' || value === null ? 'delivery' : value;
    };
    const overlay = (url: URL) => url.searchParams.get('full')
      ?? (url.searchParams.get('tab') === 'delivery' && url.searchParams.has('part') ? 'delivery' : null);
    const states = ['check', 'pane', 'panel', 'part', 'view', 'mode', 'side', 'status', 'log', 'demo', 'compare-screen', 'compare-slot'];
    if (bound.href !== target.href && (bound.searchParams.get('project') !== projectId
      || tab(bound) !== tab(target) || overlay(bound) !== overlay(target)
      || states.some(name => bound.searchParams.get(name) !== target.searchParams.get(name)))) {
      return rejectPlanning(422, 'design_capture_binding_mismatch', '实现方需核对绑定的页签或面板，与稿件演示场景对齐后再运行。');
    }
    const date = new Date(version.createdAt);
    if (!Number.isFinite(date.valueOf())) return undefined;
    const build = preview ? await openPreviewBuild?.({ projectId, commit, preview }) : await openInstalledBuild(webDist, commit);
    if (!build || !await build.current()) {
      if (preview) return rejectPlanning(409, 'design_capture_preview_build_unavailable', '当前 PR 预览的 CDS 构建无法核对。请从同一提交部署受管的 CDS 预览后重试。');
      return undefined;
    }
    const browser = await launchDesignBrowser(executable, evidenceRenderArgs);
    const expires = setTimeout(() => { void browser.close().catch(() => {}); }, 24_000);
    try {
      let referenceFailure = '原型未到达声明画面。';
      const prior = await readPrototypeScreen(browser, decorateDesignPrototype(prototype.toString('utf8')), screen, theme,
        async page => {
          const fixtures = await readDemoFixtures(page, project);
          const image = await takeScreenshot(page);
          return { fixtures, observed: await measureDesignPage(page), image };
        }, date, message => { referenceFailure = message; });
      if (!prior) return rejectPlanning(422, 'design_capture_reference_unavailable', referenceFailure);
      const actual = await readImplementation(browser, build, target, project, input, prior.fixtures, prior.image, date);
      if (!await build.current()) return rejectPlanning(409, 'design_capture_commit_changed', '实现提交在截图时变化，请创建新的验收运行。');
      if (!actual) return rejectPlanning(422, 'design_capture_implementation_unavailable', '实现未到达同数据画面。请实现方核对路由或进入动作。');
      return { fixtureDigest: designDigest(JSON.stringify(prior.fixtures)), reference: prior.image, implementation: actual.image,
        checks: compareDesignObservations(prior.observed, actual.observed, actual.pixelDifference, theme === 'light' && screen.themes.includes('dark')),
        rules: observeDesignRules(rules, actual.observed) };
    } finally {
      clearTimeout(expires);
      await browser.close().catch(() => {});
    }
  };
}
