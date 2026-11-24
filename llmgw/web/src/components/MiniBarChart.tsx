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
          // 零值不画绿柱。此前写的是 Math.max(0.04, …)，于是「当天没有请求」也会长出
          // 一根 4% 高的绿色小柱；它比真实的低值柱还矮一截，一排下来就是用户说的
          // 「像缺失的牙齿」。零值改画基线上一段 2px 的灰色刻度（见 .is-zero）——
          // 「这天是 0」和「这天没数据」是两回事，仍要看得见，但不能长得像一根柱子。
          const zero = d.count <= 0;
          const ratio = zero ? 0 : Math.max(0.06, d.count / max);
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
                className={`lg-mini-bar-value${zero ? ' is-zero' : ''}`}
                style={zero ? undefined : { height: `${ratio * 100}%` }}
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
