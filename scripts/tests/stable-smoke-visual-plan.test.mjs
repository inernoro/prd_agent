import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildVisualPlan, renderVisualPlan } from '../stable-smoke-visual-plan.mjs';

const catalog = JSON.parse(readFileSync('.claude/skills/stable-smoke/reference/visual-evidence-catalog.json', 'utf8'));

test('视觉取证计划逐模块展开为148条有路径的任务', () => {
  const plan = buildVisualPlan(catalog);
  assert.equal(plan.plannedScreenshotTarget, 148);
  assert.equal(plan.modules.length, 10);
  assert.equal(plan.slots.length, 148);
  assert.ok(plan.slots.every((slot) => slot.breadcrumb.split('→').length >= 4));
  assert.ok(plan.slots.every((slot) => slot.primaryState && slot.expectedProof && slot.methodAnchor));
});

test('双环境视觉计划展开为296个互不复用的环境验收位', () => {
  const plan = buildVisualPlan(catalog, ['cds', 'production']);
  assert.equal(plan.schemaVersion, '2.0');
  assert.equal(plan.plannedScreenshotTarget, 296);
  assert.equal(plan.slots.filter((slot) => slot.environment === 'cds').length, 148);
  assert.equal(plan.slots.filter((slot) => slot.environment === 'production').length, 148);
  assert.equal(new Set(plan.slots.map((slot) => slot.slotId)).size, 296);
  assert.ok(plan.slots.every((slot) => slot.slotId.startsWith(`${slot.environment.toUpperCase()}-VISUAL-`)));
});

test('本轮视觉计划固化运行标识、提交和取证开始时间', () => {
  const plan = buildVisualPlan(catalog, ['cds'], {
    runId: 'stsmk-20260811',
    commit: 'a'.repeat(40),
    captureStartedAt: '2026-08-11T14:00:00.000Z',
  });
  assert.equal(plan.schemaVersion, '3.0');
  assert.equal(plan.runId, 'stsmk-20260811');
  assert.equal(plan.commit, 'a'.repeat(40));
  assert.equal(plan.captureStartedAt, '2026-08-11T14:00:00.000Z');
  const report = renderVisualPlan(plan);
  assert.match(report, /运行标识：stsmk-20260811/);
  assert.match(report, /取证开始：2026-08-11T14:00:00.000Z/);
});

test('正式环境只读健康检查不生成无关的完整视觉矩阵', () => {
  const plan = buildVisualPlan(catalog, ['production'], {
    runId: 'stsmk-production-read-only',
    commit: 'a'.repeat(40),
    captureStartedAt: '2026-08-11T14:00:00.000Z',
    scope: 'production-read-only',
  });
  assert.equal(plan.schemaVersion, '3.0');
  assert.equal(plan.scope, 'production-read-only');
  assert.equal(plan.plannedScreenshotTarget, 0);
  assert.deepEqual(plan.modules, []);
  assert.deepEqual(plan.slots, []);
  const report = renderVisualPlan(plan);
  assert.match(report, /完整视觉门禁不适用/);
  assert.match(report, /不代表完整视觉验收通过/);
});

test('单图和多图视觉各有18条且覆盖产品主题与双设备', () => {
  const plan = buildVisualPlan(catalog);
  for (const moduleId of ['single-image-creation', 'multi-image-creation']) {
    const slots = plan.slots.filter((slot) => slot.moduleId === moduleId);
    assert.equal(slots.length, 18);
    assert.deepEqual([...new Set(slots.map((slot) => slot.theme))], ['dark']);
    assert.deepEqual([...new Set(slots.map((slot) => slot.viewportClass))].sort(), ['desktop', 'mobile']);
  }
});

test('主管清单不展示内部源码路径或执行命令', () => {
  const report = renderVisualPlan(buildVisualPlan(catalog));
  assert.match(report, /完整测试路径/);
  assert.match(report, /方图与宽图进度边界/);
  assert.match(report, /是否需干预/);
  assert.match(report, /逐模块视觉取证任务/);
  assert.match(report, /登录、权限与头像 · 0\/14 项完成/);
  assert.equal((report.match(/需要执行并取证/g) || []).length, 148);
  assert.doesNotMatch(report, /node scripts|prd-admin\/|e2e\//);
});
