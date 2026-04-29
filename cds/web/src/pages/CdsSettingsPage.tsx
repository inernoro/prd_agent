import { useEffect, useState } from 'react';
import {
  Boxes,
  Database,
  Github,
  KeyRound,
  Settings,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AuthTab } from '@/pages/cds-settings/tabs/AuthTab';
import { ClusterTab } from '@/pages/cds-settings/tabs/ClusterTab';
import { GitHubAppTab } from '@/pages/cds-settings/tabs/GitHubAppTab';
import { GlobalVarsTab } from '@/pages/cds-settings/tabs/GlobalVarsTab';
import { MaintenanceTab } from '@/pages/cds-settings/tabs/MaintenanceTab';
import { MirrorTab } from '@/pages/cds-settings/tabs/MirrorTab';
import { OverviewTab } from '@/pages/cds-settings/tabs/OverviewTab';
import { StorageTab } from '@/pages/cds-settings/tabs/StorageTab';

const tabs = [
  { value: 'overview', label: '概览', icon: Settings },
  { value: 'auth', label: '登录与认证', icon: KeyRound },
  { value: 'github', label: 'GitHub 集成', icon: Github },
  { value: 'storage', label: '存储后端', icon: Database },
  { value: 'cluster', label: '集群', icon: Boxes },
  { value: 'global-vars', label: 'CDS 全局变量', icon: TerminalSquare },
  { value: 'maintenance', label: '维护', icon: Wrench },
] as const;

type TabValue = (typeof tabs)[number]['value'];

function getInitialTab(): TabValue {
  const hash = window.location.hash.replace(/^#/, '');
  return tabs.some((tab) => tab.value === hash) ? (hash as TabValue) : 'overview';
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
      <Workspace>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <TabsList
              aria-label="CDS 系统设置分区"
              className="cds-surface-raised cds-hairline p-2 lg:sticky lg:top-[72px] lg:self-start"
            >
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{tab.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="cds-surface-raised cds-hairline min-w-0 p-5">
              <TabsContent value="overview">
                <OverviewTab />
              </TabsContent>
              <TabsContent value="auth">
                <AuthTab />
              </TabsContent>
              <TabsContent value="github">
                <GitHubAppTab onToast={setToast} />
              </TabsContent>
              <TabsContent value="storage">
                <StorageTab />
              </TabsContent>
              <TabsContent value="cluster">
                <ClusterTab />
              </TabsContent>
              <TabsContent value="global-vars">
                <GlobalVarsTab onToast={setToast} />
              </TabsContent>
              <TabsContent value="maintenance">
                <div className="space-y-5">
                  <MaintenanceTab onToast={setToast} />
                  <DisclosurePanel title="镜像与外观" subtitle="镜像加速和浏览器标签设置">
                    <MirrorTab />
                  </DisclosurePanel>
                </div>
              </TabsContent>
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
