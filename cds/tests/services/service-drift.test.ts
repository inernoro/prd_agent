/**
 * computeServiceDrift 测试 — 2026-05-29 openvisual 事故:同一项目下 main 有 3 个
 * 服务、PR 分支只有 2 个,UI 只显示数量看不出"少了哪个 / 哪个挂了"。病根是
 * branch.services 是上次部署的快照,项目新增 build profile 后已部署分支不回灌。
 * 本测试锁死漂移检测的判定边界,防止回归。
 */
import { describe, it, expect } from 'vitest';
import { computeServiceDrift } from '../../src/services/deploy-runtime.js';

describe('computeServiceDrift', () => {
  it('期望 3 个但分支只有 2 个 → 漂移,缺失第 3 个(openvisual 原始 case)', () => {
    const drift = computeServiceDrift(
      ['ai', 'web', 'worker'],
      { ai: { status: 'running' }, web: { status: 'running' } },
    );
    expect(drift.expectedCount).toBe(3);
    expect(drift.healthyCount).toBe(2);
    expect(drift.missingProfileIds).toEqual(['worker']);
    expect(drift.unhealthyProfileIds).toEqual([]);
    expect(drift.hasDrift).toBe(true);
  });

  it('全部 running 且数量齐 → 无漂移', () => {
    const drift = computeServiceDrift(
      ['ai', 'web', 'worker'],
      { ai: { status: 'running' }, web: { status: 'running' }, worker: { status: 'running' } },
    );
    expect(drift.healthyCount).toBe(3);
    expect(drift.hasDrift).toBe(false);
    expect(drift.missingProfileIds).toEqual([]);
  });

  it('服务存在但 error / stopped → 计入 unhealthy 并判漂移', () => {
    const drift = computeServiceDrift(
      ['ai', 'web', 'worker'],
      { ai: { status: 'running' }, web: { status: 'error' }, worker: { status: 'stopped' } },
    );
    expect(drift.healthyCount).toBe(1);
    expect(drift.unhealthyProfileIds).toEqual(['web', 'worker']);
    expect(drift.hasDrift).toBe(true);
  });

  it('从未部署(0 服务条目)→ 不算漂移(那是"未部署",不重复报警)', () => {
    const drift = computeServiceDrift(['ai', 'web', 'worker'], {});
    expect(drift.missingProfileIds).toEqual(['ai', 'web', 'worker']);
    expect(drift.healthyCount).toBe(0);
    // knownServiceCount === 0 → hasDrift 必须 false
    expect(drift.hasDrift).toBe(false);
  });

  it('services 为 undefined → 安全返回,不抛错', () => {
    const drift = computeServiceDrift(['ai'], undefined);
    expect(drift.hasDrift).toBe(false);
    expect(drift.missingProfileIds).toEqual(['ai']);
  });

  it('building / starting 等中间态既不算 healthy 也不算 unhealthy(避免部署中误报)', () => {
    const drift = computeServiceDrift(
      ['ai', 'web'],
      { ai: { status: 'running' }, web: { status: 'building' } },
    );
    expect(drift.healthyCount).toBe(1);
    expect(drift.unhealthyProfileIds).toEqual([]);
    // web 在构建中,有服务条目但既非 running 也非 error/stopped → 不报漂移
    expect(drift.hasDrift).toBe(false);
  });

  it('没有任何 profile(项目未配构建配置)→ 无漂移', () => {
    const drift = computeServiceDrift([], { ai: { status: 'running' } });
    expect(drift.expectedCount).toBe(0);
    expect(drift.hasDrift).toBe(false);
  });
});
