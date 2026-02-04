import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TabBar } from '@/components/design/TabBar';
import { Settings, Shield, Link2, Plug, ListChecks, ScrollText, Workflow } from 'lucide-react';

// 子页面组件
import OpenPlatformSettingsPanel from './open-platform/SettingsPanel';
import OpenPlatformWorkflowsPanel from './open-platform/WorkflowsPanel';
import OpenPlatformChannelsPanel from './open-platform/ChannelsPanel';
import OpenPlatformBindingPanel from './open-platform/BindingPanel';
import OpenPlatformAppsPanel from './open-platform/AppsPanel';
import OpenPlatformTasksPanel from './open-platform/TasksPanel';
import OpenPlatformLogsPanel from './open-platform/LogsPanel';

/**
 * 开放平台 - Tab 容器页面
 *
 * Tab 顺序按照配置流程：
 * 1. 邮箱配置 - 先配置邮箱服务器连接
 * 2. 邮件工作流 - 配置不同邮箱前缀的处理规则
 * 3. 通道白名单 - 配置允许的发送者
 * 4. 邮箱绑定 - 将外部邮箱绑定到系统用户
 * 5. API 应用 - 配置外部应用调用
 * 6. 任务监控 - 监控邮件处理状态
 * 7. 调用日志 - 查看 API 调用历史
 */
export default function OpenPlatformTabsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') || 'settings';
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  // 子页面传递的 actions（用于在 TabBar 右侧显示操作按钮）
  const [settingsActions, setSettingsActions] = useState<React.ReactNode>(null);
  const [workflowsActions, setWorkflowsActions] = useState<React.ReactNode>(null);
  const [channelsActions, setChannelsActions] = useState<React.ReactNode>(null);
  const [bindingActions, setBindingActions] = useState<React.ReactNode>(null);
  const [appsActions, setAppsActions] = useState<React.ReactNode>(null);
  const [tasksActions, setTasksActions] = useState<React.ReactNode>(null);
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
      case 'settings': return settingsActions;
      case 'workflows': return workflowsActions;
      case 'channels': return channelsActions;
      case 'binding': return bindingActions;
      case 'apps': return appsActions;
      case 'tasks': return tasksActions;
      case 'logs': return logsActions;
      default: return null;
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        items={[
          { key: 'settings', label: '邮箱配置', icon: <Settings size={14} /> },
          { key: 'workflows', label: '邮件工作流', icon: <Workflow size={14} /> },
          { key: 'channels', label: '通道白名单', icon: <Shield size={14} /> },
          { key: 'binding', label: '邮箱绑定', icon: <Link2 size={14} /> },
          { key: 'apps', label: 'API 应用', icon: <Plug size={14} /> },
          { key: 'tasks', label: '任务监控', icon: <ListChecks size={14} /> },
          { key: 'logs', label: '调用日志', icon: <ScrollText size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={handleTabChange}
        actions={getCurrentActions()}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'settings' && <OpenPlatformSettingsPanel onActionsReady={setSettingsActions} />}
        {activeTab === 'workflows' && <OpenPlatformWorkflowsPanel onActionsReady={setWorkflowsActions} />}
        {activeTab === 'channels' && <OpenPlatformChannelsPanel onActionsReady={setChannelsActions} />}
        {activeTab === 'binding' && <OpenPlatformBindingPanel onActionsReady={setBindingActions} />}
        {activeTab === 'apps' && <OpenPlatformAppsPanel onActionsReady={setAppsActions} />}
        {activeTab === 'tasks' && <OpenPlatformTasksPanel onActionsReady={setTasksActions} />}
        {activeTab === 'logs' && <OpenPlatformLogsPanel onActionsReady={setLogsActions} />}
      </div>
    </div>
  );
}
