import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const compiledRoot = process.env.CDS_FS_REMOVAL_COMPILED_DIR;
const moduleUrl = (name: string) => compiledRoot ? pathToFileURL(path.join(compiledRoot, `services/${name}.js`)).href
  : new URL(`../../src/services/${name}.ts`, import.meta.url).href;
const { WorktreeService } = await import(moduleUrl('worktree')) as typeof import('../../src/services/worktree.js');
const { IsolatedShellExecutor } = await import(moduleUrl('isolated-shell-executor')) as typeof import('../../src/services/isolated-shell-executor.js');
const { StateService } = await import(moduleUrl('state')) as typeof import('../../src/services/state.js');
const { JanitorService, defaultOrphanWorktreeFs } = await import(moduleUrl('janitor')) as typeof import('../../src/services/janitor.js');
const { worktreePathActivity } = await import(moduleUrl('worktree-path-activity')) as typeof import('../../src/services/worktree-path-activity.js');

describe('实际Git创建到台账受理的完整活动窗口', () => {
  it('创建返回后、异步认领未完成时仍拒绝回收，受理后交给真实台账保护', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-claim-handoff-')));
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const state = new StateService(path.join(root, 'state.json')); let rawFallbackCalls=0;
    const pool=new IsolatedShellExecutor({exec:async()=>{rawFallbackCalls++;throw new Error('forbidden raw Git fallback');}},
      {isolatedLane:'operation',concurrency:2,maxQueued:4,maxBytes:256*1024,reservedCleanup:1,reservedCleanupBytes:64*1024});
    let poolPids:number[]=[];
    try {
      const source = path.join(root, 'source'), repo = path.join(root, 'repo'); await fs.mkdir(source);
      git(['init', '--initial-branch=main'], source); git(['config', 'user.name', 'private-test'], source);
      git(['config', 'user.email', 'private-test@example.invalid'], source);
      await fs.writeFile(path.join(source, 'marker'), 'actual-git-content'); git(['add', '.'], source); git(['commit', '-m', '私有创建受理验证'], source);
      const sha = git(['rev-parse', 'HEAD'], source); git(['clone', source, repo], root);
      const base = path.join(root, 'worktrees'), dir = path.join(base, 'proj', 'owned'); await fs.mkdir(path.dirname(dir), { recursive: true });
      const now = new Date().toISOString(); state.addProject({ id: 'proj', slug: 'proj', name: 'Private', kind: 'git', createdAt: now, updatedAt: now });
      const janitor = new JanitorService(state, { enabled: true, worktreeTTLDays: 7,
        diskWarnPercent: 80, sweepIntervalSeconds: 3600, dockerPrune: false, imageRetention: false }, base,
        undefined, () => null, undefined, undefined, { ...defaultOrphanWorktreeFs, listMountedHostPaths: async () => [] });
      await pool.start();const deadline=Date.now()+5000;
      while(pool.getStats().actors.filter(a=>a.heapLimit!==undefined).length!==2) {
        if(Date.now()>=deadline)throw new Error('Owned Git actors did not arrive within original startup budget');
        await new Promise(r=>setTimeout(r,5));
      }
      const metrics=pool.getStats();poolPids=[metrics.supervisorPid!,metrics.factoryPid!,...metrics.actors.map(a=>a.pid)];
      const service = new WorktreeService(pool);
      await worktreePathActivity.withClaim([dir, WorktreeService.deploymentSourceRootFor(dir)], async () => {
        await service.create(repo, 'main', dir);
        // 年龄重新设为可回收，避免“刚创建所以太新”掩盖真实受理窗口的保护。
        const old = new Date(Date.now() - 24 * 3600_000); await fs.utimes(dir, old, old);
        const result = await janitor.runSweep(); expect(state.getBranch('owned')).toBeUndefined();
        expect(result.orphanWorktrees?.removed).toEqual([]);
        expect(await fs.readFile(path.join(dir, 'marker'), 'utf8')).toBe('actual-git-content');
        state.addBranch({ id: 'owned', projectId: 'proj', branch: 'main', worktreePath: dir,
          services: {}, status: 'idle', createdAt: now });
      });
      expect(git(['rev-parse', 'HEAD'], dir)).toBe(sha);
      expect((await janitor.runSweep()).orphanWorktrees?.removed).toEqual([]);
      expect(state.getBranch('owned')?.worktreePath).toBe(dir);
      expect(rawFallbackCalls).toBe(0);
      console.info(JSON.stringify({actualGitClaimHandoff:true,gitHead:sha,eligibleAgeProtected:true,actualStateRegistered:true,rawFallbackCalls}));
    } finally {
      await pool.close();
      const closedProcesses=poolPids.map(pid=>{let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();}catch{}return{pid,state};});
      expect(closedProcesses.every(row=>!row.state||row.state.startsWith('Z'))).toBe(true);
      console.info(JSON.stringify({actualGitPoolClosed:true,closedProcesses}));
      await state.flush();await fs.rm(root,{recursive:true,force:true});
    }
  }, 20000);
});
