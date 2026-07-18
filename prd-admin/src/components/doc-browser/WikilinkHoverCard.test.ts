import { describe, expect, it } from 'vitest';
import { reduceWikilinkHover, type WikilinkHoverState } from './WikilinkHoverCard';

const shown: WikilinkHoverState = {
  title: '第 1 章：从零认识 CDS',
  x: 180,
  y: 120,
  exists: true,
};

describe('WikilinkHoverCard 状态收敛', () => {
  it('悬停时展示当前目标', () => {
    expect(reduceWikilinkHover(null, { type: 'show', hover: shown })).toEqual(shown);
  });

  it('双链点击导致原节点卸载时仍主动关闭预览', () => {
    expect(reduceWikilinkHover(shown, { type: 'dismiss' })).toBeNull();
  });
});
