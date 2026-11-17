/** 报告导航与验收聚合共用的类型判据；不依赖存储或服务端运行时。 */
export interface ReportMetadataInput { title: string; reportType?: 'acceptance' | 'code-review' }

/** 标题合同的九类前缀（§4.1.2）。不在此列的标题归「其他」。 */
export const REPORT_KINDS = [
  '功能验收', '每日验收', 'PR验收', 'Commit验收', '分支验收', '缺陷复测', '视觉回归', '发布验收', '规范演练', '代码审查报告',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number] | '其他';
export function isCodeReviewReport(report: ReportMetadataInput): boolean {
  return report.reportType === 'code-review'
    || report.reportType === undefined && parseReportTitle(report.title).kind === '代码审查报告';
}

export interface ParsedReportTitle {
  kind: ReportKind;
  /** 重点对象（标题中段）；无法解析时为整个标题。 */
  target: string;
  /** 目标日期 YYYY-MM-DD；无法解析时为 null。 */
  targetDate: string | null;
}

const TITLE_RE = /^(\S+?)\s*[·・]\s*(.+?)\s*[·・]\s*(\d{4}-\d{2}-\d{2})\s*$/;

export function parseReportTitle(title: string): ParsedReportTitle {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return { kind: '其他', target: title.trim(), targetDate: null };
  const prefix = m[1];
  const kind: ReportKind = (REPORT_KINDS as readonly string[]).includes(prefix) ? (prefix as ReportKind) : '其他';
  return { kind, target: kind === '其他' ? title.trim() : m[2].trim(), targetDate: m[3] };
}

/** Persisted type controls code-review identity; other title categories keep their existing contract. */
export function parseReportMetadata(report: ReportMetadataInput): ParsedReportTitle {
  const parsed = parseReportTitle(report.title);
  if (isCodeReviewReport(report)) return { ...parsed, kind: '代码审查报告' };
  return parsed.kind === '代码审查报告' ? { ...parsed, kind: '其他' } : parsed;
}
