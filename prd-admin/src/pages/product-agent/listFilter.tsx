/**
 * 产品管理智能体 — 列表通用筛选 / 搜索（需求 / 功能 / 缺陷复用）。
 *
 * 客户端在已加载列表上过滤（每产品 ≤200 条，即时）。能力：
 *  - 常驻关键词搜索（匹配编号/标题/描述等，由调用方 keywordOf 提供）；
 *  - 任意「单选下拉」筛选字段（选项基于当前列表去重生成，由调用方 fields 提供）；
 *  - 用户自定义显示哪些筛选项（齿轮设置），按列表类型存 localStorage（纯 UI 偏好）。
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';

/** 与 ProductsSection 搜索框同宽（跨产品列表工具栏 SSOT） */
export const OVERVIEW_LIST_SEARCH_BOX =
  'flex flex-1 min-w-[280px] max-w-xl items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 h-8 transition-colors focus-within:border-cyan-500/40 focus-within:bg-white/[0.07]';

export interface FilterFieldDef<T> {
  key: string;
  label: string;
  /** 基于当前列表去重生成可选项 */
  options: (items: T[]) => Array<{ value: string; label: string }>;
  /** 选中某值时的过滤判定 */
  test: (item: T, value: string) => boolean;
  /** 是否默认展示（核心字段） */
  defaultVisible?: boolean;
}

function loadVisible<T>(storageKey: string, fields: FilterFieldDef<T>[]): string[] {
  const allKeys = fields.map((f) => f.key);
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const arr = (JSON.parse(raw) as string[]).filter((k) => allKeys.includes(k));
      if (arr.length > 0) return arr;
    }
  } catch {
    /* ignore */
  }
  return fields.filter((f) => f.defaultVisible).map((f) => f.key);
}

export function useListFilter<T>(opts: {
  items: T[];
  storageKey: string;
  fields: FilterFieldDef<T>[];
  keywordOf: (item: T) => string;
  keywordPlaceholder?: string;
  /** 是否显示「筛选设置」齿轮（跨产品需求等固定筛选项场景可关闭） */
  showFilterSettings?: boolean;
  /** 搜索框外层 class（默认窄 w-44；跨产品总览传 OVERVIEW_LIST_SEARCH_BOX） */
  searchBoxClassName?: string;
  /** 筛选项右侧附加控件（如「追踪」切换） */
  trailing?: ReactNode;
  /** 是否在工具栏末尾展示「命中数/总数」（总览宽工具栏默认关闭，列表区另有统计） */
  showResultCount?: boolean;
}): { bar: ReactNode; filtered: T[]; activeCount: number } {
  const {
    items,
    storageKey,
    fields,
    keywordOf,
    keywordPlaceholder,
    showFilterSettings = true,
    searchBoxClassName,
    trailing,
    showResultCount = !searchBoxClassName,
  } = opts;
  const [kw, setKw] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<string[]>(() => loadVisible(storageKey, fields));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(visible));
    } catch {
      /* ignore */
    }
  }, [storageKey, visible]);

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return items.filter((it) => {
      if (q && !keywordOf(it).toLowerCase().includes(q)) return false;
      for (const f of fields) {
        const v = values[f.key];
        if (v && !f.test(it, v)) return false;
      }
      return true;
    });
  }, [items, kw, values, fields, keywordOf]);

  const setValue = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));
  const reset = () => {
    setKw('');
    setValues({});
  };
  const activeCount = Object.values(values).filter(Boolean).length + (kw.trim() ? 1 : 0);

  const bar = (
    <FilterBar
      items={items}
      fields={fields}
      visible={visible}
      setVisible={setVisible}
      values={values}
      setValue={setValue}
      kw={kw}
      setKw={setKw}
      keywordPlaceholder={keywordPlaceholder}
      reset={reset}
      activeCount={activeCount}
      resultCount={filtered.length}
      total={items.length}
      showFilterSettings={showFilterSettings}
      searchBoxClassName={searchBoxClassName}
      trailing={trailing}
      showResultCount={showResultCount}
    />
  );

  return { bar, filtered, activeCount };
}

