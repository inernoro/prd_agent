import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Book,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Dices,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { createAgentApiKey, listAgentApiKeys } from '@/services';
import type { AgentApiKeyDto } from '@/services/contracts/agentApiKeys';
import { buildDocStoreAgentPrompt } from '@/lib/agentAccessPrompts';
import { GuideTab } from '@/pages/marketplace/skillOpenApi/GuideTab';
import { KeysListTab } from '@/pages/marketplace/skillOpenApi/KeysListTab';

/**
 * 知识库「接入 AI」一屏弹窗（2026-07 重设计）。
 *
 * 用户心智：来这里的人只想回答"让我的 AI 能对知识库做什么"。所以整屏收敛为
 * 一个问题（只读 / 可读可写）+ 一颗按钮（生成 Key 并复制智能体指令），其余全给默认：
 *  - 名称自动生成（一行可编辑文本）
 *  - 有效期默认 1 年（三枚胶囊）
 *  - 与知识库无关的 scope（marketplace / defect / open-api）收进「更多权限」折叠
 *  - 右栏常驻「接下来三步」预演，创建成功后原位打勾（预期管理，不换屏）
 *  - 「我的 Key / 使用指南」是回访路径，降权为头部文字链（内部视图，复用海鲜市场组件）
 *
 * 海鲜市场入口的 SkillOpenApiDialog 保持不动；本组件只服务知识库场景。
 * 遵守 `.claude/rules/frontend-modal.md`：createPortal + inline maxHeight + min-h-0 滚动。
 */

interface Props {
  onClose: () => void;
}

type View = 'issue' | 'keys' | 'guide';
type Permission = 'rw' | 'ro';
type Phase = 'form' | 'done';

const SCOPE_READ = 'document-store:read';
const SCOPE_WRITE = 'document-store:write';

/** 折叠区里非知识库 scope 的友好标签（缺省回退原始 scope 码） */
const EXTRA_SCOPE_LABELS: Record<string, string> = {
  'marketplace.skills:read': '浏览 & 下载技能',
  'marketplace.skills:write': '上传技能',
  'defect-agent:use': '缺陷管理',
  'defect-agent:share': '缺陷分享',
  'open-api:call': '开放接口调用',
};

/** 可读的默认 Key 名称：「知识库接入 07-16 · a1b2」 */
function generateDefaultKeyName(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `知识库接入 ${mm}-${dd} · ${suffix}`;
}

