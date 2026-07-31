/**
 * scheduled-release-first-run.test.ts —— 定时发布首次跑不该必然失败。
 *
 * 分支来源的规则原先只从**历史发布记录**里取 previewUrl。分支第一次被定时发布时
 * 必然没有历史，而空预览地址会被预检判成阻塞项 —— 于是这条规则的「立即试跑」和
 * 首次真跑都注定失败，非得有人先手动发一次不可（Codex review P2，2026-07-29）。
 *
 * 这里断言的是「预检真的收到了一个非空预览地址」，而不是「某个私有方法返回了什么」：
 * 前者才是这条链路对外的可观测行为。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScheduledJobService, type ScheduledJobReleasePort } from '../../src/services/scheduled-job-service.js';
import type { ReleasePreflightResult, ReleaseStartInput, ReleaseTargetBusyState } from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ScheduledJobTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const COMMIT = 'c'.repeat(40);

function makeRelease(): ScheduledJobReleasePort & { preflightInputs: ReleaseStartInput[] } {
  const preflightInputs: ReleaseStartInput[] = [];
  return {
    preflightInputs,
    isTargetBusy: (): ReleaseTargetBusyState => ({ busy: false }),
    preflight: async (input): Promise<ReleasePreflightResult> => {
      preflightInputs.push(input);
      return { ok: true, checks: [] };
    },
    startRelease: async () => { throw new Error('本用例只跑 check 模式，不该真发'); },
    startRollback: async () => { throw new Error('not used'); },
    getRun: () => undefined,
  };
}

const BRANCH_TARGET: ScheduledJobTarget = {
  type: 'release',
  targetId: 'target-prod',
  source: { kind: 'branch', branchId: 'b1' },
} as never;

describe('分支来源首次定时发布的预览地址', () => {
  let tmpDir: string;
  let stateService: StateService;
  let release: ReturnType<typeof makeRelease>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sched-first-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    stateService.addProject({
      id: 'demo', slug: 'demo', name: 'Demo', kind: 'git',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    stateService.addBranch({
      id: 'b1', projectId: 'demo', branch: 'main', worktreePath: '/tmp/b1', services: {},
      status: 'running', pinnedCommit: COMMIT, createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    stateService.upsertReleaseTarget({
      id: 'target-prod', projectId: 'demo', name: '生产站点', type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
      ssh: {
        host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1',
        appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://prod.test',
      },
    } as never);
    release = makeRelease();
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function boot(config: Record<string, unknown>): ScheduledJobService {
    return new ScheduledJobService({
      stateService,
      shell: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
      config: { masterPort: 9900, repoRoot: tmpDir, ...config },
      release,
      releasePollIntervalMs: 1,
      rollbackRetryIntervalMs: 1,
      sleep: async () => { /* 不真睡 */ },
    });
  }

  it('零历史 + multi 模式：现推一个预览地址给预检，而不是交一个空串', async () => {
    const service = boot({ previewDomain: 'miduo.org' });
    await service.checkTarget(BRANCH_TARGET, 30);
    expect(release.preflightInputs).toHaveLength(1);
    const previewUrl = release.preflightInputs[0].previewUrl || '';
    // 空串会让预检把「可发布产物」判成 blocking fail，规则首跑必然红。
    expect(previewUrl).not.toBe('');
    expect(previewUrl).toContain('miduo.org');
  });

  it('没有配预览域名时如实交空串，由预检给出标准结论', async () => {
    const service = boot({});
    await service.checkTarget(BRANCH_TARGET, 30);
    expect(release.preflightInputs[0].previewUrl || '').toBe('');
  });

  it('port 模式不套 multi 公式：端口是运行期分配的，算出来的子域没人监听', async () => {
    stateService.updateProject('demo', { previewMode: 'port' } as never);
    const service = boot({ previewDomain: 'miduo.org' });
    await service.checkTarget(BRANCH_TARGET, 30);
    expect(release.preflightInputs[0].previewUrl || '').toBe('');
  });

  it('simple 模式同理不猜（主域名 + cookie 切换，不是按分支算的）', async () => {
    stateService.updateProject('demo', { previewMode: 'simple' } as never);
    const service = boot({ previewDomain: 'miduo.org' });
    await service.checkTarget(BRANCH_TARGET, 30);
    expect(release.preflightInputs[0].previewUrl || '').toBe('');
  });

  it('有历史发布记录时优先用历史那个地址（现推只是兜底）', async () => {
    stateService.addReleaseRun({
      releaseId: 'rel_old', projectId: 'demo', branchId: 'b1', commitSha: COMMIT,
      artifact: { type: 'branch-preview', commitSha: COMMIT, branchId: 'b1', branchName: 'main', previewUrl: 'https://historic.example' },
      targetId: 'target-prod', planId: 'demo:ssh-script', status: 'success',
      startedAt: '2026-07-28T00:00:00.000Z', logs: [], seq: 0,
    } as never);
    const service = boot({ previewDomain: 'miduo.org' });
    await service.checkTarget(BRANCH_TARGET, 30);
    expect(release.preflightInputs[0].previewUrl).toBe('https://historic.example');
  });
});
