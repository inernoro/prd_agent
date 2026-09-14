/*
 * 守卫：通知通道自己的状态。
 *
 * 这条链上最危险的一个字符是 `void mapNotifier?.send(...)` 里的 `?.`——
 * 没配凭据时它是一次静默 no-op：探测照跑、面板照绿、告警照样「发」了，
 * 只是没有任何人收到。规则 degradation-must-alarm 原话：
 * **静默禁用就是装了个永不会响的铃，那正是这条链路要治的病。**
 *
 * 所以这里逐档钉死：没配就是没配，没发过就是没发过，两者都不许被渲染成「正常」。
 */
import { describe, expect, it } from 'vitest';

import {
  ALARM_ENV_KEYS,
  AlarmChannel,
  describeAlarmChannel,
  missingAlarmEnvKeys,
} from '../../src/services/alarm-channel.js';

const NOW = 1_700_000_000_000;

describe('通道状态四档，一档都不许塌成「正常」', () => {
  it('没配凭据 = unconfigured，且文案直说没人会被通知', () => {
    const ch = new AlarmChannel(false, 'MAP 站内通知', ['CDS_MAP_NOTIFY_KEY_ID']);
    const snap = ch.snapshot();
    expect(snap.status).toBe('unconfigured');
    expect(snap.missing).toEqual(['CDS_MAP_NOTIFY_KEY_ID']);
    expect(describeAlarmChannel(snap)).toContain('不会有任何人被通知');
  });

  it('配了但没发过 = untested，不许说成健康', () => {
    const snap = new AlarmChannel(true, 'MAP 站内通知').snapshot();
    expect(snap.status).toBe('untested');
    expect(describeAlarmChannel(snap)).not.toContain('通着');
    expect(describeAlarmChannel(snap)).toContain('未知数');
  });

  it('上一次失败 = failing，且把原因摆出来', () => {
    const ch = new AlarmChannel(true, 'MAP 站内通知');
    ch.record({ ok: false, status: 401, reason: 'MAP 返回 401' }, 'alert', NOW);
    const snap = ch.snapshot();
    expect(snap.status).toBe('failing');
    expect(snap.failed).toBe(1);
    expect(describeAlarmChannel(snap)).toContain('401');
  });

  it('上一次成功 = healthy，并记成功次数', () => {
    const ch = new AlarmChannel(true, 'MAP 站内通知');
    ch.record({ ok: false, reason: 'x' }, 'alert', NOW);
    ch.record({ ok: true, status: 200 }, 'drill', NOW + 1000);
    const snap = ch.snapshot();
    expect(snap.status).toBe('healthy');
    expect(snap.delivered).toBe(1);
    expect(snap.failed).toBe(1);
    expect(snap.last?.kind).toBe('drill');
  });

  it('从没发过时不编一条 last 出来', () => {
    expect(new AlarmChannel(true, 'x').snapshot().last).toBeUndefined();
  });

  it('没配齐时只出变量名，不碰值', () => {
    const missing = missingAlarmEnvKeys({ CDS_MAP_NOTIFY_ENDPOINT: 'https://x', CDS_MAP_NOTIFY_KEY_ID: '  ' } as NodeJS.ProcessEnv);
    expect(missing).toContain('CDS_MAP_NOTIFY_KEY_ID');
    expect(missing).toContain('CDS_MAP_NOTIFY_PRIVATE_KEY');
    expect(missing).not.toContain('CDS_MAP_NOTIFY_ENDPOINT');
    // 变量名里不许夹带值
    expect(missing.every((k) => ALARM_ENV_KEYS.includes(k as (typeof ALARM_ENV_KEYS)[number]))).toBe(true);
  });
});
