import { ArrowRight, Bot, BookOpen, Clock, Download, KeyRound, Shield, Wrench } from 'lucide-react';

interface Props {
  /** 用户点了"手动接入"：切到使用指南 Tab */
  onChooseManual: () => void;
  /** 用户点了"智能体接入"：切到「我的 Key」Tab，并自动展开新建表单（走 agent 模式） */
  onChooseAgent: () => void;
}

/**
 * 「接入 AI」弹窗落地页 —— 只给用户两个选择 + 三步时间线 + 安全提示，
 * 让面板不再有"下半部分空着"的黑洞。
 *
 * 视觉对齐：
 *  - 不使用高饱和紫色单色，而是用和外层液态玻璃同家的半透明面板
 *  - 「智能体接入」用青蓝色调（和整体 Key 状态色统一），仅以 ⭐ 徽章标记推荐
 *  - 流程时间线沿用 `frontend-architecture.md` 的注册表风格
 */
export function StartTab({ onChooseManual, onChooseAgent }: Props) {
  return (
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* 大标题 + 副标题 */}
      <div className="px-0.5">
        <div className="text-base font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
          选一条接入方式开始
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          你想让 AI 帮你一键接通，还是手动抄代码自己写 —— 看口味
        </div>
      </div>

      {/* 两个大卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 智能体接入（推荐）—— 青蓝色调，和外壳玻璃融在一起 */}
        <button
          type="button"
          onClick={onChooseAgent}
          className="group text-left rounded-2xl p-4 transition-all relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, rgba(56, 189, 248, 0.14) 0%, rgba(79, 70, 229, 0.08) 100%)',
            border: '1px solid rgba(56, 189, 248, 0.32)',
            boxShadow:
              '0 10px 30px -18px rgba(56, 189, 248, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.06)',
          }}
        >
          <div
            className="absolute top-3 right-3 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
            style={{
              background: 'rgba(56, 189, 248, 0.2)',
              color: 'rgba(186, 230, 253, 0.98)',
              border: '1px solid rgba(56, 189, 248, 0.4)',
            }}
          >
            ⭐ 推荐
          </div>

          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
            style={{
              background: 'rgba(56, 189, 248, 0.18)',
              border: '1px solid rgba(56, 189, 248, 0.35)',
            }}
          >
            <Bot size={18} style={{ color: 'rgba(186, 230, 253, 1)' }} />
          </div>
          <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            智能体接入
          </div>
          <div className="text-[11px] leading-relaxed mb-3" style={{ color: 'rgba(224, 242, 254, 0.78)' }}>
            一键生成 Key + 复制提示词粘贴给 Claude Code / Cursor —— AI 会自己配置环境变量、下载 findmapskills 技能，立即接通。
          </div>
          <div
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg group-hover:gap-1.5 transition-all"
            style={{
              background: 'rgba(56, 189, 248, 0.2)',
              color: 'rgba(186, 230, 253, 1)',
              border: '1px solid rgba(56, 189, 248, 0.42)',
            }}
          >
            开始
            <ArrowRight size={11} />
          </div>
        </button>

        {/* 手动接入 */}
        <button
          type="button"
          onClick={onChooseManual}
          className="group text-left rounded-2xl p-4 transition-all relative"
          style={{
            background: 'rgba(255, 255, 255, 0.035)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.04)',
          }}
        >
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
            style={{
              background: 'rgba(148, 163, 184, 0.14)',
              border: '1px solid rgba(148, 163, 184, 0.28)',
            }}
          >
            <Wrench size={18} style={{ color: 'rgba(203, 213, 225, 1)' }} />
          </div>
          <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            手动接入
          </div>
          <div className="text-[11px] leading-relaxed mb-3" style={{ color: 'var(--text-muted)' }}>
            看文档、抄 curl / TypeScript / Python 代码自己写 —— 适合想理解接口细节、或要把调用集成到现有 CI / 工具链的开发者。
          </div>
          <div
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg group-hover:gap-1.5 transition-all"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
            }}
          >
            <BookOpen size={11} />
            查看使用指南
          </div>
        </button>
      </div>

      {/* 智能体接入 3 步时间线 —— 给用户"我点了会发生什么"的确定感 */}
      <div
        className="rounded-2xl p-4"
        style={{
          background: 'rgba(255, 255, 255, 0.025)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <div className="text-[11px] font-medium mb-3 inline-flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
          <Clock size={12} />
          智能体接入 3 步，30 秒跑通
        </div>
        <ol className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            { icon: KeyRound, title: '生成 Key', desc: '点「开始」→ 勾选权限 → 一键创建' },
            { icon: Bot, title: '复制指令', desc: '创建完点「复制给智能体使用」' },
            { icon: Download, title: '粘给 AI', desc: 'AI 自己装 findmapskills 技能' },
          ].map((step, idx) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="flex items-start gap-2.5">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-mono relative"
                  style={{
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.28)',
                    color: 'rgba(186, 230, 253, 1)',
                  }}
                >
                  <Icon size={13} />
                  <span
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full text-[9px] flex items-center justify-center font-medium"
                    style={{
                      background: 'rgba(56, 189, 248, 0.8)',
                      color: 'white',
                    }}
                  >
                    {idx + 1}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {step.title}
                  </div>
                  <div className="text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    {step.desc}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* 安全 + 生命周期要点 —— 把底部撑起来，同时承接用户对"安全/过期"的预期 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div
          className="rounded-2xl p-3.5 flex items-start gap-2.5"
          style={{
            background: 'rgba(255, 255, 255, 0.025)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(34, 197, 94, 0.14)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
            }}
          >
            <Shield size={15} style={{ color: 'rgba(134, 239, 172, 1)' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
              密钥只会保存在你自己的环境变量里
            </div>
            <div className="text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              智能体接入提示词会指引 AI 把 Key 写进
              <code className="font-mono mx-0.5">~/.zshrc</code>
              或 <code className="font-mono mx-0.5">~/.bashrc</code>，不会入 git 仓库。明文只显示一次，后端只存 SHA256 哈希。
            </div>
          </div>
        </div>
        <div
          className="rounded-2xl p-3.5 flex items-start gap-2.5"
          style={{
            background: 'rgba(255, 255, 255, 0.025)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(234, 179, 8, 0.14)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
            }}
          >
            <Clock size={15} style={{ color: 'rgba(253, 224, 71, 1)' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
              默认 1 年 + 7 天宽限期，UI 随时续期
            </div>
            <div className="text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              到期前 30 天响应头会提示
              <code className="font-mono mx-0.5">X-AgentApiKey-ExpiringSoon</code>，到期后仍有 7 天宽限期放行。去「我的 Key」点「续期一年」即可。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
