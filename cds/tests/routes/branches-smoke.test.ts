/**
 * Tests for POST /api/branches/:id/smoke (Phase 3).
 *
 * The endpoint spawns `bash scripts/smoke-all.sh` as a child process. To keep
 * the tests hermetic we plant a fake smoke-all.sh in a tmp dir, point
 * CDS_SMOKE_SCRIPT_DIR at it, and assert on the SSE event stream that
 * echoes our fake script's stdout. This validates:
 *   - body parsing + validation (previewHost, accessKey)
 *   - spawn flow (env vars passed through)
 *   - SSE stream framing (start / line / complete)
 *   - stdout → pass count extraction via the "✅ 通过: N 项" footer line
 *
 * We do NOT test the real smoke-*.sh chain here — that's scripts/
 * responsibility and would require a live prd-api.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter, runSmokeForBranch, resolveSmokeScriptDir } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

function makeConfig(tmpDir: string, withPreview = true): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 't', issuer: 'p' },
    mode: 'standalone',
    executorPort: 9901,
    ...(withPreview ? { rootDomains: ['miduo.test'] } : {}),
  };
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
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
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* SSE / text */ }
          resolve({ status: res.statusCode!, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseSseEvents(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      try { return { event, data: JSON.parse(data) as Record<string, unknown> }; }
      catch { return { event, data: { raw: data } }; }
    });
}

describe('POST /api/branches/:id/smoke', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-smoke-'));
    prevEnv.CDS_SMOKE_SCRIPT_DIR = process.env.CDS_SMOKE_SCRIPT_DIR;
    // Plant a fake smoke-all.sh that emits a fixed summary so we can assert
    // the endpoint's pass-count parsing.
    const scriptDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const fakeSmoke = path.join(scriptDir, 'smoke-all.sh');
    fs.writeFileSync(fakeSmoke, [
      '#!/usr/bin/env bash',
      'echo "=== fake smoke start: host=$SMOKE_TEST_HOST user=$SMOKE_USER ==="',
      'echo "✅ 通过: 3 项"',
      'echo "❌ 失败: 0 项"',
      'exit 0',
    ].join('\n'));
    fs.chmodSync(fakeSmoke, 0o755);
    process.env.CDS_SMOKE_SCRIPT_DIR = scriptDir;

    const config = makeConfig(tmpDir);
    const mock = new MockShellExecutor();
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);

    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    // Seed one branch so the smoke endpoint has a real target.
    stateService.addBranch({
      id: 'my-branch',
      branch: 'main',
      worktreePath: '/w/my-branch',
      services: {},
      status: 'running',
      createdAt: new Date().toISOString(),
      projectId: 'default',
    } as any);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevEnv.CDS_SMOKE_SCRIPT_DIR === undefined) {
      delete process.env.CDS_SMOKE_SCRIPT_DIR;
    } else {
      process.env.CDS_SMOKE_SCRIPT_DIR = prevEnv.CDS_SMOKE_SCRIPT_DIR;
    }
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns 404 when the branch does not exist', async () => {
    const res = await request(server, 'POST', '/api/branches/ghost/smoke', {
      accessKey: 'k',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when previewDomain / rootDomains are missing', async () => {
    // Rebuild a server with a preview-less config.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const naked = makeConfig(tmpDir, false);
    const mock = new MockShellExecutor();
    const stateFile = path.join(tmpDir, 'state2.json');
    const st2 = new StateService(stateFile);
    st2.load();
    st2.addBranch({
      id: 'my-branch', branch: 'main', worktreePath: '/w', services: {},
      status: 'running', createdAt: new Date().toISOString(), projectId: 'default',
    } as any);
    const ws = new WorktreeService(mock, naked.repoRoot);
    const cs = new ContainerService(mock, naked);
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', createBranchRouter({ stateService: st2, worktreeService: ws, containerService: cs, shell: mock, config: naked }));
    const server2 = await new Promise<http.Server>((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s));
    });
    const res = await request(server2, 'POST', '/api/branches/my-branch/smoke', { accessKey: 'k' });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('preview_host_missing');
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  it('returns 400 when accessKey missing and no _global.AI_ACCESS_KEY', async () => {
    const res = await request(server, 'POST', '/api/branches/my-branch/smoke', {});
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe('access_key_missing');
  });

  it('falls back to _global.AI_ACCESS_KEY when body key missing', async () => {
    stateService.setCustomEnvVar('AI_ACCESS_KEY', 'fallback-key', '_global');
    const res = await request(server, 'POST', '/api/branches/my-branch/smoke', {});
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.raw);
    const complete = events.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    expect((complete!.data as any).exitCode).toBe(0);
  });

  it('returns 500 when smoke-all.sh is missing', async () => {
    // Point the env var at a dir that has NO smoke-all.sh
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-empty-'));
    process.env.CDS_SMOKE_SCRIPT_DIR = emptyDir;
    try {
      const res = await request(server, 'POST', '/api/branches/my-branch/smoke', {
        accessKey: 'k',
      });
      expect(res.status).toBe(500);
      expect((res.body as any).error).toBe('smoke_script_missing');
    } finally {
      fs.rmSync(emptyDir, { recursive: true });
    }
  });

  it('streams SSE events: start → line → complete with passedCount=3', async () => {
    const res = await request(server, 'POST', '/api/branches/my-branch/smoke', {
      accessKey: 'test-key',
      impersonateUser: 'smoke-admin',
    });
    expect(res.status).toBe(200);
    const events = parseSseEvents(res.raw);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('line');
    expect(types[types.length - 1]).toBe('complete');

    const start = events.find((e) => e.event === 'start')!;
    expect((start.data as any).host).toBe('https://my-branch.miduo.test');
    expect((start.data as any).impersonateUser).toBe('smoke-admin');

    // First stdout line should contain our planted banner — proves env
    // propagation through spawn works.
    const banner = events.find(
      (e) => e.event === 'line' && /fake smoke start/.test((e.data as any).text),
    );
    expect(banner).toBeDefined();
    expect((banner!.data as any).text).toMatch(/host=https:\/\/my-branch\.miduo\.test/);
    expect((banner!.data as any).text).toMatch(/user=smoke-admin/);

    const complete = events.find((e) => e.event === 'complete')!;
    expect((complete.data as any).exitCode).toBe(0);
    expect((complete.data as any).passedCount).toBe(3);
    expect((complete.data as any).failedCount).toBe(0);
  });
});

