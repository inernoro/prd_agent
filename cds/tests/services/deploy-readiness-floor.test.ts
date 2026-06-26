import { describe, expect, it } from 'vitest';
import {
  resolveDeployReadinessFloorSeconds,
  applyDeployReadinessFloor,
} from '../../src/services/container.js';
import type { ReadinessProbe } from '../../src/types.js';

/**
 * 发布探活分阶段（R4 / Phase 2, 2026-06-24）。
 * 发布(部署)首启可能很慢（构建/迁移/JVM 暖机），给足探测时间避免误杀；
 * 运行期重启/唤醒不走这里，保持 profile 自己的短超时。
 */
describe('resolveDeployReadinessFloorSeconds', () => {
  it('默认 1200（系统/项目都未设）', () => {
    expect(resolveDeployReadinessFloorSeconds(undefined, undefined)).toBe(1200);
    expect(resolveDeployReadinessFloorSeconds(null, null)).toBe(1200);
    expect(resolveDeployReadinessFloorSeconds(0, 0)).toBe(1200);
  });
  it('系统默认生效（项目未设）', () => {
    expect(resolveDeployReadinessFloorSeconds(600, undefined)).toBe(600);
  });
  it('项目覆盖优先于系统默认', () => {
    expect(resolveDeployReadinessFloorSeconds(600, 1800)).toBe(1800);
  });
  it('项目设 0 视为未设 → 退回系统默认', () => {
    expect(resolveDeployReadinessFloorSeconds(600, 0)).toBe(600);
  });
});

describe('applyDeployReadinessFloor', () => {
  it('profile 超时低于下限 → 抬到下限，其它字段保留', () => {
    const probe: ReadinessProbe = { timeoutSeconds: 300, intervalSeconds: 5, path: '/health', noHttp: false };
    const out = applyDeployReadinessFloor(probe, 1200);
    expect(out?.timeoutSeconds).toBe(1200);
    expect(out?.intervalSeconds).toBe(5);
    expect(out?.path).toBe('/health');
    expect(out?.noHttp).toBe(false);
  });
  it('profile 超时已高于下限 → 原样不动（不下调）', () => {
    const probe: ReadinessProbe = { timeoutSeconds: 1800 };
    expect(applyDeployReadinessFloor(probe, 1200)).toBe(probe);
  });
  it('无 probe → 生成只含 timeout 的 probe', () => {
    expect(applyDeployReadinessFloor(undefined, 1200)).toEqual({ timeoutSeconds: 1200 });
  });
  it('floor<=0 → 原样返回（不强加）', () => {
    const probe: ReadinessProbe = { timeoutSeconds: 200 };
    expect(applyDeployReadinessFloor(probe, 0)).toBe(probe);
    expect(applyDeployReadinessFloor(undefined, 0)).toBeUndefined();
  });
  it('不改原对象（返回新对象）', () => {
    const probe: ReadinessProbe = { timeoutSeconds: 100, noHttp: true };
    const out = applyDeployReadinessFloor(probe, 1200);
    expect(out).not.toBe(probe);
    expect(probe.timeoutSeconds).toBe(100);
    expect(out?.noHttp).toBe(true);
  });
});
