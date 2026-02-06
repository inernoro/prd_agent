import { Dialog } from '@/components/ui/Dialog';
import type { PoolPrediction, PredictionStep, PredictionEndpoint } from '@/types';
import { Loader2, Radar, Zap, GitBranch, RotateCw, Shuffle, Timer, ArrowRight, Check, X, CircleDot } from 'lucide-react';
import { useEffect, useState } from 'react';

interface PoolPredictionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prediction: PoolPrediction | null;
  loading: boolean;
  platformNameById: Map<string, string>;
}

const STRATEGY_ICONS: Record<string, typeof Zap> = {
  FailFast: Zap,
  Race: GitBranch,
  Sequential: ArrowRight,
  RoundRobin: RotateCw,
  WeightedRandom: Shuffle,
  LeastLatency: Timer,
};

const STRATEGY_COLORS: Record<string, string> = {
  FailFast: 'rgba(251,146,60,0.95)',
  Race: 'rgba(168,85,247,0.95)',
  Sequential: 'rgba(56,189,248,0.95)',
  RoundRobin: 'rgba(34,197,94,0.95)',
  WeightedRandom: 'rgba(251,191,36,0.95)',
  LeastLatency: 'rgba(99,102,241,0.95)',
};

const HEALTH_DOT: Record<string, string> = {
  Healthy: 'rgba(34,197,94,0.95)',
  Degraded: 'rgba(251,191,36,0.95)',
  Unavailable: 'rgba(239,68,68,0.95)',
};

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
        <div className="min-h-[300px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 size={32} className="animate-spin" style={{ color: 'rgba(56,189,248,0.6)' }} />
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

function PredictionContent({ prediction, platformNameById }: { prediction: PoolPrediction; platformNameById: Map<string, string> }) {
  const strategy = prediction.strategy;
  const StrategyIcon = STRATEGY_ICONS[strategy] || Zap;
  const strategyColor = STRATEGY_COLORS[strategy] || 'rgba(56,189,248,0.95)';
  const steps = prediction.prediction?.steps || [];

  return (
    <div className="space-y-5">
      {/* 策略标题 */}
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl"
        style={{ background: `${strategyColor}12`, border: `1px solid ${strategyColor}28` }}
      >
        <StrategyIcon size={20} style={{ color: strategyColor }} />
        <div className="flex-1">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {prediction.poolName}
            <span className="ml-2 text-[12px] font-normal px-2 py-0.5 rounded-md" style={{ background: `${strategyColor}18`, color: strategyColor }}>
              {strategy}
            </span>
          </div>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {prediction.strategyDescription}
          </div>
        </div>
      </div>

      {/* 动画可视化区域 */}
      {steps.length === 0 ? (
        <div className="py-10 text-center">
          <X size={32} className="mx-auto mb-2" style={{ color: 'rgba(239,68,68,0.6)' }} />
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>无可用端点</div>
        </div>
      ) : (
        <DispatchVisualization
          strategy={strategy}
          steps={steps}
          endpoints={prediction.allEndpoints}
          strategyColor={strategyColor}
          platformNameById={platformNameById}
        />
      )}

      {/* 所有端点状态总览 */}
      <div>
        <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
          端点状态总览
        </div>
        <div className="space-y-1">
          {prediction.allEndpoints.map((ep) => (
            <EndpointRow key={ep.endpointId} endpoint={ep} platformNameById={platformNameById} />
          ))}
        </div>
      </div>
    </div>
  );
}

function EndpointRow({ endpoint, platformNameById }: { endpoint: PredictionEndpoint; platformNameById: Map<string, string> }) {
  const dotColor = HEALTH_DOT[endpoint.healthStatus] || HEALTH_DOT.Healthy;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px]"
      style={{
        background: endpoint.isAvailable ? 'rgba(255,255,255,0.03)' : 'rgba(239,68,68,0.06)',
        opacity: endpoint.isAvailable ? 1 : 0.5,
      }}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor }} />
      <span className="font-mono truncate flex-1" style={{ color: 'var(--text-primary)' }}>
        {endpoint.modelId}
      </span>
      <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
        {platformNameById.get(endpoint.platformId) || endpoint.platformName}
      </span>
      <span className="text-[10px] shrink-0 tabular-nums w-10 text-right" style={{ color: 'var(--text-muted)' }}>
        P{endpoint.priority}
      </span>
      <span
        className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
        style={{ background: `${dotColor}18`, color: dotColor }}
      >
        {endpoint.healthScore.toFixed(0)}%
      </span>
    </div>
  );
}

