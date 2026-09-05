import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getUserNavLayouts, resetUserNavLayout } from '@/services';
import type { UserNavLayoutItem } from '@/services/contracts/userPreferences';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { findHomeItem, getMenuGroupedDefaultOrder, getUnifiedNavCatalog } from '@/lib/unifiedNavCatalog';
import { useAuthStore } from '@/stores/authStore';
import { NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import { RefreshCw, RotateCcw, Search } from 'lucide-react';
import { collapseDividers } from './NavLayoutEditor';
import {
  NAV_CHIP_BASE_CLASS,
  NAV_END_CAP_CLASS,
  NavChipBody,
  NavDividerBody,
  StaleNavChip,
  type NavChipMeta,
} from './navChips';

/**
 * 全员导航总览（管理员）：
 * - 第一行固定是「所有人的默认导航」；
 * - 下面每个真人用户一行，自定义过的排前面（最近改动倒序），沿用默认的排后面；
 * - 每一行的菜单画法与「导航顺序」编辑器完全一致（同一套 chip 零件）；
 * - 目录里已经不存在的 token（比如刚下线的菜单）用虚线红框标出来，管理员下线菜单前就能看清谁还挂着它。
 */
type Props = {
  titleNode?: ReactNode;
  defaultNavOrder: string[];
  defaultNavHidden: string[];
};

export function UserNavOverview({ titleNode, defaultNavOrder, defaultNavHidden }: Props) {
  const menuCatalog = useAuthStore((s) => s.menuCatalog);
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  const unified = useMemo(
    () => getUnifiedNavCatalog({ menuCatalog, permissions, isRoot, includeShortcuts: false }),
    [isRoot, menuCatalog, permissions],
  );
  const metaByKey = useMemo(() => {
    const map = new Map<string, NavChipMeta>();
    for (const it of unified) {
      map.set(it.id, { navKey: it.id, label: it.label, shortLabel: it.shortLabel, icon: it.icon });
    }
    return map;
  }, [unified]);
  const homeMeta = useMemo<NavChipMeta | null>(() => {
    const home = findHomeItem(unified);
    return home ? { navKey: home.id, label: home.label, shortLabel: home.shortLabel, icon: home.icon } : null;
  }, [unified]);

  // 未自定义的人看到的就是这一份（管理员配过默认 → 用默认；否则系统内置分组顺序）
  const effectiveDefaultOrder = useMemo(() => {
    if (defaultNavOrder.length > 0) return collapseDividers(defaultNavOrder);
    return getMenuGroupedDefaultOrder({ menuCatalog, permissions, isRoot });
  }, [defaultNavOrder, isRoot, menuCatalog, permissions]);

  const [items, setItems] = useState<UserNavLayoutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [onlyCustomized, setOnlyCustomized] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getUserNavLayouts();
      if (!res.success) {
        setLoadError(res.error?.message || '加载全员导航失败');
        return;
      }
      setItems(res.data.items);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '加载全员导航失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const customizedCount = useMemo(() => items.filter((it) => it.customized).length, [items]);
  const staleUserCount = useMemo(
    () => items.filter((it) => it.customized && [...it.navOrder, ...it.navHidden].some((t) => t !== NAV_DIVIDER_KEY && !metaByKey.has(t))).length,
    [items, metaByKey],
  );

  const visibleItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((it) => {
      if (onlyCustomized && !it.customized) return false;
      if (!kw) return true;
      return it.displayName.toLowerCase().includes(kw) || it.username.toLowerCase().includes(kw);
    });
  }, [items, keyword, onlyCustomized]);

  const handleReset = useCallback(async (item: UserNavLayoutItem) => {
    const ok = await systemDialog.confirm({
      title: `重置 ${item.displayName} 的导航`,
      message: `将清空 ${item.displayName}（${item.username}）的个人导航设置，让其回退到「所有人的默认导航」。只影响这一个人。确认继续吗？`,
      confirmText: '确认重置',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    setResettingId(item.userId);
    try {
      const res = await resetUserNavLayout(item.userId);
      if (!res.success) {
        toast.error('重置失败', res.error?.message || '重置用户导航失败');
        return;
      }
      const updated = res.data;
      setItems((prev) => {
        // 重置后它不再是「自定义」，按服务端同样的规则挪到默认段最前
        const rest = prev.filter((it) => it.userId !== updated.userId);
        const firstDefaultIdx = rest.findIndex((it) => !it.customized);
        const at = firstDefaultIdx < 0 ? rest.length : firstDefaultIdx;
        return [...rest.slice(0, at), updated, ...rest.slice(at)];
      });
      toast.success('已重置', `${item.displayName} 的导航已回退到默认`);
    } catch (error) {
      toast.error('重置失败', error instanceof Error ? error.message : '重置用户导航失败');
    } finally {
      setResettingId(null);
    }
  }, []);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-x-hidden overflow-y-auto" data-tour-id="user-nav-overview">
      <GlassCard animated glow accentHue={210} className="shrink-0 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 shrink-0">
            {titleNode ?? <div className="text-[12px] font-semibold text-token-primary">全部用户的导航</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!loading && !loadError && (
              <span className="text-[11px] text-token-muted" data-testid="user-nav-summary">
                {items.length} 人 · {customizedCount} 人自定义
                {staleUserCount > 0 ? ` · ${staleUserCount} 人挂着已下线菜单` : ''}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} title="重新拉取">
              <RefreshCw size={14} />
              刷新
            </Button>
          </div>
        </div>
        <div className="text-[11px] text-token-muted">
          第一行是「所有人的默认导航」；其余每人一行，自定义过的排在前面（最近改动在最上），沿用默认的排在后面。
          虚线红框是目录里已不存在的菜单（侧栏渲染时会自动跳过），删菜单前先看这里谁还挂着它。
        </div>
        <NavRow
          heading={<span className="text-[12px] font-semibold text-token-primary">所有人的默认导航</span>}
          subheading={defaultNavOrder.length > 0 ? '管理员在「所有人的」里配置的顺序' : '未配置，使用系统内置分组顺序'}
          tag={<RowTag tone="default">默认</RowTag>}
          order={effectiveDefaultOrder}
          hidden={defaultNavHidden}
          homeMeta={homeMeta}
          metaByKey={metaByKey}
        />
      </GlassCard>

      <GlassCard animated glow accentHue={180} className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[12px] font-semibold text-token-primary">每个人的导航</div>
          <label className="surface-inset ml-auto flex items-center gap-1.5 rounded-[8px] px-2 py-1">
            <Search size={12} className="text-token-muted" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按姓名 / 账号搜索"
              className="w-40 bg-transparent text-[12px] text-token-primary outline-none placeholder:text-token-muted"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-token-secondary">
            <input type="checkbox" checked={onlyCustomized} onChange={(e) => setOnlyCustomized(e.target.checked)} />
            只看自定义过的
          </label>
        </div>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-[12px] text-token-muted">
            <MapSpinner size={14} />
            正在汇总每个人的导航设置…
          </div>
        )}
        {!loading && loadError && (
          <div className="flex items-center gap-3 py-6 text-[12px]" style={{ color: 'var(--accent-fg-danger)' }}>
            {loadError}
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </div>
        )}
        {!loading && !loadError && visibleItems.length === 0 && (
          <div className="py-8 text-center text-[12px] text-token-muted">
            {items.length === 0 ? '还没有用户' : '没有匹配的用户'}
          </div>
        )}
        {!loading && !loadError && visibleItems.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="user-nav-rows">
            {visibleItems.map((it) => (
              <NavRow
                key={it.userId}
                dataUserId={it.userId}
                heading={
                  <span className="text-[12px] font-semibold text-token-primary">
                    {it.displayName}
                    <span className="ml-1.5 font-normal text-token-muted">@{it.username}</span>
                  </span>
                }
                subheading={
                  it.customized
                    ? `自定义 · ${formatTime(it.updatedAt)}`
                    : '沿用默认导航'
                }
                tag={
                  <>
                    <RowTag tone="role">{it.role}</RowTag>
                    {it.status === 'Disabled' && <RowTag tone="danger">已停用</RowTag>}
                    {it.customized ? <RowTag tone="custom">自定义</RowTag> : <RowTag tone="default">默认</RowTag>}
                  </>
                }
                order={it.customized ? it.navOrder : effectiveDefaultOrder}
                hidden={it.customized ? it.navHidden : defaultNavHidden}
                dimmed={!it.customized}
                homeMeta={homeMeta}
                metaByKey={metaByKey}
                actions={
                  it.customized ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleReset(it)}
                      disabled={resettingId === it.userId}
                      title="清空这个人的个人导航，回退到所有人的默认导航"
                    >
                      {resettingId === it.userId ? <MapSpinner size={12} /> : <RotateCcw size={12} />}
                      重置为默认
                    </Button>
                  ) : null
                }
              />
            ))}
          </div>
        )}
      </GlassCard>
    </div>
  );
}

