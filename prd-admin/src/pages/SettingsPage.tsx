import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import type { TabBarItem } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useNavOrderStore } from '@/stores/navOrderStore';
import { useAuthStore } from '@/stores/authStore';
import { GripVertical, Palette, RefreshCw, RotateCcw, Image, UserCog, Database, ListOrdered } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { ThemeSkinEditor } from '@/pages/settings/ThemeSkinEditor';
import AssetsManagePage from '@/pages/AssetsManagePage';
import AuthzPage from '@/pages/AuthzPage';
import DataManagePage from '@/pages/DataManagePage';

interface NavItem {
  key: string;
  label: string;
  icon: string;
}

// 动态获取 Lucide 图标
function getIcon(name: string, size = 16) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IconComponent = (LucideIcons as any)[name];
  if (IconComponent) {
    return <IconComponent size={size} />;
  }
  return <LucideIcons.Circle size={size} />;
}

/** 皮肤设置页签内容 */
function SkinSettings() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <ThemeSkinEditor />
    </div>
  );
}

/** 导航顺序页签内容 */
function NavOrderSettings() {
  const { navOrder, loaded, saving, loadFromServer, setNavOrder, reset } = useNavOrderStore();
  const menuCatalog = useAuthStore((s) => s.menuCatalog);

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 从后端菜单目录构建导航项
  const sortedItems: NavItem[] = useMemo(() => {
    if (!Array.isArray(menuCatalog) || menuCatalog.length === 0) return [];

    const items = menuCatalog.map((m) => ({
      key: m.appKey,
      label: m.label,
      icon: m.icon,
    }));

    if (navOrder.length > 0) {
      const orderMap = new Map(navOrder.map((k, i) => [k, i]));
      items.sort((a, b) => {
        const aOrder = orderMap.get(a.key) ?? 9999;
        const bOrder = orderMap.get(b.key) ?? 9999;
        return aOrder - bOrder;
      });
    }

    return items;
  }, [menuCatalog, navOrder]);

  // 首次加载
  useEffect(() => {
    if (!loaded) {
      void loadFromServer();
    }
  }, [loaded, loadFromServer]);

  // 简单拖拽处理
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggingIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  }, [dragOverIndex]);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      const sourceIndex = draggingIndex;
      setDraggingIndex(null);
      setDragOverIndex(null);

      if (sourceIndex === null || sourceIndex === targetIndex) return;

      const newOrder = [...sortedItems.map((it) => it.key)];
      const [removed] = newOrder.splice(sourceIndex, 1);
      newOrder.splice(targetIndex, 0, removed);
      setNavOrder(newOrder);
    },
    [draggingIndex, sortedItems, setNavOrder]
  );

  const handleDragEnd = useCallback(() => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleReset = useCallback(() => {
    reset();
    void loadFromServer();
  }, [reset, loadFromServer]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden overflow-y-auto">
      {/* 操作按钮 */}
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="secondary" size="sm" onClick={() => void loadFromServer()} disabled={saving}>
          <RefreshCw size={14} className={saving ? 'animate-spin' : ''} />
          刷新
        </Button>
        <Button variant="secondary" size="sm" onClick={handleReset} disabled={saving}>
          <RotateCcw size={14} />
          重置
        </Button>
      </div>

      {/* 导航顺序设置 */}
      <div className="flex-1 min-h-0 flex flex-col max-w-lg">
        <GlassCard animated glow accentHue={210} className="h-full flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
            <div>
              <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
                导航顺序
              </h2>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                拖拽调整左侧导航菜单的显示顺序
              </p>
            </div>
            {saving && (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                <RefreshCw size={12} className="animate-spin" />
                保存中...
              </div>
            )}
          </div>

          {/* 列表容器：隐藏滚动条 + 底部阴影渐隐 */}
          <div className="relative flex-1 min-h-0">
            <div
              className="h-full overflow-y-auto pr-1"
              style={{
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
              }}
            >
              <style>{`
                .nav-order-list::-webkit-scrollbar { display: none; }
              `}</style>
              <div className="nav-order-list space-y-1.5 pb-6">
                {sortedItems.map((item, index) => {
                  const isDragging = draggingIndex === index;
                  const isDropTarget = dragOverIndex === index && draggingIndex !== index;

                  return (
                    <div
                      key={item.key}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDrop={(e) => handleDrop(e, index)}
                      onDragEnd={handleDragEnd}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-grab active:cursor-grabbing"
                      style={{
                        background: isDragging
                          ? 'rgba(214,178,106,0.15)'
                          : isDropTarget
                            ? 'rgba(214,178,106,0.08)'
                            : 'var(--nested-block-bg)',
                        border: isDragging
                          ? '2px solid rgba(214,178,106,0.5)'
                          : isDropTarget
                            ? '2px dashed rgba(214,178,106,0.5)'
                            : '1px solid var(--nested-block-border)',
                        opacity: isDragging ? 0.6 : 1,
                      }}
                    >
                      <div
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <GripVertical size={14} />
                      </div>
                      <div
                        className="shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center"
                        style={{
                          background: 'var(--bg-card-hover)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {getIcon(item.icon, 16)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {item.label}
                        </div>
                      </div>
                      <div
                        className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded"
                        style={{
                          background: 'var(--bg-input)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {index + 1}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* 底部阴影渐隐遮罩 */}
            <div
              className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
              style={{
                background: 'linear-gradient(to top, var(--card-bg, rgba(30,30,35,0.95)) 0%, transparent 100%)',
              }}
            />
          </div>

          {sortedItems.length === 0 && (
            <div
              className="text-center py-8 text-sm"
              style={{ color: 'var(--text-muted)' }}
            >
              {loaded ? '暂无可显示的导航项' : '加载中...'}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const perms = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  // 根据权限构建可见 tab 列表
  const tabs = useMemo(() => {
    const list: TabBarItem[] = [
      { key: 'skin', label: '皮肤设置', icon: <Palette size={14} /> },
      { key: 'nav-order', label: '导航顺序', icon: <ListOrdered size={14} /> },
    ];
    const hasPerm = (p: string) => isRoot || perms.includes(p) || perms.includes('super');
    if (hasPerm('assets.read')) list.push({ key: 'assets', label: '资源管理', icon: <Image size={14} /> });
    if (hasPerm('authz.manage')) list.push({ key: 'authz', label: '权限管理', icon: <UserCog size={14} /> });
    if (hasPerm('data.read')) list.push({ key: 'data', label: '数据管理', icon: <Database size={14} /> });
    return list;
  }, [perms, isRoot]);

  const tabFromUrl = searchParams.get('tab') || 'skin';
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
    <div className="h-full min-h-0 flex flex-col gap-5">
      <TabBar
        items={tabs}
        activeKey={activeTab}
        onChange={handleTabChange}
      />

      <div className="flex-1 min-h-0">
        {activeTab === 'skin' && <SkinSettings />}
        {activeTab === 'nav-order' && <NavOrderSettings />}
        {activeTab === 'assets' && <AssetsManagePage />}
        {activeTab === 'authz' && <AuthzPage />}
        {activeTab === 'data' && <DataManagePage />}
      </div>
    </div>
  );
}
