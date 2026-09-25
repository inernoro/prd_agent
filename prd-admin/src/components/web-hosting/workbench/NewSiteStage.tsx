import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Library, Palette, Upload } from 'lucide-react';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  getDesignGenerationSettings,
  getDesignRuntimeCapabilities,
  type DesignGenerationStyle,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import { FRESH_PPT_SESSION_PATH } from '@/pages/md-to-ppt-agent/sessionContext';
import KnowledgeInlineBrowser from '../KnowledgeInlineBrowser';
import { chooseDesignRuntime, displayedDesignRuntime, runtimeFallbackNotice } from '../siteEditPreview';
import {
  formatGenerationClock,
  remainingEstimateText,
  runProvenanceText,
} from '../siteGenerateProgress';
import {
  DESIGN_ATTACHMENT_ACCEPT,
  MAX_GENERATE_ATTACHMENTS,
  useDesignAttachmentUploads,
} from '../designAttachments';
import { PRESET_REQUESTS, RUNTIME_CARD_REGISTRY, orderRuntimeCards, runtimeCardTitle, titleFromFileName } from '../siteGenerateOptions';
import { useSiteGenerationRun } from './useSiteGenerationRun';
import {
  HTML_PPT_TIMING_NOTE,
  OUTPUT_FORM_ORDER,
  OUTPUT_FORM_REGISTRY,
  buildHtmlPptHandoff,
  openHtmlPptHandoff,
  type WorkbenchOutputForm,
} from './outputForm';
import { HtmlPptHandoffPanel } from './HtmlPptHandoffPanel';
import { StyleGallery, presetSelection, type StyleGallerySelection } from './StyleGallery';
import { StyleThumbnail } from './StyleThumbnail';
import {
  AssistantBubble,
  ComposerSheet,
  OptionChip,
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
  durationText: string;
  runtimeLabel: string;
  styleName?: string | null;
}

const MAX_KNOWLEDGE = 3;
const DEFAULT_REQUEST = '把这些资料做成一个清晰好读、适合发给客户看的网页';

