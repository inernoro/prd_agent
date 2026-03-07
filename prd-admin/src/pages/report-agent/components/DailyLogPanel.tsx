import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Send, Trash2, ChevronLeft, ChevronRight, Clock, Calendar,
  Pencil, Check, X, Flame, Code2, Users, MessageCircle, FileText, TestTube, MoreHorizontal,
  GitCommit, Sparkles, Plus,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import {
  saveDailyLog,
  getDailyLog,
  deleteDailyLog,
  listDailyLogs,
  listPersonalSources,
  listDataSourceCommits,
} from '@/services';
import {
  DailyLogCategory,
} from '@/services/contracts/reportAgent';
import type { DailyLog, DailyLogItem, ReportCommit, PersonalSource } from '@/services/contracts/reportAgent';

// ── Helpers ────────────────────────────────────────────

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

function formatMinutes(min: number): string {
  if (min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

function getWeekDayLabel(date: Date): string {
  return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
}

function getDateDisplayLabel(dateStr: string): string {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${getWeekDayLabel(d)}`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function truncateCommitMsg(msg: string): string {
  const firstLine = msg.split('\n')[0];
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
}

// Category config with colors and icons
const CATEGORY_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  development:   { label: '开发', color: 'rgba(59, 130, 246, 0.95)',  bg: 'rgba(59, 130, 246, 0.12)',  icon: Code2 },
  meeting:       { label: '会议', color: 'rgba(168, 85, 247, 0.95)',  bg: 'rgba(168, 85, 247, 0.12)',  icon: Users },
  communication: { label: '沟通', color: 'rgba(249, 115, 22, 0.95)',  bg: 'rgba(249, 115, 22, 0.12)',  icon: MessageCircle },
  documentation: { label: '文档', color: 'rgba(34, 197, 94, 0.95)',   bg: 'rgba(34, 197, 94, 0.12)',   icon: FileText },
  testing:       { label: '测试', color: 'rgba(236, 72, 153, 0.95)',  bg: 'rgba(236, 72, 153, 0.12)',  icon: TestTube },
  other:         { label: '其他', color: 'rgba(148, 163, 184, 0.95)', bg: 'rgba(148, 163, 184, 0.12)', icon: MoreHorizontal },
};

interface LogItemInput {
  content: string;
  category: string;
  durationMinutes: number | undefined;
}

// ── Main Component ─────────────────────────────────────

export function DailyLogPanel() {
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [items, setItems] = useState<LogItemInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [existingLog, setExistingLog] = useState<DailyLog | null>(null);
  const [weekLogs, setWeekLogs] = useState<DailyLog[]>([]);

  // Quick input state
  const [quickInput, setQuickInput] = useState('');
  const [quickCategory, setQuickCategory] = useState<string>(DailyLogCategory.Development);
  const inputRef = useRef<HTMLInputElement>(null);

  // Editing state
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDuration, setEditDuration] = useState<number | undefined>(undefined);

  // Data source commits
  const [dataSources, setDataSources] = useState<PersonalSource[]>([]);
  const [dayCommits, setDayCommits] = useState<ReportCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);

  const isToday = selectedDate === formatDate(new Date());

  // ── Data Loading ──

  const loadWeekLogs = useCallback(async () => {
    const d = parseDate(selectedDate);
    const dayOfWeek = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const res = await listDailyLogs({
      startDate: formatDate(monday),
      endDate: formatDate(sunday),
    });
    if (res.success && res.data) {
      setWeekLogs(res.data.items);
    }
  }, [selectedDate]);

  const loadLog = useCallback(async () => {
    setLoaded(false);
    const res = await getDailyLog({ date: selectedDate });
    if (res.success && res.data && res.data.items.length > 0) {
      setExistingLog(res.data);
      setItems(
        res.data.items.map((i: DailyLogItem) => ({
          content: i.content,
          category: i.category,
          durationMinutes: i.durationMinutes,
        }))
      );
    } else {
      setExistingLog(null);
      setItems([]);
    }
    setLoaded(true);
  }, [selectedDate]);

  // Load personal data sources once
  useEffect(() => {
    void (async () => {
      const res = await listPersonalSources();
      if (res.success && res.data) {
        setDataSources(res.data.items.filter((s) => s.enabled));
      }
    })();
  }, []);

  // Load commits for the selected date
  const loadDayCommits = useCallback(async () => {
    if (dataSources.length === 0) {
      setDayCommits([]);
      return;
    }
    setCommitsLoading(true);
    const d = parseDate(selectedDate);
    const since = new Date(d);
    since.setHours(0, 0, 0, 0);
    const until = new Date(d);
    until.setHours(23, 59, 59, 999);

    const allCommits: ReportCommit[] = [];
    for (const src of dataSources) {
      try {
        const res = await listDataSourceCommits({
          id: src.id,
          since: since.toISOString(),
          until: until.toISOString(),
          limit: 50,
        });
        if (res.success && res.data) {
          allCommits.push(...res.data.items);
        }
      } catch {
        // Silently skip failed sources
      }
    }
    // Sort by time desc
    allCommits.sort((a, b) => new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime());
    setDayCommits(allCommits);
    setCommitsLoading(false);
  }, [selectedDate, dataSources]);

  useEffect(() => {
    void loadLog();
    void loadWeekLogs();
  }, [loadLog, loadWeekLogs]);

  useEffect(() => {
    void loadDayCommits();
  }, [loadDayCommits]);

  // ── Actions ──

  const doSave = async (newItems: LogItemInput[]) => {
    const validItems = newItems.filter((i) => i.content.trim());
    if (validItems.length === 0) return;
    setSaving(true);
    const res = await saveDailyLog({
      date: selectedDate,
      items: validItems.map((i) => ({
        content: i.content.trim(),
        category: i.category,
        durationMinutes: i.durationMinutes,
      })),
    });
    setSaving(false);
    if (res.success) {
      toast.success('已保存');
      setExistingLog(res.data ?? null);
      void loadWeekLogs();
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  };

  const handleQuickAdd = async () => {
    const text = quickInput.trim();
    if (!text) return;
    const newItem: LogItemInput = { content: text, category: quickCategory, durationMinutes: undefined };
    const newItems = [...items, newItem];
    setItems(newItems);
    setQuickInput('');
    inputRef.current?.focus();
    await doSave(newItems);
  };

  const handleQuickKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleQuickAdd();
    }
  };

  const handleQuickCategoryClick = (cat: string) => {
    const text = quickInput.trim();
    if (text) {
      const newItem: LogItemInput = { content: text, category: cat, durationMinutes: undefined };
      const newItems = [...items, newItem];
      setItems(newItems);
      setQuickInput('');
      setQuickCategory(cat);
      inputRef.current?.focus();
      void doSave(newItems);
    } else {
      setQuickCategory(cat);
      inputRef.current?.focus();
    }
  };

  const handleDeleteItem = async (idx: number) => {
    const newItems = items.filter((_, i) => i !== idx);
    setItems(newItems);
    if (newItems.length === 0) {
      if (existingLog) {
        const res = await deleteDailyLog({ date: selectedDate });
        if (res.success) {
          setExistingLog(null);
          void loadWeekLogs();
        }
      }
    } else {
      await doSave(newItems);
    }
  };

  const handleDeleteAll = async () => {
    if (!existingLog) return;
    if (!window.confirm('确认删除当天所有记录？')) return;
    const res = await deleteDailyLog({ date: selectedDate });
    if (res.success) {
      toast.success('已删除');
      setExistingLog(null);
      setItems([]);
      void loadWeekLogs();
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditContent(items[idx].content);
    setEditCategory(items[idx].category);
    setEditDuration(items[idx].durationMinutes);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
  };

  const confirmEdit = async () => {
    if (editingIdx === null) return;
    const newItems = items.map((item, i) =>
      i === editingIdx ? { content: editContent, category: editCategory, durationMinutes: editDuration } : item
    );
    setItems(newItems);
    setEditingIdx(null);
    await doSave(newItems);
  };

  const navigateDate = (offset: number) => {
    const d = parseDate(selectedDate);
    d.setDate(d.getDate() + offset);
    setSelectedDate(formatDate(d));
  };

  // Add a commit as a daily log item
  const handleAddCommitAsLog = async (commit: ReportCommit) => {
    const content = `${truncateCommitMsg(commit.message)}`;
    const newItem: LogItemInput = { content, category: DailyLogCategory.Development, durationMinutes: undefined };
    const newItems = [...items, newItem];
    setItems(newItems);
    await doSave(newItems);
    toast.success('已补充到日志');
  };

  // Batch add all unrecorded commits
  const handleAddAllUnrecordedCommits = async () => {
    if (unrecordedCommits.length === 0) return;
    const newLogItems = unrecordedCommits.map((c) => ({
      content: truncateCommitMsg(c.message),
      category: DailyLogCategory.Development,
      durationMinutes: undefined as number | undefined,
    }));
    const newItems = [...items, ...newLogItems];
    setItems(newItems);
    await doSave(newItems);
    toast.success(`已补充 ${unrecordedCommits.length} 条记录`);
  };

  // ── Computed ──

  const todayMinutes = items.reduce((sum, i) => sum + (i.durationMinutes || 0), 0);
  const loggedDates = new Set(weekLogs.map((l) => l.date.substring(0, 10)));

  // Week days array
  const weekDays = useMemo(() => {
    const d = parseDate(selectedDate);
    const dayOfWeek = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek + 1);
    return Array.from({ length: 7 }, (_, i) => {
      const dayDate = new Date(monday);
      dayDate.setDate(monday.getDate() + i);
      const dateStr = formatDate(dayDate);
      const dayLog = weekLogs.find((l) => l.date.substring(0, 10) === dateStr);
      const totalMin = dayLog?.items.reduce((s, it) => s + (it.durationMinutes || 0), 0) || 0;
      const itemCount = dayLog?.items.length || 0;
      return { dateStr, dayDate, totalMin, itemCount, hasLog: loggedDates.has(dateStr) };
    });
  }, [selectedDate, weekLogs, loggedDates]);

  // Category stats for current items
  const categoryStats = useMemo(() => {
    const map: Record<string, { count: number; minutes: number }> = {};
    for (const item of items) {
      if (!map[item.category]) map[item.category] = { count: 0, minutes: 0 };
      map[item.category].count++;
      map[item.category].minutes += item.durationMinutes || 0;
    }
    return Object.entries(map).sort((a, b) => b[1].count - a[1].count);
  }, [items]);

  // Streak count
  const streakCount = useMemo(() => {
    const today = formatDate(new Date());
    let count = 0;
    const d = new Date();
    for (let i = 0; i < 60; i++) {
      const dateStr = formatDate(d);
      if (dateStr === today) {
        if (items.length > 0 || loggedDates.has(dateStr)) count++;
        else break;
      } else if (loggedDates.has(dateStr)) {
        count++;
      } else {
        break;
      }
      d.setDate(d.getDate() - 1);
    }
    return count;
  }, [items, loggedDates]);

  // Week logged count
  const weekLoggedCount = useMemo(
    () => weekDays.filter((d) => d.hasLog).length,
    [weekDays]
  );

  // Max minutes in the week for heatmap scaling
  const maxWeekMin = useMemo(() => {
    return Math.max(...weekDays.map((d) => d.totalMin), 1);
  }, [weekDays]);

  // Unrecorded commits: commits whose message doesn't appear in items
  const unrecordedCommits = useMemo(() => {
    const itemContents = new Set(items.map((i) => i.content.toLowerCase()));
    return dayCommits.filter((c) => {
      const msg = truncateCommitMsg(c.message).toLowerCase();
      // Check if any existing item contains this commit message or vice versa
      return !Array.from(itemContents).some((content) =>
        content.includes(msg) || msg.includes(content)
      );
    });
  }, [dayCommits, items]);

  // ── Render ──

  return (
    <div className="flex flex-col gap-4">
      {/* ── Top Bar: Date nav + streak ── */}
      <GlassCard variant="subtle" className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
            <Button variant="ghost" size="sm" onClick={() => navigateDate(-1)}>
              <ChevronLeft size={14} />
            </Button>
            <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {getDateDisplayLabel(selectedDate)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => navigateDate(1)}>
              <ChevronRight size={14} />
            </Button>
            {!isToday && (
              <Button variant="ghost" size="sm" onClick={() => setSelectedDate(formatDate(new Date()))}>
                今天
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {items.length > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {items.length} 条记录{todayMinutes > 0 && ` · ${formatMinutes(todayMinutes)}`}
              </span>
            )}
            {/* Week check-in + streak */}
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <span>本周已打卡 {weekLoggedCount}/7</span>
              {streakCount > 1 && (
                <span className="flex items-center gap-0.5" style={{ color: 'rgba(249, 115, 22, 0.9)' }}>
                  <Flame size={13} /> {streakCount}天
                </span>
              )}
            </div>
            {existingLog && (
              <Button variant="ghost" size="sm" onClick={handleDeleteAll}>
                <Trash2 size={12} /> 清空
              </Button>
            )}
          </div>
        </div>
      </GlassCard>

      {/* ── Main two-column layout ── */}
      <div className="flex gap-4" style={{ minHeight: 'calc(100vh - 240px)' }}>
        {/* ── Left: Main Content ── */}
        <div className="flex-1 flex flex-col gap-4">
          {/* Quick input area */}
          <GlassCard variant="subtle" className="px-4 py-3">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  className="flex-1 px-3 py-2 rounded-xl text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-primary)',
                  }}
                  placeholder={isToday ? '💬 今天做了什么...' : `💬 ${getDateDisplayLabel(selectedDate)} 做了什么...`}
                  value={quickInput}
                  onChange={(e) => setQuickInput(e.target.value)}
                  onKeyDown={handleQuickKeyDown}
                  disabled={saving}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleQuickAdd}
                  disabled={!quickInput.trim() || saving}
                  style={{ borderRadius: 12 }}
                >
                  <Send size={13} />
                </Button>
              </div>
              {/* Category quick-pick tags */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => {
                  const isActive = quickCategory === key;
                  const Icon = cfg.icon;
                  return (
                    <button
                      key={key}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                      style={{
                        background: isActive ? cfg.bg : 'transparent',
                        color: isActive ? cfg.color : 'var(--text-muted)',
                        border: `1px solid ${isActive ? cfg.color.replace('0.95', '0.3') : 'transparent'}`,
                      }}
                      onClick={() => handleQuickCategoryClick(key)}
                    >
                      <Icon size={11} />
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </GlassCard>

          {/* Timeline / Items */}
          {!loaded ? (
            <GlassCard className="p-8 text-center">
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            </GlassCard>
          ) : items.length === 0 && dayCommits.length === 0 ? (
            /* ── Empty State ── */
            <div className="flex-1 flex items-center justify-center" style={{ minHeight: 300 }}>
              <div className="flex flex-col items-center gap-5 text-center max-w-sm">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center text-[28px]"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  {isToday ? '☀️' : '📋'}
                </div>
                <div>
                  <div className="text-[15px] font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                    {isToday ? '今天还没有记录' : `${getDateDisplayLabel(selectedDate)} 暂无记录`}
                  </div>
                  <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    在上方输入框快速记一笔，或点击下方标签快速开始
                  </div>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    { cat: 'development', text: '写了代码', emoji: '🔨' },
                    { cat: 'meeting', text: '开了会', emoji: '📋' },
                    { cat: 'communication', text: '做了沟通', emoji: '💬' },
                    { cat: 'documentation', text: '写了文档', emoji: '📝' },
                    { cat: 'testing', text: '跑了测试', emoji: '🧪' },
                  ].map(({ cat, text, emoji }) => (
                    <button
                      key={cat}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium transition-all duration-150 hover:scale-[1.03]"
                      style={{
                        background: CATEGORY_CONFIG[cat]?.bg || 'var(--bg-tertiary)',
                        color: CATEGORY_CONFIG[cat]?.color || 'var(--text-secondary)',
                        border: `1px solid ${(CATEGORY_CONFIG[cat]?.color || '').replace('0.95', '0.2')}`,
                      }}
                      onClick={() => {
                        setQuickInput(text);
                        setQuickCategory(cat);
                        inputRef.current?.focus();
                      }}
                    >
                      <span>{emoji}</span> {text}
                    </button>
                  ))}
                </div>
                <div
                  className="text-[11px] px-4 py-2 rounded-lg"
                  style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                >
                  💡 每日打点会在生成周报时被 AI 自动汇总归纳
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {/* ── 今日记录 (手动) ── */}
              {items.length > 0 && (
                <>
                  <div className="text-[11px] font-medium px-1 mb-1" style={{ color: 'var(--text-muted)' }}>
                    ── 今日记录 ──
                  </div>
                  {items.map((item, idx) => {
                    const cfg = CATEGORY_CONFIG[item.category] || CATEGORY_CONFIG.other;
                    const Icon = cfg.icon;
                    const isEditing = editingIdx === idx;

                    return (
                      <div key={idx} className="group flex items-start gap-3 py-2 px-3 rounded-xl transition-colors duration-150 hover:bg-[var(--bg-tertiary)]">
                        {/* Timeline dot */}
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                          style={{ background: cfg.bg }}
                        >
                          <Icon size={13} style={{ color: cfg.color }} />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <div className="flex flex-col gap-2">
                              <input
                                type="text"
                                className="w-full px-3 py-1.5 rounded-lg text-[13px] outline-none"
                                style={{
                                  background: 'var(--bg-secondary)',
                                  color: 'var(--text-primary)',
                                  border: '1px solid var(--border-primary)',
                                }}
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void confirmEdit();
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                autoFocus
                              />
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="flex gap-1">
                                  {Object.entries(CATEGORY_CONFIG).map(([key, c]) => {
                                    const CIcon = c.icon;
                                    return (
                                      <button
                                        key={key}
                                        className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                        style={{
                                          background: editCategory === key ? c.bg : 'transparent',
                                          color: editCategory === key ? c.color : 'var(--text-muted)',
                                        }}
                                        onClick={() => setEditCategory(key)}
                                      >
                                        <CIcon size={10} className="inline mr-0.5" />
                                        {c.label}
                                      </button>
                                    );
                                  })}
                                </div>
                                <div className="flex items-center gap-1 ml-2">
                                  <Clock size={11} style={{ color: 'var(--text-muted)' }} />
                                  <input
                                    type="number"
                                    className="w-14 px-1.5 py-0.5 rounded text-[11px] outline-none"
                                    style={{
                                      background: 'var(--bg-secondary)',
                                      color: 'var(--text-primary)',
                                      border: '1px solid var(--border-primary)',
                                    }}
                                    placeholder="分钟"
                                    value={editDuration ?? ''}
                                    min={0}
                                    onChange={(e) => setEditDuration(e.target.value ? Number(e.target.value) : undefined)}
                                  />
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>min</span>
                                </div>
                                <div className="flex-1" />
                                <Button variant="ghost" size="xs" onClick={cancelEdit}>
                                  <X size={12} />
                                </Button>
                                <Button variant="primary" size="xs" onClick={() => void confirmEdit()}>
                                  <Check size={12} />
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                                {item.content}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ background: cfg.bg, color: cfg.color }}
                                >
                                  {cfg.label}
                                </span>
                                {item.durationMinutes != null && item.durationMinutes > 0 && (
                                  <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                                    <Clock size={9} />
                                    {formatMinutes(item.durationMinutes)}
                                  </span>
                                )}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Actions (visible on hover) */}
                        {!isEditing && (
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              className="p-1 rounded hover:bg-[rgba(255,255,255,0.08)] transition-colors"
                              onClick={() => startEdit(idx)}
                              title="编辑"
                            >
                              <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
                            </button>
                            <button
                              className="p-1 rounded hover:bg-[rgba(239,68,68,0.1)] transition-colors"
                              onClick={() => void handleDeleteItem(idx)}
                              title="删除"
                            >
                              <Trash2 size={12} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {/* ── 来自数据源 (自动) ── */}
              {dayCommits.length > 0 && (
                <>
                  <div className="text-[11px] font-medium px-1 mt-4 mb-1 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                    <GitCommit size={11} />
                    ── 来自数据源 (自动) ──
                    {commitsLoading && <span className="text-[10px]">加载中...</span>}
                  </div>
                  {dayCommits.map((commit) => (
                    <div
                      key={commit.id}
                      className="group flex items-start gap-3 py-2 px-3 rounded-xl transition-colors duration-150 hover:bg-[var(--bg-tertiary)]"
                    >
                      {/* Git icon */}
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ background: 'rgba(148, 163, 184, 0.1)' }}
                      >
                        <GitCommit size={13} style={{ color: 'rgba(148, 163, 184, 0.7)' }} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                          📝 {truncateCommitMsg(commit.message)}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(148, 163, 184, 0.1)', color: 'rgba(148, 163, 184, 0.7)' }}
                          >
                            Git commit
                          </span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {formatTime(commit.committedAt)}
                          </span>
                          {commit.branch && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {commit.branch}
                            </span>
                          )}
                          {(commit.additions > 0 || commit.deletions > 0) && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              <span style={{ color: 'rgba(34, 197, 94, 0.8)' }}>+{commit.additions}</span>
                              {' '}
                              <span style={{ color: 'rgba(239, 68, 68, 0.8)' }}>-{commit.deletions}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Quick add button */}
                      <button
                        className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[rgba(59,130,246,0.1)]"
                        onClick={() => void handleAddCommitAsLog(commit)}
                        title="补充到日志"
                      >
                        <Plus size={12} style={{ color: 'rgba(59, 130, 246, 0.8)' }} />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {/* AI tip at bottom */}
              <div className="mt-2 px-3">
                <div
                  className="text-[10px] px-3 py-1.5 rounded-lg inline-block"
                  style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                >
                  💡 这些记录会在生成周报时被 AI 自动汇总
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Sidebar ── */}
        <div className="w-56 flex-shrink-0 flex flex-col gap-4">
          {/* Heatmap - Weekly Activity */}
          <GlassCard variant="subtle" className="px-3 py-3">
            <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              本周热力图
            </div>
            <div className="flex flex-col gap-1">
              {weekDays.map(({ dateStr, dayDate, totalMin, itemCount, hasLog }, i) => {
                const isSelected = dateStr === selectedDate;
                const isTodayDate = dateStr === formatDate(new Date());
                const dayLabel = ['一', '二', '三', '四', '五', '六', '日'][i];
                const barWidth = hasLog ? Math.max(8, (totalMin / maxWeekMin) * 100) : 0;
                const barColor = hasLog ? 'rgba(59, 130, 246, 0.7)' : 'transparent';

                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-150"
                    style={{
                      background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                    }}
                    onClick={() => setSelectedDate(dateStr)}
                  >
                    <span
                      className="w-4 text-[11px] font-medium text-center"
                      style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-muted)' }}
                    >
                      {dayLabel}
                    </span>
                    <span className="w-8 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {dayDate.getMonth() + 1}/{dayDate.getDate()}
                    </span>
                    <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                      <div
                        className="h-full rounded-sm transition-all duration-300"
                        style={{
                          width: `${barWidth}%`,
                          background: barColor,
                          minWidth: hasLog ? 8 : 0,
                        }}
                      />
                    </div>
                    <span className="w-8 text-right text-[10px]" style={{ color: hasLog ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                      {hasLog ? (totalMin > 0 ? formatMinutes(totalMin) : `${itemCount}条`) : '--'}
                    </span>
                    {isTodayDate && (
                      <span
                        className="text-[8px] px-1 rounded font-medium"
                        style={{ color: 'rgba(59, 130, 246, 0.9)', background: 'rgba(59, 130, 246, 0.1)' }}
                      >
                        今
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {weekDays.some((d) => d.hasLog) && (
              <div className="mt-2.5 pt-2.5 flex justify-between text-[11px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-primary)' }}>
                <span>本周合计</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {formatMinutes(weekDays.reduce((s, d) => s + d.totalMin, 0))} · {weekLoggedCount}/7 天
                </span>
              </div>
            )}
          </GlassCard>

          {/* Category breakdown */}
          {categoryStats.length > 0 && (
            <GlassCard variant="subtle" className="px-3 py-3">
              <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                快捷分类
              </div>
              <div className="flex flex-col gap-2">
                {categoryStats.map(([cat, stat]) => {
                  const cfg = CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.other;
                  const Icon = cfg.icon;
                  return (
                    <div key={cat} className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center"
                        style={{ background: cfg.bg }}
                      >
                        <Icon size={10} style={{ color: cfg.color }} />
                      </div>
                      <span className="flex-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {cfg.label}
                      </span>
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {stat.minutes > 0 ? formatMinutes(stat.minutes) : `${stat.count}条`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          )}

          {/* ── AI 建议 ── */}
          {unrecordedCommits.length > 0 && (
            <GlassCard variant="subtle" className="px-3 py-3">
              <div className="flex items-center gap-1.5 text-[12px] font-medium mb-3" style={{ color: 'rgba(168, 85, 247, 0.9)' }}>
                <Sparkles size={13} />
                AI 建议
              </div>
              <div className="text-[11px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)' }}>
                你有 <strong style={{ color: 'var(--text-primary)' }}>{unrecordedCommits.length}</strong> 个 commit 还没记录，要补充吗？
              </div>
              <div className="flex flex-col gap-1.5 mb-3">
                {unrecordedCommits.slice(0, 3).map((c) => (
                  <div key={c.id} className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                    📝 {truncateCommitMsg(c.message)}
                  </div>
                ))}
                {unrecordedCommits.length > 3 && (
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    ...还有 {unrecordedCommits.length - 3} 条
                  </div>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => void handleAddAllUnrecordedCommits()}
              >
                <Plus size={12} /> 一键补充
              </Button>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  );
}
