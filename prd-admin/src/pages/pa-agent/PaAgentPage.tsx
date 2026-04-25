import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageSquare, LayoutGrid, Plus, Trash2, Edit2, Check, X,
  Zap, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  getPaSessions, createPaSession, deletePaSession, renamePaSession,
} from '@/services/real/paAgentService';
import type { PaSessionInfo, PaTask } from '@/services/real/paAgentService';
import { PaAssistantChat } from './PaAssistantChat';
import { PaTaskBoard } from './PaTaskBoard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

type Tab = 'chat' | 'board';

// ── SessionItem ───────────────────────────────────────────────────────────

interface SessionItemProps {
  session: PaSessionInfo;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

function SessionItem({ session, active, onSelect, onDelete, onRename }: SessionItemProps) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(session.title);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 50);
  };

  const confirmEdit = () => {
    if (editTitle.trim() && editTitle.trim() !== session.title) {
      onRename(editTitle.trim());
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') confirmEdit();
    if (e.key === 'Escape') setEditing(false);
  };

  return (
    <div
      className="group relative flex items-start gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all"
      style={{
        background: active ? 'rgba(99,102,241,0.12)' : 'transparent',
        border: active ? '1px solid rgba(99,102,241,0.25)' : '1px solid transparent',
      }}
      onClick={onSelect}
      onMouseEnter={e => {
        if (!active) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={e => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div
        className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center mt-0.5"
        style={{ background: active ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'var(--bg-elevated)' }}
      >
        <MessageSquare size={11} color={active ? '#fff' : 'var(--text-muted)'} />
      </div>

      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input
              ref={inputRef}
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={confirmEdit}
              className="flex-1 text-xs bg-transparent outline-none border-b"
              style={{ color: 'var(--text-primary)', borderColor: '#6366f1' }}
            />
            <button onClick={confirmEdit} className="p-0.5 text-green-500"><Check size={11} /></button>
            <button onClick={() => setEditing(false)} className="p-0.5" style={{ color: 'var(--text-muted)' }}><X size={11} /></button>
          </div>
        ) : (
          <>
            <div
              className="text-xs font-medium truncate"
              style={{ color: active ? '#a5b4fc' : 'var(--text-secondary)' }}
            >
              {session.title || '新对话'}
            </div>
            {session.lastMessagePreview && (
              <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {session.lastMessagePreview}
              </div>
            )}
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              {dayjs(session.updatedAt).fromNow()}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      {!editing && (
        <div
          className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={startEdit}
            className="p-1 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="重命名"
          >
            <Edit2 size={11} />
          </button>
          <button
            onClick={() => onDelete()}
            className="p-1 rounded-lg hover:bg-red-500/10 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="删除"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── PaAgentPage ───────────────────────────────────────────────────────────

export function PaAgentPage() {
  const [tab, setTab] = useState<Tab>('chat');
  const [sessions, setSessions] = useState<PaSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    const res = await getPaSessions();
    if (res.success && Array.isArray(res.data)) {
      setSessions(res.data);
      // Auto-select most recent or first
      if (!activeSessionId && res.data.length > 0) {
        setActiveSessionId(res.data[0].id);
      }
    }
    setLoading(false);
  }, [activeSessionId]);

  useEffect(() => {
    void loadSessions();
  }, []);

  const handleNewSession = useCallback(async () => {
    const res = await createPaSession();
    if (res.success && res.data) {
      setSessions(prev => [res.data!, ...prev]);
      setActiveSessionId(res.data.id);
      setTab('chat');
    }
  }, []);

  const handleDeleteSession = useCallback(async (id: string) => {
    const res = await deletePaSession(id);
    if (res.success) {
      setSessions(prev => {
        const next = prev.filter(s => s.id !== id);
        if (activeSessionId === id) {
          setActiveSessionId(next[0]?.id ?? null);
        }
        return next;
      });
    }
  }, [activeSessionId]);

  const handleRenameSession = useCallback(async (id: string, title: string) => {
    const res = await renamePaSession(id, title);
    if (res.success && res.data) {
      setSessions(prev => prev.map(s => s.id === id ? res.data! : s));
    }
  }, []);

  const handleTaskSaved = useCallback((_task: PaTask) => {
    setBoardRefreshKey(k => k + 1);
  }, []);

  const handleSessionUpdated = useCallback((id: string, updates: Partial<PaSessionInfo>) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
  }, []);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'chat', label: '对话助理', icon: <MessageSquare size={14} /> },
    { key: 'board', label: '任务看板', icon: <LayoutGrid size={14} /> },
  ];

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div className="h-full flex" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {/* ── Sidebar ── */}
      <div
        className="flex flex-col shrink-0 transition-all duration-200 overflow-hidden"
        style={{
          width: sidebarOpen ? 220 : 0,
          borderRight: sidebarOpen ? '1px solid var(--border-default)' : 'none',
        }}
      >
        {/* Sidebar header */}
        <div
          className="shrink-0 flex items-center justify-between px-3 py-2.5"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-lg flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
            >
              <Zap size={12} color="#fff" />
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              私人助理
            </span>
          </div>
          <button
            onClick={() => void handleNewSession()}
            className="p-1.5 rounded-lg transition-all hover:scale-105"
            style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff' }}
            title="新建对话"
          >
            <Plus size={13} />
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-auto p-2 space-y-0.5">
          {loading ? (
            <div className="text-xs text-center pt-4" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-xs text-center pt-6" style={{ color: 'var(--text-muted)' }}>
              点击 + 开始新对话
            </div>
          ) : (
            sessions.map(s => (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onSelect={() => { setActiveSessionId(s.id); setTab('chat'); }}
                onDelete={() => void handleDeleteSession(s.id)}
                onRename={title => void handleRenameSession(s.id, title)}
              />
            ))
          )}
        </div>

        {/* Task board link at bottom */}
        <div
          className="shrink-0 p-2"
          style={{ borderTop: '1px solid var(--border-default)' }}
        >
          <button
            onClick={() => setTab('board')}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs transition-all"
            style={{
              background: tab === 'board' ? 'rgba(99,102,241,0.12)' : 'transparent',
              color: tab === 'board' ? '#a5b4fc' : 'var(--text-muted)',
              border: tab === 'board' ? '1px solid rgba(99,102,241,0.25)' : '1px solid transparent',
            }}
            onMouseEnter={e => { if (tab !== 'board') e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={e => { if (tab !== 'board') e.currentTarget.style.background = 'transparent'; }}
          >
            <LayoutGrid size={13} />
            任务看板
          </button>
        </div>
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            {sidebarOpen ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
          </button>

          <div className="flex-1 min-w-0">
            {tab === 'chat' && activeSession ? (
              <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {activeSession.title || '新对话'}
              </span>
            ) : (
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {tab === 'board' ? '任务看板' : '私人助理'}
              </span>
            )}
          </div>

          {/* Tab switcher - compact */}
          <div
            className="flex items-center rounded-xl p-0.5"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
          >
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-[10px] transition-all whitespace-nowrap font-medium"
                style={
                  tab === t.key
                    ? { background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff' }
                    : { color: 'var(--text-muted)' }
                }
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* New chat button (visible when sidebar collapsed) */}
          {!sidebarOpen && (
            <button
              onClick={() => void handleNewSession()}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl transition-all whitespace-nowrap"
              style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff' }}
            >
              <Plus size={13} />
              新对话
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {tab === 'chat' ? (
            activeSessionId ? (
              <PaAssistantChat
                key={activeSessionId}
                sessionId={activeSessionId}
                onTaskSaved={handleTaskSaved}
                onSessionUpdated={(updates) => handleSessionUpdated(activeSessionId, updates)}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <div className="text-4xl opacity-20">💬</div>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  点击左上角 <strong>+</strong> 开始新对话
                </p>
                <button
                  onClick={() => void handleNewSession()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium"
                  style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff' }}
                >
                  <Plus size={15} />
                  新建对话
                </button>
              </div>
            )
          ) : (
            <PaTaskBoard key={boardRefreshKey} />
          )}
        </div>
      </div>
    </div>
  );
}
