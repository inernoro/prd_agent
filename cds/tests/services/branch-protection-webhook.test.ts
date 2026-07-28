/**
 * GitHub webhook 的主干兜底：`delete` 事件绝不允许自动删掉主干预览。
 *
 * 2026-07-27 P0（CDS 把 main 回收删掉）之后补的第二道闸：
 * GitHub 上删除主干本身是极端事件，但 webhook 误判（ref 实为 tag、分支名匹配错、
 * 仓库刚改过默认分支）同样会走到这条路径，而这条路径会同时停容器 + 删 CDS 分支条目
 * + 删 worktree。主干一律拒绝，只留日志（message 会进 webhook 投递记录的 dispatchReason）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig } from '../../src/types.js';
import { GitHubWebhookDispatcher } from '../../src/services/github-webhook-dispatcher.js';

class MockShell implements IShellExecutor {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

function buildConfig(): CdsConfig {
  return {
    repoRoot: '/tmp/repo',
    worktreeBase: '/tmp/wt',
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'x'.repeat(32), issuer: 'cds' },
    mode: 'standalone',
    executorPort: 9901,
  };
}

describe('GitHub delete webhook —— 主干分支拒绝自动删除', () => {
  let tmp: string;
  let stateService: StateService;
  let dispatcher: GitHubWebhookDispatcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-trunk-webhook-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    const shell = new MockShell();
    dispatcher = new GitHubWebhookDispatcher({
      stateService,
      worktreeService: new WorktreeService(shell),
      shell,
      config: buildConfig(),
    });
    stateService.addProject({
      id: 'p1', slug: 'proj', name: 'Proj', kind: 'git',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo', githubInstallationId: 42,
      gitDefaultBranch: 'main',
    });
    for (const [id, branch] of [['proj-main', 'main'], ['proj-feat', 'feat']] as const) {
      stateService.addBranch({
        id, projectId: 'p1', branch,
        worktreePath: `/tmp/wt/${id}`, services: {}, status: 'running',
        createdAt: new Date().toISOString(),
      });
    }
  });

  it('主干被删时不返回 stopRequest / branchDeleteRequest，只给拒绝理由', async () => {
    const r = await dispatcher.handle('delete', {
      ref: 'main',
      ref_type: 'branch',
      repository: { full_name: 'octocat/repo' },
    });

    expect(r.action).toBe('ignored-event');
    expect(r.branchId).toBe('proj-main');
    expect(r.stopRequest).toBeUndefined();
    expect(r.branchDeleteRequest).toBeUndefined();
    // 拒绝的同时也不写「已放弃」墓碑——我们恰恰在拒绝放弃它
    expect(r.tombstoneRequest).toBeUndefined();
    expect(r.message).toContain('主干');
    expect(r.message).toContain('proj-main');
  });

  it('项目没配 gitDefaultBranch 时，master 同样被拒绝', async () => {
    stateService.updateProject('p1', { gitDefaultBranch: null });
    stateService.addBranch({
      id: 'proj-master', projectId: 'p1', branch: 'master',
      worktreePath: '/tmp/wt/proj-master', services: {}, status: 'running',
      createdAt: new Date().toISOString(),
    });

    const r = await dispatcher.handle('delete', {
      ref: 'master',
      ref_type: 'branch',
      repository: { full_name: 'octocat/repo' },
    });

    expect(r.action).toBe('ignored-event');
    expect(r.branchDeleteRequest).toBeUndefined();
  });

  it('普通分支删除行为不变——保护不能顺手废掉正常清理', async () => {
    const r = await dispatcher.handle('delete', {
      ref: 'feat',
      ref_type: 'branch',
      repository: { full_name: 'octocat/repo' },
    });

    expect(r.action).toBe('branch-deleted');
    expect(r.stopRequest).toEqual({ branchId: 'proj-feat' });
    expect(r.branchDeleteRequest).toEqual({ branchId: 'proj-feat' });
    expect(r.tombstoneRequest).toMatchObject({ branchId: 'proj-feat', reason: 'abandoned' });
  });
});
