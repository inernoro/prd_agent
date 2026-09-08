import { describe, expect, it } from 'vitest';
import {
  AGENT_PREBUILT_ONLY_ERROR,
  buildPrebuiltGateRejection,
  findNonPrebuiltDefaultModes,
  findNonPrebuiltProfiles,
  isAgentGatedRequest,
  isAgentPrebuiltOnly,
  isPrebuiltMode,
  listPrebuiltModeIds,
  withoutSourceFallback,
} from '../../src/services/agent-prebuilt-gate.js';
import type { BranchEntry, BuildProfile, Project } from '../../src/types.js';

/**
 * Agent 极速版门禁的判据：只认 prebuilt 标志（不认模式名）、只认机器凭据（内部派发豁免）、
 * 模式解析口径与部署一致（分支覆盖 → 基线，不看项目默认）。
 */

function profile(over: Partial<BuildProfile> = {}): BuildProfile {
  return {
    id: 'api', projectId: 'proj-a', name: 'API', dockerImage: 'node:20', workDir: '.', containerPort: 5000,
    deployModes: {
      dev: { label: '开发模式' },
      static: { label: '静态部署', prebuilt: false },
      express: { label: '极速版', prebuilt: true, dockerImage: 'ghcr.io/x/api:sha-${CDS_COMMIT_SHA}' },
    },
    ...over,
  } as BuildProfile;
}

function branch(overrides?: Record<string, { activeDeployMode?: string }>): BranchEntry {
  return {
    id: 'b1', projectId: 'proj-a', branch: 'feat/x', worktreePath: '/tmp/b1', status: 'idle',
    createdAt: new Date().toISOString(), services: {},
    ...(overrides ? { profileOverrides: overrides } : {}),
  } as BranchEntry;
}

const project: Project = { id: 'proj-a', name: 'A', slug: 'a', kind: 'git', createdAt: '', updatedAt: '', agentPrebuiltOnly: true } as Project;

