import { useCallback, useMemo, useRef, useState } from 'react';
import { usePrdAgentStore } from '@/stores/prdAgentStore';

/**
 * PRD Agent 专属侧边栏 —— 1:1 对标 Desktop Sidebar.tsx 的布局与视觉。
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
      const saved = sessionStorage.getItem('prdAgent.sidebarWidth');
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= 180 && n <= 420) return n;
      }
    } catch { /* ignore */ }
    return 224;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startW: number } | null>(null);

  const currentWidth = sidebarCollapsed ? 48 : expandedWidth;

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
    try { sessionStorage.setItem('prdAgent.sidebarWidth', String(expandedWidth)); } catch { /* ignore */ }
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

  return (
    <aside
      className={`relative flex-shrink-0 border-r border-black/10 dark:border-white/10 ${isResizing ? '' : 'transition-[width] duration-150'}`}
      style={{ width: `${currentWidth}px` }}
    >
      <div className="h-full flex flex-col">
        {/* ── 头部：群组标题 + 操作按钮（对标 Desktop p-3 border-b） ── */}
        <div className="p-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between">
          {!sidebarCollapsed && (
            <>
              <h2 className="text-sm font-medium text-text-secondary">群组</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleSidebar}
                  title="折叠侧边栏"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={onCreateSession}
                  title="新建会话（上传 PRD）"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </>
          )}
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="mx-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
              title="展开侧边栏"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* ── 会话列表（对标 Desktop GroupList） ── */}
        {!sidebarCollapsed && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <div className="text-xs text-text-secondary">暂无会话</div>
                <button
                  className="mt-2 text-xs px-3 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-text-secondary"
                  style={{ border: '1px dashed var(--border-default)' }}
                  onClick={onCreateSession}
                >
                  上传 PRD 开始
                </button>
              </div>
            ) : (
              <div className="py-2 px-2 space-y-1">
                {sessions.map((session) => {
                  const isActive = session.sessionId === activeSessionId;
                  return (
                    <div
                      key={session.sessionId}
                      role="button"
                      tabIndex={0}
                      className={`group relative w-full px-3 h-12 rounded-lg flex items-center gap-2 cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-primary-50/50 dark:bg-white/5'
                          : 'hover:bg-black/5 dark:hover:bg-white/5'
                      }`}
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
                      {/* 激活指示条（对标 Desktop active indicator） */}
                      {isActive && (
                        <span
                          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary-500"
                        />
                      )}

                      {/* 头像（对标 Desktop h-8 w-8 rounded-lg） */}
                      <div
                        className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-semibold text-white"
                        style={{ background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.7), rgba(168, 85, 247, 0.7))' }}
                      >
                        {getSessionInitial(session.title || session.documentTitle)}
                      </div>

                      {/* 标题 */}
                      <div className="min-w-0 flex-1">
                        <div
                          className="text-sm font-medium truncate text-text-primary"
                          title={session.title || session.documentTitle}
                        >
                          {session.title || session.documentTitle || `会话 ${session.sessionId.slice(0, 8)}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 知识库（对标 Desktop 知识库区） ── */}
        {!sidebarCollapsed && (
          <div className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="text-xs font-medium text-text-secondary">知识库</div>
              <button
                type="button"
                onClick={() => {
                  if (activeDocuments.length > 0 && activeDocuments[0].documentId && activeSessionId) {
                    onOpenPreview(activeDocuments[0].documentId, activeSessionId);
                  }
                }}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5"
                title="知识库管理"
                aria-label="知识库管理"
              >
                {/* Settings gear icon (对标 Desktop) */}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11.983 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c0 .7.41 1.33 1.04 1.61.3.13.62.2.95.2H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
                  />
                </svg>
              </button>
            </div>
            <div className="px-2 pb-2 max-h-44 overflow-y-auto space-y-1">
              {activeDocuments.length > 0 ? (
                <>
                  {activeDocuments.map((doc, i) => (
                    <div
                      key={doc.documentId}
                      role="button"
                      tabIndex={0}
                      className="group w-full px-3 py-2 rounded-lg text-left text-sm transition-colors cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary hover:text-primary-500"
                      onClick={() => {
                        if (doc.documentId && activeSessionId) {
                          onOpenPreview(doc.documentId, activeSessionId);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (doc.documentId && activeSessionId) {
                            onOpenPreview(doc.documentId, activeSessionId);
                          }
                        }
                      }}
                      title={doc.documentTitle || `文档 ${i + 1}`}
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* 主文档图标 w-4 h-4（对标 Desktop） */}
                          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 20h10a2 2 0 002-2V6a2 2 0 00-2-2H9l-2 2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          <span className="truncate">{doc.documentTitle || `文档 ${i + 1}`}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {doc.documentType && DOC_TYPE_LABELS[doc.documentType] && (
                            <span className="text-[9px] px-1 py-px rounded bg-black/5 dark:bg-white/10 text-text-secondary whitespace-nowrap">
                              {DOC_TYPE_LABELS[doc.documentType]}
                            </span>
                          )}
                          <button
                            type="button"
                            className="h-7 w-7 hidden group-hover:inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (doc.documentId && activeSessionId) {
                                onOpenPreview(doc.documentId, activeSessionId);
                              }
                            }}
                            title="预览文档"
                            aria-label="预览文档"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {/* 追加资料按钮（对标 Desktop） */}
                  <button
                    type="button"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('prdAgent:addDocument'));
                    }}
                    className="w-full px-3 py-1.5 rounded-lg text-left text-xs text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <span>追加资料</span>
                  </button>
                </>
              ) : (
                <div className="px-3 py-2 text-xs text-text-secondary">
                  {activeSessionId ? '当前会话无文档' : '请先选择会话'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 缺陷管理入口（对标 Desktop 缺陷管理区） ── */}
        {!sidebarCollapsed && (
          <div className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="text-xs font-medium text-text-secondary">缺陷管理</div>
              <button
                type="button"
                onClick={() => {
                  window.location.hash = '#/defect-agent';
                }}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5"
                title="缺陷管理"
                aria-label="缺陷管理"
              >
                {/* Bug icon (对标 Desktop SVG) */}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2l1.88 1.88M14.12 3.88 16 2" />
                  <path d="M9 7.13v-1a3 3 0 1 1 6 0v1" />
                  <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                  <path d="M12 20v-9" />
                  <path d="M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4" />
                  <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 拖拽调宽手柄（对标 Desktop resize handle） ── */}
      {!sidebarCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize group/handle hover:bg-primary-500/10"
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
      )}
    </aside>
  );
}
