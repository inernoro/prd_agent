import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cleanupAndReadBackResources, cleanupFailureFromAttachments } from '../../e2e/utils/stableSmokeCleanupSafety.mjs';
import { collectPlaywrightCases } from '../stable-smoke-results.mjs';
import { evaluateProductionSafetyGate, buildCommonClosureEvidenceRow } from '../stable-smoke-run.mjs';

const runId = 'stsmk-receipt-fixture';
const resources = [{ kind: 'store', id: 'a'.repeat(32), path: '/api/document-store/stores/' + 'a'.repeat(32) }, { kind: 'entry', id: 'b'.repeat(32), path: '/api/document-store/entries/' + 'b'.repeat(32) }];
const scope = { inspectionRunId: runId, environment: 'cds', testId: 'real-test-id', retry: 0 };
const receipt = (extra = {}) => ({ schemaVersion: 1, ...scope, resources: resources.map(row => ({ ...row, readbackStatus: 404 })), errors: [], ...extra });
const attachment = body => ({ name: 'stable-smoke-cleanup-receipt', body: Buffer.from(JSON.stringify(body)).toString('base64') });
const report = results => ({ suites: [{ specs: [{ id: scope.testId, title: '[FILE-003] 原阶段失败', tags: ['@cleanup'], tests: [{ results }] }] }] });
const attempt = (body, extra = {}) => ({ status: 'failed', error: { message: '原业务阶段失败' }, retry: 0, attachments: body ? [attachment(body)] : [], ...extra });

test('REG-stsmk-cleanup-circuit-001 固定旧collector实际红，新collector消费真实reporter base64绿', async () => {
  const source = execFileSync('/usr/bin/git', ['show', '23065dac5e77f9ba207991236813a0d20a57045a:scripts/stable-smoke-results.mjs'], { encoding: 'utf8' });
  const legacy = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const oldRows = legacy.collectPlaywrightCases(report([attempt(receipt())]), 'cds');
  assert.throws(() => assert.equal(oldRows[0].cleanupStatus, 'passed'), '真实旧判据必须变红，不能只口头称旧红新绿');
  assert.equal(collectPlaywrightCases(report([attempt(receipt())]), 'cds', { inspectionRunId: runId })[0].cleanupStatus, 'passed');
});

test('REG-stsmk-cleanup-circuit-001 业务红不等于清理未知；原attempt独立404保留fail但不误锁正式', () => {
  const rows = collectPlaywrightCases(report([attempt(receipt())]), 'cds', { inspectionRunId: runId });
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].error, '原业务阶段失败');
  assert.equal(rows[0].cleanupStatus, 'passed');
  assert.equal(evaluateProductionSafetyGate({ status: 'failed', resultPath: 'report.json', resultObserved: true }, rows, false, [], 'routine').restricted, false);
  const regressions = ['REG-stsmk-notify-evidence-001', 'REG-stsmk-report-view-001', 'REG-stsmk-report-risk-001'].map(caseId => ({caseId, status:'pass'}));
  assert.equal(buildCommonClosureEvidenceRow([...rows, ...regressions]).status, 'pass', '原业务失败但独立404齐全，派生清理行不得再造unknown误锁正式');
  assert.equal(collectPlaywrightCases(report([attempt()]), 'cds', { inspectionRunId: runId })[0].cleanupStatus, undefined, '旧collector没有真实回执不能解除');
});

test('REG-stsmk-cleanup-circuit-001 首败回执缺失/外轮/环境或attempt错配/200/空回执都不能被重试404覆盖', () => {
  for (const bad of [undefined, receipt({ inspectionRunId: 'stsmk-foreign' }), receipt({ environment: 'production' }), receipt({ retry: 1 }), receipt({ testId: 'foreign-test' }), receipt({ resources: [] }), receipt({ resources: [{ ...resources[0], readbackStatus: 200 }] }), receipt({ errors: ['删除未完成'] })]) {
    const rows = collectPlaywrightCases(report([attempt(bad), attempt(receipt({ retry: 1 }), { retry: 1, status: 'passed' })]), 'cds', { inspectionRunId: runId });
    assert.equal(rows[0].cleanupStatus, undefined);
    assert.equal(rows[0].hadFailedAttempt, true);
    assert.equal(evaluateProductionSafetyGate({ status: 'executed', resultPath: 'report.json', resultObserved: true }, rows, false, [], 'routine').restricted, true);
  }
});

test('REG-stsmk-cleanup-circuit-001 删除抛错仍读取全部资源并先存回执；200不能当404且错误不带原异常', async () => {
  const seen = [], saved = [];
  await assert.rejects(() => cleanupAndReadBackResources({ ...scope, resources,
    remove: async () => { throw Error('private-secret-never-log'); },
    read: async row => { seen.push(row.id); return row.kind === 'entry' ? 200 : 404; }, attach: async value => saved.push(value),
  }), /未闭环/);
  assert.deepEqual(seen, resources.map(row => row.id));
  assert.equal(saved.length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /private-secret/);
  assert.ok(cleanupFailureFromAttachments([{ name: 'stable-smoke-cleanup-receipt', body: JSON.stringify(saved[0]) }], runId));
  const good = await cleanupAndReadBackResources({ ...scope, resources, remove: async () => {}, read: async () => 404, attach: async () => {} });
  assert.equal(cleanupFailureFromAttachments([{ name: 'stable-smoke-cleanup-receipt', body: JSON.stringify(good) }], runId), undefined);
});

