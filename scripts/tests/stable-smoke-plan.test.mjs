import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, loadCatalog, parseActiveRegressions, parseMatrixCaseIds, selectFeatureLines, validateCatalog } from '../stable-smoke-plan.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = loadCatalog();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ledger = readFileSync(resolve(repoRoot, '.claude/skills/stable-smoke/reference/regression-ledger.md'), 'utf8');
const regressions = parseActiveRegressions(ledger);
const matrix = readFileSync(resolve(repoRoot, '.claude/skills/stable-smoke/reference/test-matrix.md'), 'utf8');
const matrixCaseIds = parseMatrixCaseIds(matrix);

test('业务功能台账具备发布门禁所需字段', () => {
  assert.deepEqual(validateCatalog(catalog), []);
  assert.ok(catalog.featureLines.length >= 10);
  assert.ok(catalog.featureLines.every((item) => item.cdsPolicy && !('testPolicy' in item)));
});

test('48 小时调度属于本地自动化而非 GitHub Actions', () => {
  const promptPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/local-automation-prompt.md');
  const workflowPath = resolve(repoRoot, '.github/workflows/stable-smoke-48h.yml');
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /execution_environment.*local|执行环境：`local`/);
  assert.match(prompt, /RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=2;BYMINUTE=17/);
  assert.match(prompt, /正式环境固定为 `https:\/\/map\.ebcone\.net`/);
  assert.equal(existsSync(workflowPath), false);
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

test('回归台账模板不会被当作 active 用例', () => {
  assert.ok(!regressions.some((caseId) => caseId.includes('{')));
  assert.deepEqual(regressions.sort(), [
    'REG-file-001',
    'REG-llmgw-auth-001',
    'REG-multi-image-001',
    'REG-multi-image-002',
    'REG-video-001',
    'REG-visual-error-001',
  ]);
});

test('定时计划完整纳入矩阵与永久回归', () => {
  const plan = buildPlan({
    catalog,
    changedFiles: [],
    activeRegressions: regressions,
    matrixCaseIds,
    mode: 'scheduled',
    commit: 'test-commit',
  });
  const expected = new Set([...matrixCaseIds, ...regressions]);
  assert.deepEqual(new Set(plan.requiredCaseIds), expected);
});
