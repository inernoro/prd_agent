import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { FilePreview } from '@/components/file-preview';
import {
  FolderOpen, FolderClosed, Star, Rss, Github,
  Search, ChevronRight, ChevronDown, Plus, Pin, PinOff,
  ToggleLeft, ToggleRight, Trash2, FilePlus, FolderPlus,
  Upload, Link, LayoutTemplate, Bot, Pencil, Save, X,
  Sparkles, Wand2, Tags, Replace, BookOpen, Settings, Share2, ExternalLink, Copy,
} from 'lucide-react';
import { parseFrontmatter } from '@/lib/frontmatter';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import { getVerdictConfig } from '@/lib/acceptanceVerdictRegistry';
import { getTagColor, truncateTagDisplay, TAG_PALETTE, type TagColorKey } from '@/lib/tagPalette';

// Tag 颜色覆盖：用户在编辑器里手动选的颜色，sessionStorage 全局共享
// （后端持久化作为 follow-up，先确保 UI 路径走通）
const TagColorsContext = createContext<{
  colors: Record<string, TagColorKey>;
  setColor: (tag: string, color: TagColorKey | undefined) => void;
}>({ colors: {}, setColor: () => {} });

// Finder 风格颜色选择圆点（编辑器内点击 tag 时弹出）
function TagColorSwatchPicker({
  current,
  onPick,
}: {
  current: TagColorKey;
  onPick: (color: TagColorKey | undefined) => void;
}) {
  const order: TagColorKey[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'];
  return (
    <div
      className="surface-popover absolute z-[80] mt-1 flex items-center gap-1.5 rounded-full px-2 py-1.5"
      style={{ left: 0, top: '100%', boxShadow: '0 4px 16px rgba(0,0,0,0.18)' }}
      onClick={(e) => e.stopPropagation()}
    >
      {order.map(k => {
        const spec = TAG_PALETTE[k];
        const selected = k === current;
        return (
          <button
            key={k}
            onClick={() => onPick(k)}
            title={spec.label}
            className="rounded-full cursor-pointer transition-transform hover:scale-110"
            style={{
              width: 16,
              height: 16,
              background: spec.dot,
              border: selected ? '2px solid #fff' : '2px solid transparent',
              boxShadow: selected ? `0 0 0 1.5px ${spec.dot}` : 'none',
            }}
          />
        );
      })}
      <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)', margin: '0 2px' }} />
      <button
        onClick={() => onPick(undefined)}
        title="重置为默认（哈希自动色）"
        className="text-[10px] text-token-muted cursor-pointer hover:text-token-secondary"
      >
        默认
      </button>
    </div>
  );
}

// 编辑器内的 tag chip：显示当前色 + 点击切换颜色（弹 7 色圆点）+ 删除按钮
function TagPickerChip({ tag, onRemove }: { tag: string; onRemove: () => void }) {
  const { colors, setColor } = useContext(TagColorsContext);
  const [picking, setPicking] = useState(false);
  const c = getTagColor(tag, colors);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picking) return;
    const handler = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [picking]);

  return (
    <span ref={pickerRef} className="relative inline-flex items-center">
      <span
        onClick={(e) => { e.stopPropagation(); setPicking(v => !v); }}
        className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium cursor-pointer"
        style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
        title="点击换颜色"
      >
        # {tag}
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 flex cursor-pointer items-center justify-center"
          title="移除">
          <X size={10} />
        </button>
      </span>
      {picking && (
        <TagColorSwatchPicker
          current={c.key}
          onPick={(k) => { setColor(tag, k); setPicking(false); }}
        />
      )}
    </span>
  );
}

// 条目行内 tag 小药丸（按名字排序后前 max 个完整渲染 + 多余折叠 +N），颜色读 Context 覆盖。
// max 随侧栏宽度自适应（拖宽后展示更多，不再一律压缩成 +N）。点击药丸 = 按该标签筛选（onToggleTag），
// 与顶部筛选条共用同一份 selectedTags 状态（SSOT）。
function TagRowChips({ tags, onToggleTag, activeTags, max = 2 }: { tags: string[]; onToggleTag?: (tag: string) => void; activeTags?: Set<string>; max?: number }) {
  const { colors } = useContext(TagColorsContext);
  // 标签按名字从左到右排序（中文走本地化 collation）；先排再 slice，保证可见的 N 个与 +N 都基于排序结果
  const sorted = useMemo(() => [...tags].sort((a, b) => a.localeCompare(b, 'zh')), [tags]);
  const visibleCount = Math.max(1, max);
  return (
    <span className="inline-flex items-center gap-[3px] min-w-0">
      {/* 可见 tag 放进 overflow-hidden 内层：单行、超宽裁切；+N 作为外层兄弟恒可见 */}
      <span className="inline-flex items-center gap-[3px] min-w-0 overflow-hidden">
      {sorted.slice(0, visibleCount).map(t => {
        const c = getTagColor(t, colors);
        const active = activeTags?.has(t) ?? false;
        return (
          <span
            key={t}
            role={onToggleTag ? 'button' : undefined}
            onClick={onToggleTag ? (e) => { e.stopPropagation(); onToggleTag(t); } : undefined}
            className={`text-[9px] px-1.5 rounded-full tabular-nums flex-shrink-0 ${onToggleTag ? 'cursor-pointer' : ''}`}
            style={{
              height: 15, lineHeight: '15px', background: c.bg, color: c.text,
              border: `1px solid ${active ? c.text : c.border}`,
              boxShadow: active ? `0 0 0 1px ${c.border}` : 'none',
            }}
            title={onToggleTag ? `#${t} · 点击${active ? '取消筛选' : '按此标签筛选'}` : `#${t}`}
          >
            {truncateTagDisplay(t, visibleCount > 2 ? 6 : 2)}
          </span>
        );
      })}
      </span>
      {sorted.length > visibleCount && (
        <span
          className="text-[9px] tabular-nums flex-shrink-0"
          style={{ color: 'var(--text-muted)', opacity: 0.7 }}
          title={sorted.slice(visibleCount).map(tag => `#${tag}`).join(' ')}
        >
          +{sorted.length - visibleCount}
        </span>
      )}
    </span>
  );
}

// 阅读进度条：贴阅读区顶部，随正文滚动推进（纯展示，不挡点击）。
// key 绑 selectedEntryId，切换文档时重新挂载归零重算；内容尺寸变化用 ResizeObserver 兜底。
function ReadingProgressBar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      setPct(max > 4 ? Math.min(100, Math.max(0, (el.scrollTop / max) * 100)) : 0);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [scrollRef]);
  if (pct <= 0) return null;
  return (
    <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, zIndex: 5, pointerEvents: 'none' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent-primary, #818cf8)', opacity: 0.9, transition: 'width .08s linear', borderRadius: '0 2px 2px 0' }} />
    </div>
  );
}

