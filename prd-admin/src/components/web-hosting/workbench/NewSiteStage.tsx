import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Library, PanelsTopLeft, Upload } from 'lucide-react';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  getDesignGenerationSettings,
  getDesignRuntimeCapabilities,
  getDesignTimingStats,
  getSiteContent,
  type DesignGenerationStyle,
  type DesignArtifactRunSummary,
  type DesignRuntimeCapability,
  type DesignTimingStats,
} from '@/services/real/webPages';
import KnowledgeInlineBrowser from '../KnowledgeInlineBrowser';
import { AI_STREAM_PREVIEW_SANDBOX, previewableAiStreamHtml, REQUIRED_WEB_PAGE_RUNTIME, displayedDesignRuntime, requiredWebPageRuntime } from '../siteEditPreview';
import {
  formatGenerationClock,
  formatCompletedRunDuration,
  pickGenerationTiming,
  remainingEstimateText,
  runProvenanceText,
  TIMING_STATS_TIMEOUT_MS,
  type TimingStatsState,
} from '../siteGenerateProgress';
import {
  DESIGN_ATTACHMENT_ACCEPT,
  DESIGN_ATTACHMENT_DESCRIPTION,
  MAX_GENERATE_ATTACHMENTS,
  recordedDesignAttachments,
  sentDesignAttachments,
  useDesignAttachmentUploads,
  type DesignAttachmentItem,
} from '../designAttachments';
import { runtimeCardTitle, titleFromFileName } from '../siteGenerateOptions';
import { useSiteGenerationRun } from './useSiteGenerationRun';
import { missingRuntimeBlocker } from './outputForm';
import { PersonalStyleDialog } from './PersonalStyleDialog';
import { DESIGN_SYSTEM_KEY_PREFIX, presetSelection, selectionStyleId, type StyleGallerySelection } from './StyleGallery';
import { StyleThumbnail } from './StyleThumbnail';
import {
  AssistantBubble,
  ComposerSheet,
  PageSkeleton,
  PreviewPanel,
  RunProgressCard,
  UserBubble,
  WorkbenchComposer,
  WorkbenchLayout,
  WorkbenchPreview,
  type ComposerChip,
  type PlusMenuItem,
  type WorkbenchPane,
} from './WorkbenchParts';

/** 知识库的一篇稿子，从知识库页「做成网页」带进来时预先放好。 */
export interface WorkbenchSource {
  entryId: string;
  storeId: string;
  title: string;
  storeName?: string;
}

/** 生成完成后交给修改阶段的那一轮对话，好让「继续修改」接在同一段对话下面。 */
export interface GenerationIntro {
  request: string;
  chips: string[];
  attachments?: DesignAttachmentItem[];
  durationText: string;
  runtimeLabel: string;
  styleName?: string | null;
  preview?: { html: string; sandbox: string };
}

const MAX_KNOWLEDGE = 3;
const DEFAULT_REQUEST = '把这些资料做成一个清晰好读、适合发给客户看的网页';
const REFERENCE_EXAMPLE_REQUEST = '把知识库文章做成一页给团队阅读的指南。开头用一句话说明读者能解决什么问题，正文按原文梳理步骤和常见问题，保留关键术语、数字和出处。借鉴参考网页的配色、字体和版式，在手机上也要好读。';

const frozenMaterials = (record?: DesignArtifactRunSummary | null) => [
  ...(record?.knowledgeReferences ?? []).map((entry) => `知识库 · ${entry.title}`),
  ...(record?.referenceSiteTitle ? [`风格参考 · ${record.referenceSiteTitle}`] : []),
];

