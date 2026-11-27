/**
 * 风格（模板）选择。风格库按「画面像什么」分 15 类，共 99 种（Lemo-Opuscar 的分类与风格）。
 * 两个入口选同一个状态：
 * - 输入框里的风格按钮：就地弹出，按类别或名字找，选完回到输入，不离开对话；
 * - 右栏的风格库：看大图、样片说明和全部风格，适合第一次挑。
 * 风格说明（给智能体的英文 STYLE.md）只按编号引用，界面不显示原文。
 */
import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, PanelRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StyleFrame } from './TemplateFrames';
import type { OutputKind, QcTemplate, QcTemplateCategory, QcTemplateSource } from './types';
import { formatClock } from './format';

const ALL = 'all';

function useStyleFilter(templates: QcTemplate[], categories: QcTemplateCategory[]) {
  const [category, setCategory] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const catName = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories]);
  const q = query.trim().toLowerCase();
  const list = templates.filter(t => (category === ALL || t.categoryId === category)
    && (!q || [t.name, t.nameEn, t.id, catName.get(t.categoryId) ?? ''].some(v => v.toLowerCase().includes(q))));
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    templates.forEach(t => m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + 1));
    return m;
  }, [templates]);
  return { category, setCategory, query, setQuery, list, counts, catName };
}

