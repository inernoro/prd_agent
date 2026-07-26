// 极简柱状图（纯 DOM，不引 echarts；保持 mini-app 依赖最小）。
import { useState } from 'react';
import type { TimeseriesPoint } from '@/lib/types';

export function MiniBarChart({ data, height = 140 }: { data: TimeseriesPoint[]; height?: number }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));
  const labelStep = Math.max(1, Math.ceil(Math.max(0, data.length - 1) / 5));
  const lastIndex = data.length - 1;
  const activePoint = activeIndex == null ? null : data[activeIndex];
  return (
    <div className="lg-mini-bar-chart" style={{ height }} onPointerLeave={() => setActiveIndex(null)}>
      {activePoint ? (
        <div className="lg-mini-bar-tooltip" role="status">
          <strong>{activePoint.date}</strong>
          <span><i aria-hidden="true" />请求 {activePoint.count}</span>
        </div>
      ) : null}
      {data.length === 0 ? (
        <div className="lg-mini-bar-empty">暂无数据</div>
      ) : (
        data.map((d, i) => {
          const ratio = Math.max(0.04, d.count / max);
          const showLabel = i === lastIndex
            || (i % labelStep === 0 && lastIndex - i >= Math.max(2, Math.ceil(labelStep * 0.65)));
          return (
            <button
              key={`${d.date}-${i}`}
              className={`lg-mini-bar-item${activeIndex === i ? ' is-active' : ''}`}
              type="button"
              aria-label={`${d.date}，请求 ${d.count}`}
              onPointerEnter={() => setActiveIndex(i)}
              onFocus={() => setActiveIndex(i)}
              onBlur={() => setActiveIndex(null)}
              onClick={() => setActiveIndex(i)}
            >
              <span
                className="lg-mini-bar-value"
                style={{ height: `${ratio * 100}%` }}
              />
              <small
                aria-hidden={!showLabel}
                style={{ visibility: showLabel ? 'visible' : 'hidden' }}
              >
                {d.date.slice(5)}
              </small>
            </button>
          );
        })
      )}
    </div>
  );
}
