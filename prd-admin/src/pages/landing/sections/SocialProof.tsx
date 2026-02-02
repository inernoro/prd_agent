import { cn } from '@/lib/cn';
import { GlassCard } from '@/components/design/GlassCard';
import { CountUpNumber } from '../components/CountUpNumber';

interface Stat {
  value: number;
  suffix: string;
  label: string;
  description: string;
}

const stats: Stat[] = [
  {
    value: 10000,
    suffix: '+',
    label: '活跃用户',
    description: '来自各行业的创作者',
  },
  {
    value: 99.9,
    suffix: '%',
    label: '服务可用性',
    description: '企业级稳定性保障',
  },
  {
    value: 50,
    suffix: 'ms',
    label: '平均响应',
    description: '极致的用户体验',
  },
  {
    value: 1000000,
    suffix: '+',
    label: '累计调用',
    description: '经过大规模验证',
  },
];

interface Testimonial {
  content: string;
  author: string;
  role: string;
  avatar: string;
}

const testimonials: Testimonial[] = [
  {
    content: '文学创作 Agent 极大提升了我们内容团队的效率，配图质量超出预期。',
    author: '张明',
    role: '内容运营总监',
    avatar: 'Z',
  },
  {
    content: 'PRD Agent 帮助我们快速理解和分析复杂的产品需求，节省了大量沟通成本。',
    author: '李华',
    role: '产品经理',
    avatar: 'L',
  },
  {
    content: '视觉创作工作区的多模态能力让设计探索变得更加高效和有趣。',
    author: '王芳',
    role: '设计主管',
    avatar: 'W',
  },
];

interface SocialProofProps {
  className?: string;
}

export function SocialProof({ className }: SocialProofProps) {
  return (
    <section className={cn('relative py-24 sm:py-32', className)}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#050508] via-[#0a0a0f] to-[#050508]" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6 mb-20">
          {stats.map((stat, idx) => (
            <GlassCard
              key={idx}
              glow
              variant="subtle"
              padding="lg"
              className="text-center"
            >
              <div className="text-3xl sm:text-4xl md:text-5xl font-bold mb-2">
                <span
                  style={{
                    background: 'linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                >
                  <CountUpNumber
                    end={stat.value}
                    suffix={stat.suffix}
                    duration={2500}
                    decimals={stat.suffix === '%' ? 1 : 0}
                  />
                </span>
              </div>
              <div className="text-base font-medium text-white/80 mb-1">
                {stat.label}
              </div>
              <div className="text-xs text-white/40">
                {stat.description}
              </div>
            </GlassCard>
          ))}
        </div>

        {/* Section header */}
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            用户反馈
          </h2>
          <p className="text-lg text-white/50">
            听听他们怎么说
          </p>
        </div>

        {/* Testimonials */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {testimonials.map((testimonial, idx) => (
            <GlassCard
              key={idx}
              padding="lg"
              className="group"
            >
              {/* Quote icon */}
              <div className="mb-4">
                <svg className="w-8 h-8 text-white/10" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
                </svg>
              </div>

              {/* Content */}
              <p className="text-white/70 leading-relaxed mb-6">
                "{testimonial.content}"
              </p>

              {/* Author */}
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold"
                  style={{
                    background: 'linear-gradient(135deg, #d6b26a 0%, #f2d59b 100%)',
                    color: '#0b0b0d',
                  }}
                >
                  {testimonial.avatar}
                </div>
                <div>
                  <div className="text-sm font-medium text-white/80">
                    {testimonial.author}
                  </div>
                  <div className="text-xs text-white/40">
                    {testimonial.role}
                  </div>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </section>
  );
}
