import { describe, expect, it } from 'vitest';
import {
  buildReleaseInventoryCommand,
  buildReleaseReclaimCommand,
  computeReleaseArtifactRetentionPlan,
  isReleaseArtifactId,
  parseRemoteReleaseInventory,
  RELEASE_ARTIFACT_KEEP_RECENT,
  stripAutoRestoreSuffix,
  type ReleaseArtifactRetentionInput,
  type RemoteReleaseInventory,
} from '../../src/services/release-artifact-retention.js';
import { KEEP_SUCCESSFUL_RELEASE_RUNS } from '../../src/services/release-retention.js';
import type { ReleaseRun, ReleaseStrategy, ReleaseTarget } from '../../src/types.js';

/**
 * 远端产物回收的安全边界回归。
 *
 * 事故值（修复前这套逻辑根本不存在，产物只增不减；下面每条都是「如果按最直觉的写法
 * 实现，会怎么砍到生产」）：
 *  - 只按台账保护 → `rel_xxxx-auto-restore` 不在台账里，而它完全可能正是 current
 *    指向的那一份，第一刀就删掉线上正在服务的目录；
 *  - 忘了 previous → 发布脚本自己维护的人工回退兜底被清空；
 *  - 超出 N 就删 → current/previous 若恰好很老（长期没发版）会被顺手带走；
 *  - existing-script 也扫一遍 → CDS 一个字节都没建过，却去 rm 别人的目录；
 *  - 漂移时照删 → 线上正被人手工改过，回收等于毁灭现场证据。
 */

const RUN_A = 'rel_00000000000000aa';
const RUN_B = 'rel_00000000000000bb';
const RUN_C = 'rel_00000000000000cc';
const RUN_OLD = 'rel_00000000000000dd';

function run(releaseId: string, startedAt: string, status: ReleaseRun['status'] = 'success'): Pick<ReleaseRun, 'releaseId' | 'status' | 'startedAt'> {
  return { releaseId, status, startedAt };
}

function inventory(patch: Partial<RemoteReleaseInventory> = {}): RemoteReleaseInventory {
  return {
    currentTarget: `/opt/.cds-releases/t1/worktrees/${RUN_A}`,
    previousTarget: `/opt/.cds-releases/t1/worktrees/${RUN_B}`,
    worktrees: [RUN_A, RUN_B, RUN_C, RUN_OLD],
    versions: [],
    releaseRoot: '/opt/.cds-releases/t1',
    worktreeRoot: '/opt/.cds-releases/t1/worktrees',
    ...patch,
  };
}

function plan(patch: Partial<ReleaseArtifactRetentionInput> = {}) {
  return computeReleaseArtifactRetentionPlan({
    mode: 'generated-compose',
    inventory: inventory(),
    ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z')],
    hasInFlightRun: false,
    drift: 'in-sync',
    keepRecent: 1,
    ...patch,
  });
}

const target: ReleaseTarget = {
  id: 't1',
  projectId: 'p1',
  name: '生产站点',
  type: 'ssh',
  createdAt: '2026-07-28T00:00:00.000Z',
  isEnabled: true,
  ssh: {
    host: '10.0.0.1',
    port: 22,
    user: 'deploy',
    privateKeyRef: 'host-prod',
    appPath: '/opt/app-prod/current',
    deployCommand: './deploy.sh',
    healthcheckUrl: 'https://app.example.test/',
  },
};

const composeStrategy: ReleaseStrategy = { mode: 'generated-compose', composeFile: 'cds-compose.yml', composeProject: 'p1-prod' };
const staticStrategy: ReleaseStrategy = {
  mode: 'generated-static',
  buildCommand: 'pnpm build',
  artifactDirectory: 'dist',
  publicDirectory: '/opt/p1-web',
};

describe('远端产物形状判定', () => {
  it('只认 rel_ + 16 位十六进制，可带自动恢复后缀', () => {
    expect(isReleaseArtifactId(RUN_A)).toBe(true);
    expect(isReleaseArtifactId(`${RUN_A}-auto-restore`)).toBe(true);
    // 运维手建目录、别的工具的产物、路径穿越尝试一律不碰。
    expect(isReleaseArtifactId('backup-2026')).toBe(false);
    expect(isReleaseArtifactId('..')).toBe(false);
    expect(isReleaseArtifactId('rel_00000000000000aa; rm -rf /')).toBe(false);
    expect(isReleaseArtifactId('rel_00000000000000AA')).toBe(false);
  });

  it('剥出的是那次失败发布的 id，不是线上真正在跑的版本', () => {
    expect(stripAutoRestoreSuffix(`${RUN_A}-auto-restore`)).toEqual({ id: RUN_A, autoRestore: true });
    expect(stripAutoRestoreSuffix(RUN_A)).toEqual({ id: RUN_A, autoRestore: false });
  });
});

