import { lazy, Suspense, useEffect, useState } from 'react';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';
import {
  Activity,
  Boxes,
  Database,
  Github,
  History,
  KeyRound,
  Monitor,
  Network,
  Plug,
  Save,
  ServerCog,
  Settings,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchAuthPublicStatus, type CdsAuthPublicStatus } from '@/lib/api';
import { bottomRightToastStyle } from '@/lib/overlayOffsets';

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
const SelfUpdateHistoryTab = lazy(() => import('@/pages/cds-settings/tabs/MaintenanceTab').then((m) => ({ default: m.SelfUpdateHistoryTab })));
const DockerNetworkTab = lazy(() => import('@/pages/cds-settings/tabs/MaintenanceTab').then((m) => ({ default: m.DockerNetworkTab })));
const DangerOperationsTab = lazy(() => import('@/pages/cds-settings/tabs/MaintenanceTab').then((m) => ({ default: m.DangerOperationsTab })));
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
  | 'maintenance'
  | 'update-history'
  | 'docker-network'
  | 'danger';

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
      { value: 'maintenance', label: 'CDS 更新', icon: Wrench },
      { value: 'update-history', label: '自更新历史', icon: History },
      { value: 'docker-network', label: 'Docker 网络容量', icon: Network },
      { value: 'danger', label: '危险操作', icon: ShieldAlert },
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
      { value: 'connections', label: '外部接入', icon: Plug },
    ],
  },
  {
    label: '运行时',
    items: [
      { value: 'storage', label: '存储后端', icon: Database },
      { value: 'scheduler', label: '调度器', icon: Timer },
      { value: 'cluster', label: '集群', icon: Boxes },
      { value: 'remote-hosts', label: '远程主机', icon: ServerCog },
      { value: 'global-vars', label: 'CDS 全局变量', icon: TerminalSquare },
      { value: 'loading-pages', label: '加载页预览', icon: Monitor },
      { value: 'snapshots', label: '配置快照', icon: Save },
    ],
  },
];

const tabs: TabItem[] = tabGroups.flatMap((group) => group.items);

const AUTH_MODE_LABELS: Record<string, string> = {
  github: 'GitHub OAuth',
  basic: '账号密码（单账号）',
  sso: 'SSO',
  disabled: '未启用',
};

/**
 * 用户管理 / 用户痕迹两个 tab 由 auth-local 路由支撑,而该路由**只在
 * authMode==='github' 时挂载**;basic / disabled 部署上 /api/auth/users、
 * /api/auth/activity 根本没注册,直接渲染必然 404。
 *
 * 2026-08-25 改法修正:此前是「非 github 模式整条 tab 从导航里消失」。用户在
 * basic 部署上看到的现象是「用户管理不见了」,分不清是被砍了、坏了还是被藏了
 * (expectation-management:功能不许无声消失)。现在 tab 永远在,
 * 只是把会 404 的子组件换成这块说明:当前是什么模式、为什么用不了、怎么开。
 */
export function AuthModeGatedNotice({
  feature,
  mode,
  onGoToAuth,
}: {
  feature: string;
  mode: CdsAuthPublicStatus['mode'] | null;
  onGoToAuth: () => void;
}): JSX.Element {
  if (!mode) return <SettingsTabFallback />;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{feature}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          当前认证模式是 <strong className="text-foreground">{AUTH_MODE_LABELS[mode] || mode}</strong>，
          {feature}未启用——不是被隐藏，是这个模式下后端没有多用户账号体系
          （<code className="rounded bg-[hsl(var(--surface-sunken))] px-1 py-0.5 text-xs">/api/auth/users</code> 仅在 GitHub OAuth 模式挂载）。
        </p>
      </div>
      {/* SSO 部署的账号在上游身份源里，让他们「改成 github 模式」等于劝人关掉 SSO —— 分开说。 */}
      {mode === 'sso' ? (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-4 text-sm">
          <div className="font-medium">这台 CDS 的账号在上游身份源里管理</div>
          <p className="mt-2 text-muted-foreground">
            用户的新增、停用与密码都归发起 SSO 的那套系统管，CDS 侧不再维护第二份账号表，所以本页没有可管理的对象。
            要在 CDS 自己这一层管账号，只有改用 GitHub OAuth 模式——那会替换掉当前的 SSO 登录方式，属于认证方案变更，请先确认是否真要这么做。
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-4 text-sm">
          <div className="font-medium">要启用多用户</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              给 CDS 设置 <code className="text-foreground">CDS_AUTH_MODE=github</code>，并配好{' '}
              <code className="text-foreground">CDS_GITHUB_CLIENT_ID</code> /{' '}
              <code className="text-foreground">CDS_GITHUB_CLIENT_SECRET</code>
            </li>
            <li>重启 CDS；首个登录者可通过 bootstrap 成为系统所有者（需持久化存储后端）</li>
            <li>回到本页即可创建账号、禁用账号、重置密码，并查看用户痕迹</li>
          </ol>
        </div>
      )}
      <button
        type="button"
        onClick={onGoToAuth}
        className="rounded-md border border-[hsl(var(--hairline))] px-3 py-2 text-sm font-medium hover:border-[hsl(var(--hairline-strong))]"
      >
        去「登录与认证」查看当前状态
      </button>
    </div>
  );
}

