import { describe, expect, it } from 'vitest';
import {
  ROTATION_DAYS,
  cycleIndex,
  dayIndex,
  daysUntilRotation,
  nextRotationAt,
  pickBackdrop,
} from '../backdropRotation';

const DAY = 86_400_000;
const at = (days: number, hours = 0) => days * DAY + hours * 3_600_000;

describe('背景轮换是纯函数，不存状态', () => {
  it('同一时刻在任何设备算出同一张——这是不存「上次更换时间」的全部理由', () => {
    const set = ['a', 'b', 'c'];
    const t = at(12_345, 7);
    expect(pickBackdrop(set, t)).toBe(pickBackdrop(set, t));
    // 同一轮内的任何时刻都是同一张（轮内不跳图）。
    expect(pickBackdrop(set, at(12_340))).toBe(pickBackdrop(set, at(12_349, 23)));
  });

  it('每 10 天换一张，且按素材顺序循环', () => {
    const set = ['a', 'b', 'c'];
    const base = 12_340; // 12340 / 10 = 1234，整轮起点
    expect(cycleIndex(at(base))).toBe(1234);
    const seen = [0, 1, 2, 3].map((k) => pickBackdrop(set, at(base + k * ROTATION_DAYS)));
    // 三张素材、四轮 → 回到第一张，顺序不跳。
    expect(seen[3]).toBe(seen[0]);
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
  });

  it('第 9 天还没换，第 10 天换掉', () => {
    const base = at(12_340);
    const set = ['a', 'b', 'c'];
    expect(pickBackdrop(set, base + 9 * DAY)).toBe(pickBackdrop(set, base));
    expect(pickBackdrop(set, base + 10 * DAY)).not.toBe(pickBackdrop(set, base));
  });

  it('空素材集返回 null，让调用方整层不渲染', () => {
    // 页面不许依赖背景图才成立——潜像场自己就够。
    expect(pickBackdrop([], at(1))).toBeNull();
  });

  it('单张素材永远是它，不会因为取模出 undefined', () => {
    expect(pickBackdrop(['only'], at(99_999))).toBe('only');
  });

  it('倒计时向上取整，不会显示「还有 0 天」', () => {
    // 还剩 5 小时 → 说「还有 1 天」。说 0 天用户会以为现在就该换了。
    const almost = nextRotationAt(at(12_340)).getTime() - 5 * 3_600_000;
    expect(daysUntilRotation(almost)).toBe(1);
    expect(daysUntilRotation(at(12_340))).toBe(ROTATION_DAYS);
  });

  it('下次更换时刻恰好落在轮次边界上', () => {
    const t = at(12_343, 11);
    const next = nextRotationAt(t).getTime();
    expect(next % (ROTATION_DAYS * DAY)).toBe(0);
    expect(next).toBeGreaterThan(t);
    // 边界前后属于相邻两轮，不多不少差一轮。
    expect(cycleIndex(next) - cycleIndex(t)).toBe(1);
  });

  it('天数用 UTC 算：跨时区的人不会在同一时刻看到不同张', () => {
    // 同一 UTC 瞬间，无论本地时区，dayIndex 都取同一个整数。
    expect(dayIndex(at(12_340, 23))).toBe(dayIndex(at(12_340, 1)));
    expect(dayIndex(at(12_341, 0))).toBe(dayIndex(at(12_340)) + 1);
  });

  it('自定义轮换天数也成立（days 是参数不是写死的 10）', () => {
    const set = ['a', 'b'];
    expect(pickBackdrop(set, at(100), 1)).not.toBe(pickBackdrop(set, at(101), 1));
    expect(daysUntilRotation(at(100), 3)).toBeLessThanOrEqual(3);
  });

  it('days 传 0 或负数时退化成 1 天，不会除零变成 Infinity', () => {
    expect(Number.isFinite(cycleIndex(at(10), 0))).toBe(true);
    expect(Number.isFinite(cycleIndex(at(10), -5))).toBe(true);
  });
});
