import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StateService } from '../../src/services/state.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';

/** 仅使用原有公开服务面；同一文件可在旧版运行，失败必须来自行为差异。 */
describe('自动化任务验收契约（旧版与修复版共同执行）', () => {
  let root: string, state: StateService, service: ScheduledJobService;
  let calls: number, server: http.Server | undefined;
  const blocked = async (): Promise<never> => { throw new Error('契约测试禁止真实发布'); };
  const job = (override: Record<string, unknown> = {}) => {
    const now = new Date().toISOString();
    const row = { id: 'contract-job', projectId: 'contract-project', name: '契约验收任务', enabled: true,
      schedule: { type: 'interval', intervalMinutes: 30 }, nextRunAt: now,
      target: { type: 'command', command: 'contract-only' }, timeoutSeconds: 1, retryCount: 0,
      concurrencyPolicy: 'skip', createdAt: now, updatedAt: now, ...override };
    state.upsertScheduledJob(row as any); return row;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-contract-')); calls = 0;
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    // 即使执行器被错误调用，也只计数，不启动命令、Docker 或任何外部服务。
    service = new ScheduledJobService({ stateService: state, config: { masterPort: 9900, repoRoot: root },
      shell: { exec: async () => { calls++; return { stdout: 'contract', stderr: '', exitCode: 0 }; } },
      release: { isTargetBusy: () => ({ busy: false }), preflight: blocked, startRelease: blocked, startRollback: blocked, getRun: () => undefined },
    });
  });
  afterEach(async () => {
    service.stop();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    await state.flush(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
  });
  it('AC01：过期批次不补执行或产生副作用', async () => {
    const row = job({ nextRunAt: new Date(Date.now() - 300_000).toISOString() });
    await service.tick();
    expect(calls, '过期批次的外部调用必须为0').toBe(0);
    expect(state.listScheduledJobRuns({ jobId: row.id })[0]?.status).toBe('failed');
  });
  it('AC02：手动成功不能替空排期任务重启时钟', async () => {
    const row = job({ nextRunAt: null });
    expect(state.getScheduledJob(row.id)!.nextRunAt).toBeNull();
    const run = await service.runJob(row.id, 'manual'); expect(run.status).toBe('success');
    expect(state.getScheduledJob(row.id)!.nextRunAt, '手动运行不得修复定时时钟').toBeNull();
  });
  it('AC03：命令成功但报告不存在时任务不得成功', async () => {
    const row = job({ completion: { type: 'reports', minCount: 1 } });
    const run = await service.runJob(row.id, 'manual');
    expect(calls).toBe(1); expect(state.listAcceptanceReports()).toHaveLength(0);
    expect(run.status, '缺失预期报告不能以退出码0判成功').toBe('failed');
  });
  it('AC04：同一人工幂等请求不得重复执行', async () => {
    const row = job({ schedule: { type: 'manual' }, nextRunAt: null });
    const options = { requestKey: `${Date.now()}:acceptance-contract` };
    const first = await service.runJob(row.id, 'manual', options as any);
    const duplicate = await service.runJob(row.id, 'manual', options as any);
    expect(duplicate.id, '重复请求必须指向原运行').toBe(first.id); expect(calls).toBe(1);
  });
  it('AC04：写依赖返回503也不能自动重放', async () => {
    server = http.createServer((_req, res) => { calls++; res.writeHead(503); res.end('isolated dependency failure'); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const row = job({ target: { type: 'http', method: 'POST', url: `http://127.0.0.1:${(server.address() as any).port}/contract-only` }, retryCount: 2 });
    expect((await service.runJob(row.id, 'manual')).status).toBe('failed');
    expect(calls, '503不能证明副作用未发生，写请求最多一次').toBe(1);
  });
  it('AC04：进程更换后原执行中记录必须转为可追溯失败', async () => {
    const row = job({ nextRunAt: new Date(Date.now() + 60_000).toISOString() });
    state.upsertScheduledJobRun({ id: 'contract-interrupted', jobId: row.id, projectId: row.projectId, trigger: 'schedule', status: 'running', queuedAt: new Date().toISOString() });
    await state.flush(); await service.tick();
    expect(state.listScheduledJobRuns({ jobId: row.id })[0].status, '旧执行不能永远保持running').toBe('failed');
    expect(calls).toBe(0);
  });
  it('AC06：要求持久归档时不能用本地缓存掩盖对象丢失', async () => {
    let content: string | null = null;
    state.setReportObjectStore({ isConfigured: () => true, put: async (_meta, body) => { content = body; return 'contract/object'; }, get: async () => content, remove: async () => {} });
    const report = await state.createAcceptanceReportAsync({ title: '契约报告', format: 'md', projectId: 'contract-project', content: '# valid' });
    expect(await state.readAcceptanceReportContentAsync(report.id)).toBe('# valid');
    content = null;
    expect(await (state.readAcceptanceReportContentAsync as any)(report.id, { requireObjectStorage: true }), '权威对象缺失时必须失败').toBeUndefined();
  });
});