export default function NewSiteStage({
  source,
  destinationTeamId,
  pane,
  onPaneChange,
  onGenerated,
  onBusyChange,
}: {
  source?: WorkbenchSource | null;
  destinationTeamId?: string | null;
  pane: WorkbenchPane;
  onPaneChange: (pane: WorkbenchPane) => void;
  onGenerated: (siteId: string, intro: GenerationIntro) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(true);
  const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeEntrySelection[]>(() => (source ? [{
    entryId: source.entryId,
    storeId: source.storeId,
    title: source.title,
    storeName: source.storeName || '当前知识库',
  }] : []));
  const uploads = useDesignAttachmentUploads('document', MAX_GENERATE_ATTACHMENTS);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replacingRef = useRef<string | null>(null);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [runtimesLoaded, setRuntimesLoaded] = useState(false);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [styles, setStyles] = useState<DesignGenerationStyle[]>([]);
  /** 本部署最近 30 天的真实耗时；拿不到就是 null，预估退回经验值并明说。 */
  const [timingStats, setTimingStats] = useState<DesignTimingStats | null>(null);
  // 统计请求的状态单独记：还在读、读到了、读不到三者文案不同；读不到不许冒充还在积累，
  // 卡住的请求也不许让「正在读取」一直挂着——请求有上限，超时即按读不到处理。
  const [timingState, setTimingState] = useState<TimingStatsState>('loading');
  /** 选中的风格：管理员预设（按 styleId 冻结）或目录里的设计系统（按 designSystemId 冻结）。 */
  const [styleSelection, setStyleSelection] = useState<StyleGallerySelection | null>(null);
  const [referenceSite, setReferenceSite] = useState<{ id: string; title: string } | null>(null);
  const [referencePreview, setReferencePreview] = useState<{ siteId: string; html: string } | null>(null);
  const [referencePreviewAttempt, setReferencePreviewAttempt] = useState(0);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [showReferenceExample, setShowReferenceExample] = useState(false);
  const [sheet, setSheet] = useState<'knowledge' | 'notes' | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  /** 已发出去的那一条（对话里的用户气泡）；失败后输入框里的内容原样保留，可直接再发。 */
  const [sent, setSent] = useState<(Omit<GenerationIntro, 'request' | 'durationText' | 'preview'> & { text: string }) | null>(null);
  const handedOffRef = useRef(false);
  const run = useSiteGenerationRun({
    destinationTeamId,
    hasInitialSource: Boolean(source),
    initialEntryId: source?.entryId,
    onCreated: () => { /* 完成后由下面的 effect 交给修改阶段 */ },
  });
  const { reset: resetRun } = run;

  const referenceSiteId = referenceSite?.id;
  useEffect(() => {
    if (!referenceSiteId) return;
    let current = true;
    void getSiteContent(referenceSiteId).then((result) => {
      if (!current) return;
      const raw = result.success ? result.data.html : '';
      const html = raw.trim() ? previewableAiStreamHtml(raw) || previewableAiStreamHtml(`<html><body>${raw}</body></html>`) : '';
      setReferencePreview({ siteId: referenceSiteId, html });
    }).catch(() => { if (current) setReferencePreview({ siteId: referenceSiteId, html: '' }); });
    return () => { current = false; };
  }, [referenceSiteId, referencePreviewAttempt]);

  useEffect(() => {
    let active = true;
    void getDesignRuntimeCapabilities().then((runtimes) => {
      if (active && runtimes.success) setCapabilities(runtimes.data.runtimes);
    }).catch(() => { /* 连接失败时保留资料，由对话消息提供重试入口。 */ }).finally(() => {
      if (active) setRuntimesLoaded(true);
    });
    return () => { active = false; };
  }, [runtimeAttempt]);

  useEffect(() => {
    resetRun();
    let active = true;
    void Promise.all([
      listRecentDocumentEntries(16),
      getDesignGenerationSettings(),
    ]).then(([recent, settings]) => {
      if (!active) return;
      const items = recent.success ? [...recent.data.items] : [];
      if (source && !items.some((item) => item.id === source.entryId)) {
        items.unshift({
          id: source.entryId,
          storeId: source.storeId,
          storeName: source.storeName || '当前知识库',
          title: source.title,
          contentType: 'text/markdown',
          tags: [],
          createdAt: '',
          updatedAt: '',
          isNew: false,
        });
      }
      setRecentKnowledge(items);
      if (settings.success) {
        const enabled = settings.data.styles.filter((style) => style.enabled);
        setStyles(enabled);
        const preferred = enabled.find((style) => style.isDefault) ?? enabled[0];
        setStyleSelection((current) => current ?? (preferred ? presetSelection(preferred) : null));
      } else {
        // 读不到预设就不预选：服务端会用设置里的默认风格，右边样张说明拿不到。
        setStyles([]);
      }
      setLoadingKnowledge(false);
    });
    return () => { active = false; };
    // 只在进入工作台时跑一次：来源与目标空间在打开那一刻冻结。
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onBusyChange?.(run.generating); }, [onBusyChange, run.generating]);
  useEffect(() => {
    if (run.notice?.tone === 'error') onPaneChange('chat');
  }, [onPaneChange, run.notice]);

  // 真实耗时只影响「预计多久」这句话，单独取、不挡资料与执行器的加载。
  useEffect(() => {
    let active = true;
    void getDesignTimingStats(TIMING_STATS_TIMEOUT_MS)
      .then((res) => {
        if (!active) return;
        if (res.success) { setTimingStats(res.data); setTimingState('ready'); return; }
        setTimingState('unavailable');
        console.warn('[web-pages] 生成耗时统计取不到，预估退回经验值', res.error?.code, res.error?.message);
      })
      .catch((error) => {
        if (!active) return;
        setTimingState('unavailable');
        console.warn('[web-pages] 生成耗时统计请求失败，预估退回经验值', error);
      });
    return () => { active = false; };
  }, []);

  const requestRuntime = useMemo(
    () => requiredWebPageRuntime(capabilities, 'generate'),
    [capabilities],
  );
  const visibleRuntime = displayedDesignRuntime(
    capabilities,
    requestRuntime?.id ?? REQUIRED_WEB_PAGE_RUNTIME,
    run.generating ? run.activeRunRuntime : null,
  );
  const selectedStyle = styleSelection?.kind === 'preset'
    ? styles.find((style) => style.id === styleSelection.styleId) ?? null
    : null;
  /** 样张标题：资料放进来后先换成资料的标题，让用户预判成品。 */
  const sampleTitle = selectedKnowledge[0]?.title
    || titleFromFileName(uploads.items.find((item) => item.status !== 'failed')?.fileName ?? '')
    || undefined;
  const hasSources = selectedKnowledge.length > 0 || uploads.readyIds.length > 0;
  const failedRun = run.failedRun;
  const savedRequest = failedRun?.retryInstruction;
  const failedMaterials = frozenMaterials(failedRun);
  const activeTiming = pickGenerationTiming(timingStats, run.activeRunRuntime);

  // 生成完成：把这一轮对话交给修改阶段，同一个窗口里接着说「想改哪里」。
  useEffect(() => {
    const done = run.completedSite;
    if (!done || handedOffRef.current) return;
    handedOffRef.current = true;
    onGenerated(done.id, {
      request: sent?.text || run.recoveredRun?.instruction || run.recoveredTitle || '生成网页',
      chips: sent?.chips ?? frozenMaterials(run.recoveredRun),
      attachments: sent?.attachments ?? recordedDesignAttachments(run.recoveredRun?.uploadedSources),
      durationText: formatCompletedRunDuration(done.durationSeconds),
      runtimeLabel: sent?.runtimeLabel || (visibleRuntime ? runtimeCardTitle(visibleRuntime) : '设计执行器'),
      styleName: run.runInfo?.styleName ?? sent?.styleName,
      preview: run.previewHtml ? { html: run.previewHtml, sandbox: run.previewSandbox } : undefined,
    });
  }, [onGenerated, run.completedSite, run.previewHtml, run.previewSandbox, run.recoveredRun, run.recoveredTitle, run.runInfo?.styleName, sent, visibleRuntime]);

  const openFilePicker = (replaceKey: string | null = null) => {
    replacingRef.current = replaceKey;
    fileInputRef.current?.click();
  };

  const addNotes = () => {
    const text = notesDraft.trim();
    if (!text) return;
    // 粘贴的纪要按一篇 Markdown 附件上传，和拖进来的文件走同一条路，服务端同样当作事实来源。
    const index = uploads.items.filter((item) => item.fileName.startsWith('会议纪要')).length + 1;
    uploads.addFiles([new File([text], `会议纪要-${index}.md`, { type: 'text/markdown' })]);
    setNotesDraft('');
    setSheet(null);
  };

  const materialChips: ComposerChip[] = [
    ...selectedKnowledge.map((entry) => ({
      key: `kb-${entry.entryId}`,
      label: entry.title,
      status: '知识库',
      icon: Library,
      onRemove: () => setSelectedKnowledge((current) => current.filter((item) => item.entryId !== entry.entryId)),
    })),
  ];

  const plusItems: PlusMenuItem[] = [
    {
      id: 'upload',
      title: '上传文件',
      description: DESIGN_ATTACHMENT_DESCRIPTION.document,
      onPick: () => openFilePicker(),
      icon: Upload,
      disabledReason: uploads.items.length >= MAX_GENERATE_ATTACHMENTS ? `已放入 ${MAX_GENERATE_ATTACHMENTS} 个文件，先移除一个` : undefined,
    },
    {
      id: 'knowledge',
      title: '引用知识库',
      description: `从我的或团队知识库挑，最多 ${MAX_KNOWLEDGE} 篇；稿子更新后可一键重生成`,
      icon: Library,
      onPick: () => { setSheet('knowledge'); onPaneChange('preview'); },
    },
    {
      id: 'reference',
      title: '参考网页',
      description: '从网页托管选择 HTML 网页，借鉴排版和风格',
      icon: PanelsTopLeft,
      onPick: () => { setSheet(null); setReferencePickerOpen(true); },
    },
    {
      id: 'notes',
      title: '粘贴会议纪要或通话记录',
      description: '直接贴文字，不用先存成文件',
      icon: ClipboardList,
      onPick: () => setSheet('notes'),
      disabledReason: uploads.items.length >= MAX_GENERATE_ATTACHMENTS ? `已放入 ${MAX_GENERATE_ATTACHMENTS} 个文件，先移除一个` : undefined,
    },
  ];

  const sendBlocker = uploads.busy
    ? '上传和读取完成后可发送'
    : uploads.hasFailed
      ? '请处理或移除失败的附件后再发送'
      : !requestRuntime
        ? missingRuntimeBlocker(runtimesLoaded)
        : !hasSources ? '添加至少一份资料后即可生成' : '';

  const restoreInputs = () => {
    if (!failedRun || !savedRequest) return;
    setInstruction(savedRequest);
    setSelectedKnowledge(failedRun.knowledgeReferences.flatMap((entry): KnowledgeEntrySelection[] =>
      entry.storeId ? [{ ...entry, storeId: entry.storeId, storeName: entry.storeName || '知识库' }] : []));
    uploads.reset();
    uploads.restoreReady(failedRun.uploadedSources ?? []);
    const { styleId, designSystemId, styleName: savedStyleName, referenceSiteId, referenceSiteTitle } = failedRun;
    setReferenceSite(referenceSiteId && referenceSiteTitle ? { id: referenceSiteId, title: referenceSiteTitle } : null);
    if (!referenceSiteId && designSystemId) {
      const name = savedStyleName || '默认风格';
      if (!styleId || styleId.startsWith(DESIGN_SYSTEM_KEY_PREFIX)) {
        setStyleSelection({ kind: 'design-system', key: `${DESIGN_SYSTEM_KEY_PREFIX}${designSystemId}`, designSystemId, name });
      } else if (styleId.startsWith('personal:')) {
        setStyleSelection({ kind: 'personal', key: styleId, styleId, designSystemId, name, swatches: [] });
      } else {
        setStyleSelection({ kind: 'preset', key: styleId, styleId, designSystemId, name });
      }
    }
    document.getElementById('workbench-new-instruction')?.focus();
  };

  const send = () => {
    if (!requestRuntime || sendBlocker || run.generating) return;
    const text = instruction.trim() || DEFAULT_REQUEST;
    const title = selectedKnowledge[0]?.title
      || titleFromFileName(uploads.items.find((item) => item.status === 'ready')?.fileName ?? '');
    const chips = [
      ...selectedKnowledge.map((entry) => `知识库 · ${entry.title}`),
      ...(referenceSite ? [`风格参考 · ${referenceSite.title}`] : []),
    ];
    setSent({ text, chips, attachments: sentDesignAttachments(uploads.items), runtimeLabel: runtimeCardTitle(requestRuntime), styleName: referenceSite?.title ?? styleSelection?.name });
    handedOffRef.current = false;
    void run.start({
      instruction: text,
      title,
      sourceSurface: source ? 'knowledge-base' : 'web-hosting',
      knowledge: selectedKnowledge,
      styleId: selectionStyleId(styleSelection),
      referenceSiteId: referenceSite?.id,
      designSystemId: styleSelection?.kind === 'design-system' ? styleSelection.designSystemId : null,
      attachmentIds: uploads.readyIds,
    });
    onPaneChange('preview');
  };

  const stages = run.stages;
  const steps = stages.map((stage, index) => ({
    key: `${stage.label}-${index}`,
    label: stage.label,
    state: stage.endedAtMs == null && run.generating ? 'active' as const : 'done' as const,
  }));
  const composing = !run.generating && !sent && !run.notice;
  // 随着运行阶段增长，让聊天流滚到最新一条。
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [run.generating, steps.length, run.notice, sent]);
  const styleName = styleSelection?.name ?? '默认风格';
  const canLoadOriginalInputs = !instruction && uploads.items.length === 0 && !referenceSite
    && selectedKnowledge.length === (source ? 1 : 0)
    && (!source || selectedKnowledge[0]?.entryId === source.entryId);
  const retry = () => {
    setSheet(null);
    handedOffRef.current = false;
    if (savedRequest) setSent({
      text: savedRequest,
      chips: failedMaterials,
      attachments: sent?.attachments ?? recordedDesignAttachments(failedRun?.uploadedSources),
      runtimeLabel: visibleRuntime ? runtimeCardTitle(visibleRuntime) : '设计执行器',
      styleName: failedRun?.styleName,
    });
    void run.restart();
  };

  const conversation = (
    <>
      {composing && (
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-[var(--accent-primary)]">网页生成助手</p>
          <p className="text-[14px] leading-relaxed text-token-primary">
            想做什么网页？说说给谁看，再把要用的资料加进来。
          </p>
        </div>
      )}
      {composing && (
        <div className="flex flex-wrap gap-1.5" aria-label="常用要求">
          <button
            type="button"
            onClick={() => {
              if (!instruction.trim()) setInstruction(REFERENCE_EXAMPLE_REQUEST);
              setShowReferenceExample(true);
              setSheet('knowledge');
              onPaneChange('preview');
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-token-secondary hover-bg-soft"
            style={{ border: '1px solid var(--border-default)' }}
          >
            <PanelsTopLeft size={13} />知识库文章＋网页风格示例
          </button>
        </div>
      )}
      {composing && showReferenceExample && !referenceSite && selectedKnowledge.length > 0 && sheet !== 'knowledge' && (
        <p className="text-[13px] text-token-secondary">接下来点「＋」里的「参考网页」，选择你想借鉴的风格。</p>
      )}
      {(runtimesLoaded || runtimeAttempt > 0) && !requestRuntime && !run.generating && !run.notice && (
        <AssistantBubble tone="warning">
          <p role="status">{runtimesLoaded ? '设计服务暂时不可用。你可以继续准备资料，服务恢复后再发送。' : '正在重新检测设计服务…'}</p>
          <button
            type="button"
            disabled={!runtimesLoaded}
            onClick={() => { setRuntimesLoaded(false); setRuntimeAttempt((attempt) => attempt + 1); }}
            className="min-h-8 self-start rounded-md px-2 text-[12px] font-semibold hover-bg-soft disabled:opacity-50"
          >
            重试连接
          </button>
        </AssistantBubble>
      )}
      {!sent && run.generating && (
        <UserBubble
          text={run.recoveredRun?.instruction || (run.recoveredTitle ? `接着看：${run.recoveredTitle}` : '接着看上次没跑完的生成')}
          chips={frozenMaterials(run.recoveredRun)}
          attachments={recordedDesignAttachments(run.recoveredRun?.uploadedSources)}
        />
      )}
      {sent && <UserBubble text={sent.text} chips={sent.chips} attachments={sent.attachments} />}
      {!sent && savedRequest && <UserBubble text={savedRequest} chips={failedMaterials} attachments={recordedDesignAttachments(failedRun?.uploadedSources)} />}
      {run.generating && (
        <RunProgressCard
          title="正在生成网页"
          clock={formatGenerationClock(run.elapsedSeconds)}
          estimate={remainingEstimateText(run.activeRunRuntime, run.elapsedSeconds, activeTiming, timingState)}
          runtimeLabel={visibleRuntime ? runtimeCardTitle(visibleRuntime) : undefined}
          resolvedModel={run.resolvedModel}
          provenance={runProvenanceText(run.runInfo)}
          steps={steps.length > 0 ? steps : [{ key: 'start', label: '正在提交资料', state: 'active' }]}
          activity={`${run.phase || '正在准备'}${run.lastEventAtMs ? ` · 最近一次回应 ${Math.max(0, Math.round((Date.now() - run.lastEventAtMs) / 1000))} 秒前` : ''}`}
          stopHint="可以关掉窗口，任务在服务器上继续；重新打开「生成网页」会接着显示进度。"
        />
      )}
      {run.notice && (
        <AssistantBubble tone="warning">
          <p className="font-semibold" role="status">{run.notice.tone === 'error' ? '网页生成未完成' : '说明'}</p>
          <p className="text-[12px] text-token-secondary">{run.notice.text}</p>
          {run.restartableRunId && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={retry}
                disabled={!requestRuntime}
                className="inline-flex min-h-9 items-center rounded-lg px-3 text-[12px] font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2"
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
              >
                用原资料和要求重试
              </button>
              {canLoadOriginalInputs && (
                <button type="button" onClick={restoreInputs} className="min-h-9 rounded-lg px-2 text-[12px] font-medium text-token-primary hover-bg-soft">
                  载入原资料和要求编辑
                </button>
              )}
              {!requestRuntime && <p className="w-full text-[12px] text-token-secondary">{missingRuntimeBlocker(runtimesLoaded)}</p>}
            </div>
          )}
          {!run.restartableRunId && run.notice.tone === 'error' && !sendBlocker && (
            <button
              type="button"
              onClick={send}
              className="inline-flex min-h-9 items-center rounded-lg px-3 text-[12px] font-semibold"
              style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
            >
              重新生成
            </button>
          )}
          {failedRun && <p className="text-[11px] text-token-muted">任务编号 {failedRun.runId}</p>}
        </AssistantBubble>
      )}
      <div ref={conversationEndRef} />
    </>
  );

  const composer = (
    <>
      <WorkbenchComposer
        id="workbench-new-instruction"
        value={instruction}
        onChange={setInstruction}
        placeholder={run.generating ? '生成完成后可继续修改…' : '说说想做什么网页，也可以只添加资料'}
        disabled={run.generating}
        plusItems={plusItems}
        chips={referenceSite ? [...materialChips, {
          key: 'reference-site', label: referenceSite.title, status: '风格参考', icon: PanelsTopLeft, onRemove: () => setReferenceSite(null),
        }] : materialChips}
        attachments={{ items: [...uploads.items, ...uploads.rejections], onRemove: uploads.remove, onRetry: uploads.retry, onReplace: openFilePicker }}
        sendLabel={run.generating ? '正在生成…' : '生成网页'}
        sendDisabled={run.generating || Boolean(sendBlocker)}
        sendDisabledReason={run.generating ? undefined : sendBlocker}
        onSend={send}
        onStop={() => void run.stop()}
        stopDisabled={!run.activeRunId || run.stopRequested}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={DESIGN_ATTACHMENT_ACCEPT.document}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0 && replacingRef.current) uploads.remove(replacingRef.current);
          replacingRef.current = null;
          uploads.addFiles(files);
          event.target.value = '';
        }}
      />
      {sheet === 'notes' && (
        <ComposerSheet
          title="粘贴会议纪要或通话记录"
          onClose={() => setSheet(null)}
          footer={(
            <button
              type="button"
              onClick={addNotes}
              disabled={!notesDraft.trim()}
              className="inline-flex h-10 w-full items-center justify-center rounded-xl text-[14px] font-semibold disabled:opacity-45"
              style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
            >
              放入资料
            </button>
          )}
        >
          <div className="flex h-full flex-col gap-2 p-4">
            <label htmlFor="workbench-notes" className="text-[12px] text-token-secondary">
              贴进来的文字会作为一篇资料交给生成，和上传的文件一样被当作事实来源；不会被改写成别的内容。
            </label>
            <textarea
              id="workbench-notes"
              value={notesDraft}
              onChange={(event) => setNotesDraft(event.target.value)}
              placeholder="例如：9 月 23 日客户沟通纪要……"
              className="min-h-0 flex-1 resize-none rounded-xl p-3 text-base leading-relaxed text-token-primary outline-none sm:text-[13px]"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)' }}
            />
          </div>
        </ComposerSheet>
      )}
      {referencePickerOpen && (
        <PersonalStyleDialog
          open
          mode={{ kind: 'reference', onSelect: (site) => {
            if (site.id !== referenceSite?.id) setReferencePreview(null);
            setReferenceSite(site);
            setReferencePickerOpen(false);
            onPaneChange('chat');
          } }}
          onOpenChange={setReferencePickerOpen}
        />
      )}
    </>
  );

  const pickingKnowledge = sheet === 'knowledge' && !run.generating;
  const showFailure = Boolean(run.failedRun || (run.notice?.tone === 'error' && !run.generating));
  const failedPreview = showFailure && Boolean(run.previewHtml);
  let previewTitle = `风格样张 · ${styleName}`;
  let previewNote = sampleTitle ? '标题来自你的资料，正文为示例内容' : '示例内容';
  if (pickingKnowledge) {
    previewTitle = '引用知识库';
    previewNote = `选好资料后点「放入」，最多 ${MAX_KNOWLEDGE} 篇`;
  } else if (failedPreview) {
    previewTitle = '上次生成的预览';
    previewNote = '来自未完成的任务，仅供查看';
  } else if (run.generating) {
    previewTitle = '正在生成网页';
    previewNote = run.phase || '正在准备';
  } else if (run.completedSite) {
    previewTitle = '已保存的网页';
    previewNote = '已存入网页托管';
  } else if (showFailure) {
    previewTitle = '网页预览';
    previewNote = '这次没有可查看的预览';
  } else if (referenceSite) {
    previewTitle = '参考网页';
    previewNote = `${referenceSite.title} · 风格参考`;
  }

  const preview = (
    <WorkbenchPreview
      title={previewTitle}
      note={previewNote}
      nextHint=""
      actions={pickingKnowledge ? (
        <button
          type="button"
          onClick={() => setSheet(null)}
          className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-semibold"
          style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
        >
          {pickingKnowledge && selectedKnowledge.length > 0 ? `放入 ${selectedKnowledge.length} 篇` : '完成'}
        </button>
      ) : undefined}
    >
      {pickingKnowledge ? (
        <PreviewPanel>
          <KnowledgeInlineBrowser
            recentEntries={recentKnowledge}
            loadingRecent={loadingKnowledge}
            selectedEntries={selectedKnowledge}
            onChange={setSelectedKnowledge}
            onLimitReached={() => toast.info(`最多引用 ${MAX_KNOWLEDGE} 篇`, '取消一篇后再选；更多资料可以改用上传文件')}
          />
        </PreviewPanel>
      ) : run.previewHtml ? (
        <iframe
          key={run.previewSandbox}
          srcDoc={run.previewHtml}
          sandbox={run.previewSandbox}
          referrerPolicy="no-referrer"
          title={failedPreview ? '上次生成的预览' : run.completedSite ? '已保存的网页' : '生成中的网页预览'}
          className="h-full w-full bg-white"
        />
      ) : showFailure && !run.generating ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-token-muted">
          重试后，生成的页面会显示在这里。
        </div>
      ) : referenceSite && !run.generating && !run.completedSite ? (
        referencePreview?.siteId !== referenceSite.id ? (
          <PageSkeleton caption="正在打开参考网页" />
        ) : referencePreview.html ? (
          <iframe srcDoc={referencePreview.html} sandbox={AI_STREAM_PREVIEW_SANDBOX} referrerPolicy="no-referrer" title="参考网页预览" className="h-full w-full bg-white" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-token-secondary">
            <p>暂时打不开参考网页的预览。</p>
            <button type="button" onClick={() => { setReferencePreview(null); setReferencePreviewAttempt((attempt) => attempt + 1); }} className="rounded-md px-3 py-1.5 font-semibold hover-bg-soft">重试预览</button>
          </div>
        )
      ) : run.generating || run.completedSite || !styleSelection || styleSelection.kind === 'personal' ? (
        // 我的风格没有现成样张（样张来自设计系统，而它覆盖了配色与字体），只画它自己的色块，不拿骨架样张冒充。
        <PageSkeleton
          caption={run.generating
            ? '正在规划页面结构，首段内容写好就出现在这里'
            : run.completedSite ? '正在打开已保存的网页' : styleSelection?.kind === 'personal'
              ? `「${styleSelection.name}」没有现成样张，生成时按它的配色、字体与版式出页面`
              : '风格还没读出来，生成时用设置里的默认风格'}
          swatches={selectedStyle?.swatches ?? (styleSelection?.kind === 'personal' ? styleSelection.swatches : undefined)}
        />
      ) : (
        <div className="h-full p-3 lg:p-4">
          <StyleThumbnail
            designSystemId={styleSelection.designSystemId}
            title={sampleTitle}
            size="preview"
            fit="fill"
            label={`${styleSelection.name}风格样张`}
          />
        </div>
      )}
    </WorkbenchPreview>
  );

  return <WorkbenchLayout pane={pane} conversation={conversation} composer={composer} preview={preview} />;
}
