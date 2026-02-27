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
  saveArenaBattle,
  listArenaBattles,
  getArenaBattle,
} from '@/services';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { Eye, Send, Plus, Search, MessageSquare, Clock, Loader2, Swords, ChevronDown } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArenaSlot {
  id: string;
  platformId: string;
  modelId: string;
}

interface ArenaGroup {
  key: string;
  name: string;
  slots: ArenaSlot[];
}

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
// SSE event routing context
// ---------------------------------------------------------------------------

interface SSEContext {
  /** modelId → slotId (built from request slots, for matching) */
  modelToSlotId: Map<string, string>;
  /** Backend itemId → slotId (built dynamically from modelStart events) */
  itemIdToSlotMap: Map<string, string>;
  /** Tracks which slots have been assigned to prevent duplicate-model confusion */
  assignedSlots: Set<string>;
  /** Original slots array for sequential fallback */
  slots: ArenaSlot[];
  /** Sequential counter for fallback assignment when modelId matching fails */
  nextUnassignedIdx: number;
}

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

  // --- History state ---
  const [history, setHistory] = useState<BattleHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [activeBattleId, setActiveBattleId] = useState<string | null>(null);

  // --- Sidebar ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // --- Refs ---
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelsRef = useRef<ArenaPanel[]>([]);
  const groupDropdownRef = useRef<HTMLDivElement>(null);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
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
    setPrompt('');
    textareaRef.current?.focus();
  }

  // --- SSE event handler ---
  function handleSSEEvent(sseEvent: string | undefined, data: any, ctx: SSEContext) {
    const type = data?.type as string;
    const itemId = data?.itemId as string | undefined;

    // Run-level events (event: run)
    if (sseEvent === 'run') {
      if (type === 'runDone') {
        const final = panelsRef.current;
        const done = final.length > 0 && final.every((p) => p.status === 'done' || p.status === 'error');
        setAllDone(done);
      }
      if (type === 'error') {
        toast.error('运行失败', data.errorMessage ?? '');
      }
      return;
    }

    // Model-level events — resolve slotId from itemId
    if (type === 'modelStart' && itemId) {
      // Strategy 1: Match by modelId
      const eventModelId = data.modelId as string | undefined;
      let matched = false;
      if (eventModelId) {
        for (const s of ctx.slots) {
          if (s.modelId === eventModelId && !ctx.assignedSlots.has(s.id)) {
            ctx.itemIdToSlotMap.set(itemId, s.id);
            ctx.assignedSlots.add(s.id);
            matched = true;
            break;
          }
        }
      }
      // Strategy 2: Sequential fallback — assign to next unassigned slot
      if (!matched) {
        while (ctx.nextUnassignedIdx < ctx.slots.length) {
          const s = ctx.slots[ctx.nextUnassignedIdx];
          ctx.nextUnassignedIdx++;
          if (!ctx.assignedSlots.has(s.id)) {
            ctx.itemIdToSlotMap.set(itemId, s.id);
            ctx.assignedSlots.add(s.id);
            break;
          }
        }
      }
    }

    // Resolve slotId
    let slotId: string | undefined;
    if (itemId) {
      slotId = ctx.itemIdToSlotMap.get(itemId);
    }
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

  // --- Send question ---
  const handleSend = useCallback(async () => {
    const question = prompt.trim();
    if (!question || isStreaming) return;
    if (slots.length === 0) {
      toast.warning('暂无可用模型', '请先在管理页配置竞技场阵容');
      return;
    }

    // Assign random labels
    const newLabelMap = assignLabels(slots);

    // Initialize panels
    const initialPanels: ArenaPanel[] = slots.map((slot) => {
      const info = newLabelMap.get(slot.id) ?? { label: '助手 ?', index: 0 };
      return {
        slotId: slot.id,
        label: info.label,
        labelIndex: info.index,
        status: 'waiting',
        text: '',
        ttftMs: null,
        totalMs: null,
        errorMessage: null,
        startedAt: null,
      };
    });
    setPanels(initialPanels);
    panelsRef.current = initialPanels;
    setCurrentPrompt(question);
    setIsStreaming(true);
    setAllDone(false);
    setRevealed(false);
    setRevealedInfos(new Map());
    setActiveBattleId(null);
    setPrompt('');

    // SSE routing context
    const modelToSlotId = new Map<string, string>();
    slots.forEach((s) => modelToSlotId.set(s.modelId, s.id));

    const sseCtx: SSEContext = {
      modelToSlotId,
      itemIdToSlotMap: new Map(),
      assignedSlots: new Set(),
      slots,
      nextUnassignedIdx: 0,
    };

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const token = useAuthStore.getState().token;
      const sseUrl = api.lab.model.runsStream();
      const fullUrl = joinUrl(getApiBaseUrl(), sseUrl);

      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          promptText: question,
          models: slots.map((s) => ({
            platformId: s.platformId,
            modelId: s.modelId,
            modelName: s.modelId,
          })),
          params: { maxConcurrency: 20, repeatN: 1 },
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `HTTP ${response.status} ${response.statusText}`);
      }

      // Use the proven readSseStream utility (handles CRLF, keepalive comments, etc.)
      await readSseStream(
        response,
        (evt) => {
          if (!evt.data) return;
          if (evt.data === '[DONE]') return;
          let data: any;
          try {
            data = JSON.parse(evt.data);
          } catch {
            return;
          }
          handleSSEEvent(evt.event, data, sseCtx);
        },
        abortController.signal
      );
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      toast.error('流式请求失败', e?.message ?? '网络错误');
      setPanels((prev) =>
        prev.map((p) =>
          p.status === 'waiting' || p.status === 'streaming'
            ? { ...p, status: 'error', errorMessage: e?.message ?? '连接中断' }
            : p
        )
      );
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      const finalPanels = panelsRef.current;
      const done = finalPanels.length > 0 && finalPanels.every((p) => p.status === 'done' || p.status === 'error');
      setAllDone(done);

      if (finalPanels.length > 0) {
        try {
          const saveRes = await saveArenaBattle({
            prompt: question,
            groupKey: selectedGroupKey,
            responses: finalPanels.map((p) => ({
              slotId: p.slotId,
              label: p.label,
              content: p.text,
              ttftMs: p.ttftMs,
              totalMs: p.totalMs,
              status: p.status === 'error' ? 'error' : 'done',
              errorMessage: p.errorMessage,
            })),
            revealed: false,
          });
          if (saveRes.success && saveRes.data?.id) {
            setActiveBattleId(saveRes.data.id);
          }
        } catch {
          // silent
        }
        loadHistory();
      }
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
  const canReveal = allDone && !revealed && panels.length > 0 && panels.some((p) => p.status === 'done');

  // --- Sort panels: active/done first (by startedAt), waiting last ---
  const sortedPanels = useMemo(() => {
    return [...panels].sort((a, b) => {
      // Waiting panels go to the end
      const aActive = a.status !== 'waiting';
      const bActive = b.status !== 'waiting';
      if (aActive !== bActive) return aActive ? -1 : 1;
      // Among active panels, sort by startedAt (earliest first)
      if (aActive && bActive) {
        const aT = a.startedAt ?? Infinity;
        const bT = b.startedAt ?? Infinity;
        if (aT !== bT) return aT - bT;
      }
      return 0;
    });
  }, [panels]);

  // --- Progress calculation ---
  const completedCount = panels.filter((p) => p.status === 'done' || p.status === 'error').length;
  const totalCount = panels.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div className="flex h-full" style={{ minHeight: 0 }}>
      {/* ===================== Sidebar ===================== */}
      <div
        className={cn(
          'flex flex-col border-r transition-all duration-300',
          sidebarCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-[280px] min-w-[280px]'
        )}
        style={{
          borderColor: 'var(--glass-border, rgba(255,255,255,0.07))',
          background: 'var(--bg-base, #0d0d0f)',
        }}
      >
        {/* New Battle Button */}
        <div className="p-3 flex-shrink-0">
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
          className="flex items-center justify-between px-5 h-14 flex-shrink-0 border-b"
          style={{
            borderColor: 'var(--glass-border, rgba(255,255,255,0.07))',
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
            <div className="flex items-center gap-2">
              <Swords className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
              <h1 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 竞技场</h1>
            </div>
          </div>

          {/* Group Selector */}
          <div className="relative" ref={groupDropdownRef}>
            <button
              onClick={() => setGroupDropdownOpen(!groupDropdownOpen)}
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
            {groupDropdownOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-[12px] py-1 min-w-[180px]"
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
                        '请先在管理页配置竞技场分组和模型'
                      )}
                    </div>
                  </div>
                ) : (
                  groups.map((g) => (
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
                  ))
                )}
              </div>
            )}
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
              className="flex-shrink-0 flex items-center gap-2 px-5 py-2.5 border-b"
              style={{ borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(99,102,241,0.04)' }}
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
                        border: '1px solid rgba(255,255,255,0.07)',
                      }}
                    >
                      {/* Header */}
                      <div
                        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
                        style={{ borderColor: 'rgba(255,255,255,0.05)' }}
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
                          className="px-4 py-2 flex items-center gap-4 border-t flex-shrink-0"
                          style={{ borderColor: 'rgba(255,255,255,0.05)' }}
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

        {/* ===================== Progress Bar ===================== */}
        {hasBattle && totalCount > 0 && (isStreaming || completedCount > 0) && (
          <div className="flex-shrink-0 px-6 pt-3">
            <div className="mx-auto" style={{ maxWidth: '900px' }}>
              <div className="flex items-center gap-3">
                <div
                  className="flex-1 h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${progressPct}%`,
                      background: completedCount === totalCount
                        ? '#10b981'
                        : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                    }}
                  />
                </div>
                <span
                  className="text-[11px] font-mono flex-shrink-0"
                  style={{ color: completedCount === totalCount ? '#10b981' : 'var(--text-muted)' }}
                >
                  {completedCount}/{totalCount}{completedCount === totalCount && !isStreaming ? ' 完成' : ''}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ===================== Bottom Bar ===================== */}
        <div
          className="flex-shrink-0 px-6 py-4 border-t"
          style={{
            borderColor: 'var(--glass-border, rgba(255,255,255,0.07))',
            background: 'var(--bg-base, #0d0d0f)',
          }}
        >
          <div className="mx-auto" style={{ maxWidth: '900px' }}>
            <div
              className="rounded-[16px] p-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
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
                  'w-full bg-transparent border-none outline-none resize-none text-[14px] leading-relaxed',
                  'placeholder:text-[color:var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed',
                  'px-2 py-1'
                )}
                style={{ color: 'var(--text-primary)', minHeight: '56px', maxHeight: '200px' }}
              />
              <div className="flex items-center justify-between mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <span className="text-[11px] px-2" style={{ color: 'var(--text-muted)' }}>
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
  );
}
