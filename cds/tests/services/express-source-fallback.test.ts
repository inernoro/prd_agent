import { describe, expect, it } from 'vitest';
import { pickSourceFallbackMode, resolveEffectiveProfile } from '../../src/services/container.js';
import type { BuildProfile, BranchEntry, DeployModeOverride } from '../../src/types.js';

/**
 * 极速版镜像缺失 → 自动回退源码编译（用户 2026-06-24 决策，治「极速版永远不极速 / 打不开」）。
 * CI path-filter 只构建改动组件 → 不同时改 api+admin 的分支必缺 ≥1 个 sha 镜像 → express 404。
 * pickSourceFallbackMode 从 deployModes 里挑一个带 command 的非 prebuilt 模式做回退。
 */
const mode = (over: Partial<DeployModeOverride>): DeployModeOverride => ({
  label: over.label ?? 'm',
  ...over,
});

describe('pickSourceFallbackMode', () => {
  it('挑非 prebuilt 且带 command 的模式，优先 static', () => {
    const modes: Record<string, DeployModeOverride> = {
      dev: mode({ command: 'pnpm dev' }),
      static: mode({ command: 'pnpm build && serve' }),
      express: mode({ prebuilt: true }),
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBe('static');
  });

  it('没有 static 时退而取 dev', () => {
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true }),
      dev: mode({ command: 'pnpm dev' }),
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBe('dev');
  });

  it('跳过当前（失败的）模式自身', () => {
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true, command: 'x' }), // 即便带 command 也因 prebuilt 被排除
      source: mode({ command: 'make run' }),
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBe('source');
  });

  it('prebuilt 模式被排除（即使带 command）', () => {
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true, command: 'serve' }),
      alsoPrebuilt: mode({ prebuilt: true, command: 'serve2' }),
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBeNull();
  });

  it('不要求模式自带 command（可继承 baseline，Codex P2）', () => {
    // 模式只覆盖元数据/env、command 继承 baseline 的合法配置：pickSourceFallbackMode 仍选它，
    // command 是否解析得到交给下游 resolveEffectiveProfile 的 srcProfile.command 检查兜底。
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true }),
      static: mode({}), // 无自带 command（继承 baseline）
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBe('static');
  });

  it('无 deployModes / 无可回退 → null（调用方维持硬失败，不假装能跑）', () => {
    expect(pickSourceFallbackMode(undefined, 'express')).toBeNull();
    expect(pickSourceFallbackMode({}, 'express')).toBeNull();
  });

  it('非优先名也能兜底（取第一个满足的）', () => {
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true }),
      custom: mode({ command: 'run.sh' }),
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBe('custom');
  });
});

/**
 * 回归：resolveEffectiveProfile 解析出极速版 profile 时，必须把源码回退 profile 从
 * **baseline** 解析好挂在 sourceFallbackProfile 上 —— dockerImage 是源码基础镜像
 * (dotnet-sdk)，不能误继承极速版的 sha 镜像（这正是 2026-06-24 首版 bug：原地从极速版
 * profile 切换导致 docker run 拿 sha 镜像 not found）。
 */
