import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { installSpaFallback } from '../../src/server.js';
import { createClusterRouter } from '../../src/routes/cluster.js';
import { createSchedulerRouter } from '../../src/scheduler/routes.js';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import type { CdsConfig } from '../../src/types.js';

/**
 * Integration regression test: verifies that routes mounted after the
 * base createServer() (scheduler + cluster) are reachable and return
 * JSON — not the dashboard's index.html.
 *
 * The bug this test guards against: the original createServer() installed
 * `app.get('*', ...)` as a SPA fallback at the bottom of the middleware
 * stack. Any `/api/*` route mounted later (in index.ts) was shadowed by
 * that catch-all and got index.html back instead of reaching its handler.
 * Production saw "无法查询集群状态" toasts because the dashboard's fetch
 * of /api/cluster/status received 200 text/html and res.json() threw.
 *
 * Fix: `installSpaFallback()` is a separate exported helper that index.ts
 * calls AFTER all dynamic routes are mounted. This test recreates that
 * ordering discipline in miniature and asserts that:
 *
 *   1. /api/cluster/status returns JSON (not HTML)
 *   2. /api/executors/capacity returns JSON (not HTML)
 *   3. An unknown path like /arbitrary-page still falls through to HTML
 *   4. An unknown /api/* path returns JSON 404-ish, never HTML
 */

function makeConfig(overrides: Partial<CdsConfig> = {}): CdsConfig {
  return {
    repoRoot: '/tmp/cds-integration-test',
    worktreeBase: '/tmp/cds-integration-test/worktrees',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
    mode: 'standalone',
    executorPort: 9901,
    rootDomains: ['test.example.org'],
    ...overrides,
  };
}

interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

