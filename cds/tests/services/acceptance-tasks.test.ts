import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceTaskService, startAcceptanceLeaseReaper } from '../../src/services/acceptance-tasks.js';
import { createReportObjectStore } from '../../src/services/report-object-store.js';
import type { AcceptanceCase, AcceptanceSubmission, AcceptanceTask } from '../../src/acceptance-types.js';

function businessCase(caseId = 'VIS-001'): AcceptanceCase {
  return { caseId, title: '默认模型生图', module: '视觉创作', criticality: 'core', environments: ['production', 'cds'], breadcrumb: ['百宝箱', '视觉创作'], entryPath: '/visual', preconditions: ['专用巡检身份'], inputs: [{ name: '提示词', value: '白桃' }], steps: [{ id: 'generate', action: '保留默认模型并生成', expected: '返回可下载图片' }], assertions: [{ id: 'decoded', description: '图片解码且尺寸正确' }], evidenceRequired: true, cleanup: 'required', cleanupInstructions: '删除本轮资源后回读', owner: '视觉业务负责人' };
}
function result(submissionId = 'submit-1', status: AcceptanceSubmission['status'] = 'pass'): AcceptanceSubmission {
  return { submissionId, status, actual: '白桃图片完成', assertions: [{ id: 'decoded', passed: status === 'pass', actual: '解码为 1024 × 1024' }], evidence: [{ kind: 'image', url: 'https://images.example.com/peach.png', caption: '白桃成图' }], cleanup: { status: 'pass', details: '已删除并确认无残留' } };
}

