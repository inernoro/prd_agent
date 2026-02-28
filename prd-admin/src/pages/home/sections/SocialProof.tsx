import { cn } from '@/lib/cn';
import { CountUp } from '@/components/reactbits';
import { SectionHeader } from '@/components/design/SectionHeader';

interface Stat {
  value: number;
  suffix: string;
  label: string;
  gradient: string;
}

const stats: Stat[] = [
  {
    value: 10000,
    suffix: '+',
    label: '活跃用户',
    gradient: 'from-blue-500 to-cyan-500',
  },
  {
    value: 99.9,
    suffix: '%',
    label: '服务可用性',
    gradient: 'from-emerald-500 to-teal-500',
  },
  {
    value: 50,
    suffix: 'ms',
    label: '平均响应',
    gradient: 'from-yellow-500 to-orange-500',
  },
  {
    value: 1000000,
    suffix: '+',
    label: '累计调用',
    gradient: 'from-purple-500 to-pink-500',
  },
];

interface Testimonial {
  content: string;
  author: string;
  role: string;
  company: string;
}

const testimonials: Testimonial[] = [
  {
    content: '文学创作 Agent 极大提升了我们内容团队的效率，配图质量超出预期，平均每篇文章节省 2 小时配图时间。',
    author: '张明',
    role: '内容运营总监',
    company: '某知名媒体',
  },
  {
    content: 'PRD Agent 帮助我们快速理解和分析复杂的产品需求，需求评审效率提升 40%，遗漏问题减少 60%。',
    author: '李华',
    role: '产品经理',
    company: '互联网大厂',
  },
  {
    content: '视觉创作工作区的多模态能力让设计探索变得更加高效，概念稿出图速度提升 5 倍，创意迭代更加顺畅。',
    author: '王芳',
    role: '设计主管',
    company: '设计工作室',
  },
];

interface SocialProofProps {
  className?: string;
}

export function SocialProof({ className }: SocialProofProps) {
  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Semi-transparent overlay to let global background show through */}
      <div className="absolute inset-0 bg-[#050508]/40" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        <SectionHeader
          badge="数据说话"
          title="值得信赖的选择"
          subtitle="已有数千家企业选择我们，一起见证 AI 的力量"
        />

        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6 mb-20">
          {stats.map((stat, idx) => (
            <div
              key={idx}
              className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-6 lg:p-8 text-center hover:border-white/20 transition-all duration-500"
            >
              {/* Glow on hover */}
              <div
                className={cn(
                  'absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500',
                  'bg-gradient-to-b',
                  stat.gradient
                )}
                style={{ opacity: 0 }}
              />
              <div
                className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-30 transition-opacity duration-500"
                style={{
                  background: `linear-gradient(to bottom, ${stat.gradient.includes('blue') ? 'rgba(59,130,246,0.5)' : stat.gradient.includes('emerald') ? 'rgba(16,185,129,0.5)' : stat.gradient.includes('yellow') ? 'rgba(234,179,8,0.5)' : 'rgba(168,85,247,0.5)'}, transparent)`,
                }}
              />

              <div className="relative z-10">
                <div className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-2">
                  <span
                    style={{
                      background: 'linear-gradient(135deg, #c7d2fe 0%, #6366f1 45%, #a5b4fc 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    }}
                  >
                    <CountUp
                      to={stat.value}
                      duration={2.5}
                      suffix={stat.suffix}
                      separator=","
                      decimals={stat.suffix === '%' ? 1 : 0}
                    />
                  </span>
                </div>
                <div className="text-sm lg:text-base font-medium text-white/60">
                  {stat.label}
                </div>
              </div>
            </div>
          ))}
        </div>

        <SectionHeader
          title="用户反馈"
          subtitle="听听他们怎么说"
          size="sm"
          spacing="md"
        />

        {/* Testimonials */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {testimonials.map((testimonial, idx) => (
            <div
              key={idx}
              className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-6 lg:p-8 hover:border-white/20 transition-all duration-500"
            >
              {/* Quote mark */}
              <div className="absolute top-6 right-6 text-6xl font-serif text-white/5 leading-none">
                "
              </div>

              {/* Content */}
              <div className="relative z-10">
                <p className="text-white/60 leading-relaxed mb-6 text-sm lg:text-base">
                  "{testimonial.content}"
                </p>

                {/* Author */}
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{
                      background: 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
                      color: '#0b0b0d',
                    }}
                  >
                    {testimonial.author[0]}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white/80">
                      {testimonial.author}
                    </div>
                    <div className="text-xs text-white/40">
                      {testimonial.role} · {testimonial.company}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Trust badges */}
        <div className="mt-16 pt-16 border-t border-white/10">
          <div className="text-center mb-8">
            <p className="text-sm text-white/40">受到以下企业信赖</p>
          </div>
          <div className="flex items-center justify-center gap-8 lg:gap-16 flex-wrap opacity-40">
            {['企业 A', '企业 B', '企业 C', '企业 D', '企业 E'].map((company) => (
              <div
                key={company}
                className="text-lg font-semibold text-white/60"
              >
                {company}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
