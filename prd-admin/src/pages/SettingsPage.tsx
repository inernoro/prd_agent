import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TabBar } from '@/components/design/TabBar';
import type { TabBarItem } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { ThemeSkinEditor } from '@/pages/settings/ThemeSkinEditor';
import AssetsManagePage from '@/pages/AssetsManagePage';
import AuthzPage from '@/pages/AuthzPage';
import DataManagePage from '@/pages/DataManagePage';
import { UpdateAccelerationSettings } from '@/pages/settings/UpdateAccelerationSettings';
import { UserSpaceSettings } from '@/pages/settings/UserSpaceSettings';
import { AccountSettings } from '@/pages/settings/AccountSettings';
import { DailyTipsEditor } from '@/pages/settings/DailyTipsEditor';
import { NavLayoutEditor } from '@/pages/settings/NavLayoutEditor';
import { useNavOrderStore } from '@/stores/navOrderStore';
import { useAuthStore } from '@/stores/authStore';
import { applyDefaultNavToAllUsers, updateDefaultNavLayout } from '@/services';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  Palette,
  Image,
  UserCog,
  UserCircle2,
  Database,
  ListOrdered,
  Zap,
  Sparkles,
  Save,
  Users,
} from 'lucide-react';

function SkinSettings() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <ThemeSkinEditor />
    </div>
  );
}

