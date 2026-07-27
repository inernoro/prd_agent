/**
 * 复制集被动健康摘除契约测试（debt #12 偿还，2026-07-26）。
 * 锁五件事：连接级死亡信号连续 2 次才摘；非致命错误码（超时/重置/5xx 不经此路）
 * 永不摘；冷却到期自动放行半开试探；试探再失败退避翻倍；一次成功完全回池。
 * pickReplica 侧：被摘成员退出粘性与加权；全组皆摘回落主成员（绝不无出口）。
 */
import { describe, expect, it } from 'vitest';
import { ReplicaHealthRegistry } from '../../src/forwarder/replica-health.js';
import { pickReplica } from '../../src/forwarder/route-resolver.js';
import type { RouteRecord } from '../../src/forwarder/types.js';

const member = (id: string, weight = 100): RouteRecord => ({
  _id: `r-${id}`, host: 'demo.miduo.org', upstreamHost: '127.0.0.1', upstreamPort: 1000,
  weight, replicaGroup: 'g1', replicaMemberId: id,
});

describe('ReplicaHealthRegistry', () => {
  it('连续 2 次 ECONNREFUSED 才摘除；单次不摘（容器重启瞬间豁免）', () => {
    let now = 0;
    const reg = new ReplicaHealthRegistry(() => now);
    const m = member('res-1');
    reg.noteFailure(m, 'ECONNREFUSED');
    expect(reg.isEjected(m)).toBe(false);
    reg.noteFailure(m, 'ECONNREFUSED');
    expect(reg.isEjected(m)).toBe(true);
  });

  it('非致命错误码不计入摘除（超时可能只是慢，重置可能是重启瞬间）', () => {
    const reg = new ReplicaHealthRegistry(() => 0);
    const m = member('res-1');
    for (const code of ['ETIMEDOUT', 'ECONNRESET', undefined, 'EPIPE']) {
      reg.noteFailure(m, code);
      reg.noteFailure(m, code);
    }
    expect(reg.isEjected(m)).toBe(false);
  });

  it('冷却到期放行半开试探；试探失败立即再摘且退避翻倍；成功完全回池', () => {
    let now = 0;
    const reg = new ReplicaHealthRegistry(() => now);
    const m = member('res-1');
    reg.noteFailure(m, 'ECONNREFUSED');
    reg.noteFailure(m, 'ECONNREFUSED');
    expect(reg.isEjected(m)).toBe(true);
    now = 15_000 + 1; // 第一轮冷却 15s 到期 → 放行
    expect(reg.isEjected(m)).toBe(false);
    reg.noteFailure(m, 'ECONNREFUSED'); // 半开试探又连不上 → 立即再摘（计数保持在阈值边缘）
    expect(reg.isEjected(m)).toBe(true);
    now = 15_000 + 1 + 30_000; // 第二轮退避 30s
    expect(reg.isEjected(m)).toBe(false);
    reg.noteSuccess(m);
    reg.noteFailure(m, 'ECONNREFUSED');
    expect(reg.isEjected(m)).toBe(false); // 回池后重新从零计数
  });

  it('半开只放行一个探针：查询不占位，reserveProbe 占位后并发请求仍视为摘除（Codex P2 + 第十六轮 P2）', () => {
    let now = 0;
    const reg = new ReplicaHealthRegistry(() => now);
    const m = member('res-1');
    reg.noteFailure(m, 'ECONNREFUSED');
    reg.noteFailure(m, 'ECONNREFUSED');
    now = 15_000 + 1; // 冷却到期
    // isEjected 是纯查询（第十六轮 P2）：重复查询不烧探针名额——落选成员的
    // 候选过滤不许替它占位
    expect(reg.isEjected(m)).toBe(false);
    expect(reg.isEjected(m)).toBe(false);
    reg.reserveProbe(m);                  // 最终选中者才占位
    expect(reg.isEjected(m)).toBe(true);  // 并发请求不许跟着涌向死成员
    expect(reg.isEjected(m)).toBe(true);
    // 探针成功 → 完全回池，所有请求放行；健康成员上 reserveProbe 是 no-op
    reg.noteSuccess(m);
    reg.reserveProbe(m);
    expect(reg.isEjected(m)).toBe(false);
    // 再摘一轮：探针占位超时（如客户端中途放弃、无成败回调）→ 下一个请求接棒
    reg.noteFailure(m, 'ECONNREFUSED');
    reg.noteFailure(m, 'ECONNREFUSED');
    now += 15_000 + 1;
    reg.reserveProbe(m);                  // 探针 1 占位
    expect(reg.isEjected(m)).toBe(true);
    now += 10_001;                        // 超过 PROBE_TIMEOUT_MS
    expect(reg.isEjected(m)).toBe(false); // 占位超时 → 半开重新可见
    reg.reserveProbe(m);                  // 接棒探针占位
    expect(reg.isEjected(m)).toBe(true);
  });

  it('非复制集路由永不参与（replicaGroup 缺省）', () => {
    const reg = new ReplicaHealthRegistry(() => 0);
    const plain: RouteRecord = { _id: 'p', host: 'x', upstreamHost: '127.0.0.1', upstreamPort: 1, weight: 100 };
    reg.noteFailure(plain, 'ECONNREFUSED');
    reg.noteFailure(plain, 'ECONNREFUSED');
    expect(reg.isEjected(plain)).toBe(false);
    expect(reg.snapshot()).toHaveLength(0);
  });
});

describe('pickReplica 被动健康集成', () => {
  const primary = member('primary', 100);
  const res1 = member('res-1', 100);

  it('被摘成员退出加权随机：流量全落主成员', () => {
    const isEjected = (r: RouteRecord): boolean => r.replicaMemberId === 'res-1';
    for (const rand of [0.01, 0.5, 0.99]) {
      expect(pickReplica([primary, res1], { rand: () => rand, isEjected }).replicaMemberId).toBe('primary');
    }
  });

  it('粘性指向被摘成员：放弃粘性落回健康成员（故障转移优先于会话稳定）', () => {
    const isEjected = (r: RouteRecord): boolean => r.replicaMemberId === 'res-1';
    expect(pickReplica([primary, res1], { sticky: 'res-1', rand: () => 0.9, isEjected }).replicaMemberId).toBe('primary');
  });

  it('全组皆摘：回落主成员做半开试探（绝不无出口）', () => {
    const isEjected = (): boolean => true;
    expect(pickReplica([primary, res1], { rand: () => 0.5, isEjected }).replicaMemberId).toBe('primary');
  });

  it('未注入 isEjected 时行为与历史逐字节一致', () => {
    expect(pickReplica([primary, res1], { sticky: 'res-1' }).replicaMemberId).toBe('res-1');
    expect(pickReplica([primary, res1], { rand: () => 0.01 }).replicaMemberId).toBe('primary');
  });
});
