import { cn } from '@/lib/cn';
import { useEffect, useState } from 'react';
import ShinyText from '@/components/reactbits/ShinyText';
import { SectionHeader } from '@/components/design/SectionHeader';

// Simple model badges grid - clean and no overlap
function ModelCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const models = [
    { name: 'GPT-4', color: '#10a37f' },
    { name: 'Claude', color: '#d4a574' },
    { name: 'Gemini', color: '#4285f4' },
    { name: 'Llama', color: '#0467df' },
    { name: 'Qwen', color: '#6c5ce7' },
    { name: 'DeepSeek', color: '#00d4aa' },
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % models.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [models.length]);

  return (
    <div className="mt-6 space-y-4">
      {/* Model badges - 2 rows */}
      <div className="grid grid-cols-3 gap-2">
        {models.map((model, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={model.name}
              onClick={() => setActiveIndex(i)}
              className={cn(
                'px-3 py-2 rounded-lg border text-center transition-all duration-300',
                isActive
                  ? 'border-white/30 bg-white/10'
                  : 'border-white/10 bg-white/5 hover:bg-white/10'
              )}
              style={{
                boxShadow: isActive ? `0 0 15px ${model.color}40` : 'none',
              }}
            >
              <span
                className="font-medium text-xs"
                style={{ color: isActive ? model.color : `${model.color}99` }}
              >
                {model.name}
              </span>
            </button>
          );
        })}
      </div>
      {/* Status indicator */}
      <div className="flex items-center justify-center gap-2 text-xs text-white/50">
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: models[activeIndex].color }} />
        <span>智能调度至 <ShinyText text={models[activeIndex].name} color={`${models[activeIndex].color}99`} shineColor={models[activeIndex].color} speed={2.5} className="font-medium" /></span>
      </div>
    </div>
  );
}

