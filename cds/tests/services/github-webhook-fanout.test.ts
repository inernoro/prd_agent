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
  mergeFanoutResults,
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

  function addPrebuiltProfile(projectId: string, profileId: string): void {
    stateService.addBuildProfile({
      id: profileId,
      projectId,
      name: profileId,
      dockerImage: 'node:22',
      workDir: '/app',
      containerPort: 3000,
      hostPortPreference: 0,
      buildCommand: 'echo build',
      activeDeployMode: 'express',
      deployModes: { express: { prebuilt: true } },
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
    expect(result.message).toContain('2 个触发处理');
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

  /**
   * 后续事件也要分发（2026-09-02）。
   *
   * push 分发修好之后，删分支 / 极速版镜像完成 / 关 PR 这三条仍然只认第一个项目。
   * 后果各不相同但都**没有报错**：容器留着没人收、分支永远停在等待中、预览一直开着。
   * 没有信号的故障最贵，所以这三条各钉一个用例。
   */
  describe('解绑类事件同样作用到仓库下每个项目', () => {
    it('仓库改名：每个绑着它的项目都要解绑，不是只解第一个', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');

      await dispatcher().handle('repository', {
        action: 'renamed',
        repository: { id: 1, full_name: `${REPO}-new`, name: 'monorepo-new', owner: { login: 'octocat' } },
        changes: { repository: { name: { from: 'monorepo' } } },
      });

      // 只解第一个的话，剩下那个留着一条指向旧名字的死链接：改名之后推送带的是
      // 新仓库名，永远匹配不上，于是静默停止部署，没有任何信号。
      for (const id of ['p-main', 'p-self']) {
        expect(stateService.getProject(id)?.githubRepoFullName, id).toBeUndefined();
      }
    });

    it('仓库被删：两个项目都解绑', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');

      await dispatcher().handle('repository', {
        action: 'deleted',
        repository: { id: 1, full_name: REPO, name: 'monorepo', owner: { login: 'octocat' } },
      });

      for (const id of ['p-main', 'p-self']) {
        expect(stateService.getProject(id)?.githubRepoFullName, id).toBeUndefined();
      }
    });

    it('安装被移除仓库访问权：两个项目都解绑', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');

      await dispatcher().handle('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [{ full_name: REPO }],
      });

      for (const id of ['p-main', 'p-self']) {
        expect(stateService.getProject(id)?.githubRepoFullName, id).toBeUndefined();
      }
    });
  });

  describe('后续事件同样分发到仓库下每个项目', () => {
    it('删分支：每个项目的同名预览都要被清理，不是只清第一个', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');
      // 先让两个项目各有一条 feature/x
      await dispatcher().handle('push', push(['src/app.ts']));
      expect(stateService.findBranchByProjectAndName('p-main', 'feature/x')).toBeDefined();
      expect(stateService.findBranchByProjectAndName('p-self', 'feature/x')).toBeDefined();

      const result = await dispatcher().handle('delete', {
        ref: 'feature/x',
        ref_type: 'branch',
        repository: { id: 1, full_name: REPO },
      });

      const actions = [result.action, ...(result.fanout || []).map((r) => r.action)];
      expect(actions.filter((a) => a === 'branch-deleted')).toHaveLength(2);
      // 两条清理请求都要发出去，否则第二个项目的容器没人收
      const deleteIds = [result, ...(result.fanout || [])]
        .map((r) => r.branchDeleteRequest?.branchId)
        .filter(Boolean);
      expect(deleteIds).toHaveLength(2);
      expect(new Set(deleteIds).size).toBe(2);
    });

    it('关 PR：每个项目的预览都要停，不是只停第一个', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');
      await dispatcher().handle('push', push(['src/app.ts']));

      const result = await dispatcher().handle('pull_request', {
        action: 'closed',
        repository: { id: 1, full_name: REPO },
        pull_request: { number: 7, head: { ref: 'feature/x' }, base: { ref: 'main' }, merged: false },
      });

      const stopIds = [result, ...(result.fanout || [])]
        .map((r) => r.stopRequest?.branchId)
        .filter(Boolean);
      expect(stopIds).toHaveLength(2);
      expect(new Set(stopIds).size).toBe(2);
    });

    it('极速版镜像完成：每个项目等这个 SHA 的分支都要就绪，不是只推进第一个', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');
      addPrebuiltProfile('p-main', 'api');
      addPrebuiltProfile('p-self', 'cds');

      // push 让两个项目的分支都钉上「我在等这个 SHA 的镜像」
      await dispatcher().handle('push', push(['src/app.ts']));
      const waiting = ['p-main', 'p-self'].map((pid) =>
        stateService.findBranchByProjectAndName(pid, 'feature/x'));
      expect(waiting.map((b) => b?.ciImageStatus)).toEqual(['waiting', 'waiting']);

      await dispatcher().handle('workflow_run', {
        action: 'completed',
        repository: { id: 1, full_name: REPO },
        workflow_run: {
          path: '.github/workflows/branch-image.yml',
          name: 'Branch Image',
          head_sha: SHA,
          head_branch: 'feature/x',
          conclusion: 'success',
          html_url: 'https://example.invalid/run/1',
        },
      });

      // 只推进第一个的话，第二个项目的分支永远停在 waiting——而且没有任何报错，
      // 用户只能看着它一直转圈。
      const after = ['p-main', 'p-self'].map((pid) =>
        stateService.findBranchByProjectAndName(pid, 'feature/x'));
      expect(after.map((b) => b?.ciImageStatus)).toEqual(['ready', 'ready']);
    });

    it('镜像先于 push 到达：两个项目都要认领得到，不是第一个拿走就没了', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');
      addPrebuiltProfile('p-main', 'api');
      addPrebuiltProfile('p-self', 'cds');

      // 缓存挂在分发器实例上，所以这条竞态必须用**同一个**实例走完，
      // 否则测的是「新实例读不到旧实例的缓存」，与要防的东西无关。
      const d = dispatcher();

      // 竞态：CI 完成事件先到，此时两个项目都还没有这条分支 —— 结果进缓存
      await d.handle('workflow_run', {
        action: 'completed',
        repository: { id: 1, full_name: REPO },
        workflow_run: {
          path: '.github/workflows/branch-image.yml',
          name: 'Branch Image',
          head_sha: SHA,
          head_branch: 'feature/x',
          conclusion: 'success',
          html_url: 'https://example.invalid/run/1',
        },
      });

      // push 随后到达，两个项目各建一条分支，都该认领到那次已完成的 CI
      await d.handle('push', push(['src/app.ts']));

      // 缓存是一次性消费的。键上不带项目，第一个项目拿走之后第二个永远认领不到，
      // 于是它停在 waiting 等一个不会再来的事件 —— 没有任何报错。
      const after = ['p-main', 'p-self'].map((pid) =>
        stateService.findBranchByProjectAndName(pid, 'feature/x'));
      expect(after.map((b) => b?.ciImageStatus)).toEqual(['ready', 'ready']);
    });

    it('主结果挑真的在干活的那条，不是恰好排第一的那条', async () => {
      addProject('p-main', 'mainp', 'MAP');
      addProject('p-self', 'selfp', 'CDS Self');
      addProfileWithScope('p-main', 'api', ['prd-api/**']);
      addProfileWithScope('p-self', 'cds', ['cds/**']);

      // 只改 cds/**：主项目应被判未波及，自托管项目该建分支
      const complete = { ...push(['cds/src/server.ts']), size: 1, distinct_size: 1 };
      const result = await dispatcher().handle('push', complete);

      // 面板显示「已忽略」而后台正在给另一个项目构建，是最难查的那种不一致
      expect(result.action).toBe('branch-created');
      expect(result.deployRequest).toBeDefined();
    });
  });
});

