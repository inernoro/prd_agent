/**
 * 快速创作智能体：一份文档 + 一个模板 → 能播放的视频或能浏览的网页，并发布到网页托管。
 * - 生成在服务端排队执行，离开页面不取消；地址里的 ?run= 让用户回到同一个任务。
 * - 版式沿用网页生成工作台（WorkbenchLayout）：左栏一个对话 + 底部一个输入框；右栏是选模板、管理资料和预览。窄屏切成「对话 / 预览」。
 * - 与「视频创作智能体」的区别：那边用生成式视频模型出镜头，这里用文稿 + 配音 + 可复用的模板画面代码。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, CircleCheck, ExternalLink, FileText, Globe, LayoutList, Mic, Paperclip, Plus, Send, Video } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { useSpeechInput } from '@/lib/useSpeechInput';
import { toast } from '@/lib/toast';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { PaneTabs, Segmented, WorkbenchLayout, WorkbenchPreview, fitComposerHeight, type WorkbenchPane } from '@/components/web-hosting/workbench/WorkbenchParts';
import {
  addKnowledgeAttachment, approveQuickCreationTrial, createQuickCreationRun, estimateQuickCreation, getQuickCreationRun, listQuickCreationAssets, listQuickCreationTemplates, listQuickCreationWorks, requestBriefScript, sendBriefMessage, updateBriefContext,
  addTextAttachment, publishQuickCreationRun, retryAttachmentRead, retryQuickCreationRun, uploadQuickCreationAttachment,
} from '@/services/real/quickCreation';
import { AttachmentTray, MaterialsPanel, SentAttachments } from './AttachmentTray';
import { AgentTurn, UserTurn } from './Conversation';
import { FailureCard, QueueCard, RunProgress } from './RunProgress';
import { ProgressPreview, VideoPlayer, WebPreview } from './ResultPanel';
import { StyleLibrary, StylePickerChip } from './StyleLibrary';
import { AssetLibrary } from './AssetLibrary';
import { BriefConversation, BriefStrip } from './BriefChat';
import { DurationOptions, TrialToggle, durationShort, minutesLabel } from './Duration';
import { BrowserExport } from './BrowserExport';
import { WorksList } from './WorksList';
import { RecentWorks, Sheet, Starters, StyleInspiration } from './Landing';
import { MAX_ATTACHMENTS, formatClock, summarizeAttachments } from './format';
import type { AssetScope, BriefContext, DurationChoice, OutputKind, QcAsset, QcAttachment, QcBriefSession, QcEstimate, QcFailure, QcRun, QcTemplate, QcTemplateCategory, QcTemplateSource, QcWork } from './types';
import './quickCreation.css';

const OUTPUT_LABEL: Record<OutputKind, string> = { video: '视频', web: '网页' };
const SAMPLE_KB_ENTRY = 'sample-review-habits';

function runBadge(run: QcRun) {
  if (run.status === 'queued') return { label: `排队中 · 第 ${run.queue?.position ?? '-'} 位`, variant: 'new' as const };
  if (run.status === 'running' && run.trial?.status === 'ready') return { label: '试看待确认', variant: 'warning' as const };
  if (run.status === 'running') return { label: `生成中 · ${run.stages.find(s => s.status === 'running')?.label ?? ''}`, variant: 'new' as const };
  if (run.status === 'failed') return { label: '需要处理', variant: 'danger' as const };
  if (run.publish.status === 'done') return { label: '已发布', variant: 'success' as const };
  if (run.publish.status === 'failed') return { label: '发布未完成', variant: 'warning' as const };
  return { label: '已生成', variant: 'subtle' as const };
}

export function QuickCreationAgentPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const view = params.get('view');

  const [templates, setTemplates] = useState<QcTemplate[]>([]);
  const [categories, setCategories] = useState<QcTemplateCategory[]>([]);
  const [styleSource, setStyleSource] = useState<QcTemplateSource | undefined>();
  const [works, setWorks] = useState<QcWork[]>([]);
  const [run, setRun] = useState<QcRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [kind, setKind] = useState<OutputKind>('video');
  const [templateId, setTemplateId] = useState<string>('');
  const [attachments, setAttachments] = useState<QcAttachment[]>([]);
  const [ask, setAsk] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  /* 成片时长：默认自动，按内容估算；估算值由服务端给出 */
  const [duration, setDuration] = useState<DurationChoice>('auto');
  const [estimate, setEstimate] = useState<QcEstimate | null>(null);
  /* 先试看：没手动改过时按时长默认（3 分钟及以上开） */
  const [trialPref, setTrialPref] = useState<boolean | null>(null);
  const trialOn = kind === 'video' && (trialPref ?? estimate?.trialDefault ?? false);
  /* 语音输入复用正式实现的 useSpeechInput（浏览器语音识别）；不支持的浏览器不显示入口 */
  const speechBase = useRef('');
  const speech = useSpeechInput({
    onResult: (finalText, interim) => setAsk(speechBase.current + finalText + interim),
    onError: msg => toast.error('语音输入', msg),
  });
  const toggleVoice = () => {
    if (!speech.listening) speechBase.current = ask;
    speech.toggle();
  };
  const [submitting, setSubmitting] = useState(false);
  /* 右栏此刻显示什么：资料面板（发送前管理 / 发送后回看）优先，否则按任务状态显示模板、过程或成品 */
  const [panel, setPanel] = useState<{ mode: 'manage' | 'review'; id?: string } | null>(null);
  const [pane, setPane] = useState<WorkbenchPane>('chat');
  /* 右栏「选择与资产」：select 是选风格（新建）或看本次（任务中），assets 是回看已生成的产物 */
  const [rightTab, setRightTab] = useState<'select' | 'assets'>('select');
  const [assetScope, setAssetScope] = useState<AssetScope>('mine');
  const [assets, setAssets] = useState<QcAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = askRef.current;
    if (!el) return;
    /* 手机输入框空着时只占一行，打字后再长高；桌面沿用工作台的高度规则 */
    if (window.matchMedia('(max-width: 767px)').matches) { el.style.height = 'auto'; el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`; }
    else fitComposerHeight(el);
  }, [ask]);

  useEffect(() => {
    void listQuickCreationTemplates().then(res => { if (res.success) { setTemplates(res.data.items); setCategories(res.data.categories); setStyleSource(res.data.source); } });
  }, []);
  const refreshWorks = useCallback(() => {
    void listQuickCreationWorks().then(res => { if (res.success) setWorks(res.data.items); });
  }, []);
  useEffect(() => { refreshWorks(); }, [refreshWorks, runId, view]);
  /* 产物在打开「产物」页签或切换范围时读取 */
  useEffect(() => {
    if (rightTab !== 'assets') return;
    let stop = false;
    setAssetsLoading(true);
    void listQuickCreationAssets(assetScope).then(res => {
      if (stop) return;
      setAssetsLoading(false);
      if (res.success) setAssets(res.data.items); else toast.error('产物没有读到', res.error?.message || '请稍后重试');
    });
    return () => { stop = true; };
  }, [rightTab, assetScope]);

  /* 风格与产出相互独立：同一个风格既能出视频也能出网页；默认选「视觉笔记」 */
  const DEFAULT_STYLE = 'sketchnote';
  const template = templates.find(t => t.id === (run?.templateId ?? templateId)) ?? templates.find(t => t.id === DEFAULT_STYLE) ?? templates[0];
  useEffect(() => {
    if (!templateId && templates.length) setTemplateId((templates.find(t => t.id === DEFAULT_STYLE) ?? templates[0]).id);
  }, [templates, templateId]);

  /* 按任务编号加载 */
  useEffect(() => {
    setRun(null); setRunError(null); setPanel(null); setRightTab('select');
    if (!runId) return;
    let stop = false;
    void getQuickCreationRun(runId).then(res => {
      if (stop) return;
      if (res.success) setRun(res.data); else setRunError(res.error?.message || '没有找到这个任务');
    });
    return () => { stop = true; };
  }, [runId]);

  /* 进行中的任务每秒查一次：阶段切换和恢复结果能在一秒内出现 */
  const POLL_MS = 1000;
  /* 轮询跟着任务状态走：排队、生成、发布中继续查；恢复或重试让任务重新进行时自动接上 */
  const isLive = !!run && run.id === runId && (run.status === 'queued' || run.status === 'running' || run.publish.status === 'publishing');
  useEffect(() => {
    if (!isLive || !runId) return;
    let stop = false;
    const timer = window.setTimeout(async () => {
      const res = await getQuickCreationRun(runId);
      if (!stop && res.success) setRun(res.data);
    }, POLL_MS);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [isLive, runId, run]);

  const openRun = (id: string) => setParams({ run: id });
  const startNew = () => { setParams({}); setAsk(''); setAttachments([]); setPane('chat'); };

  /* ---------- 附件 ---------- */
  const addFile = async (file: File) => {
    if (attachments.length >= MAX_ATTACHMENTS) { toast.warning('附件已达上限', `一次最多 ${MAX_ATTACHMENTS} 个，可先移除不需要的`); return; }
    const res = await uploadQuickCreationAttachment(file);
    if (res.success) setAttachments(list => [...list, res.data]);
    else toast.error('附件没有添加', res.error?.message || '请稍后重试');
  };
  const addKnowledge = async (entryId: string) => {
    const res = await addKnowledgeAttachment(entryId);
    if (res.success) setAttachments(list => [...list.filter(a => a.id !== res.data.id), res.data]);
    else toast.error('知识库文档没有添加', res.error?.message || '请稍后重试');
  };
  const retryRead = async (id: string) => {
    setAttachments(list => list.map(a => (a.id === id ? { ...a, status: 'reading', progress: 0, error: undefined } : a)));
    const res = await retryAttachmentRead(id);
    /* 重试本身失败时退回「读取失败」并写明原因，不能停在读取中 */
    setAttachments(list => list.map(a => (a.id !== id ? a : res.success ? res.data
      : { ...a, status: 'failed', progress: undefined, error: `${res.error?.message || '这次重试也没有成功'}，可以稍后再试或换一个文件` })));
  };
  /* 粘贴的长正文（一次增加 300 字以上）转成一份稿件附件，输入框只留给「要求」 */
  const PASTE_AS_DOC = 300;
  const onAskChange = async (next: string) => {
    if (next.length - ask.length < PASTE_AS_DOC) { setAsk(next); return; }
    const pasted = next.startsWith(ask) ? next.slice(ask.length) : next;
    const firstLine = pasted.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 30) || '粘贴的正文';
    const res = await addTextAttachment({ name: `${firstLine}.md`, text: pasted });
    if (res.success) { setAttachments(list => [...list, res.data]); toast.info('已作为稿件附件', `粘贴的 ${pasted.length.toLocaleString('zh-CN')} 字已放进附件，输入框留给要求`); }
    else { setAsk(next); toast.error('没能转成附件', `${res.error?.message || '请稍后重试'}，正文暂时留在输入框里`); }
  };
  const sum = summarizeAttachments(attachments);
  const hasText = attachments.some(a => a.status === 'ready' && a.kind !== 'image');
  const blockReason = !hasText ? '放进稿件才能生成，或者直接说想做什么' : sum.reading ? '还有附件在读取，读完即可生成' : null;
  const draftTitle = attachments.find(a => a.status === 'ready' && a.kind !== 'image')?.name.replace(/\.(md|markdown|txt)$/i, '') ?? (template ? `未命名 · ${template.name}` : '未命名');

  const submit = async () => {
    if (blockReason || !template) return;
    setSubmitting(true);
    const res = await createQuickCreationRun({
      kind, templateId: template.id, ask: ask.trim(),
      attachmentIds: attachments.filter(a => a.status === 'ready').map(a => a.id), title: draftTitle, ...(kind === 'video' ? { duration, trial: trialOn } : {}),
    });
    setSubmitting(false);
    if (!res.success) { toast.error('没有提交成功', `${res.error?.message || '请稍后重试'}，稿件仍在输入框里`); return; }
    openRun(res.data.id);
  };

  /* ---------- 对话起稿 ---------- */
  const [briefSession, setBriefSession] = useState<QcBriefSession | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const readyIds = attachments.filter(a => a.status === 'ready').map(a => a.id);
  const briefContext: BriefContext = { kind, templateId: template?.id, attachmentIds: readyIds, ...(kind === 'video' ? { duration } : {}) };
  /* 时长预估：产出、资料或时长选择变了就重新估（新建时） */
  const estimateKey = JSON.stringify({ kind, readyIds, duration });
  useEffect(() => {
    if (runId || kind !== 'video') { setEstimate(null); return; }
    let stop = false;
    const q = JSON.parse(estimateKey) as { kind: OutputKind; readyIds: string[]; duration: DurationChoice };
    void estimateQuickCreation({ kind: q.kind, attachmentIds: q.readyIds, duration: q.duration }).then(res => { if (!stop && res.success) setEstimate(res.data); });
    return () => { stop = true; };
  }, [estimateKey, runId, kind]);
  const contextKey = JSON.stringify(briefContext);
  const briefId = briefSession?.id;
  /* 输入框里的选择（产出、风格、资料）变了，简报跟着更新；只在新建时 */
  useEffect(() => {
    if (runId || !template) return;
    let stop = false;
    void updateBriefContext({ sessionId: briefId, context: JSON.parse(contextKey) as BriefContext }).then(res => { if (!stop && res.success) setBriefSession(res.data); });
    return () => { stop = true; };
  }, [contextKey, runId, briefId, template]);
  /* 对话里选定了风格（例如说「第二个」），输入框里的风格按钮同步 */
  const briefStyle = briefSession?.styleId;
  useEffect(() => { if (briefStyle && briefStyle !== templateId) setTemplateId(briefStyle); }, [briefStyle]); // eslint-disable-line react-hooks/exhaustive-deps
  /* 对话里定了时长（例如说「5 分钟」或点了「长一点」），输入框里的时长同步 */
  const briefDuration = briefSession?.durationChoice;
  useEffect(() => { if (briefDuration && briefDuration !== duration) setDuration(briefDuration); }, [briefDuration]); // eslint-disable-line react-hooks/exhaustive-deps
  const sendChat = async (text: string, styleOverride?: string) => {
    const t = text.trim();
    if (!t || briefBusy) return;
    if (speech.listening) speech.cancel();
    speechBase.current = '';
    setPendingText(t); setBriefBusy(true); setAsk('');
    const res = await sendBriefMessage({ sessionId: briefId, text: t, context: { ...briefContext, templateId: styleOverride ?? briefContext.templateId } });
    setPendingText(null); setBriefBusy(false);
    if (!res.success) { setAsk(t); toast.error('这句话没有发出去', `${res.error?.message || '请稍后重试'}，内容已放回输入框`); return; }
    setBriefSession(res.data);
    setRevealId([...res.data.messages].reverse().find(m => m.role === 'agent')?.id ?? null);
  };
  const pickRecommendedStyle = (id: string) => {
    setTemplateId(id);
    void sendChat(`就用「${templates.find(t => t.id === id)?.name ?? id}」`, id);
  };
  const startBriefScript = async (adjust?: 'shorter' | 'longer') => {
    if (!briefId || briefBusy) return;
    setBriefBusy(true);
    const res = await requestBriefScript(briefId, briefContext, adjust);
    setBriefBusy(false);
    if (!res.success) { toast.error('分镜脚本没有出来', res.error?.message || '请稍后重试'); return; }
    setBriefSession(res.data);
    setRevealId([...res.data.messages].reverse().find(m => m.role === 'agent')?.id ?? null);
  };
  const startFromBrief = async (withScript: boolean) => {
    if (!briefSession || !template || briefBusy) return;
    const script = withScript ? [...briefSession.messages].reverse().find(m => m.script)?.script : undefined;
    setBriefBusy(true);
    const res = await createQuickCreationRun({
      kind, templateId: template.id, ask: briefSession.brief.summary ?? ask.trim(), attachmentIds: readyIds,
      title: briefSession.brief.title ?? draftTitle, briefId: briefSession.id, ...(script ? { script } : {}), ...(kind === 'video' ? { duration, trial: trialOn } : {}),
    });
    setBriefBusy(false);
    if (!res.success) { toast.error('没有提交成功', `${res.error?.message || '请稍后重试'}，对话和简报都还在`); return; }
    openRun(res.data.id);
  };
  const hasBriefCard = !!briefSession?.messages.some(m => m.ready || m.script);
  /* 开聊后新建页换成对话：居中一列，输入框在底部 */
  const chatting = !!briefSession?.messages.length || !!pendingText;
  const conversationEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { conversationEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [briefSession?.messages.length, pendingText]);

  /* ---------- 任务动作 ---------- */
  const onRecover = async (action: QcFailure['actions'][number]) => {
    if (!run) return;
    const res = await retryQuickCreationRun(run.id, { action, unitIndex: run.failure?.unitIndex });
    if (res.success) { setRun(res.data); setParams({ run: run.id }, { replace: true }); }
    else toast.error('没有重新开始', res.error?.message || '请稍后再试');
  };
  const [approving, setApproving] = useState(false);
  const onApproveTrial = async () => {
    if (!run || approving) return;
    setApproving(true);
    const res = await approveQuickCreationTrial(run.id);
    setApproving(false);
    if (res.success) setRun(res.data);
    else toast.error('没有接着做', `${res.error?.message || '请稍后再试'}，试看仍保留`);
  };
  /* 试看不满意：回到新建，稿件、要求、产出与时长都带回，换风格或改要求后重新开始；试看只花了一成 */
  const backFromTrial = () => {
    if (!run) return;
    setAttachments(run.attachments.filter(a => a.status === 'ready')); setAsk(run.ask); setKind(run.kind); setTemplateId(run.templateId);
    setParams({}); setPane('chat');
  };
  const onPublish = async () => {
    if (!run) return;
    setRun({ ...run, publish: { ...run.publish, status: 'publishing', error: undefined } });
    const res = await publishQuickCreationRun(run.id);
    if (res.success) setRun(res.data);
    else setRun({ ...run, publish: { status: 'failed', error: res.error?.message || '网页托管这次没有响应' } });
  };

  const badge = run && view !== 'works' ? runBadge(run) : null;
  const header = (
    <header className={`flex min-h-14 shrink-0 items-center gap-2 px-2 py-2 md:gap-3 md:px-5 ${run || view === 'works' ? 'border-b border-token-subtle' : ''}`}>
      <button type="button" aria-label="返回百宝箱" onClick={() => navigate('/ai-toolbox')} className="qc-icon-btn"><ChevronLeft size={18} /></button>
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-2 ${run ? '' : 'hidden'}`}>
          <span className="text-[11px] text-token-muted">快速创作</span>
          {/* 窄屏把状态放到标题上方这一行，标题保持完整宽度 */}
          {badge && <span className="md:hidden"><Badge size="sm" variant={badge.variant}>{badge.label}</Badge></span>}
        </div>
        <div className="truncate text-[15px] font-semibold text-token-primary" data-qc="project-title">
          {view === 'works' ? '我的作品' : run?.title ?? '快速创作'}
        </div>
      </div>
      {badge && <span className="hidden md:inline-flex"><Badge variant={badge.variant}>{badge.label}</Badge></span>}
      {view !== 'works' && (
        <Button variant="ghost" size="sm" className="max-md:min-h-11" data-qc="works-link" aria-label={`我的作品，共 ${works.length} 个`}
          onClick={() => {
            /* 新建页上历史就在下面：滚到「我的作品」；其他时候打开作品列表 */
            const recent = !run && !chatting ? document.querySelector('[data-qc=recent-works]') : null;
            if (recent) recent.scrollIntoView({ block: 'start' }); else setParams({ view: 'works' });
          }}>
          <LayoutList size={15} /><span className="hidden sm:inline">我的作品</span> {works.length}
        </Button>
      )}
      {runId && view !== 'works' && <Button variant="secondary" size="sm" className="max-md:min-h-11" onClick={startNew} aria-label="新建"><Plus size={14} /><span className="hidden sm:inline">新建</span></Button>}
    </header>
  );

  if (view === 'works') {
    return (
      <div className="flex h-full min-h-0 flex-col" data-qc-ready="works">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorksList works={works} templates={templates} onOpen={openRun} onCreate={startNew} />
        </div>
      </div>
    );
  }

  const openManage = () => { setPanel(p => (p?.mode === 'manage' ? null : { mode: 'manage' })); setPane('preview'); };
  const openReview = (id?: string) => { setPanel({ mode: 'review', id }); setPane('preview'); };

  /* ---------- 新建：居中一列。还没开聊是新建页（输入框 + 起头 + 风格灵感 + 最近作品），开聊后是对话 ---------- */
  const chatFeed = (
    <>
      <BriefConversation session={briefSession} pendingText={pendingText} revealId={revealId} templates={templates} busy={briefBusy}
        onReply={t => void sendChat(t)} onUseStyle={pickRecommendedStyle} onStart={() => void startBriefScript()}
        onSkipScript={() => void startFromBrief(false)} onConfirmScript={() => void startFromBrief(true)} onAdjustScript={a => void startBriefScript(a)}
        trialOn={trialOn} estimate={estimate} onToggleTrial={setTrialPref} />
      <div ref={conversationEnd} />
    </>
  );

  /* 输入框右下只有一个动作：
     - 还没有稿件、输入框有字：发送（发给快速创作，开始对话）；
     - 有稿件：「生成」，输入框里的字作为补充要求；想问问题按 Enter 一样发给快速创作；
     - 都没有：灰的「生成」，提示里说原因 */
  const showSend = !!ask.trim() && !hasText;
  const outputSwitch = (
    /* 公共组件 Segmented 沿用正式实现（28px），触控高度差异记为框架债务，不在单页改 */
    <span data-qc-touch-exempt className="inline-flex shrink-0">
      <Segmented<OutputKind> label="选择产出" value={kind} onChange={setKind}
        options={[{ value: 'video', label: '视频', title: '能播放的成片：配音、字幕与画面' }, { value: 'web', label: '网页', title: '能浏览的网页：桌面与手机都能读' }]} />
    </span>
  );
  const durationLabel = durationShort(duration, estimate);
  /* 「做成什么」按钮：产出、时长、先试看都收在这里，输入框上只露一个词 */
  const outputChip = (
    <Popover.Root open={outputOpen} onOpenChange={setOutputOpen}>
      <Popover.Trigger asChild>
        <button type="button" data-qc="output-chip" data-output={kind} data-duration={kind === 'video' ? String(duration) : undefined}
          aria-label={`做成${OUTPUT_LABEL[kind]}${kind === 'video' ? `，${durationLabel}` : ''}，点此更换`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[13px] text-token-primary hover-bg-soft max-md:h-11">
          {kind === 'video' ? <Video size={15} className="text-token-muted" aria-hidden /> : <Globe size={15} className="text-token-muted" aria-hidden />}
          {OUTPUT_LABEL[kind]}{kind === 'video' && <span className="text-token-muted">{durationLabel.replace(/^约 /, '')}</span>}
          <ChevronDown size={13} className="text-token-muted" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} data-qc="output-popover"
          className="qc-menu-surface z-[110] w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-[var(--border-default)] p-4 shadow-lg">
          <div className="text-[12.5px] text-token-muted">做成什么</div>
          <div className="mt-2">{outputSwitch}</div>
          {kind === 'video' ? (
            <>
              <div className="mt-4 text-[12.5px] text-token-muted">多长</div>
              <div className="mt-2"><DurationOptions compact value={duration} estimate={estimate} onChange={setDuration} /></div>
              <div className="mt-2"><TrialToggle on={trialOn} estimate={estimate} onChange={setTrialPref} /></div>
            </>
          ) : <p className="m-0 mt-3 text-[12.5px] leading-5 text-token-secondary">网页按内容分 4–5 节，桌面和手机都能读。</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  const placeholder = speech.listening ? '正在听，直接说…' : hasText ? '补充要求（可不填）；想问问题按 Enter' : '说说想做什么，或者放进一份稿件';
  const composer = (
    <div>
      {chatting && briefSession && <BriefStrip brief={briefSession.brief} />}
      <div className="qc-composer relative flex flex-col" data-listening={speech.listening ? 'true' : undefined}>
        <AttachmentTray items={attachments} managing={panel?.mode === 'manage'} onRemove={id => setAttachments(l => l.filter(a => a.id !== id))} onManage={openManage} />
        <label htmlFor="qc-ask" className="sr-only">说说想做什么</label>
        <textarea id="qc-ask" ref={askRef} rows={chatting ? 1 : 2} value={ask} onChange={e => void onAskChange(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.metaKey || e.ctrlKey) { e.preventDefault(); void submit(); return; }
            if (!e.shiftKey && ask.trim()) { e.preventDefault(); void sendChat(ask); }
          }}
          title="Enter 发给快速创作；Ctrl / ⌘ + Enter 直接生成"
          placeholder={placeholder}
          className="block w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3.5 text-base leading-relaxed text-token-primary outline-none placeholder:text-token-muted sm:text-[15px]" />
        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <input ref={fileInput} type="file" accept=".md,.markdown,.txt,image/*" multiple hidden data-qc="file-input"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; files.forEach(f => void addFile(f)); }} />
          <Popover.Root open={plusOpen} onOpenChange={setPlusOpen}>
            <Popover.Trigger asChild>
              <button type="button" aria-label="放进稿件" title="放进稿件" data-qc="composer-plus" className="qc-icon-btn"><Plus size={19} /></button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12} data-qc="plus-menu"
                className="qc-menu-surface z-[110] flex w-60 flex-col rounded-xl border border-[var(--border-default)] p-1 shadow-lg">
                {[
                  { qc: 'plus-upload', icon: Paperclip, label: '上传稿件或图片', on: () => fileInput.current?.click() },
                  { qc: 'plus-knowledge', icon: BookOpen, label: '从知识库选择', on: () => void addKnowledge('kb-picker') },
                  { qc: 'plus-sample', icon: FileText, label: '用示例稿件试一下', on: () => void addKnowledge(SAMPLE_KB_ENTRY) },
                ].map(o => (
                  <button key={o.qc} type="button" data-qc={o.qc} className="flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-token-primary hover-bg-soft md:h-10"
                    onClick={() => { setPlusOpen(false); o.on(); }}><o.icon size={16} className="text-token-secondary" aria-hidden />{o.label}</button>
                ))}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {outputChip}
          <StylePickerChip templates={templates} categories={categories} selected={template} onSelect={id => { setTemplateId(id); setPanel(null); }}
            onBrowse={() => setStyleSheetOpen(true)} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {speech.supported && (
              <button type="button" data-qc="voice" aria-label={speech.listening ? '停止语音输入' : '语音输入'} title={speech.listening ? '停止语音输入' : '语音输入'} aria-pressed={speech.listening}
                className={`qc-icon-btn ${speech.listening ? 'text-[color:var(--accent-primary)]' : ''}`} onClick={toggleVoice}>
                {speech.listening ? <span className="qc-wave" aria-hidden><i /><i /><i /><i /></span> : <Mic size={17} />}
              </button>
            )}
            {showSend ? (
              <button type="button" data-qc="send" aria-label="发给快速创作" title="发给快速创作（Enter）" disabled={briefBusy} onClick={() => void sendChat(ask)}
                className="qc-face qc-face-send relative inline-flex items-center justify-center">
                {briefBusy ? <MapSpinner size={13} /> : <ArrowUp size={16} strokeWidth={2.4} />}
              </button>
            ) : (
              /* 对话里出现「准备好了」卡后，开工由卡片的主按钮负责，这里降为次要，保持一屏一个主动作 */
              <Button variant={hasBriefCard ? 'secondary' : 'primary'} size="sm" className={`qc-face relative shrink-0 px-3.5 ${hasBriefCard ? 'qc-face-secondary' : 'qc-face-primary'}`}
                disabled={!!blockReason || submitting} onClick={() => void submit()} data-qc="submit" data-block-reason={blockReason ?? undefined}
                title={blockReason ?? '直接生成（Ctrl / ⌘ + Enter）'} aria-label={blockReason ? `生成：${blockReason}` : '生成'}>
                {submitting ? <MapSpinner size={13} /> : <Send size={13} />}生成
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const landingBody = (
    <div className="h-full overflow-y-auto" data-qc="landing">
      <div className="mx-auto w-full max-w-[780px] px-4 pb-24 pt-[min(13vh,112px)] max-md:pt-8">
        <h1 className="m-0 text-center text-[32px] font-semibold leading-tight tracking-tight text-token-primary max-md:text-[24px]">把一份文档，变成视频或网页</h1>
        <div className="mt-8 max-md:mt-6">{composer}</div>
        <Starters onSample={() => void addKnowledge(SAMPLE_KB_ENTRY)} onKnowledge={() => void addKnowledge('kb-picker')} onSay={t => void sendChat(t)} showSay={!attachments.length} />
        <StyleInspiration templates={templates} selectedId={template?.id} onSelect={setTemplateId} onBrowseAll={() => setStyleSheetOpen(true)} />
        <RecentWorks works={works} templates={templates} onOpenWork={openRun} onAllWorks={() => setParams({ view: 'works' })} currentStyleId={template?.id}
          onUseStyle={a => { setTemplateId(a.templateId); toast.info(`已换成「${templates.find(t => t.id === a.templateId)?.name ?? ''}」风格`, '放进你自己的稿件就能用这个风格生成'); }}
          onOpenAsset={a => setParams({ run: a.runId })}
          onOpenHosting={a => navigate(`/web-pages?focusSite=${encodeURIComponent(a.siteId ?? '')}`)} />
      </div>
    </div>
  );
  const chatBody = (
    <div className="flex h-full min-h-0 flex-col" data-qc="chat">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-6 px-4 py-8">{chatFeed}</div>
      </div>
      <div className="mx-auto w-full max-w-[780px] shrink-0 px-4 pb-4 pt-2">{composer}</div>
    </div>
  );
  /* 新建时的两个浮层：风格库（全部 99 种）与资料管理 */
  const composeSheets = (
    <>
      <Sheet open={styleSheetOpen} onOpenChange={setStyleSheetOpen} title={`风格库 · ${templates.length} 种`} qc="style-sheet" wide>
        {template && <StyleLibrary templates={templates} categories={categories} source={styleSource} selected={template} onSelect={setTemplateId} kind={kind} />}
      </Sheet>
      <Sheet open={!run && panel?.mode === 'manage'} onOpenChange={v => { if (!v) setPanel(null); }} title={`资料 · ${sum.total} 份`} qc="materials-sheet" wide>
        <MaterialsPanel mode="manage" items={attachments} activeId={panel?.id} onSelect={id => setPanel({ mode: 'manage', id })}
          onRemove={id => setAttachments(l => l.filter(a => a.id !== id))} onRetry={id => void retryRead(id)} onClearFailed={() => setAttachments(l => l.filter(a => a.status !== 'failed'))} />
      </Sheet>
    </>
  );

  /* ---------- 左栏 · 任务：你的那一条 + 助手这一轮 ---------- */
  const runTemplate = templates.find(t => t.id === run?.templateId);
  const agentStatus = !run ? null : run.status === 'queued' || run.status === 'done' || (run.status === 'running' && run.trial?.status !== 'ready') ? null : run.status === 'running' && run.trial?.status === 'ready' ? '试看好了 · 等你确认' : run.status === 'running' ? '后台进行中 · 可以离开' : run.status === 'failed' ? '需要你处理' : '已完成';
  const runConversation = run && (
    <>
      <UserTurn meta={<>{run.kind === 'video' ? <Video size={12} aria-hidden /> : <Globe size={12} aria-hidden />}{OUTPUT_LABEL[run.kind]}{run.targetSec ? <span data-qc="run-target"> · 约 {minutesLabel(run.targetSec)}</span> : null} · {runTemplate?.name}</>}>
        <p className="m-0 px-1 text-[14px] leading-6 text-token-primary">{run.ask || '没有补充要求，按模板默认节奏生成'}</p>
        {run.attachments.some(x => x.status === 'ready')
          ? <SentAttachments items={run.attachments} onOpenAll={() => openReview()} onOpen={id => openReview(id)} />
          : <p className="m-0 px-1 text-[12px] text-token-secondary">没有稿件：内容来自和快速创作的对话，文案按对话先写。</p>}
      </UserTurn>
      <AgentTurn status={agentStatus}>
        {run.status === 'queued' && <QueueCard run={run} />}
        {run.status !== 'queued' && run.trial?.status !== 'ready' && <RunProgress run={run} />}
        {run.status !== 'done' && <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-token-muted" data-qc="saved-notice">
          <Check size={13} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />{run.status === 'queued' || (run.status === 'running' && run.trial?.status !== 'ready') ? '已保存，可以离开，做好了会通知你' : run.trial?.status === 'ready' ? '已保存，试看会一直保留' : '稿件和要求已保存'}
        </p>}
        {run.trial?.status === 'making' && (
          <p className="m-0 text-[12.5px] leading-5 text-token-secondary" data-qc="trial-note">先做试看：片头和第 1 幕，带配音。做好后在右边播放给你看，满意再做完剩下的 {run.trial.restScenes} 幕。</p>
        )}
        {run.trial?.status === 'ready' && (
          <section className="qc-rise" data-qc="trial-card">
            <div className="text-[22px] font-semibold tracking-tight text-token-primary">试看好了</div>
            <div className="mt-1 text-[13px] text-token-secondary">片头和第 1 幕，约 {run.trial.seconds} 秒</div>
            <p className="m-0 mt-3 text-[13px] leading-5 text-token-secondary">
              满意就接着做完剩下的 {run.trial.restScenes} 幕（约 {run.trial.restMin[0]}–{run.trial.restMin[1]} 分钟），试看的两幕直接沿用；等你确认时不占排队名额。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" className="qc-face qc-face-primary relative px-3.5" data-qc="trial-approve" disabled={approving} onClick={() => void onApproveTrial()}>
                {approving ? <MapSpinner size={13} /> : <Check size={14} />}满意，继续做完
              </Button>
              <Button variant="ghost" size="sm" className="max-md:min-h-11" data-qc="trial-back" onClick={backFromTrial}>不满意，回去换风格或改要求</Button>
            </div>
          </section>
        )}
        {run.trial?.status === 'approved' && run.status !== 'done' && (
          <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-token-secondary" data-qc="trial-approved"><Check size={14} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />试看已确认，接着做剩下的 {run.trial.restScenes} 幕。</p>
        )}
        {run.status === 'failed' && run.failure && <FailureCard failure={run.failure} onAction={a => void onRecover(a)} />}
        {run.status === 'done' && (
          <section className="qc-rise" data-qc="done-card">
            <div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-token-primary"><CircleCheck size={19} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />{run.kind === 'video' ? '成片好了' : '网页好了'}</div>
                <div className="mt-1 text-[13px] leading-5 text-token-secondary">
                  {run.kind === 'video' ? `${formatClock(run.durationSec ?? 0)}${run.targetSec ? `（目标约 ${minutesLabel(run.targetSec)}）` : ''} · ${run.scenes?.length ?? 0} 幕 · 1080p` : `${run.sections?.length ?? 0} 节 · 适配手机`}，右边可以直接{run.kind === 'video' ? '播放' : '浏览'}。
                </div>
              </div>
            </div>
            <div className="mt-3.5">
              {run.publish.status === 'none' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button variant="primary" className="max-md:min-h-11" onClick={() => void onPublish()} data-qc="publish"><Globe size={14} />发布到网页托管</Button>
                  <span className="text-[12px] text-token-muted">{run.bundle ? `发布的是能播放的网页（约 ${Math.max(1, Math.round(run.bundle.bytes / 1_000_000))} MB），不传视频文件` : '发布后得到可分享的链接'}</span>
                </div>
              )}
              {run.publish.status === 'publishing' && <div className="flex h-9 items-center gap-2 text-[12.5px] text-token-secondary"><MapSpinner size={13} />正在上传到网页托管…</div>}
              {run.publish.status === 'failed' && (
                <div className="rounded-[10px] border p-3" style={{ borderColor: 'var(--semantic-danger-border)', background: 'var(--semantic-danger-soft)' }} role="alert" data-qc="publish-failed">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--accent-fg-error)' }}>发布没有完成</div>
                  <div className="mt-0.5 text-[12px] leading-5 text-token-secondary">{run.publish.error}。{run.kind === 'video' ? '成片' : '网页'}已保存在作品里，右边照常可看；重试只上传，不会重新生成。</div>
                  <Button size="sm" variant="primary" className="mt-2.5 max-md:min-h-11" data-qc="publish-retry" onClick={() => void onPublish()}>重试发布</Button>
                </div>
              )}
              {run.publish.status === 'done' && (
                <div className="rounded-[10px] border p-3" style={{ borderColor: 'var(--semantic-success-border)', background: 'var(--semantic-success-soft)' }} data-qc="published">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-token-primary">
                    <Check size={15} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />已发布到网页托管
                  </div>
                  <div className="mt-0.5 truncate pl-[23px] text-[12px] text-token-secondary">{run.publish.siteTitle} · 拿到链接的人都能打开</div>
                  <Button size="sm" variant="secondary" className="ml-[23px] mt-2.5 max-md:min-h-11" data-qc="open-hosting" onClick={() => navigate(`/web-pages?focusSite=${encodeURIComponent(run.publish.siteId ?? '')}`)}>
                    <ExternalLink size={13} />在网页托管中查看
                  </Button>
                </div>
              )}
            </div>
            <BrowserExport run={run} />
          </section>
        )}
      </AgentTurn>
    </>
  );
  const runFooter = run && (
    <div className="flex items-center justify-end gap-2 px-1">
      {run.status === 'queued' || run.status === 'running' ? (
        <Button size="sm" variant="ghost" className="max-md:min-h-11" data-qc="leave" onClick={() => setParams({ view: 'works' })}>离开，稍后回来</Button>
      ) : run.status === 'failed' ? (
        <span className="text-[12px] text-token-muted">已完成的部分都已保存，也可以稍后在「我的作品」里继续。</span>
      ) : (
        <Button size="sm" variant="ghost" className="max-md:min-h-11" data-qc="redo-other" onClick={() => { setAttachments(run.attachments.filter(a => a.status === 'ready')); setAsk(run.ask); setKind(run.kind === 'video' ? 'web' : 'video'); setTemplateId(run.templateId); setParams({}); setPane('chat'); }}>
          用这份稿件做{run.kind === 'video' ? '网页' : '视频'}
        </Button>
      )}
    </div>
  );

  /* ---------- 右栏 ---------- */
  let previewTitle = '风格库';
  let previewNote = `${categories.length} 类 · ${templates.length} 种风格，按画面像什么分类；当前做${OUTPUT_LABEL[kind]}`;
  let nextHint = '选好风格后，在左边放进稿件，点「快捷生成」；也可以在输入框的风格按钮里就地换。';
  let toolbar: ReactNode = null;
  let actions: ReactNode = null;
  let body: ReactNode = null;

  if (runError) {
    previewTitle = '没有找到任务'; previewNote = runError; nextHint = '';
    body = <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-token-secondary">{runError}。可以从「我的作品」重新进入，或新建一个。</div>;
  } else if (panel?.mode === 'manage') {
    previewTitle = `资料 · ${sum.total} 份`;
    previewNote = '读取失败的资料不会用于生成；重试只重新读取这一份';
    nextHint = '';
    actions = <Button size="sm" variant="secondary" className="max-md:min-h-11" onClick={() => { setPanel(null); setPane('chat'); }}>完成</Button>;
    body = <MaterialsPanel mode="manage" items={attachments} activeId={panel.id} onSelect={id => setPanel({ mode: 'manage', id })}
      onRemove={id => setAttachments(l => l.filter(a => a.id !== id))} onRetry={id => void retryRead(id)} onClearFailed={() => setAttachments(l => l.filter(a => a.status !== 'failed'))} />;
  } else if (panel?.mode === 'review' && run) {
    previewTitle = `原稿 · ${run.attachments.filter(a => a.status === 'ready').length} 份资料`;
    previewNote = '提交时交给生成的资料，只读';
    nextHint = '';
    actions = <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="review-back" onClick={() => setPanel(null)}>回到预览</Button>;
    body = <MaterialsPanel mode="review" items={run.attachments} activeId={panel.id} onSelect={id => setPanel({ mode: 'review', id })} />;
  } else if (rightTab === 'assets') {
    previewTitle = '产物';
    previewNote = `${assetScope === 'mine' ? '我' : '团队'}生成过的视频与网页，可回看、打开原任务或把风格带回输入框`;
    nextHint = '';
    body = <AssetLibrary assets={assets} loading={assetsLoading} scope={assetScope} onScopeChange={setAssetScope} templates={templates} currentStyleId={run ? undefined : template?.id}
      onOpen={a => setParams({ run: a.runId })}
      onUseStyle={a => {
        const name = templates.find(t => t.id === a.templateId)?.name ?? '';
        setTemplateId(a.templateId); setRightTab('select');
        if (run) { setParams({}); setPane('chat'); }
        toast.info(`已换成「${name}」风格`, run ? '放进稿件后即可用这个风格生成' : '输入框里的风格已同步');
      }}
      onOpenHosting={a => navigate(`/web-pages?focusSite=${encodeURIComponent(a.siteId ?? '')}`)} />;
  } else if (!run && template) {
    body = <StyleLibrary templates={templates} categories={categories} source={styleSource} selected={template} onSelect={setTemplateId} kind={kind} />;
  } else if (run && runTemplate) {
    if (run.trial?.status === 'ready' && run.kind === 'video') {
      previewTitle = '试看';
      previewNote = `片头和第 1 幕 · 约 ${run.trial.seconds} 秒 · 配音 ${run.voice ?? '女声'} · 风格 ${runTemplate.name}`;
      nextHint = '';
      body = <VideoPlayer run={run} template={runTemplate} />;
    } else if (run.status === 'done') {
      previewTitle = run.kind === 'video' ? '成片' : '网页';
      previewNote = `${run.kind === 'video' ? `${formatClock(run.durationSec ?? 0)} · ${run.scenes?.length ?? 0} 幕 · 1080p${run.voice ? ` · 配音 ${run.voice}` : ''}` : `${run.sections?.length ?? 0} 节 · 桌面与手机都能读`} · 风格 ${runTemplate.name}`;
      nextHint = '';
      body = run.kind === 'video' ? <VideoPlayer run={run} template={runTemplate} /> : <WebPreview run={run} template={runTemplate} />;
    } else {
      previewTitle = run.kind === 'video' ? '分镜' : '页面';
      previewNote = run.status === 'failed' ? '已完成的部分保留' : '';
      nextHint = '';
      body = <ProgressPreview run={run} template={runTemplate} />;
    }
  }

  /* 选择与资产的页签：资料面板打开时让位给面板的动作 */
  if (!panel && !runError) toolbar = (
    /* 公共组件 Segmented 沿用正式实现（28px），触控高度差异记为框架债务 */
    <span data-qc-touch-exempt>
      <Segmented<'select' | 'assets'> label="选择与资产" value={rightTab} onChange={setRightTab}
        options={[{ value: 'select', label: run ? '本次' : '风格', title: run ? '这次任务的过程与成品' : '选这次用的风格' }, { value: 'assets', label: '产物', title: '回看已生成的视频与网页' }]} />
    </span>
  );
  const preview = (
    <WorkbenchPreview title={previewTitle} note={previewNote} toolbar={toolbar} actions={actions} nextHint={nextHint}>
      {body}
    </WorkbenchPreview>
  );

  const loading = runId && !run && !runError;
  /* 风格目录读到之前不标「可以创作」：输入框里的风格按钮和右栏风格库都依赖它 */
  const ready = loading ? undefined : run ? `run-${run.status}` : templates.length ? 'compose' : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col" data-qc-ready={ready} data-output={run?.kind ?? kind} data-run-id={run?.id ?? ''}>
      {header}
      {/* 窄屏：对话 / 预览切换（公共组件 PaneTabs，32px 触控高度记为框架债务） */}
      {run && <div className="flex shrink-0 items-center border-b border-token-subtle px-3 py-1.5 lg:hidden" data-qc-touch-exempt>
        <PaneTabs pane={pane} onChange={setPane} previewBadge={run?.status === 'done' ? (run.kind === 'video' ? '成片' : '网页') : undefined} />
      </div>}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-token-muted"><MapSpinner size={14} />正在打开任务…</div>
        ) : run ? (
          <WorkbenchLayout pane={pane} conversation={runConversation} composer={runFooter} preview={preview} />
        ) : chatting ? chatBody : landingBody}
      </div>
      {!run && composeSheets}
    </div>
  );
}

export default QuickCreationAgentPage;
