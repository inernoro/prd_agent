import { Card } from '@/components/design/Card';
import AdvancedImageMasterTab from '@/pages/ai-chat/AdvancedImageMasterTab';
import { useParams, Link } from 'react-router-dom';

export default function VisualAgentWorkspaceEditorPage() {
  const params = useParams();
  const workspaceId = String(params.workspaceId ?? '').trim();
  if (!workspaceId) {
    return (
      <Card>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          workspaceId 为空。请从 <Link to="/visual-agent">视觉创作 Agent</Link> 选择一个项目进入。
        </div>
      </Card>
    );
  }
  return <AdvancedImageMasterTab workspaceId={workspaceId} />;
}


