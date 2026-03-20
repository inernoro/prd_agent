import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { usePrdAgentStore } from '@/stores/prdAgentStore';
import PrdAgentSidebar from '@/components/prd-agent/PrdAgentSidebar';
import AiChatPage from './AiChatPage';

const PrdPreviewPage = lazy(() => import('@/components/prd-preview/PrdPreviewPage'));

/**
 * PRD Agent 统一入口页 —— 对标 Desktop App.tsx 的布局：
 *
 *   ┌──────────────┬──────────────────────────────────────────────┐
 *   │  Sidebar     │  Header Bar (session title + role + status)  │
 *   │  ・会话列表   ├──────────────────────────────────────────────┤
 *   │  ・知识库     │  Main Content (Chat | Preview)               │
 *   │  ・缺陷管理   │                                              │
 *   └──────────────┴──────────────────────────────────────────────┘
 *
 * 取消原 3-Tab 布局，改为 Sidebar + Main 布局，与 Desktop 保持视觉一致。
 */
export function PrdAgentTabsPage() {
  const mode = usePrdAgentStore((s) => s.mode);
  const setMode = usePrdAgentStore((s) => s.setMode);

  // 预览上下文
  const [previewDocumentId, setPreviewDocumentId] = useState<string | null>(null);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  // 监听"打开预览"事件（来自 AiChatPage 引用按钮或 Sidebar 知识库）
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ documentId?: string; groupId?: string; sessionId?: string }>;
      const detail = ce?.detail;
      if (!detail) return;
      if (detail.documentId) setPreviewDocumentId(detail.documentId);
      if (detail.sessionId) setPreviewSessionId(detail.sessionId);
      setMode('preview');
    };
    window.addEventListener('prdAgent:openPreview', handler);
    return () => window.removeEventListener('prdAgent:openPreview', handler);
  }, [setMode]);

  const handleClosePreview = useCallback(() => {
    setMode('chat');
  }, [setMode]);

  const handleCreateSession = useCallback(() => {
    // 派发事件让 AiChatPage 打开上传弹窗
    window.dispatchEvent(new CustomEvent('prdAgent:createSession'));
  }, []);

  const handleSwitchSession = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('prdAgent:switchSession', { detail: { sessionId } }));
  }, []);

  const handleOpenPreview = useCallback((documentId: string, sessionId: string) => {
    setPreviewDocumentId(documentId);
    setPreviewSessionId(sessionId);
    setMode('preview');
  }, [setMode]);

  const hasPreviewContext = !!previewDocumentId && !!previewSessionId;

  return (
    <div className="h-full min-h-0 flex">
      {/* ── 左侧栏（对标 Desktop Sidebar） ── */}
      <PrdAgentSidebar
        onCreateSession={handleCreateSession}
        onSwitchSession={handleSwitchSession}
        onOpenPreview={handleOpenPreview}
      />

      {/* ── 主内容区 ── */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {mode === 'chat' && <AiChatPage />}
        {mode === 'preview' && hasPreviewContext && (
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                加载预览...
              </div>
            }
          >
            <PrdPreviewPage
              documentId={previewDocumentId}
              groupId={null}
              sessionId={previewSessionId}
              onRequestClose={handleClosePreview}
            />
          </Suspense>
        )}
        {mode === 'preview' && !hasPreviewContext && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                暂无可预览的文档
              </div>
              <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                点击左侧知识库中的文档，或在对话中点击引用按钮打开预览。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
