import { Clock, DollarSign, TrendingUp, Zap } from 'lucide-react';
import { formatDuration, formatCompactZh, calculateSuccessRate } from '@/lib/formatStats';
import { Tooltip } from '@/components/ui/Tooltip';

type AggregatedModelStats = {
  requestCount: number;
  avgDurationMs: number | null;
  avgTtfbMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  successCount?: number;
  failCount?: number;
};

type PlatformPricing = {
  currency: string;
  inPer1k: number;
  outPer1k: number;
};

function estimateCost(stats: { totalInputTokens: number; totalOutputTokens: number }, pricing: PlatformPricing | null): number | null {
  if (!pricing) return null;
  const inCost = (Math.max(0, stats.totalInputTokens) / 1000) * pricing.inPer1k;
  const outCost = (Math.max(0, stats.totalOutputTokens) / 1000) * pricing.outPer1k;
  const total = inCost + outCost;
  return Number.isFinite(total) ? total : null;
}

function formatMoney(v: number, currency: string) {
  if (!Number.isFinite(v)) return '';
  if (v >= 1000) return `${currency}${v.toFixed(0)}`;
  if (v >= 10) return `${currency}${v.toFixed(1)}`;
  return `${currency}${v.toFixed(2)}`;
}

/**
 * KPI Rail 组件：显示3个核心指标
 * 1. TTFB（首字延迟）
 * 2. 成功率
 * 3. 成本/量级（tokens或费用）
 */
export function ModelKpiRail({
  stats,
  pricing,
  titlePrefix = '近7天',
}: {
  stats: AggregatedModelStats | null;
  pricing: PlatformPricing | null;
  titlePrefix?: string;
}) {
  if (!stats) return null;

  // 1. TTFB
  const ttfb = formatDuration(stats.avgTtfbMs);

  // 2. 成功率
  const successRate = calculateSuccessRate(
    stats.successCount ?? stats.requestCount,
    stats.requestCount
  );

  // 3. 成本/量级
  const cost = estimateCost(stats, pricing);
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const tokensText = totalTokens > 0 ? formatCompactZh(totalTokens) : null;

  return (
    <div className="flex items-center gap-4 shrink-0">
      {/* TTFB */}
      <Tooltip content={`${titlePrefix} · 首字延迟（TTFB）`}>
        <div className="flex items-center gap-1.5">
          <Zap size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[13px] font-semibold" style={{ color: ttfb.color }}>
            {ttfb.text}
          </span>
        </div>
      </Tooltip>

      {/* 成功率 */}
      <Tooltip content={`${titlePrefix} · 成功率`}>
        <div className="flex items-center gap-1.5">
          <TrendingUp size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[13px] font-semibold" style={{ color: successRate.color }}>
            {successRate.text}
          </span>
        </div>
      </Tooltip>

      {/* 成本/量级 */}
      {cost != null && pricing ? (
        <Tooltip content={`${titlePrefix} · 成本估算（基于本地单价配置）`}>
          <div className="flex items-center gap-1.5">
            <DollarSign size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatMoney(cost, pricing.currency || '¥')}
            </span>
          </div>
        </Tooltip>
      ) : tokensText ? (
        <Tooltip content={`${titlePrefix} · Token 总量`}>
          <div className="flex items-center gap-1.5">
            <Clock size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {tokensText}
            </span>
          </div>
        </Tooltip>
      ) : null}
    </div>
  );
}

