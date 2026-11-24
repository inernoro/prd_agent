import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseDueFromTitle } from './dueParse';
import { dayKey, teamDay } from './dueTime';

/**
 * 固定在团队日历 2026-09-14（周一）12:00，否则「周五」「月底」这类断言会随真实日期漂。
 * 写成绝对瞬间而不是 `new Date(2026, 8, 14, 12)`：后者是**本机**时区的 12 点，
 * 于是这批断言在 CI（UTC）与开发机上根本不是同一个团队日 —— 而这正是被测代码要治的病。
 */
const NOW = new Date('2026-09-14T04:00:00Z');

/** 按团队日历读一个 ISO 落在哪一天。不许用 getFullYear/getDate —— 那读的是本机日历 */
function dayOf(iso: string): string {
  return dayKey(teamDay(new Date(iso)));
}

describe('从标题里认「什么时候要」', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('认出「明天」并把它从标题里摘掉', () => {
    const m = parseDueFromTitle('明天交周报');
    expect(m).not.toBeNull();
    expect(m!.rest).toBe('交周报');
    expect(dayOf(m!.iso)).toBe('2026-09-15');
  });

  it('「大后天」不会被「后天」抢先匹配（长的规则排在前面）', () => {
    const m = parseDueFromTitle('大后天上线');
    expect(dayOf(m!.iso)).toBe('2026-09-17');
    expect(m!.rest).toBe('上线');
  });

  it('本周的周五：今天周一，指本周五', () => {
    const m = parseDueFromTitle('周五之前把网关比对跑完');
    expect(dayOf(m!.iso)).toBe('2026-09-18');
    expect(m!.rest).toBe('把网关比对跑完');
  });

  it('说到的那天就是那天：周一早上写「周一」指今天，不是下周一', () => {
    // NOW 是团队日历周一 12:00，18:00 还没到
    expect(dayOf(parseDueFromTitle('周一交周报')!.iso)).toBe('2026-09-14');
  });

  it('过了当天 18:00 再写「周一」，还是今天，只是退到 23:59（不跳到下周）', () => {
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z')); // 团队 20:00，已过 18:00
    const m = parseDueFromTitle('周一交周报')!;
    expect(dayOf(m.iso)).toBe('2026-09-14');
    expect(m.iso).toBe('2026-09-14T15:59:00.000Z'); // 团队 23:59
  });

  it('周六说「这周末」指今天，与「周 X」同一口径', () => {
    vi.setSystemTime(new Date('2026-09-19T02:00:00Z')); // 团队 09-19 10:00 是周六
    expect(dayOf(parseDueFromTitle('这周末上线')!.iso)).toBe('2026-09-19');
  });

  it('「下周三」跨到下一周', () => {
    const m = parseDueFromTitle('下周三评审');
    expect(dayOf(m!.iso)).toBe('2026-09-23');
  });

  it('「3天后」按天数算', () => {
    expect(dayOf(parseDueFromTitle('3天后复测')!.iso)).toBe('2026-09-17');
  });

  it('「9月20日」认成具体日期', () => {
    expect(dayOf(parseDueFromTitle('9月20日发版')!.iso)).toBe('2026-09-20');
  });

  it('已经过去的月份按明年算', () => {
    expect(dayOf(parseDueFromTitle('1月5日续费')!.iso)).toBe('2027-01-05');
  });

  it('「月底」取当月最后一天', () => {
    expect(dayOf(parseDueFromTitle('月底出账')!.iso)).toBe('2026-09-30');
  });

  it('时间统一落在团队日历当天 18:00 —— 「今天要」指今天下班前，不是此刻', () => {
    // 断言绝对瞬间，不是 getHours()：后者读本机时区，在 UTC 的 CI 上读出 10 也「对」，
    // 于是这条断言就永远测不出「按谁的 18 点」这个问题。团队 18:00 = 10:00Z，恒成立。
    expect(parseDueFromTitle('今天发出去')!.iso).toBe('2026-09-14T10:00:00.000Z');
  });

  it('日期按团队日历算，不按浏览器所在时区 —— 人在美西点「明天」，不该落成团队的后天', () => {
    // 这条是上一版的红绿判据：旧实现用 new Date() + setDate()（本机日历）+ setHours(18)
    // （本机 18 点），只有运行在东八区时才恰好产出这个瞬间。
    expect(parseDueFromTitle('明天交周报')!.iso).toBe('2026-09-15T10:00:00.000Z');
  });

  it('团队日已经翻页、UTC 还没翻页的那一小时里，「今天」跟团队走', () => {
    // 2026-09-14T16:30Z = 团队 09-15 00:30（团队已是 15 号），而 UTC 仍是 14 号、
    // 美西仍是 13 号。三本日历在这一刻互不相同，只有跟团队走才对。
    vi.setSystemTime(new Date('2026-09-14T16:30:00Z'));
    expect(dayOf(parseDueFromTitle('今天发出去')!.iso)).toBe('2026-09-15');
    expect(dayOf(parseDueFromTitle('明天发出去')!.iso)).toBe('2026-09-16');
  });

  it('连接词只剥整词，不啃掉标题第一个字', () => {
    // [之前] 写成字符类会把这句啃成「端重构」
    expect(parseDueFromTitle('明天前端重构')!.rest).toBe('前端重构');
  });

  it('没有时间词就不认，不硬猜', () => {
    expect(parseDueFromTitle('把网关比对跑完')).toBeNull();
  });

  it('整句话只有时间词、摘完什么都不剩，不认 —— 那不是任务', () => {
    expect(parseDueFromTitle('明天')).toBeNull();
    expect(parseDueFromTitle('  下周五  ')).toBeNull();
  });

  it('空标题不认', () => {
    expect(parseDueFromTitle('')).toBeNull();
    expect(parseDueFromTitle('   ')).toBeNull();
  });
});
