import { useParams } from 'react-router-dom';
import LiteraryAgentEditorPage from './LiteraryAgentEditorPage';

export default function LiteraryAgentEditorPageWrapper() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <LiteraryAgentEditorPage workspaceId={workspaceId || ''} />;
}

