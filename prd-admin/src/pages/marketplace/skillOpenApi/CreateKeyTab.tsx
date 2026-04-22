import { useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, Download, EyeOff, KeyRound, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { createAgentApiKey } from '@/services';
import {
  OFFICIAL_SKILL_MARKETPLACE_OPENAPI,
  downloadOfficialSkill,
  markOfficialSkillDownloaded,
} from './downloadOfficialSkill';

interface Props {
  /** 平台支持的 scope 白名单，来自 /api/agent-api-keys 的 allowedScopes */
  allowedScopes: string[];
  onCreated: () => Promise<void>;
  onBackToList: () => void;
}

const SCOPE_META: Record<string, { title: string; desc: string }> = {
  'marketplace.skills:read': {
    title: '浏览 & 下载技能',
    desc: '允许 AI 查询海鲜市场技能列表、拉取详情、触发 fork 下载 zip（等价于"拿来吧"）。',
  },
  'marketplace.skills:write': {
    title: '上传技能',
    desc: '允许 AI 以你的身份向海鲜市场上传新的 zip 技能包。上传的技能会默认公开，作者归属你。',
  },
};

const TTL_OPTIONS = [
  { days: 365, label: '1 年（推荐）' },
  { days: 180, label: '6 个月' },
  { days: 90, label: '3 个月' },
  { days: 1095, label: '3 年（最长）' },
];

export function CreateKeyTab({ allowedScopes, onCreated, onBackToList }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() => [
    ...allowedScopes.filter((s) => s === 'marketplace.skills:read'),
  ]);
  const [ttlDays, setTtlDays] = useState<number>(365);
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [downloadingSkill, setDownloadingSkill] = useState(false);

  // 构造"复制给智能体"的提示词 —— 让 AI 自己导入环境变量 + 安装技能包
  const buildAgentPrompt = (key: string) => {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://your-platform.example.com';
    const skillUrl = `${base}/api/official-skills/marketplace-openapi/download`;
    return `我刚在 PrdAgent 海鲜市场生成了一个开放接口 API Key，请帮我把它配置好，之后你就能浏览/下载/上传这个平台的技能包。

--- 步骤 1：设置环境变量 ---
请在当前 shell 里执行：

export PRD_AGENT_API_KEY="${key}"
export PRD_AGENT_BASE="${base}"

并把这两行写进 ~/.zshrc 或 ~/.bashrc，让后续 session 也能用。

--- 步骤 2：安装官方客户端技能包 ---
下载并解压官方技能包到 ~/.claude/skills/：

curl -L -o /tmp/marketplace-openapi.zip "${skillUrl}"
mkdir -p ~/.claude/skills
unzip -o /tmp/marketplace-openapi.zip -d ~/.claude/skills/
rm /tmp/marketplace-openapi.zip

--- 步骤 3：验证接通 ---
执行这条命令看看是否能拿到技能列表：

curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?sort=hot&limit=5" \\
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" | head -c 500

如果返回 JSON 里有 success:true 就接好了。

--- 注意事项 ---
- 这个 Key 默认 1 年有效期，到期前 30 天响应头会提示续期，
  请记得去 ${base}/marketplace 页面 → 右上角「接入 AI」→ 点"续期一年"。
- Key 明文只有这一次机会保存，不要发到公开仓库 / 截图里。
- 所有调用方式见下载的 SKILL.md，直接读它即可。
`;
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('请给 Key 起个名字，方便以后区分');
      return;
    }
    if (selectedScopes.length === 0) {
      toast.error('至少勾选一个权限范围');
      return;
    }
    setCreating(true);
    try {
      const res = await createAgentApiKey({
        name: name.trim(),
        description: description.trim() || undefined,
        scopes: selectedScopes,
        ttlDays,
      });
      if (res.success && res.data?.apiKey) {
        setPlaintext(res.data.apiKey);
        toast.success('Key 创建成功，务必现在保存明文');
        await onCreated();
      } else {
        toast.error(res.error?.message ?? '创建失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      toast.success('已复制 API Key 明文');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动选中');
    }
  };

  const handleCopyAgentPrompt = async () => {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(buildAgentPrompt(plaintext));
      setCopiedPrompt(true);
      toast.success('已复制智能体指令 —— 粘贴到 Claude Code / Cursor 让它自动配置');
      setTimeout(() => setCopiedPrompt(false), 2500);
    } catch {
      toast.error('复制失败，请手动选中');
    }
  };

  const handleDownloadSkillHere = async () => {
    setDownloadingSkill(true);
    try {
      await downloadOfficialSkill(OFFICIAL_SKILL_MARKETPLACE_OPENAPI);
      markOfficialSkillDownloaded();
      toast.success('已下载 marketplace-openapi.zip');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloadingSkill(false);
    }
  };

  // ==== 明文展示态（创建成功后仅此一次） ====
  if (plaintext) {
    return (
      <div className="flex flex-col gap-4">
        <div
          className="rounded-xl px-4 py-3 flex items-start gap-3"
          style={{
            background: 'rgba(234, 179, 8, 0.12)',
            border: '1px solid rgba(234, 179, 8, 0.4)',
          }}
        >
          <AlertTriangle size={18} style={{ color: 'rgba(253, 224, 71, 1)' }} className="mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed" style={{ color: 'rgba(254, 240, 138, 0.95)' }}>
            <div className="font-medium mb-0.5">请立即保存明文 Key</div>
            <div className="opacity-90">
              这是此 Key 唯一一次完整显示。离开此页面后只能看到前缀。丢了就得撤销重建（调用方也要更新）。
            </div>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-4 font-mono text-sm break-all select-all"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(56, 189, 248, 0.3)',
            color: 'rgba(186, 230, 253, 1)',
          }}
        >
          {plaintext}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" size="sm" onClick={handleCopy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制明文'}
          </Button>
          <button
            type="button"
            onClick={handleCopyAgentPrompt}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background: 'rgba(129, 140, 248, 0.18)',
              border: '1px solid rgba(129, 140, 248, 0.45)',
              color: 'rgba(221, 214, 254, 1)',
            }}
            title="复制一段提示词，粘贴给 Claude Code / Cursor，AI 会自己 export 环境变量 + 下载技能包"
          >
            {copiedPrompt ? <Check size={12} /> : <Bot size={12} />}
            {copiedPrompt ? '已复制指令' : '复制给智能体使用'}
          </button>
          <button
            type="button"
            onClick={handleDownloadSkillHere}
            disabled={downloadingSkill}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all"
            style={{
              background: 'rgba(56, 189, 248, 0.14)',
              border: '1px solid rgba(56, 189, 248, 0.35)',
              color: 'rgba(186, 230, 253, 1)',
            }}
          >
            <Download size={12} />
            {downloadingSkill ? '下载中…' : '下载技能包'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaintext(null);
              setName('');
              setDescription('');
              onBackToList();
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:bg-white/5"
            style={{ color: 'var(--text-muted)' }}
          >
            <EyeOff size={12} />
            我已保存，返回列表
          </button>
        </div>

        <div className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          建议直接点<strong>「复制给智能体使用」</strong>，把一整段指令粘贴给 Claude Code / Cursor —— AI 会自己
          <code className="font-mono mx-0.5">export</code> 环境变量、下载并解压官方技能包，
          然后立刻就能帮你调用海鲜市场的开放接口。
        </div>
      </div>
    );
  }

  // ==== 表单态 ====
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
          Key 名称
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 60))}
          placeholder="例：Cursor 工作站 / 我的 Claude Code"
          className="w-full h-9 px-3 rounded-lg text-sm"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      <div>
        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
          备注（可选）
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 120))}
          placeholder="用途、调用方来源等"
          className="w-full h-9 px-3 rounded-lg text-sm"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            权限范围
          </label>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            * 必选
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {allowedScopes.map((scope) => {
            const meta = SCOPE_META[scope] ?? { title: scope, desc: '' };
            const checked = selectedScopes.includes(scope);
            return (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                className="text-left rounded-xl px-3 py-2.5 transition-all"
                style={{
                  background: checked ? 'rgba(56, 189, 248, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                  border: `1px solid ${checked ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.08)'}`,
                }}
              >
                <div className="flex items-start gap-2.5">
                  <div
                    className="mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0"
                    style={{
                      background: checked ? 'rgba(56, 189, 248, 0.8)' : 'transparent',
                      border: `1px solid ${checked ? 'rgba(56, 189, 248, 1)' : 'rgba(255, 255, 255, 0.3)'}`,
                    }}
                  >
                    {checked && <Check size={11} color="white" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {meta.title}
                      </span>
                      <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                        {scope}
                      </span>
                    </div>
                    {meta.desc && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {meta.desc}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
          有效期
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {TTL_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setTtlDays(opt.days)}
              className="px-3 py-1.5 rounded-lg text-xs transition-all"
              style={{
                background: ttlDays === opt.days ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${ttlDays === opt.days ? 'rgba(56, 189, 248, 0.45)' : 'rgba(255, 255, 255, 0.1)'}`,
                color: ttlDays === opt.days ? 'rgba(186, 230, 253, 1)' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
          到期前 30 天 UI 会提醒你续期；过期后有 7 天宽限期仍可调用（并在响应头提示）；超过宽限期才 403。
          不会动不动就 403 —— 你可以在列表里一键"续期一年"。
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button variant="primary" size="sm" onClick={handleCreate} disabled={creating}>
          <Sparkles size={13} />
          {creating ? '正在创建…' : '创建 Key'}
        </Button>
        <button
          type="button"
          onClick={onBackToList}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:bg-white/5"
          style={{ color: 'var(--text-muted)' }}
        >
          <KeyRound size={12} />
          返回列表
        </button>
      </div>
    </div>
  );
}
