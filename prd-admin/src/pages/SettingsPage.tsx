import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import type { TabBarItem } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useNavOrderStore, NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { useAuthStore } from '@/stores/authStore';
import { Palette, RotateCcw, Image, UserCog, UserCircle2, Database, ListOrdered, Zap, Sparkles, Plus, X, Minus } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import * as LucideIcons from 'lucide-react';
import { ThemeSkinEditor } from '@/pages/settings/ThemeSkinEditor';
import AssetsManagePage from '@/pages/AssetsManagePage';
import AuthzPage from '@/pages/AuthzPage';
import DataManagePage from '@/pages/DataManagePage';
import { UpdateAccelerationSettings } from '@/pages/settings/UpdateAccelerationSettings';
import { UserSpaceSettings } from '@/pages/settings/UserSpaceSettings';
import { AccountSettings } from '@/pages/settings/AccountSettings';

interface NavMetaItem {
  appKey: string;
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

/**
 * 导航设置页签：横向双区拖拽 UI
 *
 * - 上方"我的导航"：用户当前左侧导航的顺序和隐藏配置（横向长条）
 *   · 拖拽条目重排
 *   · 点 × 移除到"可添加"区
 *   · 段与段之间的"---"哨兵渲染为一根短横杆（可拖、可删）
 *   · 点 + 按钮在末尾追加一根分隔符
 * - 下方"可添加"：候选池（后端菜单 - 已在我的导航中的项）
 *   · 拖到上面即加入
 *   · 点 + 也可直接追加到末尾
 * - 右上"恢复如初"按钮 → 确认后清空 navOrder + navHidden
 */
type DragSource =
  | { type: 'nav-item'; index: number }
  | { type: 'nav-divider'; index: number }
  | { type: 'pool-item'; appKey: string };

function NavOrderSettings() {
  const {
    navOrder,
    navHidden,
    loaded,
    saving,
    loadFromServer,
    setNavLayout,
    restoreDefault,
  } = useNavOrderStore();
  const menuCatalog = useAuthStore((s) => s.menuCatalog);

  // 候选元数据：后端菜单目录 → appKey → {label, icon}
  const metaByAppKey = useMemo(() => {
    const m = new Map<string, NavMetaItem>();
    (menuCatalog ?? []).forEach((entry) => {
      // 仅包含属于侧边栏分组的条目（group 为 'home' 也保留在 meta 里，但不用于候选池）
      if (!entry.group) return;
      m.set(entry.appKey, { appKey: entry.appKey, label: entry.label, icon: entry.icon });
    });
    return m;
  }, [menuCatalog]);

  // 首次加载
  useEffect(() => {
    if (!loaded) void loadFromServer();
  }, [loaded, loadFromServer]);

  // 规范化的"当前导航"：以 navOrder 为主；若为空，用系统默认顺序 + 过滤隐藏
  //  - 结果数组元素：appKey 或 NAV_DIVIDER_KEY
  const currentOrder = useMemo<string[]>(() => {
    if (navOrder.length > 0) {
      return navOrder;
    }
    // 默认顺序：按菜单目录（后端顺序，已经按 group 分组排好）
    const list = (menuCatalog ?? [])
      .filter((m) => m.group && m.group !== 'home')
      .map((m) => m.appKey);
    return list;
  }, [navOrder, menuCatalog]);

  // 候选池：所有已知非 home 菜单项 - 已在 currentOrder 中的项
  const poolItems = useMemo<NavMetaItem[]>(() => {
    const inNav = new Set(currentOrder.filter((k) => k !== NAV_DIVIDER_KEY));
    const result: NavMetaItem[] = [];
    for (const meta of metaByAppKey.values()) {
      if (!inNav.has(meta.appKey)) {
        result.push(meta);
      }
    }
    return result;
  }, [currentOrder, metaByAppKey]);

  // 是否自定义过（用于"恢复如初"按钮的 disabled 判断）
  const customized = navOrder.length > 0 || navHidden.length > 0;

  // ── 拖拽状态 ────────────────────────────────────────────
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverNavIndex, setDragOverNavIndex] = useState<number | null>(null);
  const [dragOverPool, setDragOverPool] = useState(false);

  const clearDragState = useCallback(() => {
    setDragSource(null);
    setDragOverNavIndex(null);
    setDragOverPool(false);
  }, []);

