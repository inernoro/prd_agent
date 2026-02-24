import { TabBar } from '@/components/design/TabBar';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ArrowLeftRight, Database, LayoutGrid, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ModelManagePage from './ModelManagePage';
import { ModelAppGroupPage } from './ModelAppGroupPage';
import { ModelPoolManagePage } from './ModelPoolManagePage';
import { ExchangeManagePage } from './ExchangeManagePage';

export function ModelManageTabsPage() {
  const { isMobile } = useBreakpoint();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'apps'; // 默认显示应用模型池管理
  const [activeTab, setActiveTab] = useState(tabFromUrl);
  const [appsActions, setAppsActions] = useState<React.ReactNode>(null);

  // 同步 URL 参数
  useEffect(() => {
    const currentTab = searchParams.get('tab');
    if (currentTab && currentTab !== activeTab) {
      setActiveTab(currentTab);
    }
  }, [searchParams, activeTab]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    setSearchParams({ tab: key });
  };

  return (
    <div className={`h-full min-h-0 flex flex-col ${isMobile ? 'gap-3' : 'gap-5'}`}>
      <TabBar
        items={[
          { key: 'apps', label: isMobile ? '应用池' : '应用模型池管理', icon: <Users size={14} /> },
          { key: 'pools', label: isMobile ? '模型池' : '模型池管理', icon: <Database size={14} /> },
          { key: 'platforms', label: isMobile ? '平台' : '平台管理', icon: <LayoutGrid size={14} /> },
          { key: 'exchange', label: isMobile ? '中继' : '模型中继', icon: <ArrowLeftRight size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
        actions={activeTab === 'apps' ? appsActions : undefined}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'apps' && <ModelAppGroupPage onActionsReady={setAppsActions} />}
        {activeTab === 'pools' && <ModelPoolManagePage />}
        {activeTab === 'platforms' && <ModelManagePage />}
        {activeTab === 'exchange' && <ExchangeManagePage />}
      </div>
    </div>
  );
}
