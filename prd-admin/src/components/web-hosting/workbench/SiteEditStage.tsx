import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, ImagePlus, Library, RefreshCw, RotateCcw, Share2, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listSiteShares } from '@/services';
import type { HostedSite, HostedSiteRevision, ShareLinkItem } from '@/services/real/webPages';
import KnowledgeInlineBrowser from '../KnowledgeInlineBrowser';
import { QuickSharePopover } from '../QuickSharePopover';
import { pickQuickShareLink } from '../quickShare';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  DESIGN_PREVIEW_EVENT_SANDBOX,
  VERIFIED_PACKAGE_PREVIEW_SANDBOX,
  revisionChangeSummary,
  revisionLabel,
  runningGenerationActivity,
} from '../siteEditPreview';
import { formatGenerationClock, runProvenanceText } from '../siteGenerateProgress';
import { DESIGN_ATTACHMENT_ACCEPT, MAX_EDIT_SCREENSHOTS } from '../designAttachments';
import { RUNTIME_CARD_REGISTRY, runtimeCardTitle } from '../siteGenerateOptions';
import {
  GENERATION_STAGES,
  createRevisionMutationIdempotencyKey,
  formatRevisionTime,
  siteEditStageState,
  useSiteEditSession,
} from './useSiteEditSession';
import type { GenerationIntro } from './NewSiteStage';
import {
  AssistantBubble,
  PageSkeleton,
  PreviewPanel,
  RunProgressCard,
  Segmented,
  UserBubble,
  WorkbenchComposer,
  WorkbenchLayout,
  WorkbenchPreview,
  type ComposerChip,
  type PlusMenuItem,
  type WorkbenchPane,
} from './WorkbenchParts';

const MAX_KNOWLEDGE = 3;

/** 对话里一轮修改的结论：用户看得懂的状态，而不是内部枚举。 */
function roundOutcome(revision: HostedSiteRevision): { text: string; tone: 'default' | 'success' | 'warning' } {
  if (revision.isCurrent) return { text: '客户现在看到的就是这一版', tone: 'success' };
  if (revision.status === 'draft') return { text: '草稿，只有你能看到，确认后再发布', tone: 'default' };
  if (revision.status === 'publishing') return { text: '发布没有完成，可以重试发布', tone: 'warning' };
  if (revision.status === 'rejected') return { text: '这版草稿已放弃，线上没有变化', tone: 'default' };
  return { text: '曾经发布过，可以换回这一版', tone: 'default' };
}

