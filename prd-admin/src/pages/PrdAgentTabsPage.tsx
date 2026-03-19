import { TabBar } from '@/components/design/TabBar';
import { Eye, MessagesSquare, Users2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import GroupsPage from './GroupsPage';
import AiChatPage from './AiChatPage';

const PrdPreviewPage = lazy(() => import('@/components/prd-preview/PrdPreviewPage'));

/**
 * PRD Agent 统一入口页 — 三个标签页：对话、预览、群组管理。
 *
 * "预览"标签自动从 URL 参数（documentId、groupId）或 AiChatPage 发出的
 * 自定义事件 `prdAgent:openPreview` 中获取要预览的文档信息。
 */
export function PrdAgentTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'chat';
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  // 预览上下文
  const [previewDocumentId, setPreviewDocumentId] = useState<string | null>(
    searchParams.get('documentId') || null
  );
  const [previewGroupId, setPreviewGroupId] = useState<string | null>(
    searchParams.get('groupId') || null
  );
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  // 同步 URL 参数
  useEffect(() => {
    const currentTab = searchParams.get('tab');
    if (currentTab && currentTab !== activeTab) {
      setActiveTab(currentTab);
    }
  }, [searchParams, activeTab]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    setSearchParams({ tab: key });
  };

  // 监听来自 AiChatPage（或其他组件）的"打开预览"事件
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ documentId?: string; groupId?: string; sessionId?: string }>;
      const detail = ce?.detail;
      if (!detail) return;
      if (detail.documentId) setPreviewDocumentId(detail.documentId);
      if (detail.groupId) setPreviewGroupId(detail.groupId);
      if (detail.sessionId) setPreviewSessionId(detail.sessionId);
      // 自动切到预览标签
      setActiveTab('preview');
      setSearchParams({ tab: 'preview' });
    };
    window.addEventListener('prdAgent:openPreview', handler);
    return () => window.removeEventListener('prdAgent:openPreview', handler);
  }, [setSearchParams]);

  const handleClosePreview = useCallback(() => {
    setActiveTab('chat');
    setSearchParams({ tab: 'chat' });
  }, [setSearchParams]);

  const hasPreviewContext = !!previewDocumentId && (!!previewGroupId || !!previewSessionId);

  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <TabBar
        items={[
          { key: 'chat', label: 'PRD 对话', icon: <MessagesSquare size={14} /> },
          { key: 'preview', label: hasPreviewContext ? 'PRD 预览' : 'PRD 预览（无文档）', icon: <Eye size={14} /> },
          { key: 'groups', label: '群组管理', icon: <Users2 size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'groups' && <GroupsPage />}
        {activeTab === 'chat' && <AiChatPage />}
        {activeTab === 'preview' && hasPreviewContext && (
          <Suspense fallback={<div className="h-full flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>加载预览...</div>}>
            <PrdPreviewPage
              documentId={previewDocumentId}
              groupId={previewGroupId}
              sessionId={previewSessionId}
              onRequestClose={handleClosePreview}
            />
          </Suspense>
        )}
        {activeTab === 'preview' && !hasPreviewContext && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                暂无可预览的文档
              </div>
              <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                请先在"PRD 对话"中上传文档并开始对话后，点击引用按钮打开预览。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
