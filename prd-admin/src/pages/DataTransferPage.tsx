import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { BlurText, DecryptedText, ShinyText, SplitText } from '@/components/reactbits';
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
  Search,
  Copy,
  Bell,
  Shield,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';

// --- Utility ---

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

// --- Constants ---

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
  workspace:          { icon: Layers, color: 'rgba(99, 102, 241, 0.9)' },
  'literary-prompt':  { icon: PenLine, color: 'rgba(245, 158, 11, 0.9)' },
  'ref-image-config': { icon: ImagePlus, color: 'rgba(34, 197, 94, 0.9)' },
};

// =================== Main Page ===================

export default function DataTransferPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('id');

  const [tab, setTab] = useState<'received' | 'sent'>('received');
  const [transfers, setTransfers] = useState<AccountDataTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTransfer, setSelectedTransfer] = useState<AccountDataTransfer | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Track if this is the user's very first visit (both directions empty)
  const [isFirstVisit, setIsFirstVisit] = useState<boolean | null>(null);

  const loadTransfers = useCallback(async () => {
    setLoading(true);
    const res = await listTransfers(tab);
    if (res.success) setTransfers(res.data.items);
    setLoading(false);
  }, [tab]);

  // On first mount, check both directions to determine if onboarding should show
  useEffect(() => {
    (async () => {
      const [recvRes, sentRes] = await Promise.all([
        listTransfers('received'),
        listTransfers('sent'),
      ]);
      const recvEmpty = recvRes.success && recvRes.data.items.length === 0;
      const sentEmpty = sentRes.success && sentRes.data.items.length === 0;
      setIsFirstVisit(recvEmpty && sentEmpty);

      // Also populate current tab data from above
      if (recvRes.success) setTransfers(recvRes.data.items);
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload when tab changes (skip initial since useEffect above handles it)
  const [tabInitialized, setTabInitialized] = useState(false);
  useEffect(() => {
    if (!tabInitialized) { setTabInitialized(true); return; }
    loadTransfers();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const pendingCount = useMemo(
    () => transfers.filter(t => t.status === 'pending' && new Date(t.expiresAt) > new Date()).length,
    [transfers],
  );

  const handleCreated = useCallback(() => {
    setShowCreate(false);
    setTab('sent');
    setIsFirstVisit(false);
    loadTransfers();
  }, [loadTransfers]);

  // Show onboarding when both directions are empty
  if (isFirstVisit === true) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-4 p-5 relative">
        <div className="absolute inset-0 z-0 overflow-hidden rounded-[inherit]">
          <BlackHoleVortex className="w-full h-full" />
        </div>
        <div className="relative z-10 flex flex-col gap-4 h-full min-h-0">
          <TabBar
            title={
              <BlurText
                text="数据分享"
                className="text-[15px] font-semibold tracking-tight"
                delay={80}
                animateBy="letters"
              />
            }
            icon={<Sparkles size={16} style={{ color: 'var(--accent-gold)' }} />}
            actions={
              <Button variant="ghost" size="xs" onClick={() => { setIsFirstVisit(false); loadTransfers(); }}>
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            }
          />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <OnboardingView onStartShare={() => setShowCreate(true)} />
          </div>
        </div>
        <CreateTransferDialog open={showCreate} onOpenChange={setShowCreate} onCreated={handleCreated} />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 p-5 relative">
      <div className="absolute inset-0 z-0 overflow-hidden rounded-[inherit] opacity-40">
        <BlackHoleVortex className="w-full h-full" />
      </div>
      <div className="relative z-10 flex flex-col gap-4 h-full min-h-0">
      {/* Top bar */}
      <TabBar
        title={
          <BlurText
            text="数据分享"
            className="text-[15px] font-semibold tracking-tight"
            delay={80}
            animateBy="letters"
          />
        }
        icon={<Sparkles size={16} style={{ color: 'var(--accent-gold)' }} />}
        actions={
          <motion.div
            className="flex items-center gap-2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <Button variant="ghost" size="xs" onClick={loadTransfers} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="xs" onClick={() => setShowCreate(true)}>
              <Send className="w-3.5 h-3.5" />
              发起分享
            </Button>
          </motion.div>
        }
      />

      {/* Content: left list + right detail */}
      <motion.div
        className="flex-1 min-h-0 flex gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        {/* Left: transfer list */}
        <div className="w-[420px] shrink-0 flex flex-col gap-3 min-h-0">
          {/* Tab + pending badge */}
          <div className="shrink-0 flex items-center gap-2">
            <div className="flex-1">
              <TabBar
                items={tabItems}
                activeKey={tab}
                onChange={(k) => { setTab(k as 'received' | 'sent'); setSelectedTransfer(null); }}
              />
            </div>
            {pendingCount > 0 && (
              <Badge variant="warning" size="sm">
                {pendingCount} 待处理
              </Badge>
            )}
          </div>

          {/* List */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            ) : transfers.length === 0 ? (
              <EmptyState direction={tab} onStartShare={() => setShowCreate(true)} />
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

        {/* Right: detail panel */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {selectedTransfer ? (
            <TransferDetail
              transfer={selectedTransfer}
              direction={tab}
              onAction={() => { setSelectedTransfer(null); loadTransfers(); }}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </motion.div>

      {/* Create dialog (modal) */}
      <CreateTransferDialog open={showCreate} onOpenChange={setShowCreate} onCreated={handleCreated} />
      </div>
    </div>
  );
}

// =================== Skeleton ===================

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

// =================== Onboarding View (First Visit) ===================

const FLOW_STEPS = [
  { icon: Layers, label: '选择数据', desc: '工作区、提示词、参考图' },
  { icon: Send, label: '发送分享', desc: '选择接收人，一键发送' },
  { icon: Bell, label: '通知接收', desc: '对方收到系统通知' },
  { icon: Copy, label: '深度复制', desc: '接受后自动深拷贝到账户' },
] as const;

const FEATURES = [
  { icon: Copy, title: '完整深拷贝', desc: '工作区的所有图片、对话记录一并复制，不是链接引用' },
  { icon: Shield, title: '安全可控', desc: '接收方需主动确认接受，7 天内有效，过期自动作废' },
  { icon: Bell, title: '通知闭环', desc: '发送、接受、拒绝都会收到系统通知，状态清晰' },
] as const;

const DATA_TYPES = [
  { icon: Layers, label: '工作区', color: 'rgba(99, 102, 241, 0.9)', desc: '含全部图片和对话' },
  { icon: PenLine, label: '提示词', color: 'rgba(245, 158, 11, 0.9)', desc: '文学创作提示词模板' },
  { icon: ImagePlus, label: '参考图配置', color: 'rgba(34, 197, 94, 0.9)', desc: '图片风格参考配置' },
] as const;

function OnboardingView({ onStartShare }: { onStartShare: () => void }) {
  return (
    <div className="max-w-[760px] mx-auto space-y-6">
      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <GlassCard accentHue={234} padding="none">
          <div className="px-8 py-10 text-center">
            <motion.div
              className="w-16 h-16 rounded-[16px] mx-auto mb-5 flex items-center justify-center"
              style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)' }}
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ duration: 0.6, delay: 0.2, type: 'spring', stiffness: 200 }}
            >
              <Send size={28} style={{ color: 'var(--accent-gold)' }} />
            </motion.div>
            <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              <SplitText
                text="跨账户数据分享"
                delay={60}
                duration={0.5}
                splitBy="chars"
                from={{ opacity: 0, y: 20 }}
                to={{ opacity: 1, y: 0 }}
              />
            </h2>
            <motion.p
              className="text-[14px] leading-relaxed max-w-[480px] mx-auto"
              style={{ color: 'var(--text-secondary)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.5 }}
            >
              将你的工作区、提示词、参考图等数据安全地分享给其他用户。
              <br />
              <ShinyText
                text="接收方确认后，系统自动完成深度复制。"
                color="var(--text-secondary)"
                shineColor="rgba(99, 102, 241, 0.8)"
                speed={3}
                className="text-[14px]"
              />
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.7 }}
            >
              <Button className="mt-6" onClick={onStartShare}>
                <Send className="w-4 h-4" />
                发起第一次分享
              </Button>
            </motion.div>
          </div>
        </GlassCard>
      </motion.div>

      {/* Flow Steps */}
      <div>
        <motion.div
          className="text-[11px] font-semibold uppercase tracking-wider mb-3 px-1"
          style={{ color: 'var(--text-muted)' }}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.5 }}
        >
          <DecryptedText
            text="分享流程"
            speed={50}
            maxIterations={8}
            sequential
            animateOn="view"
            className="text-[11px]"
          />
        </motion.div>
        <div className="grid grid-cols-4 gap-3">
          {FLOW_STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={i}
                className="relative"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.6 + i * 0.1 }}
              >
                <div
                  className="rounded-[12px] p-4 text-center h-full"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--nested-block-border)' }}
                >
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                      style={{ background: 'rgba(99, 102, 241, 0.15)', color: 'rgba(99, 102, 241, 0.9)' }}
                    >
                      {i + 1}
                    </span>
                    <Icon size={15} style={{ color: 'var(--accent-gold)' }} />
                  </div>
                  <div className="text-[13px] font-medium mb-0.5" style={{ color: 'var(--text-primary)' }}>{step.label}</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{step.desc}</div>
                </div>
                {i < FLOW_STEPS.length - 1 && (
                  <ChevronRight
                    size={14}
                    className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10"
                    style={{ color: 'var(--text-muted)', opacity: 0.4 }}
                  />
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Features + Data Types (two-column) */}
      <div className="grid grid-cols-2 gap-4">
        {/* Features */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 1.0 }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--text-muted)' }}>
            <DecryptedText text="特性" speed={50} maxIterations={8} sequential animateOn="view" className="text-[11px]" />
          </div>
          <div className="space-y-2">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <motion.div
                  key={i}
                  className="rounded-[10px] px-3.5 py-3 flex items-start gap-3"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--nested-block-border)' }}
                  initial={{ opacity: 0, x: -15 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, delay: 1.1 + i * 0.1 }}
                >
                  <div
                    className="shrink-0 w-7 h-7 rounded-[7px] flex items-center justify-center mt-0.5"
                    style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.15)' }}
                  >
                    <Icon size={13} style={{ color: 'rgba(99, 102, 241, 0.7)' }} />
                  </div>
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{f.title}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.desc}</div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* Supported data types */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 1.0 }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-3 px-1" style={{ color: 'var(--text-muted)' }}>
            <DecryptedText text="支持的数据类型" speed={50} maxIterations={8} sequential animateOn="view" className="text-[11px]" />
          </div>
          <div className="space-y-2">
            {DATA_TYPES.map((dt, i) => {
              const Icon = dt.icon;
              return (
                <motion.div
                  key={i}
                  className="rounded-[10px] px-3.5 py-3 flex items-start gap-3"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--nested-block-border)' }}
                  initial={{ opacity: 0, x: 15 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, delay: 1.1 + i * 0.1 }}
                >
                  <div
                    className="shrink-0 w-7 h-7 rounded-[7px] flex items-center justify-center mt-0.5"
                    style={{ background: `${dt.color}12`, border: `1px solid ${dt.color}25` }}
                  >
                    <Icon size={13} style={{ color: dt.color }} />
                  </div>
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{dt.label}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{dt.desc}</div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// =================== Empty States ===================

function EmptyState({ direction, onStartShare }: { direction: 'sent' | 'received'; onStartShare: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.15)' }}
      >
        {direction === 'received'
          ? <Inbox size={20} style={{ color: 'var(--accent-gold)' }} />
          : <Send size={20} style={{ color: 'var(--accent-gold)' }} />}
      </div>
      <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {direction === 'received' ? '暂无收到的分享' : '暂无发出的分享'}
      </div>
      {direction === 'sent' && (
        <Button variant="secondary" size="xs" onClick={onStartShare} className="mt-1">
          <Send className="w-3 h-3" />
          发起分享
        </Button>
      )}
    </div>
  );
}

function EmptyDetail() {
  return (
    <motion.div
      className="h-full flex flex-col items-center justify-center gap-3"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.4 }}
    >
      <motion.div
        className="w-14 h-14 rounded-[14px] flex items-center justify-center"
        style={{ background: 'rgba(99, 102, 241, 0.06)', border: '1px solid rgba(99, 102, 241, 0.12)' }}
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Package size={24} style={{ color: 'rgba(99, 102, 241, 0.4)' }} />
      </motion.div>
      <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
        <DecryptedText text="选择一条分享记录查看详情" speed={40} maxIterations={10} sequential animateOn="view" />
      </div>
    </motion.div>
  );
}

