import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, FileText, Sparkles } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Dialog } from '@/components/ui/Dialog';
import { useAuthStore } from '@/stores/authStore';
import { listSites, type HostedSite } from '@/services/real/webPages';
import { listDesignSystems, type DesignSystemItem } from '@/services/real/designSystems';
import {
  createPersonalStyle,
  derivePersonalStyle,
  updatePersonalStyle,
  type PersonalStyle,
  type PersonalStyleDraft,
  type PersonalStyleField,
} from '@/services/real/personalStyles';
import {
  PERSONAL_INSTRUCTION_MAX,
  PERSONAL_NAME_MAX,
  PERSONAL_NOTE_MAX,
  createInput,
  derivableSites,
  deriveBlocker,
  formFromDraft,
  formFromStyle,
  systemFilledFields,
  updateInput,
  validatePersonalStyleForm,
  type PersonalStyleForm,
} from './personalStyleModel';

const fieldStyle = { background: 'var(--bg-input)', border: '1px solid var(--border-default)' } as const;

export type PersonalStyleDialogMode = { kind: 'create' } | { kind: 'edit'; style: PersonalStyle };

/**
 * 「做一个我的风格」：选一张自己的网页和/或写几句描述 → 系统读样式提取草稿 → 审阅、改 → 保存。
 * 系统填的每一项都挂「系统填写」标记，用户一改标记就消失；提取不调模型，读不到的维度不编。
 * 编辑模式直接进审阅页，只提交改过的字段。
 */
const SITE_PAGE_SIZE = 50;