// Animated speed meter - simplified layout (reserved for future use)
// @ts-expect-error Reserved for future use
function _SpeedMeter() {
  const [value, setValue] = useState(50);

  useEffect(() => {
    const interval = setInterval(() => {
      setValue(30 + Math.random() * 40);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="mt-6 flex flex-col items-center">
      {/* Arc gauge */}
      <svg className="w-28 h-14" viewBox="0 0 100 50">
        <defs>
          <linearGradient id="speedGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#22c55e" />
            <stop offset="50%" stopColor="#eab308" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
        </defs>
        <path
          d="M 10 45 A 40 40 0 0 1 90 45"
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M 10 45 A 40 40 0 0 1 90 45"
          fill="none"
          stroke="url(#speedGrad)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="126"
          strokeDashoffset={126 - (value / 100) * 126}
          style={{ transition: 'stroke-dashoffset 1s ease-out' }}
        />
      </svg>
      {/* Value */}
      <div className="flex items-baseline gap-1 -mt-2">
        <span className="text-3xl font-bold text-white">{Math.round(value)}</span>
        <span className="text-sm text-white/50">ms</span>
      </div>
    </div>
  );
}

// Security shield animation
function SecurityShield() {
  return (
    <div className="mt-4 flex flex-col items-center gap-4">
      {/* Shield with pulsing rings */}
      <div className="relative flex items-center justify-center h-20">
        {/* Pulsing rings */}
        <div className="absolute w-16 h-16 rounded-full border border-emerald-500/30 animate-[ping_2s_ease-in-out_infinite]" />
        <div className="absolute w-12 h-12 rounded-full border border-emerald-500/40 animate-[ping_2s_ease-in-out_0.5s_infinite]" />
        {/* Shield */}
        <div className="relative w-12 h-14 flex items-center justify-center">
          <svg className="w-12 h-14 text-emerald-500" viewBox="0 0 24 28" fill="currentColor">
            <path d="M12 0L2 5v7c0 7.5 4.5 14.5 10 17 5.5-2.5 10-9.5 10-17V5L12 0z" fillOpacity="0.2" />
            <path d="M12 0L2 5v7c0 7.5 4.5 14.5 10 17 5.5-2.5 10-9.5 10-17V5L12 0zm0 2.18l8 3.82v5c0 6.5-3.9 12.5-8 14.9-4.1-2.4-8-8.4-8-14.9V6l8-3.82z" fillOpacity="0.5" />
          </svg>
          <svg className="absolute w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>
      {/* Labels */}
      <div className="flex justify-center gap-2 text-xs flex-wrap">
        {['加密传输', '权限管控', '审计日志'].map((label) => (
          <span key={label} className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400/80 border border-emerald-500/20">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Server rack animation
function ServerRack() {
  const [activeServer, setActiveServer] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveServer((prev) => (prev + 1) % 3);
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative h-28 mt-4 flex items-center justify-center">
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn(
              'relative w-16 h-24 rounded-lg border transition-all duration-500',
              activeServer === i
                ? 'bg-purple-500/20 border-purple-500/50 shadow-lg shadow-purple-500/20'
                : 'bg-white/5 border-white/10'
            )}
          >
            {/* Server LEDs */}
            <div className="absolute top-2 left-2 right-2 flex gap-1">
              <div className={cn(
                'w-1.5 h-1.5 rounded-full transition-colors duration-300',
                activeServer === i ? 'bg-green-400 animate-pulse' : 'bg-white/20'
              )} />
              <div className={cn(
                'w-1.5 h-1.5 rounded-full transition-colors duration-300',
                activeServer === i ? 'bg-amber-400 animate-pulse' : 'bg-white/20'
              )} />
            </div>
            {/* Vent lines */}
            <div className="absolute bottom-3 left-2 right-2 space-y-1">
              {[0, 1, 2].map((j) => (
                <div key={j} className="h-0.5 bg-white/10 rounded" />
              ))}
            </div>
            {/* Label */}
            <div className="absolute -bottom-5 left-0 right-0 text-center text-[10px] text-white/40">
              {['主节点', '备份', '灾备'][i]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// API Code animation
function ApiCodeBlock() {
  const [typedCode, setTypedCode] = useState('');
  const fullCode = `POST /api/v1/chat
{
  "model": "gpt-4",
  "messages": [...]
}

> 200 OK (47ms)`;

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      if (i <= fullCode.length) {
        setTypedCode(fullCode.slice(0, i));
        i++;
      } else {
        setTimeout(() => {
          i = 0;
          setTypedCode('');
        }, 2000);
      }
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative mt-4">
      <div className="bg-black/60 rounded-lg border border-white/10 p-3 font-mono text-xs">
        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/10">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-white/30 text-[10px] ml-2">api-request.sh</span>
        </div>
        <pre className="text-green-400/80 whitespace-pre-wrap h-20 overflow-hidden">
          {typedCode}
          <span className="animate-[blink_1s_step-end_infinite] text-white">|</span>
        </pre>
      </div>
    </div>
  );
}

// Workflow diagram
function WorkflowDiagram() {
  return (
    <div className="relative h-28 mt-4 flex items-center justify-center">
      <div className="flex items-center gap-2">
        {[
          { label: '输入', color: 'blue' },
          { label: '处理', color: 'purple' },
          { label: '输出', color: 'gold' },
        ].map((step, i) => (
          <div key={step.label} className="flex items-center">
            <div className={cn(
              'w-16 h-16 rounded-xl flex flex-col items-center justify-center gap-1 border transition-all',
              step.color === 'blue' && 'bg-blue-500/10 border-blue-500/30',
              step.color === 'purple' && 'bg-purple-500/10 border-purple-500/30',
              step.color === 'gold' && 'bg-amber-500/10 border-amber-500/30'
            )}>
              <svg className={cn(
                'w-6 h-6',
                step.color === 'blue' && 'text-blue-400',
                step.color === 'purple' && 'text-purple-400',
                step.color === 'gold' && 'text-amber-400'
              )} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {i === 0 && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />}
                {i === 1 && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />}
                {i === 2 && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />}
              </svg>
              <span className="text-[10px] text-white/50">{step.label}</span>
            </div>
            {i < 2 && (
              <div className="w-8 h-0.5 bg-gradient-to-r from-white/20 to-white/5 mx-1 relative">
                <div className="absolute inset-0 bg-gradient-to-r from-white/40 to-transparent animate-[shimmer_2s_ease-in-out_infinite]"
                  style={{ animationDelay: `${i * 0.3}s` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface FeatureBentoProps {
  className?: string;
}

export function FeatureBento({ className }: FeatureBentoProps) {
  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Semi-transparent overlay to let global background show through */}
      <div className="absolute inset-0 bg-[#050508]/40" />

      {/* Subtle grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        <SectionHeader
          badge="平台优势"
          badgeIcon={
            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
          title={
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold mb-4">
              <span className="text-white/90">为什么选择</span>{' '}
              <span
                style={{
                  background: 'linear-gradient(135deg, #c7d2fe 0%, #6366f1 45%, #a5b4fc 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                MAP
              </span>
            </h2>
          }
          subtitle="企业级 AI 基础设施，为您的智能化转型提供坚实保障"
        />

        {/* Bento grid - improved layout */}
        <div className="grid grid-cols-1 md:grid-cols-6 gap-4 lg:gap-5">
          {/* 先进性 - Left large card spanning 4 columns */}
          <div className="md:col-span-4 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 lg:p-8 hover:border-blue-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(59, 130, 246, 0.15) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              {/* Header with badge */}
              <div className="flex items-start justify-between gap-4 mb-6">
                <div className="flex-1">
                  <div className="inline-flex items-center gap-2 px-3 py-1 mb-4 rounded-full bg-blue-500/10 border border-blue-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="text-xs text-blue-400">实验室孵化</span>
                  </div>
                  <h3 className="text-xl lg:text-2xl font-bold text-white/90 mb-2">全球最先进模型</h3>
                  <p className="text-sm lg:text-base text-white/50 leading-relaxed">
                    昨天发布，今天可用。我们与 OpenAI、Anthropic、Google 等保持同步，新模型第一时间接入
                  </p>
                </div>
                <div className="text-right flex-shrink-0 hidden sm:block">
                  <div className="text-4xl lg:text-5xl font-bold text-blue-400">24h</div>
                  <div className="text-sm text-white/40">新模型上线</div>
                </div>
              </div>

              {/* Feature list */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                {[
                  { iconType: 'rocket', title: '持续升级', desc: '永远在技术第一线' },
                  { iconType: 'beaker', title: '实验室直通', desc: '前沿模型抢先体验' },
                  { iconType: 'target', title: '智能调度', desc: '自动选择最优模型' },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.05] border border-white/5">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                      {item.iconType === 'rocket' && (
                        <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      )}
                      {item.iconType === 'beaker' && (
                        <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                        </svg>
                      )}
                      {item.iconType === 'target' && (
                        <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white/80">{item.title}</div>
                      <div className="text-xs text-white/40">{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              <ModelCarousel />
            </div>
            <div className="absolute -bottom-20 -right-20 w-60 h-60 rounded-full opacity-10 blur-3xl bg-gradient-to-br from-blue-500 to-cyan-500 group-hover:opacity-20 transition-opacity duration-500" />
          </div>

          {/* 稳定性 - Right card spanning 2 columns */}
          <div className="md:col-span-2 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 hover:border-emerald-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 50% 30%, rgba(16, 185, 129, 0.15) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 mb-4 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-emerald-400">永不断线</span>
              </div>
              <h3 className="text-lg font-bold text-white/90 mb-2">7×24 稳定运行</h3>
              <p className="text-sm text-white/50 mb-4">Worker 进程池设计，离开屏幕继续运行</p>

              {/* Stability features */}
              <div className="space-y-2">
                {[
                  { iconType: 'refresh', text: '断网自动重连' },
                  { iconType: 'device', text: '任何设备随时操作' },
                  { iconType: 'moon', text: '后台静默运行' },
                  { iconType: 'cloud', text: '云端状态同步' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2.5 text-sm">
                    <div className="w-6 h-6 rounded-md bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
                      {item.iconType === 'refresh' && (
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                      {item.iconType === 'device' && (
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                      )}
                      {item.iconType === 'moon' && (
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                        </svg>
                      )}
                      {item.iconType === 'cloud' && (
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                        </svg>
                      )}
                    </div>
                    <span className="text-white/60">{item.text}</span>
                  </div>
                ))}
              </div>

              {/* Status indicator */}
              <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between">
                <span className="text-xs text-white/40">系统状态</span>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs text-emerald-400 font-medium">运行中</span>
                </div>
              </div>
            </div>
          </div>

          {/* Security - 2 columns */}
          <div className="md:col-span-2 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 hover:border-emerald-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 50% 30%, rgba(16, 185, 129, 0.15) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              <div className="inline-flex p-3 rounded-2xl mb-4 bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg group-hover:shadow-emerald-500/30 group-hover:scale-105 transition-all duration-300">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white/90 mb-1">企业级安全</h3>
              <p className="text-sm text-white/50">加密存储，权限精细管控</p>
              <SecurityShield />
            </div>
          </div>

          {/* Private deployment - 2 columns */}
          <div className="md:col-span-2 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 hover:border-purple-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 50% 30%, rgba(168, 85, 247, 0.15) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              <div className="inline-flex p-3 rounded-2xl mb-4 bg-gradient-to-br from-purple-500 to-pink-500 shadow-lg group-hover:shadow-purple-500/30 group-hover:scale-105 transition-all duration-300">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white/90 mb-1">私有化部署</h3>
              <p className="text-sm text-white/50">数据永不出境，满足高安全需求</p>
              <ServerRack />
            </div>
          </div>

          {/* API Platform - 2 columns */}
          <div className="md:col-span-2 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 hover:border-rose-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 50% 30%, rgba(244, 63, 94, 0.15) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              <div className="inline-flex p-3 rounded-2xl mb-4 bg-gradient-to-br from-rose-500 to-red-500 shadow-lg group-hover:shadow-rose-500/30 group-hover:scale-105 transition-all duration-300">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white/90 mb-1">API 开放平台</h3>
              <p className="text-sm text-white/50">标准 RESTful，轻松集成</p>
              <ApiCodeBlock />
            </div>
          </div>

          {/* Workflow - full width */}
          <div className="md:col-span-6 group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-2xl p-6 lg:p-8 hover:border-amber-500/30 transition-all duration-500">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.1) 0%, transparent 60%)',
              }}
            />
            <div className="relative z-10">
              <div className="flex flex-col lg:flex-row items-center gap-6 lg:gap-12">
                <div className="flex-1 text-center lg:text-left">
                  <div className="inline-flex p-3 rounded-2xl mb-4 shadow-lg group-hover:scale-105 transition-all duration-300"
                    style={{
                      background: 'linear-gradient(135deg, #c7d2fe 0%, #6366f1 45%, #a5b4fc 100%)',
                    }}
                  >
                    <svg className="w-7 h-7 text-[#ffffff]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl lg:text-2xl font-bold text-white/90 mb-2">简单三步，即刻上手</h3>
                  <p className="text-sm lg:text-base text-white/50 leading-relaxed max-w-md mx-auto lg:mx-0">
                    无需复杂配置，从注册到产出只需三步，让 AI 能力触手可及
                  </p>
                </div>
                <div className="flex-1">
                  <WorkflowDiagram />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
