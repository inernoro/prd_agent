/**
 * 同步中心（MAP 知识库传输协议 · 前端）。
 *
 * 点知识库右上角「同步」进入。默认按用户心智展示：当前状态 / 正在同步 / 需要处理 / 最近记录。
 * 发起方向与接收审计仅作为记录细节，避免把“对端推来并被本端接收”误读成“本端主动同步回对端”。
 * 遵守 frontend-modal：createPortal 到 body、inline 高度、min-h:0 滚动、ESC + 蒙版关闭。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, AlertTriangle, CheckCircle2, Clock3,
  Globe, RefreshCw, Scale, Send, X, Repeat, ChevronDown, ChevronRight, FileText,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listPeerNodes, listPeerSyncRuns, transferToPeer, setAutoSync,
  type PeerNode, type PeerSyncRun, type PeerAlign, type TransferItemResult,
} from '@/services/real/peerSync';

interface Props {
  storeId: string;
  storeName: string;
  resourceType?: string;
  onClose: () => void;
  onAfterSync?: () => void;
  /** 打开「发送到对端」高级弹窗（普通 push/pull/both） */
  onOpenSend?: () => void;
  /** 当前是否已开启后台自动同步（来自 store.peerSyncAutoEnabled） */
  autoEnabled?: boolean | null;
  /** 自动同步周期（分钟，来自 store.peerSyncIntervalMinutes） */
  autoIntervalMinutes?: number | null;
  /** 最近一次同步的方向（非空表示已手动同步过一次，可开启自动同步） */
  peerSyncDirection?: string | null;
  /** 最近一次同步的对端名称 */
  peerNodeName?: string | null;
}

const AUTO_INTERVAL_OPTS: { v: number; label: string }[] = [
  { v: 15, label: '每 15 分钟' },
  { v: 60, label: '每小时' },
  { v: 360, label: '每 6 小时' },
  { v: 1440, label: '每天' },
];

type RecordFilter = 'all' | 'mine' | 'received' | 'failed';
type ManualDirection = 'push' | 'pull';

const RECORD_FILTERS: { key: RecordFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我发起' },
  { key: 'received', label: '接收审计' },
  { key: 'failed', label: '失败' },
];

const ALIGN_OPTS: { key: PeerAlign; label: string; desc: string; danger: boolean; icon: ReactNode }[] = [
  { key: 'remote', label: '远端为准', desc: '本地对齐对端：对端没有的本地删掉', danger: true, icon: <ArrowLeft size={15} /> },
  { key: 'local', label: '本地为准', desc: '对端对齐本地：本地没有的对端删掉', danger: true, icon: <ArrowRight size={15} /> },
  { key: 'both', label: '同时对准', desc: '两边合并，各自新增都保留，不删任何一边', danger: false, icon: <ArrowLeftRight size={15} /> },
];

