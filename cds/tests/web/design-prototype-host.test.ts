import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import express from 'express';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { designViewports, type DesignScreen, type DesignVersion, type DesignWorkspace } from '../../src/shared/design-workspace.js';
import { buildZip, crc32 } from '../../src/utils/zip.js';
import { DesignFrame } from '../../web/src/pages/design-workspace/DesignCanvas';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

const projectId = 'fixture-prototype-host';
const api = `/api/projects/${projectId}/design`;
const outside = 'https://fixture-outside.invalid/blocked';
const exceptionMessage = 'fixture-private-exception-and-stack';
const consoleStimulus = 120;
const readySelector = '[data-fixture-ready]';
const recoveryCases = ['control-unavailable', 'readiness-timeout', 'prototype-error'] as const;
type FailureReason = typeof recoveryCases[number];
type Scene = 'security' | 'slow' | FailureReason;
type Diagnostics = { runtime: number; blocked: number; console: number; directives: string[] };
type Envelope = {
  type: string;
  requestId?: string;
  reached?: boolean;
  reason?: string;
  diagnostics?: Diagnostics;
  parentSealed?: boolean;
  sameOriginBlocked?: boolean;
  externalBlocked?: boolean;
};
type Message = { origin: string; data: Envelope };
type HostWindow = Window & { prototypeHostMessages: Message[] };

const scenes: DesignScreen[] = (['security', 'slow', ...recoveryCases] as const).map(id => ({
  id, name: id, route: `#${id}`, viewport: 'desktop', themes: ['light', 'dark'], impl: null,
  ...(id === 'security' ? {} : {
    entryActions: [id === 'control-unavailable' ? '#missing-fixture-entry' : '#open-fixture-entry'],
    entryReadySelector: readySelector,
    entryTimeoutMs: id === 'slow' ? 3000 : 750,
  }),
}));

const prototype = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Synthetic prototype</h1>
  <button type="button" id="open-fixture-entry">Open fixture entry</button>
  <script>
    const scene = location.hash.slice(1);
    document.querySelector('#open-fixture-entry').addEventListener('click', () => {
      if (scene === 'slow') setTimeout(() => {
        const ready = document.createElement('p');
        ready.setAttribute('data-fixture-ready', '');
        ready.textContent = 'Unique state after the fixture delay';
        document.body.append(ready);
      }, 1400);
      if (scene === 'prototype-error') {
        for (let index = 0; index < ${consoleStimulus}; index++) console.error(${JSON.stringify(exceptionMessage)});
        throw new Error(${JSON.stringify(exceptionMessage)});
      }
    });
    if (scene === 'security' || scene === 'prototype-error') {
      (async () => {
        let parentSealed = false;
        try { void parent.document.body; } catch (error) { parentSealed = error.name === 'SecurityError'; }
        const requestBlocked = async url => {
          try { await fetch(url); return false; } catch { return true; }
        };
        const [sameOriginBlocked, externalBlocked] = await Promise.all([
          requestBlocked('/fixture-parent-resource'), requestBlocked(${JSON.stringify(outside)}),
        ]);
        parent.postMessage({ type: 'fixture-sandbox', parentSealed, sameOriginBlocked, externalBlocked }, '*');
      })();
    }
  </script>
