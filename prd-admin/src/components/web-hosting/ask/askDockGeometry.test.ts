import { describe, expect, it } from 'vitest';
import { askBarWidth, askDockGeometry, askHintsBottom, askMetaBottom, type AskDockViewport } from './askDockGeometry';

const desktop: AskDockViewport = { width: 1440, height: 900, isMobile: false, safeBottom: 0 };
/** 平板竖屏这一档：还不算手机，但 660 已经放不下了 */
const narrow: AskDockViewport = { width: 620, height: 900, isMobile: false, safeBottom: 0 };
const phone: AskDockViewport = { width: 375, height: 812, isMobile: true, safeBottom: 34 };

describe('提问坞几何', () => {
  it('起手长条在桌面端水平居中 —— 原型里按错误的舞台宽算过一次，整条偏了 24px', () => {
    const bar = askDockGeometry('bar', desktop);
    // right 是距右缘，居中即「右缘留白 == 左缘留白」
    expect(bar.right).toBe(Math.round((desktop.width - bar.width) / 2));
    expect(desktop.width - bar.right - bar.width).toBe(bar.right);
  });

  it('长条不会溢出视口，窄屏跟着收', () => {
    for (const v of [desktop, narrow, phone]) {
      const bar = askDockGeometry('bar', v);
      expect(bar.right).toBeGreaterThanOrEqual(0);
      expect(bar.right + bar.width).toBeLessThanOrEqual(v.width);
    }
    expect(askBarWidth(narrow)).toBeLessThan(askBarWidth(desktop));
  });

  it('对话栏不会宽过视口；手机端整屏接管', () => {
    expect(askDockGeometry('chat', desktop).width).toBe(400);
    expect(askDockGeometry('chat', phone)).toMatchObject({ width: 375, height: 812, right: 0, radius: '0px' });
    const chatNarrow = askDockGeometry('chat', { ...desktop, width: 420 });
    expect(chatNarrow.width).toBeLessThanOrEqual(420);
  });

  it('收起态与起手态都让开手势条 —— 主操作落进 iOS 手势条就等于点不到', () => {
    expect(askDockGeometry('collapsed', phone).bottom).toBeGreaterThanOrEqual(phone.safeBottom);
    expect(askDockGeometry('bar', phone).bottom).toBeGreaterThanOrEqual(phone.safeBottom);
    expect(askMetaBottom(phone)).toBeGreaterThanOrEqual(phone.safeBottom);
    // 桌面端没有手势条，不该凭空多出一段空隙
    expect(askDockGeometry('collapsed', desktop).bottom).toBe(18);
  });

  it('提示条压在长条正上方，不叠在它身上', () => {
    const bar = askDockGeometry('bar', desktop);
    expect(askHintsBottom(desktop)).toBeGreaterThan(bar.bottom + bar.height);
  });

  it('竖条与对话栏都贴满视口高度（折起来不该只剩半截）', () => {
    expect(askDockGeometry('rail', desktop).height).toBe(desktop.height);
    expect(askDockGeometry('chat', desktop).height).toBe(desktop.height);
  });
});
