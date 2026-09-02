/**
 * 一仓多项目的 push 分发。
 *
 * 这条链路此前只认第一个项目——判据是「取第一个」，语义却是「全部」，于是同一个
 * 仓库下第二个及以后的项目永远收不到 push，只能手动建分支手动部署。本文件钉住
 * 修好之后的四件事：
 *
 *   1. 同仓库多个项目都要被处理，各自建自己的分支；
 *   2. 每个项目各自出一条 deployRequest，主结果之外的挂在 fanout 上（路由要靠它
 *      派发第二个项目的部署，少了就是「建了分支没人部署」）；
 *   3. 项目级作用域能挡掉与本项目无关的改动，且**不建分支**；
 *   4. 单项目仓库的行为与启用前逐字节一致（不出现 fanout 字段）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig, BuildProfile } from '../../src/types.js';
import {
  GitHubWebhookDispatcher,
  mergePushResults,
  type WebhookDispatchResult,
} from '../../src/services/github-webhook-dispatcher.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

class MockShell implements IShellExecutor {
  async exec() { return { stdout: '', stderr: '', exitCode: 0 }; }
}

class MockWorktree extends WorktreeService {
  createdWorktrees: Array<{ branch: string; targetDir: string }> = [];
  override async create(_repoRoot: string, branch: string, targetDir: string) {
    this.createdWorktrees.push({ branch, targetDir });
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

const REPO = 'octocat/monorepo';
const SHA = 'abc123def456789012345678901234567890aaaa';

describe('一仓多项目 push 分发', () => {
  let tmp: string;
  let stateService: StateService;
  let worktree: MockWorktree;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fanout-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    worktree = new MockWorktree(new MockShell());
  });

  function addProject(id: string, slug: string, name: string): void {
    stateService.addProject({
      id, slug, name, kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: REPO,
      githubInstallationId: 42,
    });
  }

  function addProfileWithScope(projectId: string, profileId: string, buildScope: string[]): void {
    stateService.addBuildProfile({
      id: profileId,
      projectId,
      name: profileId,
      dockerImage: 'node:22',
      workDir: '/app',
      containerPort: 3000,
      hostPortPreference: 0,
      buildCommand: 'echo build',
      buildScope,
    } as BuildProfile);
  }

  function dispatcher(): GitHubWebhookDispatcher {
    return new GitHubWebhookDispatcher({
      stateService,
      worktreeService: worktree,
      shell: new MockShell(),
      config: buildConfig(),
    });
  }

  function push(changed: string[]) {
    return {
      ref: 'refs/heads/feature/x',
      after: SHA,
      repository: { id: 1, full_name: REPO },
      commits: [{ added: [], modified: changed, removed: [] }],
    };
  }

  it('同一个仓库下的两个项目都被处理，各自建自己的分支', async () => {
    addProject('p-main', 'main-proj', '主项目');
    addProject('p-self', 'self-proj', '自托管项目');

    const result = await dispatcher().handle('push', push(['src/app.ts']));

    // 两个项目各建一条分支（作用域都未声明 = 全通配，两边都命中）
    expect(worktree.createdWorktrees).toHaveLength(2);
    expect(stateService.findBranchByProjectAndName('p-main', 'feature/x')).toBeDefined();
    expect(stateService.findBranchByProjectAndName('p-self', 'feature/x')).toBeDefined();

    // 主结果之外那条必须挂在 fanout 上并带着自己的 deployRequest，
    // 否则路由无从替第二个项目派发部署。
    expect(result.deployRequest).toBeDefined();
    expect(result.fanout).toHaveLength(1);
    expect(result.fanout?.[0].deployRequest).toBeDefined();
    const branchIds = [result.deployRequest?.branchId, result.fanout?.[0].deployRequest?.branchId];
    expect(new Set(branchIds).size).toBe(2);
    // 投递记录要看得出这个仓库有几个项目、几个真的部署了
    expect(result.message).toContain('本仓库共 2 个项目');
    expect(result.message).toContain('2 个触发部署');
  });

  it('项目级作用域挡掉无关改动，并且不建分支', async () => {
    addProject('p-main', 'main-proj', '主项目');
    addProject('p-self', 'self-proj', '自托管项目');
    addProfileWithScope('p-main', 'api', ['prd-api/**']);
    addProfileWithScope('p-self', 'cds', ['cds/**']);

    const result = await dispatcher().handle('push', push(['cds/src/server.ts']));

    // 只有自托管项目该动
    expect(worktree.createdWorktrees).toHaveLength(1);
    expect(stateService.findBranchByProjectAndName('p-main', 'feature/x')).toBeUndefined();
    expect(stateService.findBranchByProjectAndName('p-self', 'feature/x')).toBeDefined();

    const actions = [result.action, ...(result.fanout || []).map((r) => r.action)];
    expect(actions).toContain('branch-created');
    expect(actions).toContain('ignored-out-of-scope');
    // 主结果必须是真的在干活的那条，否则面板显示「已忽略」而实际在构建
    expect(result.action).toBe('branch-created');
    expect(result.deployRequest?.branchId).toContain('self-proj');
  });

  /**
   * Codex P1：GitHub 的 push payload 会截断 commits（`size` / `distinct_size` 报的
   * 才是真实条数）。截断之后改动清单是「非空但不全」——最危险的一种输入：它看起来
   * 像证据，却会让作用域判据得出反向结论，把真被波及的项目判成「未被波及」而静默
   * 跳过它的部署。漏部署没有任何信号，所以这里必须 fail-open。
   */
  it('push 清单被截断时两个项目都照建，不许拿不全的清单判「未被波及」', async () => {
    addProject('p-main', 'main-proj', '主项目');
    addProject('p-self', 'self-proj', '自托管项目');
    addProfileWithScope('p-main', 'api', ['prd-api/**']);
    addProfileWithScope('p-self', 'cds', ['cds/**']);

    // 清单里只看得到一条改 cds 的 commit，但 size 说其实有 30 条 ——
    // 那 29 条里完全可能有改 prd-api 的
    const truncated = { ...push(['cds/src/server.ts']), size: 30, distinct_size: 30 };
    const result = await dispatcher().handle('push', truncated);

    expect(worktree.createdWorktrees).toHaveLength(2);
    const actions = [result.action, ...(result.fanout || []).map((r) => r.action)];
    expect(actions).not.toContain('ignored-out-of-scope');
  });

  it('清单完整时仍照范围判（fail-open 不是永远放行）', async () => {
    addProject('p-main', 'main-proj', '主项目');
    addProject('p-self', 'self-proj', '自托管项目');
    addProfileWithScope('p-main', 'api', ['prd-api/**']);
    addProfileWithScope('p-self', 'cds', ['cds/**']);

    // size 与实际条数对得上 = 清单可信
    const complete = { ...push(['cds/src/server.ts']), size: 1, distinct_size: 1 };
    const result = await dispatcher().handle('push', complete);

    expect(worktree.createdWorktrees).toHaveLength(1);
    const actions = [result.action, ...(result.fanout || []).map((r) => r.action)];
    expect(actions).toContain('ignored-out-of-scope');
  });

  it('反过来只改主项目目录时，自托管项目不动', async () => {
    addProject('p-main', 'main-proj', '主项目');
    addProject('p-self', 'self-proj', '自托管项目');
    addProfileWithScope('p-main', 'api', ['prd-api/**']);
    addProfileWithScope('p-self', 'cds', ['cds/**']);

    const result = await dispatcher().handle('push', push(['prd-api/src/Program.cs']));

    expect(stateService.findBranchByProjectAndName('p-main', 'feature/x')).toBeDefined();
    expect(stateService.findBranchByProjectAndName('p-self', 'feature/x')).toBeUndefined();
    expect(result.deployRequest?.branchId).toContain('main-proj');
  });

  it('单项目仓库：行为与启用前一致，不出现 fanout 字段', async () => {
    addProject('p-main', 'main-proj', '主项目');

    const result = await dispatcher().handle('push', push(['src/app.ts']));

    expect(result.action).toBe('branch-created');
    expect(result.deployRequest).toBeDefined();
    expect(result.fanout).toBeUndefined();
    // 单项目时不该追加多项目后缀
    expect(result.message).not.toContain('本仓库共');
  });

  it('仓库没有任何项目时仍然是 ignored-no-project', async () => {
    const result = await dispatcher().handle('push', push(['src/app.ts']));
    expect(result.action).toBe('ignored-no-project');
  });
});

