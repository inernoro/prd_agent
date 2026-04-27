import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, Calendar, ChevronLeft, ChevronRight, RefreshCw, Inbox,
  Tag, Code2, Users, MessageCircle, FileText, TestTube, Check, MoreHorizontal,
  X, ChevronDown, ChevronUp,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listDailyLogs, getMyDailyLogTags } from '@/services';
import { DailyLogCategory } from '@/services/contracts/reportAgent';
import type { DailyLog } from '@/services/contracts/reportAgent';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';
import { useDataTheme } from '../hooks/useDataTheme';

const PAGE_SIZE = 20;

// 时间范围预设：默认最近 30 天
type DateRangePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  '90d': '最近 90 天',
  'all': '全部',
  'custom': '自定义',
};

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getWeekDayLabel(date: Date): string {
  return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
}

function formatDayHeader(dateStr: string): string {
  const d = parseDate(dateStr);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  let prefix = '';
  if (sameDay(d, today)) prefix = '今天 · ';
  else if (sameDay(d, yest)) prefix = '昨天 · ';
  return `${prefix}${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${getWeekDayLabel(d)}`;
}

function computeDateRange(preset: DateRangePreset, customStart?: string, customEnd?: string): { start?: string; end?: string } {
  const today = new Date();
  const todayStr = formatDate(today);
  if (preset === 'all') return {};
  if (preset === 'custom') return { start: customStart, end: customEnd };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - days + 1);
  return { start: formatDate(startDate), end: todayStr };
}

const SYSTEM_CATEGORIES = [
  DailyLogCategory.Development,
  DailyLogCategory.Meeting,
  DailyLogCategory.Communication,
  DailyLogCategory.Documentation,
  DailyLogCategory.Testing,
  DailyLogCategory.Todo,
  DailyLogCategory.Other,
] as const;

function buildCategoryConfig(isLight: boolean): Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> {
  if (isLight) {
    return {
      development:   { label: '开发', color: 'rgba(29, 78, 216, 1)',   bg: 'rgba(29, 78, 216, 0.10)',   icon: Code2 },
      meeting:       { label: '会议', color: 'rgba(126, 34, 206, 1)',  bg: 'rgba(126, 34, 206, 0.10)',  icon: Users },
      communication: { label: '沟通', color: 'rgba(194, 65, 12, 1)',   bg: 'rgba(194, 65, 12, 0.10)',   icon: MessageCircle },
      documentation: { label: '文档', color: 'rgba(21, 128, 61, 1)',   bg: 'rgba(21, 128, 61, 0.10)',   icon: FileText },
      testing:       { label: '测试', color: 'rgba(190, 24, 93, 1)',   bg: 'rgba(190, 24, 93, 0.10)',   icon: TestTube },
      todo:          { label: 'Todo', color: 'rgba(4, 120, 87, 1)',    bg: 'rgba(4, 120, 87, 0.10)',    icon: Check },
      other:         { label: '其他', color: 'rgba(71, 85, 105, 1)',   bg: 'rgba(71, 85, 105, 0.10)',   icon: MoreHorizontal },
    };
  }
  return {
    development:   { label: '开发', color: 'rgba(59, 130, 246, 0.95)',  bg: 'rgba(59, 130, 246, 0.12)',  icon: Code2 },
    meeting:       { label: '会议', color: 'rgba(168, 85, 247, 0.95)',  bg: 'rgba(168, 85, 247, 0.12)',  icon: Users },
    communication: { label: '沟通', color: 'rgba(249, 115, 22, 0.95)',  bg: 'rgba(249, 115, 22, 0.12)',  icon: MessageCircle },
    documentation: { label: '文档', color: 'rgba(34, 197, 94, 0.95)',   bg: 'rgba(34, 197, 94, 0.12)',   icon: FileText },
    testing:       { label: '测试', color: 'rgba(236, 72, 153, 0.95)',  bg: 'rgba(236, 72, 153, 0.12)',  icon: TestTube },
    todo:          { label: 'Todo', color: 'rgba(16, 185, 129, 0.95)',  bg: 'rgba(16, 185, 129, 0.12)',  icon: Check },
    other:         { label: '其他', color: 'rgba(148, 163, 184, 0.95)', bg: 'rgba(148, 163, 184, 0.12)', icon: MoreHorizontal },
  };
}

