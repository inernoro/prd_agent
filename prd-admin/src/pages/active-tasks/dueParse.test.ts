import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parseDueFromTitle } from './dueParse';

/** 固定在 2026-09-14（周一）12:00，否则「周五」「月底」这类断言会随真实日期漂 */
const NOW = new Date(2026, 8, 14, 12, 0, 0);

function dayOf(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  it('时间统一落在当天 18:00 —— 「今天要」指今天下班前，不是此刻', () => {
    const d = new Date(parseDueFromTitle('今天发出去')!.iso);
    expect(d.getHours()).toBe(18);
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