describe('resolveEffectiveProfile 极速版 → 附带源码回退 profile', () => {
  // 仿真 prd-agent 真实结构：baseline=dotnet sdk + 源码命令；static 继承 baseline 镜像；
  // express 覆盖成 sha 镜像 + prebuilt + 8080。
  const baseline: BuildProfile = {
    id: 'api-prd-agent',
    name: 'api',
    dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
    command: 'cd prd-api && dotnet run --urls http://0.0.0.0:5000',
    containerPort: 5000,
    activeDeployMode: 'express',
    deployModes: {
      static: { label: '源码', command: 'cd prd-api && dotnet build && dotnet run' },
      express: {
        label: '极速',
        prebuilt: true,
        dockerImage: 'ghcr.io/inernoro/prd_agent/prdagent-server:sha-${CDS_COMMIT_SHA}',
        containerPort: 8080,
      },
    },
  } as BuildProfile;
  const branch = { githubCommitSha: 'eeba7bf14abc' } as BranchEntry;

  it('极速版 profile 拿到 sha 镜像 + prebuilt', () => {
    const eff = resolveEffectiveProfile(baseline, branch);
    expect(eff.prebuiltImage).toBe(true);
    expect(eff.dockerImage).toContain('sha-eeba7bf14abc');
  });

  it('分支 override 锁 express 时仍挂非 prebuilt 源码回退（生产复现回归）', () => {
    // 生产里 express 是经 branch.profileOverrides 设的；旧实现递归解析会被 override 再次
    // 锁回 express，回退 profile 变 prebuilt 被拒 → 永不挂载 → runService 报「无源码模式」。
    const baselineStatic: BuildProfile = { ...baseline, activeDeployMode: 'static', containerPort: 5000 } as BuildProfile;
    // 生产真实形态：override 把极速版的值都 pin 了 —— activeDeployMode=express、
    // containerPort=null（极速版端口走 mode）、dockerImage=sha 模板。这些并进源码构建会坏。
    const branchWithOverride = {
      githubCommitSha: 'abc1234',
      profileOverrides: {
        'api-prd-agent': {
          activeDeployMode: 'express',
          containerPort: null,
          dockerImage: 'ghcr.io/inernoro/prd_agent/prdagent-server:sha-${CDS_COMMIT_SHA}',
          command: '',
        },
      },
    } as unknown as BranchEntry;
    const eff = resolveEffectiveProfile(baselineStatic, branchWithOverride);
    expect(eff.prebuiltImage).toBe(true); // override 生效 → 极速版
    const src = eff.sourceFallbackProfile;
    expect(src).toBeTruthy(); // 关键：仍挂上了源码回退
    expect(src!.prebuiltImage).toBeFalsy();
    expect(src!.dockerImage).toBe('mcr.microsoft.com/dotnet/sdk:8.0'); // baseline 源码镜像，非 sha
    expect(src!.dockerImage).not.toContain('ghcr.io');
    expect(src!.containerPort).toBe(5000); // baseline 端口，**非 override 的 null**
    expect(src!.command).toContain('dotnet'); // 源码命令，非 override 的空
    expect(src!.activeDeployMode).toBe('static');
  });

  it('sourceFallbackProfile 用 baseline 源码镜像，不是 sha 镜像（核心回归）', () => {
    const eff = resolveEffectiveProfile(baseline, branch);
    const src = eff.sourceFallbackProfile;
    expect(src).toBeTruthy();
    expect(src!.prebuiltImage).toBeFalsy();
    expect(src!.dockerImage).toBe('mcr.microsoft.com/dotnet/sdk:8.0'); // 不是 sha 镜像！
    expect(src!.dockerImage).not.toContain('ghcr.io');
    expect(src!.containerPort).toBe(5000); // 不是极速版的 8080
    expect(src!.command).toContain('dotnet'); // 源码构建命令
    expect(src!.activeDeployMode).toBe('static');
  });

  it('源码模式自身不再嵌套 sourceFallbackProfile（递归一层即止）', () => {
    const eff = resolveEffectiveProfile(baseline, branch);
    expect(eff.sourceFallbackProfile?.sourceFallbackProfile).toBeUndefined();
  });

  it('无极速版（纯源码 profile）不附带回退', () => {
    const src: BuildProfile = { ...baseline, activeDeployMode: 'static' } as BuildProfile;
    const eff = resolveEffectiveProfile(src, branch);
    expect(eff.prebuiltImage).toBeFalsy();
    expect(eff.sourceFallbackProfile).toBeUndefined();
  });

  it('baseline 自带 prebuiltImage:true 也不无限递归（CDS 崩溃回归）', () => {
    // 这是真实把 CDS 打成 200/502 flapping 的触发条件：baseline.prebuiltImage=true 时，
    // 旧实现递归解析源码 profile 仍是 prebuilt → 无限递归爆栈阻塞事件循环。
    const prebuiltBaseline: BuildProfile = {
      ...baseline,
      prebuiltImage: true,
      command: '', // prebuilt 常无 command
    } as BuildProfile;
    // 不抛栈溢出即通过
    const eff = resolveEffectiveProfile(prebuiltBaseline, branch);
    expect(eff).toBeTruthy();
    // 源码回退（若有）必须是非 prebuilt，且不再嵌套
    expect(eff.sourceFallbackProfile?.prebuiltImage).toBeFalsy();
    expect(eff.sourceFallbackProfile?.sourceFallbackProfile).toBeUndefined();
  });
});
