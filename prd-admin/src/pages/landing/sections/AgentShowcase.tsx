import { useState, useEffect } from 'react';
import { cn } from '@/lib/cn';

// SVG Icons for features
const Icons = {
  // Literary Agent icons
  palette: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
    </svg>
  ),
  sparkles: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  ),
  pencil: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  ),
  refresh: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  ),
  // Visual Agent icons
  photo: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  ),
  wand: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" />
    </svg>
  ),
  cursor: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zm-7.518-.267A8.25 8.25 0 1120.25 10.5M8.288 14.212A5.25 5.25 0 1117.25 10.5" />
    </svg>
  ),
  layers: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
    </svg>
  ),
  // PRD Agent icons
  chat: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  ),
  search: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  clipboard: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
    </svg>
  ),
  chart: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  ),
  // Defect Agent icons
  tag: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 6h.008v.008H6V6z" />
    </svg>
  ),
  bolt: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
  link: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
    </svg>
  ),
  trendUp: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
    </svg>
  ),
};

interface Agent {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  gradient: string;
  glowColor: string;
  features: { icon: keyof typeof Icons; title: string; desc: string }[];
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
      { icon: 'palette', title: '智能配图', desc: '基于文章内容自动生成契合的插画' },
      { icon: 'sparkles', title: '风格迁移', desc: '支持水彩、油画、素描等20+艺术风格' },
      { icon: 'pencil', title: '文学润色', desc: 'AI辅助改写，提升文章表达力' },
      { icon: 'refresh', title: '批量处理', desc: '一键为整篇文章生成系列配图' },
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
      { icon: 'photo', title: '文生图', desc: '输入描述，AI生成高质量图像' },
      { icon: 'wand', title: '图生图', desc: '上传参考图，生成风格相似的新图' },
      { icon: 'cursor', title: '局部重绘', desc: '精准编辑图像局部区域' },
      { icon: 'layers', title: '风格融合', desc: '多风格混合，创造独特视觉' },
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
      { icon: 'chat', title: '智能问答', desc: '基于PRD内容回答任何问题' },
      { icon: 'search', title: '缺失检测', desc: '自动发现需求文档中的遗漏' },
      { icon: 'clipboard', title: '用例生成', desc: '一键生成测试用例和验收标准' },
      { icon: 'chart', title: '需求摘要', desc: '快速生成PRD核心要点总结' },
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
      { icon: 'tag', title: '智能分类', desc: 'AI自动识别缺陷类型和模块' },
      { icon: 'bolt', title: '优先级建议', desc: '基于影响范围智能评估优先级' },
      { icon: 'link', title: '关联分析', desc: '发现相似缺陷，避免重复提交' },
      { icon: 'trendUp', title: '趋势预测', desc: '分析缺陷趋势，预警质量风险' },
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
    // Visual Agent mockup matching the screenshot - canvas left, chat right
    return (
      <div className={baseClass}>
        <div className="h-full bg-[#1e2128] flex">
          {/* Left sidebar - tools */}
          <div className="w-12 bg-[#282c34] flex flex-col items-center py-4 gap-3 border-r border-white/10">
            <div className="w-7 h-7 rounded bg-white/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672z" />
              </svg>
            </div>
            <div className="w-7 h-7 rounded bg-white/5 flex items-center justify-center">
              <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <div className="w-7 h-7 rounded bg-white/5 flex items-center justify-center">
              <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
              </svg>
            </div>
          </div>

          {/* Center - Canvas with images */}
          <div className="flex-1 p-4 relative">
            {/* Toolbar */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/30 rounded-lg px-3 py-1.5">
              <span className="text-xs text-white/50">14%</span>
              <span className="text-xs text-white/30">|</span>
              <span className="text-xs text-white/50">适配</span>
              <span className="text-xs text-white/50">100%</span>
            </div>

            {/* Image grid - mimicking the screenshot */}
            <div className="h-full pt-8 flex flex-wrap gap-2 content-start">
              {/* Row 1 */}
              <div className="w-16 h-12 rounded bg-gradient-to-br from-amber-600/40 to-amber-800/40 border border-white/10" />
              <div className="w-28 h-20 rounded bg-gradient-to-br from-green-600/40 to-green-800/40 border border-white/10" />
              <div className="w-20 h-14 rounded bg-gradient-to-br from-orange-600/40 to-orange-800/40 border border-white/10" />
              <div className="w-16 h-12 rounded bg-gradient-to-br from-gray-600/40 to-gray-800/40 border border-white/10" />
              {/* Row 2 */}
              <div className="w-32 h-24 rounded bg-gradient-to-br from-emerald-600/40 to-emerald-800/40 border border-white/10" />
              <div className="w-28 h-24 rounded bg-gradient-to-br from-lime-600/40 to-lime-800/40 border border-white/10" />
              {/* Watermark text */}
              <div className="absolute bottom-16 right-20 text-purple-400/30 text-xs">米多AI生成</div>
            </div>
          </div>

          {/* Right - Chat panel */}
          <div className="w-56 bg-[#282c34] border-l border-white/10 flex flex-col">
            {/* Header */}
            <div className="p-3 border-b border-white/10">
              <div className="text-sm text-white/80">Hi，我是你的 AI 设计师</div>
              <div className="text-xs text-white/40 mt-1">点画板图片即可选中，未来可作为图生图首帧...</div>
            </div>

            {/* Chat messages */}
            <div className="flex-1 p-3 space-y-3 overflow-hidden">
              {/* Message 1 */}
              <div className="bg-white/5 rounded-lg p-2">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">1K·1:1</span>
                  <span className="text-xs text-purple-400">nano-banana-pro</span>
                </div>
                <div className="text-xs text-white/50">2026.02.02 02:28:24</div>
                <div className="mt-2 h-16 rounded bg-gradient-to-br from-green-600/30 to-green-800/30 border border-white/10" />
              </div>

              {/* Message 2 */}
              <div className="bg-white/5 rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-emerald-400">站起来</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/50">重试</span>
                </div>
              </div>
            </div>

            {/* Input */}
            <div className="p-3 border-t border-white/10">
              <div className="h-8 rounded-lg bg-white/5 border border-white/10 flex items-center px-3">
                <span className="text-xs text-white/30">请输入你的设计需求...</span>
              </div>
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
                { title: '登录页面闪退', color: 'bg-red-500' },
                { title: '图片加载缓慢', color: 'bg-yellow-500' },
                { title: '文案显示不全', color: 'bg-green-500' },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                >
                  <div className={`w-2 h-2 rounded-full ${item.color}`} />
                  <span className="text-xs text-white/60 flex-1">{item.title}</span>
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

  // Auto-rotate every 6 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % agents.length);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const activeAgent = agents[activeIndex];

  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
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
                  <div className={cn('inline-flex p-2 rounded-lg mb-2 bg-gradient-to-br', activeAgent.gradient)}>
                    {Icons[feature.icon]}
                  </div>
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
