import { describe, it, expect } from 'vitest';
import {
  isTrunkBranch,
  isBranchProtected,
  resolveBranchProtection,
  describeBranchProtectionReason,
  type BranchProtectionLookup,
} from '../../src/services/branch-protection.js';
import type { BranchEntry, Project } from '../../src/types.js';

/**
 * 分支保护 SSOT 回归测试。
 *
 * 事故背景（2026-07-27 P0）：CDS 把主分支 main 直接删掉了。
 * scheduler 有主干保护、janitor 自己另写了一份且漏了那条，`Project.defaultBranch`
 * （CDS 分支 id）未配置时 janitor 就把 main 当过期分支整条回收。
 * 本文件锁死判定语义；janitor / scheduler / webhook 三处消费同一份。
 */

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    slug: 'proj',
    name: 'Proj',
    kind: 'git',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Project;
}

function makeBranch(over: Partial<BranchEntry> & { id: string; branch: string }): BranchEntry {
  return {
    projectId: 'p1',
    worktreePath: `/tmp/wt/${over.id}`,
    services: {},
    status: 'idle',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as BranchEntry;
}

/** 最小 lookup 假实现：不构造完整 StateService 也能锁死判定语义。 */
function makeLookup(
  projects: Project[],
  defaults: Record<string, string | null> = {},
): BranchProtectionLookup {
  return {
    getProject: (idOrSlug) => projects.find((p) => p.id === idOrSlug || p.slug === idOrSlug),
    getDefaultBranchFor: (projectId) => (projectId ? defaults[projectId] ?? null : null),
  };
}

describe('isTrunkBranch', () => {
  it('按项目上报的远端默认分支名判定主干', () => {
    const project = makeProject({ gitDefaultBranch: 'develop' });
    expect(isTrunkBranch(makeBranch({ id: 'proj-develop', branch: 'develop' }), project)).toBe(true);
  });

  it('项目没有 gitDefaultBranch 时兜底认 main / master', () => {
    expect(isTrunkBranch(makeBranch({ id: 'proj-main', branch: 'main' }), makeProject())).toBe(true);
    expect(isTrunkBranch(makeBranch({ id: 'proj-master', branch: 'master' }), makeProject())).toBe(true);
    expect(isTrunkBranch(makeBranch({ id: 'proj-main', branch: 'main' }), undefined)).toBe(true);
  });

  it('gitDefaultBranch 指向别的分支时 main/master 仍受保护（宁可少删不可误删）', () => {
    const project = makeProject({ gitDefaultBranch: 'develop' });
    expect(isTrunkBranch(makeBranch({ id: 'proj-main', branch: 'main' }), project)).toBe(true);
  });

  it('普通功能分支不是主干', () => {
    expect(isTrunkBranch(makeBranch({ id: 'proj-feat', branch: 'feat/login' }), makeProject())).toBe(false);
    // 前缀相同但不同名的分支不能被误判成主干
    expect(isTrunkBranch(makeBranch({ id: 'proj-mainline', branch: 'mainline' }), makeProject())).toBe(false);
    expect(isTrunkBranch(makeBranch({ id: 'x', branch: 'feature/main' }), makeProject())).toBe(false);
  });

  it('分支名为空时不判主干（缺信息不等于是主干）', () => {
    expect(isTrunkBranch(makeBranch({ id: 'blank', branch: '' }), makeProject())).toBe(false);
  });
});

describe('resolveBranchProtection', () => {
  const lookup = makeLookup([makeProject()]);

  it('pinnedByUser / isColorMarked / configPinned 各自命中并给出原因', () => {
    expect(resolveBranchProtection(makeBranch({ id: 'a', branch: 'a', pinnedByUser: true }), lookup))
      .toEqual({ protected: true, reason: 'pinned-by-user' });
    expect(resolveBranchProtection(makeBranch({ id: 'b', branch: 'b', isColorMarked: true }), lookup))
      .toEqual({ protected: true, reason: 'color-marked' });
    expect(resolveBranchProtection(makeBranch({ id: 'keep', branch: 'keep' }), lookup, ['keep']))
      .toEqual({ protected: true, reason: 'config-pinned' });
  });

  it('per-project 默认分支 id 命中时给出 default-branch', () => {
    const withDefault = makeLookup([makeProject()], { p1: 'proj-release' });
    expect(resolveBranchProtection(makeBranch({ id: 'proj-release', branch: 'release' }), withDefault))
      .toEqual({ protected: true, reason: 'default-branch' });
  });

  it('事故值：defaultBranch 未配置时，main 仍靠主干判定被保护', () => {
    const trunkLookup = makeLookup([makeProject({ gitDefaultBranch: 'main' })], {});
    expect(resolveBranchProtection(makeBranch({ id: 'proj-main', branch: 'main' }), trunkLookup))
      .toEqual({ protected: true, reason: 'trunk-branch' });
  });

  it('普通分支不受保护（不能过度保护导致回收失效）', () => {
    expect(resolveBranchProtection(makeBranch({ id: 'proj-feat', branch: 'feat/x' }), lookup))
      .toEqual({ protected: false, reason: null });
    expect(isBranchProtected(makeBranch({ id: 'proj-feat', branch: 'feat/x' }), lookup)).toBe(false);
  });

  it('多项目：A 项目的 main 不因 B 项目的 defaultBranch 配置而失去保护', () => {
    const multi = makeLookup(
      [makeProject({ id: 'pa', slug: 'a' }), makeProject({ id: 'pb', slug: 'b' })],
      // 只有 B 项目配了默认分支；A 项目一片空白
      { pb: 'b-main' },
    );
    const aMain = makeBranch({ id: 'a-main', branch: 'main', projectId: 'pa' });
    expect(resolveBranchProtection(aMain, multi))
      .toEqual({ protected: true, reason: 'trunk-branch' });
    // B 项目的普通分支照常可回收，保护没有外溢
    const bFeat = makeBranch({ id: 'b-feat', branch: 'feat/y', projectId: 'pb' });
    expect(isBranchProtected(bFeat, multi)).toBe(false);
  });

  it('每个原因都有中文说明（报表/日志直接可读）', () => {
    for (const reason of ['pinned-by-user', 'color-marked', 'default-branch', 'config-pinned', 'trunk-branch'] as const) {
      expect(describeBranchProtectionReason(reason).length).toBeGreaterThan(0);
    }
  });
});