describe('mergeFanoutResults —— 谁当主结果', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  it('有人要部署时，要部署的那条当主结果', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关' },
      { action: 'branch-created', message: '建好了', branchId: 'b1', deployRequest: { branchId: 'b1', commitSha: SHA } },
    ];
    const merged = mergeFanoutResults(results, projects);
    expect(merged.action).toBe('branch-created');
    expect(merged.fanout?.[0].action).toBe('ignored-out-of-scope');
  });

  it('没人部署时，取第一条不是被忽略的', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关' },
      { action: 'ci-image-waiting', message: '等 CI', branchId: 'b1' },
    ];
    expect(mergeFanoutResults(results, projects).action).toBe('ci-image-waiting');
  });

  it('全是被忽略时取第一条，仍然带上仓库项目数', () => {
    const results: WebhookDispatchResult[] = [
      { action: 'ignored-out-of-scope', message: '不相关一' },
      { action: 'ignored-doc-only', message: '只改了文档' },
    ];
    const merged = mergeFanoutResults(results, projects);
    expect(merged.action).toBe('ignored-out-of-scope');
    expect(merged.message).toContain('本仓库共 2 个项目');
    expect(merged.message).toContain('0 个触发处理');
  });

  it('只有一条结果时原样返回，不加后缀也不加 fanout', () => {
    const single: WebhookDispatchResult = { action: 'branch-created', message: '建好了' };
    const merged = mergeFanoutResults([single], [{ id: 'a', name: 'A' }]);
    expect(merged).toEqual(single);
  });
});

afterEach(() => {
  flushAllJsonStateStores();
});
