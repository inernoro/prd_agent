import { useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, Download, EyeOff, Play, Sparkles, Video } from 'lucide-react';
import { toast } from '@/lib/toast';
import { createAgentApiKey } from '@/services';
import { useDemoVideoUrl } from '@/stores/homepageAssetsStore';
import {
  OFFICIAL_SKILL_FINDMAPSKILLS,
  downloadOfficialSkill,
  resolveOfficialSkillDownloadUrl,
} from './downloadOfficialSkill';

/** 演示视频 slot id —— 必须与 homepageAssetSlots.ts 中的 DEMO_VIDEO_SLOTS 登记一致 */
const DEMO_VIDEO_ID = 'skill-openapi.agent-paste';

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

const SCOPE_META: Record<string, { title: string; desc: string; icon: string }> = {
  'marketplace.skills:read': {
    title: '浏览 & 下载技能',
    desc: '查询市场、拉详情、fork 下载 zip',
    icon: '📥',
  },
  'marketplace.skills:write': {
    title: '上传技能',
    desc: '以你的身份发布 zip 技能包',
    icon: '📤',
  },
};

const TTL_OPTIONS = [
  { days: 365, label: '1 年（推荐）' },
  { days: 180, label: '6 个月' },
  { days: 90, label: '3 个月' },
  { days: 1095, label: '3 年（最长）' },
];

/**
 * 生成一个可读的随机 Key 名称：
 *   「接入 2026-04-21 14:32 · a1b2」
 * 用本地时间（用户能认得出来"哪天建的"）+ 4 位随机后缀（同分钟多个不重名）。
 */
function generateDefaultKeyName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `接入 ${yyyy}-${mm}-${dd} ${hh}:${mi} · ${suffix}`;
}

