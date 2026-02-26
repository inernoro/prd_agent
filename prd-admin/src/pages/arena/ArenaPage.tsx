import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
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
  status: 'waiting' | 'streaming' | 'done' | 'error';
  text: string;
  ttftMs: number | null;
  totalMs: number | null;
  errorMessage: string | null;
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
// Helpers
// ---------------------------------------------------------------------------

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

const LABEL_COLORS: Record<string, string> = {
  A: '#6366f1',
  B: '#f59e0b',
  C: '#10b981',
  D: '#ef4444',
  E: '#8b5cf6',
  F: '#ec4899',
  G: '#14b8a6',
  H: '#f97316',
  I: '#06b6d4',
  J: '#84cc16',
  K: '#a855f7',
  L: '#e11d48',
};

function assignLabels(slots: ArenaSlot[]): Map<string, string> {
  const shuffled = [...slots];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const map = new Map<string, string>();
  shuffled.forEach((slot, idx) => {
    map.set(slot.id, `助手 ${LABELS[idx]}`);
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
  // Remove empty groups
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
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);

  // --- Battle state ---
  const [prompt, setPrompt] = useState('');
  const [panels, setPanels] = useState<ArenaPanel[]>([]);
  const [labelMap, setLabelMap] = useState<Map<string, string>>(new Map());
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
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelsRef = useRef<ArenaPanel[]>([]);
  const groupDropdownRef = useRef<HTMLDivElement>(null);

  // Keep panelsRef in sync
  useEffect(() => {
    panelsRef.current = panels;
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
    try {
      const res = await getArenaLineup();
      if (res.success && res.data?.items) {
        const items = res.data.items as ArenaGroup[];
        setGroups(items);
        if (items.length > 0 && !selectedGroupKey) {
          setSelectedGroupKey(items[0].key);
        }
      } else {
        toast.error('加载阵容失败', res.error?.message);
      }
    } catch (e) {
      toast.error('加载阵容失败', e instanceof Error ? e.message : '网络错误');
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
    setLabelMap(new Map());
    setIsStreaming(false);
    setAllDone(false);
    setRevealed(false);
    setRevealedInfos(new Map());
    setCurrentPrompt('');
    setActiveBattleId(null);
    setPrompt('');
    textareaRef.current?.focus();
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
    setLabelMap(newLabelMap);

    // Initialize panels
    const initialPanels: ArenaPanel[] = slots.map((slot) => ({
      slotId: slot.id,
      label: newLabelMap.get(slot.id) ?? '助手 ?',
      status: 'waiting',
      text: '',
      ttftMs: null,
      totalMs: null,
      errorMessage: null,
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

    // Build slot-index map: itemId "item-0" -> slots[0] -> slotId
    const slotIndexMap = new Map<number, string>();
    slots.forEach((s, i) => slotIndexMap.set(i, s.id));

    // Also map by modelId for fallback matching
    const modelToSlotId = new Map<string, string>();
    slots.forEach((s) => modelToSlotId.set(s.modelId, s.id));

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const token = useAuthStore.getState().token;
      const sseUrl = api.lab.model.runsStream();

      // Resolve full URL the same way apiClient does
      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';
      const fullUrl = baseUrl ? `${baseUrl}/${sseUrl.replace(/^\/+/, '')}` : sseUrl;

      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Client': 'admin',
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
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Parse SSE format: event: <type>\ndata: <json>\n\n
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double newline (SSE message boundary)
        while (true) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // Parse event: and data: lines
          const messageLines = raw.split('\n').map((l) => l.trimEnd());
          let sseEvent: string | undefined;
          const dataLines: string[] = [];
          for (const mLine of messageLines) {
            if (mLine.startsWith('event:')) sseEvent = mLine.slice('event:'.length).trim();
            if (mLine.startsWith('data:')) dataLines.push(mLine.slice('data:'.length).trim());
          }

          if (dataLines.length === 0) continue;
          const dataStr = dataLines.join('\n');
          if (!dataStr || dataStr === '[DONE]') continue;

          let data: any;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }

          handleSSEEvent(sseEvent, data, slotIndexMap, modelToSlotId);
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      toast.error('流式请求失败', e?.message ?? '网络错误');
      // Mark remaining waiting panels as error
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
      // Check if all done
      const finalPanels = panelsRef.current;
      const done = finalPanels.length > 0 && finalPanels.every((p) => p.status === 'done' || p.status === 'error');
      setAllDone(done);

      // Auto-save battle
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
          // silent save failure
        }
        loadHistory();
      }
    }
  }, [prompt, isStreaming, slots, selectedGroupKey]);

  function handleSSEEvent(
    sseEvent: string | undefined,
    data: any,
    slotIndexMap: Map<number, string>,
    modelToSlotId: Map<string, string>
  ) {
    const type = data.type as string;
    const itemId = data.itemId as string | undefined;

    // Resolve slotId from itemId (e.g. "item-0" -> index 0 -> slotId)
    let slotId: string | undefined;
    if (itemId) {
      const match = itemId.match(/(\d+)$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        slotId = slotIndexMap.get(idx);
      }
    }
    // Fallback: use modelId
    if (!slotId && data.modelId) {
      slotId = modelToSlotId.get(data.modelId);
    }

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

    // Model-level events (event: model)
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
        updatePanel((p) => ({ ...p, status: 'streaming' }));
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

        const loadedPanels: ArenaPanel[] = (battle.responses || []).map((r) => ({
          slotId: r.slotId,
          label: r.label,
          status: r.status === 'error' ? 'error' : 'done',
          text: r.content || '',
          ttftMs: r.ttftMs,
          totalMs: r.totalMs,
          errorMessage: r.errorMessage,
        }));
        setPanels(loadedPanels);
        panelsRef.current = loadedPanels;

        const newLabelMap = new Map<string, string>();
        loadedPanels.forEach((p) => newLabelMap.set(p.slotId, p.label));
        setLabelMap(newLabelMap);
      } else {
        toast.error('加载对战记录失败', res.error?.message);
      }
    } catch (e) {
      toast.error('加载对战记录失败', e instanceof Error ? e.message : '网络错误');
    }
  }

  // --- Textarea auto-resize and keyboard shortcut ---
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setPrompt(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  // Scroll chat area to bottom when panels update
  useEffect(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }
  }, [panels, revealed]);

  // --- Filter history ---
  const filteredHistory = historySearch
    ? history.filter((h) => h.prompt.toLowerCase().includes(historySearch.toLowerCase()))
    : history;
  const groupedHistory = groupByDate(filteredHistory);

  // --- Determine page state ---
  const hasBattle = panels.length > 0 || currentPrompt;
  const canReveal = allDone && !revealed && panels.length > 0 && panels.some((p) => p.status === 'done');

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
          <Button
            variant="primary"
            size="md"
            className="w-full"
            onClick={handleNewBattle}
          >
            <Plus className="w-4 h-4" />
            新建对战
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 flex-shrink-0">
          <div
            className="flex items-center gap-2 h-9 px-3 rounded-[10px]"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
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
            <div
              className="text-center py-8 text-[13px]"
              style={{ color: 'var(--text-muted)' }}
            >
              暂无对战记录
            </div>
          ) : (
            Array.from(groupedHistory.entries()).map(([dateLabel, items]) => (
              <div key={dateLabel} className="mb-3">
                <div
                  className="text-[11px] font-medium px-2 py-1.5 uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}
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
                      activeBattleId === item.id
                        ? 'bg-white/10'
                        : 'hover:bg-white/5'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <MessageSquare
                        className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                        style={{ color: 'var(--text-muted)' }}
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[13px] leading-snug truncate"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {truncate(item.prompt, 30)}
                        </div>
                        <div
                          className="text-[11px] mt-0.5 flex items-center gap-1"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <span>{item.responseCount} 个模型</span>
                          {item.revealed && (
                            <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: 'rgba(99,102,241,0.15)', color: 'rgba(99,102,241,0.9)' }}>
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
            {/* Mobile sidebar toggle */}
            <button
              className="lg:hidden p-1.5 rounded-lg hover:bg-white/5"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Swords className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
            </button>
            <div className="flex items-center gap-2">
              <Swords className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
              <h1 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                AI 竞技场
              </h1>
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
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary)',
              }}
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
            {groupDropdownOpen && groups.length > 0 && (
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-[12px] py-1 min-w-[180px]"
                style={{
                  background: 'var(--bg-elevated, #1a1a1e)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}
              >
                {groups.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => {
                      setSelectedGroupKey(g.key);
                      setGroupDropdownOpen(false);
                    }}
                    className={cn(
                      'w-full text-left px-3 py-2 text-[13px] transition-colors',
                      'hover:bg-white/5',
                      g.key === selectedGroupKey && 'bg-white/8'
                    )}
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <div>{g.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {g.slots.length} 个模型
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Chat Area */}
        <div
          ref={chatAreaRef}
          className="flex-1 overflow-y-auto px-4 py-6"
          style={{ minHeight: 0 }}
        >
          {!hasBattle ? (
            /* Empty State */
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(99,102,241,0.1)' }}
              >
                <Swords className="w-8 h-8" style={{ color: 'rgba(99,102,241,0.7)' }} />
              </div>
              <div className="text-center">
                <h2 className="text-[18px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  AI 盲评竞技场
                </h2>
                <p className="text-[14px] max-w-md" style={{ color: 'var(--text-muted)' }}>
                  提出问题，多个模型匿名作答。阅读回答后揭晓真实身份，公平评估模型能力。
                </p>
              </div>
              {slots.length > 0 && (
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  当前阵容: {selectedGroup?.name} ({slots.length} 个模型)
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-5xl mx-auto space-y-6">
              {/* User Question Bubble */}
              <div className="flex justify-end">
                <GlassCard
                  variant="subtle"
                  padding="md"
                  className="max-w-[70%]"
                  style={{
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(99,102,241,0.08) 100%)',
                    border: '1px solid rgba(99,102,241,0.2)',
                  }}
                >
                  <p
                    className="text-[14px] leading-relaxed whitespace-pre-wrap"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {currentPrompt}
                  </p>
                </GlassCard>
              </div>

              {/* Response Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {panels.map((panel) => {
                  const info = revealedInfos.get(panel.slotId);
                  const letterMatch = panel.label.match(/[A-L]$/);
                  const letter = letterMatch ? letterMatch[0] : 'A';
                  const labelColor = info?.avatarColor ?? LABEL_COLORS[letter] ?? '#6366f1';

                  return (
                    <GlassCard
                      key={panel.slotId}
                      padding="none"
                      className={cn(
                        'transition-transform duration-500',
                        revealAnimating && 'scale-[0.98]'
                      )}
                    >
                      {/* Panel Header */}
                      <div
                        className={cn(
                          'flex items-center justify-between px-4 py-3 border-b transition-all duration-500',
                          revealed && 'py-3'
                        )}
                        style={{
                          borderColor: 'rgba(255,255,255,0.05)',
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold"
                            style={{
                              background: `${labelColor}20`,
                              color: labelColor,
                              border: `1px solid ${labelColor}40`,
                            }}
                          >
                            {letter}
                          </div>
                          <div>
                            <div
                              className="text-[13px] font-semibold"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              {revealed && info ? info.displayName : panel.label}
                            </div>
                            {revealed && info && (
                              <div
                                className="text-[11px]"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {info.platformName}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {panel.status === 'streaming' && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: labelColor }} />
                          )}
                          {panel.status === 'done' && (
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{ background: '#10b981' }}
                            />
                          )}
                          {panel.status === 'error' && (
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{ background: '#ef4444' }}
                            />
                          )}
                        </div>
                      </div>

                      {/* Panel Body */}
                      <div className="px-4 py-3 min-h-[120px]">
                        {panel.status === 'waiting' ? (
                          <div className="flex items-center gap-2 h-full py-8 justify-center">
                            <div className="flex gap-1">
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '0ms' }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '150ms' }} />
                              <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '300ms' }} />
                            </div>
                            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              等待响应...
                            </span>
                          </div>
                        ) : panel.status === 'error' ? (
                          <div className="flex items-center gap-2 py-4">
                            <div
                              className="text-[13px] px-3 py-2 rounded-lg"
                              style={{
                                background: 'rgba(239,68,68,0.08)',
                                color: 'rgba(239,68,68,0.9)',
                                border: '1px solid rgba(239,68,68,0.15)',
                              }}
                            >
                              {panel.errorMessage ?? '响应异常'}
                            </div>
                          </div>
                        ) : (
                          <div
                            className="text-[13px] leading-relaxed whitespace-pre-wrap break-words"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {panel.text}
                            {panel.status === 'streaming' && (
                              <span
                                className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse"
                                style={{ background: labelColor, verticalAlign: 'text-bottom' }}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Panel Footer - metrics */}
                      {(panel.status === 'done' || panel.status === 'error') && revealed && (
                        <div
                          className="px-4 py-2 flex items-center gap-4 border-t"
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
                    </GlassCard>
                  );
                })}
              </div>

              {/* Reveal Button */}
              {panels.length > 0 && !revealed && (
                <div className="flex justify-center pt-4 pb-2">
                  <Button
                    variant={canReveal ? 'primary' : 'secondary'}
                    size="md"
                    onClick={handleReveal}
                    disabled={!canReveal || revealLoading}
                    className="px-8"
                  >
                    {revealLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                    揭晓模型身份
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Input Bar */}
        <div
          className="flex-shrink-0 px-4 py-3 border-t"
          style={{
            borderColor: 'var(--glass-border, rgba(255,255,255,0.07))',
            background: 'var(--bg-base, #0d0d0f)',
          }}
        >
          <div className="max-w-5xl mx-auto">
            <div
              className="flex items-end gap-2 rounded-[14px] p-2"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={handleTextareaInput}
                onKeyDown={handleKeyDown}
                placeholder={
                  slots.length === 0
                    ? '请先选择一个有模型的阵容...'
                    : '输入你的问题，让多个模型匿名回答...'
                }
                disabled={isStreaming || slots.length === 0}
                rows={1}
                className={cn(
                  'flex-1 bg-transparent border-none outline-none resize-none text-[14px] leading-relaxed',
                  'placeholder:text-[color:var(--text-muted)] disabled:opacity-50 disabled:cursor-not-allowed',
                  'px-2 py-1.5'
                )}
                style={{
                  color: 'var(--text-primary)',
                  maxHeight: '160px',
                }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSend}
                disabled={isStreaming || !prompt.trim() || slots.length === 0}
                className="flex-shrink-0 mb-0.5"
              >
                {isStreaming ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
            <div className="flex items-center justify-between mt-1.5 px-1">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Enter 发送, Shift+Enter 换行
              </span>
              {slots.length > 0 && (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedGroup?.name} - {slots.length} 个模型将匿名回答
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
