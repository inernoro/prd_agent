import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_SUPPORTED_EVENTS,
  WebhookNoiseCounter,
  classifyWebhookNoise,
} from '../../src/services/github-webhook-noise.js';

/**
 * webhook 噪声分流（2026-09-08 宿主过载复盘）。
 * 判据必须与 dispatcher 的真实动作一致：会触发动作的 action 绝不能被判成噪声，
 * 否则 push / rerequested / workflow 完成就静默丢了。
 */
describe('classifyWebhookNoise', () => {
  it('不在支持清单里的事件是噪声', () => {
    for (const ev of ['workflow_job', 'check_suite', 'status', 'pull_request_review', 'star']) {
      expect(WEBHOOK_SUPPORTED_EVENTS.has(ev)).toBe(false);
      expect(classifyWebhookNoise(ev, {}).noise).toBe(true);
    }
  });

  it('check_run 只有 rerequested 不是噪声', () => {
    expect(classifyWebhookNoise('check_run', { action: 'created' }).noise).toBe(true);
    expect(classifyWebhookNoise('check_run', { action: 'completed' }).noise).toBe(true);
    expect(classifyWebhookNoise('check_run', {}).noise).toBe(true);
    expect(classifyWebhookNoise('check_run', { action: 'rerequested' })).toEqual({ noise: false, reason: null });
  });

  it('workflow_run 只有 completed 不是噪声', () => {
    expect(classifyWebhookNoise('workflow_run', { action: 'requested' }).noise).toBe(true);
    expect(classifyWebhookNoise('workflow_run', { action: 'in_progress' }).noise).toBe(true);
    expect(classifyWebhookNoise('workflow_run', { action: 'completed' }).noise).toBe(false);
  });

  it('会触发动作的事件永远不是噪声', () => {
    for (const ev of ['push', 'pull_request', 'issue_comment', 'delete', 'release', 'ping', 'installation', 'repository']) {
      expect(classifyWebhookNoise(ev, { action: 'anything' }).noise, ev).toBe(false);
    }
  });
});

describe('WebhookNoiseCounter 聚合上报', () => {
  it('首条只起表；到达间隔后一次性上报这段时间的分布，之后归零', () => {
    let now = 1_000_000;
    const reports: Array<{ suppressed: number; byEvent: Record<string, number> }> = [];
    const counter = new WebhookNoiseCounter({
      now: () => now,
      flushIntervalMs: 60_000,
      report: (r) => reports.push(r),
    });
    counter.note('workflow_job');
    counter.note('check_run', 'created');
    counter.note('check_run', 'created');
    expect(reports).toHaveLength(0);
    expect(counter.stats()).toMatchObject({ suppressedTotal: 3, suppressedSinceFlush: 3 });

    now += 61_000;
    counter.note('check_suite');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      suppressed: 4,
      byEvent: { workflow_job: 1, 'check_run.created': 2, check_suite: 1 },
    });
    expect(counter.stats()).toMatchObject({ suppressedTotal: 4, suppressedSinceFlush: 0 });
  });

  it('flush 没有积累时不上报', () => {
    const reports: unknown[] = [];
    const counter = new WebhookNoiseCounter({ report: (r) => reports.push(r) });
    counter.flush();
    expect(reports).toHaveLength(0);
  });
});