function SearchBox({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-token-muted" aria-hidden />
      <label htmlFor={id} className="sr-only">搜索风格</label>
      <input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder="搜风格名或类别，如：水墨、蓝图、像素"
        className="h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] pl-8 pr-8 text-[13px] text-token-primary outline-none placeholder:text-token-muted focus:border-[color:var(--accent-primary)] max-md:h-11" />
      {value && (
        <button type="button" aria-label="清空搜索" onClick={() => onChange('')} className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-token-muted hover-bg-soft max-md:h-11 max-md:w-11">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** 类别：一行横向滚动，「全部」在最前，每类带数量 */
function CategoryRow({ categories, counts, total, value, onChange }: {
  categories: QcTemplateCategory[]; counts: Map<string, number>; total: number; value: string; onChange: (id: string) => void;
}) {
  const item = (id: string, label: string, n: number) => (
    <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)} data-category={id}
      className={cn('inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[12px] transition-colors max-md:h-11',
        value === id ? 'border-[color:var(--accent-primary)] bg-[var(--selection-bg)] font-medium text-token-primary' : 'border-token-subtle text-token-secondary hover-bg-soft')}>
      {label}<span className="tabular-nums text-token-muted">{n}</span>
    </button>
  );
  return (
    <div role="radiogroup" aria-label="风格类别" className="flex gap-1.5 overflow-x-auto pb-1 pr-6"
      style={{ scrollbarWidth: 'thin', maskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)', WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)' }}>
      {item(ALL, '全部', total)}
      {categories.map(c => item(c.id, c.name, counts.get(c.id) ?? 0))}
    </div>
  );
}

/** 输入框里的风格按钮 + 就地弹出的选择面板 */
export function StylePickerChip({ templates, categories, selected, onSelect, onBrowse }: {
  templates: QcTemplate[];
  categories: QcTemplateCategory[];
  selected?: QcTemplate;
  onSelect: (id: string) => void;
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const f = useStyleFilter(templates, categories);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" data-qc="style-chip" data-template={selected?.id ?? ''} aria-label={`风格：${selected?.name ?? '未选'}，点此更换`}
          className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg pl-1 pr-1.5 text-[12px] text-token-primary hover-bg-soft max-md:h-11">
          {selected && <span className="w-7 shrink-0 overflow-hidden rounded-[4px]"><StyleFrame template={{ ...selected, frame: undefined }} /></span>}
          <span className="min-w-0 truncate">{selected?.name ?? '选风格'}</span>
          <ChevronDown size={13} className="shrink-0 text-token-muted" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} data-qc="style-popover"
          className="z-[110] flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-2.5 shadow-lg"
          style={{ width: 'min(440px, calc(100vw - 24px))', maxHeight: 'min(520px, var(--radix-popover-content-available-height))' }}>
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[13px] font-semibold text-token-primary">选风格</span>
            <span className="text-[11.5px] text-token-muted">{categories.length} 类 · {templates.length} 种</span>
          </div>
          <div className="flex items-center gap-1.5"><SearchBox id="qc-style-search-pop" value={f.query} onChange={f.setQuery} /></div>
          <div className="mt-2"><CategoryRow categories={categories} counts={f.counts} total={templates.length} value={f.category} onChange={f.setCategory} /></div>
          <div role="radiogroup" aria-label="选择风格" className="mt-1.5 grid min-h-0 flex-1 grid-cols-2 content-start gap-1 overflow-y-auto pr-0.5" style={{ overscrollBehavior: 'contain' }}>
            {f.list.map(t => {
              const on = t.id === selected?.id;
              return (
                <button key={t.id} type="button" role="radio" aria-checked={on} data-style={t.id}
                  onClick={() => { onSelect(t.id); setOpen(false); }}
                  className={cn('flex min-w-0 items-center gap-2 rounded-lg p-1.5 text-left max-md:min-h-11', on ? 'bg-[var(--selection-bg)]' : 'hover-bg-soft')}>
                  <span className="w-14 shrink-0 overflow-hidden rounded-[5px]"><StyleFrame template={{ ...t, frame: undefined }} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-token-primary">{t.name}</span>
                    <span className="block truncate text-[11px] text-token-muted">{f.catName.get(t.categoryId)}</span>
                  </span>
                  {on && <Check size={13} className="shrink-0 text-[color:var(--accent-primary)]" aria-hidden />}
                </button>
              );
            })}
            {!f.list.length && <div className="col-span-2 p-4 text-center text-[12.5px] text-token-muted">没有匹配的风格，换个词或选「全部」</div>}
          </div>
          <button type="button" onClick={() => { setOpen(false); onBrowse(); }}
            className="mt-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border-t border-token-subtle pt-1 text-[12px] text-token-secondary hover:text-token-primary max-md:h-11">
            <PanelRight size={13} aria-hidden />看大图和样片说明
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 右栏的风格库：上方是选中风格的大图与说明，下方按类别浏览全部风格 */
export function StyleLibrary({ templates, categories, source, selected, onSelect, kind }: {
  templates: QcTemplate[];
  categories: QcTemplateCategory[];
  source?: QcTemplateSource;
  selected: QcTemplate;
  onSelect: (id: string) => void;
  kind: OutputKind;
}) {
  const f = useStyleFilter(templates, categories);
  return (
    <div className="h-full overflow-y-auto" style={{ overscrollBehavior: 'contain' }} data-qc="template-preview">
      <section className="grid gap-4 p-2.5 sm:p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:p-5" aria-label="当前风格">
        <div key={selected.id} className="qc-rise self-start overflow-hidden rounded-[12px] border border-token-subtle shadow-[var(--shadow-card-sm)]">
          <StyleFrame template={{ ...selected, frame: undefined }} />
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 text-[12px] text-token-muted">
            <span className="rounded-full bg-[var(--bg-tertiary)] px-2 leading-[22px] text-token-secondary">{selected.categoryId} · {f.catName.get(selected.categoryId)}</span>
            <span>No.{templates.findIndex(t => t.id === selected.id) + 1}</span>
          </div>
          <div className="mt-2 text-[20px] font-semibold leading-7 text-token-primary">{selected.name}</div>
          <div className="text-[12.5px] text-token-muted">{selected.nameEn}</div>
          <div className="mt-3 text-[13px] leading-6 text-token-secondary">
            <span className="font-medium text-token-primary">样片《{selected.film}》</span> · {formatClock(selected.durationSec)}
            <p className="m-0 mt-1">{selected.line}</p>
          </div>
          <div className="mt-3 rounded-[10px] bg-[var(--bg-secondary)] px-3 py-2.5 text-[12.5px] leading-5 text-token-secondary">
            {kind === 'video'
              ? '生成时，智能体按这个风格的风格说明用代码逐帧画出成片；内容、配音和字幕来自你的稿件。'
              : '生成网页时，按这个风格的配色、字体与版式出页面；内容来自你的稿件。'}
            {selected.needsImageTool && <span className="mt-1 block" style={{ color: 'var(--accent-fg-warning)' }}>这个风格的人物要用生图工具另外画，生成前会先确认。</span>}
          </div>
          {source && <div className="mt-auto pt-3 text-[11px] leading-4 text-token-muted">风格分类与样片：{source.name} · {source.posterLicense}</div>}
        </div>
      </section>
      <div className="sticky top-0 z-10 border-y border-token-subtle bg-[var(--bg-card)] px-2.5 pb-1.5 pt-2.5 sm:px-4 lg:px-5">
        <div className="flex items-center gap-2">
          <SearchBox id="qc-style-search" value={f.query} onChange={f.setQuery} />
          <span className="shrink-0 text-[12px] tabular-nums text-token-muted">{f.list.length} 种</span>
        </div>
        <div className="mt-2"><CategoryRow categories={categories} counts={f.counts} total={templates.length} value={f.category} onChange={f.setCategory} /></div>
      </div>
      <div role="radiogroup" aria-label="选择模板" className="grid grid-cols-2 gap-3 p-2.5 sm:grid-cols-3 sm:p-4 lg:p-5 2xl:grid-cols-4">
        {f.list.map(t => {
          const on = t.id === selected.id;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => onSelect(t.id)} data-template={t.id}
              className={cn('group flex flex-col overflow-hidden rounded-[12px] border bg-[var(--bg-input)] text-left transition-[border-color,box-shadow]',
                on ? 'border-[color:var(--accent-primary)] shadow-[0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle hover:border-[var(--border-default)]')}>
              <span className="relative block"><StyleFrame template={{ ...t, frame: undefined }} />
                {on && <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-[color:var(--accent-on-primary)]"><Check size={12} strokeWidth={3} aria-hidden /></span>}
              </span>
              <span className="block px-2.5 py-2">
                <span className="block truncate text-[13px] font-medium text-token-primary">{t.name}</span>
                <span className="block truncate text-[11.5px] text-token-muted">{f.catName.get(t.categoryId)} · {formatClock(t.durationSec)} 样片</span>
              </span>
            </button>
          );
        })}
        {!f.list.length && <div className="col-span-full p-8 text-center text-[13px] text-token-muted">没有匹配的风格，换个词或选「全部」</div>}
      </div>
    </div>
  );
}