// =================== Transfer Card ===================

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
        <div
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'var(--accent-gold)' }}
        >
          {direction === 'received'
            ? (t.senderUserName?.[0] ?? 'U')
            : (t.receiverUserName?.[0] ?? 'U')}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {direction === 'received' ? t.senderUserName : (t.receiverUserName ?? t.receiverUserId)}
            </span>
            <ArrowRight size={12} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
            <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {direction === 'received' ? '分享给你' : '收到你的分享'}
            </span>
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

// =================== Transfer Detail ===================

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
      {/* Header */}
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

      {/* Items */}
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
                {item.appKeyDisplayName && (
                  <Badge variant="subtle" size="sm">
                    {item.appKeyDisplayName}
                  </Badge>
                )}
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

        <div className="mt-4 flex items-center gap-1.5">
          <Clock size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {isExpired ? '已于 ' + fmtDate(t.expiresAt) + ' 过期' : '有效期至 ' + fmtDate(t.expiresAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
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

// =================== Create Transfer Dialog ===================

function CreateTransferDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [receiverUserId, setReceiverUserId] = useState('');
  const [message, setMessage] = useState('');

  const [workspaces, setWorkspaces] = useState<ShareableWorkspace[]>([]);
  const [prompts, setPrompts] = useState<ShareablePrompt[]>([]);
  const [refImages, setRefImages] = useState<ShareableRefImage[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const currentUser = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!open) return;
    // Reset state when dialog opens
    setReceiverUserId('');
    setMessage('');
    setSelectedIds(new Set());
    setSearchQuery('');

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
  }, [open, currentUser?.userId]);

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

  // Filter items by search query
  const q = searchQuery.trim().toLowerCase();
  const literaryWs = workspaces.filter((w) => w.scenarioType === 'article-illustration');
  const visualWs = workspaces.filter((w) => w.scenarioType !== 'article-illustration');

  const filteredLiteraryWs = q ? literaryWs.filter(w => w.title.toLowerCase().includes(q)) : literaryWs;
  const filteredVisualWs = q ? visualWs.filter(w => w.title.toLowerCase().includes(q)) : visualWs;
  const filteredPrompts = q ? prompts.filter(p => p.title.toLowerCase().includes(q)) : prompts;
  const filteredRefImages = q ? refImages.filter(r => r.name.toLowerCase().includes(q)) : refImages;

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

  const selectedReceiver = users.find(u => u.userId === receiverUserId);
  const totalItems = literaryWs.length + visualWs.length + prompts.length + refImages.length;

  const content = (
    <div className="flex flex-col gap-0" style={{ maxHeight: '65vh' }}>
      {loadingData ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
        </div>
      ) : (
        <>
          {/* Recipient + Message */}
          <div className="space-y-4 pb-4" style={{ borderBottom: '1px solid var(--nested-block-border)' }}>
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
          </div>

          {/* Search + Data Selection */}
          <div className="flex-1 min-h-0 overflow-y-auto pt-4 space-y-4">
            {/* Search bar */}
            {totalItems > 6 && (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="w-full rounded-[10px] pl-9 pr-3.5 py-2 text-[13px] outline-none transition-all duration-200 focus:ring-1"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--nested-block-border)',
                    color: 'var(--text-primary)',
                  }}
                  placeholder="搜索工作区、提示词、参考图..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            )}

            {/* Literary workspaces */}
            {filteredLiteraryWs.length > 0 && (
              <DataSection
                title="文学创作"
                icon={<PenLine size={13} />}
                iconColor="rgba(245, 158, 11, 0.9)"
                count={filteredLiteraryWs.length}
                selectedCount={filteredLiteraryWs.filter(w => selectedIds.has(`workspace:${w.id}`)).length}
                onToggleAll={() => toggleAll(filteredLiteraryWs.map(w => `workspace:${w.id}`))}
                grid
              >
                {filteredLiteraryWs.map(ws => (
                  <WorkspaceCheckItem
                    key={ws.id}
                    ws={ws}
                    checked={selectedIds.has(`workspace:${ws.id}`)}
                    onChange={() => toggle(`workspace:${ws.id}`)}
                  />
                ))}
              </DataSection>
            )}

            {/* Visual workspaces */}
            {filteredVisualWs.length > 0 && (
              <DataSection
                title="视觉创作"
                icon={<Palette size={13} />}
                iconColor="rgba(99, 102, 241, 0.9)"
                count={filteredVisualWs.length}
                selectedCount={filteredVisualWs.filter(w => selectedIds.has(`workspace:${w.id}`)).length}
                onToggleAll={() => toggleAll(filteredVisualWs.map(w => `workspace:${w.id}`))}
                grid
              >
                {filteredVisualWs.map(ws => (
                  <WorkspaceCheckItem
                    key={ws.id}
                    ws={ws}
                    checked={selectedIds.has(`workspace:${ws.id}`)}
                    onChange={() => toggle(`workspace:${ws.id}`)}
                  />
                ))}
              </DataSection>
            )}

            {/* Configs */}
            {(filteredPrompts.length > 0 || filteredRefImages.length > 0) && (
              <DataSection
                title="配置资源"
                icon={<FileText size={13} />}
                iconColor="rgba(34, 197, 94, 0.9)"
                count={filteredPrompts.length + filteredRefImages.length}
                selectedCount={
                  filteredPrompts.filter(p => selectedIds.has(`literary-prompt:${p.id}`)).length +
                  filteredRefImages.filter(r => selectedIds.has(`ref-image-config:${r.id}`)).length
                }
                onToggleAll={() => toggleAll([
                  ...filteredPrompts.map(p => `literary-prompt:${p.id}`),
                  ...filteredRefImages.map(r => `ref-image-config:${r.id}`),
                ])}
              >
                {filteredPrompts.map((p) => (
                  <ConfigCheckItem
                    key={p.id}
                    label={p.title}
                    badge="提示词"
                    icon={<PenLine size={13} style={{ color: 'rgba(245, 158, 11, 0.7)' }} />}
                    checked={selectedIds.has(`literary-prompt:${p.id}`)}
                    onChange={() => toggle(`literary-prompt:${p.id}`)}
                  />
                ))}
                {filteredRefImages.map((r) => (
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

            {/* Search empty state */}
            {q && filteredLiteraryWs.length === 0 && filteredVisualWs.length === 0 && filteredPrompts.length === 0 && filteredRefImages.length === 0 && (
              <div className="text-center py-8">
                <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>未找到匹配 "{searchQuery}" 的数据</div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="pt-4 flex items-center justify-between" style={{ borderTop: '1px solid var(--nested-block-border)' }}>
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
        </>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-[7px] flex items-center justify-center"
            style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)' }}
          >
            <Send size={13} style={{ color: 'var(--accent-gold)' }} />
          </div>
          <span>发起数据分享</span>
        </div>
      }
      content={content}
      maxWidth={640}
    />
  );
}

// =================== Data Section ===================

function DataSection({
  title,
  icon,
  iconColor,
  count,
  selectedCount,
  onToggleAll,
  children,
  grid,
}: {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  count: number;
  selectedCount: number;
  onToggleAll: () => void;
  children: React.ReactNode;
  /** Use 2-col grid layout (for workspace cards) instead of vertical list */
  grid?: boolean;
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
      <div className={grid ? 'grid grid-cols-2 gap-2.5' : 'space-y-1.5'}>
        {children}
      </div>
    </section>
  );
}

// =================== Checkbox Items ===================

function WorkspaceCheckItem({ ws, checked, onChange }: { ws: ShareableWorkspace; checked: boolean; onChange: () => void }) {
  const hasCover = ws.coverAssets && ws.coverAssets.length > 0;
  const assets = ws.coverAssets ?? [];
  const n = assets.length;
  const wsRoute = ws.scenarioType === 'article-illustration'
    ? `/literary-agent/${ws.id}`
    : `/visual-agent/${ws.id}`;

  const Tile = ({ idx, style }: { idx: number; style?: React.CSSProperties }) => {
    const a = assets[idx];
    return a?.url ? (
      <img src={a.url} alt="" className="h-full w-full object-cover" style={style} loading="lazy" referrerPolicy="no-referrer" />
    ) : (
      <div className="h-full w-full" style={{ ...style, background: 'var(--nested-block-bg)' }} />
    );
  };

  const renderMosaic = () => {
    if (n === 1) return <img src={assets[0].url} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />;
    if (n === 2) return (
      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
        <Tile idx={0} /><Tile idx={1} />
      </div>
    );
    if (n === 3) return (
      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
        <Tile idx={0} style={{ gridColumn: '1', gridRow: '1 / span 2' }} />
        <Tile idx={1} style={{ gridColumn: '2', gridRow: '1' }} />
        <Tile idx={2} style={{ gridColumn: '2', gridRow: '2' }} />
      </div>
    );
    return (
      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
        <Tile idx={0} /><Tile idx={1} /><Tile idx={2} /><Tile idx={3} />
      </div>
    );
  };

  return (
    <label className="group cursor-pointer block">
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />

      {/* Cover area with checkbox overlay */}
      <div
        className="h-[100px] w-full relative overflow-hidden rounded-[10px] transition-all duration-200"
        style={{
          background: hasCover ? 'transparent' : 'var(--bg-input)',
          border: hasCover ? 'none' : '1px solid var(--nested-block-border)',
          boxShadow: checked ? '0 0 0 2px rgba(99, 102, 241, 0.6)' : '0 2px 8px rgba(0,0,0,0.15)',
        }}
      >
        {hasCover && renderMosaic()}

        {/* Checkbox overlay - top left */}
        <div className="absolute top-1.5 left-1.5 z-10">
          <div
            className="w-5 h-5 rounded-[5px] flex items-center justify-center transition-all duration-150 backdrop-blur-sm"
            style={{
              background: checked ? 'rgba(99, 102, 241, 0.9)' : 'rgba(0,0,0,0.4)',
              border: `1.5px solid ${checked ? 'rgba(99, 102, 241, 0.9)' : 'rgba(255,255,255,0.3)'}`,
            }}
          >
            {checked && <Check size={12} className="text-white" />}
          </div>
        </div>

        {/* Jump link overlay - top right */}
        <a
          href={wsRoute}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-[6px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 backdrop-blur-sm"
          style={{ background: 'rgba(0,0,0,0.4)', color: 'rgba(255,255,255,0.8)' }}
          onClick={(e) => e.stopPropagation()}
          title="在新标签页打开"
        >
          <ExternalLink size={11} />
        </a>

        {/* Hover gradient */}
        <div
          className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 pointer-events-none"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 50%)' }}
        />

        {/* No-cover placeholder */}
        {!hasCover && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Layers size={24} style={{ color: 'rgba(99, 102, 241, 0.3)' }} />
          </div>
        )}
      </div>

      {/* Info below cover */}
      <div className="pt-1.5 px-0.5">
        <div className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {ws.title || '未命名'}
        </div>
        <div className="text-[10px] flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
          <span>{ws.assetCount} 张图</span>
          {ws.folderName && <><span>·</span><span>{ws.folderName}</span></>}
        </div>
      </div>
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
