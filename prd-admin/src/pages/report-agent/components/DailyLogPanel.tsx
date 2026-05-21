import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useState, useEffect, useCallback, useRef, useMemo, type ClipboardEvent } from 'react';
import {
  Send, Trash2, ChevronLeft, ChevronRight, Clock, Calendar,
  Pencil, Check, X, Flame, Code2, Users, MessageCircle, FileText, TestTube, MoreHorizontal,
  GitCommit, Sparkles, Plus, Tag,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDataTheme } from '../hooks/useDataTheme';
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
  uploadDailyLogImage,
} from '@/services';
import {
  DailyLogCategory,
} from '@/services/contracts/reportAgent';
import type { DailyLog, DailyLogItem, ReportCommit, PersonalSource } from '@/services/contracts/reportAgent';
import { compressImageToLimit, hasMarkdownImage, MAX_RICH_TEXT_IMAGE_BYTES } from '@/lib/imageCompress';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';
import { DailyLogPolishPopover } from './DailyLogPolishPopover';

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

type TodoPlanWeekKey = 'current' | 'next' | 'afterNext';

function getTodoPlanWeekOptions(baseDateStr: string): { key: TodoPlanWeekKey; label: string; weekYear: number; weekNumber: number }[] {
  const baseDate = parseDate(baseDateStr);
  const day = baseDate.getDay() || 7;
  const monday = new Date(baseDate);
  monday.setDate(baseDate.getDate() - day + 1);
  const nextWeekMonday = new Date(monday);
  nextWeekMonday.setDate(monday.getDate() + 7);
  const afterNextWeekMonday = new Date(monday);
  afterNextWeekMonday.setDate(monday.getDate() + 14);
  const currentInfo = getIsoWeekInfo(monday);
  const nextInfo = getIsoWeekInfo(nextWeekMonday);
  const afterNextInfo = getIsoWeekInfo(afterNextWeekMonday);
  return [
    { key: 'current', label: '本周', weekYear: currentInfo.weekYear, weekNumber: currentInfo.weekNumber },
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

// Category config with colors and icons (浅色 / 暗色 主题感知)
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

type TodoPlanTargetKey = TodoPlanWeekKey;

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
  completedAt?: string;
}

interface TagEntry {
  /** 系统 category key 或 自定义标签名称 */
  key: string;
  kind: 'system' | 'custom';
}

/**
 * 合并系统标签 + 自定义标签到一个有序列表。
 * - 如有用户偏好 tagOrder 则按其顺序，并把不在 tagOrder 中的标签按 系统默认序 + 自定义新增序 追加在尾部。
 * - 系统 / 自定义的区分仅看 key 是否落在 SYSTEM_TAG_ORDER 内。
 */
function buildOrderedTagEntries(tagOrder: string[], customTags: string[]): TagEntry[] {
  const customSet = new Set(customTags);
  const isSystem = (k: string) => (SYSTEM_TAG_ORDER as readonly string[]).includes(k);
  const isValid = (k: string) => isSystem(k) || customSet.has(k);

  const result: TagEntry[] = [];
  const seen = new Set<string>();
  for (const k of tagOrder) {
    if (!isValid(k) || seen.has(k)) continue;
    result.push({ key: k, kind: isSystem(k) ? 'system' : 'custom' });
    seen.add(k);
  }
  for (const k of SYSTEM_TAG_ORDER) {
    if (seen.has(k)) continue;
    result.push({ key: k, kind: 'system' });
    seen.add(k);
  }
  for (const k of customTags) {
    if (seen.has(k)) continue;
    result.push({ key: k, kind: 'custom' });
    seen.add(k);
  }
  return result;
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
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const CATEGORY_CONFIG = useMemo(() => buildCategoryConfig(isLight), [isLight]);
  const [selectedDate, setSelectedDate] = useState(formatDate(new Date()));
  const [items, setItems] = useState<LogItemInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [existingLog, setExistingLog] = useState<DailyLog | null>(null);
  const [weekLogs, setWeekLogs] = useState<DailyLog[]>([]);

  // Quick input state
  const [quickInput, setQuickInput] = useState('');
  // 默认空选，用户在「管理标签」勾选「默认」的标签会在 prefs 加载后注入
  const [selectedSystemTags, setSelectedSystemTags] = useState<string[]>([]);
  const [selectedCustomTags, setSelectedCustomTags] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [tagOrder, setTagOrder] = useState<string[]>([]);
  const [defaultTags, setDefaultTags] = useState<string[]>([]);
  const [tagPrefsLoaded, setTagPrefsLoaded] = useState(false);
  const [showTagManager, setShowTagManager] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [editingTagIdx, setEditingTagIdx] = useState<number | null>(null);
  const [editingTagDraft, setEditingTagDraft] = useState('');
  const [editingTagSource, setEditingTagSource] = useState<'manage' | 'quick' | 'editMode' | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [pastingTarget, setPastingTarget] = useState<'quick' | 'edit' | null>(null);
  const [polishTarget, setPolishTarget] = useState<{ scope: 'quick' | 'edit'; text: string } | null>(null);

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

  // Todo 计划面板：跨日聚合所有 Todo 条目，按周分组（本周/下周/下下周）
  const [todoSummaryLogs, setTodoSummaryLogs] = useState<DailyLog[]>([]);

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
          completedAt: i.completedAt,
        }))
      );
    } else {
      setExistingLog(null);
      setItems([]);
    }
    setLoaded(true);
  }, [selectedDate]);

  const saveCustomTags = useCallback(async (
    nextTags: string[],
    successMessage?: string,
    extra?: { tagOrder?: string[] | null; defaultTags?: string[] | null }
  ) => {
    setSavingTags(true);
    const res = await updateMyDailyLogTags({
      items: nextTags,
      tagOrder: extra?.tagOrder,
      defaultTags: extra?.defaultTags,
    });
    setSavingTags(false);
    if (res.success && res.data) {
      setCustomTags(res.data.items);
      setTagOrder(res.data.tagOrder ?? []);
      setDefaultTags(res.data.defaultTags ?? []);
      if (successMessage) toast.success(successMessage);
      return true;
    }
    toast.error(res.error?.message || '标签保存失败');
    return false;
  }, []);

  // Load personal data sources + tag preferences once
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
        setTagOrder(tagRes.data.tagOrder ?? []);
        setDefaultTags(tagRes.data.defaultTags ?? []);
      }
      setTagPrefsLoaded(true);
    })();
  }, []);

  // 用户偏好加载后注入默认勾选标签（仅在初始进入页面、未手动改过任何标签前一次性应用）
  const defaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (!tagPrefsLoaded || defaultsAppliedRef.current) return;
    if (defaultTags.length === 0) {
      defaultsAppliedRef.current = true;
      return;
    }
    const sysSet = new Set<string>(SYSTEM_TAG_ORDER as readonly string[]);
    const customSet = new Set(customTags);
    const sysDefaults: string[] = [];
    const customDefaults: string[] = [];
    for (const t of defaultTags) {
      if (sysSet.has(t)) sysDefaults.push(t);
      else if (customSet.has(t)) customDefaults.push(t);
    }
    // 系统 Todo 标签不能与其它系统标签共存（后端校验），如果默认里同时存在则丢弃 Todo
    if (sysDefaults.includes(DailyLogCategory.Todo) && sysDefaults.length > 1) {
      const idx = sysDefaults.indexOf(DailyLogCategory.Todo);
      sysDefaults.splice(idx, 1);
    }
    setSelectedSystemTags(sysDefaults);
    setSelectedCustomTags(customDefaults);
    defaultsAppliedRef.current = true;
  }, [tagPrefsLoaded, defaultTags, customTags]);

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

  // 加载所有 Todo 条目（用于右栏"待办计划"面板按周分组）
  const loadTodoSummary = useCallback(async () => {
    const res = await listDailyLogs({ categories: [DailyLogCategory.Todo], pageSize: 100 });
    if (res.success && res.data) {
      setTodoSummaryLogs(res.data.items);
    }
  }, []);

  useEffect(() => {
    void loadTodoSummary();
  }, [loadTodoSummary]);

  // ── Actions ──

  const resolveTodoPlanWeek = (targetKey: TodoPlanTargetKey) => (
    todoPlanOptions.find((opt) => opt.key === targetKey) ?? null
  );

  const buildSavePayload = (i: LogItemInput) => ({
    content: i.content.trim(),
    category: i.category,
    tags: i.tags && i.tags.length > 0 ? i.tags : undefined,
    durationMinutes: i.durationMinutes,
    planWeekYear: i.planWeekYear,
    planWeekNumber: i.planWeekNumber,
    createdAt: i.createdAt,
    completedAt: i.completedAt,
  });

  const doSave = async (newItems: LogItemInput[]) => {
    const validItems = newItems.filter((i) => i.content.trim());
    if (validItems.length === 0) return;
    setSaving(true);
    const res = await saveDailyLog({
      date: selectedDate,
      items: validItems.map(buildSavePayload),
    });
    setSaving(false);
    if (res.success) {
      toast.success('已保存');
      setExistingLog(res.data ?? null);
      void loadWeekLogs();
      void loadTodoSummary();
    } else {
      toast.error(res.error?.message || '保存失败');
    }
  };

  /**
   * 跨日保存：用于"本周待办"卡片直接操作其它日期的 todo（如标记完成、删除）。
   * 不动 selectedDate / items / existingLog。
   */
  const doSaveForDate = async (date: string, newItems: LogItemInput[]) => {
    const validItems = newItems.filter((i) => i.content.trim());
    setSaving(true);
    try {
      if (validItems.length === 0) {
        // 全删完则调 delete
        const delRes = await deleteDailyLog({ date });
        if (!delRes.success) {
          toast.error(delRes.error?.message || '删除失败');
          return false;
        }
      } else {
        const res = await saveDailyLog({
          date,
          items: validItems.map(buildSavePayload),
        });
        if (!res.success) {
          toast.error(res.error?.message || '保存失败');
          return false;
        }
      }
      // 如果改的就是当前选中日期，刷新主列表
      if (date === selectedDate) await loadLog();
      void loadWeekLogs();
      void loadTodoSummary();
      return true;
    } finally {
      setSaving(false);
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

  const handleQuickKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleQuickAdd();
    }
  };

  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, []);

  const handlePasteImage = useCallback(async (
    e: ClipboardEvent<HTMLTextAreaElement>,
    scope: 'quick' | 'edit',
    onUpdate: (next: string) => void,
  ) => {
    const imageItem = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;

    e.preventDefault();
    const textarea = e.currentTarget;
    setPastingTarget(scope);
    try {
      const { file: uploadFile, compressed } = await compressImageToLimit(file, MAX_RICH_TEXT_IMAGE_BYTES);
      const res = await uploadDailyLogImage({ file: uploadFile });
      if (!res.success || !res.data?.url) {
        toast.error(res.error?.message || '图片上传失败');
        return;
      }
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const current = textarea.value;
      const markdown = `\n![粘贴图片](${res.data.url})\n`;
      const next = `${current.slice(0, start)}${markdown}${current.slice(end)}`;
      onUpdate(next);
      const cursor = start + markdown.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
        autoResize(textarea);
      });
      toast.success(compressed ? '图片已压缩并插入' : '图片已插入');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '图片处理失败');
    } finally {
      setPastingTarget((prev) => (prev === scope ? null : prev));
    }
  }, [autoResize]);

  const handleSystemTagToggle = (tag: string) => {
    setSelectedSystemTags((prev) => {
      const isSelected = prev.includes(tag);
      let next: string[];
      if (isSelected) {
        next = prev.filter((x) => x !== tag);
      } else if (tag === DailyLogCategory.Todo) {
        next = [DailyLogCategory.Todo];
      } else {
        next = [...prev.filter((x) => x !== DailyLogCategory.Todo), tag];
      }
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
    setEditSystemTags((prev) => {
      const isSelected = prev.includes(tag);
      if (isSelected) {
        return prev.filter((x) => x !== tag);
      }
      if (tag === DailyLogCategory.Todo) {
        setEditTodoPlanTarget('next');
        return [DailyLogCategory.Todo];
      }
      return [...prev.filter((x) => x !== DailyLogCategory.Todo), tag];
    });
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
    const lower = removedTag.toLowerCase();
    const prevTags = customTags;
    const prevSelectedCustomTags = selectedCustomTags;
    const prevTagOrder = tagOrder;
    const prevDefaults = defaultTags;
    const updatedTags = customTags.filter((_, i) => i !== idx);
    const updatedOrder = tagOrder.filter((t) => t.toLowerCase() !== lower);
    const updatedDefaults = defaultTags.filter((t) => t.toLowerCase() !== lower);
    setCustomTags(updatedTags);
    setTagOrder(updatedOrder);
    setDefaultTags(updatedDefaults);
    setSelectedCustomTags((prev) => prev.filter((x) => x.toLowerCase() !== lower));
    if (editingTagIdx === idx) {
      handleCancelInlineEditTag();
    }

    const ok = await saveCustomTags(updatedTags, '标签已删除', { tagOrder: updatedOrder, defaultTags: updatedDefaults });
    if (!ok) {
      setCustomTags(prevTags);
      setTagOrder(prevTagOrder);
      setDefaultTags(prevDefaults);
      setSelectedCustomTags(prevSelectedCustomTags);
    }
  };

  /**
   * 统一持久化标签三件套（自定义列表 + 排序 + 默认勾选）。
   * 调用方传 partial，未传字段沿用当前 state。
   */
  const persistAllTagPrefs = useCallback(async (
    next: { customTags?: string[]; tagOrder?: string[]; defaultTags?: string[] },
    successMessage?: string
  ) => {
    const items = next.customTags ?? customTags;
    const order = next.tagOrder ?? tagOrder;
    const defaults = next.defaultTags ?? defaultTags;
    return await saveCustomTags(items, successMessage, { tagOrder: order, defaultTags: defaults });
  }, [customTags, tagOrder, defaultTags, saveCustomTags]);

  /**
   * 翻转某标签的"默认勾选"状态（key 可以是系统 key 或自定义标签名）。
   * 注意：系统 Todo 不能与其它系统默认共存，加 Todo 时清理其它系统默认；加其它系统默认时清掉 Todo。
   */
  const handleToggleDefaultTag = async (key: string) => {
    const hasIt = defaultTags.includes(key);
    let next: string[];
    if (hasIt) {
      next = defaultTags.filter((t) => t !== key);
    } else {
      next = [...defaultTags, key];
      const sysSet = new Set<string>(SYSTEM_TAG_ORDER as readonly string[]);
      if (key === DailyLogCategory.Todo) {
        // 加 Todo → 移除其它系统默认（自定义可共存）
        next = next.filter((t) => !sysSet.has(t) || t === DailyLogCategory.Todo);
      } else if (sysSet.has(key)) {
        // 加其它系统标签 → 移除 Todo
        next = next.filter((t) => t !== DailyLogCategory.Todo);
      }
    }
    setDefaultTags(next);
    await persistAllTagPrefs({ defaultTags: next });
  };

  /**
   * 把 fromKey 移动到 toKey 之前（拖拽排序）。
   * tagOrder 内不存在的合法 key 会先按当前 orderedTagEntries 顺序补齐再做位移。
   */
  const handleReorderTag = async (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    // 取当前完整顺序（含未在 tagOrder 中的标签，按 SYSTEM 默认 + custom 补齐）
    const fullOrder = orderedTagEntries.map((e) => e.key);
    const fromIdx = fullOrder.indexOf(fromKey);
    const toIdx = fullOrder.indexOf(toKey);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...fullOrder];
    next.splice(fromIdx, 1);
    const insertIdx = next.indexOf(toKey);
    next.splice(insertIdx, 0, fromKey);
    setTagOrder(next);
    await persistAllTagPrefs({ tagOrder: next });
  };

  const handleStartInlineEditTag = (idx: number, source: 'manage' | 'quick' | 'editMode') => {
    const target = customTags[idx];
    if (!target) return;
    setEditingTagIdx(idx);
    setEditingTagDraft(target);
    setEditingTagSource(source);
  };

  const handleCancelInlineEditTag = () => {
    setEditingTagIdx(null);
    setEditingTagDraft('');
    setEditingTagSource(null);
  };

  const handleConfirmEditCustomTag = async () => {
    if (editingTagIdx === null) return;
    const target = customTags[editingTagIdx];
    if (!target) {
      handleCancelInlineEditTag();
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

    const lower = target.toLowerCase();
    const prevTags = customTags;
    const prevSelectedCustomTags = selectedCustomTags;
    const prevTagOrder = tagOrder;
    const prevDefaults = defaultTags;
    const updatedTags = customTags.map((tag, idx) => (idx === editingTagIdx ? nextTag : tag));
    const updatedOrder = tagOrder.map((t) => (t.toLowerCase() === lower ? nextTag : t));
    const updatedDefaults = defaultTags.map((t) => (t.toLowerCase() === lower ? nextTag : t));
    setCustomTags(updatedTags);
    setTagOrder(updatedOrder);
    setDefaultTags(updatedDefaults);
    setSelectedCustomTags((prev) => prev.map((x) => (x.toLowerCase() === lower ? nextTag : x)));
    handleCancelInlineEditTag();

    const ok = await saveCustomTags(updatedTags, '标签已更新', { tagOrder: updatedOrder, defaultTags: updatedDefaults });
    if (!ok) {
      setCustomTags(prevTags);
      setTagOrder(prevTagOrder);
      setDefaultTags(prevDefaults);
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
          void loadTodoSummary();
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
      void loadTodoSummary();
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

  // 统一的标签呈现顺序（系统 + 自定义合并，按用户偏好 tagOrder 排序）
  const orderedTagEntries = useMemo(
    () => buildOrderedTagEntries(tagOrder, customTags),
    [tagOrder, customTags]
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

  // 待办计划面板：按本周/下周/下下周分组聚合所有「未完成」Todo（基于今天计算）
  const todoSummaryGroups = useMemo(() => {
    const todayStr = formatDate(new Date());
    const weekOptions = getTodoPlanWeekOptions(todayStr);
    const groups = weekOptions.map((opt) => ({
      key: opt.key,
      label: opt.label,
      weekYear: opt.weekYear,
      weekNumber: opt.weekNumber,
      items: [] as { content: string; date: string; createdAt?: string }[],
    }));
    for (const log of todoSummaryLogs) {
      for (const it of log.items) {
        if (it.category !== DailyLogCategory.Todo) continue;
        if (it.completedAt != null) continue; // 已完成不进入"待办"
        if (it.planWeekYear == null || it.planWeekNumber == null) continue;
        const group = groups.find(
          (g) => g.weekYear === it.planWeekYear && g.weekNumber === it.planWeekNumber
        );
        if (group) {
          group.items.push({ content: it.content, date: log.date, createdAt: it.createdAt });
        }
      }
    }
    for (const g of groups) {
      g.items.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : new Date(a.date).getTime();
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : new Date(b.date).getTime();
        return tb - ta;
      });
    }
    return groups;
  }, [todoSummaryLogs]);

  // 本周未完成待办（用于中央列表上方的「本周待办」置顶卡片）
  interface PendingTodo {
    logDate: string;        // 该 todo 所属的 daily log 日期（用于回写）
    itemIndex: number;      // 该 todo 在 log.items 中的下标
    content: string;
    createdAt?: string;
    planLabel: string;      // "本周" 等显示文本
  }
  const currentWeekPendingTodos = useMemo<PendingTodo[]>(() => {
    const todayStr = formatDate(new Date());
    const weekOptions = getTodoPlanWeekOptions(todayStr);
    const cur = weekOptions.find((o) => o.key === 'current');
    if (!cur) return [];
    const result: PendingTodo[] = [];
    for (const log of todoSummaryLogs) {
      log.items.forEach((it, idx) => {
        if (it.category !== DailyLogCategory.Todo) return;
        if (it.completedAt != null) return;
        if (it.planWeekYear !== cur.weekYear || it.planWeekNumber !== cur.weekNumber) return;
        result.push({
          logDate: log.date.substring(0, 10),
          itemIndex: idx,
          content: it.content,
          createdAt: it.createdAt,
          planLabel: '本周',
        });
      });
    }
    // 按创建时间倒序（新加的在前）
    result.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return result;
  }, [todoSummaryLogs]);

  /**
   * 标记某条本周待办完成：根据 logDate + itemIndex 找到原 log，把 completedAt 设为现在再回写。
   * 复用 doSaveForDate，因 todo 可能不在当前 selectedDate。
   */
  const handleCompletePendingTodo = async (todo: PendingTodo) => {
    const log = todoSummaryLogs.find((l) => l.date.substring(0, 10) === todo.logDate);
    if (!log) return;
    const nowIso = new Date().toISOString();
    const newItems: LogItemInput[] = log.items.map((it, idx) => ({
      content: it.content,
      category: it.category,
      tags: it.tags,
      durationMinutes: it.durationMinutes,
      planWeekYear: it.planWeekYear,
      planWeekNumber: it.planWeekNumber,
      createdAt: it.createdAt,
      completedAt: idx === todo.itemIndex ? nowIso : it.completedAt,
    }));
    await doSaveForDate(todo.logDate, newItems);
  };

  /**
   * 从本周待办里删除某条 todo：从原 log 移除该 item 再回写（若清空则 deleteDailyLog）。
   */
  const handleDeletePendingTodo = async (todo: PendingTodo) => {
    const log = todoSummaryLogs.find((l) => l.date.substring(0, 10) === todo.logDate);
    if (!log) return;
    const newItems: LogItemInput[] = log.items
      .filter((_, idx) => idx !== todo.itemIndex)
      .map((it) => ({
        content: it.content,
        category: it.category,
        tags: it.tags,
        durationMinutes: it.durationMinutes,
        planWeekYear: it.planWeekYear,
        planWeekNumber: it.planWeekNumber,
        createdAt: it.createdAt,
        completedAt: it.completedAt,
      }));
    await doSaveForDate(todo.logDate, newItems);
  };

  /** 当日列表里标记本日某条 todo 完成（直接走 doSave） */
  const handleCompleteCurrentDayTodo = async (idx: number) => {
    const target = items[idx];
    if (!target || target.category !== DailyLogCategory.Todo) return;
    const nowIso = new Date().toISOString();
    const newItems = items.map((it, i) => (i === idx ? { ...it, completedAt: nowIso } : it));
    setItems(newItems);
    await doSave(newItems);
  };

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
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                type="button"
                onClick={() => {
                  const el = dateInputRef.current;
                  if (!el) return;
                  // showPicker 是现代浏览器为程序化打开 date picker 提供的标准 API
                  // (Chrome 99+ / Edge 99+ / Firefox 101+ / Safari 16.4+)
                  if (typeof el.showPicker === 'function') {
                    try { el.showPicker(); return; } catch { /* fall through */ }
                  }
                  // 兜底: 老浏览器 focus + click
                  el.focus();
                  el.click();
                }}
                className="text-[14px] font-medium px-2 py-1 rounded transition-colors"
                style={{
                  color: 'var(--text-primary)',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(127,127,127,0.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                title="点击选择日期"
              >
                {getDateDisplayLabel(selectedDate)}
              </button>
              {/* 隐藏的日期输入控件 — 与按钮同区域，showPicker 会以此为锚点弹出系统原生日历 */}
              <input
                ref={dateInputRef}
                type="date"
                value={selectedDate}
                onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value); }}
                tabIndex={-1}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  pointerEvents: 'none',
                }}
              />
            </div>
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
              <div className="flex items-start gap-2">
                <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    className="w-full px-3 py-2 rounded-xl text-[13px] outline-none resize-none"
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-primary)',
                      minHeight: 38,
                      maxHeight: 320,
                      overflow: 'auto',
                    }}
                    placeholder={pastingTarget === 'quick' ? '图片上传中…' : `${quickInputPlaceholder}（支持粘贴图片 · Shift+回车换行）`}
                    value={quickInput}
                    onChange={(e) => { setQuickInput(e.target.value); autoResize(e.currentTarget); }}
                    onKeyDown={handleQuickKeyDown}
                    onPaste={(e) => { void handlePasteImage(e, 'quick', setQuickInput); }}
                    disabled={saving}
                  />
                  {hasMarkdownImage(quickInput) && (
                    <RichTextMarkdownContent
                      content={quickInput}
                      imageMaxHeight={140}
                      className="px-1"
                    />
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleQuickAdd}
                    disabled={!quickInput.trim() || saving || totalSelectedTagCount === 0}
                    style={{ borderRadius: 12 }}
                  >
                    <Send size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="AI 润色当前输入"
                    onClick={() => setPolishTarget({ scope: 'quick', text: quickInput.trim() })}
                    disabled={!quickInput.trim() || saving}
                    style={{ borderRadius: 12 }}
                  >
                    <Sparkles size={13} style={{ color: 'rgba(168, 85, 247, 0.9)' }} />
                  </Button>
                </div>
              </div>
              {/* Category quick-pick tags（系统 + 自定义统一按 tagOrder 顺序渲染） */}
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                {orderedTagEntries.map((entry) => {
                  if (entry.kind === 'system') {
                    const cfg = CATEGORY_CONFIG[entry.key];
                    if (!cfg) return null;
                    const isActive = selectedSystemTags.includes(entry.key);
                    const Icon = cfg.icon;
                    return (
                      <button
                        key={`sys-${entry.key}`}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                        style={{
                          background: isActive ? cfg.bg : 'transparent',
                          color: isActive ? cfg.color : 'var(--text-muted)',
                          border: `1px solid ${isActive ? cfg.color.replace('0.95', '0.3') : 'transparent'}`,
                        }}
                        onClick={() => handleSystemTagToggle(entry.key)}
                      >
                        <Icon size={11} />
                        {cfg.label}
                      </button>
                    );
                  }
                  // custom tag
                  const tag = entry.key;
                  const idx = customTags.indexOf(tag);
                  const isActive = selectedCustomTags.includes(tag);
                  const isEditing = editingTagIdx === idx && editingTagSource === 'quick';
                  if (isEditing) {
                    return (
                      <input
                        key={`tag-edit-${idx}`}
                        className="w-24 px-2 py-1 rounded-lg text-[11px] font-medium outline-none"
                        style={{
                          background: 'rgba(59, 130, 246, 0.08)',
                          color: 'rgba(59, 130, 246, 0.95)',
                          border: '1px solid rgba(59, 130, 246, 0.35)',
                        }}
                        value={editingTagDraft}
                        autoFocus
                        onChange={(e) => setEditingTagDraft(e.target.value)}
                        onBlur={handleCancelInlineEditTag}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void handleConfirmEditCustomTag();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            handleCancelInlineEditTag();
                          }
                        }}
                      />
                    );
                  }
                  return (
                    <button
                      key={`tag-${tag}`}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                      style={{
                        background: isActive ? 'rgba(20, 184, 166, 0.12)' : 'transparent',
                        color: isActive ? 'rgba(20, 184, 166, 0.95)' : 'var(--text-muted)',
                        border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.3)' : 'transparent'}`,
                      }}
                      title="双击重命名"
                      onClick={() => handleCustomTagToggle(tag)}
                      onDoubleClick={(e) => { e.preventDefault(); handleStartInlineEditTag(idx, 'quick'); }}
                    >
                      <Tag size={10} />
                      {tag}
                    </button>
                  );
                })}
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
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>管理标签</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      自定义 {customTags.length}/{MAX_CUSTOM_TAG_COUNT} · 默认 {defaultTags.length} 项
                    </span>
                  </div>
                  {/* 新增自定义标签 */}
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 px-3 py-1.5 rounded-lg text-[12px] outline-none transition-colors duration-150"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: `1px solid ${tagDraftTooLong ? 'rgba(239, 68, 68, 0.45)' : 'rgba(148, 163, 184, 0.28)'}`,
                      }}
                      placeholder={`新增自定义标签（最多 ${MAX_CUSTOM_TAG_COUNT} 个）`}
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
                      {tagDraftTooLong ? `超出 ${normalizedTagDraft.length - MAX_CUSTOM_TAG_LENGTH} 个字符` : '回车可快速添加；下方可拖动改变顺序、勾选默认'}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {normalizedTagDraft.length}/{MAX_CUSTOM_TAG_LENGTH}
                    </span>
                  </div>

                  {/* 排序 + 默认 + 删除 */}
                  <div className="flex flex-col gap-1">
                    {orderedTagEntries.map((entry) => {
                      const isSystem = entry.kind === 'system';
                      const sysCfg = isSystem ? CATEGORY_CONFIG[entry.key] : null;
                      const customIdx = isSystem ? -1 : customTags.indexOf(entry.key);
                      const isEditing = !isSystem && editingTagIdx === customIdx && editingTagSource === 'manage';
                      const isDefault = defaultTags.includes(entry.key);
                      const SysIcon = sysCfg?.icon;
                      return (
                        <div
                          key={`tag-row-${entry.kind}-${entry.key}`}
                          className="group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', entry.key);
                          }}
                          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const fromKey = e.dataTransfer.getData('text/plain');
                            if (fromKey && fromKey !== entry.key) void handleReorderTag(fromKey, entry.key);
                          }}
                          style={{
                            background: 'transparent',
                            cursor: 'default',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(148,163,184,0.06)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          {/* 拖动手柄 */}
                          <span
                            className="select-none text-[14px] leading-none"
                            style={{ color: 'var(--text-muted)', cursor: 'grab' }}
                            title="拖动调整顺序"
                          >
                            ⋮⋮
                          </span>
                          {/* 默认勾选 */}
                          <label
                            className="inline-flex items-center gap-1 text-[10px]"
                            style={{ color: isDefault ? 'rgba(16, 185, 129, 0.95)' : 'var(--text-muted)', cursor: 'pointer' }}
                            title="勾选则进入今日打点时自动选中此标签"
                          >
                            <input
                              type="checkbox"
                              checked={isDefault}
                              onChange={() => void handleToggleDefaultTag(entry.key)}
                              style={{ accentColor: 'rgba(16, 185, 129, 0.9)' }}
                            />
                            默认
                          </label>
                          {/* 标签 chip 或 重命名输入 */}
                          {isSystem ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-medium"
                              style={{
                                background: sysCfg!.bg,
                                color: sysCfg!.color,
                                border: `1px solid ${sysCfg!.color.replace('0.95', '0.3')}`,
                              }}
                            >
                              {SysIcon && <SysIcon size={11} />}
                              {sysCfg!.label}
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)', marginLeft: 4 }}>系统</span>
                            </span>
                          ) : isEditing ? (
                            <input
                              className="px-2 py-0.5 rounded-lg text-[11px] outline-none"
                              style={{
                                background: 'rgba(59, 130, 246, 0.08)',
                                color: 'rgba(59, 130, 246, 0.92)',
                                border: '1px solid rgba(59, 130, 246, 0.35)',
                                minWidth: 80,
                              }}
                              value={editingTagDraft}
                              autoFocus
                              onChange={(e) => setEditingTagDraft(e.target.value)}
                              onBlur={handleCancelInlineEditTag}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  void handleConfirmEditCustomTag();
                                } else if (e.key === 'Escape') {
                                  handleCancelInlineEditTag();
                                }
                              }}
                            />
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px]"
                              style={{
                                background: 'rgba(20, 184, 166, 0.09)',
                                color: 'rgba(20, 184, 166, 0.9)',
                                border: '1px solid rgba(20, 184, 166, 0.18)',
                              }}
                            >
                              <Tag size={9} />
                              {entry.key}
                            </span>
                          )}
                          {/* 操作按钮：仅自定义可重命名/删除 */}
                          {!isSystem && !isEditing && customIdx >= 0 && (
                            <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                className="inline-flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-[rgba(148,163,184,0.14)]"
                                onClick={() => handleStartInlineEditTag(customIdx, 'manage')}
                                title="重命名"
                                aria-label="重命名标签"
                              >
                                <Pencil size={10} style={{ color: 'var(--text-muted)' }} />
                              </button>
                              <button
                                className="inline-flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-[rgba(239,68,68,0.12)]"
                                onClick={() => void handleDeleteCustomTag(customIdx)}
                                title="删除"
                                aria-label="删除标签"
                              >
                                <Trash2 size={10} style={{ color: 'var(--text-muted)' }} />
                              </button>
                            </div>
                          )}
                          {isSystem && (
                            <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>不可删除</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    拖动 ⋮⋮ 调整顺序；勾选「默认」会在新建打点时自动选中此标签；系统标签不可删，自定义标签可重命名/删除。
                  </div>
                </div>
              )}
            </div>
          </GlassCard>

          {/* ── 本周待办（置顶，跨日聚合）── */}
          {currentWeekPendingTodos.length > 0 && (
            <GlassCard variant="subtle" className="p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Check size={14} style={{ color: 'rgba(16, 185, 129, 0.9)' }} />
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    本周待办
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'rgba(16, 185, 129, 0.9)' }}
                  >
                    {currentWeekPendingTodos.length} 项未完成
                  </span>
                </div>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  完成或删除前会一直流转到下一天
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {currentWeekPendingTodos.map((todo) => (
                  <div
                    key={`${todo.logDate}-${todo.itemIndex}`}
                    className="group flex items-start gap-3 py-2 px-3 rounded-xl transition-colors duration-150 hover:bg-[var(--bg-tertiary)]"
                  >
                    <div
                      className="w-5 h-5 mt-0.5 rounded flex items-center justify-center flex-shrink-0"
                      style={{
                        background: 'rgba(16, 185, 129, 0.12)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                      }}
                    >
                      <Check size={10} style={{ color: 'rgba(16, 185, 129, 0.9)' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                        {todo.content}
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        来自 {todo.logDate}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="p-1 rounded transition-colors"
                        title="标记完成"
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(16, 185, 129, 0.12)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => void handleCompletePendingTodo(todo)}
                        disabled={saving}
                      >
                        <Check size={12} style={{ color: 'rgba(16, 185, 129, 0.95)' }} />
                      </button>
                      <button
                        className="p-1 rounded transition-colors"
                        title="删除"
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => void handleDeletePendingTodo(todo)}
                        disabled={saving}
                      >
                        <Trash2 size={12} style={{ color: 'var(--text-muted)' }} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {/* Timeline / Items */}
          {!loaded ? (
            <MapSectionLoader />
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
                  💡 每日记录会在生成周报时被 AI 自动汇总归纳
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
                              <textarea
                                ref={editInputRef}
                                rows={1}
                                className="w-full px-3 py-1.5 rounded-lg text-[13px] outline-none resize-none"
                                style={{
                                  background: 'var(--bg-secondary)',
                                  color: 'var(--text-primary)',
                                  border: '1px solid var(--border-primary)',
                                  minHeight: 32,
                                  maxHeight: 320,
                                  overflow: 'auto',
                                }}
                                value={editContent}
                                onChange={(e) => { setEditContent(e.target.value); autoResize(e.currentTarget); }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                    e.preventDefault();
                                    void confirmEdit();
                                  } else if (e.key === 'Escape') {
                                    cancelEdit();
                                  }
                                }}
                                onPaste={(e) => { void handlePasteImage(e, 'edit', setEditContent); }}
                                placeholder={pastingTarget === 'edit' ? '图片上传中…' : '编辑内容（支持粘贴图片 · Enter 保存 · Shift+回车换行）'}
                                autoFocus
                              />
                              {hasMarkdownImage(editContent) && (
                                <RichTextMarkdownContent
                                  content={editContent}
                                  imageMaxHeight={140}
                                  className="px-1"
                                />
                              )}
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {orderedTagEntries.map((entry) => {
                                    if (entry.kind === 'system') {
                                      const c = CATEGORY_CONFIG[entry.key];
                                      if (!c) return null;
                                      const CIcon = c.icon;
                                      const isActive = editSystemTags.includes(entry.key);
                                      return (
                                        <button
                                          key={`edit-system-${entry.key}`}
                                          className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                          style={{
                                            background: isActive ? c.bg : 'transparent',
                                            color: isActive ? c.color : 'var(--text-muted)',
                                            border: `1px solid ${isActive ? c.color.replace('0.95', '0.3') : 'transparent'}`,
                                          }}
                                          onClick={() => handleEditSystemTagToggle(entry.key)}
                                        >
                                          <CIcon size={10} className="inline mr-0.5" />
                                          {c.label}
                                        </button>
                                      );
                                    }
                                    const tag = entry.key;
                                    const tIdx = customTags.indexOf(tag);
                                    const isActive = editCustomTags.includes(tag);
                                    const isEditing = editingTagIdx === tIdx && editingTagSource === 'editMode';
                                    if (isEditing) {
                                      return (
                                        <input
                                          key={`edit-custom-edit-${tIdx}`}
                                          className="w-20 px-1.5 py-0.5 rounded text-[10px] outline-none"
                                          style={{
                                            background: 'rgba(59, 130, 246, 0.08)',
                                            color: 'rgba(59, 130, 246, 0.95)',
                                            border: '1px solid rgba(59, 130, 246, 0.35)',
                                          }}
                                          value={editingTagDraft}
                                          autoFocus
                                          onChange={(e) => setEditingTagDraft(e.target.value)}
                                          onBlur={handleCancelInlineEditTag}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                              e.preventDefault();
                                              void handleConfirmEditCustomTag();
                                            } else if (e.key === 'Escape') {
                                              e.preventDefault();
                                              handleCancelInlineEditTag();
                                            }
                                          }}
                                        />
                                      );
                                    }
                                    return (
                                      <button
                                        key={`edit-custom-${tag}`}
                                        className="px-2 py-0.5 rounded text-[10px] transition-colors"
                                        style={{
                                          background: isActive ? 'rgba(20, 184, 166, 0.12)' : 'transparent',
                                          color: isActive ? 'rgba(20, 184, 166, 0.95)' : 'var(--text-muted)',
                                          border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.3)' : 'transparent'}`,
                                        }}
                                        title="双击重命名"
                                        onClick={() => handleEditCustomTagToggle(tag)}
                                        onDoubleClick={(e) => { e.preventDefault(); handleStartInlineEditTag(tIdx, 'editMode'); }}
                                      >
                                        <Tag size={8} className="inline mr-0.5" />
                                        {tag}
                                      </button>
                                    );
                                  })}
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
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  title="AI 润色"
                                  onClick={() => setPolishTarget({ scope: 'edit', text: editContent.trim() })}
                                  disabled={!editContent.trim()}
                                >
                                  <Sparkles size={12} style={{ color: 'rgba(168, 85, 247, 0.9)' }} />
                                </Button>
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
                              {hasMarkdownImage(item.content) ? (
                                <RichTextMarkdownContent
                                  content={item.content}
                                  imageMaxHeight={140}
                                  className="text-[13px] leading-relaxed"
                                />
                              ) : (
                                <div className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                                  {item.content}
                                </div>
                              )}
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
                                {item.category === DailyLogCategory.Todo && item.completedAt && (
                                  <span
                                    className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5"
                                    style={{ background: 'rgba(16, 185, 129, 0.16)', color: 'rgba(16, 185, 129, 0.95)' }}
                                  >
                                    <Check size={9} /> 已完成
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
                            {/* Todo 未完成：显示「标记完成」；已完成：不显示完成按钮；非 todo：显示「编辑」 */}
                            {item.category === DailyLogCategory.Todo ? (
                              !item.completedAt && (
                                <button
                                  className="p-1 rounded transition-colors"
                                  style={{ background: 'transparent' }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(16, 185, 129, 0.12)'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                  onClick={() => void handleCompleteCurrentDayTodo(idx)}
                                  title="标记完成"
                                  disabled={saving}
                                >
                                  <Check size={12} style={{ color: 'rgba(16, 185, 129, 0.95)' }} />
                                </button>
                              )
                            ) : (
                              <button
                                className="p-1 rounded transition-colors"
                                style={{ background: 'transparent' }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                onClick={() => startEdit(idx)}
                                title="编辑"
                              >
                                <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
                              </button>
                            )}
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

          {/* 待办计划：按本周/下周/下下周分组 */}
          <GlassCard variant="subtle" className="px-3 py-3">
            <div className="text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              待办计划
            </div>
            <div className="flex flex-col gap-3">
              {todoSummaryGroups.map((group) => (
                <div key={group.key} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{group.label}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{group.items.length} 项</span>
                  </div>
                  {group.items.length === 0 ? (
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>暂无</div>
                  ) : (
                    <>
                      {group.items.slice(0, 5).map((todo, ti) => (
                        <div
                          key={`${group.key}-${ti}`}
                          className="text-[11px] truncate leading-snug"
                          style={{ color: 'var(--text-primary)' }}
                          title={todo.content}
                        >
                          · {todo.content}
                        </div>
                      ))}
                      {group.items.length > 5 && (
                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          还有 {group.items.length - 5} 项
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </GlassCard>

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
      <DailyLogPolishPopover
        open={polishTarget !== null}
        text={polishTarget?.text ?? ''}
        onClose={() => setPolishTarget(null)}
        onApply={(polished) => {
          if (polishTarget?.scope === 'quick') {
            setQuickInput(polished);
            requestAnimationFrame(() => autoResize(inputRef.current));
          } else if (polishTarget?.scope === 'edit') {
            setEditContent(polished);
            requestAnimationFrame(() => autoResize(editInputRef.current));
          }
          setPolishTarget(null);
        }}
      />
    </div>
  );
}
