import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  QUICK_RECONNECT_DELAYS_MS,
  STEADY_RECONNECT_DELAY_MS,
  reconnectDelayMs,
  reconnectRemainingSeconds,
} from '../../web/src/lib/cdsReconnectPolicy.js';

const eventsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/hooks/useCdsEvents.ts'),
  'utf8',
);
const badgeSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/GlobalUpdateBadge.tsx'),
  'utf8',
);
const launcherSource = fs.readFileSync(
  path.resolve(process.cwd(), 'exec_cds.sh'),
  'utf8',
);
const supervisorSource = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/cds-supervisor.sh'),
  'utf8',
);

describe('CDS 断线恢复策略', () => {
  it('前三次快速恢复，之后永久保持一分钟级低频探测', () => {
    expect(QUICK_RECONNECT_DELAYS_MS).toEqual([5_000, 10_000, 20_000]);
    expect(reconnectDelayMs(1, () => 0.5)).toBe(5_000);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(10_000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(20_000);
    expect(reconnectDelayMs(4, () => 0.5)).toBe(STEADY_RECONNECT_DELAY_MS);
    expect(reconnectDelayMs(10_000, () => 0.5)).toBe(STEADY_RECONNECT_DELAY_MS);
  });

  it('重连抖动有界，倒计时不会显示负数', () => {
    expect(reconnectDelayMs(4, () => 0)).toBe(51_000);
    expect(reconnectDelayMs(4, () => 1)).toBe(69_000);
    expect(reconnectRemainingSeconds('2026-07-30T00:01:00.000Z', Date.parse('2026-07-30T00:00:01.000Z'))).toBe(59);
    expect(reconnectRemainingSeconds('2026-07-30T00:00:00.000Z', Date.parse('2026-07-30T00:00:01.000Z'))).toBe(0);
  });

  it('断线不会在三次后停摆，网络恢复和回到标签页会立即重连', () => {
    expect(eventsSource).toContain('const delay = reconnectDelayMs(connectAttempt)');
    expect(eventsSource).not.toContain('if (connectAttempt > 3)');
    expect(eventsSource).toContain("window.addEventListener('online', reconnectNow)");
    expect(eventsSource).toContain("document.addEventListener('visibilitychange'");
  });

  it('未知断线与明确重启分开呈现，且不再用全屏遮罩阻断页面', () => {
    expect(badgeSource).toContain("kind: 'unreachable'");
    expect(badgeSource).toContain('CDS 服务不可达');
    expect(badgeSource).toContain('CDS 正在重启');
    expect(badgeSource).not.toContain('createPortal');
    expect(badgeSource).not.toContain('fixed inset-0 z-[150]');
  });

  it('非 systemd 后台启动由 supervisor 托管，child 退出后可重新拉起', () => {
    expect(launcherSource).toContain('启动 CDS (后台保活模式)');
    expect(launcherSource).toContain('scripts/cds-supervisor.sh');
    expect(launcherSource).toContain('CDS_SUPERVISOR_PID_FILE="$SUPERVISOR_PID_FILE"');
    expect(supervisorSource).toContain('while true; do');
    expect(supervisorSource).toContain('child exited code=$rc');
    expect(supervisorSource).toContain('RESTART_DELAY_SEC');
    expect(supervisorSource).toContain('RAPID_FAILURE_LIMIT');
    expect(supervisorSource).toContain('避免配置错误重启风暴');
    expect(supervisorSource).toContain('$CDS_ROOT/cds/.cds.env');
  });
});
