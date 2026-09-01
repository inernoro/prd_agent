import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan,
  loadCatalog,
  loadVisualRegressionCaseIds,
  parseActiveRegressions,
  parseMatrixCaseIds,
  parseMatrixCases,
  selectFeatureLines,
  selectMatrixCasesByEnvironment,
  validateCatalog,
} from '../stable-smoke-plan.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = loadCatalog();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ledger = readFileSync(resolve(repoRoot, '.claude/skills/stable-smoke/reference/regression-ledger.md'), 'utf8');
const regressions = parseActiveRegressions(ledger);
const matrix = readFileSync(resolve(repoRoot, '.claude/skills/stable-smoke/reference/test-matrix.md'), 'utf8');
const matrixCaseIds = parseMatrixCaseIds(matrix);
const matrixCases = parseMatrixCases(matrix);
const visualRegressionCaseIds = loadVisualRegressionCaseIds();

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
    visualRegressionCaseIds,
    mode: 'changed',
    commit: 'test-commit',
  });
  assert.equal(plan.verdict, 'fail');
  assert.deepEqual(plan.unmappedFiles, ['prd-api/src/UnknownFeature/NewController.cs']);
});

test('视觉真实源码路径与本次逃逸回归进入计划，不依赖旧页面目录或已有 active 偶然选中', () => {
  for (const file of [
    'prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx',
    'prd-admin/src/pages/ai-chat/visualAgentModelOptions.ts',
    'prd-admin/src/components/ui/GenSweepLoader.tsx',
    'prd-admin/src/components/ui/generationProgressPlacement.ts',
  ]) {
    const result = selectFeatureLines(catalog, [file], [], 'changed');
    assert.deepEqual(result.unmappedFiles, []);
    assert.ok(result.selected.some((item) => item.id === 'visual-creation'));
    assert.ok(result.selected.some((item) => item.id === 'multi-image-creation'));
  }
  const plan = buildPlan({ catalog, changedFiles: [], activeRegressions: regressions,
    visualRegressionCaseIds, matrixCases, mode: 'scheduled', commit: 'visual-contract-regression' });
  for (const caseId of ['REG-visual-model-contract-001', 'REG-visual-viewport-001']) {
    assert.ok(regressions.includes(caseId));
    assert.ok(plan.requiredCaseIdsByEnvironment.cds.includes(caseId));
    assert.ok(plan.requiredCaseIdsByEnvironment.production.includes(caseId));
  }
});

