/**
 * 顶部主干版本流水轴：一眼看出「每个环境停在哪个提交」。
 *
 * 只有一个环境时它照样有用（生产停在哪、主干又跑了多远），所以不按环境数隐藏；
 * 但**数据缺省时整块隐藏**——画一条没有节点的空轴属于留空壳，比不画更糟。
 */

import {
  buildRailNodeViews,
  describeOldestUnreleased,
  formatAgo,
  markersOffRail,
  type RailMarker,
  type ReleaseCommitRail as RailData,
  type ReleaseTargetCommitPosition,
} from '@/lib/releaseRail';
import { Chip, SectionLabel } from './shared';

export interface CommitRailProps {
  rail: RailData;
  markers: RailMarker[];
  /** 当前选中环境的落点，用于右上角那句「最早未上线提交距今 N」。 */
  selectedPosition?: ReleaseTargetCommitPosition;
  nowMs: number;
  onSelectMarker?: (targetId: string) => void;
}

export function CommitRail({ rail, markers, selectedPosition, nowMs, onSelectMarker }: CommitRailProps): JSX.Element {
  const nodes = buildRailNodeViews(rail, markers);
  const offRail = markersOffRail(rail, markers);
  const oldestText = describeOldestUnreleased(selectedPosition, nowMs);
  const refsAgo = formatAgo(rail.refsAsOf, nowMs);

  return (
    <section className="cds-surface-raised cds-hairline shrink-0 rounded-[14px] px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{rail.branch || '主干'} 分支版本流水</h2>
          <Chip>最近 {rail.nodes.length} 个提交</Chip>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {oldestText ? <span>{oldestText}</span> : null}
          {/* 本地 ref 有多旧要如实说：打开发布中心不 fetch 是刻意取舍，
              落后数偏小的代价由这行字承担，而不是偷偷补一次网络往返。 */}
          {refsAgo ? <span>本地 {rail.ref} 读取于 {refsAgo}</span> : null}
        </div>
      </div>

      <div className="mt-2 overflow-x-auto pb-1">
        <ol className="flex min-w-max items-stretch gap-0">
          {nodes.map((node, index) => {
            const hasMarker = node.markers.length > 0;
            return (
              <li key={node.sha} className="relative flex min-w-[124px] flex-1 flex-col items-center gap-1 px-2 pt-6">
                {/* 轴线：首尾各裁掉一半，避免两端悬空的线头 */}
                <span
                  aria-hidden
                  className="absolute top-[9px] h-0.5 bg-[hsl(var(--hairline-strong))]"
                  style={{
                    left: index === 0 ? '50%' : 0,
                    right: index === nodes.length - 1 ? '50%' : 0,
                  }}
                />
                <span
                  aria-hidden
                  className={`absolute top-[4px] h-3 w-3 rounded-full border-2 ${
                    hasMarker
                      ? 'border-primary bg-primary'
                      : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))]'
                  }`}
                />
                <span className="font-mono text-[11.5px] tabular-nums">{node.shortSha}</span>
                {node.markers.map((marker) => (
                  <button
                    key={marker.targetId}
                    type="button"
                    onClick={() => onSelectMarker?.(marker.targetId)}
                    className="rounded-full bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary hover:bg-primary/20"
                  >
                    {marker.label}在此
                  </button>
                ))}
                <span className="max-w-[15ch] truncate text-[10.5px] text-muted-foreground" title={node.subject}>
                  {node.subject || '无提交说明'}
                </span>
                <span className="text-[10.5px] text-muted-foreground">{formatAgo(node.committedAt, nowMs) || '-'}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {offRail.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] pt-2">
          <SectionLabel>不在最近提交里</SectionLabel>
          {offRail.map((marker) => (
            <button
              key={marker.targetId}
              type="button"
              onClick={() => onSelectMarker?.(marker.targetId)}
              className="rounded-full border border-[hsl(var(--hairline))] px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {marker.label} · {marker.commitSha.slice(0, 7)}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
