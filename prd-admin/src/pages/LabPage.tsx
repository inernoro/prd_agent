import { Button } from '@/components/design/Button';
import DesktopLabTab from '@/pages/lab-desktop/DesktopLabTab';
import LlmLabTab from '@/pages/lab-llm/LlmLabTab';
import { useSearchParams } from 'react-router-dom';

export default function LabPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'llm') as 'llm' | 'desktop';

  const setTab = (next: 'llm' | 'desktop') => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={tab === 'llm' ? 'primary' : 'secondary'} onClick={() => setTab('llm')}>
          大模型实验室
        </Button>
        <Button variant={tab === 'desktop' ? 'primary' : 'secondary'} onClick={() => setTab('desktop')}>
          桌面实验室
        </Button>
      </div>

      {tab === 'llm' ? <LlmLabTab /> : <DesktopLabTab />}
    </div>
  );
}