test('图片输入与网关共享源码命中视觉功能线，JPEG 回归绑定每轮单图必跑项', () => {
  for (const file of [
    'prd-api/src/PrdAgent.Infrastructure/LLM/ImageInputNormalizer.cs',
    'prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs',
  ]) {
    const result = selectFeatureLines(catalog, [file], [], 'changed');
    assert.deepEqual(result.unmappedFiles, []);
    assert.ok(result.selected.some((feature) => feature.id === 'llm-gateway'));
    assert.ok(result.selected.some((feature) => feature.id === 'multi-image-creation'));
  }
  const specification = readFileSync(resolve(repoRoot, 'e2e/specs/stable-smoke.spec.ts'), 'utf8');
  assert.match(specification, /test\('\[VIS-003\]\[REG-image-input-001\]/);
  const selected = selectMatrixCasesByEnvironment(matrixCases, 'jpeg-regression');
  assert.ok(selected.cds.includes('VIS-003'));
  assert.ok(selected.production.includes('VIS-003'));
});

test('定时模式固定纳入全部功能线', () => {
  const result = selectFeatureLines(catalog, [], regressions, 'scheduled');
  assert.equal(result.selected.length, catalog.featureLines.length);
});

test('回归台账模板不会被当作 active 用例', () => {
  assert.ok(regressions.length > 0);
  assert.ok(!regressions.some((caseId) => caseId.includes('{')));
  assert.ok(regressions.every((caseId) => /^REG-[a-z0-9][a-z0-9-]*-\d+$/.test(caseId)));
  assert.ok(regressions.includes('REG-short-video-input-001'));
});

test('定时计划按环境策略纳入矩阵与永久回归', () => {
  const plan = buildPlan({
    catalog,
    changedFiles: [],
    activeRegressions: regressions,
    visualRegressionCaseIds,
    matrixCases,
    mode: 'scheduled',
    commit: 'test-commit',
  });
  const selected = selectMatrixCasesByEnvironment(matrixCases, 'test-commit');
  const functionalRegressions = [...new Set([...regressions,
    ...catalog.featureLines.flatMap((feature) => feature.regressionCaseIds),
  ])].filter((caseId) => !visualRegressionCaseIds.includes(caseId));
  assert.deepEqual(new Set(plan.requiredCaseIdsByEnvironment.cds), new Set([...selected.cds, ...functionalRegressions]));
  assert.deepEqual(new Set(plan.requiredCaseIdsByEnvironment.production), new Set([...selected.production, ...functionalRegressions]));
  assert.deepEqual(plan.visualRegressions, ['REG-visual-evidence-001']);
  assert.ok(!plan.requiredCaseIds.includes('REG-visual-evidence-001'));
  assert.ok(plan.requiredCaseIdsByEnvironment.cds.includes('REC-006'));
  assert.ok(!plan.requiredCaseIdsByEnvironment.production.includes('REC-006'));
  assert.ok(!plan.requiredCaseIdsByEnvironment.production.includes('FILE-004'));
  assert.ok(!plan.requiredCaseIdsByEnvironment.production.includes('VIDEO-005'));
  assert.ok(plan.requiredCaseIdsByEnvironment.production.includes('VIS-004'));
  assert.ok(plan.requiredCaseIdsByEnvironment.cds.includes('REG-visual-policy-001'));
  assert.ok(plan.requiredCaseIdsByEnvironment.production.includes('REG-visual-policy-001'));
  assert.deepEqual(
    new Set(plan.requiredCaseIds),
    new Set([...plan.requiredCaseIdsByEnvironment.cds, ...plan.requiredCaseIdsByEnvironment.production]),
  );
});

test('矩阵解析保留双环境原始策略并按模块只取一条轮换用例', () => {
  assert.deepEqual(matrixCases.map((item) => item.caseId), matrixCaseIds);
  assert.ok(matrixCaseIds.includes('WEB-001'));
  assert.ok(matrixCaseIds.includes('WEB-006'));
  const rec006 = matrixCases.find((item) => item.caseId === 'REC-006');
  assert.equal(rec006.cdsPolicy, '必跑');
  assert.equal(rec006.productionPolicy, '不主动运行');
  const selected = selectMatrixCasesByEnvironment(matrixCases, 'rotation-seed');
  const rotationPolicies = new Map(matrixCases.map((item) => [item.caseId, item.productionPolicy]));
  const selectedRotationByModule = selected.production
    .filter((caseId) => rotationPolicies.get(caseId) === '轮换')
    .reduce((counts, caseId) => {
      const module = caseId.split('-')[0];
      counts.set(module, (counts.get(module) || 0) + 1);
      return counts;
    }, new Map());
  assert.ok([...selectedRotationByModule.values()].every((count) => count === 1));
  const plan = buildPlan({
    catalog,
    changedFiles: [],
    activeRegressions: regressions,
    visualRegressionCaseIds,
    matrixCases,
    mode: 'scheduled',
    commit: 'rotation-seed',
  });
  assert.equal(plan.matrixPolicies['VIS-004'].productionRotation, 'within-case');
  assert.equal(plan.matrixPolicies['VIS-006'].productionRotation, 'case');
});

test('网页托管变更进入功能台账并绑定六个操作锚点', () => {
  const result = selectFeatureLines(catalog, [
    'prd-admin/src/components/web-hosting/LibraryRail.tsx',
    'prd-api/src/PrdAgent.Infrastructure/Services/SiteContentSnapshotService.cs',
  ], [], 'changed');
  assert.deepEqual(result.unmappedFiles, []);
  const feature = result.selected.find((item) => item.id === 'web-hosting-sharing');
  assert.ok(feature);
  assert.deepEqual(feature.requiredCaseIds, ['WEB-001', 'WEB-002', 'WEB-003', 'WEB-004', 'WEB-005', 'WEB-006']);
});

test('正式环境禁止项不得混入可被正式环境选中的组合用例', () => {
  const source = readFileSync(resolve(repoRoot, 'e2e/specs/stable-smoke.spec.ts'), 'utf8');
  const starts = [...source.matchAll(/\n  test\(/g)].map((match) => match.index);
  const blocks = starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
  const productionExcluded = matrixCases.filter((item) => /不主动|不改正式配置/.test(item.productionPolicy));
  for (const item of productionExcluded) {
    const matchingBlocks = blocks.filter((block) => block.includes(`[${item.caseId}]`));
    for (const block of matchingBlocks) {
      assert.match(
        block,
        /test\.skip\(requiredEnv\('STABLE_SMOKE_ENVIRONMENT'\) === 'production'/,
        `${item.caseId} 必须是整条跳过正式环境的独立用例，不得依赖标题 grep 隔离`,
      );
    }
  }
});

test('PR 变更模式同样遵守双环境矩阵策略', () => {
  const plan = buildPlan({
    catalog,
    changedFiles: ['prd-admin/src/pages/transcript-agent/TranscriptAgentPage.tsx'],
    activeRegressions: [],
    matrixCases,
    mode: 'changed',
    commit: 'changed-mode-policy',
  });
  assert.ok(plan.requiredCaseIdsByEnvironment.cds.includes('REC-006'));
  assert.ok(!plan.requiredCaseIdsByEnvironment.production.includes('REC-006'));
});