/** 核心动画可视化组件 */
function DispatchVisualization({
  strategy,
  steps,
  endpoints,
  strategyColor,
  platformNameById,
}: {
  strategy: string;
  steps: PredictionStep[];
  endpoints: PredictionEndpoint[];
  strategyColor: string;
  platformNameById: Map<string, string>;
}) {
  const [animPhase, setAnimPhase] = useState(0); // 0=init, then incrementally animate steps
  useEffect(() => {
    setAnimPhase(0);
    // stagger animation
    const timers: ReturnType<typeof setTimeout>[] = [];
    steps.forEach((_, i) => {
      const t = setTimeout(() => setAnimPhase(i + 1), 400 + i * 350);
      timers.push(t);
    });
    return () => timers.forEach(clearTimeout);
  }, [steps]);

  if (strategy === 'Race') {
    return <RaceVisualization steps={steps} animPhase={animPhase} strategyColor={strategyColor} endpoints={endpoints} platformNameById={platformNameById} />;
  }

  if (strategy === 'WeightedRandom') {
    return <WeightedVisualization steps={steps} animPhase={animPhase} strategyColor={strategyColor} endpoints={endpoints} platformNameById={platformNameById} />;
  }

  if (strategy === 'RoundRobin') {
    return <RoundRobinVisualization steps={steps} animPhase={animPhase} strategyColor={strategyColor} endpoints={endpoints} platformNameById={platformNameById} />;
  }

  // FailFast, Sequential, LeastLatency — linear flow
  return <LinearVisualization steps={steps} animPhase={animPhase} strategyColor={strategyColor} strategy={strategy} endpoints={endpoints} platformNameById={platformNameById} />;
}

/** 线性流 (FailFast / Sequential / LeastLatency) */
function LinearVisualization({
  steps, animPhase, strategyColor, strategy, endpoints, platformNameById,
}: {
  steps: PredictionStep[];
  animPhase: number;
  strategyColor: string;
  strategy: string;
  endpoints: PredictionEndpoint[];
  platformNameById: Map<string, string>;
}) {
  return (
    <div className="relative py-2">
      {/* 请求源 */}
      <div className="flex items-center gap-3 mb-4">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12px] font-semibold"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'var(--text-primary)',
          }}
        >
          <CircleDot size={14} style={{ color: strategyColor }} />
          请求入口
        </div>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${strategyColor}40, transparent)` }} />
      </div>

      {/* 步骤列表 */}
      <div className="space-y-2 pl-4">
        {steps.map((step, i) => {
          const isActive = animPhase > i;
          const ep = endpoints.find(e => e.endpointId === step.endpointId);
          const healthColor = ep ? HEALTH_DOT[ep.healthStatus] || HEALTH_DOT.Healthy : HEALTH_DOT.Healthy;

          return (
            <div
              key={step.endpointId + i}
              className="flex items-center gap-3 transition-all duration-500"
              style={{
                opacity: isActive ? 1 : 0.15,
                transform: isActive ? 'translateX(0)' : 'translateX(-12px)',
              }}
            >
              {/* 连接线 */}
              <div className="relative flex flex-col items-center w-6 shrink-0">
                {i > 0 && (
                  <div className="w-px h-3 -mt-2" style={{ background: step.isTarget ? strategyColor : 'rgba(255,255,255,0.12)' }} />
                )}
                <div
                  className="w-3 h-3 rounded-full border-2 shrink-0 transition-all duration-300"
                  style={{
                    borderColor: step.isTarget ? strategyColor : 'rgba(255,255,255,0.2)',
                    background: step.isTarget && isActive ? strategyColor : 'transparent',
                    boxShadow: step.isTarget && isActive ? `0 0 12px ${strategyColor}60` : 'none',
                  }}
                />
                {i < steps.length - 1 && (
                  <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />
                )}
              </div>

              {/* 端点卡片 */}
              <div
                className="flex-1 flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-500"
                style={{
                  background: step.isTarget && isActive ? `${strategyColor}12` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${step.isTarget && isActive ? `${strategyColor}30` : 'rgba(255,255,255,0.06)'}`,
                  boxShadow: step.isTarget && isActive ? `0 0 20px ${strategyColor}15` : 'none',
                }}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: healthColor }} />
                <span className="font-mono text-[12px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                  {step.modelId}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0" style={{
                  background: step.isTarget ? `${strategyColor}18` : 'rgba(255,255,255,0.06)',
                  color: step.isTarget ? strategyColor : 'var(--text-muted)',
                }}>
                  {step.label}
                </span>
                {step.isTarget && isActive && (
                  <Check size={14} style={{ color: strategyColor }} className="shrink-0 animate-bounce-once" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部说明 */}
      {strategy === 'Sequential' && steps.length > 1 && (
        <div className="mt-3 ml-4 text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
          <ArrowRight size={11} />
          失败时自动切换到下一个端点
        </div>
      )}
    </div>
  );
}

