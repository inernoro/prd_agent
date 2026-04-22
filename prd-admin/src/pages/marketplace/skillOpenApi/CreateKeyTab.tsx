import { useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, Download, EyeOff, KeyRound, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { createAgentApiKey } from '@/services';
import {
  OFFICIAL_SKILL_FINDMAPSKILLS,
  downloadOfficialSkill,
  markOfficialSkillDownloaded,
  resolveOfficialSkillDownloadUrl,
} from './downloadOfficialSkill';

interface Props {
  /** 平台支持的 scope 白名单，来自 /api/agent-api-keys 的 allowedScopes */
  allowedScopes: string[];
  onCreated: () => Promise<void>;
  onBackToList: () => void;
  /**
   * 智能体接入模式 —— 由 StartTab 的「智能体接入」路径触发。开启后：
   * - 创建成功页的主 CTA 从「复制明文」变为「复制给智能体使用」
   * - 顶部用醒目说明引导用户粘贴给 AI
   */
  agentMode?: boolean;
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

export function CreateKeyTab({ allowedScopes, onCreated, onBackToList, agentMode = false }: Props) {
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

  /**
   * 「复制给智能体使用」提示词 —— 最小化 + 安全：
   *  1. 只告诉 AI 两件事：把 Key 存进 shell init 文件（不入仓库），下载 findmapskills 技能
   *  2. 剩下的操作全写在 SKILL.md 里，AI 装完读一下就会
   *
   * 安全考量：
   *  - 明确要求"不要把 Key 写进仓库代码或 git 追踪的文件"
   *  - 推荐用 ~/.zshrc / ~/.bashrc（gitignore 安全区）或 macOS Keychain / pass
   *  - 不使用 ~/.env 之类容易被 git commit 的文件
   */
  const buildAgentPrompt = (key: string) => {
    const skillUrl = resolveOfficialSkillDownloadUrl(OFFICIAL_SKILL_FINDMAPSKILLS);
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    return `请帮我接入 PrdAgent 海鲜市场（技能市场）。

① 把下面这对 Key 存到 ~/.zshrc 或 ~/.bashrc（或其他不会被 git 追踪的安全位置），然后 source 生效。不要写进仓库里任何文件：

export PRD_AGENT_API_KEY="${key}"
export PRD_AGENT_BASE="${base}"

② 下载官方操作技能 findmapskills 到 ~/.claude/skills/：

curl -L "${skillUrl}" -o /tmp/findmapskills.zip \\
 && mkdir -p ~/.claude/skills && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/ \\
 && rm /tmp/findmapskills.zip

③ 读一下 ~/.claude/skills/findmapskills/SKILL.md —— 里面有海鲜市场全部操作（搜索 / 下载 / 上传 / 订阅 / Key 过期处理），后续我说"找个做 X 的技能"或"把这个上传到市场"都按那份文档操作即可。
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
      await downloadOfficialSkill(OFFICIAL_SKILL_FINDMAPSKILLS);
      markOfficialSkillDownloaded();
      toast.success('已下载 findmapskills.zip');
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
        {/* 智能体模式：顶部引导用户直接复制给 AI */}
        {agentMode && (
          <div
            className="rounded-xl px-4 py-3 flex items-start gap-3"
            style={{
              background:
                'linear-gradient(135deg, rgba(129, 140, 248, 0.18) 0%, rgba(56, 189, 248, 0.1) 100%)',
              border: '1px solid rgba(129, 140, 248, 0.45)',
            }}
          >
            <Bot size={18} style={{ color: 'rgba(221, 214, 254, 1)' }} className="mt-0.5 shrink-0" />
            <div className="text-xs leading-relaxed" style={{ color: 'rgba(224, 231, 255, 0.95)' }}>
              <div className="font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>
                Key 已生成 —— 下一步：复制给智能体使用
              </div>
              <div className="opacity-90">
                点下方紫色按钮复制完整指令，粘贴到 Claude Code / Cursor 即可。AI 会自己
                <code className="font-mono mx-0.5">export</code>
                环境变量、下载解压技能包、跑一次验证 curl。
              </div>
            </div>
          </div>
        )}

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

        {/* 按钮顺序 —— 智能体模式下「复制给智能体」提前为主 CTA；
            手动模式下保持原来的「复制明文」为主 */}
        <div className="flex items-center gap-2 flex-wrap">
          {agentMode ? (
            <>
              <Button variant="primary" size="sm" onClick={handleCopyAgentPrompt}>
                {copiedPrompt ? <Check size={13} /> : <Bot size={13} />}
                {copiedPrompt ? '已复制指令' : '复制给智能体使用'}
              </Button>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all hover:bg-white/5"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-secondary)',
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '只复制明文'}
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
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
          {agentMode ? (
            <>
              建议点<strong>「复制给智能体使用」</strong>，把整段指令粘贴给 Claude Code / Cursor —— AI 会自己配置环境变量、下载解压官方技能包，立即接通。
            </>
          ) : (
            <>
              想让 AI 一键配置？点<strong>「复制给智能体使用」</strong>即可，AI 会自己
              <code className="font-mono mx-0.5">export</code> 环境变量 + 下载解压技能包。
            </>
          )}
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