  // 将 source 插入到 nav 的 targetIndex 位置（规范化连续分隔符）
  const performDropToNav = useCallback(
    (source: DragSource, targetIndex: number) => {
      let nextOrder = [...currentOrder];

      if (source.type === 'nav-item' || source.type === 'nav-divider') {
        const [removed] = nextOrder.splice(source.index, 1);
        // 调整 targetIndex：源在目标之前，移除后 target 位左移一格
        const adjusted = source.index < targetIndex ? targetIndex - 1 : targetIndex;
        nextOrder.splice(adjusted, 0, removed);
      } else {
        // pool-item
        nextOrder.splice(targetIndex, 0, source.appKey);
      }

      // 规范化：折叠首尾和连续的分隔符
      nextOrder = collapseDividers(nextOrder);

      // 计算新的 hidden：出现在 nav 里的 appKey 从 hidden 中移除
      const navSet = new Set(nextOrder.filter((k) => k !== NAV_DIVIDER_KEY));
      const nextHidden = navHidden.filter((k) => !navSet.has(k));

      setNavLayout({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, setNavLayout]
  );

  // 从 nav 移除指定位置的项（放回候选池）
  const removeFromNav = useCallback(
    (index: number) => {
      const removed = currentOrder[index];
      const nextOrder = collapseDividers(
        currentOrder.filter((_, i) => i !== index)
      );
      const nextHidden = [...navHidden];
      if (removed !== NAV_DIVIDER_KEY && !nextHidden.includes(removed)) {
        nextHidden.push(removed);
      }
      setNavLayout({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, setNavLayout]
  );

  // 把 pool 中的项追加到 nav 末尾
  const appendFromPool = useCallback(
    (appKey: string) => {
      const nextOrder = collapseDividers([...currentOrder, appKey]);
      const nextHidden = navHidden.filter((k) => k !== appKey);
      setNavLayout({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, setNavLayout]
  );

  // 追加分隔符到末尾
  const appendDivider = useCallback(() => {
    const nextOrder = collapseDividers([...currentOrder, NAV_DIVIDER_KEY]);
    setNavLayout({ navOrder: nextOrder, navHidden });
  }, [currentOrder, navHidden, setNavLayout]);

  // 恢复如初
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const handleRestore = useCallback(async () => {
    setConfirmRestoreOpen(false);
    await restoreDefault();
  }, [restoreDefault]);

  // 拖拽事件
  const handleDragStartNav = (index: number, isDivider: boolean) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'nav-drag');
    setDragSource(isDivider ? { type: 'nav-divider', index } : { type: 'nav-item', index });
  };
  const handleDragStartPool = (appKey: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'pool-drag');
    setDragSource({ type: 'pool-item', appKey });
  };
  const handleDragOverNavSlot = (index: number) => (e: React.DragEvent) => {
    if (!dragSource) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverNavIndex !== index) setDragOverNavIndex(index);
  };
  const handleDropNavSlot = (index: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragSource) {
      performDropToNav(dragSource, index);
    }
    clearDragState();
  };
  const handleDragOverPool = (e: React.DragEvent) => {
    if (!dragSource || dragSource.type === 'pool-item') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverPool(true);
  };
  const handleDropPool = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragSource && dragSource.type === 'nav-item') {
      removeFromNav(dragSource.index);
    } else if (dragSource && dragSource.type === 'nav-divider') {
      // 分隔符拖到候选池 = 删除分隔符
      const nextOrder = collapseDividers(currentOrder.filter((_, i) => i !== dragSource.index));
      setNavLayout({ navOrder: nextOrder, navHidden });
    }
    clearDragState();
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-x-hidden overflow-y-auto">
      {/* 顶部说明 + 恢复如初 */}
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
            导航栏自定义
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            拖拽调整左侧导航的顺序，点 × 移除，点 + 添加。中间的短横杆是分隔横杆（仅视觉分组，不限制内容）。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && (
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <MapSpinner size={12} />
              保存中...
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirmRestoreOpen(true)}
            disabled={saving || !customized}
            title={customized ? '清空自定义配置，恢复系统默认' : '当前已是默认状态'}
          >
            <RotateCcw size={14} />
            恢复如初
          </Button>
        </div>
      </div>

