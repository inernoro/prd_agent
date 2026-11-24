import { expect, it } from 'vitest';
import { callMapLayout } from './callMapLayout';
it('面积严格对应调用记录占比，过滤零值且不修改原顺序', () => {
  const input = [0, 2, 5, 3];
  const cells = callMapLayout(input, (value) => value);
  expect(input).toEqual([0, 2, 5, 3]);
  expect(cells).toHaveLength(3);
  for (const cell of cells) {
    expect((cell.width * cell.height) / 10000).toBeCloseTo(cell.item / 10);
    expect(cell.x + cell.width).toBeLessThanOrEqual(100.00001);
    expect(cell.y + cell.height).toBeLessThanOrEqual(100.00001);
  }
  expect(callMapLayout([0, 0], (value) => value)).toEqual([]);
});