export function PersonalStyleDialog({
  open,
  mode,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  mode: PersonalStyleDialogMode;
  onOpenChange: (open: boolean) => void;
  onSaved: (style: PersonalStyle) => void;
}) {
  const currentUserId = useAuthStore((s) => s.user?.userId);
  const [step, setStep] = useState<'source' | 'review'>(mode.kind === 'edit' ? 'review' : 'source');
  // 网页列表按页读：每页 SITE_PAGE_SIZE 条，可按标题搜、可继续往下加载。只读第一页的话，
  // 第 51 张之后的网页永远选不到，首页恰好全是 PDF / 视频时还会误说「没有可提取的网页」。
  const [sites, setSites] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: HostedSite[]; scanned: number; total: number; loadingMore: boolean }
    | { status: 'failed'; message: string }
  >({ status: 'loading' });
  const [siteQuery, setSiteQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [catalog, setCatalog] = useState<DesignSystemItem[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [deriving, setDeriving] = useState(false);
  const [draft, setDraft] = useState<PersonalStyleDraft | null>(null);
  const [form, setForm] = useState<PersonalStyleForm | null>(mode.kind === 'edit' ? formFromStyle(mode.style) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void listDesignSystems().then((res) => {
      if (active && res.success) setCatalog(res.data.items);
    });
    return () => { active = false; };
  }, [open]);

  // 搜索条件一变就撤销已选网页：新列表里可能没有它，看不见的选中项不许被悄悄拿去提取。
  useEffect(() => { setSiteId(null); }, [debouncedQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(siteQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [siteQuery]);

  useEffect(() => {
    if (!open || mode.kind !== 'create') return;
    let active = true;
    setSites({ status: 'loading' });
    void listSites({ limit: SITE_PAGE_SIZE, keyword: debouncedQuery || undefined }).then((res) => {
      if (!active) return;
      setSites(res.success
        ? {
          status: 'ready',
          items: derivableSites(res.data.items, currentUserId),
          scanned: res.data.items.length,
          total: res.data.total,
          loadingMore: false,
        }
        : { status: 'failed', message: res.error?.message || '你的网页列表没有读出来，可以先只写描述' });
    });
    return () => { active = false; };
  }, [open, mode.kind, currentUserId, debouncedQuery]);

  const loadMoreSites = async () => {
    if (sites.status !== 'ready' || sites.loadingMore || sites.scanned >= sites.total) return;
    const skip = sites.scanned;
    setSites({ ...sites, loadingMore: true });
    const res = await listSites({ limit: SITE_PAGE_SIZE, skip, keyword: debouncedQuery || undefined });
    setSites((current) => {
      if (current.status !== 'ready' || current.scanned !== skip) return current;
      if (!res.success) return { ...current, loadingMore: false };
      const known = new Set(current.items.map((item) => item.id));
      const more = derivableSites(res.data.items, currentUserId).filter((item) => !known.has(item.id));
      return {
        status: 'ready',
        items: [...current.items, ...more],
        scanned: current.scanned + res.data.items.length,
        total: res.data.total,
        loadingMore: false,
      };
    });
  };
  const hasMoreSites = sites.status === 'ready' && sites.scanned < sites.total;

  const blocker = deriveBlocker(siteId, note);
  const filled = useMemo<PersonalStyleField[]>(
    () => (draft && form ? systemFilledFields(draft, form) : mode.kind === 'edit' ? mode.style.systemFilledFields : []),
    [draft, form, mode],
  );
  const formError = form ? validatePersonalStyleForm(form) : null;

  const derive = async () => {
    if (blocker || deriving) return;
    setDeriving(true);
    setError(null);
    const res = await derivePersonalStyle({ siteId, note });
    setDeriving(false);
    if (!res.success) {
      setError(res.error?.message || '没能提取出风格，请换一张网页或补几句描述');
      return;
    }
    setDraft(res.data);
    setForm(formFromDraft(res.data));
    setStep('review');
  };

  const save = async () => {
    if (!form || formError || saving) return;
    setSaving(true);
    setError(null);
    if (mode.kind === 'edit') {
      const patch = updateInput(mode.style, form);
      if (!patch) {
        setSaving(false);
        onOpenChange(false);
        return;
      }
      const res = await updatePersonalStyle(mode.style.id, patch);
      setSaving(false);
      if (!res.success) { setError(res.error?.message || '保存失败，请稍后重试'); return; }
      onSaved(res.data);
      return;
    }
    if (!draft) { setSaving(false); return; }
    const res = await createPersonalStyle(createInput(draft, form));
    setSaving(false);
    if (!res.success) { setError(res.error?.message || '保存失败，请稍后重试'); return; }
    onSaved(res.data);
  };

  const patchForm = (patch: Partial<PersonalStyleForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const baseReason = draft?.baseReason ?? (mode.kind === 'edit' && !mode.style.baseDesignSystemAvailable
    ? '原来的骨架已不在风格目录里，请换一个，否则用这套风格生成会被拒'
    : null);

  const content = step === 'source' ? (
    <div className="flex flex-col gap-4" data-personal-style-step="source">
      <p className="text-[12px] leading-relaxed text-token-muted">
        挑一张你喜欢的、自己做过的网页，系统会读它的样式，提取配色、字体、字号、间距与版式；也可以只写几句想要的感觉。提取完先给你看，改好了再保存。
      </p>
      <section className="flex flex-col gap-2" aria-label="从我的网页提取">
        <h4 className="text-[12px] font-semibold text-token-primary">从我的网页提取</h4>
        <input
          type="search"
          value={siteQuery}
          onChange={(event) => setSiteQuery(event.target.value)}
          placeholder="按标题搜索我的网页"
          aria-label="按标题搜索我的网页"
          className="rounded-lg px-2.5 py-1.5 text-[12px] text-token-primary"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
        />
        {sites.status === 'loading' && (
          <div className="flex items-center gap-2 text-[12px] text-token-muted"><MapSpinner size={12} />正在读取你的网页列表</div>
        )}
        {sites.status === 'failed' && <div className="text-[12px]" style={{ color: 'var(--semantic-danger-text)' }}>{sites.message}</div>}
        {sites.status === 'ready' && sites.items.length === 0 && (
          <div className="rounded-lg px-3 py-2 text-[12px] text-token-muted" style={{ background: 'var(--bg-tertiary)' }}>
            {hasMoreSites
              ? `已看过 ${sites.scanned} / ${sites.total} 张网页，其中还没有可以提取的（需要是自己创建的 HTML 网页）。可以继续往下找，或直接在下面写几句描述。`
              : debouncedQuery
                ? '没有搜到可以提取的网页（需要是自己创建的 HTML 网页）。换个标题搜，或直接在下面写几句描述。'
                : '你还没有可以提取的网页（需要是自己创建的 HTML 网页）。可以直接在下面写几句描述。'}
          </div>
        )}
        {sites.status === 'ready' && sites.items.length > 0 && (
          <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2" style={{ overscrollBehavior: 'contain' }} role="radiogroup" aria-label="选一张网页">
            {sites.items.map((site) => {
              const selected = site.id === siteId;
              return (
                <button
                  key={site.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSiteId(selected ? null : site.id)}
                  className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left hover-bg-soft"
                  style={{ border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-subtle)'}` }}
                >
                  <FileText size={14} className="shrink-0 text-token-muted" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-token-primary">{site.title || '未命名网页'}</span>
                  {selected && <Check size={12} style={{ color: 'var(--accent-primary)' }} />}
                </button>
              );
            })}
          </div>
        )}
        {hasMoreSites && (
          <button
            type="button"
            onClick={() => { void loadMoreSites(); }}
            disabled={sites.status === 'ready' && sites.loadingMore}
            className="self-start rounded-lg px-2.5 py-1 text-[12px] text-token-muted hover-bg-soft"
            data-personal-style-load-more
          >
            {sites.status === 'ready' && sites.loadingMore
              ? '正在加载'
              : `继续加载（已看过 ${sites.status === 'ready' ? sites.scanned : 0} / ${sites.status === 'ready' ? sites.total : 0} 张）`}
          </button>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <label htmlFor="personal-style-note" className="text-[12px] font-semibold text-token-primary">
          想要的感觉 <span className="font-normal text-token-muted">（可选；只写这个也行）</span>
        </label>
        <textarea
          id="personal-style-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={PERSONAL_NOTE_MAX}
          rows={3}
          placeholder="例如：深色底、荧光绿点缀，像技术发布会的页面；标题要大、留白多"
          className="resize-y rounded-lg px-3 py-2 text-[12px] leading-relaxed text-token-primary outline-none"
          style={fieldStyle}
        />
      </section>
      {deriving && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-token-secondary" style={{ background: 'var(--bg-tertiary)' }} role="status">
          <MapSpinner size={12} />
          {siteId ? '正在读取这张网页的样式，逐条数出配色、字体、字号与间距' : '正在按你的描述挑一个最接近的设计系统骨架'}
        </div>
      )}
    </div>
  ) : form ? (
    <div className="flex flex-col gap-4" data-personal-style-step="review">
      {draft && (
        <div className="rounded-lg px-3 py-2 text-[12px] leading-relaxed text-token-secondary" style={{ background: 'var(--bg-tertiary)' }}>
          <div className="font-semibold text-token-primary">系统读到了什么</div>
          <div className="text-token-muted">{draft.evidence}{draft.sourceSiteTitle ? ` · 来自「${draft.sourceSiteTitle}」` : ''}</div>
          {draft.traits.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {draft.traits.map((trait) => (
                <li key={trait.key}><span className="text-token-muted">{trait.label}：</span>{trait.value}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Field label="名称" filled={filled.includes('name')} htmlFor="personal-style-name">
        <input
          id="personal-style-name"
          value={form.name}
          maxLength={PERSONAL_NAME_MAX}
          onChange={(event) => patchForm({ name: event.target.value })}
          className="h-8 rounded-lg px-2.5 text-[13px] text-token-primary outline-none"
          style={fieldStyle}
        />
      </Field>
      <Field label="配色" filled={filled.includes('swatches')} hint="正文 / 底色 / 强调色">
        {form.swatches.length === 3 ? (
          <div className="flex flex-wrap items-center gap-3">
            {form.swatches.map((color, index) => (
              <label key={index} className="flex items-center gap-1.5 text-[12px] text-token-secondary">
                <input
                  type="color"
                  value={color}
                  aria-label={['正文色', '底色', '强调色'][index]}
                  onChange={(event) => patchForm({ swatches: form.swatches.map((item, i) => (i === index ? event.target.value : item)) })}
                  className="h-7 w-9 cursor-pointer rounded"
                  style={{ border: '1px solid var(--border-default)', background: 'transparent' }}
                />
                <span className="font-mono">{color}</span>
              </label>
            ))}
          </div>
        ) : (
          <span className="text-[12px] text-token-muted">没读到完整的配色（按描述建的风格不带色块），生成时按下面的说明来。</span>
        )}
      </Field>
      <Field label="字体" filled={filled.includes('fonts')} htmlFor="personal-style-fonts" hint="标题、正文，用逗号隔开">
        <input
          id="personal-style-fonts"
          value={form.fontsText}
          onChange={(event) => patchForm({ fontsText: event.target.value })}
          placeholder="没读到字体，可以不填"
          className="h-8 rounded-lg px-2.5 text-[13px] text-token-primary outline-none"
          style={fieldStyle}
        />
      </Field>
      <Field label="设计系统骨架" filled={filled.includes('baseDesignSystemId')} htmlFor="personal-style-base" hint={baseReason ?? '生成时以它的组件与版式为底，配色字体按上面的说明覆盖'}>
        <select
          id="personal-style-base"
          value={form.baseDesignSystemId}
          onChange={(event) => patchForm({ baseDesignSystemId: event.target.value })}
          className="h-8 rounded-lg px-2 text-[13px] text-token-primary outline-none"
          style={fieldStyle}
        >
          {!catalog.some((item) => item.id === form.baseDesignSystemId) && (
            <option value={form.baseDesignSystemId}>{form.baseDesignSystemId}{mode.kind === 'edit' && !mode.style.baseDesignSystemAvailable ? '（已下线）' : ''}</option>
          )}
          {catalog.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.category}</option>)}
        </select>
      </Field>
      <Field label="风格说明" filled={filled.includes('instruction')} htmlFor="personal-style-instruction" hint="生成时原样交给设计执行器，写得越具体越像">
        <textarea
          id="personal-style-instruction"
          value={form.instruction}
          maxLength={PERSONAL_INSTRUCTION_MAX}
          onChange={(event) => patchForm({ instruction: event.target.value })}
          rows={7}
          className="min-h-[140px] resize-y rounded-lg px-3 py-2 text-[12px] leading-relaxed text-token-primary outline-none"
          style={fieldStyle}
        />
        <span className="self-end text-[11px] text-token-muted">{form.instruction.trim().length} / {PERSONAL_INSTRUCTION_MAX}</span>
      </Field>
    </div>
  ) : null;

  const primaryButton = (label: string, onClick: () => void, disabledReason: string | null, busy: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={Boolean(disabledReason) || busy}
      title={disabledReason ?? undefined}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold disabled:opacity-50"
      style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
    >
      {busy ? <MapSpinner size={12} /> : <Sparkles size={12} />}
      {label}
    </button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode.kind === 'edit' ? `编辑我的风格 · ${mode.style.name}` : '做一个我的风格'}
      maxWidth={620}
      content={(
        <div className="flex flex-col gap-3">
          {content}
          {error && <div role="alert" className="text-[12px]" style={{ color: 'var(--semantic-danger-text)' }}>{error}</div>}
          {step === 'review' && formError && <div className="text-[12px] text-token-muted">{formError}</div>}
        </div>
      )}
      actions={step === 'source' ? (
        <>
          {blocker && <span className="mr-auto text-[11px] text-token-muted">{blocker}</span>}
          {primaryButton(deriving ? '正在提取' : '提取风格', () => void derive(), blocker, deriving)}
        </>
      ) : (
        <>
          {mode.kind === 'create' && (
            <button
              type="button"
              onClick={() => { setStep('source'); setError(null); }}
              className="mr-auto inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] text-token-secondary hover-bg-soft"
            >
              <ArrowLeft size={12} />重新选来源
            </button>
          )}
          {primaryButton(saving ? '正在保存' : mode.kind === 'edit' ? '保存修改' : '保存到我的风格', () => void save(), formError, saving)}
        </>
      )}
    />
  );
}

function Field({ label, filled, hint, htmlFor, children }: {
  label: string;
  filled: boolean;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-system-filled={filled ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={htmlFor} className="text-[12px] font-semibold text-token-primary">{label}</label>
        {filled && (
          <span className="rounded px-1.5 py-0.5 text-[10px] text-token-secondary" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            系统填写，请核对
          </span>
        )}
        {hint && <span className="text-[11px] text-token-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