describe('mergePushResults —— 谁当主结果', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  it('有人要部署时，要部署的那条当主结果', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关' },
      { action: 'branch-created', message: '建好了', branchId: 'b1', deployRequest: { branchId: 'b1', commitSha: SHA } },
    ];
    const merged = mergePushResults(results, projects);
    expect(merged.action).toBe('branch-created');
    expect(merged.fanout?.[0].action).toBe('ignored-out-of-scope');
  });

  it('没人部署时，取第一条不是被忽略的', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关' },
      { action: 'ci-image-waiting', message: '等 CI', branchId: 'b1' },
    ];
    expect(mergePushResults(results, projects).action).toBe('ci-image-waiting');
  });

  it('全是被忽略时取第一条，仍然带上仓库项目数', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关一' },
      { action: 'ignored-doc-only', message: '只改了文档' },
    ];
    const merged = mergePushResults(results, projects);
    expect(merged.action).toBe('ignored-out-of-scope');
    expect(merged.message).toContain('本仓库共 2 个项目');
    expect(merged.message).toContain('0 个触发部署');
  });

  it('只有一条结果时原样返回，不加后缀也不加 fanout', () => {
    const single: WebhookDispatchResult = { action: 'branch-created', message: '建好了' };
    const merged = mergePushResults([single], [{ id: 'a', name: 'A' }]);
    expect(merged).toEqual(single);
  });
});

afterEach(() => {
  flushAllJsonStateStores();
});
