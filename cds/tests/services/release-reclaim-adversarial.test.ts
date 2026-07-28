/**
 * 远端产物回收的**对抗性**边界回归。
 *
 * 为什么单独一套：`reclaimRemoteReleaseArtifacts` 是本仓库唯一一处
 * **默认开启、定时无人值守、在生产机器上执行 `rm -rf` / `git worktree remove --force`**
 * 的代码路径（`release-remote-watcher.ts` 每轮调它）。它算错一次的代价不是页面丑，
 * 是删掉线上正在服务的那份产物。既有用例覆盖的是「正常盘点 → 正确回收」，
 * 本套件专门反着打：**让保护对象恰好落在最该被淘汰的位置上**，确认它仍然活着。
 *
 * 判定原则：宁可漏删（磁盘多占一点），绝不多删。任何一条断言变红都意味着
 * 「某种输入下会砍到生产」，属于必须立刻停手的级别。
 */
import { describe, expect, it } from 'vitest';
import {
  computeReleaseArtifactRetentionPlan,
  parseRemoteReleaseInventory,
  type RemoteReleaseInventory,
} from '../../src/services/release-artifact-retention.js';
import type { ReleaseRun } from '../../src/types.js';

const OLDEST = 'rel_00000000000000aa';
const NEWEST = 'rel_00000000000000ff';

function run(releaseId: string, startedAt: string, extra: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    releaseId,
    projectId: 'p1',
    branchId: 'b1',
    commitSha: 'a'.repeat(40),
    artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
    targetId: 'target-prod',
    planId: 'p1:ssh-script',
    status: 'success',
    startedAt,
    logs: [],
    seq: 0,
    ...extra,
  } as ReleaseRun;
}

/** 生成 N 条比 current 更新的成功发布，把 current 挤出「最近 N 份」窗口。 */
function crowdOut(count: number): ReleaseRun[] {
  return Array.from({ length: count }, (_, i) =>
    run(`rel_${String(i).padStart(16, '0')}`, `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`));
}

function inventory(over: Partial<RemoteReleaseInventory> = {}): RemoteReleaseInventory {
  return {
    currentTarget: '',
    previousTarget: '',
    worktrees: [],
    versions: [],
    ...over,
  } as RemoteReleaseInventory;
}

