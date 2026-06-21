import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  BookOpen,
  Check,
  Copy,
  Dices,
  Download,
  EyeOff,
  KeyRound,
  Play,
  Sparkles,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react';
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
  /**
   * 预选 scope —— 由不同入口（如知识库页面）传入希望默认勾选的权限范围。
   * 会与 allowedScopes 取交集，避免预选一个平台未开放的 scope。
   * 缺省时回退为「marketplace.skills:read」（海鲜市场默认行为不变）。
   */
  presetScopes?: string[];
}

/** scope → 友好标签 + lucide 图标（禁止 emoji，见 CLAUDE.md 规则 #0） */
const SCOPE_META: Record<string, { title: string; desc: string; icon: LucideIcon }> = {
  'marketplace.skills:read': {
    title: '浏览 & 下载技能',
    desc: '查询市场、拉详情、fork 下载 zip',
    icon: Download,
  },
  'marketplace.skills:write': {
    title: '上传技能',
    desc: '以你的身份发布 zip 技能包',
    icon: Upload,
  },
  'document-store:read': {
    title: '读取文档空间',
    desc: '列出知识库、读取文章内容',
    icon: BookOpen,
  },
  'document-store:write': {
    title: '写入文档空间',
    desc: '以你的身份创建知识库、上传 / 更新文章',
    icon: Upload,
  },
};

const TTL_OPTIONS = [
  { days: 365, label: '1 年（推荐）' },
  { days: 180, label: '6 个月' },
  { days: 90, label: '3 个月' },
  { days: 1095, label: '3 年（最长）' },
];

const FIELD_CLASS = 'prd-field h-9 w-full rounded-lg px-3 text-sm focus:outline-none';

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

