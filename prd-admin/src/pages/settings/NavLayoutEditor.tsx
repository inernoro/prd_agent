import { Fragment, useCallback, useMemo, useState, type ComponentType, type DragEvent, type ReactNode } from 'react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  getUnifiedNavCatalog,
  groupBySection,
  findHomeItem,
  NAV_SECTION_ORDER,
  NAV_SECTION_META,
  type NavCatalogItem,
  type NavSection,
} from '@/lib/unifiedNavCatalog';
import { useAuthStore } from '@/stores/authStore';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import * as LucideIcons from 'lucide-react';

interface NavMetaItem {
  navKey: string;
  label: string;
  shortLabel: string;
  icon: string;
  section: NavSection;
}

type DragSource =
  | { type: 'nav-item'; index: number }
  | { type: 'nav-divider'; index: number }
  | { type: 'pool-item'; navKey: string };

type NavLayoutEditorProps = {
  navOrder: string[];
  navHidden: string[];
  fallbackNavOrder?: string[];
  fallbackNavHidden?: string[];
  loaded: boolean;
  saving: boolean;
  saveLabel?: string;
  restoreLabel?: string;
  restoreTitle?: string;
  restoreDisabled?: boolean;
  restoreVariant?: 'secondary' | 'danger';
  onChange: (payload: { navOrder: string[]; navHidden: string[] }) => void;
  onRestore?: () => void | Promise<void>;
  headerActions?: ReactNode;
};

function getIcon(name: string, size = 16) {
  const IconComponent = (LucideIcons as unknown as Record<string, ComponentType<{ size?: number }>>)[name];
  if (IconComponent) return <IconComponent size={size} />;
  return <LucideIcons.Circle size={size} />;
}

export function collapseDividers(arr: string[]): string[] {
  const result: string[] = [];
  for (const token of arr) {
    if (token === NAV_DIVIDER_KEY) {
      if (result.length === 0) continue;
      if (result[result.length - 1] === NAV_DIVIDER_KEY) continue;
      result.push(token);
      continue;
    }
    result.push(token);
  }
  while (result.length > 0 && result[result.length - 1] === NAV_DIVIDER_KEY) {
    result.pop();
  }
  return result;
}

