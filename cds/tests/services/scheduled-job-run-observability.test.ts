import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';
import type { Project, ScheduledJob, ScheduledJobRun } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

/*
 * 任务调度页要画「运行流里的动作链缩略」「详情里每步耗时」「24 小时轴」，
 * 依赖三件此前不存在的东西。这三条守卫就是为它们设的 —— 把对应实现改回去，
 * 用例必须变红（见每条用例头部注释里的红绿闭环说明）。
 */
describe('定时任务运行记录的可观测性', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let service: ScheduledJobService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-run-observability-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const project: Project = {
      id: 'demo',
      slug: 'demo',
      name: 'Demo',
      kind: 'git',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    stateService.addProject(project);
    shell = new MockShellExecutor();
    service = new ScheduledJobService({
      stateService,
      shell,
      config: { masterPort: 9900, repoRoot: tmpDir },
      release: {
        isTargetBusy: () => ({ busy: false }),
        preflight: async () => { throw new Error('本套件不应触发发布前检查'); },
        startRelease: async () => { throw new Error('本套件不应触发发布'); },
        startRollback: async () => { throw new Error('本套件不应触发回滚'); },
        getRun: () => undefined,
      },
    });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const commandJob = (id: string, commands: string[]): ScheduledJob => service.normalizeJob({
    id,
    projectId: 'demo',
    name: id,
    enabled: true,
    schedule: { type: 'manual' },
    actions: commands.map((command, index) => ({
      id: `a${index + 1}`,
      name: `第 ${index + 1} 步`,
      type: 'command' as const,
      command,
    })),
  } as unknown as ScheduledJob);

  /*
   * 红绿闭环：把 executeActions 里写 steps 的那几行去掉（或把 run.steps 的赋值删掉），
   * 本用例第一条 expect 就会红——run.steps 变成 undefined。
   */
  it('逐个动作各留一条结果，失败之后的动作记成 not-run', async () => {
    shell.addResponsePattern(/step-ok/, () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/step-bad/, () => ({ stdout: '', stderr: 'boom\n', exitCode: 1 }));
    shell.addResponsePattern(/step-never/, () => ({ stdout: 'never\n', stderr: '', exitCode: 0 }));

    const job = commandJob('job_steps', ['echo step-ok', 'echo step-bad', 'echo step-never']);
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.steps).toBeDefined();
    expect(run.steps).toHaveLength(3);
    expect(run.steps!.map((s) => s.status)).toEqual(['success', 'failed', 'not-run']);
    expect(run.steps!.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(run.steps!.map((s) => s.name)).toEqual(['第 1 步', '第 2 步', '第 3 步']);
    expect(run.steps![0].type).toBe('command');
    // 成功那步要有耗时，没跑的那步不该凭空有耗时。
    expect(typeof run.steps![0].durationMs).toBe('number');
    expect(run.steps![2].durationMs).toBeUndefined();
    expect(run.steps![1].exitCode).toBe(1);
    expect(run.status).toBe('failed');
  });

  /*
   * 红绿闭环：把 upsertScheduledJobRun 的保留策略改回全局 .slice(0, 1000)，
   * 本用例会红——日任务的历史会被高频任务挤光。
   */
  it('运行记录按任务各自保留，高频任务挤不掉低频任务的历史', () => {
    const mkRun = (jobId: string, i: number): ScheduledJobRun => ({
      id: `${jobId}_${i}`,
      jobId,
      projectId: 'demo',
      trigger: 'schedule',
      status: 'success',
      // 高频任务全部比日任务新，全局环形缓冲下会把日任务整段挤掉。
      queuedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, 0) + i * 1000).toISOString(),
    });

    // 日任务先写 5 条（时间更早）
    for (let i = 0; i < 5; i += 1) {
      stateService.upsertScheduledJobRun({
        ...mkRun('job_daily', i),
        queuedAt: new Date(Date.UTC(2026, 0, 1, i, 0, 0)).toISOString(),
      });
    }
    // 高频任务再写 3000 条（时间更新）
    for (let i = 0; i < 3000; i += 1) {
      stateService.upsertScheduledJobRun(mkRun('job_hot', i));
    }

    const daily = stateService.listScheduledJobRuns({ jobId: 'job_daily', limit: 500 });
    const hot = stateService.listScheduledJobRuns({ jobId: 'job_hot', limit: 500 });

    expect(daily).toHaveLength(5);
    // 高频任务自己被截到每任务上限，而不是把别人挤掉。
    expect(hot.length).toBeLessThanOrEqual(120);
    expect(hot.length).toBeGreaterThan(0);
  });

  /*
   * 红绿闭环：删掉 computeNextRuns，或让它每轮不推进游标，
   * 本用例会红（前者编译不过，后者返回一串相同时刻）。
   */
  it('往后推算的触发序列严格递增，且与单次 computeNextRunAt 同源', () => {
    const from = new Date('2026-03-01T00:00:00.000Z');

    const interval = service.computeNextRuns({ type: 'interval', intervalMinutes: 30 }, 4, from);
    expect(interval).toHaveLength(4);
    const asMs = interval.map((iso) => Date.parse(iso));
    expect(asMs.every((v, i) => i === 0 || v > asMs[i - 1])).toBe(true);
    // 第一个时刻必须与既有的单次判定一致 —— 序列不另起一套到期逻辑。
    expect(interval[0]).toBe(service.computeNextRunAt({ type: 'interval', intervalMinutes: 30 }, from));

    const daily = service.computeNextRuns(
      { type: 'daily', timeOfDay: '03:00', timezone: 'UTC' },
      3,
      from,
    );
    expect(daily).toHaveLength(3);
    const dailyMs = daily.map((iso) => Date.parse(iso));
    expect(dailyMs.every((v, i) => i === 0 || v > dailyMs[i - 1])).toBe(true);

    // 手动任务没有下一次，序列必须是空的，不能编一个出来。
    expect(service.computeNextRuns({ type: 'manual' }, 5, from)).toEqual([]);
  });
});