function getInitialTab(): TabValue {
  const hash = window.location.hash.replace(/^#/, '');
  // 2026-05-04:默认从 'overview' 改 'maintenance' — 用户进设置页 90%
  // 是为了 self-update,不让他多点一次。仍尊重 #hash 直链。
  if (tabs.some((tab) => tab.value === hash)) return hash as TabValue;
  // 2026-07-09 兼容 ?tab= 深链:曾有引导链接写成 ?tab=remote-hosts,本页只认
  // #hash 导致新用户落到默认 tab、引导断头。规范写法仍是 #hash,query 作 fallback。
  const queryTab = new URLSearchParams(window.location.search).get('tab') || '';
  if (tabs.some((tab) => tab.value === queryTab)) return queryTab as TabValue;
  return 'maintenance';
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
  // null = 认证模式探测中;非 github 时隐藏用户管理/用户痕迹 tab(其后端未挂载)。
  const [authMode, setAuthMode] = useState<CdsAuthPublicStatus['mode'] | null>(null);
  const authTabsVisible = authMode === 'github';

  useEffect(() => {
    let alive = true;
    // /api/auth/public-status 在所有认证模式下都挂载(server.ts:1802,早于 github-only 块),
    // 是判定当前模式的权威且安全入口。探测失败按最保守处理:隐藏 auth 相关 tab。
    fetchAuthPublicStatus()
      .then((status) => { if (alive) setAuthMode(status.mode); })
      .catch(() => { if (alive) setAuthMode('disabled'); });
    return () => { alive = false; };
  }, []);

  // tab 不再按模式隐藏:#hash 直链到 users 仍然落在 users,只是内容换成说明面板。
  const visibleTabGroups = tabGroups;

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
              className="cds-settings-nav cds-surface-raised cds-hairline p-2 lg:sticky lg:top-0 lg:self-start"
            >
              {visibleTabGroups.map((group, groupIdx) => (
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
                  {activeTab !== 'users' ? null : authTabsVisible ? (
                    <UsersTab onToast={setToast} />
                  ) : (
                    <AuthModeGatedNotice feature="用户管理" mode={authMode} onGoToAuth={() => setActiveTab('auth')} />
                  )}
                </TabsContent>
                <TabsContent value="activity">
                  {activeTab !== 'activity' ? null : authTabsVisible ? (
                    <ActivityTab />
                  ) : (
                    <AuthModeGatedNotice feature="用户痕迹" mode={authMode} onGoToAuth={() => setActiveTab('auth')} />
                  )}
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
                <TabsContent value="update-history">
                  {activeTab === 'update-history' ? <SelfUpdateHistoryTab /> : null}
                </TabsContent>
                <TabsContent value="docker-network">
                  {activeTab === 'docker-network' ? <DockerNetworkTab /> : null}
                </TabsContent>
                <TabsContent value="danger">
                  {activeTab === 'danger' ? <DangerOperationsTab onToast={setToast} /> : null}
                </TabsContent>
              </Suspense>
            </div>
          </div>
        </Tabs>

        {toast ? (
          <div
            className="fixed z-50 max-w-sm rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3 text-sm shadow-lg"
            style={bottomRightToastStyle}
            role="status"
          >
            {toast}
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}
