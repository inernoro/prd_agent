/**
 * Tests for GET /api/branches/stream (live UI stream, 2026-04-19).
 *
 * Approach:
 *   1. Open a raw HTTP connection to the SSE endpoint (cannot use the
 *      `request()` helper that buffers the whole body — we need the
 *      stream incrementally).
 *   2. Capture the `snapshot` event on connect.
 *   3. Emit on `branchEvents` from the test side; assert each typed
 *      envelope reaches the client.
 *   4. Close the connection and verify the listener is detached
 *      (memory-leak guard — a buggy subscription would hold references
 *      to closed `res` objects forever).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { branchEvents, nowIso } from '../../src/services/branch-events.js';
import type { CdsConfig, BranchEntry } from '../../src/types.js';

function makeConfig(tmpDir: string): CdsConfig {
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
  };
}

/**
 * Open an SSE connection and resolve on each full event block
 * (delimited by blank line). Caller passes an async callback that
 * inspects events and returns truthy to close the stream.
 */
async function collectSseEvents(
  server: http.Server,
  urlPath: string,
  onEvent: (ev: { event: string; data: any }) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET',
    }, (res) => {
      let buffer = '';
      let currentEvent = 'message';
      res.on('data', async (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let blockEnd: number;
        while ((blockEnd = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          if (!raw.trim() || raw.startsWith(':')) continue; // keepalive comment
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          let parsed: any = data;
          try { parsed = JSON.parse(data); } catch { /* keep string */ }
          try {
            const stop = await onEvent({ event: currentEvent, data: parsed });
            if (stop) {
              req.destroy();
              resolve();
              return;
            }
          } catch (err) {
            req.destroy();
            reject(err);
            return;
          }
          currentEvent = 'message';
        }
      });
      res.on('error', reject);
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end();
    // hard timeout guard
    setTimeout(() => { req.destroy(); resolve(); }, 2500);
  });
}

describe('GET /api/branches/stream', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bstream-'));
    const config = makeConfig(tmpDir);
    const mock = new MockShellExecutor();
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();

    // Seed one branch so snapshot isn't empty
    const seed: BranchEntry = {
      id: 'existing',
      branch: 'main',
      worktreePath: '/w/existing',
      services: {},
      status: 'running',
      createdAt: new Date().toISOString(),
      projectId: 'default',
    };
    stateService.addBranch(seed);

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);
    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config,
    }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    // remove any lingering test listeners so each test starts clean
    branchEvents.removeAllListeners('any');
  });

  it('emits an initial snapshot event containing all branches', async () => {
    const seen: any[] = [];
    await collectSseEvents(server, '/api/branches/stream', (ev) => {
      seen.push(ev);
      return ev.event === 'snapshot';
    });
    expect(seen.length).toBeGreaterThan(0);
    const snap = seen.find((e) => e.event === 'snapshot');
    expect(snap).toBeDefined();
    expect(Array.isArray(snap.data.branches)).toBe(true);
    expect(snap.data.branches.map((b: any) => b.id)).toContain('existing');
  });

  it('forwards emitted branch.created events to connected clients', async () => {
    // Emit AFTER the snapshot arrives but BEFORE closing. Use a deferred
    // emit via setTimeout so the listener is registered first.
    setTimeout(() => {
      branchEvents.emitEvent({
        type: 'branch.created',
        payload: {
          branch: {
            id: 'new-one', branch: 'feature/x', worktreePath: '/w/new', services: {},
            status: 'idle', createdAt: new Date().toISOString(), projectId: 'default',
          } as any,
          source: 'github-webhook',
          ts: nowIso(),
        },
      });
    }, 50);

    const seen: any[] = [];
    await collectSseEvents(server, '/api/branches/stream', (ev) => {
      seen.push(ev);
      return ev.event === 'branch.created';
    });
    const created = seen.find((e) => e.event === 'branch.created');
    expect(created, `did not observe branch.created in ${JSON.stringify(seen.map((s) => s.event))}`).toBeDefined();
    expect(created.data.branch.id).toBe('new-one');
    expect(created.data.source).toBe('github-webhook');
  });

  it('?project=X filters events to that project only', async () => {
    setTimeout(() => {
      branchEvents.emitEvent({
        type: 'branch.created',
        payload: {
          branch: { id: 'alt-one', branch: 'x', worktreePath: '/', services: {}, status: 'idle', createdAt: nowIso(), projectId: 'alt' } as any,
          source: 'manual', ts: nowIso(),
        },
      });
      branchEvents.emitEvent({
        type: 'branch.created',
        payload: {
          branch: { id: 'default-one', branch: 'y', worktreePath: '/', services: {}, status: 'idle', createdAt: nowIso(), projectId: 'default' } as any,
          source: 'manual', ts: nowIso(),
        },
      });
    }, 50);

    const seen: any[] = [];
    await collectSseEvents(server, '/api/branches/stream?project=default', async (ev) => {
      seen.push(ev);
      // stop after we've seen a branch.created matching default
      return ev.event === 'branch.created' && ev.data?.branch?.id === 'default-one';
    });
    // should NEVER see the alt-one event with project=default filter
    const alt = seen.find((e) => e.event === 'branch.created' && e.data?.branch?.id === 'alt-one');
    expect(alt).toBeUndefined();
    const d = seen.find((e) => e.event === 'branch.created' && e.data?.branch?.id === 'default-one');
    expect(d).toBeDefined();
  });

  it('detaches the listener when the client disconnects (no leak)', async () => {
    const before = branchEvents.listenerCount('any');
    await collectSseEvents(server, '/api/branches/stream', (ev) => ev.event === 'snapshot');
    // Give the close handler a tick to fire
    await new Promise((r) => setTimeout(r, 100));
    const after = branchEvents.listenerCount('any');
    // After disconnect we must be back to the pre-test listener count
    expect(after).toBe(before);
  });
});
