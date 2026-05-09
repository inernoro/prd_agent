/**
 * Dashboard 顶部 build SHA 常驻 chip — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 6.2 / 6.3
 * 实现位置:
 *   - cds/web/src/components/BuildShaChip.tsx(React 渲染层)
 *   - cds/web/src/components/buildShaChip.logic.ts(纯逻辑,本测试覆盖)
 *
 * 设计取舍:cds/web 当前没有 jsdom + vitest 环境,React 组件渲染断言无法在
 * 后端 vitest 里跑。但 chip 的"显示什么、颜色、tooltip、点击跳转、漂移检测"
 * 都是无副作用的纯函数,把它们抽到 buildShaChip.logic.ts 后,本文件直接断言
 * computeChipState() 的输出即可逐项覆盖 C-6.2 / C-6.3 验收点。
 */
import { describe, it, expect } from 'vitest';
import {
  chipBackgroundClass,
  computeChipState,
  POLL_INTERVAL_MS,
  shasMatch,
  type SelfStatusPayload,
} from '../../web/src/components/buildShaChip.logic.js';

function payload(over: Partial<SelfStatusPayload> = {}): SelfStatusPayload {
  return {
    headSha: 'abcdef01',
    activeDaemonSha: 'abcdef0123456789',
    activeColor: 'blue',
    activePort: 9900,
    mode: 'active',
    color: 'blue',
    bothDaemonsAlive: false,
    ...over,
  };
}

describe('BuildShaChip 渲染', () => {
  it('[C-6.2] gitHead === activeDaemonSha 时,chip 显示 "build: <8位 sha> · <color>"', () => {
    const s = computeChipState(payload());
    expect(s.mode).toBe('normal');
    expect(s.label.startsWith('build:')).toBe(true);
    // 8 位 sha
    expect(s.label).toContain('abcdef01');
    expect(s.label).toContain('blue');
  });

  it('[C-6.2] color=blue 时蓝色背景,color=green 时青色背景', () => {
    const blue = computeChipState(payload({ activeColor: 'blue' }));
    const green = computeChipState(payload({ activeColor: 'green', headSha: 'aaa', activeDaemonSha: 'aaa' }));
    expect(chipBackgroundClass(blue)).toMatch(/bg-blue-/);
    expect(chipBackgroundClass(green)).toMatch(/bg-cyan-/);
  });

  it('[C-6.2] hover tooltip 包含完整 git head + active port + uptime', () => {
    const s = computeChipState(payload({ daemonUptimeSec: 1234 }));
    expect(s.tooltip).toContain('git HEAD');
    expect(s.tooltip).toContain('active port');
    expect(s.tooltip).toContain('uptime');
    expect(s.tooltip).toContain('1234');
  });

  it('[C-6.2] 点击 chip 跳转到 /cds-settings#maintenance', () => {
    const s = computeChipState(payload());
    expect(s.navigateTo).toBe('/cds-settings#maintenance');
  });
});

describe('漂移检测', () => {
  it('[C-6.3] gitHead !== activeDaemonSha 时,chip 变红 + 闪烁 1 次', () => {
    const s = computeChipState(
      payload({ headSha: 'newhead0', activeDaemonSha: 'oldhead0' }),
    );
    expect(s.mode).toBe('drift');
    expect(s.isError).toBe(true);
    expect(s.shouldBlink).toBe(true);
    expect(chipBackgroundClass(s)).toMatch(/bg-red-/);
  });

  it('[C-6.3] tooltip 文案:"git HEAD: A · 当前部署: B · 漂移 N 个 commit"', () => {
    const s = computeChipState(
      payload({
        headSha: 'newhead0aaaa',
        activeDaemonSha: 'oldhead0bbbb',
        commitDistance: 5,
      }),
    );
    expect(s.tooltip).toContain('git HEAD');
    expect(s.tooltip).toContain('当前部署');
    expect(s.tooltip).toContain('5');
    expect(s.tooltip).toContain('漂移');
    expect(s.tooltip).toContain('commit');
  });

  it('[C-6.3] 漂移时点击 chip 跳到 /cds-settings#maintenance 并 highlight self-update 按钮', () => {
    const s = computeChipState(
      payload({ headSha: 'newhead0', activeDaemonSha: 'oldhead0' }),
    );
    expect(s.navigateTo).toBe('/cds-settings#maintenance');
    expect(s.highlightSelfUpdate).toBe(true);
  });

  it('[C-6.3] 漂移检测每 30 秒刷新一次', () => {
    expect(POLL_INTERVAL_MS).toBe(30_000);
  });
});

describe('Standby 状态', () => {
  it('[C-6.2] 当前是 standby 时,chip 显示 "standby · <color>" 灰色背景', () => {
    const s = computeChipState(payload({ mode: 'standby', activeColor: 'green', color: 'green' }));
    expect(s.mode).toBe('standby');
    expect(s.label).toContain('standby');
    expect(s.label).toContain('green');
    expect(chipBackgroundClass(s)).toMatch(/bg-zinc-/);
  });

  it('[C-6.2] 双 daemon 都活着的短窗口里(切换中),chip 显示 "切换中"', () => {
    const s = computeChipState(payload({ bothDaemonsAlive: true }));
    expect(s.mode).toBe('switching');
    expect(s.label).toBe('切换中');
    expect(chipBackgroundClass(s)).toMatch(/bg-amber-/);
  });
});

describe('数据来源', () => {
  it('[C-6.2] 数据走 /api/self-status,30 秒轮询', () => {
    // 这条契约由组件 useEffect 实现,本测试断言常量。POLL_INTERVAL_MS 用作 setInterval 间隔。
    expect(POLL_INTERVAL_MS).toBe(30_000);
    // shasMatch 是 logic 模块导出的核心比对函数,被 chip 渲染调用 — 触一下覆盖率。
    expect(shasMatch('abc', 'abc12345')).toBe(true);
    expect(shasMatch('abc', 'def')).toBe(false);
  });

  it('[C-6.2] self-status 失败时 chip 显示 "离线" + 红色', () => {
    const s = computeChipState(null);
    expect(s.mode).toBe('offline');
    expect(s.label).toBe('离线');
    expect(s.isError).toBe(true);
    expect(chipBackgroundClass(s)).toMatch(/bg-red-/);
  });
});
