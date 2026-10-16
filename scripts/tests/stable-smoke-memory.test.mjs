import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadBusinessContract, readPools, persistRunExperience, updatePools, pendingRetests } from '../stable-smoke-memory.mjs';
import { buildPlan, loadCatalog, parseMatrixCases, parseActiveRegressions } from '../stable-smoke-plan.mjs';
import { buildVisualPlan } from '../stable-smoke-visual-plan.mjs';
import { validateVisualEvidence } from '../stable-smoke-visual-gate.mjs';
const contract = loadBusinessContract();
const input = { runId: 'stsmk-memory-001', completedAt: '2026-10-13T08:00:00Z', rows: [{ environment: 'production', caseId: 'VIS-009', status: 'pass', retryCount: 1, classification: 'test' }] };

test('阅读表直接生成31项执行合同，CDS只保留五个核心功能', () => {
  assert.equal(contract.features.length, 31);
  assert.equal(contract.commonMethods.length, 8);
  assert.deepEqual(contract.features.filter(f => f.cdsCore).map(f => f.id), ['F01', 'F05', 'F08', 'F17', 'F18']);
  assert.ok(contract.features.find(f => f.id === 'F17').caseIds.includes('VIS-002'));
});
test('重试通过仍为flaky，生成热点、候选手段和原用例历史', () => {
  const result = updatePools({ revision: 0 }, input, contract);
  assert.equal(result.events[0].status, 'flaky');
  assert.equal(result.hotspots.find(f => f.featureId === 'F19').recent, true);
  assert.ok(result.methods.some(method => method.status === '待验证'));
  assert.deepEqual(pendingRetests(result, 'production'), ['VIS-009']);
});
test('同轮重复回填不增加事故频次，修复后不抹掉首次失败', () => {
  const first = updatePools({}, input, contract);
  const same = updatePools(first, input, contract);
  assert.equal(same.runs.length, 1);
  assert.equal(same.events.length, 1);
  assert.equal(same.hotspots.find(f => f.featureId === 'F19').recentFailureRuns, 1);
  const green = updatePools(same, { ...input, rows: [{ environment: 'production', caseId: 'VIS-009', status: 'pass' }] }, contract);
  assert.equal(green.events.length, 2);
  assert.ok(green.events.some(e => e.status === 'flaky'));
  assert.equal(green.defects[0].status, 'open');
});
test('REG-stsmk-report-risk-001 后续回填必须保留既有闭环诊断与热点补充证据，不污染原对象', () => {
  const first = updatePools({}, input, contract);
  first.latestClosure = { runId: input.runId, status: 'blocked', evidence: 'immutable-evidence' };
  first.allDone = true;
  first.hotspots.find(f => f.featureId === 'F19').latestValidatedReview = { reportId: 'verified-old-report', score: 88 };
  first.hotspots.find(f => f.featureId === 'F19').supplementalReviews = [{ runId: 'supplemental-run', status: 'fail' }];
  first.runs[0].maintenanceRecovery = { status: 'verified', resourceIds: ['original-resource'] };
  first.events[0].diagnosis = { fixRef: 'original-fix-ref' };
  const snapshot = structuredClone(first);
  const next = updatePools(first, input, contract);
  assert.deepEqual(next.latestClosure, first.latestClosure);
  assert.deepEqual(next.hotspots.find(f => f.featureId === 'F19').latestValidatedReview, { reportId: 'verified-old-report', score: 88 });
  assert.deepEqual(next.hotspots.find(f => f.featureId === 'F19').supplementalReviews, [{ runId: 'supplemental-run', status: 'fail' }]);
  assert.deepEqual(next.runs[0].maintenanceRecovery, { status: 'verified', resourceIds: ['original-resource'] });
  assert.deepEqual(next.events[0].diagnosis, { fixRef: 'original-fix-ref' });
  assert.deepEqual(first, snapshot);
  assert.equal(next.allDone, false, '旧轮完成标记不能让当前flaky轮冒绿');
  assert.equal(next.hotspots.find(f => f.featureId === 'F19').latest.find(x => x.environment === 'production').status, 'flaky');
});
test('两个不同轮次同因失败才增加频次；成功和未执行不算改善或新事故', () => {
  const first = updatePools({}, input, contract);
  const second = updatePools(first, { ...input, runId: 'stsmk-memory-002' }, contract);
  assert.equal(second.hotspots.find(f => f.featureId === 'F19').recentFailureRuns, 2);
  const absent = updatePools(second, { ...input, runId: 'stsmk-memory-003', rows: [] }, contract);
  assert.equal(absent.events.length, 2);
  assert.equal(absent.hotspots.find(f => f.featureId === 'F19').recentFailureRuns, 2);
  assert.equal(absent.runs.at(-1).results.find(r => r.featureId === 'F19' && r.environment === 'production').status, 'not-run');
});
test('没有verify-open的链接不进入三池，CDS通过不填正式通过', () => {
  const state = updatePools({}, { ...input, rows: [{ environment: 'cds', caseId: 'VIS-002', status: 'pass' }], archive: { reportUrl: 'https://example.test/reports?report=1' } }, contract);
  assert.equal(state.events[0].reportUrl, '');
  assert.equal(state.runs[0].evidenceVerified, false);
  assert.equal(state.runs[0].results.find(r => r.featureId === 'F17' && r.environment === 'production').status, 'not-run');
});
test('REG-stsmk-report-risk-001 正式全部显式未执行占位不能聚合通过', () => {
  const ids=[...new Set(contract.features.flatMap(f=>f.caseIds))];
  const state=updatePools({}, {...input, rows:ids.map(caseId=>({environment:'production',caseId,status:'not-run'})),requiredCaseIdsByEnvironment:{production:ids,cds:[]}},contract);
  assert.ok(state.runs[0].results.filter(r=>r.environment==='production').every(r=>r.status==='not-run'));
  assert.ok(state.hotspots.every(h=>h.latest.find(r=>r.environment==='production').status==='not-run'));
});
test('REG-stsmk-report-risk-001 手机子项通过不遮住正式同功能未执行', () => {
  const feature=contract.features.find(f=>f.id==='F17');
  const state=updatePools({}, {...input,rows:feature.caseIds.map(caseId=>({environment:'production',caseId,status:caseId==='CORE-010'?'pass':'not-run'})),requiredCaseIdsByEnvironment:{production:feature.caseIds,cds:[]}},contract);
  assert.equal(state.runs[0].results.find(r=>r.featureId==='F17'&&r.environment==='production').status,'not-run');
});
test('原通知缺陷沿用编号并记持续阻塞，不虚构多个产品事故', () => {
  const state = updatePools({}, { ...input, rows: [], notification: { status: 'blocked' } }, contract);
  assert.equal(state.defects[0].defectId, 'DEF-STSMK-NOTIFY-001');
  assert.equal(state.defects[0].classification, 'configuration');
  assert.equal(state.defects[0].status, 'blocked');
  const historical = updatePools({ defects: [{ defectId: 'DEF-STSMK-NOTIFY-001', environment: 'production', status: 'blocked', firstRunId: '历史源未提供，禁止用导入轮次替代' }] }, { ...input, notification: { status: 'blocked' } }, contract);
  assert.match(historical.defects.find(item => item.defectId === 'DEF-STSMK-NOTIFY-001').firstRunId, /历史源未提供/);
});

