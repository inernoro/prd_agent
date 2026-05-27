import { describe, expect, it } from 'vitest';

import { reduceBranchListState, type BranchListItem, type BranchListSlice } from '../../web/src/lib/branch-list-state.js';

interface TestBranch extends BranchListItem {
  branch: string;
  status?: string;
}

function branches(count: number): TestBranch[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `branch-${index + 1}`,
    projectId: 'prd-agent',
    branch: `test-${index + 1}`,
    status: 'running',
  }));
}

function slice(items: TestBranch[]): BranchListSlice<TestBranch> {
  return {
    branches: items,
    lastKnownGoodBranches: items,
  };
}

describe('branch list state reducer', () => {
  it('keeps the current list when SSE snapshot is empty', () => {
    const current = slice(branches(12));
    const result = reduceBranchListState(current, {
      type: 'sseSnapshot',
      branches: [],
      source: '实时快照',
    });

    expect(result.state.branches).toHaveLength(12);
    expect(result.needsEmptyRecheck).toBe(true);
  });

  it('removes only the requested branch on branch.removed', () => {
    const current = slice(branches(12));
    const result = reduceBranchListState(current, {
      type: 'sseBranchRemove',
      branchId: 'branch-5',
      projectId: 'prd-agent',
    });

    expect(result.state.branches).toHaveLength(11);
    expect(result.state.branches.some((branch) => branch.id === 'branch-5')).toBe(false);
    expect(result.state.branches.some((branch) => branch.id === 'branch-6')).toBe(true);
  });

  it('ignores branch.removed for another project', () => {
    const current = slice(branches(2));
    const result = reduceBranchListState(current, {
      type: 'sseBranchRemove',
      branchId: 'branch-1',
      projectId: 'other-project',
    });

    expect(result.state.branches.map((branch) => branch.id)).toEqual(['branch-1', 'branch-2']);
  });

  it('allows a confirmed empty project to show empty state', () => {
    const result = reduceBranchListState(slice([]), {
      type: 'authoritativeLoaded',
      branches: [],
      source: '分支列表刷新',
      confirmedEmpty: true,
      projectBranchCount: 0,
    });

    expect(result.state.branches).toHaveLength(0);
    expect(result.needsEmptyRecheck).toBe(false);
  });

  it('keeps old branches on suspicious empty then accepts the recheck result', () => {
    const first = reduceBranchListState(slice(branches(12)), {
      type: 'authoritativeLoaded',
      branches: [],
      source: '分支列表刷新',
      projectBranchCount: 12,
    });

    expect(first.state.branches).toHaveLength(12);
    expect(first.needsEmptyRecheck).toBe(true);

    const second = reduceBranchListState(first.state, {
      type: 'authoritativeLoaded',
      branches: branches(3),
      source: '分支列表复核',
      projectBranchCount: 3,
      confirmedEmpty: true,
    });

    expect(second.state.branches).toHaveLength(3);
    expect(second.needsEmptyRecheck).toBe(false);
  });

  it('rechecks an empty response when project metadata says branches still exist', () => {
    const result = reduceBranchListState(slice([]), {
      type: 'authoritativeLoaded',
      branches: [],
      source: '分支列表刷新',
      projectBranchCount: 2,
    });

    expect(result.state.branches).toHaveLength(0);
    expect(result.state.projectWarning).toContain('仍有 2 个分支');
    expect(result.needsEmptyRecheck).toBe(true);
  });

  it('does not change branches for malformed SSE events', () => {
    const current = slice(branches(4));
    const result = reduceBranchListState(current, {
      type: 'sseMalformed',
      source: 'branch.updated',
    });

    expect(result.state.branches).toHaveLength(4);
    expect(result.state.branches.map((branch) => branch.id)).toEqual(current.branches.map((branch) => branch.id));
  });

  it('keeps last known good branches when refresh fails after a transient empty state', () => {
    const current = slice(branches(3));
    const suspicious = reduceBranchListState(current, {
      type: 'authoritativeLoaded',
      branches: [],
      source: '分支列表刷新',
      projectBranchCount: 3,
    });

    const failed = reduceBranchListState({ ...suspicious.state, branches: [] }, {
      type: 'refreshFailed',
      message: '分支列表复核失败',
    });

    expect(failed.state.branches.map((branch) => branch.id)).toEqual(['branch-1', 'branch-2', 'branch-3']);
    expect(failed.state.projectWarning).toBe('分支列表复核失败');
  });

  it('ignores SSE upserts without the current project identity', () => {
    const current = slice(branches(2));

    const missingProject = reduceBranchListState(current, {
      type: 'sseBranchUpsert',
      projectId: 'prd-agent',
      branch: { id: 'branch-3', branch: 'test-3' },
    });
    const wrongProject = reduceBranchListState(current, {
      type: 'sseBranchUpsert',
      projectId: 'prd-agent',
      branch: { id: 'branch-3', projectId: 'other-project', branch: 'test-3' },
    });

    expect(missingProject.state.branches.map((branch) => branch.id)).toEqual(['branch-1', 'branch-2']);
    expect(wrongProject.state.branches.map((branch) => branch.id)).toEqual(['branch-1', 'branch-2']);
  });

  it('patches only known branches in the current project and preserves projectId', () => {
    const current = slice(branches(2));

    const ignored = reduceBranchListState(current, {
      type: 'sseBranchPatch',
      branchId: 'branch-1',
      projectId: 'other-project',
      patch: { status: 'error' },
    });
    const patched = reduceBranchListState(ignored.state, {
      type: 'sseBranchPatch',
      branchId: 'branch-1',
      projectId: 'prd-agent',
      patch: { projectId: 'other-project', status: 'error' },
    });

    expect(ignored.state.branches[0].status).toBe('running');
    expect(patched.state.branches[0].status).toBe('error');
    expect(patched.state.branches[0].projectId).toBe('prd-agent');
  });
});
