import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import {
  listTransfers,
  createTransfer,
  acceptTransfer,
  rejectTransfer,
  cancelTransfer,
  listMyWorkspaces,
  listMyConfigs,
  getUsers,
} from '@/services';
import type {
  AccountDataTransfer,
  ShareableWorkspace,
  ShareablePrompt,
  ShareableRefImage,
} from '@/services/contracts/dataTransfer';
import type { AdminUser } from '@/types/admin';
import { useAuthStore } from '@/stores/authStore';
import {
  Send,
  Check,
  X,
  Package,
  FileText,
  Image,
  RefreshCw,
  Inbox,
  ArrowUpRight,
  User,
  Clock,
  ChevronRight,
  ArrowRight,
  Layers,
  Palette,
  PenLine,
  ImagePlus,
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Timer,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// ─── 工具函数 ───

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeTime(s: string | null | undefined) {
  if (!s) return '';
  const now = Date.now();
  const t = new Date(s).getTime();
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(s);
}

// ─── 常量 ───

const STATUS_MAP: Record<string, { label: string; variant: 'subtle' | 'success' | 'danger' | 'warning' | 'new'; icon: typeof Check }> = {
  pending:    { label: '待接受', variant: 'warning', icon: Timer },
  processing: { label: '处理中', variant: 'new', icon: RefreshCw },
  completed:  { label: '已完成', variant: 'success', icon: CheckCircle2 },
  partial:    { label: '部分完成', variant: 'warning', icon: AlertCircle },
  rejected:   { label: '已拒绝', variant: 'danger', icon: XCircle },
  expired:    { label: '已过期', variant: 'subtle', icon: Clock },
  cancelled:  { label: '已取消', variant: 'subtle', icon: X },
  failed:     { label: '失败', variant: 'danger', icon: XCircle },
};

const SOURCE_ICON: Record<string, { icon: typeof Package; color: string }> = {
  workspace:         { icon: Layers, color: 'rgba(99, 102, 241, 0.9)' },
  'literary-prompt': { icon: PenLine, color: 'rgba(245, 158, 11, 0.9)' },
  'ref-image-config':{ icon: ImagePlus, color: 'rgba(34, 197, 94, 0.9)' },
};

// ═══════════════════ 主页面 ═══════════════════

export default function DataTransferPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('id');

  const [tab, setTab] = useState<'received' | 'sent'>('received');
  const [transfers, setTransfers] = useState<AccountDataTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTransfer, setSelectedTransfer] = useState<AccountDataTransfer | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    const res = await listTransfers(tab);
    if (res.success) setTransfers(res.data.items);
    setLoading(false);
  }, [tab]);

  useEffect(() => { loadTransfers(); }, [tab, loadTransfers]);

  useEffect(() => {
    if (highlightId && transfers.length > 0) {
      const found = transfers.find(t => t.id === highlightId);
      if (found) setSelectedTransfer(found);
    }
  }, [highlightId, transfers]);

  const tabItems = useMemo(() => [
    { key: 'received', label: '收到', icon: <Inbox className="w-3.5 h-3.5" /> },
    { key: 'sent', label: '发出', icon: <ArrowUpRight className="w-3.5 h-3.5" /> },
  ], []);

  const stats = useMemo(() => {
    const pending = transfers.filter(t => t.status === 'pending' && new Date(t.expiresAt) > new Date()).length;
    const completed = transfers.filter(t => t.status === 'completed').length;
    return { pending, completed, total: transfers.length };
  }, [transfers]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 p-5">
      {/* 顶部操作栏 */}
      <TabBar
        title={<span className="text-[15px] font-semibold tracking-tight">数据分享</span>}
        icon={<Sparkles size={16} style={{ color: 'var(--accent-gold)' }} />}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={loadTransfers} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="xs" onClick={() => setShowCreate(true)}>
              <Send className="w-3.5 h-3.5" />
              发起分享
            </Button>
          </div>
        }
      />

      {/* 内容区域 — 左侧列表 + 右侧详情 */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* 左侧：分享列表 */}
        <div className="w-[420px] shrink-0 flex flex-col gap-3 min-h-0">
          {/* 统计概览 */}
          <div className="flex gap-2">
            <MiniStatCard label="待处理" value={stats.pending} accent="warning" />
            <MiniStatCard label="已完成" value={stats.completed} accent="success" />
            <MiniStatCard label="总计" value={stats.total} accent="default" />
          </div>

          {/* 列表切换 Tab */}
          <div className="shrink-0">
            <TabBar
              items={tabItems}
              activeKey={tab}
              onChange={(k) => { setTab(k as 'received' | 'sent'); setSelectedTransfer(null); }}
            />
          </div>

          {/* 列表 */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            ) : transfers.length === 0 ? (
              <EmptyState direction={tab} />
            ) : (
              transfers.map((t) => (
                <TransferCard
                  key={t.id}
                  transfer={t}
                  direction={tab}
                  isActive={selectedTransfer?.id === t.id}
                  onClick={() => setSelectedTransfer(t)}
                />
              ))
            )}
          </div>
        </div>

        {/* 右侧：详情面板 / 创建面板 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {showCreate ? (
            <CreateTransferPanel
              onCreated={() => {
                setShowCreate(false);
                setTab('sent');
                loadTransfers();
              }}
              onCancel={() => setShowCreate(false)}
            />
          ) : selectedTransfer ? (
            <TransferDetail
              transfer={selectedTransfer}
              direction={tab}
              onAction={() => { setSelectedTransfer(null); loadTransfers(); }}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════ 小型统计卡片 ═══════════════════

function MiniStatCard({ label, value, accent }: { label: string; value: number; accent: 'warning' | 'success' | 'default' }) {
  const colors = {
    warning: { bg: 'rgba(245, 158, 11, 0.06)', border: 'rgba(245, 158, 11, 0.15)', text: 'rgba(245, 158, 11, 0.95)' },
    success: { bg: 'rgba(34, 197, 94, 0.06)', border: 'rgba(34, 197, 94, 0.15)', text: 'rgba(34, 197, 94, 0.95)' },
    default: { bg: 'var(--bg-input)', border: 'var(--nested-block-border)', text: 'var(--text-primary)' },
  }[accent];

  return (
    <div
      className="flex-1 rounded-[10px] px-3 py-2 text-center transition-all duration-200"
      style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
    >
      <div className="text-lg font-bold tabular-nums" style={{ color: colors.text, letterSpacing: '-0.02em' }}>{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wider mt-0.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

// ═══════════════════ 骨架屏 ═══════════════════

function SkeletonCard() {
  return (
    <div className="rounded-[12px] p-3.5 animate-pulse" style={{ background: 'var(--bg-input)', border: '1px solid var(--nested-block-border)' }}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full" style={{ background: 'var(--bg-card-hover)' }} />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 rounded w-32" style={{ background: 'var(--bg-card-hover)' }} />
          <div className="h-2.5 rounded w-20" style={{ background: 'var(--bg-card-hover)' }} />
        </div>
      </div>
    </div>
  );
}

// ═══════════════════ 空状态 ═══════════════════

function EmptyState({ direction }: { direction: 'sent' | 'received' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.15)' }}
      >
        {direction === 'received' ? <Inbox size={20} style={{ color: 'var(--accent-gold)' }} /> : <Send size={20} style={{ color: 'var(--accent-gold)' }} />}
      </div>
      <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {direction === 'received' ? '暂无收到的分享' : '暂无发出的分享'}
      </div>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3">
      <div
        className="w-14 h-14 rounded-[14px] flex items-center justify-center"
        style={{ background: 'rgba(99, 102, 241, 0.06)', border: '1px solid rgba(99, 102, 241, 0.12)' }}
      >
        <Package size={24} style={{ color: 'rgba(99, 102, 241, 0.4)' }} />
      </div>
      <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>选择一条分享记录查看详情</div>
    </div>
  );
}

// ═══════════════════ 分享卡片 ═══════════════════

function TransferCard({
  transfer: t,
  direction,
  isActive,
  onClick,
}: {
  transfer: AccountDataTransfer;
  direction: 'sent' | 'received';
  isActive: boolean;
  onClick: () => void;
}) {
  const status = STATUS_MAP[t.status] ?? { label: t.status, variant: 'subtle' as const, icon: Clock };
  const isExpired = new Date(t.expiresAt) < new Date() && t.status === 'pending';
  const StatusIcon = isExpired ? Clock : status.icon;

  return (
    <div
      className="group rounded-[12px] p-3.5 cursor-pointer transition-all duration-200"
      style={{
        background: isActive ? 'rgba(99, 102, 241, 0.08)' : 'var(--bg-input)',
        border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.25)' : 'var(--nested-block-border)'}`,
      }}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        {/* 头像占位 */}
        <div
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-gold)' }}
        >
          {direction === 'received'
            ? (t.senderUserName?.[0] ?? 'U')
            : (t.receiverUserName?.[0] ?? 'U')}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {direction === 'received' ? t.senderUserName : (t.receiverUserName ?? t.receiverUserId)}
              </span>
              <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
              <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                {direction === 'received' ? '分享给你' : '收到你的分享'}
              </span>
            </div>
            <ChevronRight size={14} className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: 'var(--text-muted)' }} />
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <Badge variant={isExpired ? 'subtle' : status.variant} size="sm" icon={<StatusIcon size={10} />}>
              {isExpired ? '已过期' : status.label}
            </Badge>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.items.length} 项</span>
            <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{relativeTime(t.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════ 分享详情面板 ═══════════════════

function TransferDetail({
  transfer: t,
  direction,
  onAction,
}: {
  transfer: AccountDataTransfer;
  direction: 'sent' | 'received';
  onAction: () => void;
}) {
  const [actionLoading, setActionLoading] = useState(false);
  const status = STATUS_MAP[t.status] ?? { label: t.status, variant: 'subtle' as const, icon: Clock };
  const isExpired = new Date(t.expiresAt) < new Date() && t.status === 'pending';
  const StatusIcon = isExpired ? Clock : status.icon;

  const handleAccept = async () => {
    setActionLoading(true);
    const res = await acceptTransfer(t.id);
    setActionLoading(false);
    if (res.success) onAction();
  };

  const handleReject = async () => {
    setActionLoading(true);
    await rejectTransfer(t.id);
    setActionLoading(false);
    onAction();
  };

  const handleCancel = async () => {
    setActionLoading(true);
    await cancelTransfer(t.id);
    setActionLoading(false);
    onAction();
  };

  return (
    <GlassCard accentHue={234} padding="none" className="h-full flex flex-col">
      {/* 头部信息 */}
      <div className="px-5 pt-5 pb-4" style={{ borderBottom: '1px solid var(--nested-block-border)' }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-full flex items-center justify-center text-[15px] font-bold"
              style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-gold)' }}
            >
              {direction === 'received'
                ? (t.senderUserName?.[0] ?? 'U')
                : (t.receiverUserName?.[0] ?? 'U')}
            </div>
            <div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {direction === 'received' ? t.senderUserName : (t.receiverUserName ?? t.receiverUserId)}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {direction === 'received' ? '发送给你' : '接收你的分享'}
                </span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{fmtDate(t.createdAt)}</span>
              </div>
            </div>
          </div>
          <Badge variant={isExpired ? 'subtle' : status.variant} icon={<StatusIcon size={11} />}>
            {isExpired ? '已过期' : status.label}
          </Badge>
        </div>

        {/* 附言 */}
        {t.message && (
          <div
            className="mt-3 rounded-[10px] px-3.5 py-2.5 flex items-start gap-2"
            style={{ background: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.1)' }}
          >
            <MessageSquare size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-gold)' }} />
            <span className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{t.message}</span>
          </div>
        )}
      </div>

      {/* 分享内容列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          分享内容 ({t.items.length})
        </div>

        <div className="space-y-2">
          {t.items.map((item, i) => {
            const si = SOURCE_ICON[item.sourceType] ?? { icon: Package, color: 'var(--text-muted)' };
            const Icon = si.icon;

            return (
              <div
                key={i}
                className="rounded-[10px] px-3.5 py-2.5 flex items-center gap-3 transition-all duration-150"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--nested-block-border)' }}
              >
                <div
                  className="shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center"
                  style={{ background: `${si.color}15`, border: `1px solid ${si.color}25` }}
                >
                  <Icon size={15} style={{ color: si.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {item.displayName}
                  </div>
                  {item.previewInfo && (
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{item.previewInfo}</div>
                  )}
                </div>
                {item.appKey && (
                  <Badge variant="subtle" size="sm">
                    {item.appKey === 'literary-agent' ? '文学' : '视觉'}
                  </Badge>
                )}
                {/* 克隆状态图标 */}
                {item.cloneStatus === 'success' && <CheckCircle2 size={15} style={{ color: 'rgba(34, 197, 94, 0.8)' }} />}
                {item.cloneStatus === 'failed' && (
                  <span className="flex items-center gap-1">
                    <XCircle size={15} style={{ color: 'rgba(239, 68, 68, 0.8)' }} />
                    {item.cloneError && (
                      <span className="text-[10px] max-w-[100px] truncate" style={{ color: 'rgba(239, 68, 68, 0.8)' }}>{item.cloneError}</span>
                    )}
                  </span>
                )}
                {item.cloneStatus === 'source_missing' && (
                  <Badge variant="warning" size="sm">源已删除</Badge>
                )}
              </div>
            );
          })}
        </div>

        {/* 结果统计 */}
        {t.result && (
          <div
            className="mt-4 rounded-[10px] px-3.5 py-3 flex items-center gap-4"
            style={{ background: 'rgba(34, 197, 94, 0.04)', border: '1px solid rgba(34, 197, 94, 0.12)' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>执行结果</div>
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-medium" style={{ color: 'rgba(34, 197, 94, 0.9)' }}>成功 {t.result.successCount}</span>
              {t.result.failedCount > 0 && <span className="text-[12px] font-medium" style={{ color: 'rgba(239, 68, 68, 0.9)' }}>失败 {t.result.failedCount}</span>}
              {t.result.skippedCount > 0 && <span className="text-[12px] font-medium" style={{ color: 'rgba(245, 158, 11, 0.9)' }}>跳过 {t.result.skippedCount}</span>}
              {t.result.totalAssetsCopied > 0 && <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>图片 {t.result.totalAssetsCopied}</span>}
            </div>
          </div>
        )}

        {/* 过期时间 */}
        <div className="mt-4 flex items-center gap-1.5">
          <Clock size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {isExpired ? '已于 ' + fmtDate(t.expiresAt) + ' 过期' : '有效期至 ' + fmtDate(t.expiresAt)}
          </span>
        </div>
      </div>

      {/* 底部操作 */}
      {t.status === 'pending' && !isExpired && (
        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '1px solid var(--nested-block-border)' }}>
          {direction === 'received' && (
            <>
              <Button onClick={handleAccept} disabled={actionLoading} size="sm">
                <Check className="w-3.5 h-3.5" />
                {actionLoading ? '处理中...' : '接受并复制'}
              </Button>
              <Button variant="secondary" onClick={handleReject} disabled={actionLoading} size="sm">
                <X className="w-3.5 h-3.5" />
                拒绝
              </Button>
            </>
          )}
          {direction === 'sent' && (
            <Button variant="secondary" onClick={handleCancel} disabled={actionLoading} size="sm">
              取消分享
            </Button>
          )}
        </div>
      )}
    </GlassCard>
  );
}

