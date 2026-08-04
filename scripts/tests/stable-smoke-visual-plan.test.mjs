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
  assert.doesNotMatch(report, /node scripts|prd-admin\/|e2e\//);
});
