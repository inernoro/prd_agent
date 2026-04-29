import { useEffect, useState } from 'react';
import {
  Boxes,
  Cloud,
  Database,
  Github,
  Home,
  KeyRound,
  Moon,
  Settings,
  Sun,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTheme } from '@/lib/theme';
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
  const { theme, toggle } = useTheme();
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
    <div className="cds-app-shell">
      <nav className="sticky top-0 flex h-screen flex-col items-center gap-2 border-r border-border px-0 py-4">
        <a
          className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          href="/project-list"
          aria-label="返回项目列表"
        >
          <Home className="h-5 w-5" />
        </a>
        <a
          className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-foreground"
          href="/cds-settings"
          aria-label="CDS 系统设置"
        >
          <Cloud className="h-5 w-5" />
        </a>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </nav>

      <main className="cds-main">
        <div className="cds-workspace mb-4">
          <div className="cds-breadcrumb mb-4">
            <a className="font-medium hover:text-foreground" href="/project-list">
              CDS
            </a>
            <span>/</span>
            <span className="font-medium text-foreground">系统设置</span>
          </div>
          <h1 className="cds-page-title">CDS 系统设置</h1>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
          <div className="cds-workspace grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <TabsList
              aria-label="CDS 系统设置分区"
              className="rounded-md border border-border bg-card/75 p-2 shadow-sm lg:sticky lg:top-4 lg:self-start"
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

            <div className="min-w-0 rounded-md border border-border bg-card/75 p-5 shadow-sm">
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
            className="fixed bottom-5 right-5 z-50 max-w-sm rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg"
            role="status"
          >
            {toast}
          </div>
        ) : null}
      </main>
    </div>
  );
}