describe('agent-prebuilt-gate 判据', () => {
  it('开关缺省关闭：老项目零变化', () => {
    expect(isAgentPrebuiltOnly({ id: 'p' } as Project)).toBe(false);
    expect(isAgentPrebuiltOnly(undefined)).toBe(false);
    expect(isAgentPrebuiltOnly(project)).toBe(true);
  });

  it('只有机器凭据受门禁约束；调用方自己写的 X-CDS-Trigger 不能换来豁免；真人 cookie 与内部 loopback 旁路都不带机器凭据', () => {
    expect(isAgentGatedRequest({ headers: { 'x-ai-access-key': 'k' } })).toBe(true);
    expect(isAgentGatedRequest({ headers: {}, cdsProjectKey: { projectId: 'proj-a', keyId: 'k' } })).toBe(true);
    // Codex 第二轮 P1：header 是调用方可控的，加上它照样受闸
    expect(isAgentGatedRequest({ headers: { 'x-ai-access-key': 'k', 'x-cds-trigger': 'webhook' } })).toBe(true);
    expect(isAgentGatedRequest({ headers: { cookie: 'session=1' } })).toBe(false);
    expect(isAgentGatedRequest({ headers: { 'x-cds-internal': '1', 'x-cds-trigger': 'webhook' } })).toBe(false);
  });

  it('极速版判据是 prebuilt 标志，不是模式名；模式自己的 prebuilt 优先于 profile 级 prebuiltImage', () => {
    const p = profile();
    expect(isPrebuiltMode(p, 'express')).toBe(true);
    expect(isPrebuiltMode(p, 'static')).toBe(false);
    expect(isPrebuiltMode(p, 'dev')).toBe(false);
    expect(isPrebuiltMode(p, undefined)).toBe(false);
    expect(isPrebuiltMode(profile({ deployModes: { express: { label: '假极速' } } }), 'express')).toBe(false);
    expect(isPrebuiltMode(profile({ prebuiltImage: true, deployModes: undefined }), undefined)).toBe(true);
    // 镜像站点上显式 prebuilt:false 的源码模式仍是源码（resolveProfileWithMode 口径：override.prebuilt ?? prebuiltImage）
    const imageSite = profile({ prebuiltImage: true, deployModes: { source: { label: '源码', prebuilt: false, command: 'pnpm build' }, plain: { label: '沿用' } } });
    expect(isPrebuiltMode(imageSite, 'source')).toBe(false);
    expect(isPrebuiltMode(imageSite, 'plain')).toBe(true);
    expect(listPrebuiltModeIds(p)).toEqual(['express']);
  });

  it('生效模式：分支覆盖优先于基线；覆盖成极速版就放行，基线源码且无覆盖就拦', () => {
    const base = profile({ activeDeployMode: 'static' });
    expect(findNonPrebuiltProfiles([base], branch())).toHaveLength(1);
    expect(findNonPrebuiltProfiles([base], branch({ api: { activeDeployMode: 'express' } }))).toEqual([]);
    expect(findNonPrebuiltProfiles([profile({ activeDeployMode: 'express' })], branch({ api: { activeDeployMode: 'dev' } })))
      .toMatchObject([{ profileId: 'api', modeId: 'dev', modeLabel: '开发模式' }]);
  });

  it('pending 预演「写入后」的结果：请求想写 dev 就拦，想写 express 就放行', () => {
    const base = profile({ activeDeployMode: 'dev' });
    expect(findNonPrebuiltProfiles([base], branch(), { profileId: 'api', modeId: 'express' })).toEqual([]);
    expect(findNonPrebuiltProfiles([profile({ activeDeployMode: 'express' })], branch(), { profileId: 'api', modeId: 'dev' }))
      .toHaveLength(1);
    // 清空模式（回退基线）：基线没有模式 = 源码构建，拦
    expect(findNonPrebuiltProfiles([profile()], branch(), { profileId: 'api', modeId: undefined }))
      .toMatchObject([{ modeId: '', modeLabel: '源码构建（无部署模式）' }]);
  });

  it('拒绝响应说清被拦服务、当前模式、可切模式与修复命令；没有极速版模式时提示缺口', () => {
    const p = profile({ activeDeployMode: 'static' });
    const rejection = buildPrebuiltGateRejection(project, [p], findNonPrebuiltProfiles([p], branch()), {
      branchId: 'b1', operation: 'deploy',
    });
    expect(rejection.error).toBe(AGENT_PREBUILT_ONLY_ERROR);
    expect(rejection.message).toContain('部署被拦截');
    expect(rejection.message).toContain('API（当前 静态部署，可切 express）');
    expect(rejection.message).toContain('cdscli branch set-mode b1 <profileId> <极速版模式>');
    expect(rejection.violations[0].prebuiltModes).toEqual(['express']);
    expect(rejection.hint).toContain('deployRuntime.prebuilt');

    const bare = profile({ deployModes: { dev: { label: '开发模式' } } });
    const gap = buildPrebuiltGateRejection(project, [bare], findNonPrebuiltProfiles([bare], branch()), {
      operation: 'profile-default',
    });
    expect(gap.message).toContain('该服务没有极速版模式');
    expect(gap.message).toContain('项目默认只能由真人在项目设置页修改');
    expect(gap.hint).toContain('还没接 CI 预构建');
  });

  it('withoutSourceFallback 摘掉源码回退 profile，其余字段原样；没挂回退时返回同一对象', () => {
    const resolved = { ...profile({ prebuiltImage: true }), sourceFallbackProfile: profile({ activeDeployMode: 'static' }) };
    const stripped = withoutSourceFallback(resolved);
    expect(stripped.sourceFallbackProfile).toBeUndefined();
    expect(stripped.prebuiltImage).toBe(true);
    expect(stripped.id).toBe('api');
    const plain = profile();
    expect(withoutSourceFallback(plain)).toBe(plain);
  });

  it('findNonPrebuiltDefaultModes：项目默认里写成源码模式的项被点名，空串按基线判，未知 profile 忽略', () => {
    const p = profile({ activeDeployMode: 'static' });
    expect(findNonPrebuiltDefaultModes([p], { api: 'express' })).toEqual([]);
    expect(findNonPrebuiltDefaultModes([p], { api: 'dev' })).toMatchObject([{ profileId: 'api', modeId: 'dev' }]);
    expect(findNonPrebuiltDefaultModes([p], { api: '' })).toMatchObject([{ profileId: 'api', modeId: '' }]);
    expect(findNonPrebuiltDefaultModes([p], { ghost: 'dev' })).toEqual([]);
  });

  it('显式空串与缺键不同：基线是极速版的 profile，{api: ""} 仍是源码基线（Codex 第四轮 P1）', () => {
    const p = profile({ activeDeployMode: 'express' });
    expect(findNonPrebuiltDefaultModes([p], {}, { coverAllProfiles: true })).toEqual([]);
    expect(findNonPrebuiltDefaultModes([p], { api: '' })).toMatchObject([{ profileId: 'api', modeId: '', modeLabel: '源码构建（无部署模式）' }]);
    expect(findNonPrebuiltProfiles([p], branch(), { profileId: 'api', modeId: undefined })).toHaveLength(1);
  });

  it('listPrebuiltModeIds 与 isPrebuiltMode 同判据：镜像站点上未声明 prebuilt 的模式也算可切', () => {
    const imageSite = profile({ prebuiltImage: true, deployModes: { source: { label: '源码', prebuilt: false, command: 'pnpm build' }, plain: { label: '沿用' } } });
    expect(listPrebuiltModeIds(imageSite)).toEqual(['plain']);
    const rejection = buildPrebuiltGateRejection(project, [imageSite], findNonPrebuiltProfiles([imageSite], branch(), { profileId: 'api', modeId: 'source' }), { operation: 'deploy' });
    expect(rejection.message).toContain('可切 plain');
    expect(rejection.hint).not.toContain('还没接 CI 预构建');
  });

  it('coverAllProfiles：整表替换时表里没有的 profile 也按基线判，空表不能把安全默认换掉', () => {
    const api = profile({ activeDeployMode: 'static' });
    const web = profile({ id: 'web', name: 'Web', activeDeployMode: 'express' });
    expect(findNonPrebuiltDefaultModes([api, web], {})).toEqual([]);
    expect(findNonPrebuiltDefaultModes([api, web], {}, { coverAllProfiles: true })).toMatchObject([{ profileId: 'api', modeId: 'static' }]);
    expect(findNonPrebuiltDefaultModes([api, web], { api: 'express' }, { coverAllProfiles: true })).toEqual([]);
  });
});
