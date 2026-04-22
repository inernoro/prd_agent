import { useEffect, useState } from 'react';
import { Copy, Download, KeyRound, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  deleteAgentApiKey,
  renewAgentApiKey,
  revokeAgentApiKey,
} from '@/services';
import type { AgentApiKeyDto } from '@/services/contracts/agentApiKeys';
import { StatusBadge, formatDateTime, formatDaysLeft } from './statusBadge';
import { CreateKeyTab } from './CreateKeyTab';
import {
  OFFICIAL_SKILL_FINDMAPSKILLS,
  downloadOfficialSkill,
} from './downloadOfficialSkill';

interface Props {
  keys: AgentApiKeyDto[];
  loading: boolean;
  allowedScopes: string[];
  onRefresh: () => Promise<void>;
  /** 从外部强制进入新建表单态（如 StartTab「智能体接入」跳转时）。变 true 时切换状态 */
  openCreateSignal?: number;
  /** 智能体模式：显示时优先推荐「复制给智能体」CTA + 自动勾选 read scope */
  agentMode?: boolean;
}

export function KeysListTab({ keys, loading, allowedScopes, onRefresh, openCreateSignal, agentMode }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // 外部切换到本 Tab 并且要求开启新建表单（智能体接入流程）
  useEffect(() => {
    if (openCreateSignal !== undefined && openCreateSignal > 0) {
      setShowCreate(true);
    }
  }, [openCreateSignal]);

  const handleDownloadSkill = async () => {
    setDownloading(true);
    try {
      await downloadOfficialSkill(OFFICIAL_SKILL_FINDMAPSKILLS);
      toast.success('已下载 findmapskills.zip');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloading(false);
    }
  };

  const copyPrefix = async (prefix: string) => {
    try {
      await navigator.clipboard.writeText(prefix);
      toast.success(`已复制 Key 前缀: ${prefix}`);
    } catch {
      toast.error('复制失败，请手动选中');
    }
  };

  const handleRenew = async (key: AgentApiKeyDto) => {
    setBusyId(key.id);
    try {
      const res = await renewAgentApiKey({ id: key.id });
      if (res.success) {
        toast.success(`已续期 365 天：${key.name}`);
        await onRefresh();
      } else {
        toast.error(res.error?.message ?? '续期失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (key: AgentApiKeyDto) => {
    if (!window.confirm(`确定撤销 "${key.name}"？撤销后立即失效且不可恢复，所有使用该 Key 的 AI 将无法继续访问。`))
      return;
    setBusyId(key.id);
    try {
      const res = await revokeAgentApiKey({ id: key.id });
      if (res.success) {
        toast.success(`已撤销：${key.name}`);
        await onRefresh();
      } else {
        toast.error(res.error?.message ?? '撤销失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (key: AgentApiKeyDto) => {
    if (!window.confirm(`确定彻底删除 "${key.name}"？该操作无法撤回。`)) return;
    setBusyId(key.id);
    try {
      const res = await deleteAgentApiKey({ id: key.id });
      if (res.success) {
        toast.success(`已删除：${key.name}`);
        await onRefresh();
      } else {
        toast.error(res.error?.message ?? '删除失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  // 内联新建表单态：CreateKeyTab 嵌在同一 Tab 里渲染，不再单独开一个 Tab
  if (showCreate) {
    return (
      <CreateKeyTab
        allowedScopes={allowedScopes}
        onCreated={onRefresh}
        onBackToList={() => setShowCreate(false)}
        agentMode={agentMode}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        <MapSpinner size={16} />
        正在加载你的 API Key…
      </div>
    );
  }

  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 gap-4 h-full">
        <KeyRound size={40} style={{ color: 'var(--text-muted)', opacity: 0.45 }} />
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          你还没有创建任何 API Key
        </div>
        <div className="text-xs max-w-md text-center leading-relaxed" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          创建一个 Key，让 Cursor / Claude Code / 任意 AI Agent 能授权浏览和下载海鲜市场的技能包。
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="mt-1 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[12px] font-semibold transition-all"
          style={{
            background:
              'linear-gradient(135deg, rgba(56, 189, 248, 0.85) 0%, rgba(14, 165, 233, 0.85) 100%)',
            color: '#ffffff',
            border: '1px solid rgba(186, 230, 253, 0.35)',
            boxShadow:
              '0 10px 24px -14px rgba(56, 189, 248, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.18)',
          }}
        >
          <KeyRound size={13} />
          创建第一个 Key
        </button>
        <button
          type="button"
          onClick={handleDownloadSkill}
          disabled={downloading}
          className="text-[11px] inline-flex items-center gap-1 hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          <Download size={11} />
          {downloading ? '下载中…' : '或先下载官方技能包'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部行动栏：新建 Key（主 —— 彩色） + 下载技能包（次 —— 幽灵描边） + Key 计数（弱） */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all"
          style={{
            background:
              'linear-gradient(135deg, rgba(56, 189, 248, 0.85) 0%, rgba(14, 165, 233, 0.85) 100%)',
            color: '#ffffff',
            border: '1px solid rgba(186, 230, 253, 0.35)',
            boxShadow:
              '0 8px 20px -12px rgba(56, 189, 248, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.16)',
          }}
        >
          <Plus size={13} />
          新建 Key
        </button>
        <button
          type="button"
          onClick={handleDownloadSkill}
          disabled={downloading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs transition-all hover:bg-white/5"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            color: 'var(--text-secondary)',
          }}
          title="下载 findmapskills 官方技能包，解压到 ~/.claude/skills/ 后 AI 就知道怎么调开放接口"
        >
          <Download size={12} />
          {downloading ? '下载中…' : '下载技能包'}
        </button>
        <div className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>
          共 {keys.length} 个 Key
        </div>
      </div>

      {keys.map((k) => {
        const disabled = busyId === k.id;
        const canRenew = k.status !== 'revoked';
        return (
          <div
            key={k.id}
            className="rounded-xl px-4 py-3 flex flex-col gap-2"
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {k.name}
                  </span>
                  <StatusBadge status={k.status} />
                </div>
                {k.description && (
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {k.description}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {canRenew && (
                  <button
                    type="button"
                    onClick={() => handleRenew(k)}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-all hover:bg-white/5"
                    style={{ color: 'rgba(186, 230, 253, 0.9)' }}
                    title="续期 365 天"
                  >
                    <RefreshCw size={12} />
                    续期一年
                  </button>
                )}
                {k.status !== 'revoked' && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(k)}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-all hover:bg-white/5"
                    style={{ color: 'rgba(251, 146, 60, 0.9)' }}
                    title="撤销（立即失效）"
                  >
                    <XCircle size={12} />
                    撤销
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(k)}
                  disabled={disabled}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-all hover:bg-white/5"
                  style={{ color: 'rgba(252, 165, 165, 0.9)' }}
                  title="彻底删除"
                >
                  <Trash2 size={12} />
                  删除
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <div>
                <div className="opacity-70">Key 前缀</div>
                <button
                  type="button"
                  onClick={() => copyPrefix(k.keyPrefix)}
                  className="inline-flex items-center gap-1 mt-0.5 font-mono"
                  style={{ color: 'var(--text-secondary)' }}
                  title="复制前缀（非完整 Key）"
                >
                  {k.keyPrefix}…
                  <Copy size={10} />
                </button>
              </div>
              <div>
                <div className="opacity-70">剩余有效期</div>
                <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{formatDaysLeft(k.daysLeft)}</div>
              </div>
              <div>
                <div className="opacity-70">最后使用</div>
                <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{formatDateTime(k.lastUsedAt)}</div>
              </div>
              <div>
                <div className="opacity-70">累计调用</div>
                <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{k.totalRequests} 次</div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              {k.scopes.map((s) => (
                <span
                  key={s}
                  className="px-2 py-0.5 rounded-full text-[10px] font-mono"
                  style={{
                    background: 'rgba(56, 189, 248, 0.12)',
                    color: 'rgba(186, 230, 253, 0.95)',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
