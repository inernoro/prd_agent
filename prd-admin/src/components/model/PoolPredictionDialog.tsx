import { Dialog } from '@/components/ui/Dialog';
import { ModelListItem } from '@/components/model/ModelListItem';
import type { PoolPrediction, PredictionStep, PredictionEndpoint } from '@/types';
import {
  Loader2, Radar, Zap, GitBranch, RotateCw, Shuffle, Timer,
  ArrowRight, Check, X, CircleDot, ChevronRight,
} from 'lucide-react';
import { useEffect, useState } from 'react';

interface PoolPredictionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prediction: PoolPrediction | null;
  loading: boolean;
  platformNameById: Map<string, string>;
}

const STRATEGY_META: Record<string, { icon: typeof Zap; label: string; color: string }> = {
  FailFast:       { icon: Zap,       label: '快速失败',  color: 'rgba(251,146,60,0.95)' },
  Race:           { icon: GitBranch, label: '竞速模式',  color: 'rgba(168,85,247,0.95)' },
  Sequential:     { icon: ArrowRight,label: '顺序容灾',  color: 'rgba(56,189,248,0.95)' },
  RoundRobin:     { icon: RotateCw,  label: '轮询均衡',  color: 'rgba(34,197,94,0.95)' },
  WeightedRandom: { icon: Shuffle,   label: '加权随机',  color: 'rgba(251,191,36,0.95)' },
  LeastLatency:   { icon: Timer,     label: '最低延迟',  color: 'rgba(99,102,241,0.95)' },
};

const HEALTH_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  Healthy:     { label: '健康',  color: 'rgba(34,197,94,0.95)',  bg: 'rgba(34,197,94,0.12)' },
  Degraded:    { label: '降权',  color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)',  bg: 'rgba(239,68,68,0.12)' },
};

/* ───────────────────────── main export ───────────────────────── */

export function PoolPredictionDialog({ open, onOpenChange, prediction, loading, platformNameById }: PoolPredictionDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Radar size={16} style={{ color: 'rgba(56,189,248,0.95)' }} />
          调度预测
        </span>
      }
      maxWidth={680}
      content={
        <div className="min-h-[280px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 size={28} className="animate-spin" style={{ color: 'rgba(56,189,248,0.6)' }} />
              <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>正在分析调度路径...</span>
            </div>
          ) : prediction ? (
            <PredictionContent prediction={prediction} platformNameById={platformNameById} />
          ) : null}
        </div>
      }
    />
  );
}

/* ───────────────────────── content body ───────────────────────── */

function PredictionContent({ prediction, platformNameById }: { prediction: PoolPrediction; platformNameById: Map<string, string> }) {
  const meta = STRATEGY_META[prediction.strategy] || STRATEGY_META.FailFast;
  const StrategyIcon = meta.icon;
  const color = meta.color;
  const steps = prediction.prediction?.steps || [];

  return (
    <div className="space-y-5">
      {/* ── 策略头部 ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl"
        style={{ background: `${color}10`, border: `1px solid ${color}20` }}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${color}18` }}
        >
          <StrategyIcon size={18} style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {prediction.poolName}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-md shrink-0" style={{ background: `${color}18`, color }}>
              {meta.label}
            </span>
          </div>
          <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
            {prediction.strategyDescription}
          </div>
        </div>
      </div>

      {/* ── 动画可视化 ── */}
      {steps.length === 0 ? (
        <div className="py-10 text-center">
          <X size={28} className="mx-auto mb-2" style={{ color: 'rgba(239,68,68,0.5)' }} />
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>无可用端点</div>
        </div>
      ) : (
        <DispatchViz
          strategy={prediction.strategy}
          steps={steps}
          endpoints={prediction.allEndpoints}
          color={color}
          platformNameById={platformNameById}
        />
      )}

      {/* ── 端点状态总览（用 ModelListItem） ── */}
      <div>
        <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
          端点状态总览 ({prediction.allEndpoints.length})
        </div>
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}
        >
          <div className="space-y-0.5 p-1.5">
            {prediction.allEndpoints.map((ep, idx) => {
              const hs = HEALTH_STYLE[ep.healthStatus] || HEALTH_STYLE.Healthy;
              return (
                <ModelListItem
                  key={ep.endpointId}
                  model={{
                    platformId: ep.platformId,
                    platformName: platformNameById.get(ep.platformId) || ep.platformName,
                    modelId: ep.modelId,
                  }}
                  index={idx + 1}
                  total={prediction.allEndpoints.length}
                  size="sm"
                  suffix={
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: hs.bg, color: hs.color }}
                    >
                      {hs.label}
                    </span>
                  }
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── visualization router ───────────────────────── */

function DispatchViz(props: {
  strategy: string;
  steps: PredictionStep[];
  endpoints: PredictionEndpoint[];
  color: string;
  platformNameById: Map<string, string>;
}) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    setPhase(0);
    const timers = props.steps.map((_, i) =>
      setTimeout(() => setPhase(i + 1), 300 + i * 280)
    );
    return () => timers.forEach(clearTimeout);
  }, [props.steps]);

  const common = { ...props, phase };

  switch (props.strategy) {
    case 'Race':           return <RaceViz {...common} />;
    case 'WeightedRandom': return <WeightedViz {...common} />;
    case 'RoundRobin':     return <RoundRobinViz {...common} />;
    default:               return <LinearViz {...common} />;
  }
}

