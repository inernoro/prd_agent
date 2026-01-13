import { TabBar } from '@/components/design/TabBar';
import DesktopLabTab from '@/pages/lab-desktop/DesktopLabTab';
import LlmLabTab from '@/pages/lab-llm/LlmLabTab';
import { Monitor, Sparkles } from 'lucide-react';
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
      <TabBar
        items={[
          { key: 'llm', label: '大模型实验室', icon: <Sparkles size={14} /> },
          { key: 'desktop', label: '桌面实验室', icon: <Monitor size={14} /> },
        ]}
        activeKey={tab}
        onChange={(key) => setTab(key as 'llm' | 'desktop')}
      />

      <div className="flex-1 min-h-0">
        {tab === 'llm' ? <LlmLabTab /> : <DesktopLabTab />}
      </div>
    </div>
  );
}


