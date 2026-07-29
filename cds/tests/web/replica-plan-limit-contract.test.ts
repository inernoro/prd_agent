import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPLICA_PLAN_MAX_STEPS } from '../../web/src/lib/replicaGroups';

/**
 * 前后端「单计划步数上限」防漂移（Codex 第二十六轮 P2）。
 *
 * 后端 startPlan 用 REPLICA_PLAN_MAX_STEPS 拒绝超步计划；前端用同名常量在**加草稿前**
 * 预检。两值一旦漂移，用户又会回到「按钮可点 → 攒完草稿 → 保存时 400」的老坑，
 * 所以这里直接从后端源码解析真值比对，而不是各写各的。
 */
describe('复制集计划步数上限：前后端常量一致', () => {
  const backendSource = readFileSync(
    resolve(__dirname, '../../src/services/replica-set.ts'),
    'utf8',
  );

  it('后端导出 REPLICA_PLAN_MAX_STEPS 且与前端常量相等', () => {
    const m = /export const REPLICA_PLAN_MAX_STEPS = (\d+);/.exec(backendSource);
    expect(m, '后端未导出 REPLICA_PLAN_MAX_STEPS（改名了？）').not.toBeNull();
    expect(Number(m![1])).toBe(REPLICA_PLAN_MAX_STEPS);
  });

  it('后端校验分支引用常量而非裸数字', () => {
    expect(backendSource).toContain('input.steps.length > REPLICA_PLAN_MAX_STEPS');
    expect(backendSource).not.toContain('单个计划最多 20 步');
  });

  it('上限足够容纳现实规模的项目级整组动作', () => {
    // 整组副本 / 统一战线隔离按服务数生成步骤，上限必须高于单分支服务数上限，
    // 否则这些「必须覆盖全部服务」的动作对大项目永远存不下去。
    expect(REPLICA_PLAN_MAX_STEPS).toBeGreaterThanOrEqual(30);
  });
});