const TTL_OPTIONS = [
  { days: 365, label: '1 年' },
  { days: 180, label: '6 个月' },
  { days: 1095, label: '3 年' },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ConnectAiDialog({ onClose }: Props) {
  const [view, setView] = useState<View>('issue');
  const [keys, setKeys] = useState<AgentApiKeyDto[]>([]);
  const [allowedScopes, setAllowedScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // 签发表单
  const [permission, setPermission] = useState<Permission>('rw');
  const [name, setName] = useState(() => generateDefaultKeyName());
  const [ttlDays, setTtlDays] = useState<number>(365);
  const [advOpen, setAdvOpen] = useState(false);
  const [extraScopes, setExtraScopes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // 成功态
  const [phase, setPhase] = useState<Phase>('form');
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [createdSummary, setCreatedSummary] = useState('');
  /** 主指令是否已成功进过剪贴板（决定 CTA 文案与第 1 步勾选后的引导） */
  const [promptCopied, setPromptCopied] = useState(false);
  const [plainCopied, setPlainCopied] = useState(false);

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

  /** 折叠区展示的非知识库 scope（跟随平台白名单，不硬编码全集） */
  const extraScopeOptions = useMemo(
    () => allowedScopes.filter((s) => !s.startsWith('document-store')),
    [allowedScopes],
  );

  const wantedDocScopes = permission === 'rw' ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];

  const scopeHint = useMemo(() => {
    const parts = [permission === 'rw' ? 'document-store:read + write' : 'document-store:read'];
    if (extraScopes.length > 0) parts.push(`+${extraScopes.length} 项`);
    return `${parts.join(' ')} · ${ttlDays}d`;
  }, [permission, extraScopes, ttlDays]);

  const toggleExtraScope = (scope: string) => {
    setExtraScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const permLabel = permission === 'rw' ? '可读可写' : '只读';
  const ttlLabel = TTL_OPTIONS.find((t) => t.days === ttlDays)?.label ?? `${ttlDays} 天`;

  /**
   * 一步到底：创建 Key + 把智能体指令（或裸 Key）复制进剪贴板。
   * 自动复制失败不阻断——成功态里 CTA 会退化成"复制智能体指令"再点一次。
   */
  const handleCreate = async (withPrompt: boolean) => {
    if (creating) return;
    const docScopes = wantedDocScopes.filter((s) => allowedScopes.includes(s));
    if (docScopes.length === 0) {
      toast.error(loading ? '权限列表加载中，请稍候再试' : '平台未开放文档空间权限，请联系管理员');
      return;
    }
    const finalName = name.trim() || generateDefaultKeyName();
    setCreating(true);
    try {
      const res = await createAgentApiKey({
        name: finalName,
        scopes: [...docScopes, ...extraScopes.filter((s) => allowedScopes.includes(s))],
        ttlDays,
      });
      if (!res.success || !res.data?.apiKey) {
        toast.error(res.error?.message ?? '创建失败');
        return;
      }
      const key = res.data.apiKey;
      setPlaintext(key);
      setCreatedSummary(`${finalName} · ${permLabel} · ${ttlLabel}`);
      setPhase('done');
      void refresh();
      const ok = await copyText(
        withPrompt ? buildDocStoreAgentPrompt(key, { writable: permission === 'rw' }) : key,
      );
      if (withPrompt) {
        setPromptCopied(ok);
        if (ok) toast.success('指令已复制 —— 粘贴到 Claude Code / Cursor 即可');
        else toast.error('Key 已生成，但自动复制失败，请点击"复制智能体指令"');
      } else {
        setPlainCopied(ok);
        if (ok) toast.success('Key 已生成并复制明文');
        else toast.error('Key 已生成，但自动复制失败，请手动复制');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCopyPrompt = async () => {
    if (!plaintext) return;
    const ok = await copyText(buildDocStoreAgentPrompt(plaintext, { writable: permission === 'rw' }));
    setPromptCopied(ok);
    if (ok) toast.success('已复制智能体指令');
    else toast.error('复制失败，请手动选中 Key');
  };

  const handleCopyPlain = async () => {
    if (!plaintext) return;
    const ok = await copyText(plaintext);
    setPlainCopied(ok);
    if (ok) {
      toast.success('已复制 Key 明文');
      setTimeout(() => setPlainCopied(false), 2000);
    } else {
      toast.error('复制失败，请手动选中');
    }
  };

  /** 「再签发一个」：回到表单态，换个新名字，其余选择保留 */
  const handleReissue = () => {
    setPhase('form');
    setPlaintext(null);
    setPromptCopied(false);
    setPlainCopied(false);
    setName(generateDefaultKeyName());
  };

  const isDone = phase === 'done';

  // ==== 三步预演（右栏常驻，成功后原位打勾） ====
  const steps = [
    {
      title: '生成 Key，指令自动进剪贴板',
      desc: '包含 Key、接口地址和安全保存步骤，AI 照着即可自行配置',
      state: isDone ? 'done' : 'active',
    },
    {
      title: '粘贴到 Claude Code / Cursor',
      desc: '发送后 AI 会把 Key 存进本机 secrets 并完成接入',
      state: isDone ? 'active' : 'idle',
    },
    {
      title: '直接对 AI 下指令',
      desc: '「把这份验收报告存进我的知识库」',
      state: 'idle',
    },
  ] as const;

  const issueView = (
    <>
      <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr]">
        {/* ==== 左栏：决策区 ==== */}
        <div className="px-5 py-5 min-w-0">
          {!isDone ? (
            <>
              <div className="mb-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-token-muted">
                AI 可以做什么
              </div>
              <div className="mb-4 flex flex-col gap-2" role="radiogroup" aria-label="权限选择">
                {(
                  [
                    {
                      key: 'rw' as Permission,
                      title: '可读可写',
                      recommended: true,
                      desc: '读取知识库与文章，并能以你的身份创建知识库、上传 / 更新文章',
                      code: 'document-store:read + write',
                    },
                    {
                      key: 'ro' as Permission,
                      title: '只读',
                      recommended: false,
                      desc: '仅浏览知识库列表、读取文章内容，不能改动任何东西',
                      code: 'document-store:read',
                    },
                  ]
                ).map((opt) => {
                  const checked = permission === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => setPermission(opt.key)}
                      className={cn(
                        'relative w-full rounded-[14px] p-3 pl-11 text-left transition-all',
                        checked ? 'surface-action-accent' : 'surface-inset',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute left-3.5 top-[15px] flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-all',
                          checked
                            ? 'surface-action-primary border-transparent'
                            : 'border-current opacity-40',
                        )}
                      >
                        {checked && <Check size={11} strokeWidth={3} className="text-white" />}
                      </span>
                      <span className="flex items-center gap-2 text-[13px] font-semibold text-token-primary">
                        {opt.title}
                        {opt.recommended && (
                          <span className="surface-action-accent rounded-full px-2 py-px text-[10px] font-medium">
                            推荐
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-token-secondary">
                        {opt.desc}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] text-token-muted">
                        {opt.code}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 元信息：名称 / 有效期，全部给默认 */}
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="w-12 shrink-0 text-[11.5px] text-token-muted">名称</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 60))}
                    className="prd-field h-8 min-w-0 flex-1 rounded-lg px-2.5 text-[12.5px] focus:outline-none"
                    aria-label="Key 名称"
                  />
                  <button
                    type="button"
                    onClick={() => setName(generateDefaultKeyName())}
                    className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-token-muted transition-opacity hover:opacity-80"
                    title="换一个随机名称"
                  >
                    <Dices size={11} />
                    换一个
                  </button>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="w-12 shrink-0 text-[11.5px] text-token-muted">有效期</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TTL_OPTIONS.map((opt) => (
                      <button
                        key={opt.days}
                        type="button"
                        aria-pressed={ttlDays === opt.days}
                        onClick={() => setTtlDays(opt.days)}
                        className={cn(
                          'rounded-full px-3 py-1 text-[11.5px] transition-all',
                          ttlDays === opt.days
                            ? 'surface-action-accent font-semibold'
                            : 'surface-action hover:text-token-secondary',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pl-[58px] text-[10.5px] leading-relaxed text-token-muted">
                  到期前 30 天会提醒续期，过期还有 7 天宽限，列表里可一键续期。
                </div>
              </div>

              {/* 更多权限：与知识库无关的 scope 全部收进折叠 */}
              {extraScopeOptions.length > 0 && (
                <div className="mt-3.5 border-t border-dashed border-current/10 pt-2.5">
                  <button
                    type="button"
                    onClick={() => setAdvOpen((v) => !v)}
                    aria-expanded={advOpen}
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-token-muted transition-opacity hover:opacity-80"
                  >
                    <ChevronDown
                      size={12}
                      className={cn('transition-transform', advOpen && 'rotate-180')}
                    />
                    更多权限（海鲜市场 / 缺陷管理 / 开放接口）
                    {extraScopes.length > 0 && (
                      <span className="surface-action-accent rounded-full px-1.5 text-[10px]">
                        {extraScopes.length}
                      </span>
                    )}
                  </button>
                  {advOpen && (
                    <div className="mt-2 flex flex-col gap-0.5">
                      {extraScopeOptions.map((scope) => (
                        <label
                          key={scope}
                          className="hover-bg-soft flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5"
                        >
                          <input
                            type="checkbox"
                            checked={extraScopes.includes(scope)}
                            onChange={() => toggleExtraScope(scope)}
                            className="accent-current"
                          />
                          <span className="text-[12px] text-token-primary">
                            {EXTRA_SCOPE_LABELS[scope] ?? scope}
                          </span>
                          <span className="font-mono text-[10px] text-token-muted">{scope}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            // ==== 成功态：原位变形，不换屏 ====
            <div className="flex flex-col gap-3.5">
              <div className="flex items-center gap-2.5">
                <span className="surface-state-success flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
                  <Check size={14} strokeWidth={3} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-token-primary">
                    {promptCopied ? 'Key 已生成，智能体指令已复制' : 'Key 已生成'}
                  </div>
                  <div className="truncate text-[11px] text-token-muted">{createdSummary}</div>
                </div>
              </div>
              <div className="surface-code rounded-xl px-3.5 py-3">
                <div className="break-all font-mono text-[12px] leading-relaxed text-token-accent">
                  {plaintext}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="text-[10.5px] text-token-muted">
                    明文只显示这一次，离开后只能看到前缀
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyPlain}
                    className="surface-action inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-all hover:text-token-secondary"
                  >
                    {plainCopied ? <Check size={11} /> : <Copy size={11} />}
                    {plainCopied ? '已复制' : '复制明文'}
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-4 text-[11px] text-token-muted">
                <button
                  type="button"
                  onClick={handleReissue}
                  className="inline-flex items-center gap-1 transition-opacity hover:opacity-80"
                >
                  <RefreshCw size={11} />
                  再签发一个
                </button>
                <span aria-hidden className="opacity-30">·</span>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center gap-1 transition-opacity hover:opacity-80"
                >
                  <Check size={11} />
                  我已保存，完成
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ==== 右栏：接下来三步（预期管理，点按钮前就知道会发生什么） ==== */}
        <div className="surface-inset border-t border-current/5 px-5 py-5 md:border-l md:border-t-0">
          <div className="mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-token-muted">
            接下来
          </div>
          <div className="flex flex-col">
            {steps.map((step, i) => (
              <div key={step.title} className="relative flex gap-2.5 pb-4 last:pb-0">
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-[11px] top-[26px] w-px bg-current opacity-10"
                  />
                )}
                <span
                  className={cn(
                    'z-[1] flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full font-mono text-[11px] transition-all',
                    step.state === 'done' && 'surface-state-success',
                    step.state === 'active' && 'surface-action-accent font-semibold',
                    step.state === 'idle' && 'surface-action',
                  )}
                >
                  {step.state === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                <div className="min-w-0">
                  <div
                    className={cn(
                      'text-[12.5px] font-semibold leading-snug',
                      step.state === 'active' ? 'text-token-accent' : 'text-token-primary',
                    )}
                  >
                    {step.title}
                  </div>
                  {i === 2 ? (
                    <div className="mt-1">
                      <span className="surface-code inline-block rounded-lg px-2 py-0.5 text-[10.5px] text-token-secondary">
                        {step.desc}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[10.5px] leading-relaxed text-token-muted">
                      {step.desc}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2 border-t border-current/5 pt-3 text-[10.5px] leading-relaxed text-token-muted">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <span>Key 以你的身份行动、可随时吊销；明文不入库、不进日志，只在此刻显示一次。</span>
          </div>
        </div>
      </div>

      {/* ==== 底部：单一 CTA ==== */}
      <div className="surface-panel-footer flex shrink-0 items-center gap-3 px-5 py-3.5">
        <div className="hidden min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.02em] text-token-muted sm:block">
          {scopeHint}
        </div>
        {!isDone && (
          <button
            type="button"
            onClick={() => void handleCreate(false)}
            disabled={creating}
            className="shrink-0 rounded-lg px-2 py-1.5 text-[11.5px] text-token-muted transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            只要 Key，不要指令
          </button>
        )}
        <button
          type="button"
          onClick={() => (isDone ? void handleCopyPrompt() : void handleCreate(true))}
          disabled={creating}
          className="surface-action-primary inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold tracking-[0.01em] transition-all max-sm:flex-1"
        >
          {isDone ? <Bot size={14} /> : <Sparkles size={14} />}
          {creating
            ? '正在签发…'
            : isDone
              ? promptCopied
                ? '再次复制智能体指令'
                : '复制智能体指令'
              : '生成 Key 并复制智能体指令'}
        </button>
      </div>
    </>
  );

  const modal = (
    <div
      className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      onClick={onClose}
    >
      <div
        className="surface-popover flex w-[min(760px,calc(100vw-32px))] flex-col overflow-hidden rounded-[20px] text-token-primary"
        style={{
          maxHeight: '88vh',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ==== 头部 ==== */}
        <div className="surface-panel-header flex shrink-0 items-center gap-3 px-5 py-4">
          <div className="surface-action-accent flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px]">
            <Bot size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-token-primary">接入 AI</h2>
            <div className="truncate text-[11px] text-token-muted">
              让你的智能体以你的身份读写知识库
            </div>
          </div>
          {view === 'issue' ? (
            <div className="hidden shrink-0 items-center gap-3.5 text-[11.5px] text-token-muted sm:flex">
              <button
                type="button"
                onClick={() => setView('keys')}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-token-secondary"
              >
                <KeyRound size={12} />
                我的 Key
                {keys.length > 0 && (
                  <span className="surface-action-accent rounded-full px-1.5 font-mono text-[10px]">
                    {keys.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setView('guide')}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-token-secondary"
              >
                <Book size={12} />
                使用指南
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setView('issue')}
              className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-token-muted transition-colors hover:text-token-secondary"
            >
              <ArrowLeft size={12} />
              返回签发
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="hover-bg-soft shrink-0 rounded-lg p-1.5 text-token-muted transition-colors hover:text-token-primary"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* ==== 主体 ==== */}
        {view === 'issue' ? (
          <div
            className="flex flex-col"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {issueView}
          </div>
        ) : (
          <div
            className="px-5 py-4"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {view === 'keys' && (
              <KeysListTab
                keys={keys}
                loading={loading}
                allowedScopes={allowedScopes}
                onRefresh={refresh}
                presetScopes={[SCOPE_READ, SCOPE_WRITE]}
              />
            )}
            {view === 'guide' && <GuideTab />}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
