/**
 * branchAutoPublishConverged 真实态收敛语义测试。
 *
 * 2026-05-14：用户质疑"你测了吗"。本文件给出 auto-publish 收敛判定的
 * 真实断言——核心修复是：配置切了发布版还不够，必须容器**真的**以
 * 发布版跑起来（svc.deployedMode）才算收敛；否则 redeploy 静默失败
 * （如 cluster 下 proxyDeployToExecutor 丢 override）会被误判收敛、
 * auto-publish 形同虚设。同时验证旧数据（无 deployedMode 戳）退回
 * 信任配置，不对存量分支制造无限重部署。
 */
import { describe, it, expect } from 'vitest';
import { branchAutoPublishConverged } from '../../src/services/auto-lifecycle.js';
import type { BranchEntry, BuildProfile, ServiceState } from '../../src/types.js';

function profile(id: string, overrides: Partial<BuildProfile> = {}): BuildProfile {
  return {
    id,
    name: id,
    dockerImage: 'node:22',
    workDir: '/app',
    containerPort: 3000,
    hostPortPreference: 0,
    buildCommand: 'echo build',
    // prod = 命中 RELEASE_DEPLOY_MODE_PATTERN（发布版）；dev = 源码
    deployModes: {
      dev: { label: '源码热加载' },
      prod: { label: '生产构建' },
    },
    ...overrides,
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

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'b1',
    branch: 'feat/x',
    projectId: 'p1',
    worktreePath: '/tmp/wt',
    status: 'running',
    services: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as BranchEntry;
}

describe('branchAutoPublishConverged — 真实态收敛', () => {
  it('profile 没有任何 release 模式可切 → 不算阻塞项 → 收敛 true', () => {
    const p = profile('web', { deployModes: { dev: { label: '源码' } } });
    expect(branchAutoPublishConverged(branch(), [p])).toBe(true);
  });

  it('配置仍是源码（未设 release override）→ 未收敛 false', () => {
    const p = profile('web', { activeDeployMode: 'dev' });
    expect(branchAutoPublishConverged(branch(), [p])).toBe(false);
  });

  it('配置 release + 旧数据（deployedMode 未定义）→ 退回信任配置 → 收敛 true', () => {
    const p = profile('web');
    const b = branch({
      profileOverrides: { web: { activeDeployMode: 'prod' } },
      services: { web: svc('web', 'running') }, // 无 deployedMode 戳
    });
    expect(branchAutoPublishConverged(b, [p])).toBe(true);
  });

  it('配置 release + 容器确以 release 跑（deployedMode=prod, running）→ 收敛 true', () => {
    const p = profile('web');
    const b = branch({
      profileOverrides: { web: { activeDeployMode: 'prod' } },
      services: { web: svc('web', 'running', 'prod') },
    });
    expect(branchAutoPublishConverged(b, [p])).toBe(true);
  });

  it('核心修复：配置 release 但容器实际还跑源码（deployedMode=dev, running）→ 未收敛 false', () => {
    const p = profile('web');
    const b = branch({
      profileOverrides: { web: { activeDeployMode: 'prod' } },
      services: { web: svc('web', 'running', 'dev') }, // redeploy 没真正切过去
    });
    expect(branchAutoPublishConverged(b, [p])).toBe(false);
  });

  it('配置 release 但容器没在跑（deployedMode 已知, status=stopped）→ 未收敛 false', () => {
    const p = profile('web');
    const b = branch({
      profileOverrides: { web: { activeDeployMode: 'prod' } },
      services: { web: svc('web', 'stopped', 'prod') },
    });
    expect(branchAutoPublishConverged(b, [p])).toBe(false);
  });

  it('多 profile：一个真发布、一个还跑源码 → 整体未收敛 false', () => {
    const a = profile('web');
    const c = profile('api');
    const b = branch({
      profileOverrides: {
        web: { activeDeployMode: 'prod' },
        api: { activeDeployMode: 'prod' },
      },
      services: {
        web: svc('web', 'running', 'prod'),
        api: svc('api', 'running', 'dev'), // 没切过去
      },
    });
    expect(branchAutoPublishConverged(b, [a, c])).toBe(false);
  });

  it('可切 profile 全部真发布 + 一个无 release 模式的 sidecar → 收敛 true', () => {
    const web = profile('web');
    const sidecar = profile('redis', { deployModes: { dev: { label: '源码' } } });
    const b = branch({
      profileOverrides: { web: { activeDeployMode: 'prod' } },
      services: {
        web: svc('web', 'running', 'prod'),
        redis: svc('redis', 'running', 'dev'),
      },
    });
    expect(branchAutoPublishConverged(b, [web, sidecar])).toBe(true);
  });
});