// 顶部标签筛选下拉：标签过多时收进一个"标签筛选"下拉按钮，点开弹出长方形面板多选筛选（createPortal 防裁剪）。
function TagFilterDropdown({
  tags, selected, colors, onToggle, onClear,
}: {
  tags: string[];
  selected: Set<string>;
  colors: Record<string, TagColorKey>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-tagfilter-pop]') || t.closest('[data-tagfilter-trigger]')) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const toggleOpen = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 240) });
    setOpen(o => !o);
  };

  const shown = kw.trim() ? tags.filter(t => t.toLowerCase().includes(kw.trim().toLowerCase())) : tags;

  return (
    <>
      <button
        ref={triggerRef}
        data-tagfilter-trigger
        onClick={toggleOpen}
        className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] px-2 rounded-full cursor-pointer transition-colors"
        style={{
          height: 22, lineHeight: '22px',
          color: selected.size > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          background: selected.size > 0 ? 'var(--accent-soft, rgba(129,140,248,0.12))' : 'var(--bg-input)',
          border: '1px solid var(--border-faint)',
        }}
        title="按标签筛选（多选取并集；再次点击取消）"
      >
        <Tags size={12} />
        标签筛选{selected.size > 0 ? ` · ${selected.size}` : ''}
        <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {selected.size > 0 && (
        <button
          onClick={onClear}
          className="flex-shrink-0 inline-flex items-center gap-0.5 text-[9.5px] px-1.5 rounded-full cursor-pointer"
          style={{ height: 20, lineHeight: '20px', color: 'var(--text-muted)', background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
          title="清空筛选"
        >
          <X size={9} /> 清空
        </button>
      )}
      {open && pos && createPortal(
        <div
          data-tagfilter-pop
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxWidth: 360,
            maxHeight: 320, overflowY: 'auto', overscrollBehavior: 'contain',
            zIndex: 10000, borderRadius: 10, padding: 10,
            background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
          }}
        >
          {tags.length > 12 && (
            <div className="flex items-center gap-1.5 mb-2 px-2 rounded-md" style={{ height: 28, background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
              <Search size={12} style={{ color: 'var(--text-muted)' }} />
              <input
                value={kw}
                onChange={e => setKw(e.target.value)}
                autoFocus
                placeholder="搜索标签…"
                className="flex-1 bg-transparent outline-none text-[11px]"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {shown.map(tag => {
              const c = getTagColor(tag, colors);
              const active = selected.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => onToggle(tag)}
                  className="text-[10px] px-2 rounded-full cursor-pointer font-medium transition-all"
                  style={{
                    height: 22, lineHeight: '22px',
                    color: active ? '#fff' : c.text,
                    background: active ? c.dot : c.bg,
                    border: `1px solid ${active ? c.dot : c.border}`,
                  }}
                  title={`#${tag}`}
                >
                  {truncateTagDisplay(tag, 10)}
                </button>
              );
            })}
            {shown.length === 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无匹配标签</span>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { motion } from 'motion/react';
import ShinyText from '@/components/reactbits/ShinyText';
import { systemDialog } from '@/lib/systemDialog';
import { useViewTracking } from '@/lib/useViewTracking';
import { useContentSelection, type ContentSelectionInfo } from '@/lib/useContentSelection';
import { MessageSquareText, MessageSquarePlus, Check, ChevronLeft } from 'lucide-react';
import { InlineCommentDrawer, type PendingSelection } from '@/pages/document-store/InlineCommentDrawer';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { AcceptanceEvidenceGraph } from './AcceptanceEvidenceGraph';
import { Workflow } from 'lucide-react';
import { listInlineComments } from '@/services';
import { DocToc } from './DocToc';
import { DocEmptyState } from './DocEmptyState';
import { InlineCommentOverlay } from './InlineCommentOverlay';
import { BulkActionBar } from './BulkActionBar';

// ── 类型 ──

export type EntryPreview = {
  /** 文本内容（Markdown/纯文本/提取后的 Office 文本） */
  text: string | null;
  /** 二进制文件 URL（图片/视频/音频/PDF 等） */
  fileUrl: string | null;
  /** MIME 类型 */
  contentType: string;
};

export type DocBrowserEntry = {
  id: string;
  title: string;
  parentId?: string;
  isFolder: boolean;
  sourceType: string;
  contentType: string;
  fileSize: number;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  updatedByName?: string;
  summary?: string;
  syncStatus?: string;
  /** 是否暂停（订阅类型） */
  isPaused?: boolean;
  /** 最近一次"内容真正发生变化"的时间，用于显示 (new) 徽标 */
  lastChangedAt?: string;
  metadata?: Record<string, string>;
};

/**
 * 目录排序模式：
 * - 'default'：置顶 → 文件夹 → 主文档 → 按标题升序（用于编辑场景，结构稳定）
 * - 'created-desc'：置顶 → 文件夹 → 按创建时间倒序（用于阅读/分享场景，新内容先看到）
 * - 'updated-desc'：置顶 → 文件夹 → 按更新时间倒序
 */
export type DocBrowserSortMode = 'default' | 'created-desc' | 'updated-desc';

export type DocBrowserProps = {
  entries: DocBrowserEntry[];
  primaryEntryId?: string;
  pinnedEntryIds?: string[];
  selectedEntryId?: string;
  onSelectEntry: (entryId: string) => void;
  onSetPrimary?: (entryId: string) => void;
  onTogglePin?: (entryId: string, pin: boolean) => void;
  onDeleteEntry?: (entryId: string) => void;
  /** 阅读区「返回」：提供则在阅读头显示返回按钮（如返回当前空间的文档列表）。不传不显示。 */
  onBackToList?: () => void;
  onUpdateEntryTags?: (entryId: string, tags: string[]) => Promise<void>;
  /** 重命名条目（修改 title）。提供时右键菜单会出现"重命名"项。 */
  onRenameEntry?: (entryId: string, newTitle: string) => Promise<void>;
  onMoveEntry?: (entryId: string, targetFolderId: string | null) => void;
  onSaveContent?: (entryId: string, content: string) => Promise<void>;
  onCreateFolder?: (name: string, parentId?: string) => Promise<void>;
  onCreateDocument?: () => void;
  onUploadFile?: () => void;
  /**
   * 加载文档预览数据。
   * 返回包含文本内容 + 二进制文件 URL + MIME 类型的对象，
   * 由 DocBrowser 根据 fileTypeRegistry 的 preview 字段选择渲染方式。
   */
  loadContent: (entryId: string) => Promise<EntryPreview | null>;
  onSearch?: (keyword: string, searchContent: boolean) => Promise<DocBrowserEntry[] | null>;
  /** 点击订阅条目右侧的状态徽标时触发，用于打开订阅详情面板 */
  onOpenSubscription?: (entryId: string) => void;
  /** 点击"生成字幕"时触发（仅 audio/video/image entries 显示） */
  onGenerateSubtitle?: (entryId: string) => void;
  /** 点击"再加工"时触发（仅 text entries 显示） */
  onReprocess?: (entryId: string) => void;
  /** 点击"分享"时触发（仅文档条目显示），分享单篇文档 */
  onShareEntry?: (entryId: string) => void;
  /** 指定后：当该 entry 被选中且内容加载完成时自动进入编辑态（新建文档免再点一次「编辑」） */
  autoEditEntryId?: string;
  /** autoEdit 已被消费的回调（清除一次性标记） */
  onAutoEditConsumed?: () => void;
  /** 点击"替换文件"时触发（仅文件条目显示）。原地替换内容，保留 Id/标签/主文档。 */
  onReplaceFile?: (entryId: string) => void;
  /** 正在再加工的源文档 → 进度(0-100)。提供时对应行显示"加工中 N%"chip。 */
  reprocessingMap?: Record<string, number>;
  /** 已被「单篇分享」的文档 id 集合。命中的行显示黄色"已分享"标识（点击可查看/复制链接）。 */
  sharedEntryIds?: Set<string>;
  emptyState?: React.ReactNode;
  loading?: boolean;
  /** 目录排序模式，默认 'default'（置顶+folder+主文档+标题）。阅读/分享场景建议 'created-desc'。 */
  sortMode?: DocBrowserSortMode;
  /**
   * "显示更新时间"的默认值（仅在用户未显式切换过开关时生效）。
   * 默认 true：时间默认显示（用户反馈要求），且时间永远固定在每行最右边。
   * 用户手动开/关后以其 sessionStorage 选择为准。
   */
  showUpdatedTimeDefault?: boolean;
  /**
   * 分享视图传入分享 token，用于私有库读取划词评论气泡（PR #685 Codex P1）。
   * 后端凭此 token 验证调用方确实通过有效分享访问，而非靠"存在分享链"放行。
   * 私人编辑场景（DocumentStorePage）不需要传，走 owner 身份读评论。
   */
  inlineCommentShareToken?: string;
  /**
   * 外观：
   * - 'inset'：默认，单容器无 gap（知识库 / 分享页，连续阅读体验）
   * - 'cards'：左右两个独立圆角卡片 + 12px gap（更新中心-周报，强分区视觉）
   */
  appearance?: 'inset' | 'cards';
  /**
   * 自定义"新鲜"判定（控制条目右侧 NEW 徽章）。
   * 不传时走默认规则（lastChangedAt < 24h）。
   * 更新中心-周报传入「自上次查看以来 cutoff」规则。
   */
  isEntryFresh?: (entry: DocBrowserEntry) => boolean;
  /**
   * 左侧 sidebar 顶部自定义头部内容（搜索框上方）。
   * 用于显示「周报列表 · 按最近提交 · N 篇」这类列表标题 + 计数。
   * 不传则不渲染。
   */
  sidebarHeader?: React.ReactNode;
  /**
   * 用户自定义 tag 颜色映射（tagName → 调色板 key）。
   * 不传时回退到 sessionStorage（仅本 tab）；传入时持久化由调用方负责（onTagColorsChange）。
   */
  tagColors?: Record<string, TagColorKey>;
  onTagColorsChange?: (next: Record<string, TagColorKey>) => void;
};

// ── (new) 徽标判定：lastChangedAt 在 24 小时以内 ──
function isRecentlyChanged(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 24 * 60 * 60 * 1000;
}

// ── 时间分组桶：created-desc / updated-desc 模式下按时间给条目分组（今天/昨天/本周/本月/更早） ──
export function timeBucket(iso: string | undefined, now: number): { key: string; label: string } {
  if (!iso) return { key: 'none', label: '未知时间' };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { key: 'none', label: '未知时间' };
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (t >= startMs) return { key: 'today', label: '今天' };
  if (t >= startMs - day) return { key: 'yesterday', label: '昨天' };
  if (t >= startMs - 7 * day) return { key: 'week', label: '本周' };
  if (t >= startMs - 30 * day) return { key: 'month', label: '本月' };
  return { key: 'earlier', label: '更早' };
}

// 列表渲染项（条目 / 时间分组头）
export type DocBrowserDisplayItem =
  | { kind: 'entry'; entry: DocBrowserEntry }
  | { kind: 'header'; bucketKey: string; label: string; count: number };

// 把根级条目构造为渲染项序列：groupByTime 时按时间桶插入分组头（文件夹不参与分组，遇文件夹重置桶边界）。
// 纯函数便于单测；传 now 固定"今天"基准。
export function buildDisplayItems(
  roots: DocBrowserEntry[],
  opts: { groupByTime: boolean; timeField: 'createdAt' | 'updatedAt'; now?: number },
): DocBrowserDisplayItem[] {
  if (!opts.groupByTime) return roots.map(e => ({ kind: 'entry', entry: e }));
  const now = opts.now ?? Date.now();
  const items: DocBrowserDisplayItem[] = [];
  let lastKey: string | null = null;
  let headerIdx = -1; // 当前连续段分组头在 items 中的下标，用于回填本段（非全库）条数
  for (const e of roots) {
    if (e.isFolder) { items.push({ kind: 'entry', entry: e }); lastKey = null; headerIdx = -1; continue; }
    const b = timeBucket(e[opts.timeField], now);
    if (b.key !== lastKey) {
      headerIdx = items.length;
      items.push({ kind: 'header', bucketKey: b.key, label: b.label, count: 0 });
      lastKey = b.key;
    }
    items.push({ kind: 'entry', entry: e });
    // 文件夹会重置桶边界（同一桶可能被拆成多段），count 只数本段、不数全库——
    // 否则被文件夹拆开的同名桶头都显示全库总数（Bugbot Medium「Time header count not sectional」）
    const h = items[headerIdx];
    if (h && h.kind === 'header') h.count += 1;
  }
  return items;
}

// ── 文件图标（所有类型映射通过 FILE_TYPE_REGISTRY 注册表） ──

function EntryIcon({ entry, isPrimary, isPinned, isOpen }: { entry: DocBrowserEntry; isPrimary: boolean; isPinned: boolean; isOpen?: boolean }) {
  if (entry.isFolder) {
    return isOpen
      ? <FolderOpen size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />
      : <FolderClosed size={14} style={{ color: 'rgba(234,179,8,0.6)' }} />;
  }
  if (isPrimary) return <Star size={14} style={{ color: 'rgba(234,179,8,0.85)' }} />;
  if (isPinned) return <Pin size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
  if (entry.sourceType === 'github_directory') return <Github size={14} style={{ color: 'rgba(130,80,223,0.7)' }} />;
  // 订阅源图标弱化为中性灰：整库都是订阅源时，金色 RSS 每条都亮太啰嗦；保留波浪形状区分类型即可
  if (entry.sourceType === 'subscription') return <Rss size={14} style={{ color: 'var(--text-muted)' }} />;

  // 通过注册表按文件名/MIME 类型查找对应图标
  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const Icon = cfg.icon;
  return <Icon size={14} style={{ color: cfg.color }} />;
}

// ── 获取文档显示标题 ──
function getDisplayTitle(entry: DocBrowserEntry, useContentTitle: boolean, contentFirstLines: Map<string, string>): string {
  if (entry.isFolder) return entry.title;
  if (!useContentTitle) return entry.title;
  const firstLine = contentFirstLines.get(entry.id);
  if (firstLine) return firstLine;
  return entry.title;
}

// ── 判断 entry 可以发起的 Agent 操作 ──
function canGenerateSubtitle(entry: DocBrowserEntry): boolean {
  if (entry.isFolder) return false;
  const ct = (entry.contentType ?? '').toLowerCase();
  return ct.startsWith('audio/') || ct.startsWith('video/') || ct.startsWith('image/');
}

function canReprocess(entry: DocBrowserEntry): boolean {
  if (entry.isFolder) return false;
  // Reference 类条目（如"转存自网页托管"）只在 metadata 里存了 sourceUrl，
  // 本地既无 documentId 也无 attachmentId，后端 ContentReprocessProcessor
  // 在读 sourceContent 时拿不到正文会抛 "源文档无正文可供再加工"。
  // 既然必失败，直接在 UI 隐藏入口，避免误触 + 浪费一次 Run。
  if ((entry.sourceType ?? '') === 'reference' && entry.metadata?.sourceUrl) return false;
  const ct = (entry.contentType ?? '').toLowerCase();
  // 文字类（markdown / 字幕 / 纯文本 / JSON / YAML 等）才能再加工
  return ct.startsWith('text/') || ct.includes('markdown') || ct === '';
}

function formatMetaTime(iso?: string): string {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── 右键/⋯ 菜单 ──
function ContextMenu({
  x, y, entry, isPrimary, isPinned,
  onSetPrimary, onTogglePin, onDelete, onEditTags, onRename,
  onGenerateSubtitle, onReprocess, onShareEntry, onReplaceFile,
  onClose,
}: {
  x: number;
  y: number;
  entry: DocBrowserEntry;
  isPrimary: boolean;
  isPinned: boolean;
  onSetPrimary?: (entryId: string) => void;
  onTogglePin?: (entryId: string, pin: boolean) => void;
  onDelete?: (entryId: string) => void;
  onEditTags?: (entry: DocBrowserEntry) => void;
  onRename?: (entry: DocBrowserEntry) => void;
  onGenerateSubtitle?: (entryId: string) => void;
  onReprocess?: (entryId: string) => void;
  onShareEntry?: (entryId: string) => void;
  onReplaceFile?: (entryId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const showSubtitle = canGenerateSubtitle(entry) && !!onGenerateSubtitle;
  const showReprocess = canReprocess(entry) && !!onReprocess;
  const showShare = !entry.isFolder && !!onShareEntry;

  // 只读项（即使所有写回调都为空也始终可用）：
  // - 在新窗口打开（只有非文件夹有效）
  // - 复制条目链接（带 ?entry=ID 高亮）
  // 这两条在 share readonly 模式下也保证菜单有内容,不再是空壳。
  const showOpenInNewWindow = !entry.isFolder;
  const showCopyEntryLink = !entry.isFolder;

  // createPortal 挂 body + z-[10000]：合规 frontend-modal 规则;
  // 旧版 z-50 会被 modal/drawer (z-[100]~z-[10000]) 盖住;且祖先 overflow:hidden 会裁剪。
  const menu = (
    <div ref={menuRef} className="surface-popover fixed z-[10000] min-w-[170px] rounded-[10px] py-1" style={{ left: x, top: y }}>
      {showOpenInNewWindow && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => {
            // 当前页 URL 上换 ?entry={id}，方便对方/自己分享/记忆条目锚点
            const u = new URL(window.location.href);
            u.searchParams.set('entry', entry.id);
            window.open(u.toString(), '_blank', 'noopener');
            onClose();
          }}>
          <ExternalLink size={12} />
          在新窗口打开
        </button>
      )}
      {showCopyEntryLink && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => {
            const u = new URL(window.location.href);
            u.searchParams.set('entry', entry.id);
            navigator.clipboard.writeText(u.toString()).catch(() => {});
            onClose();
          }}>
          <Copy size={12} />
          复制条目链接
        </button>
      )}
      {(showOpenInNewWindow || showCopyEntryLink) && (showSubtitle || showReprocess || showShare || onRename || onTogglePin || onEditTags || onSetPrimary || onReplaceFile || onDelete) && (
        <div className="my-1 border-t border-token-subtle" />
      )}
      {showSubtitle && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onGenerateSubtitle!(entry.id); onClose(); }}>
          <Sparkles size={12} />
          生成字幕
        </button>
      )}
      {showReprocess && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onReprocess!(entry.id); onClose(); }}>
          <Wand2 size={12} />
          智能体
        </button>
      )}
      {showShare && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onShareEntry!(entry.id); onClose(); }}>
          <Share2 size={12} />
          分享
        </button>
      )}
      {(showSubtitle || showReprocess || showShare) && (
        <div className="my-1 border-t border-token-subtle" />
      )}
      {onRename && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onRename(entry); onClose(); }}>
          <Pencil size={12} />
          重命名
        </button>
      )}
      {!entry.isFolder && onTogglePin && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onTogglePin(entry.id, !isPinned); onClose(); }}>
          {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
          {isPinned ? '取消置顶' : '置顶文档'}
        </button>
      )}
      {!entry.isFolder && onEditTags && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onEditTags(entry); onClose(); }}>
          <Tags size={12} />
          打标签
        </button>
      )}
      {!entry.isFolder && onSetPrimary && !isPrimary && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onSetPrimary(entry.id); onClose(); }}>
          <Star size={12} />
          设为主文档
        </button>
      )}
      {!entry.isFolder
        && entry.sourceType !== 'subscription'
        && entry.sourceType !== 'github_directory'
        && onReplaceFile && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onReplaceFile(entry.id); onClose(); }}>
          <Replace size={12} />
          替换文件
        </button>
      )}
      {onDelete && (
        <>
          <div className="my-1 border-t border-token-subtle" />
          <button
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-error transition-colors hover:bg-white/6"
            onClick={() => { onDelete(entry.id); onClose(); }}>
            <Trash2 size={12} />
            删除
          </button>
        </>
      )}
    </div>
  );

  // createPortal 到 document.body,避免被祖先 overflow:hidden 裁剪 / 被低 z-index 容器盖住
  return createPortal(menu, document.body);
}

