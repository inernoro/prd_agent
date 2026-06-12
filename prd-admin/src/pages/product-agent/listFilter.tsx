/**
 * 产品管理智能体 — 列表通用筛选 / 搜索（需求 / 功能 / 缺陷复用）。
 *
 * 客户端在已加载列表上过滤（每产品 ≤200 条，即时）。能力：
 *  - 常驻关键词搜索（匹配编号/标题/描述等，由调用方 keywordOf 提供）；
 *  - 任意「单选下拉」筛选字段（选项基于当前列表去重生成，由调用方 fields 提供）；
 *  - 用户自定义显示哪些筛选项（齿轮设置），按列表类型存 localStorage（纯 UI 偏好）。
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';

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
}): { bar: ReactNode; filtered: T[]; activeCount: number } {
  const { items, storageKey, fields, keywordOf, keywordPlaceholder, showFilterSettings = true } = opts;
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
}) {
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gearOpen) return;
    const h = (e: MouseEvent) => {
      if (gearRef.current && !gearRef.current.contains(e.target as Node)) setGearOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [gearOpen]);

  const visibleFields = fields.filter((f) => visible.includes(f.key));
  const selectCls =
    'h-8 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 px-2 outline-none focus:border-cyan-500/40 max-w-[170px]';
  const toggle = (k: string) =>
    setVisible((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/35 pointer-events-none" />
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder={keywordPlaceholder ?? '搜索…'}
          className="h-8 w-44 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 pl-7 pr-2 outline-none focus:border-cyan-500/40"
        />
      </div>
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
          {gearOpen && (
            <div className="absolute z-50 right-0 mt-1 w-48 rounded-lg border border-white/10 bg-[#16171c] p-2 shadow-xl">
              <div className="text-[11px] text-white/40 px-1 pb-1">显示哪些筛选项</div>
              <div className="max-h-64 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
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
            </div>
          )}
        </div>
      )}
      <span className="text-[11px] text-white/30 ml-auto shrink-0">
        {resultCount}/{total}
      </span>
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
