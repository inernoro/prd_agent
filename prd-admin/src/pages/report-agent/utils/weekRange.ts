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

/** 把一个 UTC 日历日（只看 getUTC* 字段）换算成它所属的 ISO 周。 */
export function isoWeekOfUtcDate(date: Date): WeekRefLike {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 挪到本周周四：周四所在年份即 ISO 周年
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

/** 上一个 ISO 周：本周一往前 7 天所在的周（跨年与 53 周年都按 ISO 规则自动处理）。 */
export function getPreviousIsoWeek(week: WeekRefLike): WeekRefLike {
  const monday = getISOWeekStart(week.weekYear, week.weekNumber);
  monday.setUTCDate(monday.getUTCDate() - 7);
  return isoWeekOfUtcDate(monday);
}

const CHINA_OFFSET_MS = 8 * 3600 * 1000;

/** 统一截止规则生效周（含），与后端 WeeklyReportSubmissionRules.UnifiedDeadlineEffectiveWeek* 一致。 */
const UNIFIED_DEADLINE_EFFECTIVE = { weekYear: 2026, weekNumber: 46 };

function usesUnifiedDeadline(week: WeekRefLike): boolean {
  return week.weekYear > UNIFIED_DEADLINE_EFFECTIVE.weekYear
    || (week.weekYear === UNIFIED_DEADLINE_EFFECTIVE.weekYear && week.weekNumber >= UNIFIED_DEADLINE_EFFECTIVE.weekNumber);
}

/**
 * 新建周报默认归属的 ISO 周：最近一个尚未截止的周，与后端
 * WeeklyReportSubmissionRules.ResolveDefaultSubmissionWeek 同口径。
 * 上一周截止 = 本周一 24:00（UTC+8），所以周一默认上周，周二至周日默认本周。
 * 按 UTC+8 判定日期，不依赖浏览器时区。
 */
export function resolveDefaultSubmissionWeek(now: Date = new Date()): WeekRefLike {
  const current = isoWeekOfUtcDate(new Date(now.getTime() + CHINA_OFFSET_MS));
  const previous = getPreviousIsoWeek(current);
  if (!usesUnifiedDeadline(previous)) return current; // 旧口径为周日截止，到本周必然已过
  // 上周截止 = 上周一 + 8 天的 00:00（UTC+8）
  const deadlineMs = getISOWeekStart(previous.weekYear, previous.weekNumber).getTime()
    + 8 * 86400000 - CHINA_OFFSET_MS;
  return now.getTime() <= deadlineMs ? previous : current;
}

/**
 * 把 ISO 周渲染为日期范围字符串 "M.D~M.D"。
 * 用点 . 作日期分隔、波浪 ~ 作起止连接，紧凑且符合用户习惯（如 5.11~5.17）。
 * 不补零省空间，跨月仍能直观读懂。
 */
export function formatWeekDateRange(week: WeekRefLike): string {
  const start = getISOWeekStart(week.weekYear, week.weekNumber);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const m1 = start.getUTCMonth() + 1;
  const d1 = start.getUTCDate();
  const m2 = end.getUTCMonth() + 1;
  const d2 = end.getUTCDate();
  return `${m1}.${d1}~${m2}.${d2}`;
}

/**
 * 「日期范围 · W21」混合标签：日期为主、周次为辅，兼顾"看得懂"与"能引用周次"。
 */
export function formatWeekLabelWithRange(week: WeekRefLike): string {
  return `${formatWeekDateRange(week)} · W${String(week.weekNumber).padStart(2, '0')}`;
}
