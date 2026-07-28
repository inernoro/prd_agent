import { afterEach, describe, expect, it } from 'vitest';
import {
  detectReleaseRemoteDrift,
  type RemoteReleaseInventory,
} from '../../src/services/release-artifact-retention.js';
import {
  planDriftAlert,
  resetReleaseDriftDedupe,
  setReleaseDriftNotifier,
  sweepReleaseRemoteState,
  type ReleaseDriftEventData,
  type ReleaseDriftEventType,
} from '../../src/services/release-remote-watcher.js';
import type { ReleaseArtifactReclaimResult, ReleaseRemoteStateResult } from '../../src/services/release-service.js';
import type { ReleaseTarget } from '../../src/types.js';

/**
 * 线上漂移判定 + 告警边沿去重。
 *
 * 两个必须记住的事故值：
 *  1. **不剥 `-auto-restore` 后缀**：探测失败后的自动恢复会把 current 指到
 *     `rel_xxxx-auto-restore`，剥掉后拿到的是那次**失败发布**的 id，线上真正在跑的是
 *     它的 previousReleaseId。不做这两层处理，一次完全正常的自动恢复就会被报成
 *     生产漂移——假阳性响几次，人就学会忽略这个告警了。
 *  2. **unknown 当成恢复**：SSH 不通只是「看不见」，不是「已恢复」。此时发 cleared
 *     等于给出一个假的全清信号，比不发更糟。
 */

const FAILED_RUN = 'rel_00000000000000ff';
const ONLINE_RUN = 'rel_00000000000000aa';
const OTHER_RUN = 'rel_00000000000000bb';

function inventory(currentTarget: string, previousTarget = ''): RemoteReleaseInventory {
  return {
    currentTarget,
    previousTarget,
    worktrees: [],
    versions: [],
    releaseRoot: '/opt/.cds-releases/t1',
    worktreeRoot: '/opt/.cds-releases/t1/worktrees',
  };
}

describe('远端漂移四态', () => {
  it('existing-script 模式判「不适用」，不是未知也不是漂移', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'existing-script',
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN],
    });

    expect(drift.status).toBe('not-applicable');
  });

  it('读不回来判 unknown，并把原因带出来', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      readError: 'ECONNREFUSED',
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN],
    });

    expect(drift.status).toBe('unknown');
    expect(drift.message).toContain('ECONNREFUSED');
  });

  it('current 链接缺失判 unknown，不冒充漂移', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(''),
      expectedReleaseId: '',
      knownReleaseIds: [],
    });

    expect(drift.status).toBe('unknown');
  });

  it('远端与 CDS 一致时判 in-sync', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(`/opt/.cds-releases/t1/worktrees/${ONLINE_RUN}`),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN],
    });

    expect(drift.status).toBe('in-sync');
    expect(drift.remoteReleaseId).toBe(ONLINE_RUN);
  });

  it('远端版本不在台账里判漂移，并点名「可能有人手工发过」', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(`/opt/.cds-releases/t1/worktrees/${OTHER_RUN}`),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN],
    });

    expect(drift.status).toBe('drifted');
    expect(drift.message).toContain('不在 CDS 台账');
  });

  it('远端指向台账内的另一个版本也判漂移，两边版本都点出来', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(`/opt/.cds-releases/t1/worktrees/${OTHER_RUN}`),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN, OTHER_RUN],
    });

    expect(drift.status).toBe('drifted');
    expect(drift.remoteReleaseId).toBe(OTHER_RUN);
    expect(drift.expectedReleaseId).toBe(ONLINE_RUN);
  });

  it('current 指向的不是产物形状时判漂移——线上被 CDS 之外的手段改过', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-static',
      inventory: inventory('/opt/p1-web/.releases/manual-hotfix'),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN],
    });

    expect(drift.status).toBe('drifted');
    expect(drift.rawRemoteReleaseId).toBe('manual-hotfix');
  });
});

describe('自动恢复不得被误报成漂移', () => {
  it('current 指向 -auto-restore 时回溯到真正在线的版本，判 in-sync', () => {
    // 事故值：不剥后缀 → 远端读作 `rel_...ff-auto-restore`，与期望的 rel_...aa 不等 →
    // 一次正常的自动恢复被报成生产漂移。只剥不回溯 → 读作失败发布的 rel_...ff，同样误报。
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(`/opt/.cds-releases/t1/worktrees/${FAILED_RUN}-auto-restore`),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN, FAILED_RUN],
      previousByReleaseId: { [FAILED_RUN]: ONLINE_RUN },
    });

    expect(drift.status).toBe('in-sync');
    expect(drift.remoteReleaseId).toBe(ONLINE_RUN);
    expect(drift.rawRemoteReleaseId).toBe(`${FAILED_RUN}-auto-restore`);
  });

  it('回溯不到上一版本时不硬判 in-sync，仍报漂移让人去看现场', () => {
    const drift = detectReleaseRemoteDrift({
      mode: 'generated-compose',
      inventory: inventory(`/opt/.cds-releases/t1/worktrees/${FAILED_RUN}-auto-restore`),
      expectedReleaseId: ONLINE_RUN,
      knownReleaseIds: [ONLINE_RUN, FAILED_RUN],
    });

    expect(drift.status).toBe('drifted');
    expect(drift.remoteReleaseId).toBe(FAILED_RUN);
  });
});

function state(status: ReleaseRemoteStateResult['drift']['status'], remoteReleaseId?: string): ReleaseRemoteStateResult {
  return {
    targetId: 't1',
    projectId: 'p1',
    mode: 'generated-compose',
    drift: { status, remoteReleaseId, expectedReleaseId: ONLINE_RUN, message: 'x' },
    readAt: '2026-07-28T00:00:00.000Z',
  };
}

