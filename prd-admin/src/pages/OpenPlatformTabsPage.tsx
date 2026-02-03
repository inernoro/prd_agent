import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TabBar } from '@/components/design/TabBar';
import { Plug, Mail, ListChecks, UserCheck, ScrollText } from 'lucide-react';

// 子页面组件
import OpenPlatformAppsPanel from './open-platform/AppsPanel';
import OpenPlatformChannelsPanel from './open-platform/ChannelsPanel';
import OpenPlatformTasksPanel from './open-platform/TasksPanel';
import OpenPlatformIdentityPanel from './open-platform/IdentityPanel';
import OpenPlatformLogsPanel from './open-platform/LogsPanel';

/**
 * 开放平台 - Tab 容器页面
 *
 * 设计原则：
 * 1. 扁平化导航 - 所有功能通过顶部 Tab 切换，避免深层跳转
 * 2. URL 同步 - Tab 状态同步到 URL 参数，支持书签和刷新
 * 3. 统一入口 - 从侧边栏进入后，所有子功能一目了然
 */
export default function OpenPlatformTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'apps';
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  // 子页面传递的 actions（用于在 TabBar 右侧显示操作按钮）
  const [appsActions, setAppsActions] = useState<React.ReactNode>(null);
  const [channelsActions, setChannelsActions] = useState<React.ReactNode>(null);
  const [tasksActions, setTasksActions] = useState<React.ReactNode>(null);
  const [identityActions, setIdentityActions] = useState<React.ReactNode>(null);
  const [logsActions, setLogsActions] = useState<React.ReactNode>(null);

  // 同步 URL 参数到状态
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

  // 根据当前 Tab 获取对应的 actions
  const getCurrentActions = () => {
    switch (activeTab) {
      case 'apps': return appsActions;
      case 'channels': return channelsActions;
      case 'tasks': return tasksActions;
      case 'identity': return identityActions;
      case 'logs': return logsActions;
      default: return null;
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        items={[
          { key: 'apps', label: 'API 应用', icon: <Plug size={14} /> },
          { key: 'channels', label: '通道白名单', icon: <Mail size={14} /> },
          { key: 'tasks', label: '任务监控', icon: <ListChecks size={14} /> },
          { key: 'identity', label: '身份映射', icon: <UserCheck size={14} /> },
          { key: 'logs', label: '调用日志', icon: <ScrollText size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
        actions={getCurrentActions()}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'apps' && <OpenPlatformAppsPanel onActionsReady={setAppsActions} />}
        {activeTab === 'channels' && <OpenPlatformChannelsPanel onActionsReady={setChannelsActions} />}
        {activeTab === 'tasks' && <OpenPlatformTasksPanel onActionsReady={setTasksActions} />}
        {activeTab === 'identity' && <OpenPlatformIdentityPanel onActionsReady={setIdentityActions} />}
        {activeTab === 'logs' && <OpenPlatformLogsPanel onActionsReady={setLogsActions} />}
      </div>
    </div>
  );
}
