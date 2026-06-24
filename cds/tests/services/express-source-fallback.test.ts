import { describe, expect, it } from 'vitest';
import { pickSourceFallbackMode } from '../../src/services/container.js';
import type { DeployModeOverride } from '../../src/types.js';

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

  it('无 command 的模式被排除（无法源码构建）', () => {
    const modes: Record<string, DeployModeOverride> = {
      express: mode({ prebuilt: true }),
      empty: mode({ command: '   ' }), // 空白 command 视为无
    };
    expect(pickSourceFallbackMode(modes, 'express')).toBeNull();
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