describe('回收计划的安全边界', () => {
  it('current 指向的那一份绝不删，判据取远端实读值', () => {
    // 事故值：只按台账保护时，台账里只有 RUN_A，current 若指向别处就会被删。
    const result = plan({
      inventory: inventory({ currentTarget: `/opt/.cds-releases/t1/worktrees/${RUN_C}`, previousTarget: '' }),
      ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z')],
    });

    expect(result.removeWorktrees).not.toContain(RUN_C);
    expect(result.keptReasons[RUN_C]).toContain('current');
  });

  it('previous 指向的那一份绝不删，即使它超出保留份数', () => {
    const result = plan({ keepRecent: 0 });

    expect(result.removeWorktrees).not.toContain(RUN_B);
    expect(result.keptReasons[RUN_B]).toContain('previous');
  });

  it('自动恢复目录若正是 current，也绝不删——它从未进过台账', () => {
    const restore = `${RUN_C}-auto-restore`;
    const result = plan({
      inventory: inventory({
        currentTarget: `/opt/.cds-releases/t1/worktrees/${restore}`,
        previousTarget: '',
        worktrees: [RUN_A, RUN_B, RUN_C, restore],
      }),
      ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z')],
    });

    expect(result.removeWorktrees).not.toContain(restore);
    expect(result.keptReasons[restore]).toContain('current');
  });

  it('最近 N 个可回滚版本的目录及其自动恢复现场一并保住', () => {
    const restore = `${RUN_C}-auto-restore`;
    const result = plan({
      inventory: inventory({ previousTarget: '', worktrees: [RUN_A, RUN_B, RUN_C, restore, RUN_OLD] }),
      ledgerRuns: [
        run(RUN_A, '2026-07-28T03:00:00.000Z'),
        run(RUN_B, '2026-07-28T02:00:00.000Z'),
        run(RUN_C, '2026-07-28T01:00:00.000Z'),
        run(RUN_OLD, '2026-07-01T00:00:00.000Z'),
      ],
      keepRecent: 3,
    });

    expect(result.removeWorktrees).toEqual([RUN_OLD]);
    expect(result.keptReasons[restore]).toContain('自动恢复现场');
  });

  it('失败的 run 不占可回滚名额，它的目录该收就收', () => {
    const result = plan({
      inventory: inventory({ previousTarget: '', worktrees: [RUN_A, RUN_C] }),
      ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z'), run(RUN_C, '2026-07-28T02:00:00.000Z', 'failed')],
      keepRecent: 5,
    });

    expect(result.removeWorktrees).toEqual([RUN_C]);
  });

  it('不是产物形状的目录一个字节都不碰', () => {
    const result = plan({
      inventory: inventory({ previousTarget: '', worktrees: [RUN_A, 'backup-2026', 'node_modules'] }),
      keepRecent: 1,
    });

    expect(result.removeWorktrees).toEqual([]);
    expect(result.keptReasons['backup-2026']).toContain('不是 CDS 发布产物');
  });

  it('existing-script 模式整轮 no-op —— CDS 没在远端建过任何东西', () => {
    const result = plan({ mode: 'existing-script' });

    expect(result.removeWorktrees).toEqual([]);
    expect(result.removeVersions).toEqual([]);
    expect(result.skippedReason).toContain('existing-script');
  });

  it('目标上有在途 run 时整轮跳过，不与执行体抢同一棵 worktree', () => {
    const result = plan({ hasInFlightRun: true, keepRecent: 0 });

    expect(result.removeWorktrees).toEqual([]);
    expect(result.skippedReason).toContain('进行中');
  });

  it('漂移或读不回来时整轮跳过，宁可漏收也不误删', () => {
    expect(plan({ drift: 'drifted', keepRecent: 0 }).skippedReason).toContain('drifted');
    expect(plan({ drift: 'unknown', keepRecent: 0 }).skippedReason).toContain('unknown');
    expect(plan({ inventory: undefined, keepRecent: 0 }).skippedReason).toContain('读不回');
    expect(plan({ inventory: inventory({ currentTarget: '' }), keepRecent: 0 }).skippedReason).toContain('current');
  });

  it('单轮上限截断的数量必须如实报出，不能让人以为已经清干净', () => {
    const result = plan({
      inventory: inventory({ previousTarget: '', worktrees: [RUN_A, RUN_B, RUN_C, RUN_OLD] }),
      keepRecent: 1,
      maxRemovals: 1,
    });

    expect(result.removeWorktrees).toHaveLength(1);
    expect(result.deferred).toBe(2);
  });

  it('static 的成品目录与 worktree 一起纳入回收', () => {
    const result = plan({
      mode: 'generated-static',
      inventory: inventory({
        currentTarget: `/opt/p1-web/.releases/${RUN_A}`,
        previousTarget: `/opt/p1-web/.releases/${RUN_B}`,
        worktrees: [RUN_A, RUN_C],
        versions: [RUN_A, RUN_B, RUN_C],
      }),
      ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z')],
      keepRecent: 1,
    });

    expect(result.removeVersions).toEqual([RUN_C]);
    expect(result.removeWorktrees).toEqual([RUN_C]);
  });

  it('publicDirectory 被其他目标共用时，只删本目标台账里的版本', () => {
    // 事故值：.releases 不像 worktrees 那样带 targetId，两个目标配同一个 publicDirectory
    // 就会互删对方的成品。共用时退化为「只认本目标台账」。
    const result = plan({
      mode: 'generated-static',
      inventory: inventory({
        currentTarget: `/opt/p1-web/.releases/${RUN_A}`,
        previousTarget: '',
        worktrees: [],
        versions: [RUN_A, RUN_B, RUN_C],
      }),
      ledgerRuns: [run(RUN_A, '2026-07-28T03:00:00.000Z'), run(RUN_B, '2026-07-28T02:00:00.000Z')],
      keepRecent: 1,
      publicDirectoryShared: true,
    });

    expect(result.removeVersions).toEqual([RUN_B]);
    expect(result.keptReasons[RUN_C]).toContain('不在本目标台账');
    expect(result.deferred).toBe(0);
  });
});

