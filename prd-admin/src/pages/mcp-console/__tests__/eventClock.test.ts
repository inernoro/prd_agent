/**
 * 事件行的时间列必须区分得开「今天的 15:01」和「昨天的 15:01」。
 *
 * 真事：2026-09-05 14:06 UTC 打开接入台，第一屏写「今天一次都还没调过」，
 * 紧挨着的列表第一行写 `15:01` —— 展开才看得到它其实是 `2026/9/4 15:01:07`。
 * 两句话都没说错（判断句按 UTC 自然日算，列表按条数取最近 N 条），
 * 但放在一起读就是自相矛盾，而读者没有任何线索能自己解开。
 */
import { describe, expect, it } from 'vitest';
import { eventClock } from '../eventClock';

const NOW = new Date('2026-09-05T14:06:51Z');

describe('事件行时间列', () => {
  it('今天的只写时刻', () => {
    expect(eventClock('2026-09-05T07:31:02Z', NOW)).toBe('07:31');
  });

  it('昨天的必须带上日期——否则跟今天的同一时刻长得一模一样', () => {
    const yesterday = eventClock('2026-09-04T15:01:07Z', NOW);
    expect(yesterday).toContain('15:01');
    expect(yesterday).not.toBe('15:01');
    expect(yesterday).toMatch(/09.*04/);
  });

  it('同一个时刻，今天与昨天渲染出来不能相同（这就是那条缺陷本身）', () => {
    expect(eventClock('2026-09-05T15:01:07Z', NOW))
      .not.toBe(eventClock('2026-09-04T15:01:07Z', NOW));
  });

  it('更早的也带日期', () => {
    expect(eventClock('2026-08-30T06:28:00Z', NOW)).toMatch(/08.*30/);
  });

  it('判据按本地自然日，不按 UTC 日期字符串——跨时区时前者才与眼睛看到的时刻一致', () => {
    // 同一个瞬间，只要跟 now 是同一个本地自然日，就只写时刻
    const now = new Date('2026-09-05T00:30:00Z');
    expect(eventClock('2026-09-05T23:30:00Z', now)).toBe(
      new Date('2026-09-05T23:30:00Z').toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('时间戳认不出来时给空串，不抛也不显示 Invalid Date', () => {
    expect(eventClock('不是时间', NOW)).toBe('');
  });
});
