import { Tabs } from '@/components/ui/Tabs';
import { LayoutGrid, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ModelManagePage from './ModelManagePage';
import { ModelAppGroupPage } from './ModelAppGroupPage';

export function ModelManageTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'apps'; // 默认显示应用与分组
  const [activeTab, setActiveTab] = useState(tabFromUrl);

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
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-5 pt-5 pb-3">
        <Tabs
          items={[
            { key: 'apps', label: '应用与分组', icon: <Users size={14} /> },
            { key: 'platforms', label: '平台管理', icon: <LayoutGrid size={14} /> },
          ]}
          activeKey={activeTab}
          onChange={handleTabChange}
        />
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5">
        {activeTab === 'apps' && <ModelAppGroupPage />}
        {activeTab === 'platforms' && <ModelManagePage />}
      </div>
    </div>
  );
}