type VizProps = {
  steps: PredictionStep[];
  endpoints: PredictionEndpoint[];
  color: string;
  phase: number;
  platformNameById: Map<string, string>;
  strategy?: string;
};

/* ───────────────────── shared: endpoint chip ───────────────────── */

function EndpointChip({ step, ep, color, active, highlight, platformNameById }: {
  step: PredictionStep;
  ep?: PredictionEndpoint;
  color: string;
  active: boolean;
  highlight: boolean;
  platformNameById: Map<string, string>;
}) {
  const platformName = ep ? (platformNameById.get(ep.platformId) || ep.platformName) : '';
  const hs = HEALTH_STYLE[ep?.healthStatus || 'Healthy'] || HEALTH_STYLE.Healthy;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-500"
      style={{
        opacity: active ? 1 : 0.12,
        transform: active ? 'translateX(0)' : 'translateX(-8px)',
        background: highlight ? `${color}10` : 'rgba(255,255,255,0.03)',
        border: `1px solid ${highlight ? `${color}25` : 'rgba(255,255,255,0.06)'}`,
        boxShadow: highlight ? `0 0 16px ${color}12` : 'none',
      }}
    >
      {/* 健康点 */}
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: hs.color }} />
      {/* 平台 */}
      {platformName && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
        >
          {platformName}
        </span>
      )}
      {/* 模型名 */}
      <span className="text-[12px] truncate flex-1 font-mono" style={{ color: 'var(--text-primary)' }}>
        {step.modelId}
      </span>
      {/* 标签 */}
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0"
        style={{
          background: highlight ? `${color}18` : 'rgba(255,255,255,0.05)',
          color: highlight ? color : 'var(--text-muted)',
        }}
      >
        {step.label}
      </span>
      {highlight && active && <Check size={13} style={{ color }} className="shrink-0" />}
    </div>
  );
}

/* ───────────────────── Linear (FailFast / Sequential / LeastLatency) ───────────────────── */

function LinearViz({ steps, endpoints, color, phase, platformNameById, strategy }: VizProps) {
  return (
    <div
      className="rounded-xl px-4 py-4"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* 入口 */}
      <div className="flex items-center gap-3 mb-3">
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold"
          style={{ background: `${color}10`, border: `1px solid ${color}20`, color }}
        >
          <CircleDot size={12} />
          请求入口
        </div>
        <div className="flex-1 relative h-px">
          <div className="absolute inset-0" style={{ background: `linear-gradient(to right, ${color}30, transparent)` }} />
          {/* 流动光点 */}
          <div
            className="absolute top-[-2px] w-1.5 h-1.5 rounded-full"
            style={{
              background: color,
              boxShadow: `0 0 6px ${color}`,
              animation: 'flowDot 2s ease-in-out infinite',
            }}
          />
        </div>
      </div>

      {/* 端点列表 */}
      <div className="space-y-1.5 ml-2">
        {steps.map((step, i) => {
          const ep = endpoints.find(e => e.endpointId === step.endpointId);
          return (
            <div key={step.endpointId + i} className="flex items-center gap-2">
              {/* 连接轨道 */}
              <div className="flex flex-col items-center w-4 shrink-0 self-stretch">
                <div
                  className="w-px flex-1 transition-all duration-500"
                  style={{ background: phase > i ? `${color}40` : 'rgba(255,255,255,0.06)' }}
                />
                <div
                  className="w-2.5 h-2.5 rounded-full border-[1.5px] shrink-0 transition-all duration-500"
                  style={{
                    borderColor: phase > i ? color : 'rgba(255,255,255,0.15)',
                    background: step.isTarget && phase > i ? color : 'transparent',
                    boxShadow: step.isTarget && phase > i ? `0 0 8px ${color}50` : 'none',
                  }}
                />
                <div
                  className="w-px flex-1"
                  style={{ background: i < steps.length - 1 ? 'rgba(255,255,255,0.06)' : 'transparent' }}
                />
              </div>
              {/* 端点 */}
              <div className="flex-1">
                <EndpointChip
                  step={step} ep={ep} color={color}
                  active={phase > i} highlight={step.isTarget}
                  platformNameById={platformNameById}
                />
              </div>
            </div>
          );
        })}
      </div>

      {strategy === 'Sequential' && steps.length > 1 && (
        <div className="mt-3 ml-6 text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
          <ChevronRight size={10} />
          失败自动顺延到下一个端点
        </div>
      )}

      <style>{`
        @keyframes flowDot {
          0% { left: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }
      `}</style>
    </div>
  );
}

