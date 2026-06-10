import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { createServer, installSpaFallback } from '../../src/server.js';
import { createClusterRouter } from '../../src/routes/cluster.js';
import { createSchedulerRouter } from '../../src/scheduler/routes.js';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { CdsConfig } from '../../src/types.js';
import type { ServerEventLogSink, ServerEventRecord } from '../../src/services/server-event-log-store.js';
import type { HttpLogRecord, HttpLogSink } from '../../src/services/http-log-store.js';

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
  headers: http.IncomingHttpHeaders;
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
            headers: res.headers,
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

  function buildRealServerWithEvents(events: ServerEventRecord[]): express.Express {
    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const serverEventLogStore: ServerEventLogSink = {
      record() {},
      async findRecent(filter = {}) {
        const severityRank = { info: 10, warn: 20, error: 30 } as const;
        const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
        return events
          .filter((event) => {
            if (filter.category && event.category !== filter.category) return false;
            if (filter.severity && event.severity !== filter.severity) return false;
            if (filter.minSeverity && severityRank[event.severity] < severityRank[filter.minSeverity]) return false;
            if (filter.source && event.source !== filter.source) return false;
            if (filter.action && event.action !== filter.action) return false;
            if (filter.containerName && event.containerName !== filter.containerName) return false;
            if (filter.branchId && event.branchId !== filter.branchId) return false;
            if (filter.profileId && event.profileId !== filter.profileId) return false;
            if (filter.projectId && event.projectId !== filter.projectId) return false;
            if (filter.requestId && event.requestId !== filter.requestId) return false;
            if (filter.operationId && event.operationId !== filter.operationId && event.details?.operationId !== filter.operationId) return false;
            if (filter.since && event.ts < new Date(filter.since)) return false;
            return true;
          })
          .sort((a, b) => b.ts.getTime() - a.ts.getTime())
          .slice(0, limit);
      },
    };
    return createServer({
      stateService,
      worktreeService: new WorktreeService(new MockShellExecutor(), tmpDir),
      containerService: {} as any,
      proxyService: {
        getProxyLog: () => [],
        setOnProxyLog: () => {},
        handleSwitchFromExpress: (_req: unknown, _res: unknown) => {},
      } as any,
      bridgeService: {} as any,
      shell: new MockShellExecutor(),
      config: makeConfig({ repoRoot: tmpDir, worktreeBase: path.join(tmpDir, 'worktrees') }),
      serverEventLogStore,
    });
  }

  function buildRealServerWithHttpLogs(logs: HttpLogRecord[]): express.Express {
    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const httpLogStore: HttpLogSink = {
      record() {},
      async findRecent(filter = {}) {
        const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
        return logs
          .filter((log) => {
            if (filter.method && log.method !== filter.method.toUpperCase()) return false;
            if (filter.minStatus && log.status < filter.minStatus) return false;
            if (filter.pathContains && !log.path.includes(filter.pathContains)) return false;
            if (filter.since && log.ts < new Date(filter.since)) return false;
            if (filter.until && log.ts > new Date(filter.until)) return false;
            return true;
          })
          .sort((a, b) => b.ts.getTime() - a.ts.getTime())
          .slice(0, limit);
      },
    };
    return createServer({
      stateService,
      worktreeService: new WorktreeService(new MockShellExecutor(), tmpDir),
      containerService: {} as any,
      proxyService: {
        getProxyLog: () => [],
        setOnProxyLog: () => {},
        handleSwitchFromExpress: (_req: unknown, _res: unknown) => {},
      } as any,
      bridgeService: {} as any,
      shell: new MockShellExecutor(),
      config: makeConfig({ repoRoot: tmpDir, worktreeBase: path.join(tmpDir, 'worktrees') }),
      httpLogStore,
    });
  }

  it('real createServer exposes queryable /api/server-events before branch router fallback', async () => {
    const app = buildRealServerWithEvents([
      {
        _id: 'evt-start',
        ts: new Date('2026-05-26T23:00:00.000Z'),
        category: 'system',
        severity: 'info',
        source: 'branch-operation-coordinator',
        action: 'branch.operation.started',
        projectId: 'prd-agent',
        branchId: 'prd-agent-main',
        requestId: 'req-start',
        operationId: 'op-start',
        details: { operationId: 'op-start', trigger: 'webhook', commitSha: '1111111' },
      },
      {
        _id: 'evt-cancel',
        ts: new Date('2026-05-26T23:01:00.000Z'),
        category: 'system',
        severity: 'warn',
        source: 'branch-operation-coordinator',
        action: 'branch.operation.cancelled',
        projectId: 'prd-agent',
        branchId: 'prd-agent-main',
        requestId: 'req-cancel',
        operationId: 'op-cancel',
        details: { operationId: 'op-cancel', trigger: 'manual', actor: 'user' },
      },
    ]);
    server = await startServer(app);

    const res = await request(
      server,
      '/api/server-events?operationId=op-cancel&branchId=prd-agent-main&action=branch.operation.cancelled',
    );

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(false);
    expect(body.total).toBe(1);
    expect(body.events[0].operationId).toBe('op-cancel');
    expect(body.events[0].requestId).toBe('req-cancel');
    expect(body.events[0].details.trigger).toBe('manual');
  });

  it('real createServer treats /_cds/api/* as a master API alias, not SPA HTML', async () => {
    const app = buildRealServerWithEvents([
      {
        _id: 'evt-cds-alias',
        ts: new Date('2026-05-28T09:00:00.000Z'),
        category: 'system',
        severity: 'info',
        source: 'test',
        action: 'alias.probe',
        requestId: 'req-alias',
      },
    ]);
    installSpaFallback(app, webDir);
    server = await startServer(app);

    const res = await request(server, '/_cds/api/server-events?action=alias.probe');

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(res.body).not.toContain('DASHBOARD');
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(body.events[0].requestId).toBe('req-alias');
  });

  it('real createServer rejects invalid /api/server-events since timestamps', async () => {
    const app = buildRealServerWithEvents([]);
    server = await startServer(app);

    const res = await request(server, '/api/server-events?since=not-a-date');

    expect(res.status).toBe(400);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body).error).toBe('invalid_since');
  });

  it('real createServer advertises bundled cdscli version on API responses', async () => {
    const cliDir = path.join(tmpDir, '.claude', 'skills', 'cds', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'cdscli.py'), 'VERSION = "9.8.7"\n');
    const app = buildRealServerWithEvents([]);
    server = await startServer(app);

    const res = await request(server, '/api/server-events');

    expect(res.status).toBe(200);
    expect(res.headers['x-cds-cli-latest']).toBe('9.8.7');
  });

  it('real createServer exposes slow HTTP endpoint rankings from recent samples', async () => {
    const base = {
      _id: 'unused',
      ts: new Date('2026-05-27T08:00:00.000Z'),
      layer: 'master' as const,
      requestId: 'req',
      method: 'GET',
      protocol: 'http',
      host: 'cds.test',
      path: '/api/branches',
      status: 200,
      durationMs: 1,
      outcome: 'ok' as const,
      request: {},
      response: {},
    };
    const app = buildRealServerWithHttpLogs([
      { ...base, _id: '1', requestId: 'r1', path: '/api/branches?project=prd-agent', durationMs: 5 },
      { ...base, _id: '2', requestId: 'r2', path: '/api/branches/prd-agent-main/logs', durationMs: 1200 },
      { ...base, _id: '3', requestId: 'r3', path: '/api/branches/prd-agent-main/logs', durationMs: 800, status: 500, outcome: 'server-error' },
      { ...base, _id: '4', requestId: 'r4', path: '/api/projects/prd-agent', durationMs: 30 },
      { ...base, _id: '5', requestId: 'r5', path: '/api/executors/capacity', durationMs: 60 },
      { ...base, _id: '6', requestId: 'r6', path: '/api/branches/stream', durationMs: 40 },
    ]);
    server = await startServer(app);

    const res = await request(server, '/api/http-logs/slow?sample=1000&top=5&includeNoise=1');

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.sampleSize).toBe(6);
    expect(body.endpoints[0]).toMatchObject({
      method: 'GET',
      endpoint: '/api/branches/:branchId/logs',
      count: 2,
      errorCount: 1,
      maxMs: 1200,
    });
    expect(body.endpoints[0].slowest.requestId).toBe('r2');
    expect(body.endpoints.map((endpoint: { endpoint: string }) => endpoint.endpoint)).toContain('/api/executors/capacity');
    expect(body.endpoints.map((endpoint: { endpoint: string }) => endpoint.endpoint)).toContain('/api/branches/stream');
  });

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
    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

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

    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

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

  it('regression: SPA fallback fails closed for non-API paths when React dist is missing', async () => {
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

    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

    server = await startServer(app);

    // Unknown non-API path must not fall through to stale static HTML.
    const res = await request(server, '/some/spa/route');
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('text/html');
    expect(res.body).not.toContain('DASHBOARD');
  });

  // ── React migration: per-route progressive replacement ──
  //
  // installSpaFallback() owns two layers of routing:
  //
  //   1. /api/* — mounted upstream, never shadowed (the recovery endpoint
  //      POST /api/factory-reset lives here and must always reach its
  //      handler regardless of how many routes the React app claims).
  //   2. The React app (cds/web/dist/) — owns every non-API dashboard path,
  //      plus the /assets/* directory for hashed bundles.
  //
  // These tests pin the contract so a future refactor can't accidentally let
  // dashboard routes regress to static HTML, or worse, let the React SPA
  // fallback start swallowing /api/*.

  it('react mount: when cds/web/dist is missing, dashboard paths are not served from legacy static HTML', async () => {
    const app = buildApp();
    // Point reactDistOverride at a directory that doesn't exist; the helper
    // must warn-and-skip cleanly without crashing.
    installSpaFallback(app, webDir, path.join(tmpDir, 'no-react-dist'));
    server = await startServer(app);

    // Legacy /api/branches (mounted by buildApp) must still return JSON.
    const apiRes = await request(server, '/api/branches');
    expect(apiRes.contentType).toContain('application/json');
    expect(apiRes.body).toContain('"ok":true');

    // /hello would normally be claimed by React, but with no dist on disk it
    // must fail closed instead of serving stale legacy static HTML.
    const hello = await request(server, '/hello');
    expect(hello.status).toBe(404);
    expect(hello.contentType).toContain('text/html');
    expect(hello.body).not.toContain('DASHBOARD');
  });

  it('react mount: serves all dashboard routes from React and leaves recovery API intact', async () => {
    const app = buildApp();

    // Build a fake React dist with the same shape Vite emits.
    const reactDist = path.join(tmpDir, 'react-dist');
    fs.mkdirSync(reactDist, { recursive: true });
    fs.writeFileSync(
      path.join(reactDist, 'index.html'),
      '<html><body data-app="react">REACT_BUNDLE</body></html>',
    );
    fs.mkdirSync(path.join(reactDist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(reactDist, 'assets', 'main-abc.js'), 'console.log("react");');

    // Mount a fake recovery endpoint upstream — it must remain reachable
    // regardless of what installSpaFallback does below.
    const recovery = express.Router();
    recovery.post('/factory-reset', (_req, res) => res.json({ ok: true, reset: true }));
    app.use('/api', recovery);

    installSpaFallback(app, webDir, reactDist, [
      '/hello',
      '/cds-settings',
      '/project-list',
      '/branches',
      '/branch-list',
      '/branch-panel',
      '/branch-topology',
      '/settings',
    ]);
    server = await startServer(app);

    // 1. /hello (a migrated route) returns the React SPA shell.
    const hello = await request(server, '/hello');
    expect(hello.status).toBe(200);
    expect(hello.contentType).toContain('text/html');
    expect(hello.body).toContain('REACT_BUNDLE');
    expect(hello.body).not.toContain('DASHBOARD');

    // 2. /hello/sub (a deep link under a migrated prefix) also lands on
    //    the React shell so client-side routing can resolve it.
    const helloDeep = await request(server, '/hello/sub-route');
    expect(helloDeep.body).toContain('REACT_BUNDLE');

    // 3. /assets/main-abc.js serves the React asset bundle.
    const asset = await request(server, '/assets/main-abc.js');
    expect(asset.status).toBe(200);
    expect(asset.body).toContain('console.log("react")');

    // 4. /api/factory-reset (the recovery endpoint) is NOT shadowed.
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

    // 5. A newly migrated semantic path is also claimed by React.
    const settings = await request(server, '/cds-settings');
    expect(settings.contentType).toContain('text/html');
    expect(settings.body).toContain('REACT_BUNDLE');
    expect(settings.body).not.toContain('DASHBOARD');

    // 6. The project list has also moved to React.
    const projectList = await request(server, '/project-list');
    expect(projectList.contentType).toContain('text/html');
    expect(projectList.body).toContain('REACT_BUNDLE');
    expect(projectList.body).not.toContain('DASHBOARD');

    // 7. Project settings deep links are claimed by React.
    const branchList = await request(server, '/branches/demo-project');
    expect(branchList.contentType).toContain('text/html');
    expect(branchList.body).toContain('REACT_BUNDLE');
    expect(branchList.body).not.toContain('DASHBOARD');

    const legacyBranchList = await request(server, '/branch-list?project=demo-project');
    expect(legacyBranchList.contentType).toContain('text/html');
    expect(legacyBranchList.body).toContain('REACT_BUNDLE');
    expect(legacyBranchList.body).not.toContain('DASHBOARD');

    const branchPanel = await request(server, '/branch-panel?project=demo-project');
    expect(branchPanel.contentType).toContain('text/html');
    expect(branchPanel.body).toContain('REACT_BUNDLE');
    expect(branchPanel.body).not.toContain('DASHBOARD');

    const branchPanelDeep = await request(server, '/branch-panel/demo-branch?project=demo-project');
    expect(branchPanelDeep.body).toContain('REACT_BUNDLE');

    const branchTopology = await request(server, '/branch-topology?project=demo-project');
    expect(branchTopology.body).toContain('REACT_BUNDLE');
    expect(branchTopology.body).not.toContain('DASHBOARD');

    // 8. Project settings deep links are claimed by React.
    const projectSettings = await request(server, '/settings/demo-project');
    expect(projectSettings.contentType).toContain('text/html');
    expect(projectSettings.body).toContain('REACT_BUNDLE');
    expect(projectSettings.body).not.toContain('DASHBOARD');

    const projectSettingsDeep = await request(server, '/settings/demo-project/stats');
    expect(projectSettingsDeep.body).toContain('REACT_BUNDLE');

    // 9. The old settings.html entry redirects to the semantic path.
    const settingsRedirect = await request(server, '/settings.html?project=demo-project');
    expect(settingsRedirect.status).toBe(301);
    expect(settingsRedirect.body).toContain('/settings/demo-project');

    const settingsNoProject = await request(server, '/settings.html');
    expect(settingsNoProject.status).toBe(302);
    expect(settingsNoProject.body).toContain('/project-list');

    // 10. The old basic-auth login filename is retired; it must never serve
    // the legacy HTML file or fall through to the legacy SPA shell.
    const loginRedirect = await request(server, '/login.html?redirect=%2Fcds-settings');
    expect(loginRedirect.status).toBe(301);
    expect(loginRedirect.body).toContain('/login?redirect=%2Fcds-settings');
    expect(loginRedirect.body).not.toContain('DASHBOARD');

    // 11. Unknown non-API paths still resolve to React, which owns the
    // client-side 404/redirect decision.
    const unknown = await request(server, '/some/legacy/route');
    expect(unknown.body).toContain('REACT_BUNDLE');
    expect(unknown.body).not.toContain('DASHBOARD');
  });

  it('regression: SPA fallback installed TOO EARLY now returns JSON 404 (not HTML)', async () => {
    // This test memorializes a production failure mode + the 2026-05-04 hardening.
    //
    // Original bug:installing SPA fallback BEFORE the cluster router meant
    //   `app.get('*')` caught `/api/cluster/status` and served HTML index.html
    //   with status 200 — frontend's apiRequest got HTML body, JSON.parse
    //   silently failed, downstream code crashed on property access.
    //
    // Fix(2026-05-04):installSpaFallback now adds `if (req.path.startsWith('/api/'))
    //   return next()` to the wildcard handler AND registers a `app.use('/api', ...)`
    //   JSON-404 catch-all. So:
    //     - Wrong order(fallback first):API requests still don't reach the
    //       late-mounted router, BUT they get a proper JSON 404 instead of HTML —
    //       frontend can detect missing endpoints cleanly.
    //     - Correct order(fallback last,as installSpaFallback comment instructs):
    //       cluster router runs, returns its real JSON. (Tested by the earlier
    //       'cluster router returns JSON when mounted BEFORE installSpaFallback'
    //       case in this file.)
    const app = buildApp();

    // WRONG ORDER: fallback first
    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

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
    // Post-fix: JSON 404, NOT HTML. Frontend apiRequest sees ApiError(404)
    // and can show a proper "endpoint missing" toast, not a property-access crash.
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(res.body).not.toContain('DASHBOARD');
    const parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    expect(parsed.error).toBe('not_found');
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

    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

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

    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

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

    installSpaFallback(app, webDir, path.join(tmpDir, "no-react-dist"));

    server = await startServer(app);

    // Dashboard UI paths must STILL require cookie auth — we don't want to
    // accidentally expose capacity numbers to anonymous callers.
    const status = await request(server, '/api/cluster/status');
    expect(status.status).toBe(401);

    const list = await request(server, '/api/executors/capacity');
    expect(list.status).toBe(401);
  });
});