function EntryTagEditor({
  entry,
  onClose,
  onSave,
}: {
  entry: DocBrowserEntry;
  onClose: () => void;
  onSave: (tags: string[]) => Promise<void>;
}) {
  const [tags, setTags] = useState<string[]>(entry.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/^#/, '');
    if (!trimmed) return;
    if (trimmed.length > 20) { setError('单个标签最多 20 个字'); return; }
    if (tags.includes(trimmed)) { setTagInput(''); return; }
    if (tags.length >= 10) { setError('最多 10 个标签'); return; }
    setError('');
    setTags(prev => [...prev, trimmed]);
    setTagInput('');
  }, [tags]);

  const removeTag = useCallback((target: string) => {
    setTags(prev => prev.filter(tag => tag !== target));
    setError('');
  }, []);

  const handleTagKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }, [addTag, removeTag, tagInput, tags]);

  const handleSave = useCallback(async () => {
    const pending = tagInput.trim().replace(/^#/, '');
    if (pending.length > 20) { setError('单个标签最多 20 个字'); return; }
    const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    if (finalTags.length > 10) { setError('最多 10 个标签'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(finalTags);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [onClose, onSave, tagInput, tags]);

  return (
    <div className="surface-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[440px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Tags size={14} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-token-primary">
                文档标签
              </div>
              <div className="truncate text-[11px] text-token-muted">
                {entry.title}
              </div>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">
            标签 <span className="text-[10px] text-token-muted">（回车或逗号分隔，最多 10 个；点击标签可换颜色）</span>
          </label>
          <div
            className="prd-field flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] px-2 py-1.5">
            {tags.map(tag => (
              <TagPickerChip key={tag} tag={tag} onRemove={() => removeTag(tag)} />
            ))}
            <input
              autoFocus
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? '如：架构、需求、API' : ''}
              className="h-6 min-w-[80px] flex-1 bg-transparent text-[12px] text-token-primary outline-none"
            />
          </div>
        </div>

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="surface-action h-8 cursor-pointer rounded-[8px] px-3 text-[12px] font-semibold">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="surface-action-accent h-8 cursor-pointer rounded-[8px] px-3 text-[12px] font-semibold disabled:opacity-60">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 重命名条目对话框 ──

function EntryRenameDialog({
  entry,
  onClose,
  onSave,
}: {
  entry: DocBrowserEntry;
  onClose: () => void;
  onSave: (newTitle: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(entry.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 打开后聚焦并选中整个标题，方便直接覆盖输入
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(t);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) { setError('标题不能为空'); return; }
    if (trimmed === entry.title) { onClose(); return; }
    if (trimmed.length > 200) { setError('标题不超过 200 字'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [entry.title, onClose, onSave, title]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleSave, onClose]);

  return (
    <div className="surface-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[440px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Pencil size={14} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-token-primary">重命名</div>
              <div className="truncate text-[11px] text-token-muted">{entry.title}</div>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">新标题</label>
          <div className="prd-field flex items-center rounded-[10px] px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (error) setError(''); }}
              onKeyDown={handleKeyDown}
              maxLength={200}
              placeholder="输入新标题"
              className="h-6 w-full bg-transparent text-[13px] text-token-primary outline-none"
            />
          </div>
          {error && <p className="mt-1.5 text-[11px]" style={{ color: '#ef4444' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="h-8 px-4 rounded-[8px] text-[12px] text-token-secondary transition-colors duration-200 hover:bg-white/6">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="h-8 px-4 rounded-[8px] text-[12px] font-medium surface-action-primary inline-flex items-center gap-1.5 disabled:opacity-50">
            {saving ? <MapSpinner size={12} /> : <Save size={12} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 树节点递归组件 ──

function TreeNode({
  entry,
  childrenMap,
  depth,
  selectedEntryId,
  primaryEntryId,
  pinnedEntryIds,
  folderPrimaryMap,
  expandedFolders,
  useContentTitle,
  showUpdatedTime,
  timeField,
  contentFirstLines,
  contentMatchIds,
  reprocessingMap,
  sharedEntryIds,
  onToggleFolder,
  onSelectEntry,
  onContextMenu,
  onShareEntry,
  onMoveEntry,
  onOpenSubscription,
  isEntryFresh,
  onToggleTag,
  activeTags,
  tagMax,
  selectedIds,
  onToggleSelect,
  selectionActive,
}: {
  entry: DocBrowserEntry;
  childrenMap: Map<string, DocBrowserEntry[]>;
  depth: number;
  selectedEntryId?: string;
  isEntryFresh?: (entry: DocBrowserEntry) => boolean;
  primaryEntryId?: string;
  pinnedEntryIds: Set<string>;
  folderPrimaryMap: Map<string, string>;
  expandedFolders: Set<string>;
  useContentTitle: boolean;
  showUpdatedTime: boolean;
  timeField: 'createdAt' | 'updatedAt';
  contentFirstLines: Map<string, string>;
  contentMatchIds: Set<string>;
  reprocessingMap?: Record<string, number>;
  sharedEntryIds?: Set<string>;
  onToggleFolder: (id: string) => void;
  onSelectEntry: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: DocBrowserEntry) => void;
  onShareEntry?: (entryId: string) => void;
  onMoveEntry?: (entryId: string, targetFolderId: string | null) => void;
  onOpenSubscription?: (entryId: string) => void;
  onToggleTag?: (tag: string) => void;
  activeTags?: Set<string>;
  tagMax?: number;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  selectionActive?: boolean;
}) {
  const isFolder = entry.isFolder;
  const isOpen = expandedFolders.has(entry.id);
  const isSelected = entry.id === selectedEntryId;
  const isPrimary = entry.id === primaryEntryId || (entry.parentId ? folderPrimaryMap.get(entry.parentId) === entry.id : false);
  const isPinned = pinnedEntryIds.has(entry.id);
  const children = childrenMap.get(entry.id) ?? [];
  const displayTitle = getDisplayTitle(entry, useContentTitle, contentFirstLines);
  const reprocessing = !isFolder ? reprocessingMap?.[entry.id] : undefined;
  const isChecked = !isFolder && (selectedIds?.has(entry.id) ?? false);
  const isShared = !isFolder && (sharedEntryIds?.has(entry.id) ?? false);
  const [dragOver, setDragOver] = useState(false);

  // 是否需要渲染右上角徽章行
  const verdictForRow = !isFolder ? getVerdictConfig(entry.metadata?.verdict) : null;
  const isFreshForRow = !isFolder && (isEntryFresh ? isEntryFresh(entry) : isRecentlyChanged(entry.lastChangedAt));
  const isContentMatch = !isFolder && contentMatchIds.has(entry.id);
  // 订阅状态点只在「非健康」（暂停/同步中/出错）时才占徽章行：健康（已同步）不画绿点，
  // 否则每条都顶一个绿点、副行只剩这一个点显得空旷。健康订阅条目因此回落为单行紧凑布局。
  const isSubscriptionAbnormal = !isFolder && entry.sourceType === 'subscription'
    && (!!entry.isPaused || entry.syncStatus === 'syncing' || entry.syncStatus === 'error');
  const isSubscriptionDot = isSubscriptionAbnormal && !!onOpenSubscription;
  const hasTags = !isFolder && (entry.tags?.length ?? 0) > 0;
  const hasBadgeRow =
    !isFolder && (
      isShared || reprocessing !== undefined || !!verdictForRow ||
      hasTags || isContentMatch ||
      isSubscriptionDot || isPrimary || (isPinned && !isPrimary)
    );


  return (
    <>
      <button
        data-entry-id={entry.id}
        onClick={() => {
          if (isFolder) onToggleFolder(entry.id);
          else onSelectEntry(entry.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, entry);
        }}
        draggable={!isFolder}
        onDragStart={(e) => {
          if (isFolder) return;
          e.dataTransfer.setData('text/plain', entry.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          setDragOver(false);
          const draggedId = e.dataTransfer.getData('text/plain');
          if (draggedId && draggedId !== entry.id && onMoveEntry) {
            onMoveEntry(draggedId, entry.id);
          }
        }}
        className={`relative flex flex-col justify-center text-left cursor-pointer transition-all duration-150 group ${isFolder ? 'py-[7px]' : 'gap-1 py-[8px] hover-bg-soft'}`}
        style={{
          // 整块圆角高亮：左右留 6px 内缩，hover/选中不贴边。
          // 宽度扣掉左右 12px 外边距，避免 w-full(100%)+margin 超出容器、撑出横向滚动条。
          width: 'calc(100% - 12px)',
          paddingLeft: `${10 + depth * 14}px`,
          paddingRight: '10px',
          marginLeft: '6px',
          marginRight: '6px',
          // 非文件夹条目固定 minHeight，避免「有 badges 的两层 vs 无 badges 的单行」导致列表高度跳变
          minHeight: isFolder ? undefined : 44,
          // 仅在拖拽/选中时显式给背景，未高亮时留空让 hover-bg-soft 类的 :hover 生效
          background: dragOver
            ? 'var(--accent-soft, rgba(99,102,241,0.14))'
            : (isSelected && !isFolder
                ? 'var(--accent-soft, rgba(99,102,241,0.10))'
                : undefined),
          outline: dragOver ? '1px dashed var(--accent-primary, var(--accent-gold))' : 'none',
          // 文件夹「章节分组」标题：上方单条细分隔线 + 克制留白，更接近文档站目录观感
          ...(isFolder
            ? {
                marginTop: depth === 0 ? '8px' : '4px',
                borderTop: '1px solid var(--border-faint)',
                borderRadius: 0,
              }
            : {
                borderRadius: '9px',
                // 条目之间一条淡分隔线（内缩对齐圆角块），让两行布局下相邻条目不糊在一起
                borderBottom: '1px solid var(--border-faint)',
              }),
        }}
        title={isFolder ? '点击展开/折叠（可拖拽文件到此）' : isPrimary ? '主文档' : '右键打开菜单'}
      >
        {/* 左侧状态色条：验收结论 → 绿/琥珀/红竖条，整列向下一扫即知通过率分布（颜色 + 文字双编码，满足无障碍） */}
        {verdictForRow && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full"
            style={{ width: '3px', height: '64%', background: verdictForRow.color, opacity: isSelected ? 1 : 0.9 }}
          />
        )}
        {/* 选中态：圆角块内侧细 accent 条（无验收色条时才显示，避免与状态色条重叠） */}
        {isSelected && !isFolder && !verdictForRow && (
          <span
            aria-hidden
            className="absolute left-[3px] top-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: '3px',
              height: '60%',
              background: 'var(--accent-primary, var(--accent-gold))',
              opacity: 0.85,
            }}
          />
        )}
        {/* 第一行：图标 + 标题独占整行（标题增强：更亮更粗略放大），徽章移到第二行，避免挤占标题宽度 */}
        <div className="flex items-center gap-2 w-full min-w-0">
          {/* 批量多选勾选框：仅文件，hover 或已进入多选态时显示；点击只切换选择不打开文档 */}
          {!isFolder && onToggleSelect && (
            <span
              role="checkbox"
              aria-checked={isChecked}
              onClick={(e) => { e.stopPropagation(); onToggleSelect(entry.id); }}
              className={`flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-opacity ${isChecked || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              style={{
                width: 15, height: 15, borderRadius: 4,
                border: `1.5px solid ${isChecked ? 'var(--accent-primary, #818cf8)' : 'var(--border-strong, rgba(255,255,255,0.28))'}`,
                background: isChecked ? 'var(--accent-primary, #818cf8)' : 'transparent',
              }}
              title={isChecked ? '取消选择' : '选择（批量操作）'}
            >
              {isChecked && <Check size={10} style={{ color: '#fff' }} />}
            </span>
          )}
          <EntryIcon entry={entry} isPrimary={isPrimary} isPinned={isPinned} isOpen={isOpen} />

          {/* 非文件夹标题不再 flex-1 撑满：取自然宽度，让 NEW 紧贴标题末尾（时间靠 ml-auto 顶右） */}
          <span className={`${isFolder ? 'flex-1 ' : ''}truncate min-w-0`}
            style={{
              color: isFolder ? 'var(--text-muted)' : 'var(--text-primary)',
              fontWeight: isFolder ? 600 : (isSelected ? 700 : 600),
              fontSize: isFolder ? '10.5px' : '13px',
              letterSpacing: isFolder ? '0.06em' : '-0.01em',
              textTransform: isFolder ? 'uppercase' : 'none',
            }}>
            {displayTitle}
          </span>

          {/* NEW 与标题同行、贴标题末尾：标题过长截断时与标题一起省略，并与右侧时间归为"近期"信号 */}
          {isFreshForRow && (
            <span
              className="text-[9px] px-1.5 rounded-full flex-shrink-0 font-bold"
              style={{ height: 15, lineHeight: '15px', background: 'rgba(34,197,94,0.12)', letterSpacing: '0.3px' }}
              title={`最近更新: ${entry.lastChangedAt ? new Date(entry.lastChangedAt).toLocaleString('zh-CN') : ''}`}
            >
              <ShinyText text="NEW" speed={2.4} color="rgba(74,222,128,0.95)" shineColor="rgba(255,255,255,0.95)" spread={120} />
            </span>
          )}

          {/* 文件夹的计数 + 折叠箭头（第一行右侧） */}
          {isFolder && (
            <span className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                {children.length}
              </span>
              {isOpen
                ? <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
                : <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />}
            </span>
          )}

          {/* 无徽章行时：时间紧贴标题右侧，避免出现空旷的第二行 */}
          {!isFolder && !hasBadgeRow && showUpdatedTime && entry[timeField] && (
            <span className="flex-shrink-0 ml-auto" style={{ paddingLeft: '6px', opacity: 0.6 }}>
              <RelativeTime
                value={entry[timeField]!}
                refreshIntervalMs={0}
                className="text-[9.5px] tabular-nums text-token-muted"
                title={`${timeField === 'createdAt' ? '创建于' : '最后更新'}：${new Date(entry[timeField]!).toLocaleString('zh-CN')}${timeField === 'updatedAt' && entry.updatedByName ? ` · ${entry.updatedByName}` : ''}`}
              />
            </span>
          )}
        </div>

        {/* 第二行：徽章（左对齐，tag 按名字排序）+ 时间（右对齐）。仅非文件夹且有徽章时渲染，缩进对齐标题下方 */}
        {hasBadgeRow && (
        <div className="flex items-center gap-1.5 w-full" style={{ paddingLeft: '22px' }}>
        {/* 已分享：icon-only 节省宽度，hover/点击复用原行为 */}
        {isShared && (
          <span
            onClick={onShareEntry ? (e) => { e.stopPropagation(); onShareEntry(entry.id); } : undefined}
            className="flex-shrink-0 cursor-pointer"
            style={{ color: 'rgba(234,179,8,0.85)' }}
            title="已分享 · 点击查看或复制链接"
          >
            <Share2 size={11} />
          </span>
        )}

        {/* 再加工进行中：保留文字让用户看进度 */}
        {!isFolder && reprocessing !== undefined && (
          <span
            className="inline-flex items-center gap-1 text-[9px] px-1.5 rounded-full flex-shrink-0 font-semibold tabular-nums"
            style={{
              height: 15,
              lineHeight: '15px',
              background: 'rgba(59,130,246,0.12)',
              color: 'rgba(96,165,250,0.95)',
            }}
            title="智能体处理中"
          >
            <MapSpinner size={9} />
            {Math.round(reprocessing)}%
          </span>
        )}

        {/* 验收结论：保留小药丸（"通过 L1" 是关键扫读信号） */}
        {!isFolder && (() => {
          const vc = getVerdictConfig(entry.metadata?.verdict);
          if (!vc) return null;
          const tier = entry.metadata?.tier;
          return (
            <span
              className="text-[9px] px-1.5 rounded-full flex-shrink-0 font-bold tabular-nums"
              style={{ height: 15, lineHeight: '15px', background: vc.background, color: vc.color, border: vc.border }}
              title={`验收结论：${vc.label}${tier ? ` · 档位 ${tier}` : ''}`}
            >
              {vc.label}{tier ? ` ${tier}` : ''}
            </span>
          );
        })()}

        {/* tag：每个 tag 一个小药丸，颜色走 tagPalette + 用户覆盖；点击按该标签筛选 */}
        {!isFolder && (entry.tags?.length ?? 0) > 0 && (
          <TagRowChips tags={entry.tags!} onToggleTag={onToggleTag} activeTags={activeTags} max={tagMax} />
        )}

        {/* 内容命中标记 */}
        {!isFolder && contentMatchIds.has(entry.id) && (
          <span
            className="text-[9px] px-1.5 rounded-full flex-shrink-0"
            style={{
              height: 15,
              lineHeight: '15px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-muted)',
              letterSpacing: '0.2px',
            }}
            title="该文件因正文内容命中而被搜出（标题未含关键词）"
          >
            内容包含
          </span>
        )}

        {/* 订阅状态点：仅非健康（暂停/同步中/出错）才显示；健康已同步不画点（去重复绿点） */}
        {isSubscriptionAbnormal && onOpenSubscription && (
          <span
            onClick={(e) => { e.stopPropagation(); onOpenSubscription(entry.id); }}
            className="flex-shrink-0 cursor-pointer"
            title={
              entry.isPaused ? '订阅已暂停（点击查看详情）'
              : entry.syncStatus === 'syncing' ? '同步中（点击查看详情）'
              : entry.syncStatus === 'error' ? '同步出错（点击查看详情）'
              : '订阅源（点击查看详情）'
            }
          >
            <span
              className="block w-1.5 h-1.5 rounded-full"
              style={{
                background: entry.isPaused ? 'rgba(148,163,184,0.7)'
                  : entry.syncStatus === 'syncing' ? 'rgba(96,165,250,0.85)'
                  : entry.syncStatus === 'error' ? 'rgba(248,113,113,0.85)'
                  : 'rgba(74,222,128,0.85)',
                boxShadow: entry.syncStatus === 'syncing' ? '0 0 6px rgba(96,165,250,0.6)' : 'none',
              }}
            />
          </span>
        )}

        {/* README / Pin 简化为 icon */}
        {!isFolder && isPrimary && (
          <span className="flex-shrink-0" title="主文档（README）" style={{ color: 'rgba(234,179,8,0.85)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em' }}>
            README
          </span>
        )}

        {isPinned && !isPrimary && (
          <Pin size={10} className="flex-shrink-0" style={{ color: 'rgba(59,130,246,0.5)' }} />
        )}
        {/* 时间：第二行右对齐，跟随排序键显示 createdAt 或 updatedAt */}
        {showUpdatedTime && entry[timeField] && (
          <span className="ml-auto flex-shrink-0" style={{ opacity: 0.65 }}>
            <RelativeTime
              value={entry[timeField]!}
              refreshIntervalMs={0}
              className="text-[9.5px] tabular-nums text-token-muted"
              title={`${timeField === 'createdAt' ? '创建于' : '最后更新'}：${new Date(entry[timeField]!).toLocaleString('zh-CN')}${timeField === 'updatedAt' && entry.updatedByName ? ` · ${entry.updatedByName}` : ''}`}
            />
          </span>
        )}
        </div>
        )}
      </button>

      {/* 子节点 */}
      {isFolder && isOpen && children.map(child => (
        <TreeNode
          key={child.id}
          entry={child}
          childrenMap={childrenMap}
          depth={depth + 1}
          selectedEntryId={selectedEntryId}
          primaryEntryId={primaryEntryId}
          pinnedEntryIds={pinnedEntryIds}
          folderPrimaryMap={folderPrimaryMap}
          expandedFolders={expandedFolders}
          useContentTitle={useContentTitle}
          showUpdatedTime={showUpdatedTime}
          timeField={timeField}
          contentFirstLines={contentFirstLines}
          contentMatchIds={contentMatchIds}
          reprocessingMap={reprocessingMap}
          sharedEntryIds={sharedEntryIds}
          onToggleFolder={onToggleFolder}
          onSelectEntry={onSelectEntry}
          onContextMenu={onContextMenu}
          onShareEntry={onShareEntry}
          onMoveEntry={onMoveEntry}
          onOpenSubscription={onOpenSubscription}
          isEntryFresh={isEntryFresh}
          onToggleTag={onToggleTag}
          activeTags={activeTags}
          tagMax={tagMax}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          selectionActive={selectionActive}
        />
      ))}
    </>
  );
}

// ── 面包屑 ──

function Breadcrumbs({ entryId, entries }: { entryId: string; entries: DocBrowserEntry[] }) {
  const entryMap = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);

  const path = useMemo(() => {
    const result: DocBrowserEntry[] = [];
    let current = entryMap.get(entryId);
    if (!current) return result;
    result.unshift(current);
    while (current?.parentId) {
      const parent = entryMap.get(current.parentId);
      if (!parent) break;
      result.unshift(parent);
      current = parent;
    }
    return result;
  }, [entryId, entryMap]);

  // 2026-05-28 用户两次反馈："标题重复显示像 bug"。
  // 第一次修复改成小灰字字号(11px)，但文件名 + markdown H1 内容仍 99% 重合。
  // 第二次彻底修：单级路径(就是文件本身,没有父文件夹)直接不渲染面包屑——
  // 因为 markdown H1 已经是"我是什么文档"的清晰锚点，重复显示无收益。
  // 仅在多级路径(有父文件夹层级)时才渲染面包屑，作为"我在哪"的位置指示。
  if (path.length <= 1) return null;

  // 多级路径：仍是小灰字，作为位置指示。最后一段(文件名本身)用 truncate +
  // max-w 避免吃掉过多空间。
  return (
    <div className="flex items-center gap-1 text-[11px] min-w-0" style={{ color: 'var(--text-muted)' }}>
      {path.map((entry, i) => (
        <span key={entry.id} className="flex items-center gap-1 min-w-0">
          {i > 0 && <ChevronRight size={10} className="flex-shrink-0" style={{ color: 'var(--text-muted)', opacity: 0.6 }} />}
          <span className="truncate" title={entry.title} style={i === path.length - 1 ? { maxWidth: '320px' } : undefined}>
            {entry.title}
          </span>
        </span>
      ))}
    </div>
  );
}

// ── DocBrowser 主组件 ──

export function DocBrowser({
  entries,
  primaryEntryId,
  pinnedEntryIds: pinnedIds = [],
  selectedEntryId,
  onSelectEntry,
  onSetPrimary,
  onTogglePin,
  onDeleteEntry,
  onBackToList,
  onUpdateEntryTags,
  onRenameEntry,
  onMoveEntry,
  onSaveContent,
  loadContent,
  onCreateFolder,
  onCreateDocument,
  onUploadFile,
  onSearch,
  onOpenSubscription,
  onGenerateSubtitle,
  onReprocess,
  onShareEntry,
  autoEditEntryId,
  onAutoEditConsumed,
  onReplaceFile,
  reprocessingMap,
  sharedEntryIds,
  emptyState,
  loading,
  sortMode = 'default',
  showUpdatedTimeDefault = true,
  appearance = 'inset',
  isEntryFresh,
  sidebarHeader,
  tagColors: tagColorsProp,
  onTagColorsChange,
  inlineCommentShareToken,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<DocBrowserEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  // 内容加载缓存键：以 entryId + updatedAt 组合作内容版本，替换文件后 updatedAt 变化即触发重载
  const [loadedContentKey, setLoadedContentKey] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [useContentTitle, setUseContentTitle] = useState(true);
  const [showUpdatedTime, setShowUpdatedTime] = useState<boolean>(() => {
    const saved = sessionStorage.getItem('doc-browser-show-updated-time');
    if (saved === '1') return true;
    if (saved === '0') return false;
    return showUpdatedTimeDefault; // 用户未显式选择时走调用方默认（验收库默认显示时间）
  });
  // 列表时间显示哪个字段：跟随排序键，避免"按创建排序却显更新时间"的错位。
  const timeField: 'createdAt' | 'updatedAt' = sortMode === 'created-desc' ? 'createdAt' : 'updatedAt';
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [contentFirstLines, setContentFirstLines] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DocBrowserEntry } | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [tagEditEntry, setTagEditEntry] = useState<DocBrowserEntry | null>(null);
  const [renameEntry, setRenameEntry] = useState<DocBrowserEntry | null>(null);
  // 左侧面板宽度（可拖拽调整，sessionStorage 持久化）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = sessionStorage.getItem('doc-browser-sidebar-width');
    return saved ? parseInt(saved, 10) : 280;
  });
  // tag 筛选（多选，sessionStorage 持久化）
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => {
    try {
      const saved = sessionStorage.getItem('doc-browser-selected-tags');
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch { return new Set(); }
  });
  useEffect(() => {
    sessionStorage.setItem('doc-browser-selected-tags', JSON.stringify([...selectedTags]));
  }, [selectedTags]);
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);
  // tag 颜色覆盖：受控优先（onTagColorsChange 用于持久化到后端），
  // 否则回退 sessionStorage（仅本 tab 生效）
  const [tagColorMapLocal, setTagColorMapLocal] = useState<Record<string, TagColorKey>>(() => {
    if (tagColorsProp) return tagColorsProp;
    try {
      const saved = sessionStorage.getItem('doc-browser-tag-colors');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  // 受控时跟随 prop 同步
  useEffect(() => {
    if (tagColorsProp) setTagColorMapLocal(tagColorsProp);
  }, [tagColorsProp]);
  const tagColorMap = tagColorsProp ?? tagColorMapLocal;
  // intentRef 跟踪"最新想要的"色板状态，避免快速连点两个 tag 时，第二次回调从
  // 过时的 prop/state 起始 spread，丢掉第一次的改动（Bugbot Medium）。
  const tagColorIntentRef = useRef(tagColorMap);
  useEffect(() => { tagColorIntentRef.current = tagColorMap; }, [tagColorMap]);
  const setTagColor = useCallback((tag: string, color: TagColorKey | undefined) => {
    const next = { ...tagColorIntentRef.current };
    if (color) next[tag] = color; else delete next[tag];
    tagColorIntentRef.current = next;
    if (onTagColorsChange) {
      // 受控：先本地立即反映（让 UI 不等 parent 来回 round-trip），再上报
      setTagColorMapLocal(next);
      onTagColorsChange(next);
    } else {
      setTagColorMapLocal(next);
      sessionStorage.setItem('doc-browser-tag-colors', JSON.stringify(next));
    }
  }, [onTagColorsChange]);
  const tagColorsCtxValue = useMemo(() => ({ colors: tagColorMap, setColor: setTagColor }), [tagColorMap, setTagColor]);
  const [resizing, setResizing] = useState(false);
  // 侧栏 DOM 引用 + 拖拽起始时量出的真实左边界，避免用写死偏移导致"不跟手/跳动"
  const sidebarRef = useRef<HTMLDivElement>(null);
  const resizeBaseLeftRef = useRef(0);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 搜索请求序号：异步响应回来时只有仍是最新一次搜索才采纳，丢弃陈旧响应
  const searchSeqRef = useRef(0);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // 解析"当前选中条目"的数据：优先主 entries，回退搜索结果（后端搜索命中的条目可能
  // 不在已加载的 entries 里，如 200 条分页之外、或 github_directory 这类靠搜索才浮现的条目）。
  const selectedEntryData = useMemo(
    () => entries.find(e => e.id === selectedEntryId) ?? searchResults?.find(e => e.id === selectedEntryId),
    [entries, searchResults, selectedEntryId],
  );

  // 父链映射（entryId → parentId），用于展开选中条目的所有祖先文件夹。
  // 合并 searchResults：搜索命中 / 深链 ?entry 的条目可能不在已加载的 entries 里，
  // 否则祖先链断、文件夹不展开、滚不到位。
  const parentMap = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const e of entries) m.set(e.id, e.parentId);
    for (const e of (searchResults ?? [])) if (!m.has(e.id)) m.set(e.id, e.parentId);
    return m;
  }, [entries, searchResults]);

  // 选中条目（含通过 ?entry 传入的初始选中）自动展开其所有祖先文件夹 + 滚动到可见。
  // 否则在分享链 / 子文件夹归档场景下，选中的那篇藏在折叠文件夹里，用户看不到"当前在读哪一篇"。
  useEffect(() => {
    if (!selectedEntryId) return;
    const ancestors: string[] = [];
    let pid = parentMap.get(selectedEntryId);
    let guard = 0;
    while (pid && guard++ < 50) {
      ancestors.push(pid);
      pid = parentMap.get(pid);
    }
    if (ancestors.length) {
      setExpandedFolders(prev => {
        let changed = false;
        const next = new Set(prev);
        for (const a of ancestors) if (!next.has(a)) { next.add(a); changed = true; }
        return changed ? next : prev;
      });
    }
    // 展开后下一帧把选中行滚到可见区
    const t = setTimeout(() => {
      const el = sidebarRef.current?.querySelector(`[data-entry-id="${selectedEntryId}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 80);
    return () => clearTimeout(t);
  }, [selectedEntryId, parentMap]);

  // 批次 C：只对选中的非文件夹条目埋点
  const trackedEntryId = useMemo(() => {
    if (!selectedEntryId) return null;
    const e = entries.find(x => x.id === selectedEntryId);
    return e && !e.isFolder ? selectedEntryId : null;
  }, [selectedEntryId, entries]);
  useViewTracking(trackedEntryId);

  // 批次 D：划词评论
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const [inlineCommentsOpen, setInlineCommentsOpen] = useState(false);
  const [evidenceGraphOpen, setEvidenceGraphOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  // 2026-05-28 用户反馈："看不到别人留在这里的评论气泡"。
  // 进入条目时主动预拉评论计数，让正文上方常驻一颗 chip：
  //   "N 条评论" 点击打开 InlineCommentDrawer。
  // 仅 best-effort：失败/无权（私有库无分享访问）默认 0，不影响主流程。
  const [commentCount, setCommentCount] = useState(0);
  // 评论全量列表（驱动行内高亮气泡 InlineCommentOverlay；commentCount 仍用于上方 chip）
  const [inlineCommentItems, setInlineCommentItems] = useState<DocumentInlineComment[]>([]);
  // 评论计数 fetchIdRef 守卫（PR #685 Bugbot Low）：切换条目 / onClose 重拉时，
  // 旧 entry 的慢响应不覆盖新 entry 已设的计数。
  const commentCountFetchIdRef = useRef(0);
  // 选区 offset 必须基于"实际渲染的正文"解析：文本类预览渲染的是
  // parseFrontmatter(text).body（已剥 frontmatter），若把含 frontmatter 的
  // 原文喂给 useContentSelection，选中同时出现在 frontmatter 的文字（如标题）
  // 会先匹配到 frontmatter 块，导致 offset/上下文错位、评论锚点定位错误。
  // 与 tocContent / MarkdownViewer 共用 parseFrontmatter（SSOT）。
  const selectionRawContent = useMemo(() => {
    const text = preview?.text;
    if (!text) return text ?? undefined;
    const e = selectedEntryData; // 用带 searchResults 兜底的 SSOT：仅存在于搜索结果的命中也能正确解析选区（Bugbot）
    if (!e || e.isFolder) return text;
    const cfg = getFileTypeConfig(e.title, e.contentType);
    return cfg.preview === 'text' ? parseFrontmatter(text).body : text;
  }, [preview, selectedEntryData]);
  const { selection: liveSelection, clear: clearLiveSelection } = useContentSelection(
    contentAreaRef,
    selectionRawContent,
    Boolean(selectedEntryId && !contentLoading && !editMode),
  );
  const trackedEntryForComments = useMemo(() => {
    // 用带 searchResults 兜底的 selectedEntryData：仅存在于后端搜索结果的命中也能拉评论（Bugbot Medium）
    const e = selectedEntryData;
    return e && !e.isFolder ? e : null;
  }, [selectedEntryData]);

  // 进入条目时预拉评论计数，让正文上方常驻入口（共享视图也能看到他人评论的存在）
  useEffect(() => {
    if (!trackedEntryForComments) {
      setCommentCount(0);
      setInlineCommentItems([]);
      return;
    }
    const myId = ++commentCountFetchIdRef.current;
    // 切到新文档先清空上一篇的评论：避免新文档 listInlineComments 失败/无权（success:false）时
    // 旧评论残留，甚至因正文文本碰巧匹配把旧高亮/气泡画到新文档上（Codex P2）
    setCommentCount(0);
    setInlineCommentItems([]);
    (async () => {
      try {
        const res = await listInlineComments(trackedEntryForComments.id, inlineCommentShareToken);
        if (myId === commentCountFetchIdRef.current && res.success) {
          setCommentCount(res.data.items.length);
          setInlineCommentItems(res.data.items);
        }
      } catch { /* 私有库 + 无分享 + 非 owner 会 404，正常 */ }
    })();
  }, [trackedEntryForComments, inlineCommentShareToken]);

  // F1：仅当当前预览是文本类（Markdown/提取文本）时，给右侧 TOC 提供正文
  const tocContent = useMemo(() => {
    const e = selectedEntryData; // 同上：带 searchResults 兜底，搜索命中也正确生成 TOC（Bugbot）
    if (!e || e.isFolder) return null;
    const text = preview?.text;
    if (!text) return null;
    const cfg = getFileTypeConfig(e.title, e.contentType);
    // 与 MarkdownViewer 一致：剥掉 frontmatter，TOC 不把 ---/title: 当标题
    return cfg.preview === 'text' ? parseFrontmatter(text).body : null;
  }, [selectedEntryData, preview]);

  // 拖拽调整宽度
  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      // 以拖拽开始时量出的侧栏真实左边界为基准，宽度 = 鼠标 X - 左边界，1:1 跟手
      const newWidth = Math.min(560, Math.max(200, e.clientX - resizeBaseLeftRef.current));
      setSidebarWidth(newWidth);
    };
    const handleUp = () => {
      setResizing(false);
      sessionStorage.setItem('doc-browser-sidebar-width', String(sidebarWidthRef.current));
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing]);

  // 从 entries 的 metadata 中构建每个文件夹的主文档映射
  const folderPrimaryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder && e.metadata?.primaryChildId) {
        map.set(e.id, e.metadata.primaryChildId);
      }
    }
    return map;
  }, [entries]);

  // 构建树结构
  const { rootEntries, childrenMap, fileCount } = useMemo(() => {
    // 移除对 'github_directory' 的硬编码过滤，使订阅文件夹与文件可以在树结构中正常显示。
    const cMap = new Map<string, DocBrowserEntry[]>();
    const roots: DocBrowserEntry[] = [];

    for (const e of entries) {
      if (!e.parentId) {
        roots.push(e);
      } else {
        const siblings = cMap.get(e.parentId) ?? [];
        siblings.push(e);
        cMap.set(e.parentId, siblings);
      }
    }

    // 排序：置顶优先 → 文件夹优先 → 主文档优先 → 按 sortMode 决定剩余顺序
    const tsOf = (e: DocBrowserEntry, field: 'createdAt' | 'updatedAt'): number => {
      const v = e[field];
      if (!v) return 0;
      const t = new Date(v).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const sortFn = (a: DocBrowserEntry, b: DocBrowserEntry) => {
      const aPinned = pinnedSet.has(a.id) || a.id === primaryEntryId;
      const bPinned = pinnedSet.has(b.id) || b.id === primaryEntryId;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (a.id === primaryEntryId) return -1;
      if (b.id === primaryEntryId) return 1;
      if (sortMode === 'created-desc') {
        const d = tsOf(b, 'createdAt') - tsOf(a, 'createdAt');
        if (d !== 0) return d;
      } else if (sortMode === 'updated-desc') {
        const d = tsOf(b, 'updatedAt') - tsOf(a, 'updatedAt');
        if (d !== 0) return d;
      }
      return a.title.localeCompare(b.title);
    };
    roots.sort(sortFn);
    for (const [, children] of cMap) children.sort(sortFn);

    const fCount = entries.filter(e => !e.isFolder).length;

    return { rootEntries: roots, childrenMap: cMap, fileCount: fCount };
  }, [entries, primaryEntryId, pinnedSet, sortMode]);

  // 从 summary 提取显示标题：优先 YAML frontmatter 的 title（去引号），
  // 没有 frontmatter / 没有 title 时回退到 frontmatter 之后的首个正文标题，
  // 再不行回退到首个非空行（去掉行首 # 号）。与正文渲染共用 parseFrontmatter。
  useEffect(() => {
    const lines = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder || !e.summary) continue;
      const { title, body } = parseFrontmatter(e.summary);
      let display = (title ?? '').trim();
      if (!display) {
        const firstLine = body.split('\n').find(l => l.trim());
        if (firstLine) display = firstLine.replace(/^#+\s*/, '').trim();
      }
      if (display) lines.set(e.id, display);
    }
    setContentFirstLines(lines);
  }, [entries]);

  // 添加菜单 click outside
  useEffect(() => {
    if (!showAddMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setShowAddMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAddMenu]);

  // 显示设置菜单 click outside
  useEffect(() => {
    if (!showSettingsMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) setShowSettingsMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettingsMenu]);

  // 搜索过滤（本地 title 搜索 + 可选后端内容搜索） + tag 过滤
  const { filteredRoots, filteredChildrenMap } = useMemo(() => {
    const hasTagFilter = selectedTags.size > 0;
    const kw = search.trim().toLowerCase();
    const hasLocalSearch = kw.length > 0 && searchResults === null;

    // 无过滤 → 原样
    if (!hasLocalSearch && !hasTagFilter) {
      if (searchResults !== null) return { filteredRoots: searchResults, filteredChildrenMap: new Map() };
      return { filteredRoots: rootEntries, filteredChildrenMap: childrenMap };
    }

    // 后端搜索结果：仅叠加 tag 过滤
    if (searchResults !== null) {
      const list = hasTagFilter
        ? searchResults.filter(e => (e.tags ?? []).some(t => selectedTags.has(t)))
        : searchResults;
      return { filteredRoots: list, filteredChildrenMap: new Map() };
    }

    // 本地搜索 / tag 过滤（两者 AND）
    const matchIds = new Set<string>();
    const entryMap = new Map(entries.map(e => [e.id, e]));
    for (const e of entries) {
      let searchHit = !hasLocalSearch;
      if (hasLocalSearch) {
        const titleMatch = e.title.toLowerCase().includes(kw);
        const summaryMatch = e.summary?.toLowerCase().includes(kw) ?? false;
        const firstLineMatch = contentFirstLines.get(e.id)?.toLowerCase().includes(kw) ?? false;
        searchHit = titleMatch || summaryMatch || firstLineMatch;
      }
      // 文件夹本身不参与 tag 过滤（无 tag），但若其后代命中则保留
      const tagHit = !hasTagFilter || (!e.isFolder && (e.tags ?? []).some(t => selectedTags.has(t)));
      if (searchHit && tagHit && !e.isFolder) {
        matchIds.add(e.id);
        let cur = e;
        while (cur.parentId) {
          matchIds.add(cur.parentId);
          const parent = entryMap.get(cur.parentId);
          if (!parent) break;
          cur = parent;
        }
      } else if (hasLocalSearch && !hasTagFilter && e.isFolder && e.title.toLowerCase().includes(kw)) {
        // 仅文本搜索时文件夹标题命中仍保留（与原逻辑保持兼容）
        matchIds.add(e.id);
      }
    }

    const fRoots = rootEntries.filter(e => matchIds.has(e.id));
    const fMap = new Map<string, DocBrowserEntry[]>();
    for (const [parentId, children] of childrenMap) {
      const filtered = children.filter(e => matchIds.has(e.id));
      if (filtered.length > 0) fMap.set(parentId, filtered);
    }

    return { filteredRoots: fRoots, filteredChildrenMap: fMap };
  }, [search, selectedTags, searchResults, rootEntries, childrenMap, entries, contentFirstLines]);

  // 收集 entries 中所有出现过的 tag（按出现频次排序，热门 tag 排前）
  const allTagsRanked = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      if (e.isFolder) continue;
      for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }, [entries]);

  // 列表渲染项：chronological 排序（created/updated-desc）且非搜索态时按时间桶插入分组小标题；
  // 否则纯条目列表（default 文件夹树 / 搜索结果保持原序）。逻辑提取为 buildDisplayItems 便于单测。
  const displayItems = useMemo(
    () => buildDisplayItems(filteredRoots, { groupByTime: sortMode !== 'default' && !search.trim(), timeField }),
    [filteredRoots, sortMode, search, timeField],
  );

  // 行内标签可见数随侧栏宽度自适应：侧栏越宽展示越多标签（拖宽后不再压缩成 +N）
  // 窄栏更激进地收进 +N，保证徽章行恒为单行（绝不竖直堆叠）；宽栏才逐步多展示
  const rowTagMax = sidebarWidth >= 560 ? 12 : sidebarWidth >= 460 ? 6 : sidebarWidth >= 380 ? 4 : sidebarWidth >= 340 ? 3 : sidebarWidth >= 300 ? 2 : 1;

  // 自动剔除当前 entries 不存在的已选 tag：
  // sessionStorage 是全局共享（DocBrowser 三处调用），跨知识库切换时上一个库选的 tag 可能
  // 当前库根本没有 → filter 拒绝所有文件 + chip 条因 allTagsRanked 为空不渲染，用户卡死无法清空。
  // 等 entries 加载完后剔除幽灵 tag。entries 为空（加载中）时不动，避免误清。
  useEffect(() => {
    if (entries.length === 0) return;
    const available = new Set(allTagsRanked);
    setSelectedTags(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const t of prev) {
        if (available.has(t)) next.add(t); else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allTagsRanked, entries.length]);

  // 内容命中标记：搜索时若条目在结果中但关键词不在标题里 → 标「（内容包含）」
  const contentMatchIds = useMemo(() => {
    const ids = new Set<string>();
    const kw = search.trim().toLowerCase();
    if (!kw) return ids;
    // 后端搜索模式：searchResults 已是扁平的全部命中条目。
    // 本地搜索模式（searchResults === null）：filteredRoots 只含根级条目，
    // 文件夹内嵌套文件不在其中——必须并入 filteredChildrenMap 各 value 数组，
    // 否则展开的子文件永远拿不到「内容包含」标记（Bugbot-L）。
    let list: DocBrowserEntry[];
    if (searchResults !== null) {
      list = searchResults;
    } else {
      list = [...filteredRoots];
      for (const children of filteredChildrenMap.values()) list.push(...children);
    }
    for (const e of list) {
      if (e.isFolder) continue;
      const titleHit = (e.title ?? '').toLowerCase().includes(kw);
      const contentTitleHit = (contentFirstLines.get(e.id) ?? '').toLowerCase().includes(kw);
      if (!titleHit && !contentTitleHit) ids.add(e.id);
    }
    return ids;
  }, [search, searchResults, filteredRoots, filteredChildrenMap, contentFirstLines]);

  // 搜索处理（防抖 + 永远同时搜标题+内容，走后端；onSearch 内部会先 rebuildContentIndex）
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setSearchResults(null);

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const trimmed = value.trim();
    // 每次输入变化都推进序号：在途响应回来时若序号已变即视为陈旧并丢弃
    const reqId = ++searchSeqRef.current;

    if (trimmed && onSearch) {
      setSearching(true);
      searchTimerRef.current = setTimeout(async () => {
        try {
          const results = await onSearch(trimmed, true);
          // 仅当这仍是最新一次搜索才采纳，否则丢弃陈旧响应
          if (reqId !== searchSeqRef.current) return;
          setSearchResults(results);
        } catch {
          if (reqId !== searchSeqRef.current) return;
          setSearchResults(null);
        } finally {
          // 仅最新请求负责收起 spinner：陈旧响应不动它（更新的在途请求会收），
          // 但 onSearch 抛错时最新请求也必须解除 loading，避免 spinner 永久卡住。
          if (reqId === searchSeqRef.current) setSearching(false);
        }
      }, 400);
    } else {
      // 搜索框被清空：立即回到本地全量树，并让任何在途响应作废
      setSearchResults(null);
      setSearching(false);
    }
  }, [onSearch]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // 搜索时自动展开所有文件夹（后端结果为扁平列表时无需展开，但展开无副作用）
  useEffect(() => {
    if (search.trim()) {
      const allFolderIds = entries.filter(e => e.isFolder).map(e => e.id);
      setExpandedFolders(new Set(allFolderIds));
    }
  }, [search, entries]);

  // 加载内容
  // contentKey = `${entryId}:${updatedAt}`：替换文件后后端会更新 updatedAt，
  // 缓存键随之变化，命中失败 → 重新拉取新正文（修复"替换后预览不刷新"）
  const loadEntryContent = useCallback(async (entryId: string, contentKey: string) => {
    if (contentKey === loadedContentKey) return;
    setContentLoading(true);
    setPreview(null);
    try {
      const data = await loadContent(entryId);
      setPreview(data);
      setLoadedContentKey(contentKey);
    } catch {
      setPreview(null);
    }
    setContentLoading(false);
  }, [loadContent, loadedContentKey]);

  useEffect(() => {
    if (selectedEntryId) {
      // 用 selectedEntryData（含 searchResults 回退），否则搜索命中、不在已加载 entries 里的
      // 条目不会触发 loadContent，preview 停在上一篇，正文/证据图显示错位（Bugbot High）。
      const entry = selectedEntryData;
      if (entry && !entry.isFolder) {
        loadEntryContent(selectedEntryId, `${selectedEntryId}:${entry.updatedAt ?? ''}`);
      }
    }
  }, [selectedEntryId, loadEntryContent, selectedEntryData]);

  // 新建文档默认进入编辑态：autoEditEntryId 命中且内容加载完成后自动开编辑（一次性）
  useEffect(() => {
    if (!autoEditEntryId || selectedEntryId !== autoEditEntryId || contentLoading) return;
    // 必须确认当前 preview 已是该 entry 的内容，否则会把上一篇的旧正文带进新文档
    // （selectedEntryId 刚切换那一帧 contentLoading 仍为 false，preview 还是旧的）——Bugbot 报告
    if (!loadedContentKey || !loadedContentKey.startsWith(autoEditEntryId + ':')) return;
    const entry = entries.find(e => e.id === autoEditEntryId);
    if (!entry || entry.isFolder) return;
    const cfg = getFileTypeConfig(entry.title, entry.contentType);
    if (cfg.editable && onSaveContent) {
      setEditContent(preview?.text ?? '');
      setEditMode(true);
    }
    onAutoEditConsumed?.();
  }, [autoEditEntryId, selectedEntryId, contentLoading, loadedContentKey, preview, entries, onSaveContent, onAutoEditConsumed]);

  // 内容版本键变化时强制退出编辑态：
  // loadedContentKey = `${entryId}:${updatedAt}`。当"同一个 entry"的 updatedAt
  // 变了（左侧右键"替换文件"覆盖当前选中文档 / 外部更新），loadEntryContent
  // 已重新拉取新正文，但 editMode/editContent 仍持有替换前的旧文本，此时若用户
  // 点保存会把旧文本写回覆盖刚解析的新文档 → 替换像丢数据。这里在"同 entry 内容
  // 换了版本"时清掉编辑态，回到新内容预览。
  // 只针对"同 entry 且 key 真的变了"生效：首次加载（prev=null）、切换到不同
  // entry 都不处理（切文件本就保留既有行为，用户正常进入/中途编辑不受影响）。
  const prevLoadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevLoadedKeyRef.current;
    const cur = loadedContentKey;
    prevLoadedKeyRef.current = cur;
    if (!prev || !cur || prev === cur) return;
    const prevEntryId = prev.slice(0, prev.indexOf(':'));
    const curEntryId = cur.slice(0, cur.indexOf(':'));
    // 不同 entry = 切换文件，沿用既有行为，不在此处干预
    if (prevEntryId !== curEntryId) return;
    // 同一 entry 但版本键变了 = 内容被替换/外部更新，退出编辑态避免旧文本覆盖
    setEditMode(false);
    setEditContent('');
  }, [loadedContentKey]);

  // 自动选中主文档 + 展开其父文件夹链。每次进入空间只自动选一次：
  // StoreDetailView 按 selectedStoreId 条件渲染 → 切空间会重挂 DocBrowser、本 ref 自然归零，对新空间仍会自动选；
  // 显式「返回列表」清空选中后不再自动重选——即便此后该空间主文档 id 变化（新设 README）也不打回（Codex/Bugbot）。
  const didAutoSelectRef = useRef(false);
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (selectedEntryId) { didAutoSelectRef.current = true; return; }      // 已有选中（含深链）→ 视为已初始化、不覆盖
    if (primaryEntryId && entries.some(e => e.id === primaryEntryId)) {
      didAutoSelectRef.current = true;
      onSelectEntry(primaryEntryId);
      const entryMap = new Map(entries.map(e => [e.id, e]));
      const toExpand = new Set<string>();
      let cur = entryMap.get(primaryEntryId);
      while (cur?.parentId) {
        toExpand.add(cur.parentId);
        cur = entryMap.get(cur.parentId);
      }
      if (toExpand.size > 0) {
        setExpandedFolders(prev => new Set([...prev, ...toExpand]));
      }
    }
  }, [primaryEntryId, entries, selectedEntryId, onSelectEntry]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !onCreateFolder) return;
    await onCreateFolder(newFolderName.trim());
    setNewFolderName('');
    setCreatingFolder(false);
  }, [newFolderName, onCreateFolder]);

  // 批量多选（仅非文件夹条目）：勾选若干条 → 底部浮出 BulkActionBar 批量删除
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const selectionActive = selectedIds.size > 0;
  // 列表变化（刷新 / 别处删除 / 切换空间）时剔除已不在树里的选中 id：
  // 避免批量条停留显示陈旧数量、批量删除命中已不存在的 id（Bugbot Medium）
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (live.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
  }, [entries]);
  const handleBulkDelete = useCallback(async () => {
    if (!onDeleteEntry || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const confirmed = await systemDialog.confirm({
      title: '批量删除文档',
      message: `将永久删除选中的 ${ids.length} 个文件及其解析正文 / 附件。\n\n此操作不可恢复。`,
      tone: 'danger',
      confirmText: `永久删除 ${ids.length} 个`,
      cancelText: '取消',
    });
    if (!confirmed) return;
    for (const id of ids) {
      try { await onDeleteEntry(id); } catch { /* 单个失败不阻断其余 */ }
    }
    setSelectedIds(new Set());
  }, [onDeleteEntry, selectedIds]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: DocBrowserEntry) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 0, height: '100%' }}>
        <MapSectionLoader />
      </div>
    );
  }

  if (entries.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const isCards = appearance === 'cards';
  // cards: 双独立圆角卡片 + 12px gap（周报风格）；inset: 单容器无 gap（知识库/分享）
  const rootClass = isCards
    ? 'flex flex-1 gap-3 overflow-hidden p-3 rounded-2xl surface-raised'
    : 'surface-inset flex flex-1 gap-0 overflow-hidden rounded-[12px]';
  // cards 模式下左右各自包圆角卡片；inset 模式下走原生分隔线
  const sidebarClass = isCards
    ? 'surface-reading relative flex flex-shrink-0 flex-col rounded-xl overflow-hidden'
    : 'bg-token-nested relative flex flex-shrink-0 flex-col border-r border-token-subtle';

  return (
    <TagColorsContext.Provider value={tagColorsCtxValue}>
    <div className={rootClass} style={{ minHeight: 0 }}>

      {/* 左侧：文件树（液态玻璃效果 + 可拖拽调整宽度） */}
      <div ref={sidebarRef} className={sidebarClass}
        style={{
          width: `${sidebarWidth}px`,
          minHeight: 0,
        }}>

        {/* 批量操作条：选中条目后浮在侧栏底部，支持批量删除（取消即清空选择） */}
        {selectionActive && onDeleteEntry && (
          <div style={{ position: 'absolute', left: 8, right: 8, bottom: 10, zIndex: 20 }}>
            <BulkActionBar
              count={selectedIds.size}
              onDelete={handleBulkDelete}
              onCancel={clearSelection}
            />
          </div>
        )}

        {/* 外部自定义 sidebar 头部（如「周报列表 · 按最近提交 · N 篇」），可选 */}
        {sidebarHeader && (
          <div className="shrink-0 px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
            {sidebarHeader}
          </div>
        )}
        {/* 标题显示切换 + 搜索 + 新建文件夹 */}
        <div className="surface-panel-header space-y-2.5 px-3 py-3">
          {/* 标题模式切换（正文标题/文件名）+ 显示设置 */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setUseContentTitle(!useContentTitle)}
              className="flex cursor-pointer items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10px] text-token-muted transition-colors hover-bg-soft"
              title={useContentTitle ? '当前：显示正文第一行为标题' : '当前：显示文件名为标题'}>
              {useContentTitle ? <ToggleRight size={12} className="text-token-accent" /> : <ToggleLeft size={12} />}
              {useContentTitle ? '正文标题' : '文件名'}
            </button>
            <div ref={settingsMenuRef} className="relative">
              <button
                onClick={() => setShowSettingsMenu(v => !v)}
                className="flex cursor-pointer items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10px] text-token-muted transition-colors hover-bg-soft"
                title="显示设置">
                <Settings size={11} className={showUpdatedTime ? 'text-token-accent' : ''} />
                显示
              </button>
              {showSettingsMenu && (
                <div className="surface-popover absolute right-0 top-[26px] z-50 min-w-[180px] rounded-[10px] p-2">
                  <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-token-secondary transition-colors hover:bg-white/6">
                    <input
                      type="checkbox"
                      checked={showUpdatedTime}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setShowUpdatedTime(next);
                        sessionStorage.setItem('doc-browser-show-updated-time', next ? '1' : '0');
                      }}
                      className="h-3 w-3 cursor-pointer accent-current"
                    />
                    显示更新时间
                  </label>
                  <div className="px-2 py-1 text-[10px] text-token-muted">
                    显示每条目最后变更时间，鼠标悬停查看精确时间和作者。
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
              <input
                value={search} onChange={e => handleSearchChange(e.target.value)}
                placeholder="搜索标题或内容…"
                className="h-8 w-full rounded-[9px] pl-8 pr-3 text-[11.5px] outline-none transition-colors"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-faint)',
                  color: 'var(--text-primary)',
                }}
              />
              {searching && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  <MapSpinner size={12} />
                </span>
              )}
            </div>
            <div ref={addMenuRef} className="relative">
              <button
                onClick={() => setShowAddMenu(v => !v)}
                className="surface-action flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] transition-colors"
                title="新建"
              >
                <Plus size={12} />
              </button>
              {showAddMenu && (
                <div className="surface-popover absolute right-0 top-[30px] z-50 min-w-[180px] rounded-[10px] py-1">
                  {/* 可用操作 */}
                  {onCreateDocument && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { onCreateDocument(); setShowAddMenu(false); }}>
                      <FilePlus size={12} className="text-token-accent" />
                      文档
                    </button>
                  )}
                  {onUploadFile && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { onUploadFile(); setShowAddMenu(false); }}>
                      <Upload size={12} className="text-token-accent" />
                      上传文件
                    </button>
                  )}
                  {onCreateFolder && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { setCreatingFolder(true); setShowAddMenu(false); }}>
                      <FolderPlus size={12} className="text-token-warning" />
                      新建文件夹
                    </button>
                  )}
                  {/* 分隔线 */}
                  <div className="my-1 border-t border-token-subtle" />
                  {/* 尚未实现：置灰 */}
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <LayoutTemplate size={12} />
                    从模板新建
                  </button>
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <Bot size={12} />
                    AI 帮你写
                  </button>
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <Link size={12} />
                    添加链接
                  </button>
                </div>
              )}
            </div>
          </div>
          {/* tag 筛选条：≤6 个内联 chip 行；>6 个收进"标签筛选"下拉（点开弹长方形面板多选），避免一长串横向溢出 */}
          {allTagsRanked.length > 0 && (
            <div
              className="flex items-center gap-1 overflow-x-auto"
              style={{
                paddingTop: 2,
                paddingBottom: 2,
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255,255,255,0.15) transparent',
              }}
              title="点击筛选；多选取并集；再次点击取消"
            >
              {allTagsRanked.length > 6 ? (
                <TagFilterDropdown
                  tags={allTagsRanked}
                  selected={selectedTags}
                  colors={tagColorMap}
                  onToggle={toggleTag}
                  onClear={() => setSelectedTags(new Set())}
                />
              ) : (
                <>
                  {selectedTags.size > 0 && (
                    <button
                      onClick={() => setSelectedTags(new Set())}
                      className="flex-shrink-0 text-[9.5px] px-1.5 rounded-full cursor-pointer transition-colors"
                      style={{
                        height: 18,
                        lineHeight: '18px',
                        color: 'var(--text-muted)',
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-faint)',
                      }}
                      title="清空筛选"
                    >
                      清空
                    </button>
                  )}
                  {allTagsRanked.map(tag => {
                    const c = getTagColor(tag, tagColorMap);
                    const active = selectedTags.has(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        className="flex-shrink-0 text-[10px] px-2 rounded-full cursor-pointer font-medium transition-all"
                        style={{
                          height: 20,
                          lineHeight: '20px',
                          color: active ? '#fff' : c.text,
                          background: active ? c.dot : c.bg,
                          border: `1px solid ${active ? c.dot : c.border}`,
                          letterSpacing: '0.01em',
                        }}
                        title={`#${tag}`}
                      >
                        {truncateTagDisplay(tag)}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
          {creatingFolder && (
            <div className="flex gap-1.5">
              <input
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
                placeholder="文件夹名称..."
                autoFocus
                className="flex-1 h-7 px-2.5 rounded-[8px] text-[11px] outline-none"
                style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.15)', color: 'var(--text-primary)' }}
              />
              <button onClick={handleCreateFolder}
                className="h-7 px-2.5 rounded-[8px] text-[10px] font-semibold cursor-pointer"
                style={{ background: 'rgba(234,179,8,0.1)', color: 'rgba(234,179,8,0.9)', border: '1px solid rgba(234,179,8,0.15)' }}>
                创建
              </button>
            </div>
          )}
        </div>

        {/* 文件树 */}
        <div
          className="flex-1 py-1"
          style={{ minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
        >
          {filteredRoots.length === 0 ? (
            <div className="px-3 py-10 flex flex-col items-center gap-3 text-center">
              {search ? (
                <>
                  <div className="h-10 w-10 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <Search size={18} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {searching ? '搜索中...' : '无匹配文件'}
                  </p>
                </>
              ) : (
                <>
                  {/* 空状态引导 — 符合 guided-exploration.md 原则 */}
                  <div className="h-12 w-12 rounded-[14px] flex items-center justify-center relative"
                    style={{
                      background: 'linear-gradient(135deg, rgba(168,85,247,0.12), rgba(59,130,246,0.10))',
                      border: '1px solid rgba(168,85,247,0.18)',
                    }}>
                    <FolderPlus size={20} style={{ color: 'rgba(216,180,254,0.95)' }} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[12px] font-semibold text-token-primary">
                      还是空的
                    </p>
                    <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: '220px' }}>
                      把音频/视频/PDF 拖到这里,或点击下方按钮添加第一个文档
                    </p>
                  </div>
                  {(onUploadFile || onCreateDocument) && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {onUploadFile && (
                        <button onClick={onUploadFile}
                          className="text-[10.5px] px-2.5 py-1 rounded-[8px] cursor-pointer transition-all"
                          style={{
                            background: 'rgba(168,85,247,0.14)',
                            border: '1px solid rgba(168,85,247,0.25)',
                            color: 'rgba(216,180,254,0.95)',
                          }}>
                          上传文件
                        </button>
                      )}
                      {onCreateDocument && (
                        <button onClick={onCreateDocument}
                          className="text-[10.5px] px-2.5 py-1 rounded-[8px] cursor-pointer text-token-muted hover:text-token-primary"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          新建文档
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : displayItems.map((item, idx) => (
            item.kind === 'header' ? (
              <div
                key={`grp-${item.bucketKey}-${idx}`}
                className="flex items-center justify-between"
                style={{
                  fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--text-muted)', padding: '12px 12px 5px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border-faint)',
                }}
              >
                <span>{item.label}</span>
                <span style={{ fontWeight: 500, letterSpacing: 0, opacity: 0.8 }}>{item.count} 篇</span>
              </div>
            ) : (
            <motion.div
              key={item.entry.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, delay: Math.min(idx * 0.018, 0.5), ease: [0.25, 0.1, 0.25, 1] }}
            >
            <TreeNode
              entry={item.entry}
              childrenMap={search.trim() && searchResults !== null ? new Map() : (search.trim() || selectedTags.size > 0 ? filteredChildrenMap : childrenMap)}
              depth={0}
              selectedEntryId={selectedEntryId}
              primaryEntryId={primaryEntryId}
              pinnedEntryIds={pinnedSet}
              folderPrimaryMap={folderPrimaryMap}
              expandedFolders={expandedFolders}
              useContentTitle={useContentTitle}
              showUpdatedTime={showUpdatedTime}
              timeField={timeField}
              contentFirstLines={contentFirstLines}
              contentMatchIds={contentMatchIds}
              reprocessingMap={reprocessingMap}
              sharedEntryIds={sharedEntryIds}
              onToggleFolder={toggleFolder}
              onSelectEntry={onSelectEntry}
              onContextMenu={handleContextMenu}
              onShareEntry={onShareEntry}
              onMoveEntry={onMoveEntry}
              onOpenSubscription={onOpenSubscription}
              isEntryFresh={isEntryFresh}
              onToggleTag={toggleTag}
              activeTags={selectedTags}
              tagMax={rowTagMax}
              selectedIds={selectedIds}
              onToggleSelect={onDeleteEntry ? toggleSelect : undefined}
              selectionActive={selectionActive}
            />
            </motion.div>
            )
          ))}
        </div>
        {/* 根级放置区域 - 允许拖到根级别 */}
        {onMoveEntry && (
          <div
            className="h-2"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => {
              e.preventDefault();
              const draggedId = e.dataTransfer.getData('text/plain');
              if (draggedId) onMoveEntry(draggedId, null);
            }}
          />
        )}

        {/* 底部统计 */}
        <div
          className="flex items-center gap-1.5 px-3.5 py-2.5 text-[10px]"
          style={{ borderTop: '1px solid var(--border-faint)', color: 'var(--text-muted)' }}
        >
          <FolderOpen size={11} style={{ opacity: 0.7 }} />
          <span className="tabular-nums">{fileCount}</span>
          <span style={{ opacity: 0.8 }}>个文件</span>
        </div>

        {/* 拖拽调整宽度的把手（仅 inset 模式）。cards 模式下双卡片有 12px gap，
            把手挂在 sidebar 内部右边缘会被 overflow-hidden + rounded-xl 剪成孤立小方块，
            视觉怪异。cards 场景以阅读为主，固定宽度足够，故 cards 模式下不渲染。 */}
        {!isCards && (
          <div
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize group/resize"
            onMouseDown={(e) => {
              e.preventDefault();
              resizeBaseLeftRef.current = sidebarRef.current?.getBoundingClientRect().left ?? 0;
              setResizing(true);
            }}
            style={{ zIndex: 10 }}
          >
            <div
              className="absolute top-0 left-0 h-full transition-all duration-150"
              style={{
                width: resizing ? '2px' : '1px',
                background: resizing ? 'rgba(59,130,246,0.6)' : 'transparent',
              }}
            />
            <div className="absolute top-0 left-0 h-full w-1 group-hover/resize:bg-[rgba(59,130,246,0.3)] transition-colors duration-150" />
          </div>
        )}
      </div>

      {/* 右侧：文档预览 */}
      <div
        className={`flex-1 min-w-0 flex flex-col overflow-hidden${isCards ? ' surface-reading rounded-xl' : ''}`}
        style={{ minHeight: 0 }}
      >
        {selectedEntryId ? (
          <>
            {/* 面包屑导航 header */}
            <div className="flex items-center gap-2 px-5 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {/* 阅读区返回按钮：返回当前空间的文档列表（上一层），仅调用方传 onBackToList 才显示 */}
              {onBackToList && (
                <button
                  onClick={onBackToList}
                  className="flex-shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-[8px] text-[11px] cursor-pointer transition-colors hover:opacity-80"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)', color: 'var(--text-secondary)' }}
                  title="返回文档列表"
                >
                  <ChevronLeft size={13} /> 返回列表
                </button>
              )}
              <Breadcrumbs entryId={selectedEntryId} entries={entries} />
              {/* 验收结论药丸：列表里有、阅读区原先缺失，这里补上让「通过 L1」在阅读视图也一眼可见 */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                const vc = sel && !sel.isFolder ? getVerdictConfig(sel.metadata?.verdict) : null;
                if (!vc) return null;
                const tier = sel!.metadata?.tier;
                return (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 font-bold tabular-nums"
                    style={{ background: vc.background, color: vc.color, border: vc.border }}
                    title={`验收结论：${vc.label}${tier ? ` · 档位 ${tier}` : ''}`}
                  >
                    {vc.label}{tier ? ` ${tier}` : ''}
                  </span>
                );
              })()}
              {selectedEntryId === primaryEntryId && (
                <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: 'rgba(234,179,8,0.08)', color: 'rgba(234,179,8,0.8)', border: '1px solid rgba(234,179,8,0.12)' }}>
                  README
                </span>
              )}
              {pinnedSet.has(selectedEntryId) && selectedEntryId !== primaryEntryId && (
                <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: 'rgba(59,130,246,0.08)', color: 'rgba(59,130,246,0.8)', border: '1px solid rgba(59,130,246,0.12)' }}>
                  置顶
                </span>
              )}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder || (sel.tags?.length ?? 0) === 0) return null;
                return (
                  <>
                    {sel.tags!.slice(0, 4).map(tag => (
                      <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{
                          background: 'rgba(168,85,247,0.08)',
                          color: 'rgba(216,180,254,0.92)',
                          border: '1px solid rgba(168,85,247,0.16)',
                        }}>
                        #{tag}
                      </span>
                    ))}
                    {sel.tags!.length > 4 && (
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        +{sel.tags!.length - 4}
                      </span>
                    )}
                  </>
                );
              })()}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                // 「更新于」用 updatedAt（所有本地变更都会刷新它）；lastChangedAt 仅供 new 徽标，
                // 避免浏览器内保存只 patch updatedAt 而 lastChangedAt 滞后导致显示陈旧
                return (
                  <div className="ml-auto flex items-center gap-3 min-w-0">
                    <span
                      className="text-[10px] whitespace-nowrap"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      更新于 <RelativeTime value={sel.updatedAt} fallback="未知时间" title={`最后更新时间：${formatMetaTime(sel.updatedAt)}`} />
                    </span>
                    {/* 作者未知时不显示「更新者 未知用户」，减少噪音 */}
                    {sel.updatedByName && (
                      <span
                        className="text-[10px] truncate max-w-[160px]"
                        style={{ color: 'var(--text-muted)' }}
                        title={`更新者：${sel.updatedByName}`}
                      >
                        更新者 {sel.updatedByName}
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* 当前文件最近更新徽标 + 订阅来源版本信息（git 类订阅独有） */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                const recentlyChanged = isRecentlyChanged(sel.lastChangedAt);
                const isSubscription = sel.sourceType === 'subscription';
                const githubSha = sel.metadata?.github_sha;
                if (!recentlyChanged && !isSubscription) return null;
                return (
                  <>
                    {recentlyChanged && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 font-bold"
                        style={{
                          background: 'rgba(34,197,94,0.1)',
                          color: 'rgba(74,222,128,0.95)',
                          border: '1px solid rgba(34,197,94,0.25)',
                          letterSpacing: '0.3px',
                        }}
                        title={sel.lastChangedAt ? `最近更新: ${new Date(sel.lastChangedAt).toLocaleString('zh-CN')}` : ''}
                      >
                        new
                      </span>
                    )}
                    {isSubscription && onOpenSubscription && (
                      <button
                        onClick={() => onOpenSubscription(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.18)',
                          color: 'rgba(96,165,250,0.95)',
                        }}
                        title={githubSha ? `GitHub 版本 ${githubSha.slice(0, 7)}（点击查看同步详情）` : '查看订阅同步详情'}
                      >
                        {githubSha ? `#${githubSha.slice(0, 7)}` : '订阅信息'}
                      </button>
                    )}
                  </>
                );
              })()}
              {/* 知识库 Agent 按钮：生成字幕 / 再加工 */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                const showSubtitle = canGenerateSubtitle(sel) && !!onGenerateSubtitle;
                const showReprocess = canReprocess(sel) && !!onReprocess;
                if (!showSubtitle && !showReprocess) return null;
                return (
                  <>
                    {showSubtitle && (
                      <button
                        onClick={() => onGenerateSubtitle!(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(168,85,247,0.1)',
                          border: '1px solid rgba(168,85,247,0.22)',
                          color: 'rgba(216,180,254,0.95)',
                        }}
                        title="一键生成字幕"
                      >
                        <Sparkles size={11} /> 生成字幕
                      </button>
                    )}
                    {showReprocess && (
                      <button
                        onClick={() => onReprocess!(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.18)',
                          color: 'rgba(96,165,250,0.95)',
                        }}
                        title="用智能体加工文档"
                      >
                        <Wand2 size={11} /> 智能体
                      </button>
                    )}
                  </>
                );
              })()}
              {/* 验收报告「证据关系图」按钮：仅验收类条目 + 有正文时显示，放在工具栏（非文章正中） */}
              {(() => {
                // 用 selectedEntryData（含 searchResults 回退），与正文/GitHub 渲染一致，
                // 否则搜索命中的验收报告点开后「证据图」按钮不显示。
                const sel = selectedEntryData;
                const isAcc = !!(sel?.metadata?.kind === 'acceptance-report' || sel?.metadata?.verdict);
                if (!isAcc || !preview?.text || editMode) return null;
                return (
                  <button
                    onClick={() => setEvidenceGraphOpen(true)}
                    className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                    style={{
                      background: 'rgba(99,102,241,0.1)',
                      border: '1px solid rgba(99,102,241,0.22)',
                      color: 'rgba(165,180,252,0.95)',
                    }}
                    title="证据关系图 — 把报告里的步骤连成页面跳转关系图（探案证据板）"
                  >
                    <Workflow size={11} /> 证据图
                  </button>
                );
              })()}
              {/* 批次 D：划词评论开关按钮 */}
              {trackedEntryForComments && (
                <button
                  onClick={() => setInlineCommentsOpen(true)}
                  className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                  style={{
                    background: 'rgba(168,85,247,0.08)',
                    border: '1px solid rgba(168,85,247,0.18)',
                    color: 'rgba(216,180,254,0.95)',
                  }}
                  title={commentCount > 0 ? `已有 ${commentCount} 条评论 — 点击查看 / 添加` : '划词评论 — 选中文本后浮起「添加评论」'}
                >
                  <MessageSquareText size={11} />
                  {commentCount > 0 ? `${commentCount} 条评论` : '评论'}
                </button>
              )}
              {/* 编辑/保存按钮（仅对可编辑类型显示） */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder || !onSaveContent) return null;
                const cfg = getFileTypeConfig(sel.title, sel.contentType);
                if (!cfg.editable) return null;
                return (
                  <div className="flex items-center gap-1.5">
                    {editMode ? (
                      <>
                        <button
                          onClick={async () => {
                            if (!selectedEntryId) return;
                            setSaving(true);
                            try {
                              await onSaveContent(selectedEntryId, editContent);
                              setPreview(prev => prev ? { ...prev, text: editContent } : prev);
                              setEditMode(false);
                            } finally {
                              setSaving(false);
                            }
                          }}
                          disabled={saving}
                          className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.9)' }}>
                          {saving ? <MapSpinner size={12} color="rgba(34,197,94,0.9)" /> : <Save size={11} />}
                          保存
                        </button>
                        <button
                          onClick={() => setEditMode(false)}
                          className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
                          <X size={11} /> 取消
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => { setEditContent(preview?.text ?? ''); setEditMode(true); }}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                        style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)', color: 'rgba(59,130,246,0.9)' }}>
                        <Pencil size={11} /> 编辑
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
            {/* 内容区 + 右侧本页章节导航（F1） */}
            <div className="flex-1 flex min-w-0 relative" style={{ minHeight: 0 }}>
              {/* 内容列包裹：让进度条 absolute 限定在本列宽度内，不跨到右侧 TOC 列（Bugbot Low） */}
              <div className="flex-1 min-w-0 relative flex flex-col" style={{ minHeight: 0 }}>
              {/* 阅读进度条（仅正文预览态）；切文档时按 key 重挂归零 */}
              {!editMode && !contentLoading && (
                <ReadingProgressBar key={selectedEntryId} scrollRef={contentAreaRef} />
              )}
              <div
                ref={contentAreaRef}
                className="flex-1 min-w-0 px-6 py-4 relative"
                style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
              >
                {contentLoading ? (
                  <MapSectionLoader text="加载文档内容…" />
                ) : editMode ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    spellCheck={false}
                    className="w-full h-full min-h-[400px] resize-none outline-none text-[13px] font-mono leading-relaxed"
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      color: 'var(--text-primary)',
                    }}
                    placeholder="在此编辑文档内容..."
                  />
                ) : (preview
                      || selectedEntryData?.sourceType === 'github_directory'
                      || selectedEntryData?.contentType === 'application/x-github-directory') ? (
                  <FilePreview
                    entry={selectedEntryData}
                    preview={preview}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 gap-2">
                    <FolderOpen size={48} className="opacity-20 mb-2" />
                    <p className="text-[13px]">{selectedEntryData?.isFolder ? '这是一个目录' : '无法预览该文件'}</p>
                  </div>
                )}
                {/* 划词选中时的浮层"添加评论"按钮 */}
                {liveSelection && !editMode && (
                  <SelectionActionPopover
                    selection={liveSelection}
                    onAddComment={() => {
                      setPendingSelection({
                        selectedText: liveSelection.selectedText,
                        contextBefore: liveSelection.contextBefore,
                        contextAfter: liveSelection.contextAfter,
                        startOffset: liveSelection.startOffset,
                        endOffset: liveSelection.endOffset,
                      });
                      setInlineCommentsOpen(true);
                      clearLiveSelection();
                      window.getSelection()?.removeAllRanges();
                    }}
                  />
                )}
                {/* 行内评论高亮 + 气泡：把他人评论锚回正文，气泡点击打开评论抽屉 */}
                {!editMode && !contentLoading && tocContent && inlineCommentItems.length > 0 && (
                  <InlineCommentOverlay
                    containerRef={contentAreaRef}
                    comments={inlineCommentItems}
                    reflowKey={`${selectedEntryId ?? ''}:${preview?.text?.length ?? 0}`}
                    onOpenComment={() => setInlineCommentsOpen(true)}
                  />
                )}
              </div>
              </div>
              {/* F1：本页章节导航——仅文本类预览且非编辑态显示，无标题时组件自身返回 null */}
              {!contentLoading && !editMode && tocContent && (
                <DocToc content={tocContent} scrollContainerRef={contentAreaRef} />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            {entries.length === 0 ? (
              /* 空知识库：宽阔的右栏放完整首访引导（左侧 sidebar 太窄放不下） */
              <DocEmptyState
                title="这是你的知识库"
                description="汇总文档，按结论与时间归档，支持全文搜索与标签筛选。"
                onCreateDocument={onCreateDocument}
                onUploadFile={onUploadFile}
              />
            ) : (
              <div className="text-center">
                <BookOpen size={34} className="mx-auto mb-3" style={{ color: 'rgba(255,255,255,0.10)' }} />
                <p className="text-[13px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  选择左侧文件查看内容
                </p>
                <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                  右键文件可置顶或设为主文档
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          isPrimary={contextMenu.entry.id === primaryEntryId || (contextMenu.entry.parentId ? folderPrimaryMap.get(contextMenu.entry.parentId) === contextMenu.entry.id : false)}
          isPinned={pinnedSet.has(contextMenu.entry.id)}
          onSetPrimary={onSetPrimary}
          onTogglePin={onTogglePin}
          onDelete={onDeleteEntry ? async (entryId) => {
            const target = contextMenu.entry;
            const isFolder = target.isFolder;
            const isGithub = target.sourceType === 'github_directory';
            const isSubscription = target.sourceType === 'subscription' || isGithub;
            const consequence = isGithub
              ? '所有同步来的子文档、解析正文、附件、同步日志'
              : isFolder
                ? '文件夹下所有子文档、解析正文、附件、同步日志'
                : isSubscription
                  ? '解析正文、同步日志'
                  : '解析正文、附件文件';
            const confirmed = await systemDialog.confirm({
              title: `确认删除${isFolder ? '文件夹' : '文档'}`,
              message: `删除「${target.title}」将永久清除：\n  · ${consequence}\n\n此操作不可恢复。`,
              tone: 'danger',
              confirmText: '永久删除',
              cancelText: '取消',
            });
            if (confirmed) onDeleteEntry(entryId);
          } : undefined}
          onEditTags={onUpdateEntryTags ? (entry) => setTagEditEntry(entry) : undefined}
          onRename={onRenameEntry ? (entry) => setRenameEntry(entry) : undefined}
          onGenerateSubtitle={onGenerateSubtitle}
          onReprocess={onReprocess}
          onShareEntry={onShareEntry}
          onReplaceFile={onReplaceFile}
          onClose={() => setContextMenu(null)}
        />
      )}

      {tagEditEntry && onUpdateEntryTags && (
        <EntryTagEditor
          entry={tagEditEntry}
          onClose={() => setTagEditEntry(null)}
          onSave={async (tags) => {
            await onUpdateEntryTags(tagEditEntry.id, tags);
          }}
        />
      )}

      {renameEntry && onRenameEntry && (
        <EntryRenameDialog
          entry={renameEntry}
          onClose={() => setRenameEntry(null)}
          onSave={async (newTitle) => {
            await onRenameEntry(renameEntry.id, newTitle);
          }}
        />
      )}

      {/* 验收报告证据关系图（探案证据板） */}
      {evidenceGraphOpen && preview?.text && (
        <AcceptanceEvidenceGraph
          content={preview.text}
          title={entries.find(e => e.id === selectedEntryId)?.title ?? '验收报告'}
          onClose={() => setEvidenceGraphOpen(false)}
        />
      )}

      {/* 批次 D：划词评论抽屉 */}
      {inlineCommentsOpen && trackedEntryForComments && (
        <InlineCommentDrawer
          entryId={trackedEntryForComments.id}
          entryTitle={trackedEntryForComments.title}
          shareToken={inlineCommentShareToken}
          pendingSelection={pendingSelection}
          onClearPending={() => setPendingSelection(null)}
          onLocate={(text) => {
            // 在 content area 的 DOM 里查找文本并 scroll / 高亮
            scrollToTextInContainer(contentAreaRef.current, text);
          }}
          onClose={() => {
            setInlineCommentsOpen(false);
            setPendingSelection(null);
            // 关闭时刷新评论计数（新建/删除/无变化都通用）；带 fetchIdRef 守卫，
            // 关闭后立刻切换条目时旧响应不覆盖新计数（PR #685 Bugbot Low）
            if (trackedEntryForComments) {
              const entryId = trackedEntryForComments.id;
              const myId = ++commentCountFetchIdRef.current;
              listInlineComments(entryId, inlineCommentShareToken).then((res) => {
                if (myId === commentCountFetchIdRef.current && res.success) {
                  setCommentCount(res.data.items.length);
                  setInlineCommentItems(res.data.items);
                }
              }).catch(() => {});
            }
          }}
        />
      )}
    </div>
    </TagColorsContext.Provider>
  );
}

