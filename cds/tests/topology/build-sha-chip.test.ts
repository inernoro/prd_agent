/**
 * Dashboard 顶部 build SHA 常驻 chip — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 6.2 / 6.3
 * 实现位置(尚未存在):cds/web/src/components/BuildShaChip.tsx
 *
 * Dashboard 顶栏始终显示当前 active daemon 的 buildSha + color,
 * 与 git HEAD 不一致时变红 + tooltip 提示"漂移"。
 */
import { describe, it } from 'vitest';

describe('BuildShaChip 渲染', () => {
  it.todo('[C-6.2] gitHead === activeDaemonSha 时,chip 显示 "build: <8位 sha> · <color>"');
  it.todo('[C-6.2] color=blue 时蓝色背景,color=green 时青色背景');
  it.todo('[C-6.2] hover tooltip 包含完整 git head + active port + uptime');
  it.todo('[C-6.2] 点击 chip 跳转到 /cds-settings#maintenance');
});

describe('漂移检测', () => {
  it.todo('[C-6.3] gitHead !== activeDaemonSha 时,chip 变红 + 闪烁 1 次');
  it.todo('[C-6.3] tooltip 文案:"git HEAD: A · 当前部署: B · 漂移 N 个 commit"');
  it.todo('[C-6.3] 漂移时点击 chip 跳到 /cds-settings#maintenance 并 highlight self-update 按钮');
  it.todo('[C-6.3] 漂移检测每 30 秒刷新一次');
});

describe('Standby 状态', () => {
  it.todo('[C-6.2] 当前是 standby 时,chip 显示 "standby · <color>" 灰色背景');
  it.todo('[C-6.2] 双 daemon 都活着的短窗口里(切换中),chip 显示 "切换中"');
});

describe('数据来源', () => {
  it.todo('[C-6.2] 数据走 /api/self-status,30 秒轮询');
  it.todo('[C-6.2] self-status 失败时 chip 显示 "离线" + 红色');
});
