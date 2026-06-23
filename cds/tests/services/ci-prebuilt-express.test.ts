/**
 * 极速版（CI 预构建）单元测试。
 *
 * 覆盖:
 *  - 纯函数:resolveImageTemplate / slugifyBranchForImage（container.ts）
 *  - 纯函数:resolveActiveDeployModeId / branchUsesPrebuiltMode（deploy-runtime.ts）
 *  - resolveEffectiveProfile 在 express 模式下:prebuiltImage + containerPort + 镜像模板解析
 *  - classifyDeployRuntime 把 express 归类为 release
 *  - dispatcher:push 在极速版分支 → ci-image-waiting（不部署、置 waiting）
 *  - dispatcher:workflow_run.completed（branch-image.yml）→ ready+deployRequest / failed
 *  - dispatcher:非预构建工作流（ci.yml）/ SHA 不匹配 → ack 不动作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry } from '../../src/types.js';
import { GitHubWebhookDispatcher } from '../../src/services/github-webhook-dispatcher.js';
import { resolveImageTemplate, slugifyBranchForImage, resolveEffectiveProfile } from '../../src/services/container.js';
import {
  resolveActiveDeployModeId,
  branchUsesPrebuiltMode,
  classifyDeployRuntime,
} from '../../src/services/deploy-runtime.js';

const FULL_SHA = 'deadbeef00112233445566778899aabbccddeeff';

function expressApiProfile(): BuildProfile {
  return {
    id: 'api',
    projectId: 'p1',
    name: 'API',
    dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
    workDir: 'prd-api',
    command: 'dotnet run',
    containerPort: 5000,
    deployModes: {
      express: {
        label: '极速版（CI 预构建）',
        // 运行期 DeployModeOverride 字段是 dockerImage（compose-parser 把 yaml 的 image 映射到此）
        dockerImage: 'ghcr.io/inernoro/prd_agent/prdagent-server:sha-${CDS_COMMIT_SHA}',
        prebuilt: true,
        containerPort: 8080,
      },
    },
  };
}

describe('极速版 — 纯函数', () => {
  it('resolveImageTemplate 替换 CDS_COMMIT_SHA / CDS_BRANCH_SLUG', () => {
    const branch = { githubCommitSha: FULL_SHA, branch: 'feat/Cool Thing' } as BranchEntry;
    expect(
      resolveImageTemplate('ghcr.io/x/api:sha-${CDS_COMMIT_SHA}', branch),
    ).toBe(`ghcr.io/x/api:sha-${FULL_SHA}`);
    expect(
      resolveImageTemplate('ghcr.io/x/api:branch-${CDS_BRANCH_SLUG}', branch),
    ).toBe('ghcr.io/x/api:branch-feat-cool-thing');
  });

  it('resolveImageTemplate 无模板变量原样返回', () => {
    expect(resolveImageTemplate('node:20-slim', undefined)).toBe('node:20-slim');
  });

  it('slugifyBranchForImage 小写 + 非 [a-z0-9-] 转 - + 去头尾', () => {
    expect(slugifyBranchForImage('Feature/Foo_Bar')).toBe('feature-foo-bar');
    expect(slugifyBranchForImage('--main--')).toBe('main');
  });

  it('resolveActiveDeployModeId 优先级 分支override > 基线 > 项目默认', () => {
    const p = expressApiProfile();
    expect(resolveActiveDeployModeId(p, undefined, { api: 'express' })).toBe('express');
    const branch = { profileOverrides: { api: { activeDeployMode: 'dev' } } } as unknown as BranchEntry;
    expect(resolveActiveDeployModeId(p, branch, { api: 'express' })).toBe('dev');
  });

  it('branchUsesPrebuiltMode 命中 prebuilt 模式', () => {
    const p = expressApiProfile();
    expect(branchUsesPrebuiltMode([p], undefined, { api: 'express' })).toBe(true);
    expect(branchUsesPrebuiltMode([p], undefined, { api: 'dev' })).toBe(false);
    expect(branchUsesPrebuiltMode([p], undefined, undefined)).toBe(false);
  });

  it('classifyDeployRuntime 把 express 归类为 release', () => {
    expect(classifyDeployRuntime('express', '极速版（CI 预构建）')).toBe('release');
    expect(classifyDeployRuntime('dev', '开发模式')).toBe('source');
  });

  it('resolveEffectiveProfile 在 express 下应用 prebuilt + containerPort + 镜像模板', () => {
    const p = expressApiProfile();
    const branch = {
      id: 'p1-main',
      branch: 'main',
      githubCommitSha: FULL_SHA,
      profileOverrides: { api: { activeDeployMode: 'express' } },
    } as unknown as BranchEntry;
    const eff = resolveEffectiveProfile(p, branch);
    expect(eff.prebuiltImage).toBe(true);
    expect(eff.containerPort).toBe(8080);
    expect(eff.dockerImage).toBe(`ghcr.io/inernoro/prd_agent/prdagent-server:sha-${FULL_SHA}`);
  });
});

// ── dispatcher 集成 ───────────────────────────────────────────────────

class MockShell implements IShellExecutor {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}
class MockWorktree extends WorktreeService {
  override async create() { /* no-op */ }
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

