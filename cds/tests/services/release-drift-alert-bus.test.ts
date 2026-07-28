import { afterEach, describe, expect, it } from 'vitest';
import { cdsEventsBus, isAlertCdsEvent, type CdsEventEnvelope } from '../../src/services/cds-events-bus.js';
import {
  resetReleaseDriftDedupe,
  setReleaseDriftNotifier,
  sweepReleaseRemoteState,
} from '../../src/services/release-remote-watcher.js';
import type { ReleaseTarget } from '../../src/types.js';

/**
 * 漂移告警的最后一公里：巡检判出漂移 → 经 notifier 上 cds-events-bus → 够格叫醒人。
 *
 * 事故值（本轮验收实测）：release-remote-watcher 建成、40 条单测全绿，但 src/ 里
 * **没有任何文件 import 它** —— 定时器从不启动、notifier 从不注册，漂移只会退化成
 * 一行 console.warn。判据「线上被人工手改过版本时 CDS 主动告警」实际达成度为 0，
 * 而全量 3948 passed 一片绿。接线守卫（release-observability-wiring-guard）钉住
 * 「有没有接」，本文件钉住「接上之后发出去的东西对不对」。
 *
 * 另一半事故形状：把 drift-detected 的告警等级写成 false。事件照发、面板照收，
 * 但没人被叫醒 —— 与「无告警外发」等价，且更难发现，因为链路看上去是通的。
 */

const TARGET: ReleaseTarget = {
  id: 'rt_drift', projectId: 'proj-a', name: '生产站点', type: 'ssh',
  createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
  createdBy: 'u', isEnabled: true, lifecycle: 'active', environment: 'production',
  isCanonical: true, strategy: { mode: 'generated-static' },
  ssh: {
    host: 'h', port: 22, user: 'u', privateKeyRef: 'k', appPath: '/srv/app',
    deployCommand: '', rollbackCommand: '', healthcheckUrl: 'https://example.test/health',
  },
} as unknown as ReleaseTarget;

function driftedService() {
  return {
    async readRemoteReleaseState() {
      return {
        targetId: TARGET.id, projectId: TARGET.projectId, mode: 'generated-static' as const,
        readAt: '2026-07-28T10:00:00.000Z',
        drift: {
          status: 'drifted' as const,
          remoteReleaseId: 'rel_手工发的',
          expectedReleaseId: 'rel_cds_认为的',
          message: '远端 current 指向 rel_手工发的，与 CDS 台账不一致',
        },
      };
    },
    async reclaimRemoteReleaseArtifacts() { throw new Error('本用例只巡检不回收'); },
  };
}

describe('漂移告警上总线', () => {
  afterEach(() => {
    setReleaseDriftNotifier(null);
    resetReleaseDriftDedupe();
  });

  it('drift-detected 是告警级，drift-cleared 只留痕不叫醒人', () => {
    expect(isAlertCdsEvent('release.drift-detected')).toBe(true);
    expect(isAlertCdsEvent('release.drift-cleared')).toBe(false);
  });

  it('巡检判出漂移后，事件真的落到 cds-events-bus 上', async () => {
    const seen: CdsEventEnvelope[] = [];
    const off = cdsEventsBus.subscribe((envelope) => {
      if (String(envelope.type).startsWith('release.drift')) seen.push(envelope);
    });
    // 与 server.ts bootstrap 里那行接线等价：巡检不认识总线，只认 notifier。
    setReleaseDriftNotifier((type, data) => { cdsEventsBus.publish(type, data); });

    try {
      const result = await sweepReleaseRemoteState({
        listTargets: () => [TARGET],
        releaseService: driftedService() as never,
        reclaim: false,
      });

      expect(result.drifted).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0].type).toBe('release.drift-detected');
      const data = seen[0].data as Record<string, unknown>;
      // projectId 必须在：GET /api/cds-events 对项目级 key 只放行命中自己项目的事件，
      // 漏掉它不会报错，只会让项目 key 一条漂移告警都收不到（同 release-events 的坑）。
      expect(data.projectId).toBe('proj-a');
      expect(data.remoteReleaseId).toBe('rel_手工发的');
      expect(data.expectedReleaseId).toBe('rel_cds_认为的');
    } finally {
      off();
    }
  });

  it('没注册 notifier 时不静默丢弃，退化成 console.warn 留痕', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      await sweepReleaseRemoteState({
        listTargets: () => [TARGET],
        releaseService: driftedService() as never,
        reclaim: false,
      });
    } finally {
      console.warn = original;
    }

    expect(warnings.some((line) => line.includes('[release-drift]') && line.includes('未接告警通道'))).toBe(true);
  });
});
