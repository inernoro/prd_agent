import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';

interface Agent {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  gradient: string;
  glowColor: string;
  features: { icon: string; title: string; desc: string }[];
  mockupType: 'literary' | 'visual' | 'prd' | 'defect';
}

const agents: Agent[] = [
  {
    id: 'literary',
    name: '文学创作 Agent',
    subtitle: '为您的文字插上翅膀',
    description: '智能文章配图与文学润色，一键生成与文章内容完美契合的插画，支持多种艺术风格，让每篇文章都成为视觉盛宴。',
    gradient: 'from-amber-500 via-orange-500 to-red-500',
    glowColor: 'rgba(251, 146, 60, 0.4)',
    features: [
      { icon: '🎨', title: '智能配图', desc: '基于文章内容自动生成契合的插画' },
      { icon: '✨', title: '风格迁移', desc: '支持水彩、油画、素描等20+艺术风格' },
      { icon: '📝', title: '文学润色', desc: 'AI辅助改写，提升文章表达力' },
      { icon: '🔄', title: '批量处理', desc: '一键为整篇文章生成系列配图' },
    ],
    mockupType: 'literary',
  },
  {
    id: 'visual',
    name: '视觉创作 Agent',
    subtitle: '释放你的视觉想象力',
    description: '专业级AI图像生成工作区，从文字描述到惊艳视觉，支持文生图、图生图、局部重绘等高级功能，让创意触手可及。',
    gradient: 'from-purple-500 via-pink-500 to-rose-500',
    glowColor: 'rgba(168, 85, 247, 0.4)',
    features: [
      { icon: '🖼️', title: '文生图', desc: '输入描述，AI生成高质量图像' },
      { icon: '🔮', title: '图生图', desc: '上传参考图，生成风格相似的新图' },
      { icon: '🎯', title: '局部重绘', desc: '精准编辑图像局部区域' },
      { icon: '🎭', title: '风格融合', desc: '多风格混合，创造独特视觉' },
    ],
    mockupType: 'visual',
  },
  {
    id: 'prd',
    name: 'PRD Agent',
    subtitle: '让需求文档触手可及',
    description: '智能需求文档解读与问答系统，上传PRD即可与AI对话，快速理解需求细节、发现文档缺失、生成测试用例。',
    gradient: 'from-blue-500 via-cyan-500 to-teal-500',
    glowColor: 'rgba(59, 130, 246, 0.4)',
    features: [
      { icon: '💬', title: '智能问答', desc: '基于PRD内容回答任何问题' },
      { icon: '🔍', title: '缺失检测', desc: '自动发现需求文档中的遗漏' },
      { icon: '📋', title: '用例生成', desc: '一键生成测试用例和验收标准' },
      { icon: '📊', title: '需求摘要', desc: '快速生成PRD核心要点总结' },
    ],
    mockupType: 'prd',
  },
  {
    id: 'defect',
    name: '缺陷管理 Agent',
    subtitle: '让Bug无处遁形',
    description: '智能缺陷分析与管理助手，自动分类、评估优先级、关联相似问题，AI驱动的缺陷全生命周期管理。',
    gradient: 'from-emerald-500 via-green-500 to-lime-500',
    glowColor: 'rgba(16, 185, 129, 0.4)',
    features: [
      { icon: '🏷️', title: '智能分类', desc: 'AI自动识别缺陷类型和模块' },
      { icon: '⚡', title: '优先级建议', desc: '基于影响范围智能评估优先级' },
      { icon: '🔗', title: '关联分析', desc: '发现相似缺陷，避免重复提交' },
      { icon: '📈', title: '趋势预测', desc: '分析缺陷趋势，预警质量风险' },
    ],
    mockupType: 'defect',
  },
];