</body></html>`;

function fixtureScreenshot() {
  const { width, height } = designViewports.desktop;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4, 'ascii');
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function expectSafeDiagnostics(data: Envelope): Diagnostics {
  const serialized = JSON.stringify(data);
  expect(serialized.includes(exceptionMessage) || serialized.includes(outside), 'the bridge keeps the original error and URL private').toBe(false);
  expect(Buffer.byteLength(serialized), 'the bridge payload is bounded').toBeLessThanOrEqual(1024);
  const diagnostics = data.diagnostics;
  expect(Boolean(diagnostics)).toBe(true);
  expect(Object.keys(diagnostics!).sort()).toEqual(['blocked', 'console', 'directives', 'runtime']);
  for (const count of [diagnostics!.blocked, diagnostics!.console, diagnostics!.runtime]) {
    expect(Number.isSafeInteger(count) && count >= 0 && count <= 1000).toBe(true);
  }
  expect(Array.isArray(diagnostics!.directives)).toBe(true);
  expect(diagnostics!.directives.length).toBeLessThanOrEqual(20);
  expect(diagnostics!.directives.every(directive => /^[a-z-]{1,40}$/.test(directive))).toBe(true);
  return diagnostics!;
}

describe('prototype host in Chromium', () => {
  let directory: string;
  let server: Server;
  let browser: Browser;
  let origin: string;
  let version: DesignVersion;
  let clientScript: string;
  let localResourceHits = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cds-prototype-host-'));
    const service = new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory));
    const actor: DesignActor = { kind: 'human', id: 'fixture-reader', label: 'Synthetic draft reader', permissions: ['read', 'write'] };
    const app = express();
    app.get('/fixture-frame-client.js', (_req, res) => res.type('js').send(clientScript));
    app.get('/fixture-design.css', async (_req, res) => {
      res.type('css').send(await readFile(new URL('../../web/src/pages/design-workspace/design.css', import.meta.url), 'utf8'));
    });
    app.get('/fixture-parent-resource', (_req, res) => {
      localResourceHits++;
      res.send('Synthetic parent-only resource');
    });
    app.get('/fixture/:scene', (req, res) => {
      const screen = version.screens.find(item => item.id === req.params.scene);
      if (!screen) { res.sendStatus(404); return; }
      const props = { projectId, version, screen, theme: 'light' as const, zoom: 100 };
      if (req.query.client === '1') {
        const json = JSON.stringify(props).replace(/</g, '\\u003c');
        res.type('html').send(`<!doctype html><html><head><link rel="stylesheet" href="/fixture-design.css"></head>
          <body><div id="fixture-root"></div><script type="application/json" id="fixture-props">${json}</script>
          <script src="/fixture-frame-client.js"></script></body></html>`);
        return;
      }
      const frame = renderToStaticMarkup(createElement(DesignFrame, props));
      res.type('html').send(`<!doctype html><html><title>Fixture parent</title><body>${frame}</body></html>`);
    });
    app.use('/api', createDesignWorkspaceRouter({
      service, resolveAccess: (_req, project) => project === projectId ? actor : null,
    }));
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback prototype host');
    origin = `http://127.0.0.1:${address.port}`;
    const archive = buildZip([
      { name: 'design.json', data: JSON.stringify({ project: projectId, title: 'Synthetic prototype host', screens: scenes }) },
      { name: '思路.md', data: 'Exercise the embedded prototype with synthetic data.' },
      { name: 'dist/index.html', data: prototype },
      { name: 'screens/prototype-error.light.png', data: fixtureScreenshot() },
    ]);
    const published = await fetch(`${origin}${api}/packages?sourceMode=private&intent=create&designKey=fixture/prototype-host&sourcePath=design/fixture&requestId=fixture-host&sourceCommit=${'a'.repeat(40)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(archive),
    });
    expect(published.status, (await published.text()).slice(0, 250)).toBe(201);
    const workspace = await (await fetch(origin + api)).json() as DesignWorkspace;
    version = workspace.designs[0].versions[0];
    browser = await chromium.launch({ headless: true,
      ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
    });
  }, 20_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function visit(context: BrowserContext, scene: Scene) {
    const remoteRequests: string[] = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) await route.continue();
      else {
        remoteRequests.push(url.origin);
        await route.abort();
      }
    });
    const page = await context.newPage();
    await observeFrameMessages(page);
    const navigation = page.waitForResponse(response => new URL(response.url()).pathname === `${api}/artifacts/${version.prototypeId}`);
    await page.goto(`${origin}/fixture/${scene}`, { waitUntil: 'domcontentloaded' });
    const response = await navigation;
    await page.frameLocator('iframe').getByRole('button', { name: 'Open fixture entry' }).waitFor();
    return { page, response, remoteRequests };
  }

  function observeFrameMessages(page: Page) {
    return page.addInitScript(() => {
      if (window !== window.top) return;
      const messages = (window as HostWindow).prototypeHostMessages = [];
      window.addEventListener('message', event => {
        if (event.source === document.querySelector('iframe')?.contentWindow) {
          messages.push({ origin: event.origin, data: event.data });
        }
      });
    });
  }

  async function firstMessage(page: Page, type: string, timeout = 5000): Promise<Message> {
    await page.waitForFunction(messageType => (window as HostWindow).prototypeHostMessages.some(message => message.data?.type === messageType), type, { timeout });
    return page.evaluate(messageType => (window as HostWindow).prototypeHostMessages.find(message => message.data?.type === messageType)!, type);
  }

  async function runEntry(page: Page, scene: Scene, timeoutMs: number) {
    const screen = version.screens.find(item => item.id === scene)!;
    const requestId = `fixture-entry-${scene}`;
    await page.evaluate(input => {
      document.querySelector('iframe')!.contentWindow!.postMessage(input, '*');
    }, { type: 'cds-design-entry', actions: screen.entryActions, ready: screen.entryReadySelector, requestId, timeoutMs });
    const message = await firstMessage(page, 'cds-design-entry-result');
    expect(message.origin).toBe('null');
    return { requestId, data: message.data };
  }

  it('preserves the opaque iframe, restrictive headers and blocked browser requests', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const { page, response, remoteRequests } = await visit(context, 'security');
      expect(response.status()).toBe(200);
      expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
      expect(await page.locator('iframe').getAttribute('referrerpolicy')).toBe('no-referrer');
      const headers = await response.allHeaders();
      expect(headers).toMatchObject({
        'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'cache-control': 'private, no-store',
      });
      const policy = headers['content-security-policy']?.split(';').map(item => item.trim());
      expect(policy).toEqual(expect.arrayContaining(["sandbox allow-scripts", "default-src 'none'", "frame-ancestors 'self'", "form-action 'none'", "base-uri 'none'"]));
      expect(policy?.some(entry => /(?:allow-same-origin|unsafe-eval|https?:)/.test(entry))).toBe(false);
      const { origin: frameOrigin, data } = await firstMessage(page, 'fixture-sandbox');
      expect(frameOrigin).toBe('null');
      expect(data).toMatchObject({ parentSealed: true, sameOriginBlocked: true, externalBlocked: true });
      expect(localResourceHits).toBe(0);
      expect(remoteRequests).toHaveLength(0);
    } finally {
      await context.close();
    }
  }, 10_000);

  it('waits for the unique ready state reached 1.4 seconds after opening the entry', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const { page } = await visit(context, 'slow');
      const { requestId, data } = await runEntry(page, 'slow', 3000);
      expect(data.reached).toBe(true);
      expect(data.requestId).toBe(requestId);
      expect(data.reason).toBeUndefined();
      expectSafeDiagnostics(data);
      expect(await page.frameLocator('iframe').locator(readySelector).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 10_000);

  it.each(recoveryCases)('reports %s with bounded diagnostics and the originating request ID', async (reason) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const { page } = await visit(context, reason);
      const result = await runEntry(page, reason, 750);
      expect(result.data.reached).toBe(false);
      expect(result.data.reason).toBe(reason);
      expect(result.data.requestId).toBe(result.requestId);
      const diagnostics = expectSafeDiagnostics(result.data);
      if (reason === 'prototype-error') {
        expect(diagnostics.runtime).toBeGreaterThan(0);
        expect(diagnostics.console).toBeGreaterThan(0);
        expect(diagnostics.console).toBeLessThan(consoleStimulus);
        const live = await page.evaluate(() => (window as HostWindow).prototypeHostMessages.find(
          message => message.data?.type === 'cds-design-diagnostics' && (message.data.diagnostics?.runtime ?? 0) > 0,
        ));
        expect(Boolean(live && live.origin === 'null')).toBe(true);
        expectSafeDiagnostics(live!.data);
      }
    } finally {
      await context.close();
    }
  }, 10_000);

  it('mounts the real React frame, shows the failure, and lets the user switch between the delivered image and live prototype', async () => {
    const web = fileURLToPath(new URL('../../web/', import.meta.url));
    const bundle = await build({
      stdin: { resolveDir: web, contents: `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { DesignFrame } from './src/pages/design-workspace/DesignCanvas';
        createRoot(document.getElementById('fixture-root')).render(
          createElement(DesignFrame, JSON.parse(document.getElementById('fixture-props').textContent)),
        );
      ` },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
      alias: { '@': join(web, 'src') }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    clientScript = bundle.outputFiles[0].text;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(`${origin}/fixture/prototype-error?client=1`, { waitUntil: 'domcontentloaded' });
      const summary = page.getByRole('status').filter({ hasText: '原型脚本出错' });
      await summary.waitFor({ timeout: 5000 });
      expect((await summary.textContent())?.includes(exceptionMessage)).toBe(false);
      expect(await summary.textContent()).toContain('正在看交付包里的截图');
      await page.waitForFunction(width => {
        const image = document.querySelector<HTMLImageElement>('.dw-frame-png');
        return image?.complete && image.naturalWidth === width;
      }, designViewports.desktop.width, { timeout: 3000 });
      expect(await page.locator('iframe').isHidden()).toBe(true);
      await summary.getByRole('button', { name: '看交互原型' }).click();
      await page.frameLocator('iframe').getByRole('button', { name: 'Open fixture entry' }).waitFor({ timeout: 3000 });
      expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
      expect(await page.locator('.dw-frame-png').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 12_000);

  it('hosts cdscli design preview locally with an opaque frame and a safe failure summary', async () => {
    const packageDir = join(directory, 'cli-fixture');
    const dist = join(packageDir, 'dist');
    await mkdir(dist, { recursive: true });
    const marker = 'host-execution-marker';
    const markerScript = `node -e "require('node:fs').writeFileSync('${marker}', 'unexpected')"`;
    await Promise.all([
      writeFile(join(packageDir, 'design.json'), JSON.stringify({ project: projectId, title: 'CLI fixture', screens: scenes })),
      writeFile(join(packageDir, 'package.json'), JSON.stringify({ scripts: { start: markerScript, build: markerScript, preview: markerScript } })),
      writeFile(join(packageDir, '思路.md'), 'Exercise local preview with a synthetic package.'),
      writeFile(join(dist, 'index.html'), prototype),
    ]);

    const cli = fileURLToPath(new URL('../../../.claude/skills/cds/cli/cdscli.py', import.meta.url));
    const child = spawn('python3', [cli, 'design', 'preview', '--dir', packageDir, '--screen', 'prototype-error', '--theme', 'dark', '--port', '0'], {
      cwd: packageDir,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startError: string | undefined;
    child.once('error', (error: NodeJS.ErrnoException) => { startError = error.code; });
    child.stderr.resume();
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    let context: BrowserContext | undefined;
    try {
      const output = createInterface({ input: child.stdout, signal: AbortSignal.timeout(5000) });
      let localUrl: string | undefined;
      try {
        for await (const line of output) {
          localUrl = line.match(/http:\/\/127\.0\.0\.1:\d+(?:\/[^\s"'<>]*)?/)?.[0];
          if (localUrl) break;
        }
      } finally {
        output.close();
      }
      expect(Boolean(localUrl), `cdscli advertised a loopback URL (exit ${child.exitCode ?? startError ?? 'pending'})`).toBe(true);
      const local = new URL(localUrl!);
      expect(Number(local.port)).toBeGreaterThan(0);

      context = await browser.newContext({ serviceWorkers: 'block' });
      const remoteRequests: string[] = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === local.origin) await route.continue();
        else {
          remoteRequests.push(url.origin);
          await route.abort();
        }
      });
      const page = await context.newPage();
      await observeFrameMessages(page);
      const frameNavigation = page.waitForResponse(
        response => response.request().isNavigationRequest() && Boolean(response.frame().parentFrame()), { timeout: 5000 },
      );
      await page.goto(local.href, { waitUntil: 'domcontentloaded', timeout: 5000 });
      const frameResponse = await frameNavigation;
      expect(frameResponse.status()).toBe(200);
      expect((await frameResponse.allHeaders())['content-security-policy']).toContain('sandbox allow-scripts');
      expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
      await page.frameLocator('iframe').locator('html[data-theme="dark"]').waitFor({ state: 'attached', timeout: 5000 });

      const result = await firstMessage(page, 'cds-design-entry-result', 12_000);
      expect(result.origin).toBe('null');
      expect(result.data.reached).toBe(false);
      expect(result.data.reason).toBe('prototype-error');
      expectSafeDiagnostics(result.data);
      const { data: boundary } = await firstMessage(page, 'fixture-sandbox');
      expect(boundary).toMatchObject({ parentSealed: true, sameOriginBlocked: true, externalBlocked: true });
      expect(remoteRequests).toHaveLength(0);
      const failed = page.locator('#preview-status[data-state="failed"]');
      await failed.waitFor({ timeout: 3000 });
      expect(await failed.getAttribute('role')).toBe('status');
      const summary = await failed.textContent();
      expect(summary).toContain('原型脚本出错');
      expect(summary).toMatch(/原型报错\s*[1-9]\d*\s*条/);
      expect(summary?.includes(exceptionMessage)).toBe(false);
      await expect(access(join(packageDir, marker))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      try { await context?.close(); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const killTimeout = setTimeout(() => child.kill('SIGKILL'), 1000);
        try { await stopped; } finally { clearTimeout(killTimeout); }
      }
    }
  }, 25_000);
});
