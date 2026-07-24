/**
 * 同步面板（MAP 知识库传输协议 · 前端唯一入口）。
 *
 * 用户心智：一个库 x 一个对端 = 一条同步关系（方向 + 是否自动）。
 * 主视觉是「本库 ⇄ 对端」关系拓扑图——箭头方向即同步方向，连线颜色与流动即同步状态，
 * 一张图顶掉大半文字（artifact-is-experience：等待期看到的是关系本身在流动，不是 spinner）。
 * 结构自上而下（默认一屏不滚动）：拓扑图 -> 一行状态 -> 方向三键段控 -> 立即同步 + 自动开关
 * -> （折叠）最近记录 / 高级对齐。
 * 「发送到」不再是独立门面，它只是方向为「发送」的关系的一次执行；策略收敛为固定默认值。
 * 遵守 frontend-modal：createPortal 到 body、inline 高度、min-h:0 滚动、ESC + 蒙版关闭。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, AlertTriangle, CheckCircle2, Clock3,
  Globe, RefreshCw, Scale, Send, X, ChevronDown, ChevronRight, FileText,
  Library, History, SlidersHorizontal, Ban, Square,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listPeerNodes, listPeerSyncRuns, transferToPeer, setAutoSync, cancelPeerSyncRun,
  type PeerNode, type PeerSyncRun, type PeerAlign, type TransferItemResult,
} from '@/services/real/peerSync';

interface Props {
  storeId: string;
  storeName: string;
  resourceType?: string;
  onClose: () => void;
  onAfterSync?: () => void;
  /** 当前是否已开启后台自动同步（来自 store.peerSyncAutoEnabled） */
  autoEnabled?: boolean | null;
  /** 自动同步周期（分钟，来自 store.peerSyncIntervalMinutes） */
  autoIntervalMinutes?: number | null;
  /** 自动发送模式（默认 trigger） */
  autoMode?: string | null;
  /** 最近一次同步的方向（非空表示已手动同步过一次，可开启自动同步） */
  peerSyncDirection?: string | null;
  /** 最近一次同步的对端稳定 ID（RemoteNodeId），多对端时用于预选已保存的对端 */
  peerNodeId?: string | null;
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
/** 同步方式（关系方向）：发送 / 拉回 / 双向，选一次长期生效 */
type ManualDirection = 'push' | 'pull' | 'both';
/** 状态色调：需处理 > 同步中 > 已建立 > 未建立 */
export type SyncTone = 'red' | 'gold' | 'teal' | 'none';

const RECORD_FILTERS: { key: RecordFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我发起' },
  { key: 'received', label: '接收审计' },
  { key: 'failed', label: '失败' },
];

const DIRECTION_OPTS: { key: ManualDirection; label: string; seg: string; arrow: (node: string) => string; desc: string; recommended?: boolean }[] = [
  { key: 'push', label: '发送', seg: '本库 → 对端', arrow: n => `本库 → ${n}`, desc: '把本库内容发布到对端，对端不回写' },
  { key: 'pull', label: '拉回', seg: '对端 → 本库', arrow: n => `${n} → 本库`, desc: '把对端内容取回本库，本库不外发' },
  { key: 'both', label: '双向', seg: '保持一致', arrow: n => `本库 ⇄ ${n}`, desc: '两边合并保持一致，各自新增都保留', recommended: true },
];

const DIRECTION_VERB: Record<ManualDirection, string> = { push: '发送', pull: '拉回', both: '双向同步' };

/** 归一方向 -> 算作「该方向成功过」的 run.direction 取值（对齐 align-* 归一，与后端 AcceptableRunDirections 同口径）。 */
const DIRECTION_ALIGN_EQUIV: Record<ManualDirection, string[]> = {
  push: ['push', 'align-local'],
  pull: ['pull', 'align-remote'],
  both: ['both', 'align-both'],
};

const ALIGN_OPTS: { key: PeerAlign; label: string; desc: string; danger: boolean; icon: ReactNode }[] = [
  { key: 'remote', label: '远端为准', desc: '本地对齐对端：对端没有的本地删掉', danger: true, icon: <ArrowLeft size={15} /> },
  { key: 'local', label: '本地为准', desc: '对端对齐本地：本地没有的对端删掉', danger: true, icon: <ArrowRight size={15} /> },
  { key: 'both', label: '同时对准', desc: '两边合并，各自新增都保留，不删任何一边', danger: false, icon: <ArrowLeftRight size={15} /> },
];

/** 状态色调 -> 连线/端点视觉（青=已同步呼吸 / 金=同步中流动 / 红=需处理 / 灰=未建立）。批量弹窗复用同一 SSOT。 */
export const TONE_WIRE: Record<SyncTone, { wire: string; strong: string; bg: string; anim: 'flowing' | 'breathing' | 'none' }> = {
  none: { wire: 'rgba(148,163,184,0.30)', strong: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.08)', anim: 'none' },
  teal: { wire: 'rgba(45,212,191,0.42)', strong: 'rgb(94,234,212)', bg: 'rgba(20,184,166,0.12)', anim: 'breathing' },
  gold: { wire: 'rgba(245,158,11,0.50)', strong: 'rgb(252,211,77)', bg: 'rgba(245,158,11,0.12)', anim: 'flowing' },
  red: { wire: 'rgba(248,113,113,0.44)', strong: 'rgb(252,165,165)', bg: 'rgba(239,68,68,0.10)', anim: 'none' },
};

