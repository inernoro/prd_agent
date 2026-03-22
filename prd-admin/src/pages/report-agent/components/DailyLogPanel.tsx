import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Send, Trash2, ChevronLeft, ChevronRight, Clock, Calendar,
  Pencil, Check, X, Flame, Code2, Users, MessageCircle, FileText, TestTube, MoreHorizontal,
  GitCommit, Sparkles, Plus, Tag,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import {
  saveDailyLog,
  getDailyLog,
  deleteDailyLog,
  listDailyLogs,
  getMyDailyLogTags,
  updateMyDailyLogTags,
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

function getIsoWeekInfo(date: Date): { weekYear: number; weekNumber: number } {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const weekYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { weekYear, weekNumber };
}

function getTodoPlanWeekOptions(baseDateStr: string): { key: 'next' | 'afterNext'; label: string; weekYear: number; weekNumber: number }[] {
  const baseDate = parseDate(baseDateStr);
  const day = baseDate.getDay() || 7;
  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - day + 1);
  const nextWeekMonday = new Date(monday);
  nextWeekMonday.setDate(monday.getDate() + 7);
  const afterNextWeekMonday = new Date(monday);
  afterNextWeekMonday.setDate(monday.getDate() + 14);
  const nextInfo = getIsoWeekInfo(nextWeekMonday);
  const afterNextInfo = getIsoWeekInfo(afterNextWeekMonday);
  return [
    { key: 'next', label: '下周', weekYear: nextInfo.weekYear, weekNumber: nextInfo.weekNumber },
    { key: 'afterNext', label: '下下周', weekYear: afterNextInfo.weekYear, weekNumber: afterNextInfo.weekNumber },
  ];
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
  todo:          { label: 'Todo', color: 'rgba(16, 185, 129, 0.95)',  bg: 'rgba(16, 185, 129, 0.12)',  icon: Check },
  other:         { label: '其他', color: 'rgba(148, 163, 184, 0.95)', bg: 'rgba(148, 163, 184, 0.12)', icon: MoreHorizontal },
};

const MAX_CUSTOM_TAG_COUNT = 20;
const MAX_CUSTOM_TAG_LENGTH = 16;
const SYSTEM_TAG_ORDER = [
  DailyLogCategory.Development,
  DailyLogCategory.Meeting,
  DailyLogCategory.Communication,
  DailyLogCategory.Documentation,
  DailyLogCategory.Testing,
  DailyLogCategory.Todo,
  DailyLogCategory.Other,
] as const;

type TodoPlanTargetKey = 'next' | 'afterNext';

function normalizeCustomTag(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ');
}

interface LogItemInput {
  content: string;
  category: string;
  tags?: string[];
  durationMinutes: number | undefined;
  planWeekYear?: number;
  planWeekNumber?: number;
  createdAt?: string;
}

