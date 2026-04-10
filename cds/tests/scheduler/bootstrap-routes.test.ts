import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import { createSchedulerRouter } from '../../src/scheduler/routes.js';
import type { CdsConfig } from '../../src/types.js';

/**
 * Tests for the cluster bootstrap register flow in `scheduler/routes.ts`.
 *
 * Strategy: spin up a real express app backed by an ephemeral port, hit
 * it with `http.request`, and assert on the registry + callbacks. No
 * supertest dependency — same pattern as `tests/routes/branches.test.ts`.
 */

function makeConfig(overrides: Partial<CdsConfig> = {}): CdsConfig {
  return {
    repoRoot: '/tmp/cds-bootstrap-test',
    worktreeBase: '/tmp/cds-bootstrap-test/worktrees',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
    mode: 'scheduler',
    executorPort: 9901,
    ...overrides,
  };
}

interface HttpResponse {
  status: number;
  body: unknown;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(
  config: CdsConfig,
  stateService: StateService,
  registry: ExecutorRegistry,
  hooks: {
    onFirstRegister?: (executorId: string) => Promise<void> | void;
    onBootstrapConsumed?: () => Promise<string> | string;
  } = {},
): Promise<http.Server> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/executors',
    createSchedulerRouter({
      registry,
      config,
      onFirstRegister: hooks.onFirstRegister,
      onBootstrapConsumed: hooks.onBootstrapConsumed,
    }),
  );
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function defaultBody(id = 'exec-a') {
  return {
    id,
    host: `${id}.local`,
    port: 9900,
    capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
    labels: [],
    role: 'remote',
  };
}

