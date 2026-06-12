import { describe, expect, it } from 'vitest';
import { aggregateConsecutive, maskName, rotateHourlyToLocal, smoothAreaPath } from '../pulse';
import type { TeamActivityItem } from '@/services/contracts/teamActivity';

function item(over: Partial<TeamActivityItem>): TeamActivityItem {
  return {
    id: Math.random().toString(36).slice(2),
    actorId: 'u1',
    module: 'visual-agent',
    moduleLabel: '视觉创作',
    action: 'ImageGen.CreateRun',
    actionLabel: '发起了图片生成',
    createdAt: '2026-06-12T03:00:00Z',
    ...over,
  };
}

describe('maskName 隐私脱敏（标题按业界惯例全文显示，只脱敏人名）', () => {
  it('姓名保留姓氏', () => {
    expect(maskName('周泽腾')).toBe('周**');
    expect(maskName('')).toBe('');
  });
});

describe('smoothAreaPath 平滑面积曲线', () => {
  it('生成 Bezier line 与闭合 area', () => {
    const { line, area } = smoothAreaPath([0, 5, 2, 8], 240, 48);
    expect(line.startsWith('M ')).toBe(true);
    expect(line).toContain(' C ');
    expect(area.endsWith('Z')).toBe(true);
    expect(area.startsWith(line)).toBe(true);
  });
  it('全零数据画在底边附近且不越界', () => {
    const { line } = smoothAreaPath([0, 0, 0], 100, 40, 2);
    const ys = [...line.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.every((y) => y >= 0 && y <= 40)).toBe(true);
    expect(ys.every((y) => y === 38)).toBe(true);
  });
  it('空数组返回空串', () => {
    expect(smoothAreaPath([], 100, 40)).toEqual({ line: '', area: '' });
  });
});

describe('aggregateConsecutive 连续同类动作折叠', () => {
  it('同人同模块同动作的相邻条目折叠为一条并累计次数', () => {
    const items = [
      item({ id: 'a', targetTitle: '标题一' }),
      item({ id: 'b', targetTitle: '标题一' }),
      item({ id: 'c', targetTitle: '标题二' }),
    ];
    const out = aggregateConsecutive(items);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].titles).toEqual(['标题一', '标题二']);
    expect(out[0].id).toBe('a');
  });

  it('不同人 / 不同动作打断折叠', () => {
    const items = [
      item({ id: 'a', actorId: 'u1' }),
      item({ id: 'b', actorId: 'u2' }),
      item({ id: 'c', actorId: 'u1', action: 'ImageMaster.CreateWorkspace', actionLabel: '创建了工作区' }),
    ];
    const out = aggregateConsecutive(items);
    expect(out).toHaveLength(3);
    expect(out.every((g) => g.count === 1)).toBe(true);
  });

  it('标题去重且最多保留 3 个', () => {
    const items = ['一', '二', '三', '四', '四'].map((t, i) => item({ id: String(i), targetTitle: t }));
    const out = aggregateConsecutive(items);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(5);
    expect(out[0].titles).toEqual(['一', '二', '三']);
  });
});

describe('rotateHourlyToLocal 时区旋转', () => {
  it('UTC+8：UTC 0 点的计数落到本地 8 点', () => {
    const utc = new Array(24).fill(0);
    utc[0] = 7;
    const local = rotateHourlyToLocal(utc, 480);
    expect(local[8]).toBe(7);
    expect(local.reduce((a, b) => a + b, 0)).toBe(7);
  });
  it('UTC+0 原样返回', () => {
    const utc = Array.from({ length: 24 }, (_, i) => i);
    expect(rotateHourlyToLocal(utc, 0)).toEqual(utc);
  });
});
