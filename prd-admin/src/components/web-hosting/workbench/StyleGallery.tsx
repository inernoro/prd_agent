import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Palette, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { getDesignGenerationSettings, type DesignGenerationStyle } from '@/services/real/webPages';
import {
  listDesignSystems,
  type DesignSystemCatalog,
  type DesignSystemItem,
} from '@/services/real/designSystems';
import { deletePersonalStyle, listPersonalStyles, type PersonalStyle } from '@/services/real/personalStyles';
import { StyleThumbnail } from './StyleThumbnail';
import { PersonalStyleDialog, type PersonalStyleDialogMode } from './PersonalStyleDialog';
import { createBlocker } from './personalStyleModel';

/**
 * 风格画廊（受控）：管理员配置的预设风格在前（真实缩略图 + 名称 + 一句话），
 * 接着是「我的风格」（只属于当前用户，标「我的」，可新建 / 编辑 / 删除），
 * 下面「更多风格」按分类折叠浏览 OpenDesign 的全部设计系统。
 *
 * 每张缩略图都是该风格真实样张的缩小版（StyleThumbnail），分类默认折叠、缩略图进入视口才加载，
 * 一百五十多套设计系统不会一次性全渲染。
 */

/**
 * 选中的是哪一套：管理员预设（生成时按 styleId 冻结）、我的风格（styleId = personal:<id>，
 * 服务端按编号 + 当前用户取出风格正文）或目录里的某个设计系统。
 */
export type StyleGallerySelection =
  | { kind: 'preset'; key: string; styleId: string; designSystemId: string; name: string }
  | { kind: 'personal'; key: string; styleId: string; designSystemId: string; name: string; swatches: string[] }
  | { kind: 'design-system'; key: string; designSystemId: string; name: string };

/** 生成请求里该带的 styleId：预设与我的风格走 styleId，目录设计系统走 designSystemId（不带 styleId）。 */
export function selectionStyleId(selection: StyleGallerySelection | null): string | null {
  return selection && selection.kind !== 'design-system' ? selection.styleId : null;
}

/** 目录项的选择键加前缀，避免与预设的 styleId 撞名（预设 editorial 与设计系统 editorial 是两回事）。 */
export const DESIGN_SYSTEM_KEY_PREFIX = 'design-system:';

export function presetSelection(style: DesignGenerationStyle): StyleGallerySelection {
  return { kind: 'preset', key: style.id, styleId: style.id, designSystemId: style.designSystemId, name: style.name };
}

/** 我的风格的选择键就是它的 styleId（personal:<id>），与预设编号、design-system: 前缀都不会撞。 */
export function personalSelection(style: PersonalStyle): StyleGallerySelection {
  return {
    kind: 'personal',
    key: style.styleId,
    styleId: style.styleId,
    designSystemId: style.baseDesignSystemId,
    name: style.name,
    swatches: style.swatches,
  };
}

export function designSystemSelection(item: DesignSystemItem): StyleGallerySelection {
  return { kind: 'design-system', key: `${DESIGN_SYSTEM_KEY_PREFIX}${item.id}`, designSystemId: item.id, name: item.name };
}

export interface MoreStyleGroup {
  category: string;
  items: DesignSystemItem[];
}

/**
 * 「更多风格」分组：按后端给的分类顺序（数量从多到少）分组，去掉已经作为预设出现的设计系统，
 * 空分组不出现。
 */
export function groupMoreStyles(catalog: DesignSystemCatalog, presetDesignSystemIds: ReadonlySet<string>): MoreStyleGroup[] {
  const byCategory = new Map<string, DesignSystemItem[]>();
  for (const item of catalog.items) {
    if (presetDesignSystemIds.has(item.id)) continue;
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  return catalog.categories
    .map((category) => ({ category: category.name, items: byCategory.get(category.name) ?? [] }))
    .filter((group) => group.items.length > 0);
}

type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; message: string };

export interface StyleGalleryProps {
  /** 当前选中项的 key（预设为 styleId，我的风格为 `personal:<id>`，目录项为 `design-system:<id>`）；null 表示未选。 */
  selectedId: string | null;
  onSelect: (selection: StyleGallerySelection) => void;
  /** 样张大标题，通常是用户正在生成的网页标题。 */
  title?: string;
}

