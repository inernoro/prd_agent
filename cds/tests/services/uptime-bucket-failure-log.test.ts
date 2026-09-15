/*
 * 守卫：故障那一段必须能答出「当时炸了什么」。
 *
 * 用户 2026-09-10 的第 3 条反馈：「鼠标悬浮在故障的条状物上面能显示当时故障的
 * 缩写日志」。此前柱条只给「成功 x / 共 y 次」——知道坏了，不知道坏在哪。
 *
 * 判据分两截，都要红得起来：
 *   服务端 bucketizeSamples 把桶内第一次失败的原因盖进 bucket.fail；
 *   前端 describeBucket 把它读成人看的那一行（原生 title 与读数区共用这一份）。
 *
 * 拿不到原因时照实说拿不到（7d / 30d 走按天聚合，原始 err 已经不在了），
 * 不许拿桶级统计编一条像日志的话。
 */
import { describe, expect, it } from 'vitest';

import { bucketizeSamples, type UptimeSample } from '../../src/services/uptime-metrics.js';
import { describeBucket } from '../../web/src/lib/monitorCenter.js';

const T0 = Date.UTC(2026, 8, 10, 0, 0, 0);
const HOUR = 3600_000;

function sample(offsetMs: number, up: boolean, extra: Partial<UptimeSample> = {}): UptimeSample {
  return { t: T0 + offsetMs, up, ms: up ? 120 : 0, ...extra };
}

describe('故障桶携带缩写日志', () => {
  it('把桶内第一次失败的原因与状态码盖进 fail', () => {
    const buckets = bucketizeSamples(
      [
        sample(5 * 60_000, true),
        sample(20 * 60_000, false, { err: '网关服务内部错误（500）', code: 500 }),
        sample(40 * 60_000, false, { err: '探测超时（8000ms）' }),
      ],
      T0,
      T0 + HOUR,
      1,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].status).toBe('partial');
    expect(buckets[0].fail).toEqual({
      at: T0 + 20 * 60_000,
      err: '网关服务内部错误（500）',
      code: 500,
      count: 2,
    });
  });

  it('采样乱序到达也取最早那次失败 —— 故障从它开始，后面多是回声', () => {
    const buckets = bucketizeSamples(
      [
        sample(50 * 60_000, false, { err: '后到的、但更晚的那次' }),
        sample(10 * 60_000, false, { err: '真正的第一次' }),
      ],
      T0,
      T0 + HOUR,
      1,
    );
    expect(buckets[0].fail?.err).toBe('真正的第一次');
  });

  it('失败采样没有 err 时退回状态码，两样都没有就不盖 —— 不编', () => {
    const withCode = bucketizeSamples([sample(10 * 60_000, false, { code: 502 })], T0, T0 + HOUR, 1);
    expect(withCode[0].fail?.err).toBe('HTTP 502');

    const bare = bucketizeSamples([sample(10 * 60_000, false)], T0, T0 + HOUR, 1);
    expect(bare[0].status).toBe('down');
    expect(bare[0].fail).toBeUndefined();
  });

  it('全绿的桶不带 fail', () => {
    const buckets = bucketizeSamples([sample(10 * 60_000, true), sample(30 * 60_000, true)], T0, T0 + HOUR, 1);
    expect(buckets[0].status).toBe('up');
    expect(buckets[0].fail).toBeUndefined();
  });
});

describe('柱条读数把缩写日志说出来', () => {
  it('故障段读得到失败时刻、状态码与原因', () => {
    const [bucket] = bucketizeSamples(
      [sample(10 * 60_000, false, { err: '网关服务内部错误（500）', code: 500 })],
      T0,
      T0 + HOUR,
      1,
    );
    const lines = describeBucket(bucket);
    expect(lines.join('\n')).toContain('网关服务内部错误（500）');
    expect(lines.join('\n')).toContain('HTTP 500');
  });

  it('拿不到原因时明说拿不到，并指出去哪能看到', () => {
    // 按天聚合出来的桶就是这个形状：有 down 计数，没有原始 err。
    const daily = { from: T0, to: T0 + 24 * HOUR, up: 40, down: 3, avgLatencyMs: 210, status: 'partial' as const };
    const text = describeBucket(daily).join('\n');
    expect(text).toContain('看不到当时的失败原因');
    expect(text).toContain('24 小时');
  });

  it('全绿的段不冒出任何失败字样', () => {
    const green = { from: T0, to: T0 + HOUR, up: 12, down: 0, avgLatencyMs: 130, status: 'up' as const };
    expect(describeBucket(green).join('\n')).not.toContain('失败');
  });

  it('无采样的段只说无采样', () => {
    const none = { from: T0, to: T0 + HOUR, up: 0, down: 0, avgLatencyMs: null, status: 'none' as const };
    expect(describeBucket(none).join('\n')).toContain('无采样');
  });
});
