import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { reclaimDeploymentSources } from '../../src/services/deployment-source-retention.js';
import { defaultOrphanWorktreeFs } from '../../src/services/janitor.js';
import { removeOwnedDirectory } from '../../src/services/worktree-directory-removal-process.js';
import { readWorktreeDirectoryIdentity, worktreePathActivity, WorktreeClaimHeldError } from '../../src/services/worktree-path-activity.js';
import { computeImageRetentionPlan } from '../../src/services/image-retention.js';
import { buildReleaseReclaimCommand, computeReleaseArtifactRetentionPlan, parseRemoteReclaimOutcome } from '../../src/services/release-artifact-retention.js';
import type { BranchEntry, ReleaseTarget, ReleaseStrategy } from '../../src/types.js';

const scratch: string[] = [];
const DAY = 86400_000, PAYLOAD = 64 * 1024;
const start = Date.parse('2026-01-01T00:00:00Z');
const sha = (n: number) => n.toString(16).padStart(40, '0');
const image = (n: number) => `ghcr.io/capacity-fixture/api:sha-${sha(n)}`;
const digest = (text: Buffer) => createHash('sha256').update(text).digest('hex');
const evidence: Record<string, unknown> = {};

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  // Opt-in evidence output; never writes to a production path or tracked report.
  if (process.env.CAPACITY_DRILL_EVIDENCE) {
    await fs.writeFile(process.env.CAPACITY_DRILL_EVIDENCE, JSON.stringify(evidence, null, 2));
  }
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'capacity-growth-')));
  scratch.push(root);
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Capacity fixture');
  await fs.writeFile(path.join(repo, 'source.bin'), Buffer.alloc(PAYLOAD, 37));
  git('add', '.'); git('commit', '-m', '隔离增长演练');
  return { root, repo, git };
}

