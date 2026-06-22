import { lazy, Suspense, useEffect, useState } from 'react';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';
import {
  Activity,
  Boxes,
  Database,
  Github,
  KeyRound,
  Monitor,
  Plug,
  Save,
  ServerCog,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const AccessKeysTab = lazy(() => import('@/pages/cds-settings/tabs/AccessKeysTab').then((m) => ({ default: m.AccessKeysTab })));
const AuthTab = lazy(() => import('@/pages/cds-settings/tabs/AuthTab').then((m) => ({ default: m.AuthTab })));
const UsersTab = lazy(() => import('@/pages/cds-settings/tabs/UsersTab').then((m) => ({ default: m.UsersTab })));
const ActivityTab = lazy(() => import('@/pages/cds-settings/tabs/ActivityTab').then((m) => ({ default: m.ActivityTab })));
const ClusterTab = lazy(() => import('@/pages/cds-settings/tabs/ClusterTab').then((m) => ({ default: m.ClusterTab })));
const ConnectionsTab = lazy(() => import('@/pages/cds-settings/tabs/ConnectionsTab').then((m) => ({ default: m.ConnectionsTab })));
const ConfigSnapshotsTab = lazy(() => import('@/pages/cds-settings/tabs/ConfigSnapshotsTab').then((m) => ({ default: m.ConfigSnapshotsTab })));
const GitHubAppTab = lazy(() => import('@/pages/cds-settings/tabs/GitHubAppTab').then((m) => ({ default: m.GitHubAppTab })));
const GitHubAppWhitelistTab = lazy(() => import('@/pages/cds-settings/tabs/GitHubAppWhitelistTab').then((m) => ({ default: m.GitHubAppWhitelistTab })));
const GitHubWebhookLogTab = lazy(() => import('@/pages/cds-settings/tabs/GitHubWebhookLogTab').then((m) => ({ default: m.GitHubWebhookLogTab })));
const GlobalVarsTab = lazy(() => import('@/pages/cds-settings/tabs/GlobalVarsTab').then((m) => ({ default: m.GlobalVarsTab })));
const LoadingPagesTab = lazy(() => import('@/pages/cds-settings/tabs/LoadingPagesTab').then((m) => ({ default: m.LoadingPagesTab })));
const MaintenanceTab = lazy(() => import('@/pages/cds-settings/tabs/MaintenanceTab').then((m) => ({ default: m.MaintenanceTab })));
const MirrorTab = lazy(() => import('@/pages/cds-settings/tabs/MirrorTab').then((m) => ({ default: m.MirrorTab })));
const OverviewTab = lazy(() => import('@/pages/cds-settings/tabs/OverviewTab').then((m) => ({ default: m.OverviewTab })));
const RemoteHostsTab = lazy(() => import('@/pages/cds-settings/tabs/RemoteHostsTab').then((m) => ({ default: m.RemoteHostsTab })));
const SchedulerTab = lazy(() => import('@/pages/cds-settings/tabs/SchedulerTab').then((m) => ({ default: m.SchedulerTab })));
const StorageTab = lazy(() => import('@/pages/cds-settings/tabs/StorageTab').then((m) => ({ default: m.StorageTab })));

/*
 * CDS system settings — flattened into 3 semantic groups (接入 / 运行时 /
 * 维护) so the user can find a setting in 3 seconds without scanning seven
 * sibling tabs. The TabsList renders section headers as plain divs between
 * TabsTrigger groups; Radix preserves keyboard nav across triggers.
 */
type TabValue =
  | 'overview'
  | 'auth'
  | 'users'
  | 'activity'
  | 'access-keys'
  | 'github'
  | 'github-whitelist'
  | 'webhook-log'
  | 'storage'
  | 'scheduler'
  | 'cluster'
  | 'remote-hosts'
  | 'connections'
  | 'global-vars'
  | 'loading-pages'
  | 'snapshots'
  | 'maintenance';

interface TabItem {
  value: TabValue;
  label: string;
  icon: typeof Settings;
}

interface TabGroup {
  label: string;
  items: TabItem[];
}

// 2026-05-04 用户反馈调整 tab 顺序:
// 「更新与重启」是日常最常用的运维入口(尤其 self-update),提到第一位。
// 「概览」次之,认证 / GitHub 集成 等"接入类"放后面 — 用户进设置页 90%
// 是为了升级 CDS,不该让他们扫到第 7 个 tab 才看到。
const tabGroups: TabGroup[] = [
  {
    label: '常用',
    items: [
      { value: 'maintenance', label: '更新与重启', icon: Wrench },
      // 2026-05-28 删:运维控制台 Tab 与弹窗审批流(OperatorApprovalModal)100%
      // 功能重叠,且暴露面更大。AI 发起请求 → 右下角弹窗 → 一键允许的流程
      // 已覆盖所有 op,Tab 上点击执行的入口反而有误操作风险。后端注册表保留。
      { value: 'access-keys', label: 'AI Access Key', icon: KeyRound },
      { value: 'overview', label: '概览', icon: Settings },
    ],
  },
  {
    label: '接入',
    items: [
      { value: 'auth', label: '登录与认证', icon: KeyRound },
      { value: 'users', label: '用户管理', icon: Users },
      { value: 'activity', label: '用户痕迹', icon: Activity },
      { value: 'github', label: 'GitHub 集成', icon: Github },
      { value: 'github-whitelist', label: 'GitHub 白名单', icon: ShieldCheck },
      { value: 'webhook-log', label: 'Webhook 日志', icon: Activity },
    ],
  },
  {
    label: '运行时',
    items: [
      { value: 'storage', label: '存储后端', icon: Database },
      { value: 'scheduler', label: '调度器', icon: Timer },
      { value: 'cluster', label: '集群', icon: Boxes },
      { value: 'remote-hosts', label: '远程主机', icon: ServerCog },
      { value: 'connections', label: '对接 MAP', icon: Plug },
      { value: 'global-vars', label: 'CDS 全局变量', icon: TerminalSquare },
      { value: 'loading-pages', label: '加载页预览', icon: Monitor },
      { value: 'snapshots', label: '配置快照', icon: Save },
    ],
  },
];

const tabs: TabItem[] = tabGroups.flatMap((group) => group.items);

function getInitialTab(): TabValue {
  const hash = window.location.hash.replace(/^#/, '');
  // 2026-05-04:默认从 'overview' 改 'maintenance' — 用户进设置页 90%
  // 是为了 self-update,不让他多点一次。仍尊重 #hash 直链。
  return tabs.some((tab) => tab.value === hash) ? (hash as TabValue) : 'maintenance';
}

function SettingsTabFallback(): JSX.Element {
  // 2026-05-28:用品牌 loader 替换裸"加载设置..." 文本,跟 CDS 视觉调性一致。
  return (
    <div className="flex min-h-[200px] items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] p-4">
      <CdsLogoLoader size="lg" inline={false} label={<span className="text-sm text-muted-foreground">加载设置…</span>} />
    </div>
  );
}

export function CdsSettingsPage(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabValue>(() => getInitialTab());
  const [toast, setToast] = useState('');

  useEffect(() => {
    window.history.replaceState(null, '', `#${activeTab}`);
  }, [activeTab]);

  useEffect(() => {
    const syncFromHash = () => setActiveTab(getInitialTab());
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <AppShell
      active="cds-settings"
      topbar={
        <TopBar
          left={
            <Crumb
              items={[
                { label: 'CDS', href: '/project-list' },
                { label: '系统设置' },
              ]}
            />
          }
        />
      }
    >
      <Workspace className="cds-workspace-settings">
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <TabsList
              aria-label="CDS 系统设置分区"
              className="cds-settings-nav cds-surface-raised cds-hairline p-2 lg:sticky lg:top-[72px] lg:self-start"
            >
              {tabGroups.map((group, groupIdx) => (
                <div key={group.label} className={`cds-settings-nav-group ${groupIdx === 0 ? '' : 'mt-2'}`}>
                  <div className="cds-settings-nav-group-label px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                    {group.label}
                  </div>
                  {group.items.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <TabsTrigger key={tab.value} value={tab.value} className="cds-settings-nav-trigger">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{tab.label}</span>
                      </TabsTrigger>
                    );
                  })}
                </div>
              ))}
            </TabsList>

            <div className="cds-settings-content cds-surface-raised cds-hairline min-w-0 p-5">
              <Suspense fallback={<SettingsTabFallback />}>
                <TabsContent value="overview">
                  {activeTab === 'overview' ? <OverviewTab /> : null}
                </TabsContent>
                <TabsContent value="auth">
                  {activeTab === 'auth' ? <AuthTab /> : null}
                </TabsContent>
                <TabsContent value="users">
                  {activeTab === 'users' ? <UsersTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="activity">
                  {activeTab === 'activity' ? <ActivityTab /> : null}
                </TabsContent>
                <TabsContent value="access-keys">
                  {activeTab === 'access-keys' ? <AccessKeysTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="github">
                  {activeTab === 'github' ? <GitHubAppTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="github-whitelist">
                  {activeTab === 'github-whitelist' ? <GitHubAppWhitelistTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="webhook-log">
                  {activeTab === 'webhook-log' ? <GitHubWebhookLogTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="storage">
                  {activeTab === 'storage' ? <StorageTab /> : null}
                </TabsContent>
                <TabsContent value="scheduler">
                  {activeTab === 'scheduler' ? <SchedulerTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="cluster">
                  {activeTab === 'cluster' ? <ClusterTab /> : null}
                </TabsContent>
                <TabsContent value="remote-hosts">
                  {activeTab === 'remote-hosts' ? <RemoteHostsTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="connections">
                  {activeTab === 'connections' ? <ConnectionsTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="global-vars">
                  {activeTab === 'global-vars' ? <GlobalVarsTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="loading-pages">
                  {activeTab === 'loading-pages' ? <LoadingPagesTab /> : null}
                </TabsContent>
                <TabsContent value="snapshots">
                  {activeTab === 'snapshots' ? <ConfigSnapshotsTab onToast={setToast} /> : null}
                </TabsContent>
                <TabsContent value="maintenance">
                  {activeTab === 'maintenance' ? (
                    <div className="space-y-5">
                      <MaintenanceTab onToast={setToast} />
                      <DisclosurePanel title="镜像与外观" subtitle="镜像加速和浏览器标签设置">
                        <MirrorTab />
                      </DisclosurePanel>
                    </div>
                  ) : null}
                </TabsContent>
              </Suspense>
            </div>
          </div>
        </Tabs>

        {toast ? (
          <div
            className="fixed bottom-5 right-5 z-50 max-w-sm rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3 text-sm shadow-lg"
            role="status"
          >
            {toast}
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}
