import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import type { TabBarItem } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useNavOrderStore, NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { useAuthStore } from '@/stores/authStore';
import { getLauncherCatalog, LAUNCHER_GROUP_LABELS } from '@/lib/launcherCatalog';
import { getShortLabel } from '@/lib/shortLabel';
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
import { DailyTipsEditor } from '@/pages/settings/DailyTipsEditor';

/** 导航候选项元数据（key 可以是菜单 appKey 或 launcher id，如 "agent:prd-agent"） */
interface NavMetaItem {
  navKey: string;
  label: string;
  /** 折叠态短标签（与 AppShell 侧边栏 collapsed 态一致） */
  shortLabel: string;
  icon: string;
  /** 分组（用于候选池分组展示，以及默认顺序生成分隔符）
   *  - 'tools' | 'personal' | 'admin' : 来自后端 menuCatalog
   *  - 'agent' | 'toolbox' | 'utility' : 来自 launcherCatalog
   */
  group: string;
  /** 来源：menu（后端菜单） / launcher（Cmd+K 目录） */
  source: 'menu' | 'launcher';
}

/** 后端默认导航分组顺序（与 AppShell NAV_GROUPS 对齐） */
const DEFAULT_NAV_GROUPS_ORDER: string[] = ['tools', 'personal', 'admin'];

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
  | { type: 'pool-item'; navKey: string };

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
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  /**
   * 统一元数据查询表：
   * - 后端菜单目录（按 appKey 入表，权威来源）
   * - launcher catalog（按 launcher id 入表，路由已被 menuCatalog 覆盖的条目跳过避免重复）
   */
  const metaByKey = useMemo(() => {
    const m = new Map<string, NavMetaItem>();
    const routesUsed = new Set<string>();

    // 1) 后端菜单目录：仅带 group 的条目（含 'home'，首页由候选池隐藏）
    (menuCatalog ?? []).forEach((entry) => {
      if (!entry.group) return;
      m.set(entry.appKey, {
        navKey: entry.appKey,
        label: entry.label,
        shortLabel: getShortLabel(entry.appKey, entry.label),
        icon: entry.icon,
        group: entry.group,
        source: 'menu',
      });
      routesUsed.add(entry.path);
    });

    // 2) launcher catalog：按 id 入表，已被 menuCatalog 路由覆盖的跳过；
    //    「设置」本页自己不作为候选，避免循环导航
    const launcher = getLauncherCatalog({ permissions, isRoot });
    launcher.forEach((li) => {
      if (routesUsed.has(li.route)) return;
      if (li.id === 'utility:settings') return;
      m.set(li.id, {
        navKey: li.id,
        label: li.name,
        shortLabel: getShortLabel(li.agentKey ?? li.id, li.name),
        icon: li.icon,
        group: li.group,
        source: 'launcher',
      });
    });

    return m;
  }, [menuCatalog, permissions, isRoot]);

  // 首次加载
  useEffect(() => {
    if (!loaded) void loadFromServer();
  }, [loaded, loadFromServer]);

  /**
   * 规范化的"当前导航"：以 navOrder 为主；若为空，按后端 group 字段生成默认顺序，
   * 并在分组切换处插入 NAV_DIVIDER_KEY，视觉上与 AppShell 默认分段一致。
   * 这样用户第一次进入设置页看到的就是"现成的默认布局"（带横杆），
   * 点"恢复如初"对用户来说是"原地不动"，不会突然把横杆还回去。
   */
  const currentOrder = useMemo<string[]>(() => {
    if (navOrder.length > 0) {
      return navOrder;
    }
    // 默认顺序：按 menuCatalog 的 group 字段分段 + 段间分隔符
    const byGroup: Record<string, string[]> = {};
    (menuCatalog ?? []).forEach((item) => {
      if (!item.group || item.group === 'home') return;
      (byGroup[item.group] ??= []).push(item.appKey);
    });
    const result: string[] = [];
    DEFAULT_NAV_GROUPS_ORDER.forEach((g) => {
      const items = byGroup[g] ?? [];
      if (items.length === 0) return;
      if (result.length > 0) result.push(NAV_DIVIDER_KEY);
      result.push(...items);
    });
    return result;
  }, [navOrder, menuCatalog]);

  /**
   * 候选池：metaByKey 中"不在 currentOrder 里"的条目。
   * 按 launcher group（agent / toolbox / utility）分段展示；后端菜单项归入 "menu" 段。
   */
  // 首页在侧栏固定展示，不参与自定义排序，不进候选池
  const homeMeta = useMemo<NavMetaItem | null>(() => {
    for (const meta of metaByKey.values()) {
      if (meta.group === 'home') return meta;
    }
    return null;
  }, [metaByKey]);

  const poolGroups = useMemo<{ key: string; label: string; items: NavMetaItem[] }[]>(() => {
    const inNav = new Set(currentOrder.filter((k) => k !== NAV_DIVIDER_KEY));
    const bucket: Record<string, NavMetaItem[]> = {};
    for (const meta of metaByKey.values()) {
      if (inNav.has(meta.navKey)) continue;
      if (meta.group === 'home') continue; // 首页在"我的导航"开头固定展示，不进候选池
      // 后端菜单项统一放在 "menu" 桶
      const bucketKey = meta.source === 'launcher' ? meta.group : 'menu';
      (bucket[bucketKey] ??= []).push(meta);
    }
    // 稳定顺序：菜单兜底项 → Agent → 百宝箱 → 实用工具
    const order: { key: string; label: string }[] = [
      { key: 'menu', label: '其他菜单' },
      { key: 'agent', label: LAUNCHER_GROUP_LABELS.agent },
      { key: 'toolbox', label: LAUNCHER_GROUP_LABELS.toolbox },
      { key: 'utility', label: LAUNCHER_GROUP_LABELS.utility },
    ];
    return order
      .map(({ key, label }) => ({ key, label, items: bucket[key] ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [currentOrder, metaByKey]);

  const poolIsEmpty = poolGroups.length === 0;

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
        nextOrder.splice(targetIndex, 0, source.navKey);
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
    (navKey: string) => {
      const nextOrder = collapseDividers([...currentOrder, navKey]);
      const nextHidden = navHidden.filter((k) => k !== navKey);
      setNavLayout({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, setNavLayout]
  );

  // 在末尾附近插入一根分隔符 —— collapseDividers 会剥掉真正末尾的分隔符
  // （尾部分隔符无意义），因此插入到倒数第二位（最后一个条目之前），
  // 保证用户点击后"我的导航"里立刻看到新横杆，可以再拖动到任意位置。
  const appendDivider = useCallback(() => {
    const base = [...currentOrder];
    // 剥掉末尾已有的分隔符，避免插入后出现连续两根
    while (base.length > 0 && base[base.length - 1] === NAV_DIVIDER_KEY) base.pop();
    if (base.length === 0) {
      // 极端情况：导航被清空，直接忽略（分隔符不能独存）
      return;
    }
    const insertAt = Math.max(0, base.length - 1);
    const withDivider = [...base.slice(0, insertAt), NAV_DIVIDER_KEY, ...base.slice(insertAt)];
    const nextOrder = collapseDividers(withDivider);
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
  const handleDragStartPool = (navKey: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'pool-drag');
    setDragSource({ type: 'pool-item', navKey });
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

          {/* 固定首页（侧栏恒常显示，不可移动） */}
          {homeMeta && <FixedHomeChip meta={homeMeta} getIcon={getIcon} />}

          {/* 条目列表 */}
          {currentOrder.map((token, idx) => {
            const isDivider = token === NAV_DIVIDER_KEY;
            const meta = isDivider ? null : metaByKey.get(token);
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
                    onDragEnd={clearDragState}
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
                    onDragEnd={clearDragState}
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
            拖到上方，或点 + 直接追加到末尾 · 数据来源与 Cmd+K 一致
          </span>
        </div>
        <div
          className="rounded-[12px] p-3 min-h-[90px] flex-1 overflow-y-auto"
          style={{
            background: dragOverPool ? 'rgba(99,102,241,0.08)' : 'var(--nested-block-bg)',
            border: `1px ${dragOverPool ? 'dashed rgba(99,102,241,0.5)' : 'solid var(--nested-block-border)'}`,
          }}
          onDragOver={handleDragOverPool}
          onDragLeave={() => setDragOverPool(false)}
          onDrop={handleDropPool}
        >
          {poolIsEmpty && (
            <div className="w-full text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {loaded ? '所有可用条目都已在导航中 —— 拖一个下来就回到这里' : '加载中...'}
            </div>
          )}
          {poolGroups.map((g) => (
            <div key={g.key} className="mb-3 last:mb-0">
              <div
                className="text-[10px] font-mono uppercase tracking-wider mb-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                {g.label} · {g.items.length}
              </div>
              <div className="flex flex-wrap gap-2">
                {g.items.map((meta) => (
                  <PoolItemChip
                    key={meta.navKey}
                    meta={meta}
                    getIcon={getIcon}
                    onDragStart={handleDragStartPool(meta.navKey)}
                    onDragEnd={clearDragState}
                    onAppend={() => appendFromPool(meta.navKey)}
                  />
                ))}
              </div>
            </div>
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

// ── 子组件：导航项 Chip（紧凑竖排，与侧栏折叠态一致） ───────────
function NavItemChip({
  meta,
  getIcon,
  onDragStart,
  onDragEnd,
  onRemove,
}: {
  meta: NavMetaItem;
  getIcon: (name: string, size?: number) => React.ReactNode;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group relative shrink-0 flex flex-col items-center justify-center gap-0 rounded-[10px] cursor-grab active:cursor-grabbing"
      style={{
        width: 56,
        padding: '6px 0 4px',
        background: 'var(--bg-card-hover)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
      }}
      title={`${meta.label}（拖动重排 / 点 × 移除）`}
    >
      <span className="inline-flex items-center justify-center" style={{ width: 28, height: 28 }}>
        {getIcon(meta.icon, 18)}
      </span>
      <span
        className="text-[10px] leading-tight text-center mt-0.5 px-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {meta.shortLabel}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center rounded"
        style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.25)' }}
        title="从导航中移除"
      >
        <X size={10} />
      </button>
    </div>
  );
}

// ── 子组件：固定首页 Chip（不可拖动不可移除） ───────────────────
function FixedHomeChip({
  meta,
  getIcon,
}: {
  meta: NavMetaItem;
  getIcon: (name: string, size?: number) => React.ReactNode;
}) {
  return (
    <div
      className="shrink-0 flex flex-col items-center justify-center gap-0 rounded-[10px]"
      style={{
        width: 56,
        padding: '6px 0 4px',
        background: 'var(--bg-card-hover)',
        border: '1px dashed var(--border-subtle)',
        color: 'var(--text-secondary)',
        opacity: 0.85,
      }}
      title={`${meta.label}（固定在侧栏顶部，不可移除）`}
    >
      <span className="inline-flex items-center justify-center" style={{ width: 28, height: 28 }}>
        {getIcon(meta.icon, 18)}
      </span>
      <span
        className="text-[10px] leading-tight text-center mt-0.5 px-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {meta.shortLabel}
      </span>
    </div>
  );
}

// ── 子组件：分隔横杆 Chip ──────────────────────────────────────
function DividerChip({
  onDragStart,
  onDragEnd,
  onRemove,
}: {
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group shrink-0 relative flex items-center justify-center cursor-grab active:cursor-grabbing"
      style={{ width: 34, height: 48 }}
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
  onDragEnd,
  onAppend,
}: {
  meta: NavMetaItem;
  getIcon: (name: string, size?: number) => React.ReactNode;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onAppend: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="group relative shrink-0 flex flex-col items-center justify-center gap-0 rounded-[10px] cursor-grab active:cursor-grabbing"
      style={{
        width: 56,
        padding: '6px 0 4px',
        background: 'var(--bg-card-hover)',
        border: '1px dashed var(--border-subtle)',
        color: 'var(--text-secondary)',
      }}
      title={`${meta.label}（拖到我的导航，或点 + 追加到末尾）`}
    >
      <span className="inline-flex items-center justify-center" style={{ width: 28, height: 28 }}>
        {getIcon(meta.icon, 18)}
      </span>
      <span
        className="text-[10px] leading-tight text-center mt-0.5 px-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {meta.shortLabel}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAppend();
        }}
        className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center rounded opacity-60 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.25)' }}
        title="追加到我的导航末尾"
      >
        <Plus size={10} />
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
    if (hasPerm('daily-tips.read')) list.push({ key: 'daily-tips', label: '小技巧', icon: <Sparkles size={14} /> });
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
        {activeTab === 'daily-tips' && <DailyTipsEditor />}
      </div>
    </div>
  );
}
