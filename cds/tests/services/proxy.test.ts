import { describe, it, expect, beforeEach } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

describe('ProxyService', () => {
  let stateFile: string;
  let stateService: StateService;
  let proxy: ProxyService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-proxy-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    proxy = new ProxyService(stateService);
  });

  function makeReq(headers: Record<string, string> = {}, url = '/'): http.IncomingMessage {
    return { headers, url } as unknown as http.IncomingMessage;
  }

  describe('resolveBranch', () => {
    it('should resolve from X-Branch header', () => {
      const req = makeReq({ 'x-branch': 'feature/new-ui' });
      expect(proxy.resolveBranch(req)).toBe('feature/new-ui');
    });

    it('should resolve from domain routing rule', () => {
      stateService.addRoutingRule({
        id: 'r1', name: 'Feature', type: 'domain',
        match: '{{feature_*}}.dev.example.com',
        branch: '$1', priority: 0, enabled: true,
      });

      const req = makeReq({ host: 'feature-auth.dev.example.com' });
      expect(proxy.resolveBranch(req)).toBe('feature-auth');
    });

    it('should fall back to default branch', () => {
      stateService.setDefaultBranch('main');
      const req = makeReq({ host: 'anything.com' });
      expect(proxy.resolveBranch(req)).toBe('main');
    });

    it('should resolve from cds_branch cookie', () => {
      const req = makeReq({ cookie: 'cds_branch=claude%2Ffix-worktree-creation-rG5DU' });
      expect(proxy.resolveBranch(req)).toBe('claude/fix-worktree-creation-rG5DU');
    });

    it('should prefer X-Branch header over cookie', () => {
      const req = makeReq({
        'x-branch': 'feature/alpha',
        cookie: 'cds_branch=feature%2Fbeta',
      });
      expect(proxy.resolveBranch(req)).toBe('feature/alpha');
    });

    it('should return null when no rules match and no default', () => {
      const req = makeReq({ host: 'anything.com' });
      expect(proxy.resolveBranch(req)).toBeNull();
    });

    it('should skip disabled rules', () => {
      stateService.addRoutingRule({
        id: 'r1', name: 'Disabled', type: 'domain',
        match: '{{*}}.dev.example.com', branch: '$1',
        priority: 0, enabled: false,
      });
      const req = makeReq({ host: 'test.dev.example.com' });
      expect(proxy.resolveBranch(req)).toBeNull();
    });
  });

  describe('patternToRegex', () => {
    it('should convert simple wildcard pattern', () => {
      const regex = proxy.patternToRegex('{{feature_*}}.dev.example.com');
      expect('feature-auth.dev.example.com').toMatch(new RegExp(regex, 'i'));
      expect('somethingelse.dev.example.com').not.toMatch(new RegExp(regex, 'i'));
    });

    it('should convert pattern with multiple wildcards', () => {
      const regex = proxy.patternToRegex('{{*}}-{{*}}.test.com');
      expect('abc-def.test.com').toMatch(new RegExp(regex, 'i'));
    });

    it('should handle exact match (no wildcards)', () => {
      const regex = proxy.patternToRegex('staging.example.com');
      expect('staging.example.com').toMatch(new RegExp(regex, 'i'));
      expect('other.example.com').not.toMatch(new RegExp(regex, 'i'));
    });
  });

  describe('handleRequest — /_switch/', () => {
    function makeRes(): { res: http.ServerResponse; written: { statusCode: number; headers: Record<string, string>; body: string } } {
      const written = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) { written.statusCode = code; written.headers = headers; },
        end(body?: string) { written.body = body || ''; },
      } as unknown as http.ServerResponse;
      return { res, written };
    }

    it('should set cds_branch cookie and redirect on /_switch/<branch>', () => {
      const req = makeReq({}, '/_switch/claude/fix-worktree-creation-rG5DU');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);
      expect(written.statusCode).toBe(302);
      expect(written.headers['Set-Cookie']).toContain('cds_branch=');
      expect(written.headers['Location']).toBe('/');
    });

    it('should clear cookie on /_clear_branch', () => {
      const req = makeReq({}, '/_clear_branch');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);
      expect(written.statusCode).toBe(302);
      expect(written.headers['Set-Cookie']).toContain('Max-Age=0');
    });
  });

  describe('handleRequest — /_cds internal context', () => {
    function makeRes(): { res: http.ServerResponse; written: { statusCode: number; headers: Record<string, string>; body: string } } {
      const written = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) { written.statusCode = code; written.headers = headers; },
        end(body?: string) { written.body = body || ''; },
      } as unknown as http.ServerResponse;
      return { res, written };
    }

    it('stamps source project and branch headers from preview host', () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'prd-agent',
        slug: 'prd-agent',
        name: 'PRD Agent',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      stateService.addBranch({
        id: 'prd-agent-main',
        projectId: 'prd-agent',
        branch: 'main',
        worktreePath: '/tmp/prd-agent-main',
        services: {},
        status: 'running',
        createdAt: now,
      });
      stateService.save();
      proxy = new ProxyService(stateService, {
        repoRoot: '/tmp/repo',
        worktreeBase: '/tmp/worktrees',
        masterPort: 9900,
        workerPort: 5500,
        dockerNetwork: 'cds-network',
        portStart: 10001,
        sharedEnv: {},
        jwt: { secret: 'test-secret', issuer: 'cds' },
        rootDomains: ['miduo.org'],
      });

      let capturedHeaders: http.IncomingHttpHeaders = {};
      (proxy as any).proxyRequest = (req: http.IncomingMessage) => {
        capturedHeaders = req.headers;
      };

      const req = makeReq({ host: 'main-prd-agent.miduo.org' }, '/_cds/api/build-profiles');
      const { res } = makeRes();
      proxy.handleRequest(req, res);

      expect(capturedHeaders['x-cds-internal']).toBe('1');
      expect(capturedHeaders['x-cds-source-host']).toBe('main-prd-agent.miduo.org');
      expect(capturedHeaders['x-cds-source-project-id']).toBe('prd-agent');
      expect(capturedHeaders['x-cds-source-branch-id']).toBe('prd-agent-main');
      expect(req.url).toBe('/api/build-profiles');
    });
  });

  describe('handleRequest — starting state loading page', () => {
    function makeRes(): { res: http.ServerResponse; written: { statusCode: number; headers: Record<string, string>; body: string } } {
      const written = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) { written.statusCode = code; written.headers = headers; },
        end(body?: string) { written.body = body || ''; },
      } as unknown as http.ServerResponse;
      return { res, written };
    }

    function addBranch(id: string, status: 'running' | 'starting' | 'building' | 'idle' | 'error' | 'restarting' | 'stopping', services: Record<string, { profileId: string; status: string }> = {}) {
      const svcState: Record<string, any> = {};
      for (const [k, v] of Object.entries(services)) {
        svcState[k] = { profileId: v.profileId, containerName: `cds-${id}-${k}`, hostPort: 9000, status: v.status };
      }
      stateService.addBranch({
        id, branch: id, worktreePath: `/tmp/${id}`,
        services: svcState, status, createdAt: new Date().toISOString(),
      });
      stateService.save();
    }

    it('should serve loading page (HTTP 503 + Retry-After) when branch status is starting', () => {
      addBranch('my-branch', 'starting', {
        admin: { profileId: 'admin', status: 'starting' },
      });
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      const req = makeReq({ host: 'localhost' });
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      // 503 + Retry-After lets Cloudflare + browsers know this is transient;
      // the HTML body still renders in the browser. See
      // .claude/rules/cds-auto-deploy.md and proxy.serveStartingPage.
      expect(written.statusCode).toBe(503);
      expect(written.headers['Content-Type']).toContain('text/html');
      expect(written.headers['Retry-After']).toBe('2');
      expect(written.body).toContain('启动中');
      expect(written.body).toContain('magic-rings-canvas');
      expect(written.body).toContain('id="magic-rings"');
      expect(written.body).not.toContain('shape-grid-bg');
      expect(written.body).not.toContain('rings-orbit');
      expect(written.body).not.toContain('class="panel"');
      expect(written.body).toContain('/_cds/waiting-status');
      expect(written.body).toContain('shiny-text');
      expect(written.body).not.toContain('setTimeout(function(){location.reload');
    });

    it('should expose waiting status as JSON so the loading page can poll without reloading', () => {
      proxy = new ProxyService(stateService, { previewDomain: 'preview.test' } as any);
      addBranch('my-branch', 'running', {
        api: { profileId: 'api', status: 'running' },
        admin: { profileId: 'admin', status: 'starting' },
      });

      const req = makeReq({ host: 'my-branch.preview.test', accept: 'application/json' }, '/_cds/waiting-status?profile=admin');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(200);
      expect(written.headers['Content-Type']).toContain('application/json');
      const payload = JSON.parse(written.body) as { ready: boolean; status: string; waitingProfileId: string; services: Array<{ profileId: string; status: string }> };
      expect(payload.ready).toBe(false);
      expect(payload.status).toBe('running');
      expect(payload.waitingProfileId).toBe('admin');
      expect(payload.services).toContainEqual({ profileId: 'admin', status: 'starting' });
    });

    it('should not return waiting-page HTML for module assets while branch is starting', () => {
      addBranch('my-branch', 'starting', {
        admin: { profileId: 'admin', status: 'starting' },
      });
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      const req = makeReq({
        host: 'localhost',
        accept: '*/*',
        'sec-fetch-dest': 'script',
      }, '/node_modules/.vite/deps/react.js?v=123');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(503);
      expect(written.headers['Content-Type']).toContain('application/javascript');
      expect(written.body).toContain('CDS preview is not ready');
      expect(written.body).not.toContain('<!DOCTYPE html>');
      expect(written.body).not.toContain('CDS Waiting Room');
    });

    it('should not return waiting-page HTML for css module requests while target service is starting', () => {
      addBranch('my-branch', 'running', {
        api: { profileId: 'api', status: 'running' },
        admin: { profileId: 'admin', status: 'starting' },
      });
      stateService.addBuildProfile({
        id: 'api', name: 'API', dockerImage: 'dotnet:8', workDir: 'api',
        containerPort: 5000, pathPrefixes: ['/api/'],
      });
      stateService.addBuildProfile({
        id: 'admin', name: 'Admin', dockerImage: 'node:20', workDir: 'admin',
        containerPort: 5173,
      });
      stateService.setDefaultBranch('my-branch');
      stateService.save();
      proxy.setResolveUpstream(() => 'http://localhost:9000');

      const req = makeReq({
        host: 'localhost',
        accept: '*/*',
        'sec-fetch-dest': 'script',
      }, '/src/globals.css');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(503);
      expect(written.headers['Content-Type']).toContain('text/css');
      expect(written.body).toContain('CDS preview is not ready');
      expect(written.body).not.toContain('<!DOCTYPE html>');
    });

    it('should serve terminal error page without triggering auto-build or auto-refresh', () => {
      addBranch('my-branch', 'error', {
        api: { profileId: 'api', status: 'error' },
      });
      const branch = stateService.getBranch('my-branch');
      if (branch) branch.errorMessage = 'api: dotnet build failed';
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      let autoBuildCalled = false;
      proxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = makeReq({ host: 'localhost', accept: 'text/html' }, '/');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(false);
      expect(written.statusCode).toBe(503);
      expect(written.body).toContain('分支部署出现异常');
      expect(written.body).toContain('api: dotnet build failed');
      expect(written.body).not.toContain('location.reload()');
    });

    it('should serve loading page when target service is starting but branch is running', () => {
      addBranch('my-branch', 'running', {
        api: { profileId: 'api', status: 'running' },
        admin: { profileId: 'admin', status: 'starting' },
      });
      stateService.addBuildProfile({
        id: 'api', name: 'API', dockerImage: 'dotnet:8', workDir: 'api',
        containerPort: 5000, pathPrefixes: ['/api/'],
      });
      stateService.addBuildProfile({
        id: 'admin', name: 'Admin', dockerImage: 'node:20', workDir: 'admin',
        containerPort: 5173,
      });
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      // Must set resolveUpstream — proxy checks it before profile detection
      proxy.setResolveUpstream(() => 'http://localhost:9000');

      // Request to admin (non-API path) → should hit the starting admin service
      const req = makeReq({ host: 'localhost' }, '/dashboard');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(503);
      expect(written.headers['Content-Type']).toContain('text/html');
      expect(written.body).toContain('启动中');
      expect(written.body).toContain('admin');
    });

    it('should serve loading page (not auto-build) when branch is already building', () => {
      // 'building' is a loading state — a build is already in progress, so
      // firing another onAutoBuild would race the running deploy. Loading
      // page auto-refreshes until the build flips status to 'running'.
      addBranch('my-branch', 'building', {});
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      let autoBuildCalled = false;
      proxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = makeReq({ host: 'localhost' }, '/');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(false);
      expect(written.statusCode).toBe(503);
      expect(written.body).toContain('构建中');
    });

    it('should proxy to upstream when target service is running', () => {
      addBranch('my-branch', 'running', {
        admin: { profileId: 'admin', status: 'running' },
      });
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      let resolvedUpstream = '';
      proxy.setResolveUpstream((_branchSlug, _profileId) => { resolvedUpstream = 'http://localhost:9000'; return resolvedUpstream; });

      // Use a mock req with pipe to avoid TypeError in proxyRequest
      const req = { headers: { host: 'localhost' }, url: '/', pipe: () => {} } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      proxy.handleRequest(req, res);

      expect(resolvedUpstream).toBe('http://localhost:9000');
    });

    it('should not trigger auto-build for existing idle branches from a preview visit', () => {
      // Existing idle branches require an explicit redeploy action from the
      // control plane. A passive preview-page visit must not create a deploy
      // loop or hide the current terminal status.
      addBranch('my-branch', 'idle', {});
      stateService.setDefaultBranch('my-branch');
      stateService.save();

      let autoBuildCalled = false;
      proxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = makeReq({ host: 'localhost' }, '/');
      const { res } = makeRes();
      proxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(false);
    });

    it('should serve HTML "branch gone" fallback for unknown branch when no onAutoBuild is wired', () => {
      // Executor-only / misconfigured mode: no auto-build hook. Without this
      // fallback the user used to land on Chrome's raw "HTTP ERROR 400/503"
      // blank page. Now we return a 404 HTML that explains the situation.
      stateService.setDefaultBranch('missing-branch');
      stateService.save();
      // Deliberately DO NOT call setOnAutoBuild

      const req = makeReq({ host: 'localhost', accept: 'text/html,*/*' }, '/');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(404);
      expect(written.headers['Content-Type']).toContain('text/html');
      expect(written.body).toContain('预览已下线');
      expect(written.body).toContain('missing-branch');
    });

    it('should still return JSON 404 for API clients (non-HTML Accept) when branch missing', () => {
      stateService.setDefaultBranch('missing-branch');
      stateService.save();

      const req = makeReq({ host: 'localhost', accept: 'application/json' }, '/api/x');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(404);
      expect(written.headers['Content-Type']).toContain('application/json');
      expect(written.body).toContain('not-found');
    });

    it('should serve HTML fallback when no routing rule matches and no default branch', () => {
      // No branches, no rules, no default. Browser request (Accept: text/html)
      // gets the friendly page instead of a 502 JSON.
      const req = makeReq({ host: 'stranger.example.com', accept: 'text/html' }, '/');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);

      expect(written.statusCode).toBe(404);
      expect(written.headers['Content-Type']).toContain('text/html');
      expect(written.body).toContain('预览已下线');
    });
  });

  describe('preview subdomain — 三档解析（v3 优先 / v1 / v2 兼容）', () => {
    // 子域名 `<slug>.<root>` 拿到裸 slug 后，proxy 按
    // ① v3 前向匹配 → ② v1 裸 slug 直查 → ③ v2 `${projectSlug}-${slug}` 拼接
    // 的顺序解析。任何一档命中就返回，三档都 miss 才走 auto-build。
    function makeRes(): { res: http.ServerResponse; written: { statusCode: number; headers: Record<string, string>; body: string } } {
      const written = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) { written.statusCode = code; written.headers = headers; },
        end(body?: string) { written.body = body || ''; },
      } as unknown as http.ServerResponse;
      return { res, written };
    }

    it('① v3 前向匹配：tail-prefix-project 子域名命中正确 entry', () => {
      // 用户访问的是新格式 URL，例如
      // https://fix-refresh-error-handling-2xayx-claude-prd-agent.miduo.org/
      stateService.addProject({
        id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git',
        legacyFlag: false, createdAt: new Date().toISOString(),
      } as any);
      stateService.addBranch({
        id: 'prd-agent-claude-fix-refresh-error-handling-2xayx',
        projectId: 'prd-agent',
        branch: 'claude/fix-refresh-error-handling-2Xayx',
        worktreePath: '/tmp/v3',
        services: { admin: { profileId: 'admin', containerName: 'cds-v3-admin', hostPort: 9100, status: 'running' } },
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      const previewProxy = new ProxyService(stateService, {
        masterPort: 9900, workerPort: 5500,
        repoRoot: '/tmp', worktreeBase: '/tmp', portStart: 9000,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      } as any);

      let upstreamCalledWith: { branchId: string } | null = null;
      previewProxy.setResolveUpstream((branchId) => {
        upstreamCalledWith = { branchId };
        return 'http://127.0.0.1:9100';
      });
      let autoBuildCalled = false;
      previewProxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = {
        headers: { host: 'fix-refresh-error-handling-2xayx-claude-prd-agent.preview.example.com' },
        url: '/',
        pipe: () => {},
      } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      previewProxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(false);
      expect(upstreamCalledWith).not.toBeNull();
      // 命中的应该是 entry.id（不是 v3 slug 字面量）
      expect(upstreamCalledWith!.branchId).toBe('prd-agent-claude-fix-refresh-error-handling-2xayx');
    });

    it('③ v2 兼容：旧 `prd-agent-claude-fix-foo.miduo.org` 链接仍可解析', () => {
      // ceb2c01 ~ 本次改造之间外发的链接，proxy 必须继续解析
      stateService.addProject({
        id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git',
        legacyFlag: false, createdAt: new Date().toISOString(),
      } as any);
      stateService.addBranch({
        id: 'prd-agent-claude-fix-foo',
        projectId: 'prd-agent',
        branch: 'claude/fix-foo',
        worktreePath: '/tmp/v2',
        services: { admin: { profileId: 'admin', containerName: 'cds-v2-admin', hostPort: 9000, status: 'running' } },
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      const previewProxy = new ProxyService(stateService, {
        masterPort: 9900, workerPort: 5500,
        repoRoot: '/tmp', worktreeBase: '/tmp', portStart: 9000,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      } as any);

      let upstreamCalledWith: { branchId: string } | null = null;
      previewProxy.setResolveUpstream((branchId) => {
        upstreamCalledWith = { branchId };
        return 'http://127.0.0.1:9000';
      });
      let autoBuildCalled = false;
      previewProxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      // 旧 v2 URL：项目名做前缀
      const req = {
        headers: { host: 'prd-agent-claude-fix-foo.preview.example.com' },
        url: '/',
        pipe: () => {},
      } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      previewProxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(false);
      expect(upstreamCalledWith!.branchId).toBe('prd-agent-claude-fix-foo');
    });

    it('should resolve a bare-slug subdomain to a project-scoped canonical entry', () => {
      // 模拟一个非 legacy 项目：分支 entry 存在 canonical id `prd-agent-claude-fix-foo`
      // 下，子域名只带裸 slug `claude-fix-foo`。
      stateService.addProject({
        id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git',
        legacyFlag: false, createdAt: new Date().toISOString(),
      } as any);
      stateService.addBranch({
        id: 'prd-agent-claude-fix-foo',
        projectId: 'prd-agent',
        branch: 'claude/fix-foo',
        worktreePath: '/tmp/x',
        services: {
          admin: { profileId: 'admin', containerName: 'cds-x-admin', hostPort: 9000, status: 'running' },
        },
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      // Configure preview routing for the test.
      // We do NOT use stateService config — the proxy reads its own
      // `config` constructor arg, so re-create with previewDomain set.
      const previewProxy = new ProxyService(stateService, {
        masterPort: 9900, workerPort: 5500,
        repoRoot: '/tmp', worktreeBase: '/tmp', portStart: 9000,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      } as any);

      let upstreamCalledWith: { branchId: string; profileId: string | undefined } | null = null;
      previewProxy.setResolveUpstream((branchId, profileId) => {
        upstreamCalledWith = { branchId, profileId };
        return 'http://127.0.0.1:9000';
      });
      let autoBuildCalled = false;
      previewProxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = {
        headers: { host: 'claude-fix-foo.preview.example.com' },
        url: '/',
        pipe: () => {},
      } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      previewProxy.handleRequest(req, res);

      // 关键断言：不应再触发 auto-build；resolveUpstream 应该用 canonical id 调用
      expect(autoBuildCalled).toBe(false);
      expect(upstreamCalledWith).not.toBeNull();
      expect(upstreamCalledWith!.branchId).toBe('prd-agent-claude-fix-foo');
    });

    it('should still fall through to auto-build when neither bare slug nor canonical id matches', () => {
      const previewProxy = new ProxyService(stateService, {
        masterPort: 9900, workerPort: 5500,
        repoRoot: '/tmp', worktreeBase: '/tmp', portStart: 9000,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      } as any);
      let autoBuildCalled = false;
      previewProxy.setOnAutoBuild(() => { autoBuildCalled = true; });

      const req = {
        headers: { host: 'totally-new-branch.preview.example.com' },
        url: '/',
        pipe: () => {},
      } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      previewProxy.handleRequest(req, res);

      expect(autoBuildCalled).toBe(true);
    });

    it('should prefer exact bare-slug match over a canonical-id suffix match', () => {
      // 两条 entry：`legacy-slug`（legacy project，id == slug）与
      // `other-proj-legacy-slug`（非 legacy）。子域名命中裸 entry 时
      // direct lookup 应该胜出，不被 canonical 兜底"抢走"。
      // 默认 project 在 StateService 初始化时已自动 seed（id=default,
      // legacyFlag=true），这里只补一个非 legacy 的 other-proj。
      stateService.addProject({
        id: 'other-proj', slug: 'other-proj', name: 'Other', kind: 'git',
        legacyFlag: false, createdAt: new Date().toISOString(),
      } as any);
      stateService.addBranch({
        id: 'legacy-slug',
        projectId: 'default',
        branch: 'legacy-slug',
        worktreePath: '/tmp/a',
        services: { admin: { profileId: 'admin', containerName: 'cds-a-admin', hostPort: 9001, status: 'running' } },
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      stateService.addBranch({
        id: 'other-proj-legacy-slug',
        projectId: 'other-proj',
        branch: 'legacy-slug',
        worktreePath: '/tmp/b',
        services: { admin: { profileId: 'admin', containerName: 'cds-b-admin', hostPort: 9002, status: 'running' } },
        status: 'running',
        createdAt: new Date().toISOString(),
      });
      const previewProxy = new ProxyService(stateService, {
        masterPort: 9900, workerPort: 5500,
        repoRoot: '/tmp', worktreeBase: '/tmp', portStart: 9000,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      } as any);

      let upstreamCalledWith: { branchId: string; profileId: string | undefined } | null = null;
      previewProxy.setResolveUpstream((branchId, profileId) => {
        upstreamCalledWith = { branchId, profileId };
        return 'http://127.0.0.1:9001';
      });

      const req = {
        headers: { host: 'legacy-slug.preview.example.com' },
        url: '/',
        pipe: () => {},
      } as unknown as http.IncomingMessage;
      const { res } = makeRes();
      previewProxy.handleRequest(req, res);

      expect(upstreamCalledWith).not.toBeNull();
      expect(upstreamCalledWith!.branchId).toBe('legacy-slug');
    });
  });

  describe('matchRule', () => {
    it('should match domain rule and extract capture group', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'domain', match: '{{agent_*}}.dev.com', branch: '$1', priority: 0, enabled: true },
        'agent-chat.dev.com', '/',
      );
      expect(result).toBe('agent-chat');
    });

    it('should match URL pattern rule', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'pattern', match: '/preview/{{*}}/', branch: '$1', priority: 0, enabled: true },
        'localhost', '/preview/feature-auth/',
      );
      expect(result).toBe('feature-auth');
    });

    it('should return null for non-matching rule', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'domain', match: '{{agent_*}}.dev.com', branch: '$1', priority: 0, enabled: true },
        'other.com', '/',
      );
      expect(result).toBeNull();
    });
  });

  describe('subdomain alias resolution (via extractPreviewBranch)', () => {
    // ProxyService.extractPreviewBranch is private — we reach it via any-cast
    // because the alternative (full HTTP dance through handleRequest with
    // a mock upstream) is much heavier and obscures the unit being tested.
    // This is a surgical whitebox test of the alias override path.
    type ProxyWithPrivate = ProxyService & {
      extractPreviewBranch(host: string): string | null;
    };

    const makeProxy = (): ProxyWithPrivate => {
      const p = new ProxyService(stateService, {
        repoRoot: '/repo',
        worktreeBase: '/wt',
        masterPort: 9900,
        workerPort: 5500,
        dockerNetwork: 'cds-net',
        portStart: 10000,
        sharedEnv: {},
        jwt: { secret: 's', issuer: 'i' },
        mode: 'standalone',
        executorPort: 9901,
        previewDomain: 'preview.example.com',
        rootDomains: ['preview.example.com'],
      });
      return p as ProxyWithPrivate;
    };

    const addBranch = (id: string, aliases?: string[]) => {
      stateService.addBranch({
        id,
        branch: id,
        worktreePath: `/wt/${id}`,
        services: {},
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
        ...(aliases ? { subdomainAliases: aliases } : {}),
      });
    };

    it('falls back to slug when no alias matches', () => {
      const p = makeProxy();
      addBranch('feat-a');
      expect(p.extractPreviewBranch('feat-a.preview.example.com')).toBe('feat-a');
    });

    it('returns branch id when an alias matches', () => {
      const p = makeProxy();
      addBranch('feat-long-slug-id', ['demo']);
      expect(p.extractPreviewBranch('demo.preview.example.com')).toBe('feat-long-slug-id');
    });

    it('alias match is case-insensitive', () => {
      const p = makeProxy();
      addBranch('feat-a', ['paypal-webhook']);
      expect(p.extractPreviewBranch('PAYPAL-WEBHOOK.preview.example.com')).toBe('feat-a');
    });

    it('alias wins over a branch whose slug happens to be the same', () => {
      // Edge case: branch A has slug "demo", branch B has alias "demo".
      // Branch B's alias wins because aliases are checked before slug fallback.
      const p = makeProxy();
      addBranch('demo');
      addBranch('feat-b', ['demo']);
      expect(p.extractPreviewBranch('demo.preview.example.com')).toBe('feat-b');
    });

    it('returns null when host is not under any configured rootDomain', () => {
      const p = makeProxy();
      addBranch('feat-a', ['demo']);
      expect(p.extractPreviewBranch('demo.other-domain.com')).toBeNull();
    });

    it('ignores port suffix in host header', () => {
      const p = makeProxy();
      addBranch('feat-a', ['demo']);
      expect(p.extractPreviewBranch('demo.preview.example.com:8080')).toBe('feat-a');
    });
  });
});
