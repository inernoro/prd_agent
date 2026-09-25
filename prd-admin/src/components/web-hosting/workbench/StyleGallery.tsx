import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Palette, RotateCw } from 'lucide-react';
import { getDesignGenerationSettings, type DesignGenerationStyle } from '@/services/real/webPages';
import {
  listDesignSystems,
  type DesignSystemCatalog,
  type DesignSystemItem,
} from '@/services/real/designSystems';
import { StyleThumbnail } from './StyleThumbnail';

/**
 * 风格画廊（受控）：管理员配置的预设风格在前（真实缩略图 + 名称 + 一句话），
 * 下面「更多风格」按分类折叠浏览 OpenDesign 的全部设计系统，最后一张是「做一个我的风格」入口。
 *
 * 每张缩略图都是该风格真实样张的缩小版（StyleThumbnail），分类默认折叠、缩略图进入视口才加载，
 * 一百五十多套设计系统不会一次性全渲染。
 */

/** 选中的是哪一套：管理员预设（生成时按 styleId 冻结）或目录里的某个设计系统。 */
export type StyleGallerySelection =
  | { kind: 'preset'; key: string; styleId: string; designSystemId: string; name: string }
  | { kind: 'design-system'; key: string; designSystemId: string; name: string };

/** 目录项的选择键加前缀，避免与预设的 styleId 撞名（预设 editorial 与设计系统 editorial 是两回事）。 */
export const DESIGN_SYSTEM_KEY_PREFIX = 'design-system:';

export function presetSelection(style: DesignGenerationStyle): StyleGallerySelection {
  return { kind: 'preset', key: style.id, styleId: style.id, designSystemId: style.designSystemId, name: style.name };
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
  /** 当前选中项的 key（预设为 styleId，目录项为 `design-system:<id>`）；null 表示未选。 */
  selectedId: string | null;
  onSelect: (selection: StyleGallerySelection) => void;
  /** 样张大标题，通常是用户正在生成的网页标题。 */
  title?: string;
  /** 点「做一个我的风格」时调用；本期只是入口，由调用方决定怎么处理。 */
  onRequestCustomStyle: () => void;
}

export function StyleGallery({ selectedId, onSelect, title, onRequestCustomStyle }: StyleGalleryProps) {
  const [presets, setPresets] = useState<Loadable<DesignGenerationStyle[]>>({ status: 'loading' });
  const [catalog, setCatalog] = useState<Loadable<DesignSystemCatalog>>({ status: 'loading' });
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPresets({ status: 'loading' });
    setCatalog({ status: 'loading' });
    void getDesignGenerationSettings().then((res) => {
      if (cancelled) return;
      setPresets(res.success
        ? { status: 'ready', data: res.data.styles.filter((style) => style.enabled) }
        : { status: 'failed', message: res.error?.message || '预设风格没有读出来，请稍后重试。' });
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

      <CustomStyleCard onRequest={onRequestCustomStyle} />
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
  badge: '即将支持',
  description: '按你的品牌规范或参考页面生成一套自己的风格。这个能力还没有上线，现在还不能用。',
} as const;

export function CustomStyleCard({ onRequest }: { onRequest: () => void }) {
  return (
    <button
      type="button"
      onClick={onRequest}
      className="flex items-center gap-3 rounded-xl p-3 text-left hover-bg-soft"
      style={{ border: '1px dashed var(--border-default)' }}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
        <Palette size={18} className="text-token-secondary" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-token-primary">{CUSTOM_STYLE_CARD_TEXT.title}</span>
          <span className="rounded-md px-1.5 py-0.5 text-[11px] text-token-muted" style={{ background: 'var(--bg-tertiary)' }}>
            {CUSTOM_STYLE_CARD_TEXT.badge}
          </span>
        </span>
        <span className="text-[11px] leading-snug text-token-muted">{CUSTOM_STYLE_CARD_TEXT.description}</span>
      </span>
    </button>
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
