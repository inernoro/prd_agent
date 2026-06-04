import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link as LinkIcon, Copy, CheckCircle2, AlertCircle, RefreshCw,
  Trash2, X, ArrowLeftRight, ArrowRight, ArrowLeft, Globe, FolderSync, Clock,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listAllSyncLinks, listStoreSyncLinks, createLocalSyncLink, generateSyncLink, connectSyncLink,
  runSyncLink, updateSyncLinkDirection, deleteSyncLink, revokeSyncToken,
  type DocumentSyncLink, type SyncDirection, type SyncLinkStatus,
} from '@/services/real/documentStoreSync';
import { listDocumentStoresWithPreview } from '@/services/real/documentStore';
import type { DocumentStoreWithPreview } from '@/services/contracts/documentStore';
import { useTeamStore } from '@/stores/teamStore';

const DIRECTIONS: { key: SyncDirection; label: string; icon: typeof ArrowRight }[] = [
  { key: 'both', label: '双向同步', icon: ArrowLeftRight },
  { key: 'pull', label: '对端 → 本地', icon: ArrowLeft },
  { key: 'push', label: '本地 → 对端', icon: ArrowRight },
];

function StatusBadge({ status }: { status: SyncLinkStatus }) {
  if (status === 'synced')
    return <span className="inline-flex items-center gap-1 text-[12px] text-emerald-400"><CheckCircle2 size={13} />已同步</span>;
  if (status === 'pending')
    return <span className="inline-flex items-center gap-1 text-[12px] text-amber-400"><Clock size={13} />待同步</span>;
  if (status === 'error')
    return <span className="inline-flex items-center gap-1 text-[12px] text-rose-400"><AlertCircle size={13} />同步出错</span>;
  return <span className="inline-flex items-center gap-1 text-[12px] text-token-muted">未同步</span>;
}

/**
 * 知识库详情右上角的同步状态徽章：仅当本库已加入同步配对时显示。
 * 聚合多个配对的状态（error > pending > synced > never），点击跳转到「跨环境同步」页签。
 */
export function StoreSyncBadge({ storeId, onManage }: { storeId: string; onManage?: () => void }) {
  const [links, setLinks] = useState<DocumentSyncLink[] | null>(null);

  useEffect(() => {
    let alive = true;
    listStoreSyncLinks(storeId).then(res => {
      if (alive && res.success) setLinks(res.data.items ?? []);
    });
    return () => { alive = false; };
  }, [storeId]);

  if (!links || links.length === 0) return null;

  const agg: SyncLinkStatus = links.some(l => l.status === 'error') ? 'error'
    : links.some(l => l.status === 'pending') ? 'pending'
    : links.some(l => l.status === 'synced') ? 'synced'
    : 'never';

  const meta = {
    synced: { cls: 'text-emerald-400', icon: <CheckCircle2 size={11} />, text: '已同步' },
    pending: { cls: 'text-amber-400', icon: <Clock size={11} />, text: '待同步' },
    error: { cls: 'text-rose-400', icon: <AlertCircle size={11} />, text: '同步出错' },
    never: { cls: 'text-token-muted', icon: <FolderSync size={11} />, text: '已链接同步' },
  }[agg];

  return (
    <button
      onClick={onManage}
      title={`本知识库已加入跨环境同步（${links.length} 个配对），点击管理`}
      className={`surface-action flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[11px] font-semibold transition-all ${meta.cls}`}
    >
      {meta.icon}
      {meta.text}
    </button>
  );
}

