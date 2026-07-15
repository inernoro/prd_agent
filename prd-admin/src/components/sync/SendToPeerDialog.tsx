/**
 * 批量同步弹窗（知识库列表页）。与单库同步面板（SyncCenterDialog）同一套拓扑语言。
 *
 * 两个视图：
 *  - 发起：拓扑图「已选 N 个库 ⇄ 对端」+ 方向段控（发送/拉取/双向）+ 选库列表；策略走固定默认值。
 *  - 历史：列出全部同步台账，进行中的可「停止」（后端 runs/{id}/cancel）。
 * 相比旧版砍掉了实时监控面板的一堆术语与状态机、没开始就全是 0 的统计、每行未开始的进度条与步骤块。
 * 遵守 frontend-modal：createPortal 到 body、inline 高度、min-h:0 滚动、ESC + 蒙版关闭。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Check, CheckCircle2, Database, History,
  Layers, RefreshCw, Send, X,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listPeerNodes, listPeerItems, transferToPeer, listPeerSyncRuns, cancelPeerSyncRun,
  type PeerNode, type SyncResourceCapability, type SyncItemSummary,
  type TransferItemResult, type PeerTransferDirection, type PeerSyncRun,
} from '@/services/real/peerSync';
import { TONE_WIRE, RunCard, isRunActive, type SyncTone } from '@/pages/document-store/SyncCenterDialog';

interface Props {
  resourceType: string;
  presetItemIds?: string[];
  onClose: () => void;
  onDone?: () => void;
}

type Tab = 'send' | 'history';
type ItemStatus = 'unselected' | 'selected' | 'running' | 'done' | 'skipped' | 'failed';

const DIRECTIONS: { key: PeerTransferDirection; label: string; seg: string }[] = [
  { key: 'push', label: '发送', seg: '选中 → 对端' },
  { key: 'pull', label: '拉取', seg: '对端 → 选中' },
  { key: 'both', label: '双向', seg: '保持一致' },
];
const DIRECTION_VERB: Record<PeerTransferDirection, string> = { push: '发送', pull: '拉取', both: '双向同步' };

// 同步中阶段文案（发起后拓扑下方一行，让等待期有内容，非真实 per-item 流）。
const STAGES = ['正在读取所选知识库', '正在上传图片到目标域名', '正在按血缘合并内容', '正在回写同步状态'];

export function SendToPeerDialog({ resourceType, presetItemIds, onClose, onDone }: Props) {
  const [tab, setTab] = useState<Tab>('send');
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [capability, setCapability] = useState<SyncResourceCapability | null>(null);
  const [items, setItems] = useState<SyncItemSummary[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(presetItemIds ?? []));
  const [direction, setDirection] = useState<PeerTransferDirection>('both');

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<TransferItemResult[] | null>(null);
  const [stageIdx, setStageIdx] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  // 历史视图
  const [runs, setRuns] = useState<PeerSyncRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const safeClose = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') safeClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [safeClose]);

  // ── 发起视图数据 ──
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const mySeq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    const [nodesRes, itemsRes] = await Promise.all([listPeerNodes(), listPeerItems(resourceType)]);
    if (mySeq !== loadSeqRef.current || !mountedRef.current) return;
    if (nodesRes.success && nodesRes.data) {
      const nextNodes = nodesRes.data.items || [];
      const cap = (nodesRes.data.capabilities || []).find(c => c.resourceType === resourceType) || null;
      setNodes(nextNodes);
      setCapability(cap);
      if (nextNodes.length === 1) setNodeId(nextNodes[0].id);
      if (!cap?.supportsBidirectional) setDirection('push');
    } else {
      setLoadError(nodesRes.error?.message || '加载对端节点失败');
    }
    if (itemsRes.success && itemsRes.data) setItems(itemsRes.data.items || []);
    else setLoadError(prev => prev || itemsRes.error?.message || '加载可同步条目失败');
    setLoading(false);
  }, [resourceType]);
  useEffect(() => { void load(); }, [load]);

  // ── 历史视图数据（全部库台账）+ 轮询 ──
  const runsSeqRef = useRef(0);
  const loadRuns = useCallback(async () => {
    const my = ++runsSeqRef.current;
    const res = await listPeerSyncRuns(resourceType);
    if (mountedRef.current && my === runsSeqRef.current && res.success && res.data) setRuns(res.data.items || []);
  }, [resourceType]);
  const activeCount = useMemo(() => runs.filter(isRunActive).length, [runs]);
  useEffect(() => {
    if (tab !== 'history') return;
    let alive = true;
    setHistoryLoading(true);
    void loadRuns().finally(() => { if (alive && mountedRef.current) setHistoryLoading(false); });
    const t = window.setInterval(() => { void loadRuns(); }, activeCount > 0 ? 2000 : 6000);
    return () => { alive = false; window.clearInterval(t); };
  }, [tab, loadRuns, activeCount]);

  // 同步进行中的阶段文案推进
  useEffect(() => {
    if (!submitting) { setStageIdx(0); return; }
    const timers = [
      window.setTimeout(() => setStageIdx(1), 1200),
      window.setTimeout(() => setStageIdx(2), 3200),
      window.setTimeout(() => setStageIdx(3), 6200),
    ];
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [submitting]);

  const activeNode = useMemo(() => nodes.find(n => n.id === nodeId) || null, [nodes, nodeId]);
  const nodeName = activeNode?.displayName || (nodes.length ? '对端节点' : '未配对');
  const availableDirections = useMemo(
    () => DIRECTIONS.filter(d => d.key === 'push' || capability?.supportsBidirectional),
    [capability],
  );
  const selectedItems = useMemo(() => items.filter(it => selected.has(it.itemId)), [items, selected]);
  const canSubmit = Boolean(nodeId && selected.size > 0 && !submitting);
  const tone: SyncTone = submitting ? 'gold' : selected.size > 0 ? 'teal' : 'none';

  // 改选后上一轮的 results 已过时：清掉，避免取消选中的行仍按旧 result 显示「已完成/失败」，
  // 而「再次同步」只发当前 selected，造成弹窗看起来在重同步已不在 payload 里的条目（Codex P2）。
  const toggleItem = (id: string) => {
    if (submitting) return;
    setResults(null);
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const toggleAll = () => {
    if (submitting) return;
    setResults(null);
    setSelected(prev => prev.size === items.length ? new Set() : new Set(items.map(i => i.itemId)));
  };

  const itemStatus = (id: string): ItemStatus => {
    if (results) {
      const r = results.find(x => x.itemId === id);
      if (!r) return selected.has(id) ? 'selected' : 'unselected';
      return r.ok ? (isSkippedResult(r) ? 'skipped' : 'done') : 'failed';
    }
    if (transferError && selected.has(id)) return 'failed';
    if (submitting && selected.has(id)) return 'running';
    return selected.has(id) ? 'selected' : 'unselected';
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const runItemIds = selectedItems.map(it => it.itemId);
    setSubmitting(true);
    setTransferError(null);
    setResults(null);
    // 策略固定默认值：保留原时间 / 覆盖同名 / 图片重传，与单库同步面板同口径。
    const res = await transferToPeer({
      nodeId, resourceType, itemIds: runItemIds, direction,
      mode: 'overwrite', preserveTimestamps: true, rewriteAssetLinks: true,
    });
    if (!mountedRef.current) return;
    setSubmitting(false);
    if (res.success && res.data) {
      setResults(res.data.results || []);
      if ((res.data.results || []).some(r => r.ok)) onDone?.();
    } else {
      setTransferError(res.error?.message || '同步失败');
    }
  };

  const handleCancelRun = async (run: PeerSyncRun) => {
    const res = await cancelPeerSyncRun(run.id);
    if (!mountedRef.current) return;
    if (res.success) await loadRuns();
  };

  const primaryLabel = submitting ? '同步中…' : results ? '再次同步' : `开始${DIRECTION_VERB[direction]}`;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(5,7,12,0.70)' }} onClick={safeClose}>
      <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ maxHeight: '86vh', background: 'linear-gradient(150deg,rgba(18,24,33,0.99),rgba(26,30,40,0.99))', borderColor: 'rgba(148,163,184,0.24)', color: 'var(--text-primary)' }}
        onClick={e => e.stopPropagation()}>
        <style>{`
          @keyframes batchFlowR{to{stroke-dashoffset:-24}}
          @keyframes batchFlowL{to{stroke-dashoffset:24}}
          .batch-flow{fill:none;stroke-width:2.6;stroke-linecap:round;stroke-dasharray:9 15}
          .batch-topo.is-flowing .batch-flow.r{animation:batchFlowR 1s linear infinite}
          .batch-topo.is-flowing .batch-flow.l{animation:batchFlowL 1s linear infinite}
          .batch-topo.is-breathing .batch-flow.r{animation:batchFlowR 3.4s linear infinite}
          .batch-topo.is-breathing .batch-flow.l{animation:batchFlowL 3.4s linear infinite}
          @media(prefers-reduced-motion:reduce){.batch-flow{animation:none!important}}
        `}</style>

        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border" style={{ background: 'rgba(20,184,166,0.10)', borderColor: 'rgba(45,212,191,0.28)' }}>
            <Layers size={16} style={{ color: 'rgb(94,234,212)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-tight">批量同步</div>
            <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {selected.size > 0 ? `把 ${selected.size} 个知识库${DIRECTION_VERB[direction]}到「${nodeName}」` : '一次选多个知识库，同步到另一个 MAP 节点'}
            </div>
          </div>
          <button onClick={safeClose} className="rounded-lg p-2 transition hover:bg-white/10" aria-label="关闭"><X size={17} /></button>
        </div>

        {/* tab 切换 */}
        <div className="flex shrink-0 gap-1 border-b px-4 pt-2" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
          <TabBtn active={tab === 'send'} onClick={() => setTab('send')} icon={<Send size={13} />} label="发起" />
          <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={<History size={13} />} label="历史" badge={activeCount > 0 ? `${activeCount} 进行中` : undefined} />
        </div>

        {tab === 'send' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ overscrollBehavior: 'contain' }}>
              {loading ? <MapSectionLoader text="正在加载…" /> : (
                <>
                  <BatchTopology count={selected.size} nodeName={nodeName} direction={direction} tone={tone} hasNode={nodes.length > 0} />

                  {nodes.length > 1 && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>对端</span>
                      <select value={nodeId} onChange={e => setNodeId(e.target.value)} disabled={submitting}
                        className="prd-field h-7 rounded-lg px-2 text-xs outline-none" style={{ maxWidth: 220 }}>
                        <option value="">选择对端…</option>
                        {nodes.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
                      </select>
                    </div>
                  )}

                  {/* 方向段控 */}
                  <div className="mt-4 grid gap-1 rounded-xl border p-1" style={{ gridTemplateColumns: `repeat(${availableDirections.length}, 1fr)`, borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.34)' }}>
                    {availableDirections.map(d => {
                      const on = direction === d.key;
                      return (
                        <button key={d.key} onClick={() => !submitting && setDirection(d.key)} disabled={submitting}
                          className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-center transition disabled:opacity-60"
                          style={{ background: on ? 'rgba(20,184,166,0.14)' : 'transparent', color: on ? 'rgb(94,234,212)' : 'var(--text-secondary)', boxShadow: on ? 'inset 0 0 0 1px rgba(45,212,191,0.36)' : 'none' }}>
                          <span className="text-[12.5px] font-semibold">{d.label}</span>
                          <span className="text-[10px]" style={{ color: on ? 'rgba(94,234,212,0.7)' : 'var(--text-muted)' }}>{d.seg}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* 同步中阶段文案 */}
                  {submitting && (
                    <div className="mt-3 flex items-center justify-center gap-2 text-[11.5px]" style={{ color: 'rgb(252,211,77)' }}>
                      <MapSpinner size={12} /> {STAGES[stageIdx]}…
                    </div>
                  )}

                  {/* 选库列表 */}
                  <div className="mb-2 mt-4 flex items-center justify-between px-1">
                    <div className="text-[12.5px] font-semibold">选择知识库</div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>已选 {selected.size} / {items.length}</span>
                      {items.length > 0 && !submitting && (
                        <button onClick={toggleAll} className="rounded-md px-2 py-0.5 text-[11.5px]" style={{ color: 'rgb(94,234,212)' }}>
                          {selected.size === items.length ? '清空' : '全选'}
                        </button>
                      )}
                    </div>
                  </div>
                  {items.length === 0 ? (
                    <EmptyBlock icon={<Database size={20} />} title="没有可同步的知识库" desc="当前账号没有可发送的个人或团队知识库" />
                  ) : (
                    <div className="space-y-1.5">
                      {items.map(it => (
                        <ItemRow key={it.itemId} item={it} status={itemStatus(it.itemId)}
                          result={results?.find(r => r.itemId === it.itemId) || null} onToggle={() => toggleItem(it.itemId)} />
                      ))}
                    </div>
                  )}

                  <div className="mt-3 rounded-lg border px-3 py-2 text-[11px] leading-5" style={{ borderColor: 'rgba(45,212,191,0.18)', background: 'rgba(20,184,166,0.05)', color: 'var(--text-muted)' }}>
                    <span style={{ color: 'rgb(94,234,212)', fontWeight: 600 }}>默认策略，无需设置：</span>保留原时间、覆盖同名条目、图片重传到目标域名，完成后回读校验。
                  </div>

                  {(loadError || transferError) && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px]" style={{ borderColor: 'rgba(248,113,113,0.28)', background: 'rgba(127,29,29,0.16)', color: 'rgb(252,165,165)' }}>
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{transferError || loadError}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t px-5 py-4" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="flex-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>已选 <b style={{ color: 'var(--text-primary)' }}>{selected.size}</b> 个知识库</div>
              <Button size="sm" variant="ghost" onClick={safeClose}>取消</Button>
              <Button size="sm" onClick={handleSubmit} disabled={!canSubmit} className="h-10 px-5">
                {submitting ? <MapSpinner size={14} /> : <Send size={14} />} {primaryLabel}
              </Button>
            </div>
          </>
        ) : (
          /* 历史视图 */
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ overscrollBehavior: 'contain' }}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>所有知识库的同步记录，进行中的可停止</div>
              <button onClick={() => loadRuns()} className="rounded-lg p-1.5 hover:bg-white/10" title="刷新"><RefreshCw size={14} /></button>
            </div>
            {historyLoading && runs.length === 0 ? <MapSectionLoader text="正在加载…" /> : runs.length === 0 ? (
              <EmptyBlock icon={<History size={20} />} title="暂无同步记录" desc="发起一次批量同步后，这里会出现记录" />
            ) : (
              <div className="space-y-2.5">
                {runs.map(r => <RunCard key={r.id} run={r} onCancel={handleCancelRun} forceExpanded={r.status === 'error'} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function TabBtn({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; badge?: string }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-[12.5px] font-semibold transition"
      style={{ color: active ? 'rgb(94,234,212)' : 'var(--text-muted)', borderBottom: `2px solid ${active ? 'rgb(45,212,191)' : 'transparent'}` }}>
      {icon}{label}
      {badge && <span className="rounded-full px-1.5 text-[10px]" style={{ background: 'rgba(245,158,11,0.16)', color: 'rgb(252,211,77)' }}>{badge}</span>}
    </button>
  );
}

/** 批量拓扑图：已选 N 个库 ⇄ 对端。与单库 SyncTopology 同款视觉，左节点换成堆叠库图标 + 计数。 */
function BatchTopology({ count, nodeName, direction, tone, hasNode }: {
  count: number; nodeName: string; direction: PeerTransferDirection; tone: SyncTone; hasNode: boolean;
}) {
  const w = TONE_WIRE[tone];
  const linked = count > 0 && hasNode;
  const animClass = linked ? (w.anim === 'flowing' ? 'is-flowing' : w.anim === 'breathing' ? 'is-breathing' : '') : '';
  const discStyle = linked
    ? { borderColor: w.wire, background: w.bg, color: w.strong, boxShadow: `0 0 0 4px ${w.bg}` }
    : { borderColor: 'rgba(148,163,184,0.30)', background: 'rgba(15,23,42,0.5)', color: 'var(--text-2, #aebbc9)' };
  return (
    <div className={`batch-topo ${animClass} grid items-center`} style={{ gridTemplateColumns: '1fr auto 1fr', gap: 6 }}>
      <TopoNode role="本端" name={count > 0 ? `已选 ${count} 个库` : '未选择库'} style={discStyle}
        icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><rect x="3" y="8" width="14" height="12" rx="2" /><path d="M7 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></svg>} />
      <div className="relative" style={{ width: 130, height: 70 }}>
        <svg viewBox="0 0 130 70" preserveAspectRatio="none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          <path d="M6 35 H124" fill="none" stroke={w.wire} strokeWidth={2.2} strokeLinecap="round" strokeDasharray="2 7" opacity={0.9} />
          {linked && direction === 'push' && (<>
            <path className="batch-flow r" d="M6 35 H120" stroke={w.strong} />
            <path d="M121 35 L114 31 L114 39 Z" fill={w.strong} />
          </>)}
          {linked && direction === 'pull' && (<>
            <path className="batch-flow l" d="M10 35 H124" stroke={w.strong} />
            <path d="M9 35 L16 31 L16 39 Z" fill={w.strong} />
          </>)}
          {linked && direction === 'both' && (<>
            <path className="batch-flow r" d="M6 27 H120" stroke={w.strong} />
            <path d="M121 27 L114 23 L114 31 Z" fill={w.strong} />
            <path className="batch-flow l" d="M10 43 H124" stroke={w.strong} />
            <path d="M9 43 L16 39 L16 47 Z" fill={w.strong} />
          </>)}
        </svg>
        {linked && (
          <div className="absolute flex items-center justify-center rounded-full"
            style={{ top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 24, height: 24, background: 'rgb(18,24,33)', border: `1.5px solid ${w.wire}`, color: w.strong }}>
            {tone === 'gold' ? <RefreshCw size={12} /> : <CheckCircle2 size={12} />}
          </div>
        )}
      </div>
      <TopoNode role="对端" name={hasNode ? nodeName : '未配对'} muted={!hasNode} style={discStyle}
        icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>} />
    </div>
  );
}

function TopoNode({ icon, name, role, style, muted }: { icon: ReactNode; name: string; role: string; style: React.CSSProperties; muted?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <div className="flex h-[58px] w-[58px] items-center justify-center rounded-2xl border transition-all"
        style={muted ? { borderColor: 'rgba(148,163,184,0.24)', background: 'rgba(15,23,42,0.4)', color: 'var(--text-muted)' } : style}>
        {icon}
      </div>
      <div className="max-w-[140px] truncate text-[12px] font-semibold" title={name}>{name}</div>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)', letterSpacing: '0.04em' }}>{role}</div>
    </div>
  );
}

function ItemRow({ item, status, result, onToggle }: { item: SyncItemSummary; status: ItemStatus; result: TransferItemResult | null; onToggle: () => void }) {
  const sel = status !== 'unselected';
  const meta = STATUS_META[status];
  return (
    <button onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition"
      style={{ borderColor: sel ? 'rgba(45,212,191,0.36)' : 'rgba(148,163,184,0.16)', background: sel ? 'rgba(20,184,166,0.10)' : 'rgba(2,6,23,0.2)' }}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
        style={{ borderColor: sel ? 'rgb(94,234,212)' : 'rgba(148,163,184,0.30)', background: sel ? 'rgba(20,184,166,0.2)' : 'transparent', color: sel ? 'rgb(94,234,212)' : 'transparent' }}>
        <Check size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{stripTimestampSuffix(item.name)}</span>
          <span className="shrink-0 rounded-full border px-1.5 text-[10.5px] font-normal" style={{ borderColor: 'rgba(148,163,184,0.2)', color: 'var(--text-2, #aebbc9)' }}>{item.recordCount} 项</span>
        </div>
        {(result?.message || item.updatedAt) && (
          <div className="mt-0.5 truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            {result?.message ? result.message : `更新 ${formatShortTime(item.updatedAt!)}`}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[11px] font-semibold" style={{ color: meta.color }}>
        {status === 'running' ? <MapSpinner size={12} /> : meta.label}
      </span>
    </button>
  );
}

const STATUS_META: Record<ItemStatus, { label: string; color: string }> = {
  unselected: { label: '未选', color: 'rgb(148,163,184)' },
  selected: { label: '已选', color: 'rgb(94,234,212)' },
  running: { label: '同步中', color: 'rgb(252,211,77)' },
  done: { label: '完成', color: 'rgb(134,239,172)' },
  skipped: { label: '已一致', color: 'rgb(148,163,184)' },
  failed: { label: '失败', color: 'rgb(252,165,165)' },
};

function EmptyBlock({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-2xl border px-4 py-8 text-center" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.36)' }}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'rgba(148,163,184,0.10)', color: 'rgb(148,163,184)' }}>{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</div>
    </div>
  );
}

/** 已同步（无增删改）判定：与旧逻辑一致，供列表行显示「已一致」而非「完成」。 */
export function isSkippedResult(result: TransferItemResult): boolean {
  if (!result.ok) return false;
  const created = result.created ?? 0;
  const updated = result.updated ?? 0;
  const failed = result.failed ?? 0;
  const skipped = result.skipped ?? 0;
  if (skipped > 0 && created === 0 && updated === 0 && failed === 0) return true;
  const message = result.message ?? '';
  return /新增0\/更新0\/跳过[1-9]\d*/.test(message) && !/失败[1-9]\d*/.test(message);
}

function stripTimestampSuffix(name: string): string {
  return name.replace(/[-_]?20\d{10,14}$/, '');
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