export function SyncCenterDialog({ storeId, storeName, resourceType = 'document-store', onClose, onAfterSync, onOpenSend, autoEnabled, autoIntervalMinutes, peerSyncDirection, peerNodeName }: Props) {
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<PeerSyncRun[]>([]);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [recordFilter, setRecordFilter] = useState<RecordFilter>('all');
  const [showAlign, setShowAlign] = useState(false);
  const [confirmAlign, setConfirmAlign] = useState<PeerAlign | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 后台自动同步本地态（乐观更新）
  const [autoOn, setAutoOn] = useState(!!autoEnabled);
  const [autoInterval, setAutoInterval] = useState(autoIntervalMinutes && autoIntervalMinutes > 0 ? autoIntervalMinutes : 60);
  const [autoBusy, setAutoBusy] = useState(false);
  const mounted = useRef(true);

  // 已手动同步过一次（有方向或有 outgoing 台账）才允许开启自动同步——和后端同口径。
  const everSynced = !!peerSyncDirection || runs.some(r => r.origin === 'outgoing');

  useEffect(() => () => { mounted.current = false; }, []);

  // 跟随 props 更新：onAfterSync 重载 store 后 autoEnabled/autoIntervalMinutes 会变，
  // 弹窗常开时本地态需同步，否则 UI 与服务端不一致（Bugbot）。乐观更新成功后 prop==本地值，此处为 no-op。
  useEffect(() => { setAutoOn(!!autoEnabled); }, [autoEnabled]);
  useEffect(() => { if (autoIntervalMinutes && autoIntervalMinutes > 0) setAutoInterval(autoIntervalMinutes); }, [autoIntervalMinutes]);

  // runs 发号器：load 与 loadRuns 轮询都会 setRuns，只应用「最新一发」结果，防慢响应覆盖快响应
  // （学习规则：轮询/并发 fetch 需 stale-response 守卫）。
  const runsSeq = useRef(0);

  const loadRuns = useCallback(async () => {
    const my = ++runsSeq.current;
    const res = await listPeerSyncRuns(resourceType, storeId);
    if (mounted.current && my === runsSeq.current && res.success && res.data) setRuns(res.data.items || []);
  }, [resourceType, storeId]);

  const load = useCallback(async () => {
    setLoading(true);
    const my = ++runsSeq.current;
    const [nodesRes, runsRes] = await Promise.all([listPeerNodes(), listPeerSyncRuns(resourceType, storeId)]);
    if (!mounted.current) return;
    if (nodesRes.success && nodesRes.data) {
      const ns = nodesRes.data.items || [];
      setNodes(ns);
      if (ns.length === 1) setNodeId(ns[0].id);
    }
    if (my === runsSeq.current && runsRes.success && runsRes.data) setRuns(runsRes.data.items || []);
    setLoading(false);
  }, [resourceType, storeId]);

  useEffect(() => { void load(); }, [load]);

  // 轮询：有进行中任务时 2s 一刷（动起来），否则 6s 兜底。
  // 「进行中」只认近 30 分钟内开始的 syncing 运行（与详情页 + 后端租约 TTL 同口径），
  // 崩溃残留的陈旧 syncing 台账不再让面板永久脉冲、也不再触发更快轮询（Bugbot）。
  const anyRunning = runs.some(isRunActive);
  useEffect(() => {
    const t = window.setInterval(() => { void loadRuns(); }, anyRunning ? 2000 : 6000);
    return () => window.clearInterval(t);
  }, [loadRuns, anyRunning]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const activeRuns = useMemo(() => runs.filter(isRunActive), [runs]);
  const problemRuns = useMemo(() => runs.filter(r => isProblemRun(r, runs)), [runs]);
  const latestRun = runs[0] || null;
  const manualTargetName = activeNodeName(nodes, nodeId) || '对端节点';
  const routeNodeName = peerNodeName || latestRun?.peerNodeName || manualTargetName;
  const routeText = syncRouteText(peerSyncDirection, routeNodeName);
  const autoDirectionNeedsConfirm = shouldConfirmAutoDirection(peerSyncDirection);

  const filtered = useMemo(() => {
    const records = runs.filter(r => !isRunActive(r));
    if (recordFilter === 'mine') return records.filter(r => r.origin === 'outgoing');
    if (recordFilter === 'received') return records.filter(r => r.origin === 'incoming');
    if (recordFilter === 'failed') return records.filter(r => isProblemRun(r, runs));
    return records;
  }, [runs, recordFilter]);

  const counts = useMemo(() => ({
    all: runs.filter(r => !isRunActive(r)).length,
    mine: runs.filter(r => !isRunActive(r) && r.origin === 'outgoing').length,
    received: runs.filter(r => !isRunActive(r) && r.origin === 'incoming').length,
    failed: runs.filter(r => isProblemRun(r, runs)).length,
  }), [runs]);

  const activeNode = nodes.find(n => n.id === nodeId) || null;

  const runManual = async (direction: ManualDirection) => {
    if (!nodeId) { setError('请先选择对端节点'); return; }
    setSubmitting(true);
    setError(null);
    const res = await transferToPeer({ nodeId, resourceType, itemIds: [storeId], direction, mode: 'overwrite' });
    if (!mounted.current) return;
    setSubmitting(false);
    const businessError = getTransferFailureMessage(res.success ? res.data : undefined);
    if (res.success && !businessError) {
      setRecordFilter('all');
      await loadRuns();
      onAfterSync?.();
    } else if (res.success) {
      setRecordFilter('failed');
      setError(businessError || '同步失败');
      await loadRuns();
    } else {
      setError(res.error?.message || '同步失败');
    }
  };

  const runAlign = async (align: PeerAlign) => {
    if (!nodeId) { setError('请先选择对端节点'); return; }
    setSubmitting(true);
    setError(null);
    setConfirmAlign(null);
    const res = await transferToPeer({ nodeId, resourceType, itemIds: [storeId], align });
    if (!mounted.current) return;
    setSubmitting(false);
    const businessError = getTransferFailureMessage(res.success ? res.data : undefined);
    if (res.success && !businessError) {
      setRecordFilter('all');
      await loadRuns();
      onAfterSync?.();
    } else if (res.success) {
      setRecordFilter('failed');
      setError(businessError || '对齐失败');
      await loadRuns();
    } else {
      setError(res.error?.message || '对齐失败');
    }
  };

  // 后台自动同步开关 / 改周期（乐观更新 + 失败回滚）。
  const applyAuto = async (enabled: boolean, interval: number) => {
    if (resourceType !== 'document-store') return;
    if (enabled && !everSynced) { setError('请先手动同步一次（确定对端与方向）后，再开启后台自动同步'); return; }
    setAutoBusy(true);
    setError(null);
    const prevOn = autoOn;
    const prevInterval = autoInterval;
    setAutoOn(enabled);
    setAutoInterval(interval);
    const res = await setAutoSync({ resourceType, itemId: storeId, enabled, intervalMinutes: interval });
    if (!mounted.current) return;
    setAutoBusy(false);
    if (res.success && res.data) {
      setAutoOn(res.data.enabled);
      setAutoInterval(res.data.intervalMinutes);
      onAfterSync?.();
    } else {
      setAutoOn(prevOn);
      setAutoInterval(prevInterval);
      setError(res.error?.message || '设置自动同步失败');
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(5,7,12,0.70)' }} onClick={onClose}>
      <div className="w-full max-w-[920px] overflow-hidden rounded-2xl border shadow-2xl"
        style={{ maxHeight: '88vh', background: 'linear-gradient(135deg,rgba(18,24,33,0.98),rgba(31,34,43,0.98))', borderColor: 'rgba(148,163,184,0.20)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}>
        <style>{`@keyframes scSpin{to{transform:rotate(360deg)}}`}</style>

        {/* header */}
        <div className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border" style={{ background: 'rgba(20,184,166,0.10)', borderColor: 'rgba(45,212,191,0.28)' }}>
              {anyRunning ? <MapSpinner size={18} /> : <ArrowLeftRight size={18} style={{ color: 'rgb(94,234,212)' }} />}
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold truncate">同步中心 · {storeName}</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {anyRunning ? '有任务进行中，实时刷新' : '关闭面板不影响后台同步'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onOpenSend && (
              <Button size="sm" variant="secondary" onClick={onOpenSend}><Send size={14} /> 发送到…</Button>
            )}
            <button onClick={onClose} className="rounded-lg p-2 transition hover:bg-white/10" aria-label="关闭"><X size={18} /></button>
          </div>
        </div>

        <div className="flex min-h-0 flex-col" style={{ height: 'min(700px, calc(88vh - 65px))' }}>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" style={{ overscrollBehavior: 'contain' }}>
            {loading ? <MapSectionLoader text="正在加载…" /> : (
              <div className="space-y-4">
                <section className="rounded-xl border p-4" style={{ borderColor: problemRuns.length > 0 ? 'rgba(248,113,113,0.28)' : activeRuns.length > 0 ? 'rgba(245,158,11,0.30)' : 'rgba(45,212,191,0.24)', background: 'rgba(15,23,42,0.34)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-base font-semibold">
                        {problemRuns.length > 0 ? <AlertTriangle size={18} style={{ color: 'rgb(252,165,165)' }} /> : activeRuns.length > 0 ? <MapSpinner size={18} /> : <CheckCircle2 size={18} style={{ color: 'rgb(94,234,212)' }} />}
                        {problemRuns.length > 0 ? '需要处理' : activeRuns.length > 0 ? '正在同步' : '两边基本一致'}
                      </div>
                      <div className="mt-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
                        {problemRuns.length > 0
                          ? `${problemRuns.length} 条同步记录需要查看原因。`
                          : activeRuns.length > 0
                            ? '关闭面板不影响后台同步，当前进度会自动刷新。'
                            : latestRun ? `最近一次：${formatTime(latestRun.startedAt)}，${statusText(latestRun)}。` : '还没有同步记录。'}
                      </div>
                    </div>
                    <button onClick={() => loadRuns()} className="rounded-lg p-1.5 hover:bg-white/10" title="刷新"><RefreshCw size={14} /></button>
                  </div>

                  {resourceType === 'document-store' && (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2" style={{ borderColor: autoDirectionNeedsConfirm ? 'rgba(245,158,11,0.32)' : 'rgba(148,163,184,0.14)', background: 'rgba(2,6,23,0.18)' }}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <Repeat size={14} style={{ color: autoOn && !autoDirectionNeedsConfirm ? 'rgb(94,234,212)' : 'var(--text-muted)' }} />
                          自动同步
                          <span className="text-xs font-normal" style={{ color: autoOn && !autoDirectionNeedsConfirm ? 'rgb(94,234,212)' : 'var(--text-muted)' }}>
                            {autoDirectionNeedsConfirm ? '方向待确认' : autoOn ? '已开启' : '未开启'}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px]" style={{ color: autoDirectionNeedsConfirm ? 'rgb(252,211,77)' : 'var(--text-muted)' }}>
                          {autoDirectionNeedsConfirm ? '最近只是接收了对端推送，尚未确认自动同步方向。' : routeText}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {autoOn && !autoDirectionNeedsConfirm && (
                          <select
                            value={autoInterval}
                            onChange={e => applyAuto(true, Number(e.target.value))}
                            disabled={autoBusy}
                            className="prd-field h-8 rounded-lg px-2 text-xs outline-none"
                            style={{ maxWidth: 130 }}
                          >
                            {AUTO_INTERVAL_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                          </select>
                        )}
                        <Button
                          size="sm"
                          variant={autoOn && !autoDirectionNeedsConfirm ? 'primary' : 'secondary'}
                          onClick={() => applyAuto(!autoOn, autoInterval)}
                          disabled={autoBusy || (!autoOn && (autoDirectionNeedsConfirm || !everSynced))}
                          title={autoDirectionNeedsConfirm && !autoOn ? '请先手动选择发送或拉回方向' : !everSynced ? '请先手动同步一次' : autoOn ? '关闭后台自动同步' : '开启后台自动同步'}
                        >
                          {autoBusy ? <MapSpinner size={13} /> : <Repeat size={13} />}
                          {autoOn ? '关闭' : '开启'}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>

                {activeRuns.length > 0 && (
                  <section>
                    <SectionTitle title="正在同步" desc="按文章逐条更新进度" />
                    <div className="mt-2 space-y-2.5">{activeRuns.map(r => <RunCard key={r.id} run={r} />)}</div>
                  </section>
                )}

                <section>
                  <SectionTitle title="需要处理" desc={problemRuns.length > 0 ? '失败记录会默认展开原因' : '没有需要你处理的问题'} />
                  {problemRuns.length > 0 ? (
                    <div className="mt-2 space-y-2.5">{problemRuns.map(r => <RunCard key={r.id} run={r} forceExpanded />)}</div>
                  ) : (
                    <div className="mt-2 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(45,212,191,0.20)', background: 'rgba(20,184,166,0.08)', color: 'rgb(153,246,228)' }}>
                      当前没有失败项。已一致的文章会记为“已同步”，不需要处理。
                    </div>
                  )}
                </section>

                <section className="rounded-xl border p-4" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.28)' }}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-sm font-semibold">手动处理</div>
                      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>日常只用前两个按钮；强制对齐会删除条目，放在高级里。</div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {nodes.length > 1 && (
                        <select value={nodeId} onChange={e => setNodeId(e.target.value)}
                          className="prd-field h-8 rounded-lg px-2 text-xs outline-none" style={{ maxWidth: 200 }}>
                          <option value="">选择对端…</option>
                          {nodes.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
                        </select>
                      )}
                      <Button size="sm" variant="primary" onClick={() => runManual('push')} disabled={submitting || nodes.length === 0}>
                        {submitting ? <MapSpinner size={13} /> : <ArrowRight size={13} />} 发送到{manualTargetName}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => runManual('pull')} disabled={submitting || nodes.length === 0}>
                        <ArrowLeft size={13} /> 从{manualTargetName}拉回
                      </Button>
                      <Button size="sm" variant={showAlign ? 'primary' : 'secondary'} onClick={() => setShowAlign(v => !v)} disabled={nodes.length === 0}>
                        <Scale size={13} /> 高级对齐
                      </Button>
                    </div>
                  </div>
                  {nodes.length === 0 && (
                    <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <Globe size={13} /> 暂无已配对对端，请管理员到「设置 → 系统互联」配对节点后再用。
                    </div>
                  )}
                  {showAlign && nodes.length > 0 && (
                    <div className="mt-3 grid gap-2.5 md:grid-cols-3">
                      {ALIGN_OPTS.map(o => (
                        <button key={o.key} onClick={() => (o.danger ? setConfirmAlign(o.key) : runAlign(o.key))}
                          disabled={submitting || !nodeId}
                          className="rounded-xl border p-3 text-left transition disabled:opacity-50"
                          style={{ borderColor: 'rgba(148,163,184,0.20)', background: 'rgba(2,6,23,0.22)' }}>
                          <div className="flex items-center gap-2 text-sm font-semibold">{o.icon}{o.label}</div>
                          <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>{o.desc}</div>
                          {o.danger
                            ? <div className="mt-2 rounded-md px-2 py-1 text-[10.5px]" style={{ color: 'rgb(252,165,165)', background: 'rgba(127,29,29,0.18)', border: '1px solid rgba(248,113,113,0.34)' }}>会删除条目，需确认</div>
                            : <div className="mt-2 rounded-md px-2 py-1 text-[10.5px]" style={{ color: 'rgb(94,234,212)', background: 'rgba(20,184,166,0.10)', border: '1px solid rgba(45,212,191,0.34)' }}>不删除，最安全</div>}
                        </button>
                      ))}
                    </div>
                  )}
                  {error && (
                    <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'rgb(252,165,165)' }}>
                      <AlertTriangle size={13} /> {error}
                    </div>
                  )}
                </section>

                <section>
                  <div className="flex items-center justify-between gap-3">
                    <SectionTitle title="最近记录" desc="接收审计只表示本节点收到了对端推送" />
                    <div className="flex items-center gap-1">
                      {RECORD_FILTERS.map(t => (
                        <button key={t.key} onClick={() => setRecordFilter(t.key)}
                          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition"
                          style={{
                            color: recordFilter === t.key ? 'var(--text-primary)' : 'rgb(148,163,184)',
                            background: recordFilter === t.key ? 'rgba(45,212,191,0.12)' : 'transparent',
                            border: `1px solid ${recordFilter === t.key ? 'rgba(45,212,191,0.30)' : 'transparent'}`,
                          }}>
                          {t.label}
                          <span className="rounded-full px-1.5 text-[10px]" style={{ background: 'rgba(148,163,184,0.16)' }}>{counts[t.key]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {filtered.length === 0 ? (
                    <div className="mt-2 flex flex-col items-center justify-center rounded-xl border py-10 text-center" style={{ borderColor: 'rgba(148,163,184,0.14)', color: 'var(--text-muted)' }}>
                      <ArrowLeftRight size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
                      <div className="text-sm">暂无记录</div>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2.5">{filtered.slice(0, 12).map(r => <RunCard key={r.id} run={r} />)}</div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 强制对齐二次确认 */}
      {confirmAlign && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4" style={{ background: 'rgba(5,7,12,0.6)' }} onClick={() => setConfirmAlign(null)}>
          <div className="w-full max-w-[420px] rounded-2xl border p-5" style={{ background: 'var(--bg-elevated)', borderColor: 'rgba(248,113,113,0.34)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-base font-semibold" style={{ color: 'rgb(252,165,165)' }}>
              <AlertTriangle size={18} /> 确认强制对齐
            </div>
            <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {confirmAlign === 'remote'
                ? <>将以对端「{activeNode?.displayName}」为准，<b>删除本库在对端不存在的文档</b>。此操作不可恢复。</>
                : <>将以本库为准，<b>删除对端「{activeNode?.displayName}」在本库不存在的文档</b>。此操作不可恢复。</>}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmAlign(null)}>取消</Button>
              <Button size="sm" onClick={() => runAlign(confirmAlign)} disabled={submitting}>
                {submitting ? <MapSpinner size={14} /> : <Scale size={14} />} 确认对齐
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}

function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div>
      <div className="text-sm font-semibold">{title}</div>
      {desc && <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</div>}
    </div>
  );
}

function RunCard({ run, forceExpanded = false }: { run: PeerSyncRun; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(forceExpanded || run.status === 'error');
  const incoming = run.origin === 'incoming';
  const dirLabel = directionLabel(run.direction);
  // 崩溃残留的陈旧 syncing 行（超 30min）不再显示为「进行中」金色脉冲，按 stale 中性态展示（Bugbot）。
  const active = isRunActive(run);
  const stale = run.status === 'syncing' && !active;
  const st = statusMeta(stale ? 'stale' : run.status);
  const progressTotal = Math.max(0, run.progressTotal ?? 0);
  const progressCurrent = progressTotal > 0 ? Math.min(Math.max(0, run.progressCurrent ?? 0), progressTotal) : 0;
  const progressPercent = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;
  const hasDetails = Boolean(run.message || run.currentRecordTitle || progressTotal > 0 || run.status === 'error' || stale);
  return (
    <div
      className="rounded-xl border p-3 transition-colors"
      style={{ borderColor: active ? 'rgba(245,158,11,0.34)' : 'rgba(148,163,184,0.16)', background: active ? 'rgba(245,158,11,0.10)' : 'rgba(15,23,42,0.34)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {hasDetails && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-white/10"
              aria-label={expanded ? '收起同步详情' : '展开同步详情'}
              title={expanded ? '收起详情' : '查看失败原因和同步进度'}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <span className="text-sm font-semibold truncate">{run.itemName || run.itemId}</span>
          <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]" style={{ color: incoming ? 'rgb(147,180,255)' : 'rgb(94,234,212)', background: incoming ? 'rgba(59,130,246,0.12)' : 'rgba(20,184,166,0.12)', border: `1px solid ${incoming ? 'rgba(59,130,246,0.3)' : 'rgba(45,212,191,0.34)'}` }}>{dirLabel}</span>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]" style={{ color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>
          {active ? <MapSpinner size={11} /> : st.icon}{st.label}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {run.created > 0 && <span style={{ color: 'rgb(134,239,172)' }}>新增 {run.created}</span>}
        {run.updated > 0 && <span style={{ color: 'rgb(94,234,212)' }}>更新 {run.updated}</span>}
        {run.skipped > 0 && <span>已一致 {run.skipped}</span>}
        {run.deleted > 0 && <span style={{ color: 'rgb(252,165,165)' }}>删除 {run.deleted}</span>}
        {run.failed > 0 && <span style={{ color: 'rgb(252,165,165)' }}>失败 {run.failed}</span>}
        {(run.assetsRewritten > 0 || run.assetRewriteFailed > 0) && <span>图片重传 {run.assetsRewritten}/失败 {run.assetRewriteFailed}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px]" style={{ color: 'var(--text-faint, rgba(148,163,184,0.7))' }}>
        <span>{incoming ? '接收自' : '对端'} {run.peerNodeName}</span>
        <span>{formatTime(run.startedAt)}</span>
        {run.durationMs > 0 && <span>耗时 {(run.durationMs / 1000).toFixed(1)}s</span>}
        {run.triggeredByName && <span>{run.triggeredByName}</span>}
      </div>
      {(active || progressTotal > 0) && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span className="min-w-0 truncate">
              {run.progressPhase || (active ? '同步中' : '同步进度')}
              {run.currentRecordTitle && (
                <span className="ml-1" style={{ color: 'var(--text-primary)' }}>《{run.currentRecordTitle}》</span>
              )}
            </span>
            {progressTotal > 0 && <span className="shrink-0 tabular-nums">{progressCurrent}/{progressTotal}</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.16)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progressTotal > 0 ? progressPercent : active ? 18 : 0}%`,
                background: active ? 'linear-gradient(90deg, rgba(45,212,191,0.9), rgba(129,140,248,0.95))' : 'rgba(45,212,191,0.75)',
              }}
            />
          </div>
        </div>
      )}
      {expanded && (
        <div className="mt-3 rounded-lg border p-3 text-[12px] leading-6" style={{ borderColor: run.status === 'error' ? 'rgba(248,113,113,0.26)' : 'rgba(148,163,184,0.14)', background: 'rgba(2,6,23,0.22)' }}>
          {run.currentRecordTitle && (
            <div className="mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
              <FileText size={13} />
              <span>当前处理：{run.currentRecordTitle}</span>
            </div>
          )}
          {run.message ? (
            <div style={{ color: run.status === 'error' ? 'rgb(252,165,165)' : 'var(--text-secondary)' }}>
              {run.status === 'error' ? '失败原因：' : '同步结果：'}{run.message}
            </div>
          ) : run.status === 'error' ? (
            <div style={{ color: 'rgb(252,165,165)' }}>失败原因：后端没有返回具体错误，请刷新后重试或检查对端节点日志。</div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>暂无更多详情。</div>
          )}
          {(run.status === 'error' || stale) && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              建议先确认「设置 → 系统互联」里的对端节点可连通，再重新发起同步。
            </div>
          )}
          {incoming && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              这是一条接收审计，表示本节点收到了对端推送；不代表本节点主动同步回对端。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 「进行中」判定：syncing 且开始于近 30 分钟内（与详情页 + 后端租约 TTL 同口径）。
// 崩溃残留的陈旧 syncing 台账超过此窗口即视为非活动，不再让 UI 永久脉冲。
const RUN_FRESH_MS = 30 * 60 * 1000;
function isRunActive(r: PeerSyncRun): boolean {
  return r.status === 'syncing' && Date.now() - new Date(r.startedAt).getTime() < RUN_FRESH_MS;
}

export function shouldConfirmAutoDirection(direction: string | null | undefined): boolean {
  return direction === 'received';
}

export function directionLabel(d: string): string {
  // 纯文本，不带任何符号字形（遵守 CLAUDE.md §0 禁止 emoji；方向语义由文案表达，视觉强调走底色）。
  switch (d) {
    case 'push': return '发送';
    case 'pull': return '拉取';
    case 'both': return '双向';
    case 'received': return '接收审计';
    case 'align-remote': return '远端为准';
    case 'align-local': return '本地为准';
    case 'align-both': return '同时对准';
    default: return d;
  }
}

function statusMeta(s: string): { label: string; color: string; bg: string; border: string; icon: ReactNode } {
  if (s === 'synced') return { label: '完成', color: 'rgb(134,239,172)', bg: 'rgba(22,101,52,0.18)', border: 'rgba(34,197,94,0.3)', icon: <CheckCircle2 size={12} /> };
  if (s === 'skipped') return { label: '已同步', color: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.28)', icon: <CheckCircle2 size={12} /> };
  if (s === 'error') return { label: '失败', color: 'rgb(252,165,165)', bg: 'rgba(127,29,29,0.18)', border: 'rgba(248,113,113,0.34)', icon: <AlertTriangle size={12} /> };
  // 陈旧：标记 syncing 但超 30min 未收尾（多为进程中断），按中性「未完成」展示，不再金色脉冲。
  if (s === 'stale') return { label: '未完成', color: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.28)', icon: <AlertTriangle size={12} /> };
  return { label: '进行中', color: 'rgb(252,211,77)', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.34)', icon: <Clock3 size={12} /> };
}

function activeNodeName(nodes: PeerNode[], nodeId: string): string | null {
  return nodes.find(n => n.id === nodeId)?.displayName || null;
}

function runIdentity(r: Pick<PeerSyncRun, 'itemId' | 'direction' | 'origin'>): string {
  return `${r.itemId}::${r.origin}::${r.direction}`;
}

function runStartedAt(r: Pick<PeerSyncRun, 'startedAt'>): number {
  const t = new Date(r.startedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function isProblemRun(run: PeerSyncRun, allRuns: PeerSyncRun[]): boolean {
  const stale = run.status === 'syncing' && !isRunActive(run);
  if (run.status !== 'error' && !stale) return false;
  const identity = runIdentity(run);
  const startedAt = runStartedAt(run);
  return !allRuns.some(other =>
    other.id !== run.id
    && runIdentity(other) === identity
    && runStartedAt(other) > startedAt
    && (other.status === 'synced' || other.status === 'skipped'));
}

export function getTransferFailureMessage(data: { anyFail?: boolean; results?: TransferItemResult[] } | null | undefined): string | null {
  if (!data?.anyFail) return null;
  const failed = data.results?.find(r => !r.ok);
  if (!failed) return '同步未完成，部分条目失败';
  const name = failed.name || failed.itemId || '当前知识库';
  return failed.message ? `${name}：${failed.message}` : `${name}：同步未完成`;
}

export function syncRouteText(direction: string | null | undefined, nodeName: string): string {
  switch (direction) {
    case 'push': return `自动把本库发送到「${nodeName}」`;
    case 'pull': return `自动从「${nodeName}」拉回本库`;
    case 'both': return `自动与「${nodeName}」双向保持一致`;
    case 'align-remote':
    case 'align-local':
    case 'align-both':
      return `最近做过强制对齐，后续自动同步按双向非删除方式运行`;
    case 'received':
      return '最近只是接收过对端推送，尚未确认自动同步方向';
    default:
      return '先手动同步一次，确认对端和方向后再开启自动同步';
  }
}

export function statusText(run: Pick<PeerSyncRun, 'status' | 'origin' | 'startedAt'>): string {
  if (run.status === 'error') return '失败';
  if (run.status === 'syncing') return Date.now() - new Date(run.startedAt).getTime() < RUN_FRESH_MS ? '进行中' : '未完成';
  if (run.status === 'skipped') return '两边已一致';
  if (run.status === 'synced') return run.origin === 'incoming' ? '已接收对端推送' : '已完成';
  return run.status;
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
