import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageSquare, LayoutGrid, Plus, Trash2, Edit2, Check, X,
  ChevronLeft, ChevronRight, Brain, BookOpen, Moon,
} from 'lucide-react';
import {
  getPaSessions, createPaSession, deletePaSession, renamePaSession,
} from '@/services/real/paAgentService';
import type { PaSessionInfo, PaTask } from '@/services/real/paAgentService';
import { PaAssistantChat } from './PaAssistantChat';
import { PaTaskBoard } from './PaTaskBoard';
import { PaProfilePanel } from './PaProfilePanel';
import { PaReviewDrawer } from './PaReviewDrawer';
import { PaSecretaryIcon } from '@/pages/ai-toolbox/components/PaSecretaryIcon';
import './paAgent.css';

/** sessionStorage key — 主题偏好（dark / parchment） */
const PA_THEME_KEY = 'pa-agent.theme';
/** sessionStorage key — 字号档位（small / medium / large） */
const PA_FONTSIZE_KEY = 'pa-agent.fontsize';

type PaTheme = 'dark' | 'parchment';
type PaFontSize = 'small' | 'medium' | 'large';

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = sessionStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch { /* sessionStorage 不可用时静默 */ }
  return fallback;
}

function writePref(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch { /* 隐私模式下静默 */ }
}
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
      className="pa-session-item group relative flex items-start gap-2 px-2.5 py-2 rounded-xl cursor-pointer transition-all"
      data-active={active ? 'true' : 'false'}
      onClick={onSelect}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        e.currentTarget.style.setProperty('--pa-hover-x', `${x}px`);
        e.currentTarget.style.setProperty('--pa-hover-y', `${y}px`);
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
              className="pa-fs-xs font-medium truncate"
              style={{ color: active ? '#67e8f9' : 'var(--text-secondary)' }}
            >
              {session.title || '新对话'}
            </div>
            {session.lastMessagePreview && (
              <div className="pa-fs-tiny truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {session.lastMessagePreview}
              </div>
            )}
            <div className="pa-fs-tiny mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
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

// ── SessionSkeleton（骨架屏 — Linear/GitHub 风，比"加载中..."更现代） ────