describe('远端回收：保护对象落在淘汰位上仍必须活着', () => {
  it('current 指向的那份是最旧的，也绝不进删除计划', () => {
    // 真实场景：一次发布上线后很久没再发，期间为了排查连发了一串失败/回滚的
    // 试验版本。按「保留最近 N 份」的朴素排序，正在服务的那份恰恰排在最后。
    const runs = [...crowdOut(40), run(OLDEST, '2026-01-01T00:00:00.000Z')];
    const plan = computeReleaseArtifactRetentionPlan({
      inventory: inventory({
        currentTarget: `/srv/app/.cds-releases/${OLDEST}`,
        worktrees: [OLDEST, ...crowdOut(40).map((r) => r.releaseId)],
      }),
      ledgerRuns: runs,
      hasInFlightRun: false,
      drift: 'in-sync',
      mode: 'generated-compose',
    });

    expect(plan.removeWorktrees).not.toContain(OLDEST);
    expect(plan.removeVersions).not.toContain(OLDEST);
  });

  it('previous 指向的那份同样受保护（回滚的人工兜底不能被回收掉）', () => {
    const runs = [...crowdOut(40), run(OLDEST, '2026-01-01T00:00:00.000Z')];
    const plan = computeReleaseArtifactRetentionPlan({
      inventory: inventory({
        currentTarget: `/srv/app/.cds-releases/${NEWEST}`,
        previousTarget: `/srv/app/.cds-releases/${OLDEST}`,
        worktrees: [OLDEST, NEWEST, ...crowdOut(40).map((r) => r.releaseId)],
      }),
      ledgerRuns: [...runs, run(NEWEST, '2026-09-01T00:00:00.000Z')],
      hasInFlightRun: false,
      drift: 'in-sync',
      mode: 'generated-compose',
    });

    expect(plan.removeWorktrees).not.toContain(OLDEST);
    expect(plan.removeWorktrees).not.toContain(NEWEST);
  });

  it('current 链接读不回来时一刀不砍（宁可漏删，不可误删）', () => {
    // SSH 抖动 / 链接被人删掉 / 从没通过 CDS 发过 —— 三种情况都长这样。
    // 此时「哪一份在服务」是未知的，任何删除都是赌博。
    const plan = computeReleaseArtifactRetentionPlan({
      inventory: inventory({ worktrees: crowdOut(50).map((r) => r.releaseId) }),
      ledgerRuns: crowdOut(50),
      hasInFlightRun: false,
      drift: 'in-sync',
      mode: 'generated-compose',
    });

    expect(plan.removeWorktrees).toEqual([]);
    expect(plan.removeVersions).toEqual([]);
    expect(plan.skippedReason).toBeTruthy();
  });

  it('台账为空（CDS 侧数据丢了）时不拿远端目录当垃圾清', () => {
    // state 被重置 / 保留策略把老 run 淘汰完了，都会走到这里。远端还在服务的
    // 那份此时「不在台账里」，若据此判为孤儿就会砍掉生产。
    const plan = computeReleaseArtifactRetentionPlan({
      inventory: inventory({
        currentTarget: `/srv/app/.cds-releases/${NEWEST}`,
        worktrees: [NEWEST, OLDEST],
      }),
      ledgerRuns: [],
      hasInFlightRun: false,
      drift: 'in-sync',
      mode: 'generated-compose',
    });

    expect(plan.removeWorktrees).not.toContain(NEWEST);
  });

  it('current 带 -auto-restore 后缀时，被 current 指着的那个派生目录必须受保护', () => {
    // 自动恢复现场是「那次失败发布」的派生目录，逻辑上线的版本是它 previousReleaseId
    // 指的那个 id（drift 判定就是这么回溯的）。但**物理上** current 指的是派生目录本身：
    // 发布脚本里 `worktree="$worktree_root/$CDS_RELEASE_ID"` + `current -> $worktree`，
    // 自动恢复那次用的是 `<failed>-auto-restore` 这个 id，所以它是一棵**独立**的 worktree。
    //
    // 因此本用例只钉「派生目录不许删」这一条硬安全性。原始 `restored` 目录**不在**保护集里，
    // 这是有意的取舍而非疏漏：删掉它不影响正在服务的那份，且下次真要回滚到它时
    // 脚本的 `if [ ! -d "$worktree" ]; then git worktree add` 会从 git 重新长出来。
    // 代价只是那次回滚多花一次 checkout。已记入 debt.cds.release-system。
    const failed = 'rel_00000000000000bb';
    const restored = 'rel_00000000000000cc';
    const plan = computeReleaseArtifactRetentionPlan({
      inventory: inventory({
        currentTarget: `/srv/app/.cds-releases/${failed}-auto-restore`,
        worktrees: [`${failed}-auto-restore`, failed, restored, ...crowdOut(40).map((r) => r.releaseId)],
      }),
      ledgerRuns: [
        run(failed, '2026-08-01T00:00:00.000Z', { status: 'failed', previousReleaseId: restored }),
        run(restored, '2026-07-01T00:00:00.000Z'),
        ...crowdOut(40),
      ],
      hasInFlightRun: false,
      drift: 'in-sync',
      previousByReleaseId: { [failed]: restored },
      mode: 'generated-compose',
    });

    expect(plan.removeWorktrees).not.toContain(`${failed}-auto-restore`);
    // 保护理由必须落在 keptReasons 里：出事复盘时要看得出「这份为什么没被回收」。
    expect(Object.keys(plan.keptReasons)).toContain(`${failed}-auto-restore`);
  });

  it('盘点输出夹杂噪声/路径穿越时，脏条目进得了 inventory 但进不了删除计划', () => {
    // SSH stdout 混进 banner、MOTD、stderr 交错是常态。解析器**刻意**是宽松的
    // 原样透传（它只做 key=value 拆分），形状校验放在计划层（安全边界 7）。
    // 所以断言必须打在计划层——只测解析器会漏掉真正的风险面。
    const parsed = parseRemoteReleaseInventory([
      'Welcome to Ubuntu 22.04',
      `CDS_RELEASE_WORKTREE=${NEWEST}`,
      'CDS_RELEASE_WORKTREE=../..',
      'CDS_RELEASE_WORKTREE=.',
      'CDS_RELEASE_WORKTREE=rel_bad',
      `CDS_RELEASE_CURRENT=/srv/app/.cds-releases/${NEWEST}`,
    ].join('\n'));

    expect(parsed.currentTarget).toBe(`/srv/app/.cds-releases/${NEWEST}`);

    const plan = computeReleaseArtifactRetentionPlan({
      inventory: parsed,
      // 台账里一条都没有 → 这些目录全是「孤儿」，是最容易被误删的形态。
      ledgerRuns: crowdOut(40),
      hasInFlightRun: false,
      drift: 'in-sync',
      mode: 'generated-compose',
    });

    // 真正的风险：`../..` 拼进 `rm -rf "$wt/$name"` 会打到仓库父目录。
    for (const dirty of ['../..', '.', 'rel_bad']) {
      expect(plan.removeWorktrees).not.toContain(dirty);
      expect(plan.removeVersions).not.toContain(dirty);
    }
  });
});
