import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';
import type { Project, ScheduledJob } from '../../src/types.js';

describe('ScheduledJobService', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let service: ScheduledJobService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-scheduled-job-'));
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
    });
  });

  afterEach(() => {
    delete process.env.CDS_TASK_SANDBOX_IMAGE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs a command job and persists run history', async () => {
    shell.addResponsePattern(/docker run[\s\S]*echo sync-ok/, () => ({ stdout: 'sync-ok\n', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_1',
      projectId: 'demo',
      name: '同步统计',
      enabled: true,
      schedule: { type: 'daily', timeOfDay: '02:00', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'echo sync-ok' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('success');
    expect(run.log).toContain('sync-ok');
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]).toContain('docker run --rm');
    expect(shell.commands[0]).toContain('alpine:3');
    expect(shell.commands[0]).toContain(path.join('.cds', 'task-sandboxes', 'job_1', 'work'));
    expect(shell.commands[0]).toContain(':/workspace:rw');
    expect(shell.commands[0]).toContain('-w /workspace');
    expect(shell.cwds[0]).toBeUndefined();
    const runs = stateService.listScheduledJobRuns({ jobId: job.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    const updated = stateService.getScheduledJob(job.id);
    expect(updated?.lastRunStatus).toBe('success');
    expect(updated?.nextRunAt).toMatch(/T/);
  });

  it('runs multiple actions in order and stores one combined run log', async () => {
    shell.addResponsePattern(/docker run[\s\S]*echo clean-ok/, () => ({ stdout: 'clean-ok\n', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_multi',
      projectId: 'demo',
      name: '多动作任务',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      actions: [
        { id: 'pull', name: '拉取旧后台数据', type: 'command', command: 'echo pull-ok' },
        { id: 'clean', name: '清洗入库', type: 'command', command: 'echo clean-ok' },
      ],
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    shell.addResponsePattern(/docker run[\s\S]*echo pull-ok/, () => ({ stdout: 'pull-ok\n', stderr: '', exitCode: 0 }));
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('success');
    expect(shell.commands).toHaveLength(2);
    expect(run.log).toContain('[1/2] 拉取旧后台数据');
    expect(run.log).toContain('[2/2] 清洗入库');
    expect(run.log).toContain('pull-ok');
    expect(run.log).toContain('clean-ok');
  });

  it('stops later actions when an earlier action fails', async () => {
    shell.addResponsePattern(/docker run[\s\S]*exit 7/, () => ({ stdout: '', stderr: 'pull failed\n', exitCode: 7 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_multi_fail',
      projectId: 'demo',
      name: '失败停止',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      actions: [
        { id: 'pull', name: '拉取旧后台数据', type: 'command', command: 'exit 7' },
        { id: 'clean', name: '清洗入库', type: 'command', command: 'echo should-not-run' },
      ],
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('拉取旧后台数据');
    expect(shell.commands).toHaveLength(1);
    expect(run.log).not.toContain('清洗入库');
  });

  it('retries a failed action according to retryCount before continuing', async () => {
    let attempts = 0;
    shell.addResponsePattern(/docker run[\s\S]*flaky/, () => {
      attempts += 1;
      return attempts === 1
        ? { stdout: '', stderr: 'temporary failure\n', exitCode: 1 }
        : { stdout: 'recovered\n', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/docker run[\s\S]*after-retry/, () => ({ stdout: 'after-ok\n', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_retry',
      projectId: 'demo',
      name: '重试任务',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      actions: [
        { id: 'flaky', name: '临时失败动作', type: 'command', command: 'flaky' },
        { id: 'next', name: '后续动作', type: 'command', command: 'after-retry' },
      ],
      timeoutSeconds: 30,
      retryCount: 1,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('success');
    expect(attempts).toBe(2);
    expect(shell.commands).toHaveLength(3);
    expect(run.log).toContain('尝试 1/2');
    expect(run.log).toContain('尝试 2/2');
    expect(run.log).toContain('recovered');
    expect(run.log).toContain('after-ok');
  });

  it('skips a due scheduled job when it is already running', async () => {
    shell.addResponsePattern(/docker run[\s\S]*slow/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_2',
      projectId: 'demo',
      name: '慢任务',
      enabled: true,
      schedule: { type: 'interval', intervalMinutes: 1, timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'slow' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob({ ...job, nextRunAt: '2026-01-01T00:00:00.000Z' });

    const first = service.runJob(job.id, 'manual');
    const skipped = await service.runJob(job.id, 'schedule');
    await first;

    expect(skipped.status).toBe('skipped');
    expect(skipped.log).toContain('并发策略跳过');
  });

  it('checks a command target without creating run history', async () => {
    shell.addResponsePattern(/docker run[\s\S]*echo check-ok/, () => ({ stdout: 'check-ok\n', stderr: '', exitCode: 0 }));

    const result = await service.checkTarget({ type: 'command', command: 'echo check-ok' }, 30);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain('check-ok');
    expect(shell.commands[0]).toContain(path.join('.cds', 'task-sandboxes', 'check-'));
    expect(shell.commands[0]).toContain(':/workspace:rw');
    expect(stateService.listScheduledJobRuns()).toHaveLength(0);
  });

  it('reports failed command target checks', async () => {
    shell.addResponsePattern(/docker run[\s\S]*exit 2/, () => ({ stdout: '', stderr: 'failed\n', exitCode: 2 }));

    const result = await service.checkTarget({ type: 'command', command: 'exit 2' }, 30);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('退出码 2');
    expect(result.log).toContain('failed');
  });

  it('runs command targets from a relative directory inside the sandbox', async () => {
    shell.addResponsePattern(/docker run[\s\S]*pwd/, () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_relative_cwd',
      projectId: 'demo',
      name: '相对目录',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'pwd', cwd: 'nested/work' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    await service.runJob(job.id, 'manual');

    const expectedCwd = fs.realpathSync.native(path.join(tmpDir, '.cds', 'task-sandboxes', 'job_relative_cwd', 'work', 'nested', 'work'));
    expect(fs.existsSync(expectedCwd)).toBe(true);
    expect(shell.commands[0]).toContain(`${fs.realpathSync.native(path.join(tmpDir, '.cds', 'task-sandboxes', 'job_relative_cwd', 'work'))}:/workspace:rw`);
    expect(shell.commands[0]).toContain("-w /workspace/nested/work");
  });

  it('fails command targets that request an absolute cwd', async () => {
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_abs_cwd',
      projectId: 'demo',
      name: '绝对目录',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'pwd', cwd: '/tmp' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('相对路径');
    expect(shell.commands).toHaveLength(0);
  });

  it('fails command targets that try to traverse outside the sandbox', async () => {
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_traverse_cwd',
      projectId: 'demo',
      name: '跳出目录',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'pwd', cwd: '../outside' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('不能跳出 sandbox');
    expect(shell.commands).toHaveLength(0);
  });

  it('fails command targets when cwd is a symlink escaping the sandbox', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    const sandboxWork = path.join(tmpDir, '.cds', 'task-sandboxes', 'job_symlink_cwd', 'work');
    fs.mkdirSync(sandboxWork, { recursive: true });
    fs.symlinkSync(outside, path.join(sandboxWork, 'escape'), 'dir');
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_symlink_cwd',
      projectId: 'demo',
      name: '符号链接',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'pwd', cwd: 'escape' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('符号链接跳出 sandbox');
    expect(shell.commands).toHaveLength(0);
  });

  it('wraps destructive absolute-path commands inside the docker sandbox', async () => {
    shell.addResponsePattern(/docker run[\s\S]*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const job: ScheduledJob = service.normalizeJob({
      id: 'job_destructive',
      projectId: 'demo',
      name: '危险命令',
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command: 'rm -rf /tmp/outside-file' },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    stateService.upsertScheduledJob(job);

    const run = await service.runJob(job.id, 'manual');

    expect(run.status).toBe('success');
    expect(shell.commands[0]).toContain('docker run --rm');
    expect(shell.commands[0]).toContain("sh -lc 'rm -rf /tmp/outside-file'");
    expect(shell.cwds[0]).toBeUndefined();
  });

  it('allows overriding the sandbox image by environment variable', async () => {
    process.env.CDS_TASK_SANDBOX_IMAGE = 'node:20-alpine';
    shell.addResponsePattern(/docker run[\s\S]*/, () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
    const result = await service.checkTarget({ type: 'command', command: 'node -v' }, 30);

    expect(result.ok).toBe(true);
    expect(shell.commands[0]).toContain('node:20-alpine');
  });
});
