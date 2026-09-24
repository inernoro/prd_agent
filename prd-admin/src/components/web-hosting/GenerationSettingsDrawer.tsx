import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Copy, Lock, Plus, RotateCcw, Settings2, Trash2, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getDesignGenerationSettings,
  updateDesignGenerationSettings,
  type DesignGenerationRuntime,
  type DesignGenerationSettings,
  type DesignGenerationSettingsUpdate,
  type DesignGenerationStyle,
  type DesignPromptKind,
  type DesignReviewMode,
} from '@/services/real/webPages';
import { RUNTIME_CARD_REGISTRY } from './siteGenerateOptions';
import {
  PROMPT_SECTION_REGISTRY,
  REVIEW_MODE_REGISTRY,
  buildGenerationSettingsPatch,
  composePromptBundle,
  type GenerationSettingsDraft,
} from './generationSettingsModel';

interface Props {
  open: boolean;
  onClose: () => void;
}

const RUNTIME_OPTIONS: DesignGenerationRuntime[] = ['open-design', 'map-gateway'];

function toDraft(settings: DesignGenerationSettings): GenerationSettingsDraft {
  return {
    defaultRuntime: settings.defaultRuntime,
    reviewMode: settings.reviewMode,
    styles: settings.styles.map((style) => ({ ...style, swatches: [...style.swatches] })),
    prompts: {
      generate: settings.prompts.generate.value,
      edit: settings.prompts.edit.value,
      review: settings.prompts.review.value,
    },
  };
}

