import { describe, expect, it } from 'vitest';
import { branchExtraVolumePrefix, parseBranchExtraVolumes } from '../../src/services/branch-extra-volumes.js';

describe('branch-local persistent extra-service volumes', () => {
  const mount = { kind: 'volume', hostPath: 'scheduler-data', containerPath: '/var/lib/mysql' };
  it('keeps data identity across source revisions and separates project/branch ownership', () => {
    const a = parseBranchExtraVolumes('project-a', 'branch', [mount])!;
    expect(a[0].hostPath).toBe(branchExtraVolumePrefix('project-a', 'branch') + 'scheduler-data');
    expect(parseBranchExtraVolumes('project-a', 'branch', a)).toEqual(a);
    expect(parseBranchExtraVolumes('project-b', 'branch', [mount])![0].hostPath).not.toBe(a[0].hostPath);
    expect(parseBranchExtraVolumes('project-a', 'other', [mount])![0].hostPath).not.toBe(a[0].hostPath);
    expect(() => parseBranchExtraVolumes('project-b', 'branch', a)).toThrow('其他分支');
  });
  it.each([
    [{ ...mount, kind: 'bind', hostPath: '/etc' }], [{ ...mount, hostPath: '../other' }],
    [{ ...mount, hostPath: '$(id)' }], [{ ...mount, containerPath: '/' }],
    [{ ...mount, containerPath: '/app/../data' }], [{ ...mount, containerPath: '/app//data' }],
    [mount, mount], null,
  ].map(raw => [raw]))('rejects unsafe or ambiguous volume input %#', raw => {
    expect(() => parseBranchExtraVolumes('a', 'b', raw)).toThrow();
  });
  it('preserves omitted existing mounts, with explicit empty list as the only removal request', () => {
    const prior = [mount as { kind: 'volume'; hostPath: string; containerPath: string }];
    expect(parseBranchExtraVolumes('a', 'b', undefined, prior)).toBe(prior);
    expect(parseBranchExtraVolumes('a', 'b', [], prior)).toEqual([]);
  });
});