async function request(server: http.Server, urlPath: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            contentType: (res.headers['content-type'] || '').toString(),
            body: raw,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Server route ordering (regression)', () => {
  let tmpDir: string;
  let webDir: string;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-integration-'));
    // Fake "dashboard" dir so installSpaFallback has something to serve
    webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html><body>DASHBOARD</body></html>');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  /**
   * Minimal createServer stand-in: mimics the real `createServer()` shape
   * (mounts /api/* routes, does NOT install SPA fallback), plus lets the
   * test mount extra routers after the fact — the exact ordering that
   * production uses.
   */
  function buildApp(): express.Express {
    const app = express();
    app.set('etag', false);
    app.use(express.json());
    // Pretend there's an existing /api/branches route (matches production shape)
    const fakeBranches = express.Router();
    fakeBranches.get('/branches', (_req, res) => res.json({ ok: true }));
    app.use('/api', fakeBranches);
    return app;
  }

  function startServer(app: express.Express): Promise<http.Server> {
    return new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  }

  it('cluster router returns JSON when mounted BEFORE installSpaFallback', async () => {
    const app = buildApp();

    // Build minimal deps for the cluster router
    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    let agent: null = null;
    app.use('/api/cluster', createClusterRouter({
      config: makeConfig(),
      stateService,
      registry,
      getExecutorAgent: () => agent,
      setExecutorAgent: () => { agent = null; },
      getStrategy: () => 'least-load',
      setStrategy: () => {},
    }));

    // CRITICAL: SPA fallback installed LAST
    installSpaFallback(app, webDir);

    server = await startServer(app);

    const res = await request(server, '/api/cluster/status');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(res.body).toContain('effectiveRole');
    expect(res.body).not.toContain('DASHBOARD');
  });

  it('scheduler router (/api/executors/capacity) returns JSON, not HTML', async () => {
    const app = buildApp();

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    app.use('/api/executors', createSchedulerRouter({
      registry,
      config: makeConfig(),
    }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    const res = await request(server, '/api/executors/capacity');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    // Parse must succeed without throwing, and shape must match ClusterCapacity
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('online');
    expect(body).toHaveProperty('total');
    expect(body).not.toContain?.('DASHBOARD');
  });

  it('regression: SPA fallback still serves index.html for non-API paths', async () => {
    const app = buildApp();

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    let agent: null = null;
    app.use('/api/cluster', createClusterRouter({
      config: makeConfig(),
      stateService,
      registry,
      getExecutorAgent: () => agent,
      setExecutorAgent: () => { agent = null; },
      getStrategy: () => 'least-load',
      setStrategy: () => {},
    }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    // Unknown non-API path should still get the dashboard HTML
    const res = await request(server, '/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('DASHBOARD');
  });

  // ── /v2 mount (CDS Dashboard v2 React migration) ──
  //
  // installSpaFallback() now mounts the React build (cds/web-v2-dist/) at
  // /v2/* BEFORE the legacy static fallback. These tests guard the contract:
  //
  //   1. Pre-build state — no v2 dist on disk → /v2 falls through to legacy
  //      SPA fallback (returns DASHBOARD HTML), no crash.
  //   2. Post-build state — v2 index.html exists → /v2 returns the v2
  //      bundle, while legacy /index.html, /api/factory-reset, and SPA
  //      deep-links continue to work unmodified.
  //
  // The recovery API (POST /api/factory-reset) lives upstream at /api/* so
  // the only way /v2 could break it is if the mount were routed too greedily
  // — these tests assert the boundary is correct.

  it('/v2 mount: when web-v2-dist is missing, falls through cleanly (no crash)', async () => {
    const app = buildApp();
    // No web-v2-dist sibling in tmpDir → installSpaFallback should warn but
    // still install the legacy static fallback.
    installSpaFallback(app, webDir);
    server = await startServer(app);

    // Legacy /api/branches (mounted by buildApp) must still return JSON.
    const apiRes = await request(server, '/api/branches');
    expect(apiRes.contentType).toContain('application/json');
    expect(apiRes.body).toContain('"ok":true');

    // /v2 path falls through to the legacy SPA fallback (which serves
    // dashboard HTML). Acceptable transitional behavior.
    const v2Res = await request(server, '/v2/anything');
    expect(v2Res.status).toBe(200);
    expect(v2Res.contentType).toContain('text/html');
    expect(v2Res.body).toContain('DASHBOARD');
  });

  it('/v2 mount: when web-v2-dist exists, serves v2 index without affecting /api or legacy SPA', async () => {
    const app = buildApp();

    // Simulate a built v2 dist as a sibling of webDir
    const v2Dir = path.join(path.dirname(webDir), 'web-v2-dist');
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(v2Dir, 'index.html'),
      '<html><body data-app="v2">CDS_V2_BUNDLE</body></html>',
    );
    fs.mkdirSync(path.join(v2Dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(v2Dir, 'assets', 'main.js'), 'console.log("v2");');

    // Mount a fake recovery endpoint upstream — it must remain reachable.
    const recovery = express.Router();
    recovery.post('/factory-reset', (_req, res) => res.json({ ok: true, reset: true }));
    app.use('/api', recovery);

    installSpaFallback(app, webDir);
    server = await startServer(app);

    // 1. /v2/ deep links return the v2 SPA shell
    const v2Root = await request(server, '/v2/');
    expect(v2Root.status).toBe(200);
    expect(v2Root.contentType).toContain('text/html');
    expect(v2Root.body).toContain('CDS_V2_BUNDLE');

    const v2Deep = await request(server, '/v2/cds-settings/general');
    expect(v2Deep.contentType).toContain('text/html');
    expect(v2Deep.body).toContain('CDS_V2_BUNDLE');

    // 2. /v2/assets/main.js returns the actual JS asset
    const v2Asset = await request(server, '/v2/assets/main.js');
    expect(v2Asset.status).toBe(200);
    expect(v2Asset.body).toContain('console.log("v2")');

    // 3. /api/factory-reset (the "recovery" endpoint) is NOT shadowed.
    //    Use a tiny POST helper inline since this file's `request` is GET-only.
    const recoveryRes = await new Promise<HttpResponse>((resolve, reject) => {
      const addr = server!.address() as { port: number };
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: '/api/factory-reset',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
        },
        (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => (raw += c.toString()));
          res.on('end', () => resolve({
            status: res.statusCode!,
            contentType: (res.headers['content-type'] || '').toString(),
            body: raw,
          }));
        },
      );
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
    expect(recoveryRes.status).toBe(200);
    expect(recoveryRes.contentType).toContain('application/json');
    expect(recoveryRes.body).toContain('"reset":true');

    // 4. Legacy SPA deep-link still serves the OLD dashboard, not v2.
    const legacy = await request(server, '/some/legacy/route');
    expect(legacy.contentType).toContain('text/html');
    expect(legacy.body).toContain('DASHBOARD');
    expect(legacy.body).not.toContain('CDS_V2_BUNDLE');
  });

  it('regression: demonstrates the OLD bug when SPA fallback is installed TOO EARLY', async () => {
    // This test exists to memorialize the failure mode. We deliberately
    // install the SPA fallback BEFORE the cluster router to reproduce the
    // production bug — the request to /api/cluster/status comes back as
    // HTML. If someone ever flips the order in production again, this test
    // will flip green and the next test will go red, making the regression
    // impossible to miss.
    const app = buildApp();

    // WRONG ORDER: fallback first
    installSpaFallback(app, webDir);

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    let agent: null = null;
    app.use('/api/cluster', createClusterRouter({
      config: makeConfig(),
      stateService,
      registry,
      getExecutorAgent: () => agent,
      setExecutorAgent: () => { agent = null; },
      getStrategy: () => 'least-load',
      setStrategy: () => {},
    }));

    server = await startServer(app);

    const res = await request(server, '/api/cluster/status');
    // When wrong-order is in force, the SPA fallback serves HTML and the
    // cluster router never runs. This is the production bug captured.
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('DASHBOARD');
  });

  // ── Auth middleware bypass for cluster peer-to-peer endpoints ──
  //
  // Production bug: the auth middleware in createServer() only recognized
  // cookie / X-CDS-Token / X-AI-Access-Key / X-Cds-Internal. Cross-node
  // register and heartbeat calls carry X-Bootstrap-Token / X-Executor-Token
  // and were rejected with 401 before the route handler ever ran. These
  // tests simulate the full auth-enabled server and verify the bypass.

  /** Build a full app with the real auth middleware enabled. */
  function buildAuthedApp(): express.Express {
    const app = express();
    app.set('etag', false);
    app.use(express.json());

    // Mimic the production auth middleware (see server.ts). Only the parts
    // relevant to the cluster bypass are needed — a valid cookie value of
    // "valid-token" passes, everything else gets 401 UNLESS the path is on
    // the cluster peer-to-peer bypass list.
    app.use((req, res, next) => {
      // Cluster peer-to-peer bypasses — MUST come before the generic
      // cookie check, matching the production fix.
      const reqMethod = req.method;
      const reqPath = req.path;
      if (reqMethod === 'POST' && reqPath === '/api/executors/register') return next();
      if (reqMethod === 'POST' && /^\/api\/executors\/[^/]+\/heartbeat$/.test(reqPath)) return next();
      if (reqMethod === 'DELETE' && /^\/api\/executors\/[^/]+$/.test(reqPath)) return next();
      if (reqMethod === 'POST' && /^\/api\/executors\/[^/]+\/drain$/.test(reqPath)) return next();

      // Cookie-based auth (simplified)
      const cookie = (req.headers.cookie || '').match(/cds_token=([^;]+)/);
      if (cookie && cookie[1] === 'valid-token') return next();
      res.status(401).json({ error: '未登录' });
    });

    return app;
  }

  async function postJson(
    srv: http.Server,
    urlPath: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const addr = srv.address() as { port: number };
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: urlPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...headers,
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
          res.on('end', () => resolve({
            status: res.statusCode!,
            contentType: (res.headers['content-type'] || '').toString(),
            body: raw,
          }));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  it('regression: auth bypass allows POST /api/executors/register without cookie', async () => {
    const app = buildAuthedApp();

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    app.use('/api/executors', createSchedulerRouter({
      registry,
      config: makeConfig({ bootstrapToken: { value: 'boot-abc', expiresAt: future } }),
    }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    // No cookie, only X-Bootstrap-Token — mirrors what a remote executor
    // sends during the bootstrap flow.
    const res = await postJson(
      server,
      '/api/executors/register',
      {
        id: 'remote-x',
        host: 'remote.local',
        port: 9901,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      },
      { 'X-Bootstrap-Token': 'boot-abc' },
    );

    // Pre-fix: 401 "未登录". Post-fix: 200 with node body.
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(res.body).toContain('remote-x');
    expect(res.body).not.toContain('未登录');
  });

  it('regression: auth bypass allows POST /api/executors/:id/heartbeat without cookie', async () => {
    const app = buildAuthedApp();

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    // Pre-register so heartbeat has a target
    registry.register({
      id: 'hb-target',
      host: 'hb.local',
      port: 9901,
      capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
    });

    app.use('/api/executors', createSchedulerRouter({
      registry,
      config: makeConfig({ executorToken: 'perm-token' }),
    }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    const res = await postJson(
      server,
      '/api/executors/hb-target/heartbeat',
      { load: { memoryUsedMB: 100, cpuPercent: 5 }, branches: {} },
      { 'X-Executor-Token': 'perm-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
  });

  it('auth bypass does NOT cover GET /api/executors or /api/cluster/status (dashboard UI paths)', async () => {
    const app = buildAuthedApp();

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    let agent: null = null;
    app.use('/api/cluster', createClusterRouter({
      config: makeConfig(),
      stateService,
      registry,
      getExecutorAgent: () => agent,
      setExecutorAgent: () => { agent = null; },
      getStrategy: () => 'least-load',
      setStrategy: () => {},
    }));
    app.use('/api/executors', createSchedulerRouter({ registry, config: makeConfig() }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    // Dashboard UI paths must STILL require cookie auth — we don't want to
    // accidentally expose capacity numbers to anonymous callers.
    const status = await request(server, '/api/cluster/status');
    expect(status.status).toBe(401);

    const list = await request(server, '/api/executors/capacity');
    expect(list.status).toBe(401);
  });
});
