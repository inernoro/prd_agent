import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StateService } from '../../src/services/state.js';
import { ScheduledJobService, type ScheduledJobReleasePort } from '../../src/services/scheduled-job-service.js';
import { observeScheduledJobs, validateJobReports } from '../../src/services/scheduled-job-health.js';
import { buildOverview, groupKeyOf, taskHealthTone } from '../../web/src/lib/task-schedule-view.js';
import type { ScheduledJob, ScheduledJobRun, IShellExecutor } from '../../src/types.js';

const release: ScheduledJobReleasePort = {
  isTargetBusy: () => ({ busy: false }), preflight: async () => { throw Error('禁止外部发布'); },
  startRelease: async () => { throw Error('禁止外部发布'); }, startRollback: async () => { throw Error('禁止外部发布'); }, getRun: () => undefined,
};
describe('自动化任务健康与安全恢复', () => {
  let dir: string, state: StateService, service: ScheduledJobService;
  let shell: IShellExecutor & { exec: ReturnType<typeof vi.fn> };
  let server: http.Server | undefined;
  const events: Array<{ type: string; data: any }> = [];
  const publish = (type: any, data: any) => { events.push({ type, data }); };
  const makeService = () => new ScheduledJobService({ stateService: state, shell, release, publishEvent: publish, config: { masterPort: 9900, repoRoot: dir } });
  const job = (overrides: Partial<ScheduledJob> = {}) => {
    const row: ScheduledJob = { id: 'report-job', projectId: 'project', name: '定期验收', enabled: true,
      schedule: { type: 'interval', intervalMinutes: 30 }, target: { type: 'command', command: 'generate-report' },
      timeoutSeconds: 1, retryCount: 3, concurrencyPolicy: 'skip', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(), ...overrides };
    state.upsertScheduledJob(row); return row;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-task-health-'));
    state = new StateService(path.join(dir, 'state.json'), dir); state.load(); events.length = 0;
    shell = { exec: vi.fn(async () => ({ stdout: 'done', stderr: '', exitCode: 0 })) };
    service = makeService();
  });
  afterEach(async () => {
    service.stop();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    await state.flush(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const archive = (run: ScheduledJobRun, extra: Record<string, unknown> = {}) => state.createAcceptanceReport({
    title: '隔离验收报告', format: 'md', content: '# 已完成验收\n断言通过', projectId: run.projectId,
    scheduledJobRunId: run.id, verdict: 'pass', ...extra,
  });
  it('区分暂停、未到时间和漏跑；手动成功不能掩盖漏跑', async () => {
    let row = job({ enabled: false, nextRunAt: new Date(Date.now() - 300_000).toISOString() });
    expect(service.health(row).state).toBe('paused'); await service.tick(); expect(shell.exec).not.toHaveBeenCalled();
    row = job({ nextRunAt: new Date(Date.now() + 60_000).toISOString() });
    expect(service.health(row).state).toBe('waiting'); await service.tick(); expect(shell.exec).not.toHaveBeenCalled();
    row = job({ nextRunAt: new Date(Date.now() - 300_000).toISOString() });
    await service.tick(); expect(shell.exec).not.toHaveBeenCalled();
    expect(state.getScheduledJob(row.id)!.lastScheduledRun?.failureKind).toBe('missed');
    const manual = await service.runJob(row.id, 'manual'); expect(manual.status).toBe('success');
    expect(service.health(state.getScheduledJob(row.id)!).state).toBe('missed');
    expect(events.some(e => e.type === 'scheduled-job.unhealthy')).toBe(true);
    const projected = { ...state.getScheduledJob(row.id)!, health: service.health(state.getScheduledJob(row.id)!) };
    expect(groupKeyOf(projected as any, Date.now())).toBe('attention');
    expect(buildOverview([projected as any], [manual] as any, Date.now()).state).toBe('failing');
  });
  it('手动成功和普通编辑都不能替停摆任务重新安排时钟', async () => {
    const row = job({ nextRunAt: null });
    const manual = await service.runJob(row.id, 'manual'); expect(manual.status).toBe('success');
    const current = state.getScheduledJob(row.id)!; expect(current.nextRunAt).toBeNull(); expect(service.health(current).state).toBe('missed');
    expect(service.normalizeJob(current, { preserveNextRunAt: true }).nextRunAt).toBeNull();
  });
  it('启动阶段只核实中断记录，监听就绪前不会提前执行任务', async () => {
    job(); service.start(); await state.flush(); expect(shell.exec).not.toHaveBeenCalled();
    service.stop(); await service.tick(); expect(shell.exec).toHaveBeenCalledTimes(1);
  });
  it('已有存活探测可发现任务循环停摆，并按任务去重告警', () => {
    job({ nextRunAt: new Date(Date.now() - 300_000).toISOString() });
    observeScheduledJobs(state, publish); observeScheduledJobs(state, publish);
    expect(events).toHaveLength(1); expect(events[0].data.failureKind).toBe('missed');
    expect(shell.exec).not.toHaveBeenCalled();
  });
  it('同刻到期的六个长任务先分别认领，不因等待别的任务超过宽限而漏跑', async () => {
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(startedAt);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    shell.exec.mockImplementation(async () => { await completion; return { stdout: 'isolated long job', stderr: '', exitCode: 0 }; });
    for (let i = 0; i < 6; i++) job({ id: `simultaneous-${i}`, schedule: { type: 'interval', intervalMinutes: 60 }, timeoutSeconds: 600 });
    const pending = service.tick();
    try {
      await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledTimes(6), { timeout: 500, interval: 5 });
      await service.tick(); expect(shell.exec).toHaveBeenCalledTimes(6);
      vi.setSystemTime(startedAt + 180_000); finish(); await pending;
      expect(state.listScheduledJobRuns()).toHaveLength(6);
      expect(state.listScheduledJobRuns().every(run => run.status === 'success')).toBe(true);
      expect(events.filter(event => event.data.failureKind === 'missed')).toHaveLength(0);
    } finally {
      vi.setSystemTime(startedAt + 180_000); finish(); await pending; vi.useRealTimers();
    }
  });
  it('并发跳过认领并推进当前批次，原执行结束后不补跑已跳过的批次', async () => {
    const startedAt = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(startedAt);
    let finish!: () => void; const completion = new Promise<void>(resolve => { finish = resolve; });
    shell.exec.mockImplementationOnce(async () => { await completion; return { stdout: 'first', stderr: '', exitCode: 0 }; });
    const row = job({ schedule: { type: 'interval', intervalMinutes: 1 }, timeoutSeconds: 600 });
    const first = service.tick(new Date(startedAt));
    try {
      await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledTimes(1));
      vi.setSystemTime(startedAt + 60_000); await service.tick(new Date());
      const skipped = state.listScheduledJobRuns({ jobId: row.id }).find(run => run.status === 'skipped')!;
      expect(skipped).toMatchObject({ scheduledFor: new Date(startedAt + 60_000).toISOString(), requestKey: `schedule:${new Date(startedAt + 60_000).toISOString()}` });
      expect(state.getScheduledJob(row.id)!.nextRunAt).toBe(new Date(startedAt + 120_000).toISOString());
      expect((await service.runJob(row.id, 'schedule', { scheduledFor: skipped.scheduledFor })).id).toBe(skipped.id);
      vi.setSystemTime(startedAt + 90_000); finish(); await first; await service.tick(new Date());
      expect(shell.exec).toHaveBeenCalledTimes(1);
      vi.setSystemTime(startedAt + 120_000); await service.tick(new Date()); expect(shell.exec).toHaveBeenCalledTimes(2);
      expect(events.filter(event => event.data.failureKind === 'missed')).toHaveLength(0);
    } finally { finish(); await first; vi.useRealTimers(); }
  });
  it('在途占用超过宽限仍是并发跳过，不误报漏跑且保留原执行失败', async () => {
    const startedAt = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(startedAt);
    let finish!: () => void; const completion = new Promise<void>(resolve => { finish = resolve; });
    shell.exec.mockImplementation(async () => { await completion; return { stdout: '', stderr: 'isolated failure', exitCode: 1 }; });
    const row = job({ schedule: { type: 'interval', intervalMinutes: 1 }, timeoutSeconds: 600 });
    const first = service.tick(new Date());
    try {
      await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledTimes(1));
      const activeId = state.listScheduledJobRuns({ jobId: row.id })[0].id;
      vi.setSystemTime(startedAt + 60_000); await service.tick(new Date());
      vi.setSystemTime(startedAt + 300_000); await service.tick(new Date());
      expect(state.getScheduledJob(row.id)!.nextRunAt).toBe(new Date(startedAt + 360_000).toISOString());
      expect(state.listScheduledJobRuns({ jobId: row.id }).filter(run => run.status === 'skipped')).toHaveLength(2);
      expect(events).toHaveLength(0); finish(); await first;
      expect(state.getScheduledJob(row.id)!.lastScheduledRun).toMatchObject({ id: activeId, status: 'failed', failureKind: 'execution' });
      expect(service.health(state.getScheduledJob(row.id)!).state).toBe('execution'); expect(shell.exec).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.data.failureKind === 'missed')).toHaveLength(0);
    } finally { finish(); await first; vi.useRealTimers(); }
  });
  it('启动首次落盘阻塞时也已封锁全部中断任务，后续任务人工请求不能重复调用', async () => {
    for (const id of ['first-interrupted', 'later-interrupted']) {
      const row = job({ id, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() });
      state.upsertScheduledJobRun({ id: `${id}-run`, jobId: row.id, projectId: row.projectId, trigger: 'schedule', status: 'running', queuedAt: new Date().toISOString() });
    }
    await state.flush();
    let releaseFlush!: () => void; const receipt = new Promise<void>(resolve => { releaseFlush = resolve; });
    const originalFlush = state.flush.bind(state); let firstFlush = true;
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      if (firstFlush) { firstFlush = false; await receipt; }
      await originalFlush();
    });
    service.start();
    try {
      const result = await service.runJob('later-interrupted', 'manual').then(run => ({ run, error: undefined }), error => ({ run: undefined, error }));
      expect(shell.exec).not.toHaveBeenCalled(); expect(result.error?.message).toContain('结果未知');
      for (const id of ['first-interrupted', 'later-interrupted']) expect(state.getScheduledJob(id)!.recoveryRequiredRunId).toBe(`${id}-run`);
    } finally { releaseFlush(); service.stop(); await service.tick(); await state.flush(); }
  });
  it('push 发布失败进入红色健康与原告警，手动成功和历史裁剪不能掩盖', async () => {
    const commitSha = 'a'.repeat(40);
    state.addBranch({ id: 'isolated-branch', projectId: 'project', branch: 'main', worktreePath: dir, services: {}, status: 'running', pinnedCommit: commitSha, createdAt: new Date().toISOString() } as any);
    state.upsertReleaseTarget({ id: 'isolated-target', projectId: 'project', name: '隔离发布目标', type: 'ssh', isEnabled: true, createdAt: new Date().toISOString() } as any);
    let terminal: any = { releaseId: 'isolated-release-failed', projectId: 'project', branchId: 'isolated-branch', targetId: 'isolated-target', commitSha, status: 'failed', errorMessage: '隔离依赖失败' };
    const startRelease = vi.fn(async () => terminal);
    const withRelease = () => new ScheduledJobService({ stateService: state, shell, release: { ...release, startRelease, getRun: () => terminal }, publishEvent: publish, config: { masterPort: 9900, repoRoot: dir } });
    service = withRelease();
    const row = job({ schedule: { type: 'push', event: 'push', branchPattern: 'main' }, nextRunAt: null, timeoutSeconds: 60,
      target: { type: 'release', targetId: 'isolated-target', source: { kind: 'branch', branchId: 'isolated-branch' } } });
    const failed = await service.runJob(row.id, 'push', { overrideBranchId: 'isolated-branch', overrideCommitSha: commitSha });
    expect(failed.failureKind).toBe('execution'); expect(state.getScheduledJob(row.id)!.recoveryRequiredRunId).toBeUndefined();
    const current = state.getScheduledJob(row.id)!;
    expect(service.health(current).state).toBe('execution');
    expect(taskHealthTone({ ...current, health: service.health(current) } as any)).toBe('bg-bad');
    expect(events.filter(event => event.type === 'scheduled-job.unhealthy')).toHaveLength(1);
    terminal = { ...terminal, releaseId: 'isolated-manual-success', status: 'success' };
    expect((await service.runJob(row.id, 'manual')).status).toBe('success');
    expect(service.health(state.getScheduledJob(row.id)!).state).toBe('execution');
    (state.getState() as any).scheduledJobRuns = [];
    state.upsertScheduledJob(state.getScheduledJob(row.id)!); await state.flush();
    state = new StateService(path.join(dir, 'state.json'), dir); state.load(); service = withRelease();
    expect(state.listScheduledJobRuns({ jobId: row.id })).toHaveLength(0);
    expect(service.health(state.getScheduledJob(row.id)!).state).toBe('execution');
    observeScheduledJobs(state, publish); expect(events.filter(event => event.type === 'scheduled-job.unhealthy')).toHaveLength(1);
    const nextCommit = 'b'.repeat(40);
    state.getBranch('isolated-branch')!.pinnedCommit = nextCommit;
    terminal = { ...terminal, releaseId: 'isolated-later-push', commitSha: nextCommit, status: 'success' };
    expect((await service.runJob(row.id, 'push', { overrideBranchId: 'isolated-branch', overrideCommitSha: nextCommit })).status).toBe('success');
    expect(service.health(state.getScheduledJob(row.id)!).state).toBe('event-driven');
    observeScheduledJobs(state, publish); expect(state.getScheduledJob(row.id)!.healthAlertKey).toBeUndefined();
    expect(startRelease).toHaveBeenCalledTimes(3);
  });
  it('恢复旧 push 的已有报告不能把较新 push 的执行失败变绿', async () => {
    const row = job({ schedule: { type: 'push', event: 'push', branchPattern: 'main' }, nextRunAt: null });
    const old: ScheduledJobRun = { id: 'older-push', jobId: row.id, projectId: row.projectId, trigger: 'push', status: 'failed', failureKind: 'artifact-invalid', phase: 'validating', queuedAt: new Date(Date.now() - 10_000).toISOString(), completion: { type: 'reports', minCount: 1 } };
    const latest: ScheduledJobRun = { id: 'latest-push', jobId: row.id, projectId: row.projectId, trigger: 'push', status: 'failed', failureKind: 'execution', queuedAt: new Date().toISOString() };
    state.upsertScheduledJobRun(old); state.upsertScheduledJobRun(latest); archive(old);
    expect((await service.recoverRun(row.id, old.id)).status).toBe('success');
    expect(service.health(state.getScheduledJob(row.id)!)).toMatchObject({ state: 'execution', runId: latest.id });
    expect(shell.exec).not.toHaveBeenCalled();
  });
  it('并发重复触发同一应执行批次只调用一次，历史裁剪后仍保留批次凭据', async () => {
    const row = job(); let finish!: () => void;
    shell.exec.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ stdout: 'paid once', stderr: '', exitCode: 0 }); }));
    const first = service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    const duplicate = service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledTimes(1)); finish();
    const [a, b] = await Promise.all([first, duplicate]); expect(a.id).toBe(b.id);
    (state.getState() as any).scheduledJobRuns = [];
    expect((await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! })).id).toBe(a.id);
    expect(shell.exec).toHaveBeenCalledTimes(1);
  });
  it('手动幂等结果跨重新加载保留；旧请求拒绝重放', async () => {
    const row = job({ schedule: { type: 'manual' } });
    const stamp = Date.now(); const key = `${stamp}:fixture-request-one`;
    const first = await service.runJob(row.id, 'manual', { requestKey: key }); await state.flush();
    state = new StateService(path.join(dir, 'state.json'), dir); state.load(); service = makeService();
    expect((await service.runJob(row.id, 'manual', { requestKey: key })).id).toBe(first.id);
    await service.runJob(row.id, 'manual', { requestKey: `${stamp + 1}:fixture-request-two` });
    await expect(service.runJob(row.id, 'manual', { requestKey: key })).rejects.toThrow('过期');
    expect(shell.exec).toHaveBeenCalledTimes(2);
  });
  it('重复 push 版本在运行史裁剪后也不重放', async () => {
    const row = job({ schedule: { type: 'push', event: 'push', branchPattern: 'main' } });
    const options = { overrideBranchId: 'branch', overrideCommitSha: 'a'.repeat(40), requestKey: 'push:branch:commit' };
    await service.runJob(row.id, 'push', options);
    (state.getState() as any).scheduledJobRuns = [];
    expect((await service.runJob(row.id, 'push', options)).status).toBe('skipped');
    expect(shell.exec).toHaveBeenCalledTimes(1);
  });
  it('执行器忽略超时选项时，硬期限仍能发现故障并阻断后续动作', async () => {
    const row = job({ actions: [{ id: 'a', type: 'command', command: 'hang' }, { id: 'b', type: 'command', command: 'publish' }] });
    shell.exec.mockImplementation(() => new Promise(() => {}));
    const run = await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    expect(run.failureKind).toBe('timeout'); expect(run.steps?.[1].status).toBe('not-run');
    expect(shell.exec).toHaveBeenCalledTimes(1);
  });
  it('部分产物不能掩盖多动作执行中断', async () => {
    const row = job();
    const run: ScheduledJobRun = { id: 'partial', jobId: row.id, projectId: row.projectId, trigger: 'schedule', status: 'failed', phase: 'executing', actionCount: 2, queuedAt: new Date().toISOString(), completion: { type: 'reports', minCount: 1 } };
    state.upsertScheduledJobRun(run); archive(run);
    await expect(service.recoverRun(row.id, run.id)).rejects.toThrow('全部执行完成'); expect(shell.exec).not.toHaveBeenCalled();
  });
  it('持久化屏障失败时不执行上游动作', async () => {
    const row = job(); vi.spyOn(state, 'flush').mockRejectedValueOnce(Error('disk unavailable'));
    const run = await service.runJob(row.id, 'manual'); expect(run.status).toBe('failed'); expect(shell.exec).not.toHaveBeenCalled();
  });
  it('执行成功后仍等待真实报告归档，验证正文并留下哈希凭据', async () => {
    const row = job({ timeoutSeconds: 3, completion: { type: 'reports', minCount: 1, allowedVerdicts: ['pass'] } });
    const pending = service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    await vi.waitFor(() => expect(state.listScheduledJobRuns()[0]?.phase).toBe('validating'));
    const active = state.listScheduledJobRuns()[0]; expect(active.status).toBe('running');
    const meta = archive(active); const done = await pending;
    expect(done.status).toBe('success'); expect(done.artifacts?.[0]).toMatchObject({ reportId: meta.id, sizeBytes: meta.sizeBytes });
    expect(done.artifacts?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('HTTP/命令成功但无报告则失败；迟到产物只验证恢复，不再调用生成器', async () => {
    const row = job({ completion: { type: 'reports', minCount: 1 } });
    const failed = await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    expect(failed.failureKind).toBe('artifact-invalid'); expect(service.health(state.getScheduledJob(row.id)!).state).toBe('artifact-invalid');
    await expect(service.runJob(row.id, 'manual')).rejects.toThrow('结果未知');
    archive(failed); const recovered = await service.recoverRun(row.id, failed.id);
    expect(recovered.status).toBe('success'); expect(shell.exec).toHaveBeenCalledTimes(1);
    expect(state.getScheduledJob(row.id)!.recoveryRequiredRunId).toBeUndefined();
  });
  it('恢复后仍保留原失败种类、原因和时间，不能抹掉故障记录', async () => {
    const row = job({ completion: { type: 'reports', minCount: 1 } });
    const failed = await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    const original = { failureKind: failed.failureKind, error: failed.error, failedAt: failed.finishedAt };
    archive(failed);
    const recovered = await service.recoverRun(row.id, failed.id);
    expect(recovered.status).toBe('success');
    expect(recovered.recovery).toMatchObject(original);
    expect(recovered.recovery!.verifiedAt).toEqual(expect.any(String));
    expect(state.getScheduledJob(row.id)!.lastScheduledRun).toMatchObject({ recovery: original });
    await state.flush();
    const reloaded = new StateService(path.join(dir, 'state.json'), dir); reloaded.load();
    expect(reloaded.listScheduledJobRuns({ jobId: row.id })[0].recovery).toMatchObject(original);
  });
  it('漏跑不能凭人工补报告标记为定时成功', async () => {
    const row = job({ nextRunAt: new Date(Date.now() - 300_000).toISOString(), completion: { type: 'reports', minCount: 1 } });
    await service.tick(); const missed = state.listScheduledJobRuns({ jobId: row.id })[0];
    archive(missed);
    await expect(service.recoverRun(row.id, missed.id)).rejects.toThrow('漏跑');
    expect(service.health(state.getScheduledJob(row.id)!).state).toBe('missed');
    expect(shell.exec).not.toHaveBeenCalled();
  });
  it('拒绝旧运行、跨项目、缺正文、空正文、不合格验收与非持久归档产物', async () => {
    const run: ScheduledJobRun = { id: 'sjr_fixture', jobId: 'report-job', projectId: 'project', trigger: 'schedule', status: 'running', queuedAt: new Date().toISOString(), completion: { type: 'reports', minCount: 1, allowedVerdicts: ['pass'] } };
    archive(run, { scheduledJobRunId: 'old-run' }); archive(run, { projectId: 'other' });
    await expect(validateJobReports(state, run)).rejects.toThrow('已归档 0');
    const bad = archive(run, { verdict: 'fail' }); await expect(validateJobReports(state, run)).rejects.toThrow('验收结论');
    state.updateAcceptanceReport(bad.id, { verdict: 'pass', content: '' }); await expect(validateJobReports(state, run)).rejects.toThrow('正文');
    state.updateAcceptanceReport(bad.id, { content: 'valid' }); fs.unlinkSync(path.join(state.getReportsBase(), `${bad.id}.md`));
    await expect(validateJobReports(state, run)).rejects.toThrow('正文');
    state.updateAcceptanceReport(bad.id, { content: 'valid' }); run.completion!.requireObjectStorage = true;
    await expect(validateJobReports(state, run)).rejects.toThrow('对象存储');
  });
  it('本地缓存仍在也不能掩盖权威归档对象丢失', async () => {
    let body: string | null = null;
    state.setReportObjectStore({ isConfigured: () => true, put: async (_meta, content) => { body = content; return 'fixture/object'; }, get: async () => body, remove: async () => {} });
    const run: ScheduledJobRun = { id: 'object-run', jobId: 'report-job', projectId: 'project', trigger: 'schedule', status: 'running', queuedAt: new Date().toISOString(), completion: { type: 'reports', minCount: 1, requireObjectStorage: true } };
    await state.createAcceptanceReportAsync({ title: '持久报告', format: 'md', content: '# valid', projectId: run.projectId, scheduledJobRunId: run.id });
    expect((await validateJobReports(state, run))).toHaveLength(1);
    body = null; await expect(validateJobReports(state, run)).rejects.toThrow('正文');
  });
  it('重启发现执行中断，不重放；只验证已关联的报告', async () => {
    const row = job({ nextRunAt: new Date(Date.now() + 60_000).toISOString() });
    const run: ScheduledJobRun = { id: 'sjr_crashed', jobId: row.id, projectId: row.projectId, trigger: 'schedule', status: 'running', queuedAt: new Date().toISOString(), scheduledFor: new Date().toISOString(), completion: { type: 'reports', minCount: 1 } };
    state.upsertScheduledJobRun(run); await state.flush();
    state = new StateService(path.join(dir, 'state.json'), dir); state.load(); service = makeService();
    await service.tick(); expect(service.health(state.getScheduledJob(row.id)!).state).toBe('interrupted');
    archive(run); await service.recoverRun(row.id, run.id); expect(shell.exec).not.toHaveBeenCalled();
  });
  it('外部依赖失败与超时分开记录；写请求不重试且重复触发不增加付费调用', async () => {
    let calls = 0;
    server = http.createServer((req, res) => { calls++; if (req.url === '/hang') return; res.writeHead(503); res.end('dependency unavailable'); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    let row = job({ target: { type: 'http', method: 'POST', url: `${base}/paid` } });
    const failed = await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    expect(failed.failureKind).toBe('execution'); expect(failed.log).toContain('dependency unavailable'); expect(calls).toBe(1);
    await expect(service.runJob(row.id, 'manual')).rejects.toThrow('结果未知'); expect(calls).toBe(1);
    row = job({ id: 'timeout', target: { type: 'http', method: 'POST', url: `${base}/hang` } });
    const timed = await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! });
    expect(timed.failureKind).toBe('timeout'); expect(calls).toBe(2);
    await service.runJob(row.id, 'schedule', { scheduledFor: row.nextRunAt! }); expect(calls).toBe(2);
  });
});