describe('Scheduler bootstrap routes', () => {
  let tmpDir: string;
  let stateFile: string;
  let stateService: StateService;
  let registry: ExecutorRegistry;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bootstrap-routes-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    registry = new ExecutorRegistry(stateService);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    registry.stopHealthChecks();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  // ── POST /register — bootstrap token happy path ──

  describe('POST /api/executors/register', () => {
    it('accepts a valid bootstrap token and returns the permanent token in the body', async () => {
      const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const config = makeConfig({
        bootstrapToken: { value: 'boot-xyz', expiresAt: futureIso },
      });

      const mintedToken = 'minted-permanent-token';
      let consumed = 0;
      server = await startServer(config, stateService, registry, {
        onBootstrapConsumed: () => {
          consumed += 1;
          return mintedToken;
        },
      });

      const res = await request(server, 'POST', '/api/executors/register', defaultBody(), {
        'X-Bootstrap-Token': 'boot-xyz',
      });

      expect(res.status).toBe(200);
      const body = res.body as {
        node: { id: string };
        permanentToken: string;
        masterInfo: { mode: string };
      };
      expect(body.node.id).toBe('exec-a');
      expect(body.permanentToken).toBe(mintedToken);
      expect(body.masterInfo.mode).toBe('scheduler');
      expect(consumed).toBe(1);
      // Registry should now hold the new executor
      expect(registry.getAll().map((n) => n.id)).toContain('exec-a');
    });

    it('rejects an expired bootstrap token with 401', async () => {
      // Expired more than TOKEN_CLOCK_SKEW_MS (60s) ago so it cannot be accepted
      const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const config = makeConfig({
        bootstrapToken: { value: 'expired-token', expiresAt: pastIso },
      });

      server = await startServer(config, stateService, registry);

      const res = await request(server, 'POST', '/api/executors/register', defaultBody(), {
        'X-Bootstrap-Token': 'expired-token',
      });

      expect(res.status).toBe(401);
      const body = res.body as { error: string };
      expect(body.error).toContain('expired');
      expect(registry.getAll()).toHaveLength(0);
    });

    it('rejects a mismatched bootstrap token with 401', async () => {
      const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const config = makeConfig({
        bootstrapToken: { value: 'correct-token', expiresAt: futureIso },
      });

      server = await startServer(config, stateService, registry);

      const res = await request(server, 'POST', '/api/executors/register', defaultBody(), {
        'X-Bootstrap-Token': 'wrong-token',
      });

      expect(res.status).toBe(401);
      const body = res.body as { error: string };
      expect(body.error).toContain('Invalid');
      expect(registry.getAll()).toHaveLength(0);
    });

    it('triggers onFirstRegister on the first successful call only', async () => {
      const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const config = makeConfig({
        bootstrapToken: { value: 'boot-xyz', expiresAt: futureIso },
        executorToken: 'permanent-shared-token',
      });

      const calls: string[] = [];
      server = await startServer(config, stateService, registry, {
        onFirstRegister: (id) => {
          calls.push(id);
        },
      });

      // First call — bootstrap consume path
      const first = await request(server, 'POST', '/api/executors/register', defaultBody('exec-a'), {
        'X-Bootstrap-Token': 'boot-xyz',
      });
      expect(first.status).toBe(200);

      // Second call — re-register using the permanent token
      const second = await request(server, 'POST', '/api/executors/register', defaultBody('exec-b'), {
        'X-Executor-Token': 'permanent-shared-token',
      });
      expect(second.status).toBe(200);

      expect(calls).toEqual(['exec-a']);
    });

    it('accepts an already-configured permanent token without consuming bootstrap', async () => {
      const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const config = makeConfig({
        bootstrapToken: { value: 'boot-xyz', expiresAt: futureIso },
        executorToken: 'permanent-shared-token',
      });

      let bootstrapConsumed = 0;
      server = await startServer(config, stateService, registry, {
        onBootstrapConsumed: () => {
          bootstrapConsumed += 1;
          return 'new-token';
        },
      });

      const res = await request(server, 'POST', '/api/executors/register', defaultBody(), {
        'X-Executor-Token': 'permanent-shared-token',
      });

      expect(res.status).toBe(200);
      const body = res.body as { permanentToken: string };
      // Returns the already-configured permanent token for self-heal
      expect(body.permanentToken).toBe('permanent-shared-token');
      // But bootstrap was not consumed
      expect(bootstrapConsumed).toBe(0);
    });

    it('accepts registration with no tokens configured and no token header (backward compat)', async () => {
      const config = makeConfig(); // neither executorToken nor bootstrapToken
      server = await startServer(config, stateService, registry);

      const res = await request(server, 'POST', '/api/executors/register', defaultBody());

      expect(res.status).toBe(200);
      const body = res.body as { node: { id: string }; permanentToken: string | undefined };
      expect(body.node.id).toBe('exec-a');
      // Without a configured permanent token there's nothing to hand back.
      expect(body.permanentToken).toBeUndefined();
    });

    it('rejects registration when a permanent token is configured but the header is missing', async () => {
      const config = makeConfig({ executorToken: 'permanent-shared-token' });
      server = await startServer(config, stateService, registry);

      const res = await request(server, 'POST', '/api/executors/register', defaultBody());

      expect(res.status).toBe(401);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('returns 400 when required fields are missing from the body', async () => {
      const config = makeConfig();
      server = await startServer(config, stateService, registry);

      const res = await request(server, 'POST', '/api/executors/register', {
        id: 'only-id',
        // host and port intentionally omitted
      });

      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/executors/capacity ──

  describe('GET /api/executors/capacity', () => {
    it('returns aggregated capacity that grows after a successful register', async () => {
      const config = makeConfig();
      server = await startServer(config, stateService, registry);

      // Initially empty
      const before = await request(server, 'GET', '/api/executors/capacity');
      expect(before.status).toBe(200);
      const beforeBody = before.body as { online: number };
      expect(beforeBody.online).toBe(0);

      // Register one executor (no-auth backward-compat path)
      const reg = await request(server, 'POST', '/api/executors/register', defaultBody());
      expect(reg.status).toBe(200);

      const after = await request(server, 'GET', '/api/executors/capacity');
      expect(after.status).toBe(200);
      const afterBody = after.body as {
        online: number;
        total: { maxBranches: number; memoryMB: number; cpuCores: number };
      };
      expect(afterBody.online).toBe(1);
      expect(afterBody.total.maxBranches).toBe(4);
      expect(afterBody.total.memoryMB).toBe(4096);
      expect(afterBody.total.cpuCores).toBe(4);
    });
  });
});
