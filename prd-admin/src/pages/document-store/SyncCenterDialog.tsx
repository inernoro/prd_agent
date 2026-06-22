/**
 * 同步中心（MAP 知识库传输协议 · 前端）。
 *
 * 点知识库右上角「同步」进入。四视图：进行中 / 发出去(push) / 收进来(pull) / 历史，
 * 外加「强制对齐」三选项（远端为准 / 本地为准 / 同时对准）。打开时轮询 runs，让进行中「动起来」。
 * 遵守 frontend-modal：createPortal 到 body、inline 高度、min-h:0 滚动、ESC + 蒙版关闭。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, AlertTriangle, CheckCircle2, Clock3,
  Globe, RefreshCw, Scale, Send, X, Repeat,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listPeerNodes, listPeerSyncRuns, transferToPeer, setAutoSync,
  type PeerNode, type PeerSyncRun, type PeerAlign,
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

type TabKey = 'running' | 'out' | 'in' | 'history';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'running', label: '进行中' },
  { key: 'out', label: '发出去' },
  { key: 'in', label: '收进来' },
  { key: 'history', label: '历史' },
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
  const [tab, setTab] = useState<TabKey>('running');
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

  const filtered = useMemo(() => {
    if (tab === 'running') return runs.filter(isRunActive);
    if (tab === 'out') return runs.filter(r => r.origin === 'outgoing');
    if (tab === 'in') return runs.filter(r => r.origin === 'incoming');
    return runs;
  }, [runs, tab]);

  const counts = useMemo(() => ({
    running: runs.filter(isRunActive).length,
    out: runs.filter(r => r.origin === 'outgoing').length,
    in: runs.filter(r => r.origin === 'incoming').length,
    history: runs.length,
  }), [runs]);

  const activeNode = nodes.find(n => n.id === nodeId) || null;

  const runAlign = async (align: PeerAlign) => {
    if (!nodeId) { setError('请先选择对端节点'); return; }
    setSubmitting(true);
    setError(null);
    setConfirmAlign(null);
    const res = await transferToPeer({ nodeId, resourceType, itemIds: [storeId], align });
    if (!mounted.current) return;
    setSubmitting(false);
    if (res.success) {
      setTab('history');
      await loadRuns();
      onAfterSync?.();
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

        <div className="flex min-h-0 flex-col" style={{ height: 'min(680px, calc(88vh - 65px))' }}>
          {/* 后台自动同步：开启后由服务端定期复用最近一次同步的对端 + 方向，自动保持两端一致（非破坏性，绝不删条目） */}
          {resourceType === 'document-store' && (
            <div className="border-b px-6 py-3" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <Repeat size={15} style={{ color: autoOn ? 'rgb(94,234,212)' : 'var(--text-muted)' }} />
                  <span className="text-sm font-semibold">后台自动同步</span>
                  <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {autoOn
                      ? `已开启 · 自动${peerNodeName ? ` 与「${peerNodeName}」` : ''}保持一致`
                      : everSynced ? '关闭中 · 仅手动同步' : '需先手动同步一次后才能开启'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {autoOn && (
                    <select
                      value={autoInterval}
                      onChange={e => applyAuto(true, Number(e.target.value))}
                      disabled={autoBusy}
                      className="prd-field h-8 rounded-lg px-2 text-xs outline-none"
                      style={{ maxWidth: 140 }}
                    >
                      {AUTO_INTERVAL_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                  )}
                  <Button
                    size="sm"
                    variant={autoOn ? 'primary' : 'secondary'}
                    onClick={() => applyAuto(!autoOn, autoInterval)}
                    disabled={autoBusy || (!autoOn && !everSynced)}
                    title={!everSynced ? '请先手动同步一次（确定对端与方向）' : autoOn ? '关闭后台自动同步' : '开启后台自动同步'}
                  >
                    {autoBusy ? <MapSpinner size={13} /> : <Repeat size={13} />}
                    {autoOn ? '已开启' : '开启自动'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 强制对齐 */}
          <div className="border-b px-6 py-3" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Scale size={15} style={{ color: 'rgb(252,211,77)' }} />
                <span className="text-sm font-semibold">手动同步 · 强制对齐</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>两边数量对不上时一次拉齐</span>
              </div>
              <div className="flex items-center gap-2">
                {nodes.length > 1 && (
                  <select value={nodeId} onChange={e => setNodeId(e.target.value)}
                    className="prd-field h-8 rounded-lg px-2 text-xs outline-none" style={{ maxWidth: 200 }}>
                    <option value="">选择对端…</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.displayName}</option>)}
                  </select>
                )}
                <Button size="sm" variant={showAlign ? 'primary' : 'secondary'} onClick={() => setShowAlign(v => !v)} disabled={nodes.length === 0}>
                  <Scale size={13} /> 强制对齐 {showAlign ? '▴' : '▾'}
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
                    style={{ borderColor: 'rgba(148,163,184,0.20)', background: 'rgba(15,23,42,0.40)' }}>
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
          </div>

          {/* tabs */}
          <div className="flex items-center gap-1 px-6 pt-3">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className="flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs transition"
                style={{
                  color: tab === t.key ? 'var(--text-primary)' : 'rgb(148,163,184)',
                  background: tab === t.key ? 'rgba(15,23,42,0.5)' : 'transparent',
                  borderBottom: tab === t.key ? '2px solid rgba(45,212,191,0.6)' : '2px solid transparent',
                }}>
                {t.label}
                <span className="rounded-full px-1.5 text-[10px]" style={{ background: 'rgba(148,163,184,0.16)' }}>{counts[t.key]}</span>
              </button>
            ))}
            <span className="flex-1" />
            <button onClick={() => loadRuns()} className="rounded-lg p-1.5 hover:bg-white/10" title="刷新"><RefreshCw size={13} /></button>
          </div>

          {/* run list */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3" style={{ overscrollBehavior: 'contain' }}>
            {loading ? <MapSectionLoader text="正在加载…" /> : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <ArrowLeftRight size={28} style={{ color: 'var(--text-muted)', opacity: 0.4, marginBottom: 10 }} />
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {tab === 'running' ? '当前没有进行中的同步' : tab === 'in' ? '还没有收到对端推来的同步' : '暂无记录'}
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">{filtered.map(r => <RunCard key={r.id} run={r} />)}</div>
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

function RunCard({ run }: { run: PeerSyncRun }) {
  const incoming = run.origin === 'incoming';
  const dirLabel = directionLabel(run.direction);
  // 崩溃残留的陈旧 syncing 行（超 30min）不再显示为「进行中」金色脉冲，按 stale 中性态展示（Bugbot）。
  const active = isRunActive(run);
  const stale = run.status === 'syncing' && !active;
  const st = statusMeta(stale ? 'stale' : run.status);
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: active ? 'rgba(245,158,11,0.34)' : 'rgba(148,163,184,0.16)', background: active ? 'rgba(245,158,11,0.10)' : 'rgba(15,23,42,0.34)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
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
        {run.skipped > 0 && <span>跳过 {run.skipped}</span>}
        {run.deleted > 0 && <span style={{ color: 'rgb(252,165,165)' }}>删除 {run.deleted}</span>}
        {run.failed > 0 && <span style={{ color: 'rgb(252,165,165)' }}>失败 {run.failed}</span>}
        {(run.assetsRewritten > 0 || run.assetRewriteFailed > 0) && <span>图片重传 {run.assetsRewritten}/失败 {run.assetRewriteFailed}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px]" style={{ color: 'var(--text-faint, rgba(148,163,184,0.7))' }}>
        <span>{incoming ? '来自' : '对端'} {run.peerNodeName}</span>
        <span>{formatTime(run.startedAt)}</span>
        {run.durationMs > 0 && <span>耗时 {(run.durationMs / 1000).toFixed(1)}s</span>}
        {run.triggeredByName && <span>{run.triggeredByName}</span>}
      </div>
    </div>
  );
}

// 「进行中」判定：syncing 且开始于近 30 分钟内（与详情页 + 后端租约 TTL 同口径）。
// 崩溃残留的陈旧 syncing 台账超过此窗口即视为非活动，不再让 UI 永久脉冲。
const RUN_FRESH_MS = 30 * 60 * 1000;
function isRunActive(r: PeerSyncRun): boolean {
  return r.status === 'syncing' && Date.now() - new Date(r.startedAt).getTime() < RUN_FRESH_MS;
}

function directionLabel(d: string): string {
  // 纯文本，不带任何符号字形（遵守 CLAUDE.md §0 禁止 emoji；方向语义由文案表达，视觉强调走底色）。
  switch (d) {
    case 'push': return '发送';
    case 'pull': return '拉取';
    case 'both': return '双向';
    case 'received': return '收到';
    case 'align-remote': return '远端为准';
    case 'align-local': return '本地为准';
    case 'align-both': return '同时对准';
    default: return d;
  }
}

function statusMeta(s: string): { label: string; color: string; bg: string; border: string; icon: ReactNode } {
  if (s === 'synced') return { label: '完成', color: 'rgb(134,239,172)', bg: 'rgba(22,101,52,0.18)', border: 'rgba(34,197,94,0.3)', icon: <CheckCircle2 size={12} /> };
  if (s === 'skipped') return { label: '无变化', color: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.28)', icon: <CheckCircle2 size={12} /> };
  if (s === 'error') return { label: '失败', color: 'rgb(252,165,165)', bg: 'rgba(127,29,29,0.18)', border: 'rgba(248,113,113,0.34)', icon: <AlertTriangle size={12} /> };
  // 陈旧：标记 syncing 但超 30min 未收尾（多为进程中断），按中性「未完成」展示，不再金色脉冲。
  if (s === 'stale') return { label: '未完成', color: 'rgb(148,163,184)', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.28)', icon: <AlertTriangle size={12} /> };
  return { label: '进行中', color: 'rgb(252,211,77)', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.34)', icon: <Clock3 size={12} /> };
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
