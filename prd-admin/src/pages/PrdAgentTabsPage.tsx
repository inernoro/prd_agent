import { TabBar } from '@/components/design/TabBar';
import { MessagesSquare, Users2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import GroupsPage from './GroupsPage';
import AiChatPage from './AiChatPage';

export function PrdAgentTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'chat';
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
    <div className="h-full min-h-0 flex flex-col gap-2">
      <TabBar
        items={[
          { key: 'chat', label: 'PRD 对话', icon: <MessagesSquare size={14} /> },
          { key: 'groups', label: '群组管理', icon: <Users2 size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'groups' && <GroupsPage />}
        {activeTab === 'chat' && <AiChatPage />}
      </div>
    </div>
  );
}
