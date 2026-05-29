import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Users, Eye } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import {
  listAllSites,
  listSiteViewersAdmin,
  type AdminSite,
  type AdminOwner,
  type AdminSiteViewer,
} from '@/services/real/webAdmin';

const PAGE_SIZE = 50;

type SortKey = 'newest' | 'most-viewed';

function formatTime(iso?: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 全部网页（高级权限）—— 跨用户审计所有托管站点 + 阅读量 + 访客 ID。
 * 仅 web-pages.viewAll 权限可见（路由层 RequirePermission 门控 + 后端二次校验）。
 */
export default function AdminWebPagesPage() {
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');

  const [sites, setSites] = useState<AdminSite[]>([]);
  const [owners, setOwners] = useState<Record<string, AdminOwner>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewerSite, setViewerSite] = useState<AdminSite | null>(null);

  const loadSites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAllSites({
        keyword: appliedKeyword || undefined,
        sort,
        skip: 0,
        limit: PAGE_SIZE,
      });
      if (res.success && res.data) {
        setSites(res.data.items ?? []);
        setOwners(res.data.owners ?? {});
        setTotal(res.data.total ?? 0);
      } else {
        setError(res.error?.message || '加载失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [appliedKeyword, sort]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  const submitSearch = useCallback(() => {
    setAppliedKeyword(keyword.trim());
  }, [keyword]);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* 顶部：标题 + 搜索 + 排序 */}
      <div className="shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              全部网页（高级）
            </h1>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              跨用户查看所有托管站点的阅读量与访客记录（高级权限）。共 {total} 个站点。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div
            className="flex items-center gap-2 rounded-md px-3 h-9 flex-1 min-w-[220px]"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
          >
            <Search size={15} style={{ color: 'var(--text-muted)' }} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch();
              }}
              placeholder="搜索站点标题 / 描述"
              className="bg-transparent outline-none text-sm flex-1"
              style={{ color: 'var(--text-primary)' }}
            />
            {keyword && (
              <button
                type="button"
                onClick={() => {
                  setKeyword('');
                  setAppliedKeyword('');
                }}
                style={{ color: 'var(--text-muted)' }}
                aria-label="清除搜索"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={submitSearch}
            className="h-9 px-4 rounded-md text-sm font-medium"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          >
            搜索
          </button>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-9 px-3 rounded-md text-sm outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
          >
            <option value="newest">最新创建</option>
            <option value="most-viewed">阅读量最高</option>
          </select>
        </div>
      </div>

      {/* 列表区 */}
      <div
        className="flex-1 min-h-0 overflow-y-auto rounded-lg"
        style={{ border: '1px solid var(--border-subtle)', overscrollBehavior: 'contain' }}
      >
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <MapSectionLoader text="正在加载全部网页…" />
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {error}
            </p>
            <button
              type="button"
              onClick={() => void loadSites()}
              className="h-8 px-4 rounded-md text-sm"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              重试
            </button>
          </div>
        ) : sites.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              没有匹配的托管站点
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {appliedKeyword ? '换个关键词试试，或清除搜索查看全部。' : '当前系统内还没有任何用户上传托管网页。'}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="text-left font-medium px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                  站点标题
                </th>
                <th className="text-left font-medium px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                  所属用户
                </th>
                <th className="text-right font-medium px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  阅读量
                </th>
                <th className="text-left font-medium px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  创建时间
                </th>
                <th className="text-right font-medium px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => {
                const owner = owners[site.ownerUserId];
                const ownerName = owner?.displayName || site.ownerUserId || '未知用户';
                const ownerAvatar = resolveAvatarUrl({ avatarFileName: owner?.avatarFileName });
                return (
                  <tr key={site.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>
                      <div className="font-medium truncate max-w-[320px]" title={site.title}>
                        {site.title || '未命名站点'}
                      </div>
                      {site.description && (
                        <div className="text-xs mt-0.5 truncate max-w-[320px]" style={{ color: 'var(--text-muted)' }} title={site.description}>
                          {site.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <UserAvatar src={ownerAvatar} alt={ownerName} className="w-6 h-6 rounded-full shrink-0 object-cover" />
                        <span className="truncate max-w-[160px]" style={{ color: 'var(--text-primary)' }} title={ownerName}>
                          {ownerName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>
                      {site.viewCount.toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {formatTime(site.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setViewerSite(site)}
                        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-xs"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                      >
                        <Users size={13} />
                        查看访客
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {viewerSite && (
        <ViewersModal site={viewerSite} onClose={() => setViewerSite(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 访客记录弹窗（createPortal + inline height，主题 token + 不透明 elevated 表面）
// ─────────────────────────────────────────────

const VIEWER_PAGE_SIZE = 50;

function ViewersModal({ site, onClose }: { site: AdminSite; onClose: () => void }) {
  const [viewers, setViewers] = useState<AdminSiteViewer[]>([]);
  const [total, setTotal] = useState(0);
  const [uniqueViewers, setUniqueViewers] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipRef = useRef(0);

  const load = useCallback(
    async (append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        skipRef.current = 0;
      }
      setError(null);
      try {
        const res = await listSiteViewersAdmin(site.id, skipRef.current, VIEWER_PAGE_SIZE);
        if (res.success && res.data) {
          const incoming = res.data.items ?? [];
          setViewers((prev) => (append ? [...prev, ...incoming] : incoming));
          setTotal(res.data.total ?? 0);
          setUniqueViewers(res.data.uniqueViewers ?? 0);
          skipRef.current += incoming.length;
        } else {
          setError(res.error?.message || '加载访客记录失败');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载访客记录失败');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [site.id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canLoadMore = useMemo(() => viewers.length < total, [viewers.length, total]);

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl flex flex-col rounded-xl shadow-2xl"
        style={{
          maxHeight: '82vh',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div
          className="shrink-0 flex items-start justify-between gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={site.title}>
              访客记录 · {site.title || '未命名站点'}
            </h2>
            <div className="flex items-center gap-4 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <span className="inline-flex items-center gap-1">
                <Eye size={12} /> 阅读量 {site.viewCount.toLocaleString('zh-CN')}
              </span>
              <span className="inline-flex items-center gap-1">
                <Users size={12} /> 去重登录访客 {uniqueViewers.toLocaleString('zh-CN')}
              </span>
              <span>记录 {total.toLocaleString('zh-CN')} 条</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5"
            style={{ color: 'var(--text-muted)' }}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* body */}
        <div
          className="flex-1 px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <div className="py-10 flex items-center justify-center">
              <MapSectionLoader text="正在加载访客记录…" />
            </div>
          ) : error ? (
            <div className="py-10 flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {error}
              </p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="h-8 px-4 rounded-md text-sm"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              >
                重试
              </button>
            </div>
          ) : viewers.length === 0 ? (
            <div className="py-10 flex flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                还没有访客记录
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                当有用户访问该站点时，访问痕迹会在此处显示。
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {viewers.map((v, idx) => {
                const name = v.viewerName || (v.viewerUserId ? `用户 ${v.viewerUserId}` : '匿名访客');
                const avatar = resolveAvatarUrl({ avatarFileName: v.viewerAvatarFileName });
                return (
                  <div
                    key={v.id || `${v.viewerUserId ?? 'anon'}-${idx}`}
                    className="flex items-center gap-3 rounded-md px-3 py-2"
                    style={{ background: 'var(--bg-input)' }}
                  >
                    <UserAvatar src={avatar} alt={name} className="w-7 h-7 rounded-full shrink-0 object-cover" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }} title={name}>
                        {name}
                      </div>
                      {v.viewerUserId && (
                        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          ID: {v.viewerUserId}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                        {formatTime(v.viewedAt)}
                      </div>
                      {v.ipAddress && (
                        <div className="text-[11px] tabular-nums whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                          {v.ipAddress}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {canLoadMore && (
                <button
                  type="button"
                  onClick={() => void load(true)}
                  disabled={loadingMore}
                  className="mt-2 h-9 rounded-md text-sm inline-flex items-center justify-center gap-2"
                  style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                >
                  {loadingMore ? <MapSpinner size={14} /> : null}
                  加载更多（{viewers.length}/{total}）
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
