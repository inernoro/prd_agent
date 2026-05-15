/**
 * AutoLifecycleService.tick() 行为测试 —— 驱动真实调用链
 * tick → branchAutoPublishConverged → applyAutoPublish → redeployBranch，
 * 用注入的 fake state + mock redeploy 断言"自动切发布版"真的发生 /
 * 失败真的回滚，而不仅仅是 tsc 通过。
 *
 * 2026-05-14：回应用户"你测了吗"。
 */
import { describe, it, expect, vi } from 'vitest';
import { AutoLifecycleService } from '../../src/services/auto-lifecycle.js';
import type { BranchEntry, BuildProfile, ServiceState } from '../../src/types.js';

function profile(id: string): BuildProfile {
  return {
    id,
    name: id,
    dockerImage: 'node:22',
    workDir: '/app',
    containerPort: 3000,
    hostPortPreference: 0,
    buildCommand: 'echo build',
    activeDeployMode: 'dev',
    deployModes: { dev: { label: '源码热加载' }, prod: { label: '生产构建' } },
  } as BuildProfile;
}

function svc(profileId: string, status: ServiceState['status'], deployedMode?: string): ServiceState {
  return {
    profileId,
    containerName: `c-${profileId}`,
    hostPort: 30000,
    status,
    ...(deployedMode !== undefined ? { deployedMode } : {}),
  } as ServiceState;
}

const READY_AT = '2026-05-14T00:00:00.000Z';
const NOW_MS = Date.parse(READY_AT) + 11 * 60 * 1000; // ready 后 11 分钟

function makeHarness(branch: BranchEntry) {
  const profiles = [profile('web')];
  const stateService = {
    getProjects: () => [{ id: 'p1', autoPublishAfterMinutes: 10, autoStopAfterMinutes: 0 }],
    getBuildProfilesForProject: () => profiles,
    getAllBranches: () => [branch],
    getBranch: (id: string) => (id === branch.id ? branch : undefined),
    setBranchProfileOverride: (bid: string, pid: string, ov: { activeDeployMode?: string }) => {
      if (bid !== branch.id) return;
      branch.profileOverrides = branch.profileOverrides || {};
      branch.profileOverrides[pid] = { ...(branch.profileOverrides[pid] || {}), ...ov };
    },
    appendActivityLog: vi.fn(),
    save: vi.fn(),
  };
  const stopBranch = vi.fn(async () => {});
  const redeployBranch = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AutoLifecycleService(
    { stateService: stateService as any, stopBranch, redeployBranch, clock: { now: () => NOW_MS } },
    { tickIntervalSeconds: 30, enabled: true },
  );
  return { service, stateService, stopBranch, redeployBranch, branch };
}

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'b1',
    branch: 'feat/x',
    projectId: 'p1',
    worktreePath: '/tmp/wt',
    status: 'running',
    lastReadyAt: READY_AT,
    services: { web: svc('web', 'running', 'dev') },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as BranchEntry;
}

describe('AutoLifecycleService.tick — auto-publish 真实重部署', () => {
  it('未收敛（容器跑源码）→ 写 release override 并调用 redeployBranch', async () => {
    const h = makeHarness(branch());
    await h.service.tick();
    expect(h.redeployBranch).toHaveBeenCalledTimes(1);
    expect(h.redeployBranch).toHaveBeenCalledWith('b1');
    // override 已写成 release 模式（prod 命中发布版正则）
    expect(h.branch.profileOverrides?.web?.activeDeployMode).toBe('prod');
    // Cursor Bugbot Medium：redeploy 后分支重新跑起来，不能钉"已停止"字段
    expect(h.branch.lastStoppedAt).toBeUndefined();
    expect(h.branch.lastStopSource).not.toBe('system');
  });

  it('已收敛（override=prod 且容器 deployedMode=prod）→ 不重部署', async () => {
    const h = makeHarness(
      branch({
        profileOverrides: { web: { activeDeployMode: 'prod' } },
        services: { web: svc('web', 'running', 'prod') },
      }),
    );
    await h.service.tick();
    expect(h.redeployBranch).not.toHaveBeenCalled();
  });

  it('配置已是 release 但容器还跑源码 → 仍重部署，且不改写 override（Codex P2）', async () => {
    const h = makeHarness(
      branch({
        profileOverrides: { web: { activeDeployMode: 'prod' } },
        services: { web: svc('web', 'running', 'dev') }, // 配置 prod，容器实际 dev
      }),
    );
    await h.service.tick();
    expect(h.redeployBranch).toHaveBeenCalledTimes(1);
    expect(h.redeployBranch).toHaveBeenCalledWith('b1');
    // redeploy-only：override 保持用户/项目选的 prod，不被覆盖
    expect(h.branch.profileOverrides?.web?.activeDeployMode).toBe('prod');
  });

  it('redeploy 失败 → 回滚 override（不留假收敛），下一拍仍未收敛', async () => {
    const h = makeHarness(branch());
    h.redeployBranch.mockRejectedValueOnce(new Error('deploy boom'));
    await h.service.tick(); // 内部 catch 记录错误，不抛出 tick 外
    expect(h.redeployBranch).toHaveBeenCalledTimes(1);
    // 回滚：override 恢复到原值（undefined）
    expect(h.branch.profileOverrides?.web?.activeDeployMode).toBeUndefined();

    // 下一拍：依然未收敛 → 会再次尝试 redeploy（证明没被误判收敛）
    await h.service.tick();
    expect(h.redeployBranch).toHaveBeenCalledTimes(2);
  });
});