export function SyncManagerPanel() {
  const [links, setLinks] = useState<DocumentSyncLink[]>([]);
  const [myStores, setMyStores] = useState<DocumentStoreWithPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  // 防 stale 响应：快速点刷新 / 切走再回来时，旧请求回填会覆盖新数据。
  // 单调递增序号锁住"只有最新一次请求才能 setState"（与 DocumentStorePage 的 listFetchSeq 同款，
  // 满足 prd-admin learned rule: tab/filter 触发的 async fetch 必须有 fetchId stale-guard）。
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mySeq = ++loadSeq.current;
    setLoading(true);
    // 选择器要列出"我能写的所有库"：自己拥有的(mine) + 各团队共享给我的(team)。
    // 后端 LoadWritableStoreAsync 接受团队写者，UI 不补这些库的话团队共享库就配不了对（Codex P2）。
    await useTeamStore.getState().loadTeams().catch(() => {});
    const teams = useTeamStore.getState().teams;
    const [linkRes, mineRes] = await Promise.all([
      listAllSyncLinks(),
      listDocumentStoresWithPreview(1, 500, { scope: 'mine' }),
    ]);
    const teamResults = await Promise.all(
      teams.map(t => listDocumentStoresWithPreview(1, 500, { scope: 'team', teamId: t.team.id })),
    );
    if (mySeq !== loadSeq.current) return; // 已有更新的请求发出，丢弃本次回填
    if (linkRes.success) setLinks(linkRes.data.items ?? []);
    // 合并去重（按 store id）：mine 优先，团队共享库补充
    const merged = new Map<string, DocumentStoreWithPreview>();
    if (mineRes.success) for (const s of mineRes.data.items ?? []) merged.set(s.id, s);
    for (const tr of teamResults) if (tr.success) for (const s of tr.data.items ?? []) if (!merged.has(s.id)) merged.set(s.id, s);
    setMyStores([...merged.values()]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRun = async (link: DocumentSyncLink) => {
    setRunningId(link.id);
    const res = await runSyncLink(link.id);
    if (res.success) {
      // 后端可能返回 pending（如对端状态未取到），此时不能报"同步完成"
      if (res.data.status === 'pending')
        toast.warning('同步已执行，对端状态待确认', res.data.lastResult ?? undefined);
      else
        toast.success('同步完成', res.data.lastResult ?? undefined);
      setLinks(prev => prev.map(l => l.id === link.id ? res.data : l));
    } else {
      toast.error('同步失败', res.error?.message);
      // 刷新拿到 error 状态
      load();
    }
    setRunningId(null);
  };

  const handleDirection = async (link: DocumentSyncLink, direction: SyncDirection) => {
    const res = await updateSyncLinkDirection(link.id, direction);
    // 状态依赖方向，后端会按新方向重算 status 并回带库名；直接用返回值（名字缺失时回退旧值兜底）。
    if (res.success) setLinks(prev => prev.map(l => l.id === link.id ? {
      ...l, ...res.data,
      localStoreName: res.data.localStoreName ?? l.localStoreName,
      remoteStoreName: res.data.remoteStoreName ?? l.remoteStoreName,
    } : l));
    else toast.error('修改方向失败', res.error?.message);
  };

  const handleDelete = async (link: DocumentSyncLink) => {
    if (!window.confirm(`确定撤销「${link.localStoreName ?? '本库'}」与「${link.remoteStoreName ?? '对端'}」的同步配对？`)) return;
    const res = await deleteSyncLink(link.id);
    if (res.success) setLinks(prev => prev.filter(l => l.id !== link.id));
    else toast.error('撤销失败', res.error?.message);
  };

  return (
    <div className="flex flex-col">
      {/* 工具栏 */}
      <div data-tour-id="sync-toolbar" className="flex items-center gap-2 mb-4 flex-wrap">
        <Button data-tour-id="sync-start-link" variant="primary" size="sm" onClick={() => setShowStart(true)}>
          <LinkIcon size={14} />启动链接
        </Button>
        <Button data-tour-id="sync-generate-link" variant="secondary" size="sm" onClick={() => setShowGenerate(true)}>
          <Copy size={14} />生成连接链接
        </Button>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} />刷新
        </Button>
        <span className="text-[12px] text-token-muted ml-1">
          共 {links.length} 个同步配对
        </span>
      </div>

      <div data-tour-id="sync-list">
        {loading ? (
          <MapSectionLoader text="正在加载同步配对…" />
        ) : links.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="surface-action-accent flex h-12 w-12 items-center justify-center rounded-[14px] mb-4">
              <FolderSync size={22} />
            </div>
            <p className="text-[15px] font-semibold text-token-primary mb-1.5">还没有同步配对</p>
            <p className="text-[13px] text-token-muted mb-5 max-w-[420px]">
              把另一处知识库的「连接链接」粘贴进来，即可让两个知识库互相同步内容（支持跨环境，也支持本环境两个库）。
            </p>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => setShowStart(true)}>
                <LinkIcon size={14} />启动链接
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowGenerate(true)}>
                <Copy size={14} />生成连接链接
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {links.map(link => (
              <div key={link.id} className="surface-popover rounded-[14px] p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="surface-action-accent flex h-9 w-9 items-center justify-center rounded-[10px] shrink-0">
                      {link.linkType === 'remote' ? <Globe size={16} /> : <FolderSync size={16} />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[14px] text-token-primary font-medium truncate">
                        <span className="truncate max-w-[180px]">{link.localStoreName ?? '本库'}</span>
                        <ArrowLeftRight size={13} className="text-token-muted shrink-0" />
                        <span className="truncate max-w-[180px]">{link.remoteStoreName ?? link.remoteStoreId}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-token-muted">
                        <span className="px-1.5 py-0.5 rounded-[6px] bg-white/6">
                          {link.linkType === 'remote' ? '跨环境' : '本地'}
                        </span>
                        {link.linkType === 'remote' && link.remoteBaseUrl && (
                          <span className="truncate max-w-[220px]">{link.remoteBaseUrl}</span>
                        )}
                        {link.lastSyncedAt && (
                          <span>上次同步 {new Date(link.lastSyncedAt).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={link.status} />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
                  {/* 方向选择 */}
                  <div className="flex items-center gap-1">
                    {DIRECTIONS.map(d => {
                      const active = link.direction === d.key;
                      const Icon = d.icon;
                      return (
                        <button
                          key={d.key}
                          onClick={() => handleDirection(link, d.key)}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-[8px] text-[12px] transition-colors duration-150 ${
                            active ? 'surface-action-accent text-token-primary' : 'text-token-muted hover:bg-white/6'
                          }`}
                          title={d.label}
                        >
                          <Icon size={12} />{d.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="primary" size="xs" onClick={() => handleRun(link)} disabled={runningId === link.id}>
                      {runningId === link.id ? <MapSpinner size={13} /> : <RefreshCw size={13} />}
                      {runningId === link.id ? '同步中…' : '立即同步'}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => handleDelete(link)} disabled={runningId === link.id}>
                      <Trash2 size={13} />撤销
                    </Button>
                  </div>
                </div>
                {link.lastResult && (
                  <p className="mt-2 text-[11px] text-token-muted">{link.lastResult}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showStart && (
        <StartLinkDialog
          stores={myStores}
          onClose={() => setShowStart(false)}
          onDone={() => { setShowStart(false); load(); }}
        />
      )}
      {showGenerate && (
        <GenerateLinkDialog
          stores={myStores}
          onClose={() => setShowGenerate(false)}
        />
      )}
    </div>
  );
}

// ── 启动链接（跨环境粘贴链接 / 本地两库配对）──

function StartLinkDialog({ stores, onClose, onDone }: {
  stores: DocumentStoreWithPreview[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'remote' | 'local'>('remote');
  const [localStoreId, setLocalStoreId] = useState(stores[0]?.id ?? '');
  const [targetStoreId, setTargetStoreId] = useState('');
  const [link, setLink] = useState('');
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const localOptions = useMemo(() => stores, [stores]);
  const targetOptions = useMemo(() => stores.filter(s => s.id !== localStoreId), [stores, localStoreId]);

  const submit = async () => {
    if (busy) return;
    if (!localStoreId) { setError('请选择本地知识库'); return; }
    setBusy(true);
    setError('');
    if (mode === 'remote') {
      if (!link.trim()) { setError('请粘贴对方的连接链接'); setBusy(false); return; }
      const res = await connectSyncLink(localStoreId, link.trim(), direction);
      if (res.success) { toast.success('已连接，可在列表点「立即同步」'); onDone(); }
      else { setError(res.error?.message ?? '连接失败'); }
    } else {
      if (!targetStoreId) { setError('请选择对端知识库'); setBusy(false); return; }
      const res = await createLocalSyncLink(localStoreId, targetStoreId, direction);
      if (res.success) { toast.success('已配对，可在列表点「立即同步」'); onDone(); }
      else { setError(res.error?.message ?? '配对失败'); }
    }
    setBusy(false);
  };

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="surface-popover w-[480px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <LinkIcon size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">启动同步链接</span>
          </div>
          <button onClick={() => !busy && onClose()} disabled={busy}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6 disabled:opacity-40">
            <X size={15} />
          </button>
        </div>

        {/* 模式切换 */}
        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('remote')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-[10px] text-[13px] transition-colors ${
              mode === 'remote' ? 'surface-action-accent text-token-primary' : 'text-token-muted hover:bg-white/6'}`}>
            <Globe size={14} />跨环境（粘贴链接）
          </button>
          <button onClick={() => setMode('local')}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-[10px] text-[13px] transition-colors ${
              mode === 'local' ? 'surface-action-accent text-token-primary' : 'text-token-muted hover:bg-white/6'}`}>
            <FolderSync size={14} />本环境两个库
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">本地知识库</label>
          <select value={localStoreId} onChange={e => setLocalStoreId(e.target.value)} disabled={busy}
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none disabled:opacity-60">
            {localOptions.length === 0 && <option value="">（暂无知识库）</option>}
            {localOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {mode === 'remote' ? (
          <div className="mb-4">
            <label className="mb-1.5 block text-[12px] text-token-muted">对方的连接链接</label>
            <textarea value={link} onChange={e => setLink(e.target.value)} disabled={busy}
              placeholder="粘贴对方在「生成连接链接」里复制的 skblink_… 链接"
              className="prd-field w-full rounded-[10px] px-3 py-2 text-[13px] outline-none disabled:opacity-60 resize-none"
              rows={3}
            />
          </div>
        ) : (
          <div className="mb-4">
            <label className="mb-1.5 block text-[12px] text-token-muted">对端知识库（同环境）</label>
            <select value={targetStoreId} onChange={e => setTargetStoreId(e.target.value)} disabled={busy}
              className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none disabled:opacity-60">
              <option value="">请选择…</option>
              {targetOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">同步方向</label>
          <div className="flex gap-2">
            {DIRECTIONS.map(d => {
              const Icon = d.icon;
              return (
                <button key={d.key} onClick={() => setDirection(d.key)} disabled={busy}
                  className={`flex-1 inline-flex items-center justify-center gap-1 h-9 rounded-[10px] text-[12px] transition-colors disabled:opacity-60 ${
                    direction === d.key ? 'surface-action-accent text-token-primary' : 'text-token-muted hover:bg-white/6'}`}>
                  <Icon size={12} />{d.label}
                </button>
              );
            })}
          </div>
        </div>

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={() => !busy && onClose()} disabled={busy}>取消</Button>
          <Button variant="primary" size="xs" onClick={submit} disabled={busy}>
            {busy ? '连接中…' : '连接'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 生成连接链接（把本库交给对端来连）──

function GenerateLinkDialog({ stores, onClose }: {
  stores: DocumentStoreWithPreview[];
  onClose: () => void;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const generate = async () => {
    if (busy || !storeId) { if (!storeId) setError('请选择知识库'); return; }
    setBusy(true);
    setError('');
    const res = await generateSyncLink(storeId, baseUrl.trim() || undefined);
    if (res.success) setLink(res.data.link);
    else setError(res.error?.message ?? '生成失败');
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast.success('已复制连接链接'); }
    catch { toast.error('复制失败，请手动选择复制'); }
  };

  const revoke = async () => {
    if (busy || !storeId) return;
    if (!window.confirm('撤销后，所有用本库连接链接连入的对端将立即失效（已建立的配对无法再同步）。确定撤销？')) return;
    setBusy(true);
    setError('');
    const res = await revokeSyncToken(storeId);
    if (res.success) { setLink(''); toast.success('已撤销本库连接令牌，旧链接立即失效'); }
    else setError(res.error?.message ?? '撤销失败');
    setBusy(false);
  };

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="surface-popover w-[480px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Copy size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">生成连接链接</span>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <p className="mb-4 text-[12px] text-token-muted leading-relaxed">
          把生成的链接发给对端环境，对端在「启动链接」里粘贴即可双向同步。令牌永久有效；不想再被连入时，点下方「撤销连接令牌」即刻失效所有旧链接。
        </p>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">知识库</label>
          <select value={storeId} onChange={e => { setStoreId(e.target.value); setLink(''); }} disabled={busy}
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none disabled:opacity-60">
            {stores.length === 0 && <option value="">（暂无知识库）</option>}
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">本环境对外地址（对端需能访问）</label>
          <input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setLink(''); }} disabled={busy}
            placeholder="https://your-env.example.com"
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none disabled:opacity-60" />
          <p className="mt-1 text-[11px] text-token-muted">默认填当前访问地址，跨环境时请改成对端能访问到的地址。本环境两个库互同步不需要它。</p>
        </div>

        {link && (
          <div className="mb-4">
            <label className="mb-1.5 block text-[12px] text-token-muted">连接链接（发给对端）</label>
            <div className="flex gap-2">
              <textarea value={link} readOnly rows={2}
                className="prd-field flex-1 rounded-[10px] px-3 py-2 text-[12px] outline-none resize-none break-all" />
              <Button variant="secondary" size="xs" onClick={copy}><Copy size={13} />复制</Button>
            </div>
          </div>
        )}

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <Button variant="danger" size="xs" onClick={revoke} disabled={busy || !storeId}>
            <Trash2 size={13} />撤销连接令牌
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="xs" onClick={onClose}>关闭</Button>
            <Button variant="primary" size="xs" onClick={generate} disabled={busy}>
              {busy ? '生成中…' : link ? '重新生成' : '生成链接'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
