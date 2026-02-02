import { TabBar } from '@/components/design/TabBar';
import DesktopLabTab from '@/pages/lab-desktop/DesktopLabTab';
import LlmLabTab from '@/pages/lab-llm/LlmLabTab';
import WorkshopLabTab from '@/pages/lab-workshop/WorkshopLabTab';
import RemotionLabTab from '@/pages/lab-remotion/RemotionLabTab';
import { Monitor, Sparkles, FlaskConical, Film } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

type LabTab = 'workshop' | 'llm' | 'desktop' | 'remotion';

export default function LabPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'workshop') as LabTab;

  const setTab = (next: LabTab) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar
        items={[
          { key: 'workshop', label: '试验车间', icon: <FlaskConical size={14} /> },
          { key: 'llm', label: '大模型实验室', icon: <Sparkles size={14} /> },
          { key: 'desktop', label: '桌面实验室', icon: <Monitor size={14} /> },
          { key: 'remotion', label: '视频实验室', icon: <Film size={14} /> },
        ]}
        activeKey={tab}
        onChange={(key) => setTab(key as LabTab)}
      />

      <div className="flex-1 min-h-0">
        {tab === 'workshop' && <WorkshopLabTab />}
        {tab === 'llm' && <LlmLabTab />}
        {tab === 'desktop' && <DesktopLabTab />}
        {tab === 'remotion' && <RemotionLabTab />}
      </div>
    </div>
  );
}


