import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, Settings2, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getSite, type HostedSite } from '@/services/real/webPages';
import NewSiteStage, { type GenerationIntro, type WorkbenchSource } from './NewSiteStage';
import SiteEditStage from './SiteEditStage';
import { PaneTabs, type WorkbenchPane } from './WorkbenchParts';

/**
 * 生成网页工作台：一个对话 + 一个预览，把「新建」和「继续修改」放进同一个窗口。
 *
 * 2026-09-24 用户定的方向：点「生成网页」直接进这里，不再先选素材来源、再写要求、再生成；
 * 「帮我修改」也进同一个窗口，生成完不用关掉再找入口。新建完成后同一段对话接着往下改。
 */
export type WorkbenchTarget =
  | { kind: 'new'; source?: WorkbenchSource | null }
  | { kind: 'site'; site: HostedSite };

export default function SiteWorkbench({
  open,
  target,
  destinationTeamId,
  onClose,
  onCreated,
  onSiteChanged,
  onLocateSaved,
  onOpenSettings,
  onOpenShareSettings,
}: {
  open: boolean;
  target: WorkbenchTarget;
  /** 新建时归属的团队空间（打开那一刻冻结，随请求交给服务端）；个人空间传 null。 */
  destinationTeamId?: string | null;
  onClose: () => void;
  /** 新网页已存进网页托管：列表页据此刷新、补分组。 */
  onCreated?: (siteId: string) => void;
  /** 发布、换回等改变了线上版本：列表页同步这条网页。 */
  onSiteChanged?: (site: HostedSite) => void;
  onLocateSaved: (siteId: string) => void;
  onOpenSettings?: () => void;
  onOpenShareSettings?: (site: HostedSite) => void;
}) {
  const [pane, setPane] = useState<WorkbenchPane>('chat');
  const [site, setSite] = useState<HostedSite | null>(target.kind === 'site' ? target.site : null);
  const [intro, setIntro] = useState<GenerationIntro | null>(null);
  const [loadingSite, setLoadingSite] = useState(false);
  const [savedSiteId, setSavedSiteId] = useState<string | null>(null);
  const [openingFailed, setOpeningFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 每次打开换一把钥匙：两个阶段都重新挂载，上一轮的状态不会漏进这一轮。 */
  const [session, setSession] = useState(0);
  // 同步可读的会话号：生成完读站点的那次请求要能判断「我回来时还是不是这一轮」。
  const sessionRef = useRef(0);

  useEffect(() => {
    // 关窗也算换了一轮：读站点期间关掉，结果不许落到下一次打开的工作台上。
    sessionRef.current += 1;
    if (!open) return;
    setSession((current) => current + 1);
    setPane('chat');
    setIntro(null);
    setLoadingSite(false);
    setSavedSiteId(null);
    setOpeningFailed(false);
    setSite(target.kind === 'site' ? target.site : null);
    // 只在打开那一刻快照目标；打开期间列表刷新带来的新对象由 onSiteChanged 回写。
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSavedSite = useCallback((siteId: string) => {
    setOpeningFailed(false);
    setLoadingSite(true);
    const requestedIn = sessionRef.current;
    void getSite(siteId).then((result) => {
      if (sessionRef.current !== requestedIn) return;
      setLoadingSite(false);
      if (!result.success) {
        setOpeningFailed(true);
        return;
      }
      setSite(result.data);
    }).catch(() => {
      if (sessionRef.current !== requestedIn) return;
      setLoadingSite(false);
      setOpeningFailed(true);
    });
  }, []);

  const handleGenerated = useCallback((siteId: string, generatedIntro: GenerationIntro) => {
    setSavedSiteId(siteId);
    setIntro(generatedIntro);
    onCreated?.(siteId);
    openSavedSite(siteId);
  }, [onCreated, openSavedSite]);

  const handleSiteChanged = useCallback((updated: HostedSite) => {
    setSite(updated);
    onSiteChanged?.(updated);
  }, [onSiteChanged]);

  const title = site?.title ?? (savedSiteId ? '网页已生成' : '生成网页');
  const subtitle = site
    ? busy ? '正在修改 · 线上不变' : '说想改哪里，先出草稿再发布'
    : busy ? '正在生成 · 可以关掉窗口，回来接着看' : '用知识、文件或纪要生成网页';

  const dialogTitle = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]" style={{ background: 'var(--selection-bg)', color: 'var(--accent-primary)' }}>
        <Sparkles size={16} />
      </span>
      <span className="min-w-0">
        <span className="block max-w-[46vw] truncate text-[15px] font-bold lg:max-w-[520px]">{title}</span>
        <span className="block max-w-[46vw] truncate text-[11px] font-normal text-token-muted lg:max-w-[520px]">{subtitle}</span>
      </span>
    </span>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={dialogTitle}
      titleAction={(
        <span className="flex items-center gap-1.5">
          <PaneTabs pane={pane} onChange={setPane} previewBadge={busy ? '生成中' : undefined} />
          {onOpenSettings && !site && (
            <button
              type="button"
              title="风格与提示词"
              aria-label="风格与提示词"
              onClick={onOpenSettings}
              className="hidden h-8 w-8 items-center justify-center rounded-lg text-token-secondary hover-bg-soft sm:inline-flex"
            >
              <Settings2 size={15} />
            </button>
          )}
        </span>
      )}
      maxWidth={1440}
      contentStyle={{
        width: 'min(1440px, calc(100vw - 16px))',
        maxWidth: 'calc(100vw - 16px)',
        height: 'min(900px, calc(100dvh - 16px))',
        maxHeight: 'calc(100dvh - 16px)',
      }}
      content={(
        <div data-testid="site-workbench" className="flex h-full min-h-0 flex-col" style={{ minHeight: 0 }}>
          {savedSiteId && (
            <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
              <p role="status" className="flex items-center gap-2 text-[13px] font-semibold text-token-primary">
                <CheckCircle2 size={16} style={{ color: 'var(--accent-primary)' }} aria-hidden />
                已保存到网页托管
              </p>
              <button type="button" onClick={() => onLocateSaved(savedSiteId)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold" style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}>
                在网页托管中查看 <ExternalLink size={13} aria-hidden />
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {site ? (
              <SiteEditStage
                key={`${session}-${site.id}`}
                site={site}
                intro={intro}
                pane={pane}
                onPaneChange={setPane}
                onSiteChanged={handleSiteChanged}
                onOpenShareSettings={onOpenShareSettings}
                onBusyChange={setBusy}
              />
            ) : loadingSite ? (
              <MapSectionLoader text="网页已生成，正在打开" />
            ) : savedSiteId && openingFailed ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                <p role="alert" className="text-[13px] text-token-secondary">已保存的网页暂时打不开。可以重试打开预览，或到网页托管查看。</p>
                <button type="button" onClick={() => openSavedSite(savedSiteId)} className="min-h-9 rounded-lg px-3 text-[13px] font-semibold hover-bg-soft" style={{ border: '1px solid var(--border-default)' }}>
                  重试打开预览
                </button>
              </div>
            ) : target.kind === 'new' ? (
              <NewSiteStage
                key={session}
                source={target.source}
                destinationTeamId={destinationTeamId}
                pane={pane}
                onPaneChange={setPane}
                onGenerated={handleGenerated}
                onBusyChange={setBusy}
              />
            ) : null}
          </div>
        </div>
      )}
    />
  );
}