      {/* ── 我的导航（横向长条） ── */}
      <GlassCard animated glow accentHue={210} className="shrink-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            我的导航
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={appendDivider}
            title="在末尾加一根分隔横杆"
          >
            <Minus size={14} />
            加分隔
          </Button>
        </div>
        <div
          className="relative rounded-[12px] p-3 flex items-center gap-2 overflow-x-auto"
          style={{
            background: 'var(--nested-block-bg)',
            border: '1px solid var(--nested-block-border)',
            minHeight: 74,
          }}
        >
          {/* "顶部" 标识 */}
          <span
            className="shrink-0 select-none text-[10px] font-mono px-2 py-1 rounded"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}
          >
            顶部
          </span>

          {/* 条目列表 */}
          {currentOrder.map((token, idx) => {
            const isDivider = token === NAV_DIVIDER_KEY;
            const meta = isDivider ? null : metaByAppKey.get(token);
            return (
              <Fragment key={`nav-${idx}-${token}`}>
                {/* 拖放槽（在每一项之前） */}
                <NavDropSlot
                  active={dragOverNavIndex === idx && !!dragSource}
                  onDragOver={handleDragOverNavSlot(idx)}
                  onDrop={handleDropNavSlot(idx)}
                />
                {isDivider ? (
                  <DividerChip
                    onDragStart={handleDragStartNav(idx, true)}
                    onRemove={() => {
                      const next = collapseDividers(currentOrder.filter((_, i) => i !== idx));
                      setNavLayout({ navOrder: next, navHidden });
                    }}
                  />
                ) : meta ? (
                  <NavItemChip
                    meta={meta}
                    getIcon={getIcon}
                    onDragStart={handleDragStartNav(idx, false)}
                    onRemove={() => removeFromNav(idx)}
                  />
                ) : null}
              </Fragment>
            );
          })}
          {/* 末尾拖放槽 */}
          <NavDropSlot
            active={dragOverNavIndex === currentOrder.length && !!dragSource}
            onDragOver={handleDragOverNavSlot(currentOrder.length)}
            onDrop={handleDropNavSlot(currentOrder.length)}
          />

          {/* "底部" 标识 */}
          <span
            className="shrink-0 select-none text-[10px] font-mono px-2 py-1 rounded"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}
          >
            底部
          </span>
        </div>
      </GlassCard>

      {/* ── 可添加（候选池） ── */}
      <GlassCard animated glow accentHue={180} className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            可添加
          </div>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            拖到上方，或点 + 直接追加到末尾
          </span>
        </div>
        <div
          className="rounded-[12px] p-3 flex flex-wrap gap-2 min-h-[90px] flex-1 overflow-y-auto content-start"
          style={{
            background: dragOverPool ? 'rgba(99,102,241,0.08)' : 'var(--nested-block-bg)',
            border: `1px ${dragOverPool ? 'dashed rgba(99,102,241,0.5)' : 'solid var(--nested-block-border)'}`,
          }}
          onDragOver={handleDragOverPool}
          onDragLeave={() => setDragOverPool(false)}
          onDrop={handleDropPool}
        >
          {poolItems.length === 0 && (
            <div className="w-full text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {loaded ? '所有可用条目都已在导航中 —— 拖一个下来就回到这里' : '加载中...'}
            </div>
          )}
          {poolItems.map((meta) => (
            <PoolItemChip
              key={meta.appKey}
              meta={meta}
              getIcon={getIcon}
              onDragStart={handleDragStartPool(meta.appKey)}
              onAppend={() => appendFromPool(meta.appKey)}
            />
          ))}
        </div>
      </GlassCard>

      {/* 恢复如初 确认弹窗 */}
      {confirmRestoreOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => setConfirmRestoreOpen(false)}
        >
          <div
            className="rounded-[12px] p-5 max-w-sm mx-4"
            style={{
              background: 'var(--card-bg, #1e1e24)',
              border: '1px solid var(--nested-block-border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              恢复如初？
            </div>
            <div className="text-[12px] mb-4" style={{ color: 'var(--text-secondary)' }}>
              将清空你的导航顺序与隐藏项，回到系统默认。你的账号其他设置不受影响。
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmRestoreOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handleRestore()}>
                恢复
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 子组件：导航项 Chip ────────────────────────────────────────
function NavItemChip({
  meta,
  getIcon,
  onDragStart,
  onRemove,
}: {
  meta: NavMetaItem;
  getIcon: (name: string, size?: number) => React.ReactNode;
  onDragStart: (e: React.DragEvent) => void;
  onRemove: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] cursor-grab active:cursor-grabbing"
      style={{
        background: 'var(--bg-card-hover)',
        border: '1px solid var(--border-subtle)',
      }}
      title={`${meta.label}（拖动重排 / 点 × 移除）`}
    >
      <span style={{ color: 'var(--text-secondary)' }}>{getIcon(meta.icon, 14)}</span>
      <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {meta.label}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 w-4 h-4 flex items-center justify-center rounded"
        style={{ color: 'var(--text-muted)' }}
        title="从导航中移除"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// ── 子组件：分隔横杆 Chip ──────────────────────────────────────
function DividerChip({
  onDragStart,
  onRemove,
}: {
  onDragStart: (e: React.DragEvent) => void;
  onRemove: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group shrink-0 relative flex items-center justify-center cursor-grab active:cursor-grabbing"
      style={{ width: 34, height: 32 }}
      title="分隔横杆（拖动移动 / 点 × 删除）"
    >
      <div
        style={{
          width: 24,
          height: 2,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.22)',
        }}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity w-4 h-4 flex items-center justify-center rounded"
        style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}
      >
        <X size={10} />
      </button>
    </div>
  );
}

