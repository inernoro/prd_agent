/**
 * Canvas 图层操作测试
 * 
 * 运行方式：pnpm -C prd-admin test canvasLayerUtils
 */

import { describe, it, expect } from 'vitest';
import {
  moveUp,
  moveDown,
  bringToFront,
  sendToBack,
  canMoveUp,
  canMoveDown,
} from '../canvasLayerUtils';

describe('图层操作测试', () => {
  // 测试数据：模拟 canvas 数组
  // 数组顺序 = 渲染顺序，后面的在上层
  const createCanvas = () => [
    { key: 'a', name: 'A' }, // 底层 (index 0)
    { key: 'b', name: 'B' }, // (index 1)
    { key: 'c', name: 'C' }, // (index 2)
    { key: 'd', name: 'D' }, // 顶层 (index 3)
  ];

  const getKeys = (items: { key: string }[]) => items.map((it) => it.key);

  describe('moveUp - 上移一层', () => {
    it('中间元素上移一层', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['b']);
      // b 从 index 1 移到 index 2，与 c 交换位置
      expect(getKeys(result)).toEqual(['a', 'c', 'b', 'd']);
    });

    it('底层元素上移一层', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['a']);
      // a 从 index 0 移到 index 1，与 b 交换位置
      expect(getKeys(result)).toEqual(['b', 'a', 'c', 'd']);
    });

    it('已在顶层的元素上移无效果', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['d']);
      // d 已经在顶层，无法再上移
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('多选上移：不相邻的元素', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['a', 'c']);
      // a 和 c 各自上移一层
      // a: 0->1, c: 2->3
      // 结果: [b, a, d, c]
      expect(getKeys(result)).toEqual(['b', 'a', 'd', 'c']);
    });

    it('多选上移：相邻元素保持相对顺序', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['a', 'b']);
      // a 和 b 相邻，作为整体上移
      // 结果: [c, a, b, d]
      expect(getKeys(result)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('多选上移：包含顶层元素时部分有效', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, ['c', 'd']);
      // d 在顶层无法上移，c 也无法上移（因为上面是 d）
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('空数组返回空数组', () => {
      const result = moveUp([], ['a']);
      expect(result).toEqual([]);
    });

    it('空选中返回原数组', () => {
      const canvas = createCanvas();
      const result = moveUp(canvas, []);
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('moveDown - 下移一层', () => {
    it('中间元素下移一层', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['c']);
      // c 从 index 2 移到 index 1，与 b 交换位置
      expect(getKeys(result)).toEqual(['a', 'c', 'b', 'd']);
    });

    it('顶层元素下移一层', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['d']);
      // d 从 index 3 移到 index 2，与 c 交换位置
      expect(getKeys(result)).toEqual(['a', 'b', 'd', 'c']);
    });

    it('已在底层的元素下移无效果', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['a']);
      // a 已经在底层，无法再下移
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('多选下移：不相邻的元素', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['b', 'd']);
      // b 和 d 各自下移一层
      // b: 1->0, d: 3->2
      // 结果: [b, a, d, c]
      expect(getKeys(result)).toEqual(['b', 'a', 'd', 'c']);
    });

    it('多选下移：相邻元素保持相对顺序', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['c', 'd']);
      // c 和 d 相邻，作为整体下移
      // 结果: [a, c, d, b]
      expect(getKeys(result)).toEqual(['a', 'c', 'd', 'b']);
    });

    it('多选下移：包含底层元素时部分有效', () => {
      const canvas = createCanvas();
      const result = moveDown(canvas, ['a', 'b']);
      // a 在底层无法下移，b 也无法下移（因为下面是 a）
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('bringToFront - 置于顶层', () => {
    it('单个元素置于顶层', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['a']);
      // a 移到顶层
      expect(getKeys(result)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('中间元素置于顶层', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['b']);
      expect(getKeys(result)).toEqual(['a', 'c', 'd', 'b']);
    });

    it('已在顶层的元素置顶无效果', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['d']);
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('多选置于顶层保持相对顺序', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['a', 'b']);
      // a 和 b 移到顶层，保持 a 在 b 前面的相对顺序
      expect(getKeys(result)).toEqual(['c', 'd', 'a', 'b']);
    });

    it('多选置于顶层：不相邻元素', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['a', 'c']);
      // a 和 c 移到顶层，保持相对顺序
      expect(getKeys(result)).toEqual(['b', 'd', 'a', 'c']);
    });

    it('选中所有元素置顶无效果', () => {
      const canvas = createCanvas();
      const result = bringToFront(canvas, ['a', 'b', 'c', 'd']);
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('sendToBack - 置于底层', () => {
    it('单个元素置于底层', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['d']);
      // d 移到底层
      expect(getKeys(result)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('中间元素置于底层', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['c']);
      expect(getKeys(result)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('已在底层的元素置底无效果', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['a']);
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('多选置于底层保持相对顺序', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['c', 'd']);
      // c 和 d 移到底层，保持 c 在 d 前面的相对顺序
      expect(getKeys(result)).toEqual(['c', 'd', 'a', 'b']);
    });

    it('多选置于底层：不相邻元素', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['b', 'd']);
      // b 和 d 移到底层，保持相对顺序
      expect(getKeys(result)).toEqual(['b', 'd', 'a', 'c']);
    });

    it('选中所有元素置底无效果', () => {
      const canvas = createCanvas();
      const result = sendToBack(canvas, ['a', 'b', 'c', 'd']);
      expect(getKeys(result)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('canMoveUp - 检查是否可以上移', () => {
    it('顶层元素不可上移', () => {
      const canvas = createCanvas();
      expect(canMoveUp(canvas, ['d'])).toBe(false);
    });

    it('非顶层元素可上移', () => {
      const canvas = createCanvas();
      expect(canMoveUp(canvas, ['a'])).toBe(true);
      expect(canMoveUp(canvas, ['b'])).toBe(true);
      expect(canMoveUp(canvas, ['c'])).toBe(true);
    });

    it('多选包含顶层元素不可上移', () => {
      const canvas = createCanvas();
      expect(canMoveUp(canvas, ['c', 'd'])).toBe(false);
    });

    it('多选不包含顶层元素可上移', () => {
      const canvas = createCanvas();
      expect(canMoveUp(canvas, ['a', 'b'])).toBe(true);
    });

    it('空数组不可上移', () => {
      expect(canMoveUp([], ['a'])).toBe(false);
    });

    it('空选中不可上移', () => {
      const canvas = createCanvas();
      expect(canMoveUp(canvas, [])).toBe(false);
    });
  });

  describe('canMoveDown - 检查是否可以下移', () => {
    it('底层元素不可下移', () => {
      const canvas = createCanvas();
      expect(canMoveDown(canvas, ['a'])).toBe(false);
    });

    it('非底层元素可下移', () => {
      const canvas = createCanvas();
      expect(canMoveDown(canvas, ['b'])).toBe(true);
      expect(canMoveDown(canvas, ['c'])).toBe(true);
      expect(canMoveDown(canvas, ['d'])).toBe(true);
    });

    it('多选包含底层元素不可下移', () => {
      const canvas = createCanvas();
      expect(canMoveDown(canvas, ['a', 'b'])).toBe(false);
    });

    it('多选不包含底层元素可下移', () => {
      const canvas = createCanvas();
      expect(canMoveDown(canvas, ['c', 'd'])).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('单元素数组无法移动', () => {
      const canvas = [{ key: 'only' }];
      expect(getKeys(moveUp(canvas, ['only']))).toEqual(['only']);
      expect(getKeys(moveDown(canvas, ['only']))).toEqual(['only']);
      expect(getKeys(bringToFront(canvas, ['only']))).toEqual(['only']);
      expect(getKeys(sendToBack(canvas, ['only']))).toEqual(['only']);
    });

    it('选中不存在的 key 无效果', () => {
      const canvas = createCanvas();
      expect(getKeys(moveUp(canvas, ['nonexistent']))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('不修改原数组（不可变）', () => {
      const canvas = createCanvas();
      const original = [...canvas];
      moveUp(canvas, ['a']);
      expect(canvas).toEqual(original);
    });
  });
});
