import { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, FileText, Plus, Bug } from 'lucide-react';
import { usePrdAgentStore } from '@/stores/prdAgentStore';

/**
 * PRD Agent 专属侧边栏 —— 对标 Desktop Sidebar.tsx 的布局与功能。
 *
 * 三段结构：
 *   1. 会话列表（对标 Desktop 的"群组"列表）
 *   2. 知识库（对标 Desktop 的知识库区，展示当前会话文档）
 *   3. 缺陷管理入口
 */

const DOC_TYPE_LABELS: Record<string, string> = {
  product: '产品',
  technical: '技术',
  design: '设计',
  reference: '参考',
};

function getSessionInitial(name: string): string {
  const s = (name || '').trim();
  if (!s) return 'P';
  // 取首个中文字符或英文字母
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) return ch;
    if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  }
  return s[0] || 'P';
}

interface PrdAgentSidebarProps {
  onCreateSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onOpenPreview: (documentId: string, sessionId: string) => void;
}

export default function PrdAgentSidebar({ onCreateSession, onSwitchSession, onOpenPreview }: PrdAgentSidebarProps) {
  const sessions = usePrdAgentStore((s) => s.sessions);
  const activeSessionId = usePrdAgentStore((s) => s.activeSessionId);
  const mode = usePrdAgentStore((s) => s.mode);
  const setMode = usePrdAgentStore((s) => s.setMode);
  const sidebarCollapsed = usePrdAgentStore((s) => s.sidebarCollapsed);
  const toggleSidebar = usePrdAgentStore((s) => s.toggleSidebar);

  // ── 侧边栏拖拽调宽 ──
  const [expandedWidth, setExpandedWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('prdAgent.sidebarWidth');
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= 180 && n <= 420) return n;
      }
    } catch { /* ignore */ }
    return 224;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startW: number } | null>(null);

  const currentWidth = sidebarCollapsed ? 0 : expandedWidth;

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeStateRef.current = { startX: e.clientX, startW: expandedWidth };
    setIsResizing(true);
  }, [expandedWidth]);

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStateRef.current) return;
    const delta = e.clientX - resizeStateRef.current.startX;
    const next = Math.max(180, Math.min(420, resizeStateRef.current.startW + delta));
    setExpandedWidth(next);
  }, []);

  const endResize = useCallback(() => {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    setIsResizing(false);
    try { localStorage.setItem('prdAgent.sidebarWidth', String(expandedWidth)); } catch { /* ignore */ }
  }, [expandedWidth]);

  // 当前活跃会话
  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  // 当前会话文档列表
  const activeDocuments = useMemo(() => {
    if (!activeSession) return [];
    if (activeSession.documents && activeSession.documents.length > 0) return activeSession.documents;
    if (activeSession.documentId) return [{ documentId: activeSession.documentId, documentTitle: activeSession.documentTitle || '' }];
    return [];
  }, [activeSession]);

  if (sidebarCollapsed) {
    return (
      <aside className="shrink-0 border-r flex flex-col items-center py-3" style={{ width: 48, borderColor: 'var(--border-default)' }}>
        <button
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onClick={toggleSidebar}
          title="展开侧边栏"
        >
          <ChevronRight size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="shrink-0 border-r flex flex-col relative"
      style={{ width: currentWidth, borderColor: 'var(--border-default)', minWidth: 0 }}
    >
      {/* ── 头部：会话标题 + 操作 ── */}
      <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-default)' }}>
        <h2 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>会话</h2>
        <div className="flex items-center gap-1.5">
          <button
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onClick={onCreateSession}
            title="新建会话（上传 PRD）"
          >
            <Plus size={14} />
          </button>
          <button
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onClick={toggleSidebar}
            title="折叠侧边栏"
          >
            <ChevronLeft size={14} />
          </button>
        </div>
      </div>

      {/* ── 会话列表（对标 Desktop GroupList） ── */}
      <div className="flex-1 min-h-0 overflow-y-auto py-2 px-2 space-y-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无会话</div>
            <button
              className="mt-2 text-xs px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
              style={{ color: 'var(--text-secondary)', border: '1px dashed var(--border-default)' }}
              onClick={onCreateSession}
            >
              上传 PRD 开始
            </button>
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session.sessionId === activeSessionId;
            return (
              <div
                key={session.sessionId}
                role="button"
                tabIndex={0}
                className="group relative w-full px-3 h-12 rounded-lg flex items-center gap-2 cursor-pointer transition-colors"
                style={{
                  background: isActive ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                }}
                onClick={() => {
                  onSwitchSession(session.sessionId);
                  if (mode !== 'chat') setMode('chat');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSwitchSession(session.sessionId);
                    if (mode !== 'chat') setMode('chat');
                  }
                }}
              >
                {/* 激活指示条 */}
                {isActive && (
                  <span
                    className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full"
                    style={{ background: 'rgba(99, 102, 241, 0.8)' }}
                  />
                )}

                {/* 头像 */}
                <div
                  className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-semibold text-white"
                  style={{ background: 'rgba(99, 102, 241, 0.6)' }}
                >
                  {getSessionInitial(session.title || session.documentTitle)}
                </div>

                {/* 标题 */}
                <div className="min-w-0 flex-1">
                  <div
                    className="text-sm font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                    title={session.title || session.documentTitle}
                  >
                    {session.title || session.documentTitle || `会话 ${session.sessionId.slice(0, 8)}`}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── 知识库（对标 Desktop 知识库区） ── */}
      <div className="shrink-0 border-t" style={{ borderColor: 'var(--border-default)' }}>
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>知识库</div>
        </div>
        <div className="px-2 pb-2 max-h-44 overflow-y-auto space-y-1">
          {activeDocuments.length > 0 ? (
            activeDocuments.map((doc, i) => (
              <div
                key={doc.documentId}
                className="group px-3 py-1.5 text-sm flex items-center gap-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors"
                onClick={() => {
                  if (doc.documentId && activeSessionId) {
                    onOpenPreview(doc.documentId, activeSessionId);
                  }
                }}
                title={doc.documentTitle || `文档 ${i + 1}`}
              >
                <FileText size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                  {doc.documentTitle || `文档 ${i + 1}`}
                </span>
                {doc.documentType && DOC_TYPE_LABELS[doc.documentType] && (
                  <span
                    className="text-[9px] px-1 py-px rounded whitespace-nowrap shrink-0"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                  >
                    {DOC_TYPE_LABELS[doc.documentType]}
                  </span>
                )}
                <button
                  className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (doc.documentId && activeSessionId) {
                      onOpenPreview(doc.documentId, activeSessionId);
                    }
                  }}
                  title="预览文档"
                >
                  <Eye size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {activeSessionId ? '当前会话无文档' : '请先选择会话'}
            </div>
          )}
        </div>
      </div>

      {/* ── 缺陷管理入口（对标 Desktop 缺陷管理区） ── */}
      <div className="shrink-0 border-t" style={{ borderColor: 'var(--border-default)' }}>
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>缺陷管理</div>
          <button
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onClick={() => {
              // 导航到缺陷管理页面（与 Desktop 一致的行为）
              window.location.hash = '#/defect-agent';
            }}
            title="打开缺陷管理"
          >
            <Bug size={13} />
          </button>
        </div>
      </div>

      {/* ── 拖拽调宽手柄（对标 Desktop resize handle） ── */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize group/handle"
        style={{ touchAction: 'none' }}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <div
          className="absolute inset-0 transition-colors"
          style={{
            background: isResizing ? 'rgba(99, 102, 241, 0.3)' : 'transparent',
          }}
        />
      </div>
    </aside>
  );
}
