import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getSidebarAutoAppendItems } from '@/lib/adminMenuCatalog';
import {
  getUnifiedNavCatalog,
  getMenuGroupedDefaultOrder,
  groupBySection,
  findHomeItem,
  NAV_SECTION_META,
  type NavCatalogItem,
  type NavSection,
} from '@/lib/unifiedNavCatalog';
import { useAuthStore } from '@/stores/authStore';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import {
  NAV_CHIP_ACTION_CLASS,
  NAV_CHIP_BASE_CLASS,
  NAV_END_CAP_CLASS,
  NavChipBody,
  NavDividerBody,
  getNavIcon,
  type NavChipMeta,
} from './navChips';

interface NavMetaItem extends NavChipMeta {
  section: NavSection;
}

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
  /** 替换「我的导航」标题，用于嵌入范围切换控件 */
  titleNode?: ReactNode;
};

/*
 * 拖拽方案：@dnd-kit（core + sortable）。
 * 原版是浏览器原生 HTML5 DnD：拖影是浏览器随手截的半透明快照、落点只有 4px 宽的隐形槽、
 * 分隔横杆 34px 宽且几乎没有可按面积——用户反馈「那个 | 无法得到有效的拖拽和移动」。
 * dnd-kit 的好处：指针传感器（鼠标 / 触屏统一）、拖动时其余条目实时让位、
 * DragOverlay 自绘拖影、键盘也能排序（空格拾起 / 方向键移动 / 空格放下）。
 *
 * ID 约定：
 *   nav:<index>   —— 「我的导航」条目（含分隔横杆），按位置编号；拖动期间列表不变，编号稳定
 *   pool:<navKey> —— 候选池条目
 *   strip / pool  —— 两个容器本身（落在空白处：strip=追加到末尾，pool=从导航移除）
 */