function dedupePreserveOrder(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
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
  const [selectedSystemTags, setSelectedSystemTags] = useState<string[]>([DailyLogCategory.Development]);
  const [selectedCustomTags, setSelectedCustomTags] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [showTagManager, setShowTagManager] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [editingTagIdx, setEditingTagIdx] = useState<number | null>(null);
  const [editingTagDraft, setEditingTagDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Editing state
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editSystemTags, setEditSystemTags] = useState<string[]>([]);
  const [editCustomTags, setEditCustomTags] = useState<string[]>([]);
  const [editDuration, setEditDuration] = useState<number | undefined>(undefined);
  const [selectedTodoPlanTarget, setSelectedTodoPlanTarget] = useState<TodoPlanTargetKey>('next');
  const [editTodoPlanTarget, setEditTodoPlanTarget] = useState<TodoPlanTargetKey>('next');

  // Data source commits
  const [dataSources, setDataSources] = useState<PersonalSource[]>([]);
  const [dayCommits, setDayCommits] = useState<ReportCommit[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);

  const isToday = selectedDate === formatDate(new Date());
  const todoPlanOptions = useMemo(() => getTodoPlanWeekOptions(selectedDate), [selectedDate]);
  const selectedTodoPlanOption = useMemo(
    () => todoPlanOptions.find((opt) => opt.key === selectedTodoPlanTarget) ?? null,
    [todoPlanOptions, selectedTodoPlanTarget]
  );
  const hasTodoSelected = selectedSystemTags.includes(DailyLogCategory.Todo);
  const hasEditTodoSelected = editSystemTags.includes(DailyLogCategory.Todo);
  const quickInputPlaceholder = hasTodoSelected
    ? '计划做些什么？'
    : (isToday ? '💬 今天做了什么...' : `💬 ${getDateDisplayLabel(selectedDate)} 做了什么...`);

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
          tags: i.tags,
          durationMinutes: i.durationMinutes,
          planWeekYear: i.planWeekYear,
          planWeekNumber: i.planWeekNumber,
          createdAt: i.createdAt,
        }))
      );
    } else {
      setExistingLog(null);
      setItems([]);
    }
    setLoaded(true);
  }, [selectedDate]);

  const saveCustomTags = useCallback(async (nextTags: string[], successMessage?: string) => {
    setSavingTags(true);
    const res = await updateMyDailyLogTags({ items: nextTags });
    setSavingTags(false);
    if (res.success && res.data) {
      setCustomTags(res.data.items);
      if (successMessage) toast.success(successMessage);
      return true;
    }
    toast.error(res.error?.message || '标签保存失败');
    return false;
  }, []);

  // Load personal data sources + custom tags once
  useEffect(() => {
    void (async () => {
      const [sourceRes, tagRes] = await Promise.all([
        listPersonalSources(),
        getMyDailyLogTags(),
      ]);
      if (sourceRes.success && sourceRes.data) {
        setDataSources(sourceRes.data.items.filter((s) => s.enabled));
      }
      if (tagRes.success && tagRes.data) {
        setCustomTags(tagRes.data.items);
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

  const resolveTodoPlanWeek = (targetKey: TodoPlanTargetKey) => (
    todoPlanOptions.find((opt) => opt.key === targetKey) ?? null
  );

  const doSave = async (newItems: LogItemInput[]) => {
    const validItems = newItems.filter((i) => i.content.trim());
    if (validItems.length === 0) return;
    setSaving(true);
    const res = await saveDailyLog({
      date: selectedDate,
      items: validItems.map((i) => ({
        content: i.content.trim(),
        category: i.category,
        tags: i.tags && i.tags.length > 0 ? i.tags : undefined,
        durationMinutes: i.durationMinutes,
        planWeekYear: i.planWeekYear,
        planWeekNumber: i.planWeekNumber,
        createdAt: i.createdAt,
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

  const ensureTodoPlanWeek = (targetKey: TodoPlanTargetKey): { weekYear: number; weekNumber: number } | null => {
    const option = resolveTodoPlanWeek(targetKey);
    if (!option) return null;
    return { weekYear: option.weekYear, weekNumber: option.weekNumber };
  };

  const handleQuickAdd = async () => {
    const text = quickInput.trim();
    if (!text) return;

    const isTodoSelected = selectedSystemTags.includes(DailyLogCategory.Todo);
    const totalSelectedTagCount = selectedSystemTags.length + selectedCustomTags.length;
    if (totalSelectedTagCount === 0) {
      toast.error('请至少选择一个标签');
      return;
    }
    if (isTodoSelected && !selectedTodoPlanOption) {
      toast.error('请选择计划周次');
      return;
    }

    const todoPlanWeek = isTodoSelected ? ensureTodoPlanWeek(selectedTodoPlanTarget) : null;
    if (isTodoSelected && !todoPlanWeek) {
      toast.error('请选择计划周次');
      return;
    }

    const orderedSystemTags = SYSTEM_TAG_ORDER.filter((key) => selectedSystemTags.includes(key));
    const primaryCategory = orderedSystemTags.find((key) => key !== DailyLogCategory.Other) ?? DailyLogCategory.Other;
    const tags = dedupePreserveOrder([...orderedSystemTags, ...selectedCustomTags]);

    const newItem: LogItemInput = {
      content: text,
      category: primaryCategory,
      durationMinutes: undefined,
      tags: tags.length > 0 ? tags : undefined,
      planWeekYear: todoPlanWeek?.weekYear,
      planWeekNumber: todoPlanWeek?.weekNumber,
    };
    const newItems = [...items, newItem];
    setItems(newItems);
    setQuickInput('');
    setSelectedCustomTags([]);
    inputRef.current?.focus();
    await doSave(newItems);
  };

  const handleQuickKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleQuickAdd();
    }
  };

  const handleSystemTagToggle = (tag: string) => {
    setSelectedSystemTags((prev) => {
      const next = prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag];
      if (next.includes(DailyLogCategory.Todo) && !prev.includes(DailyLogCategory.Todo)) {
        setSelectedTodoPlanTarget('next');
      }
      return next;
    });
    inputRef.current?.focus();
  };

  const handleCustomTagToggle = (tag: string) => {
    setSelectedCustomTags((prev) => (
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]
    ));
    inputRef.current?.focus();
  };

  const splitItemTagsForEdit = useCallback((item: LogItemInput) => {
    const rawTags = item.tags ?? [];
    const normalized = dedupePreserveOrder(rawTags);
    const systemTags = normalized.filter((tag) => SYSTEM_TAG_ORDER.includes(tag as typeof SYSTEM_TAG_ORDER[number]));
    const custom = normalized.filter((tag) => !SYSTEM_TAG_ORDER.includes(tag as typeof SYSTEM_TAG_ORDER[number]));

    if (systemTags.length > 0 || custom.length > 0) {
      return { systemTags, customTags: custom };
    }

    // 兼容历史数据：无 tags 时回退到 category
    const fallbackSystem = SYSTEM_TAG_ORDER.includes(item.category as typeof SYSTEM_TAG_ORDER[number])
      ? [item.category]
      : [DailyLogCategory.Other];
    return { systemTags: fallbackSystem, customTags: [] as string[] };
  }, []);

  const handleEditSystemTagToggle = (tag: string) => {
    setEditSystemTags((prev) => (
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]
    ));
  };

  const handleEditCustomTagToggle = (tag: string) => {
    setEditCustomTags((prev) => (
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]
    ));
  };

  const handleAddCustomTag = async () => {
    const nextTag = normalizeCustomTag(tagDraft);
    if (!nextTag) return;
    if (nextTag.length > MAX_CUSTOM_TAG_LENGTH) {
      toast.error(`标签最多 ${MAX_CUSTOM_TAG_LENGTH} 个字符`);
      return;
    }
    const exists = customTags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase());
    if (exists) {
      toast.error('标签已存在');
      return;
    }
    if (customTags.length >= MAX_CUSTOM_TAG_COUNT) {
      toast.error(`最多添加 ${MAX_CUSTOM_TAG_COUNT} 个标签`);
      return;
    }

    const prevTags = customTags;
    const updatedTags = [...customTags, nextTag];
    setCustomTags(updatedTags);
    setTagDraft('');

    const ok = await saveCustomTags(updatedTags, '标签已添加');
    if (!ok) {
      setCustomTags(prevTags);
      setTagDraft(nextTag);
    }
  };

  const handleDeleteCustomTag = async (idx: number) => {
    const removedTag = customTags[idx];
    if (!removedTag) return;
    const prevTags = customTags;
    const prevSelectedCustomTags = selectedCustomTags;
    const updatedTags = customTags.filter((_, i) => i !== idx);
    setCustomTags(updatedTags);
    setSelectedCustomTags((prev) => prev.filter((x) => x.toLowerCase() !== removedTag.toLowerCase()));
    if (editingTagIdx === idx) {
      setEditingTagIdx(null);
      setEditingTagDraft('');
    }

    const ok = await saveCustomTags(updatedTags, '标签已删除');
    if (!ok) {
      setCustomTags(prevTags);
      setSelectedCustomTags(prevSelectedCustomTags);
    }
  };

  const handleConfirmEditCustomTag = async () => {
    if (editingTagIdx === null) return;
    const target = customTags[editingTagIdx];
    if (!target) {
      setEditingTagIdx(null);
      setEditingTagDraft('');
      return;
    }

    const nextTag = normalizeCustomTag(editingTagDraft);
    if (!nextTag) {
      toast.error('标签不能为空');
      return;
    }
    if (nextTag.length > MAX_CUSTOM_TAG_LENGTH) {
      toast.error(`标签最多 ${MAX_CUSTOM_TAG_LENGTH} 个字符`);
      return;
    }

    const duplicated = customTags.some(
      (tag, idx) => idx !== editingTagIdx && tag.toLowerCase() === nextTag.toLowerCase()
    );
    if (duplicated) {
      toast.error('标签已存在');
      return;
    }

    const prevTags = customTags;
    const prevSelectedCustomTags = selectedCustomTags;
    const updatedTags = customTags.map((tag, idx) => (idx === editingTagIdx ? nextTag : tag));
    setCustomTags(updatedTags);
    setSelectedCustomTags((prev) => prev.map((x) => (x.toLowerCase() === target.toLowerCase() ? nextTag : x)));
    setEditingTagIdx(null);
    setEditingTagDraft('');

    const ok = await saveCustomTags(updatedTags, '标签已更新');
    if (!ok) {
      setCustomTags(prevTags);
      setSelectedCustomTags(prevSelectedCustomTags);
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
    const selection = splitItemTagsForEdit(items[idx]);
    setEditSystemTags(selection.systemTags);
    setEditCustomTags(selection.customTags);
    setEditDuration(items[idx].durationMinutes);
    const current = items[idx];
    const option = todoPlanOptions.find(
      (opt) => opt.weekYear === current.planWeekYear && opt.weekNumber === current.planWeekNumber
    );
    setEditTodoPlanTarget(option?.key ?? 'next');
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setEditSystemTags([]);
    setEditCustomTags([]);
  };

  const confirmEdit = async () => {
    if (editingIdx === null) return;
    const editSelectedCount = editSystemTags.length + editCustomTags.length;
    if (editSelectedCount === 0) {
      toast.error('请至少选择一个标签');
      return;
    }

    const isEditTodo = editSystemTags.includes(DailyLogCategory.Todo);
    const editTodoPlanWeek = isEditTodo ? ensureTodoPlanWeek(editTodoPlanTarget) : null;
    if (isEditTodo && !editTodoPlanWeek) {
      toast.error('请选择计划周次');
      return;
    }

    const orderedSystemTags = SYSTEM_TAG_ORDER.filter((key) => editSystemTags.includes(key));
    const primaryCategory = orderedSystemTags.find((key) => key !== DailyLogCategory.Other) ?? DailyLogCategory.Other;
    const tags = dedupePreserveOrder([...orderedSystemTags, ...editCustomTags]);

    const newItems = items.map((item, i) =>
      i === editingIdx
        ? {
            content: editContent,
            category: primaryCategory,
            tags,
            durationMinutes: editDuration,
            planWeekYear: editTodoPlanWeek?.weekYear,
            planWeekNumber: editTodoPlanWeek?.weekNumber,
          }
        : item
    );
    setItems(newItems);
    setEditingIdx(null);
    setEditSystemTags([]);
    setEditCustomTags([]);
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

  const normalizedTagDraft = normalizeCustomTag(tagDraft);
  const tagDraftTooLong = normalizedTagDraft.length > MAX_CUSTOM_TAG_LENGTH;
  const tagLimitReached = customTags.length >= MAX_CUSTOM_TAG_COUNT;
  const canSubmitTagDraft = normalizedTagDraft.length > 0 && !tagDraftTooLong && !tagLimitReached;
  const totalSelectedTagCount = selectedSystemTags.length + selectedCustomTags.length;
  const systemCategoryKeys = useMemo(
    () => SYSTEM_TAG_ORDER.filter((key) => key !== DailyLogCategory.Other),
    []
  );

  const todayMinutes = items.reduce((sum, i) => sum + (i.durationMinutes || 0), 0);
  const loggedDates = useMemo(
    () => new Set(weekLogs.map((l) => l.date.substring(0, 10))),
    [weekLogs]
  );

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
              <span>本周已记录 {weekLoggedCount}/7</span>
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
                  placeholder={quickInputPlaceholder}
                  value={quickInput}
                  onChange={(e) => setQuickInput(e.target.value)}
                  onKeyDown={handleQuickKeyDown}
                  disabled={saving}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleQuickAdd}
                  disabled={!quickInput.trim() || saving || totalSelectedTagCount === 0}
                  style={{ borderRadius: 12 }}
                >
                  <Send size={13} />
                </Button>
              </div>
              {/* Category quick-pick tags */}
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                {systemCategoryKeys.map((key) => {
                  const cfg = CATEGORY_CONFIG[key];
                  const isActive = selectedSystemTags.includes(key);
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
                      onClick={() => handleSystemTagToggle(key)}
                    >
                      <Icon size={11} />
                      {cfg.label}
                    </button>
                  );
                })}
                {customTags.map((tag) => {
                  const isActive = selectedCustomTags.includes(tag);
                  return (
                    <button
                      key={`tag-${tag}`}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                      style={{
                        background: isActive ? 'rgba(20, 184, 166, 0.12)' : 'transparent',
                        color: isActive ? 'rgba(20, 184, 166, 0.95)' : 'var(--text-muted)',
                        border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.3)' : 'transparent'}`,
                      }}
                      onClick={() => handleCustomTagToggle(tag)}
                    >
                      <Tag size={10} />
                      {tag}
                    </button>
                  );
                })}
                {(() => {
                  const key = DailyLogCategory.Other;
                  const cfg = CATEGORY_CONFIG[key];
                  const isActive = selectedSystemTags.includes(key);
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
                      onClick={() => handleSystemTagToggle(key)}
                    >
                      <Icon size={11} />
                      {cfg.label}
                    </button>
                  );
                })()}
                </div>
                <div className="h-4 w-px" style={{ background: 'var(--border-primary)' }} />
                <div className="flex items-center">
                <button
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150 whitespace-nowrap"
                  style={{
                    background: showTagManager ? 'rgba(148, 163, 184, 0.1)' : 'transparent',
                    color: showTagManager ? 'var(--text-secondary)' : 'var(--text-muted)',
                    border: `1px solid ${showTagManager ? 'rgba(148, 163, 184, 0.28)' : 'rgba(148, 163, 184, 0.14)'}`,
                  }}
                  onClick={() => setShowTagManager((v) => !v)}
                >
                  管理标签
                </button>
                </div>
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                已选标签 {totalSelectedTagCount} 个，提交前至少选择 1 个
              </div>
              {hasTodoSelected && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>计划周次</span>
                  {todoPlanOptions.map((opt) => {
                    const isActive = opt.key === selectedTodoPlanTarget;
                    return (
                      <button
                        key={`todo-plan-${opt.key}`}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                        style={{
                          background: isActive ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
                          color: isActive ? 'rgba(16, 185, 129, 0.95)' : 'var(--text-muted)',
                          border: `1px solid ${isActive ? 'rgba(16, 185, 129, 0.3)' : 'rgba(148, 163, 184, 0.18)'}`,
                        }}
                        onClick={() => setSelectedTodoPlanTarget(opt.key)}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
              {showTagManager && (
                <div
                  className="mt-1 rounded-xl px-3 py-2.5 flex flex-col gap-2"
                  style={{
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    background: 'linear-gradient(180deg, rgba(148,163,184,0.06) 0%, rgba(148,163,184,0.03) 100%)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>自定义标签</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {customTags.length}/{MAX_CUSTOM_TAG_COUNT}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 px-3 py-1.5 rounded-lg text-[12px] outline-none transition-colors duration-150"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: `1px solid ${tagDraftTooLong ? 'rgba(239, 68, 68, 0.45)' : 'rgba(148, 163, 184, 0.28)'}`,
                      }}
                      placeholder={`新增标签（最多 ${MAX_CUSTOM_TAG_COUNT} 个）`}
                      value={tagDraft}
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleAddCustomTag();
                        }
                      }}
                      disabled={savingTags}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleAddCustomTag()}
                      disabled={!canSubmitTagDraft || savingTags}
                    >
                      添加
                    </Button>
                  </div>
                  <div className="flex items-center justify-between min-h-[16px]">
                    <span
                      className="text-[10px]"
                      style={{ color: tagDraftTooLong ? 'rgba(239, 68, 68, 0.9)' : 'var(--text-muted)' }}
                    >
                      {tagDraftTooLong ? `超出 ${normalizedTagDraft.length - MAX_CUSTOM_TAG_LENGTH} 个字符` : '回车可快速添加'}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {normalizedTagDraft.length}/{MAX_CUSTOM_TAG_LENGTH}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {customTags.length === 0 ? (
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        暂无自定义标签
                      </span>
                    ) : (
                      customTags.map((tag, idx) => {
                        const isEditing = editingTagIdx === idx;
                        return (
                          <span
                            key={`custom-tag-${tag}-${idx}`}
                            className="group inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-colors duration-150"
                            style={{
                              background: isEditing ? 'rgba(59, 130, 246, 0.08)' : 'rgba(20, 184, 166, 0.09)',
                              color: isEditing ? 'rgba(59, 130, 246, 0.92)' : 'rgba(20, 184, 166, 0.9)',
                              border: `1px solid ${isEditing ? 'rgba(59, 130, 246, 0.25)' : 'rgba(20, 184, 166, 0.18)'}`,
                            }}
                          >
                            {isEditing ? (
                              <>
                                <input
                                  className="w-20 bg-transparent outline-none text-[11px]"
                                  value={editingTagDraft}
                                  onChange={(e) => setEditingTagDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      void handleConfirmEditCustomTag();
                                    }
                                    if (e.key === 'Escape') {
                                      setEditingTagIdx(null);
                                      setEditingTagDraft('');
                                    }
                                  }}
                                  autoFocus
                                />
                                <button
                                  className="inline-flex items-center justify-center w-4 h-4 rounded transition-colors duration-150 hover:bg-[rgba(59,130,246,0.12)]"
                                  onClick={() => void handleConfirmEditCustomTag()}
                                  title="确认修改"
                                  aria-label="确认修改标签"
                                >
                                  <Check size={9} />
                                </button>
                                <button
                                  className="inline-flex items-center justify-center w-4 h-4 rounded transition-colors duration-150 hover:bg-[rgba(148,163,184,0.14)]"
                                  onClick={() => {
                                    setEditingTagIdx(null);
                                    setEditingTagDraft('');
                                  }}
                                  title="取消"
                                  aria-label="取消修改标签"
                                >
                                  <X size={9} />
                                </button>
                              </>
                            ) : (
                              <>
                                <Tag size={9} />
                                {tag}
                                <button
                                  className="inline-flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150 hover:bg-[rgba(148,163,184,0.14)]"
                                  onClick={() => {
                                    setEditingTagIdx(idx);
                                    setEditingTagDraft(tag);
                                  }}
                                  title="修改"
                                  aria-label="修改标签"
                                >
                                  <Pencil size={9} />
                                </button>
                                <button
                                  className="inline-flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150 hover:bg-[rgba(239,68,68,0.12)]"
                                  onClick={() => void handleDeleteCustomTag(idx)}
                                  title="删除"
                                  aria-label="删除标签"
                                >
                                  <Trash2 size={9} />
                                </button>
                              </>
                            )}
                          </span>
                        );
                      })
                    )}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    自定义标签仅影响你的日常记录快捷标签，不会改变系统默认分类。
                  </div>
                </div>
              )}
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
                  className="w-16 h-16 rounded-2xl flex items-center justify-center"
                  style={{ background: 'rgba(59, 130, 246, 0.06)', border: '1px solid rgba(59, 130, 246, 0.1)' }}
                >
                  <Calendar size={28} style={{ color: 'rgba(59, 130, 246, 0.5)' }} />
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
                        setSelectedSystemTags([cat]);
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
            <GlassCard variant="subtle" className="p-4 flex flex-col gap-1">
              {/* ── 今日记录 (手动) ── */}
              {items.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-2 mb-2">
                    <div className="h-px flex-1" style={{ background: 'var(--border-primary)' }} />
                    <span className="text-[11px] font-medium px-2" style={{ color: 'var(--text-muted)' }}>
                      今日记录
                    </span>
                    <div className="h-px flex-1" style={{ background: 'var(--border-primary)' }} />
                  </div>
                  {items.map((item, idx) => {
                    const cfg = CATEGORY_CONFIG[item.category] || CATEGORY_CONFIG.other;
                    const isEditing = editingIdx === idx;

                    return (
                      <div key={idx} className="group flex items-start gap-3 py-2 px-3 rounded-xl transition-colors duration-150 hover:bg-[var(--bg-tertiary)]">
                        {/* Colored dot + timestamp */}
                        <div className="flex flex-col items-center gap-1 flex-shrink-0 mt-1 w-10">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ background: cfg.color }}
                          />
                          <span
                            className="text-[10px] font-mono leading-none"
                            style={{
                              color: item.createdAt ? 'var(--text-muted)' : 'transparent',
                              minHeight: 12,
                            }}
                          >
                            {item.createdAt ? formatTime(item.createdAt) : '--:--'}
                          </span>
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
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {systemCategoryKeys.map((key) => {
                                    const c = CATEGORY_CONFIG[key];
                                    const CIcon = c.icon;
                                    const isActive = editSystemTags.includes(key);
                                    return (
                                      <button
                                        key={`edit-system-${key}`}
                                        className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                        style={{
                                          background: isActive ? c.bg : 'transparent',
                                          color: isActive ? c.color : 'var(--text-muted)',
                                          border: `1px solid ${isActive ? c.color.replace('0.95', '0.3') : 'transparent'}`,
                                        }}
                                        onClick={() => handleEditSystemTagToggle(key)}
                                      >
                                        <CIcon size={10} className="inline mr-0.5" />
                                        {c.label}
                                      </button>
                                    );
                                  })}
                                  {customTags.map((tag) => {
                                    const isActive = editCustomTags.includes(tag);
                                    return (
                                      <button
                                        key={`edit-custom-${tag}`}
                                        className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                        style={{
                                          background: isActive ? 'rgba(20, 184, 166, 0.12)' : 'transparent',
                                          color: isActive ? 'rgba(20, 184, 166, 0.95)' : 'var(--text-muted)',
                                          border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.3)' : 'transparent'}`,
                                        }}
                                        onClick={() => handleEditCustomTagToggle(tag)}
                                      >
                                        <Tag size={8} className="inline mr-0.5" />
                                        {tag}
                                      </button>
                                    );
                                  })}
                                  {(() => {
                                    const key = DailyLogCategory.Other;
                                    const c = CATEGORY_CONFIG[key];
                                    const CIcon = c.icon;
                                    const isActive = editSystemTags.includes(key);
                                    return (
                                      <button
                                        key="edit-system-other"
                                        className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                        style={{
                                          background: isActive ? c.bg : 'transparent',
                                          color: isActive ? c.color : 'var(--text-muted)',
                                          border: `1px solid ${isActive ? c.color.replace('0.95', '0.3') : 'transparent'}`,
                                        }}
                                        onClick={() => handleEditSystemTagToggle(key)}
                                      >
                                        <CIcon size={10} className="inline mr-0.5" />
                                        {c.label}
                                      </button>
                                    );
                                  })()}
                                </div>
                                {hasEditTodoSelected && (
                                  <div className="flex items-center gap-1 ml-2">
                                    {todoPlanOptions.map((opt) => {
                                      const active = editTodoPlanTarget === opt.key;
                                      return (
                                        <button
                                          key={`edit-plan-${opt.key}`}
                                          type="button"
                                          className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                          style={{
                                            background: active ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
                                            color: active ? 'rgba(16, 185, 129, 0.95)' : 'var(--text-muted)',
                                            border: `1px solid ${active ? 'rgba(16, 185, 129, 0.3)' : 'transparent'}`,
                                          }}
                                          onClick={() => setEditTodoPlanTarget(opt.key)}
                                        >
                                          {opt.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
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
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                {item.tags && item.tags.length > 0 ? item.tags.map((tag, ti) => {
                                  const sysCfg = CATEGORY_CONFIG[tag];
                                  if (sysCfg) {
                                    const Icon = sysCfg.icon;
                                    return (
                                      <span
                                        key={ti}
                                        className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5"
                                        style={{ background: sysCfg.bg, color: sysCfg.color }}
                                      >
                                        <Icon size={8} /> {sysCfg.label}
                                      </span>
                                    );
                                  }
                                  return (
                                    <span
                                      key={ti}
                                      className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5"
                                      style={{ background: 'rgba(20, 184, 166, 0.1)', color: 'rgba(20, 184, 166, 0.85)' }}
                                    >
                                      <Tag size={8} /> {tag}
                                    </span>
                                  );
                                }) : (
                                  <span
                                    className="text-[10px] px-1.5 py-0.5 rounded"
                                    style={{ background: cfg.bg, color: cfg.color }}
                                  >
                                    {cfg.label}
                                  </span>
                                )}
                                {item.category === DailyLogCategory.Todo
                                  && item.planWeekYear != null
                                  && item.planWeekNumber != null && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded"
                                      style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'rgba(16, 185, 129, 0.9)' }}
                                    >
                                      计划周：{item.planWeekYear}-W{item.planWeekNumber}
                                    </span>
                                )}
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
                  <div className="flex items-center gap-2 px-2 mt-4 mb-2">
                    <div className="h-px flex-1" style={{ background: 'var(--border-primary)' }} />
                    <span className="text-[11px] font-medium px-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                      <GitCommit size={11} />
                      来自数据源
                      {commitsLoading && <span className="text-[10px]">加载中...</span>}
                    </span>
                    <div className="h-px flex-1" style={{ background: 'var(--border-primary)' }} />
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
              <div className="mt-3 px-1">
                <div
                  className="text-[11px] px-3 py-2 rounded-lg inline-flex items-center gap-1.5"
                  style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}
                >
                  <Sparkles size={11} style={{ color: 'rgba(168, 85, 247, 0.6)' }} />
                  这些记录会在生成周报时被 AI 自动汇总
                </div>
              </div>
            </GlassCard>
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
