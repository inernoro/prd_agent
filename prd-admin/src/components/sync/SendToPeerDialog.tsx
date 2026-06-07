/**
 * 「发送到对端节点」通用弹窗 —— 系统级跨节点互传的用户入口。
 *
 * 任意应用都可复用：传 resourceType 即可。知识库（document-store）支持双向同步，
 * 其它资源默认单向发送。详见 doc/design.peer-sync.md。
 *
 * 遵守 .claude/rules/frontend-modal.md：createPortal 到 body、inline 高度、min-h-0 滚动、ESC + 蒙版关闭。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, X, Check, Send, ArrowRightLeft, ArrowLeft, ArrowRight } from 'lucide-react';
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
  /** 预选条目（如知识库列表里勾选的库 id）。为空则在弹窗内多选。 */
  presetItemIds?: string[];
  onClose: () => void;
  /** 互传完成回调（可用于刷新列表） */
  onDone?: () => void;
}

const DIRECTIONS: { key: PeerTransferDirection; label: string; icon: React.ReactNode; hint: string }[] = [
  { key: 'push', label: '发送到对端', icon: <ArrowRight size={14} />, hint: '本地内容覆盖对端（对端被更新）' },
  { key: 'pull', label: '从对端拉取', icon: <ArrowLeft size={14} />, hint: '对端内容覆盖本地（本地被更新）' },
  { key: 'both', label: '双向同步', icon: <ArrowRightLeft size={14} />, hint: '两侧合并，冲突以本地为准，各自新增都保留' },
];