describe('equivalent fourteen-day retention and recovery drill (isolated files only)', () => {
  it('bounds real detached sources, protects active/rollback/inflight/data, retries failure and killed worker', async () => {
    const f = await fixture(), base = path.join(f.root, 'worktrees');
    const bucket = path.join(base, 'project', '.deployment-sources', 'branch');
    await fs.mkdir(bucket, { recursive: true });
    const make = async (now = start) => {
      const dir = path.join(bucket, randomUUID()); f.git('worktree', 'add', '--detach', dir, 'HEAD');
      await fs.utimes(dir, new Date(now - 4 * 3600_000), new Date(now - 4 * 3600_000));
      return dir;
    };
    const active = await make(), rollback = await make(), inflight = await make(), data = await make();
    await fs.mkdir(path.join(data, '.cds-run-data'));
    await fs.writeFile(path.join(data, '.cds-run-data', 'business.db'), 'business sentinel');
    await fs.utimes(data, new Date(start - DAY), new Date(start - DAY));
    const refs: BranchEntry[] = [{ id: 'branch', projectId: 'project', branch: 'feature', status: 'running',
      createdAt: new Date(start).toISOString(), services: {
        active: { profileId: 'active', status: 'running', sourceCheckoutPath: active },
        rollback: { profileId: 'rollback', status: 'stopped', sourceCheckoutPath: rollback },
      } } as BranchEntry];
    const claim = worktreePathActivity.tryAcquire([inflight]); expect(claim).toBeTruthy();
    const protectedHash = digest(await fs.readFile(path.join(rollback, 'source.bin')));
    let failPath = '', failOnce = false, now = start;
    const files = { ...defaultOrphanWorktreeFs, listMountedHostPaths: async () => [] as string[] | null,
      removeDir: async (dir: string, options: any) => {
        options.beforeStart();
        if (dir === failPath && failOnce) { failOnce = false; return 'controlled EIO; no removal'; }
        const result = await removeOwnedDirectory({ ...options, dir });
        if (result === 'held') throw new WorktreeClaimHeldError();
        return null;
      } };
    const sweep = () => reclaimDeploymentSources({ base, projectIds: ['project'], branches: () => refs, files, nowMs: now });
    const rows: unknown[] = [];
    const allocatedBytes = () => Number(execFileSync('du', ['-sx', '--block-size=1', '--', bucket], {encoding:'utf8'}).split(/\s+/)[0]);
    let generated = 0, reclaimed = 0, reclaimedAllocatedBytes = 0, regenerationSha = '';
    try {
      for (let day = 1; day <= 14; day++) {
        now = start + day * DAY;
        await fs.writeFile(path.join(f.repo, 'source.bin'), Buffer.alloc(PAYLOAD, 37 + day));
        f.git('commit', '-am', `第${day}天的新产物`);
        if (day === 1) regenerationSha = f.git('rev-parse', 'HEAD');
        const added: string[] = [];
        for (let i = 0; i < 8; i++) { added.push(await make(now)); generated++; }
        const beforeBytes = allocatedBytes();
        if (day === 3) { failPath = added[0]; failOnce = true; }
        if (day === 5) {
          // Run the actual deletion primitive in a separate Node process. Kill
          // after its first confirmed removal, before the remaining backlog.
          const victim = added[0], identity = await readWorktreeDirectoryIdentity(victim);
          const module = fileURLToPath(new URL('../../src/services/worktree-directory-removal-process.ts', import.meta.url));
          const code = `import {removeOwnedDirectory} from ${JSON.stringify(module)};
            const result = await removeOwnedDirectory(JSON.parse(process.argv[1]));
            process.stdout.write(JSON.stringify({result})+'\\n');
            setInterval(()=>{},1000);`;
          const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code,
            JSON.stringify({ dir: victim, allowedBase: base, identity, entryOnly: false, sourceOnly: true })],
          { stdio: ['ignore', 'pipe', 'pipe'] });
          const output = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker checkpoint timeout')); }, 10000);
            child.stdout.once('data', value => { clearTimeout(timer); resolve(value.toString()); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited before checkpoint')); });
          });
          const exited = once(child, 'exit'); child.kill('SIGTERM');
          expect(await exited).toEqual([null, 'SIGTERM']);
          expect(JSON.parse(output).result).toBe('removed'); reclaimed++;
          await expect(fs.access(victim)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await fs.stat(added[1])).toBeTruthy();
        }
        const first = await sweep(); reclaimed += first.removed.length;
        if (day === 3) {
          expect(first.failed.map(entry => entry.path)).toContain(failPath);
          expect(await fs.stat(failPath)).toBeTruthy();
        }
        const retry = await sweep(); reclaimed += retry.removed.length;
        expect(retry.failed).toEqual([]);
        const remaining = await fs.readdir(bucket);
        expect(remaining).toHaveLength(4);
        for (const protectedDir of [active, rollback, inflight, data]) {
          expect(digest(await fs.readFile(path.join(protectedDir, 'source.bin')))).toBe(protectedHash);
        }
        expect(await fs.readFile(path.join(data, '.cds-run-data', 'business.db'), 'utf8')).toBe('business sentinel');
        expect(f.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(5); // repo + four holds
        const afterBytes = allocatedBytes(); reclaimedAllocatedBytes += beforeBytes - afterBytes;
        rows.push({ day, generated, reclaimed, retained: remaining.length, beforeAllocatedBytes:beforeBytes,
          afterAllocatedBytes:afterBytes, retainedPayloadBytes: 4 * PAYLOAD });
      }
      // A rollback actually reads its exact old bytes; released references can
      // then be reclaimed without harming the active service or business data.
      refs[0].services.active.sourceCheckoutPath = rollback;
      delete refs[0].services.rollback;
      claim!.release();
      const released = await sweep();
      expect(released.removed.sort()).toEqual([active, inflight].sort());
      expect(digest(await fs.readFile(path.join(rollback, 'source.bin')))).toBe(protectedHash);
      const regenerated = path.join(f.root, 'regenerated-cache');
      f.git('worktree', 'add', '--detach', regenerated, regenerationSha);
      expect(await fs.readFile(path.join(regenerated, 'source.bin'))).toEqual(Buffer.alloc(PAYLOAD, 38));
      expect(execFileSync('git', ['-C', regenerated, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim()).toBe(regenerationSha);
      evidence.sources = { equivalentDays: 14, generated, reclaimed, generatedPayloadBytes: generated * PAYLOAD,
        retainedPayloadBytes: 4 * PAYLOAD, reclaimedAllocatedBytes, protectedHash, rows, failureRetry: true, killedWorkerRetry: true,
        rollbackReadVerified: true, deletedCacheRegenerated: true, regenerationSha,
        releasedReferencesReclaimed: 2, businessDataPreserved: true,
        accounting: 'payload and du allocated bytes reported separately; Git common-dir metadata excluded from source bucket' };
    } finally { claim!.release(); }
  }, 60000);

  it('bounds per-SHA images by recent generations and explicit live/inflight/rollback references', () => {
    const host = new Set([image(1), image(2), image(3), 'mongo:8', 'foreign:sha-' + sha(1)]);
    const ledger: Array<{image:string;branchId:string;profileId:string;createdAt:string}> = [];
    const refs = [image(1), image(2), image(3)];
    const rows: unknown[] = [];
    for (let day = 1; day <= 14; day++) {
      for (let i = 0; i < 12; i++) {
        const n = day * 100 + i; host.add(image(n));
        ledger.push({image:image(n),branchId:'branch',profileId:'api',createdAt:new Date(start + day * DAY + i).toISOString()});
      }
      const plan = computeImageRetentionPlan({ledger,hostImages:[...host],inUseImages:refs,keepGenerations:5,maxRemovals:40});
      for (const ref of plan.remove) { expect(refs).not.toContain(ref); host.delete(ref); }
      expect(host.size).toBe(10); // 5 recent + 3 protected + 2 foreign
      expect(plan.deferred).toBe(0);
      rows.push({day,retained:host.size,removed:plan.remove.length});
    }
    evidence.images = { equivalentDays:14, generated:168, retainedManaged:8, protectedReferences:3, rows,
      accounting:'model of Docker inventory using the production planner; no actual image bytes or Docker deletion' };
  });

  it('bounds real static release files and preserves old current/previous and in-flight runs', async () => {
    const f = await fixture(), publish = path.join(f.root, 'public'), versions = path.join(publish, '.releases');
    await fs.mkdir(versions, {recursive:true});
    const id = (n:number) => 'rel_' + n.toString(16).padStart(16,'0');
    const make = async (n:number) => { await fs.mkdir(path.join(versions,id(n))); await fs.writeFile(path.join(versions,id(n),'index.html'),Buffer.alloc(PAYLOAD,n%256)); };
    await make(1);await make(2);
    await fs.symlink(path.join(versions,id(1)),path.join(publish,'current'));
    await fs.symlink(path.join(versions,id(2)),path.join(publish,'previous'));
    const target = {id:'fixture',ssh:{appPath:f.repo}} as ReleaseTarget;
    const strategy = {mode:'generated-static',publicDirectory:publish} as ReleaseStrategy;
    const ledger: Array<{releaseId:string;status:'success';startedAt:string}> = [];
    const rows: unknown[] = []; let removed=0;
    for (let day=1;day<=14;day++) {
      for (let i=0;i<4;i++) {const n=100*day+i;await make(n);ledger.push({releaseId:id(n),status:'success',startedAt:new Date(start+day*DAY+i).toISOString()});}
      const inventory = {currentTarget:await fs.readlink(path.join(publish,'current')),previousTarget:await fs.readlink(path.join(publish,'previous')),
        versions:await fs.readdir(versions),worktrees:[],releaseRoot:publish,worktreeRoot:path.join(f.root,'.cds-releases/fixture/worktrees')};
      const plan = computeReleaseArtifactRetentionPlan({mode:'generated-static',inventory,ledgerRuns:ledger,hasInFlightRun:day===4,drift:'in-sync',keepRecent:3});
      if(day===4) {expect(plan.removeVersions).toEqual([]);expect(plan.skippedReason).toBeTruthy();}
      const command=buildReleaseReclaimCommand(target,strategy,plan);
      if(command) {const outcome=parseRemoteReclaimOutcome(execFileSync('/bin/sh',['-c',command],{encoding:'utf8'}));
        expect(outcome.failedVersions).toEqual([]);expect(outcome.removedVersions).toEqual(plan.removeVersions);removed+=outcome.removedVersions.length;}
      const retained=await fs.readdir(versions);expect(retained.length).toBeLessThanOrEqual(day===4?9:5);
      expect(await fs.readFile(path.join(publish,'current','index.html'))).toEqual(Buffer.alloc(PAYLOAD,1));
      expect(await fs.readFile(path.join(publish,'previous','index.html'))).toEqual(Buffer.alloc(PAYLOAD,2));
      rows.push({day,retained:retained.length,removed});
    }
    // Exercise a real pointer rollback and recovery after the growth window,
    // using the deliberately old previous bytes, then restore current.
    const current = path.join(publish, 'current'), next = path.join(publish, '.current-next');
    await fs.symlink(await fs.readlink(path.join(publish, 'previous')), next);
    await fs.rename(next, current);
    expect(await fs.readFile(path.join(current, 'index.html'))).toEqual(Buffer.alloc(PAYLOAD, 2));
    await fs.symlink(path.join(versions, id(1)), next); await fs.rename(next, current);
    expect(await fs.readFile(path.join(current, 'index.html'))).toEqual(Buffer.alloc(PAYLOAD, 1));
    evidence.releases={equivalentDays:14,generated:56,removed,retained:5,retainedPayloadBytes:5*PAYLOAD,
      currentAndPreviousPreserved:true,rollbackSwitchAndRestoreVerified:true,inFlightSweepSkipped:true,rows,
      accounting:'real static payload files, production plan and shell command, isolated target'};
  }, 30000);
});
