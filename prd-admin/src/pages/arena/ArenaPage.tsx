import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Button } from '@/components/design/Button';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { connectSse } from '@/lib/useSseStream';
import { getAvatarUrlByModelName, getAvatarUrlByPlatformType, useAvatarUpdates } from '@/assets/model-avatars';
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
  uploadArenaAttachment,
} from '@/services';
import type { ArenaAttachmentInfo } from '@/services';
import { api } from '@/services/api';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmTip } from '@/components/ui/ConfirmTip';
import { ModelPoolPickerDialog, type SelectedModelItem } from '@/components/model/ModelPoolPickerDialog';
import type { Platform } from '@/types/admin';
import {
  Eye, Send, Plus, Search, MessageSquare, Clock, Swords, ChevronDown, ChevronRight, Brain,
  Edit3, Trash2, Settings, Power, RefreshCw, Download, Copy, Check,
  Image as ImageIcon, X, FileText, Paperclip,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StaticBackdrop } from '@/pages/home/components/StaticBackdrop';
import { Reveal } from '@/pages/home/components/Reveal';
import { HERO_GRADIENT } from '@/pages/home/sections/HeroSection';

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
  thinking: string;
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
  hasAttachments?: boolean;
}

interface BattleAttachment {
  attachmentId: string;
  url: string;
  fileName: string;
  mimeType: string;
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
  attachments?: BattleAttachment[];
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

// ---------------------------------------------------------------------------
// ThinkingBlock — collapsible reasoning/thinking display
// ---------------------------------------------------------------------------

function ThinkingBlock({ thinking, color, streaming }: { thinking: string; color: string; streaming?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  // Auto-expand while streaming thinking (no text yet), collapse once text starts
  const isActive = streaming && thinking.length > 0;

  return (
    <div className="mb-3">
      <button
        className="flex items-center gap-1.5 text-[12px] py-1 px-1 rounded hover:bg-white/5 transition-colors"
        style={{ color: 'var(--text-muted)' }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded || isActive ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <Brain className="w-3 h-3" style={{ color }} />
        <span>{isActive ? '思考中...' : '思考过程'}</span>
        {isActive && (
          <span
            className="inline-block w-[2px] h-[10px] ml-0.5 animate-pulse"
            style={{ background: color, verticalAlign: 'text-bottom' }}
          />
        )}
      </button>
      {(expanded || isActive) && (
        <div
          className="mt-1 px-3 py-2 rounded-lg text-[12px] leading-[1.6] max-h-[200px] overflow-y-auto"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {thinking}
        </div>
      )}
    </div>
  );
}

export function ArenaPage() {
  useAvatarUpdates();
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

  // --- Attachment state ---
  const [attachments, setAttachments] = useState<ArenaAttachmentInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [currentAttachments, setCurrentAttachments] = useState<BattleAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

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
          thinking: '',
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
        if (!res.success) throw new Error(res.error?.message || '更新失败');
        toast.success('分组已更新');
      } else {
        const res = await createArenaGroup({
          key: groupForm.key.trim(),
          name: groupForm.name.trim(),
          description: groupForm.description.trim() || undefined,
          sortOrder: groupForm.sortOrder,
        });
        if (!res.success) throw new Error(res.error?.message || '创建失败');
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
      if (!res.success) throw new Error(res.error?.message || '删除失败');
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
    const existingSlots = group?.slots ?? [];
    const existingKeys = new Set(
      existingSlots.map((s) => `${s.platformId}:${s.modelId}`.toLowerCase()),
    );
    const confirmedKeys = new Set(
      models.map((m) => `${m.platformId}:${m.modelId}`.toLowerCase()),
    );

    // Find new models to add
    const newModels = models.filter(
      (m) => !existingKeys.has(`${m.platformId}:${m.modelId}`.toLowerCase()),
    );
    // Find existing slots to remove (were in existing but removed from confirmed list)
    const slotsToRemove = existingSlots.filter(
      (s) => !confirmedKeys.has(`${s.platformId}:${s.modelId}`.toLowerCase()),
    );

    if (newModels.length === 0 && slotsToRemove.length === 0) {
      toast.info('没有变更');
      return;
    }

    let addCount = 0;
    let removeCount = 0;

    // Delete removed slots
    for (const slot of slotsToRemove) {
      try {
        const res = await deleteArenaSlot(slot.id);
        if (res.success) removeCount++;
      } catch {
        // continue
      }
    }

    // Add new slots
    for (const m of newModels) {
      try {
        const res = await createArenaSlot({
          displayName: m.name || m.modelName || m.modelId,
          platformId: m.platformId,
          modelId: m.modelId,
          group: modelPickerTargetGroup,
          enabled: true,
        });
        if (res.success) addCount++;
      } catch {
        // continue
      }
    }

    if (addCount > 0 || removeCount > 0) {
      const msgs: string[] = [];
      if (addCount > 0) msgs.push(`添加 ${addCount} 个`);
      if (removeCount > 0) msgs.push(`移除 ${removeCount} 个`);
      toast.success(`模型已更新：${msgs.join('，')}`);
      await loadAdminGroups();
    } else {
      toast.error('操作失败');
    }
  }

  async function handleDeleteSlot(slotId: string) {
    try {
      const res = await deleteArenaSlot(slotId);
      if (!res.success) throw new Error(res.error?.message || '删除失败');
      toast.success('模型已删除');
      await loadAdminGroups();
    } catch (err: any) {
      toast.error('删除模型失败', err?.message);
    }
  }

  async function handleToggleSlot(slotId: string) {
    try {
      const res = await toggleArenaSlot(slotId);
      if (!res.success) throw new Error(res.error?.message || '切换失败');
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
    setAttachments([]);
    setCurrentAttachments([]);
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
      // Backend only emits runDone after Task.WhenAll — all models are guaranteed done/error.
      // Directly set allDone=true to avoid React 18 batching race where panelsRef.current
      // hasn't been updated yet by preceding modelDone setPanels updaters.
      setAllDone(true);
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

      case 'thinking':
        updatePanel((p) => ({
          ...p,
          status: 'streaming',
          thinking: p.thinking + (data.content ?? ''),
          startedAt: p.startedAt ?? Date.now(),
        }));
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
        const msg = String(data.errorMessage ?? '').trim() || '模型响应异常';
        updatePanel((p) => ({
          ...p,
          status: 'error',
          errorMessage: msg,
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

    const streamPath = api.arena.runs.stream(runId);
    const fullUrl = joinUrl(getApiBaseUrl(), `${streamPath}?afterSeq=${afterSeq}`);

    const result = await connectSse({
      url: fullUrl,
      signal: abortController.signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        // Track sequence for reconnection
        if (evt.id) {
          const seq = parseInt(evt.id, 10);
          if (!isNaN(seq)) afterSeqRef.current = seq;
        }
        // The SSE stream wraps events as RunEventRecord — data contains the full record JSON
        try {
          const record = JSON.parse(evt.data);
          const payloadJson = record.payloadJson ?? evt.data;
          handleRunEvent(payloadJson);
        } catch {
          handleRunEvent(evt.data);
        }
      },
    });

    if (!result.success && !abortController.signal.aborted) {
      // Connection lost — check if run is still active and auto-reconnect
      // Keep abortRef alive so the reconnect guard can check it
      try {
        const runRes = await getArenaRun(runId);
        if (runRes.success && runRes.data) {
          const status = runRes.data.status as string;
          if (status === 'Running' || status === 'Queued') {
            setTimeout(() => {
              // Guard: skip reconnect if user already started a new battle or aborted
              if (abortRef.current?.signal.aborted === false) {
                subscribeToRunStream(runId, afterSeqRef.current);
              }
            }, 1000);
            return;
          }
          if (status === 'Done') {
            abortRef.current = null;
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
      abortRef.current = null;
      toast.error('流式连接中断', result.errorMessage ?? '网络错误');
    } else {
      abortRef.current = null;
    }
  }

  // --- Core battle launcher (shared by handleSend & handleRetry) ---
  async function launchBattle(question: string, sendAttachmentIds: string[] = []) {
    const newLabelMap = assignLabels(slots);
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

    const initialPanels: ArenaPanel[] = runSlots.map((s) => ({
      slotId: s.slotId,
      label: s.label,
      labelIndex: s.labelIndex,
      status: 'waiting' as const,
      text: '',
      thinking: '',
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
    afterSeqRef.current = 0;
    setPrompt('');

    try {
      const res = await createArenaRun({
        prompt: question,
        groupKey: selectedGroupKey,
        slots: runSlots,
        attachmentIds: sendAttachmentIds.length > 0 ? sendAttachmentIds : undefined,
      });

      if (!res.success || !res.data?.runId) {
        throw new Error(res.error?.message || '创建 Run 失败');
      }

      const runId = res.data.runId as string;
      setActiveRunId(runId);

      sessionStorage.setItem(ARENA_RUN_STORAGE_KEY, JSON.stringify({
        runId,
        prompt: question,
        groupKey: selectedGroupKey,
        slots: runSlots,
      }));

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
  }

  // --- Send question ---
  const handleSend = useCallback(async () => {
    const question = prompt.trim();
    if (!question || isStreaming) return;
    if (slots.length === 0) {
      toast.warning('暂无可用模型', '请先在管理页配置竞技场阵容');
      return;
    }

    const sendAttachmentIds = attachments.map((a) => a.attachmentId);
    setCurrentAttachments(attachments.map((a) => ({
      attachmentId: a.attachmentId,
      url: a.url,
      fileName: a.fileName,
      mimeType: a.mimeType,
    })));
    setAttachments([]);

    await launchBattle(question, sendAttachmentIds);
  }, [prompt, isStreaming, slots, selectedGroupKey, attachments]);

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

  // --- Retry: re-send the same question ---
  function handleRetry() {
    if (isStreaming || !currentPrompt.trim()) return;
    launchBattle(currentPrompt.trim());
  }

  // --- Copy panel text to clipboard ---
  const [copiedSlotId, setCopiedSlotId] = useState<string | null>(null);

  // --- Track panels that just completed (for attention pulse) ---
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(new Set());
  const prevPanelStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prevMap = prevPanelStatusRef.current;
    const newlyDone: string[] = [];
    const anyStillStreaming = panels.some((p) => p.status === 'streaming' || p.status === 'waiting');
    for (const p of panels) {
      const prev = prevMap.get(p.slotId);
      if (prev && prev !== 'done' && prev !== 'error' && (p.status === 'done' || p.status === 'error') && anyStillStreaming) {
        newlyDone.push(p.slotId);
      }
      prevMap.set(p.slotId, p.status);
    }
    if (newlyDone.length > 0) {
      setJustCompletedIds((prev) => {
        const next = new Set(prev);
        for (const id of newlyDone) next.add(id);
        return next;
      });
      // Clear after animation completes (matches 3s CSS duration)
      setTimeout(() => {
        setJustCompletedIds((prev) => {
          const next = new Set(prev);
          for (const id of newlyDone) next.delete(id);
          return next;
        });
      }, 3200);
    }
  }, [panels]);
  function handleCopyPanel(panel: ArenaPanel) {
    navigator.clipboard.writeText(panel.text).then(() => {
      setCopiedSlotId(panel.slotId);
      toast.success('已复制到剪贴板');
      setTimeout(() => setCopiedSlotId(null), 2000);
    }).catch(() => toast.error('复制失败'));
  }

  // --- Download panel text as markdown ---
  function handleDownloadPanel(panel: ArenaPanel) {
    const info = revealedInfos.get(panel.slotId);
    const name = revealed && info ? info.displayName : panel.label;
    const filename = `${name.replace(/[/\\?%*:|"<>\s]/g, '_')}.md`;
    const header = `# ${name}\n\n`;
    const blob = new Blob([header + panel.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
        setCurrentAttachments(battle.attachments ?? []);

        const loadedPanels: ArenaPanel[] = (battle.responses || []).map((r, idx) => ({
          slotId: r.slotId,
          label: r.label,
          labelIndex: idx,
          status: r.status === 'error' ? 'error' : 'done',
          text: r.content || '',
          thinking: (r as any).thinking || '',
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

  // --- Attachment handlers ---
  const ACCEPTED_TYPES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
    'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
    'application/pdf', 'application/json', 'application/xml',
  ];
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
  const MAX_ATTACHMENTS = 20;

  async function uploadFiles(files: File[]) {
    const validFiles = files.filter((f) => ACCEPTED_TYPES.includes(f.type));
    if (validFiles.length === 0) {
      toast.warning('不支持的文件类型', '支持图片、文本、Markdown、PDF、JSON、CSV 等格式');
      return;
    }
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      toast.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const toUpload = validFiles.slice(0, remaining);
    setIsUploading(true);
    for (const file of toUpload) {
      try {
        const res = await uploadArenaAttachment(file);
        if (res.success && res.data) {
          setAttachments((prev) => [...prev, res.data!]);
        } else {
          toast.error('上传失败', res.error?.message ?? file.name);
        }
      } catch (err: any) {
        toast.error('上传失败', err?.message ?? file.name);
      }
    }
    setIsUploading(false);
  }

  function handleAttachmentClick() {
    fileInputRef.current?.click();
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) uploadFiles(files);
    e.target.value = '';
  }

  function handleRemoveAttachment(attachmentId: string) {
    setAttachments((prev) => prev.filter((a) => a.attachmentId !== attachmentId));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const pastedFiles: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      uploadFiles(pastedFiles);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) uploadFiles(files);
  }

  // --- Filter history ---
  const filteredHistory = historySearch
    ? history.filter((h) => h.prompt.toLowerCase().includes(historySearch.toLowerCase()))
    : history;
  const groupedHistory = groupByDate(filteredHistory);

  // --- Determine page state ---
  const hasBattle = panels.length > 0 || !!currentPrompt;
  const canReveal = allDone && !revealed && !revealAnimating && !revealLoading && panels.length > 0 && panels.some((p) => p.status === 'done');

  // --- Sort panels ---
  // First to produce content stays left, latecomers append right.
  // Once a panel's position is assigned it never changes — no reordering at any point.
  const sortOrderRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (panels.length === 0) {
      sortOrderRef.current = new Map();
      return;
    }
    let nextOrder = sortOrderRef.current.size;
    for (const p of panels) {
      if (!sortOrderRef.current.has(p.slotId)) {
        const hasContent = (p.text?.length ?? 0) > 0 || (p.thinking?.length ?? 0) > 0 || p.status === 'error';
        if (hasContent) {
          sortOrderRef.current.set(p.slotId, nextOrder++);
        }
      }
    }
  }, [panels]);

  const sortedPanels = useMemo(() => {
    return [...panels].sort((a, b) => {
      const aOrder = sortOrderRef.current.get(a.slotId) ?? Infinity;
      const bOrder = sortOrderRef.current.get(b.slotId) ?? Infinity;
      return aOrder - bOrder;
    });
  }, [panels]);

  // --- Safety net: detect all panels done even if runDone event was missed ---
  useEffect(() => {
    if (!allDone && !isStreaming && panels.length > 0 && panels.every((p) => p.status === 'done' || p.status === 'error')) {
      setAllDone(true);
    }
  }, [panels, isStreaming, allDone]);

  // --- Progress calculation ---
  const completedCount = panels.filter((p) => p.status === 'done' || p.status === 'error').length;
  const totalCount = panels.length;
  const hasActiveProgress = hasBattle && totalCount > 0 && (isStreaming || completedCount > 0);

  return (
    <div
      className="relative flex h-full text-white"
      style={{ minHeight: 0, fontFamily: 'var(--font-body)' }}
    >
      {/* Layer 0 · StaticBackdrop（absolute 模式，局限在 AppShell 主内容区） */}
      <StaticBackdrop mode="absolute" />

      {/* ===================== Sidebar ===================== */}
      <div
        className={cn(
          'relative z-10 flex flex-col transition-all duration-300',
          sidebarCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-[280px] min-w-[280px]'
        )}
        style={{
          background: 'rgba(10, 14, 22, 0.62)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        }}
      >
        {/* New Battle Button — HERO_GRADIENT pill */}
        <div className="p-3 flex-shrink-0">
          <button
            type="button"
            onClick={handleNewBattle}
            className="group relative inline-flex w-full items-center justify-center gap-2 h-10 px-4 rounded-full text-[13px] font-medium text-white transition-all duration-200 hover:scale-[1.01] active:scale-[0.98]"
            style={{
              background: HERO_GRADIENT,
              boxShadow:
                '0 0 28px rgba(124, 58, 237, 0.32), 0 0 64px rgba(0, 240, 255, 0.18), 0 6px 20px rgba(0, 0, 0, 0.45)',
              fontFamily: 'var(--font-display)',
              letterSpacing: '0.01em',
            }}
          >
            <Plus className="w-4 h-4" />
            <span>新建对战</span>
          </button>
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
              <MapSpinner size={16} color="var(--text-muted)" />
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="text-center py-8 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              暂无对战记录
            </div>
          ) : (
            Array.from(groupedHistory.entries()).map(([dateLabel, items]) => (
              <div key={dateLabel} className="mb-3">
                <div
                  className="text-[11px] px-2 py-1.5 uppercase"
                  style={{
                    color: 'rgba(255, 255, 255, 0.45)',
                    fontFamily: 'var(--font-terminal)',
                    letterSpacing: '0.2em',
                  }}
                >
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
                          {item.hasAttachments && (
                            <ImageIcon className="w-3 h-3 ml-0.5" style={{ color: 'rgba(99,102,241,0.7)' }} />
                          )}
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
      <div className="relative z-10 flex-1 flex flex-col min-w-0" style={{ minHeight: 0 }}>
        {/* Top Bar — glass + HUD chip status */}
        <div
          className="flex items-center justify-between px-5 h-14 flex-shrink-0"
          style={{
            background: 'rgba(10, 14, 22, 0.52)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-1.5 rounded-lg hover:bg-white/5"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Swords className="w-4 h-4 text-white/85" />
            </button>
            <div className="flex items-center gap-3">
              {/* Gradient icon badge */}
              <div
                className="relative flex items-center justify-center w-8 h-8 rounded-[10px]"
                style={{
                  background: HERO_GRADIENT,
                  boxShadow:
                    '0 0 24px rgba(124, 58, 237, 0.28), 0 0 48px rgba(0, 240, 255, 0.12)',
                }}
              >
                <Swords className="w-4 h-4 text-white drop-shadow" />
              </div>
              <h1
                className="text-[17px] font-medium text-white"
                style={{
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '-0.015em',
                }}
              >
                AI 竞技场
              </h1>
              {/* HUD chip — live status */}
              <div
                className="hidden md:inline-flex items-center gap-2 ml-1 px-2.5 py-1 rounded-md"
                style={{
                  fontFamily: 'var(--font-terminal)',
                  background: 'rgba(16, 185, 129, 0.06)',
                  border: '1px solid rgba(16, 185, 129, 0.28)',
                  boxShadow: '0 0 16px rgba(16, 185, 129, 0.16), inset 0 0 8px rgba(16, 185, 129, 0.04)',
                }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70" />
                  <span
                    className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400"
                    style={{ boxShadow: '0 0 6px #34d399' }}
                  />
                </span>
                <span
                  className="text-[10.5px] text-emerald-300 uppercase"
                  style={{ letterSpacing: '0.2em', textShadow: '0 0 8px rgba(52, 211, 153, 0.55)' }}
                >
                  BLIND · LIVE
                </span>
              </div>
            </div>
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
                  <MapSpinner size={14} />
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
                    <button
                      onClick={openCreateGroup}
                      className="h-7 px-2 rounded-md text-[11px] flex items-center gap-1 hover:bg-white/5 transition-colors"
                      style={{ color: 'rgba(99,102,241,0.9)' }}
                    >
                      <Plus className="w-3 h-3" />
                      新建分组
                    </button>
                  </div>
                  {/* Group list */}
                  <div className="flex-1 overflow-y-auto px-2 pb-2" style={{ minHeight: 0 }}>
                    {adminLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <MapSpinner size={16} color="var(--text-muted)" />
                      </div>
                    ) : adminGroups.length === 0 ? (
                      <div className="text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        暂无分组，点击"新建分组"创建
                      </div>
                    ) : (
                      adminGroups.map((ag) => (
                        <div key={ag.key} className="mb-2 rounded-[10px] overflow-hidden" style={{ background: ag.key === selectedGroupKey ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.03)', border: ag.key === selectedGroupKey ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent' }}>
                          {/* Group row */}
                          <div className="flex items-center justify-between px-3 py-2">
                            <button
                              className="flex-1 min-w-0 text-left"
                              onClick={() => { setSelectedGroupKey(ag.key); setGroupDropdownOpen(false); setManageMode(false); manageModeRef.current = false; }}
                              title="点击切换到此阵容"
                            >
                              <div className="flex items-center gap-1.5">
                                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{ag.name}</div>
                                {ag.key === selectedGroupKey && (
                                  <Check className="w-3 h-3 flex-shrink-0" style={{ color: 'rgba(99,102,241,0.8)' }} />
                                )}
                              </div>
                              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{ag.slots.length} 个模型</div>
                            </button>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => openEditGroup(ag)}
                                className="p-1.5 rounded-md hover:bg-white/8 transition-colors"
                                title="重命名分组"
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
                              {/* Add model button — inside slot list for clarity */}
                              <button
                                onClick={() => openAddSlots(ag.key)}
                                className="w-full flex items-center justify-center gap-1.5 mt-1 py-1.5 rounded-md text-[11px] transition-colors hover:bg-white/5"
                                style={{ color: 'rgba(99,102,241,0.8)', border: '1px dashed rgba(99,102,241,0.25)' }}
                              >
                                <Plus className="w-3 h-3" />
                                添加模型
                              </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {/* Full-width bottom bar — "完成" */}
                  <div className="flex-shrink-0 px-2 pb-2 pt-1">
                    <button
                      onClick={exitManageMode}
                      className="w-full h-9 rounded-lg text-[13px] font-medium transition-colors"
                      style={{
                        background: 'rgba(99,102,241,0.15)',
                        color: 'rgba(99,102,241,0.95)',
                        border: '1px solid rgba(99,102,241,0.2)',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.25)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.15)'; }}
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ===================== Content ===================== */}
        {!hasBattle ? (
          /* Empty State — hero-style welcome with Reveal stagger */
          <div className="flex-1 flex flex-col items-center justify-center px-4" style={{ minHeight: 0 }}>
            <div className="w-full" style={{ maxWidth: '720px' }}>
              {/* Welcome hero — eyebrow / title / subtitle */}
              <div className="text-center mb-8">
                <Reveal delay={0}>
                  <div
                    className="inline-flex items-center gap-2 mb-6 px-3.5 py-1.5 rounded-md"
                    style={{
                      fontFamily: 'var(--font-terminal)',
                      background: 'rgba(148, 163, 184, 0.06)',
                      border: '1px solid rgba(148, 163, 184, 0.30)',
                      boxShadow:
                        '0 0 20px rgba(148, 163, 184, 0.18), inset 0 0 10px rgba(148, 163, 184, 0.04)',
                    }}
                  >
                    <Swords className="w-3.5 h-3.5 text-slate-200" />
                    <span
                      className="text-[12px] text-slate-200 uppercase"
                      style={{
                        letterSpacing: '0.22em',
                        textShadow: '0 0 10px rgba(203, 213, 225, 0.45)',
                      }}
                    >
                      BLIND · ARENA
                    </span>
                  </div>
                </Reveal>

                <Reveal delay={80}>
                  <h2
                    data-arena-pulse
                    className="text-white font-medium"
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.875rem, 3.6vw, 2.75rem)',
                      lineHeight: 1.06,
                      letterSpacing: '-0.03em',
                      animation: 'arena-title-pulse 5s ease-in-out infinite',
                    }}
                  >
                    AI 盲评竞技场
                  </h2>
                </Reveal>

                <Reveal delay={160}>
                  <p
                    className="mt-5 text-[14.5px] leading-[1.7] mx-auto"
                    style={{ color: 'rgba(255, 255, 255, 0.58)', maxWidth: '44ch' }}
                  >
                    提出问题，多个模型匿名作答。阅读回答后揭晓真实身份，公平评估模型能力。
                  </p>
                </Reveal>
              </div>

              {lineupLoading ? (
                <div className="mb-4">
                  <MapSectionLoader text="加载阵容中..." />
                </div>
              ) : lineupError ? (
                <div className="text-center mb-4">
                  <div
                    className="text-[13px] mb-2 px-3 py-2 rounded-lg inline-block"
                    style={{ background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.15)' }}
                  >
                    加载阵容失败: {lineupError}
                  </div>
                  <div><Button variant="secondary" size="sm" onClick={loadLineup}>重新加载</Button></div>
                </div>
              ) : groups.length === 0 ? (
                <div
                  className="text-[13px] px-4 py-3 rounded-xl text-center mx-auto max-w-sm mb-4"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                >
                  暂无可用阵容，请先在后台管理页面配置竞技场分组和模型
                </div>
              ) : null}

              {/* Centered input box */}
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,text/plain,text/markdown,text/csv,text/html,text/xml,application/pdf,application/json,application/xml,.md,.txt,.csv,.json,.pdf,.xml,.html"
                className="hidden"
                onChange={handleFileInputChange}
              />
              <Reveal delay={240}>
                <div
                  className={cn(
                    'rounded-[18px] p-[1.5px] transition-all duration-300',
                    dragOver && 'ring-2 ring-cyan-400/50'
                  )}
                  style={{
                    background: dragOver
                      ? HERO_GRADIENT
                      : 'linear-gradient(135deg, rgba(0, 240, 255, 0.28) 0%, rgba(124, 58, 237, 0.22) 50%, rgba(244, 63, 94, 0.28) 100%)',
                    boxShadow: dragOver
                      ? '0 0 48px rgba(124, 58, 237, 0.35), 0 0 100px rgba(0, 240, 255, 0.2)'
                      : '0 0 32px rgba(124, 58, 237, 0.12), 0 8px 28px rgba(0, 0, 0, 0.5)',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <div
                    className="rounded-[16.5px] p-3"
                    style={{
                      background: 'rgba(10, 14, 22, 0.82)',
                      backdropFilter: 'blur(14px)',
                      WebkitBackdropFilter: 'blur(14px)',
                      position: 'relative',
                      zIndex: 1,
                    }}
                  >
                    {/* Attachment preview strip */}
                    {attachments.length > 0 && (
                      <div className="flex gap-2 px-2 pb-2 flex-wrap">
                        {attachments.map((att) => (
                          <div
                            key={att.attachmentId}
                            className="relative group rounded-lg overflow-hidden flex-shrink-0"
                            style={{
                              width: '64px',
                              height: '64px',
                              background: 'rgba(255,255,255,0.04)',
                              border: '1px solid rgba(255,255,255,0.08)',
                            }}
                          >
                            {IMAGE_TYPES.has(att.mimeType) ? (
                              <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <FileText className="w-5 h-5 text-white/50" />
                              </div>
                            )}
                            <button
                              onClick={() => handleRemoveAttachment(att.attachmentId)}
                              className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ background: 'rgba(0,0,0,0.7)' }}
                            >
                              <X className="w-2.5 h-2.5 text-white" />
                            </button>
                            <div
                              className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate"
                              style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
                            >
                              {att.fileName}
                            </div>
                          </div>
                        ))}
                        {isUploading && (
                          <div
                            className="flex items-center justify-center rounded-lg flex-shrink-0"
                            style={{
                              width: '64px',
                              height: '64px',
                              background: 'rgba(255,255,255,0.04)',
                              border: '1px dashed rgba(255,255,255,0.15)',
                            }}
                          >
                            <MapSpinner size={16} color="rgba(255,255,255,0.45)" />
                          </div>
                        )}
                      </div>
                    )}
                    <textarea
                      ref={textareaRef}
                      value={prompt}
                      onChange={handleTextareaInput}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
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
                      rows={3}
                      className={cn(
                        'w-full bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none resize-none text-[14.5px] leading-relaxed',
                        'placeholder:text-white/30 disabled:opacity-50 disabled:cursor-not-allowed',
                        'px-2 py-1 no-focus-ring text-white'
                      )}
                      style={{ minHeight: '72px', maxHeight: '200px', border: 'none', boxShadow: 'none', fontFamily: 'var(--font-body)' }}
                    />
                    {/* Toolbar row */}
                    <div className="flex items-center justify-between mt-1 px-1">
                      <div className="flex items-center gap-1">
                        {/* Attachment button */}
                        <button
                          onClick={handleAttachmentClick}
                          disabled={isStreaming || slots.length === 0 || attachments.length >= MAX_ATTACHMENTS}
                          className={cn(
                            'flex items-center justify-center w-8 h-8 rounded-lg transition-colors text-white/55',
                            'disabled:opacity-30 disabled:cursor-not-allowed',
                            'hover:bg-white/8 hover:text-white/85'
                          )}
                          title={`添加附件 (${attachments.length}/${MAX_ATTACHMENTS})`}
                        >
                          <Paperclip className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className="text-[11px] text-white/50"
                          style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.08em' }}
                        >
                          {slots.length > 0
                            ? `${selectedGroup?.name?.toUpperCase()} · ${slots.length} 个模型`
                            : groups.length === 0 ? '未配置阵容' : '请选择阵容'}
                        </span>
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={isStreaming || !prompt.trim() || slots.length === 0}
                          className="group inline-flex items-center gap-1.5 h-9 px-5 rounded-full text-[13px] font-medium text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                          style={{
                            background: HERO_GRADIENT,
                            boxShadow:
                              '0 0 24px rgba(124, 58, 237, 0.32), 0 0 54px rgba(0, 240, 255, 0.18), 0 4px 16px rgba(0, 0, 0, 0.45)',
                            fontFamily: 'var(--font-display)',
                          }}
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>发送</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>

              {/* Hint text — VT323 mono */}
              <Reveal delay={320}>
                <div className="text-center mt-3">
                  <span
                    className="text-[11px] text-white/45"
                    style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.1em' }}
                  >
                    DRAG · PASTE · FILES · ENTER 发送 · SHIFT+ENTER 换行
                  </span>
                </div>
              </Reveal>
            </div>
          </div>
        ) : (
          /* Battle View — horizontal card layout */
          <div className="flex-1 flex flex-col min-h-0">
            {/* Prompt Bar — subtle gradient accent */}
            <div
              className="flex-shrink-0 px-5 py-2.5"
              style={{
                background: 'rgba(10, 14, 22, 0.42)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    background: HERO_GRADIENT,
                    boxShadow: '0 0 12px rgba(124, 58, 237, 0.35)',
                  }}
                >
                  <MessageSquare className="w-3 h-3 text-white" />
                </div>
                <p
                  className="text-[13px] truncate flex-1 text-white/92"
                  title={currentPrompt}
                >
                  {currentPrompt}
                </p>
                <span
                  className="hidden sm:inline-flex items-center px-2 h-5 rounded-full text-[10px] flex-shrink-0 text-white/55"
                  style={{
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    fontFamily: 'var(--font-terminal)',
                    letterSpacing: '0.12em',
                  }}
                  title="盲评模式：每个模型独立作答，不带历史上下文。这样比较的是模型本身的能力，不掺杂记忆/缓存差异。如需多轮追问，请揭晓后到对应 Agent 对话页面继续。"
                >
                  盲评 · 单轮
                </span>
                {allDone && !isStreaming && (
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-1.5 px-3 h-7 rounded-full text-[11px] transition-colors hover:bg-white/8 flex-shrink-0 text-white/65"
                    style={{
                      border: '1px solid rgba(255, 255, 255, 0.16)',
                      fontFamily: 'var(--font-terminal)',
                      letterSpacing: '0.14em',
                    }}
                    title="使用相同问题重新对战（盲评模式：每轮独立，不带历史上下文）"
                  >
                    <RefreshCw className="w-3 h-3" />
                    RETRY
                  </button>
                )}
              </div>
              {/* Attachment thumbnails in prompt bar */}
              {currentAttachments.length > 0 && (
                <div className="flex gap-1.5 mt-2 ml-7">
                  {currentAttachments.map((att) => (
                    <div
                      key={att.attachmentId}
                      className="rounded overflow-hidden flex-shrink-0"
                      style={{
                        width: '40px',
                        height: '40px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                      title={att.fileName}
                    >
                      {IMAGE_TYPES.has(att.mimeType) ? (
                        <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <FileText className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                        </div>
                      )}
                    </div>
                  ))}
                  <span className="self-center text-[11px] ml-1" style={{ color: 'var(--text-muted)' }}>
                    {currentAttachments.length} 个附件
                  </span>
                </div>
              )}
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
                const justCompleted = justCompletedIds.has(panel.slotId);

                return (
                  <div
                    key={panel.slotId}
                    className="flex-shrink-0 flex flex-col overflow-hidden"
                    style={{ width: 'calc(33.333% - 8px)', minWidth: '320px' }}
                  >
                    <div
                      className={cn(
                        'flex flex-col h-full rounded-[14px] overflow-hidden transition-transform duration-500',
                        revealAnimating && 'scale-[0.98]',
                        justCompleted && 'arena-panel-done-pulse'
                      )}
                      style={{
                        background: 'rgba(10, 14, 22, 0.68)',
                        border: `1px solid ${labelColor}33`,
                        backdropFilter: 'blur(12px)',
                        WebkitBackdropFilter: 'blur(12px)',
                        boxShadow: `0 0 24px ${labelColor}1a, 0 10px 32px rgba(0, 0, 0, 0.45), inset 0 0 14px ${labelColor}08`,
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
                              className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] flex-shrink-0"
                              style={{
                                background: `${labelColor}22`,
                                color: labelColor,
                                border: `1px solid ${labelColor}55`,
                                boxShadow: `0 0 10px ${labelColor}44, inset 0 0 6px ${labelColor}1f`,
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                letterSpacing: '-0.02em',
                              }}
                            >
                              {letter}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div
                              className="text-[13px] font-medium truncate text-white"
                              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em' }}
                            >
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
                            <MapSpinner size={14} color={labelColor} />
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
                            {panel.thinking && (
                              <ThinkingBlock thinking={panel.thinking} color={labelColor} />
                            )}
                            <div
                              className="text-[13px] px-3 py-2 rounded-lg break-all"
                              style={{ background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.9)', border: '1px solid rgba(239,68,68,0.15)' }}
                            >
                              {panel.errorMessage ?? '响应异常'}
                            </div>
                          </div>
                        ) : (
                          <div>
                            {/* Thinking block — collapsible */}
                            {panel.thinking && (
                              <ThinkingBlock thinking={panel.thinking} color={labelColor} streaming={panel.status === 'streaming' && !panel.text} />
                            )}
                            {/* Main content */}
                            <div className="arena-markdown text-[14px] leading-[1.75] break-words" style={{ color: 'var(--text-primary)' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{panel.text}</ReactMarkdown>
                              {panel.status === 'streaming' && (
                                <span
                                  className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse"
                                  style={{ background: labelColor, verticalAlign: 'text-bottom' }}
                                />
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Footer — actions + metrics */}
                      {(panel.status === 'done' || panel.status === 'error') && (
                        <div
                          className="px-4 py-2 flex items-center flex-shrink-0"
                        >
                          {/* Metrics (visible after reveal) */}
                          {revealed && (
                            <div className="flex items-center gap-4 flex-1">
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
                          {!revealed && <div className="flex-1" />}
                          {/* Copy & Download buttons — right-aligned */}
                          {panel.text && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleCopyPanel(panel)}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-white/8"
                                style={{ color: 'var(--text-muted)' }}
                                title="复制内容"
                              >
                                {copiedSlotId === panel.slotId
                                  ? <Check className="w-3 h-3" style={{ color: '#10b981' }} />
                                  : <Copy className="w-3 h-3" />}
                                复制
                              </button>
                              <button
                                onClick={() => handleDownloadPanel(panel)}
                                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-white/8"
                                style={{ color: 'var(--text-muted)' }}
                                title="下载 Markdown"
                              >
                                <Download className="w-3 h-3" />
                                下载
                              </button>
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

        {/* ===================== Bottom Bar (only when in battle) ===================== */}
        {hasBattle && (
        <div
          className="flex-shrink-0 px-6 py-3"
          style={{
            background: 'rgba(10, 14, 22, 0.52)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div className="mx-auto" style={{ maxWidth: '900px' }}>
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,text/plain,text/markdown,text/csv,text/html,text/xml,application/pdf,application/json,application/xml,.md,.txt,.csv,.json,.pdf,.xml,.html"
              className="hidden"
              onChange={handleFileInputChange}
            />
            {/* Rotating progress ring wrapper */}
            <div
              className={cn(
                'rounded-[18px] p-[1.5px] transition-all duration-300',
                dragOver && 'ring-2 ring-cyan-400/50'
              )}
              style={{
                background: hasActiveProgress
                  ? completedCount === totalCount && !isStreaming
                    ? 'linear-gradient(135deg, #10b981 0%, #14b8a6 50%, #06b6d4 100%)'
                    : 'linear-gradient(135deg, rgba(0, 240, 255, 0.28) 0%, rgba(124, 58, 237, 0.22) 50%, rgba(244, 63, 94, 0.28) 100%)'
                  : dragOver
                    ? HERO_GRADIENT
                    : 'linear-gradient(135deg, rgba(0, 240, 255, 0.22) 0%, rgba(124, 58, 237, 0.18) 50%, rgba(244, 63, 94, 0.22) 100%)',
                boxShadow:
                  '0 0 26px rgba(124, 58, 237, 0.12), 0 6px 22px rgba(0, 0, 0, 0.45)',
                position: 'relative',
                overflow: 'hidden',
              }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {/* Spinning arc overlay — only visible during streaming */}
              {hasActiveProgress && !(completedCount === totalCount && !isStreaming) && (
                <div
                  style={{
                    position: 'absolute',
                    top: '-50%',
                    right: '-50%',
                    bottom: '-50%',
                    left: '-50%',
                    background: `conic-gradient(from 0deg, transparent 0deg, #00f0ff 40deg, #7c3aed 120deg, #f43f5e 200deg, transparent 240deg)`,
                    animation: 'arena-ring-spin 2.5s linear infinite',
                    borderRadius: 'inherit',
                  }}
                />
              )}
              <div
                className="rounded-[16.5px] p-3"
                style={{
                  background: 'rgba(10, 14, 22, 0.86)',
                  backdropFilter: 'blur(14px)',
                  WebkitBackdropFilter: 'blur(14px)',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {/* Attachment preview strip */}
                {attachments.length > 0 && (
                  <div className="flex gap-2 px-2 pb-2 flex-wrap">
                    {attachments.map((att) => (
                      <div
                        key={att.attachmentId}
                        className="relative group rounded-lg overflow-hidden flex-shrink-0"
                        style={{
                          width: '64px',
                          height: '64px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <img src={att.url} alt={att.fileName} className="w-full h-full object-cover" />
                        <button
                          onClick={() => handleRemoveAttachment(att.attachmentId)}
                          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ background: 'rgba(0,0,0,0.7)' }}
                        >
                          <X className="w-2.5 h-2.5" style={{ color: '#fff' }} />
                        </button>
                        <div
                          className="absolute bottom-0 left-0 right-0 px-1 py-0.5 text-[9px] truncate"
                          style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
                        >
                          {att.fileName}
                        </div>
                      </div>
                    ))}
                    {isUploading && (
                      <div
                        className="flex items-center justify-center rounded-lg flex-shrink-0"
                        style={{
                          width: '64px',
                          height: '64px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px dashed rgba(255,255,255,0.15)',
                        }}
                      >
                        <MapSpinner size={16} color="var(--text-muted)" />
                      </div>
                    )}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder="提出新问题（盲评模式 · 每轮独立、不带历史）"
                  disabled={isStreaming || slots.length === 0}
                  rows={1}
                  className={cn(
                    'w-full bg-transparent border-none outline-none ring-0 focus:ring-0 focus:outline-none resize-none text-[14.5px] leading-relaxed text-white',
                    'placeholder:text-white/30 disabled:opacity-50 disabled:cursor-not-allowed',
                    'px-2 py-1 no-focus-ring'
                  )}
                  style={{ minHeight: '40px', maxHeight: '200px', border: 'none', boxShadow: 'none', fontFamily: 'var(--font-body)' }}
                />
                {/* Toolbar row */}
                <div className="flex items-center justify-between mt-1 px-1">
                  <div className="flex items-center gap-2">
                    {/* Attachment button */}
                    <button
                      onClick={handleAttachmentClick}
                      disabled={isStreaming || slots.length === 0 || attachments.length >= MAX_ATTACHMENTS}
                      className={cn(
                        'flex items-center justify-center w-8 h-8 rounded-lg transition-colors text-white/55',
                        'disabled:opacity-30 disabled:cursor-not-allowed',
                        'hover:bg-white/8 hover:text-white/85'
                      )}
                      title={`添加附件 (${attachments.length}/${MAX_ATTACHMENTS})`}
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    {/* Status info — VT323 mono */}
                    {hasActiveProgress && (
                      <span
                        className="text-[11px] ml-1"
                        style={{
                          fontFamily: 'var(--font-terminal)',
                          letterSpacing: '0.12em',
                          color: completedCount === totalCount ? '#34d399' : 'rgba(255,255,255,0.5)',
                          textShadow: completedCount === totalCount ? '0 0 8px rgba(52, 211, 153, 0.5)' : 'none',
                        }}
                      >
                        {completedCount}/{totalCount}{completedCount === totalCount && !isStreaming ? ' · 完成' : ' · 进行中'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {canReveal && (
                      <button
                        type="button"
                        onClick={handleReveal}
                        disabled={revealLoading}
                        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-[12.5px] font-medium text-white/90 transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background: 'rgba(10, 14, 22, 0.62)',
                          border: '1px solid rgba(255, 255, 255, 0.24)',
                          boxShadow: '0 0 14px rgba(255, 255, 255, 0.06), inset 0 0 8px rgba(255, 255, 255, 0.03)',
                          fontFamily: 'var(--font-display)',
                        }}
                      >
                        {revealLoading ? <MapSpinner size={14} /> : <Eye className="w-3.5 h-3.5" />}
                        <span>揭晓身份</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={isStreaming || !prompt.trim() || slots.length === 0}
                      className="inline-flex items-center justify-center gap-1.5 h-9 min-w-[44px] px-4 rounded-full text-[13px] font-medium text-white transition-all duration-200 hover:scale-[1.02] active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                      style={{
                        background: HERO_GRADIENT,
                        boxShadow:
                          '0 0 22px rgba(124, 58, 237, 0.3), 0 0 48px rgba(0, 240, 255, 0.16), 0 4px 14px rgba(0, 0, 0, 0.45)',
                        fontFamily: 'var(--font-display)',
                      }}
                    >
                      {isStreaming ? (
                        <MapSpinner size={14} />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
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
                {groupSaving ? <MapSpinner size={14} /> : null}
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
        confirmText="确认保存"
        description="管理该分组的参战模型：添加新模型或从池中移除已有模型，确认后生效"
      />

      {/* Scoped keyframes — Arena neon pulse on title */}
      <style>{`
        @keyframes arena-title-pulse {
          0%, 100% {
            text-shadow:
              0 0 28px rgba(203, 213, 225, 0.30),
              0 0 80px rgba(0, 240, 255, 0.20),
              0 0 120px rgba(124, 58, 237, 0.10);
          }
          50% {
            text-shadow:
              0 0 38px rgba(226, 232, 240, 0.44),
              0 0 100px rgba(0, 240, 255, 0.28),
              0 0 150px rgba(124, 58, 237, 0.16);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-arena-pulse] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