export default function SiteEditStage({
  site,
  intro,
  pane,
  onPaneChange,
  onSiteChanged,
  onOpenShareSettings,
  onBusyChange,
}: {
  site: HostedSite;
  intro?: GenerationIntro | null;
  pane: WorkbenchPane;
  onPaneChange: (pane: WorkbenchPane) => void;
  onSiteChanged: (site: HostedSite) => void;
  onOpenShareSettings?: (site: HostedSite) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const session = useSiteEditSession(site, {
    onPublished: onSiteChanged,
    prefillInstructionFromDraft: false,
  });
  const {
    instruction, setInstruction, phase, elapsedSeconds, resolvedModel, thinking,
    previewHtml, previewUrl, previewedRevision, previewFromEvent, revisions, loadingHistory,
    generating, mutatingId, mutatingAction, recentKnowledge, selectedKnowledge, setSelectedKnowledge,
    loadingKnowledge, selectedRuntime, setSelectedRuntime, screenshots, runInfo, activeRunId,
    stopRequested, recoveryNotice, runtimeRecoveryGate, enabledRuntimes, activeRuntime, runtimeFallback,
    screenshotsSupported, addScreenshots, generationStageIndex, openRevision, generate, stopGeneration,
    publish, rollback, reject, retryRecovery, progress,
  } = session;
  const [sheet, setSheet] = useState<'knowledge' | null>(null);
  const [sentInstruction, setSentInstruction] = useState('');
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);
  const [shareLinks, setShareLinks] = useState<ShareLinkItem[]>([]);
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const openedInitialRef = useRef(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { onBusyChange?.(generating); }, [generating, onBusyChange]);

  const loadShares = () => {
    void listSiteShares(false, site.id).then((result) => {
      if (result.success) setShareLinks(result.data.items);
    });
  };
  useEffect(loadShares, [site.id]);

  const ordered = useMemo(
    () => [...revisions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [revisions],
  );
  const liveRevision = revisions.find((item) => item.isCurrent) ?? null;
  const pendingDraft = [...ordered].reverse().find((item) => item.status === 'draft' || item.status === 'publishing') ?? null;
  const view: 'live' | 'draft' = pendingDraft && previewedRevision?.id === pendingDraft.id ? 'draft' : 'live';
  const shareLink = pickQuickShareLink(shareLinks, site.id);

  // 进来先让右边有东西：有待确认的草稿就看草稿，否则看线上版。
  useEffect(() => {
    if (openedInitialRef.current || loadingHistory || generating) return;
    const target = pendingDraft ?? liveRevision;
    if (!target) return;
    openedInitialRef.current = true;
    void openRevision(target.id);
  }, [generating, liveRevision, loadingHistory, openRevision, pendingDraft]);

  // 一轮修改做完（出了新草稿）就清空输入框：那一轮已经作为对话显示在上面了。
  const lastDraftRef = useRef<string | null>(null);
  useEffect(() => {
    const draftId = pendingDraft?.id ?? null;
    if (draftId && draftId !== lastDraftRef.current && !generating && sentInstruction) {
      setInstruction('');
      setSentInstruction('');
      screenshots.reset();
    }
    lastDraftRef.current = draftId;
  }, [generating, pendingDraft?.id, screenshots, sentInstruction, setInstruction]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [generating, revisions.length, recoveryNotice]);

  const send = () => {
    if (!instruction.trim() || generating) return;
    setSentInstruction(instruction.trim());
    void generate();
    onPaneChange('preview');
  };

  const plusItems: PlusMenuItem[] = [
    {
      id: 'knowledge',
      title: '引用知识库',
      description: `改的时候对照知识库里的稿子，最多 ${MAX_KNOWLEDGE} 篇`,
      icon: Library,
      onPick: () => { setSheet('knowledge'); onPaneChange('preview'); },
    },
    {
      id: 'screenshot',
      title: '附上截图',
      description: '把要改的地方截图圈出来，也可以直接在输入框里粘贴',
      icon: ImagePlus,
      onPick: () => screenshotInputRef.current?.click(),
      disabledReason: !screenshotsSupported
        ? '截图需要「精细」方式；在输入框下面切到精细后可用'
        : screenshots.items.length >= MAX_EDIT_SCREENSHOTS
          ? `最多 ${MAX_EDIT_SCREENSHOTS} 张，先移除一张`
          : undefined,
    },
  ];

  const chips: ComposerChip[] = [
    ...selectedKnowledge.map((entry) => ({
      key: `kb-${entry.entryId}`,
      label: entry.title,
      status: '知识库',
      onRemove: () => setSelectedKnowledge(selectedKnowledge.filter((item) => item.entryId !== entry.entryId)),
    })),
    ...screenshots.items.map((item) => ({
      key: item.key,
      label: item.fileName,
      status: !screenshotsSupported
        ? '快速方式不带截图'
        : item.status === 'uploading'
          ? `上传 ${item.progress}%`
          : item.status === 'ready' ? '截图' : item.status === 'failed' ? item.error || '失败' : '保存中',
      tone: item.status === 'failed' ? 'danger' as const : item.status === 'ready' ? 'default' as const : 'busy' as const,
      onRemove: () => screenshots.remove(item.key),
    })),
  ];

  const requestRuntime = enabledRuntimes.find((item) => item.id === selectedRuntime) ?? enabledRuntimes[0];
  const runtimeCopy = requestRuntime ? RUNTIME_CARD_REGISTRY[requestRuntime.id] : undefined;
  const sendBlocker = !requestRuntime
    ? '没有可用的设计执行器，请联系管理员检查部署状态'
    : screenshots.busy ? '截图还在上传，传完就能生成' : '';

  const steps = GENERATION_STAGES.map((stage, index) => {
    const { complete, current } = siteEditStageState(index, generationStageIndex, generating, progress);
    return { key: stage.label, label: stage.label, state: complete ? 'done' as const : current ? 'active' as const : 'todo' as const };
  });

  const roundBubbles = ordered.map((revision, index) => {
    const outcome = roundOutcome(revision);
    const isFirst = index === 0;
    const showIntro = isFirst && intro;
    const previewing = previewedRevision?.id === revision.id;
    const canRollback = revision.status === 'published' && !revision.isCurrent;
    return (
      <div key={revision.id} className="flex flex-col gap-2">
        {showIntro ? (
          <UserBubble text={intro.request} chips={intro.chips} />
        ) : revision.source === 'ai-edit' && revision.instruction ? (
          <UserBubble text={revision.instruction} chips={revision.knowledgeEntryIds.length > 0 ? [`引用了 ${revision.knowledgeEntryIds.length} 篇知识`] : undefined} />
        ) : null}
        <AssistantBubble tone={outcome.tone}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold">
                {showIntro
                  ? `网页已生成，用时 ${intro.durationText}`
                  : isFirst ? '最初的版本' : revisionLabel(revision)}
              </p>
              <p className="text-[12px] text-token-secondary">
                {showIntro
                  ? `${intro.runtimeLabel}${intro.styleName ? ` · 风格：${intro.styleName}` : ''}。已存进网页托管，只有你能看到；满意就点右上角「发布给客户」，不满意直接说想改哪里。`
                  : `${outcome.text}。${revision.source === 'ai-edit' ? revisionChangeSummary(revision, null) : ''}`}
              </p>
              <p className="mt-0.5 text-[11px] text-token-muted">{formatRevisionTime(revision.publishedAt || revision.createdAt)}</p>
            </div>
            <button
              type="button"
              onClick={() => { void openRevision(revision.id); onPaneChange('preview'); }}
              disabled={previewing}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-token-secondary hover-bg-soft disabled:opacity-50"
            >
              {previewing ? '正在看' : '看这版'}
            </button>
          </div>
          {canRollback && (confirmRollbackId === revision.id ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg p-2" style={{ background: 'var(--bg-card)' }}>
              <span className="text-[12px] text-token-secondary">确认换回？客户打开同一个链接会看到这一版，现有版本都会保留。</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmRollbackId(null);
                  void rollback(revision.id, createRevisionMutationIdempotencyKey());
                }}
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] font-semibold"
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
              >
                <RotateCcw size={12} />确认换回
              </button>
              <button type="button" onClick={() => setConfirmRollbackId(null)} className="h-8 rounded-lg px-2 text-[12px] text-token-secondary hover-bg-soft">取消</button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRollbackId(revision.id)}
              disabled={mutatingId !== null}
              className="inline-flex items-center gap-1 self-start text-[12px] text-token-secondary underline-offset-2 hover:underline disabled:opacity-50"
            >
              {mutatingId === revision.id && mutatingAction === 'rollback' ? <MapSpinner size={12} /> : <RotateCcw size={12} />}
              换回这一版
            </button>
          ))}
        </AssistantBubble>
      </div>
    );
  });

  const recoveryLabel = runtimeRecoveryGate
    ? `正在回收运行环境，已检查 ${runtimeRecoveryGate.checks + 1} 次`
    : recoveryNotice?.action === 'publish' ? '重试发布'
      : recoveryNotice?.action === 'rollback' ? '重试换回'
        : recoveryNotice?.action === 'reject' ? '重试放弃草稿'
          : recoveryNotice?.action === 'history' ? '刷新版本记录'
            : recoveryNotice?.action === 'preview' ? '重新打开这一版'
              : '按原要求重试';

  const conversation = (
    <>
      {loadingHistory && revisions.length === 0 && (
        <AssistantBubble><p className="flex items-center gap-2 text-[12px] text-token-secondary"><MapSpinner size={12} />正在读取这个网页的修改记录</p></AssistantBubble>
      )}
      {roundBubbles}
      {generating && (
        <>
          {sentInstruction && <UserBubble text={sentInstruction} />}
          <RunProgressCard
            title="正在修改，先出草稿"
            clock={formatGenerationClock(elapsedSeconds)}
            runtimeLabel={activeRuntime ? runtimeCardTitle(activeRuntime) : undefined}
            resolvedModel={resolvedModel}
            provenance={runProvenanceText(runInfo)}
            steps={steps}
            activity={runningGenerationActivity(phase, elapsedSeconds)}
            thinking={thinking}
            onStop={() => void stopGeneration()}
            stopRequested={stopRequested}
            canStop={Boolean(activeRunId)}
            stopHint="线上版本不变，客户看到的还是原来那版；可以关掉窗口，回来接着看。"
          />
        </>
      )}
      {recoveryNotice && (
        <AssistantBubble tone="warning">
          <p className="font-semibold">{recoveryNotice.title}</p>
          <p className="text-[12px] text-token-secondary">{recoveryNotice.detail}</p>
          <button
            type="button"
            onClick={retryRecovery}
            disabled={generating || mutatingId !== null || runtimeRecoveryGate !== null}
            className="inline-flex h-9 items-center gap-1.5 self-start rounded-lg px-3 text-[12px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
          >
            <RefreshCw size={12} className={runtimeRecoveryGate ? 'animate-spin motion-reduce:animate-none' : ''} />{recoveryLabel}
          </button>
        </AssistantBubble>
      )}
      {runtimeFallback && !generating && (
        <p className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>{runtimeFallback}</p>
      )}
      <div ref={conversationEndRef} />
    </>
  );

  const composer = (
    <>
      <WorkbenchComposer
        id={`workbench-edit-instruction-${site.id}`}
        value={instruction}
        onChange={setInstruction}
        placeholder="想改哪里？比如「把首屏标题改短」「第三块换成表格」"
        disabled={generating}
        plusItems={plusItems}
        chips={chips}
        onPaste={(event) => {
          if (!screenshotsSupported) return;
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
          if (files.length === 0) return;
          event.preventDefault();
          addScreenshots(files);
        }}
        options={enabledRuntimes.length > 1 ? (
          <Segmented
            label="修改方式"
            value={requestRuntime?.id ?? ''}
            disabled={generating}
            onChange={setSelectedRuntime}
            options={enabledRuntimes.map((item) => ({
              value: item.id,
              label: runtimeCardTitle(item).replace('生成', '').replace('设计', ''),
              title: RUNTIME_CARD_REGISTRY[item.id]?.description ?? item.label,
            }))}
          />
        ) : undefined}
        sendLabel={generating ? '正在修改…' : '生成修改草稿 · 线上不变'}
        sendDisabled={generating || !instruction.trim() || Boolean(sendBlocker)}
        sendDisabledReason={generating ? undefined : sendBlocker || '先写一句想改哪里'}
        onSend={send}
        hint={`只改你点名的地方，其余逐字保留；先出草稿，确认后再发布。${runtimeCopy ? runtimeCopy.footnote : ''}`}
      />
      <input
        ref={screenshotInputRef}
        type="file"
        multiple
        accept={DESIGN_ATTACHMENT_ACCEPT.image}
        className="hidden"
        onChange={(event) => {
          addScreenshots(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );

  const draftId = pendingDraft?.id ?? null;
  const pickingKnowledge = sheet === 'knowledge' && !generating;
  const previewTitle = generating
    ? '正在修改'
    : view === 'draft' ? '草稿' : previewedRevision && !previewedRevision.isCurrent ? revisionLabel(previewedRevision) : '线上版';
  const previewNote = generating
    ? '线上版本不变，客户看到的还是原来那版'
    : view === 'draft'
      ? '只有你能看到；发布后客户打开同一个链接就是这一版'
      : shareLink ? '客户打开分享链接看到的就是这一版' : '已存进网页托管，还没有发给客户';
  const nextHint = generating
    ? '修改写好一段就显示一段；做好后这里可以在「线上版」「草稿」之间切换对比。'
    : view === 'draft'
      ? '满意就点「发布这版」，旧版留在对话里可随时换回；不满意继续在左边说，或点「放弃草稿」。'
      : draftId
        ? '有一版草稿还没发布：切到「草稿」看改了什么。'
        : shareLink
          ? '继续在左边说想改哪里，先出草稿，确认后再发布；分享链接不用重发。'
          : '满意就点「发布给客户」，拿到链接和二维码；不满意直接在左边说想改哪里。';

  const toolbar = draftId && !generating ? (
    <Segmented
      label="对比线上版与草稿"
      value={view}
      onChange={(next) => {
        const target = next === 'draft' ? draftId : liveRevision?.id;
        if (target) void openRevision(target);
      }}
      options={[{ value: 'live', label: '线上版' }, { value: 'draft', label: '草稿' }]}
    />
  ) : null;

  const actions = (
    <>
      {view === 'draft' && draftId && !generating && (
        <>
          <button
            type="button"
            onClick={() => {
              void reject(draftId, '').then(() => { if (liveRevision) void openRevision(liveRevision.id); });
            }}
            disabled={mutatingId !== null}
            className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[13px] text-token-secondary hover-bg-soft disabled:opacity-50"
            style={{ border: '1px solid var(--border-default)' }}
          >
            {mutatingId === draftId && mutatingAction === 'reject' ? <MapSpinner size={12} /> : <X size={13} />}
            放弃草稿
          </button>
          <button
            type="button"
            onClick={() => void publish(draftId)}
            disabled={mutatingId !== null}
            className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
          >
            {mutatingId === draftId && mutatingAction === 'publish' ? <MapSpinner size={12} /> : <Check size={13} />}
            {pendingDraft?.status === 'publishing' ? '重试发布' : '发布这版'}
          </button>
        </>
      )}
      {view === 'live' && (
        <>
          {site.siteUrl && (
            <a
              href={site.siteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-[13px] text-token-secondary hover-bg-soft"
            >
              <ExternalLink size={13} />新窗口打开
            </a>
          )}
          <button
            type="button"
            onClick={(event) => setShareAnchor(event.currentTarget)}
            className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold"
            style={shareLink
              ? { border: '1px solid var(--border-default)', color: 'var(--text-primary)' }
              : { background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
          >
            <Share2 size={13} />
            {shareLink ? '分享链接' : '发布给客户'}
          </button>
        </>
      )}
    </>
  );

  const frameSandbox = previewUrl ? VERIFIED_PACKAGE_PREVIEW_SANDBOX : previewFromEvent ? DESIGN_PREVIEW_EVENT_SANDBOX : AI_STREAM_PREVIEW_SANDBOX;
  const preview = (
    <>
      <WorkbenchPreview
        title={pickingKnowledge ? '引用知识库' : previewTitle}
        note={pickingKnowledge ? `改的时候对照这些稿子，最多 ${MAX_KNOWLEDGE} 篇；放入后左边输入框上方会列出来` : previewNote}
        nextHint={pickingKnowledge ? '选好点右上角「放入」，这里换回网页预览。' : nextHint}
        toolbar={pickingKnowledge ? null : toolbar}
        actions={pickingKnowledge ? (
          <button
            type="button"
            onClick={() => setSheet(null)}
            className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-semibold"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
          >
            {selectedKnowledge.length > 0 ? `放入 ${selectedKnowledge.length} 篇` : '完成'}
          </button>
        ) : actions}
      >
        {pickingKnowledge ? (
          <PreviewPanel>
            <KnowledgeInlineBrowser
              recentEntries={recentKnowledge}
              loadingRecent={loadingKnowledge}
              selectedEntries={selectedKnowledge}
              onChange={setSelectedKnowledge}
              onLimitReached={() => toast.info(`最多引用 ${MAX_KNOWLEDGE} 篇`, '取消一篇后再选')}
            />
          </PreviewPanel>
        ) : previewHtml || previewUrl ? (
          <iframe
            key={`${previewUrl ? 'url' : 'doc'}-${frameSandbox}`}
            src={previewUrl || undefined}
            srcDoc={previewUrl ? undefined : previewHtml}
            sandbox={frameSandbox}
            referrerPolicy="no-referrer"
            title={previewedRevision ? `${revisionLabel(previewedRevision)}预览` : '网页预览'}
            className="h-full w-full bg-white"
          />
        ) : (
          <PageSkeleton caption={generating ? '正在找要改的位置，写好的部分会先显示在这里' : '正在打开这个网页'} />
        )}
      </WorkbenchPreview>
      {shareAnchor && (
        <QuickSharePopover
          anchorEl={shareAnchor}
          site={{ id: site.id, title: site.title }}
          links={shareLinks}
          onClose={() => setShareAnchor(null)}
          onLinksChanged={loadShares}
          onOpenAdvanced={() => {
            setShareAnchor(null);
            if (onOpenShareSettings) onOpenShareSettings(site);
            else toast.info('高级分享设置在网页托管列表里', '关掉工作台后在网页卡片上点「分享」');
          }}
        />
      )}
    </>
  );

  return <WorkbenchLayout pane={pane} conversation={conversation} composer={composer} preview={preview} />;
}
