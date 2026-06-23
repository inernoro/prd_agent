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
import { resolveImageTemplate, slugifyBranchForImage, resolveEffectiveProfile, normalizeFallbackImages } from '../../src/services/container.js';
import {
  resolveActiveDeployModeId,
  branchUsesPrebuiltMode,
  classifyDeployRuntime,
  applyDefaultDeployModesToBranch,
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
    // slug 对齐 docker/metadata-action:保留大小写,空格(非法)→ '-'。
    expect(
      resolveImageTemplate('ghcr.io/x/api:branch-${CDS_BRANCH_SLUG}', branch),
    ).toBe('ghcr.io/x/api:branch-feat-Cool-Thing');
  });

  it('resolveImageTemplate 无模板变量原样返回', () => {
    expect(resolveImageTemplate('node:20-slim', undefined)).toBe('node:20-slim');
  });

  it('resolveImageTemplate 优先用 ciTargetSha（CI 就绪 SHA）而非 githubCommitSha（Bugbot High）', () => {
    const OLD = 'aaaaaaaa00112233445566778899aabbccddeeff';
    // docs-only push 把 githubCommitSha 推进到 NEW,但 ciTargetSha 仍是 CI 就绪的 OLD。
    const branch = { githubCommitSha: FULL_SHA, ciTargetSha: OLD, branch: 'feature' } as BranchEntry;
    expect(resolveImageTemplate('ghcr.io/x/api:sha-${CDS_COMMIT_SHA}', branch)).toBe(`ghcr.io/x/api:sha-${OLD}`);
    // ciTargetSha 未设时退回 githubCommitSha。
    const noTarget = { githubCommitSha: FULL_SHA, branch: 'feature' } as BranchEntry;
    expect(resolveImageTemplate('ghcr.io/x/api:sha-${CDS_COMMIT_SHA}', noTarget)).toBe(`ghcr.io/x/api:sha-${FULL_SHA}`);
  });

  it('slugifyBranchForImage 对齐 docker/metadata-action(保留大小写/下划线/点, / 与空格→ -)', () => {
    expect(slugifyBranchForImage('my/branch')).toBe('my-branch');
    expect(slugifyBranchForImage('Codex/fix')).toBe('Codex-fix');
    expect(slugifyBranchForImage('release/v1.2')).toBe('release-v1.2');
    expect(slugifyBranchForImage('Feature/Foo_Bar')).toBe('Feature-Foo_Bar');
    expect(slugifyBranchForImage('--main')).toBe('main'); // 去前导 '-'(Docker tag 不能以 '-' 开头)
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

  it('applyDefaultDeployModesToBranch 把已有分支(原 dev)对齐到项目默认 express（强制对齐核心）', () => {
    const p = expressApiProfile();
    const branch = { profileOverrides: { api: { activeDeployMode: 'dev' } } } as unknown as BranchEntry;
    applyDefaultDeployModesToBranch(branch, { api: 'express' }, [p]);
    expect(branch.profileOverrides!.api.activeDeployMode).toBe('express');
  });

  it('applyDefaultDeployModesToBranch 跳过 profile 不存在的目标模式（不写脏配置）', () => {
    const p = expressApiProfile();
    const branch = {} as unknown as BranchEntry;
    applyDefaultDeployModesToBranch(branch, { api: 'nonexistent' }, [p]);
    expect(branch.profileOverrides?.api?.activeDeployMode).toBeUndefined();
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
    // 关键：express 无 command 时不继承 baseline 源码命令,置空 → 用镜像 ENTRYPOINT。
    expect(eff.command || '').toBe('');
  });

  it('resolveEffectiveProfile 带 fallbackImage 有序回退链时逐元素解析模板（Codex P1）', () => {
    const p = expressApiProfile();
    p.deployModes!.express.fallbackImage = [
      'ghcr.io/inernoro/prd_agent/prdagent-server:branch-${CDS_BRANCH_SLUG}',
      'ghcr.io/inernoro/prd_agent/prdagent-server:branch-main',
    ];
    const branch = {
      id: 'p1-main', branch: 'Feat/Cool', githubCommitSha: FULL_SHA,
      profileOverrides: { api: { activeDeployMode: 'express' } },
    } as unknown as BranchEntry;
    const eff = resolveEffectiveProfile(p, branch);
    expect(eff.dockerImage).toBe(`ghcr.io/inernoro/prd_agent/prdagent-server:sha-${FULL_SHA}`);
    // 回退链逐元素解析:① 本分支 tag(branch-Feat-Cool,保留大小写,保住本分支已有改动) ② 固定 branch-main。
    expect(eff.fallbackImage).toEqual([
      'ghcr.io/inernoro/prd_agent/prdagent-server:branch-Feat-Cool',
      'ghcr.io/inernoro/prd_agent/prdagent-server:branch-main',
    ]);
  });

  it('normalizeFallbackImages 把 string|string[]|undefined 规整为去空去重数组', () => {
    expect(normalizeFallbackImages(undefined)).toEqual([]);
    expect(normalizeFallbackImages('a:1')).toEqual(['a:1']);
    expect(normalizeFallbackImages(['a:1', ' ', 'b:2'])).toEqual(['a:1', 'b:2']);
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
    const ready = stateService.getBranch(pushed.branchId!);
    expect(ready?.ciImageStatus).toBe('ready');
    // ciTargetSha 必须与 head_sha 一致,否则 check_run 闸门会卡（Bugbot: CI ready omits target SHA）。
    expect(ready?.ciTargetSha).toBe(FULL_SHA);
  });

  it('docs-only 跳过的 commit 不被 workflow_run 自动部署（Codex P2: don\'t fallback-deploy docs-only CI runs）', async () => {
    const pushed = await pushOnce();
    // 先让 FULL_SHA 就绪并部署。
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 80, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'feature', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
    // docs-only push 到 NEW:分支是 ready(非 waiting),只刷新 githubCommitSha,
    // 不推进 ciTargetSha(仍 FULL_SHA),显式不部署。
    const NEW = 'eeee5555ffff6666aaaa7777bbbb8888cccc9999';
    const doc = await dispatcher.handle('push', {
      ref: 'refs/heads/feature', after: NEW, repository: { id: 1, full_name: 'octocat/repo' },
      commits: [{ id: NEW, added: [], removed: [], modified: ['README.md'] }],
    });
    expect(doc.action).toBe('ignored-doc-only');
    expect(stateService.getBranch(pushed.branchId!)?.ciTargetSha).toBe(FULL_SHA);
    // NEW 的 CI 完成 → 不应自动部署(docs-only 已显式跳过),strict matcher 落空 → ack/缓存。
    const wf = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 81, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: NEW, head_branch: 'feature', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(wf.action).toBe('workflow-acknowledged');
    expect(wf.deployRequest).toBeUndefined();
    // 分支仍指向旧的就绪 SHA,未被 NEW 顶替部署。
    expect(stateService.getBranch(pushed.branchId!)?.ciTargetSha).toBe(FULL_SHA);
  });

  it('分支已切回非极速版 → workflow_run 完成不再被认领自动重部署（Codex P2: re-check mode before consuming CI completions）', async () => {
    const pushed = await pushOnce(); // waiting, express
    // 用户把 override 从 express 切回 dev（CI 字段可能还残留）。
    stateService.setBranchProfileOverride(pushed.branchId!, 'api', { activeDeployMode: 'dev' } as any);
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 90, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'feature', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('workflow-acknowledged');
    expect(result.deployRequest).toBeUndefined();
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

  it('CI 失败后 re-run 同 SHA 成功 → failed 恢复 ready + deployRequest（Codex review）', async () => {
    const pushed = await pushOnce();
    // 第一次失败
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 10, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, conclusion: 'failure' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('failed');
    // re-run 同 SHA 成功 → 应恢复 ready + 部署（不需再 push）
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 11, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-ready');
    expect(result.deployRequest).toEqual({ branchId: pushed.branchId, commitSha: FULL_SHA });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
  });

  it('workflow_run head_branch 与等待分支不符 → ack（不误派给同 SHA 的别的分支，Bugbot/Codex review）', async () => {
    await pushOnce(); // 分支名 feature
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 12, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'other-branch', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('workflow-acknowledged');
    expect(result.deployRequest).toBeUndefined();
  });

  it('workflow_run 缺 head_branch 且同 SHA 多个候选 → 不误派给第一个,ack（Bugbot: missing head_branch picks wrong branch）', async () => {
    await dispatcher.handle('push', { ref: 'refs/heads/feature', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' } });
    await dispatcher.handle('push', { ref: 'refs/heads/feature-2', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' } });
    // 两个极速版分支都 waiting 在同一 SHA;workflow_run 缺 head_branch → 有歧义 → 放弃匹配。
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 13, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('workflow-acknowledged');
    expect(result.deployRequest).toBeUndefined();
    // 两个分支都仍 waiting,没有任何一个被误标 ready。
    expect(stateService.getBranch('proj-feature')?.ciImageStatus).toBe('waiting');
    expect(stateService.getBranch('proj-feature-2')?.ciImageStatus).toBe('waiting');
  });

  it('workflow_run 缺 head_branch 但只有一个候选 → 无歧义,正常认领', async () => {
    const pushed = await pushOnce();
    const result = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 14, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-ready');
    expect(result.deployRequest).toEqual({ branchId: pushed.branchId, commitSha: FULL_SHA });
  });

  it('dry-run push 在极速版分支 → ci-image-waiting,不返回 deployRequest（Bugbot: dry-run ignores express wait path）', async () => {
    // 先真实建分支（已有 express override）。
    await pushOnce();
    const result = await dispatcher.handle(
      'push',
      { ref: 'refs/heads/feature', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' } },
      { dryRun: true },
    );
    expect(result.action).toBe('ci-image-waiting');
    expect(result.deployRequest).toBeUndefined();
  });

  it('dry-run push 新建极速版分支(项目默认 express) → ci-image-waiting,不返回 deployRequest', async () => {
    // 全新分支,dry-run 不落盘;项目 defaultDeployModes={api:express} → 应模拟出极速版。
    const result = await dispatcher.handle(
      'push',
      { ref: 'refs/heads/brand-new', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' } },
      { dryRun: true },
    );
    expect(result.action).toBe('ci-image-waiting');
    expect(result.deployRequest).toBeUndefined();
    // dry-run 不应真的建分支
    expect(stateService.getBranch('proj-brand-new')).toBeUndefined();
  });

  it('docs-only push 不动 CI 状态,保护正在构建的代码 commit（Bugbot: CI ready without image builds — 防孤儿）', async () => {
    const pushed = await pushOnce(); // waiting, ciTargetSha=FULL_SHA(代码 commit,CI 构建中)
    const NEW_SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
    const result = await dispatcher.handle('push', {
      ref: 'refs/heads/feature',
      after: NEW_SHA,
      repository: { id: 1, full_name: 'octocat/repo' },
      commits: [{ id: NEW_SHA, added: [], removed: [], modified: ['README.md'] }],
    });
    expect(result.action).toBe('ignored-doc-only');
    const branch = stateService.getBranch(pushed.branchId!);
    // path-filter 下 docs commit 不产镜像 → ciTargetSha 必须**保持**在代码 commit(FULL_SHA),
    // 否则会把正在构建的代码 commit 顶成孤儿;只刷新展示用 githubCommitSha。
    expect(branch?.ciImageStatus).toBe('waiting');
    expect(branch?.ciTargetSha).toBe(FULL_SHA);
    expect(branch?.githubCommitSha).toBe(NEW_SHA);
  });

  it('workflow_run 抢先到达(分支未 stamp waiting) → 缓存,后续 push 认领直接 ready+deploy（Bugbot/Codex P2: 不丢早到的 completion）', async () => {
    // 模拟 push webhook 延迟:先收到 branch-image.yml 成功的 workflow_run。
    const early = await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 20,
        name: 'Branch Image',
        path: '.github/workflows/branch-image.yml',
        head_sha: FULL_SHA,
        head_branch: 'feature',
        conclusion: 'success',
        html_url: 'https://github.com/octocat/repo/actions/runs/20',
      },
      repository: { full_name: 'octocat/repo' },
    });
    expect(early.action).toBe('workflow-acknowledged'); // 暂无分支,已缓存
    expect(early.deployRequest).toBeUndefined();

    // 稍后 push 到达,建分支(极速版) → 应认领缓存的成功结果,直接 ready+deploy,不置 waiting。
    const pushed = await pushOnce();
    expect(pushed.action).toBe('ci-image-ready');
    expect(pushed.deployRequest).toEqual({ branchId: pushed.branchId, commitSha: FULL_SHA });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
  });

  it('workflow_run 抢先到达且失败 → 后续 push 认领为 failed,不置 waiting 苦等', async () => {
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 21,
        name: 'Branch Image',
        path: '.github/workflows/branch-image.yml',
        head_sha: FULL_SHA,
        head_branch: 'feature',
        conclusion: 'failure',
        html_url: 'https://github.com/octocat/repo/actions/runs/21',
      },
      repository: { full_name: 'octocat/repo' },
    });
    const pushed = await pushOnce();
    expect(pushed.action).toBe('ci-image-failed');
    expect(pushed.deployRequest).toBeUndefined();
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('failed');
  });

  it('同一 SHA 两分支各跑 CI 早到 → 缓存按 head_branch 分键,各自认领不互相吞（Bugbot: shared CI cache single consume）', async () => {
    // 两分支 feature / feature-2 指向同一 commit,GitHub 各发一条带不同 head_branch 的 run。
    for (const br of ['feature', 'feature-2']) {
      const r = await dispatcher.handle('workflow_run', {
        action: 'completed',
        workflow_run: {
          id: br === 'feature' ? 30 : 31,
          name: 'Branch Image',
          path: '.github/workflows/branch-image.yml',
          head_sha: FULL_SHA,
          head_branch: br,
          conclusion: 'success',
          html_url: `https://github.com/octocat/repo/actions/${br}`,
        },
        repository: { full_name: 'octocat/repo' },
      });
      expect(r.action).toBe('workflow-acknowledged'); // 都先缓存
    }
    // 两次 push 各自认领自己的缓存 → 都 ready+deploy,互不吞噬。
    const p1 = await dispatcher.handle('push', {
      ref: 'refs/heads/feature', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' },
    });
    const p2 = await dispatcher.handle('push', {
      ref: 'refs/heads/feature-2', after: FULL_SHA, repository: { id: 1, full_name: 'octocat/repo' },
    });
    expect(p1.action).toBe('ci-image-ready');
    expect(p2.action).toBe('ci-image-ready');
    expect(p1.branchId).not.toBe(p2.branchId);
    expect(stateService.getBranch(p1.branchId!)?.ciImageStatus).toBe('ready');
    expect(stateService.getBranch(p2.branchId!)?.ciImageStatus).toBe('ready');
  });

  it('docs-only push 不认领 docs SHA 的缓存,继续等待代码 commit（path-filter:docs 不产镜像）', async () => {
    const pushed = await pushOnce(); // waiting, ciTargetSha=FULL_SHA(代码 commit)
    const NEW_SHA = 'bbbb2222cccc3333dddd4444eeee5555ffff6666';
    // 假设有一条 NEW_SHA 的 workflow_run 早到并缓存(实际 path-filter 下 docs commit 不会产生
    // 有意义的镜像,这里只验证 docs-only push 不会去认领它、不会顶掉代码 commit 的等待)。
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 40, name: 'Branch Image', path: '.github/workflows/branch-image.yml',
        head_sha: NEW_SHA, head_branch: 'feature', conclusion: 'success',
        html_url: 'https://github.com/octocat/repo/actions/runs/40',
      },
      repository: { full_name: 'octocat/repo' },
    });
    const result = await dispatcher.handle('push', {
      ref: 'refs/heads/feature',
      after: NEW_SHA,
      repository: { id: 1, full_name: 'octocat/repo' },
      commits: [{ id: NEW_SHA, added: [], removed: [], modified: ['README.md'] }],
    });
    // docs-only → 不部署、不认领缓存;仍等待代码 commit FULL_SHA。
    expect(result.action).toBe('ignored-doc-only');
    expect(result.deployRequest).toBeUndefined();
    const branch = stateService.getBranch(pushed.branchId!);
    expect(branch?.ciImageStatus).toBe('waiting');
    expect(branch?.ciTargetSha).toBe(FULL_SHA);
  });

  it('check_run 重跑在极速版 waiting 分支不返回 deployRequest（Bugbot: check run skips CI wait）', async () => {
    const pushed = await pushOnce(); // express, ciImageStatus=waiting
    const result = await dispatcher.handle('check_run', {
      action: 'rerequested',
      check_run: { external_id: pushed.branchId, head_sha: FULL_SHA },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-waiting');
    expect(result.deployRequest).toBeUndefined();
  });

  it('check_run 重跑在极速版 ready 分支放行部署', async () => {
    const pushed = await pushOnce();
    // 让 CI 成功 → ready
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 50, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'feature', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
    const result = await dispatcher.handle('check_run', {
      action: 'rerequested',
      check_run: { external_id: pushed.branchId, head_sha: FULL_SHA },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('check-run-requeued');
    expect(result.deployRequest).toEqual({ branchId: pushed.branchId, commitSha: FULL_SHA });
  });

  it('check_run 重跑:ready 的是别的 commit → 仍不放行（Bugbot: check run ignores CI target SHA）', async () => {
    const pushed = await pushOnce(); // ciTargetSha=FULL_SHA
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 60, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'feature', conclusion: 'success' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(stateService.getBranch(pushed.branchId!)?.ciImageStatus).toBe('ready');
    // check_run 携带另一个 commit B → ready(针对 A) 不应放行 B 的预构建部署。
    const OTHER_SHA = 'cccc3333dddd4444eeee5555ffff6666aaaa7777';
    const result = await dispatcher.handle('check_run', {
      action: 'rerequested',
      check_run: { external_id: pushed.branchId, head_sha: OTHER_SHA },
      repository: { full_name: 'octocat/repo' },
    });
    expect(result.action).toBe('ci-image-waiting');
    expect(result.deployRequest).toBeUndefined();
  });

  it('新 push 重置 waiting 时清掉旧 ciWorkflowRunUrl（Bugbot: stale CI run link on wait）', async () => {
    const pushed = await pushOnce();
    // 先让上一轮失败并留下 run url。
    await dispatcher.handle('workflow_run', {
      action: 'completed',
      workflow_run: { id: 70, name: 'Branch Image', path: '.github/workflows/branch-image.yml', head_sha: FULL_SHA, head_branch: 'feature', conclusion: 'failure', html_url: 'https://github.com/octocat/repo/actions/runs/70' },
      repository: { full_name: 'octocat/repo' },
    });
    expect(stateService.getBranch(pushed.branchId!)?.ciWorkflowRunUrl).toBe('https://github.com/octocat/repo/actions/runs/70');
    // 新 push 同分支新 commit → 重置 waiting,应清掉旧 run url。
    const NEW_SHA = 'dddd4444eeee5555ffff6666aaaa7777bbbb8888';
    await dispatcher.handle('push', { ref: 'refs/heads/feature', after: NEW_SHA, repository: { id: 1, full_name: 'octocat/repo' } });
    const branch = stateService.getBranch(pushed.branchId!);
    expect(branch?.ciImageStatus).toBe('waiting');
    expect(branch?.ciTargetSha).toBe(NEW_SHA);
    expect(branch?.ciWorkflowRunUrl).toBeUndefined();
  });
});
