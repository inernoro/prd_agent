import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import { createClusterRouter } from '../../src/routes/cluster.js';
import type { CdsConfig } from '../../src/types.js';
import type { ExecutorAgent } from '../../src/executor/agent.js';

/**
 * Tests for the UI-facing cluster bootstrap router.
 *
 * Strategy: real express + ephemeral port, same pattern as
 * tests/scheduler/bootstrap-routes.test.ts. We override CDS_ENV_FILE so the
 * router's updateEnvFile() writes to a tmp file instead of our actual
 * cds/.cds.env — otherwise running the tests would silently mutate the
 * developer's environment.
 */

function makeConfig(overrides: Partial<CdsConfig> = {}): CdsConfig {
  return {
    repoRoot: '/tmp/cds-cluster-router-test',
    worktreeBase: '/tmp/cds-cluster-router-test/worktrees',
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
  body: unknown;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
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

interface TestHarness {
  server: http.Server;
  config: CdsConfig;
  stateService: StateService;
  registry: ExecutorRegistry;
  getAgent: () => ExecutorAgent | null;
  setAgent: (a: ExecutorAgent | null) => void;
}

function startHarness(configOverrides: Partial<CdsConfig> = {}): Promise<TestHarness> {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cluster-router-'));
    process.env.CDS_ENV_FILE = path.join(tmpDir, '.cds.env');

    const stateFile = path.join(tmpDir, 'state.json');
    const stateService = new StateService(stateFile);
    stateService.load();
    const registry = new ExecutorRegistry(stateService);

    const config = makeConfig(configOverrides);

    let agent: ExecutorAgent | null = null;
    const getAgent = () => agent;
    const setAgent = (a: ExecutorAgent | null) => { agent = a; };

    const app = express();
    app.use(express.json());
    app.use(
      '/api/cluster',
      createClusterRouter({ config, stateService, registry, getExecutorAgent: getAgent, setExecutorAgent: setAgent }),
    );

    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, config, stateService, registry, getAgent, setAgent });
    });
  });
}