function formatUpdatedAt(value: string | null) {
  if (!value) return '尚未修改过';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已复制${label}`);
  } catch {
    toast.error('复制失败', '浏览器没有给剪贴板权限，可以手动全选复制');
  }
}

function Section({ title, hint, children, action }: {
  title: string;
  hint?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-token-primary">{title}</h3>
          {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-token-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function SmallButton({ children, onClick, disabled, danger }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors hover-bg-soft disabled:cursor-not-allowed disabled:opacity-45"
      style={{ border: '1px solid var(--border-default)', color: danger ? 'var(--semantic-danger-text)' : 'var(--text-secondary)' }}
    >
      {children}
    </button>
  );
}

const fieldStyle = { background: 'var(--bg-input)', border: '1px solid var(--border-default)' } as const;

/**
 * 网页生成设置（从网页托管顶部「生成网页」旁的齿轮进入）。
 *
 * 管理员在这里改默认执行器、自查强度、风格预设与三段提示词；改完下一次运行生效，
 * 已经在跑的任务不受影响（运行时冻结进任务书）。canEdit=false 时整页只读，但复制照样可用——
 * 提示词区的一个重要用途就是整段复制拿去搭自己的智能体。
 */
export default function GenerationSettingsDrawer({ open, onClose }: Props) {
  const [settings, setSettings] = useState<DesignGenerationSettings | null>(null);
  const [draft, setDraft] = useState<GenerationSettingsDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await getDesignGenerationSettings();
    if (result.success) {
      setSettings(result.data);
      setDraft(toDraft(result.data));
    } else {
      setLoadError(result.error?.message || '网页生成设置暂时读不到');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const readOnly = !settings?.canEdit;
  const patch = useMemo(
    () => (settings && draft ? buildGenerationSettingsPatch(settings, draft) : {}),
    [draft, settings],
  );
  const dirty = Object.keys(patch).length > 0;
  const invalidStyle = draft?.styles.find((style) => !style.name.trim());

  const updateDraft = (next: (current: GenerationSettingsDraft) => GenerationSettingsDraft) => {
    setDraft((current) => (current ? next(current) : current));
  };

  const updateStyle = (id: string, change: Partial<DesignGenerationStyle>) => {
    updateDraft((current) => ({
      ...current,
      styles: current.styles.map((style) => (style.id === id ? { ...style, ...change } : style)),
    }));
  };

  const setDefaultStyle = (id: string) => {
    updateDraft((current) => ({
      ...current,
      styles: current.styles.map((style) => ({ ...style, isDefault: style.id === id, enabled: style.id === id ? true : style.enabled })),
    }));
  };

  const addStyle = () => {
    updateDraft((current) => {
      const template = current.styles.find((style) => style.isDefault) ?? current.styles[0];
      return {
        ...current,
        styles: [...current.styles, {
          id: `custom-${Date.now().toString(36)}`,
          name: '新风格',
          description: '',
          designSystemId: template?.designSystemId ?? '',
          swatches: [],
          enabled: true,
          isDefault: false,
          builtIn: false,
        }],
      };
    });
  };

  const removeStyle = (id: string) => {
    updateDraft((current) => {
      const next = current.styles.filter((style) => style.id !== id);
      // 删掉的若是默认风格，默认落到剩下的第一项，保证始终恰好一个默认。
      if (next.length > 0 && !next.some((style) => style.isDefault)) next[0] = { ...next[0], isDefault: true };
      return { ...current, styles: next };
    });
  };

  const save = async () => {
    if (!dirty || readOnly || saving) return;
    if (invalidStyle) {
      toast.error('风格还没填完整', `「${invalidStyle.name || '未命名风格'}」需要名称和三个 #RRGGBB 色块`);
      return;
    }
    setSaving(true);
    const result = await updateDesignGenerationSettings(patch as DesignGenerationSettingsUpdate);
    setSaving(false);
    if (!result.success) {
      toast.error('保存失败', result.error?.message || '请稍后重试');
      return;
    }
    setSettings(result.data);
    setDraft(toDraft(result.data));
    toast.success('已保存，下一次生成起生效');
  };

  const requestClose = () => {
    if (dirty && !window.confirm('有改动还没保存，确定关闭吗？')) return;
    onClose();
  };

  const body = () => {
    if (loading && !settings) return <MapSectionLoader text="正在读取网页生成设置" />;
    if (loadError || !settings || !draft) {
      return (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-[13px]" style={{ color: 'var(--semantic-danger-text)' }}>{loadError || '网页生成设置暂时读不到'}</p>
          <SmallButton onClick={() => void load()}>重新读取</SmallButton>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Section title="默认执行器" hint="新开生成弹窗和「帮我修改」时默认选中哪一种；它不可用时界面会自动改用另一种并写明原因。">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="默认执行器">
            {RUNTIME_OPTIONS.map((runtime) => {
              const copy = RUNTIME_CARD_REGISTRY[runtime];
              const active = draft.defaultRuntime === runtime;
              return (
                <button
                  key={runtime}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={readOnly}
                  onClick={() => updateDraft((current) => ({ ...current, defaultRuntime: runtime }))}
                  className="flex flex-col gap-1 rounded-xl px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed"
                  style={active
                    ? { border: '1.5px solid var(--accent-primary)', background: 'var(--selection-bg)' }
                    : { border: '1px solid var(--border-default)' }}
                >
                  <span className="flex items-center gap-2 text-[14px] font-bold text-token-primary">
                    {copy?.title ?? runtime}
                    <span className="text-[11px] font-normal text-token-muted">{copy?.badge}</span>
                  </span>
                  <span className="text-[12px] leading-relaxed text-token-muted">{copy?.description}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="自查强度" hint="只对精细设计（OpenDesign）生效：写完页面后要自查几轮。">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="自查强度">
            {(Object.keys(REVIEW_MODE_REGISTRY) as DesignReviewMode[]).map((mode) => {
              const item = REVIEW_MODE_REGISTRY[mode];
              const active = draft.reviewMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={readOnly}
                  onClick={() => updateDraft((current) => ({ ...current, reviewMode: mode }))}
                  className="flex flex-col gap-1 rounded-xl px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed"
                  style={active
                    ? { border: '1.5px solid var(--accent-primary)', background: 'var(--selection-bg)' }
                    : { border: '1px solid var(--border-default)' }}
                >
                  <span className="text-[14px] font-bold text-token-primary">{item.label}</span>
                  <span className="text-[12px] leading-relaxed text-token-muted">{item.description}</span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          title="风格预设"
          hint="生成弹窗里能选的风格。每项对应 OpenDesign 的一套设计系统，色块取自它的真实配色，只读。"
          action={!readOnly && <SmallButton onClick={addStyle}><Plus size={13} />新增风格</SmallButton>}
        >
          <div className="flex flex-col gap-2.5">
            {draft.styles.map((style) => (
              <div key={style.id} className="flex flex-col gap-2.5 rounded-xl p-3" style={{ border: '1px solid var(--border-subtle)', opacity: style.enabled ? 1 : 0.65 }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-7 w-20 shrink-0 overflow-hidden rounded-md" style={{ border: '1px solid var(--border-subtle)' }} aria-hidden>
                    {style.swatches.slice(0, 3).map((swatch, index) => (
                      <span key={index} className="flex-1" style={{ background: swatch }} />
                    ))}
                  </span>
                  <input
                    aria-label="风格名称"
                    value={style.name}
                    disabled={readOnly}
                    maxLength={40}
                    onChange={(event) => updateStyle(style.id, { name: event.target.value })}
                    className="h-8 min-w-0 flex-1 rounded-lg px-2.5 text-[13px] font-semibold text-token-primary outline-none disabled:opacity-80"
                    style={fieldStyle}
                  />
                  {style.builtIn && <span className="rounded-md px-1.5 py-0.5 text-[11px] text-token-muted" style={{ background: 'var(--bg-tertiary)' }}>内置</span>}
                  <label className="flex items-center gap-1.5 text-[12px] text-token-secondary">
                    <input
                      type="checkbox"
                      checked={style.enabled}
                      disabled={readOnly || style.isDefault}
                      onChange={(event) => updateStyle(style.id, { enabled: event.target.checked })}
                      style={{ accentColor: 'var(--accent-primary)' }}
                    />
                    启用
                  </label>
                  <label className="flex items-center gap-1.5 text-[12px] text-token-secondary">
                    <input
                      type="radio"
                      name="design-default-style"
                      checked={style.isDefault}
                      disabled={readOnly}
                      onChange={() => setDefaultStyle(style.id)}
                      style={{ accentColor: 'var(--accent-primary)' }}
                    />
                    默认
                  </label>
                  {!readOnly && !style.builtIn && (
                    <button type="button" aria-label={`删除风格 ${style.name}`} onClick={() => removeStyle(style.id)} className="flex h-8 w-8 items-center justify-center rounded-lg hover-bg-soft" style={{ color: 'var(--semantic-danger-text)' }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <input
                  aria-label="风格描述"
                  value={style.description}
                  disabled={readOnly}
                  maxLength={200}
                  placeholder="一句话描述，会显示在生成弹窗的风格卡片上"
                  onChange={(event) => updateStyle(style.id, { description: event.target.value })}
                  className="h-8 rounded-lg px-2.5 text-[12px] text-token-primary outline-none placeholder:text-token-muted disabled:opacity-80"
                  style={fieldStyle}
                />
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-token-secondary">
                  <label className="flex items-center gap-1.5">
                    设计系统编号
                    <input
                      value={style.designSystemId}
                      disabled={readOnly}
                      maxLength={80}
                      onChange={(event) => updateStyle(style.id, { designSystemId: event.target.value })}
                      className="h-8 w-44 rounded-lg px-2.5 font-mono text-[12px] text-token-primary outline-none disabled:opacity-80"
                      style={fieldStyle}
                    />
                  </label>
                  <span className="ml-1 text-token-muted">
                    {style.swatches.length > 0
                      ? '色块取自该设计系统的真实配色，随设计系统自动更新'
                      : '保存后按设计系统的真实配色显示色块；不在 OpenDesign 目录里的设计系统没有色块'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="提示词"
          hint="这三段只用于精细设计；快速生成只采用风格名称与说明。它们接在平台契约之后，只影响「怎么设计」，不影响「能不能发布」，可以整段复制拿去搭自己的智能体。"
          action={(
            <SmallButton onClick={() => void copyText(composePromptBundle(settings.platformContract, draft.prompts), '平台契约与三段提示词')}>
              <Copy size={13} />复制全部
            </SmallButton>
          )}
        >
          {(Object.keys(PROMPT_SECTION_REGISTRY) as DesignPromptKind[]).map((kind) => {
            const meta = PROMPT_SECTION_REGISTRY[kind];
            const prompt = settings.prompts[kind];
            const value = draft.prompts[kind];
            const isDefault = value === prompt.defaultValue;
            return (
              <div key={kind} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`design-prompt-${kind}`} className="text-[13px] font-semibold text-token-primary">{meta.label}</label>
                  <span
                    className="rounded-md px-1.5 py-0.5 text-[11px]"
                    style={isDefault
                      ? { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }
                      : { background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}
                  >
                    {isDefault ? '默认' : '已自定义'}
                  </span>
                  <span className="text-[11px] text-token-muted">{meta.hint}</span>
                  <span className="ml-auto flex gap-1.5">
                    <SmallButton onClick={() => void copyText(value, meta.label)}><Copy size={13} />复制</SmallButton>
                    {!readOnly && (
                      <SmallButton disabled={isDefault} onClick={() => updateDraft((current) => ({ ...current, prompts: { ...current.prompts, [kind]: prompt.defaultValue } }))}>
                        <RotateCcw size={13} />恢复默认
                      </SmallButton>
                    )}
                  </span>
                </div>
                <textarea
                  id={`design-prompt-${kind}`}
                  value={value}
                  readOnly={readOnly}
                  onChange={(event) => updateDraft((current) => ({ ...current, prompts: { ...current.prompts, [kind]: event.target.value } }))}
                  rows={8}
                  spellCheck={false}
                  className="min-h-[160px] resize-y rounded-xl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-token-primary outline-none"
                  style={fieldStyle}
                />
              </div>
            );
          })}
        </Section>

        <Section
          title="平台契约（只读）"
          hint="发布闸门的硬规矩：链接、按钮、占位、事实来源。改坏了页面会在最后一步被拒收，所以这里不开放编辑。"
          action={<SmallButton onClick={() => void copyText(settings.platformContract, '平台契约')}><Copy size={13} />复制</SmallButton>}
        >
          <pre
            className="max-h-72 whitespace-pre-wrap break-words rounded-xl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-token-secondary"
            style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-subtle)', overflowY: 'auto' }}
          >
            {settings.platformContract || '（后端没有返回平台契约）'}
          </pre>
        </Section>
      </div>
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0" style={{ background: 'var(--dialog-overlay)', zIndex: 110 }} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed right-0 top-0 flex flex-col shadow-2xl outline-none"
          style={{
            zIndex: 111,
            width: 'min(760px, 100vw)',
            height: '100vh',
            maxHeight: '100vh',
            background: 'var(--bg-elevated)',
            borderLeft: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <div className="shrink-0 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: 'var(--selection-bg)', color: 'var(--accent-primary)' }}>
                <Settings2 size={18} />
              </span>
              <DialogPrimitive.Title className="min-w-0 flex-1 text-[17px] font-bold">网页生成设置</DialogPrimitive.Title>
              {settings && !settings.canEdit && (
                <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-token-muted" style={{ background: 'var(--bg-tertiary)' }}>
                  <Lock size={12} />只读，需要网页托管管理权限才能修改
                </span>
              )}
              <DialogPrimitive.Close aria-label="关闭" className="flex h-8 w-8 items-center justify-center rounded-lg text-token-muted hover-bg-soft">
                <X size={16} />
              </DialogPrimitive.Close>
            </div>
            {settings && (
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-token-muted">
                <span>当前提示词版本 <span className="font-mono text-token-secondary">{settings.promptFingerprint.slice(0, 12) || '—'}</span></span>
                <span>最后修改：{settings.updatedBy || '系统默认'} · {formatUpdatedAt(settings.updatedAt)}</span>
                <span>改动从下一次生成起生效，正在跑的任务不受影响</span>
              </p>
            )}
          </div>
          <div className="flex-1 px-5 py-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {body()}
          </div>
          {settings?.canEdit && (
            <div className="flex shrink-0 items-center gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <span className="min-w-0 flex-1 text-[12px] text-token-muted">
                {dirty ? `有 ${Object.keys(patch).length} 类改动未保存` : '没有未保存的改动'}
              </span>
              <SmallButton disabled={!dirty || saving} onClick={() => settings && setDraft(toDraft(settings))}>放弃改动</SmallButton>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-bold disabled:cursor-not-allowed disabled:opacity-45"
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
              >
                {saving && <MapSpinner size={13} />}保存
              </button>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
