import { useCallback, useEffect, useState } from 'react';
import { Eye, Users, Clock, X, UserCircle2 } from 'lucide-react';
import { listStoreViewEvents } from '@/services';
import type { DocumentStoreViewEvent, DocumentStoreViewStats } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
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

function formatDurationMs(ms?: number): string {
  if (!ms || ms < 1000) return '< 1 秒';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时 ${min % 60} 分`;
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

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex h-full w-[520px] max-w-[94vw] flex-col border-l border-token-subtle">

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
                <ol className="space-y-3">
                  {events.map(ev => <ViewEventRow key={ev.id} ev={ev} />)}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
  return (
    <li className="surface-row flex items-start gap-3 rounded-[10px] p-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
        style={{
          background: ev.viewerUserId ? 'rgba(59,130,246,0.1)' : 'rgba(148,163,184,0.1)',
          border: ev.viewerUserId ? '1px solid rgba(59,130,246,0.2)' : '1px solid rgba(148,163,184,0.2)',
        }}>
        <UserCircle2 size={16} style={{
          color: ev.viewerUserId ? 'rgba(96,165,250,0.95)' : 'rgba(148,163,184,0.9)',
        }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
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
          <p className="mb-0.5 truncate text-[11px] text-token-secondary">
            {ev.entryTitle}
          </p>
        )}
        <div className="flex items-center gap-3 text-[10px] text-token-muted">
          <span>{formatRelative(ev.enteredAt)}</span>
          <span>·</span>
          <span>停留 {formatDurationMs(ev.durationMs)}</span>
        </div>
      </div>
    </li>
  );
}