export function StyleGallery({ selectedId, onSelect, title }: StyleGalleryProps) {
  const [presets, setPresets] = useState<Loadable<DesignGenerationStyle[]>>({ status: 'loading' });
  const [mine, setMine] = useState<Loadable<{ items: PersonalStyle[]; limit: number }>>({ status: 'loading' });
  const [catalog, setCatalog] = useState<Loadable<DesignSystemCatalog>>({ status: 'loading' });
  const [dialog, setDialog] = useState<{ key: number; mode: PersonalStyleDialogMode } | null>(null);
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPresets({ status: 'loading' });
    setMine({ status: 'loading' });
    setCatalog({ status: 'loading' });
    void getDesignGenerationSettings().then((res) => {
      if (cancelled) return;
      setPresets(res.success
        ? { status: 'ready', data: res.data.styles.filter((style) => style.enabled) }
        : { status: 'failed', message: res.error?.message || '预设风格没有读出来，请稍后重试。' });
    });
    void listPersonalStyles().then((res) => {
      if (cancelled) return;
      setMine(res.success
        ? { status: 'ready', data: res.data }
        : { status: 'failed', message: res.error?.message || '我的风格没有读出来，请稍后重试。' });
    });
    void listDesignSystems().then((res) => {
      if (cancelled) return;
      setCatalog(res.success
        ? { status: 'ready', data: res.data }
        : { status: 'failed', message: res.error?.message || '风格目录没有读出来，请稍后重试。' });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const presetDesignSystemIds = useMemo(
    () => new Set(presets.status === 'ready' ? presets.data.map((style) => style.designSystemId) : []),
    [presets],
  );
  const moreGroups = useMemo(
    () => (catalog.status === 'ready' ? groupMoreStyles(catalog.data, presetDesignSystemIds) : []),
    [catalog, presetDesignSystemIds],
  );
  const toggleCategory = useCallback((category: string) => {
    setOpenCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const mineCount = mine.status === 'ready' ? mine.data.items.length : 0;
  const mineLimit = mine.status === 'ready' ? mine.data.limit : 20;
  const newBlocker = mine.status === 'ready' ? createBlocker(mineCount, mineLimit) : null;

  /** 新建或改完：列表里换上服务端返回的那一份，并直接选中它（新建后不必再点一次）。 */
  const handleSaved = useCallback((saved: PersonalStyle) => {
    setMine((current) => {
      if (current.status !== 'ready') return current;
      const rest = current.data.items.filter((item) => item.id !== saved.id);
      return { status: 'ready', data: { ...current.data, items: [saved, ...rest] } };
    });
    setDialog(null);
    onSelect(personalSelection(saved));
  }, [onSelect]);

  const handleDelete = useCallback(async (style: PersonalStyle) => {
    const confirmed = await systemDialog.confirm({
      title: '删除我的风格',
      message: `删除「${style.name}」？已经用它生成的网页不受影响，但以后不能再选它。`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!confirmed) return;
    const res = await deletePersonalStyle(style.id);
    if (!res.success) {
      toast.error('没有删掉', res.error?.message || '请稍后重试');
      return;
    }
    setMine((current) => (current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, items: current.data.items.filter((item) => item.id !== style.id) } }
      : current));
    // 删掉的正是选中的那套：退回默认预设，免得生成时带着一个已经不存在的编号被拒。
    if (selectedId === style.styleId && presets.status === 'ready') {
      const fallback = presets.data.find((item) => item.isDefault) ?? presets.data[0];
      if (fallback) onSelect(presetSelection(fallback));
    }
  }, [onSelect, presets, selectedId]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="flex flex-col gap-2.5" aria-label="预设风格">
        <SectionHeading title="预设风格" hint="管理员在网页生成设置里配置的风格，缩略图是它真实的样子" />
        {presets.status === 'failed' && <LoadFailure message={presets.message} onRetry={retry} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {presets.status === 'loading' && Array.from({ length: 4 }, (_, index) => <CardSkeleton key={index} />)}
          {presets.status === 'ready' && presets.data.map((style) => (
            <StyleCard
              key={style.id}
              selection={presetSelection(style)}
              selected={selectedId === style.id}
              description={style.description}
              sampleDesignSystemId={style.sampleUrl ? style.designSystemId : null}
              title={title}
              onSelect={onSelect}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2.5" aria-label="我的风格">
        <SectionHeading
          title="我的风格"
          hint={mine.status === 'ready'
            ? `只有你自己看得到、用得到；已有 ${mineCount} / ${mineLimit} 套`
            : '只有你自己看得到、用得到'}
        />
        {mine.status === 'failed' && <LoadFailure message={mine.message} onRetry={retry} />}
        {mine.status === 'loading' && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"><CardSkeleton /></div>}
        {mine.status === 'ready' && mine.data.items.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {mine.data.items.map((style) => (
              <PersonalStyleCard
                key={style.id}
                style={style}
                selected={selectedId === style.styleId}
                onSelect={onSelect}
                onEdit={() => setDialog({ key: Date.now(), mode: { kind: 'edit', style } })}
                onDelete={() => void handleDelete(style)}
              />
            ))}
          </div>
        )}
        <CustomStyleCard
          disabledReason={newBlocker}
          onRequest={() => setDialog({ key: Date.now(), mode: { kind: 'create' } })}
        />
      </section>

      <section className="flex flex-col gap-2.5" aria-label="更多风格">
        <SectionHeading
          title="更多风格"
          hint={catalog.status === 'ready'
            ? `OpenDesign ${catalog.data.engine.version} 自带的 ${catalog.data.count} 套设计系统，按分类展开浏览`
            : 'OpenDesign 自带的全部设计系统，按分类展开浏览'}
        />
        {catalog.status === 'loading' && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"><CardSkeleton /><CardSkeleton /></div>}
        {catalog.status === 'failed' && <LoadFailure message={catalog.message} onRetry={retry} />}
        {moreGroups.map((group) => {
          const open = openCategories.has(group.category);
          return (
            <div key={group.category} className="rounded-xl" style={{ border: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggleCategory(group.category)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left hover-bg-soft"
              >
                {open ? <ChevronDown size={14} className="text-token-muted" /> : <ChevronRight size={14} className="text-token-muted" />}
                <span className="text-[13px] font-semibold text-token-primary">{group.category}</span>
                <span className="text-[12px] text-token-muted">{group.items.length} 套</span>
                <span className="ml-auto flex h-3 w-16 overflow-hidden rounded-sm" aria-hidden>
                  {group.items.slice(0, 4).map((item) => (
                    <span key={item.id} className="flex-1" style={{ background: item.swatches.accent }} />
                  ))}
                </span>
              </button>
              {open && (
                <div className="grid grid-cols-2 gap-3 px-3 pb-3 sm:grid-cols-3 lg:grid-cols-4">
                  {group.items.map((item) => {
                    const selection = designSystemSelection(item);
                    return (
                      <StyleCard
                        key={item.id}
                        selection={selection}
                        selected={selectedId === selection.key}
                        description={item.summary}
                        sampleDesignSystemId={item.id}
                        title={title}
                        onSelect={onSelect}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {dialog && (
        <PersonalStyleDialog
          key={dialog.key}
          open
          mode={dialog.mode}
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export interface StyleCardProps {
  selection: StyleGallerySelection;
  selected: boolean;
  description: string;
  /** 有真实样张时是设计系统编号；null 表示没有样张（缩略图位置会说明原因）。 */
  sampleDesignSystemId: string | null;
  title?: string;
  onSelect: (selection: StyleGallerySelection) => void;
}

/**
 * 单张风格卡：整张可点（键盘 Enter / 空格同样生效），选中态用强调色描边 + 角标。
 * 根节点用 role="button" 而不是 <button>：缩略图加载失败时里面有一个「重试」按钮，按钮不能嵌套。
 */
export function StyleCard({ selection, selected, description, sampleDesignSystemId, title, onSelect }: StyleCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(selection)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(selection);
        }
      }}
      className="group flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-2 text-left outline-none transition-colors hover-bg-soft"
      style={{
        border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
        boxShadow: selected ? '0 0 0 1px var(--accent-primary)' : undefined,
        background: 'var(--bg-card)',
      }}
      data-style-key={selection.key}
    >
      <div className="relative">
        <StyleThumbnail designSystemId={sampleDesignSystemId} title={title} size="thumb" label={`${selection.name}风格样张`} />
        {selected && (
          <span
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
            aria-hidden
          >
            <Check size={12} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="truncate text-[13px] font-semibold text-token-primary">{selection.name}</span>
        <span className="line-clamp-2 text-[11px] leading-snug text-token-muted">{description || '暂无说明'}</span>
      </div>
    </div>
  );
}

export const CUSTOM_STYLE_CARD_TEXT = {
  title: '做一个我的风格',
  description: '挑一张你自己做过的网页，或写几句想要的感觉；系统读出配色、字体与版式，你核对后保存。',
} as const;

export function CustomStyleCard({ onRequest, disabledReason }: { onRequest: () => void; disabledReason?: string | null }) {
  return (
    <button
      type="button"
      onClick={onRequest}
      disabled={Boolean(disabledReason)}
      className="flex items-center gap-3 rounded-xl p-3 text-left hover-bg-soft disabled:cursor-not-allowed disabled:opacity-60"
      style={{ border: '1px dashed var(--border-default)' }}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        <Palette size={18} className="text-token-secondary" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-token-primary">{CUSTOM_STYLE_CARD_TEXT.title}</span>
        <span className="text-[11px] leading-snug text-token-muted">{disabledReason || CUSTOM_STYLE_CARD_TEXT.description}</span>
      </span>
    </button>
  );
}

export interface PersonalStyleCardProps {
  style: PersonalStyle;
  selected: boolean;
  onSelect: (selection: StyleGallerySelection) => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * 我的风格卡：没有真实样张（样张来自设计系统，而这套风格覆盖了它的配色与字体），缩略图位置用这套风格
 * 自己的三枚色块画一张配色示意；按描述建、没有色块的，写「按描述生成」而不是编一组颜色。
 */
export function PersonalStyleCard({ style, selected, onSelect, onEdit, onDelete }: PersonalStyleCardProps) {
  const selection = personalSelection(style);
  const [ink, paper, accent] = style.swatches.length === 3 ? style.swatches : [];
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(selection)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(selection);
        }
      }}
      className="group flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl p-2 text-left outline-none transition-colors hover-bg-soft"
      style={{
        border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
        boxShadow: selected ? '0 0 0 1px var(--accent-primary)' : undefined,
        background: 'var(--bg-card)',
      }}
      data-style-key={selection.key}
      data-style-kind="personal"
    >
      <div className="relative">
        <div
          className="flex w-full flex-col justify-center gap-1.5 overflow-hidden rounded-[10px] px-[12%]"
          style={{
            aspectRatio: '1200 / 760',
            background: paper ?? 'var(--bg-tertiary)',
            border: '1px solid var(--border-subtle)',
          }}
          role="img"
          aria-label={ink ? `${style.name}的配色示意` : `${style.name}按描述生成，没有色块`}
        >
          {ink ? (
            <>
              <span className="h-2 w-2/3 rounded-sm" style={{ background: ink }} />
              <span className="h-1 w-5/6 rounded-sm opacity-60" style={{ background: ink }} />
              <span className="h-1 w-3/4 rounded-sm opacity-60" style={{ background: ink }} />
              <span className="mt-1 h-2.5 w-1/4 rounded-sm" style={{ background: accent }} />
            </>
          ) : (
            <span className="text-center text-[11px] text-token-muted">按描述生成，无色块</span>
          )}
        </div>
        <span
          className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
        >
          我的
        </span>
        {selected && (
          <span
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
            aria-hidden
          >
            <Check size={12} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-1 px-0.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-token-primary">{style.name}</span>
          <span className="line-clamp-2 text-[11px] leading-snug text-token-muted">{style.instruction}</span>
          {!style.baseDesignSystemAvailable && (
            <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--semantic-warning-text)' }}>
              <AlertTriangle size={11} />骨架已下线，编辑换一个
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`编辑${style.name}`}
            title="编辑 / 重命名"
            onClick={(event) => { stop(event); onEdit(); }}
            onKeyDown={stop}
            className="rounded p-1 text-token-muted hover-bg-soft"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            aria-label={`删除${style.name}`}
            title="删除"
            onClick={(event) => { stop(event); onDelete(); }}
            onKeyDown={stop}
            className="rounded p-1 text-token-muted hover-bg-soft"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-[13px] font-semibold text-token-primary">{title}</h3>
      <span className="text-[11px] text-token-muted">{hint}</span>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-2 rounded-xl p-2" style={{ border: '1px solid var(--border-subtle)' }} aria-hidden>
      <div className="w-full rounded-[10px]" style={{ aspectRatio: '1200 / 760', background: 'var(--bg-tertiary)' }} />
      <div className="h-3 w-1/2 rounded-sm" style={{ background: 'var(--bg-tertiary)' }} />
      <div className="h-2.5 w-4/5 rounded-sm" style={{ background: 'var(--bg-tertiary)' }} />
    </div>
  );
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]" role="alert" style={{ border: '1px solid var(--border-subtle)', color: 'var(--semantic-danger-text)' }}>
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-token-secondary hover-bg-soft">
        <RotateCw size={12} />重试
      </button>
    </div>
  );
}