export function MyRecordsListPanel() {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const CATEGORY_CONFIG = useMemo(() => buildCategoryConfig(isLight), [isLight]);

  // ── Filter state ──
  const [keyword, setKeyword] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  // ── Data state ──
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>({});
  const [availableTags, setAvailableTags] = useState<string[]>([]);

  // ── Load my custom tags for filter chips ──
  useEffect(() => {
    let cancelled = false;
    void getMyDailyLogTags().then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setAvailableTags(res.data.items);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Fetch logs ──
  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = computeDateRange(datePreset, customStart, customEnd);
      const res = await listDailyLogs({
        startDate: range.start,
        endDate: range.end,
        keyword: keyword || undefined,
        categories: selectedCategories.length > 0 ? selectedCategories : undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      if (res.success && res.data) {
        setLogs(res.data.items);
        setTotal(res.data.total ?? res.data.items.length);
        setHasMore(res.data.hasMore ?? false);
      } else {
        setError(res.error?.message ?? '加载失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [datePreset, customStart, customEnd, keyword, selectedCategories, selectedTags, page]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  // ── Filter event handlers (reset page on filter change) ──
  const onKeywordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setKeyword(keywordInput.trim());
    setPage(1);
  };

  const onClearKeyword = () => {
    setKeywordInput('');
    setKeyword('');
    setPage(1);
  };

  const onPresetChange = (preset: DateRangePreset) => {
    setDatePreset(preset);
    setPage(1);
  };

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
    setPage(1);
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
    setPage(1);
  };

  const onResetFilters = () => {
    setKeyword('');
    setKeywordInput('');
    setDatePreset('30d');
    setCustomStart('');
    setCustomEnd('');
    setSelectedCategories([]);
    setSelectedTags([]);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilter =
    !!keyword
    || datePreset !== '30d'
    || selectedCategories.length > 0
    || selectedTags.length > 0;

  const toggleCollapsed = (date: string) => {
    setCollapsedDays((prev) => ({ ...prev, [date]: !prev[date] }));
  };

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* ── Filter bar ── */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex flex-col gap-3">
          {/* 搜索 + 时间范围 */}
          <div className="flex items-center gap-2 flex-wrap">
            <form onSubmit={onKeywordSubmit} className="flex items-center gap-1.5 flex-1 min-w-[240px]">
              <div
                className="flex items-center gap-2 flex-1 px-3 py-1.5 rounded-lg"
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                }}
              >
                <Search size={14} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  placeholder="搜索工作内容或标签..."
                  className="flex-1 bg-transparent outline-none text-[13px]"
                  style={{ color: 'var(--text-primary)' }}
                />
                {keywordInput && (
                  <button
                    type="button"
                    onClick={onClearKeyword}
                    className="opacity-60 hover:opacity-100"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <Button type="submit" variant="primary" size="sm" disabled={loading}>
                搜索
              </Button>
            </form>

            <div
              className="inline-flex items-center p-0.5 rounded-lg"
              style={{
                background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
                border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
              }}
            >
              {(['7d', '30d', '90d', 'all', 'custom'] as DateRangePreset[]).map((p) => {
                const active = datePreset === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className="whitespace-nowrap px-2.5 py-1 rounded-md text-[12px] font-medium transition-all duration-200"
                    style={{
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: active
                        ? (isLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)')
                        : 'transparent',
                      boxShadow: active && isLight ? 'var(--shadow-card-active)' : 'none',
                    }}
                    onClick={() => onPresetChange(p)}
                  >
                    {DATE_RANGE_LABELS[p]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 自定义日期 */}
          {datePreset === 'custom' && (
            <div className="flex items-center gap-2 flex-wrap">
              <div
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
              >
                <Calendar size={13} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => { setCustomStart(e.target.value); setPage(1); }}
                  className="text-[12px] bg-transparent outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>至</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => { setCustomEnd(e.target.value); setPage(1); }}
                  className="text-[12px] bg-transparent outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
              </div>
            </div>
          )}

          {/* 系统分类筛选 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] mr-1" style={{ color: 'var(--text-muted)' }}>分类</span>
            {SYSTEM_CATEGORIES.map((cat) => {
              const cfg = CATEGORY_CONFIG[cat];
              const Icon = cfg.icon;
              const active = selectedCategories.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium transition-all"
                  style={{
                    color: active ? cfg.color : 'var(--text-muted)',
                    background: active ? cfg.bg : 'transparent',
                    border: `1px solid ${active ? cfg.color.replace(/[\d.]+\)$/, '0.4)') : 'var(--border-primary)'}`,
                  }}
                  onClick={() => toggleCategory(cat)}
                >
                  <Icon size={11} />
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {/* 自定义标签筛选 */}
          {availableTags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] mr-1" style={{ color: 'var(--text-muted)' }}>标签</span>
              {availableTags.map((tag) => {
                const active = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium transition-all"
                    style={{
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: active
                        ? (isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.08)')
                        : 'transparent',
                      border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border-primary)'}`,
                    }}
                    onClick={() => toggleTag(tag)}
                  >
                    <Tag size={10} />
                    {tag}
                  </button>
                );
              })}
            </div>
          )}

          {/* 状态条 */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {loading
                ? '加载中…'
                : total > 0
                  ? `共 ${total} 天有记录${hasActiveFilter ? '（已筛选）' : ''}`
                  : '暂无记录'}
            </div>
            <div className="flex items-center gap-1.5">
              {hasActiveFilter && (
                <Button variant="ghost" size="xs" onClick={onResetFilters}>
                  <X size={11} /> 重置
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={() => void loadLogs()} disabled={loading}>
                <RefreshCw size={11} /> 刷新
              </Button>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* ── List ── */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain', scrollbarWidth: 'thin' }}>
        {error && (
          <GlassCard variant="subtle" className="px-4 py-3 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{error}</span>
              <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                <RefreshCw size={12} /> 重试
              </Button>
            </div>
          </GlassCard>
        )}

        {loading && logs.length === 0 && (
          <div className="py-10">
            <MapSectionLoader text="加载我的记录…" />
          </div>
        )}

        {!loading && logs.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <Inbox size={26} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            </div>
            <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {hasActiveFilter ? '没有匹配的记录' : '当前时间范围内还没有日常记录'}
            </div>
            {hasActiveFilter && (
              <Button variant="secondary" size="sm" onClick={onResetFilters}>
                清除筛选
              </Button>
            )}
          </div>
        )}

        {/* Day cards */}
        <div className="flex flex-col gap-3">
          {logs.map((log) => {
            const dateStr = log.date.slice(0, 10);
            const collapsed = !!collapsedDays[dateStr];
            const itemCount = log.items.length;
            // 每张卡内出现的分类徽标（去重，按 SYSTEM_CATEGORIES 顺序）
            const categoryBadges = SYSTEM_CATEGORIES.filter((c) => log.items.some((i) => i.category === c));
            return (
              <GlassCard key={log.id || dateStr} variant="subtle" className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => toggleCollapsed(dateStr)}
                  className="w-full flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {formatDayHeader(dateStr)}
                    </span>
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--bg-tertiary)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {itemCount} 条
                    </span>
                    {categoryBadges.map((c) => {
                      const cfg = CATEGORY_CONFIG[c];
                      const Icon = cfg.icon;
                      return (
                        <span
                          key={c}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium"
                          style={{ color: cfg.color, background: cfg.bg }}
                        >
                          <Icon size={10} />
                          {cfg.label}
                        </span>
                      );
                    })}
                  </div>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  </span>
                </button>

                {!collapsed && (
                  <ul className="flex flex-col gap-2 mt-3">
                    {log.items.map((item, idx) => {
                      const cfg = CATEGORY_CONFIG[item.category] ?? CATEGORY_CONFIG.other;
                      const Icon = cfg.icon;
                      return (
                        <li
                          key={idx}
                          className="flex items-start gap-2 px-2.5 py-2 rounded-lg"
                          style={{
                            background: isLight ? 'rgba(15, 23, 42, 0.025)' : 'rgba(255, 255, 255, 0.025)',
                            border: '1px solid var(--border-primary)',
                          }}
                        >
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded shrink-0 mt-0.5"
                            style={{ background: cfg.bg, color: cfg.color }}
                          >
                            <Icon size={12} />
                          </span>
                          <div className="flex flex-col gap-1 flex-1 min-w-0">
                            <RichTextMarkdownContent content={item.content} />
                            {(item.tags && item.tags.length > 0) && (
                              <div className="flex items-center gap-1 flex-wrap">
                                {item.tags.map((t) => (
                                  <span
                                    key={t}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10.5px]"
                                    style={{
                                      background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.05)',
                                      color: 'var(--text-secondary)',
                                      border: '1px solid var(--border-primary)',
                                    }}
                                  >
                                    <Tag size={9} /> {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </GlassCard>
            );
          })}
        </div>

        {/* 分页 */}
        {logs.length > 0 && total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-2 mt-4 mb-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
            >
              <ChevronLeft size={12} /> 上一页
            </Button>
            <span className="text-[12px] px-2" style={{ color: 'var(--text-secondary)' }}>
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore || loading}
            >
              下一页 <ChevronRight size={12} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