export function SyncCenterDialog({ storeId, storeName, resourceType = 'document-store', onClose, onAfterSync, autoEnabled, autoIntervalMinutes, autoMode, peerSyncDirection, peerNodeId, peerNodeName }: Props) {
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<PeerSyncRun[]>([]);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [recordFilter, setRecordFilter] = useState<RecordFilter>('all');
  const [showRecords, setShowRecords] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmAlign, setConfirmAlign] = useState<PeerAlign | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 同步方式（关系方向）：初值来自服务端最近一次方向；received/无记录 = 还没确认，需用户选 */
  const [direction, setDirection] = useState<ManualDirection | null>(() => initialManualDirection(peerSyncDirection));
  // 后台自动同步本地态（乐观更新）
  const [autoOn, setAutoOn] = useState(!!autoEnabled);
  const [autoInterval, setAutoInterval] = useState(autoIntervalMinutes && autoIntervalMinutes > 0 ? autoIntervalMinutes : 60);
  const [autoSendMode, setAutoSendMode] = useState<'trigger' | 'scheduled'>(autoMode === 'scheduled' ? 'scheduled' : 'trigger');
  const [autoBusy, setAutoBusy] = useState(false);
  // 服务端全量历史判定的「已建立关系」（针对当前保存的对端+方向），兜底被截断到 80 条的 runs 列表（Codex P2）。
  const [serverEstablished, setServerEstablished] = useState(false);
  const mounted = useRef(true);
  // 「需要处理」首次出现时自动展开失败记录一次；之后尊重用户手动折叠。
  const autoOpenedProblems = useRef(false);

  const activeNode = nodes.find(n => n.id === nodeId) || null;
  // 「已建立关系」= 当前选中的对端 + 方向组合确实成功同步过一次——与后端 auto-sync gate/worker 守护同口径。
  // 不是「该库任意成功过」：切对端 A→B 或换方向未成功时，旧组合的成功不能算作新组合已建立（Codex P2）。
  // run.direction 对齐存 align-*，用等价集合归一（align-remote≈pull / align-local≈push / align-both≈both）。
  const acceptableRunDirs = direction ? DIRECTION_ALIGN_EQUIV[direction] : [];
  // 从（被截断到 80 条的）runs 列表推断的「已建立」——够用于绝大多数库，但长命库成功 run 可能已滚出窗口。
  const everSyncedFromRuns = !!activeNode && runs.some(r =>
    r.origin === 'outgoing'
    && (r.status === 'synced' || r.status === 'skipped')
    && r.peerNodeId === activeNode.remoteNodeId
    && acceptableRunDirs.includes(r.direction));
  // 自动同步复用「最近成功同步的方向」（服务端 PeerSyncDirection）；用户在段控里改了方向但还没成功
  // 手动同步一次，就开自动，会出现「header 说自动 pull、后台 run 还 push」的不一致（Codex P2）。
  // 因此本地方向与服务端保存方向不一致时，禁用自动开关，逼用户先按新方向成功同步一次。
  const serverDirection = initialManualDirection(peerSyncDirection);
  const directionDirty = !!serverDirection && !!direction && direction !== serverDirection;
  // 同理，多对端时选了一个还没成功同步过的对端（≠ 已保存关系的 peerNodeId），也不能开自动：
  // setAutoSync 不带 nodeId，后端会对 saved peer 开自动，而面板拓扑显示的是新选对端，方向/对端两不一致（Codex P2）。
  const peerDirty = !!peerNodeId && !!activeNode && activeNode.remoteNodeId !== peerNodeId;
  const relationDirty = directionDirty || peerDirty;
  // 有效「已建立」= runs 列表可见成功记录，或（当前选中组合==已保存关系且服务端全量门通过）。
  // 后者兜底 runs 被截断到 80 条、当年建立关系的成功 run 已滚出窗口的长命库；选中组合偏离已保存关系
  // （relationDirty）时不认服务端 flag（它只针对 saved peer+方向），回落到 runs 推断（与后端 gate 同口径，Codex P2）。
  const everSynced = everSyncedFromRuns || (serverEstablished && !relationDirty);
  const canAuto = everSynced && !shouldConfirmAutoDirection(peerSyncDirection) && !relationDirty;

  useEffect(() => {
    // React StrictMode 开发态会执行一次 setup -> cleanup -> setup；第二次 setup 必须恢复存活标记，
    // 否则节点/运行记录虽已成功返回，load 仍会把响应当成卸载后的结果丢弃，面板永久停在「正在加载」。
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // 跟随 props 更新：onAfterSync 重载 store 后 autoEnabled/autoIntervalMinutes 会变，
  // 弹窗常开时本地态需同步，否则 UI 与服务端不一致（Bugbot）。乐观更新成功后 prop==本地值，此处为 no-op。
  useEffect(() => { setAutoOn(!!autoEnabled); }, [autoEnabled]);
  useEffect(() => { if (autoIntervalMinutes && autoIntervalMinutes > 0) setAutoInterval(autoIntervalMinutes); }, [autoIntervalMinutes]);
  useEffect(() => { setAutoSendMode(autoMode === 'scheduled' ? 'scheduled' : 'trigger'); }, [autoMode]);

  // runs 发号器：load 与 loadRuns 轮询都会 setRuns，只应用「最新一发」结果，防慢响应覆盖快响应
  // （学习规则：轮询/并发 fetch 需 stale-response 守卫）。
  const runsSeq = useRef(0);

  const loadRuns = useCallback(async () => {
    const my = ++runsSeq.current;
    const res = await listPeerSyncRuns(resourceType, storeId);
    if (mounted.current && my === runsSeq.current && res.success && res.data) {
      setRuns(res.data.items || []);
      setServerEstablished(!!res.data.established);
    }
  }, [resourceType, storeId]);

  const load = useCallback(async () => {
    setLoading(true);
    const my = ++runsSeq.current;
    const [nodesRes, runsRes] = await Promise.all([listPeerNodes(), listPeerSyncRuns(resourceType, storeId)]);
    if (!mounted.current) return;
    if (nodesRes.success && nodesRes.data) {
      const ns = nodesRes.data.items || [];
      setNodes(ns);
      // 预选对端：单对端直接选；多对端则匹配已保存关系的 RemoteNodeId，
      // 否则已建立关系的库重开面板会因 nodeId 空而无法立即同步（Codex P2）。
      if (ns.length === 1) setNodeId(ns[0].id);
      else if (peerNodeId) {
        const saved = ns.find(n => n.remoteNodeId === peerNodeId);
        if (saved) setNodeId(saved.id);
      }
    }
    if (my === runsSeq.current && runsRes.success && runsRes.data) {
      setRuns(runsRes.data.items || []);
      setServerEstablished(!!runsRes.data.established);
    }
    setLoading(false);
  }, [resourceType, storeId, peerNodeId]);

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
  const nodeName = activeNodeName(nodes, nodeId) || peerNodeName || latestRun?.peerNodeName || '对端节点';
  const autoDirectionNeedsConfirm = shouldConfirmAutoDirection(peerSyncDirection) && !direction;

  // 「需要处理」首次出现自动展开失败记录（异常态多一屏合理），其后尊重用户折叠。
  useEffect(() => {
    if (problemRuns.length > 0 && !autoOpenedProblems.current) {
      autoOpenedProblems.current = true;
      setShowRecords(true);
      setRecordFilter('failed');
    }
  }, [problemRuns.length]);

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

  const progressRun = activeRuns.find(r => (r.progressTotal ?? 0) > 0) || activeRuns[0] || null;

  const tone: SyncTone = problemRuns.length > 0 ? 'red' : activeRuns.length > 0 ? 'gold' : everSynced ? 'teal' : 'none';

  /** 立即同步：按既定关系方向执行；策略走固定默认值（保留原时间 / 覆盖同名 / 图片重传）。 */
  const runNow = async () => {
    if (!nodeId) { setError('请先选择对端节点'); return; }
    if (!direction) { setError('请先选择同步方式（发送 / 拉回 / 双向）'); return; }
    setSubmitting(true);
    setError(null);
    const res = await transferToPeer({
      nodeId, resourceType, itemIds: [storeId], direction,
      mode: 'overwrite', preserveTimestamps: true, rewriteAssetLinks: true,
    });
    if (!mounted.current) return;
    setSubmitting(false);
    const businessError = getTransferFailureMessage(res.success ? res.data : undefined);
    if (res.success && !businessError) {
      setRecordFilter('all');
      await loadRuns();
      onAfterSync?.();
    } else if (res.success) {
      setRecordFilter('failed');
      setShowRecords(true);
      setError(businessError || '同步失败');
      await loadRuns();
    } else {
      setError(res.error?.message || '同步失败');
    }
  };

  // 停止一个进行中的同步 run（置取消位，后端在检查点中断落 cancelled）。
  const handleCancelRun = async (run: PeerSyncRun) => {
    setError(null);
    const res = await cancelPeerSyncRun(run.id);
    if (!mounted.current) return;
    if (res.success) await loadRuns();
    else setError(res.error?.message || '取消失败');
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
      // 对齐成功即建立/更新了关系方向：把本地 direction 同步为对齐的归一方向（remote≈pull / local≈push / both≈both），
      // 否则首次对齐后本地仍 direction=null → everSynced 恒 false，面板一直说未建立、禁自动，直到重开（Codex P2）。
      setDirection(align === 'remote' ? 'pull' : align === 'local' ? 'push' : 'both');
      setRecordFilter('all');
      await loadRuns();
      onAfterSync?.();
    } else if (res.success) {
      setRecordFilter('failed');
      setShowRecords(true);
      setError(businessError || '对齐失败');
      await loadRuns();
    } else {
      setError(res.error?.message || '对齐失败');
    }
  };

  // 后台自动同步开关 / 改周期（乐观更新 + 失败回滚）。
  const applyAuto = async (enabled: boolean, interval: number, mode: 'trigger' | 'scheduled' = autoSendMode) => {
    if (resourceType !== 'document-store') return;
    if (enabled && !everSynced) { setError('请先手动同步一次（确定对端与方向）后，再开启自动同步'); return; }
    setAutoBusy(true);
    setError(null);
    const prevOn = autoOn;
    const prevInterval = autoInterval;
    const prevMode = autoSendMode;
    setAutoOn(enabled);
    setAutoInterval(interval);
    setAutoSendMode(mode);
    const res = await setAutoSync({ resourceType, itemId: storeId, enabled, intervalMinutes: interval, mode });
    if (!mounted.current) return;
    setAutoBusy(false);
    if (res.success && res.data) {
      setAutoOn(res.data.enabled);
      setAutoInterval(res.data.intervalMinutes);
      setAutoSendMode(res.data.mode);
      onAfterSync?.();
    } else {
      setAutoOn(prevOn);
      setAutoInterval(prevInterval);
      setAutoSendMode(prevMode);
      setError(res.error?.message || '设置自动同步失败');
    }
  };

  const primaryLabel = submitting ? '同步中…'
    : !direction ? '先选择方向'
      : tone === 'red' ? '重试同步'
        : everSynced ? '立即同步' : `开始第一次${DIRECTION_VERB[direction]}`;

  const status = statusLine(tone, { latestRun, problemRuns, progressRun });

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(5,7,12,0.70)' }} onClick={onClose}>
      <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ maxHeight: '88vh', background: 'linear-gradient(150deg,rgba(18,24,33,0.99),rgba(26,30,40,0.99))', borderColor: 'rgba(148,163,184,0.24)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}>
        <style>{`
          @keyframes syncFlowR{to{stroke-dashoffset:-24}}
          @keyframes syncFlowL{to{stroke-dashoffset:24}}
          @keyframes syncBadgeSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}
          .sync-flow{fill:none;stroke-width:2.6;stroke-linecap:round;stroke-dasharray:9 15}
          .sync-topo.is-flowing .sync-flow.r{animation:syncFlowR 1s linear infinite}
          .sync-topo.is-flowing .sync-flow.l{animation:syncFlowL 1s linear infinite}
          .sync-topo.is-breathing .sync-flow.r{animation:syncFlowR 3.4s linear infinite}
          .sync-topo.is-breathing .sync-flow.l{animation:syncFlowL 3.4s linear infinite}
          .sync-badge.spin{animation:syncBadgeSpin 1s linear infinite}
          @media(prefers-reduced-motion:reduce){.sync-flow{animation:none!important}.sync-badge.spin{animation:none!important}}
        `}</style>

        {/* header：标题 + 关系语句（当前这个库和谁保持什么关系） */}
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border" style={{ background: 'rgba(20,184,166,0.10)', borderColor: 'rgba(45,212,191,0.28)' }}>
            {anyRunning ? <MapSpinner size={16} /> : <ArrowLeftRight size={16} style={{ color: 'rgb(94,234,212)' }} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-tight">同步</div>
            <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {relationSummary(direction, autoOn, nodeName)}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 transition hover-bg-soft" aria-label="关闭"><X size={17} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ overscrollBehavior: 'contain' }}>
          {loading ? <MapSectionLoader text="正在加载…" /> : (
            <>
              {/* 拓扑图：面板主视觉 */}
              <SyncTopology storeName={storeName} nodeName={nodeName} direction={direction} tone={tone} hasNode={nodes.length > 0} />

              {/* 多对端时的对端选择器（单对端不显示，保持一屏干净） */}
              {nodes.length > 1 && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>对端</span>
                  <select value={nodeId} onChange={e => setNodeId(e.target.value)}
                    className="prd-field h-7 rounded-lg px-2 text-xs outline-none" style={{ maxWidth: 220 }}>
                    <option value="">选择对端…</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
                  </select>
                </div>
              )}

              {/* 一句话状态 */}
              <div className="mt-4 text-center">
                <div className="inline-flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2 w-2 rounded-full" style={{ background: TONE_WIRE[tone].strong }} />
                  {status.big}
                </div>
                <div className="mt-1 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{status.sub}</div>
              </div>

              {/* 方向段控 */}
              <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl border p-1" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.34)' }}>
                {DIRECTION_OPTS.map(o => {
                  const active = direction === o.key;
                  return (
                    <button key={o.key} onClick={() => setDirection(o.key)} disabled={submitting}
                      className="flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 text-center transition disabled:opacity-50"
                      style={{
                        background: active ? 'rgba(20,184,166,0.14)' : 'transparent',
                        color: active ? 'rgb(94,234,212)' : 'var(--text-secondary)',
                        boxShadow: active ? 'inset 0 0 0 1px rgba(45,212,191,0.36)' : 'none',
                      }}>
                      <span className="text-[12.5px] font-semibold">{o.label}</span>
                      <span className="text-[10px]" style={{ color: active ? 'rgba(94,234,212,0.7)' : 'var(--text-muted)' }}>{o.seg}</span>
                    </button>
                  );
                })}
              </div>
              {autoDirectionNeedsConfirm && (
                <div className="mt-2 text-center text-[11px]" style={{ color: 'rgb(252,211,77)' }}>
                  最近只是接收了对端推送，选一个方向即可确认本库的同步方向。
                </div>
              )}

              {/* 主动作：立即同步 + 自动开关 */}
              <div className="mt-4 flex items-center gap-3">
                <Button
                  variant="primary"
                  onClick={runNow}
                  disabled={submitting || !direction || nodes.length === 0 || !nodeId}
                  className="h-11 flex-1 justify-center whitespace-nowrap text-sm"
                  title={!direction ? '先选择同步方式' : `按既定方向执行：${DIRECTION_VERB[direction]}`}
                >
                  {submitting ? <MapSpinner size={15} /> : tone === 'red' ? <RefreshCw size={15} /> : <Send size={15} />} {primaryLabel}
                </Button>
                {resourceType === 'document-store' && (
                  <div className="flex shrink-0 items-center gap-2.5">
                    <div className="hidden text-right sm:block">
                      <div className="text-[11.5px] font-semibold" style={{ color: 'var(--text-secondary)' }}>自动</div>
                      <div className="text-[10px]" style={{ color: relationDirty ? 'rgb(252,211,77)' : 'var(--text-muted)' }}>{peerDirty ? '新对端需先同步' : directionDirty ? '新方向需先同步' : !canAuto ? '同步一次后可开' : autoOn ? '保持同步' : '仅手动'}</div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={autoOn}
                      aria-label="自动保持同步"
                      onClick={() => applyAuto(!autoOn, autoInterval)}
                      disabled={autoBusy || (!autoOn && !canAuto)}
                      title={peerDirty ? '所选对端尚未同步，请先对新对端手动同步一次，再开自动' : directionDirty ? '所选方向尚未保存，请先按新方向手动同步一次，再开自动' : !canAuto ? '请先手动同步一次（确定对端与方向）' : autoOn ? '关闭自动同步' : '开启自动同步'}
                      className="relative h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-40"
                      style={{
                        background: autoOn ? 'rgba(20,184,166,0.30)' : 'rgba(148,163,184,0.14)',
                        borderColor: autoOn ? 'rgba(45,212,191,0.42)' : 'rgba(148,163,184,0.30)',
                      }}
                    >
                      <span className="absolute top-[2px] h-[18px] w-[18px] rounded-full transition-all"
                        style={{ left: autoOn ? 20 : 2, background: autoOn ? 'rgb(94,234,212)' : 'rgb(148,163,184)' }} />
                    </button>
                  </div>
                )}
              </div>

              {/* 自动触发方式（开启后才出现，保持默认态最简） */}
              {resourceType === 'document-store' && autoOn && (
                <div className="mt-3 rounded-xl border p-2.5" style={{ borderColor: 'rgba(148,163,184,0.14)', background: 'rgba(15,23,42,0.28)' }}>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" disabled={autoBusy} onClick={() => applyAuto(autoOn, autoInterval, 'trigger')}
                      className="rounded-lg border px-2.5 py-2 text-left transition"
                      style={{ borderColor: autoSendMode === 'trigger' ? 'rgba(45,212,191,0.36)' : 'rgba(148,163,184,0.16)', background: autoSendMode === 'trigger' ? 'rgba(20,184,166,0.08)' : 'transparent' }}>
                      <div className="text-[11.5px] font-semibold" style={{ color: autoSendMode === 'trigger' ? 'rgb(94,234,212)' : 'var(--text-secondary)' }}>内容变更时</div>
                      <div className="mt-0.5 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>改动后合并连续编辑再发一次</div>
                    </button>
                    <button type="button" disabled={autoBusy} onClick={() => applyAuto(autoOn, autoInterval, 'scheduled')}
                      className="rounded-lg border px-2.5 py-2 text-left transition"
                      style={{ borderColor: autoSendMode === 'scheduled' ? 'rgba(45,212,191,0.36)' : 'rgba(148,163,184,0.16)', background: autoSendMode === 'scheduled' ? 'rgba(20,184,166,0.08)' : 'transparent' }}>
                      <div className="text-[11.5px] font-semibold" style={{ color: autoSendMode === 'scheduled' ? 'rgb(94,234,212)' : 'var(--text-secondary)' }}>定时检查</div>
                      <div className="mt-0.5 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>按周期检查，无变化不访问对端</div>
                    </button>
                  </div>
                  {autoSendMode === 'scheduled' && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>周期</span>
                      <select value={autoInterval} onChange={e => applyAuto(autoOn, Number(e.target.value), 'scheduled')} disabled={autoBusy}
                        className="prd-field h-7 rounded-lg px-2 text-[11px] outline-none">
                        {AUTO_INTERVAL_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {/* 进度条（同步中）：可停止 */}
              {activeRuns.length > 0 && (
                <ProgressStrip run={progressRun} onCancel={handleCancelRun} />
              )}

              {nodes.length === 0 && (
                <div className="mt-3 flex items-center justify-center gap-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  <Globe size={13} /> 暂无已配对对端，请管理员到「设置 → 系统互联」配对节点。
                </div>
              )}
              {error && (
                <div className="mt-3 flex items-center justify-center gap-2 text-[11.5px]" style={{ color: 'rgb(252,165,165)' }}>
                  <AlertTriangle size={13} /> {error}
                </div>
              )}

              {/* 底部折叠入口：最近记录 / 高级对齐 */}
              <div className="mt-4 flex gap-2 border-t pt-4" style={{ borderColor: 'rgba(148,163,184,0.14)' }}>
                <button onClick={() => setShowRecords(v => !v)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] transition hover-bg-soft"
                  style={{ borderColor: showRecords ? 'rgba(45,212,191,0.30)' : 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.2)', color: showRecords ? 'rgb(94,234,212)' : 'var(--text-secondary)' }}>
                  <History size={13} /> 最近记录
                  {counts.all > 0 && <span className="rounded-full px-1.5 text-[10px]" style={{ background: 'rgba(148,163,184,0.16)', color: problemRuns.length > 0 ? 'rgb(252,165,165)' : 'var(--text-muted)' }}>{problemRuns.length > 0 ? `${problemRuns.length} 失败` : counts.all}</span>}
                  {showRecords ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <button onClick={() => setShowAdvanced(v => !v)} disabled={nodes.length === 0}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] transition hover-bg-soft disabled:opacity-50"
                  style={{ borderColor: showAdvanced ? 'rgba(45,212,191,0.30)' : 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.2)', color: showAdvanced ? 'rgb(94,234,212)' : 'var(--text-secondary)' }}>
                  <SlidersHorizontal size={13} /> 高级对齐
                  {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              </div>

              {/* 最近记录（折叠） */}
              {showRecords && (
                <section className="mt-3">
                  <div className="space-y-1.5">
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>接收审计只表示本节点收到了对端推送</div>
                    <div className="sync-row-scroll flex items-center gap-1">
                      {RECORD_FILTERS.map(t => (
                        <button key={t.key} onClick={() => setRecordFilter(t.key)}
                          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] transition"
                          style={{
                            color: recordFilter === t.key ? 'var(--text-primary)' : 'rgb(148,163,184)',
                            background: recordFilter === t.key ? 'rgba(45,212,191,0.12)' : 'transparent',
                            border: `1px solid ${recordFilter === t.key ? 'rgba(45,212,191,0.30)' : 'transparent'}`,
                          }}>
                          {t.label}<span className="rounded-full px-1 text-[9.5px]" style={{ background: 'rgba(148,163,184,0.16)' }}>{counts[t.key]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {filtered.length === 0 ? (
                    <div className="mt-2 flex flex-col items-center justify-center rounded-xl border py-8 text-center" style={{ borderColor: 'rgba(148,163,184,0.14)', color: 'var(--text-muted)' }}>
                      <Clock3 size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                      <div className="text-[13px]">暂无记录</div>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">{filtered.slice(0, 12).map(r => <RunCard key={r.id} run={r} forceExpanded={r.status === 'error'} />)}</div>
                  )}
                </section>
              )}

              {/* 高级对齐（折叠） */}
              {showAdvanced && (
                <section className="mt-3">
                  <div className="rounded-lg border px-3 py-2 text-[11px] leading-5" style={{ borderColor: 'rgba(45,212,191,0.18)', background: 'rgba(20,184,166,0.05)', color: 'var(--text-muted)' }}>
                    <span style={{ color: 'rgb(94,234,212)', fontWeight: 600 }}>默认策略，无需设置：</span>
                    保留原时间、覆盖同名条目、图片自动重传到目标域名，完成后回读校验。
                  </div>
                  <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
                    {ALIGN_OPTS.map(o => (
                      <button key={o.key} onClick={() => (o.danger ? setConfirmAlign(o.key) : runAlign(o.key))}
                        disabled={submitting || !nodeId}
                        className="rounded-xl border p-2.5 text-left transition disabled:opacity-50"
                        style={{ borderColor: 'rgba(148,163,184,0.20)', background: 'rgba(2,6,23,0.22)' }}>
                        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">{o.icon}{o.label}</div>
                        <div className="mt-1 text-[10.5px] leading-4" style={{ color: 'var(--text-muted)' }}>{o.desc}</div>
                        {o.danger
                          ? <div className="mt-1.5 rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'rgb(252,165,165)', background: 'rgba(127,29,29,0.18)', border: '1px solid rgba(248,113,113,0.34)' }}>会删除条目，需确认</div>
                          : <div className="mt-1.5 rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'rgb(94,234,212)', background: 'rgba(20,184,166,0.10)', border: '1px solid rgba(45,212,191,0.34)' }}>不删除，最安全</div>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
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

/**
 * 关系拓扑图：本库 ⇄ 对端，箭头方向即同步方向，连线颜色与流动即状态。
 * 一张图承载「方向 + 状态 + 对象」，替代大段文字表单。
 */
function SyncTopology({ storeName, nodeName, direction, tone, hasNode }: {
  storeName: string; nodeName: string; direction: ManualDirection | null; tone: SyncTone; hasNode: boolean;
}) {
  const w = TONE_WIRE[tone];
  const animClass = direction ? (w.anim === 'flowing' ? 'is-flowing' : w.anim === 'breathing' ? 'is-breathing' : '') : '';
  const linked = !!direction && hasNode;
  const discActiveStyle: React.CSSProperties = linked
    ? { borderColor: w.wire, background: w.bg, color: w.strong, boxShadow: `0 0 0 4px ${w.bg}` }
    : { borderColor: 'rgba(148,163,184,0.30)', background: 'rgba(15,23,42,0.5)', color: 'var(--text-secondary)' };

  return (
    <div className={`sync-topo ${animClass} grid items-center`} style={{ gridTemplateColumns: '1fr auto 1fr', gap: 6 }}>
      <TopoNode icon={<Library size={22} />} name={storeName} role="本库" style={discActiveStyle} />

      <div className="relative" style={{ width: 150, height: 78 }}>
        <svg viewBox="0 0 150 78" preserveAspectRatio="none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          {/* 底层导轨 */}
          <path d="M6 39 H144" fill="none" stroke={w.wire} strokeWidth={2.4} strokeLinecap="round" strokeDasharray="2 7" opacity={0.9} />
          {/* 流动层（按方向） */}
          {direction === 'push' && (<>
            <path className="sync-flow r" d="M6 39 H140" stroke={w.strong} />
            <path d="M141 39 L133 34.5 L133 43.5 Z" fill={w.strong} />
          </>)}
          {direction === 'pull' && (<>
            <path className="sync-flow l" d="M10 39 H144" stroke={w.strong} />
            <path d="M9 39 L17 34.5 L17 43.5 Z" fill={w.strong} />
          </>)}
          {direction === 'both' && (<>
            <path className="sync-flow r" d="M6 30 H140" stroke={w.strong} />
            <path d="M141 30 L133 25.5 L133 34.5 Z" fill={w.strong} />
            <path className="sync-flow l" d="M10 48 H144" stroke={w.strong} />
            <path d="M9 48 L17 43.5 L17 52.5 Z" fill={w.strong} />
          </>)}
        </svg>
        {/* 中央状态徽记 */}
        {direction && (
          <div
            className={`sync-badge absolute flex items-center justify-center rounded-full ${tone === 'gold' ? 'spin' : ''}`}
            style={{ top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 26, height: 26, background: 'rgb(18,24,33)', border: `1.5px solid ${w.wire}`, color: w.strong }}
          >
            {tone === 'gold' ? <RefreshCw size={13} /> : tone === 'red' ? <AlertTriangle size={13} /> : tone === 'teal' ? <CheckCircle2 size={13} /> : <span className="h-2 w-2 rounded-full" style={{ background: w.strong }} />}
          </div>
        )}
      </div>

      <TopoNode icon={<Globe size={22} />} name={hasNode ? nodeName : '未配对'} role="对端" style={discActiveStyle} muted={!hasNode} />
    </div>
  );
}

function TopoNode({ icon, name, role, style, muted }: { icon: ReactNode; name: string; role: string; style: React.CSSProperties; muted?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <div className="flex h-[62px] w-[62px] items-center justify-center rounded-[18px] border transition-all"
        style={muted ? { borderColor: 'rgba(148,163,184,0.24)', background: 'rgba(15,23,42,0.4)', color: 'var(--text-muted)' } : style}>
        {icon}
      </div>
      <div className="max-w-[130px] truncate text-[12.5px] font-semibold" title={name}>{name}</div>
      <div className="text-[10.5px]" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>{role}</div>
    </div>
  );
}

/** 同步中的进度条：逐文章推进，取带进度的活动 run。可停止。 */
function ProgressStrip({ run, onCancel }: { run: PeerSyncRun | null; onCancel?: (run: PeerSyncRun) => void }) {
  const total = Math.max(0, run?.progressTotal ?? 0);
  const current = total > 0 ? Math.min(Math.max(0, run?.progressCurrent ?? 0), total) : 0;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const cancelling = !!run?.cancelRequested;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span className="min-w-0 truncate">
          {cancelling ? '正在停止…' : run?.progressPhase || '同步中'}
          {run?.currentRecordTitle && <span className="ml-1" style={{ color: 'var(--text-primary)' }}>《{run.currentRecordTitle}》</span>}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {total > 0 && <span className="tabular-nums">{current}/{total}</span>}
          {run && onCancel && (
            <button
              onClick={() => !cancelling && onCancel(run)}
              disabled={cancelling}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold transition disabled:opacity-50"
              style={{ color: 'rgb(252,165,165)', background: 'rgba(127,29,29,0.16)', border: '1px solid rgba(248,113,113,0.34)' }}
              title="停止这次同步"
            >
              <Square size={10} /> {cancelling ? '停止中' : '停止'}
            </button>
          )}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.16)' }}>
        <div className="h-full rounded-full transition-all duration-300"
          style={{ width: `${total > 0 ? percent : 18}%`, background: 'linear-gradient(90deg, rgba(45,212,191,0.9), rgba(129,140,248,0.95))' }} />
      </div>
    </div>
  );
}

export function RunCard({ run, forceExpanded = false, onCancel }: { run: PeerSyncRun; forceExpanded?: boolean; onCancel?: (run: PeerSyncRun) => void }) {
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
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover-bg-soft"
              aria-label={expanded ? '收起同步详情' : '展开同步详情'}
              title={expanded ? '收起详情' : '查看失败原因和同步进度'}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          <span className="text-sm font-semibold truncate">{run.itemName || run.itemId}</span>
          <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]" style={{ color: incoming ? 'rgb(147,180,255)' : 'rgb(94,234,212)', background: incoming ? 'rgba(59,130,246,0.12)' : 'rgba(20,184,166,0.12)', border: `1px solid ${incoming ? 'rgba(59,130,246,0.3)' : 'rgba(45,212,191,0.34)'}` }}>{dirLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active && onCancel && (
            <button
              onClick={() => !run.cancelRequested && onCancel(run)}
              disabled={!!run.cancelRequested}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-semibold transition disabled:opacity-50"
              style={{ color: 'rgb(252,165,165)', background: 'rgba(127,29,29,0.16)', border: '1px solid rgba(248,113,113,0.34)' }}
              title="停止这次同步"
            >
              <Square size={10} /> {run.cancelRequested ? '停止中' : '停止'}
            </button>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]" style={{ color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>
            {active ? <MapSpinner size={11} /> : st.icon}{st.label}
          </span>
        </div>
      </div>
      <div className="sync-row-scroll mt-2 flex gap-x-3 whitespace-nowrap text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {run.created > 0 && <span style={{ color: 'rgb(134,239,172)' }}>新增 {run.created}</span>}
        {run.updated > 0 && <span style={{ color: 'rgb(94,234,212)' }}>更新 {run.updated}</span>}
        {run.skipped > 0 && <span>已一致 {run.skipped}</span>}
        {run.deleted > 0 && <span style={{ color: 'rgb(252,165,165)' }}>删除 {run.deleted}</span>}
        {run.failed > 0 && <span style={{ color: 'rgb(252,165,165)' }}>失败 {run.failed}</span>}
        {(run.assetsRewritten > 0 || run.assetRewriteFailed > 0) && <span>图片重传 {run.assetsRewritten}/失败 {run.assetRewriteFailed}</span>}
      </div>
      <div className="sync-row-scroll mt-1.5 flex gap-x-3 whitespace-nowrap text-[10.5px]" style={{ color: 'var(--text-faint, rgba(148,163,184,0.7))' }}>
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
export function isRunActive(r: PeerSyncRun): boolean {
  return r.status === 'syncing' && Date.now() - new Date(r.startedAt).getTime() < RUN_FRESH_MS;
}

/** 一行状态文案（拓扑图下方）：big 一句话 + sub 一句补充。 */
export function statusLine(
  tone: SyncTone,
  ctx: { latestRun: PeerSyncRun | null; problemRuns: PeerSyncRun[]; progressRun: PeerSyncRun | null },
): { big: string; sub: string } {
  if (tone === 'red') {
    const first = ctx.problemRuns[0];
    return {
      big: `${ctx.problemRuns.length} 项需要处理`,
      sub: first?.message ? first.message : '展开「最近记录」查看失败原因，处理后可重试。',
    };
  }
  if (tone === 'gold') {
    const r = ctx.progressRun;
    const total = Math.max(0, r?.progressTotal ?? 0);
    const current = total > 0 ? Math.min(Math.max(0, r?.progressCurrent ?? 0), total) : 0;
    return {
      big: '正在同步',
      sub: total > 0 ? `${current} / ${total} · 关闭面板不影响后台同步` : '关闭面板不影响后台同步',
    };
  }
  if (tone === 'teal') {
    return {
      big: '两边一致',
      sub: ctx.latestRun ? `最近 ${formatTime(ctx.latestRun.startedAt)} · ${statusText(ctx.latestRun)}` : '还没有同步记录',
    };
  }
  return { big: '还没建立同步关系', sub: '选一个方向，开始第一次同步' };
}

/**
 * 由服务端最近一次同步方向推导「关系方向」初值：
 * push/pull/both 原样沿用；强制对齐视为已确认过双向；received（只被推送过）或无记录 = 还没确认，返回 null 等用户选。
 */
export function initialManualDirection(direction: string | null | undefined): ManualDirection | null {
  if (direction === 'push' || direction === 'pull' || direction === 'both') return direction;
  if (direction === 'align-remote' || direction === 'align-local' || direction === 'align-both') return 'both';
  return null;
}

/** 关系语句：header 一句话说清「这个库和谁保持什么关系」。 */
export function relationSummary(direction: ManualDirection | null, autoOn: boolean, nodeName: string): string {
  if (!direction) return `与「${nodeName}」还没有建立同步关系`;
  const map: Record<ManualDirection, string> = {
    push: `把本库发送到「${nodeName}」`,
    pull: `从「${nodeName}」拉回本库`,
    both: `与「${nodeName}」双向保持一致`,
  };
  return `${map[direction]} · ${autoOn ? '自动' : '手动'}`;
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
  // 已取消：用户主动中止，中性灰（区别于失败的红），禁行图标。
  if (s === 'cancelled') return { label: '已取消', color: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.28)', icon: <Ban size={12} /> };
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
  // 用户主动取消（cancelled）不是失败：ok=false 但历史落 cancelled，不能报成 error（Codex P2）。
  // 只挑「真失败」项；若失败项全是取消，返回 null，调用方走正常收尾（刷新历史，历史里显示已取消）。
  const failed = data.results?.find(r => !r.ok && !r.cancelled);
  if (!failed) return null;
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
  if (run.status === 'cancelled') return '已取消';
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
