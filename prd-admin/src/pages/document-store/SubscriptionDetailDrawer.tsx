import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Rss,
  Github,
  RefreshCw,
  Pause,
  Play,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitCommit,
  FilePlus,
  FileMinus,
  FileEdit,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  listSubscriptionDetail,
  triggerSync,
  updateSubscription,
} from '@/services';
import type { DocumentEntry, SubscriptionDetail } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

// ── 时间格式化辅助 ──

function formatRelative(iso?: string | null): string {
  if (!iso) return '从未';
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const absMs = Math.abs(diffMs);
  const future = diffMs < 0;

  const seconds = Math.floor(absMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let phrase: string;
  if (seconds < 60) phrase = '刚刚';
  else if (minutes < 60) phrase = `${minutes} 分钟`;
  else if (hours < 24) phrase = `${hours} 小时`;
  else if (days < 30) phrase = `${days} 天`;
  else phrase = date.toLocaleDateString('zh-CN');

  if (phrase === '刚刚') return phrase;
  return future ? `${phrase}后` : `${phrase}前`;
}

function formatAbsolute(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function formatInterval(min?: number): string {
  if (!min || min <= 0) return '—';
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) return `${min / 60} 小时`;
  return `${min / 1440} 天`;
}

// ── 状态徽标 ──

function StatusBadge({ status, paused }: { status?: string; paused: boolean }) {
  if (paused) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
        style={{ background: 'rgba(148,163,184,0.12)', color: 'rgba(148,163,184,0.95)', border: '1px solid rgba(148,163,184,0.2)' }}>
        <Pause size={10} /> 已暂停
      </span>
    );
  }
  if (status === 'syncing') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
        style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(96,165,250,0.95)', border: '1px solid rgba(59,130,246,0.25)' }}>
        <MapSpinner size={10} /> 同步中
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
        style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(239,68,68,0.25)' }}>
        <AlertCircle size={10} /> 出错
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
      style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.95)', border: '1px solid rgba(34,197,94,0.25)' }}>
      <CheckCircle2 size={10} /> 正常
    </span>
  );
}

// ── 时间线节点（一条变化记录） ──

