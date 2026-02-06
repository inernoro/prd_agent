import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TabBar } from '@/components/design/TabBar';
import { Mail, Webhook, ListChecks, Plug, ScrollText } from 'lucide-react';

// 子页面组件
import EmailChannelPanel from './open-platform/EmailChannelPanel';
import ChannelsPanel from './open-platform/ChannelsPanel';
import AppsPanel from './open-platform/AppsPanel';
import TasksPanel from './open-platform/TasksPanel';
import LogsPanel from './open-platform/LogsPanel';

/**
 * 开放平台 - Tab 容器页面
 *
 * 分类结构：
 * 1. 通道适配器
 *    - 邮箱通道：服务器配置 + 工作流邮箱 + 发件人白名单
 *    - Webhook：端点配置 + 白名单
 * 2. 任务中心
 *    - 任务监控：所有通道的任务汇总
 * 3. 开放平台 API
 *    - API 应用：应用管理
 *    - 调用日志：请求日志
 */
export default function OpenPlatformTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'email';
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  // 子页面传递的 actions
  const [emailActions, setEmailActions] = useState<React.ReactNode>(null);
  const [webhookActions, setWebhookActions] = useState<React.ReactNode>(null);
  const [tasksActions, setTasksActions] = useState<React.ReactNode>(null);
  const [appsActions, setAppsActions] = useState<React.ReactNode>(null);
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

  const getCurrentActions = () => {
    switch (activeTab) {
      case 'email': return emailActions;
      case 'webhook': return webhookActions;
      case 'tasks': return tasksActions;
      case 'apps': return appsActions;
      case 'logs': return logsActions;
      default: return null;
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        items={[
          { key: 'email', label: '邮箱通道', icon: <Mail size={14} /> },
          { key: 'webhook', label: 'Webhook', icon: <Webhook size={14} /> },
          { key: 'tasks', label: '任务监控', icon: <ListChecks size={14} /> },
          { key: 'apps', label: 'API 应用', icon: <Plug size={14} /> },
          { key: 'logs', label: '调用日志', icon: <ScrollText size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
        actions={getCurrentActions()}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'email' && <EmailChannelPanel onActionsReady={setEmailActions} />}
        {activeTab === 'webhook' && <ChannelsPanel onActionsReady={setWebhookActions} />}
        {activeTab === 'tasks' && <TasksPanel onActionsReady={setTasksActions} />}
        {activeTab === 'apps' && <AppsPanel onActionsReady={setAppsActions} />}
        {activeTab === 'logs' && <LogsPanel onActionsReady={setLogsActions} />}
      </div>
    </div>
  );
}
