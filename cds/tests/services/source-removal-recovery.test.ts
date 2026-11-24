import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { JanitorService, defaultOrphanWorktreeFs } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import { NoticeLedgerService, startNoticeLedger } from '../../src/services/notice-ledger.js';
import { removeOwnedDirectory } from '../../src/services/worktree-directory-removal-process.js';
import {
  readWorktreeDirectoryIdentity,
  worktreePathActivity,
} from '../../src/services/worktree-path-activity.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const roots: string[] = [],
  services: JanitorService[] = [],
  subscriptions: Array<{ stop(): void }> = [];
afterEach(async () => {
  services.splice(0).forEach((s) => s.stop());
  subscriptions.splice(0).forEach((s) => s.stop());
  await flushAllJsonStateStores();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-removal-recovery-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Isolated regression');
  git('config', 'user.email', 'regression@example.invalid');
  await fs.writeFile(path.join(repo, 'source.txt'), 'immutable historical source');
  git('add', '.');
  git('commit', '-m', '隔离源码恢复基线');
  const base = path.join(root, 'worktrees'),
    bucket = path.join(base, 'project', '.deployment-sources', 'branch');
  await fs.mkdir(bucket, { recursive: true });
  const old = new Date(Date.now() - 4 * 3600000);
  const make = async () => {
    const dir = path.join(bucket, randomUUID());
    git('worktree', 'add', '--detach', dir, 'HEAD');
    await fs.utimes(dir, old, old);
    return dir;
  };
  const state = new StateService(path.join(root, 'state.json'));
  state.addProject({
    id: 'project',
    slug: 'project',
    name: 'Private regression',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);
  const ledger = new NoticeLedgerService({ storePath: '' });
  subscriptions.push(startNoticeLedger({ ledger, outbound: null }));
  return { root, repo, base, bucket, old, git, make, state, ledger };
}
function observe(
  f: Awaited<ReturnType<typeof fixture>>,
  files = { ...defaultOrphanWorktreeFs, listMountedHostPaths: async () => [] as string[] },
) {
  const s = new JanitorService(
    f.state,
    {
      enabled: false,
      worktreeTTLDays: 7,
      diskWarnPercent: 80,
      sweepIntervalSeconds: 3600,
      dockerPrune: false,
      imageRetention: false,
    },
    f.base,
    undefined,
    () => ({ totalBytes: 1000, freeBytes: 500 }),
    undefined,
    undefined,
    files,
  );
  services.push(s);
  return s;
}
describe('source deletion failures remain visible until confirmed resolved', () => {
  it('does not recover when a failed source becomes too young or claimed, and verifies external removal', async () => {
    const f = await fixture(),
      dir = await f.make();
    let fail = true;
    const files = {
      ...defaultOrphanWorktreeFs,
      listMountedHostPaths: async () => [],
      removeDir: async (d: string, o: any) =>
        fail ? 'controlled deletion failure' : defaultOrphanWorktreeFs.removeDir(d, o),
    };
    const service = observe(f, files);
    const first = await service.sweep();
    expect(first.deploymentSources!.failed.map((x) => x.path)).toContain(dir);
    fail = false;
    await fs.utimes(dir, new Date(), new Date());
    const young = await service.sweep();
    expect(young.deploymentSources!.attempted).toBe(0);
    expect(
      young.deploymentSources!.failed.map((x) => x.path),
      'age protection is not proof that an earlier deletion failure recovered',
    ).toContain(dir);
    service.stop();
    service.start();
    f.state.addBranch({
      id: 'branch',
      projectId: 'project',
      branch: 'main',
      status: 'running',
      createdAt: new Date().toISOString(),
      services: { source: { profileId: 'source', status: 'stopped', sourceCheckoutPath: dir } },
    } as any);
    await service.sweep();
    expect(f.ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(false);
    f.state.removeBranch('branch'); // Release the test-only rollback reference before external reclamation.
    f.git('worktree', 'remove', dir);
    await service.sweep();
    expect(f.ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(true);
  });
  it('reports thrown deletion errors as failures, retaining a legitimate held claim separately', async () => {
    const f = await fixture(),
      failed = await f.make(),
      held = await f.make();
    const claim = worktreePathActivity.tryAcquire([held]);
    expect(claim).toBeTruthy();
    try {
      const service = observe(f, {
        ...defaultOrphanWorktreeFs,
        listMountedHostPaths: async () => [],
        removeDir: async () => {
          throw new Error('controlled native deletion error');
        },
      });
      const report = (await service.sweep()).deploymentSources!;
      expect(report.failed.map((x) => x.path)).toEqual([failed]);
      expect(report.held[held]).toBeTruthy();
      expect(f.ledger.list().some((n) => n.eventType === 'capacity.risk')).toBe(true);
    } finally {
      claim!.release();
    }
  });
  it('distinguishes a native Git remove failure from an ordinary protected source', async () => {
    const f = await fixture(),
      dir = await f.make();
    f.git('worktree', 'lock', dir);
    const identity = await readWorktreeDirectoryIdentity(dir);
    expect(identity).toBeTruthy();
    await expect(
      removeOwnedDirectory({
        dir,
        allowedBase: f.base,
        identity: identity!,
        entryOnly: false,
        sourceOnly: true,
      }),
      'locked native Git removal must not return held as though it was a clean protected observation',
    ).rejects.toThrow();
    const service = observe(f);
    const first = await service.sweep();
    expect(first.deploymentSources!.failed.map((x) => x.path)).toContain(dir);
    f.git('worktree', 'unlock', dir);
    const next = await service.sweep();
    expect(next.deploymentSources!.removed).toContain(dir);
    expect(f.ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(true);
  });
  it('reports a real Git metadata read failure and preserves content until metadata is repaired', async () => {
    const f = await fixture(), dir = await f.make();
    const metadata = await fs.readFile(path.join(dir, '.git'));
    const before = createHash('sha256').update(await fs.readFile(path.join(dir, 'source.txt'))).digest('hex');
    await fs.writeFile(path.join(dir, '.git'), 'invalid private regression metadata');
    const service = observe(f);
    expect((await service.sweep()).deploymentSources!.failed.map(entry => entry.path)).toContain(dir);
    expect(createHash('sha256').update(await fs.readFile(path.join(dir, 'source.txt'))).digest('hex')).toBe(before);
    expect(f.ledger.list().some(n => n.eventType === 'capacity.recovered')).toBe(false);
    await fs.writeFile(path.join(dir, '.git'), metadata);
    expect(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()).toBe(f.git('rev-parse', 'HEAD'));
    expect((await service.sweep()).deploymentSources!.removed).toContain(dir);
    expect(f.ledger.list().some(n => n.eventType === 'capacity.recovered')).toBe(true);
  });
  it('preserves a partially deleted tracked tree, reports risk, and recovers only after historical repair and safe reclaim', async () => {
    const f = await fixture(),
      dir = await f.make(),
      data = await f.make();
    await fs.mkdir(path.join(data, '.cds-run-data'));
    await fs.writeFile(path.join(data, '.cds-run-data', 'db'), 'business sentinel');
    await fs.utimes(data, f.old, f.old);
    await fs.unlink(path.join(dir, 'source.txt'));
    await fs.utimes(dir, f.old, f.old);
    const service = observe(f);
    const first = await service.sweep();
    expect(
      first.deploymentSources!.failed.map((x) => x.path),
      'tracked deletions are not a clean protected source',
    ).toContain(dir);
    await service.sweep();
    expect(f.ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(false);
    const restarted = observe(f);
    expect((await restarted.sweep()).deploymentSources!.failed.map((x) => x.path)).toContain(dir);
    expect(await fs.readFile(path.join(data, '.cds-run-data', 'db'), 'utf8')).toBe('business sentinel');
    execFileSync('git', ['-C', dir, 'restore', '--source=HEAD', '--worktree', '--', '.']);
    const bytes = await fs.readFile(path.join(dir, 'source.txt'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256').update('immutable historical source').digest('hex'),
    );
    await fs.utimes(dir, f.old, f.old);
    const recovered = await service.sweep();
    expect(recovered.deploymentSources!.removed).toContain(dir);
    expect(f.ledger.list().some((n) => n.eventType === 'capacity.recovered')).toBe(true);
    expect(await fs.readFile(path.join(data, '.cds-run-data', 'db'), 'utf8')).toBe('business sentinel');
  });
});

describe('bounded pending failure receipts', () => {
  it('keeps overflow unknown after individually recorded paths disappear', async () => {
    const { DeploymentSourceFailureTracker } = await import(
      '../../src/services/deployment-source-retention.js'
    );
    const f = await fixture(),
      dirs = await Promise.all([f.make(), f.make(), f.make()]);
    const tracker = new DeploymentSourceFailureTracker(2);
    const report = {
      scanned: 3,
      attempted: 3,
      removed: [] as string[],
      held: {},
      failed: dirs.map((dir) => ({ path: dir, error: 'controlled failure' })),
      deferred: 0,
      failureRecheckUnconfirmed: false,
    };
    await tracker.reconcile(report);
    expect(report.failureRecheckUnconfirmed).toBe(true);
    const skipped = {
      scanned: 0,
      attempted: 0,
      removed: [] as string[],
      held: {},
      failed: [] as Array<{ path: string; error: string }>,
      deferred: 3,
    };
    await tracker.reconcile(skipped);
    expect(skipped.failed.map((entry) => entry.path)).toEqual(dirs.slice(0, 2));
    for (const dir of dirs) f.git('worktree', 'remove', dir);
    const next = {
      scanned: 0,
      attempted: 0,
      removed: [] as string[],
      held: {},
      failed: [] as Array<{ path: string; error: string }>,
      deferred: 0,
      failureRecheckUnconfirmed: false,
    };
    await tracker.reconcile(next);
    expect(next.failed).toEqual([]);
    expect(next.failureRecheckUnconfirmed).toBe(true);
  });
  it('does not erase a current failed operation before a later pass confirms absence', async () => {
    const { DeploymentSourceFailureTracker } = await import(
      '../../src/services/deployment-source-retention.js'
    );
    const f = await fixture(),
      dir = path.join(f.root, 'already-removed');
    const tracker = new DeploymentSourceFailureTracker();
    const first = {
      scanned: 1,
      attempted: 1,
      removed: [] as string[],
      held: {},
      failed: [{ path: dir, error: 'operation failed after leaf removal' }],
      deferred: 0,
    };
    await tracker.reconcile(first);
    expect(first.failed).toHaveLength(1);
    const next = {
      scanned: 0,
      attempted: 0,
      removed: [] as string[],
      held: {},
      failed: [] as Array<{ path: string; error: string }>,
      deferred: 0,
    };
    await tracker.reconcile(next);
    expect(next.failed).toEqual([]);
  });
});