function TimelineEntry({ log }: { log: SubscriptionDetail['logs'][number] }) {
  const isError = log.kind === 'error';
  const accent = isError ? '239,68,68' : '59,130,246';
  return (
    <li className="relative pl-6 pb-4">
      {/* 左侧圆点 */}
      <span className="absolute left-0 top-1 w-3 h-3 rounded-full"
        style={{
          background: `rgba(${accent},0.18)`,
          border: `2px solid rgba(${accent},0.6)`,
        }}
      />
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {formatRelative(log.syncedAt)}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {formatAbsolute(log.syncedAt)}
        </span>
      </div>
      {isError ? (
        <p className="text-[12px] break-all" style={{ color: 'rgba(248,113,113,0.95)' }}>
          {log.errorMessage ?? '同步出错'}
        </p>
      ) : (
        <>
          <p className="text-[12px]" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>
            {log.changeSummary ?? '内容已更新'}
          </p>
          {log.fileChanges && log.fileChanges.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {log.fileChanges.slice(0, 8).map((fc, idx) => {
                const Icon = fc.action === 'added' ? FilePlus : fc.action === 'deleted' ? FileMinus : FileEdit;
                const color = fc.action === 'added' ? 'rgba(74,222,128,0.85)'
                  : fc.action === 'deleted' ? 'rgba(248,113,113,0.85)'
                  : 'rgba(96,165,250,0.85)';
                return (
                  <li key={idx} className="flex items-center gap-1.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    <Icon size={11} style={{ color }} />
                    <span className="truncate">{fc.path}</span>
                  </li>
                );
              })}
              {log.fileChanges.length > 8 && (
                <li className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  …还有 {log.fileChanges.length - 8} 个文件
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

// ── 主组件 ──

export type SubscriptionDetailDrawerProps = {
  entryId: string;
  onClose: () => void;
  /** 状态变更后回调（暂停/恢复/手动同步），用于父组件刷新 entry 列表 */
  onChanged?: (entry?: DocumentEntry) => void;
};

export function SubscriptionDetailDrawer({ entryId, onClose, onChanged }: SubscriptionDetailDrawerProps) {
  const [data, setData] = useState<SubscriptionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSubscriptionDetail(entryId, 30);
    if (res.success) {
      setData(res.data);
    } else {
      toast.error('加载订阅详情失败', res.error?.message);
    }
    setLoading(false);
  }, [entryId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleManualSync = useCallback(async () => {
    if (!data) return;
    setActing(true);
    const res = await triggerSync(entryId);
    if (res.success) {
      toast.success('已触发同步', '后台正在拉取最新内容，稍候刷新查看结果');
      // 立刻把状态推进到 syncing 状态，避免视觉静止
      setData(prev => prev ? { ...prev, entry: { ...prev.entry, syncStatus: 'syncing' } } : prev);
      onChanged?.();
      // 5 秒后再拉一次详情看是否有新日志
      setTimeout(() => { load(); onChanged?.(); }, 5000);
    } else {
      toast.error('触发同步失败', res.error?.message);
    }
    setActing(false);
  }, [data, entryId, load, onChanged]);

  const handleTogglePause = useCallback(async () => {
    if (!data) return;
    const next = !data.entry.isPaused;
    setActing(true);
    const res = await updateSubscription(entryId, { isPaused: next });
    if (res.success) {
      toast.success(next ? '订阅已暂停' : '订阅已恢复');
      setData(prev => prev ? { ...prev, entry: { ...prev.entry, isPaused: next } } : prev);
      onChanged?.(res.data);
    } else {
      toast.error('操作失败', res.error?.message);
    }
    setActing(false);
  }, [data, entryId, onChanged]);

  const handleIntervalChange = useCallback(async (minutes: number) => {
    setActing(true);
    const res = await updateSubscription(entryId, { syncIntervalMinutes: minutes });
    if (res.success) {
      toast.success('同步间隔已更新');
      setData(prev => prev ? { ...prev, entry: { ...prev.entry, syncIntervalMinutes: res.data.syncIntervalMinutes } } : prev);
      onChanged?.(res.data);
    } else {
      toast.error('更新失败', res.error?.message);
    }
    setActing(false);
  }, [entryId, onChanged]);

  const isGithub = data?.entry.sourceType === 'github_directory';
  const accent = isGithub ? '130,80,223' : '234,179,8';
  const Icon = isGithub ? Github : Rss;

  // 间隔选项：GitHub 最小 1 小时（避免 API 限流），URL 5 分钟起
  const intervalOptions = isGithub ? [60, 360, 720, 1440] : [15, 60, 360, 1440];

  return (
    <div className="fixed inset-0 z-50 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[480px] max-w-[92vw] h-full flex flex-col"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '-24px 0 48px -12px rgba(0,0,0,0.5)',
        }}>

        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
              style={{ background: `rgba(${accent},0.1)`, border: `1px solid rgba(${accent},0.18)` }}>
              <Icon size={15} style={{ color: `rgba(${accent},0.9)` }} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {data?.entry.title ?? '订阅详情'}
              </p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {isGithub ? 'GitHub 目录订阅' : 'URL 订阅源'}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200 flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 内容区 */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSectionLoader text="加载订阅详情…" />
          </div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            未能加载订阅详情
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* 状态卡 */}
            <div className="mx-5 mt-4 p-4 rounded-[12px]"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>当前状态</span>
                <StatusBadge status={data.entry.syncStatus} paused={data.entry.isPaused} />
              </div>

              {/* 源 URL */}
              {data.entry.sourceUrl && (
                <div className="mb-2">
                  <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>源地址</p>
                  <a href={data.entry.sourceUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] flex items-center gap-1 break-all hover:underline"
                    style={{ color: 'rgba(96,165,250,0.9)' }}>
                    <ExternalLink size={10} className="flex-shrink-0" />
                    <span className="truncate">{data.entry.sourceUrl}</span>
                  </a>
                </div>
              )}

              {/* 时间网格 */}
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>上次检查</p>
                  <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {formatRelative(data.entry.lastSyncAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>下次检查</p>
                  <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {data.entry.isPaused ? '已暂停' : formatRelative(data.entry.nextSyncAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>最近变化</p>
                  <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {formatRelative(data.entry.lastChangedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>同步间隔</p>
                  <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {formatInterval(data.entry.syncIntervalMinutes)}
                  </p>
                </div>
              </div>

              {/* 错误信息 */}
              {data.entry.syncStatus === 'error' && data.entry.syncError && (
                <div className="mt-3 px-2.5 py-1.5 rounded-[8px] text-[11px] break-all"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: 'rgba(248,113,113,0.95)',
                  }}>
                  {data.entry.syncError}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex gap-2 mt-4">
                <Button variant="secondary" size="xs"
                  onClick={handleManualSync}
                  disabled={acting || data.entry.isPaused || data.entry.syncStatus === 'syncing'}
                  className="flex-1">
                  {acting && data.entry.syncStatus !== 'syncing' ? <MapSpinner size={11} /> : <RefreshCw size={11} />}
                  立即同步
                </Button>
                <Button variant="secondary" size="xs"
                  onClick={handleTogglePause}
                  disabled={acting}
                  className="flex-1">
                  {data.entry.isPaused ? <Play size={11} /> : <Pause size={11} />}
                  {data.entry.isPaused ? '恢复订阅' : '暂停订阅'}
                </Button>
              </div>
            </div>

            {/* 间隔调整 */}
            <div className="mx-5 mt-4">
              <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>调整同步间隔</p>
              <div className="flex gap-1.5">
                {intervalOptions.map(m => {
                  const active = data.entry.syncIntervalMinutes === m;
                  return (
                    <button key={m} onClick={() => handleIntervalChange(m)}
                      disabled={acting}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200 disabled:opacity-50"
                      style={{
                        background: active ? `rgba(${accent},0.1)` : 'rgba(255,255,255,0.02)',
                        border: active ? `1px solid rgba(${accent},0.25)` : '1px solid rgba(255,255,255,0.06)',
                        color: active ? `rgba(${accent},0.95)` : 'var(--text-muted)',
                      }}>
                      {formatInterval(m)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 时间线 */}
            <div className="mx-5 mt-5 mb-5">
              <div className="flex items-center gap-2 mb-3">
                <GitCommit size={12} style={{ color: 'var(--text-muted)' }} />
                <p className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                  最近变化（共 {data.logs.length} 条）
                </p>
              </div>
              {data.logs.length === 0 ? (
                <div className="text-center py-8"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: '10px',
                  }}>
                  <Clock size={20} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.2)' }} />
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    暂无变化记录
                  </p>
                  <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    内容未发生变化的同步不会落库，避免日志膨胀
                  </p>
                </div>
              ) : (
                <ol className="relative pl-2"
                  style={{
                    borderLeft: '1px dashed rgba(255,255,255,0.08)',
                    marginLeft: '5px',
                  }}>
                  {data.logs.map(log => <TimelineEntry key={log.id} log={log} />)}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
