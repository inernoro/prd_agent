import { GlassCard } from '@/components/design/GlassCard';
import AdvancedVisualAgentTab from '@/pages/ai-chat/AdvancedVisualAgentTab';
import { useParams, Link } from 'react-router-dom';
import { useRef } from 'react';

export default function VisualAgentWorkspaceEditorPage() {
  const params = useParams();
  const workspaceId = String(params.workspaceId ?? '').trim();
  const wrapRef = useRef<HTMLDivElement | null>(null);

  if (!workspaceId) {
    return (
      <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
        <GlassCard glow>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            workspaceId 为空。请从 <Link to="/visual-agent">视觉创作 Agent</Link> 选择一个项目进入。
          </div>
        </GlassCard>
      </div>
    );
  }
  // AdvancedVisualAgentTab 内部使用大量 h-full/min-h-0 布局，必须由父容器提供稳定高度
  // initialPrompt 现在在 AdvancedVisualAgentTab 内部从 sessionStorage 读取
  return (
    <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
      <AdvancedVisualAgentTab workspaceId={workspaceId} />
    </div>
  );
}
