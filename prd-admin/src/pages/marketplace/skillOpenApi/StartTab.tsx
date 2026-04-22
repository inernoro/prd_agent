import { Bot, BookOpen, Sparkles, Wrench } from 'lucide-react';

interface Props {
  /** 用户点了"手动接入"：切到使用指南 Tab */
  onChooseManual: () => void;
  /** 用户点了"智能体接入"：切到「我的 Key」Tab，并自动展开新建表单（走 agent 模式） */
  onChooseAgent: () => void;
}

/**
 * 「接入 AI」弹窗落地页 —— 只给用户两个选择：
 *
 *   1. 手动接入：自己抄代码 → 跳「使用指南」
 *   2. 智能体接入：一键创建 Key + 复制给智能体指令 → 跳「我的 Key」的新建流
 *
 * 遵循 `.claude/rules/zero-friction-input.md`：不让用户面对空白发呆；
 * 遵循 `guided-exploration.md`：新页面 3 秒内知道下一步做什么。
 */
export function StartTab({ onChooseManual, onChooseAgent }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {/* 大标题 + 副标题 */}
      <div className="px-1 pt-1">
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          选一条接入方式开始
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          你只是想抄代码自己写，还是让 AI 帮你一键搞定 —— 看你口味
        </div>
      </div>

      {/* 两个大卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 智能体接入（推荐） */}
        <button
          type="button"
          onClick={onChooseAgent}
          className="group text-left rounded-2xl p-4 transition-all relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, rgba(129, 140, 248, 0.18) 0%, rgba(56, 189, 248, 0.12) 100%)',
            border: '1px solid rgba(129, 140, 248, 0.42)',
            boxShadow:
              '0 8px 24px -12px rgba(99, 102, 241, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.08)',
          }}
        >
          {/* 推荐徽章 */}
          <div
            className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
            style={{
              background: 'rgba(129, 140, 248, 0.3)',
              color: 'rgba(237, 233, 254, 1)',
              border: '1px solid rgba(129, 140, 248, 0.5)',
            }}
          >
            <Sparkles size={10} />
            推荐
          </div>

          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center mb-3"
            style={{
              background: 'rgba(129, 140, 248, 0.3)',
              border: '1px solid rgba(129, 140, 248, 0.5)',
            }}
          >
            <Bot size={20} style={{ color: 'rgba(237, 233, 254, 1)' }} />
          </div>
          <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            智能体接入
          </div>
          <div className="text-[11px] leading-relaxed mb-2.5" style={{ color: 'rgba(224, 231, 255, 0.85)' }}>
            一键创建 API Key，复制一段指令粘贴给 Claude Code / Cursor —— AI 会自己
            <code className="font-mono mx-0.5">export</code>
            环境变量 + 下载解压官方技能包，立即接通本平台。
          </div>
          <div
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg"
            style={{
              background: 'rgba(129, 140, 248, 0.28)',
              color: 'rgba(237, 233, 254, 1)',
              border: '1px solid rgba(129, 140, 248, 0.5)',
            }}
          >
            开始 →
          </div>
        </button>

        {/* 手动接入 */}
        <button
          type="button"
          onClick={onChooseManual}
          className="group text-left rounded-2xl p-4 transition-all"
          style={{
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.05)',
          }}
        >
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center mb-3"
            style={{
              background: 'rgba(148, 163, 184, 0.16)',
              border: '1px solid rgba(148, 163, 184, 0.3)',
            }}
          >
            <Wrench size={20} style={{ color: 'rgba(203, 213, 225, 1)' }} />
          </div>
          <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            手动接入
          </div>
          <div className="text-[11px] leading-relaxed mb-2.5" style={{ color: 'var(--text-muted)' }}>
            看文档、抄 curl / TypeScript / Python 代码自己写 —— 适合想理解接口细节、或要把调用集成到现有 CI / 工具链的开发者。
          </div>
          <div
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg"
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
            }}
          >
            <BookOpen size={11} />
            查看使用指南
          </div>
        </button>
      </div>

      {/* 底部小字说明 */}
      <div
        className="rounded-xl px-3 py-2.5 text-[11px] leading-relaxed"
        style={{
          background: 'rgba(255, 255, 255, 0.025)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          color: 'var(--text-muted)',
        }}
      >
        两种方式底层一样：都需要一个 API Key，都走 <code className="font-mono">Authorization: Bearer</code> 鉴权。
        Key 默认 1 年有效期 + 7 天宽限期 + UI 随时续期，不会动不动就 403。
      </div>
    </div>
  );
}
