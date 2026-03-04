import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
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
  ChevronDown,
  Package,
  FileText,
  Image,
  RefreshCw,
  Inbox,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATUS_MAP: Record<string, { label: string; variant: 'subtle' | 'success' | 'danger' | 'warning' | 'new' }> = {
  pending: { label: '待接受', variant: 'warning' },
  processing: { label: '处理中', variant: 'new' },
  completed: { label: '已完成', variant: 'success' },
  partial: { label: '部分完成', variant: 'warning' },
  rejected: { label: '已拒绝', variant: 'danger' },
  expired: { label: '已过期', variant: 'subtle' },
  cancelled: { label: '已取消', variant: 'subtle' },
  failed: { label: '失败', variant: 'danger' },
};

const SOURCE_TYPE_LABELS: Record<string, { label: string; icon: typeof Package }> = {
  workspace: { label: '工作区', icon: Package },
  'literary-prompt': { label: '提示词', icon: FileText },
  'ref-image-config': { label: '参考图', icon: Image },
};

// ═══════════════════ 主页面 ═══════════════════

export default function DataTransferPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('id');

  const [tab, setTab] = useState<'received' | 'sent' | 'create'>('received');
  const [transfers, setTransfers] = useState<AccountDataTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(highlightId);

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    const dir = tab === 'create' ? undefined : tab;
    const res = await listTransfers(dir);
    if (res.success) setTransfers(res.data.items);
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'create') loadTransfers();
  }, [tab, loadTransfers]);

  useEffect(() => {
    if (highlightId) setDetailId(highlightId);
  }, [highlightId]);

  const tabItems = useMemo(() => [
    { key: 'received', label: '收到的分享', icon: <Inbox className="w-4 h-4" /> },
    { key: 'sent', label: '发出的分享', icon: <Send className="w-4 h-4" /> },
    { key: 'create', label: '发起分享', icon: <Package className="w-4 h-4" /> },
  ], []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据分享</h1>
        {tab !== 'create' && (
          <Button variant="ghost" size="sm" onClick={loadTransfers} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>

      <TabBar
        items={tabItems}
        activeKey={tab}
        onChange={(k) => setTab(k as 'received' | 'sent' | 'create')}
      />

      {tab === 'create' ? (
        <CreateTransferPanel onCreated={() => { setTab('sent'); loadTransfers(); }} />
      ) : (
        <TransferList
          transfers={transfers}
          loading={loading}
          direction={tab}
          onAction={loadTransfers}
          detailId={detailId}
          setDetailId={setDetailId}
        />
      )}
    </div>
  );
}

// ═══════════════════ 分享列表 ═══════════════════

function TransferList({
  transfers,
  loading,
  direction,
  onAction,
  detailId,
  setDetailId,
}: {
  transfers: AccountDataTransfer[];
  loading: boolean;
  direction: 'sent' | 'received';
  onAction: () => void;
  detailId: string | null;
  setDetailId: (id: string | null) => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAccept = async (id: string) => {
    setActionLoading(id);
    const res = await acceptTransfer(id);
    setActionLoading(null);
    if (res.success) onAction();
  };

  const handleReject = async (id: string) => {
    setActionLoading(id);
    await rejectTransfer(id);
    setActionLoading(null);
    onAction();
  };

  const handleCancel = async (id: string) => {
    setActionLoading(id);
    await cancelTransfer(id);
    setActionLoading(null);
    onAction();
  };

  if (loading) return <div className="text-center py-12 text-muted-foreground">加载中...</div>;
  if (transfers.length === 0) return <div className="text-center py-12 text-muted-foreground">暂无数据</div>;

  return (
    <div className="space-y-3">
      {transfers.map((t) => {
        const status = STATUS_MAP[t.status] ?? { label: t.status, variant: 'subtle' as const };
        const isExpired = new Date(t.expiresAt) < new Date() && t.status === 'pending';
        const isOpen = detailId === t.id;

        return (
          <GlassCard key={t.id} className="p-4">
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => setDetailId(isOpen ? null : t.id)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="text-sm font-medium truncate">
                  {direction === 'received' ? (
                    <><span className="text-muted-foreground">来自</span> {t.senderUserName}</>
                  ) : (
                    <><span className="text-muted-foreground">发给</span> {t.receiverUserName ?? t.receiverUserId}</>
                  )}
                </div>
                <Badge variant={isExpired ? 'subtle' : status.variant} className="text-xs shrink-0">
                  {isExpired ? '已过期' : status.label}
                </Badge>
                <span className="text-xs text-muted-foreground shrink-0">{t.items.length} 项</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{fmtDate(t.createdAt)}</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </div>
            </div>

            {isOpen && (
              <div className="mt-4 space-y-3 border-t pt-3 border-border/50">
                {t.message && (
                  <div className="text-sm bg-muted/30 rounded p-2">
                    <span className="text-muted-foreground">附言：</span>{t.message}
                  </div>
                )}

                <div className="space-y-1">
                  {t.items.map((item, i) => {
                    const st = SOURCE_TYPE_LABELS[item.sourceType] ?? { label: item.sourceType, icon: Package };
                    const Icon = st.icon;
                    return (
                      <div key={i} className="flex items-center gap-2 text-sm py-1">
                        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{item.displayName}</span>
                        {item.previewInfo && <span className="text-xs text-muted-foreground">({item.previewInfo})</span>}
                        {item.appKey && (
                          <Badge variant="subtle" className="text-xs ml-auto shrink-0">
                            {item.appKey === 'literary-agent' ? '文学' : '视觉'}
                          </Badge>
                        )}
                        {item.cloneStatus === 'success' && <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                        {item.cloneStatus === 'failed' && (
                          <span className="text-xs text-red-500 shrink-0" title={item.cloneError ?? ''}>失败</span>
                        )}
                        {item.cloneStatus === 'source_missing' && (
                          <span className="text-xs text-yellow-500 shrink-0">源已删除</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {t.result && (
                  <div className="text-xs text-muted-foreground flex gap-3">
                    <span>成功 {t.result.successCount}</span>
                    {t.result.failedCount > 0 && <span className="text-red-400">失败 {t.result.failedCount}</span>}
                    {t.result.skippedCount > 0 && <span className="text-yellow-400">跳过 {t.result.skippedCount}</span>}
                    {t.result.totalAssetsCopied > 0 && <span>图片 {t.result.totalAssetsCopied}</span>}
                  </div>
                )}

                {t.status === 'pending' && !isExpired && (
                  <div className="flex gap-2 pt-1">
                    {direction === 'received' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => handleAccept(t.id)}
                          disabled={actionLoading === t.id}
                        >
                          <Check className="w-4 h-4 mr-1" />
                          {actionLoading === t.id ? '处理中...' : '接受并复制'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleReject(t.id)}
                          disabled={actionLoading === t.id}
                        >
                          <X className="w-4 h-4 mr-1" />拒绝
                        </Button>
                      </>
                    )}
                    {direction === 'sent' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleCancel(t.id)}
                        disabled={actionLoading === t.id}
                      >
                        取消分享
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </GlassCard>
        );
      })}
    </div>
  );
}

// ═══════════════════ 创建分享面板 ═══════════════════

function CreateTransferPanel({ onCreated }: { onCreated: () => void }) {
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

  const selectAllWorkspaces = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = workspaces.every((w) => next.has(`workspace:${w.id}`));
      workspaces.forEach((w) => {
        if (allSelected) next.delete(`workspace:${w.id}`);
        else next.add(`workspace:${w.id}`);
      });
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

  if (loadingData) return <div className="text-center py-12 text-muted-foreground">加载中...</div>;

  const literaryWs = workspaces.filter((w) => w.scenarioType === 'article-illustration');
  const visualWs = workspaces.filter((w) => w.scenarioType !== 'article-illustration');

  return (
    <div className="space-y-6">
      <GlassCard className="p-4 space-y-3">
        <label className="text-sm font-medium">接收人</label>
        <select
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
          value={receiverUserId}
          onChange={(e) => setReceiverUserId(e.target.value)}
        >
          <option value="">选择接收用户...</option>
          {users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.displayName} ({u.username})
            </option>
          ))}
        </select>

        <label className="text-sm font-medium">附言（可选）</label>
        <input
          type="text"
          className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
          placeholder="例如：我要换账号了，数据给你"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </GlassCard>

      {literaryWs.length > 0 && (
        <GlassCard className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">文学创作工作区</h3>
            <Button variant="ghost" size="sm" onClick={selectAllWorkspaces} className="text-xs">
              全选/取消
            </Button>
          </div>
          {literaryWs.map((ws) => (
            <WorkspaceCheckItem
              key={ws.id}
              ws={ws}
              checked={selectedIds.has(`workspace:${ws.id}`)}
              onChange={() => toggle(`workspace:${ws.id}`)}
            />
          ))}
        </GlassCard>
      )}

      {visualWs.length > 0 && (
        <GlassCard className="p-4 space-y-2">
          <h3 className="text-sm font-medium">视觉创作工作区</h3>
          {visualWs.map((ws) => (
            <WorkspaceCheckItem
              key={ws.id}
              ws={ws}
              checked={selectedIds.has(`workspace:${ws.id}`)}
              onChange={() => toggle(`workspace:${ws.id}`)}
            />
          ))}
        </GlassCard>
      )}

      {(prompts.length > 0 || refImages.length > 0) && (
        <GlassCard className="p-4 space-y-2">
          <h3 className="text-sm font-medium">配置（可选）</h3>
          {prompts.map((p) => (
            <label key={p.id} className="flex items-center gap-2 py-1 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={selectedIds.has(`literary-prompt:${p.id}`)}
                onChange={() => toggle(`literary-prompt:${p.id}`)}
                className="accent-primary"
              />
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="truncate">{p.title}</span>
              <Badge variant="subtle" className="text-xs ml-auto" size="sm">提示词</Badge>
            </label>
          ))}
          {refImages.map((r) => (
            <label key={r.id} className="flex items-center gap-2 py-1 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={selectedIds.has(`ref-image-config:${r.id}`)}
                onChange={() => toggle(`ref-image-config:${r.id}`)}
                className="accent-primary"
              />
              <Image className="w-4 h-4 text-muted-foreground" />
              <span className="truncate">{r.name}</span>
              <Badge variant="subtle" className="text-xs ml-auto" size="sm">参考图</Badge>
            </label>
          ))}
        </GlassCard>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          已选择 {selectedIds.size} 项
        </span>
        <Button
          onClick={handleSubmit}
          disabled={!receiverUserId || selectedIds.size === 0 || submitting}
        >
          <Send className="w-4 h-4 mr-1" />
          {submitting ? '发送中...' : '发送分享'}
        </Button>
      </div>
    </div>
  );
}

function WorkspaceCheckItem({
  ws,
  checked,
  onChange,
}: {
  ws: ShareableWorkspace;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-2 py-1.5 cursor-pointer text-sm">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-primary" />
      <Package className="w-4 h-4 text-muted-foreground shrink-0" />
      <span className="truncate">{ws.title}</span>
      <span className="text-xs text-muted-foreground shrink-0">({ws.assetCount} 张图)</span>
      {ws.folderName && (
        <Badge variant="subtle" className="text-xs ml-auto shrink-0" size="sm">{ws.folderName}</Badge>
      )}
    </label>
  );
}
