import { describe, it, expect, vi } from 'vitest';
import { parseRuntimeCapacityGuard, captureGuardedRuntime } from '../../src/services/guarded-runtime.js';
import type { BranchEntry } from '../../src/types.js';

const sha = 'a'.repeat(40), cid = 'b'.repeat(64), image = 'registry.example/app@sha256:' + 'c'.repeat(64);
function fixture() {
  const entry = { id: 'preview', branch: 'feature/preview', projectId: 'project',
    githubCommitSha: sha, status: 'idle', services: { api: { profileId: 'api', containerName: 'same-name',
      containerId: cid, status: 'stopped', hostPort: 1000, deployedImage: image, sourceCommitSha: sha } },
  } as BranchEntry;
  const guard = parseRuntimeCapacityGuard({ expectedMaxHotBranches: 25, expectedCommitSha: sha,
    expectedContainers: { api: cid }, expectedImage: image, yieldFirst: true })!;
  return { entry, guard };
}
describe('explicit exact-runtime protection', () => {
  it('never silently downgrades malformed or extended guards to ordinary operations', () => {
    expect(parseRuntimeCapacityGuard(undefined)).toBeNull();
    for (const bad of [null, [], {}, { ...fixture().guard, yieldFirst: false },
      { ...fixture().guard, expectedCommitSha: 'short' }, { ...fixture().guard, target: 'other' },
      { ...fixture().guard, expectedContainers: { api: 'short' } },
      { ...fixture().guard, expectedImage: 'registry.example/app:latest' }])
      expect(() => parseRuntimeCapacityGuard(bad)).toThrow();
  });
  it('rejects missing, extra, same-name replaced and retained runtimes before any physical mutation', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.guard.expectedContainers = {}; },
      (f: ReturnType<typeof fixture>) => { f.entry.services.api.containerId = 'd'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.entry.services.api.retainedRuntimes = [{ containerName: 'old', containerId: 'e'.repeat(64), hostPort: 999 }]; },
      (f: ReturnType<typeof fixture>) => { f.entry.services.api.deployedImage = 'other@sha256:' + 'd'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.entry.services.api.sourceCommitSha = 'd'.repeat(40); },
      (f: ReturnType<typeof fixture>) => { f.entry.services.api.retainedRuntimes = [{ containerName: 'same-name', containerId: 'e'.repeat(64), hostPort: 999 }]; },
    ]) {
      const f = fixture(); change(f); expect(() => captureGuardedRuntime(f.entry, f.guard, 'restart')).toThrow();
    }
  });
  it('checks every physical container before mutation and detects identity changes across await', async () => {
    const f = fixture(), snapshot = captureGuardedRuntime(f.entry, f.guard, 'restart');
    const inspectGuardedRuntime = vi.fn(async () => {
      f.entry.services.api.containerId = 'd'.repeat(64);
      return { containerId: cid, containerName: 'same-name', hostPort: 1000 };
    });
    await expect(snapshot.inspectAll({ inspectGuardedRuntime } as any, () => {})).rejects.toThrow('身份已变化');
    expect(inspectGuardedRuntime).toHaveBeenCalledWith(f.entry, 'api', expect.objectContaining({ containerId: cid }), image, sha, false);
  });
  it('refuses disappearance, configuration replacement and operation supersession', async () => {
    const f = fixture(), snapshot = captureGuardedRuntime(f.entry, f.guard, 'stop');
    await expect(snapshot.inspectAll({ inspectGuardedRuntime: vi.fn(async () => null) } as any, () => {})).rejects.toThrow('不存在');
    f.entry.profileOverrides = { api: { containerWorkDir: '/changed' } };
    expect(snapshot.assertCurrent).toThrow('配置已变化');
    const g = fixture(), second = captureGuardedRuntime(g.entry, g.guard, 'restart');
    const inspect = vi.fn();
    await expect(second.inspectAll({ inspectGuardedRuntime: inspect } as any, () => { throw new Error('superseded'); })).rejects.toThrow('superseded');
    expect(inspect).not.toHaveBeenCalled();
  });
  it('a changed port or retained descriptor cannot redirect readiness after capture', () => {
    const f = fixture(), snapshot = captureGuardedRuntime(f.entry, f.guard, 'restart');
    f.entry.services.api.hostPort = 9999;
    expect(snapshot.assertCurrent).toThrow('身份已变化');
    const g = fixture(), second = captureGuardedRuntime(g.entry, g.guard, 'restart');
    g.entry.services.api.pendingRuntime = { ...g.entry.services.api, containerId: 'd'.repeat(64) };
    expect(second.assertCurrent).toThrow('身份已变化');
  });
});
