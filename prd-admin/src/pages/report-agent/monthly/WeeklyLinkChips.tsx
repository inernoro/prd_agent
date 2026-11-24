import { ExternalLink, X } from 'lucide-react';
import type { MonthlyLinkedWeekly } from '@/services/contracts/reportAgentMonthly';
import { formatWeekDateRange } from '../utils/weekRange';

/**
 * 关联周报的小卡片：点击在新标签页打开周报详情（编辑中的月报不会丢）。
 * 周报已被删除时显示「已删除」，不渲染成坏链接。
 */
export function WeeklyLinkChips({
  links,
  onRemove,
}: {
  links: MonthlyLinkedWeekly[];
  onRemove?: (weeklyReportId: string) => void;
}) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="weekly-link-chips">
      {links.map((l) => {
        const label = `W${String(l.weekNumber).padStart(2, '0')} · ${formatWeekDateRange({ weekYear: l.weekYear, weekNumber: l.weekNumber })}`;
        return (
          <div
            key={l.weeklyReportId}
            className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg text-[12px]"
            style={{
              background: l.exists ? 'var(--status-going-soft)' : 'var(--bg-secondary)',
              border: `1px solid ${l.exists ? 'var(--status-going-border)' : 'var(--border-primary)'}`,
            }}
          >
            {l.exists ? (
              <a
                href={`/report-agent/report/${l.weeklyReportId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
                style={{ color: 'var(--text-primary)' }}
                data-testid="weekly-link"
              >
                {label}
                <ExternalLink size={11} style={{ color: 'var(--text-muted)' }} />
              </a>
            ) : (
              <span style={{ color: 'var(--text-muted)' }} title="这份周报已被删除">
                {label} · 已删除
              </span>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(l.weeklyReportId)}
                className="p-0.5 rounded hover-bg-soft"
                aria-label={`取消关联 ${label}`}
              >
                <X size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
