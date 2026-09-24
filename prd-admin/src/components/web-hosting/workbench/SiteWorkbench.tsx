import { useCallback, useEffect, useState } from 'react';
import { Settings2, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
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
  onOpenSettings?: () => void;
  onOpenShareSettings?: (site: HostedSite) => void;
}) {
  const [pane, setPane] = useState<WorkbenchPane>('chat');
  const [site, setSite] = useState<HostedSite | null>(target.kind === 'site' ? target.site : null);
  const [intro, setIntro] = useState<GenerationIntro | null>(null);
  const [loadingSite, setLoadingSite] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 每次打开换一把钥匙：两个阶段都重新挂载，上一轮的状态不会漏进这一轮。 */
  const [session, setSession] = useState(0);

  useEffect(() => {
    if (!open) return;
    setSession((current) => current + 1);
    setPane('chat');
    setIntro(null);
    setSite(target.kind === 'site' ? target.site : null);
    // 只在打开那一刻快照目标；打开期间列表刷新带来的新对象由 onSiteChanged 回写。
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerated = useCallback((siteId: string, generatedIntro: GenerationIntro) => {
    onCreated?.(siteId);
    setIntro(generatedIntro);
    setLoadingSite(true);
    void getSite(siteId).then((result) => {
      setLoadingSite(false);
      if (!result.success) {
        toast.error('网页已生成，但没能打开修改', result.error?.message || '关掉后在网页托管列表里点「帮我修改」');
        return;
      }
      setSite(result.data);
    });
  }, [onCreated]);

  const handleSiteChanged = useCallback((updated: HostedSite) => {
    setSite(updated);
    onSiteChanged?.(updated);
  }, [onSiteChanged]);

  const title = site ? site.title : '生成网页';
  const subtitle = site
    ? busy ? '正在修改 · 线上不变' : '说想改哪里，先出草稿再发布'
    : busy ? '正在生成 · 可以关掉窗口，回来接着看' : '放资料、说要求，右边先看效果';

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
        <div data-testid="site-workbench" className="h-full min-h-0" style={{ minHeight: 0 }}>
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
      )}
    />
  );
}
