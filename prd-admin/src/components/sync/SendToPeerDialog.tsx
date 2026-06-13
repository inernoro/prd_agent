/**
 * 「发送到对端节点」通用弹窗。
 *
 * 知识库支持双向同步、保留原时间、覆盖修复、图片重传到目标域名。
 * 遵守 frontend-modal 约束：createPortal 到 body、inline 高度、min-h:0 滚动、ESC + 蒙版关闭。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Clock3,
  Database,
  FolderOpen,
  Globe,
  ListChecks,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listPeerNodes,
  listPeerItems,
  transferToPeer,
  type PeerNode,
  type SyncResourceCapability,
  type SyncItemSummary,
  type TransferItemResult,
  type PeerTransferDirection,
} from '@/services/real/peerSync';

interface Props {
  resourceType: string;
  presetItemIds?: string[];
  onClose: () => void;
  onDone?: () => void;
}

const DIRECTIONS: { key: PeerTransferDirection; label: string; icon: ReactNode; hint: string }[] = [
  { key: 'push', label: '发送到对端', icon: <ArrowRight size={15} />, hint: '本地内容写入对端' },
  { key: 'pull', label: '从对端拉取', icon: <ArrowLeft size={15} />, hint: '对端内容写回本地' },
  { key: 'both', label: '双向同步', icon: <ArrowRightLeft size={15} />, hint: '先发送再回读，双方合并' },
];

const STEPS = [
  { title: '扫描', desc: '读取所选知识库与目录差异' },
  { title: '图片重传', desc: '上传到目标平台域名' },
  { title: '合并', desc: '按血缘写入或覆盖' },
  { title: '回读', desc: '刷新同步标识与结果' },
];

export function SendToPeerDialog({ resourceType, presetItemIds, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [capability, setCapability] = useState<SyncResourceCapability | null>(null);
  const [items, setItems] = useState<SyncItemSummary[]>([]);

  const [nodeId, setNodeId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(presetItemIds ?? []));
  const [direction, setDirection] = useState<PeerTransferDirection>('both');
  const [preserveTimestamps, setPreserveTimestamps] = useState(true);
  const [allowOverwrite, setAllowOverwrite] = useState(true);
  const [rewriteAssetLinks, setRewriteAssetLinks] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<TransferItemResult[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ step: number; stage: string; startedAt: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!submitting) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [submitting]);

  const safeClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') safeClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [safeClose]);

  const loadSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const load = useCallback(async () => {
    const mySeq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    const [nodesRes, itemsRes] = await Promise.all([listPeerNodes(), listPeerItems(resourceType)]);
    if (mySeq !== loadSeqRef.current || !isMountedRef.current) return;
    if (nodesRes.success && nodesRes.data) {
      const nextNodes = nodesRes.data.items || [];
      const cap = (nodesRes.data.capabilities || []).find((c) => c.resourceType === resourceType) || null;
      setNodes(nextNodes);
      setCapability(cap);
      if (nextNodes.length === 1) setNodeId(nextNodes[0].id);
      if (!cap?.supportsBidirectional) setDirection('push');
    } else {
      setLoadError(nodesRes.error?.message || '加载对端节点失败');
    }
    if (itemsRes.success && itemsRes.data) {
      setItems(itemsRes.data.items || []);
    } else {
      setLoadError((prev) => prev || itemsRes.error?.message || '加载可同步条目失败');
    }
    setLoading(false);
  }, [resourceType]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeNode = useMemo(() => nodes.find((n) => n.id === nodeId) || null, [nodes, nodeId]);
  const availableDirections = useMemo(
    () => DIRECTIONS.filter((d) => d.key === 'push' || capability?.supportsBidirectional),
    [capability],
  );
  const canSubmit = Boolean(nodeId && selected.size > 0 && !submitting);
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.itemId)),
    [items, selected],
  );
  const queueState = useMemo(
    () => deriveQueueState(selectedItems, submitting, progress, results, transferError),
    [selectedItems, submitting, progress, results, transferError],
  );
  const primaryActionLabel = submitting
    ? '停止监听'
    : results
      ? '再次同步'
      : direction === 'pull'
        ? '开始拉取'
        : direction === 'both'
          ? '开始双向同步'
          : '开始发送';

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setTransferError(null);
    setResults(null);
    const startedAt = Date.now();
    setProgress({ step: 1, stage: '正在扫描所选知识库', startedAt });
    const timers = [
      window.setTimeout(() => setProgress({ step: 2, stage: '正在上传图片并重写目标域链接', startedAt }), 1200),
      window.setTimeout(() => setProgress({ step: 3, stage: '正在按血缘合并内容', startedAt }), 3200),
      window.setTimeout(() => setProgress({ step: 4, stage: '正在回写同步状态', startedAt }), 6200),
    ];
    const res = await transferToPeer({
      nodeId,
      resourceType,
      itemIds: Array.from(selected),
      direction,
      mode: allowOverwrite ? 'overwrite' : 'add-only',
      preserveTimestamps,
      rewriteAssetLinks,
    });
    timers.forEach((t) => window.clearTimeout(t));
    if (!isMountedRef.current) return;
    setSubmitting(false);
    setProgress(null);
    if (res.success && res.data) {
      const nextResults = res.data.results || [];
      setResults(nextResults);
      if (nextResults.some((r) => r.ok)) onDone?.();
    } else {
      setTransferError(res.error?.message || '互传失败');
    }
  };

  const handlePrimaryAction = () => {
    if (submitting) {
      safeClose();
      return;
    }
    void handleSubmit();
  };

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(5, 7, 12, 0.70)' }}
      onClick={safeClose}
    >
      <div
        className="w-full max-w-[1180px] overflow-hidden rounded-2xl border shadow-2xl"
        style={{
          maxHeight: '90vh',
          background: 'linear-gradient(135deg, rgba(18,24,33,0.98), rgba(31,34,43,0.98))',
          borderColor: 'rgba(148,163,184,0.20)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`
          @keyframes peerFlow {
            0% { transform: translateX(-100%); opacity: 0; }
            20% { opacity: 1; }
            100% { transform: translateX(240%); opacity: 0; }
          }
          @keyframes peerPulse {
            0%, 100% { transform: scale(1); opacity: 0.72; }
            50% { transform: scale(1.08); opacity: 1; }
          }
          .peer-flow-beam { animation: peerFlow 1.6s ease-in-out infinite; }
          .peer-flow-pulse { animation: peerPulse 1.35s ease-in-out infinite; }
        `}</style>

        <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border" style={{ background: 'rgba(20,184,166,0.10)', borderColor: 'rgba(45,212,191,0.28)' }}>
              <Send size={18} style={{ color: 'rgb(94,234,212)' }} />
            </div>
            <div>
              <div className="text-base font-semibold">发送到对端节点</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                实时监听知识库同步进度，关闭面板即可停止监听
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs md:flex">
            <StatusPill icon={<Activity size={13} />} text={submitting ? '监听中' : '监听待命'} tone={submitting ? 'gold' : 'slate'} />
            <StatusPill icon={<ShieldCheck size={13} />} text="回读校验" tone={direction === 'both' ? 'teal' : 'slate'} />
            <StatusPill icon={<ListChecks size={13} />} text="条目明细" tone="teal" />
          </div>
          <button
            onClick={safeClose}
            className="rounded-lg p-2 transition hover:bg-white/10"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 grid-cols-[310px_minmax(0,1fr)]" style={{ height: 'min(760px, calc(90vh - 73px))' }}>
          <aside className="flex min-h-0 flex-col border-r p-5" style={{ borderColor: 'rgba(148,163,184,0.12)', background: 'rgba(10,15,24,0.34)' }}>
            {loading ? (
              <MapSectionLoader text="正在加载…" />
            ) : (
              <>
                <div className="space-y-5 overflow-y-auto pr-1" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
                  <SectionTitle label="目标节点" />
                  {nodes.length === 0 ? (
                    <EmptyBlock icon={<Globe size={18} />} title="暂无可用对端" desc="请先在系统互联中完成对端配对" />
                  ) : (
                    <div className="grid gap-2">
                      {nodes.map((n) => (
                        <ChoiceCard key={n.id} active={nodeId === n.id} icon={<Globe size={18} />} onClick={() => setNodeId(n.id)}>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{n.displayName}</div>
                            <div className="truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{n.baseUrl}</div>
                          </div>
                        </ChoiceCard>
                      ))}
                    </div>
                  )}

                  <SectionTitle label="同步方向" />
                  <div className="grid grid-cols-3 gap-2">
                    {availableDirections.map((d) => (
                      <CompactChoiceCard key={d.key} active={direction === d.key} icon={d.icon} label={directionShortLabel(d.key)} onClick={() => setDirection(d.key)} />
                    ))}
                  </div>

                  <SectionTitle label="同步策略" />
                  <div className="grid grid-cols-3 gap-2">
                    <CompactToggle
                      label="原时间"
                      checked={preserveTimestamps}
                      onChange={setPreserveTimestamps}
                    />
                    <CompactToggle
                      label="覆盖"
                      checked={allowOverwrite}
                      onChange={setAllowOverwrite}
                    />
                    <CompactToggle
                      label="重传"
                      checked={rewriteAssetLinks}
                      onChange={setRewriteAssetLinks}
                    />
                  </div>
                  <div className="rounded-xl border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(45,212,191,0.18)', background: 'rgba(15,23,42,0.36)', color: 'rgb(203,213,225)' }}>
                    使用策略：{preserveTimestamps ? '保留原时间' : '使用同步时间'}、{allowOverwrite ? '覆盖同名条目' : '仅新增'}、{rewriteAssetLinks ? '图片重传' : '跳过图片'}，完成后回读校验。
                  </div>
                </div>
              </>
            )}
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="border-b px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold">知识库同步队列</div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    外层是知识库状态，阶段进度和回读校验由同一队列状态推导
                  </div>
                </div>
                <QueueOverview state={queueState} />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6" style={{ overscrollBehavior: 'contain' }}>
              {(loadError || transferError) && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: 'rgba(248,113,113,0.28)', background: 'rgba(127,29,29,0.16)', color: 'rgb(252,165,165)' }}>
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{transferError || loadError}</span>
                </div>
              )}

              {loading ? (
                <MapSectionLoader text="正在加载…" />
              ) : (
                <div className="space-y-4">
                  <SyncMonitorStrip state={queueState} node={activeNode} direction={direction} />
                  {queueState.waitingCount > 0 && (
                    <div className="text-xs font-medium" style={{ color: 'rgb(203,213,225)' }}>
                      还有 {queueState.waitingCount} 个等待知识库，向下滚动查看。
                    </div>
                  )}
                  <section className="space-y-3">
                    {items.map((it) => (
                      <QueueItemCard
                        key={it.itemId}
                        item={it}
                        selected={selected.has(it.itemId)}
                        onToggle={() => toggleItem(it.itemId)}
                        state={queueState.itemStates.get(it.itemId) || 'unselected'}
                        progress={queueState.itemProgress.get(it.itemId) || 0}
                        result={results?.find((r) => r.itemId === it.itemId) || null}
                        active={queueState.activeItem?.itemId === it.itemId}
                      />
                    ))}
                  </section>

                  {items.length === 0 && (
                    <EmptyBlock icon={<Database size={20} />} title="没有可同步的知识库" desc="当前账号没有可发送的个人或团队知识库" />
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {submitting && progress ? `${progress.stage}，已用 ${Math.round((Date.now() - progress.startedAt) / 1000)} 秒，预计剩余 ${queueState.etaLabel}` : '同步完成后会刷新知识库列表和跨系统同步标识'}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={safeClose}>{submitting ? '关闭面板' : '取消'}</Button>
                <Button size="sm" onClick={handlePrimaryAction} disabled={!submitting && !canSubmit}>
                  {submitting ? <X size={14} /> : <Send size={14} />}
                  {primaryActionLabel}
                </Button>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function SectionTitle({ label }: { label: string }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'rgb(148,163,184)' }}>{label}</div>;
}

function ChoiceCard({ active, icon, onClick, children }: { active: boolean; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition"
      style={{
        borderColor: active ? 'rgba(45,212,191,0.54)' : 'rgba(148,163,184,0.18)',
        background: active ? 'rgba(20,184,166,0.12)' : 'rgba(15,23,42,0.42)',
      }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border" style={{ borderColor: 'rgba(148,163,184,0.16)', color: active ? 'rgb(94,234,212)' : 'rgb(148,163,184)' }}>
        {icon}
      </div>
      {children}
      {active && <Check size={15} className="shrink-0" style={{ color: 'rgb(94,234,212)' }} />}
    </button>
  );
}

function EmptyBlock({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-2xl border px-4 py-6 text-center" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.36)' }}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'rgba(148,163,184,0.10)', color: 'rgb(148,163,184)' }}>{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</div>
    </div>
  );
}

function CompactChoiceCard({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative min-h-[76px] rounded-xl border px-3 py-3 text-left transition"
      style={{
        borderColor: active ? 'rgba(45,212,191,0.54)' : 'rgba(148,163,184,0.18)',
        background: active ? 'rgba(20,184,166,0.12)' : 'rgba(15,23,42,0.42)',
      }}
    >
      <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: 'rgba(148,163,184,0.16)', color: active ? 'rgb(94,234,212)' : 'rgb(148,163,184)' }}>
        {icon}
      </div>
      <div className="text-xs font-semibold">{label}</div>
      {active && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full" style={{ background: 'rgb(94,234,212)', boxShadow: '0 0 12px rgba(94,234,212,0.8)' }} />}
    </button>
  );
}

function CompactToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="relative h-9 rounded-xl border px-2 text-center text-xs font-semibold transition"
      style={{
        borderColor: checked ? 'rgba(45,212,191,0.46)' : 'rgba(148,163,184,0.18)',
        background: checked ? 'rgba(20,184,166,0.12)' : 'rgba(15,23,42,0.42)',
        color: checked ? 'rgb(94,234,212)' : 'rgb(148,163,184)',
      }}
    >
      {label}
      {checked && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full" style={{ background: 'rgb(94,234,212)' }} />}
    </button>
  );
}

function directionShortLabel(direction: PeerTransferDirection) {
  if (direction === 'push') return '发送';
  if (direction === 'pull') return '拉取';
  return '双向';
}

type QueueItemState = 'unselected' | 'waiting' | 'running' | 'done' | 'failed';

interface QueueState {
  selectedCount: number;
  doneCount: number;
  runningCount: number;
  waitingCount: number;
  failedCount: number;
  activeItem: SyncItemSummary | null;
  activeStep: number;
  currentLabel: string;
  reverseLabel: string;
  etaLabel: string;
  itemStates: Map<string, QueueItemState>;
  itemProgress: Map<string, number>;
}

export function deriveQueueState(
  selectedItems: SyncItemSummary[],
  submitting: boolean,
  progress: { step: number; stage: string; startedAt: number } | null,
  results: TransferItemResult[] | null,
  error: string | null,
): QueueState {
  const resultMap = new Map((results || []).map((r) => [r.itemId, r]));
  const doneCount = results?.filter((r) => r.ok).length ?? 0;
  const failedCount = results?.filter((r) => !r.ok).length ?? (error ? selectedItems.length : 0);
  const runningCount = submitting && selectedItems.length > doneCount + failedCount ? 1 : 0;
  const waitingCount = Math.max(0, selectedItems.length - doneCount - failedCount - runningCount);
  const activeIndex = submitting ? Math.min(doneCount + failedCount, Math.max(0, selectedItems.length - 1)) : -1;
  const activeItem = activeIndex >= 0 ? selectedItems[activeIndex] || null : null;
  const activeStep = progress?.step ?? 0;
  const itemStates = new Map<string, QueueItemState>();
  const itemProgress = new Map<string, number>();

  selectedItems.forEach((item, index) => {
    const result = resultMap.get(item.itemId);
    if (result) {
      itemStates.set(item.itemId, result.ok ? 'done' : 'failed');
      itemProgress.set(item.itemId, 100);
      return;
    }
    if (submitting && index === activeIndex) {
      itemStates.set(item.itemId, 'running');
      itemProgress.set(item.itemId, stepProgress(activeStep));
      return;
    }
    itemStates.set(item.itemId, submitting && index > activeIndex ? 'waiting' : 'waiting');
    itemProgress.set(item.itemId, 0);
  });

  const etaSeconds = Math.max(20, waitingCount * 35 + (submitting ? Math.max(0, 5 - activeStep) * 14 : 0));
  const reverseLabel = reverseStatusFromStep({ submitting, activeStep, results, error });
  return {
    selectedCount: selectedItems.length,
    doneCount,
    runningCount,
    waitingCount,
    failedCount,
    activeItem,
    activeStep,
    currentLabel: progress?.stage || (results ? '同步结果已返回' : selectedItems.length > 0 ? '等待开始同步' : '等待选择知识库'),
    reverseLabel,
    etaLabel: submitting ? `约 ${formatDuration(etaSeconds)}` : '无进行中任务',
    itemStates,
    itemProgress,
  };
}

function stepProgress(step: number) {
  if (step <= 1) return 16;
  if (step === 2) return 42;
  if (step === 3) return 68;
  if (step >= 4) return 88;
  return 0;
}

function reverseStatusFromStep(args: {
  submitting: boolean;
  activeStep: number;
  results: TransferItemResult[] | null;
  error: string | null;
}) {
  if (args.error) return '未执行回读';
  if (args.results && args.results.length > 0) return args.results.some((r) => !r.ok) ? '部分条目未通过' : '回读校验通过';
  if (!args.submitting) return '等待回读';
  if (args.activeStep < 4) return '等待回读';
  return '正在回读同步结果';
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function QueueOverview({ state }: { state: QueueState }) {
  return (
    <div className="grid grid-cols-5 gap-2 text-center">
      <QueueStat label="已选" value={state.selectedCount} />
      <QueueStat label="完成" value={state.doneCount} tone="green" />
      <QueueStat label="同步中" value={state.runningCount} tone="gold" />
      <QueueStat label="等待" value={state.waitingCount} />
      <QueueStat label="失败" value={state.failedCount} tone={state.failedCount > 0 ? 'red' : 'slate'} />
    </div>
  );
}

function QueueStat({ label, value, tone = 'slate' }: { label: string; value: number; tone?: 'green' | 'gold' | 'red' | 'slate' }) {
  const color = tone === 'green' ? 'rgb(134,239,172)' : tone === 'gold' ? 'rgb(252,211,77)' : tone === 'red' ? 'rgb(252,165,165)' : 'rgb(226,232,240)';
  return (
    <div className="min-w-[54px] rounded-xl border px-2 py-2" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)' }}>
      <div className="text-[10px] font-semibold" style={{ color: 'rgb(174,187,201)' }}>{label}</div>
      <div className="text-base font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}

function SyncMonitorStrip({ state, node, direction }: { state: QueueState; node: PeerNode | null; direction: PeerTransferDirection }) {
  return (
    <div className="grid gap-2 lg:grid-cols-4">
      <MonitorCell label="当前状态" value={state.currentLabel} />
      <MonitorCell label="目标节点" value={node?.displayName || '等待选择'} sub={directionShortLabel(direction)} />
      <MonitorCell label="反向校验" value={state.reverseLabel} />
      <MonitorCell label="预计剩余" value={state.etaLabel} />
    </div>
  );
}

function MonitorCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border px-3 py-2" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.40)' }}>
      <div className="text-[11px] font-semibold" style={{ color: 'rgb(174,187,201)' }}>{label}</div>
      <div className="mt-1 truncate text-xs font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function QueueItemCard({ item, selected, onToggle, state, progress, result, active }: {
  item: SyncItemSummary;
  selected: boolean;
  onToggle: () => void;
  state: QueueItemState;
  progress: number;
  result: TransferItemResult | null;
  active: boolean;
}) {
  const tone = queueStateTone(state);
  return (
    <button
      onClick={onToggle}
      className="w-full rounded-2xl border p-4 text-left transition"
      title={item.updatedAt ? `最近更新 ${new Date(item.updatedAt).toLocaleString('zh-CN')}` : undefined}
      style={{
        borderColor: selected ? statusBorder(tone) : 'rgba(148,163,184,0.16)',
        background: selected ? statusBackground(tone) : 'rgba(15,23,42,0.32)',
      }}
    >
      <div className="grid gap-4 md:grid-cols-[44px_minmax(0,1fr)_280px]">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border" style={{ borderColor: selected ? statusBorder(tone) : 'rgba(148,163,184,0.18)', color: selected ? statusColor(tone) : 'rgb(148,163,184)', background: selected ? statusBackground(tone) : 'rgba(15,23,42,0.46)' }}>
          {selected ? <Check size={17} /> : <FolderOpen size={17} />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">{stripTimestampSuffix(item.name)}</div>
            <span className="rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: 'rgba(148,163,184,0.16)', color: 'rgb(203,213,225)' }}>
              {item.recordCount} 项
            </span>
          </div>
          {item.description && <div className="mt-1 text-xs leading-5" style={{ color: 'rgb(174,187,201)' }}>{item.description}</div>}
          <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ color: 'rgb(174,187,201)' }}>
            {item.updatedAt && <span>更新 {formatShortTime(item.updatedAt)}</span>}
            <span>保留原时间</span>
            <span>允许覆盖</span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <StatusPill icon={active ? <MapSpinner size={12} /> : state === 'done' ? <CheckCircle2 size={13} /> : state === 'failed' ? <AlertTriangle size={13} /> : <Clock3 size={13} />} text={queueStateLabel(state)} tone={tone} />
            <span className="font-semibold" style={{ color: statusColor(tone) }}>{selected ? `${progress}%` : '未选'}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.14)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${selected ? progress : 0}%`, background: state === 'failed' ? 'rgb(248,113,113)' : 'linear-gradient(90deg, rgb(94,234,212), rgb(134,239,172))' }} />
          </div>
          {active && (
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {STEPS.map((step, index) => (
                <StepChip key={step.title} label={step.title} state={index + 1 < stepFromProgress(progress) ? 'done' : index + 1 === stepFromProgress(progress) ? 'active' : 'idle'} />
              ))}
            </div>
          )}
          {result?.message && <div className="mt-2 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>{result.message}</div>}
          {item.recordCount >= 20 && selected && <div className="mt-2 text-[11px]" style={{ color: 'rgb(174,187,201)' }}>可在结果明细中审计全部 {item.recordCount} 项内容</div>}
        </div>
      </div>
    </button>
  );
}

function StepChip({ label, state }: { label: string; state: 'idle' | 'active' | 'done' }) {
  const color = state === 'done' ? 'rgb(134,239,172)' : state === 'active' ? 'rgb(252,211,77)' : 'rgb(148,163,184)';
  return (
    <span className="truncate rounded-lg border px-1.5 py-1 text-center text-[10px] font-semibold" style={{
      color,
      borderColor: state === 'active' ? 'rgba(245,158,11,0.34)' : state === 'done' ? 'rgba(34,197,94,0.28)' : 'rgba(148,163,184,0.14)',
      background: state === 'active' ? 'rgba(245,158,11,0.10)' : state === 'done' ? 'rgba(22,101,52,0.10)' : 'rgba(15,23,42,0.34)',
    }}>{label}</span>
  );
}

function stepFromProgress(progress: number) {
  if (progress >= 88) return 4;
  if (progress >= 68) return 3;
  if (progress >= 42) return 2;
  if (progress > 0) return 1;
  return 0;
}

function queueStateTone(state: QueueItemState): StatusTone {
  if (state === 'done') return 'teal';
  if (state === 'running') return 'gold';
  if (state === 'failed') return 'red';
  return 'slate';
}

function queueStateLabel(state: QueueItemState) {
  if (state === 'done') return '已完成';
  if (state === 'running') return '同步中';
  if (state === 'failed') return '失败';
  if (state === 'waiting') return '等待';
  return '未选择';
}

function stripTimestampSuffix(name: string) {
  return name.replace(/[-_]?20\d{10,14}$/, '');
}

type StatusTone = 'teal' | 'gold' | 'slate' | 'red';

function StatusPill({ icon, text, tone }: { icon: ReactNode; text: string; tone: StatusTone }) {
  const color = statusColor(tone);
  const border = statusBorder(tone);
  const bg = statusBackground(tone);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1" style={{ color, borderColor: border, background: bg }}>
      {icon}
      {text}
    </span>
  );
}

function statusColor(tone: StatusTone) {
  if (tone === 'teal') return 'rgb(94,234,212)';
  if (tone === 'gold') return 'rgb(252,211,77)';
  if (tone === 'red') return 'rgb(252,165,165)';
  return 'rgb(148,163,184)';
}

function statusBorder(tone: StatusTone) {
  if (tone === 'teal') return 'rgba(45,212,191,0.32)';
  if (tone === 'gold') return 'rgba(245,158,11,0.34)';
  if (tone === 'red') return 'rgba(248,113,113,0.34)';
  return 'rgba(148,163,184,0.18)';
}

function statusBackground(tone: StatusTone) {
  if (tone === 'teal') return 'rgba(20,184,166,0.10)';
  if (tone === 'gold') return 'rgba(245,158,11,0.10)';
  if (tone === 'red') return 'rgba(127,29,29,0.14)';
  return 'rgba(148,163,184,0.08)';
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
