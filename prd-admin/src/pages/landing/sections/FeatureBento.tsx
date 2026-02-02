import { cn } from '@/lib/cn';
import { GlowOrb } from '../components/GlowOrb';

interface Feature {
  title: string;
  description: string;
  icon: React.ReactNode;
  gradient: string;
  glowColor: string;
  span: 1 | 2;
  stat?: { value: string; label: string };
  extra?: React.ReactNode;
}

const features: Feature[] = [
  {
    title: '多模型智能调度',
    description: '支持 GPT-4、Claude、Gemini 等主流大模型，智能选择最优模型处理任务，确保输出质量与成本平衡。',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    gradient: 'from-blue-500 to-cyan-500',
    glowColor: 'rgba(59, 130, 246, 0.2)',
    span: 2,
    stat: { value: '10+', label: '支持模型' },
    extra: (
      <div className="flex items-center gap-2 flex-wrap mt-4">
        {['GPT-4', 'Claude', 'Gemini', 'Llama', 'Qwen'].map((model) => (
          <span
            key={model}
            className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/60"
          >
            {model}
          </span>
        ))}
        <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/40">
          +5
        </span>
      </div>
    ),
  },
  {
    title: '毫秒级响应',
    description: '优化的推理管线，流式输出让等待不再漫长。',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    gradient: 'from-yellow-500 to-orange-500',
    glowColor: 'rgba(234, 179, 8, 0.2)',
    span: 1,
    stat: { value: '50ms', label: '首字延迟' },
  },
  {
    title: '企业级安全',
    description: '数据加密存储，权限精细管控，符合企业安全合规要求。',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-500',
    glowColor: 'rgba(16, 185, 129, 0.2)',
    span: 1,
  },
  {
    title: '私有化部署',
    description: '支持本地部署，数据永不出境，满足金融、政务等高安全需求场景。',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
      </svg>
    ),
    gradient: 'from-purple-500 to-pink-500',
    glowColor: 'rgba(168, 85, 247, 0.2)',
    span: 1,
  },
  {
    title: 'API 开放平台',
    description: '标准 RESTful API，轻松集成到您的业务系统，支持 WebSocket 实时通信。',
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
    gradient: 'from-rose-500 to-red-500',
    glowColor: 'rgba(244, 63, 94, 0.2)',
    span: 1,
  },
];

interface FeatureBentoProps {
  className?: string;
}

export function FeatureBento({ className }: FeatureBentoProps) {
  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#050508] via-[#080810] to-[#050508]" />

      {/* Decorative orbs */}
      <GlowOrb color="blue" size="lg" className="top-1/4 right-0 translate-x-1/2 opacity-40" />
      <GlowOrb color="purple" size="md" className="bottom-1/4 left-0 -translate-x-1/2 opacity-40" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full border border-white/10 bg-white/[0.03]">
            <span className="text-sm text-white/50">平台优势</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            为什么选择我们
          </h2>
          <p className="text-lg text-white/40 max-w-2xl mx-auto">
            企业级 AI 基础设施，为您的智能化转型保驾护航
          </p>
        </div>

        {/* Bento grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">
          {features.map((feature, index) => (
            <div
              key={index}
              className={cn(
                'group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] p-6 lg:p-8',
                'hover:border-white/20 transition-all duration-500',
                feature.span === 2 && 'md:col-span-2'
              )}
            >
              {/* Glow effect on hover */}
              <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                style={{
                  background: `radial-gradient(circle at 30% 30%, ${feature.glowColor} 0%, transparent 60%)`,
                }}
              />

              <div className="relative z-10">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    {/* Icon */}
                    <div
                      className={cn(
                        'inline-flex p-3 rounded-2xl mb-4 bg-gradient-to-br',
                        feature.gradient,
                        'shadow-lg group-hover:shadow-xl group-hover:scale-105 transition-all duration-300'
                      )}
                    >
                      <div className="text-white">{feature.icon}</div>
                    </div>

                    {/* Title */}
                    <h3 className="text-xl lg:text-2xl font-bold text-white/90 mb-2">{feature.title}</h3>

                    {/* Description */}
                    <p className="text-sm lg:text-base text-white/50 leading-relaxed">{feature.description}</p>

                    {/* Extra content */}
                    {feature.extra}
                  </div>

                  {/* Stat */}
                  {feature.stat && (
                    <div className="text-right flex-shrink-0">
                      <div className="text-3xl lg:text-4xl font-bold text-white/80">{feature.stat.value}</div>
                      <div className="text-xs lg:text-sm text-white/40">{feature.stat.label}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Corner gradient */}
              <div
                className={cn(
                  'absolute -bottom-20 -right-20 w-40 h-40 rounded-full opacity-10 blur-3xl',
                  'bg-gradient-to-br',
                  feature.gradient,
                  'group-hover:opacity-20 transition-opacity duration-500'
                )}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