function NavOrderSettings() {
  const {
    navOrder,
    navHidden,
    defaultNavOrder,
    defaultNavHidden,
    loaded,
    saving,
    loadFromServer,
    setNavLayout,
    setDefaultNavLayoutLocal,
    restoreDefault,
  } = useNavOrderStore();
  const perms = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const canManageDefaultNav = isRoot || perms.includes('super') || perms.includes('settings.write');
  const [activeScope, setActiveScope] = useState<'mine' | 'all'>('mine');
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [defaultDraftOrder, setDefaultDraftOrder] = useState<string[]>([]);
  const [defaultDraftHidden, setDefaultDraftHidden] = useState<string[]>([]);

  useEffect(() => {
    if (!loaded) void loadFromServer();
  }, [loaded, loadFromServer]);

  useEffect(() => {
    setDefaultDraftOrder(defaultNavOrder);
    setDefaultDraftHidden(defaultNavHidden);
  }, [defaultNavHidden, defaultNavOrder]);

  const navSubTabs = useMemo<TabBarItem[]>(
    () =>
      canManageDefaultNav
        ? [
            { key: 'mine', label: '我的', icon: <UserCircle2 size={14} /> },
            { key: 'all', label: '所有人的', icon: <Users size={14} /> },
          ]
        : [{ key: 'mine', label: '我的', icon: <UserCircle2 size={14} /> }],
    [canManageDefaultNav]
  );

  const mineCustomized = navOrder.length > 0 || navHidden.length > 0;
  const defaultCustomized = defaultDraftOrder.length > 0 || defaultDraftHidden.length > 0;
  const defaultDirty = useMemo(() => {
    return JSON.stringify(defaultDraftOrder) !== JSON.stringify(defaultNavOrder)
      || JSON.stringify(defaultDraftHidden) !== JSON.stringify(defaultNavHidden);
  }, [defaultDraftHidden, defaultDraftOrder, defaultNavHidden, defaultNavOrder]);

  const handleRestoreMine = useCallback(async () => {
    const ok = await systemDialog.confirm({
      title: '恢复我的导航',
      message: '将清空你的导航顺序与隐藏项，并回退到管理员设置的默认导航。确认继续吗？',
      confirmText: '确认恢复',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    await restoreDefault();
    toast.success('已恢复', '你的导航已回退到默认值');
  }, [restoreDefault]);

  const handleSaveDefault = useCallback(async () => {
    setDefaultSaving(true);
    try {
      const res = await updateDefaultNavLayout({
        navOrder: defaultDraftOrder,
        navHidden: defaultDraftHidden,
      });
      if (!res.success) {
        toast.error('保存失败', res.error?.message || '默认导航保存失败');
        return;
      }
      setDefaultNavLayoutLocal({
        navOrder: res.data.navOrder,
        navHidden: res.data.navHidden,
      });
      setDefaultDraftOrder(res.data.navOrder);
      setDefaultDraftHidden(res.data.navHidden);
      toast.success('已保存', '全局默认导航已更新');
    } catch (error) {
      toast.error('保存失败', error instanceof Error ? error.message : '默认导航保存失败');
    } finally {
      setDefaultSaving(false);
    }
  }, [defaultDraftHidden, defaultDraftOrder, setDefaultNavLayoutLocal]);

  const handleRestoreDefaultNav = useCallback(async () => {
    const ok = await systemDialog.confirm({
      title: '恢复系统默认导航',
      message: '将清空“所有人的默认导航”配置，未自定义导航的用户将回退到系统内置顺序。确认继续吗？',
      confirmText: '恢复系统默认',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;

    setDefaultSaving(true);
    try {
      const res = await updateDefaultNavLayout({ navOrder: [], navHidden: [] });
      if (!res.success) {
        toast.error('恢复失败', res.error?.message || '恢复系统默认失败');
        return;
      }
      setDefaultNavLayoutLocal({
        navOrder: res.data.navOrder,
        navHidden: res.data.navHidden,
      });
      setDefaultDraftOrder(res.data.navOrder);
      setDefaultDraftHidden(res.data.navHidden);
      toast.success('已恢复', '默认导航已回退到系统内置顺序');
    } catch (error) {
      toast.error('恢复失败', error instanceof Error ? error.message : '恢复系统默认失败');
    } finally {
      setDefaultSaving(false);
    }
  }, [setDefaultNavLayoutLocal]);

  const handleApplyToAllUsers = useCallback(async () => {
    const ok = await systemDialog.confirm({
      title: '恢复所有用户导航',
      message: '此操作会清空所有用户的个人导航配置，让他们统一回退到“所有人的默认导航”。确认继续吗？',
      confirmText: '恢复所有用户',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;

    setDefaultSaving(true);
    try {
      const res = await applyDefaultNavToAllUsers();
      if (!res.success) {
        toast.error('操作失败', res.error?.message || '恢复所有用户导航失败');
        return;
      }
      await restoreDefault();
      toast.success(
        '已恢复所有用户',
        `本次更新 ${res.data.modifiedCount} 条用户导航记录`
      );
    } catch (error) {
      toast.error('操作失败', error instanceof Error ? error.message : '恢复所有用户导航失败');
    } finally {
      setDefaultSaving(false);
    }
  }, [restoreDefault]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar items={navSubTabs} activeKey={activeScope} onChange={(key) => setActiveScope(key as 'mine' | 'all')} />

      <div className="flex-1 min-h-0">
        {activeScope === 'mine' && (
          <NavLayoutEditor
            navOrder={navOrder}
            navHidden={navHidden}
            fallbackNavOrder={defaultNavOrder}
            fallbackNavHidden={defaultNavHidden}
            loaded={loaded}
            saving={saving}
            onChange={setNavLayout}
            onRestore={() => void handleRestoreMine()}
            restoreDisabled={saving || !mineCustomized}
            restoreLabel="恢复默认"
            restoreTitle={mineCustomized ? '清空个人导航配置，回退到默认导航' : '当前已是默认导航'}
          />
        )}

        {activeScope === 'all' && canManageDefaultNav && (
          <NavLayoutEditor
            navOrder={defaultDraftOrder}
            navHidden={defaultDraftHidden}
            loaded={loaded}
            saving={defaultSaving}
            saveLabel="处理中..."
            onChange={({ navOrder: nextOrder, navHidden: nextHidden }) => {
              setDefaultDraftOrder(nextOrder);
              setDefaultDraftHidden(nextHidden);
            }}
            onRestore={() => void handleRestoreDefaultNav()}
            restoreDisabled={defaultSaving || !defaultCustomized}
            restoreLabel="恢复系统默认"
            restoreTitle={defaultCustomized ? '清空全局默认导航配置' : '当前已是系统内置默认导航'}
            restoreVariant="danger"
            headerActions={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleApplyToAllUsers()}
                  disabled={defaultSaving}
                  title="清空所有用户的个人导航配置，统一回退到默认导航"
                >
                  <Users size={14} />
                  恢复所有用户
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSaveDefault()}
                  disabled={defaultSaving || !defaultDirty}
                  title={defaultDirty ? '保存当前默认导航配置' : '当前没有未保存修改'}
                >
                  <Save size={14} />
                  保存默认导航
                </Button>
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const perms = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  const tabs = useMemo(() => {
    const list: TabBarItem[] = [
      { key: 'user-space', label: '我的空间', icon: <Sparkles size={14} /> },
      { key: 'account', label: '账户管理', icon: <UserCircle2 size={14} /> },
      { key: 'skin', label: '皮肤设置', icon: <Palette size={14} /> },
      { key: 'nav-order', label: '导航顺序', icon: <ListOrdered size={14} /> },
    ];

    const hasPerm = (perm: string) => isRoot || perms.includes(perm) || perms.includes('super');
    if (hasPerm('assets.read')) list.push({ key: 'assets', label: '资源管理', icon: <Image size={14} /> });
    if (hasPerm('authz.manage')) list.push({ key: 'authz', label: '权限管理', icon: <UserCog size={14} /> });
    if (hasPerm('data.read')) list.push({ key: 'data', label: '数据管理', icon: <Database size={14} /> });
    if (hasPerm('settings.write')) list.push({ key: 'update-accel', label: '更新加速', icon: <Zap size={14} /> });
    if (hasPerm('daily-tips.read')) list.push({ key: 'daily-tips', label: '小技巧', icon: <Sparkles size={14} /> });
    return list;
  }, [isRoot, perms]);

  const tabFromUrl = searchParams.get('tab') || 'user-space';
  const [activeTab, setActiveTab] = useState(tabFromUrl);

  useEffect(() => {
    const currentTab = searchParams.get('tab');
    if (currentTab && currentTab !== activeTab) {
      setActiveTab(currentTab);
    }
  }, [activeTab, searchParams]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    setSearchParams({ tab: key });
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar items={tabs} activeKey={activeTab} onChange={handleTabChange} />

      <div className="flex-1 min-h-0">
        {activeTab === 'user-space' && <UserSpaceSettings />}
        {activeTab === 'account' && <AccountSettings />}
        {activeTab === 'skin' && <SkinSettings />}
        {activeTab === 'nav-order' && <NavOrderSettings />}
        {activeTab === 'assets' && <AssetsManagePage />}
        {activeTab === 'authz' && <AuthzPage />}
        {activeTab === 'data' && <DataManagePage />}
        {activeTab === 'update-accel' && <UpdateAccelerationSettings />}
        {activeTab === 'daily-tips' && <DailyTipsEditor />}
      </div>
    </div>
  );
}