function FilterBar<T>({
  items,
  fields,
  visible,
  setVisible,
  values,
  setValue,
  kw,
  setKw,
  keywordPlaceholder,
  reset,
  activeCount,
  resultCount,
  total,
  showFilterSettings,
  searchBoxClassName,
  trailing,
  showResultCount,
}: {
  items: T[];
  fields: FilterFieldDef<T>[];
  visible: string[];
  setVisible: Dispatch<SetStateAction<string[]>>;
  values: Record<string, string>;
  setValue: (k: string, v: string) => void;
  kw: string;
  setKw: (v: string) => void;
  keywordPlaceholder?: string;
  reset: () => void;
  activeCount: number;
  resultCount: number;
  total: number;
  showFilterSettings: boolean;
  searchBoxClassName?: string;
  trailing?: ReactNode;
  showResultCount: boolean;
}) {
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement>(null);
  const [gearPos, setGearPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!gearOpen) return;
    // 弹层用 createPortal 挂 body + fixed 定位，避免被工具栏容器 overflow 裁剪（用户反馈：筛选展开看不到）
    const anchorAtBtn = () => {
      const btn = gearRef.current?.querySelector('button');
      if (btn) {
        const r = btn.getBoundingClientRect();
        setGearPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
      }
    };
    anchorAtBtn();
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (gearRef.current && !gearRef.current.contains(target) && !(target as HTMLElement).closest?.('[data-filter-gear-pop]')) setGearOpen(false);
    };
    // 外层滚动会让 fixed 定位失锚 → 关闭；但弹层自身的内部滚动列表（filter 字段过多时）必须保留
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (t as HTMLElement).nodeType === 1 && (t as HTMLElement).closest?.('[data-filter-gear-pop]')) return;
      setGearOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGearOpen(false); };
    const onResize = () => setGearOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [gearOpen]);

  const visibleFields = fields.filter((f) => visible.includes(f.key));
  const selectCls =
    'h-8 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 px-2 outline-none focus:border-cyan-500/40 max-w-[220px]';
  const toggle = (k: string) =>
    setVisible((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const wideSearch = Boolean(searchBoxClassName);

  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${wideSearch ? 'flex-nowrap' : 'flex-wrap'}`}>
      {wideSearch ? (
        <div className={searchBoxClassName}>
          <Search size={14} className="shrink-0 text-white/35" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder={keywordPlaceholder ?? '搜索…'}
            className="min-w-0 flex-1 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/35"
          />
        </div>
      ) : (
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/35 pointer-events-none" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder={keywordPlaceholder ?? '搜索…'}
            className="h-8 w-44 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 pl-7 pr-2 outline-none focus:border-cyan-500/40"
          />
        </div>
      )}
      {visibleFields.map((f) => {
        const opts = f.options(items);
        return (
          <select
            key={f.key}
            value={values[f.key] ?? ''}
            onChange={(e) => setValue(f.key, e.target.value)}
            className={selectCls}
            title={f.label}
          >
            <option value="">{f.label}：全部</option>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      })}
      {trailing}
      {activeCount > 0 && (
        <button
          onClick={reset}
          className="h-8 flex items-center gap-1 px-2 rounded-lg text-xs text-white/45 hover:text-white/80 hover:bg-white/5"
          title="清空筛选"
        >
          <X size={12} /> 清空({activeCount})
        </button>
      )}
      {showFilterSettings && (
        <div ref={gearRef} className="relative">
          <button
            onClick={() => setGearOpen((v) => !v)}
            className="h-8 flex items-center gap-1 px-2 rounded-lg border border-white/10 text-xs text-white/55 hover:text-white hover:bg-white/5"
            title="筛选设置：选择显示哪些筛选项"
          >
            <SlidersHorizontal size={13} /> 筛选设置
          </button>
          {gearOpen && gearPos && createPortal(
            <div
              data-filter-gear-pop
              className="fixed z-[10000] w-52 rounded-lg border border-white/10 bg-[#16171c] p-2 shadow-2xl"
              style={{ top: gearPos.top, right: gearPos.right, overscrollBehavior: 'contain' }}
            >
              <div className="text-[11px] text-white/40 px-1 pb-1">显示哪些筛选项</div>
              <div className="max-h-72 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {fields.map((f) => (
                  <label
                    key={f.key}
                    className="flex items-center gap-2 px-1 py-1 rounded hover:bg-white/5 cursor-pointer text-xs text-white/75"
                  >
                    <input
                      type="checkbox"
                      checked={visible.includes(f.key)}
                      onChange={() => toggle(f.key)}
                      className="accent-cyan-500"
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>,
            document.body,
          )}
        </div>
      )}
      {showResultCount && (
        <span className="text-[11px] text-white/30 ml-auto shrink-0">
          {resultCount}/{total}
        </span>
      )}
    </div>
  );
}

// ── 字段配置助手 ─────────────────────────────────────────

/** 单值字段去重选项（如 处理人/负责人/状态） */
export function distinctOptions<T>(
  items: T[],
  getId: (it: T) => string | null | undefined,
  getLabel: (id: string) => string,
): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const it of items) {
    const id = getId(it);
    if (id) seen.set(id, getLabel(id));
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

/** 多值字段去重选项（如 关联版本/关联客户/实现需求） */
export function distinctMultiOptions<T>(
  items: T[],
  getIds: (it: T) => string[],
  getLabel: (id: string) => string,
): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const it of items) for (const id of getIds(it)) if (id) seen.set(id, getLabel(id));
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

export const TIME_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'm', label: '本月' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
];

/** 时间预设判定：m=本自然月，7/30=最近 N 天 */
export function inTimeRange(dateStr: string | null | undefined, preset: string): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const t = d.getTime();
  if (Number.isNaN(t)) return false;
  const now = new Date();
  if (preset === 'm') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  const days = preset === '7' ? 7 : preset === '30' ? 30 : 0;
  if (!days) return true;
  return t >= now.getTime() - days * 86400000;
}
