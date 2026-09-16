/**
 * 从标题里认出「什么时候要」—— 打「明天交周报」，时间自己填上，标题只留「交周报」。
 *
 * 界面上什么都没多，这是那一手「简洁但不简单」的全部。
 *
 * 纯规则，不走大模型：这一步必须即时、可预期、不烧 token；
 * 认不出来就老老实实认不出来，让人点胶囊 —— 猜错比不猜更烦人。
 */

import { addDays, dayOf, endOfDay, monthOf, teamDate, teamDay, weekdayOf, yearOf } from './dueTime';

export interface DueMatch {
  /** 识别到的时间，ISO 字符串 */
  iso: string;
  /** 标题里被认出来的那段原文，如「明天」 */
  text: string;
  /** 去掉时间词之后的标题 */
  rest: string;
}


function plusDays(n: number): Date {
  return endOfDay(addDays(teamDay(), n));
}

const WEEKDAYS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

/** 本周的周 X；今天已过就取下周同一天（和日历 App 的直觉一致） */
function thisWeekday(target: number): Date {
  const today = teamDay();
  const delta = (target - weekdayOf(today) + 7) % 7;
  return endOfDay(addDays(today, delta === 0 ? 7 : delta));
}

/** 下周的周 X */
function nextWeekday(target: number): Date {
  const today = teamDay();
  const toNextMonday = ((1 - weekdayOf(today) + 7) % 7) || 7;
  return endOfDay(addDays(today, toNextMonday + ((target === 0 ? 7 : target) - 1)));
}

/** 规则表：一行一条，按先长后短排 —— 「大后天」必须排在「后天」前面，否则永远匹配不到 */
const RULES: { re: RegExp; when: (m: RegExpMatchArray) => Date }[] = [
  { re: /大后天/, when: () => plusDays(3) },
  { re: /后天/, when: () => plusDays(2) },
  { re: /今天|今日|今晚/, when: () => plusDays(0) },
  { re: /明天|明日/, when: () => plusDays(1) },
  { re: /这?个?(?:周|礼拜)末|本周末/, when: () => {
    const today = teamDay();
    return endOfDay(addDays(today, (6 - weekdayOf(today) + 7) % 7 || 7));
  } },
  { re: /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/, when: (m) => nextWeekday(WEEKDAYS[m[1]]) },
  { re: /(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])/, when: (m) => thisWeekday(WEEKDAYS[m[1]]) },
  { re: /(\d{1,2})\s*天(?:后|内|之后)/, when: (m) => plusDays(Number(m[1])) },
  { re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/, when: (m) => {
    const today = teamDay();
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    let year = yearOf(today);
    // 已经过去的月份按明年算 —— 12 月写「1月5日」指的是下一年
    if (month < monthOf(today) || (month === monthOf(today) && day < dayOf(today))) year += 1;
    return endOfDay(teamDate(year, month, day));
  } },
  { re: /月底/, when: () => {
    const today = teamDay();
    return endOfDay(teamDate(yearOf(today), monthOf(today) + 1, 0));
  } },
];

/**
 * 从标题里认时间。认不出返回 null。
 *
 * 只认第一处 —— 一句话里写两个时间（「明天问问周五能不能交」）本来就有歧义，
 * 认第一个然后让人自己改，比猜一个更不容易错。
 */
export function parseDueFromTitle(title: string): DueMatch | null {
  const text = title ?? '';
  if (!text.trim()) return null;

  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m) continue;

    const matched = m[0];
    // 把时间词摘掉，再收拾它留下的空格和连接词。
    // 连接词只认整词，不用字符类 —— [之前] 那种写法会把「明天前端重构」啃成「端重构」。
    const rest = text
      .replace(matched, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:之前|以前|前面|截止|的|要)\s*/, '')
      .trim();

    // 摘完什么都不剩，说明这句话整个就是个时间，不是任务 —— 不认
    if (!rest) return null;

    return { iso: rule.when(m).toISOString(), text: matched, rest };
  }

  return null;
}
