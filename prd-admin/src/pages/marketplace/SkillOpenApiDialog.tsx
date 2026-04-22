import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Book, KeyRound, Sparkles, X, Zap, type LucideIcon } from 'lucide-react';
import { listAgentApiKeys } from '@/services';
import type { AgentApiKeyDto } from '@/services/contracts/agentApiKeys';
import { toast } from '@/lib/toast';
import { GuideTab } from './skillOpenApi/GuideTab';
import { KeysListTab } from './skillOpenApi/KeysListTab';
import { StartTab } from './skillOpenApi/StartTab';

/**
 * 「接入 AI」弹窗 —— 海鲜市场右上角按钮触发。
 *
 * 三个 Tab：
 *  1. 新建接入（落地页）：两个大卡片 —— 手动接入 / 智能体接入
 *  2. 我的 Key：列表 + 内联新建表单（不再是独立 Tab）
 *  3. 使用指南：curl / TypeScript / Python 代码样本 + 订阅/修改/续期说明
 *
 * 流程：
 *  - 手动接入 → 切 Tab 3 「使用指南」，用户自己照着抄代码
 *  - 智能体接入 → 切 Tab 2 「我的 Key」，自动进入新建表单 agent 模式，
 *    创建完给用户「复制给智能体使用」按钮一键复制完整 prompt
 *
 * 遵守 `.claude/rules/frontend-modal.md`：
 *  - createPortal 挂到 document.body
 *  - height/maxHeight 用 inline style
 *  - 滚动容器 flex-1 + min-h-0 + overflowY: auto
 */
interface Props {
  onClose: () => void;
}

type TabKey = 'start' | 'keys' | 'guide';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'start', label: '新建接入', icon: Sparkles },
  { key: 'keys', label: '我的 Key', icon: KeyRound },
  { key: 'guide', label: '使用指南', icon: Book },
];

export function SkillOpenApiDialog({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('start');
  const [keys, setKeys] = useState<AgentApiKeyDto[]>([]);
  const [allowedScopes, setAllowedScopes] = useState<string[]>([
    'marketplace.skills:read',
    'marketplace.skills:write',
  ]);
  const [loading, setLoading] = useState(true);
  /** 单调递增的"新建信号"：StartTab 点智能体接入时 ++，KeysListTab 监听到就打开创建表单 */
  const [openCreateSignal, setOpenCreateSignal] = useState(0);
  /** 当前走的是不是智能体接入流程 —— 影响 CreateKeyTab 的 agent CTA 高亮 */
  const [agentMode, setAgentMode] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAgentApiKeys();
      if (res.success && res.data) {
        setKeys(res.data.items ?? []);
        if (res.data.allowedScopes && res.data.allowedScopes.length > 0) {
          setAllowedScopes(res.data.allowedScopes);
        }
      } else {
        toast.error(res.error?.message ?? '加载 API Key 列表失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleChooseManual = () => {
    setAgentMode(false);
    setActiveTab('guide');
  };

  const handleChooseAgent = () => {
    setAgentMode(true);
    setActiveTab('keys');
    // 用递增信号通知 KeysListTab 立即切进新建表单（和 agentMode 一起喂进去）
    setOpenCreateSignal((n) => n + 1);
  };

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      style={{ background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="w-full flex flex-col rounded-[20px] overflow-hidden"
        style={{
          width: 'min(760px, 100vw - 32px)',
          height: '88vh',
          maxHeight: '88vh',
          background:
            'linear-gradient(180deg, rgba(15, 23, 42, 0.82) 0%, rgba(2, 6, 23, 0.9) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.28)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          boxShadow:
            '0 30px 64px -18px rgba(0, 0, 0, 0.7), 0 0 40px -12px rgba(56, 189, 248, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.08)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 px-5 py-4 flex items-center justify-between gap-3"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{
                background: 'rgba(56, 189, 248, 0.15)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
              }}
            >
              <Zap size={16} style={{ color: 'rgba(186, 230, 253, 1)' }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                接入 AI · 海鲜市场开放接口
              </h2>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                给外部 AI / Agent 授权一个长效 Key，让它帮你浏览、下载、上传技能
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          className="shrink-0 px-5 flex items-center gap-1"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs transition-all"
                style={{
                  color: active ? 'rgba(186, 230, 253, 1)' : 'var(--text-muted)',
                  borderBottom: `2px solid ${active ? 'rgba(56, 189, 248, 0.8)' : 'transparent'}`,
                  marginBottom: '-1px',
                }}
              >
                <Icon size={13} />
                {t.label}
                {t.key === 'keys' && keys.length > 0 && (
                  <span
                    className="ml-1 px-1.5 rounded-full text-[10px]"
                    style={{
                      background: 'rgba(56, 189, 248, 0.18)',
                      color: 'rgba(186, 230, 253, 1)',
                    }}
                  >
                    {keys.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Body (scrollable) */}
        <div
          className="flex-1 px-5 py-4"
          style={{
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {activeTab === 'start' && (
            <StartTab onChooseManual={handleChooseManual} onChooseAgent={handleChooseAgent} />
          )}
          {activeTab === 'keys' && (
            <KeysListTab
              keys={keys}
              loading={loading}
              allowedScopes={allowedScopes}
              onRefresh={refresh}
              openCreateSignal={openCreateSignal}
              agentMode={agentMode}
            />
          )}
          {activeTab === 'guide' && <GuideTab />}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
