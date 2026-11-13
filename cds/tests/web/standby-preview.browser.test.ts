import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

it.each(['peers-first', 'standby-first'])('saved peer survives %s loading; unsaved preview never saves or enables background execution', async loadOrder => {
  const webRoot = path.resolve('web');
  const requireWeb = createRequire(path.join(webRoot, 'package.json'));
  const { build, preview } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
  const fixture = path.join(webRoot, '__standby-preview-fixture.html');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-standby-built-'));
  let server: any, browser: any;
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let backgroundStarts = 0;
  const savedConfig = { peerId: 'fixture-peer', remoteProjectId: 'fixture-target', enabled: false, intervalMinutes: 15, branchSyncPolicy: 'audit-only', autoFailover: false };
  try {
    await fs.writeFile(fixture, `<!doctype html><html><body><div id="root"></div><script type="module">
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectMigrationTab} from '/src/pages/ProjectSettingsPage.tsx';
      createRoot(document.getElementById('root')).render(React.createElement(ProjectMigrationTab,{projectId:'fixture-source',onToast:(text)=>{document.body.dataset.toast=text}}));
    </script></body></html>`);
    // 直接读取构建产物，避免把开发依赖优化/HMR混入业务结果的10秒断言。
    const config = { root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), logLevel: 'error' as const,
      build: { outDir, emptyOutDir: true, rollupOptions: { input: fixture } } };
    await build(config);
    // Any unhandled API is directed to a deliberately closed port, never the user's CDS.
    server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: 'http://127.0.0.1:1' } } } });
    const port = server.httpServer.address().port;
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }), headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', (error: Error) => console.error('fixture page error:', error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const method = request.method(); const body = request.postData() ? JSON.parse(request.postData()!) : null;
      requests.push({ method, path: url.pathname, body });
      let response: any;
      if (url.pathname.endsWith('/peers')) {
        if (loadOrder === 'standby-first') await new Promise(resolve => setTimeout(resolve, 120));
        response = { peers: [{ id: 'unrelated-peer', name: 'Unrelated peer', baseUrl: 'https://unrelated.invalid', hasKey: false, keyMasked: null, createdAt: '2026-10-28' },
          { id: 'fixture-peer', name: 'Synthetic peer', baseUrl: 'https://example.invalid', hasKey: false, keyMasked: null, createdAt: '2026-10-28' }] };
      }
      else if (url.pathname.endsWith('/config-preview')) response = { yaml: '', bytes: 0, summary: { profiles: 0, infra: 0, envVars: 0, routingRules: 0 } };
      else if (url.pathname.endsWith('/standby')) {
        if (loadOrder === 'peers-first' && method === 'GET') await new Promise(resolve => setTimeout(resolve, 120));
        if (method === 'PUT' && body.enabled && body.branchSyncPolicy === 'warm-running') backgroundStarts++;
        response = { ok: true, config: method === 'PUT' ? body : savedConfig };
      } else if (url.pathname.endsWith('/standby/reconcile')) response = { result: { dryRun: true, policy: body.policy, sourceBranchCount: 1, targetBranchCount: 0,
        planned: [{ name: 'main', kind: 'create', reason: 'fixture' }], created: [], deployed: [], stopped: [], divergent: [], failed: [] } };
      else return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected fixture endpoint' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto(`${origin}/__standby-preview-fixture.html`);
    try {
      await page.waitForFunction(() => document.querySelectorAll<HTMLInputElement>('input[name="migration-peer"]')[1]?.checked === true);
    } catch (error) {
      console.error('standby fixture failed:', loadOrder, JSON.stringify(requests), await page.locator('body').innerText());
      throw error;
    }
    await page.locator('label').filter({ hasText: '分支同步策略' }).locator('select').selectOption('warm-running');
    await page.getByLabel('按间隔持续核对', { exact: true }).check();
    const response = page.waitForResponse((r: any) => r.url().endsWith('/standby/reconcile'));
    await page.getByRole('button', { name: '预演分支同步', exact: true }).click(); await response;
    expect(requests.filter(request => request.method === 'PUT')).toEqual([]);
    expect(backgroundStarts).toBe(0);
    expect(requests.filter(request => request.method !== 'GET')).toEqual([{ method: 'POST', path: '/api/projects/fixture-source/migration/standby/reconcile',
      body: { peerId: 'fixture-peer', remoteProjectId: 'fixture-target', policy: 'warm-running', dryRun: true } }]);
    expect(await page.getByLabel('按间隔持续核对', { exact: true }).isChecked()).toBe(true);
  } finally {
    await browser?.close(); await server?.close(); await fs.rm(fixture, { force: true });
    await fs.rm(outDir, { recursive: true, force: true });
    expect(await fs.stat(fixture).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(outDir).then(() => true, () => false)).toBe(false);
    if (server) expect(server.httpServer?.listening ?? false).toBe(false);
  }
}, 60_000);
