import { Card } from '@/components/design/Card';

export function KpiCard({
  title,
  value,
  suffix,
  loading,
  accent,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  loading?: boolean;
  accent?: 'green';
}) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;

  return (
    <Card>
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <div
          className="text-[32px] font-semibold tracking-[-0.03em] leading-none"
          style={{ color: accent === 'green' ? 'var(--accent-green)' : 'var(--text-primary)' }}
        >
          {loading ? '—' : display}
        </div>
        {suffix && <div className="text-[13px] font-medium" style={{ color: 'var(--text-muted)' }}>{suffix}</div>}
      </div>
      <div className="mt-3 h-px" style={{ background: 'rgba(255,255,255,0.07)' }} />
      <div className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {loading ? '加载中...' : '数据来自 mock 契约层'}
      </div>
    </Card>
  );
}