// ── 批次 D：划词选中时的浮层按钮 ──

function SelectionActionPopover({
  selection,
  onAddComment,
}: {
  selection: ContentSelectionInfo;
  onAddComment: () => void;
}) {
  // 浮层定位：选中区上方；跨出视口时转到下方
  const top = Math.max(8, selection.rect.top - 38);
  const left = Math.max(8, Math.min(window.innerWidth - 140, selection.rect.left + selection.rect.width / 2 - 60));
  return (
    <div
      className="fixed z-40 h-8 px-3 rounded-[10px] flex items-center gap-1.5 cursor-pointer transition-all"
      style={{
        top,
        left,
        background: 'rgba(20,20,30,0.92)',
        border: '1px solid rgba(168,85,247,0.4)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAddComment}
    >
      <MessageSquarePlus size={13} style={{ color: 'rgba(216,180,254,0.95)' }} />
      <span className="text-[11px] font-semibold" style={{ color: 'rgba(216,180,254,0.95)' }}>
        添加评论
      </span>
    </div>
  );
}

/**
 * 批次 D：在容器 DOM 里查找指定文本并 scroll + 闪烁高亮。
 * 使用 TreeWalker 遍历所有 text node，找到第一处匹配即停。
 */
function scrollToTextInContainer(container: HTMLElement | null, text: string) {
  if (!container || !text) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textContent = node.textContent ?? '';
    const idx = textContent.indexOf(text);
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const el = (node.parentElement ?? container) as HTMLElement;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 闪烁高亮：短暂添加一个 class
      const originalBg = el.style.backgroundColor;
      const originalTransition = el.style.transition;
      el.style.transition = 'background-color 0.6s';
      el.style.backgroundColor = 'rgba(168,85,247,0.22)';
      window.setTimeout(() => {
        el.style.backgroundColor = originalBg;
        window.setTimeout(() => { el.style.transition = originalTransition; }, 600);
      }, 1200);
      return;
    }
  }
}
