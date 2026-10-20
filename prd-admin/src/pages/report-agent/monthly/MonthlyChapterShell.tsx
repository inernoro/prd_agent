import type { ReactNode } from 'react';

/** 章节外壳：序号徽章 + 标题 + 必填/选填 + 提示语，编辑页与详情页共用 */
export function MonthlyChapterShell({
  index,
  title,
  requiredLabel,
  hint,
  issue,
  actions,
  children,
}: {
  index: number;
  title: string;
  requiredLabel?: string;
  hint?: string;
  /** 后端算出的该章未完成项，标红提示 */
  issue?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`monthly-chapter-${index}`}
      className="rounded-2xl p-4 sm:p-5 flex flex-col gap-3 scroll-mt-4"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${issue ? 'var(--accent-fg-error)' : 'var(--border-primary)'}`,
      }}
      data-testid={`monthly-chapter-${index}`}
    >
      <header className="flex items-start gap-3">
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center text-[12px] font-semibold shrink-0"
          style={{ background: 'var(--status-going-soft)', color: 'var(--status-going)', border: '1px solid var(--status-going-border)' }}
        >
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
            {requiredLabel && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  color: requiredLabel === '必填' ? 'var(--accent-fg-warning)' : 'var(--text-muted)',
                  background: 'var(--bg-secondary)',
                }}
              >
                {requiredLabel}
              </span>
            )}
          </div>
          {hint && <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{hint}</div>}
          {issue && <div className="text-[12px] mt-1" style={{ color: 'var(--accent-fg-error)' }}>{issue}</div>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
