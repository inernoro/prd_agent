import type { MonthlyReportStatus, WeeklyCandidateGroup } from '@/services/contracts/reportAgentMonthly';

/** 月报状态 → 文案与颜色（走 status token，双主题自适应） */
export const MONTHLY_STATUS_REGISTRY: Record<MonthlyReportStatus, { label: string; color: string; bg: string; border: string }> = {
  draft: { label: '草稿', color: 'var(--status-idle)', bg: 'var(--status-idle-soft)', border: 'var(--status-idle-border)' },
  submitted: { label: '已提交', color: 'var(--status-going)', bg: 'var(--status-going-soft)', border: 'var(--status-going-border)' },
  viewed: { label: '负责人已查看', color: 'var(--status-done)', bg: 'var(--status-done-soft)', border: 'var(--status-done-border)' },
};

export function getMonthlyStatusMeta(status: string) {
  return MONTHLY_STATUS_REGISTRY[status as MonthlyReportStatus] ?? MONTHLY_STATUS_REGISTRY.draft;
}

/**
 * 四章的界面提示（章节标题以后端返回的 chapterTitles 为准，这里只放 UI 引导文案）。
 * 是否可提交以后端 submitIssues 为准，requiredLabel 只是提示。
 */
export const MONTHLY_CHAPTER_UI: { requiredLabel: '必填' | '选填'; hint: string; placeholder: string }[] = [
  {
    requiredLabel: '必填',
    hint: '勾选这个月的周报，或直接写下本月成果，两者至少有一样',
    placeholder: '可以补充周报里没写到的成果、关键数字、本月最想让上级知道的一件事……（支持 Markdown）',
  },
  {
    requiredLabel: '选填',
    hint: '本月遇到的问题，以及你打算怎么解决',
    placeholder: '问题：……\n对策：……',
  },
  {
    requiredLabel: '选填',
    hint: '写下本月让你印象最深刻的伙伴（最多 3 位，不限本系统用户）和理由',
    placeholder: '为什么是 TA？可以写多行',
  },
  {
    requiredLabel: '选填',
    hint: '对上级、团队或公司的建议',
    placeholder: '想到什么写什么，具体一点更容易被采纳',
  },
];

export const WEEKLY_GROUP_LABELS: Record<WeeklyCandidateGroup, string> = {
  current: '归属本月的周报',
  adjacent: '相邻月份',
  other: '更早或更晚',
};

/** 当前北京时间的年月（只用于默认选中「本月」，可写月份的判定以后端为准） */
export function currentYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}

/** 最近 N 个月（含本月），倒序 */
export function recentMonths(count: number): { year: number; month: number }[] {
  const { year, month } = currentYearMonth();
  const out: { year: number; month: number }[] = [];
  for (let i = 0; i < count; i++) {
    const idx = year * 12 + (month - 1) - i;
    out.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 });
  }
  return out;
}

export function formatYearMonth(year: number, month: number) {
  return `${year} 年 ${month} 月`;
}