test('REG-stsmk-report-risk-001 报告归档拒收导致未投递，不能更新原通知配置缺陷', () => {
  const previous = { defects:[{defectId:'DEF-STSMK-NOTIFY-001',status:'blocked',firstRunId:'stsmk-original',latestRunId:'stsmk-original',environment:'production',caseIds:['REG-stsmk-notify-evidence-001']}] };
  const state = updatePools(previous,{...input,rows:[],archive:{status:'failed'},notification:{status:'delivery-failed'}} ,contract);
  assert.equal(state.defects.find(x=>x.defectId==='DEF-STSMK-NOTIFY-001').latestRunId,'stsmk-original');
  assert.equal(state.events.some(x=>x.caseId==='REG-stsmk-notify-evidence-001'),false);
});
test('重试仍失败不能伪装flaky；近期窗口按上海14个自然日', () => {
  const old = updatePools({}, { ...input, completedAt: '2026-09-29T16:00:00Z', rows: [{ environment: 'production', caseId: 'VIS-009', status: 'fail', retryCount: 1 }] }, contract);
  assert.equal(old.events[0].status, 'fail');
  const next = updatePools(old, { ...input, runId: 'stsmk-window-001', completedAt: '2026-10-13T15:59:59Z', rows: [] }, contract);
  const hotspot = next.hotspots.find(item => item.featureId === 'F19');
  assert.deepEqual(hotspot.window, { start: '2026-09-30', end: '2026-10-13', timezone: 'Asia/Shanghai' });
  assert.equal(hotspot.recentFailureRuns, 1);
  const expired = updatePools(next, { ...input, runId: 'stsmk-window-002', completedAt: '2026-10-13T16:00:00Z', rows: [] }, contract);
  assert.equal(expired.hotspots.find(item => item.featureId === 'F19').recentFailureRuns, 0);
});
test('原子保存、回读、条件版本和并发锁防止覆盖，失败不破坏旧账', () => {
  const folder = mkdtempSync(resolve(tmpdir(), 'stsmk-memory-'));
  const path = resolve(folder, 'pools.json');
  try {
    const saved = persistRunExperience(input, { path, contract, expectedRevision: 0 });
    assert.equal(saved.features, 31);
    assert.equal(readPools(path).revision, 1);
    assert.throws(() => persistRunExperience(input, { path, contract, expectedRevision: 0 }), /拒绝覆盖/);
    writeFileSync(`${path}.lock`, 'another-run');
    assert.throws(() => persistRunExperience(input, { path, contract }), /EEXIST/);
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), 'another-run');
    assert.equal(readPools(path).revision, 1);
  } finally { rmSync(folder, { recursive: true }); }
});
test('例行计划减少CDS而保持正式矩阵，热点不能越权加入正式故障注入', () => {
  const base = { catalog: loadCatalog(), changedFiles: [], activeRegressions: parseActiveRegressions(readFileSync('.claude/skills/stable-smoke/reference/regression-ledger.md', 'utf8')), matrixCases: parseMatrixCases(readFileSync('.claude/skills/stable-smoke/reference/test-matrix.md', 'utf8')), mode: 'scheduled', commit: 'a'.repeat(40) };
  const full = buildPlan(base);
  const routine = buildPlan({ ...base, profile: 'routine', businessContract: contract, pools: { defects: [{ status: 'open', environment: 'production', caseIds: ['GW-006'] }] } });
  assert.ok(routine.requiredCaseIdsByEnvironment.cds.length < full.requiredCaseIdsByEnvironment.cds.length / 2);
  assert.deepEqual([...routine.requiredCaseIdsByEnvironment.production].sort(), [...full.requiredCaseIdsByEnvironment.production].sort());
  assert.ok(!routine.requiredCaseIdsByEnvironment.production.includes('GW-006'));
  const withHotspot = buildPlan({ ...base, profile: 'routine', businessContract: contract, pools: { defects: [{ status: 'open', environment: 'cds', caseIds: ['WEB-001'] }] } });
  assert.ok(withHotspot.requiredCaseIdsByEnvironment.cds.includes('WEB-001'));
  assert.deepEqual(withHotspot.cdsCoreCaseIds, routine.cdsCoreCaseIds);
});
test('例行视觉合同按环境保留核心状态，缺图仍失败，偷减计划被拒', () => {
  const catalog = JSON.parse(readFileSync('.claude/skills/stable-smoke/reference/visual-evidence-catalog.json', 'utf8'));
  const plan = buildVisualPlan(catalog, ['cds'], { scope: 'routine' });
  assert.equal(plan.slots.length, 14);
  assert.equal(plan.modules.length, 4);
  assert.notEqual(validateVisualEvidence(catalog, [], ['cds'], plan).verdict, '通过');
  assert.throws(() => validateVisualEvidence(catalog, [], ['cds'], { ...plan, slots: plan.slots.slice(1) }), /拒绝缩减/);
  const production = buildVisualPlan(catalog, ['production'], { scope: 'routine' });
  assert.ok(production.slots.length > plan.slots.length);
  assert.equal(production.modules.length, 10);
});
