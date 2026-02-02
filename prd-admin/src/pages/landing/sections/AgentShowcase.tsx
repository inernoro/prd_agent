import { useState } from 'react';
import { cn } from '@/lib/cn';
import { GlassCard } from '@/components/design/GlassCard';

interface Agent {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  gradient: string;
  features: string[];
  accentHue: number;
}

const agents: Agent[] = [
  {
    id: 'literary',
    name: '文学创作 Agent',
    description: '智能文章配图与文学创作助手，为您的创意插上翅膀',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
    gradient: 'from-amber-500 to-orange-600',
    features: ['智能配图生成', '风格迁移', '文学润色', '创意激发'],
    accentHue: 30,
  },
  {
    id: 'visual',
    name: '视觉创作 Agent',
    description: '专业级视觉内容生成工作区，释放您的视觉想象力',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
    gradient: 'from-purple-500 to-pink-600',
    features: ['文生图', '图生图', '局部重绘', '风格融合'],
    accentHue: 280,
  },
  {
    id: 'prd',
    name: 'PRD Agent',
    description: '智能需求解读与分析，让产品文档触手可及',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    gradient: 'from-blue-500 to-cyan-600',
    features: ['智能问答', '需求解析', '缺失检测', '自动摘要'],
    accentHue: 200,
  },
  {
    id: 'defect',
    name: '缺陷管理 Agent',
    description: '智能缺陷分析与跟踪，提升研发效率',
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    gradient: 'from-emerald-500 to-teal-600',
    features: ['智能分类', '优先级建议', '关联分析', '趋势预测'],
    accentHue: 160,
  },
];

interface AgentShowcaseProps {
  className?: string;
}

export function AgentShowcase({ className }: AgentShowcaseProps) {
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  return (
    <section className={cn('relative py-24 sm:py-32', className)}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#050508] via-[#0a0a0f] to-[#050508]" />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            四大智能 Agent
          </h2>
          <p className="text-lg text-white/50 max-w-2xl mx-auto">
            为不同场景量身定制的 AI 助手，覆盖创作、设计、需求、质量全流程
          </p>
        </div>

        {/* Agent cards grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
          {agents.map((agent) => (
            <GlassCard
              key={agent.id}
              interactive
              glow={activeAgent === agent.id}
              accentHue={agent.accentHue}
              padding="lg"
              className="group cursor-pointer"
              onClick={() => setActiveAgent(activeAgent === agent.id ? null : agent.id)}
            >
              <div className="flex flex-col h-full">
                {/* Header */}
                <div className="flex items-start gap-4 mb-4">
                  {/* Icon */}
                  <div
                    className={cn(
                      'flex-shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center',
                      'bg-gradient-to-br',
                      agent.gradient,
                      'shadow-lg transition-transform duration-300 group-hover:scale-110'
                    )}
                  >
                    <div className="text-white">{agent.icon}</div>
                  </div>

                  {/* Title */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-xl font-semibold text-white/90 mb-1">
                      {agent.name}
                    </h3>
                    <p className="text-sm text-white/50 line-clamp-2">
                      {agent.description}
                    </p>
                  </div>

                  {/* Expand indicator */}
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full border border-white/10 flex items-center justify-center transition-all duration-300',
                      activeAgent === agent.id ? 'bg-white/10 rotate-180' : 'bg-transparent'
                    )}
                  >
                    <svg className="w-4 h-4 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Features - collapsible */}
                <div
                  className={cn(
                    'grid transition-all duration-300 ease-out',
                    activeAgent === agent.id
                      ? 'grid-rows-[1fr] opacity-100'
                      : 'grid-rows-[0fr] opacity-0'
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="pt-4 border-t border-white/10">
                      <div className="grid grid-cols-2 gap-3">
                        {agent.features.map((feature, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 text-sm text-white/60"
                          >
                            <div
                              className={cn(
                                'w-1.5 h-1.5 rounded-full bg-gradient-to-r',
                                agent.gradient
                              )}
                            />
                            {feature}
                          </div>
                        ))}
                      </div>

                      {/* CTA */}
                      <button
                        className={cn(
                          'mt-4 w-full py-2.5 rounded-lg text-sm font-medium',
                          'bg-gradient-to-r',
                          agent.gradient,
                          'text-white shadow-lg transition-all duration-300',
                          'hover:shadow-xl hover:scale-[1.02] active:scale-[0.98]'
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Navigate to agent
                        }}
                      >
                        开始使用
                      </button>
                    </div>
                  </div>
                </div>

                {/* Always visible feature tags */}
                <div
                  className={cn(
                    'flex flex-wrap gap-2 mt-4 transition-all duration-300',
                    activeAgent === agent.id ? 'opacity-0 h-0' : 'opacity-100'
                  )}
                >
                  {agent.features.slice(0, 3).map((feature, idx) => (
                    <span
                      key={idx}
                      className="px-3 py-1 text-xs rounded-full bg-white/5 text-white/50 border border-white/10"
                    >
                      {feature}
                    </span>
                  ))}
                  <span className="px-3 py-1 text-xs rounded-full bg-white/5 text-white/40">
                    +{agent.features.length - 3}
                  </span>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </section>
  );
}
