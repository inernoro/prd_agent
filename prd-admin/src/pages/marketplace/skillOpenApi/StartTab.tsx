import { ArrowRight, Bot, Wrench } from 'lucide-react';

interface Props {
  /** 用户点了"手动接入"：切到使用指南 Tab */
  onChooseManual: () => void;
  /** 用户点了"智能体接入"：切到「我的 Key」Tab，并自动展开新建表单（走 agent 模式） */
  onChooseAgent: () => void;
}

/**
 * 「接入 AI」弹窗落地页 —— 日式极简广告风：
 *
 *   - 一屏一个焦点：两张分支选择卡 = 唯一行动入口，其他一律退让
 *   - 卡片自己就是按钮（整张可点），不再塞内嵌的「开始 →」小按钮
 *     （避免"卡片+按钮"的焦点重复）
 *   - 辅助信息压缩为一行灰字足注，不再用彩色徽章 / 时间线分散注意力
 *   - 上下由 flex + justify-center 撑开，让留白成为构图的一部分
 */
export function StartTab({ onChooseManual, onChooseAgent }: Props) {
  return (
    <div className="flex flex-col gap-8 h-full min-h-0 justify-center">
      {/* 标题 */}
      <div className="px-0.5 text-center">
        <div className="text-[15px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          选一条接入方式开始
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          你想让 AI 帮你一键接通，还是手动抄代码自己写 —— 看口味
        </div>
      </div>

      {/* 两个大卡片：整张卡片 = 按钮 */}
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

      {/* 一行足注：替代之前的双栏信息框，降到最弱 */}
      <div
        className="text-[10.5px] text-center"
        style={{ color: 'var(--text-muted)', opacity: 0.65, letterSpacing: '0.01em' }}
      >
        两种方式底层一致：默认 1 年有效期 + 7 天宽限期 + UI 随时续期，不会动不动就 403。
        <span className="mx-1.5 opacity-50">·</span>
        明文只显示一次，后端只存 SHA256 哈希。
      </div>
    </div>
  );
}