function SessionSkeleton() {
  return (
    <div className="space-y-1.5 px-1 pt-2">
      {[0, 1, 2].map(i => (
        <div
          key={i}
          className="rounded-xl px-2.5 py-2 flex items-start gap-2"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <div className="shrink-0 w-6 h-6 rounded-lg pa-skeleton-shimmer" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="h-2.5 rounded pa-skeleton-shimmer" style={{ width: `${60 + i * 10}%` }} />
            <div className="h-2 rounded pa-skeleton-shimmer" style={{ width: `${40 + i * 8}%`, opacity: 0.6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── GroupedSessions — 按时间分组 + 复盘单独成组（Notion/Linear 风） ────────

interface GroupedSessionsProps {
  sessions: PaSessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
}

function GroupedSessions({ sessions, activeSessionId, onSelect, onDelete, onRename }: GroupedSessionsProps) {
  // 排序后再分组，保证组内仍按 UpdatedAt 倒序
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const now = dayjs();
  const startOfToday = now.startOf('day');
  const startOfYesterday = startOfToday.subtract(1, 'day');
  const startOfWeek = now.startOf('week');

  const reviewGroup: PaSessionInfo[] = [];
  const todayGroup: PaSessionInfo[] = [];
  const yesterdayGroup: PaSessionInfo[] = [];
  const thisWeekGroup: PaSessionInfo[] = [];
  const earlierGroup: PaSessionInfo[] = [];

  for (const s of sorted) {
    if (s.type === 'review') {
      reviewGroup.push(s);
      continue;
    }
    const u = dayjs(s.updatedAt);
    if (u.isAfter(startOfToday) || u.isSame(startOfToday)) todayGroup.push(s);
    else if (u.isAfter(startOfYesterday) || u.isSame(startOfYesterday)) yesterdayGroup.push(s);
    else if (u.isAfter(startOfWeek) || u.isSame(startOfWeek)) thisWeekGroup.push(s);
    else earlierGroup.push(s);
  }

  const groups: { key: string; label: string; items: PaSessionInfo[] }[] = [
    { key: 'review', label: '我的复盘', items: reviewGroup },
    { key: 'today', label: '今天', items: todayGroup },
    { key: 'yesterday', label: '昨天', items: yesterdayGroup },
    { key: 'week', label: '本周', items: thisWeekGroup },
    { key: 'earlier', label: '更早', items: earlierGroup },
  ];

  return (
    <div className="space-y-3">
      {groups
        .filter(g => g.items.length > 0)
        .map(g => (
          <div key={g.key} className="pa-session-group">
            <div
              className="px-2 pb-1 pa-fs-tiny font-semibold uppercase tracking-wider flex items-center justify-between"
              style={{ color: 'var(--text-muted)', opacity: 0.65, letterSpacing: '0.08em' }}
            >
              <span>{g.label}</span>
              <span className="text-[9px] opacity-70 tabular-nums">{g.items.length}</span>
            </div>
            <div className="space-y-1">
              {g.items.map(s => (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onSelect={() => onSelect(s.id)}
                  onDelete={() => void onDelete(s.id)}
                  onRename={title => void onRename(s.id, title)}
                />
              ))}
            </div>
          </div>
        ))}
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  // 主题（dark / parchment）与字号档（small / medium / large）— sessionStorage 持久化
  const [theme, setTheme] = useState<PaTheme>(() =>
    readPref<PaTheme>(PA_THEME_KEY, 'dark', ['dark', 'parchment']));
  const [fontSize, setFontSize] = useState<PaFontSize>(() =>
    readPref<PaFontSize>(PA_FONTSIZE_KEY, 'medium', ['small', 'medium', 'large']));

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => {
      const next: PaTheme = prev === 'dark' ? 'parchment' : 'dark';
      writePref(PA_THEME_KEY, next);
      return next;
    });
  }, []);

  const handleSetFontSize = useCallback((next: PaFontSize) => {
    setFontSize(next);
    writePref(PA_FONTSIZE_KEY, next);
  }, []);

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
    { key: 'chat', label: '对话', icon: <MessageSquare size={14} /> },
    { key: 'board', label: '任务看板', icon: <LayoutGrid size={14} /> },
  ];

  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <div
      className="pa-agent-root h-full flex"
      data-pa-theme={theme}
      data-pa-fontsize={fontSize}
      style={{
        // parchment 主题下 .pa-agent-root[data-pa-theme="parchment"] 会用 !important 覆盖
        background: 'var(--bg-base)',
        color: 'var(--text-primary)',
      }}
    >
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
              style={{ background: 'linear-gradient(135deg,#0c3d6e,#2563eb)' }}
            >
              <PaSecretaryIcon size={12} color="#fff" />
            </div>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              毒舌秘书
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

        {/* Session list — 按时间分组 + 复盘单独成组 */}
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {loading ? (
            <SessionSkeleton />
          ) : sessions.length === 0 ? (
            <div className="text-xs text-center pt-6 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              点击 <span style={{ color: '#a5b4fc', fontWeight: 600 }}>+</span> 开始新对话<br/>
              <span className="text-[10px] opacity-70">把混乱丢给秘书</span>
            </div>
          ) : (
            <GroupedSessions
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={id => { setActiveSessionId(id); setTab('chat'); }}
              onDelete={handleDeleteSession}
              onRename={handleRenameSession}
            />
          )}
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
                {tab === 'board' ? '任务看板' : '毒舌秘书'}
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
                data-active={tab === t.key}
                className="pa-tab-button flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-[10px] whitespace-nowrap font-medium"
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

          {/* 阅读偏好：字号档 + 主题切换（顶部 bar 右侧） */}
          <div
            className="hidden md:flex items-center gap-0.5 rounded-xl p-0.5"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
            title="阅读偏好：字号 A- / A / A+ 三档"
          >
            <button
              type="button"
              className="pa-toolbar-btn pa-toolbar-font-btn"
              data-active={fontSize === 'small'}
              onClick={() => handleSetFontSize('small')}
              title="小号字"
            >
              A-
            </button>
            <button
              type="button"
              className="pa-toolbar-btn pa-toolbar-font-btn"
              data-active={fontSize === 'medium'}
              onClick={() => handleSetFontSize('medium')}
              title="默认字号"
            >
              A
            </button>
            <button
              type="button"
              className="pa-toolbar-btn pa-toolbar-font-btn"
              data-active={fontSize === 'large'}
              onClick={() => handleSetFontSize('large')}
              title="大号字"
            >
              A+
            </button>
          </div>

          <button
            onClick={handleToggleTheme}
            className="pa-toolbar-btn"
            data-active={theme === 'parchment'}
            title={theme === 'parchment' ? '切回深色（暗夜专注）' : '切到羊皮卷（护眼复古）'}
            style={{ width: 28, height: 28, padding: 0 }}
          >
            {theme === 'parchment' ? <Moon size={14} /> : <BookOpen size={14} />}
          </button>
          <button
            onClick={() => setProfileOpen(true)}
            className="pa-toolbar-btn flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl"
            title="毒舌秘书会跨会话记得的事 — 角色 / 项目 / 节奏 / 偏好"
          >
            <Brain size={13} />
            我的画像
          </button>

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
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}
                >
                  <MessageSquare size={20} style={{ color: 'var(--text-muted)' }} />
                </div>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  点击左上角 <strong>+</strong> 开新对话，毒舌秘书在等你的难题。
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
            <PaTaskBoard
              key={boardRefreshKey}
              onOpenReview={() => setReviewOpen(true)}
            />
          )}
        </div>
      </div>

      <PaProfilePanel open={profileOpen} onClose={() => setProfileOpen(false)} />
      <PaReviewDrawer open={reviewOpen} onClose={() => setReviewOpen(false)} />
    </div>
  );
}
