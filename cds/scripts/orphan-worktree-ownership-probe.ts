import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type * as janitorTypes from '../src/services/janitor.js';
import type * as stateTypes from '../src/services/state.js';
import type * as worktreeTypes from '../src/services/worktree.js';
import type { IShellExecutor } from '../src/types.js';

export type OwnershipCase = 'create-before-state' | 'directory-replaced' | 'alias-retargeted';

/** 真实私有Git/FS及原创建、回收入口；受控交错不代替台账或回收判定。 */
export async function runOrphanOwnershipProbe(janitor: typeof janitorTypes, stateModule: typeof stateTypes,
  worktreeModule: typeof worktreeTypes, shell: IShellExecutor, privateRoot: string, scenario: OwnershipCase) {
  assert.match(path.basename(privateRoot), /^cds-orphan-ownership-/);
  privateRoot = await fs.realpath(privateRoot);
  const root = path.join(privateRoot, scenario), base = path.join(root, 'worktrees');
  const candidate = path.join(base, 'proj', 'owned');
  const real = path.join(base, 'legacy'), replacement = path.join(base, 'replacement');
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  if (scenario === 'alias-retargeted') {
    await fs.mkdir(real); await fs.mkdir(replacement);
    await fs.writeFile(path.join(replacement, 'must-survive'), 'replacement');
    await fs.symlink(real, candidate, 'dir');
  } else await fs.mkdir(candidate);
  await fs.writeFile(path.join(candidate, 'must-survive'), 'original');
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  await fs.utimes(candidate, old, old);
  if (scenario === 'alias-retargeted') await fs.utimes(replacement, old, old);
  const state = new stateModule.StateService(path.join(root, 'state.json'));
  const createdAt = new Date().toISOString();
  state.addProject({ id: 'proj', slug: 'proj', name: 'Owned project', kind: 'git', createdAt, updatedAt: createdAt });
  let mutated = false, releaseCreate = () => {}, creation: Promise<void> | undefined, expectedHead = '';
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = async (cmd: string, cwd?: string) => {
    const result = await shell.exec(cmd, { cwd, executionLane: 'operation', timeout: 15000 });
    assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim();
  };
  if (scenario === 'create-before-state') {
    const origin = path.join(root, 'origin'), repo = path.join(root, 'repo');
    await fs.mkdir(origin); await command('git init -b main', origin);
    await command('git config user.name cds-owned-test', origin);
    await command('git config user.email cds-owned-test@example.invalid', origin);
    await fs.writeFile(path.join(origin, 'owned-source'), 'private-source');
    await command('git add owned-source', origin); await command('git commit -m owned-source', origin);
    expectedHead = await command('git rev-parse HEAD', origin);
    await command(`git clone ${quote(origin)} ${quote(repo)}`, root);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { releaseCreate = resolve; });
    const gated: IShellExecutor = { exec: async (cmd, options) => {
      if (cmd.startsWith('git fetch')) { entered(); await released; }
      return shell.exec(cmd, options);
    } };
    creation = new worktreeModule.WorktreeService(gated).create(repo, 'main', candidate);
    // rejection is observed immediately as well as awaited in finally.
    void creation.catch(() => {}); await started;
  }
  const files: janitorTypes.OrphanWorktreeFs = { ...janitor.defaultOrphanWorktreeFs,
    listMountedHostPaths: async () => [], // owned fixture has no containers.
    statDirMtimeMs: async dir => {
      const mtime = await janitor.defaultOrphanWorktreeFs.statDirMtimeMs(dir);
      if (dir === candidate && !mutated && scenario !== 'create-before-state') {
        mutated = true;
        if (scenario === 'directory-replaced') {
          await fs.rename(candidate, path.join(root, 'previous-directory'));
          await fs.mkdir(candidate); await fs.writeFile(path.join(candidate, 'must-survive'), 'replacement');
          await fs.utimes(candidate, old, old);
        } else { await fs.unlink(candidate); await fs.symlink(replacement, candidate, 'dir'); }
      }
      return mtime;
    },
  };
  const runner = new janitor.JanitorService(state, { enabled: false, worktreeTTLDays: 7,
    diskWarnPercent: 80, sweepIntervalSeconds: 3600, dockerPrune: false, imageRetention: false },
  base, undefined, () => null, async () => ({ ran: false, reclaimed: [], errors: [] }),
  { listImages: async () => [], listInUseImages: async () => [], removeImage: async () => null }, files);
  try {
    const report = await runner.sweep(); let protectedDuringOperation = false;
    try { protectedDuringOperation = await fs.readFile(path.join(candidate, 'must-survive'), 'utf8')
      === (scenario === 'create-before-state' ? 'original' : 'replacement'); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
    const noStateClaim = state.getAllBranches().length === 0;
    let actualCreationHead: string | undefined;
    if (creation) { releaseCreate(); await creation; actualCreationHead = await command('git rev-parse HEAD', candidate);
      assert.equal(actualCreationHead, expectedHead); assert.equal(await fs.readFile(path.join(candidate, 'owned-source'), 'utf8'), 'private-source'); }
    return { scenario, protectedDuringOperation, noStateClaim, actualCreationHead,
      removed: report.orphanWorktrees!.removed, keptReason: report.orphanWorktrees!.keptReasons[candidate],
      errors: report.errors, privateFilesOnly: true, actualApplicationDeploymentVerified: false };
  } finally { releaseCreate(); await creation; await state.flush(); }
}
