import { cn } from '@/lib/cn';
import { GlassCard } from '@/components/design/GlassCard';

interface Feature {
  title: string;
  description: string;
  icon: React.ReactNode;
  gradient: string;
  size: 'sm' | 'lg';
}

const features: Feature[] = [
  {
    title: 'AI 驱动',
    description: '基于最新大语言模型，融合多模态能力，提供智能化的创作与分析服务',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
    gradient: 'from-amber-400 to-orange-500',
    size: 'lg',
  },
  {
    title: '极速响应',
    description: '毫秒级响应速度，流式输出实时反馈',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    gradient: 'from-blue-400 to-cyan-500',
    size: 'sm',
  },
  {
    title: '多模态融合',
    description: '文字、图像、代码无缝协作',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
    gradient: 'from-purple-400 to-pink-500',
    size: 'sm',
  },
  {
    title: '安全可控',
    description: '企业级权限管理，数据安全有保障，支持私有化部署',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    gradient: 'from-emerald-400 to-teal-500',
    size: 'lg',
  },
];

interface FeatureBentoProps {
  className?: string;
}

export function FeatureBento({ className }: FeatureBentoProps) {
  return (
    <section className={cn('relative py-24 sm:py-32', className)}>
      {/* Background */}
      <div className="absolute inset-0 bg-[#050508]" />

      {/* Decorative elements */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] opacity-30"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(214, 178, 106, 0.15) 0%, transparent 70%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-6xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            为什么选择我们
          </h2>
          <p className="text-lg text-white/50 max-w-2xl mx-auto">
            技术驱动创新，安全保障未来
          </p>
        </div>

        {/* Bento grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
          {features.map((feature, idx) => (
            <GlassCard
              key={idx}
              glow
              accentHue={idx * 60 + 30}
              padding="lg"
              className={cn(
                'group relative overflow-hidden',
                feature.size === 'lg' ? 'lg:col-span-2' : ''
              )}
            >
              {/* Gradient background on hover */}
              <div
                className={cn(
                  'absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100',
                  'bg-gradient-to-br',
                  feature.gradient
                )}
                style={{ opacity: 0, mixBlendMode: 'overlay' }}
              />

              {/* Icon */}
              <div
                className={cn(
                  'w-12 h-12 rounded-xl flex items-center justify-center mb-4',
                  'bg-gradient-to-br',
                  feature.gradient,
                  'shadow-lg transition-all duration-300 group-hover:scale-110 group-hover:shadow-xl'
                )}
              >
                <div className="text-white">{feature.icon}</div>
              </div>

              {/* Content */}
              <h3 className="text-xl font-semibold text-white/90 mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-white/50 leading-relaxed">
                {feature.description}
              </p>

              {/* Decorative corner */}
              <div
                className={cn(
                  'absolute -bottom-20 -right-20 w-40 h-40 rounded-full opacity-10',
                  'bg-gradient-to-br',
                  feature.gradient,
                  'blur-2xl transition-opacity duration-500 group-hover:opacity-20'
                )}
              />
            </GlassCard>
          ))}
        </div>
      </div>
    </section>
  );
}
