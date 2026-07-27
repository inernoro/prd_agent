import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
  Link2,
  Network,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { publishTutorialLinkGraph, rollbackTutorialLinkGraph } from '@/services';
import type {
  TutorialLinkGraphSnapshot,
  TutorialLinkSurface,
} from '@/services/contracts/documentStore';

type DrawerTab = 'coverage' | 'drift' | 'history';

type Props = {
  storeId: string;
  snapshot: TutorialLinkGraphSnapshot;
  tutorialTitles: Record<string, string>;
  onClose: () => void;
  onSnapshotChange: (snapshot: TutorialLinkGraphSnapshot) => void;
  onOpenTutorial: (sourceId: string) => void;
  onOpenProductRoute: (route: string) => Promise<void>;
};

function surfaceFingerprint(surface: TutorialLinkSurface): string {
  return JSON.stringify(surface);
}

export function resolveTutorialProductRoute(route: string): string {
  const parameterIndex = route.indexOf('/:');
  if (parameterIndex > 0) return route.slice(0, parameterIndex);
  if (route.endsWith('/view')) return route.slice(0, -'/view'.length) || '/';
  return route;
}

export function TutorialLinkGraphDrawer({
  storeId,
  snapshot,
  tutorialTitles,
  onClose,
  onSnapshotChange,
  onOpenTutorial,
  onOpenProductRoute,
}: Props) {
  const [tab, setTab] = useState<DrawerTab>('coverage');
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const published = snapshot.published;
  const draft = snapshot.draft;
  const surfaces = useMemo(() => published?.surfaces ?? [], [published]);
  const tutorialIds = useMemo(
    () => [...new Set(surfaces.flatMap(surface => surface.tutorialSourceIds))].sort(),
    [surfaces],
  );
  const changedSurfaces = useMemo(() => {
    const publishedMap = new Map((published?.surfaces ?? []).map(surface => [surface.id, surface]));
    const draftMap = new Map((draft?.surfaces ?? []).map(surface => [surface.id, surface]));
    return [...new Set([...publishedMap.keys(), ...draftMap.keys()])].sort().flatMap((id) => {
      const before = publishedMap.get(id);
      const after = draftMap.get(id);
      if (before && after && surfaceFingerprint(before) === surfaceFingerprint(after)) return [];
      return [{ id, before, after }];
    });
  }, [draft, published]);
  const selectedSurface = (tab === 'drift'
    ? draft?.surfaces.find(surface => surface.id === selectedSurfaceId)
    : surfaces.find(surface => surface.id === selectedSurfaceId))
    ?? surfaces.find(surface => surface.id === selectedSurfaceId)
    ?? draft?.surfaces.find(surface => surface.id === selectedSurfaceId)
    ?? null;
  const selectedTutorialLinks = useMemo(() => {
    if (!selectedSurface) return [];
    const detailed = new Map(selectedSurface.tutorialLinks.map(link => [link.sourceId, link]));
    return selectedSurface.tutorialSourceIds.map(sourceId => ({
      sourceId,
      stepIds: detailed.get(sourceId)?.stepIds ?? [],
      evidenceIds: detailed.get(sourceId)?.evidenceIds ?? [],
    }));
  }, [selectedSurface]);
  const hasUnpublishedDraft = Boolean(draft && draft.graphSha256 !== published?.graphSha256);
  const linkCount = surfaces.reduce((total, surface) => total + surface.tutorialLinks.length, 0);
  const evidenceCount = surfaces.reduce(
    (total, surface) => total + surface.tutorialLinks.reduce((sum, link) => sum + link.evidenceIds.length, 0),
    0,
  );

  async function publishDraft() {
    if (!draft || busy) return;
    const accepted = await systemDialog.confirm({
      title: '发布教程关系图',
      message: `将草稿 ${draft.graphSha256.slice(0, 10)} 发布为运行时版本。教程正文不会被修改。`,
      confirmText: '发布图谱',
      cancelText: '取消',
    });
    if (!accepted) return;
    setBusy(true);
    const result = await publishTutorialLinkGraph(storeId, draft.graphSha256, published?.graphSha256);
    setBusy(false);
    if (!result.success) {
      toast.error('发布失败', result.error?.message ?? '图谱已变化，请刷新后重试');
      return;
    }
    onSnapshotChange(result.data);
    toast.success('教程关系图已发布');
  }

  async function rollback(versionId: string) {
    if (!published || busy) return;
    const accepted = await systemDialog.confirm({
      title: '回滚教程关系图',
      message: '将指定历史版本重新发布。教程正文不会被修改，现有版本仍保留在历史中。',
      confirmText: '确认回滚',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!accepted) return;
    setBusy(true);
    const result = await rollbackTutorialLinkGraph(storeId, versionId, published.graphSha256);
    setBusy(false);
    if (!result.success) {
      toast.error('回滚失败', result.error?.message ?? '图谱已变化，请刷新后重试');
      return;
    }
    onSnapshotChange(result.data);
    toast.success('教程关系图已回滚');
  }

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex justify-end" role="dialog" aria-modal="true" aria-labelledby="tutorial-link-graph-title">
      <button type="button" className="absolute inset-0 cursor-default bg-black/45" aria-label="关闭教程关系背景" onClick={onClose} />
      <section
        className="surface-base relative z-10 flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-token-subtle shadow-2xl lg:max-w-[1120px]"
        style={{
          width: 'min(1120px, 100vw)',
          height: '100dvh',
          maxHeight: '100dvh',
          background: 'var(--bg-primary)',
        }}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-token-subtle px-4 py-3 sm:gap-4 sm:px-7 sm:py-4">
          <div className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-token-muted sm:text-[11px] sm:tracking-[0.14em]">
              <Network size={14} className="shrink-0" />
              <span className="truncate">LLM Gateway<span className="hidden sm:inline"> 教程维护</span></span>
            </div>
            <h2 id="tutorial-link-graph-title" className="text-[18px] font-semibold tracking-[-0.02em] text-token-primary sm:text-[20px]">教程关系</h2>
            <p className="mt-1 max-w-[560px] pr-1 text-[11px] leading-4 text-token-muted sm:text-[12px]">页面、教程步骤与验收证据共用同一份已发布运行时图谱。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasUnpublishedDraft && (
              <button type="button" disabled={busy} onClick={() => void publishDraft()} className="surface-action flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[12px] font-semibold text-token-primary">
                {busy ? <MapSpinner size={13} /> : <GitBranch size={13} />}发布草稿
              </button>
            )}
            <button type="button" onClick={onClose} className="surface-action grid h-8 w-8 place-items-center rounded-[8px] text-token-muted" aria-label="关闭教程关系"><X size={16} /></button>
          </div>
        </header>

        <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-token-subtle px-4 py-3 sm:grid-cols-4 sm:px-7 sm:py-4">
          {[
            ['页面', surfaces.length],
            ['教程', tutorialIds.length],
            ['步骤关系', linkCount],
            ['验收证据', evidenceCount],
          ].map(([label, value]) => (
            <div key={label} className="surface-raised rounded-[10px] px-3 py-2.5">
              <div className="text-[11px] text-token-muted">{label}</div>
              <div className="mt-1 text-[19px] font-semibold tabular-nums text-token-primary">{value}</div>
            </div>
          ))}
        </div>

        <nav className="flex shrink-0 gap-4 overflow-x-auto border-b border-token-subtle px-4 sm:gap-5 sm:px-7" aria-label="教程关系视图">
          {([
            ['coverage', '覆盖矩阵'],
            ['drift', `漂移 ${changedSurfaces.length}`],
            ['history', `版本 ${snapshot.history.length}`],
          ] as Array<[DrawerTab, string]>).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} className={`h-11 border-b-2 px-0.5 text-[13px] font-medium ${tab === key ? 'border-token-primary text-token-primary' : 'border-transparent text-token-muted'}`}>
              {label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overscroll-contain overflow-auto px-4 py-4 sm:px-7 sm:py-5">
          {!published ? (
            <div className="surface-raised mx-auto mt-12 max-w-lg rounded-[12px] p-6 text-center">
              <ShieldCheck className="mx-auto text-token-muted" size={24} />
              <h3 className="mt-3 text-[15px] font-semibold text-token-primary">尚未发布教程关系图</h3>
              <p className="mt-1 text-[12px] text-token-muted">每日巡检可以生成草稿；管理员检查后再发布，不会自动改教程正文。</p>
            </div>
          ) : tab === 'coverage' ? (
            <div className="space-y-4">
              <div className="hidden overflow-x-auto rounded-[12px] border border-token-subtle bg-[var(--bg-primary)] md:block">
                <table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
                  <thead className="surface-raised text-token-muted">
                    <tr>
                      <th className="sticky left-0 z-10 min-w-[220px] border-b border-token-subtle bg-inherit px-4 py-3 font-medium">产品页面</th>
                      {tutorialIds.map(id => <th key={id} className="min-w-[116px] border-b border-token-subtle px-3 py-3 font-medium">{tutorialTitles[id] ?? id}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {surfaces.map(surface => (
                      <tr key={surface.id} className="hover-bg-soft cursor-pointer" onClick={() => setSelectedSurfaceId(surface.id)}>
                        <td className="sticky left-0 border-b border-token-subtle bg-[var(--bg-primary)] px-4 py-3">
                          <div className="flex items-center justify-between gap-3"><span className="font-semibold text-token-primary">{surface.label ?? surface.id}</span><ChevronRight size={14} className="text-token-muted" /></div>
                          <div className="mt-1 font-mono text-[10px] text-token-muted">{surface.routes.join(' · ')}</div>
                        </td>
                        {tutorialIds.map(id => (
                          <td key={id} className="border-b border-token-subtle px-3 py-3 text-center">
                            {surface.tutorialSourceIds.includes(id)
                              ? <button type="button" onClick={(event) => { event.stopPropagation(); onOpenTutorial(id); }} className="mx-auto grid h-6 w-6 place-items-center rounded-full bg-[var(--semantic-success-soft)] text-[var(--semantic-success-text)]" aria-label={`打开 ${tutorialTitles[id] ?? id}`}><Check size={13} /></button>
                              : <span className="text-token-faint">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 md:hidden">
                {surfaces.map(surface => (
                  <button key={surface.id} type="button" onClick={() => setSelectedSurfaceId(surface.id)} className="surface-raised flex w-full items-center justify-between gap-3 overflow-hidden rounded-[11px] p-4 text-left">
                    <span className="min-w-0"><strong className="block truncate text-[13px] text-token-primary">{surface.label ?? surface.id}</strong><small className="mt-1 block truncate text-[11px] text-token-muted">{surface.tutorialSourceIds.length} 篇教程 · {surface.routes[0]}</small></span>
                    <ChevronRight size={16} className="shrink-0 text-token-muted" />
                  </button>
                ))}
              </div>
            </div>
          ) : tab === 'drift' ? (
            changedSurfaces.length === 0 ? (
              <div className="surface-raised mx-auto mt-12 max-w-lg rounded-[12px] p-6 text-center"><ShieldCheck className="mx-auto text-token-muted" size={24} /><h3 className="mt-3 text-[15px] font-semibold text-token-primary">草稿与正式版本一致</h3><p className="mt-1 text-[12px] text-token-muted">没有待发布的页面、教程步骤或验收证据漂移。</p></div>
            ) : (
              <div className="space-y-2">
                {changedSurfaces.map(item => (
                  <button key={item.id} type="button" onClick={() => setSelectedSurfaceId(item.id)} className="surface-raised flex w-full items-center justify-between gap-4 rounded-[11px] p-4 text-left">
                    <span><strong className="block text-[13px] text-token-primary">{item.after?.label ?? item.before?.label ?? item.id}</strong><small className="mt-1 block text-[11px] text-token-muted">{!item.before ? '草稿新增' : !item.after ? '草稿移除' : '关系或证据已变化'}</small></span>
                    <ChevronRight size={16} className="text-token-muted" />
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="space-y-2">
              {snapshot.history.map(version => (
                <div key={version.versionId} className="surface-raised flex flex-wrap items-center justify-between gap-3 rounded-[11px] p-4">
                  <div className="min-w-0"><div className="flex items-center gap-2 text-[13px] font-semibold text-token-primary"><Clock3 size={14} />{new Date(version.publishedAt).toLocaleString()}</div><div className="mt-1 truncate font-mono text-[10px] text-token-muted">{version.graphSha256} · {version.sourceRevision}</div></div>
                  <button type="button" disabled={busy || version.graphSha256 === published.graphSha256} onClick={() => void rollback(version.versionId)} className="surface-action flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-semibold text-token-primary disabled:opacity-40"><RotateCcw size={13} />回滚到此版本</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedSurface && (
          <aside className="surface-base absolute inset-y-0 right-0 z-20 flex w-full max-w-[460px] flex-col border-l border-token-subtle shadow-2xl" style={{ background: 'var(--bg-primary)' }} aria-label="页面关系详情">
            <header className="flex items-start justify-between gap-3 border-b border-token-subtle p-5"><div><div className="text-[11px] text-token-muted">页面关系详情</div><h3 className="mt-1 text-[17px] font-semibold text-token-primary">{selectedSurface.label ?? selectedSurface.id}</h3></div><button type="button" className="surface-action grid h-8 w-8 place-items-center rounded-[8px] text-token-muted" onClick={() => setSelectedSurfaceId(null)} aria-label="关闭详情"><X size={15} /></button></header>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
              <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-token-muted">产品路由</h4><div className="mt-2 space-y-2">{selectedSurface.routes.map(route => { const target = resolveTutorialProductRoute(route); return <button key={route} type="button" onClick={() => void onOpenProductRoute(target)} className="surface-action flex w-full items-center justify-between rounded-[9px] px-3 py-2.5 text-left font-mono text-[11px] text-token-primary"><span>{target}</span><ArrowUpRight size={13} /></button>; })}</div></section>
              <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-token-muted">关联教程与步骤</h4><div className="mt-2 space-y-2">{selectedTutorialLinks.map(link => <button key={link.sourceId} type="button" onClick={() => onOpenTutorial(link.sourceId)} className="surface-raised block w-full rounded-[9px] p-3 text-left"><span className="flex items-center justify-between gap-2 text-[12px] font-semibold text-token-primary"><span className="truncate">{tutorialTitles[link.sourceId] ?? link.sourceId}</span><Link2 size={13} /></span><small className="mt-1 block text-[10px] text-token-muted">{link.stepIds.length > 0 ? `步骤 ${link.stepIds.join('、')} · 证据 ${link.evidenceIds.join('、') || '待补'}` : '页面级关系 · 尚无步骤级证据'}</small></button>)}</div></section>
              <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-token-muted">变更来源</h4><div className="mt-2 space-y-1 font-mono text-[10px] text-token-muted">{selectedSurface.changeSources.map(source => <div key={source}>{source}</div>)}</div></section>
            </div>
          </aside>
        )}
      </section>
    </div>,
    document.body,
  );
}

export function TutorialLinkedPages({
  sourceId,
  snapshot,
  onOpenRoute,
}: {
  sourceId?: string;
  snapshot: TutorialLinkGraphSnapshot | null;
  onOpenRoute: (route: string) => Promise<void>;
}) {
  const surfaces = (snapshot?.published?.surfaces ?? []).filter(surface => sourceId && surface.tutorialSourceIds.includes(sourceId));
  if (surfaces.length === 0) return null;
  return (
    <section className="mt-5 border-t border-token-subtle pt-5" aria-labelledby="linked-product-pages-title">
      <div className="mb-3 flex items-center gap-2"><Network size={14} className="text-token-muted" /><h3 id="linked-product-pages-title" className="text-[13px] font-semibold text-token-primary">关联的 LLM Gateway 页面</h3></div>
      <div className="grid gap-2 sm:grid-cols-2">
        {surfaces.map(surface => (
          <button key={surface.id} type="button" onClick={() => void onOpenRoute(resolveTutorialProductRoute(surface.routes[0]))} className="surface-raised flex items-center justify-between gap-3 rounded-[10px] p-3 text-left">
            <span className="min-w-0"><strong className="block truncate text-[12px] text-token-primary">{surface.label ?? surface.id}</strong><small className="mt-1 block truncate font-mono text-[10px] text-token-muted">{resolveTutorialProductRoute(surface.routes[0])}</small></span>
            <ArrowUpRight size={14} className="shrink-0 text-token-muted" />
          </button>
        ))}
      </div>
    </section>
  );
}