function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
}

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
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [settingsDefaultRuntime, setSettingsDefaultRuntime] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState('open-design');
  const [styles, setStyles] = useState<DesignGenerationStyle[]>([]);
  /** 选中的风格：管理员预设（按 styleId 冻结）或目录里的设计系统（按 designSystemId 冻结）。 */
  const [styleSelection, setStyleSelection] = useState<StyleGallerySelection | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [sheet, setSheet] = useState<'knowledge' | 'notes' | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  /** 已发出去的那一条（对话里的用户气泡）；失败后输入框里的内容原样保留，可直接再发。 */
  const [sent, setSent] = useState<{ text: string; chips: string[]; runtimeLabel: string; styleName?: string | null } | null>(null);
  const handedOffRef = useRef(false);
  /** 产出形式：网页在这里直接生成；网页 PPT 带着资料与要求交给 HTML PPT 智能体（原因见 outputForm.ts）。 */
  const [outputForm, setOutputForm] = useState<WorkbenchOutputForm>('web-page');
  const navigate = useNavigate();

  const run = useSiteGenerationRun({
    destinationTeamId,
    hasInitialSource: Boolean(source),
    onCreated: () => { /* 完成后由下面的 effect 交给修改阶段 */ },
  });
  const { reset: resetRun } = run;

  useEffect(() => {
    resetRun();
    let active = true;
    void Promise.all([
      listRecentDocumentEntries(16),
      getDesignRuntimeCapabilities(),
      getDesignGenerationSettings(),
    ]).then(([recent, runtimes, settings]) => {
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
      if (runtimes.success) {
        setCapabilities(runtimes.data.runtimes);
        setSettingsDefaultRuntime(runtimes.data.defaultRuntime);
        const runtimeId = chooseDesignRuntime(runtimes.data.runtimes, runtimes.data.defaultRuntime);
        if (runtimeId) setSelectedRuntime(runtimeId);
      }
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

  const enabledRuntimes = useMemo(() => orderRuntimeCards(capabilities.filter((item) => item.enabled)), [capabilities]);
  const requestRuntime = enabledRuntimes.find((item) => item.id === selectedRuntime) ?? enabledRuntimes[0];
  const visibleRuntime = displayedDesignRuntime(
    capabilities,
    requestRuntime?.id ?? selectedRuntime,
    run.generating ? run.activeRunRuntime : null,
  );
  const fallbackNotice = runtimeFallbackNotice(capabilities, settingsDefaultRuntime, requestRuntime?.id);
  const selectedStyle = styleSelection?.kind === 'preset'
    ? styles.find((style) => style.id === styleSelection.styleId) ?? null
    : null;
  /** 样张标题：资料放进来后先换成资料的标题，让用户预判成品。 */
  const sampleTitle = selectedKnowledge[0]?.title
    || titleFromFileName(uploads.items.find((item) => item.status !== 'failed')?.fileName ?? '')
    || undefined;
  const hasSources = selectedKnowledge.length > 0 || uploads.readyIds.length > 0;
  const runtimeCopy = requestRuntime ? RUNTIME_CARD_REGISTRY[requestRuntime.id] : undefined;
  const eta = runtimeCopy ? `${runtimeCopy.facts[0].value} ${runtimeCopy.facts[0].unit}` : '';

  // 生成完成：把这一轮对话交给修改阶段，同一个窗口里接着说「想改哪里」。
  useEffect(() => {
    const done = run.completedSite;
    if (!done || handedOffRef.current) return;
    handedOffRef.current = true;
    onGenerated(done.id, {
      request: sent?.text || run.recoveredTitle || '生成网页',
      chips: sent?.chips ?? [],
      durationText: durationText(run.elapsedSeconds),
      runtimeLabel: sent?.runtimeLabel || (visibleRuntime ? runtimeCardTitle(visibleRuntime) : '设计执行器'),
      styleName: run.runInfo?.styleName ?? sent?.styleName,
    });
  }, [onGenerated, run.completedSite, run.elapsedSeconds, run.recoveredTitle, run.runInfo?.styleName, sent, visibleRuntime]);

  const addFiles = (files: File[]) => {
    const rejected = uploads.addFiles(files);
    if (rejected.length > 0) toast.error('有文件没有加入', rejected.join('；'));
  };

  const addNotes = () => {
    const text = notesDraft.trim();
    if (!text) return;
    // 粘贴的纪要按一篇 Markdown 附件上传，和拖进来的文件走同一条路，服务端同样当作事实来源。
    const index = uploads.items.filter((item) => item.fileName.startsWith('会议纪要')).length + 1;
    addFiles([new File([text], `会议纪要-${index}.md`, { type: 'text/markdown' })]);
    setNotesDraft('');
    setSheet(null);
  };

  const materialChips: ComposerChip[] = [
    ...selectedKnowledge.map((entry) => ({
      key: `kb-${entry.entryId}`,
      label: entry.title,
      status: '知识库',
      onRemove: () => setSelectedKnowledge((current) => current.filter((item) => item.entryId !== entry.entryId)),
    })),
    ...uploads.items.map((item) => ({
      key: item.key,
      label: item.fileName,
      status: item.status === 'uploading'
        ? `上传 ${item.progress}%`
        : item.status === 'reading'
          ? '读取正文'
          : item.status === 'ready'
            ? '可以用'
            : item.error || '失败',
      tone: item.status === 'failed' ? 'danger' as const : item.status === 'ready' ? 'default' as const : 'busy' as const,
      onRemove: () => uploads.remove(item.key),
    })),
  ];

  const plusItems: PlusMenuItem[] = [
    {
      id: 'knowledge',
      title: '引用知识库',
      description: `从我的或团队知识库挑，最多 ${MAX_KNOWLEDGE} 篇；稿子更新后可一键重生成`,
      icon: Library,
      onPick: () => { setGalleryOpen(false); setSheet('knowledge'); onPaneChange('preview'); },
    },
    {
      id: 'upload',
      title: '上传文件',
      description: 'Markdown、Word、PDF、PPT、纯文本，最多 5 个',
      icon: Upload,
      onPick: () => fileInputRef.current?.click(),
      disabledReason: uploads.items.length >= MAX_GENERATE_ATTACHMENTS ? `已放入 ${MAX_GENERATE_ATTACHMENTS} 个文件，先移除一个` : undefined,
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

  const isPpt = outputForm === 'html-ppt';
  const pptHandoff = useMemo(() => buildHtmlPptHandoff({
    instruction,
    knowledge: selectedKnowledge,
    uploadedFileNames: uploads.items.filter((item) => item.status !== 'failed').map((item) => item.fileName),
    destinationTeamId,
  }), [instruction, selectedKnowledge, uploads.items, destinationTeamId]);

  const sendBlocker = isPpt
    ? (pptHandoff.ok ? '' : pptHandoff.blocker)
    : !requestRuntime
    ? '没有可用的设计执行器，请联系管理员检查部署状态'
    : uploads.busy
      ? '文件还在上传，传完就能生成'
      : !hasSources
        ? '先点左下角的 + 放入资料：知识库、文件或会议纪要都行'
        : '';

  const send = () => {
    if (isPpt) {
      // 交接不是生成：不建设计任务、不显示网页进度卡，直接带着资料与要求去 PPT 智能体。
      if (sendBlocker || run.generating || !pptHandoff.ok) return;
      navigate(openHtmlPptHandoff(pptHandoff));
      return;
    }
    if (sendBlocker || run.generating || !requestRuntime) return;
    const text = instruction.trim() || DEFAULT_REQUEST;
    const title = selectedKnowledge[0]?.title
      || titleFromFileName(uploads.items.find((item) => item.status === 'ready')?.fileName ?? '');
    const chips = [
      ...selectedKnowledge.map((entry) => `知识库 · ${entry.title}`),
      ...uploads.items.filter((item) => item.status === 'ready').map((item) => `文件 · ${item.fileName}`),
    ];
    setSent({ text, chips, runtimeLabel: runtimeCardTitle(requestRuntime), styleName: styleSelection?.name });
    setGalleryOpen(false);
    handedOffRef.current = false;
    void run.start({
      instruction: text,
      title,
      runtimeId: requestRuntime.id,
      sourceSurface: source ? 'knowledge-base' : 'web-hosting',
      knowledge: selectedKnowledge,
      styleId: styleSelection?.kind === 'preset' ? styleSelection.styleId : null,
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
  // 进度卡往下长、停止按钮在卡片最底下：不跟着滚，按钮就被输入区挡住（与修改阶段同一做法）。
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [run.generating, steps.length, run.notice, sent]);
  const styleName = styleSelection?.name ?? '默认风格';

  const conversation = (
    <>
      <AssistantBubble>
        <p className="font-semibold">{isPpt ? '把资料做成网页 PPT，发给客户看' : '把资料做成网页，发给客户看'}</p>
        <p className="text-[12px] text-token-secondary">
          {isPpt
            ? '从 + 里放一篇知识库稿子，再用一句话说给谁看、想讲清什么。点下去会带着稿子和这句话去 HTML PPT 智能体：先出大纲给你确认，再逐页生成；发布后进网页托管，按幻灯片播放，同样能「发布给客户」。'
            : '点输入框左边的 + 放资料（知识库、文件、会议纪要可以一起放），再用一句话说给谁看、想达到什么效果。预览里是所选风格的样张，生成后换成你的页面；做好先存进网页托管，只有你能看到，确认后再发给客户。'}
        </p>
      </AssistantBubble>
      {composing && !isPpt && (
        <div className="flex flex-wrap gap-1.5" aria-label="常用要求">
          {PRESET_REQUESTS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setInstruction(preset.text)}
              className="rounded-lg px-2.5 py-1 text-[12px] text-token-secondary transition-colors hover-bg-soft"
              style={{ border: '1px solid var(--border-default)' }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      {!sent && run.generating && (
        <UserBubble text={run.recoveredTitle ? `接着看：${run.recoveredTitle}` : '接着看上次没跑完的生成'} />
      )}
      {sent && <UserBubble text={sent.text} chips={sent.chips} />}
      {run.generating && (
        <RunProgressCard
          title="正在生成网页"
          clock={formatGenerationClock(run.elapsedSeconds)}
          estimate={remainingEstimateText(run.activeRunRuntime, run.elapsedSeconds)}
          runtimeLabel={visibleRuntime ? runtimeCardTitle(visibleRuntime) : undefined}
          resolvedModel={run.resolvedModel}
          provenance={runProvenanceText(run.runInfo)}
          steps={steps.length > 0 ? steps : [{ key: 'start', label: '正在提交资料', state: 'active' }]}
          activity={`${run.phase || '正在准备'}${run.lastEventAtMs ? ` · 最近一次回应 ${Math.max(0, Math.round((Date.now() - run.lastEventAtMs) / 1000))} 秒前` : ''}`}
          thinking={run.thinking}
          onStop={() => void run.stop()}
          stopRequested={run.stopRequested}
          canStop={Boolean(run.activeRunId)}
          stopHint="可以关掉窗口，任务在服务器上继续；重新打开「生成网页」会接着显示进度。"
        />
      )}
      {run.notice && (
        <AssistantBubble tone="warning">
          <p className="font-semibold">{run.notice.tone === 'error' ? '这次没有做成' : '说明'}</p>
          <p className="text-[12px] text-token-secondary">{run.notice.text}</p>
          <p className="text-[12px] text-token-secondary">资料和要求还在下面的输入框里，改一改或直接再点一次生成。</p>
        </AssistantBubble>
      )}
      {fallbackNotice && !run.generating && (
        <p className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>{fallbackNotice}</p>
      )}
      <div ref={conversationEndRef} />
    </>
  );

  const options = (
    <>
      <Segmented
        label="产出形式"
        value={outputForm}
        disabled={run.generating}
        onChange={(form) => { setOutputForm(form); setGalleryOpen(false); onPaneChange('preview'); }}
        options={OUTPUT_FORM_ORDER.map((form) => ({
          value: form,
          label: OUTPUT_FORM_REGISTRY[form].label,
          title: OUTPUT_FORM_REGISTRY[form].title,
        }))}
      />
      {isPpt ? (
        <span className="text-[12px] text-token-muted">主题与模板在 PPT 智能体里选</span>
      ) : (
        <>
          <OptionChip
            label={`风格：${styleName}，点开换一个`}
            value={styleName}
            pressed={galleryOpen}
            onClick={() => { setSheet(null); setGalleryOpen((current) => !current); onPaneChange('preview'); }}
            disabled={run.generating}
          >
            <Palette size={13} />
            {selectedStyle && (
              <span className="flex gap-0.5">
                {selectedStyle.swatches.slice(0, 3).map((color) => <span key={color} className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />)}
              </span>
            )}
          </OptionChip>
          {enabledRuntimes.length > 1 ? (
            <Segmented
              label="生成方式"
              value={requestRuntime?.id ?? ''}
              disabled={run.generating}
              onChange={setSelectedRuntime}
              options={enabledRuntimes.map((item) => ({
                value: item.id,
                label: runtimeCardTitle(item).replace('生成', '').replace('设计', ''),
                title: RUNTIME_CARD_REGISTRY[item.id]?.description ?? item.label,
              }))}
            />
          ) : requestRuntime ? (
            <span className="text-[12px] text-token-muted">{runtimeCardTitle(requestRuntime)}</span>
          ) : null}
        </>
      )}
    </>
  );

  const composer = (
    <>
      <WorkbenchComposer
        id="workbench-new-instruction"
        value={instruction}
        onChange={setInstruction}
        placeholder="说说要做成什么样：给谁看、想达到什么效果（可以不写，只放资料也行）"
        disabled={run.generating}
        plusItems={plusItems}
        chips={materialChips}
        options={options}
        sendLabel={run.generating
          ? '正在生成…'
          : isPpt ? '去 PPT 智能体生成' : `生成网页${eta ? ` · 约 ${eta.replace('约 ', '')}` : ''}`}
        sendDisabled={run.generating || Boolean(sendBlocker)}
        sendDisabledReason={run.generating ? undefined : sendBlocker}
        onSend={send}
        hint={isPpt
          ? `点下去：带着稿子和要求打开 HTML PPT 智能体（要求只预填、不会自动发送）。${HTML_PPT_TIMING_NOTE}`
          : runtimeCopy
          ? `点下去：对话里一步步显示进度，预览里先出骨架、再换成真实页面；${runtimeCopy.footnote}`
          : '点下去：对话里一步步显示进度，预览里出真实页面；做好自动存进网页托管，只有你能看到。'}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={DESIGN_ATTACHMENT_ACCEPT.document}
        className="hidden"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
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
    </>
  );

  const pickingKnowledge = sheet === 'knowledge' && !run.generating;
  const showPptHandoff = isPpt && !run.generating && !pickingKnowledge;
  const previewTitle = run.generating ? '正在生成网页' : pickingKnowledge ? '引用知识库' : showPptHandoff ? '网页 PPT 怎么做' : galleryOpen ? '选一个风格' : `样张 · ${styleName}`;
  const previewNote = run.generating
    ? (run.phase || '正在准备')
    : pickingKnowledge
      ? `勾选要放进来的稿子，最多 ${MAX_KNOWLEDGE} 篇；放入后输入框上方会列出来`
      : showPptHandoff
      ? '在 HTML PPT 智能体里生成，这里说清会带过去什么'
      : galleryOpen
      ? '每张缩略图都是这个风格真实的样子，标题已换成你的资料'
      : sampleTitle ? '标题已换成你的资料，正文是示例；点生成后换成你的页面' : '示例内容；放进资料后标题先换成你的';
  const nextHint = run.generating
    ? '灰色块是还没写到的部分，写好一段换一段；做好后自动存进网页托管，这里直接显示成品。'
    : pickingKnowledge
      ? '选好点右上角「放入」，这里换回样张，样张标题会换成第一篇稿子的标题。'
      : showPptHandoff
      ? '点「去 PPT 智能体生成」后离开这个窗口；PPT 发布后回到网页托管就能看到它，按幻灯片播放。'
      : galleryOpen
      ? '点一张就选定它，预览立刻换成这个风格的样张；选好后回到对话点生成。'
      : hasSources
        ? '资料已放好。不喜欢这个样子就点输入框下面的风格换一个；点生成后，这里一段段出现你的页面。'
        : '先放资料、说要求；这里是所选风格真实的样子。';

  const preview = (
    <WorkbenchPreview
      title={previewTitle}
      note={previewNote}
      nextHint={nextHint}
      actions={(galleryOpen || pickingKnowledge) && !run.generating ? (
        <button
          type="button"
          onClick={() => { setGalleryOpen(false); setSheet(null); }}
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
      ) : showPptHandoff ? (
        <HtmlPptHandoffPanel handoff={pptHandoff} onOpenBlank={() => navigate(FRESH_PPT_SESSION_PATH)} />
      ) : galleryOpen && !run.generating ? (
        <div className="h-full overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
          <StyleGallery
            selectedId={styleSelection?.key ?? null}
            title={sampleTitle}
            onSelect={(selection) => { setStyleSelection(selection); setGalleryOpen(false); }}
            onRequestCustomStyle={() => toast.info('「做一个我的风格」还没上线', '现在可以从预设或更多风格里挑一套最接近的')}
          />
        </div>
      ) : run.previewHtml ? (
        <iframe
          key={run.previewSandbox}
          srcDoc={run.previewHtml}
          sandbox={run.previewSandbox}
          referrerPolicy="no-referrer"
          title="生成中的网页预览"
          className="h-full w-full bg-white"
        />
      ) : run.generating || !styleSelection ? (
        <PageSkeleton
          caption={run.generating ? '正在规划页面结构，首段内容写好就出现在这里' : '风格还没读出来，生成时用设置里的默认风格'}
          swatches={selectedStyle?.swatches}
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
