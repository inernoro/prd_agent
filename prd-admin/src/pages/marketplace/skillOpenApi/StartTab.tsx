import { ArrowRight, Bot, Copy, Download, KeyRound, Wrench } from 'lucide-react';

interface Props {
  /** 用户点了"手动接入"：切到使用指南 Tab */
  onChooseManual: () => void;
  /** 用户点了"智能体接入"：切到「我的 Key」Tab，并自动展开新建表单（走 agent 模式） */
  onChooseAgent: () => void;
}

/**
 * 「接入 AI」弹窗落地页 —— 顶/中/底三段式：
 *  - 顶部：标题（左对齐、不抢戏）
 *  - 中部：两张选择卡（主视觉）
 *  - 底部：横向 3 步流程条（把"点了之后会发生什么"视觉化，顺便撑满下方空间）
 *
 * 原则仍遵循"一屏一焦点"：推荐卡用青蓝渐变弱提示，底部流程条用透明 ghost
 * 不和主卡片抢注意力。
 */
export function StartTab({ onChooseManual, onChooseAgent }: Props) {
  return (
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* 顶部：标题（左对齐，不居中） */}
      <div className="px-0.5">
        <div className="text-[15px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          选一条接入方式开始
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          想让 AI 一键接通 / 手动抄代码自己写 —— 看口味
        </div>
      </div>

      {/* 中部：两张选择卡（主视觉焦点） */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          type="button"
          onClick={onChooseAgent}
          className="group text-left rounded-2xl p-5 transition-all relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, rgba(56, 189, 248, 0.12) 0%, rgba(99, 102, 241, 0.06) 100%)',
            border: '1px solid rgba(56, 189, 248, 0.32)',
            boxShadow:
              '0 12px 36px -20px rgba(56, 189, 248, 0.38), inset 0 1px 1px rgba(255, 255, 255, 0.06)',
          }}
        >
          <div
            className="absolute top-4 right-4 text-[10px] font-medium"
            style={{ color: 'rgba(186, 230, 253, 0.85)', letterSpacing: '0.04em' }}
          >
            ⭐ 推荐
          </div>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
            style={{
              background: 'rgba(56, 189, 248, 0.16)',
              border: '1px solid rgba(56, 189, 248, 0.32)',
            }}
          >
            <Bot size={20} style={{ color: 'rgba(186, 230, 253, 1)' }} />
          </div>
          <div className="text-[14px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
            智能体接入
          </div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'rgba(224, 242, 254, 0.72)' }}>
            一键生成 Key + 复制提示词粘贴给 Claude Code / Cursor ——
            <br className="hidden md:inline" />
            AI 自己装 findmapskills 技能，立即接通。
          </div>
          <div
            className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium"
            style={{ color: 'rgba(186, 230, 253, 0.95)' }}
          >
            开始
            <ArrowRight
              size={12}
              className="transition-transform group-hover:translate-x-0.5"
              style={{ opacity: 0.85 }}
            />
          </div>
        </button>

        <button
          type="button"
          onClick={onChooseManual}
          className="group text-left rounded-2xl p-5 transition-all"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.04)',
          }}
        >
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
            style={{
              background: 'rgba(148, 163, 184, 0.12)',
              border: '1px solid rgba(148, 163, 184, 0.24)',
            }}
          >
            <Wrench size={20} style={{ color: 'rgba(203, 213, 225, 1)' }} />
          </div>
          <div className="text-[14px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
            手动接入
          </div>
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            看文档、抄 curl / TypeScript / Python 代码自己写 ——
            <br className="hidden md:inline" />
            适合想理解接口细节或集成到 CI / 工具链的开发者。
          </div>
          <div
            className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            查看使用指南
            <ArrowRight
              size={12}
              className="transition-transform group-hover:translate-x-0.5"
              style={{ opacity: 0.7 }}
            />
          </div>
        </button>
      </div>

      {/* 底部：横向 3 步流程条 —— 撑满下方空间，给"智能体接入"做 30 秒可预览的路径 */}
      <div
        className="mt-auto rounded-2xl px-5 py-4"
        style={{
          background:
            'linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, rgba(255, 255, 255, 0.015) 100%)',
          border: '1px solid rgba(255, 255, 255, 0.07)',
        }}
      >
        <div className="text-[10.5px] mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
          智能体接入 · 30 秒跑通
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-center">
          {[
            { icon: KeyRound, label: '生成 Key', hint: '勾选权限范围' },
            { icon: Copy, label: '复制指令', hint: '一段提示词' },
            { icon: Download, label: 'AI 自己接通', hint: '装 findmapskills' },
          ].map((step, idx, arr) => {
            const Icon = step.icon;
            return (
              <div key={step.label} className="contents md:contents">
                <div className="flex items-center gap-2.5 md:flex-col md:items-start">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 relative"
                    style={{
                      background: 'rgba(56, 189, 248, 0.1)',
                      border: '1px solid rgba(56, 189, 248, 0.22)',
                    }}
                  >
                    <Icon size={14} style={{ color: 'rgba(186, 230, 253, 1)' }} />
                    <span
                      className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full text-[9px] flex items-center justify-center font-medium"
                      style={{ background: 'rgba(56, 189, 248, 0.8)', color: '#ffffff' }}
                    >
                      {idx + 1}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11.5px] font-medium leading-tight" style={{ color: 'var(--text-primary)' }}>
                      {step.label}
                    </div>
                    <div className="text-[10.5px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                      {step.hint}
                    </div>
                  </div>
                </div>
                {idx < arr.length - 1 && (
                  <ArrowRight
                    size={14}
                    className="hidden md:block justify-self-center"
                    style={{ color: 'var(--text-muted)', opacity: 0.4 }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-3 pt-3 text-[10.5px]" style={{ color: 'var(--text-muted)', opacity: 0.7, borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
          默认 1 年有效期 + 7 天宽限期 + UI 随时续期，不会动不动就 403。明文仅显示一次，后端只存 SHA256 哈希。
        </div>
      </div>
    </div>
  );
}
