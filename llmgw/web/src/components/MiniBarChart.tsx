// 极简柱状图（纯 DOM，不引 echarts；保持 mini-app 依赖最小）。
import type { TimeseriesPoint } from '@/lib/types';

export function MiniBarChart({ data, height = 140 }: { data: TimeseriesPoint[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  return (
    <div className="lg-mini-bar-chart" style={{ height }}>
      {data.length === 0 ? (
        <div className="lg-mini-bar-empty">暂无数据</div>
      ) : (
        data.map((d, i) => {
          const ratio = Math.max(0.04, d.count / max);
          return (
            <div key={`${d.date}-${i}`} className="lg-mini-bar-item" title={`${d.date} · ${d.count} 次`}>
              <span
                className="lg-mini-bar-value"
                style={{ height: `${ratio * 100}%` }}
              />
              <small
                aria-hidden={i % labelStep !== 0 && i !== data.length - 1}
                style={{ visibility: i % labelStep === 0 || i === data.length - 1 ? 'visible' : 'hidden' }}
              >
                {d.date.slice(5)}
              </small>
            </div>
          );
        })
      )}
    </div>
  );
}