// ── Phase 4 helpers ──
// Unit tests for runSmokeForBranch + resolveSmokeScriptDir independent
// of the HTTP endpoint. Validates that the helper is reusable by the
// auto-deploy hook path (which doesn't go through Express).

describe('runSmokeForBranch (Phase 4 helper)', () => {
  let scriptDir: string;

  beforeEach(() => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-smoke-helper-'));
    const entry = path.join(scriptDir, 'smoke-all.sh');
    fs.writeFileSync(entry, [
      '#!/usr/bin/env bash',
      'echo "probe host=$SMOKE_TEST_HOST"',
      'echo "probe user=$SMOKE_USER"',
      'echo "✅ 通过: 7 项"',
      'echo "❌ 失败: 2 项"',
      'exit 42',
    ].join('\n'));
    fs.chmodSync(entry, 0o755);
  });

  afterEach(() => {
    if (fs.existsSync(scriptDir)) fs.rmSync(scriptDir, { recursive: true });
  });

  it('propagates env vars, forwards lines, reports pass/fail counts + exit code', async () => {
    const lines: Array<{ stream: string; text: string }> = [];
    const result = await new Promise<any>((resolve, reject) => {
      runSmokeForBranch({
        branch: { id: 'ut-branch' } as any,
        previewHost: 'https://ut.example.test',
        accessKey: 'ut-key',
        impersonateUser: 'ut-user',
        scriptDir,
        onLine: (stream, text) => lines.push({ stream, text }),
        onComplete: resolve,
        onError: reject,
      });
    });

    // pass/fail parsed from the 通过/失败 footer lines
    expect(result.passedCount).toBe(7);
    expect(result.failedCount).toBe(2);
    // exit code comes straight from bash
    expect(result.exitCode).toBe(42);
    // elapsed is a non-negative int
    expect(result.elapsedSec).toBeGreaterThanOrEqual(0);

    // Confirm env propagation via the planted probe lines
    const hostLine = lines.find((l) => /probe host=/.test(l.text));
    expect(hostLine?.text).toBe('probe host=https://ut.example.test');
    const userLine = lines.find((l) => /probe user=/.test(l.text));
    expect(userLine?.text).toBe('probe user=ut-user');
  });

  it('resolveSmokeScriptDir reports exists=false when smoke-all.sh missing', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-smoke-empty-'));
    const prev = process.env.CDS_SMOKE_SCRIPT_DIR;
    process.env.CDS_SMOKE_SCRIPT_DIR = emptyDir;
    try {
      const r = resolveSmokeScriptDir();
      expect(r.dir).toBe(emptyDir);
      expect(r.exists).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CDS_SMOKE_SCRIPT_DIR;
      else process.env.CDS_SMOKE_SCRIPT_DIR = prev;
      fs.rmSync(emptyDir, { recursive: true });
    }
  });
});