// Mock UI components for each agent type
function AgentMockup({ type, isActive }: { type: Agent['mockupType']; isActive: boolean }) {
  const baseClass = cn(
    'w-full h-full rounded-2xl overflow-hidden transition-all duration-700',
    isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
  );

  if (type === 'literary') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-6 flex gap-6">
          {/* Left: Article */}
          <div className="flex-1 space-y-4">
            <div className="h-3 w-32 bg-white/20 rounded" />
            <div className="space-y-2">
              <div className="h-2 w-full bg-white/10 rounded" />
              <div className="h-2 w-4/5 bg-white/10 rounded" />
              <div className="h-2 w-full bg-white/10 rounded" />
              <div className="h-2 w-3/4 bg-white/10 rounded" />
            </div>
            <div className="h-32 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center">
              <span className="text-amber-400/60 text-sm">AI 配图生成中...</span>
            </div>
            <div className="space-y-2">
              <div className="h-2 w-full bg-white/10 rounded" />
              <div className="h-2 w-5/6 bg-white/10 rounded" />
            </div>
          </div>
          {/* Right: Generated images */}
          <div className="w-48 space-y-3">
            <div className="text-xs text-white/40 mb-2">生成的配图</div>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-20 rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-600/30 border border-amber-500/20 animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (type === 'visual') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-6">
          {/* Canvas area */}
          <div className="h-full rounded-xl border border-white/10 bg-black/30 relative overflow-hidden">
            {/* Generated image preview */}
            <div className="absolute inset-4 rounded-lg bg-gradient-to-br from-purple-500/20 via-pink-500/20 to-rose-500/20 flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 animate-pulse flex items-center justify-center">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <span className="text-purple-300/60 text-sm">正在生成...</span>
              </div>
            </div>
            {/* Tool panel */}
            <div className="absolute left-4 top-1/2 -translate-y-1/2 space-y-2">
              {['🖌️', '✂️', '🔄', '💾'].map((icon, i) => (
                <div
                  key={i}
                  className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-sm hover:bg-white/10 transition-colors"
                >
                  {icon}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'prd') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-6 flex gap-4">
          {/* Left: Document */}
          <div className="w-1/2 rounded-xl border border-white/10 bg-black/20 p-4 space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-white/10">
              <div className="w-3 h-3 rounded bg-blue-500" />
              <span className="text-xs text-white/60">PRD文档.pdf</span>
            </div>
            <div className="space-y-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-2 bg-white/10 rounded" style={{ width: `${60 + Math.random() * 40}%` }} />
              ))}
            </div>
            <div className="h-16 rounded bg-blue-500/10 border border-blue-500/30 mt-4 flex items-center justify-center">
              <span className="text-blue-400/60 text-xs">高亮: 第3.2节 用户登录流程</span>
            </div>
          </div>
          {/* Right: Chat */}
          <div className="flex-1 rounded-xl border border-white/10 bg-black/20 p-4 flex flex-col">
            <div className="flex-1 space-y-3">
              <div className="flex justify-end">
                <div className="bg-blue-500/20 rounded-lg px-3 py-2 text-xs text-white/70 max-w-[80%]">
                  登录失败后的处理逻辑是什么？
                </div>
              </div>
              <div className="flex justify-start">
                <div className="bg-white/5 rounded-lg px-3 py-2 text-xs text-white/60 max-w-[80%]">
                  根据PRD第3.2.4节，登录失败后...
                </div>
              </div>
            </div>
            <div className="mt-3 h-8 rounded-lg bg-white/5 border border-white/10" />
          </div>
        </div>
      </div>
    );
  }

  if (type === 'defect') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-6">
          <div className="h-full rounded-xl border border-white/10 bg-black/20 p-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/10 mb-4">
              <span className="text-sm text-white/70">缺陷列表</span>
              <div className="flex gap-2">
                <span className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-400">严重 3</span>
                <span className="px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400">一般 8</span>
                <span className="px-2 py-1 rounded text-xs bg-green-500/20 text-green-400">轻微 5</span>
              </div>
            </div>
            {/* List */}
            <div className="space-y-2">
              {[
                { title: '登录页面闪退', tag: '严重', color: 'red' },
                { title: '图片加载缓慢', tag: '一般', color: 'yellow' },
                { title: '文案显示不全', tag: '轻微', color: 'green' },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                >
                  <div className={`w-2 h-2 rounded-full bg-${item.color}-500`} />
                  <span className="text-xs text-white/60 flex-1">{item.title}</span>
                  <span className={`px-2 py-0.5 rounded text-xs bg-${item.color}-500/20 text-${item.color}-400`}>
                    {item.tag}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

interface AgentShowcaseProps {
  className?: string;
}

export function AgentShowcase({ className }: AgentShowcaseProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-rotate every 5 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % agents.length);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const activeAgent = agents[activeIndex];

  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)} ref={containerRef}>
      {/* Background */}
      <div className="absolute inset-0 bg-[#050508]" />

      {/* Dynamic glow based on active agent */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full blur-[150px] transition-all duration-1000"
        style={{ background: activeAgent.glowColor, opacity: 0.3 }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full border border-white/10 bg-white/[0.03]">
            <span className="text-sm text-white/50">四大智能助手</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            为不同场景量身定制
          </h2>
          <p className="text-lg text-white/40 max-w-2xl mx-auto">
            覆盖创作、设计、需求、质量全流程的 AI 助手矩阵
          </p>
        </div>

        {/* Agent tabs */}
        <div className="flex justify-center gap-2 mb-12 flex-wrap">
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              onClick={() => setActiveIndex(index)}
              className={cn(
                'px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-300',
                index === activeIndex
                  ? 'bg-white/10 text-white border border-white/20'
                  : 'text-white/50 hover:text-white/70 hover:bg-white/5'
              )}
            >
              {agent.name}
            </button>
          ))}
        </div>

        {/* Main showcase area */}
        <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
          {/* Left: Info */}
          <div className="order-2 lg:order-1">
            <div
              className={cn(
                'inline-block px-3 py-1 rounded-full text-xs font-medium mb-4 bg-gradient-to-r',
                activeAgent.gradient
              )}
            >
              {activeAgent.subtitle}
            </div>

            <h3 className="text-3xl sm:text-4xl font-bold text-white/90 mb-4">
              {activeAgent.name}
            </h3>

            <p className="text-white/50 mb-8 leading-relaxed">
              {activeAgent.description}
            </p>

            {/* Features grid */}
            <div className="grid grid-cols-2 gap-4 mb-8">
              {activeAgent.features.map((feature, i) => (
                <div
                  key={i}
                  className="p-4 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.05] hover:border-white/20 transition-all duration-300"
                >
                  <div className="text-2xl mb-2">{feature.icon}</div>
                  <div className="text-sm font-medium text-white/80 mb-1">{feature.title}</div>
                  <div className="text-xs text-white/40">{feature.desc}</div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <button
              className={cn(
                'px-6 py-3 rounded-xl font-medium text-white transition-all duration-300 hover:scale-105 active:scale-95 bg-gradient-to-r',
                activeAgent.gradient
              )}
              style={{
                boxShadow: `0 0 30px ${activeAgent.glowColor}`,
              }}
            >
              开始使用 {activeAgent.name}
            </button>
          </div>

          {/* Right: Mockup */}
          <div className="order-1 lg:order-2">
            <div
              className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-white/10"
              style={{
                boxShadow: `0 0 60px ${activeAgent.glowColor}, 0 25px 50px -12px rgba(0,0,0,0.5)`,
              }}
            >
              {/* Window chrome */}
              <div className="absolute top-0 left-0 right-0 h-8 bg-black/50 backdrop-blur-sm flex items-center px-3 gap-1.5 z-10">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
              </div>

              {/* Mockup content */}
              <div className="pt-8 h-full">
                {agents.map((agent, index) => (
                  <div
                    key={agent.id}
                    className={cn(
                      'absolute inset-0 pt-8 transition-all duration-700',
                      index === activeIndex ? 'opacity-100' : 'opacity-0 pointer-events-none'
                    )}
                  >
                    <AgentMockup type={agent.mockupType} isActive={index === activeIndex} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Progress indicators */}
        <div className="flex justify-center gap-2 mt-12">
          {agents.map((_, index) => (
            <button
              key={index}
              onClick={() => setActiveIndex(index)}
              className={cn(
                'h-1.5 rounded-full transition-all duration-500',
                index === activeIndex ? 'w-8 bg-white/60' : 'w-1.5 bg-white/20 hover:bg-white/30'
              )}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
