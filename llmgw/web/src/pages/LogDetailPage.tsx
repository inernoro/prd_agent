import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { GenerationDetailsDrawer } from '@/components/GenerationDetailsDrawer';

import { getLogReturnTarget, getLogTaskContext } from '@/lib/logNavigation';

export function LogDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const target = getLogReturnTarget(getLogTaskContext(location.search));

  if (!id) return null;

  return (
    <GenerationDetailsDrawer
      logId={id}
      presentation="page"
      returnLabel={target.label}
      onClose={() => navigate(target.href)}
    />
  );
}
