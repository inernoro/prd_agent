/**
 * 路由站点地图（行为洞察 Hero 视图之一）：把 mapData 的端点路径铺成层级树，回答「哪个功能区在出问题」。
 * 全部从现有 mapData 现算，不额外请求后端。
 * 构建：按 module → 端点叶子两层缩进树（端点节点直接挂在模块下，按问题严重度排序）。
 * 痛点节点高亮（error 红 / slow 琥珀），点痛点节点 → 调 onSelectTarget 下钻（与热力图同一抽屉联动）。
 * 入场：节点依次生长（淡入 + 左移）。纯 DOM + SVG 连接线，冷色海主题，禁止 emoji。
 */
import { useMemo, type ReactNode } from 'react';
import { Network, AlertTriangle, Clock } from 'lucide-react';
import { GlassCard } from '@/components/design';
import type { ExperienceMapGroup, ExperienceMapLeaf, TeamActivityExperienceMapData } from '@/services/contracts/teamActivity';

const ERR = '#f8717a';
const SLOW = '#fbbf24';

type ModuleNode = {
  group: ExperienceMapGroup;
  leaves: ExperienceMapLeaf[];
  painCount: number;
};

/** 优先有痛点的模块在前；模块内痛点叶子在前；只展示有信号(value>0)的端点，每模块最多 8 个 */
function buildTree(mapData: TeamActivityExperienceMapData | null): ModuleNode[] {
  if (!mapData) return [];
  return mapData.groups
    .map((g) => {
      const leaves = [...g.leaves]
        .sort((a, b) => {
          const pa = a.status === 'error' ? 2 : a.status === 'slow' ? 1 : 0;
          const pb = b.status === 'error' ? 2 : b.status === 'slow' ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return b.value - a.value;
        })
        .slice(0, 8);
      const painCount = leaves.filter((l) => l.status === 'error' || l.status === 'slow').length;
      return { group: g, leaves, painCount };
    })
    .filter((m) => m.leaves.length > 0)
    .sort((a, b) => {
      if (a.painCount !== b.painCount) return b.painCount - a.painCount;
      return b.group.value - a.group.value;
    })
    .slice(0, 14);
}

export function ExperienceSiteMap({
  mapData,
  onSelectTarget,
  onSwitchHeatmap,
  headerExtra,
}: {
  mapData: TeamActivityExperienceMapData | null;
  onSelectTarget?: (target: string, fallback: { label: string; metric: string }) => void;
  onSwitchHeatmap?: () => void;
  /** 头部右侧额外控件（四图仪表盘里注入 热力图⇄站点地图 子切换器） */
  headerExtra?: ReactNode;
}) {
  const tree = useMemo(() => buildTree(mapData), [mapData]);

  if (tree.length === 0) {
    return (
      <GlassCard className="overflow-hidden h-full flex flex-col" style={{ padding: 0, minHeight: 320 }}>
        <Header headerExtra={headerExtra} />
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2.5 text-center">
          <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
          <span className="text-sm text-emerald-300/85">当前窗口没有可铺设的站点路径</span>
          <span className="text-[12px] text-white/40">尚无足够请求构建路由树。可换时间范围，或</span>
          {onSwitchHeatmap ? (
            <button
              type="button"
              onClick={onSwitchHeatmap}
              className="mt-1 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-white/10 bg-white/[0.03] text-[11px] text-white/55 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer"
            >
              切回体验全景热力图
            </button>
          ) : null}
        </div>
      </GlassCard>
    );
  }

  let nodeIdx = 0;
  return (
    <GlassCard className="overflow-hidden h-full flex flex-col" style={{ padding: 0, minHeight: 320 }}>
      <Header headerExtra={headerExtra} />
      <div className="px-3 pb-3 flex-1 min-h-0" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <div className="flex flex-col gap-3 pt-1">
          {tree.map((m) => {
            const moduleDelay = nodeIdx++ * 50;
            return (
              <div key={m.group.key} style={{ animation: 'voc-site-in .4s ease both', animationDelay: `${moduleDelay}ms` }}>
                {/* 模块节点 */}
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.painCount > 0 ? ERR : 'rgba(94,234,212,0.7)' }} />
                  <span className="text-[12.5px] font-semibold text-white/80">{m.group.label}</span>
                  {m.painCount > 0 ? (
                    <span className="text-[10.5px] px-1.5 py-px rounded-full" style={{ background: 'rgba(248,113,122,0.12)', color: ERR }}>
                      {m.painCount} 处告警
                    </span>
                  ) : (
                    <span className="text-[10.5px] text-white/30">{m.leaves.length} 个端点 · 健康</span>
                  )}
                </div>
                {/* 端点叶子（缩进 + 左侧连接竖线） */}
                <div className="flex flex-col gap-1 pl-3 ml-[3px]" style={{ borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
                  {m.leaves.map((l) => {
                    const isPain = l.status === 'error' || l.status === 'slow';
                    const color = l.status === 'error' ? ERR : l.status === 'slow' ? SLOW : 'rgba(94,234,212,0.55)';
                    const clickable = isPain && !!onSelectTarget;
                    const delay = nodeIdx++ * 28;
                    return (
                      <button
                        key={l.target}
                        type="button"
                        disabled={!clickable}
                        onClick={clickable ? () => onSelectTarget!(l.target, { label: `${m.group.label} · ${l.label}`, metric: l.metric }) : undefined}
                        title={clickable ? `下钻 ${l.target}` : l.target}
                        className="group/site flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors min-w-0"
                        style={{
                          animation: 'voc-site-in .35s ease both',
                          animationDelay: `${delay}ms`,
                          cursor: clickable ? 'pointer' : 'default',
                          background: isPain ? `${color}14` : 'transparent',
                          border: isPain ? `1px solid ${color}3a` : '1px solid transparent',
                        }}
                      >
                        {isPain ? (
                          l.status === 'error' ? (
                            <AlertTriangle size={12} style={{ color }} />
                          ) : (
                            <Clock size={12} style={{ color }} />
                          )
                        ) : (
                          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                        )}
                        <span className="text-[11.5px] truncate min-w-0 sm:max-w-[220px]" style={{ color: isPain ? 'rgba(255,255,255,0.85)' : 'rgba(236,236,239,0.5)' }}>
                          {l.label}
                        </span>
                        <span className="hidden sm:inline text-[10px] font-mono text-white/30 truncate sm:max-w-[200px]">
                          {l.target}
                        </span>
                        {isPain ? (
                          <span className="ml-auto text-[10.5px] tabular-nums shrink-0" style={{ color }}>
                            {l.metric}
                            {clickable ? <span className="ml-1.5 text-white/40 opacity-0 group-hover/site:opacity-100 transition-opacity">下钻</span> : null}
                          </span>
                        ) : (
                          <span className="ml-auto text-[10px] text-white/25 tabular-nums shrink-0">{l.value} 次</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <style>{`@keyframes voc-site-in { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </GlassCard>
  );
}

function Header({ headerExtra }: { headerExtra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 shrink-0">
      <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5 min-w-0 flex-wrap">
        <span className="whitespace-nowrap">路由站点地图</span>
        <span className="hidden sm:inline-flex text-[11px] text-white/35 font-normal items-center gap-1.5 whitespace-nowrap">
          <Network size={12} className="text-cyan-300/70" />
          按模块铺开路由树 · 点痛点节点下钻
        </span>
      </span>
      {headerExtra ? <span className="shrink-0">{headerExtra}</span> : null}
    </div>
  );
}
