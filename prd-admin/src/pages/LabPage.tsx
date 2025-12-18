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
    <div className="h-full min-h-0 flex flex-col gap-4">
      <div className="flex items-center gap-2 shrink-0">
        <Button variant={tab === 'llm' ? 'primary' : 'secondary'} onClick={() => setTab('llm')}>
          大模型实验室
        </Button>
        <Button variant={tab === 'desktop' ? 'primary' : 'secondary'} onClick={() => setTab('desktop')}>
          桌面实验室
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'llm' ? <LlmLabTab /> : <DesktopLabTab />}
      </div>
    </div>
  );
}