// ═══════════════════ 创建分享面板 ═══════════════════

function CreateTransferPanel({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [receiverUserId, setReceiverUserId] = useState('');
  const [message, setMessage] = useState('');

  const [workspaces, setWorkspaces] = useState<ShareableWorkspace[]>([]);
  const [prompts, setPrompts] = useState<ShareablePrompt[]>([]);
  const [refImages, setRefImages] = useState<ShareableRefImage[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const currentUser = useAuthStore((s) => s.user);

  useEffect(() => {
    (async () => {
      setLoadingData(true);
      const [usersRes, wsRes, configRes] = await Promise.all([
        getUsers({ page: 1, pageSize: 200 }),
        listMyWorkspaces(),
        listMyConfigs(),
      ]);
      if (usersRes.success) setUsers(usersRes.data.items.filter((u) => u.userId !== currentUser?.userId && u.status === 'Active'));
      if (wsRes.success) setWorkspaces(wsRes.data.items);
      if (configRes.success) {
        setPrompts(configRes.data.prompts);
        setRefImages(configRes.data.refImages);
      }
      setLoadingData(false);
    })();
  }, [currentUser?.userId]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (keys: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = keys.every(k => next.has(k));
      keys.forEach(k => { if (allSelected) next.delete(k); else next.add(k); });
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!receiverUserId || selectedIds.size === 0) return;
    setSubmitting(true);

    const items = Array.from(selectedIds).map((key) => {
      const [sourceType, ...rest] = key.split(':');
      const sourceId = rest.join(':');
      const ws = workspaces.find((w) => w.id === sourceId);
      return {
        sourceType,
        sourceId,
        appKey: ws?.scenarioType === 'article-illustration' ? 'literary-agent' : undefined,
      };
    });

    const res = await createTransfer({ receiverUserId, message: message.trim() || undefined, items });
    setSubmitting(false);
    if (res.success) onCreated();
  };

  const literaryWs = workspaces.filter((w) => w.scenarioType === 'article-illustration');
  const visualWs = workspaces.filter((w) => w.scenarioType !== 'article-illustration');
  const selectedReceiver = users.find(u => u.userId === receiverUserId);

  return (
    <GlassCard accentHue={210} padding="none" className="h-full flex flex-col">
      {/* 头部 */}
      <div className="px-5 pt-5 pb-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--nested-block-border)' }}>
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-[8px] flex items-center justify-center"
            style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)' }}
          >
            <Send size={14} style={{ color: 'var(--accent-gold)' }} />
          </div>
          <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>发起数据分享</span>
        </div>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <X size={14} /> 关闭
        </Button>
      </div>

      {/* 内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
        {loadingData ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : (
          <>
            {/* 接收人选择 */}
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                接收人
              </div>
              <Select
                value={receiverUserId}
                onValueChange={setReceiverUserId}
                placeholder="选择接收用户..."
                leftIcon={<User size={14} />}
              >
                {users.map(u => (
                  <option key={u.userId} value={u.userId}>
                    {u.displayName} ({u.username})
                  </option>
                ))}
              </Select>
              {selectedReceiver && (
                <div className="flex items-center gap-2 px-1">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold" style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-gold)' }}>
                    {selectedReceiver.displayName?.[0] ?? 'U'}
                  </div>
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    将发送系统通知给 {selectedReceiver.displayName}
                  </span>
                </div>
              )}
            </section>

            {/* 附言 */}
            <section className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                附言 <span className="normal-case font-normal">(可选)</span>
              </div>
              <input
                type="text"
                className="w-full rounded-[10px] px-3.5 py-2.5 text-[13px] outline-none transition-all duration-200 focus:ring-1"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--nested-block-border)',
                  color: 'var(--text-primary)',
                }}
                placeholder="例如：我要换账号了，数据给你"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </section>

            {/* 文学创作工作区 */}
            {literaryWs.length > 0 && (
              <DataSection
                title="文学创作"
                icon={<PenLine size={13} />}
                iconColor="rgba(245, 158, 11, 0.9)"
                count={literaryWs.length}
                selectedCount={literaryWs.filter(w => selectedIds.has(`workspace:${w.id}`)).length}
                onToggleAll={() => toggleAll(literaryWs.map(w => `workspace:${w.id}`))}
              >
                {literaryWs.map(ws => (
                  <WorkspaceCheckItem
                    key={ws.id}
                    ws={ws}
                    checked={selectedIds.has(`workspace:${ws.id}`)}
                    onChange={() => toggle(`workspace:${ws.id}`)}
                  />
                ))}
              </DataSection>
            )}

            {/* 视觉创作工作区 */}
            {visualWs.length > 0 && (
              <DataSection
                title="视觉创作"
                icon={<Palette size={13} />}
                iconColor="rgba(99, 102, 241, 0.9)"
                count={visualWs.length}
                selectedCount={visualWs.filter(w => selectedIds.has(`workspace:${w.id}`)).length}
                onToggleAll={() => toggleAll(visualWs.map(w => `workspace:${w.id}`))}
              >
                {visualWs.map(ws => (
                  <WorkspaceCheckItem
                    key={ws.id}
                    ws={ws}
                    checked={selectedIds.has(`workspace:${ws.id}`)}
                    onChange={() => toggle(`workspace:${ws.id}`)}
                  />
                ))}
              </DataSection>
            )}

            {/* 配置资源 */}
            {(prompts.length > 0 || refImages.length > 0) && (
              <DataSection
                title="配置资源"
                icon={<FileText size={13} />}
                iconColor="rgba(34, 197, 94, 0.9)"
                count={prompts.length + refImages.length}
                selectedCount={
                  prompts.filter(p => selectedIds.has(`literary-prompt:${p.id}`)).length +
                  refImages.filter(r => selectedIds.has(`ref-image-config:${r.id}`)).length
                }
                onToggleAll={() => toggleAll([
                  ...prompts.map(p => `literary-prompt:${p.id}`),
                  ...refImages.map(r => `ref-image-config:${r.id}`),
                ])}
              >
                {prompts.map((p) => (
                  <ConfigCheckItem
                    key={p.id}
                    label={p.title}
                    badge="提示词"
                    icon={<PenLine size={13} style={{ color: 'rgba(245, 158, 11, 0.7)' }} />}
                    checked={selectedIds.has(`literary-prompt:${p.id}`)}
                    onChange={() => toggle(`literary-prompt:${p.id}`)}
                  />
                ))}
                {refImages.map((r) => (
                  <ConfigCheckItem
                    key={r.id}
                    label={r.name}
                    badge="参考图"
                    icon={<Image size={13} style={{ color: 'rgba(34, 197, 94, 0.7)' }} />}
                    checked={selectedIds.has(`ref-image-config:${r.id}`)}
                    onChange={() => toggle(`ref-image-config:${r.id}`)}
                  />
                ))}
              </DataSection>
            )}
          </>
        )}
      </div>

      {/* 底部提交栏 */}
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderTop: '1px solid var(--nested-block-border)' }}>
        <div className="flex items-center gap-1.5">
          <Layers size={13} style={{ color: 'var(--accent-gold)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
            已选择 <span style={{ color: 'var(--text-primary)' }}>{selectedIds.size}</span> 项
          </span>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={!receiverUserId || selectedIds.size === 0 || submitting}
          size="sm"
        >
          <Send className="w-3.5 h-3.5" />
          {submitting ? '发送中...' : '发送分享'}
        </Button>
      </div>
    </GlassCard>
  );
}