describe('Cluster router (UI bootstrap)', () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
      harness.registry.stopHealthChecks();
      harness = null;
    }
    delete process.env.CDS_ENV_FILE;
  });

  // ── /issue-token ──

  describe('POST /api/cluster/issue-token', () => {
    it('mints a bootstrap token and returns a base64-decodable connectionCode', async () => {
      harness = await startHarness();
      const res = await request(harness.server, 'POST', '/api/cluster/issue-token');

      expect(res.status).toBe(200);
      const body = res.body as {
        connectionCode: string;
        masterUrl: string;
        expiresAt: string;
        ttlSeconds: number;
      };
      expect(body.connectionCode).toBeTruthy();
      expect(body.masterUrl).toBe('https://test.example.org');
      expect(body.ttlSeconds).toBe(900);

      // connectionCode must decode to { master, token, expiresAt }
      const decoded = JSON.parse(Buffer.from(body.connectionCode, 'base64').toString('utf-8'));
      expect(decoded.master).toBe('https://test.example.org');
      expect(typeof decoded.token).toBe('string');
      expect(decoded.token.length).toBe(64); // 32 bytes hex
      expect(decoded.expiresAt).toBe(body.expiresAt);

      // In-memory config should have the token so scheduler/routes can validate it
      expect(harness.config.bootstrapToken?.value).toBe(decoded.token);
    });

    it('refuses to issue when node is an executor', async () => {
      harness = await startHarness({ mode: 'executor' });
      const res = await request(harness.server, 'POST', '/api/cluster/issue-token');

      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain('executor');
    });

    it('errors when no masterUrl can be determined', async () => {
      harness = await startHarness({ rootDomains: undefined });
      const res = await request(harness.server, 'POST', '/api/cluster/issue-token');

      // Without rootDomains the fallback to request Host would kick in, but
      // http.request uses 127.0.0.1 and does set Host, so we'll get a body
      // with a localhost masterUrl. The check is that we DON'T 500 — the
      // fallback path works.
      expect(res.status).toBe(200);
      const body = res.body as { masterUrl: string };
      expect(body.masterUrl).toContain('127.0.0.1');
    });
  });

  // ── /join ──

  describe('POST /api/cluster/join', () => {
    function buildCode(master: string, expiresAt: string, token = 'test-token'): string {
      return Buffer.from(JSON.stringify({ master, token, expiresAt }), 'utf-8').toString('base64');
    }

    it('returns 400 when connectionCode is missing', async () => {
      harness = await startHarness();
      const res = await request(harness.server, 'POST', '/api/cluster/join', {});
      expect(res.status).toBe(400);
    });

    it('returns 400 when connectionCode is not valid base64 JSON', async () => {
      harness = await startHarness();
      const res = await request(harness.server, 'POST', '/api/cluster/join', {
        connectionCode: 'not-a-real-code',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when connectionCode is missing required fields', async () => {
      harness = await startHarness();
      const partial = Buffer.from(JSON.stringify({ master: 'https://x', token: 'y' }), 'utf-8').toString('base64');
      const res = await request(harness.server, 'POST', '/api/cluster/join', { connectionCode: partial });
      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('expiresAt');
    });

    it('returns 400 when token has already expired', async () => {
      harness = await startHarness();
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const code = buildCode('https://master.example.org', past);
      const res = await request(harness.server, 'POST', '/api/cluster/join', { connectionCode: code });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('过期');
    });

    it('refuses plain HTTP master URL (cleartext token protection)', async () => {
      harness = await startHarness();
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const code = buildCode('http://master.example.org', future);
      const res = await request(harness.server, 'POST', '/api/cluster/join', { connectionCode: code });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('HTTP');
    });

    it('allows loopback HTTP master URL (dev/test)', async () => {
      harness = await startHarness();
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      // Unreachable port on loopback so the register() call fails, but the
      // HTTP-check should pass — we're testing the URL scheme guard, not the
      // actual register flow.
      const code = buildCode('http://127.0.0.1:65432', future);
      const res = await request(harness.server, 'POST', '/api/cluster/join', { connectionCode: code });

      // register() will fail → 502, but NOT 400 for the HTTP guard
      expect(res.status).toBe(502);
    });

    it('rejects double-join when an agent is already present', async () => {
      harness = await startHarness();
      // Plant a fake agent to simulate "already joined" state
      harness.setAgent({ executorId: 'fake' } as ExecutorAgent);

      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const code = buildCode('https://master.example.org', future);
      const res = await request(harness.server, 'POST', '/api/cluster/join', { connectionCode: code });

      expect(res.status).toBe(409);
      const body = res.body as { error: string };
      expect(body.error).toContain('已加入');
    });
  });

  // ── /leave ──

  describe('POST /api/cluster/leave', () => {
    it('returns success even when not currently joined (idempotent)', async () => {
      harness = await startHarness();
      const res = await request(harness.server, 'POST', '/api/cluster/leave');
      expect(res.status).toBe(200);
      const body = res.body as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('clears in-memory cluster state', async () => {
      harness = await startHarness({
        masterUrl: 'https://leftover.example.org',
        executorToken: 'stale-token',
      });

      const res = await request(harness.server, 'POST', '/api/cluster/leave');
      expect(res.status).toBe(200);

      // Post-leave, the in-memory config must be clean
      expect(harness.config.masterUrl).toBeUndefined();
      expect(harness.config.executorToken).toBeUndefined();
    });
  });

  // ── /status ──

  describe('GET /api/cluster/status', () => {
    it('reports standalone when no remote executors have joined', async () => {
      harness = await startHarness();
      const res = await request(harness.server, 'GET', '/api/cluster/status');

      expect(res.status).toBe(200);
      const body = res.body as {
        mode: string;
        effectiveRole: string;
        remoteExecutorCount: number;
      };
      expect(body.effectiveRole).toBe('standalone');
      expect(body.remoteExecutorCount).toBe(0);
    });

    it('reports scheduler when remote executors exist', async () => {
      harness = await startHarness();
      harness.registry.register({
        id: 'remote-1',
        host: 'r1.local',
        port: 9901,
        capacity: { maxBranches: 4, memoryMB: 4096, cpuCores: 4 },
      });

      const res = await request(harness.server, 'GET', '/api/cluster/status');
      const body = res.body as { effectiveRole: string; remoteExecutorCount: number };
      expect(body.effectiveRole).toBe('scheduler');
      expect(body.remoteExecutorCount).toBe(1);
    });

    it('reports executor when mode is executor', async () => {
      harness = await startHarness({ mode: 'executor', masterUrl: 'https://m.example.org' });
      const res = await request(harness.server, 'GET', '/api/cluster/status');
      const body = res.body as { effectiveRole: string; masterUrl: string };
      expect(body.effectiveRole).toBe('executor');
      expect(body.masterUrl).toBe('https://m.example.org');
    });

    it('reports hybrid when an in-process agent exists and mode is still standalone', async () => {
      harness = await startHarness();
      harness.setAgent({ executorId: 'hybrid-exec' } as ExecutorAgent);

      const res = await request(harness.server, 'GET', '/api/cluster/status');
      const body = res.body as { effectiveRole: string; executorId: string };
      expect(body.effectiveRole).toBe('hybrid');
      expect(body.executorId).toBe('hybrid-exec');
    });

    it('includes cluster capacity snapshot', async () => {
      harness = await startHarness();
      harness.registry.registerEmbeddedMaster(9900, 'test-master');

      const res = await request(harness.server, 'GET', '/api/cluster/status');
      const body = res.body as { capacity: { online: number; total: { memoryMB: number } } };
      expect(body.capacity.online).toBe(1);
      expect(body.capacity.total.memoryMB).toBeGreaterThan(0);
    });
  });
});