export function CreateKeyTab({
  allowedScopes,
  onCreated,
  onBackToList,
  agentMode = false,
  presetScopes,
}: Props) {
  const [name, setName] = useState(() => generateDefaultKeyName());
  // 预选项与平台白名单取交集，避免勾选一个后端未开放的 scope。
  const computeSeed = (allowed: string[], preset?: string[]): string[] => {
    const wanted = preset && preset.length > 0 ? preset : ['marketplace.skills:read'];
    return allowed.filter((s) => wanted.includes(s));
  };
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
    computeSeed(allowedScopes, presetScopes),
  );
  // 弹窗常在 allowedScopes 仍是海鲜市场默认值时就先渲染本表单，待 listAgentApiKeys
  // 回来才补齐 document-store 等 scope。初始化器只跑一次会拿到陈旧白名单 → 预选落空，
  // 知识库「接入 AI」一键创建会因没勾选而失败。故在 allowedScopes/presetScopes 变化时
  // 重新播种；userEditedRef 守卫保证一旦用户手动勾选过就不再覆盖其选择（修复 PR #865
  // Codex P2「Seed preset scopes after allowed scopes load」）。
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (userEditedRef.current) return;
    setSelectedScopes(computeSeed(allowedScopes, presetScopes));
  }, [allowedScopes, presetScopes]);
  const [ttlDays, setTtlDays] = useState<number>(365);
  const [creating, setCreating] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [downloadingSkill, setDownloadingSkill] = useState(false);
  const demoVideoUrl = useDemoVideoUrl(DEMO_VIDEO_ID);

  // 本 Key 实际包含哪类 scope —— 决定给智能体的指令走"海鲜市场"还是"文档空间"。
  // 知识库「接入 AI」签发的是 document-store-only Key，若仍发海鲜市场提示词 +
  // 装 findmapskills（只覆盖 marketplace.skills:* 端点），AI 照做会 403 或拿不到
  // 任何文档空间工作流（修复 PR #865 Codex P2「Provide document-store agent instructions」）。
  const hasMarketplaceScope = selectedScopes.some((s) => s.startsWith('marketplace.skills'));
  const hasDocStoreScope = selectedScopes.some((s) => s.startsWith('document-store'));

  /**
   * 「复制给智能体使用」提示词 —— 按 Key 的真实 scope 出对应指令，最小化 + 安全：
   *  - 含 marketplace.skills → 海鲜市场提示词 + 下载 findmapskills 技能
   *  - 仅 document-store → 文档空间 API 提示词（真实端点，不装 marketplace 技能）
   *
   * 安全考量：
   *  - 明确要求"不要把 Key 写进仓库代码或 git 追踪的文件"
   *  - 推荐用 ~/.zshrc / ~/.bashrc（gitignore 安全区）或 macOS Keychain / pass
   *  - 不使用 ~/.env 之类容易被 git commit 的文件
   */
  const buildAgentPrompt = (key: string) => {
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    const keyBlock = `① 把下面这对 Key 存到 ~/.zshrc 或 ~/.bashrc（或其他不会被 git 追踪的安全位置），然后 source 生效。不要写进仓库里任何文件：

export PRD_AGENT_API_KEY="${key}"
export PRD_AGENT_BASE="${base}"`;

    // 仅文档空间权限（无 marketplace）→ 文档空间 API 指令，不引用 findmapskills。
    if (hasDocStoreScope && !hasMarketplaceScope) {
      return `请帮我接入 PrdAgent 知识库（文档空间）开放接口。

${keyBlock}

② 调用文档空间 API（统一带请求头 Authorization: Bearer $PRD_AGENT_API_KEY）：
- 列出我的知识库：GET  $PRD_AGENT_BASE/api/document-store/stores
- 读取某篇文章：  GET  $PRD_AGENT_BASE/api/document-store/entries/{entryId}
- 新建知识库：    POST $PRD_AGENT_BASE/api/document-store/stores
- 在知识库下新增文章：POST $PRD_AGENT_BASE/api/document-store/stores/{storeId}/entries
- 更新文章正文：  PUT  $PRD_AGENT_BASE/api/document-store/entries/{entryId}/content

后续我说"把这份内容存进我的知识库"或"读一下我某个知识库的文章"，按上面的接口操作即可。
`;
    }

    // 含海鲜市场权限 → 海鲜市场提示词 + findmapskills 技能。
    const skillUrl = resolveOfficialSkillDownloadUrl(OFFICIAL_SKILL_FINDMAPSKILLS);
    return `请帮我接入 PrdAgent 海鲜市场（技能市场）。

${keyBlock}

② 下载官方操作技能 findmapskills 到 ~/.claude/skills/：

curl -L "${skillUrl}" -o /tmp/findmapskills.zip \\
 && mkdir -p ~/.claude/skills && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/ \\
 && rm /tmp/findmapskills.zip

③ 读一下 ~/.claude/skills/findmapskills/SKILL.md —— 里面有海鲜市场全部操作（搜索 / 下载 / 上传 / 订阅 / Key 过期处理），后续我说"找个做 X 的技能"或"把这个上传到市场"都按那份文档操作即可。
`;
  };

  const toggleScope = (scope: string) => {
    userEditedRef.current = true;
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
            className="mt-0.5 shrink-0 text-token-success"
          />
          <div className="text-[12px] leading-snug text-token-primary">
            Key 已生成
            {agentMode && (
              <span className="text-token-muted">
                ，下一步：<span className="text-token-accent">复制给智能体使用</span>
              </span>
            )}
          </div>
        </div>

        {/* 警告：保持，但字号 / 透明度更克制 */}
        <div className="surface-state-warning flex items-start gap-2.5 rounded-xl px-3.5 py-2.5">
          <AlertTriangle
            size={14}
            className="mt-0.5 shrink-0"
          />
          <div className="text-[11px] leading-relaxed">
            <strong className="font-medium">请立即保存明文 Key。</strong>
            这是唯一一次完整显示，离开此页面后只看得到前缀。
          </div>
        </div>

        {/* Key 明文 */}
        <div
          className="surface-code break-all rounded-xl px-4 py-3.5 text-center font-mono text-[13px] text-token-accent"
          style={{
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
            className="surface-code relative overflow-hidden rounded-xl"
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
            <div className="surface-action-accent absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium backdrop-blur-md">
              <Play size={9} fill="currentColor" />
              演示：复制密钥粘贴给智能体
            </div>
          </div>
        ) : (
          <div className="surface-inset flex items-center gap-3 rounded-xl border-dashed px-4 py-3.5">
            <div className="surface-action flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
              <Video size={16} />
            </div>
            <div className="text-[10.5px] leading-relaxed text-token-muted">
              <div className="mb-0.5 text-[11.5px] text-token-secondary">
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
          className="surface-action-primary inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-semibold tracking-[0.01em] transition-all"
          data-agent={agentMode}
        >
          {primaryIcon}
          {primaryLabel}
        </button>

        {/* 次要操作一行 —— 文字链 + 小幽灵按钮，全部低调 */}
        <div
          className="flex items-center justify-center gap-4 text-[11px] text-token-muted"
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

          {/* findmapskills 只覆盖海鲜市场端点 —— 仅含 marketplace.skills scope 的 Key
              才提供下载，文档空间专用 Key 不引导装这个无关技能（见 buildAgentPrompt）。 */}
          {hasMarketplaceScope && (
            <>
              <span aria-hidden className="opacity-30">·</span>

              <button
                type="button"
                onClick={handleDownloadSkillHere}
                disabled={downloadingSkill}
                className="inline-flex items-center gap-1 hover:opacity-80 transition-opacity"
              >
                <Download size={11} />
                {downloadingSkill ? '下载中…' : '下载 findmapskills 技能包'}
              </button>
            </>
          )}

          <span aria-hidden className="opacity-30">·</span>

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
          <div className="mt-1 text-center text-[10.5px] text-token-muted opacity-70">
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
          <label className="text-xs font-medium text-token-secondary">
            Key 名称
          </label>
          <button
            type="button"
            onClick={() => setName(generateDefaultKeyName())}
            className="inline-flex items-center gap-1 text-[10px] text-token-muted transition-opacity hover:opacity-80"
            title="换一个随机名称"
          >
            <Dices size={11} />
            换一个
          </button>
        </div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 60))}
          placeholder="例：Cursor 工作站 / 我的 Claude Code"
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <label className="text-xs font-medium text-token-secondary">
            权限范围
          </label>
          <span className="text-[10px] text-token-muted">
            * 必选
          </span>
        </div>
        {/* 2 列卡片选择器：紧凑可视、主次分明 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {allowedScopes.map((scope) => {
            const meta = SCOPE_META[scope] ?? { title: scope, desc: '', icon: KeyRound };
            const ScopeIcon = meta.icon;
            const checked = selectedScopes.includes(scope);
            return (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                className={`relative rounded-xl p-3 text-left transition-all ${
                  checked ? 'surface-action-accent' : 'surface-inset'
                }`}
              >
                {/* 右上勾选指示器 */}
                <div
                  className={`absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full transition-all ${
                    checked ? 'surface-action-primary' : 'surface-action'
                  }`}
                >
                  {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                </div>
                <div className="mb-1.5 text-token-secondary" aria-hidden>
                  <ScopeIcon size={18} />
                </div>
                <div className="mb-0.5 pr-6 text-[12.5px] font-semibold text-token-primary">
                  {meta.title}
                </div>
                <div className="mb-1.5 text-[10.5px] leading-snug text-token-muted">
                  {meta.desc}
                </div>
                <div className="font-mono text-[10px] text-token-muted opacity-70">
                  {scope}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-token-secondary">
          有效期
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {TTL_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setTtlDays(opt.days)}
              className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                ttlDays === opt.days ? 'surface-action-accent' : 'surface-action hover:text-token-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="mt-1.5 text-[11px] text-token-muted">
          到期前 30 天 UI 会提醒你续期；过期后有 7 天宽限期仍可调用（并在响应头提示）；超过宽限期才 403。
          不会动不动就 403 —— 你可以在列表里一键"续期一年"。
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-2.5 pt-3">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="surface-action-primary inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-semibold tracking-[0.01em] transition-all"
        >
          <Sparkles size={14} />
          {creating ? '正在创建…' : '创建 Key'}
        </button>
        <button
          type="button"
          onClick={onBackToList}
          className="text-center text-[11px] text-token-muted transition-opacity hover:opacity-80"
        >
          返回列表
        </button>
      </div>
    </div>
  );
}