test('REG-stsmk-cleanup-circuit-001 已知store和entry不能仅用store404解锁；运行时与reporter共用范围', () => {
  const created = [
    { name: 'short-video-invalid-store-created', body: JSON.stringify({ inspectionRunId: runId, storeId: resources[0].id }) },
    { name: 'short-video-invalid-seed-created', body: JSON.stringify({ storeId: resources[0].id, seedEntryId: resources[1].id }) },
  ];
  const body = receipt({ resources: [receipt().resources[0]] });
  for (const mode of ['missing-entry', 'missing-receipt', 'wrong-environment', 'wrong-test', 'wrong-retry', 'good']) {
    const candidate = mode === 'missing-entry' ? body : receipt({ ...(mode === 'wrong-environment' ? {environment:'production'} : {}), ...(mode === 'wrong-test' ? {testId:'foreign'} : {}), ...(mode === 'wrong-retry' ? {retry:1} : {}) });
    const runtimeAttachments = [...created, ...(mode === 'missing-receipt' ? [] : [{name:'stable-smoke-cleanup-receipt',body:JSON.stringify(candidate)}])];
    const blocked = cleanupFailureFromAttachments(runtimeAttachments, runId, scope);
    assert.equal(Boolean(blocked), mode !== 'good', mode);
    const reportAttachments = runtimeAttachments.map(item => ({...item,body:Buffer.from(item.body).toString('base64')}));
    const rows = collectPlaywrightCases(report([{...attempt(),attachments:reportAttachments}]), 'cds', {inspectionRunId:runId});
    assert.equal(rows[0].cleanupStatus === 'passed', mode === 'good', mode);
    if (mode !== 'good') assert.equal(evaluateProductionSafetyGate({status:'failed',resultObserved:true,resultPath:'report.json'},rows,false,[],'routine').restricted,true);
  }
});

test('REG-stsmk-cleanup-circuit-001 录音真实确定性ID必须绑定原session且只认固定资源路径', () => {
  const sessionId = 'c'.repeat(32), entryId = `recording-completed-${sessionId}`, deferredTranscriptionRunId = `recording-archive-transcribe-${sessionId}`;
  const created = { name:'recording-idempotency-entry-created', body:JSON.stringify({storeId:resources[0].id,sessionId,entryId,deferredTranscriptionRunId}) };
  const body = receipt({resources:[receipt().resources[0], {kind:'session',id:sessionId,path:`/api/document-store/recording-uploads/${sessionId}`,readbackStatus:404}, {kind:'entry',id:entryId,path:`/api/document-store/entries/${entryId}`,readbackStatus:404}, {kind:`run:${deferredTranscriptionRunId}`,id:deferredTranscriptionRunId,path:`/api/document-store/agent-runs/${deferredTranscriptionRunId}`,readbackStatus:404}]});
  const attachments = [created,{name:'stable-smoke-cleanup-receipt',body:JSON.stringify(body)}];
  assert.equal(cleanupFailureFromAttachments(attachments,runId,scope),undefined);
  assert.equal(collectPlaywrightCases(report([{...attempt(),attachments}]),'cds',{inspectionRunId:runId})[0].cleanupStatus,'passed');
  for(const invalid of ['foreign-'+sessionId, 'recording-completed-'+'d'.repeat(32)]) {
    assert.ok(cleanupFailureFromAttachments([{...created,body:JSON.stringify({storeId:resources[0].id,sessionId,entryId:invalid,deferredTranscriptionRunId})},attachments[1]],runId,scope));
  }
  const wrongPath = structuredClone(body);wrongPath.resources[2].path='/api/document-store/entries/other';
  assert.ok(cleanupFailureFromAttachments([created,{...attachments[1],body:JSON.stringify(wrongPath)}],runId,scope));
});

test('REG-stsmk-cleanup-circuit-001 多图真实创建的子run不得被仅工作区404漏核销', () => {
  const workspaceId = 'c'.repeat(32), imageRunId = 'd'.repeat(32);
  const created = [
    {name:'visual-workspace-created', body:JSON.stringify({inspectionRunId:runId,workspaceId})},
    {name:'multi-image-run-created', body:JSON.stringify({inspectionRunId:runId,runId:imageRunId,referenceCount:3})},
  ];
  const workspace = {kind:'workspace',id:workspaceId,path:`/api/visual-agent/image-master/workspaces/${workspaceId}/detail`,readbackStatus:404};
  const imageRun = {kind:'run',id:imageRunId,path:`/api/visual-agent/image-gen/runs/${imageRunId}`,readbackStatus:404};
  for (const candidate of [[workspace], [workspace,{...imageRun,readbackStatus:200}], [workspace,imageRun]]) {
    const attachments = [...created,{name:'stable-smoke-cleanup-receipt',body:JSON.stringify(receipt({resources:candidate}))}];
    const good = candidate.length===2 && candidate[1].readbackStatus===404;
    assert.equal(Boolean(cleanupFailureFromAttachments(attachments,runId,scope)),!good);
    assert.equal(collectPlaywrightCases(report([{...attempt(),attachments}]),'cds',{inspectionRunId:runId})[0].cleanupStatus==='passed',good);
  }
});
