/**
 * 周报 Agent 周次日期范围格式化工具。
 *
 * 用户反馈："第 X 周"看不出是哪几天，要直接显示日期范围。
 * 本工具统一返回 ISO 周（周一-周日）的紧凑日期范围字符串，供顶部筛选、卡片、列表等多处复用。
 */

export interface WeekRefLike {
  weekYear: number;
  weekNumber: number;
}

/**
 * 根据 ISO 周年 + 周号计算该周的周一日期（UTC）。
 * ISO 8601 规则：含 1 月 4 日的那周为第 1 周，周一为首日。
 */
export function getISOWeekStart(weekYear: number, weekNumber: number): Date {
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // 周一=1..周日=7
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow + 1);
  const weekStart = new Date(week1Mon);
  weekStart.setUTCDate(week1Mon.getUTCDate() + (weekNumber - 1) * 7);
  return weekStart;
}

/**
 * 把 ISO 周渲染为日期范围字符串 "M/D - M/D"。
 * 不补零省空间（5/18 优于 05/18），跨月仍能直观读懂。
 */
export function formatWeekDateRange(week: WeekRefLike): string {
  const start = getISOWeekStart(week.weekYear, week.weekNumber);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const m1 = start.getUTCMonth() + 1;
  const d1 = start.getUTCDate();
  const m2 = end.getUTCMonth() + 1;
  const d2 = end.getUTCDate();
  return `${m1}/${d1} - ${m2}/${d2}`;
}

/**
 * 「日期范围 · W21」混合标签：日期为主、周次为辅，兼顾"看得懂"与"能引用周次"。
 */
export function formatWeekLabelWithRange(week: WeekRefLike): string {
  return `${formatWeekDateRange(week)} · W${String(week.weekNumber).padStart(2, '0')}`;
}
