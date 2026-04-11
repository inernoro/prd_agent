import {
  Sparkles,
  MessageSquare,
  Image as ImageIcon,
  PenLine,
  FileText,
  Video,
  Settings,
  Plus,
  Paperclip,
  ArrowUp,
} from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * ProductMockup — Linear 风格的"真实产品壳"
 *
 * 设计目标：
 * - 不是浮动假卡，是一个看起来像真实截图的 MAP 应用窗口
 * - 浏览器 chrome + 左侧 icon 导航 + 主内容区 + 输入框，对照真实应用布局
 * - 展示视觉 Agent 正在生成 4 张候选图的场景（动态进度 + 2 张已完成）
 * - 用于 Hero 首屏下半部分，让"米多 Agent 平台"不再只是一句 slogan，
 *   而是用户滚到一半就能看到的"这东西长这样"
 *
 * 动效克制：只有生成中的两格 shimmer + 底部 pulse dot，其他静态
 */
export function ProductMockup() {
  const { t } = useLanguage();
  const mock = t.productMockup;
  return (
    <div className="relative mx-auto w-full max-w-5xl">
      {/* 下方柔和光晕（作为"产品从暗处浮起来"的基座） */}
      <div
        className="absolute -inset-x-20 -bottom-20 top-20 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(124, 58, 237, 0.22) 0%, rgba(0, 240, 255, 0.12) 35%, transparent 70%)',
          filter: 'blur(60px)',
        }}
      />

      {/* 应用窗口本体 */}
      <div
        className="relative rounded-2xl overflow-hidden border border-white/10"
        style={{
          background: '#0A0D14',
          boxShadow:
            '0 50px 120px -30px rgba(124, 58, 237, 0.35), 0 30px 80px -20px rgba(0, 240, 255, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
        }}
      >
        {/* 浏览器 chrome */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] bg-[#080A10]">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-white/15" />
            <span className="w-3 h-3 rounded-full bg-white/15" />
            <span className="w-3 h-3 rounded-full bg-white/15" />
          </div>
          <div
            className="ml-4 px-3 py-1 rounded-md bg-white/[0.04] text-[11px] text-white/40 font-mono"
            style={{ letterSpacing: '0.02em' }}
          >
            map.miduo.org / visual-agent
          </div>
          <div className="ml-auto text-[10px] text-white/30 uppercase" style={{ letterSpacing: '0.15em' }}>
            MAP
          </div>
        </div>

        {/* 应用主体 */}
        <div className="flex h-[480px]">
          {/* 左侧 icon 导航 */}
          <aside className="w-14 border-r border-white/[0.06] py-4 flex flex-col items-center gap-2 bg-[#080A10]">
            <NavIcon Icon={MessageSquare} active tint="#a855f7" />
            <NavIcon Icon={ImageIcon} />
            <NavIcon Icon={PenLine} />
            <NavIcon Icon={FileText} />
            <NavIcon Icon={Video} />
            <div className="flex-1" />
            <NavIcon Icon={Settings} />
          </aside>

          {/* 中间对话列表（极简，i18n）*/}
          <div className="w-56 border-r border-white/[0.06] p-3 hidden md:block">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] text-white/85 border border-white/10 bg-white/[0.03] mb-3"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              <Plus className="w-3.5 h-3.5" />
              {mock.newConversation}
            </button>
            <div className="space-y-0.5">
              {mock.conversations.map((conv, i) => (
                <ConversationItem
                  key={i}
                  title={conv.title}
                  subtitle={conv.meta}
                  active={i === 0}
                />
              ))}
            </div>
          </div>

          {/* 主内容区 */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* 顶部标题栏 */}
            <header className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: 'linear-gradient(135deg, rgba(168,85,247,0.25), rgba(124,58,237,0.15))',
                    border: '1px solid rgba(168,85,247,0.4)',
                  }}
                >
                  <Sparkles className="w-4 h-4 text-purple-300" />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] text-white/90 font-medium truncate" style={{ fontFamily: 'var(--font-display)' }}>
                    {mock.header.title}
                  </div>
                  <div className="text-[10px] text-white/40">{mock.header.meta}</div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button className="px-3 py-1.5 rounded-md text-[11px] text-white/55 border border-white/10 hover:bg-white/[0.04]">
                  {mock.actions.share}
                </button>
                <button
                  className="px-3 py-1.5 rounded-md text-[11px] text-white/90"
                  style={{
                    background: 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(124,58,237,0.2))',
                    border: '1px solid rgba(168,85,247,0.4)',
                  }}
                >
                  {mock.actions.continue}
                </button>
              </div>
            </header>

            {/* 对话区 */}
            <div className="flex-1 p-6 space-y-5 overflow-hidden">
              {/* 用户消息 */}
              <div className="flex justify-end">
                <div
                  className="max-w-sm px-4 py-2.5 rounded-2xl rounded-tr-md text-[13px] text-white/90 leading-relaxed"
                  style={{
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  {mock.chat.userMessage}
                </div>
              </div>

              {/* Agent 回复 + 4 张候选 */}
              <div className="flex gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: 'linear-gradient(135deg, #a855f7, #7c3aed)',
                    boxShadow: '0 0 20px rgba(168, 85, 247, 0.4)',
                  }}
                >
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/85 mb-3 leading-relaxed" style={{ fontFamily: 'var(--font-body)' }}>
                    {mock.chat.agentReply}
                  </div>

                  {/* 4 张候选图 */}
                  <div className="grid grid-cols-4 gap-2 max-w-md">
                    <MockImage variant={1} done />
                    <MockImage variant={2} done />
                    <MockImage variant={3} generating />
                    <MockImage variant={4} generating />
                  </div>

                  {/* 生成中状态行 */}
                  <div className="flex items-center gap-2 mt-3 text-[11px] text-white/45">
                    <span
                      className="relative flex h-2 w-2"
                      style={{ filter: 'drop-shadow(0 0 4px #a855f7)' }}
                    >
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-400" />
                    </span>
                    {mock.chat.progress}
                  </div>
                </div>
              </div>
            </div>

            {/* 输入栏 */}
            <div className="p-4 border-t border-white/[0.06]">
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-white/10">
                <span
                  className="text-[12px] text-white/35 flex-1 truncate"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {mock.input}
                </span>
                <button className="w-7 h-7 rounded-md text-white/45 hover:bg-white/5 flex items-center justify-center">
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                <button
                  className="w-7 h-7 rounded-md flex items-center justify-center text-white"
                  style={{
                    background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
                    boxShadow: '0 0 12px rgba(124, 58, 237, 0.5)',
                  }}
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 子组件 ────────────────────────────────────────────