// ═══════════════════ 数据分组组件 ═══════════════════

function DataSection({
  title,
  icon,
  iconColor,
  count,
  selectedCount,
  onToggleAll,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  count: number;
  selectedCount: number;
  onToggleAll: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-[6px] flex items-center justify-center"
            style={{ background: `${iconColor}15`, border: `1px solid ${iconColor}25` }}
          >
            <span style={{ color: iconColor }}>{icon}</span>
          </div>
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {selectedCount > 0 ? `${selectedCount}/${count}` : count}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] px-2 py-0.5 rounded-[6px] transition-colors hover:bg-white/6"
          style={{ color: 'var(--accent-gold)' }}
          onClick={onToggleAll}
        >
          {selectedCount === count ? '取消全选' : '全选'}
        </button>
      </div>
      <div className="space-y-1.5">
        {children}
      </div>
    </section>
  );
}

// ═══════════════════ 复选框项目组件 ═══════════════════

function WorkspaceCheckItem({ ws, checked, onChange }: { ws: ShareableWorkspace; checked: boolean; onChange: () => void }) {
  return (
    <label
      className="flex items-center gap-3 rounded-[10px] px-3 py-2.5 cursor-pointer transition-all duration-150"
      style={{
        background: checked ? 'rgba(99, 102, 241, 0.06)' : 'var(--bg-input)',
        border: `1px solid ${checked ? 'rgba(99, 102, 241, 0.2)' : 'var(--nested-block-border)'}`,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-primary sr-only"
      />
      <div
        className="shrink-0 w-5 h-5 rounded-[5px] flex items-center justify-center transition-all duration-150"
        style={{
          background: checked ? 'rgba(99, 102, 241, 0.9)' : 'transparent',
          border: `1.5px solid ${checked ? 'rgba(99, 102, 241, 0.9)' : 'rgba(255,255,255,0.2)'}`,
        }}
      >
        {checked && <Check size={12} className="text-white" />}
      </div>
      <Layers size={15} className="shrink-0" style={{ color: 'rgba(99, 102, 241, 0.6)' }} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{ws.title}</div>
      </div>
      <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{ws.assetCount} 张图</span>
      {ws.folderName && (
        <Badge variant="subtle" size="sm">{ws.folderName}</Badge>
      )}
    </label>
  );
}

function ConfigCheckItem({
  label,
  badge,
  icon,
  checked,
  onChange,
}: {
  label: string;
  badge: string;
  icon: React.ReactNode;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className="flex items-center gap-3 rounded-[10px] px-3 py-2.5 cursor-pointer transition-all duration-150"
      style={{
        background: checked ? 'rgba(99, 102, 241, 0.06)' : 'var(--bg-input)',
        border: `1px solid ${checked ? 'rgba(99, 102, 241, 0.2)' : 'var(--nested-block-border)'}`,
      }}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      <div
        className="shrink-0 w-5 h-5 rounded-[5px] flex items-center justify-center transition-all duration-150"
        style={{
          background: checked ? 'rgba(99, 102, 241, 0.9)' : 'transparent',
          border: `1.5px solid ${checked ? 'rgba(99, 102, 241, 0.9)' : 'rgba(255,255,255,0.2)'}`,
        }}
      >
        {checked && <Check size={12} className="text-white" />}
      </div>
      {icon}
      <span className="flex-1 text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <Badge variant="subtle" size="sm">{badge}</Badge>
    </label>
  );
}
