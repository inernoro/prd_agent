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
  Image,
  ListChecks,
  RotateCcw,
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
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ step: number; stage: string; startedAt: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!submitting) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [submitting]);

  const safeClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

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
    setError(null);
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
      setError(nodesRes.error?.message || '加载对端节点失败');
    }
    if (itemsRes.success && itemsRes.data) {
      setItems(itemsRes.data.items || []);
    } else {
      setError((prev) => prev || itemsRes.error?.message || '加载可同步条目失败');
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
  const modeLabel = allowOverwrite ? '允许覆盖' : '仅新增';

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
    setError(null);
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
    setSubmitting(false);
    setProgress(null);
    if (res.success && res.data) {
      const nextResults = res.data.results || [];
      setResults(nextResults);
      if (nextResults.some((r) => r.ok)) onDone?.();
    } else {
      setError(res.error?.message || '互传失败');
    }
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
                左侧设置同步策略，右侧选择知识库并预览传输过程
              </div>
            </div>
          </div>
          <button
            onClick={safeClose}
            disabled={submitting}
            className="rounded-lg p-2 transition hover:bg-white/10 disabled:opacity-40"
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
                  <div className="grid grid-cols-1 gap-2">
                    {availableDirections.map((d) => (
                      <ChoiceCard key={d.key} active={direction === d.key} icon={d.icon} onClick={() => setDirection(d.key)}>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold">{d.label}</div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{d.hint}</div>
                        </div>
                      </ChoiceCard>
                    ))}
                  </div>

                  <SectionTitle label="同步策略" />
                  <div className="grid gap-2">
                    <ToggleRow
                      icon={<Clock3 size={16} />}
                      title="保存原时间"
                      desc="保留源知识库的创建与更新时间"
                      checked={preserveTimestamps}
                      onChange={setPreserveTimestamps}
                    />
                    <ToggleRow
                      icon={<RotateCcw size={16} />}
                      title="允许覆盖"
                      desc="修复历史同步造成的脏数据"
                      checked={allowOverwrite}
                      onChange={setAllowOverwrite}
                    />
                    <ToggleRow
                      icon={<Image size={16} />}
                      title="图片重传"
                      desc="使用目标平台自己的图片域名"
                      checked={rewriteAssetLinks}
                      onChange={setRewriteAssetLinks}
                    />
                  </div>
                </div>

                <div className="mt-5 rounded-xl border p-3 text-xs leading-5" style={{ borderColor: 'rgba(245,158,11,0.32)', background: 'rgba(245,158,11,0.10)', color: 'rgb(252,211,77)' }}>
                  本次建议：保留原时间、允许覆盖、图片重传。任一条目失败不会写入成功同步标识。
                </div>
              </>
            )}
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="border-b px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold">选择与传输预览</div>
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    已选 {selected.size} 个知识库，模式为 {modeLabel}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <StatusPill icon={<ShieldCheck size={13} />} text={preserveTimestamps ? '保留原时间' : '使用同步时间'} tone={preserveTimestamps ? 'teal' : 'slate'} />
                  <StatusPill icon={<RotateCcw size={13} />} text={modeLabel} tone={allowOverwrite ? 'gold' : 'slate'} />
                  <StatusPill icon={<Image size={13} />} text={rewriteAssetLinks ? '图片重传' : '跳过图片'} tone={rewriteAssetLinks ? 'teal' : 'slate'} />
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6" style={{ overscrollBehavior: 'contain' }}>
              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: 'rgba(248,113,113,0.28)', background: 'rgba(127,29,29,0.16)', color: 'rgb(252,165,165)' }}>
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {loading ? (
                <MapSectionLoader text="正在加载…" />
              ) : (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <section className="min-w-0 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      {items.map((it) => (
                        <button
                          key={it.itemId}
                          onClick={() => toggleItem(it.itemId)}
                          className="group min-h-[118px] rounded-2xl border p-4 text-left transition"
                          style={{
                            borderColor: selected.has(it.itemId) ? 'rgba(45,212,191,0.56)' : 'rgba(148,163,184,0.18)',
                            background: selected.has(it.itemId)
                              ? 'linear-gradient(135deg, rgba(20,184,166,0.14), rgba(59,130,246,0.10))'
                              : 'rgba(15,23,42,0.42)',
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border" style={{ borderColor: 'rgba(148,163,184,0.20)', background: 'rgba(15,23,42,0.55)' }}>
                              {selected.has(it.itemId) ? <Check size={17} style={{ color: 'rgb(45,212,191)' }} /> : <FolderOpen size={17} style={{ color: 'rgb(148,163,184)' }} />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="line-clamp-2 text-sm font-semibold">{it.name}</div>
                              <div className="mt-2 flex flex-wrap gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                <span>{it.recordCount} 项内容</span>
                                {it.updatedAt && <span>最近更新 {formatShortTime(it.updatedAt)}</span>}
                              </div>
                            </div>
                          </div>
                          {it.description && (
                            <div className="mt-3 line-clamp-2 text-xs" style={{ color: 'var(--text-muted)' }}>{it.description}</div>
                          )}
                        </button>
                      ))}
                    </div>

                    {items.length === 0 && (
                      <EmptyBlock icon={<Database size={20} />} title="没有可同步的知识库" desc="当前账号没有可发送的个人或团队知识库" />
                    )}
                  </section>

                  <aside className="space-y-4">
                    <TransferPreview
                      node={activeNode}
                      direction={direction}
                      selectedCount={selected.size}
                      submitting={submitting}
                      progress={progress}
                      results={results}
                      error={error}
                    />

                    <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(148,163,184,0.18)', background: 'rgba(15,23,42,0.42)' }}>
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                        <ListChecks size={16} />
                        验收步骤
                      </div>
                      <div className="space-y-2">
                        {STEPS.map((s, index) => {
                          const active = submitting && progress && progress.step === index + 1;
                          const done = Boolean(results) || Boolean(progress && progress.step > index + 1);
                          return (
                            <div key={s.title} className="flex gap-3 rounded-xl border px-3 py-2" style={{
                              borderColor: active ? 'rgba(45,212,191,0.46)' : 'rgba(148,163,184,0.14)',
                              background: active ? 'rgba(20,184,166,0.10)' : 'rgba(15,23,42,0.34)',
                            }}>
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold" style={{
                                background: done ? 'rgba(34,197,94,0.20)' : active ? 'rgba(45,212,191,0.22)' : 'rgba(148,163,184,0.12)',
                                color: done ? 'rgb(134,239,172)' : active ? 'rgb(94,234,212)' : 'rgb(148,163,184)',
                              }}>
                                {index + 1}
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold">{s.title}</div>
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{s.desc}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {results && (
                      <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(148,163,184,0.18)', background: 'rgba(15,23,42,0.42)' }}>
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                          <CheckCircle2 size={16} />
                          互传结果
                        </div>
                        <div className="space-y-2">
                          {results.map((r) => {
                            const name = items.find((i) => i.itemId === r.itemId)?.name || r.itemId;
                            return (
                              <div key={r.itemId} className="rounded-xl border px-3 py-2 text-xs" style={{
                                borderColor: r.ok ? 'rgba(34,197,94,0.26)' : 'rgba(248,113,113,0.30)',
                                background: r.ok ? 'rgba(22,101,52,0.12)' : 'rgba(127,29,29,0.14)',
                              }}>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate font-semibold">{name}</span>
                                  <span style={{ color: r.ok ? 'rgb(134,239,172)' : 'rgb(252,165,165)' }}>{r.ok ? '成功' : '失败'}</span>
                                </div>
                                {r.message && <div className="mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>{r.message}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </aside>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: 'rgba(148,163,184,0.12)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {submitting && progress ? `${progress.stage}，已用 ${Math.round((Date.now() - progress.startedAt) / 1000)} 秒` : '同步完成后会刷新知识库列表和跨系统同步标识'}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={safeClose} disabled={submitting}>取消</Button>
                <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
                  {submitting ? <MapSpinner size={14} /> : <Send size={14} />}
                  {direction === 'pull' ? '开始拉取' : direction === 'both' ? '开始双向同步' : '开始发送'}
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

function ToggleRow({ icon, title, desc, checked, onChange }: {
  icon: ReactNode;
  title: string;
  desc: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition"
      style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.42)' }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: 'rgba(59,130,246,0.12)', color: 'rgb(147,197,253)' }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{desc}</div>
      </div>
      <span className="relative h-6 w-11 rounded-full border transition" style={{
        borderColor: checked ? 'rgba(45,212,191,0.56)' : 'rgba(148,163,184,0.22)',
        background: checked ? 'rgba(20,184,166,0.28)' : 'rgba(15,23,42,0.70)',
      }}>
        <span className="absolute top-1 h-4 w-4 rounded-full transition" style={{
          left: checked ? 22 : 4,
          background: checked ? 'rgb(94,234,212)' : 'rgb(148,163,184)',
        }} />
      </span>
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

function TransferPreview({ node, direction, selectedCount, submitting, progress, results, error }: {
  node: PeerNode | null;
  direction: PeerTransferDirection;
  selectedCount: number;
  submitting: boolean;
  progress: { step: number; stage: string; startedAt: number } | null;
  results: TransferItemResult[] | null;
  error: string | null;
}) {
  const directionText = direction === 'push' ? '发送' : direction === 'pull' ? '拉取' : '双向';
  const activeStep = progress?.step ?? 0;
  const successCount = results?.filter((r) => r.ok).length ?? 0;
  const failedCount = results?.filter((r) => !r.ok).length ?? 0;
  const status = getTransferStatus({ submitting, results, error, selectedCount });
  const statusTone = transferStatusTone(status);
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(148,163,184,0.18)', background: 'rgba(15,23,42,0.42)' }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Activity size={16} />
          传输状态
        </div>
        <StatusPill
          text={transferStatusLabel(status)}
          icon={submitting ? <MapSpinner size={12} /> : status === 'success' ? <CheckCircle2 size={13} /> : status === 'failed' || status === 'partial' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
          tone={statusTone}
        />
      </div>

      <div className="mb-3 rounded-2xl border px-4 py-3" style={{
        borderColor: statusBorder(statusTone),
        background: statusBackground(statusTone),
      }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: statusColor(statusTone) }}>{transferStatusLabel(status)}</div>
            <div className="mt-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              {transferStatusDesc(status, { selectedCount, successCount, failedCount, error })}
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 text-center">
            <MiniStat label="已选" value={selectedCount} />
            <MiniStat label="成功" value={successCount} tone="green" />
            <MiniStat label="失败" value={failedCount} tone={failedCount > 0 ? 'red' : 'slate'} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(15,23,42,0.54)' }}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <TransferNode
            label="本地"
            title={`${selectedCount} 个知识库`}
            desc="读取内容与附件"
            icon={<Database size={16} />}
            active={submitting && activeStep <= 2}
          />

          <div className="flex min-w-[88px] flex-col items-center gap-2">
            <div className="relative h-px w-full overflow-hidden rounded-full" style={{ background: 'rgba(148,163,184,0.24)' }}>
              <div
                className="peer-flow-beam absolute top-0 h-px w-9 rounded-full"
                style={{
                  left: 0,
                  background: 'linear-gradient(90deg, transparent, rgb(94,234,212), transparent)',
                  animationPlayState: submitting ? 'running' : 'paused',
                }}
              />
            </div>
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{
              borderColor: direction === 'both' ? 'rgba(45,212,191,0.34)' : 'rgba(148,163,184,0.18)',
              color: direction === 'both' ? 'rgb(94,234,212)' : 'rgb(203,213,225)',
              background: direction === 'both' ? 'rgba(20,184,166,0.10)' : 'rgba(148,163,184,0.08)',
            }}>
              {directionText}
            </span>
          </div>

          <TransferNode
            label="对端"
            title={node?.displayName || '等待选择'}
            desc={node?.baseUrl || '选择目标节点'}
            icon={<Globe size={16} />}
            active={submitting && activeStep >= 2}
          />
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2">
          {STEPS.map((s, index) => {
            const state = resultsState(index + 1, activeStep, submitting, results, failedCount, error);
            return (
              <div
                key={s.title}
                className="rounded-xl border px-2.5 py-2"
                style={{
                  borderColor: state === 'active' ? 'rgba(45,212,191,0.46)' : state === 'done' ? 'rgba(34,197,94,0.28)' : state === 'failed' ? 'rgba(248,113,113,0.34)' : 'rgba(148,163,184,0.14)',
                  background: state === 'active' ? 'rgba(20,184,166,0.10)' : state === 'done' ? 'rgba(22,101,52,0.10)' : state === 'failed' ? 'rgba(127,29,29,0.14)' : 'rgba(15,23,42,0.34)',
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span className={state === 'active' ? 'peer-flow-pulse' : ''} style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: state === 'active' ? 'rgb(94,234,212)' : state === 'done' ? 'rgb(134,239,172)' : state === 'failed' ? 'rgb(252,165,165)' : 'rgb(100,116,139)',
                    display: 'inline-block',
                    flexShrink: 0,
                  }} />
                  <span className="truncate text-[11px] font-semibold">{s.title}</span>
                </div>
                <div className="mt-1 truncate text-[10px]" style={{ color: state === 'failed' ? 'rgb(252,165,165)' : 'var(--text-muted)' }}>
                  {state === 'done' ? '已完成' : state === 'active' ? '进行中' : state === 'failed' ? '未成功' : s.desc}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-3 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        {progress ? progress.stage : '开始后会按顺序执行扫描、图片重传、合并、回读四步。'}
      </div>
    </div>
  );
}

type TransferStatus = 'idle' | 'ready' | 'running' | 'success' | 'partial' | 'failed';

function getTransferStatus({ submitting, results, error, selectedCount }: {
  submitting: boolean;
  results: TransferItemResult[] | null;
  error: string | null;
  selectedCount: number;
}): TransferStatus {
  if (submitting) return 'running';
  if (error) return 'failed';
  if (results && results.length > 0) return results.some((r) => !r.ok) ? 'partial' : 'success';
  if (selectedCount > 0) return 'ready';
  return 'idle';
}

function transferStatusLabel(status: TransferStatus) {
  switch (status) {
    case 'success': return '同步成功';
    case 'partial': return '部分失败';
    case 'failed': return '同步失败';
    case 'running': return '同步中';
    case 'ready': return '可开始';
    default: return '待选择';
  }
}

function transferStatusDesc(status: TransferStatus, args: {
  selectedCount: number;
  successCount: number;
  failedCount: number;
  error: string | null;
}) {
  switch (status) {
    case 'success': return `${args.successCount} 个知识库已完成跨系统同步，列表和状态标识会刷新。`;
    case 'partial': return `${args.successCount} 个成功，${args.failedCount} 个失败。失败条目不会写入成功同步标识。`;
    case 'failed': return args.error || '本次传输未成功，不会写入成功同步标识。';
    case 'running': return `正在处理 ${args.selectedCount} 个知识库，请保持面板打开。`;
    case 'ready': return `已选择 ${args.selectedCount} 个知识库，点击开始后会显示每一步结果。`;
    default: return '先选择一个或多个知识库。';
  }
}

function transferStatusTone(status: TransferStatus): StatusTone {
  if (status === 'success') return 'teal';
  if (status === 'partial' || status === 'running') return 'gold';
  if (status === 'failed') return 'red';
  return 'slate';
}

function MiniStat({ label, value, tone = 'slate' }: { label: string; value: number; tone?: 'green' | 'red' | 'slate' }) {
  const color = tone === 'green' ? 'rgb(134,239,172)' : tone === 'red' ? 'rgb(252,165,165)' : 'rgb(203,213,225)';
  return (
    <div className="min-w-[42px] rounded-lg border px-2 py-1" style={{ borderColor: 'rgba(148,163,184,0.14)', background: 'rgba(15,23,42,0.40)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}

function TransferNode({ label, title, desc, icon, active }: {
  label: string;
  title: string;
  desc: string;
  icon: ReactNode;
  active: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border px-3 py-3" style={{
      borderColor: active ? 'rgba(45,212,191,0.36)' : 'rgba(148,163,184,0.16)',
      background: active ? 'rgba(20,184,166,0.10)' : 'rgba(2,6,23,0.28)',
    }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border" style={{
          borderColor: active ? 'rgba(45,212,191,0.34)' : 'rgba(148,163,184,0.16)',
          color: active ? 'rgb(94,234,212)' : 'rgb(148,163,184)',
          background: active ? 'rgba(20,184,166,0.12)' : 'rgba(15,23,42,0.40)',
        }}>
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.10em]" style={{ color: 'rgb(148,163,184)' }}>{label}</span>
      </div>
      <div className="truncate text-xs font-semibold">{title}</div>
      <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{desc}</div>
    </div>
  );
}

function resultsState(step: number, activeStep: number, submitting: boolean, results: TransferItemResult[] | null, failedCount: number, error: string | null) {
  if (error) return step === 1 ? 'failed' : 'idle';
  if (results && results.length > 0) return failedCount > 0 && step === STEPS.length ? 'failed' : 'done';
  if (!submitting) return 'idle';
  if (step < activeStep) return 'done';
  if (step === activeStep) return 'active';
  return 'idle';
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
