/**
 * Codex review（PR #1532）第三轮的服务端两条。
 *
 * 两条都属于同一族：**判据比它该管的范围宽**（predicate-and-wiring-discipline 形状 1）。
 * 一条把「活没干成、分支删了」算成「部署了没验收」，另一条在最强的那把钥匙已经
 * 明确不匹配之后，还继续退回到会被复用的分支名去认领报告。
 * 两条都不报错、页面照常渲染，只是首页那句判断说的不是真的。
 */
import { describe, it, expect } from 'vitest';
import { buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';
import { matchesChange } from '../../src/services/acceptance-overview.js';
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../../src/types.js';

const project = (id: string): Project => ({
  id, slug: id, name: id, kind: 'git',
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
} as unknown as Project);

const branch = (p: Partial<BranchEntry> & { branch: string }): BranchEntry => ({
  id: `b-${p.branch}`, projectId: 'p1', worktreePath: '/tmp/x', status: 'running',
  createdAt: '2026-09-10T00:00:00.000Z', services: {}, lastDeployAt: '2026-09-11T00:00:00.000Z', ...p,
} as unknown as BranchEntry);

const tomb = (p: Partial<BranchTombstone> & { branch: string }): BranchTombstone => ({
  previewSlug: `s-${p.branch}`, branchId: `old-${p.branch}`, projectId: 'p1',
  reason: 'abandoned', removedAt: '2026-09-05T00:00:00.000Z', ...p,
} as unknown as BranchTombstone);

const leaksOf = (tombstones: BranchTombstone[], branches: BranchEntry[] = []) =>
  buildPipelineOverview([project('p1')], branches, tombstones, [], {
    now: new Date('2026-09-15T00:00:00.000Z'),
  }).totalLeaks;

describe('「部署了没验收」只对还在途的改动成立', () => {
  it('放弃的分支（PR 关掉 / 分支删掉）一条都不算漏', () => {
    // 墓碑一律 deployed=true（有过预览子域），abandoned 又 merged=false。
    // 不看在途的话，一个项目里历年放弃的分支会被整批算进这一档，
    // 首页那句警告就按「放弃过多少次」一路顶高——里面没有一条要人处理。
    const abandoned = ['feat/a', 'feat/b', 'feat/c'].map((b) => tomb({ branch: b }));
    expect(leaksOf(abandoned)['deployed-not-accepted']).toBe(0);
  });

  it('在途且部署过、还没有报告的，仍然要报出来', () => {
    // 反向断言：别把这一档整个关掉。它本来就是首页最该点名的那一种。
    const live = leaksOf([], [branch({ branch: 'feat/live' })]);
    expect(live['deployed-not-accepted']).toBe(1);
  });

  it('放弃与在途混在一起时，只数在途那一条', () => {
    const mixed = leaksOf(
      ['feat/a', 'feat/b'].map((b) => tomb({ branch: b })),
      [branch({ branch: 'feat/live' })],
    );
    expect(mixed['deployed-not-accepted']).toBe(1);
  });

  it('合并了没验收走的是另一档，没被这次收窄误伤', () => {
    const merged = leaksOf([tomb({ branch: 'feat/m', reason: 'merged' })]);
    expect(merged['merged-not-accepted']).toBe(1);
    expect(merged['deployed-not-accepted']).toBe(0);
  });
});

describe('对齐判据：最强的一把钥匙不匹配时，不许退回分支名', () => {
  const ref = (p: Partial<AcceptanceReportMeta> = {}): never => ({
    id: 'r1', projectId: 'p1', title: 't', createdAt: '2026-09-10T00:00:00.000Z',
    verdict: 'pass', branch: 'claude/reused', prNumber: 1500, commitSha: null, ...p,
  } as never);

  it('两边都记了 PR 号且不同 —— 判不匹配', () => {
    // 分支名被复用是本仓库的常态（同一条 claude/xxx 跑完一个 PR 再开下一个）。
    // 退回分支名会把上一个 PR 的报告挂到新改动上，首页据此报「已验收」，
    // 而这条改动其实一份报告都没有。
    expect(matchesChange(ref(), {
      projectId: 'p1', branch: 'claude/reused', prNumber: 1532, commitSha: null,
    })).toBe(false);
  });

  it('两边都记了 PR 号且相同 —— 匹配', () => {
    expect(matchesChange(ref(), {
      projectId: 'p1', branch: 'other/name', prNumber: 1500, commitSha: null,
    })).toBe(true);
  });

  it('只有一边记了 PR 号 —— 这把钥匙不参与判定，退回分支名', () => {
    expect(matchesChange(ref({ prNumber: null } as never), {
      projectId: 'p1', branch: 'claude/reused', prNumber: 1532, commitSha: null,
    })).toBe(true);
    expect(matchesChange(ref(), {
      projectId: 'p1', branch: 'claude/reused', prNumber: null, commitSha: null,
    })).toBe(true);
  });

  it('commit 不同不作否决：改动侧给的常常是合并提交，报告记的是分支头提交', () => {
    // 拿 commit 否决会把正常的合并覆盖判成没验 —— 比漏判更糟。
    expect(matchesChange(ref({ prNumber: null, commitSha: 'aaaaaaa' } as never), {
      projectId: 'p1', branch: 'claude/reused', prNumber: null, commitSha: 'bbbbbbb',
    })).toBe(true);
  });

  it('项目不同永远不匹配', () => {
    expect(matchesChange(ref(), { projectId: 'p2', branch: 'claude/reused', prNumber: 1500 })).toBe(false);
  });
});
