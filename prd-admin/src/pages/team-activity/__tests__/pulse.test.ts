import { describe, expect, it } from 'vitest';
import { aggregateConsecutive, maskName, maskTitle, rotateHourlyToLocal } from '../pulse';
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

describe('maskTitle / maskName 隐私脱敏', () => {
  it('长标题保留首尾字、中间打码', () => {
    expect(maskTitle('全球运动鞋服行业商业模式变革')).toBe('全***革');
  });
  it('短标题只保留首字', () => {
    expect(maskTitle('周报')).toBe('周***');
    expect(maskTitle('A')).toBe('A*');
    expect(maskTitle('')).toBe('');
  });
  it('姓名保留姓氏', () => {
    expect(maskName('周泽腾')).toBe('周**');
    expect(maskName('')).toBe('');
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
