import {
  ArrowRight,
  BookOpen,
  Bot,
  Code2,
  Copy,
  Download,
  KeyRound,
  Search,
  ShieldCheck,
  UploadCloud,
  Wrench,
} from 'lucide-react';

interface Props {
  /** 用户点了"手动接入"：切到使用指南 Tab */
  onChooseManual: () => void;
  /** 用户点了"智能体接入"：切到「我的 Key」Tab，并自动展开新建表单（走 agent 模式） */
  onChooseAgent: () => void;
}

/**
 * 「接入 AI」弹窗落地页。
 *
 * 参考同类的 Key 创建和安装向导，避免大面积营销卡片：
 * - 左侧只负责选择接入方式。
 * - 右侧说明接入后能做什么和安全边界。
 * - 底部用紧凑步骤条交代下一步，不用空白撑高度。
 */
export function StartTab({ onChooseManual, onChooseAgent }: Props) {
  const options = [
    {
      key: 'agent',
      title: '智能体接入',
      hint: '推荐',
      description: '生成 Key 后复制一段指令给 Claude Code / Cursor，让 AI 自动安装 findmapskills 并接通市场。',
      action: '生成 Key 并复制指令',
      icon: Bot,
      onClick: onChooseAgent,
      featured: true,
    },
    {
      key: 'manual',
      title: '手动接入',
      hint: '开发者',
      description: '查看 curl / TypeScript / Python 示例，自己接入 CI、脚本或工具链。',
      action: '查看使用指南',
      icon: Wrench,
      onClick: onChooseManual,
      featured: false,
    },
  ];

  const abilities = [
    { icon: Search, label: '浏览市场', desc: '搜索公开技能和配置' },
    { icon: Download, label: '下载技能', desc: '拉取 zip 或 fork 副本' },
    { icon: UploadCloud, label: '上传技能', desc: '按你的身份发布' },
    { icon: ShieldCheck, label: '权限授权', desc: '只开放勾选范围' },
  ];

  const steps = [
    { icon: KeyRound, label: '生成 Key', hint: '权限 + 有效期' },
    { icon: Copy, label: '复制指令', hint: '明文只显示一次' },
    { icon: Download, label: '接通市场', hint: '安装 findmapskills' },
  ];

  return (
    <div className="open-api-start">
      <div className="open-api-start-heading">
        <div>
          <div className="open-api-eyebrow">
            接入方式
          </div>
          <div className="open-api-title">
            先选择谁来调用海鲜市场
          </div>
        </div>
        <div className="open-api-heading-note">
          外部 AI / Agent 只拿到你授权的市场能力。
        </div>
      </div>

      <div className="open-api-start-layout">
        <div className="open-api-option-list">
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.key}
                type="button"
                onClick={option.onClick}
                data-featured={option.featured}
                className="open-api-option-card"
              >
                <div className="open-api-option-icon">
                  <Icon size={17} />
                </div>
                <div className="open-api-option-main">
                  <div className="open-api-option-topline">
                    <span className="open-api-option-title">
                      {option.title}
                    </span>
                    <span className="open-api-option-badge">
                      {option.hint}
                    </span>
                  </div>
                  <p className="open-api-option-desc">
                    {option.description}
                  </p>
                  <span className="open-api-option-action">
                    {option.action}
                    <ArrowRight size={12} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <aside className="open-api-summary-panel">
          <div className="open-api-summary-head">
            <div className="open-api-summary-icon">
              <Code2 size={15} />
            </div>
            <div>
              <div className="open-api-summary-title">
                接入后可用能力
              </div>
              <div className="open-api-summary-subtitle">
                适合工具链、自动化脚本和 AI Agent。
              </div>
            </div>
          </div>

          <div className="open-api-ability-list">
            {abilities.map((ability) => {
              const Icon = ability.icon;
              return (
                <div key={ability.label} className="open-api-ability-row">
                  <span className="open-api-ability-icon">
                    <Icon size={12} />
                  </span>
                  <span className="open-api-ability-copy">
                    <span className="open-api-ability-label">
                      {ability.label}
                    </span>
                    <span className="open-api-ability-desc">
                      {ability.desc}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="open-api-security-note">
            <ShieldCheck size={13} />
            <span>
              默认只创建长效 Key，权限可控；明文只显示一次，后端只保存哈希。
            </span>
          </div>
        </aside>
      </div>

      <div className="open-api-step-strip">
        <div className="open-api-step-title">
          推荐路径 · 30 秒跑通
        </div>
        <div className="open-api-step-list">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <div key={step.label} className="open-api-step-item">
                <div className="open-api-step-icon">
                  <span className="open-api-step-number">
                    {idx + 1}
                  </span>
                  <span className="open-api-step-symbol">
                    <Icon size={14} />
                  </span>
                </div>
                <div className="open-api-step-copy">
                  <div className="open-api-step-label">
                    {step.label}
                  </div>
                  <div className="open-api-step-hint">
                    {step.hint}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="open-api-step-help">
          <BookOpen size={12} />
          <span>需要自己集成时，选择“手动接入”查看完整接口示例。</span>
        </div>
      </div>
    </div>
  );
}
