import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Book, KeyRound, Plus, X, Zap, type LucideIcon } from 'lucide-react';
import { listAgentApiKeys } from '@/services';
import type { AgentApiKeyDto } from '@/services/contracts/agentApiKeys';
import { toast } from '@/lib/toast';
import { CreateKeyTab } from './skillOpenApi/CreateKeyTab';
import { GuideTab } from './skillOpenApi/GuideTab';
import { KeysListTab } from './skillOpenApi/KeysListTab';

/**
 * 「接入 AI」弹窗 —— 海鲜市场右上角按钮触发。
 *
 * 三个 Tab：
 *  1. 我的 Key：列出用户已有的 AgentApiKey + 续期/撤销/删除
 *  2. 新建 Key：scope 勾选 + TTL + 明文一次性展示
 *  3. 使用指南：curl / TypeScript / Python 代码样本 + 订阅/修改/续期说明
 *
 * 遵守 `.claude/rules/frontend-modal.md`：
 *  - createPortal 挂到 document.body
 *  - height/maxHeight 用 inline style
 *  - 滚动容器 flex-1 + min-h-0 + overflowY: auto
 */
interface Props {
  onClose: () => void;
}

type TabKey = 'keys' | 'create' | 'guide';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'keys', label: '我的 Key', icon: KeyRound },
  { key: 'create', label: '新建 Key', icon: Plus },
  { key: 'guide', label: '使用指南', icon: Book },
];

export function SkillOpenApiDialog({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('keys');
  const [keys, setKeys] = useState<AgentApiKeyDto[]>([]);
  const [allowedScopes, setAllowedScopes] = useState<string[]>([
    'marketplace.skills:read',
    'marketplace.skills:write',
  ]);
  const [loading, setLoading] = useState(true);

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

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      style={{ background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="w-full flex flex-col rounded-2xl overflow-hidden"
        style={{
          width: 'min(720px, 100vw - 32px)',
          height: '86vh',
          maxHeight: '86vh',
          background: '#0f1014',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 30px 60px -20px rgba(0, 0, 0, 0.8)',
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
          {activeTab === 'keys' && (
            <KeysListTab
              keys={keys}
              loading={loading}
              onRefresh={refresh}
              onGotoCreate={() => setActiveTab('create')}
            />
          )}
          {activeTab === 'create' && (
            <CreateKeyTab
              allowedScopes={allowedScopes}
              onCreated={refresh}
              onBackToList={() => setActiveTab('keys')}
            />
          )}
          {activeTab === 'guide' && <GuideTab />}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