// ── 子组件：拖放槽（条目之间的细空槽） ─────────────────────────
function NavDropSlot({
  active,
  onDragOver,
  onDrop,
}: {
  active: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="shrink-0 transition-all duration-100"
      style={{
        width: active ? 12 : 4,
        height: 40,
        background: active ? 'rgba(99,102,241,0.45)' : 'transparent',
        borderRadius: 2,
      }}
    />
  );
}

// ── 子组件：候选池 Chip ────────────────────────────────────────
function PoolItemChip({
  meta,
  getIcon,
  onDragStart,
  onAppend,
}: {
  meta: NavMetaItem;
  getIcon: (name: string, size?: number) => React.ReactNode;
  onDragStart: (e: React.DragEvent) => void;
  onAppend: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] cursor-grab active:cursor-grabbing"
      style={{
        background: 'var(--bg-card-hover)',
        border: '1px dashed var(--border-subtle)',
      }}
      title={`${meta.label}（拖到我的导航，或点 + 追加到末尾）`}
    >
      <span style={{ color: 'var(--text-muted)' }}>{getIcon(meta.icon, 14)}</span>
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {meta.label}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAppend();
        }}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-60 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--text-secondary)' }}
        title="追加到我的导航末尾"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

// ── 工具：折叠连续分隔符 + 去首尾分隔符 ─────────────────────────
function collapseDividers(arr: string[]): string[] {
  const result: string[] = [];
  for (const token of arr) {
    if (token === NAV_DIVIDER_KEY) {
      // 跳过首位与前一个已经是分隔符的情况
      if (result.length === 0) continue;
      if (result[result.length - 1] === NAV_DIVIDER_KEY) continue;
      result.push(token);
    } else {
      result.push(token);
    }
  }
  // 去尾部分隔符
  while (result.length > 0 && result[result.length - 1] === NAV_DIVIDER_KEY) {
    result.pop();
  }
  return result;
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const perms = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  // 根据权限构建可见 tab 列表
  const tabs = useMemo(() => {
    const list: TabBarItem[] = [
      { key: 'user-space', label: '我的空间', icon: <Sparkles size={14} /> },
      { key: 'account', label: '账户管理', icon: <UserCircle2 size={14} /> },
      { key: 'skin', label: '皮肤设置', icon: <Palette size={14} /> },
      { key: 'nav-order', label: '导航顺序', icon: <ListOrdered size={14} /> },
    ];
    const hasPerm = (p: string) => isRoot || perms.includes(p) || perms.includes('super');
    if (hasPerm('assets.read')) list.push({ key: 'assets', label: '资源管理', icon: <Image size={14} /> });
    if (hasPerm('authz.manage')) list.push({ key: 'authz', label: '权限管理', icon: <UserCog size={14} /> });
    if (hasPerm('data.read')) list.push({ key: 'data', label: '数据管理', icon: <Database size={14} /> });
    if (hasPerm('settings.write')) list.push({ key: 'update-accel', label: '更新加速', icon: <Zap size={14} /> });
    return list;
  }, [perms, isRoot]);

  const tabFromUrl = searchParams.get('tab') || 'user-space';
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
        {activeTab === 'user-space' && <UserSpaceSettings />}
        {activeTab === 'account' && <AccountSettings />}
        {activeTab === 'skin' && <SkinSettings />}
        {activeTab === 'nav-order' && <NavOrderSettings />}
        {activeTab === 'assets' && <AssetsManagePage />}
        {activeTab === 'authz' && <AuthzPage />}
        {activeTab === 'data' && <DataManagePage />}
        {activeTab === 'update-accel' && <UpdateAccelerationSettings />}
      </div>
    </div>
  );
}
