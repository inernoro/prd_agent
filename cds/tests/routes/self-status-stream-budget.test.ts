import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { ContainerService } from '../../src/services/container.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('legacy self-status state stream budget', () => {
  let root: string; let server: http.Server; let shell: MockShellExecutor; let latestBranch: string;
  const requests = new Set<http.ClientRequest>();
  const responses = new Map<string, http.ServerResponse>();
  const frames = new Map<string, string[]>();

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-self-stream-'));
    const config = { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'owned', portStart: 10001, sharedEnv: {}, jwt: { secret: 'owned', issuer: 'owned' },
      mode: 'standalone', executorPort: 9901 } as CdsConfig;
    shell = new MockShellExecutor();
    const state = new StateService(path.join(root, 'state.json')); state.load();
    const app = express();
    app.use((req, res, next) => {
      const id = String(req.headers['x-owned-id']); responses.set(id, res); frames.set(id, []);
      const write = res.write.bind(res);
      res.write = ((chunk: string) => {
        frames.get(id)!.push(String(chunk));
        const accepted = write(chunk);
        return id === 'slow' && frames.get(id)!.length === 1 ? false : accepted;
      }) as typeof res.write;
      next();
    });
    app.use('/api', createBranchRouter({ stateService: state, worktreeService: new WorktreeService(shell, root),
      containerService: new ContainerService(shell, config), shell, config }));
    latestBranch = 'cached-owned';
    selfStatusCache.init({ computeSnapshot: async () => ({ currentBranch: latestBranch } as any), scanRemoteBranches: async () => [] });
    selfStatusCache.enqueueRefresh('manual'); for (let i = 0; i < 10; i++) await tick();
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  });
  afterEach(async () => {
    for (const request of requests) request.destroy(); requests.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    selfStatusCache._resetForTests(); responses.clear(); frames.clear();
    await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true });
  });
  function connect(id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const addr = server.address() as { port: number };
      let buffer = ''; const timer = setTimeout(() => reject(new Error('initial state did not arrive')), 800);
      const req = http.get({ host: '127.0.0.1', port: addr.port, path: '/api/self-status/stream', headers: { 'x-owned-id': id } }, res => {
        res.on('error', () => {});
        res.on('data', chunk => { buffer += chunk; if (buffer.includes('\n\n')) { clearTimeout(timer); resolve(buffer.split('\n\n')[0]); } });
        res.on('end', () => { clearTimeout(timer); reject(new Error('ended before initial state')); });
      });
      req.on('error', err => { clearTimeout(timer); reject(err); }); requests.add(req);
    });
  }

  it('serves the shared cached snapshot without per-connection git queries', async () => {
    const snapshots = await Promise.all(Array.from({ length: 8 }, (_, i) => connect(`owned-${i}`)));
    expect(snapshots.every(frame => frame.includes('cached-owned'))).toBe(true);
    expect(shell.commands).toHaveLength(0);
  });

  it('does not serialize or write every update for a blocked peer and recovers the current cache', async () => {
    await connect('slow'); await connect('fast');
    for (let i = 0; i < 20; i++) cdsEventsBus.publish('self.status', { currentBranch: `owned-${i}` });
    expect(frames.get('slow')).toHaveLength(1);
    expect(frames.get('fast')!.length).toBeGreaterThanOrEqual(21);
    latestBranch = 'current-owned';
    selfStatusCache.enqueueRefresh('manual', { dedupeWindowMs: 0 });
    for (let i = 0; i < 10; i++) await tick();
    responses.get('slow')!.emit('drain'); await tick();
    expect(frames.get('slow')).toHaveLength(2);
    expect(frames.get('slow')!.at(-1)).toContain('current-owned');
    expect(frames.get('slow')!.at(-1)).not.toContain('owned-19');
  });

  it('deduplicates the first refresh across eight cold clients and disconnect does not cancel it', async () => {
    selfStatusCache._resetForTests();
    let computes = 0; let finish!: (value: any) => void;
    selfStatusCache.init({ computeSnapshot: async () => {
      computes++;
      return new Promise(resolve => { finish = resolve; });
    }, scanRemoteBranches: async () => [] });
    await Promise.all(Array.from({ length: 8 }, (_, i) => connect(`cold-${i}`)));
    expect(computes).toBe(1);
    for (const request of requests) request.destroy(); for (let i = 0; i < 5; i++) await tick();
    finish({ currentBranch: 'completed-without-clients' });
    for (let i = 0; i < 10; i++) await tick();
    expect(selfStatusCache.getSnapshot().currentBranch).toBe('completed-without-clients');
    expect(shell.commands).toHaveLength(0);
  });

  it('rejects an oversized initial snapshot before subscribing the response', async () => {
    latestBranch = 'x'.repeat(256 * 1024);
    selfStatusCache.enqueueRefresh('manual', { dedupeWindowMs: 0 });
    for (let i = 0; i < 10; i++) await tick();
    await expect(connect('oversized')).rejects.toThrow();
    expect(frames.get('oversized')).toHaveLength(0);
    cdsEventsBus.publish('self.status', { currentBranch: 'after-oversized' });
    expect(frames.get('oversized')).toHaveLength(0);
  });

  it('does not keep a disconnected response in the broadcast pool', async () => {
    await connect('owned-close');
    responses.get('owned-close')!.destroy(); for (let i = 0; i < 5; i++) await tick();
    const before = frames.get('owned-close')!.length;
    cdsEventsBus.publish('self.status', { currentBranch: 'after-close' });
    expect(frames.get('owned-close')).toHaveLength(before);
  });
});
