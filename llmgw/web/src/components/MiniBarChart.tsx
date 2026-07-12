// 极简柱状图（纯 DOM，不引 echarts；保持 mini-app 依赖最小）。
import type { TimeseriesPoint } from '@/lib/types';

export function MiniBarChart({ data, height = 140 }: { data: TimeseriesPoint[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div style={{ height, display: 'flex', alignItems: 'flex-end', gap: 3, padding: '8px 4px 22px', position: 'relative' }}>
      {data.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
          }}
        >
          暂无数据
        </div>
      ) : (
        data.map((d, i) => {
          const h = Math.max(2, (d.count / max) * (height - 34));
          return (
            <div
              key={i}
              title={`${d.date} · ${d.count} 次`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: 22,
                  height: h,
                  background: 'var(--accent)',
                  opacity: 0.85,
                  borderRadius: '3px 3px 0 0',
                }}
              />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.date.slice(5)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
