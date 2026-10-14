import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type * as janitorTypes from '../src/services/janitor.js';
import type * as stateTypes from '../src/services/state.js';

export type RecheckCase = 'claim-during-stat' | 'claim-during-previous-remove' | 'claim-real-during-stat';

export async function probeEnumerationYield(janitor: typeof janitorTypes, privateRoot: string) {
  assert.match(path.basename(privateRoot), /^cds-orphan-recheck-/);
  const base = path.join(privateRoot, 'yield-worktrees');
  for (let index = 0; index < 128; index++) await fs.mkdir(path.join(base, 'proj', `owned-${index}`), { recursive: true });
  let ticks = 0, enabled = true;
  const tick = () => { ticks++; if (enabled) setImmediate(tick); };
  const handle = setImmediate(tick);
  const started = performance.now();
  try {
    const result = await janitor.defaultOrphanWorktreeFs.listWorktreeDirs(base, ['proj']);
    assert.equal(result.dirs.length, 128); assert.deepEqual(result.unreadable, []);
    return { ticksDuringEnumeration: ticks, elapsedMs: performance.now() - started, directories: result.dirs.length,
      scope: 'private real FS event-loop yield only; no public latency or IO capacity assertion' };
  } finally { enabled = false; clearImmediate(handle); }
}

/** 原状态类和实际私有文件操作；只在既有await接缝写入新认领，不替代回收判定。 */
export async function runOrphanRecheckProbe(janitor: typeof janitorTypes, stateModule: typeof stateTypes,
  privateRoot: string, scenario: RecheckCase) {
  assert.match(path.basename(privateRoot), /^cds-orphan-recheck-/);
  // 与真实枚举返回的规范路径一致（macOS临时目录别名不能冒充真身身份）。
  privateRoot = await fs.realpath(privateRoot);
  const root = path.join(privateRoot, scenario), base = path.join(root, 'worktrees');
  const first = path.join(base, 'proj', '00-first');
  const candidate = path.join(base, 'proj', '10-later');
  const real = path.join(base, 'legacy');
  await fs.mkdir(first, { recursive: true });
  if (scenario === 'claim-real-during-stat') {
    await fs.mkdir(real); await fs.symlink(real, candidate, 'dir');
  } else await fs.mkdir(candidate);
  const marker = path.join(candidate, 'must-survive');
  await fs.writeFile(marker, 'owned-live-worktree');
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  await fs.utimes(first, old, old); await fs.utimes(candidate, old, old);
  const state = new stateModule.StateService(path.join(root, 'state.json'));
  const createdAt = new Date().toISOString();
  state.addProject({ id: 'proj', slug: 'proj', name: 'Owned project', kind: 'git', createdAt, updatedAt: createdAt });
  let claimed = false;
  const claimedPath = scenario === 'claim-real-during-stat' ? real : candidate;
  const claim = () => {
    assert.equal(claimed, false); claimed = true;
    state.addBranch({ id: 'claimed', projectId: 'proj', branch: 'owned-live', worktreePath: claimedPath,
      status: 'idle', services: {}, createdAt });
  };
  const files: janitorTypes.OrphanWorktreeFs = {
    ...janitor.defaultOrphanWorktreeFs,
    listMountedHostPaths: async () => [], // 私有无容器布局；本probe不启动Docker。
    listWorktreeDirs: async (...args) => {
      const enumeration = await janitor.defaultOrphanWorktreeFs.listWorktreeDirs(...args);
      enumeration.dirs.sort((a, b) => a.path.localeCompare(b.path)); return enumeration;
    },
    statDirMtimeMs: async dir => {
      const value = await janitor.defaultOrphanWorktreeFs.statDirMtimeMs(dir);
      if (dir === candidate && scenario !== 'claim-during-previous-remove') claim();
      return value;
    },
    removeDir: async dir => {
      const result = await janitor.defaultOrphanWorktreeFs.removeDir(dir);
      if (dir === first && scenario === 'claim-during-previous-remove') claim();
      return result;
    },
  };
  const runner = new janitor.JanitorService(state, { enabled: false, worktreeTTLDays: 7,
    diskWarnPercent: 80, sweepIntervalSeconds: 3600, dockerPrune: false, imageRetention: false },
  base, undefined, () => null, async () => ({ ran: false, reclaimed: [], errors: [] }),
  { listImages: async () => [], listInUseImages: async () => [], removeImage: async () => null }, files);
  try {
    const report = await runner.sweep();
    assert.equal(claimed, true); assert.equal(state.getBranch('claimed')?.worktreePath, claimedPath);
    let markerSurvived = false;
    try { markerSurvived = await fs.readFile(marker, 'utf8') === 'owned-live-worktree'; }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); }
    assert.ok(report.orphanWorktrees?.removed.includes(first));
    return { scenario, markerSurvived, actualStateClaimConfirmed: true, claimedPath,
      removed: report.orphanWorktrees!.removed, keptReason: report.orphanWorktrees!.keptReasons[candidate],
      errors: report.errors, privateFilesOnly: true, noActualDeploymentOrPublicPerformance: true };
  } finally { await state.flush(); }
}
