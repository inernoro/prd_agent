import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck, TrendingDown, RefreshCw } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getModelGroupHealthOverview } from '@/services';
import { getModelTypeDisplayName } from '@/lib/appCallerUtils';
import type {
  ModelGroupHealthOverview,
  HealthAlarm,
  FallbackTypeStat,
} from '@/types/modelGroup';

interface PoolHealthOverviewProps {
  /** 数据刷新触发器：父页面增删改池后 +1，总览随之重新拉取 */
  refreshKey?: number;
  /** 点击死池告警时定位到对应池（父页面负责高亮/滚动） */
  onLocatePool?: (poolId: string) => void;
  /** 点击高 fallback 告警时按 modelType 过滤 */
  onLocateModelType?: (modelType: string) => void;
}

const ALARM_LEVEL_STYLE: Record<
  HealthAlarm['level'],
  { bg: string; border: string; color: string; Icon: typeof AlertTriangle }
> = {
  critical: {
    bg: 'rgba(239,68,68,0.10)',
    border: 'rgba(239,68,68,0.30)',
    color: 'rgba(239,68,68,0.95)',
    Icon: ShieldAlert,
  },
  warning: {
    bg: 'rgba(251,146,60,0.10)',
    border: 'rgba(251,146,60,0.30)',
    color: 'rgba(251,146,60,0.95)',
    Icon: AlertTriangle,
  },
};

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** fallback 率配色：>=20% 橙色（告警阈值），>=5% 黄，否则中性 */
function fallbackColor(rate: number): string {
  if (rate >= 0.2) return 'rgba(251,146,60,0.95)';
  if (rate >= 0.05) return 'rgba(251,191,36,0.95)';
  return 'var(--text-muted)';
}

export function PoolHealthOverview({
  refreshKey = 0,
  onLocatePool,
  onLocateModelType,
}: PoolHealthOverviewProps) {
  const [data, setData] = useState<ModelGroupHealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getModelGroupHealthOverview(7);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载健康总览失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading && !data) {
    return (
      <GlassCard className="shrink-0 p-0 overflow-hidden">
        <div className="px-4 py-5">
          <MapSectionLoader text="正在加载模型池健康总览..." />
        </div>
      </GlassCard>
    );
  }

  if (error && !data) {
    return (
      <GlassCard className="shrink-0 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <AlertTriangle size={14} style={{ color: 'rgba(251,146,60,0.95)' }} />
            <span>健康总览加载失败：{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-md"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-input)' }}
          >
            <RefreshCw size={12} />
            重试
          </button>
        </div>
      </GlassCard>
    );
  }

  if (!data) return null;

  const alarms = data.alarms ?? [];
  const fallbackByType: FallbackTypeStat[] = (data.fallbackByType ?? [])
    .filter((f) => f.total > 0)
    .slice(0, 6);
  const hasAlarms = alarms.length > 0;
  const criticalCount = alarms.filter((a) => a.level === 'critical').length;
  const warningCount = alarms.length - criticalCount;

  return (
    <GlassCard
      className="shrink-0 p-0 overflow-hidden"
      style={
        hasAlarms
          ? {
              borderColor:
                criticalCount > 0 ? 'rgba(239,68,68,0.30)' : 'rgba(251,146,60,0.30)',
            }
          : undefined
      }
    >
      <div className="p-3 flex flex-col gap-3">
        {/* 标题行 + 概况 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {hasAlarms ? (
              <ShieldAlert
                size={16}
                style={{ color: criticalCount > 0 ? 'rgba(239,68,68,0.95)' : 'rgba(251,146,60,0.95)' }}
              />
            ) : (
              <ShieldCheck size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
            )}
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              健康总览
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              近 {data.days} 天 · {data.pools.length} 个池
            </span>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            title="刷新健康总览"
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-input)' }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>

        {/* 告警区 / 全部健康绿条 */}
        {hasAlarms ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {criticalCount > 0 && (
                <span style={{ color: 'rgba(239,68,68,0.95)' }}>{criticalCount} 项严重</span>
              )}
              {criticalCount > 0 && warningCount > 0 && <span> · </span>}
              {warningCount > 0 && (
                <span style={{ color: 'rgba(251,146,60,0.95)' }}>{warningCount} 项警告</span>
              )}
            </div>
            {alarms.map((a, idx) => {
              const style = ALARM_LEVEL_STYLE[a.level];
              const AlarmIcon = a.kind === 'high-fallback' ? TrendingDown : style.Icon;
              const clickable =
                (a.kind === 'dead-pool' && !!a.poolId && !!onLocatePool) ||
                (a.kind === 'high-fallback' && !!a.modelType && !!onLocateModelType);
              return (
                <button
                  key={`${a.kind}-${a.target}-${idx}`}
                  type="button"
                  disabled={!clickable}
                  onClick={() => {
                    if (a.kind === 'dead-pool' && a.poolId) onLocatePool?.(a.poolId);
                    else if (a.kind === 'high-fallback' && a.modelType) onLocateModelType?.(a.modelType);
                  }}
                  className="flex items-start gap-2 px-2.5 py-2 rounded-lg text-left w-full transition-opacity"
                  style={{
                    background: style.bg,
                    border: `1px solid ${style.border}`,
                    cursor: clickable ? 'pointer' : 'default',
                  }}
                >
                  <AlarmIcon size={14} className="shrink-0 mt-px" style={{ color: style.color }} />
                  <span className="text-[12px] leading-snug" style={{ color: 'var(--text-primary)' }}>
                    {a.detail}
                    {clickable && (
                      <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        点击定位
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
            style={{
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.22)',
            }}
          >
            <ShieldCheck size={14} style={{ color: 'rgba(34,197,94,0.95)' }} />
            <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              全部健康：无死池、无高 fallback 告警
            </span>
          </div>
        )}

        {/* 近 7 天 fallback 率（按 modelType 迷你列表） */}
        {fallbackByType.length > 0 && (
          <div className="flex flex-col gap-1 pt-0.5">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              近 {data.days} 天 fallback 率（按模型类型）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {fallbackByType.map((f) => {
                const color = fallbackColor(f.fallbackRate);
                const clickable = !!onLocateModelType;
                return (
                  <button
                    key={f.modelType}
                    type="button"
                    disabled={!clickable}
                    onClick={() => onLocateModelType?.(f.modelType)}
                    title={
                      f.topFallbackReasons.length > 0
                        ? `主要原因：${f.topFallbackReasons.map((r) => `${r.reason}(${r.count})`).join('、')}`
                        : undefined
                    }
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md transition-opacity"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-subtle)',
                      cursor: clickable ? 'pointer' : 'default',
                    }}
                  >
                    <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      {getModelTypeDisplayName(f.modelType)}
                    </span>
                    <span className="text-[11px] font-mono font-medium" style={{ color }}>
                      {fmtPct(f.fallbackRate)}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      ({f.fallbackCount}/{f.total})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  );
}