function NavIcon({
  Icon,
  active,
  tint,
}: {
  Icon: typeof Sparkles;
  active?: boolean;
  tint?: string;
}) {
  return (
    <button
      className="w-9 h-9 rounded-xl flex items-center justify-center transition-colors"
      style={{
        background: active ? `${tint ?? '#ffffff'}18` : 'transparent',
        border: active ? `1px solid ${tint ?? '#ffffff'}33` : '1px solid transparent',
      }}
    >
      <Icon className="w-4 h-4" style={{ color: active ? tint ?? '#ffffff' : 'rgba(255,255,255,0.4)' }} />
    </button>
  );
}

function ConversationItem({
  title,
  subtitle,
  active,
}: {
  title: string;
  subtitle: string;
  active?: boolean;
}) {
  return (
    <button
      className="w-full text-left px-3 py-2 rounded-lg transition-colors"
      style={{
        background: active ? 'rgba(168, 85, 247, 0.10)' : 'transparent',
        border: active ? '1px solid rgba(168, 85, 247, 0.25)' : '1px solid transparent',
      }}
    >
      <div
        className="text-[12px] text-white/85 truncate"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        {title}
      </div>
      <div className="text-[10px] text-white/35 truncate mt-0.5">{subtitle}</div>
    </button>
  );
}

function MockImage({
  variant,
  done,
  generating,
}: {
  variant: number;
  done?: boolean;
  generating?: boolean;
}) {
  // 4 种不同的"合成图"渐变模式，模拟不同方向的生成结果
  const gradients = [
    'radial-gradient(circle at 30% 70%, #00d4ff 0%, transparent 45%), radial-gradient(circle at 70% 30%, #7c3aed 0%, transparent 45%), linear-gradient(135deg, #0a0a1e 0%, #1a0a2e 100%)',
    'radial-gradient(circle at 50% 80%, #f43f5e 0%, transparent 50%), radial-gradient(circle at 20% 30%, #3b82f6 0%, transparent 45%), linear-gradient(135deg, #0b0510 0%, #1a0a20 100%)',
    'radial-gradient(circle at 40% 50%, #00f0ff 0%, transparent 50%), linear-gradient(135deg, #050a15 0%, #0a1025 100%)',
    'radial-gradient(circle at 60% 40%, #a855f7 0%, transparent 45%), radial-gradient(circle at 30% 80%, #ec4899 0%, transparent 45%), linear-gradient(135deg, #100515 0%, #200a25 100%)',
  ];

  return (
    <div
      className="relative aspect-[16/10] rounded-md overflow-hidden border border-white/[0.06]"
      style={{ background: gradients[variant - 1] }}
    >
      {/* "图像内容"的几何提示 */}
      <div
        className="absolute inset-x-0 bottom-0 h-2/3"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      <div
        className="absolute left-[15%] bottom-[15%] w-[8%] h-[45%] rounded-sm"
        style={{ background: 'rgba(255, 255, 255, 0.08)' }}
      />
      <div
        className="absolute left-[28%] bottom-[15%] w-[6%] h-[60%] rounded-sm"
        style={{ background: 'rgba(255, 255, 255, 0.12)' }}
      />
      <div
        className="absolute left-[40%] bottom-[15%] w-[10%] h-[55%] rounded-sm"
        style={{ background: 'rgba(255, 255, 255, 0.09)' }}
      />
      <div
        className="absolute left-[56%] bottom-[15%] w-[7%] h-[70%] rounded-sm"
        style={{ background: 'rgba(255, 255, 255, 0.11)' }}
      />
      <div
        className="absolute left-[70%] bottom-[15%] w-[9%] h-[50%] rounded-sm"
        style={{ background: 'rgba(255, 255, 255, 0.08)' }}
      />

      {/* 生成中 shimmer overlay */}
      {generating && (
        <>
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)',
              animation: 'mockup-shimmer 1.8s linear infinite',
            }}
          />
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="text-[9px] text-white/70" style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.1em' }}>
              {variant === 3 ? '68%' : '42%'}
            </div>
          </div>
        </>
      )}

      {/* 完成态：左上小对勾 */}
      {done && (
        <div className="absolute top-1.5 left-1.5 w-3.5 h-3.5 rounded-full bg-emerald-400/90 flex items-center justify-center">
          <svg className="w-2 h-2 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      <style>{`
        @keyframes mockup-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}