describe('保留份数只有一个判定源', () => {
  it('N 直接转发回滚可达范围，不另写字面量', () => {
    expect(RELEASE_ARTIFACT_KEEP_RECENT).toBe(KEEP_SUCCESSFUL_RELEASE_RUNS);
  });
});

describe('远端命令', () => {
  it('盘点命令在远端复算路径，且用 readlink 而非 readlink -f', () => {
    const command = buildReleaseInventoryCommand(target, composeStrategy)!;

    // 路径必须在远端用 $PWD/dirname 现算：TS 侧自己拼会在相对路径或软链下算出另一个目录。
    expect(command).toContain('repo="$PWD"');
    expect(command).toContain('parent="$(dirname "$repo")"');
    expect(command).toContain('readlink "$root/current"');
    // 事故值：readlink -f 会继续解析下去，publicDirectory 自身是软链时读回的 basename 对不上 releaseId。
    expect(command).not.toContain('readlink -f');
    // ls 在目录不存在时非零退出，会被 sshExec 判成「读不回来」，故必须 exit 0 收尾。
    expect(command.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('static 盘点额外取回成品目录，compose 不取', () => {
    expect(buildReleaseInventoryCommand(target, staticStrategy)!).toContain('CDS_RELEASE_VERSION=');
    expect(buildReleaseInventoryCommand(target, composeStrategy)!).not.toContain('CDS_RELEASE_VERSION=');
  });

  it('existing-script 模式不生成任何命令', () => {
    expect(buildReleaseInventoryCommand(target, { mode: 'existing-script', command: './deploy.sh' })).toBeNull();
    expect(buildReleaseReclaimCommand(
      target,
      { mode: 'existing-script', command: './deploy.sh' },
      { removeWorktrees: [RUN_A], removeVersions: [] },
    )).toBeNull();
  });

  it('删 worktree 走 git worktree remove 并收尾 prune，不裸 rm', () => {
    const command = buildReleaseReclaimCommand(target, composeStrategy, {
      removeWorktrees: [RUN_A],
      removeVersions: [],
    })!;

    // 事故值：裸 rm -rf 会在 .git/worktrees/ 留孤儿元数据，之后 git worktree add 会因
    // 「已注册但目录不存在」直接失败。
    expect(command).toContain('git -C "$repo" worktree remove --force');
    expect(command).toContain('git -C "$repo" worktree prune');
  });

  it('删除命令拒绝形状不合法的名字，且不会有未加引号的注入面', () => {
    const command = buildReleaseReclaimCommand(target, composeStrategy, {
      removeWorktrees: [RUN_A, '$(rm -rf /)', '../../etc'],
      removeVersions: [],
    })!;

    expect(command).toContain(`'${RUN_A}'`);
    expect(command).not.toContain('rm -rf /)');
    expect(command).not.toContain('../../etc');
  });

  it('无可删项时不生成命令，避免打一次没有意义的 SSH', () => {
    expect(buildReleaseReclaimCommand(target, composeStrategy, { removeWorktrees: [], removeVersions: [] })).toBeNull();
    // compose 模式没有成品目录，只给 versions 也不该生成命令。
    expect(buildReleaseReclaimCommand(target, composeStrategy, { removeWorktrees: [], removeVersions: [RUN_A] })).toBeNull();
  });
});

describe('盘点输出解析', () => {
  it('按前缀分流并容忍空值与噪声行', () => {
    const parsed = parseRemoteReleaseInventory([
      'CDS_RELEASE_ROOT=/opt/.cds-releases/t1',
      'CDS_RELEASE_WORKTREE_ROOT=/opt/.cds-releases/t1/worktrees',
      `CDS_RELEASE_CURRENT=/opt/.cds-releases/t1/worktrees/${RUN_A}`,
      'CDS_RELEASE_PREVIOUS=',
      `CDS_RELEASE_WORKTREE=${RUN_A}`,
      `CDS_RELEASE_WORKTREE=${RUN_B}`,
      'warning: something on stderr',
      '',
    ].join('\n'));

    expect(parsed.currentTarget).toBe(`/opt/.cds-releases/t1/worktrees/${RUN_A}`);
    expect(parsed.previousTarget).toBe('');
    expect(parsed.worktrees).toEqual([RUN_A, RUN_B]);
    expect(parsed.versions).toEqual([]);
  });
});
