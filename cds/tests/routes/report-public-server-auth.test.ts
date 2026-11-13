import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, installSpaFallback } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

// Actual production authentication, report routers and static-file serving. No OAuth or remote server is used.
describe.each(['basic', 'github'] as const)('报告匿名阅读经过生产 %s 鉴权链', mode => {
  let root: string, state: StateService, server: http.Server, base: string, reportId: string, token: string, assetName: string;
  const picture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
  const runtime = 'globalThis.mermaid={initialize(){},render(){return Promise.resolve({svg:"<svg></svg>"})}};';

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-public-report-auth-'));
    vi.stubEnv('CDS_AUTH_MODE', mode);
    vi.stubEnv('CDS_USERNAME', 'fixture-owner'); vi.stubEnv('CDS_PASSWORD', 'fixture-password');
    vi.stubEnv('CDS_GITHUB_CLIENT_ID', 'synthetic-unused'); vi.stubEnv('CDS_GITHUB_CLIENT_SECRET', 'synthetic-unused');
    vi.stubEnv('CDS_ALLOWED_ORGS', ''); vi.stubEnv('CDS_SSO_ENABLED', 'false');
    vi.stubEnv('CDS_AI_ACCESS_KEY', ''); vi.stubEnv('AI_ACCESS_KEY', '');
    vi.stubEnv('CDS_PUBLIC_BASE_URL', 'http://localhost'); vi.stubEnv('CDS_REPO_ROOT', root);
    vi.stubEnv('CDS_CACHE_BASE', path.join(root, 'cache'));
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    assetName = createHash('sha256').update(picture).digest('hex') + '.svg';
    await state.writeReportAssetAsync(assetName, picture);
    const report = state.createAcceptanceReport({ title: '匿名完整报告', format: 'md',
      content: `# 匿名完整报告\n\n![证据](/api/reports/assets/${assetName})\n\n\`\`\`mermaid\nflowchart LR\n A --> B\n\`\`\`\n\nREADING-END`,
      projectId: null, branchId: null });
    reportId = report.id; token = state.enableReportShare(report.id)!.shareToken!;
    const dist = path.join(root, 'web-dist'); fs.mkdirSync(path.join(dist, 'report-assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fixture dashboard</title>');
    fs.writeFileSync(path.join(dist, 'report-assets/mermaid.min.js'), runtime);
    fs.writeFileSync(path.join(dist, 'report-assets/private.js'), 'must remain behind authentication');
    const shell = new MockShellExecutor();
    const config: CdsConfig = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'fixture', portStart: 10001, sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' },
      mode: 'standalone', rootDomains: ['example.test'] };
    const app = createServer({ stateService: state, shell, config, authStore: new MemoryAuthStore(),
      worktreeService: new WorktreeService(shell, root), containerService: {} as any, bridgeService: {} as any,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any });
    installSpaFallback(app, undefined, dist);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await flushAllJsonStateStores(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (url: string, method = 'GET', headers: Record<string, string> = {}) => fetch(base + url, {
    method, redirect: 'manual', headers: { Accept: 'application/json', ...headers },
  });

  it('匿名分享HTML无需登录跳转，保留正文与沙箱', async () => {
    const response = await request(`/r/${token}?theme=dark`, 'GET', { Accept: 'text/html' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('READING-END'); expect(html).toContain('/report-assets/mermaid.min.js');
    expect(html).toContain('sandbox='); expect(html).not.toContain('allow-same-origin');
  });

  it('匿名与opaque iframe可读取完整证据图片', async () => {
    const response = await request(`/api/reports/assets/${assetName}`, 'GET', { Origin: 'null', 'Sec-Fetch-Dest': 'image' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(picture);
  });

  it('opaque iframe可读取固定Mermaid运行文件而非登录HTML', async () => {
    const response = await request('/report-assets/mermaid.min.js', 'GET', { Origin: 'null', 'Sec-Fetch-Dest': 'script' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(await response.text()).toBe(runtime);
  });

  it('无效与已撤销token仍返回404，不能借分享读取别的报告', async () => {
    for (const invalid of ['0'.repeat(32), 'invalid-token']) {
      expect((await request(`/r/${invalid}`, 'GET', { Accept: 'text/html' })).status).toBe(404);
    }
    state.disableReportShare(reportId);
    expect((await request(`/r/${token}`, 'GET', { Accept: 'text/html' })).status).toBe(404);
  });

  it('只公开精确GET：列表、raw、元数据、上传、分享写入及其它静态文件仍须认证', async () => {
    const denied: [string, string][] = [
      ['GET', '/api/reports'], ['GET', `/api/reports/${reportId}`], ['GET', `/api/reports/${reportId}/raw`],
      ['GET', `/api/reports/${reportId}/download`], ['POST', '/api/reports'], ['POST', '/api/reports/assets'],
      ['POST', `/api/reports/${reportId}/share`], ['DELETE', `/api/reports/${reportId}/share`],
      ['PATCH', `/api/reports/${reportId}`], ['DELETE', `/api/reports/${reportId}`],
      ['POST', `/r/${token}`], ['GET', `/r/${token}/raw`], ['HEAD', `/r/${token}`],
      ['POST', `/api/reports/assets/${assetName}`], ['HEAD', `/api/reports/assets/${assetName}`],
      ['GET', '/api/reports/assets/private.svg'], ['GET', '/report-assets/private.js'],
      ['HEAD', '/report-assets/mermaid.min.js'], ['POST', '/report-assets/mermaid.min.js'],
    ];
    for (const [method, url] of denied) {
      const response = await request(url, method);
      if (url.startsWith('/api/')) expect(response.status, `${method} ${url}`).toBe(401);
      else expect([401, 302], `${method} ${url}`).toContain(response.status);
    }
    expect(state.getAcceptanceReport(reportId)?.shareToken).toBe(token);
    expect(state.listAcceptanceReports(null)).toHaveLength(1);
    expect(state.readReportAsset(assetName)?.data).toEqual(picture);
  });
});
