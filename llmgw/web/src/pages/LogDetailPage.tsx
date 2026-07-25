import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { GenerationDetailsDrawer } from '@/components/GenerationDetailsDrawer';

type LogDetailLocationState = {
  from?: string;
};

export function LogDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LogDetailLocationState | null)?.from;

  if (!id) return null;

  return (
    <GenerationDetailsDrawer
      logId={id}
      presentation="page"
      onClose={() => navigate(from || '/logs')}
    />
  );
}
