import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { floatingPanelPosition } from '../../web/src/lib/floatingPanelPosition.js';

const informationCenterSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/SiteNoticeInbox.tsx'),
  'utf8',
);

describe('信息中心视口碰撞定位', () => {
  it('靠左宿主不会再把 520px 面板推到负坐标', () => {
    const position = floatingPanelPosition(
      { left: 183, bottom: 46 },
      { width: 1104, height: 989 },
    );

    expect(position).toMatchObject({ left: 183, top: 54, width: 520 });
    expect(position.left).toBeGreaterThanOrEqual(8);
    expect(position.left + position.width).toBeLessThanOrEqual(1096);
  });

  it('手机宽度下左右各保留 8px，不依赖铃铛位于哪一侧', () => {
    const position = floatingPanelPosition(
      { left: 300, bottom: 56 },
      { width: 375, height: 667 },
    );

    expect(position).toMatchObject({ left: 8, top: 64, width: 359, maxHeight: 595 });
  });

  it('靠右宿主会自动向左收回视口', () => {
    const position = floatingPanelPosition(
      { left: 1360, bottom: 56 },
      { width: 1440, height: 900 },
    );

    expect(position).toMatchObject({ left: 912, top: 64, width: 520 });
    expect(position.left + position.width).toBe(1432);
  });

  it('面板挂到 body 并使用 fixed 定位，避免顶部栏包含块继续裁切', () => {
    expect(informationCenterSource).toContain('data-testid="cds-information-center-panel"');
    expect(informationCenterSource).toContain('className="fixed z-[220]');
    expect(informationCenterSource).toContain('), document.body)');
    expect(informationCenterSource).not.toContain('absolute right-0 top-full');
  });
});
