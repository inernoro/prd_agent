import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, loadCatalog, parseActiveRegressions, selectFeatureLines, validateCatalog } from '../stable-smoke-plan.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = loadCatalog();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ledger = readFileSync(resolve(repoRoot, '.claude/skills/stable-smoke/reference/regression-ledger.md'), 'utf8');
const regressions = parseActiveRegressions(ledger);

test('业务功能台账具备发布门禁所需字段', () => {
  assert.deepEqual(validateCatalog(catalog), []);
  assert.ok(catalog.featureLines.length >= 10);
});

test('视觉代码变更自动纳入单图、多图和永久回归', () => {
  const result = selectFeatureLines(catalog, ['prd-admin/src/pages/visual-agent/VisualAgentPage.tsx'], regressions, 'changed');
  const ids = result.selected.map((item) => item.id);
  assert.ok(ids.includes('visual-creation'));
  assert.ok(ids.includes('multi-image-creation'));
  assert.ok(result.selected.some((item) => item.regressionCaseIds.includes('REG-multi-image-001')));
});

test('未登记的核心代码变更不能静默通过', () => {
  const plan = buildPlan({
    catalog,
    changedFiles: ['prd-api/src/UnknownFeature/NewController.cs'],
    activeRegressions: regressions,
    mode: 'changed',
    commit: 'test-commit',
  });
  assert.equal(plan.verdict, 'fail');
  assert.deepEqual(plan.unmappedFiles, ['prd-api/src/UnknownFeature/NewController.cs']);
});

test('定时模式固定纳入全部功能线', () => {
  const result = selectFeatureLines(catalog, [], regressions, 'scheduled');
  assert.equal(result.selected.length, catalog.featureLines.length);
});