describe('结构化验收任务', () => {
  let dir: string, state: StateService, service: AcceptanceTaskService, clock: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-task-'));
    process.env.CDS_CACHE_BASE = path.join(dir, 'cache');
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: '项目一', kind: 'git', createdAt: '', updatedAt: '' });
    state.addProject({ id: 'p2', slug: 'p2', name: '项目二', kind: 'git', createdAt: '', updatedAt: '' });
    clock = Date.parse('2026-10-02T00:00:00.000Z');
    service = new AcceptanceTaskService(state, { now: () => new Date(clock), leaseMs: 1_000 });
  });
  afterEach(async () => { await state.flush().catch(() => {}); delete process.env.CDS_CACHE_BASE; fs.rmSync(dir, { recursive: true, force: true }); });
  async function task(cases = [businessCase()]): Promise<AcceptanceTask> {
    const template = await service.publishTemplate({ projectId: 'p1', title: '核心功能', cases });
    return service.createTask({ projectId: 'p1', templateId: template.id, environment: 'production' });
  }

  it('并发领取只一胜，重复service实例共享权威互斥且票据读取隐藏', async () => {
    const t = await task(), another = new AcceptanceTaskService(state, { now: () => new Date(clock), leaseMs: 1_000 });
    const claims = await Promise.allSettled([service.claim(t.id, 'Agent A'), another.claim(t.id, 'Agent B')]);
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
    const success = claims.find((c) => c.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<AcceptanceTaskService['claim']>>>;
    expect(success.value.leaseToken).toBeTruthy();
    expect(JSON.stringify(service.getTask(t.id))).not.toContain(success.value.leaseToken);
    expect(service.getTask(t.id)).not.toHaveProperty('leaseTokenHash');
    expect(service.listTasks('p1')[0]).not.toHaveProperty('leaseGeneration');
    expect(state.getState().acceptanceTasks![0].leaseTokenHash).toHaveLength(64);
  });
  it('过期租约可接续，旧票据不能写结果或心跳', async () => {
    const t = await task(), old = await service.claim(t.id, 'A'); clock += 1_001;
    expect(await service.reconcileExpiredLeases()).toBe(1);
    expect(service.getTask(t.id).status).toBe('pending');
    const next = await service.claim(t.id, 'B');
    expect(next.task.lease!.generation).toBe(2);
    await expect(service.submit(t.id, 'VIS-001', old.leaseToken, result())).rejects.toMatchObject({ code: 'lease_invalid' });
    await expect(service.heartbeat(t.id, old.leaseToken)).rejects.toMatchObject({ code: 'lease_invalid' });
    await service.submit(t.id, 'VIS-001', next.leaseToken, result());
  });
  it('心跳延长租约，释放保留已有进度且再次领取换票据', async () => {
    const t = await task(), claim = await service.claim(t.id, 'A'); clock += 800;
    const heartbeat = await service.heartbeat(t.id, claim.leaseToken);
    expect(Date.parse(heartbeat.lease!.expiresAt)).toBe(clock + 1_000);
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result());
    await service.release(t.id, claim.leaseToken);
    const next = await service.claim(t.id, 'B');
    expect(next.leaseToken).not.toBe(claim.leaseToken); expect(next.task.results['VIS-001'].status).toBe('pass');
  });
  it('模板发布不可变版本，任务保留原快照，不要求发布或CDS前置', async () => {
    const first = await service.publishTemplate({ projectId: 'p1', title: '核心功能', cases: [businessCase()] });
    const before = await service.createTask({ projectId: 'p1', templateId: first.id, environment: 'production' });
    const revised = businessCase(); revised.title = '修改后的功能';
    const next = await service.publishTemplate({ projectId: 'p1', templateId: first.id, expectedVersion: 1, title: '核心功能新版', cases: [revised] });
    expect(next.version).toBe(2); expect(service.getTemplate(first.id, 1).cases[0].title).toBe('默认模型生图');
    expect(service.getTask(before.id).templateSnapshot.version).toBe(1);
    expect(service.getTask(before.id).cases[0].title).toBe('默认模型生图');
    await expect(service.publishTemplate({ projectId: 'p1', templateId: first.id, expectedVersion: 1, title: '旧写', cases: [revised] })).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(service.createTask({ projectId: 'p2', templateId: first.id, environment: 'production' })).rejects.toMatchObject({ code: 'template_not_found' });
  });
  it.each([
    ['缺断言', { assertions: [] }], ['假断言', { assertions: [{ id: 'decoded', passed: false, actual: '失败' }] }],
    ['缺证据', { evidence: [] }], ['清理失败', { cleanup: { status: 'fail', details: '残留' } }],
    ['跳过清理', { cleanup: { status: 'not-required', details: '' } }],
  ])('%s 不能回填为通过', async (_label, patch) => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await expect(service.submit(t.id, 'VIS-001', claim.leaseToken, { ...result(), ...patch })).rejects.toMatchObject({ code: 'incomplete_pass' });
    expect(service.getTask(t.id).summary.pass).toBe(0);
  });
  it.each(['file:///tmp/image.png', '/tmp/image.png', 'http://localhost/a', 'https://127.0.0.1/a', 'http://10.2.3.4/a', 'https://user:secret@example.com/a', 'https://[::1]/a'])('本机或带凭据证据不可接受: %s', async (url) => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await expect(service.submit(t.id, 'VIS-001', claim.leaseToken, { ...result(), evidence: [{ kind: 'image', url, caption: '证据' }] })).rejects.toMatchObject({ code: 'invalid_evidence' });
  });
  it('幂等回填不新增尝试，同submissionId不同内容或跨case冲突', async () => {
    const t = await task([businessCase(), businessCase('VIS-002')]), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result());
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result());
    expect(service.getTask(t.id).results['VIS-001'].attempts).toHaveLength(1);
    await expect(service.submit(t.id, 'VIS-001', claim.leaseToken, { ...result(), actual: '不同结果' })).rejects.toMatchObject({ code: 'submission_conflict' });
    await expect(service.submit(t.id, 'VIS-002', claim.leaseToken, result())).rejects.toMatchObject({ code: 'submission_conflict' });
  });
  it('最多一次重试，首败保留且重试通过为flaky，不变成全绿', async () => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result('first', 'fail'));
    const retried = await service.submit(t.id, 'VIS-001', claim.leaseToken, result('retry'));
    expect(retried.results['VIS-001'].attempts.map((a) => a.status)).toEqual(['fail', 'pass']);
    expect(retried.summary).toMatchObject({ pass: 1, flaky: 1, gate: 'fail' });
    await expect(service.submit(t.id, 'VIS-001', claim.leaseToken, result('third', 'fail'))).rejects.toMatchObject({ code: 'retry_exhausted' });
  });
  it('fail/blocked/notrun分开计数，完成后结果不可改，矩阵来自真实回填', async () => {
    const t = await task(['A', 'B', 'C', 'D'].map(businessCase)), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'A', claim.leaseToken, result('a', 'fail'));
    await service.submit(t.id, 'B', claim.leaseToken, result('b', 'blocked'));
    await service.submit(t.id, 'C', claim.leaseToken, result('c', 'not-run'));
    const completed = await service.complete(t.id, claim.leaseToken);
    expect(completed.summary).toEqual({ planned: 4, executed: 1, pass: 0, fail: 1, blocked: 1, notRun: 2, flaky: 0, gate: 'fail' });
    await expect(service.submit(t.id, 'A', claim.leaseToken, result('after'))).rejects.toMatchObject({ code: 'task_not_running' });
    await expect(service.claim(t.id, 'B')).rejects.toMatchObject({ code: 'task_frozen' });
    expect(service.matrix('p1').rows.map((r) => r.cells[0].status)).toEqual(['fail', 'blocked', 'not-run', 'not-run']);
  });
  it('状态落库失败不发成功票据，读取保持待领取，修复后可恢复', async () => {
    const t = await task();
    const flush = vi.spyOn(state, 'flush').mockRejectedValue(new Error('模拟持久层断开'));
    await expect(service.claim(t.id, 'A')).rejects.toMatchObject({ status: 503, code: 'acceptance_storage' });
    expect(service.getTask(t.id).status).toBe('pending'); expect(service.health().persistenceOk).toBe(false);
    flush.mockRestore();
    const claim = await service.claim(t.id, 'B'); expect(claim.task.status).toBe('running'); expect(service.health().ok).toBe(true);
  });
  it('flush完成之前公开读取不会看到尚未落库的领取', async () => {
    const t = await task(); let finish!: () => void;
    const flush = vi.spyOn(state, 'flush').mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const promise = service.claim(t.id, 'A');
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getTask(t.id).status).toBe('pending'); finish(); await promise; flush.mockRestore();
    expect(service.getTask(t.id).status).toBe('running');
  });
  it('重建后可读取模板与执行历史，票据明文未落盘', async () => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result());
    await state.flush();
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(claim.leaseToken);
    const rebuilt = new StateService(path.join(dir, 'state.json')); rebuilt.load();
    const next = new AcceptanceTaskService(rebuilt, { now: () => new Date(clock) });
    expect(next.getTask(t.id).results['VIS-001'].status).toBe('pass'); expect(next.getTemplate(t.templateId).version).toBe(1);
    await rebuilt.flush();
  });
  it('报告只生成canonical源；归档需object存储、同项目同任务且正文一致', async () => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result()); await service.complete(t.id, claim.leaseToken);
    const source = service.reportSource(t.id);
    expect(source.verdict).toBe('pass'); expect(source.verification).toBe('pending'); expect(source.content).toContain('计划 1，执行 1，通过 1');
    expect(source.content).toContain('| 编号 | 重要功能 | 怎么验 | 通过标准 | 结果 | 证据 |');
    const currentCase = service.getTask(t.id).cases[0];
    const scoreRow = source.content.split('\n').find((line) => line.startsWith(`| ${currentCase.caseId} |`))!;
    expect(scoreRow).toContain(currentCase.title);
    expect(scoreRow).toContain(currentCase.steps[0].action);
    expect(scoreRow).toContain(currentCase.assertions[0].description);
    expect(scoreRow).toContain(service.getTask(t.id).results[currentCase.caseId].evidence[0].url);
    expect(state.listAcceptanceReports('p1')).toHaveLength(0);
    const local = await state.createAcceptanceReportAsync({ ...source, projectId: 'p1' });
    await expect(service.bindReport(t.id, local.id)).rejects.toMatchObject({ code: 'report_not_durable' });
    const bucket = new Map<string, Buffer>();
    state.setReportObjectStore(createReportObjectStore({ endpoint: 'https://objects.example.com', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', prefix: 'p' }, {
      upload: async (opts) => { bucket.set(opts.objectKey, opts.body); return { objectKey: opts.objectKey, bytes: opts.body.byteLength, sha256: 'x' }; },
      fetchObject: async (opts) => bucket.get(opts.objectKey) ?? null,
    }));
    const wrong = await state.createAcceptanceReportAsync({ ...source, projectId: 'p2' });
    await expect(service.bindReport(t.id, wrong.id)).rejects.toMatchObject({ code: 'report_mismatch' });
    const changed = await state.createAcceptanceReportAsync({ ...source, projectId: 'p1', content: source.content + '\n篡改' });
    await expect(service.bindReport(t.id, changed.id)).rejects.toMatchObject({ code: 'report_mismatch' });
    const archived = await state.createAcceptanceReportAsync({ ...source, projectId: 'p1' });
    const bound = await service.bindReport(t.id, archived.id);
    expect(bound.report).toEqual({ id: archived.id, url: `/reports?report=${archived.id}`, verification: 'pending' });
    expect((await service.bindReport(t.id, archived.id)).report).toEqual(bound.report);
    await expect(service.bindReport(t.id, changed.id)).rejects.toMatchObject({ code: 'report_conflict' });
  });
  it('报告blocked不伪造产品严重缺陷，失败证据及重试记录保留', async () => {
    const t = await task(), claim = await service.claim(t.id, 'A');
    await service.submit(t.id, 'VIS-001', claim.leaseToken, result('blocked', 'blocked')); await service.complete(t.id, claim.leaseToken);
    expect(service.reportSource(t.id)).toMatchObject({ verdict: 'conditional', defectCounts: { p0: 0, p1: 0 } });
  });
  it('周期收敛真实运行，健康可见且stop停止定时器', async () => {
    const t = await task(); await service.claim(t.id, 'A');
    const reaper = startAcceptanceLeaseReaper(service, { intervalMs: 10 }); clock += 1_001;
    await new Promise((resolve) => setTimeout(resolve, 40)); reaper.stop();
    expect(service.getTask(t.id).status).toBe('pending'); expect(service.health()).toMatchObject({ ok: true, lastReconcileOk: true, expiredLeases: 0 });
    expect(service.health().reaperRunning).toBe(false);
  });
  it('收敛停滞超过三个周期可观察，不把永远pending的持久操作报健康', async () => {
    const reaper = startAcceptanceLeaseReaper(service, { intervalMs: 1_000 });
    await reaper.reapNow(); await new Promise((resolve) => setImmediate(resolve)); clock += 3_001;
    expect(service.health()).toMatchObject({ ok: false, reconcileStale: true, reaperRunning: true });
    reaper.stop();
  });
  it('pending可取消，running必须当前租约，旧持有者不能取消新执行者', async () => {
    const pending = await task();
    expect((await service.cancel(pending.id)).status).toBe('cancelled');
    const active = await task(), first = await service.claim(active.id, 'A');
    await expect(service.cancel(active.id)).rejects.toMatchObject({ code: 'lease_invalid' });
    clock += 1_001;
    const second = await service.claim(active.id, 'B');
    await expect(service.cancel(active.id, first.leaseToken)).rejects.toMatchObject({ code: 'lease_invalid' });
    expect(service.getTask(active.id).lease?.agentName).toBe('B');
    expect((await service.cancel(active.id, second.leaseToken)).status).toBe('cancelled');
  });
  it('矩阵同名caseId按模板分行，不把其他模板结果误判为本行通过', async () => {
    const first = await task(), otherCase = businessCase(); otherCase.title = '另一模板同名用例';
    const second = await task([otherCase]);
    const claim = await service.claim(first.id, 'A');
    await service.submit(first.id, 'VIS-001', claim.leaseToken, result());
    const matrix = service.matrix('p1');
    expect(matrix.rows).toHaveLength(2);
    const firstRow = matrix.rows.find((r) => r.templateId === first.templateId)!;
    const secondRow = matrix.rows.find((r) => r.templateId === second.templateId)!;
    expect(firstRow.cells.find((c) => c.taskId === first.id)).toMatchObject({ applicable: true, status: 'pass' });
    expect(firstRow.cells.find((c) => c.taskId === second.id)).toMatchObject({ applicable: false, status: 'not-run', evidence: [] });
    expect(secondRow.cells.find((c) => c.taskId === first.id)).toMatchObject({ applicable: false, status: 'not-run', evidence: [] });
    expect(secondRow.cells.find((c) => c.taskId === second.id)).toMatchObject({ applicable: true, status: 'not-run' });
  });
  it('矩阵环境筛选与部分case范围保留不适用，而不跨环境借用结果', async () => {
    const common = businessCase('COMMON-001'), production = businessCase('PROD-001'), cds = businessCase('CDS-001');
    production.environments = ['production']; cds.environments = ['cds'];
    const template = await service.publishTemplate({ projectId: 'p1', title: '双环境清单', cases: [common, production, cds] });
    const full = await service.createTask({ projectId: 'p1', templateId: template.id, environment: 'production' });
    const partial = await service.createTask({ projectId: 'p1', templateId: template.id, environment: 'production', caseIds: ['COMMON-001'] });
    const cdsTask = await service.createTask({ projectId: 'p1', templateId: template.id, environment: 'cds' });
    const claim = await service.claim(cdsTask.id, 'A');
    await service.submit(cdsTask.id, 'COMMON-001', claim.leaseToken, result());
    const prodMatrix = service.matrix('p1', template.id, 'production');
    expect(prodMatrix.tasks.map((t) => t.id)).toEqual([full.id, partial.id]);
    expect(prodMatrix.rows.map((r) => r.caseId)).toEqual(['COMMON-001', 'PROD-001']);
    expect(prodMatrix.rows.find((r) => r.caseId === 'PROD-001')!.cells.find((c) => c.taskId === partial.id)).toMatchObject({ applicable: false, status: 'not-run' });
    expect(prodMatrix.rows[0].cells.every((c) => c.status === 'not-run')).toBe(true);
    const all = service.matrix('p1', template.id);
    expect(all.rows.find((r) => r.caseId === 'CDS-001')!.cells.find((c) => c.taskId === full.id)).toMatchObject({ applicable: false, status: 'not-run' });
    expect(service.matrix('p1', template.id, 'cds').rows[0].cells[0]).toMatchObject({ applicable: true, status: 'pass' });
  });
});
