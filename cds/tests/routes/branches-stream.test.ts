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
import { reduceBranchListState } from '../../web/src/lib/branch-list-state.js';
import { branchRuntimeBadge } from '../../web/src/lib/deploy-runtime-badge.js';
import type { CdsConfig, BranchEntry } from '../../src/types.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
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
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (err?: unknown) => { clearTimeout(timeout); err ? reject(err) : resolve(); };
    const addr = server.address() as { port: number };
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET',
      headers,
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
              finish();
              return;
            }
          } catch (err) {
            req.destroy();
            finish(err);
            return;
          }
          currentEvent = 'message';
        }
      });
      res.on('error', finish);
      res.on('end', () => finish(new Error('SSE ended before expected event')));
    });
    req.on('error', finish);
    req.end();
    // hard timeout guard
    timeout = setTimeout(() => { req.destroy(); finish(new Error('SSE expected event timeout')); }, 2500);
  });
}

describe('GET /api/branches/stream', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;
  let blockedResponse: http.ServerResponse | undefined;
  let writes: number;

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
    writes = 0;
    blockedResponse = undefined;
    app.use((req, res, next) => {
      const scope = req.headers['x-test-project-key'];
      if (typeof scope === 'string') (req as any).cdsProjectKey = { projectId: scope };
      const globalScope = req.headers['x-test-global-projects'];
      if (typeof globalScope === 'string') (req as any).cdsAccess = { access: { projects: globalScope.split(',') } };
      if (req.headers['x-test-block'] === 'true') {
        blockedResponse = res;
        const write = res.write.bind(res);
        res.write = ((...args: Parameters<typeof res.write>) => {
          writes++;
          const result = (write as any)(...args);
          return writes === 1 ? false : result;
        }) as typeof res.write;
      }
      next();
    });
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config,
    }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // remove any lingering test listeners so each test starts clean
    branchEvents.removeAllListeners('any');
  });

  it('preserves failed first deployment and summary across SSE reconnects', async () => {
    const branch = stateService.getBranch('existing')!;
    branch.status = 'error'; branch.errorMessage = 'candidate_network_identity: rejected';
    for (let connection = 0; connection < 2; connection++) {
      await collectSseEvents(server, '/api/branches/stream', ev => {
        if (ev.event !== 'snapshot') return false;
        const visible = ev.data.branches.find((item: any) => item.id === branch.id);
        expect(visible.status).toBe('error');
        expect(visible.errorMessage).toBe('candidate_network_identity: rejected');
        return true;
      });
      expect(stateService.getBranch('existing')!.status).toBe('error');
      expect(branch.errorMessage).toBe('candidate_network_identity: rejected');
    }
  });

  it('does not mutate canonical branch state while projecting an SSE snapshot', async () => {
    const branch = stateService.getBranch('existing')!;
    expect(branch.status).toBe('running');
    await collectSseEvents(server, '/api/branches/stream', ev => ev.event === 'snapshot');
    expect(branch.status).toBe('running');
  });

  it('clears stale service errors only in the SSE projection, preserving canonical nested services', async () => {
    const branch = stateService.getBranch('existing')!;
    branch.services.api = { profileId: 'api', containerName: 'owned-api', hostPort: 10001,
      status: 'running', errorMessage: 'previous start failed' };
    await collectSseEvents(server, '/api/branches/stream', ev => {
      if (ev.event !== 'snapshot') return false;
      expect(ev.data.branches[0].services.api.errorMessage).toBeUndefined();
      return true;
    });
    expect(branch.services.api.errorMessage).toBe('previous start failed');
  });

  it.each(['branch.updated', 'branch.status'] as const)('updates actual express runtime and clears the prior failure through %s without reloading', async type => {
    const branch = stateService.getBranch('existing')!;
    branch.status = 'error'; branch.errorMessage = 'original failed deployment';
    const target = 'a'.repeat(40);
    branch.githubCommitSha = target;
    for (const id of ['api', 'worker']) stateService.addBuildProfile({ id, projectId: 'default', name: id,
      dockerImage: 'owned/prebuilt:sha-' + target, command: '', workDir: '.', containerPort: 8080,
      activeDeployMode: 'express', deployModes: { express: { label: 'Express', prebuilt: true, dockerImage: 'owned/prebuilt:sha-' + target } } });
    let client: any = { branches: [{ ...branch, deployRuntime: { kind: 'source', activeProfiles: 2,
      prebuilt: true, actualPrebuiltCoverage: 'unknown' } }], lastKnownGoodBranches: [] };
    await collectSseEvents(server, '/api/branches/stream?project=default', ev => {
      if (ev.event === 'snapshot') {
        branch.status = 'running'; branch.errorMessage = undefined;
        branch.services = Object.fromEntries(['api', 'worker'].map((id, i) => [id, { profileId: id,
          containerName: 'owned-' + id, hostPort: 10001 + i, status: 'running', deployedMode: 'express',
          deployedImage: 'sha256:' + 'b'.repeat(64), deployedPrebuilt: true, deployedCommitSha: target }]));
        if (type === 'branch.updated') branchEvents.emitEvent({ type, payload: { branchId: branch.id, projectId: 'default', patch: {}, ts: nowIso() } });
        else branchEvents.emitEvent({ type, payload: { branchId: branch.id, projectId: 'default', status: 'running', ts: nowIso() } });
        return;
      }
      expect(ev.event).toBe(type);
      client = reduceBranchListState(client, { type: 'sseBranchUpsert', branch: ev.data.branch, projectId: 'default' }).state;
      const visible = client.branches[0];
      expect(visible.deployRuntime.actualPrebuiltCoverage).toBe('all');
      expect(visible.deployRuntime.actualVersionStatus).toBe('current');
      expect(branchRuntimeBadge(visible)?.lightning).toBe('yellow');
      expect(visible.errorMessage).toBe('');
      expect(branch.errorMessage).toBeUndefined();
      return true;
    });
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

  it('coalesces events during backpressure and sends a fresh scoped recovery snapshot after drain', async () => {
    let initialSeen = false;
    await collectSseEvents(server, '/api/branches/stream?project=default', ev => {
      if (ev.event !== 'snapshot') throw new Error(`unexpected queued event: ${ev.event}`);
      if (!initialSeen) {
        initialSeen = true;
        const branch = stateService.getBranch('existing')!;
        branch.status = 'idle';
        stateService.save();
        for (let i = 0; i < 20; i++) branchEvents.emitEvent({ type: 'branch.status', payload: {
          branchId: 'existing', projectId: 'default', status: 'idle', ts: nowIso(),
        } });
        expect(writes).toBe(1);
        blockedResponse!.emit('drain');
        return;
      }
      expect(ev.data.resyncRequired).toBe(true);
      expect(ev.data.branches.find((b: any) => b.id === 'existing').status).toBe('idle');
      expect(writes).toBe(2);
      return true;
    }, { 'x-test-block': 'true' });
    expect(initialSeen).toBe(true);
  });

  it('limits the snapshot to one requested branch', async () => {
    stateService.addBranch({ ...stateService.getBranch('existing')!, id: 'other', branch: 'other' });
    await collectSseEvents(server, '/api/branches/stream?project=default&branch=existing', ev => {
      expect(ev.data.branches.map((b: any) => b.id)).toEqual(['existing']);
      return true;
    });
  });

  it('locks a project credential to its own scope when the query omits project', async () => {
    stateService.addBranch({ ...stateService.getBranch('existing')!, id: 'other-project', projectId: 'alt' });
    await collectSseEvents(server, '/api/branches/stream', ev => {
      expect(ev.data.branches.map((b: any) => b.id)).toEqual(['existing']);
      expect(ev.data.projectId).toBe('default');
      return true;
    }, { 'x-test-project-key': 'default' });
  });

  it('filters a restricted global credential snapshot to its granted projects', async () => {
    stateService.addBranch({ ...stateService.getBranch('existing')!, id: 'other-project', projectId: 'alt' });
    await collectSseEvents(server, '/api/branches/stream', ev => {
      expect(ev.data.branches.map((b: any) => b.id)).toEqual(['existing']);
      return true;
    }, { 'x-test-global-projects': 'default' });
  });

  it('denies a project credential requesting another project before opening SSE', async () => {
    const status = await new Promise<number>(resolve => {
      const request = http.get({ hostname: '127.0.0.1', port: (server.address() as any).port,
        path: '/api/branches/stream?project=alt', headers: { 'x-test-project-key': 'default' } }, response => {
        resolve(response.statusCode!); response.destroy(); request.destroy();
      });
    });
    expect(status).toBe(403);
  });

  it('sends only the selected branch live event and ignores scoped events without project identity', async () => {
    stateService.addBranch({ ...stateService.getBranch('existing')!, id: 'other', branch: 'other' });
    const seen: string[] = [];
    await collectSseEvents(server, '/api/branches/stream?project=default&branch=existing', ev => {
      if (ev.event === 'snapshot') {
        branchEvents.emitEvent({ type: 'branch.status', payload: { branchId: 'unknown', status: 'idle', ts: nowIso() } });
        branchEvents.emitEvent({ type: 'branch.status', payload: { branchId: 'other', projectId: 'default', status: 'idle', ts: nowIso() } });
        branchEvents.emitEvent({ type: 'branch.status', payload: { branchId: 'existing', status: 'idle', ts: nowIso() } });
        return;
      }
      seen.push(ev.data.branchId);
      return true;
    }, { 'x-test-project-key': 'default' });
    expect(seen).toEqual(['existing']);
  });

  it('rejects a conflicting event project instead of enriching it with a foreign branch', async () => {
    stateService.addBranch({ ...stateService.getBranch('existing')!, id: 'foreign', projectId: 'alt', notes: 'foreign-note' });
    const seen: string[] = [];
    await collectSseEvents(server, '/api/branches/stream?project=default', ev => {
      if (ev.event === 'snapshot') {
        branchEvents.emitEvent({ type: 'branch.updated', payload: {
          branchId: 'foreign', projectId: 'default', patch: { notes: 'forged' }, ts: nowIso(),
        } });
        branchEvents.emitEvent({ type: 'branch.updated', payload: {
          branchId: 'existing', projectId: 'default', patch: { notes: 'owned' }, ts: nowIso(),
        } });
        return;
      }
      seen.push(ev.data.branchId);
      expect(JSON.stringify(ev.data)).not.toContain('foreign-note');
      return true;
    }, { 'x-test-project-key': 'default' });
    expect(seen).toEqual(['existing']);
  });

  it('does not send build output through a service patch in a branch state event', async () => {
    await collectSseEvents(server, '/api/branches/stream?project=default', ev => {
      if (ev.event === 'snapshot') {
        branchEvents.emitEvent({ type: 'branch.updated', payload: { branchId: 'existing', projectId: 'default',
          patch: { services: { api: { status: 'error', buildLog: 'private-build-output' } } } as any, ts: nowIso() } });
        return;
      }
      expect(JSON.stringify(ev.data)).not.toContain('private-build-output');
      expect(ev.data.patch.services.api.status).toBe('error');
      return true;
    });
  });

  it('invalidates list cache on a saved mutation before a recovery GET', async () => {
    const getBranches = () => new Promise<any>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: (server.address() as any).port,
        path: '/api/branches?project=default', headers: { Connection: 'close' } }, response => {
        let data = ''; response.on('data', chunk => { data += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(err); } });
      }).on('error', reject);
    });
    const branch = stateService.getBranch('existing')!;
    branch.notes = 'before'; stateService.save();
    expect((await getBranches()).branches[0].notes).toBe('before');
    branch.notes = 'after'; stateService.save();
    expect((await getBranches()).branches[0].notes).toBe('after');
  });

  it('does not multiply a large build log into state snapshots while preserving runtime identity', async () => {
    stateService.getBranch('existing')!.services.api = { profileId: 'api', containerName: 'owned-api',
      containerId: 'a'.repeat(64), hostPort: 10001, status: 'error', buildLog: 'private-log'.repeat(50000) };
    await collectSseEvents(server, '/api/branches/stream?project=default', ev => {
      const service = ev.data.branches[0].services.api;
      expect(service.containerId).toBe('a'.repeat(64));
      expect(service.buildLog).toBeUndefined();
      expect(JSON.stringify(ev.data).length).toBeLessThan(256 * 1024);
      return true;
    });
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
