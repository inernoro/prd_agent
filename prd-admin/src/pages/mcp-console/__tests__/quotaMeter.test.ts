/**
 * 额度条的填充宽度。
 *
 * 这条判据删掉不会红：按真实比例画照样编译、照样全绿、桌面截图也看不出来，
 * 只有真的有人用掉了一两次额度、再去手机上看那条 6px 高的轨道时才现形。
 */
import { describe, expect, it } from 'vitest';
import { MIN_VISIBLE_PERCENT, quotaFillPercent } from '../quotaMeter';

describe('额度条填充宽度', () => {
  it('一次没用是真的空', () => {
    expect(quotaFillPercent(0, 50)).toBe(0);
  });

  it('用过一点也必须看得见，不按真实比例缩到看不出来', () => {
    // 1/200 真实是 0.5%，四舍五入成 1% —— 在 6px 高的轨道上画不出来
    expect(quotaFillPercent(1, 200)).toBe(MIN_VISIBLE_PERCENT);
    expect(quotaFillPercent(1, 200)).toBeGreaterThan(1);
  });

  it('正常比例照实画', () => {
    expect(quotaFillPercent(25, 50)).toBe(50);
    expect(quotaFillPercent(9, 200)).toBe(5); // 4.5 → 5，本来就够看见，不抬
  });

  it('用超了封顶在 100', () => {
    expect(quotaFillPercent(80, 50)).toBe(100);
  });

  it('没有上限却用过：画满，不画成空的', () => {
    // 空轨道会被读成「一次没用」，而事实相反
    expect(quotaFillPercent(3, 0)).toBe(100);
  });
});