const STRIP_ID = 'strip';
const POOL_ID = 'pool';
const navId = (index: number) => `nav:${index}`;
const poolId = (navKey: string) => `pool:${navKey}`;
const parseId = (id: UniqueIdentifier): { kind: 'nav'; index: number } | { kind: 'pool'; navKey: string } | { kind: 'container'; id: string } => {
  const s = String(id);
  if (s.startsWith('nav:')) return { kind: 'nav', index: Number(s.slice(4)) };
  if (s.startsWith('pool:')) return { kind: 'pool', navKey: s.slice(5) };
  return { kind: 'container', id: s };
};

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
  titleNode,
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
      map.set(it.id, toMeta(it));
    }
    return map;
  }, [toMeta, unified]);

  const currentOrder = useMemo<string[]>(() => {
    const base = (() => {
      if (navOrder.length > 0) return navOrder;
      if (fallbackNavOrder.length > 0) return collapseDividers(fallbackNavOrder);
      // 默认布局：与 AppShell NAV_GROUPS 完全一致——按 menuCatalog 的 group
      // 字段（tools/personal/admin）分段。这样「我的导航」strip 显示的内容
      // 与左侧 sidebar 实际渲染的内容是同一份数据。
      return getMenuGroupedDefaultOrder({ menuCatalog, permissions, isRoot });
    })();

    // 镜像 AppShell 的「新功能上线兜底」逻辑：
    // 当用户有自定义 navOrder 时，AppShell 会把后端 menuCatalog 里不在 navOrder
    // 中的条目自动追加到 sidebar 末尾，导致 sidebar 比「我的导航」多出几项。
    // 这里同步将这些条目追加到 currentOrder，保证两侧数量一致。
    //
    // getSidebarAutoAppendItems 是唯一来源（镜像 AppShell 的 NON_HOME auto-append 逻辑），
    // home 分组由 AppShell 单独渲染，不参与 navOrder 管理，此处同步排除。
    // effectiveHidden 镜像 AppShell 的 effectiveNavHidden：用户已隐藏的条目不追加回来，
    // 否则用户点 × 移除的条目会被孤立检测立即补回，无法真正隐藏。
    // 无论 base 来自 navOrder / fallbackNavOrder 还是 getMenuGroupedDefaultOrder，
    // 都执行孤立检测，确保新上线功能（不在 DEFAULT_NAV_ORDER 里的条目）
    // 自动追加到 currentOrder，与 AppShell sidebar 保持一致。
    const inBase = new Set(base.filter((k) => k !== NAV_DIVIDER_KEY));
    const effectiveHidden = new Set([...navHidden, ...fallbackNavHidden]);
    const appShellVisibleIds = new Set(
      getSidebarAutoAppendItems({ items: menuCatalog, permissions, isRoot }).map((m) => m.appKey),
    );
    const orphans = [...appShellVisibleIds].filter(
      (id) => !inBase.has(id) && !effectiveHidden.has(id),
    );
    if (orphans.length > 0) return [...base, ...orphans];

    return base;
  }, [fallbackNavHidden, fallbackNavOrder, isRoot, menuCatalog, navHidden, navOrder, permissions]);

  const homeMeta = useMemo<NavMetaItem | null>(() => {
    const home = findHomeItem(unified);
    return home ? toMeta(home) : null;
  }, [toMeta, unified]);

  const poolGroups = useMemo(() => {
    const inNav = new Set(currentOrder.filter((key) => key !== NAV_DIVIDER_KEY));
    const remain = unified.filter(
      (it) => it.section !== 'home' && !inNav.has(it.id),
    );
    return groupBySection(remain).map((g) => ({
      key: g.section,
      label: g.label,
      items: g.items.map(toMeta),
    }));
  }, [currentOrder, toMeta, unified]);

  // ── 提交动作（与旧版语义一致） ──
  const commitOrder = useCallback(
    (nextOrderRaw: string[]) => {
      const nextOrder = collapseDividers(nextOrderRaw);
      const navSet = new Set(nextOrder.filter((key) => key !== NAV_DIVIDER_KEY));
      const nextHidden = navHidden.filter((key) => !navSet.has(key));
      onChange({ navOrder: nextOrder, navHidden: nextHidden });
    },
    [navHidden, onChange],
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

  const removeDivider = useCallback(
    (index: number) => {
      onChange({
        navOrder: collapseDividers(currentOrder.filter((_, i) => i !== index)),
        navHidden,
      });
    },
    [currentOrder, navHidden, onChange],
  );

  const insertFromPool = useCallback(
    (navKey: string, at: number) => {
      const next = [...currentOrder];
      next.splice(Math.max(0, Math.min(at, next.length)), 0, navKey);
      commitOrder(next);
    },
    [commitOrder, currentOrder],
  );

  const appendFromPool = useCallback(
    (navKey: string) => insertFromPool(navKey, currentOrder.length),
    [currentOrder.length, insertFromPool],
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

  // ── dnd-kit 接线 ──
  const sensors = useSensors(
    // 4px 激活距离：chip 上的 × / + 小按钮点一下不会误触发拖动
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  // 候选池条目悬停在导航条目上时的插入位置（导航内部排序由 dnd-kit 自己做让位动画，不需要这个）
  const [poolInsertAt, setPoolInsertAt] = useState<number | null>(null);

  const navIds = useMemo(() => currentOrder.map((_, idx) => navId(idx)), [currentOrder]);

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const within = pointerWithin(args);
    const source = parseId(args.active.id);
    const inPool = within.some((c) => c.id === POOL_ID);
    const inStrip = within.some((c) => c.id === STRIP_ID);

    if (source.kind === 'nav') {
      // 导航条目：指针进了候选池 → 移除；否则在导航条目之间找最近的一个（离开条一点也能排序）
      if (inPool) return within.filter((c) => c.id === POOL_ID);
      const nav = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('nav:')),
      });
      if (nav.length > 0) return nav;
      return within.filter((c) => c.id === STRIP_ID);
    }

    // 候选池条目：只有指针真的进了「我的导航」这条才算，避免在池子里晃一下就被插进去
    if (!inStrip) return [];
    const nav = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('nav:')),
    });
    if (nav.length > 0) return nav;
    return within.filter((c) => c.id === STRIP_ID);
  }, []);

  /** 候选池条目落到导航条目上：按拖影中心在目标中心左侧还是右侧决定插在前面还是后面 */
  const resolvePoolInsertIndex = useCallback((event: DragOverEvent | DragEndEvent): number | null => {
    const { over, active } = event;
    if (!over) return null;
    const target = parseId(over.id);
    if (target.kind === 'container') return target.id === STRIP_ID ? currentOrder.length : null;
    if (target.kind !== 'nav') return null;
    const translated = active.rect.current.translated;
    if (!translated) return target.index;
    const activeCenterX = translated.left + translated.width / 2;
    const overCenterX = over.rect.left + over.rect.width / 2;
    return activeCenterX > overCenterX ? target.index + 1 : target.index;
  }, [currentOrder.length]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
    setPoolInsertAt(null);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const source = parseId(event.active.id);
    if (source.kind !== 'pool') {
      setPoolInsertAt(null);
      return;
    }
    setPoolInsertAt(resolvePoolInsertIndex(event));
  }, [resolvePoolInsertIndex]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setPoolInsertAt(null);
    if (!over) return;
    const source = parseId(active.id);
    const target = parseId(over.id);

    if (source.kind === 'nav') {
      if (target.kind === 'container' && target.id === POOL_ID) {
        if (currentOrder[source.index] === NAV_DIVIDER_KEY) removeDivider(source.index);
        else removeFromNav(source.index);
        return;
      }
      if (target.kind === 'nav' && target.index !== source.index) {
        commitOrder(arrayMove(currentOrder, source.index, target.index));
      }
      return;
    }

    if (source.kind === 'pool') {
      const at = resolvePoolInsertIndex(event);
      if (at != null) insertFromPool(source.navKey, at);
    }
  }, [commitOrder, currentOrder, insertFromPool, removeDivider, removeFromNav, resolvePoolInsertIndex]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setPoolInsertAt(null);
  }, []);

  const activeSource = activeId != null ? parseId(activeId) : null;
  const overlayNode = (() => {
    if (!activeSource) return null;
    if (activeSource.kind === 'nav') {
      const token = currentOrder[activeSource.index];
      if (token === NAV_DIVIDER_KEY) return <div className="group cursor-grabbing"><NavDividerBody active /></div>;
      const meta = metaByKey.get(token);
      return meta ? <OverlayChip meta={meta} /> : null;
    }
    if (activeSource.kind === 'pool') {
      const meta = metaByKey.get(activeSource.navKey);
      return meta ? <OverlayChip meta={meta} dashed /> : null;
    }
    return null;
  })();

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className="h-full min-h-0 flex flex-col gap-4 overflow-x-hidden overflow-y-auto"
        data-tour-id="nav-order-editor"
      >
        <GlassCard animated glow accentHue={210} className="shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 shrink-0">
              {titleNode ?? (
                <div className="text-[12px] font-semibold text-token-primary">我的导航</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {saving && (
                <span className="flex items-center gap-1.5 text-[11px] text-token-muted">
                  <MapSpinner size={12} />
                  {saveLabel}
                </span>
              )}
              {headerActions}
              <Button variant="ghost" size="sm" onClick={appendDivider} title="在末尾前插入一个分隔横杆">
                <Minus size={14} />
                加分隔
              </Button>
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

          <StripDroppable
            active={activeSource?.kind === 'pool' && poolInsertAt === currentOrder.length}
          >
            <span className={NAV_END_CAP_CLASS}>顶部</span>
            {homeMeta && <FixedHomeChip meta={homeMeta} />}
            <SortableContext items={navIds} strategy={rectSortingStrategy}>
              {currentOrder.map((token, idx) => {
                const isDivider = token === NAV_DIVIDER_KEY;
                const meta = isDivider ? null : (metaByKey.get(token) ?? null);
                if (!isDivider && !meta) return null;
                return (
                  <SortableNavEntry
                    key={navId(idx)}
                    id={navId(idx)}
                    meta={meta}
                    insertBefore={activeSource?.kind === 'pool' && poolInsertAt === idx}
                    onRemove={() => (isDivider ? removeDivider(idx) : removeFromNav(idx))}
                  />
                );
              })}
            </SortableContext>
            <span className={NAV_END_CAP_CLASS}>底部</span>
          </StripDroppable>
          <div className="text-[10px] text-token-muted">
            拖动条目或分隔横杆重排；拖回下方候选池即移除。键盘：Tab 选中条目后按空格拾起、方向键移动、再按空格放下。
          </div>
        </GlassCard>

        <GlassCard animated glow accentHue={180} className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-semibold text-token-primary">
              可添加
            </div>
            <span className="text-[10px] text-token-muted">
              拖到上方，或点 + 直接追加到末尾。数据来源与 `Cmd+K` 一致。
            </span>
          </div>
          <PoolDroppable acceptDrop={activeSource?.kind === 'nav'}>
            {poolGroups.length === 0 && (
              <div className="w-full py-6 text-center text-[12px] text-token-muted">
                {loaded ? '所有可用条目都已在导航中，拖一个下来就会回到这里。' : '加载中...'}
              </div>
            )}
            {poolGroups.map((group) => {
              const meta = NAV_SECTION_META[group.key];
              return (
                <div key={group.key} className="mb-4 last:mb-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-token-muted">
                      {getNavIcon(meta.iconName, 12)}
                    </span>
                    <span className="text-[12px] font-semibold text-token-primary">
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-token-muted">
                      · {meta.subtitle}
                    </span>
                    <span className="surface-inset ml-auto rounded px-1.5 py-0.5 text-[10px] text-token-muted">
                      {group.items.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((it) => (
                      <PoolItemChip
                        key={it.navKey}
                        meta={it}
                        onAppend={() => appendFromPool(it.navKey)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </PoolDroppable>
        </GlassCard>
      </div>

      <DragOverlay dropAnimation={null}>{overlayNode}</DragOverlay>
    </DndContext>
  );
}

// ── 容器 ──

function StripDroppable({ children, active }: { children: ReactNode; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: STRIP_ID });
  return (
    <div
      ref={setNodeRef}
      data-nav-strip
      className="surface-inset relative flex min-h-[74px] flex-wrap items-center gap-2 rounded-[12px] p-3 transition-colors"
      style={isOver || active ? { boxShadow: 'inset 0 0 0 1px hsl(var(--primary) / 0.45)' } : undefined}
    >
      {children}
      {active && <InsertMarker />}
    </div>
  );
}

function PoolDroppable({ children, acceptDrop }: { children: ReactNode; acceptDrop: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: POOL_ID });
  const highlight = acceptDrop && isOver;
  return (
    <div
      ref={setNodeRef}
      className="rounded-[12px] p-3 min-h-[90px] flex-1 overflow-y-auto"
      style={{
        background: highlight ? 'hsl(var(--primary) / 0.08)' : 'var(--nested-block-bg)',
        border: `1px ${highlight ? 'dashed hsl(var(--primary) / 0.5)' : 'solid var(--nested-block-border)'}`,
      }}
    >
      {children}
    </div>
  );
}

function InsertMarker() {
  return <span className="h-10 w-[3px] shrink-0 rounded-sm bg-[hsl(var(--primary)/0.6)]" />;
}

// ── 条目 ──

function SortableNavEntry({
  id,
  meta,
  insertBefore,
  onRemove,
}: {
  id: string;
  meta: NavMetaItem | null;
  insertBefore: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };
  const isDivider = meta == null;
  return (
    <>
      {insertBefore && <InsertMarker />}
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        data-nav-entry={isDivider ? 'divider' : meta.navKey}
        className={
          isDivider
            ? 'group relative shrink-0 cursor-grab touch-none active:cursor-grabbing'
            : `${NAV_CHIP_BASE_CLASS} cursor-grab touch-none active:cursor-grabbing`
        }
        title={isDivider ? '分隔横杆（拖动移动 / 点 × 删除）' : `${meta.label}（拖动重排 / 点 × 移除）`}
      >
        {isDivider ? <NavDividerBody /> : <NavChipBody meta={meta} />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`${NAV_CHIP_ACTION_CLASS} ${
            isDivider ? '-right-1 -top-1 bg-token-nested' : 'right-0.5 top-0.5'
          } text-token-muted opacity-0 group-hover:opacity-100`}
          title={isDivider ? '删除分隔横杆' : '从导航中移除'}
        >
          <X size={10} />
        </button>
      </div>
    </>
  );
}

function FixedHomeChip({ meta }: { meta: NavMetaItem }) {
  return (
    <div
      className="surface-inset flex w-14 shrink-0 flex-col items-center justify-center gap-0 rounded-[10px] border-dashed pb-1 pt-1.5 text-token-secondary opacity-85"
      title={`${meta.label}（固定在侧栏顶部，不可移除）`}
    >
      <NavChipBody meta={meta} />
    </div>
  );
}

function PoolItemChip({ meta, onAppend }: { meta: NavMetaItem; onAppend: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: poolId(meta.navKey) });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-pool-entry={meta.navKey}
      className={`${NAV_CHIP_BASE_CLASS} border-dashed cursor-grab touch-none active:cursor-grabbing`}
      style={{ opacity: isDragging ? 0.35 : 1 }}
      title={`${meta.label}（拖到我的导航，或点 + 追加到末尾）`}
    >
      <NavChipBody meta={meta} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAppend();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`${NAV_CHIP_ACTION_CLASS} right-0.5 top-0.5 text-token-secondary opacity-60 group-hover:opacity-100`}
        title="追加到我的导航末尾"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}

/** 拖影：跟着指针走的那一枚，自绘而不是交给浏览器截图 */
function OverlayChip({ meta, dashed }: { meta: NavMetaItem; dashed?: boolean }) {
  return (
    <div
      className={`${NAV_CHIP_BASE_CLASS} ${dashed ? 'border-dashed' : ''} cursor-grabbing shadow-lg`}
      style={{ transform: 'scale(1.04)' }}
    >
      <NavChipBody meta={meta} />
    </div>
  );
}
