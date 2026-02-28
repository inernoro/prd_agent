import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/design/Button';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { readSseStream } from '@/lib/sse';
import { getAvatarUrlByModelName, getAvatarUrlByPlatformType } from '@/assets/model-avatars';
import {
  getArenaLineup,
  revealArenaSlots,
  listArenaBattles,
  getArenaBattle,
  listArenaGroups,
  createArenaGroup,
  updateArenaGroup,
  deleteArenaGroup,
  createArenaSlot,
  deleteArenaSlot,
  toggleArenaSlot,
  createArenaRun,
  getArenaRun,
  getPlatforms,
} from '@/services';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { ModelPoolPickerDialog, type SelectedModelItem } from '@/components/model/ModelPoolPickerDialog';
import type { Platform } from '@/types/admin';
import {
  Eye, Send, Plus, Search, MessageSquare, Clock, Loader2, Swords, ChevronDown,
  Edit3, Trash2, Settings, Power,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArenaSlot {
  id: string;
  platformId: string;
  modelId: string;
  displayName?: string;
  enabled?: boolean;
}

interface ArenaGroup {
  id?: string;
  key: string;
  name: string;
  description?: string;
  sortOrder?: number;
  slots: ArenaSlot[];
}

interface GroupForm {
  key: string;
  name: string;
  description: string;
  sortOrder: number;
}

const EMPTY_GROUP_FORM: GroupForm = { key: '', name: '', description: '', sortOrder: 0 };

interface ArenaPanel {
  slotId: string;
  label: string;
  labelIndex: number;
  status: 'waiting' | 'streaming' | 'done' | 'error';
  text: string;
  ttftMs: number | null;
  totalMs: number | null;
  errorMessage: string | null;
  /** Timestamp when this panel started receiving data (for completion-order sorting) */
  startedAt: number | null;
}

interface RevealedInfo {
  id: string;
  displayName: string;
  platformName: string;
  avatarColor: string;
  description?: string;
}

interface BattleHistoryItem {
  id: string;
  prompt: string;
  groupKey: string;
  revealed: boolean;
  createdAt: string;
  responseCount: number;
}

interface BattleDetail {
  id: string;
  prompt: string;
  groupKey: string;
  responses: Array<{
    slotId: string;
    label: string;
    content: string;
    ttftMs: number | null;
    totalMs: number | null;
    status: string;
    errorMessage: string | null;
  }>;
  revealed: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// URL helpers (match the pattern used by the working modelLab service)
// ---------------------------------------------------------------------------

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

// ---------------------------------------------------------------------------
// Run/Worker session persistence key
// ---------------------------------------------------------------------------

const ARENA_RUN_STORAGE_KEY = 'arena_active_run';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate letter label: 0→A, 25→Z, 26→AA, 27→AB... */
function getLabel(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  return String.fromCharCode(65 + Math.floor(idx / 26) - 1) + String.fromCharCode(65 + (idx % 26));
}

const PALETTE = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#a855f7', '#e11d48',
  '#3b82f6', '#d946ef', '#0ea5e9', '#65a30d', '#7c3aed', '#db2777',
  '#0d9488', '#ea580c', '#0891b2', '#ca8a04', '#9333ea', '#be123c',
  '#2563eb', '#c026d3',
];

function getLabelColor(idx: number): string {
  return PALETTE[idx % PALETTE.length];
}

function assignLabels(slots: ArenaSlot[]): Map<string, { label: string; index: number }> {
  const shuffled = [...slots];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const map = new Map<string, { label: string; index: number }>();
  shuffled.forEach((slot, idx) => {
    map.set(slot.id, { label: `助手 ${getLabel(idx)}`, index: idx });
  });
  return map;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return '今天';
  if (target.getTime() === yesterday.getTime()) return '昨天';
  return '更早';
}

function groupByDate(items: BattleHistoryItem[]): Map<string, BattleHistoryItem[]> {
  const groups = new Map<string, BattleHistoryItem[]>();
  const order = ['今天', '昨天', '更早'];
  for (const o of order) groups.set(o, []);
  for (const item of items) {
    const key = formatDate(item.createdAt);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  for (const o of order) {
    if (groups.get(o)?.length === 0) groups.delete(o);
  }
  return groups;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ArenaPage() {
  // --- Lineup state ---
  const [groups, setGroups] = useState<ArenaGroup[]>([]);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string>('');
  const [lineupLoading, setLineupLoading] = useState(true);
  const [lineupError, setLineupError] = useState<string | null>(null);
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);

  // --- Battle state ---
  const [prompt, setPrompt] = useState('');
  const [panels, setPanels] = useState<ArenaPanel[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [revealedInfos, setRevealedInfos] = useState<Map<string, RevealedInfo>>(new Map());
  const [revealLoading, setRevealLoading] = useState(false);
  const [currentPrompt, setCurrentPrompt] = useState('');
  const [revealAnimating, setRevealAnimating] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  void activeRunId; // used via setActiveRunId for run lifecycle tracking

  // --- History state ---
  const [history, setHistory] = useState<BattleHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [activeBattleId, setActiveBattleId] = useState<string | null>(null);

  // --- Sidebar ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // --- Group management state ---
  const [manageMode, setManageMode] = useState(false);
  const [adminGroups, setAdminGroups] = useState<ArenaGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [groupSaving, setGroupSaving] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerTargetGroup, setModelPickerTargetGroup] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);

  const platformMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of platforms) map.set(p.id, p.name);
    return map;
  }, [platforms]);

  const existingModelsForPicker = useMemo<SelectedModelItem[]>(() => {
    const group = adminGroups.find((g) => g.key === modelPickerTargetGroup);
    if (!group) return [];
    return group.slots.map((s) => ({
      platformId: s.platformId,
      modelId: s.modelId,
      name: s.displayName || s.modelId,
    }));
  }, [adminGroups, modelPickerTargetGroup]);

  // --- Refs ---
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelsRef = useRef<ArenaPanel[]>([]);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  const manageModeRef = useRef(false);
  const afterSeqRef = useRef<number>(0);

  // Keep panelsRef in sync
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  // Auto-scroll each panel body to bottom during streaming
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('[data-panel-body]').forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, [panels]);

  // Keep manageModeRef in sync
  useEffect(() => {
    manageModeRef.current = manageMode;
  }, [manageMode]);

  // Close dropdown when clicking outside (but not during manage mode — ConfirmTip uses portals)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (manageModeRef.current) return;
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node)) {
        setGroupDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // --- Load lineup on mount ---
  useEffect(() => {
    loadLineup();
    loadHistory();
  }, []);

  // --- Page refresh recovery: check for active run and reconnect ---
  useEffect(() => {
    const raw = sessionStorage.getItem(ARENA_RUN_STORAGE_KEY);
    if (!raw) return;

    let session: { runId: string; prompt: string; groupKey: string; slots: Array<{ slotId: string; label: string; labelIndex: number }> };
    try {
      session = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
      return;
    }

    // Check if run is still active
    (async () => {
      try {
        const res = await getArenaRun(session.runId);
        if (!res.success || !res.data) {
          sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
          return;
        }
        const status = res.data.status as string;
        if (status === 'Done' || status === 'Error' || status === 'Cancelled') {
          sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
          return;
        }

        // Run is still active — restore panels and reconnect
        const initialPanels: ArenaPanel[] = session.slots.map((s) => ({
          slotId: s.slotId,
          label: s.label,
          labelIndex: s.labelIndex,
          status: 'waiting' as const,
          text: '',
          ttftMs: null,
          totalMs: null,
          errorMessage: null,
          startedAt: null,
        }));
        setPanels(initialPanels);
        panelsRef.current = initialPanels;
        setCurrentPrompt(session.prompt);
        setSelectedGroupKey(session.groupKey);
        setIsStreaming(true);
        setAllDone(false);
        setRevealed(false);
        setRevealedInfos(new Map());
        setActiveRunId(session.runId);

        // Reconnect from seq 0 (snapshot will fast-forward)
        subscribeToRunStream(session.runId, 0);
      } catch {
        sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLineup() {
    setLineupLoading(true);
    setLineupError(null);
    try {
      const res = await getArenaLineup();
      if (res.success) {
        const items = (res.data?.items ?? []) as ArenaGroup[];
        setGroups(items);
        if (items.length > 0 && !selectedGroupKey) {
          setSelectedGroupKey(items[0].key);
        }
      } else {
        const msg = res.error?.message ?? '请求失败';
        setLineupError(msg);
        toast.error('加载阵容失败', msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '网络错误';
      setLineupError(msg);
      toast.error('加载阵容失败', msg);
    } finally {
      setLineupLoading(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const res = await listArenaBattles(1, 50);
      if (res.success && res.data?.items) {
        setHistory(res.data.items as BattleHistoryItem[]);
      }
    } catch {
      // silent
    } finally {
      setHistoryLoading(false);
    }
  }

  // --- Group management functions ---
  async function loadAdminGroups() {
    setAdminLoading(true);
    try {
      const [groupsRes, platformsRes] = await Promise.all([
        listArenaGroups(),
        getPlatforms(),
      ]);
      if (groupsRes.success && groupsRes.data?.items) {
        setAdminGroups(groupsRes.data.items as ArenaGroup[]);
      }
      if (platformsRes.success) {
        setPlatforms((platformsRes.data as Platform[]) ?? []);
      }
    } catch {
      toast.error('加载阵容配置失败');
    } finally {
      setAdminLoading(false);
    }
  }

  function enterManageMode() {
    setManageMode(true);
    loadAdminGroups();
  }

  function exitManageMode() {
    setManageMode(false);
    setGroupDropdownOpen(false);
    // Reload lineup to pick up changes
    loadLineup();
  }

  function openCreateGroup() {
    setEditingGroupId(null);
    setGroupForm(EMPTY_GROUP_FORM);
    setGroupDialogOpen(true);
  }

  function openEditGroup(group: ArenaGroup) {
    setEditingGroupId(group.id ?? null);
    setGroupForm({
      key: group.key,
      name: group.name,
      description: group.description ?? '',
      sortOrder: group.sortOrder ?? 0,
    });
    setGroupDialogOpen(true);
  }

  async function handleSaveGroup() {
    if (!groupForm.name.trim()) {
      toast.warning('请填写分组名称');
      return;
    }
    if (!editingGroupId && !groupForm.key.trim()) {
      toast.warning('请填写分组 Key');
      return;
    }
    setGroupSaving(true);
    try {
      if (editingGroupId) {
        const res = await updateArenaGroup(editingGroupId, {
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.message || '更新失败');
        toast.success('分组已更新');
      } else {
        const res = await createArenaGroup({
          key: groupForm.key.trim(),
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.message || '创建失败');
        toast.success('分组已创建');
      }
      setGroupDialogOpen(false);
      await loadAdminGroups();
    } catch (err: any) {
      toast.error(editingGroupId ? '更新分组失败' : '创建分组失败', err?.message);
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleDeleteGroup(groupId: string) {
    try {
      const res = await deleteArenaGroup(groupId);
      if (!res.success) throw new Error(res.message || '删除失败');
      toast.success('分组已删除');
      await loadAdminGroups();
    } catch (err: any) {
      toast.error('删除分组失败', err?.message);
    }
  }

  function openAddSlots(groupKey: string) {
    setModelPickerTargetGroup(groupKey);
    setModelPickerOpen(true);
  }

  async function handleModelPickerConfirm(models: SelectedModelItem[]) {
    const group = adminGroups.find((g) => g.key === modelPickerTargetGroup);
    const existingKeys = new Set(
      (group?.slots ?? []).map((s) => `${s.platformId}:${s.modelId}`.toLowerCase()),
    );
    const newModels = models.filter(
      (m) => !existingKeys.has(`${m.platformId}:${m.modelId}`.toLowerCase()),
    );
    if (newModels.length === 0) {
      toast.info('没有新模型需要添加');
      return;
    }
    let successCount = 0;
    for (const m of newModels) {
      try {
        const res = await createArenaSlot({
          displayName: m.name || m.modelName || m.modelId,
          platformId: m.platformId,
          modelId: m.modelId,
          group: modelPickerTargetGroup,
          enabled: true,
        });
        if (res.success) successCount++;
      } catch {
        // continue
      }
    }
    if (successCount > 0) {
      toast.success(`已添加 ${successCount} 个模型`);
      await loadAdminGroups();
    } else {
      toast.error('添加模型失败');
    }
  }

  async function handleDeleteSlot(slotId: string) {
    try {
      const res = await deleteArenaSlot(slotId);
      if (!res.success) throw new Error(res.message || '删除失败');
      toast.success('模型已删除');
      await loadAdminGroups();
    } catch (err: any) {
      toast.error('删除模型失败', err?.message);
    }
  }

  async function handleToggleSlot(slotId: string) {
    try {
      const res = await toggleArenaSlot(slotId);
      if (!res.success) throw new Error(res.message || '切换失败');
      await loadAdminGroups();
    } catch (err: any) {
      toast.error('切换状态失败', err?.message);
    }
  }

  // --- Get selected group's slots ---
  const selectedGroup = groups.find((g) => g.key === selectedGroupKey);
  const slots = selectedGroup?.slots ?? [];

  // --- Start a new battle ---
  function handleNewBattle() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPanels([]);
    setIsStreaming(false);
    setAllDone(false);
    setRevealed(false);
    setRevealedInfos(new Map());
    setCurrentPrompt('');
    setActiveBattleId(null);
    setActiveRunId(null);
    setPrompt('');
    afterSeqRef.current = 0;
    sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
    textareaRef.current?.focus();
  }

  // --- SSE event handler (Run/Worker mode: events come as RunEventRecord with payloadJson) ---
  function handleRunEvent(payloadJson: string) {
    let data: any;
    try {
      // payloadJson is the RunEventRecord.payloadJson — parse the actual event object
      data = JSON.parse(payloadJson);
    } catch {
      return;
    }

    const type = data?.type as string;
    if (!type) return;

    // Run-level events
    if (type === 'runStart') return; // nothing to do
    if (type === 'runDone') {
      const final = panelsRef.current;
      const done = final.length > 0 && final.every((p) => p.status === 'done' || p.status === 'error');
      setAllDone(done);
      setIsStreaming(false);
      // Clear persisted run
      sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
      setActiveRunId(null);
      loadHistory();
      return;
    }
    if (type === 'error') {
      toast.error('运行失败', data.errorMessage ?? '');
      setIsStreaming(false);
      sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
      setActiveRunId(null);
      return;
    }

    // Snapshot event (for reconnection recovery)
    if (type === 'arenaSnapshot') {
      const snapshotSlots = data.slots as Array<{ slotId: string; label: string; labelIndex: number; content: string }>;
      if (snapshotSlots) {
        setPanels((prev) => {
          const next = prev.map((p) => {
            const snap = snapshotSlots.find((s) => s.slotId === p.slotId);
            if (snap && snap.content.length > p.text.length) {
              return { ...p, text: snap.content, status: p.status === 'waiting' ? 'streaming' : p.status };
            }
            return p;
          });
          panelsRef.current = next;
          return next;
        });
        if (data.prompt) setCurrentPrompt(data.prompt);
      }
      return;
    }

    // Model-level events — use slotId directly from ArenaRunWorker
    const slotId = data.slotId as string | undefined;
    if (!slotId) return;

    const updatePanel = (updater: (p: ArenaPanel) => ArenaPanel) => {
      setPanels((prev) => {
        const next = prev.map((p) => (p.slotId === slotId ? updater(p) : p));
        panelsRef.current = next;
        return next;
      });
    };

    switch (type) {
      case 'modelStart':
        updatePanel((p) => ({ ...p, status: 'streaming', startedAt: p.startedAt ?? Date.now() }));
        break;

      case 'delta':
        updatePanel((p) => ({
          ...p,
          status: 'streaming',
          text: p.text + (data.content ?? ''),
        }));
        break;

      case 'firstToken':
        updatePanel((p) => ({
          ...p,
          ttftMs: typeof data.ttftMs === 'number' ? data.ttftMs : p.ttftMs,
        }));
        break;

      case 'modelDone':
        updatePanel((p) => ({
          ...p,
          status: 'done',
          ttftMs: data.ttftMs ?? p.ttftMs,
          totalMs: data.totalMs ?? p.totalMs,
        }));
        break;

      case 'modelError': {
        const code = String(data.errorCode ?? '').trim();
        const msg = String(data.errorMessage ?? '').trim() || '模型响应异常';
        const em = code ? `[${code}] ${msg}` : msg;
        updatePanel((p) => ({
          ...p,
          status: 'error',
          errorMessage: em,
        }));
        break;
      }
    }
  }

  // --- Subscribe to arena run SSE stream (supports afterSeq reconnection) ---
  async function subscribeToRunStream(runId: string, afterSeq: number = 0) {
    const abortController = new AbortController();
    abortRef.current = abortController;
    afterSeqRef.current = afterSeq;

    try {
      const token = useAuthStore.getState().token;
      const streamPath = api.arena.runs.stream(runId);
      const fullUrl = joinUrl(getApiBaseUrl(), `${streamPath}?afterSeq=${afterSeq}`);

      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `HTTP ${response.status} ${response.statusText}`);
      }

      await readSseStream(
        response,
        (evt) => {
          if (!evt.data) return;
          // Track sequence for reconnection
          if (evt.id) {
            const seq = parseInt(evt.id, 10);
            if (!isNaN(seq)) afterSeqRef.current = seq;
          }
          // The SSE stream wraps events as RunEventRecord — data contains the full record JSON
          try {
            const record = JSON.parse(evt.data);
            // record is { runId, seq, eventName, payloadJson, createdAt }
            const payloadJson = record.payloadJson ?? evt.data;
            handleRunEvent(payloadJson);
          } catch {
            // Fallback: try treating data as direct payload
            handleRunEvent(evt.data);
          }
        },
        abortController.signal
      );
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      // Connection lost — check if run is still active and auto-reconnect
      try {
        const runRes = await getArenaRun(runId);
        if (runRes.success && runRes.data) {
          const status = runRes.data.status as string;
          if (status === 'Running' || status === 'Queued') {
            // Run still active — reconnect after a short delay
            setTimeout(() => {
              if (!abortRef.current?.signal.aborted) {
                subscribeToRunStream(runId, afterSeqRef.current);
              }
            }, 1000);
            return;
          }
          // Run completed while we were disconnected
          if (status === 'Done') {
            setAllDone(true);
            setIsStreaming(false);
            sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
            setActiveRunId(null);
            loadHistory();
            return;
          }
        }
      } catch {
        // ignore
      }
      toast.error('流式连接中断', e?.message ?? '网络错误');
    } finally {
      abortRef.current = null;
    }
  }

  // --- Send question (Run/Worker mode) ---
  const handleSend = useCallback(async () => {
    const question = prompt.trim();
    if (!question || isStreaming) return;
    if (slots.length === 0) {
      toast.warning('暂无可用模型', '请先在管理页配置竞技场阵容');
      return;
    }

    // Assign random labels
    const newLabelMap = assignLabels(slots);

    // Build slot data for the run
    const runSlots = slots.map((slot) => {
      const info = newLabelMap.get(slot.id) ?? { label: '助手 ?', index: 0 };
      return {
        slotId: slot.id,
        platformId: slot.platformId,
        modelId: slot.modelId,
        label: info.label,
        labelIndex: info.index,
      };
    });

    // Initialize panels
    const initialPanels: ArenaPanel[] = runSlots.map((s) => ({
      slotId: s.slotId,
      label: s.label,
      labelIndex: s.labelIndex,
      status: 'waiting' as const,
      text: '',
      ttftMs: null,
      totalMs: null,
      errorMessage: null,
      startedAt: null,
    }));
    setPanels(initialPanels);
    panelsRef.current = initialPanels;
    setCurrentPrompt(question);
    setIsStreaming(true);
    setAllDone(false);
    setRevealed(false);
    setRevealedInfos(new Map());
    setActiveBattleId(null);
    setPrompt('');
    afterSeqRef.current = 0;

    try {
      // 1) Create Run (server-side) — returns immediately with runId
      const res = await createArenaRun({
        prompt: question,
        groupKey: selectedGroupKey,
        slots: runSlots,
      });

      if (!res.success || !res.data?.runId) {
        throw new Error(res.error?.message || '创建 Run 失败');
      }

      const runId = res.data.runId as string;
      setActiveRunId(runId);

      // Persist run session for page refresh recovery
      sessionStorage.setItem(ARENA_RUN_STORAGE_KEY, JSON.stringify({
        runId,
        prompt: question,
        groupKey: selectedGroupKey,
        slots: runSlots,
      }));

      // 2) Subscribe to SSE stream (afterSeq=0 for fresh start)
      await subscribeToRunStream(runId, 0);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      toast.error('竞技场请求失败', e?.message ?? '网络错误');
      setPanels((prev) =>
        prev.map((p) =>
          p.status === 'waiting' || p.status === 'streaming'
            ? { ...p, status: 'error', errorMessage: e?.message ?? '连接中断' }
            : p
        )
      );
      setIsStreaming(false);
      sessionStorage.removeItem(ARENA_RUN_STORAGE_KEY);
      setActiveRunId(null);
    }
  }, [prompt, isStreaming, slots, selectedGroupKey]);

  // --- Reveal models ---
  async function handleReveal() {
    if (revealLoading || revealed) return;
    const slotIds = panels.map((p) => p.slotId);
    if (slotIds.length === 0) return;

    setRevealLoading(true);
    try {
      const res = await revealArenaSlots(slotIds);
      if (res.success && res.data?.items) {
        const infos = res.data.items as RevealedInfo[];
        const infoMap = new Map<string, RevealedInfo>();
        for (const info of infos) {
          infoMap.set(info.id, info);
        }
        setRevealedInfos(infoMap);
        setRevealAnimating(true);
        setTimeout(() => {
          setRevealed(true);
          setRevealAnimating(false);
        }, 600);
      } else {
        toast.error('揭晓失败', res.error?.message);
      }
    } catch (e) {
      toast.error('揭晓失败', e instanceof Error ? e.message : '网络错误');
    } finally {
      setRevealLoading(false);
    }
  }

  // --- Load a historical battle ---
  async function handleLoadBattle(battleId: string) {
    if (isStreaming) return;
    try {
      const res = await getArenaBattle(battleId);
      if (res.success && res.data) {
        const battle = res.data as BattleDetail;
        setCurrentPrompt(battle.prompt);
        setActiveBattleId(battle.id);
        setRevealed(battle.revealed);
        setAllDone(true);
        setIsStreaming(false);
        setRevealedInfos(new Map());

        const loadedPanels: ArenaPanel[] = (battle.responses || []).map((r, idx) => ({
          slotId: r.slotId,
          label: r.label,
          labelIndex: idx,
          status: r.status === 'error' ? 'error' : 'done',
          text: r.content || '',
          ttftMs: r.ttftMs,
          totalMs: r.totalMs,
          errorMessage: r.errorMessage,
          startedAt: idx,
        }));
        setPanels(loadedPanels);
        panelsRef.current = loadedPanels;
      } else {
        toast.error('加载对战记录失败', res.error?.message);
      }
    } catch (e) {
      toast.error('加载对战记录失败', e instanceof Error ? e.message : '网络错误');
    }
  }

  // --- Textarea ---
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  // --- Filter history ---
  const filteredHistory = historySearch
    ? history.filter((h) => h.prompt.toLowerCase().includes(historySearch.toLowerCase()))
    : history;
  const groupedHistory = groupByDate(filteredHistory);

  // --- Determine page state ---
  const hasBattle = panels.length > 0 || !!currentPrompt;
  const canReveal = allDone && !revealed && !revealAnimating && !revealLoading && panels.length > 0 && panels.some((p) => p.status === 'done');

  // --- Sort panels: panels with content first, then by startedAt, waiting last ---
  const sortedPanels = useMemo(() => {
    return [...panels].sort((a, b) => {
      // Panels with content (text or error) come first
      const aHasContent = a.text.length > 0 || a.status === 'error';
      const bHasContent = b.text.length > 0 || b.status === 'error';
      if (aHasContent !== bHasContent) return aHasContent ? -1 : 1;
      // Among those with content, sort by startedAt (earliest first = responded first)
      const aT = a.startedAt ?? Infinity;
      const bT = b.startedAt ?? Infinity;
      if (aT !== bT) return aT - bT;
      return 0;
    });
  }, [panels]);

  // --- Progress calculation ---
  const completedCount = panels.filter((p) => p.status === 'done' || p.status === 'error').length;
  const totalCount = panels.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const hasActiveProgress = hasBattle && totalCount > 0 && (isStreaming || completedCount > 0);

  return (
    <div className="flex h-full" style={{ minHeight: 0 }}>
      {/* ===================== Sidebar ===================== */}
      <div
        className={cn(
          'flex flex-col transition-all duration-300',
          sidebarCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-[280px] min-w-[280px]'
        )}
        style={{
          background: 'var(--bg-base, #0d0d0f)',
        }}
      >
        {/* Sidebar Title */}
        <div className="p-3 pb-1 flex-shrink-0 flex items-center gap-2">
          <Swords className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
          <h1 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 竞技场</h1>
        </div>

        {/* New Battle Button */}
        <div className="px-3 pb-2 flex-shrink-0">
          <Button variant="primary" size="md" className="w-full" onClick={handleNewBattle}>
            <Plus className="w-4 h-4" />
            新建对战
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 flex-shrink-0">
          <div
            className="flex items-center gap-2 h-9 px-3 rounded-[10px]"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="搜索历史对战..."
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              className="flex-1 bg-transparent border-none outline-none text-[13px]"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        {/* History List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2" style={{ minHeight: 0 }}>
          {historyLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="text-center py-8 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              暂无对战记录
            </div>
          ) : (
            Array.from(groupedHistory.entries()).map(([dateLabel, items]) => (
              <div key={dateLabel} className="mb-3">
                <div className="text-[11px] font-medium px-2 py-1.5 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {dateLabel}
                </div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleLoadBattle(item.id)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 rounded-[10px] mb-0.5',
                      'transition-colors duration-150 group',
                      activeBattleId === item.id ? 'bg-white/10' : 'hover:bg-white/5'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] leading-snug truncate" style={{ color: 'var(--text-primary)' }}>
                          {truncate(item.prompt, 30)}
                        </div>
                        <div className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                          <span>{item.responseCount} 个模型</span>
                          {item.revealed && (
                            <span
                              className="ml-1 text-[10px] px-1 py-0.5 rounded"
                              style={{ background: 'rgba(99,102,241,0.15)', color: 'rgba(99,102,241,0.9)' }}
                            >
                              已揭晓
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ===================== Main Area ===================== */}
      <div className="flex-1 flex flex-col min-w-0" style={{ minHeight: 0 }}>
        {/* Top Bar */}
        <div
          className="flex items-center justify-between px-5 h-14 flex-shrink-0"
          style={{
            background: 'var(--bg-base, #0d0d0f)',
          }}
        >
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-1.5 rounded-lg hover:bg-white/5"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Swords className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
            </button>
          </div>

          {/* Group Selector + Manage */}
          <div className="flex items-center gap-2">
            <div className="relative" ref={groupDropdownRef}>
              <button
                onClick={() => { setGroupDropdownOpen(!groupDropdownOpen); if (!groupDropdownOpen && manageMode) loadAdminGroups(); }}
                disabled={lineupLoading || isStreaming}
                className={cn(
                  'flex items-center gap-2 h-9 px-3 rounded-[10px] text-[13px] transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'hover:bg-white/5'
                )}
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
              >
                {lineupLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <span>{selectedGroup?.name ?? '选择阵容'}</span>
                    <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                  </>
                )}
              </button>
              {groupDropdownOpen && !manageMode && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-[12px] py-1 min-w-[200px]"
                  style={{
                    background: 'var(--bg-elevated, #1a1a1e)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                  }}
                >
                  {groups.length === 0 ? (
                    <div className="px-4 py-3 text-[13px] text-center" style={{ color: 'var(--text-muted)' }}>
                      {lineupError ? '加载失败，点击重试' : '暂无可用阵容'}
                      <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {lineupError ? (
                          <button className="underline hover:text-white/80" onClick={() => { setGroupDropdownOpen(false); loadLineup(); }}>
                            重新加载
                          </button>
                        ) : (
                          <button className="underline hover:text-white/80" onClick={enterManageMode}>
                            点击配置阵容
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      {groups.map((g) => (
                        <button
                          key={g.key}
                          onClick={() => { setSelectedGroupKey(g.key); setGroupDropdownOpen(false); }}
                          className={cn(
                            'w-full text-left px-3 py-2 text-[13px] transition-colors',
                            'hover:bg-white/5',
                            g.key === selectedGroupKey && 'bg-white/8'
                          )}
                          style={{ color: 'var(--text-primary)' }}
                        >
                          <div>{g.name}</div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{g.slots.length} 个模型</div>
                        </button>
                      ))}
                      <div className="mx-2 my-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
                      <button
                        onClick={enterManageMode}
                        className="w-full text-left px-3 py-2 text-[12px] transition-colors hover:bg-white/5 flex items-center gap-1.5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <Settings className="w-3.5 h-3.5" />
                        管理阵容
                      </button>
                    </>
                  )}
                </div>
              )}
              {/* --- Manage Mode Panel --- */}
              {groupDropdownOpen && manageMode && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-[12px] min-w-[360px] max-h-[480px] flex flex-col"
                  style={{
                    background: 'var(--bg-elevated, #1a1a1e)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                  }}
                >
                  {/* Manage header */}
                  <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>管理阵容</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={openCreateGroup}
                        className="h-7 px-2 rounded-md text-[11px] flex items-center gap-1 hover:bg-white/5 transition-colors"
                        style={{ color: 'rgba(99,102,241,0.9)' }}
                      >
                        <Plus className="w-3 h-3" />
                        新建分组
                      </button>
                      <button
                        onClick={exitManageMode}
                        className="h-7 px-2 rounded-md text-[11px] hover:bg-white/5 transition-colors"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        完成
                      </button>
                    </div>
                  </div>
                  {/* Group list */}
                  <div className="flex-1 overflow-y-auto px-2 pb-2" style={{ minHeight: 0 }}>
                    {adminLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
                      </div>
                    ) : adminGroups.length === 0 ? (
                      <div className="text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        暂无分组，点击"新建分组"创建
                      </div>
                    ) : (
                      adminGroups.map((ag) => (
                        <div key={ag.key} className="mb-2 rounded-[10px] overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)' }}>
                          {/* Group row */}
                          <div className="flex items-center justify-between px-3 py-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ag.name}</div>
                              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{ag.slots.length} 个模型</div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => openAddSlots(ag.key)}
                                className="p-1.5 rounded-md hover:bg-white/8 transition-colors"
                                title="添加模型"
                              >
                                <Plus className="w-3.5 h-3.5" style={{ color: 'rgba(99,102,241,0.8)' }} />
                              </button>
                              <button
                                onClick={() => openEditGroup(ag)}
                                className="p-1.5 rounded-md hover:bg-white/8 transition-colors"
                                title="编辑分组"
                              >
                                <Edit3 className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                              </button>
                              <ConfirmTip
                                title={`删除分组「${ag.name}」？`}
                                description="将同时删除该分组下所有模型槽位"
                                onConfirm={() => handleDeleteGroup(ag.id!)}
                              >
                                <button
                                  className="p-1.5 rounded-md hover:bg-white/8 transition-colors"
                                  title="删除分组"
                                >
                                  <Trash2 className="w-3.5 h-3.5" style={{ color: 'rgba(239,68,68,0.7)' }} />
                                </button>
                              </ConfirmTip>
                            </div>
                          </div>
                          {/* Slot list */}
                          {ag.slots.length > 0 && (
                            <div className="px-2 pb-2">
                              {ag.slots.map((slot) => (
                                <div
                                  key={slot.id}
                                  className="flex items-center justify-between px-2 py-1.5 rounded-md"
                                  style={{ opacity: slot.enabled === false ? 0.45 : 1 }}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                                      {slot.displayName || slot.modelId}
                                    </div>
                                    <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                                      {platformMap.get(slot.platformId) || slot.platformId}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-0.5 flex-shrink-0">
                                    <button
                                      onClick={() => handleToggleSlot(slot.id)}
                                      className="p-1 rounded hover:bg-white/8 transition-colors"
                                      title={slot.enabled === false ? '启用' : '禁用'}
                                    >
                                      <Power className="w-3 h-3" style={{ color: slot.enabled === false ? 'var(--text-muted)' : '#10b981' }} />
                                    </button>
                                    <ConfirmTip
                                      title={`删除模型「${slot.displayName || slot.modelId}」？`}
                                      onConfirm={() => handleDeleteSlot(slot.id)}
                                    >
                                      <button className="p-1 rounded hover:bg-white/8 transition-colors" title="删除">
                                        <Trash2 className="w-3 h-3" style={{ color: 'rgba(239,68,68,0.6)' }} />
                                      </button>
                                    </ConfirmTip>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===================== Content ===================== */}
        {!hasBattle ? (
          /* Empty State */
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4" style={{ minHeight: 0 }}>
            <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.1)' }}>
              <Swords className="w-8 h-8" style={{ color: 'rgba(99,102,241,0.7)' }} />
            </div>
            <div className="text-center">
              <h2 className="text-[18px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>AI 盲评竞技场</h2>
              <p className="text-[14px] max-w-md" style={{ color: 'var(--text-muted)' }}>
                提出问题，多个模型匿名作答。阅读回答后揭晓真实身份，公平评估模型能力。
              </p>
            </div>
            {lineupLoading ? (
              <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>加载阵容中...</span>
              </div>
            ) : lineupError ? (
              <div className="text-center">
                <div
                  className="text-[13px] mb-2 px-3 py-2 rounded-lg"
                  style={{ background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.15)' }}
                >
                  加载阵容失败: {lineupError}
                </div>
                <Button variant="secondary" size="sm" onClick={loadLineup}>重新加载</Button>
              </div>
            ) : groups.length === 0 ? (
              <div
                className="text-[13px] px-4 py-3 rounded-xl text-center max-w-sm"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
              >
                暂无可用阵容，请先在后台管理页面配置竞技场分组和模型
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                当前阵容: {selectedGroup?.name} ({slots.length} 个模型)
              </div>
            )}
          </div>
        ) : (
          /* Battle View — horizontal card layout */
          <div className="flex-1 flex flex-col min-h-0">
            {/* Prompt Bar */}
            <div
              className="flex-shrink-0 flex items-center gap-2 px-5 py-2.5"
              style={{ background: 'rgba(99,102,241,0.04)' }}
            >
              <div
                className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(99,102,241,0.15)' }}
              >
                <MessageSquare className="w-3 h-3" style={{ color: 'rgba(99,102,241,0.8)' }} />
              </div>
              <p
                className="text-[13px] truncate flex-1"
                style={{ color: 'var(--text-primary)' }}
                title={currentPrompt}
              >
                {currentPrompt}
              </p>
            </div>

            {/* Panels Row — horizontal scroll, each card 1/3 width, sorted by activity */}
            <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto px-4 py-4">
              {sortedPanels.map((panel) => {
                const info = revealedInfos.get(panel.slotId);
                const letter = getLabel(panel.labelIndex);
                const labelColor = info?.avatarColor ?? getLabelColor(panel.labelIndex);

                // Resolve model avatar for revealed state
                const avatarUrl = revealed && info
                  ? (getAvatarUrlByModelName(info.displayName) ?? getAvatarUrlByPlatformType(info.platformName))
                  : null;
                const isSvg = avatarUrl ? /\.svg(\?|#|$)/i.test(avatarUrl) : false;

                return (
                  <div
                    key={panel.slotId}
                    className="flex-shrink-0 flex flex-col"
                    style={{ width: 'calc(33.333% - 8px)', minWidth: '320px' }}
                  >
                    <div
                      className={cn(
                        'flex flex-col h-full rounded-[14px] transition-transform duration-500',
                        revealAnimating && 'scale-[0.98]'
                      )}
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                      }}
                    >
                      {/* Header */}
                      <div
                        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                      >
                        <div className="flex items-center gap-2.5">
                          {/* Avatar: model image on reveal, letter badge before reveal */}
                          {revealed && info && avatarUrl ? (
                            <div
                              className="w-7 h-7 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0"
                              style={{ background: isSvg ? 'rgba(255,255,255,0.06)' : 'transparent' }}
                            >
                              <img
                                src={avatarUrl}
                                alt={info.displayName}
                                className={isSvg ? 'w-4 h-4 object-contain' : 'w-full h-full object-cover'}
                                style={isSvg ? { filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))' } : undefined}
                              />
                            </div>
                          ) : (
                            <div
                              className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold flex-shrink-0"
                              style={{
                                background: `${labelColor}20`,
                                color: labelColor,
                                border: `1px solid ${labelColor}40`,
                              }}
                            >
                              {letter}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {revealed && info ? info.displayName : panel.label}
                            </div>
                            {revealed && info && (
                              <div className="mt-0.5">
                                <PlatformLabel name={info.platformName} size="sm" showIcon={false} />
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {panel.status === 'streaming' && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: labelColor }} />
                          )}
                          {panel.status === 'done' && (
                            <div className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} />
                          )}
                          {panel.status === 'error' && (
                            <div className="w-2 h-2 rounded-full" style={{ background: '#ef4444' }} />
                          )}
                          {(panel.status === 'done' || panel.status === 'error') && panel.totalMs != null && (
                            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                              {(panel.totalMs / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Body — internal scroll */}
                      <div
                        className="flex-1 overflow-y-auto min-h-0 px-5 py-4"
                        data-panel-body
                      >
                        {panel.status === 'waiting' ? (
                          <div className="flex items-center gap-2 py-8 justify-center">
                            <div className="flex gap-1">
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '0ms' }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '150ms' }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '300ms' }} />
                            </div>
                            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>等待响应...</span>
                          </div>
                        ) : panel.status === 'error' ? (
                          <div className="py-4">
                            <div
                              className="text-[13px] px-3 py-2 rounded-lg"
                              style={{ background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.15)' }}
                            >
                              {panel.errorMessage ?? '响应异常'}
                            </div>
                          </div>
                        ) : (
                          <div className="arena-markdown text-[14px] leading-[1.75] break-words" style={{ color: 'var(--text-primary)' }}>
                            <ReactMarkdown>{panel.text}</ReactMarkdown>
                            {panel.status === 'streaming' && (
                              <span
                                className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse"
                                style={{ background: labelColor, verticalAlign: 'text-bottom' }}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Footer — metrics (visible after reveal) */}
                      {(panel.status === 'done' || panel.status === 'error') && revealed && (
                        <div
                          className="px-4 py-2 flex items-center gap-4 flex-shrink-0"
                        >
                          {panel.ttftMs != null && (
                            <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <Clock className="w-3 h-3" />
                              <span>TTFT: {panel.ttftMs}ms</span>
                            </div>
                          )}
                          {panel.totalMs != null && (
                            <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <Clock className="w-3 h-3" />
                              <span>总耗时: {(panel.totalMs / 1000).toFixed(1)}s</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================== Bottom Bar ===================== */}
        <div
          className="flex-shrink-0 px-6 py-4"
          style={{
            background: 'var(--bg-base, #0d0d0f)',
          }}
        >
          <div className="mx-auto" style={{ maxWidth: '900px' }}>
            {/* Conic-gradient progress ring wrapper */}
            <div
              className="rounded-[18px] p-[2px] transition-all duration-300"
              style={{
                background: hasActiveProgress
                  ? completedCount === totalCount && !isStreaming
                    ? '#10b981'
                    : `conic-gradient(from 0deg, #6366f1 ${progressPct * 3.6}deg, rgba(255,255,255,0.06) ${progressPct * 3.6}deg)`
                  : 'rgba(255,255,255,0.06)',
              }}
            >
              <div
                className="rounded-[16px] p-3"
                style={{ background: 'var(--bg-base, #0d0d0f)' }}
              >
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder={
                  lineupLoading
                    ? '阵容加载中...'
                    : groups.length === 0
                      ? '请先在管理页配置竞技场阵容...'
                      : slots.length === 0
                        ? '请先选择一个有模型的阵容...'
                        : '输入你的问题，让多个模型匿名回答...'
                }
                disabled={isStreaming || slots.length === 0}
                rows={2}
                className={cn(
                  'w-full bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none resize-none text-[14px] leading-relaxed',
                  'placeholder:text-[color:var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed',
                  'px-2 py-1 no-focus-ring'
                )}
                style={{ color: 'var(--text-primary)', minHeight: '56px', maxHeight: '200px', border: 'none', boxShadow: 'none' }}
              />
              <div className="flex items-center justify-between mt-2 pt-2">
                <span className="text-[11px] px-2" style={{ color: 'var(--text-muted)' }}>
                  {hasActiveProgress
                    ? <span style={{ color: completedCount === totalCount ? '#10b981' : 'var(--text-muted)' }}>
                        {completedCount}/{totalCount}{completedCount === totalCount && !isStreaming ? ' 完成' : ' 进行中'}
                        {' · '}
                      </span>
                    : null}
                  {slots.length > 0
                    ? `${selectedGroup?.name} · ${slots.length} 个模型匿名回答`
                    : groups.length === 0 ? '未配置阵容' : '请选择阵容'}
                </span>
                <div className="flex items-center gap-2">
                  {canReveal && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleReveal}
                      disabled={revealLoading}
                    >
                      {revealLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                      揭晓身份
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSend}
                    disabled={isStreaming || !prompt.trim() || slots.length === 0}
                    className="px-4"
                  >
                    {isStreaming ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        发送
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== Group Create/Edit Dialog ===================== */}
      <Dialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        title={editingGroupId ? '编辑分组' : '新建分组'}
        content={
          <div className="space-y-4">
            {!editingGroupId && (
              <div>
                <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                  分组 Key <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={groupForm.key}
                  onChange={(e) => setGroupForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="如 global-frontier"
                  className="w-full h-9 px-3 rounded-[8px] text-[13px] bg-transparent outline-none"
                  style={{ border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                />
              </div>
            )}
            <div>
              <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                分组名称 <span style={{ color: 'rgba(239,68,68,0.8)' }}>*</span>
              </label>
              <input
                type="text"
                value={groupForm.name}
                onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="如 世界顶尖"
                className="w-full h-9 px-3 rounded-[8px] text-[13px] bg-transparent outline-none"
                style={{ border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
              />
            </div>
            <div>
              <label className="text-[12px] font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>描述</label>
              <input
                type="text"
                value={groupForm.description}
                onChange={(e) => setGroupForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="可选"
                className="w-full h-9 px-3 rounded-[8px] text-[13px] bg-transparent outline-none"
                style={{ border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setGroupDialogOpen(false)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSaveGroup} disabled={groupSaving}>
                {groupSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {editingGroupId ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        }
      />

      {/* ===================== Model Picker Dialog ===================== */}
      <ModelPoolPickerDialog
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        selectedModels={existingModelsForPicker}
        platforms={platforms}
        onConfirm={handleModelPickerConfirm}
      />
    </div>
  );
}