export function CreateKeyTab({ allowedScopes, onCreated, onBackToList, agentMode = false }: Props) {
  const [name, setName] = useState(() => generateDefaultKeyName());
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() => [
    ...allowedScopes.filter((s) => s === 'marketplace.skills:read'),
  ]);
  const [ttlDays, setTtlDays] = useState<number>(365);
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [downloadingSkill, setDownloadingSkill] = useState(false);
  const demoVideoUrl = useDemoVideoUrl(DEMO_VIDEO_ID);

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
      toast.success('已下载 findmapskills.zip');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloadingSkill(false);
    }
  };

  // ==== 明文展示态（创建成功后仅此一次） ====
  if (plaintext) {
    const primaryLabel = agentMode
      ? (copiedPrompt ? '已复制指令' : '复制给智能体使用')
      : (copied ? '已复制' : '复制明文');
    const primaryIcon = agentMode
      ? (copiedPrompt ? <Check size={14} /> : <Bot size={14} />)
      : (copied ? <Check size={14} /> : <Copy size={14} />);
    const primaryHandler = agentMode ? handleCopyAgentPrompt : handleCopy;
    const primaryActive = agentMode ? copiedPrompt : copied;

    const handleBackToList = () => {
      setPlaintext(null);
      setName(generateDefaultKeyName());
      onBackToList();
    };

    return (
      <div className="flex flex-col gap-4">
        {/* 一行标题 —— 替代原来紫色大说明框，降到最弱 */}
        <div className="flex items-start gap-2 px-0.5">
          <Check
            size={14}
            style={{ color: 'rgba(134, 239, 172, 1)' }}
            className="mt-0.5 shrink-0"
          />
          <div className="text-[12px] leading-snug" style={{ color: 'var(--text-primary)' }}>
            Key 已生成
            {agentMode && (
              <span style={{ color: 'var(--text-muted)' }}>
                ，下一步：<span style={{ color: 'rgba(186, 230, 253, 1)' }}>复制给智能体使用</span>
              </span>
            )}
          </div>
        </div>

        {/* 警告：保持，但字号 / 透明度更克制 */}
        <div
          className="rounded-xl px-3.5 py-2.5 flex items-start gap-2.5"
          style={{
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.28)',
          }}
        >
          <AlertTriangle
            size={14}
            style={{ color: 'rgba(253, 224, 71, 0.9)' }}
            className="mt-0.5 shrink-0"
          />
          <div className="text-[11px] leading-relaxed" style={{ color: 'rgba(254, 240, 138, 0.85)' }}>
            <strong className="font-medium">请立即保存明文 Key。</strong>
            这是唯一一次完整显示，离开此页面后只看得到前缀。
          </div>
        </div>

        {/* Key 明文 */}
        <div
          className="rounded-xl px-4 py-3.5 font-mono text-[13px] break-all select-all text-center"
          style={{
            background: 'rgba(0, 0, 0, 0.35)',
            border: '1px solid rgba(56, 189, 248, 0.22)',
            color: 'rgba(186, 230, 253, 1)',
            letterSpacing: '0.02em',
          }}
        >
          {plaintext}
        </div>

        {/* 演示视频 —— 在 Key 与主 CTA 之间给用户一个"接下来会发生什么"的可视化预览。
            已上传：embed 实际视频（autoplay muted loop）；
            未上传：显示简洁占位卡，提示管理员可以上传。不阻断流程。 */}
        {demoVideoUrl ? (
          <div
            className="rounded-xl overflow-hidden relative"
            style={{
              background: 'rgba(0, 0, 0, 0.35)',
              border: '1px solid rgba(56, 189, 248, 0.22)',
              boxShadow: '0 8px 24px -16px rgba(0, 0, 0, 0.5)',
            }}
          >
            <video
              src={demoVideoUrl}
              autoPlay
              muted
              loop
              playsInline
              controls={false}
              className="w-full block"
              style={{ aspectRatio: '16 / 9', objectFit: 'cover' }}
            />
            <div
              className="absolute top-2 left-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-medium backdrop-blur-md"
              style={{
                background: 'rgba(0, 0, 0, 0.4)',
                color: 'rgba(186, 230, 253, 0.95)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
              }}
            >
              <Play size={9} fill="currentColor" />
              演示：复制密钥粘贴给智能体
            </div>
          </div>
        ) : (
          <div
            className="rounded-xl px-4 py-3.5 flex items-center gap-3"
            style={{
              background: 'rgba(255, 255, 255, 0.025)',
              border: '1px dashed rgba(255, 255, 255, 0.14)',
            }}
          >
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: 'rgba(148, 163, 184, 0.1)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
              }}
            >
              <Video size={16} style={{ color: 'rgba(203, 213, 225, 0.9)' }} />
            </div>
            <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <div className="text-[11.5px] mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                演示视频待上传
              </div>
              管理员可前往「资源管理 → 演示视频 → 接入 AI · 粘贴密钥给智能体」上传录屏，之后这里会自动播放流程动画。
            </div>
          </div>
        )}

        {/* 主 CTA —— 整行唯一焦点，放大 + 高对比 */}
        <button
          type="button"
          onClick={primaryHandler}
          className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl text-[13px] font-semibold transition-all"
          style={{
            background: agentMode
              ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.85) 0%, rgba(99, 102, 241, 0.85) 100%)'
              : 'linear-gradient(135deg, rgba(56, 189, 248, 0.85) 0%, rgba(14, 165, 233, 0.85) 100%)',
            color: '#ffffff',
            border: '1px solid rgba(186, 230, 253, 0.35)',
            boxShadow:
              '0 10px 28px -14px rgba(56, 189, 248, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.18)',
            letterSpacing: '0.01em',
          }}
        >
          {primaryIcon}
          {primaryLabel}
        </button>

        {/* 次要操作一行 —— 文字链 + 小幽灵按钮，全部低调 */}
        <div
          className="flex items-center justify-center gap-4 text-[11px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {/* 另一个复制选项（次要文字链） */}
          <button
            type="button"
            onClick={agentMode ? handleCopy : handleCopyAgentPrompt}
            className="inline-flex items-center gap-1 hover:opacity-80 transition-opacity"
          >
            {agentMode ? (
              <>
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? '已复制明文' : '只复制明文'}
              </>
            ) : (
              <>
                {copiedPrompt ? <Check size={11} /> : <Bot size={11} />}
                {copiedPrompt ? '已复制指令' : '复制给智能体'}
              </>
            )}
          </button>

          <span aria-hidden style={{ opacity: 0.3 }}>·</span>

          <button
            type="button"
            onClick={handleDownloadSkillHere}
            disabled={downloadingSkill}
            className="inline-flex items-center gap-1 hover:opacity-80 transition-opacity"
          >
            <Download size={11} />
            {downloadingSkill ? '下载中…' : '下载 findmapskills 技能包'}
          </button>

          <span aria-hidden style={{ opacity: 0.3 }}>·</span>

          <button
            type="button"
            onClick={handleBackToList}
            className="inline-flex items-center gap-1 hover:opacity-80 transition-opacity"
          >
            <EyeOff size={11} />
            我已保存
          </button>
        </div>

        {/* 作用主 CTA 时才保留的指引脚注 —— 其他情况静默 */}
        {!primaryActive && (
          <div
            className="text-[10.5px] text-center mt-1"
            style={{ color: 'var(--text-muted)', opacity: 0.7 }}
          >
            {agentMode
              ? '点上方按钮后，粘贴到 Claude Code / Cursor，AI 会自己配置 + 下载技能包'
              : '想让 AI 一键配置？旁边的「复制给智能体」即可'}
          </div>
        )}
      </div>
    );
  }

  // ==== 表单态 ====
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            Key 名称
          </label>
          <button
            type="button"
            onClick={() => setName(generateDefaultKeyName())}
            className="text-[10px] hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
            title="换一个随机名称"
          >
            🎲 换一个
          </button>
        </div>
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
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            权限范围
          </label>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            * 必选
          </span>
        </div>
        {/* 2 列卡片选择器：紧凑可视、主次分明 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {allowedScopes.map((scope) => {
            const meta = SCOPE_META[scope] ?? { title: scope, desc: '', icon: '🔑' };
            const checked = selectedScopes.includes(scope);
            return (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                className="text-left rounded-xl p-3 transition-all relative"
                style={{
                  background: checked
                    ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.12) 0%, rgba(14, 165, 233, 0.06) 100%)'
                    : 'rgba(255, 255, 255, 0.03)',
                  border: `1px solid ${checked ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.08)'}`,
                  boxShadow: checked ? 'inset 0 1px 1px rgba(255, 255, 255, 0.05)' : 'none',
                }}
              >
                {/* 右上勾选指示器 */}
                <div
                  className="absolute top-2.5 right-2.5 w-4 h-4 rounded-full flex items-center justify-center transition-all"
                  style={{
                    background: checked ? 'rgba(56, 189, 248, 0.9)' : 'transparent',
                    border: `1px solid ${checked ? 'rgba(56, 189, 248, 1)' : 'rgba(255, 255, 255, 0.28)'}`,
                  }}
                >
                  {checked && <Check size={10} color="white" strokeWidth={3} />}
                </div>
                <div className="text-[18px] mb-1.5" aria-hidden>
                  {meta.icon}
                </div>
                <div className="text-[12.5px] font-semibold mb-0.5 pr-6" style={{ color: 'var(--text-primary)' }}>
                  {meta.title}
                </div>
                <div className="text-[10.5px] mb-1.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {meta.desc}
                </div>
                <div className="text-[10px] font-mono opacity-70" style={{ color: 'var(--text-muted)' }}>
                  {scope}
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

      <div className="flex flex-col items-stretch gap-2.5 pt-3">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl text-[13px] font-semibold transition-all"
          style={{
            background: creating
              ? 'rgba(56, 189, 248, 0.3)'
              : 'linear-gradient(135deg, rgba(56, 189, 248, 0.85) 0%, rgba(14, 165, 233, 0.85) 100%)',
            color: '#ffffff',
            border: '1px solid rgba(186, 230, 253, 0.35)',
            boxShadow:
              '0 10px 28px -14px rgba(56, 189, 248, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.18)',
            cursor: creating ? 'wait' : 'pointer',
            letterSpacing: '0.01em',
          }}
        >
          <Sparkles size={14} />
          {creating ? '正在创建…' : '创建 Key'}
        </button>
        <button
          type="button"
          onClick={onBackToList}
          className="text-[11px] text-center hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          返回列表
        </button>
      </div>
    </div>
  );
}
