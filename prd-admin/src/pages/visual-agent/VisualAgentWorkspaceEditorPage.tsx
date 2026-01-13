import { Card } from '@/components/design/Card';
import AdvancedImageMasterTab from '@/pages/ai-chat/AdvancedImageMasterTab';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useRef } from 'react';

export default function VisualAgentWorkspaceEditorPage() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const workspaceId = String(params.workspaceId ?? '').trim();
  const initialPrompt = searchParams.get('prompt') ?? '';
  const wrapRef = useRef<HTMLDivElement | null>(null);

  if (!workspaceId) {
    return (
      <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
        <Card>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            workspaceId 为空。请从 <Link to="/visual-agent">视觉创作 Agent</Link> 选择一个项目进入。
          </div>
        </Card>
      </div>
    );
  }
  // AdvancedImageMasterTab 内部使用大量 h-full/min-h-0 布局，必须由父容器提供稳定高度
  return (
    <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
      <AdvancedImageMasterTab workspaceId={workspaceId} initialPrompt={initialPrompt} />
    </div>
  );
}