describe('极速版 — dispatcher', () => {
  let tmp: string;
  let stateService: StateService;
  let dispatcher: GitHubWebhookDispatcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ciexpress-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    stateService.addProject({
      id: 'p1',
      slug: 'proj',
      name: 'Proj',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      githubRepoFullName: 'octocat/repo',
      githubInstallationId: 42,
      defaultDeployModes: { api: 'express' },
    });
    stateService.addBuildProfile(expressApiProfile());
    const shell = new MockShell();
    dispatcher = new GitHubWebhookDispatcher({
      stateService,
      worktreeService: new MockWorktree(shell),
      shell,
      config: buildConfig(),
    });
  });

  async function pushOnce(sha = FULL_SHA) {
    return dispatcher.handle('push', {
      ref: 'refs/heads/feature',
      after: sha,
      repository: { id: 1, full_name: 'octocat/repo' },
    });
  }

  it('push 在极速版分支 → ci-image-waiting,不返回 deployRequest,置 waiting', async () => {
    const result = await pushOnce();
    expect(result.action).toBe('ci-image-waiting');
    expect(result.deployRequest).toBeUndefined();
    const branch = stateService.getBranch(result.branchId!);
    expect(branch?.ciImageStatus).toBe('waiting');
    expect(branch?.ciTargetSha).toBe(FULL_SHA);
    // 极速版 override 已回填到新分支
    expect(branch?.profileOverrides?.api?.activeDeployMode).toBe('express');
  });

  it('workflow_run(branch-image.yml, success) → ci-image-ready + deployRequest', async () => {
    const pushed = await pushOnce();
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 1,
        name: 'Branch Image',
        path: '.github/workflows/branch-image.yml',
        head_sha: FULL_SHA,
        conclusion: 'success',
        html_url: 'https://github.com/octocat/repo/actions/runs/1',
      },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-ready');
    expect(result.deployRequest).toEqual({ branchId: pushed.branchId, commitSha: FULL_SHA });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
  });

  it('workflow_run(branch-image.yml, failure) → ci-image-failed,无 deployRequest', async () => {
    const pushed = await pushOnce();
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 2,
        name: 'Branch Image',
        path: '.github/workflows/branch-image.yml',
        head_sha: FULL_SHA,
        conclusion: 'failure',
        html_url: 'https://github.com/octocat/repo/actions/runs/2',
      },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-failed');
    expect(result.deployRequest).toBeUndefined();
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('failed');
  });

  it('workflow_run 来自非预构建工作流(ci.yml) → ack 不触发部署', async () => {
    await pushOnce();
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 3,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        head_sha: FULL_SHA,
        conclusion: 'success',
      },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('workflow-acknowledged');
    expect(result.deployRequest).toBeUndefined();
  });

  it('workflow_run head_sha 不匹配任何等待分支 → ack', async () => {
    await pushOnce();
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 4,
        name: 'Branch Image',
        path: '.github/workflows/branch-image.yml',
        head_sha: 'ffffffffffffffffffffffffffffffffffffffff',
        conclusion: 'success',
      },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('workflow-acknowledged');
    expect(result.deployRequest).toBeUndefined();
  });
});
