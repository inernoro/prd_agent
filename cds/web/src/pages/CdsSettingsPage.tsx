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

/*
 * CDS system settings — flattened into 3 semantic groups (接入 / 运行时 /
 * 维护) so the user can find a setting in 3 seconds without scanning seven
 * sibling tabs. The TabsList renders section headers as plain divs between
 * TabsTrigger groups; Radix preserves keyboard nav across triggers.
 */
type TabValue =
  | 'overview'
  | 'auth'
  | 'github'
  | 'storage'
  | 'cluster'
  | 'global-vars'
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
      { value: 'overview', label: '概览', icon: Settings },
    ],
  },
  {
    label: '接入',
    items: [
      { value: 'auth', label: '登录与认证', icon: KeyRound },
      { value: 'github', label: 'GitHub 集成', icon: Github },
    ],
  },
  {
    label: '运行时',
    items: [
      { value: 'storage', label: '存储后端', icon: Database },
      { value: 'cluster', label: '集群', icon: Boxes },
      { value: 'global-vars', label: 'CDS 全局变量', icon: TerminalSquare },
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
              {tabGroups.map((group, groupIdx) => (
                <div key={group.label} className={groupIdx === 0 ? '' : 'mt-2'}>
                  <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                    {group.label}
                  </div>
                  {group.items.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <TabsTrigger key={tab.value} value={tab.value}>
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{tab.label}</span>
                      </TabsTrigger>
                    );
                  })}
                </div>
              ))}
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
