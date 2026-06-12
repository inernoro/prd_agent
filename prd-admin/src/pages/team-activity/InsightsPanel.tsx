/**
 * 行为洞察面板：把「沉默的行为信号」聚合成带证据的改进方向。
 * 每条洞察注明：是什么行为（kind）、发生在哪（target）、涉及多少人/多少次（证据）、
 * 影响多大（severity 排序 + metric）、建议改什么（suggestion）。
 * 数据源：apirequestlogs（报错/慢端点，历史即有）+ behavior_events（路由信号，自采集上线起累积）。
 */
import { useEffect, useRef, useState } from 'react';
import { Radar, Users } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getTeamActivityInsights } from '@/services';
import type { TeamActivityInsightsData } from '@/services/contracts/teamActivity';
import { getInsightKindMeta } from './insightKinds';

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function InsightsPanel({ from }: { from?: string }) {
  const [data, setData] = useState<TeamActivityInsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    void getTeamActivityInsights({ from }).then((res) => {
      if (fetchIdRef.current !== fetchId) return;
      if (res.success) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error?.message ?? '加载失败，请重试');
      }
      setLoading(false);
    });
  }, [from]);

  if (loading && !data) {
    return (
      <GlassCard className="flex-1" style={{ minHeight: 0 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在从行为信号中聚合洞察…" />
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-1 px-5 py-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/* 数据源状态行：诚实告知信号从哪来、采集到什么程度 */}
        {data ? (
          <div className="flex items-center gap-3 flex-wrap pb-3 text-[11px] text-white/35">
            <span>
              分析窗口 {fmtDate(data.windowFrom)} ~ {fmtDate(data.windowTo)}
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span>
              路由信号 {data.behaviorEventCount} 条
              {data.trackedSince ? `（自 ${fmtDate(data.trackedSince)} 起采集）` : '（采集器刚上线，数据从现在开始累积）'}
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span>报错/等待信号来自 API 请求日志（含历史）</span>
          </div>
        ) : null}

        {error && !data ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar size={36} className="text-white/15" />
            <div className="text-sm text-white/60">{error}</div>
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar size={36} className="text-white/15" />
            <div className="text-sm text-white/60">当前窗口还没有形成洞察</div>
            <div className="text-[12px] text-white/35 max-w-md leading-relaxed">
              洞察由行为信号聚合而来：频繁报错、等待过久（来自 API 日志，历史即可分析）；
              停留过久、秒退放弃、反复横跳（来自路由信号，自采集上线起累积）。
              信号达到阈值（如同一接口失败 5 次以上）才会出现在这里——没有洞察本身就是好消息。
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {data.items.map((item, idx) => {
              const meta = getInsightKindMeta(item.kind);
              const Icon = meta.icon;
              return (
                <div
                  key={`${item.kind}-${item.target}`}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 flex gap-3"
                >
                  <span
                    className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: meta.soft }}
                  >
                    <Icon size={14} style={{ color: meta.accent }} />
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-white/30 tabular-nums">#{idx + 1}</span>
                      <span
                        className="px-1.5 py-px rounded text-[11px] font-semibold"
                        style={{ background: meta.soft, color: meta.accent }}
                      >
                        {item.kindLabel}
                      </span>
                      <span className="text-[13px] text-white/85 font-medium break-all">{item.target}</span>
                      <span className="text-[11px] text-white/45 tabular-nums">{item.metric}</span>
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-white/40 tabular-nums shrink-0">
                        <Users size={11} />
                        {item.userCount} 人 · {item.eventCount} 次
                      </span>
                    </div>
                    <div className="text-[12px] text-white/60 leading-relaxed">{item.suggestion}</div>
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      {item.evidence.map((line, i) => (
                        <div key={i} className="flex items-baseline gap-1.5 text-[11px] text-white/35">
                          <span className="w-1 h-1 rounded-full shrink-0" style={{ background: meta.accent }} />
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </GlassCard>
  );
}