/** 竞速模式 — 并行扇出 */
function RaceVisualization({
  steps, animPhase, strategyColor, endpoints, platformNameById,
}: {
  steps: PredictionStep[];
  animPhase: number;
  strategyColor: string;
  endpoints: PredictionEndpoint[];
  platformNameById: Map<string, string>;
}) {
  const [pulseIdx, setPulseIdx] = useState(-1);

  useEffect(() => {
    if (animPhase >= steps.length) {
      // 随机高亮一个作为"最快返回"
      const timer = setTimeout(() => setPulseIdx(0), 300);
      return () => clearTimeout(timer);
    }
  }, [animPhase, steps.length]);

  return (
    <div className="py-2">
      {/* 请求源 */}
      <div className="flex justify-center mb-4">
        <div
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold"
          style={{
            background: `${strategyColor}12`,
            border: `1px solid ${strategyColor}28`,
            color: strategyColor,
          }}
        >
          <CircleDot size={14} />
          请求入口 — 同时发送
        </div>
      </div>

      {/* 扇出线 */}
      <div className="flex justify-center mb-2">
        <svg width="100%" height="24" viewBox="0 0 400 24" preserveAspectRatio="xMidYMid meet" className="max-w-[400px]">
          {steps.map((_, i) => {
            const x = steps.length === 1 ? 200 : 60 + (280 / (steps.length - 1)) * i;
            return (
              <line
                key={i}
                x1="200" y1="0" x2={x} y2="24"
                stroke={strategyColor}
                strokeWidth="1.5"
                strokeOpacity={animPhase > i ? 0.6 : 0.1}
                strokeDasharray={animPhase > i ? 'none' : '4 4'}
                className="transition-all duration-500"
              />
            );
          })}
        </svg>
      </div>

      {/* 端点并排 */}
      <div className="flex gap-2 flex-wrap justify-center">
        {steps.map((step, i) => {
          const isActive = animPhase > i;
          const isWinner = pulseIdx === i;
          const ep = endpoints.find(e => e.endpointId === step.endpointId);
          const healthColor = ep ? HEALTH_DOT[ep.healthStatus] || HEALTH_DOT.Healthy : HEALTH_DOT.Healthy;

          return (
            <div
              key={step.endpointId + i}
              className="flex flex-col items-center gap-1.5 px-3 py-2.5 rounded-xl transition-all duration-500 min-w-[120px]"
              style={{
                opacity: isActive ? 1 : 0.15,
                transform: isActive ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.95)',
                background: isWinner ? `${strategyColor}15` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isWinner ? `${strategyColor}40` : 'rgba(255,255,255,0.06)'}`,
                boxShadow: isWinner ? `0 0 24px ${strategyColor}20` : 'none',
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: healthColor }} />
              <span className="font-mono text-[11px] truncate max-w-[100px]" style={{ color: 'var(--text-primary)' }}>
                {step.modelId}
              </span>
              {isWinner && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-md animate-pulse"
                  style={{ background: `${strategyColor}20`, color: strategyColor }}
                >
                  最快返回
                </span>
              )}
              {!isWinner && isActive && (
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>竞争中</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
        同时请求 {steps.length} 个端点，取最先返回的成功结果
      </div>
    </div>
  );
}

/** 加权随机 — 饼图式概率展示 */
function WeightedVisualization({
  steps, animPhase, strategyColor, endpoints, platformNameById,
}: {
  steps: PredictionStep[];
  animPhase: number;
  strategyColor: string;
  endpoints: PredictionEndpoint[];
  platformNameById: Map<string, string>;
}) {
  const colors = [
    'rgba(56,189,248,0.85)',
    'rgba(168,85,247,0.85)',
    'rgba(34,197,94,0.85)',
    'rgba(251,146,60,0.85)',
    'rgba(251,191,36,0.85)',
    'rgba(236,72,153,0.85)',
  ];

  // 计算弧形
  const total = steps.reduce((s, st) => s + (st.probability || 0), 0);
  let accum = 0;

  return (
    <div className="py-2">
      <div className="flex items-start gap-6 justify-center">
        {/* 环形图 */}
        <div className="relative w-[140px] h-[140px] shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            {steps.map((step, i) => {
              const pct = step.probability || 0;
              const startAngle = (accum / total) * 360;
              const sliceAngle = (pct / total) * 360;
              accum += pct;

              const isActive = animPhase > i;
              const r = 38;
              const circumference = 2 * Math.PI * r;
              const dashLen = (sliceAngle / 360) * circumference;
              const dashOffset = -((startAngle / 360) * circumference);

              return (
                <circle
                  key={i}
                  cx="50" cy="50" r={r}
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth="10"
                  strokeDasharray={`${dashLen} ${circumference - dashLen}`}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-700"
                  style={{ opacity: isActive ? 1 : 0.1 }}
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Shuffle size={16} style={{ color: strategyColor }} className="mx-auto mb-0.5" />
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>随机</div>
            </div>
          </div>
        </div>

        {/* 图例 */}
        <div className="space-y-1.5 pt-2">
          {steps.map((step, i) => {
            const isActive = animPhase > i;
            return (
              <div
                key={step.endpointId + i}
                className="flex items-center gap-2 transition-all duration-500"
                style={{ opacity: isActive ? 1 : 0.15 }}
              >
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colors[i % colors.length] }} />
                <span className="font-mono text-[11px] truncate max-w-[140px]" style={{ color: 'var(--text-primary)' }}>
                  {step.modelId}
                </span>
                <span className="text-[11px] font-semibold tabular-nums" style={{ color: colors[i % colors.length] }}>
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

/** 轮询模式 — 旋转动画 */
function RoundRobinVisualization({
  steps, animPhase, strategyColor, endpoints, platformNameById,
}: {
  steps: PredictionStep[];
  animPhase: number;
  strategyColor: string;
  endpoints: PredictionEndpoint[];
  platformNameById: Map<string, string>;
}) {
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (animPhase < steps.length) return;
    const interval = setInterval(() => {
      setActiveIdx(prev => (prev + 1) % steps.length);
    }, 1200);
    return () => clearInterval(interval);
  }, [animPhase, steps.length]);

  const radius = 60;
  const cx = 80, cy = 80;

  return (
    <div className="py-2">
      <div className="flex justify-center">
        <div className="relative" style={{ width: 160, height: 160 }}>
          <svg width="160" height="160" viewBox="0 0 160 160">
            {/* 中心 */}
            <circle cx={cx} cy={cy} r="16" fill={`${strategyColor}15`} stroke={strategyColor} strokeWidth="1" strokeOpacity="0.3" />
            <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill={strategyColor}>轮询</text>

            {/* 端点圆形排列 */}
            {steps.map((step, i) => {
              const angle = (2 * Math.PI * i) / steps.length - Math.PI / 2;
              const ex = cx + radius * Math.cos(angle);
              const ey = cy + radius * Math.sin(angle);
              const isActive = animPhase > i;
              const isCurrent = animPhase >= steps.length && activeIdx === i;
              const ep = endpoints.find(e => e.endpointId === step.endpointId);
              const healthColor = ep ? HEALTH_DOT[ep.healthStatus] || HEALTH_DOT.Healthy : HEALTH_DOT.Healthy;

              return (
                <g key={step.endpointId + i}>
                  {/* 连接线 */}
                  <line
                    x1={cx} y1={cy} x2={ex} y2={ey}
                    stroke={isCurrent ? strategyColor : 'rgba(255,255,255,0.1)'}
                    strokeWidth={isCurrent ? 2 : 1}
                    strokeDasharray={isCurrent ? 'none' : '3 3'}
                    className="transition-all duration-300"
                  />
                  {/* 节点 */}
                  <circle
                    cx={ex} cy={ey} r={isCurrent ? 14 : 12}
                    fill={isCurrent ? `${strategyColor}25` : 'rgba(255,255,255,0.05)'}
                    stroke={isCurrent ? strategyColor : 'rgba(255,255,255,0.15)'}
                    strokeWidth={isCurrent ? 2 : 1}
                    className="transition-all duration-300"
                    style={{ opacity: isActive ? 1 : 0.15 }}
                  />
                  {/* 健康点 */}
                  <circle cx={ex} cy={ey} r="3" fill={healthColor} style={{ opacity: isActive ? 1 : 0.15 }} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* 当前选中标签 */}
      <div className="flex flex-wrap gap-2 justify-center mt-2">
        {steps.map((step, i) => {
          const isCurrent = animPhase >= steps.length && activeIdx === i;
          return (
            <span
              key={step.endpointId + i}
              className="font-mono text-[11px] px-2 py-1 rounded-lg transition-all duration-300"
              style={{
                background: isCurrent ? `${strategyColor}15` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isCurrent ? `${strategyColor}30` : 'rgba(255,255,255,0.06)'}`,
                color: isCurrent ? strategyColor : 'var(--text-muted)',
              }}
            >
              {step.modelId}
            </span>
          );
        })}
      </div>

      <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
        请求按顺序均匀分配到 {steps.length} 个端点
      </div>
    </div>
  );
}
