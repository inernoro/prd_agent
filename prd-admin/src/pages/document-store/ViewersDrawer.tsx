import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Users, Clock, X, UserCircle2 } from 'lucide-react';
import { listStoreViewEvents } from '@/services';
import type { DocumentStoreViewEvent, DocumentStoreViewStats } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';

// ── 时间 / 时长格式化 ──

function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso).getTime();
  const diff = Date.now() - date;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

// 聚合统计「总停留」用：始终给出一个数值文案（0 也显示 < 1 秒）。
function formatDurationMs(ms?: number): string {
  if (!ms || ms < 1000) return '< 1 秒';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
}

// 单条访问「停留」用：埋点只累计「前台可见」时长，离开/切 tab/关页时经 sendBeacon 补写。
// durationMs 为 0/缺失 = leave 信标未送达（硬关浏览器等），与「真的看了不到 1 秒」语义不同，
// 显示为「—」避免误导，而不是谎报「< 1 秒」。
function formatDwell(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  return formatDurationMs(ms);
}

// ── Drawer ──

export type ViewersDrawerProps = {
  storeId: string;
  storeName: string;
  onClose: () => void;
};

export function ViewersDrawer({ storeId, storeName, onClose }: ViewersDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DocumentStoreViewStats | null>(null);
  const [events, setEvents] = useState<DocumentStoreViewEvent[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listStoreViewEvents(storeId, 50);
    if (res.success) {
      setStats(res.data.stats);
      setEvents(res.data.events);
    } else {
      toast.error('加载访客列表失败', res.error?.message);
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  // ESC 关闭（遵循 frontend-modal 规则）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const drawer = (
    <div className="surface-backdrop fixed inset-0 z-[10000] flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* 面板底色用不透明 token var(--bg-elevated)：surface-popover 的 --panel-solid
          在暗色仅 92% 不透明，叠加 backdrop blur 会透出底层页面头部（分享/上传按钮），
          与 SiteViewersDrawer 保持一致的不透明处理。 */}
      <div className="surface-popover flex h-full w-[520px] max-w-[94vw] flex-col border-l border-token-subtle"
        style={{ background: 'var(--bg-elevated)' }}>

        {/* 头部 */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Users size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                访客记录
              </p>
              <p className="truncate text-[10px] text-token-muted">
                {storeName}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        {/* 内容 */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSectionLoader text="加载访客数据…" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* 聚合统计卡 */}
            <div className="surface-inset mx-5 mt-4 grid grid-cols-3 gap-3 rounded-[12px] p-4">
              <StatTile
                icon={<Eye size={14} style={{ color: 'rgba(96,165,250,0.9)' }} />}
                label="总访问量"
                value={stats?.totalViews ?? 0}
              />
              <StatTile
                icon={<Users size={14} style={{ color: 'rgba(168,85,247,0.9)' }} />}
                label="独立访客"
                value={stats?.uniqueVisitors ?? 0}
              />
              <StatTile
                icon={<Clock size={14} style={{ color: 'rgba(74,222,128,0.9)' }} />}
                label="总停留"
                value={formatDurationMs(stats?.totalDurationMs)}
              />
            </div>

            {/* 事件列表（时间线） */}
            <div className="mx-5 mt-5 mb-5">
              <p className="mb-3 text-[11px] font-semibold text-token-muted">
                最近 {events.length} 次访问
              </p>
              {events.length === 0 ? (
                <div className="surface-inset rounded-[10px] border border-dashed border-token-subtle py-10 text-center">
                  <Eye size={22} className="mx-auto mb-2 text-token-muted opacity-30" />
                  <p className="text-[11px] text-token-muted">
                    还没有访客记录
                  </p>
                  <p className="mt-1 text-[10px] text-token-muted-faint">
                    把知识库设为公开后，访客浏览会在这里显示
                  </p>
                </div>
              ) : (
                <ol className="space-y-1">
                  {events.map(ev => <ViewEventRow key={ev.id} ev={ev} />)}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] text-token-muted">{label}</span>
      </div>
      <p className="text-[16px] font-bold text-token-primary">{value}</p>
    </div>
  );
}

function ViewEventRow({ ev }: { ev: DocumentStoreViewEvent }) {
  const revisits = ev.revisitCount ?? 0;
  return (
    <li className="surface-row flex items-center gap-2.5 rounded-[8px] px-2.5 py-2">
      {ev.viewerUserId ? (
        // 登录访客：渲染真实头像（resolveAvatarUrl 自动兜底 nohead.png）
        <UserAvatar
          src={resolveAvatarUrl({ avatarFileName: ev.viewerAvatar })}
          alt={ev.viewerName}
          className="w-7 h-7 flex-shrink-0 rounded-full object-cover"
        />
      ) : (
        // 匿名访客：无头像，沿用占位图标
        <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
          style={{
            background: 'rgba(148,163,184,0.1)',
            border: '1px solid rgba(148,163,184,0.2)',
          }}>
          <UserCircle2 size={15} style={{ color: 'rgba(148,163,184,0.9)' }} />
        </div>
      )}
      {/* 中段取自然高度（姓名 + 文档名两行），紧凑不留白 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-token-primary">
            {ev.viewerName}
          </span>
          {!ev.viewerUserId && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
              style={{ background: 'rgba(148,163,184,0.1)', color: 'rgba(148,163,184,0.9)' }}>
              匿名
            </span>
          )}
        </div>
        {ev.entryTitle && (
          <p className="truncate text-[11px] text-token-secondary">
            {ev.entryTitle}
          </p>
        )}
      </div>
      {/* 时间 + 停留靠右，填满原本空荡的右侧 */}
      <div className="flex flex-shrink-0 flex-col items-end gap-0.5 text-[10px] text-token-muted">
        <span>{formatRelative(ev.enteredAt)}</span>
        <span>
          停留 {formatDwell(ev.durationMs)}
          {revisits > 0 && ` · ${revisits + 1} 次`}
        </span>
      </div>
    </li>
  );
}
