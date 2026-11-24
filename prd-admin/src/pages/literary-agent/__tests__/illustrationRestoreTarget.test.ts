import { describe, expect, it } from 'vitest';
import { planRestore } from '../illustrationRestoreTarget';

const data = {
  markerIndexes: [0, 1, 2],
  markers: [
    { index: 0, description: '书店门口' },
    { index: 1, description: '窗边打盹的橘猫，阳光斜斜地照在书架上' },
    { index: 2, description: '茶杯' },
  ],
};

describe('历史配图放回到哪', () => {
  it('原位置还在：默认放回原位置，下拉里标出原位置', () => {
    const plan = planRestore(data, { isCurrent: false, markerIndex: 1 });
    expect(plan.restorable).toBe(true);
    expect(plan.defaultTarget).toBe(1);
    expect(plan.showPicker).toBe(true);
    expect(plan.options.find((o) => o.index === 1)?.label).toContain('（原位置）');
    expect(plan.options.find((o) => o.index === 0)?.label).not.toContain('原位置');
  });

  it('改稿后原位置不在了：仍可放回，但不预选，要人挑一个位置', () => {
    const plan = planRestore(data, { isCurrent: false, markerIndex: 5 });
    expect(plan.restorable).toBe(true);
    expect(plan.defaultTarget).toBeUndefined();
    expect(plan.options.map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it('没记位置的早期图：同样可以放回任意位置', () => {
    const plan = planRestore(data, { isCurrent: false, markerIndex: null });
    expect(plan.restorable).toBe(true);
    expect(plan.defaultTarget).toBeUndefined();
  });

  it('当前只有一个位置：不显示下拉，直接放回那一个', () => {
    const plan = planRestore({ markerIndexes: [3], markers: [{ index: 3, description: '灯塔' }] }, { isCurrent: false, markerIndex: null });
    expect(plan.showPicker).toBe(false);
    expect(plan.defaultTarget).toBe(3);
  });

  it('正在使用的图、或当前方案没有任何位置：不提供放回', () => {
    expect(planRestore(data, { isCurrent: true, markerIndex: 0 }).restorable).toBe(false);
    expect(planRestore({ markerIndexes: [], markers: [] }, { isCurrent: false, markerIndex: 0 }).restorable).toBe(false);
  });

  it('下拉选项带上该位置现在的描述，过长时截断，让人看清选的是哪一段', () => {
    const plan = planRestore(data, { isCurrent: false, markerIndex: 0 });
    const cat = plan.options.find((o) => o.index === 1)!;
    expect(cat.label.startsWith('配图 2 · 窗边打盹的橘猫')).toBe(true);
    expect(cat.label).toContain('…');
    expect(cat.description).toBe('窗边打盹的橘猫，阳光斜斜地照在书架上');
  });
});