function formatTime(iso?: string | null): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function RowTag({ tone, children }: { tone: 'default' | 'custom' | 'role' | 'danger'; children: ReactNode }) {
  const style: React.CSSProperties =
    tone === 'custom'
      ? { background: 'hsl(var(--primary) / 0.14)', color: 'var(--text-primary)', border: '1px solid hsl(var(--primary) / 0.35)' }
      : tone === 'danger'
        ? { background: 'transparent', color: 'var(--accent-fg-danger)', border: '1px solid var(--accent-fg-danger)' }
        : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)', border: '1px solid var(--nested-block-border)' };
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] leading-none" style={style}>
      {children}
    </span>
  );
}

/** 一行 = 一个人：左侧身份区，右侧与编辑器同款的 chip 条 */
function NavRow({
  heading,
  subheading,
  tag,
  order,
  hidden,
  dimmed,
  homeMeta,
  metaByKey,
  actions,
  dataUserId,
}: {
  heading: ReactNode;
  subheading: string;
  tag: ReactNode;
  order: string[];
  hidden: string[];
  dimmed?: boolean;
  homeMeta: NavChipMeta | null;
  metaByKey: Map<string, NavChipMeta>;
  actions?: ReactNode;
  dataUserId?: string;
}) {
  const hiddenMetas = hidden.filter((t) => t !== NAV_DIVIDER_KEY);
  return (
    <div
      className="surface-inset flex flex-col gap-2 rounded-[12px] p-3"
      style={dimmed ? { opacity: 0.78 } : undefined}
      data-user-nav-row={dataUserId ?? 'default'}
    >
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <span className="text-[11px] text-token-muted">{subheading}</span>
        <span className="ml-auto flex items-center gap-1.5">{tag}</span>
        {actions}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={NAV_END_CAP_CLASS}>顶部</span>
        {homeMeta && (
          <div className={`${NAV_CHIP_BASE_CLASS} border-dashed opacity-85`} title={`${homeMeta.label}（固定）`}>
            <NavChipBody meta={homeMeta} />
          </div>
        )}
        {order.map((token, idx) => {
          if (token === NAV_DIVIDER_KEY) {
            return (
              <div key={`d-${idx}`} className="group" title="分隔横杆">
                <NavDividerBody />
              </div>
            );
          }
          const meta = metaByKey.get(token);
          if (!meta) return <StaleNavChip key={`s-${idx}-${token}`} token={token} />;
          return (
            <div key={`${token}-${idx}`} className={NAV_CHIP_BASE_CLASS} title={meta.label}>
              <NavChipBody meta={meta} />
            </div>
          );
        })}
        <span className={NAV_END_CAP_CLASS}>底部</span>
        {hiddenMetas.length > 0 && (
          <>
            <span className={`${NAV_END_CAP_CLASS} ml-2`}>已隐藏</span>
            {hiddenMetas.map((token, idx) => {
              const meta = metaByKey.get(token);
              if (!meta) return <StaleNavChip key={`hs-${idx}-${token}`} token={token} />;
              return (
                <div key={`h-${token}-${idx}`} className={`${NAV_CHIP_BASE_CLASS} border-dashed`} title={`${meta.label}（该用户已从侧栏隐藏）`}>
                  <NavChipBody meta={meta} dimmed />
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