export function NavLayoutEditor({
  navOrder,
  navHidden,
  fallbackNavOrder = [],
  fallbackNavHidden = [],
  loaded,
  saving,
  saveLabel = '保存中...',
  restoreLabel = '恢复默认',
  restoreTitle,
  restoreDisabled,
  restoreVariant = 'secondary',
  onChange,
  onRestore,
  headerActions,
}: NavLayoutEditorProps) {
  const menuCatalog = useAuthStore((s) => s.menuCatalog);
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  const unified = useMemo(
    () => getUnifiedNavCatalog({ menuCatalog, permissions, isRoot, includeShortcuts: false }),
    [isRoot, menuCatalog, permissions],
  );

  const toMeta = useCallback((it: NavCatalogItem): NavMetaItem => ({
    navKey: it.id,
    label: it.label,
    shortLabel: it.shortLabel,
    icon: it.icon,
    section: it.section,
  }), []);

  const metaByKey = useMemo(() => {
    const map = new Map<string, NavMetaItem>();
    for (const it of unified) {
      // 设置项不出现在「我的导航」（避免用户误移除把自己锁在外面）
      if (it.route === '/settings') continue;
      map.set(it.id, toMeta(it));
    }
    return map;
  }, [toMeta, unified]);

  const currentOrder = useMemo<string[]>(() => {
    if (navOrder.length > 0) return navOrder;
    if (fallbackNavOrder.length > 0) return collapseDividers(fallbackNavOrder);

    // 默认布局：智能体 + 百宝箱（与智能体重复的会被 unifiedNavCatalog 按 route 去重过滤掉），
    // 实用工具 / 基础设施 / 其他菜单 默认不进导航——它们出现在「可添加」池里供用户按需追加。
    // 这样恢复默认后用户能看到丰富的可选项，而不是「全推到导航上」。
    const byGroup = new Map<NavSection, string[]>();
    for (const it of unified) {
      if (it.section === 'home' || it.route === '/settings') continue;
      if (it.section !== 'agent' && it.section !== 'toolbox') continue;
      const arr = byGroup.get(it.section) ?? [];
      arr.push(it.id);
      byGroup.set(it.section, arr);
    }

    const result: string[] = [];
    for (const sec of NAV_SECTION_ORDER) {
      const items = byGroup.get(sec) ?? [];
      if (items.length === 0) continue;
      if (result.length > 0) result.push(NAV_DIVIDER_KEY);
      result.push(...items);
    }
    return result;
  }, [unified, fallbackNavOrder, navOrder]);

  const homeMeta = useMemo<NavMetaItem | null>(() => {
    const home = findHomeItem(unified);
    return home ? toMeta(home) : null;
  }, [toMeta, unified]);

  const poolGroups = useMemo(() => {
    const inNav = new Set(currentOrder.filter((key) => key !== NAV_DIVIDER_KEY));
    const remain = unified.filter(
      (it) => it.section !== 'home' && it.route !== '/settings' && !inNav.has(it.id),
    );
    return groupBySection(remain).map((g) => ({
      key: g.section,
      label: g.label,
      items: g.items.map(toMeta),
    }));
  }, [currentOrder, toMeta, unified]);

  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverNavIndex, setDragOverNavIndex] = useState<number | null>(null);
  const [dragOverPool, setDragOverPool] = useState(false);

  const clearDragState = useCallback(() => {
    setDragSource(null);
    setDragOverNavIndex(null);
    setDragOverPool(false);
  }, []);

  const performDropToNav = useCallback(
    (source: DragSource, targetIndex: number) => {
      let nextOrder = [...currentOrder];

      if (source.type === 'nav-item' || source.type === 'nav-divider') {
        const [removed] = nextOrder.splice(source.index, 1);
        const adjusted = source.index < targetIndex ? targetIndex - 1 : targetIndex;
        nextOrder.splice(adjusted, 0, removed);
      } else {
        nextOrder.splice(targetIndex, 0, source.navKey);
      }

      nextOrder = collapseDividers(nextOrder);
      const navSet = new Set(nextOrder.filter((key) => key !== NAV_DIVIDER_KEY));
      const nextHidden = navHidden.filter((key) => !navSet.has(key));
      onChange({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, onChange]
  );

  const removeFromNav = useCallback(
    (index: number) => {
      const removed = currentOrder[index];
      const nextOrder = collapseDividers(currentOrder.filter((_, i) => i !== index));
      // 只操作用户自己的 navHidden，不复制 fallbackNavHidden（管理员默认隐藏项）
      // AppShell 会在渲染时合并 defaultNavHidden，这里不需要重复
      const nextHidden = [...navHidden];
      if (removed !== NAV_DIVIDER_KEY && !nextHidden.includes(removed)) {
        // 只有当被移除的项不在管理员默认隐藏列表中时，才添加到用户隐藏列表
        // 如果项目本来就是管理员隐藏的，移除后它会自动被 AppShell 的 effectiveNavHidden 隐藏
        if (!fallbackNavHidden.includes(removed)) {
          nextHidden.push(removed);
        }
      }
      onChange({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, fallbackNavHidden, navHidden, onChange]
  );

  const appendFromPool = useCallback(
    (navKey: string) => {
      const nextOrder = collapseDividers([...currentOrder, navKey]);
      const nextHidden = navHidden.filter((key) => key !== navKey);
      onChange({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [currentOrder, navHidden, onChange]
  );

  const appendDivider = useCallback(() => {
    const base = [...currentOrder];
    while (base.length > 0 && base[base.length - 1] === NAV_DIVIDER_KEY) base.pop();
    if (base.length === 0) return;
    const insertAt = Math.max(0, base.length - 1);
    const nextOrder = collapseDividers([
      ...base.slice(0, insertAt),
      NAV_DIVIDER_KEY,
      ...base.slice(insertAt),
    ]);
    onChange({ navOrder: nextOrder, navHidden });
  }, [currentOrder, navHidden, onChange]);

  const handleDragStartNav = (index: number, isDivider: boolean) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'nav-drag');
    setDragSource(isDivider ? { type: 'nav-divider', index } : { type: 'nav-item', index });
  };

  const handleDragStartPool = (navKey: string) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'pool-drag');
    setDragSource({ type: 'pool-item', navKey });
  };

  const handleDragOverNavSlot = (index: number) => (e: DragEvent) => {
    if (!dragSource) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverNavIndex !== index) setDragOverNavIndex(index);
  };

  const handleDropNavSlot = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragSource) performDropToNav(dragSource, index);
    clearDragState();
  };

  const handleDragOverPool = (e: DragEvent) => {
    if (!dragSource || dragSource.type === 'pool-item') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverPool(true);
  };

  const handleDropPool = (e: DragEvent) => {
    e.preventDefault();
    if (dragSource?.type === 'nav-item') {
      removeFromNav(dragSource.index);
    } else if (dragSource?.type === 'nav-divider') {
      onChange({
        navOrder: collapseDividers(currentOrder.filter((_, i) => i !== dragSource.index)),
        navHidden,
      });
    }
    clearDragState();
  };

  return (
    <div
      className="h-full min-h-0 flex flex-col gap-4 overflow-x-hidden overflow-y-auto"
      data-tour-id="nav-order-editor"
    >
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
            导航栏自定义
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            拖拽调整左侧导航的顺序，点 × 移除，点 + 添加。中间的短横杆是分隔横杆，仅用于视觉分组。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && (
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <MapSpinner size={12} />
              {saveLabel}
            </span>
          )}
          {headerActions}
          {onRestore && (
            <Button
              variant={restoreVariant}
              size="sm"
              onClick={() => void onRestore()}
              disabled={restoreDisabled}
              title={restoreTitle}
            >
              <RotateCcw size={14} />
              {restoreLabel}
            </Button>
          )}
        </div>
      </div>

      <GlassCard animated glow accentHue={210} className="shrink-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            我的导航
          </div>
          <Button variant="ghost" size="sm" onClick={appendDivider} title="在末尾前插入一个分隔横杆">
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
          <span
            className="shrink-0 select-none text-[10px] font-mono px-2 py-1 rounded"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}
          >
            顶部
          </span>

          {homeMeta && <FixedHomeChip meta={homeMeta} />}

          {currentOrder.map((token, idx) => {
            const isDivider = token === NAV_DIVIDER_KEY;
            const meta = isDivider ? null : metaByKey.get(token);
            return (
              <Fragment key={`nav-${idx}-${token}`}>
                <NavDropSlot
                  active={dragOverNavIndex === idx && !!dragSource}
                  onDragOver={handleDragOverNavSlot(idx)}
                  onDrop={handleDropNavSlot(idx)}
                />
                {isDivider ? (
                  <DividerChip
                    onDragStart={handleDragStartNav(idx, true)}
                    onDragEnd={clearDragState}
                    onRemove={() =>
                      onChange({
                        navOrder: collapseDividers(currentOrder.filter((_, i) => i !== idx)),
                        navHidden,
                      })
                    }
                  />
                ) : meta ? (
                  <NavItemChip
                    meta={meta}
                    onDragStart={handleDragStartNav(idx, false)}
                    onDragEnd={clearDragState}
                    onRemove={() => removeFromNav(idx)}
                  />
                ) : null}
              </Fragment>
            );
          })}

          <NavDropSlot
            active={dragOverNavIndex === currentOrder.length && !!dragSource}
            onDragOver={handleDragOverNavSlot(currentOrder.length)}
            onDrop={handleDropNavSlot(currentOrder.length)}
          />

          <span
            className="shrink-0 select-none text-[10px] font-mono px-2 py-1 rounded"
            style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}
          >
            底部
          </span>
        </div>
      </GlassCard>

      <GlassCard animated glow accentHue={180} className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            可添加
          </div>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            拖到上方，或点 + 直接追加到末尾。数据来源与 `Cmd+K` 一致。
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
          {poolGroups.length === 0 && (
            <div className="w-full text-center py-6 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {loaded ? '所有可用条目都已在导航中，拖一个下来就会回到这里。' : '加载中...'}
            </div>
          )}
          {poolGroups.map((group) => {
            const meta = NAV_SECTION_META[group.key];
            return (
              <div key={group.key} className="mb-4 last:mb-0">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center"
                    style={{ color: 'rgba(255,255,255,0.55)', width: 14, height: 14 }}
                  >
                    {getIcon(meta.iconName, 12)}
                  </span>
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {meta.label}
                  </span>
                  <span
                    className="text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    · {meta.subtitle}
                  </span>
                  <span
                    className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    {group.items.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.items.map((it) => (
                    <PoolItemChip
                      key={it.navKey}
                      meta={it}
                      onDragStart={handleDragStartPool(it.navKey)}
                      onDragEnd={clearDragState}
                      onAppend={() => appendFromPool(it.navKey)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </GlassCard>
    </div>
  );
}

function NavItemChip({
  meta,
  onDragStart,
  onDragEnd,
  onRemove,
}: {
  meta: NavMetaItem;
  onDragStart: (e: DragEvent) => void;
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
      <span className="text-[10px] leading-tight text-center mt-0.5 px-1" style={{ color: 'var(--text-muted)' }}>
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

function FixedHomeChip({ meta }: { meta: NavMetaItem }) {
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
      <span className="text-[10px] leading-tight text-center mt-0.5 px-1" style={{ color: 'var(--text-muted)' }}>
        {meta.shortLabel}
      </span>
    </div>
  );
}

function DividerChip({
  onDragStart,
  onDragEnd,
  onRemove,
}: {
  onDragStart: (e: DragEvent) => void;
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

function NavDropSlot({
  active,
  onDragOver,
  onDrop,
}: {
  active: boolean;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
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

function PoolItemChip({
  meta,
  onDragStart,
  onDragEnd,
  onAppend,
}: {
  meta: NavMetaItem;
  onDragStart: (e: DragEvent) => void;
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
      <span className="text-[10px] leading-tight text-center mt-0.5 px-1" style={{ color: 'var(--text-muted)' }}>
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