describe('漂移告警的边沿去重', () => {
  afterEach(() => {
    resetReleaseDriftDedupe();
    setReleaseDriftNotifier(null);
  });

  it('同一条漂移只响一次，5 分钟一轮不会把人训练成忽略告警', () => {
    expect(planDriftAlert(state('drifted', OTHER_RUN))?.type).toBe('release.drift-detected');
    expect(planDriftAlert(state('drifted', OTHER_RUN))).toBeNull();
  });

  it('漂移变成另一个版本是新事实，必须再响一次', () => {
    planDriftAlert(state('drifted', OTHER_RUN));

    expect(planDriftAlert(state('drifted', 'rel_00000000000000cc'))?.type).toBe('release.drift-detected');
  });

  it('恢复一致时发解除，且只发一次', () => {
    planDriftAlert(state('drifted', OTHER_RUN));

    expect(planDriftAlert(state('in-sync', ONLINE_RUN))?.type).toBe('release.drift-cleared');
    expect(planDriftAlert(state('in-sync', ONLINE_RUN))).toBeNull();
  });

  it('unknown 绝不当成恢复——SSH 不通只是看不见，不是已修好', () => {
    planDriftAlert(state('drifted', OTHER_RUN));

    expect(planDriftAlert(state('unknown'))).toBeNull();
    // 看不见期间漂移记忆必须保住：恢复连接后仍是同一条漂移，不该重复报警。
    expect(planDriftAlert(state('drifted', OTHER_RUN))).toBeNull();
  });

  it('从未漂移过的目标不会凭空发解除', () => {
    expect(planDriftAlert(state('in-sync', ONLINE_RUN))).toBeNull();
    expect(planDriftAlert(state('not-applicable'))).toBeNull();
  });
});

describe('巡检轮次', () => {
  afterEach(() => {
    resetReleaseDriftDedupe();
    setReleaseDriftNotifier(null);
  });

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

  function reclaimResult(patch: Partial<ReleaseArtifactReclaimResult> = {}): ReleaseArtifactReclaimResult {
    return {
      targetId: 't1',
      projectId: 'p1',
      mode: 'generated-compose',
      drift: { status: 'drifted', remoteReleaseId: OTHER_RUN, expectedReleaseId: ONLINE_RUN, message: '远端不一致' },
      removedWorktrees: [],
      removedVersions: [],
      keptReasons: {},
      deferred: 0,
      dryRun: false,
      ...patch,
    };
  }

  it('漂移经巡检外发到告警通道，载荷带得起项目作用域过滤', async () => {
    const events: Array<{ type: ReleaseDriftEventType; data: ReleaseDriftEventData }> = [];
    setReleaseDriftNotifier((type, data) => { events.push({ type, data }); });

    await sweepReleaseRemoteState({
      listTargets: () => [target],
      reclaim: false,
      releaseService: {
        readRemoteReleaseState: async () => state('drifted', OTHER_RUN),
        reclaimRemoteReleaseArtifacts: async () => reclaimResult(),
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('release.drift-detected');
    // projectId 漏掉不会报错，只会让项目作用域的事件订阅方一条都收不到（静默失效）。
    expect(events[0].data.projectId).toBe('p1');
    expect(events[0].data.remoteReleaseId).toBe(OTHER_RUN);
  });

  it('单个目标炸掉不中断整轮——一台机器不通不该让别的目标停摆', async () => {
    const other: ReleaseTarget = { ...target, id: 't2', name: '备用站点' };
    const seen: string[] = [];

    const result = await sweepReleaseRemoteState({
      listTargets: () => [target, other],
      reclaim: false,
      releaseService: {
        readRemoteReleaseState: async (t) => {
          seen.push(t.id);
          if (t.id === 't1') throw new Error('boom');
          return { ...state('in-sync', ONLINE_RUN), targetId: 't2' };
        },
        reclaimRemoteReleaseArtifacts: async () => reclaimResult(),
      },
    });

    expect(seen).toEqual(['t1', 't2']);
    expect(result.scanned).toBe(1);
  });

  it('已禁用与非 SSH 目标不巡检', async () => {
    const result = await sweepReleaseRemoteState({
      listTargets: () => [
        { ...target, id: 't-off', isEnabled: false },
        { ...target, id: 't-k8s', type: 'k8s', ssh: undefined },
      ],
      reclaim: false,
      releaseService: {
        readRemoteReleaseState: async () => { throw new Error('不该被调用'); },
        reclaimRemoteReleaseArtifacts: async () => reclaimResult(),
      },
    });

    expect(result.scanned).toBe(0);
  });

  it('开启回收时只打一次 SSH：漂移判定复用回收内部那次只读盘点', async () => {
    let readCalls = 0;
    let reclaimCalls = 0;

    const result = await sweepReleaseRemoteState({
      listTargets: () => [target],
      reclaim: true,
      releaseService: {
        readRemoteReleaseState: async () => { readCalls += 1; return state('in-sync', ONLINE_RUN); },
        reclaimRemoteReleaseArtifacts: async () => {
          reclaimCalls += 1;
          return reclaimResult({
            drift: { status: 'in-sync', remoteReleaseId: ONLINE_RUN, expectedReleaseId: ONLINE_RUN, message: '一致' },
            removedWorktrees: [OTHER_RUN],
          });
        },
      },
    });

    expect(reclaimCalls).toBe(1);
    expect(readCalls).toBe(0);
    expect(result.reclaimed).toBe(1);
  });
});