/* ───────────────────── Race (并行竞速) ───────────────────── */

function RaceViz({ steps, endpoints, color, phase, platformNameById }: VizProps) {
  const [winner, setWinner] = useState(-1);

  useEffect(() => {
    if (phase >= steps.length) {
      const t = setTimeout(() => setWinner(0), 400);
      return () => clearTimeout(t);
    }
    setWinner(-1);
  }, [phase, steps.length]);

  return (
    <div
      className="rounded-xl px-4 py-4"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* 入口 */}
      <div className="flex justify-center mb-3">
        <div
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-[11px] font-semibold"
          style={{ background: `${color}10`, border: `1px solid ${color}20`, color }}
        >
          <CircleDot size={12} />
          请求入口 — 同时发送到 {steps.length} 个端点
        </div>
      </div>

      {/* SVG 扇出线 */}
      <div className="flex justify-center mb-1">
        <svg width="100%" height="28" viewBox="0 0 400 28" preserveAspectRatio="xMidYMid meet" className="max-w-[420px]">
          <defs>
            <linearGradient id="raceLine" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.5" />
              <stop offset="100%" stopColor={color} stopOpacity="0.15" />
            </linearGradient>
          </defs>
          {steps.map((_, i) => {
            const x = steps.length === 1 ? 200 : 50 + (300 / (steps.length - 1)) * i;
            return (
              <line
                key={i}
                x1="200" y1="0" x2={x} y2="28"
                stroke="url(#raceLine)"
                strokeWidth={phase > i ? 2 : 1}
                strokeOpacity={phase > i ? 1 : 0.15}
                strokeDasharray={phase > i ? 'none' : '4 3'}
                className="transition-all duration-500"
              />
            );
          })}
        </svg>
      </div>

      {/* 端点卡片 */}
      <div className="flex gap-2 flex-wrap justify-center">
        {steps.map((step, i) => {
          const ep = endpoints.find(e => e.endpointId === step.endpointId);
          const hs = HEALTH_STYLE[ep?.healthStatus || 'Healthy'] || HEALTH_STYLE.Healthy;
          const platformName = ep ? (platformNameById.get(ep.platformId) || ep.platformName) : '';
          const isActive = phase > i;
          const isWinner = winner === i;

          return (
            <div
              key={step.endpointId + i}
              className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl transition-all duration-500 min-w-[110px] max-w-[160px]"
              style={{
                opacity: isActive ? 1 : 0.12,
                transform: isActive ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.96)',
                background: isWinner ? `${color}12` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isWinner ? `${color}35` : 'rgba(255,255,255,0.06)'}`,
                boxShadow: isWinner ? `0 0 20px ${color}15` : 'none',
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: hs.color }} />
              {platformName && (
                <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                  {platformName}
                </span>
              )}
              <span className="font-mono text-[11px] truncate max-w-full text-center" style={{ color: 'var(--text-primary)' }}>
                {step.modelId}
              </span>
              {isWinner ? (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-md flex items-center gap-1"
                  style={{ background: `${color}18`, color }}
                >
                  <Check size={10} />
                  最快返回
                </span>
              ) : isActive ? (
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>竞争中...</span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
        并行请求 {steps.length} 个端点，取最先成功返回的结果
      </div>
    </div>
  );
}

/* ───────────────────── Weighted Random (加权概率) ───────────────────── */

function WeightedViz({ steps, endpoints, color, phase, platformNameById }: VizProps) {
  const ARC_COLORS = [
    'rgba(56,189,248,0.85)', 'rgba(168,85,247,0.85)', 'rgba(34,197,94,0.85)',
    'rgba(251,146,60,0.85)', 'rgba(236,72,153,0.85)', 'rgba(99,102,241,0.85)',
  ];

  const total = steps.reduce((s, st) => s + (st.probability || 0), 0);
  let accum = 0;
  const r = 42, cx = 55, cy = 55;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      className="rounded-xl px-4 py-4"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="flex items-center gap-6 justify-center">
        {/* 环形图 */}
        <div className="relative shrink-0" style={{ width: 110, height: 110 }}>
          <svg viewBox="0 0 110 110" className="w-full h-full" style={{ transform: 'rotate(-90deg)' }}>
            {steps.map((step, i) => {
              const pct = step.probability || 0;
              const startAngle = (accum / total) * 360;
              const sliceAngle = (pct / total) * 360;
              accum += pct;

              const dashLen = (sliceAngle / 360) * circumference;
              const dashOffset = -((startAngle / 360) * circumference);
              const clr = ARC_COLORS[i % ARC_COLORS.length];

              return (
                <circle
                  key={i}
                  cx={cx} cy={cy} r={r}
                  fill="none"
                  stroke={clr}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${dashLen - 2} ${circumference - dashLen + 2}`}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-700"
                  style={{ opacity: phase > i ? 1 : 0.08 }}
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Shuffle size={14} style={{ color }} className="mx-auto mb-0.5" />
              <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>随机</div>
            </div>
          </div>
        </div>

        {/* 图例 (用 ModelListItem 风格) */}
        <div className="space-y-1 flex-1 min-w-0">
          {steps.map((step, i) => {
            const ep = endpoints.find(e => e.endpointId === step.endpointId);
            const platformName = ep ? (platformNameById.get(ep.platformId) || ep.platformName) : '';
            const clr = ARC_COLORS[i % ARC_COLORS.length];
            const isActive = phase > i;

            return (
              <div
                key={step.endpointId + i}
                className="flex items-center gap-2 px-2 py-1 rounded-lg transition-all duration-500"
                style={{ opacity: isActive ? 1 : 0.12 }}
              >
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: clr }} />
                {platformName && (
                  <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                    {platformName}
                  </span>
                )}
                <span className="font-mono text-[11px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                  {step.modelId}
                </span>
                <span className="text-[11px] font-semibold tabular-nums shrink-0" style={{ color: clr }}>
                  {step.probability?.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
        每次请求按概率权重随机选择一个端点
      </div>
    </div>
  );
}

/* ───────────────────── RoundRobin (轮询) ───────────────────── */

function RoundRobinViz({ steps, endpoints, color, phase, platformNameById }: VizProps) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (phase < steps.length) return;
    const iv = setInterval(() => setActiveIdx(p => (p + 1) % steps.length), 1200);
    return () => clearInterval(iv);
  }, [phase, steps.length]);

  return (
    <div
      className="rounded-xl px-4 py-4"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* 入口 */}
      <div className="flex justify-center mb-3">
        <div
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-[11px] font-semibold"
          style={{ background: `${color}10`, border: `1px solid ${color}20`, color }}
        >
          <RotateCw size={12} className={phase >= steps.length ? 'animate-spin' : ''} style={{ animationDuration: '3s' }} />
          轮询调度
        </div>
      </div>

      {/* 端点列表，当前高亮轮换 */}
      <div className="space-y-1.5">
        {steps.map((step, i) => {
          const ep = endpoints.find(e => e.endpointId === step.endpointId);
          const isCurrent = phase >= steps.length && activeIdx === i;
          const isActive = phase > i;
          const hs = HEALTH_STYLE[ep?.healthStatus || 'Healthy'] || HEALTH_STYLE.Healthy;
          const platformName = ep ? (platformNameById.get(ep.platformId) || ep.platformName) : '';

          return (
            <div
              key={step.endpointId + i}
              className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-400"
              style={{
                opacity: isActive ? 1 : 0.12,
                background: isCurrent ? `${color}10` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isCurrent ? `${color}30` : 'rgba(255,255,255,0.06)'}`,
                boxShadow: isCurrent ? `0 0 12px ${color}12` : 'none',
              }}
            >
              {/* 轮询指示 */}
              <div
                className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-all duration-300"
                style={{
                  background: isCurrent ? `${color}20` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${isCurrent ? `${color}40` : 'rgba(255,255,255,0.08)'}`,
                }}
              >
                {isCurrent ? (
                  <ArrowRight size={10} style={{ color }} />
                ) : (
                  <span className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                )}
              </div>
              {/* 健康点 */}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: hs.color }} />
              {/* 平台 */}
              {platformName && (
                <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                  {platformName}
                </span>
              )}
              {/* 模型名 */}
              <span className="font-mono text-[12px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                {step.modelId}
              </span>
              {isCurrent && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0" style={{ background: `${color}18`, color }}>
                  当前
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
        请求按顺序均匀分配到 {steps.length} 个端点
      </div>
    </div>
  );
}