export function SendToPeerDialog({ resourceType, presetItemIds, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<PeerNode[]>([]);
  const [capability, setCapability] = useState<SyncResourceCapability | null>(null);
  const [items, setItems] = useState<SyncItemSummary[]>([]);

  const [nodeId, setNodeId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set(presetItemIds ?? []));
  const [direction, setDirection] = useState<PeerTransferDirection>('push');

  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<TransferItemResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ stage: string; startedAt: number } | null>(null);
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!submitting) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [submitting]);

  // PR #742 review Medium：transfer 进行中拦住所有关闭路径（ESC / 蒙版 / 关闭按钮），
  // 否则 HTTP 还在跑、结果没回前 modal 被关掉，用户以为"啥都没发生"，
  // onDone 也不触发，知识库列表不刷新。
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

  // PR #742 review fix: 慢响应回填可能在 modal 关闭后 / 新一轮 load 启动后才到，
  // 导致弹窗状态被旧数据短暂覆盖。沿用 prd-admin learned rule: fetchIdRef stale guard。
  const loadSeqRef = useRef(0);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);
  const load = useCallback(async () => {
    const mySeq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    const [nodesRes, itemsRes] = await Promise.all([listPeerNodes(), listPeerItems(resourceType)]);
    if (mySeq !== loadSeqRef.current || !isMountedRef.current) return; // 旧响应或 modal 已关闭 → 丢弃
    if (nodesRes.success && nodesRes.data) {
      setNodes(nodesRes.data.items || []);
      const cap = (nodesRes.data.capabilities || []).find((c) => c.resourceType === resourceType) || null;
      setCapability(cap);
      if (!cap?.supportsBidirectional && direction === 'both') setDirection('push');
      if ((nodesRes.data.items || []).length === 1) setNodeId(nodesRes.data.items[0].id);
    } else {
      setError(nodesRes.error?.message || '加载对端节点失败');
    }
    if (itemsRes.success && itemsRes.data) {
      setItems(itemsRes.data.items || []);
    } else {
      // PR #742 review Medium fix：之前只看 nodesRes，items 加载失败时静默走空状态，用户以为"没东西可发"。
      // 用 || 累加错误（nodes 已报错时优先保留）。
      setError((prev) => prev || itemsRes.error?.message || '加载可发送条目失败');
    }
    setLoading(false);
  }, [resourceType, direction]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceType]);

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSubmit = nodeId && selected.size > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setResults(null);
    const startedAt = Date.now();
    const total = selected.size;
    const dirLabel = direction === 'push' ? '发送' : direction === 'pull' ? '拉取' : '双向同步';
    setProgress({ stage: `准备 ${dirLabel} ${total} 项条目…`, startedAt });
    const t1 = setTimeout(() => setProgress({ stage: `正在导出 / 跨节点传输 bundle…`, startedAt }), 1500);
    const t2 = setTimeout(() => setProgress({ stage: `对端正在 apply（按血缘 upsert）…`, startedAt }), 5000);
    const t3 = setTimeout(() => setProgress({ stage: `对端响应较慢，知识库较大或网络较差时可能需要更长时间…`, startedAt }), 12000);
    const res = await transferToPeer({
      nodeId,
      resourceType,
      itemIds: Array.from(selected),
      direction,
    });
    clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    setSubmitting(false);
    setProgress(null);
    if (res.success && res.data) {
      const items = res.data.results || [];
      setResults(items);
      // PR #742 review Medium fix：之前只有 anyFail=false 才回调 onDone，部分成功部分失败时知识库列表不刷新
      // 用户看到弹窗里某些条目「成功」但列表没变化，以为啥都没发生。只要至少一条 ok=true 就触发刷新。
      if (items.some((r) => r.ok)) onDone?.();
    } else {
      setError(res.error?.message || '互传失败');
    }
  };

  const availableDirections = useMemo(
    // PR #742 review P2 fix：之前只过滤掉 both，仍允许用户选 pull → 后端拒 → 验证失败提示。
    // 单向资源（push-only）应该在 UI 就只露出 push。
    () => DIRECTIONS.filter((d) => d.key === 'push' || capability?.supportsBidirectional),
    [capability],
  );

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={safeClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/10 bg-[#16171b] flex flex-col shadow-2xl"
        style={{ maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Send size={16} className="text-white/70" />
            <span className="text-sm font-medium">发送到对端节点</span>
          </div>
          <button onClick={safeClose} className="text-white/40 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 px-5 py-4 space-y-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {/* PR #742 review Medium fix：error 之前只在 nodes.length>0 分支渲染，
              listPeerNodes 失败时 nodes=[] 走"还没有可用的对端节点"空状态，真实错误被吞掉。
              改为顶层渲染 error，让 API 失败时用户能看到真因。 */}
          {!loading && error && (
            <div className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.20)',
                color: 'rgba(252,165,165,0.95)',
              }}>
              <span className="font-medium shrink-0">加载失败：</span>
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
          {loading ? (
            <MapSectionLoader text="正在加载…" />
          ) : nodes.length === 0 ? (
            <div className="text-center py-8">
              <Globe size={26} className="mx-auto text-white/25" />
              <div className="mt-3 text-sm text-white/60">还没有可用的对端节点</div>
              <div className="mt-1 text-xs text-white/40">
                请联系管理员在「设置 → 系统互联」中配置对端节点后再试。
              </div>
            </div>
          ) : (
            <>
              {/* 目标节点 */}
              <div>
                <div className="text-xs text-white/50 mb-1.5">目标节点</div>
                <div className="grid gap-1.5">
                  {nodes.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setNodeId(n.id)}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                        nodeId === n.id ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
                      }`}
                    >
                      <Globe size={15} className="text-white/50 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{n.displayName}</div>
                        <div className="text-[11px] text-white/40 font-mono truncate">{n.baseUrl}</div>
                      </div>
                      {nodeId === n.id && <Check size={15} className="text-white/70 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* 方向 */}
              <div>
                <div className="text-xs text-white/50 mb-1.5">方向</div>
                <div className="grid gap-1.5">
                  {availableDirections.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => setDirection(d.key)}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                        direction === d.key ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
                      }`}
                    >
                      <span className="text-white/60 shrink-0">{d.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{d.label}</div>
                        <div className="text-[11px] text-white/40">{d.hint}</div>
                      </div>
                      {direction === d.key && <Check size={15} className="text-white/70 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* 条目选择 */}
              <div>
                <div className="text-xs text-white/50 mb-1.5">
                  选择条目（{capability?.displayName || resourceType}）· 已选 {selected.size}
                </div>
                {items.length === 0 ? (
                  <div className="text-xs text-white/40 px-3 py-4 text-center rounded-lg border border-white/10 bg-white/5">
                    没有可发送的条目
                  </div>
                ) : (
                  <div className="grid gap-1 max-h-52 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                    {items.map((it) => (
                      <button
                        key={it.itemId}
                        onClick={() => toggleItem(it.itemId)}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                          selected.has(it.itemId) ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
                        }`}
                      >
                        <span
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            selected.has(it.itemId) ? 'bg-white/80 border-white/80' : 'border-white/30'
                          }`}
                        >
                          {selected.has(it.itemId) && <Check size={11} className="text-black" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate">{it.name}</div>
                          <div className="text-[11px] text-white/40">{it.recordCount} 项内容</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 进度（等提示信息，避免空白等待 — CLAUDE.md §6） */}
              {submitting && progress && (
                <div
                  className="rounded-lg p-3 flex items-start gap-2"
                  style={{
                    background: 'rgba(59,130,246,0.08)',
                    border: '1px solid rgba(59,130,246,0.20)',
                  }}
                >
                  <MapSpinner size={13} />
                  <div className="min-w-0 flex-1 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                    {progress.stage}
                    <span className="ml-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      已用 {Math.round((Date.now() - progress.startedAt) / 1000)}s
                    </span>
                  </div>
                </div>
              )}

              {/* 结果 */}
              {results && (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-1">
                  <div className="text-xs text-white/60 mb-1">互传结果</div>
                  {results.map((r) => {
                    const name = items.find((i) => i.itemId === r.itemId)?.name || r.itemId;
                    return (
                      <div key={r.itemId} className="flex items-start gap-2 text-[12px]">
                        <span className={r.ok ? 'text-green-400' : 'text-red-400'}>{r.ok ? '成功' : '失败'}</span>
                        <span className="text-white/70 truncate">{name}</span>
                        {r.message && <span className="text-white/40">— {r.message}</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* error 顶层渲染，见 body 顶部空状态前的渲染块 */}
            </>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 shrink-0">
          <Button size="sm" variant="ghost" onClick={safeClose}>
            关闭
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? <MapSpinner size={14} /> : <Send size={14} />}
            {direction === 'pull' ? '拉取' : direction === 'both' ? '双向同步' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
