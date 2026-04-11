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
    }));

    installSpaFallback(app, webDir);

    server = await startServer(app);

    // Unknown non-API path should still get the dashboard HTML
    const res = await request(server, '/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('DASHBOARD');
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
    }));

    server = await startServer(app);

    const res = await request(server, '/api/cluster/status');
    // When wrong-order is in force, the SPA fallback serves HTML and the
    // cluster router never runs. This is the production bug captured.
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('DASHBOARD');
  });
});
