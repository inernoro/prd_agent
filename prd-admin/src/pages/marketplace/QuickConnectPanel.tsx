import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { createAgentApiKey, listAgentApiKeys } from '@/services';
import type { AgentApiKeyDto } from '@/services/contracts/agentApiKeys';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  OFFICIAL_SKILL_FINDMAPSKILLS,
  resolveOfficialSkillDownloadUrl,
} from './skillOpenApi/downloadOfficialSkill';

interface Props {
  onClose: () => void;
  onOpenFullDialog: () => void;
}

function generateDefaultKeyName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `快速接入 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${suffix}`;
}

function buildAgentPrompt(key: string): string {
  const skillUrl = resolveOfficialSkillDownloadUrl(OFFICIAL_SKILL_FINDMAPSKILLS);
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `请帮我接入 PrdAgent 海鲜市场（技能市场）。

① 把下面这对 Key 存到 ~/.zshrc 或 ~/.bashrc，然后 source 生效。不要写进仓库：

export PRD_AGENT_API_KEY="${key}"
export PRD_AGENT_BASE="${base}"

② 下载官方操作技能 findmapskills 到 ~/.claude/skills/：

curl -L "${skillUrl}" -o /tmp/findmapskills.zip \\
 && mkdir -p ~/.claude/skills && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/ \\
 && rm /tmp/findmapskills.zip

③ 读一下 ~/.claude/skills/findmapskills/SKILL.md —— 里面有全部操作说明（搜索 / 下载 / 上传 / 订阅）。`;
}

export function QuickConnectPanel({ onClose, onOpenFullDialog }: Props) {
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<AgentApiKeyDto[]>([]);
  const [allowedScopes, setAllowedScopes] = useState<string[]>(['marketplace.skills:read']);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadKeys();
  }, []);

  const loadKeys = async () => {
    setLoading(true);
    try {
      const res = await listAgentApiKeys();
      if (res.success && res.data) {
        setKeys(res.data.items ?? []);
        if (res.data.allowedScopes && res.data.allowedScopes.length > 0) {
          setAllowedScopes(res.data.allowedScopes);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleQuickCreate = async () => {
    setCreating(true);
    try {
      const defaultScope = allowedScopes.find((s) => s === 'marketplace.skills:read')
        ?? allowedScopes[0];
      const res = await createAgentApiKey({
        name: generateDefaultKeyName(),
        scopes: defaultScope ? [defaultScope] : ['marketplace.skills:read'],
        ttlDays: 365,
      });
      if (res.success && res.data) {
        setCreatedKey(res.data.apiKey);
        await loadKeys();
        toast.success('API Key 已生成');
      } else {
        toast.error(res.error?.message ?? '生成失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCopyAgentPrompt = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(buildAgentPrompt(createdKey));
      setCopied(true);
      toast.success('已复制，粘贴给 AI 即可完成接入');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error('复制失败');
    }
  };

  const activeKeys = keys.filter(
    (k) => k.status === 'active' || k.status === 'expiring-soon',
  );

  return (
    <div className="mkt-qc-panel">
      {/* Header row */}
      <div className="mkt-qc-header">
        <span className="mkt-qc-title">
          <KeyRound size={13} />
          快速接入 AI
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onOpenFullDialog} className="mkt-qc-advanced-link">
            高级设置
            <ExternalLink size={10} />
          </button>
          <button type="button" onClick={onClose} className="mkt-qc-close" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="mkt-qc-body">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-token-muted">
            <MapSpinner size={13} />
            检查已有 Key…
          </div>
        ) : createdKey ? (
          /* ── Step 2: Key created ── */
          <div className="mkt-qc-created">
            <div className="mkt-qc-key-row">
              <code className="mkt-qc-key-preview">{createdKey.slice(0, 22)}…</code>
              <span className="mkt-qc-key-warning">仅此一次可见</span>
            </div>
            <button
              type="button"
              onClick={handleCopyAgentPrompt}
              className="mkt-qc-copy-primary"
              data-copied={copied ? 'true' : 'false'}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制！粘贴给 AI 即可' : '复制给 AI 使用（一键接入）'}
            </button>
          </div>
        ) : activeKeys.length > 0 ? (
          /* ── Has existing key ── */
          <div className="mkt-qc-existing">
            <div className="mkt-qc-existing-info">
              <KeyRound size={12} className="opacity-60 flex-shrink-0" />
              <span>已有 {activeKeys.length} 个有效 Key</span>
              <code className="mkt-qc-existing-prefix">{activeKeys[0].keyPrefix}…</code>
            </div>
            <button
              type="button"
              onClick={handleQuickCreate}
              disabled={creating}
              className="mkt-qc-create-btn"
            >
              {creating ? <MapSpinner size={12} /> : <KeyRound size={12} />}
              再生成一个
            </button>
          </div>
        ) : (
          /* ── No keys yet ── */
          <div className="mkt-qc-nocreate">
            <span className="mkt-qc-desc">
              一键生成 API Key，让 Claude Code / Cursor 等 AI 直接搜索和下载技能包
            </span>
            <button
              type="button"
              onClick={handleQuickCreate}
              disabled={creating}
              className="mkt-qc-create-primary"
            >
              {creating ? <MapSpinner size={13} /> : <KeyRound size={13} />}
              {creating ? '正在生成…' : '一键生成'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
