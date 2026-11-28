/**
 * 快速创作智能体：一份文档 + 一个模板 → 能播放的视频或能浏览的网页，并发布到网页托管。
 * - 生成在服务端排队执行，离开页面不取消；地址里的 ?run= 让用户回到同一个任务。
 * - 版式沿用网页生成工作台（WorkbenchLayout）：左栏一个对话 + 底部一个输入框；右栏是选模板、管理资料和预览。窄屏切成「对话 / 预览」。
 * - 与「视频创作智能体」的区别：那边用生成式视频模型出镜头，这里用文稿 + 配音 + 可复用的模板画面代码。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, CircleCheck, ExternalLink, FileText, Globe, LayoutList, Mic, Paperclip, Plus, Send, Video } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useSpeechInput } from '@/lib/useSpeechInput';
import { toast } from '@/lib/toast';
import { TEAM_ID_PATTERN } from '@/lib/designArtifactLaunch';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Dialog } from '@/components/ui/Dialog';
import KnowledgeEntryPicker, { type KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import { PaneTabs, Segmented, WorkbenchLayout, WorkbenchPreview, fitComposerHeight, type WorkbenchPane } from '@/components/web-hosting/workbench/WorkbenchParts';
import {
  addKnowledgeAttachment, approveQuickCreationTrial, createQuickCreationRun, estimateQuickCreation, getQuickCreationRun, listQuickCreationAssets, listQuickCreationTemplates, listQuickCreationWorks,
  addTextAttachment, publishQuickCreationRun, retryAttachmentRead, retryQuickCreationRun, uploadQuickCreationAttachment,
} from '@/services/real/quickCreation';
import { AttachmentTray, MaterialsPanel, SentAttachments } from './AttachmentTray';
import { AgentTurn, UserTurn } from './Conversation';
import { BriefConversation, BriefStrip } from './BriefChat';
import { useQuickCreationBrief } from './useQuickCreationBrief';
import { FailureCard, QueueCard, RunProgress, stageName } from './RunProgress';
import { ProgressPreview, VideoPlayer, WebPreview } from './ResultPanel';
import { DurationOptions, durationShort, minutesLabel, TrialToggle } from './Duration';
import { BrowserExport, BrowserFilmPlayer } from './BrowserExport';
import { StyleLibrary, StylePickerChip } from './StyleLibrary';
import { AssetLibrary } from './AssetLibrary';
import { WorksList } from './WorksList';
import { RecentWorks, Sheet, Starters, StyleInspiration } from './Landing';
import { formatClock, summarizeAttachments } from './format';
import type { AssetScope, DurationChoice, OutputKind, QcAsset, QcAttachment, QcBriefContext, QcBriefSession, QcEstimate, QcFailure, QcRun, QcTemplate, QcTemplateCategory, QcTemplateSource, QcWork } from './types';
import './quickCreation.css';

const OUTPUT_LABEL: Record<OutputKind, string> = { video: '视频', web: '网页' };
const SAMPLE_KB_ENTRY = 'sample-review-habits';
const RETRY_RUN_READ_ERRORS = new Set(['DISCONNECTED', 'NETWORK_ERROR', 'SERVER_ERROR', 'SERVER_UNAVAILABLE', 'TIMEOUT']);

function runBadge(run: QcRun) {
  if (run.status === 'queued') return { label: `排队中 · 第 ${run.queue?.position ?? '-'} 位`, variant: 'new' as const };
  if (run.status === 'running') return { label: '生成中', variant: 'new' as const };
  if (run.status === 'trial-ready') return { label: '试看待确认', variant: 'warning' as const };
  if (run.status === 'failed') return { label: '需要处理', variant: 'danger' as const };
  if (run.publish.status === 'done') return { label: '已发布', variant: 'success' as const };
  if (run.publish.status === 'failed') return { label: '发布未完成', variant: 'warning' as const };
  return { label: '已生成', variant: 'subtle' as const };
}

export function QuickCreationAgentPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const briefId = params.get('brief');
  const view = params.get('view');
  const filmComparison = params.get('filmComparison') ?? undefined;
  const fromHosting = params.get('from') === 'web-pages';
  const requestedTeam = params.get('destTeam');
  const destinationTeamId = fromHosting && requestedTeam && TEAM_ID_PATTERN.test(requestedTeam) ? requestedTeam : undefined;

  const [templates, setTemplates] = useState<QcTemplate[]>([]);
  const [categories, setCategories] = useState<QcTemplateCategory[]>([]);
  const [styleSource, setStyleSource] = useState<QcTemplateSource | undefined>();
  const [works, setWorks] = useState<QcWork[]>([]);
  const [run, setRun] = useState<QcRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const [kind, setKind] = useState<OutputKind>(fromHosting ? 'web' : 'video');
  const [templateId, setTemplateId] = useState<string>('');
  const [stylePicked, setStylePicked] = useState(false);
  const [duration, setDuration] = useState<DurationChoice>('auto');
  const [estimate, setEstimate] = useState<QcEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimateRetry, setEstimateRetry] = useState(0);
  const [browserFilm, setBrowserFilm] = useState(false);
  const [trialChoice, setTrialChoice] = useState<boolean | null>(null);
  const [approving, setApproving] = useState(false);
  const [attachments, setAttachments] = useState<QcAttachment[]>([]);
  const [ask, setAsk] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  const recentWorks = useRef<HTMLElement>(null);
  const [recentTab, setRecentTab] = useState<'mine' | 'team'>('mine');
  const speechBase = useRef('');
  const speech = useSpeechInput({
    onResult: (finalText, interim) => setAsk(speechBase.current + finalText + interim),
    onError: message => toast.error('语音输入', message.startsWith('语音识别出错') ? '语音识别没有完成，请重试或直接输入' : message),
  });
  const toggleVoice = () => {
    if (!speech.listening) speechBase.current = ask;
    try { speech.toggle(); }
    catch {
      speech.cancel();
      toast.error('语音输入', '无法启动语音输入，请检查麦克风后重试');
    }
  };
  const [submitting, setSubmitting] = useState(false);
  const [adding, setAdding] = useState(false);
  const addingFiles = useRef(false);
  const failedUploads = useRef(new Map<string, File>());
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeSelection, setKnowledgeSelection] = useState<KnowledgeEntrySelection[]>([]);
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
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
  const restoreBrief = useCallback((value: QcBriefSession) => {
    setKind(value.kind);
    setDuration(value.durationChoice ?? 'auto');
    setTemplateId(value.styleId);
    setStylePicked(value.brief.fields.find(field => field.key === 'style')?.source === 'pick');
    setAttachments(value.attachments);
    if (value.draft && !value.busy) setAsk(current => current || value.draft || '');
  }, []);
  const briefFlow = useQuickCreationBrief(briefId, restoreBrief);
  const { session: brief, pending: pendingBrief, restoring: restoringBrief, syncing: syncingBrief, sync: syncBrief, error: briefError } = briefFlow;
  useEffect(() => {
    const input = askRef.current;
    if (!input) return;
    if (!isMobile) {
      fitComposerHeight(input);
      return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 160)}px`;
  }, [ask, isMobile]);

  useEffect(() => {
    void listQuickCreationTemplates().then(res => { if (res.success) { setTemplates(res.data.items); setCategories(res.data.categories); setStyleSource(res.data.source); setBrowserFilm(res.data.browserFilm === true); } });
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

  /* 首次进入与自动恢复都按地址里的任务编号读取。 */
  useEffect(() => {
    setRun(null); setRunError(null); setReconnecting(false); setPanel(null); setRightTab('select');
    if (!runId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      const res = await getQuickCreationRun(runId, controller.signal);
      if (controller.signal.aborted) return;
      if (res.success) {
        setReconnecting(false);
        setRun(res.data);
      } else if (RETRY_RUN_READ_ERRORS.has(res.error.code)) {
        setReconnecting(true);
        timer = window.setTimeout(load, 4000);
      } else {
        setReconnecting(false);
        setRunError(res.error.message || '没有找到这个任务');
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [runId]);

  /* 读失败时保留上次进度，自动回查同一个任务。 */
  const isLive = !!run && run.id === runId && (run.status === 'queued' || run.status === 'running' || run.publish.status === 'publishing');
  useEffect(() => {
    if (!isLive || !runId) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      const res = await getQuickCreationRun(runId, controller.signal);
      if (controller.signal.aborted) return;
      setReconnecting(!res.success);
      if (res.success) setRun(res.data);
      timer = window.setTimeout(poll, res.success ? 1000 : 4000);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [isLive, runId]);

  const showPage = (target: Record<string, string>, replace = false) => {
    const query = new URLSearchParams(target);
    if (fromHosting) query.set('from', 'web-pages');
    if (destinationTeamId) query.set('destTeam', destinationTeamId);
    setParams(query, { replace });
  };
  const openRun = (id: string) => showPage({ run: id });
  const approveTrial = async (item: QcRun) => {
    setApproving(true);
    const result = await approveQuickCreationTrial(item.id).finally(() => setApproving(false));
    if (result.success) openRun(result.data.id);
    else toast.error('没有继续生成', result.error?.message ?? '试看仍保留，可以稍后再试');
  };
  const reviseTrial = (item: QcRun) => {
    showPage({}); setKind(item.kind); setTemplateId(item.templateId); setStylePicked(true);
    setDuration(item.durationChoice ?? 'auto'); setTrialChoice(true); setAsk(item.briefUserRequests ?? item.ask);
    setAttachments(item.attachments); setPane('chat'); setPanel(null); setRightTab('select');
  };
  const startNew = () => {
    speech.cancel();
    failedUploads.current.clear();
    showPage({});
    setKind(fromHosting ? 'web' : 'video');
    setDuration('auto');
    setTrialChoice(null);
    setAsk('');
    setAttachments([]);
    setPanel(null);
    setPane('chat');
    setRecentTab('mine');
  };

  /* ---------- 附件 ---------- */
  const uploadFileRow = async (id: string, file: File) => {
    const res = await uploadQuickCreationAttachment(file);
    if (res.success) {
      failedUploads.current.delete(id);
      setPanel(current => current?.mode === 'manage' && current.id === id ? { ...current, id: res.data.id } : current);
    }
    setAttachments(list => list.map(item => item.id !== id ? item : res.success ? res.data : {
      ...item, status: 'failed', progress: undefined, error: res.error?.message || '这次没有上传成功，请重试',
    }));
  };
  const addFiles = async (files: File[]) => {
    if (!files.length || adding || addingFiles.current || restoringBrief || submitting) return;
    const rows: QcAttachment[] = files.map(file => ({
      id: `upload-${crypto.randomUUID()}`, name: file.name, kind: /\.(png|jpe?g|webp)$/i.test(file.name) ? 'image' : 'doc',
      meta: `${(file.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`, status: 'reading',
    }));
    addingFiles.current = true;
    setAdding(true);
    setAttachments(list => [...list, ...rows]);
    rows.forEach((row, index) => failedUploads.current.set(row.id, files[index]));
    try {
      for (const [index, row] of rows.entries()) {
        if (failedUploads.current.has(row.id)) await uploadFileRow(row.id, files[index]);
      }
    } finally {
      addingFiles.current = false;
      setAdding(false);
    }
  };
  const removeAttachment = (id: string) => {
    failedUploads.current.delete(id);
    setAttachments(list => list.filter(item => item.id !== id));
  };
  const addKnowledge = async (entryId: string, storeId?: string) => {
    const res = await addKnowledgeAttachment(entryId, storeId);
    if (res.success) setAttachments(list => [...list.filter(a => a.id !== res.data.id), res.data]);
    else toast.error('知识库文档没有添加', res.error?.message || '请稍后重试');
  };
  const openKnowledge = () => {
    setKnowledgeSelection([]);
    setKnowledgeOpen(true);
    void listRecentDocumentEntries(8).then(result => {
      if (result.success) setRecentKnowledge(result.data.items);
    });
  };
  const addSelectedKnowledge = async () => {
    if (adding || addingFiles.current || restoringBrief || submitting) return;
    setKnowledgeOpen(false);
    setAdding(true);
    try {
      for (const selection of knowledgeSelection) await addKnowledge(selection.entryId, selection.storeId);
    } finally {
      setAdding(false);
    }
  };
  const retryRead = async (id: string) => {
    setAttachments(list => list.map(a => (a.id === id ? { ...a, status: 'reading', progress: 0, error: undefined } : a)));
    const file = failedUploads.current.get(id);
    if (file) { await uploadFileRow(id, file); return; }
    const res = await retryAttachmentRead(id);
    /* 重试本身失败时退回「读取失败」并写明原因，不能停在读取中 */
    setAttachments(list => list.map(a => (a.id !== id ? a : res.success ? res.data
      : { ...a, status: 'failed', progress: undefined, error: `${res.error?.message || '这次重试也没有成功'}，可以稍后再试或换一个文件` })));
  };
  /* 粘贴的长正文（一次增加 300 字以上）转成一份稿件附件，输入框只留给「要求」 */
  const PASTE_AS_DOC = 300;
  const onAskPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData('text/plain');
    if (pasted.length < PASTE_AS_DOC || adding || addingFiles.current) return;
    event.preventDefault();
    setAdding(true);
    const res = await addTextAttachment({ name: '粘贴的正文.md', text: pasted });
    setAdding(false);
    if (res.success) { setAttachments(list => [...list, res.data]); toast.info('已作为稿件附件', `粘贴的 ${pasted.length.toLocaleString('zh-CN')} 字已放进附件，输入框留给要求`); }
    else { setAsk(value => value ? value + '\n' + pasted : pasted); toast.error('没能转成附件', `${res.error?.message || '请稍后重试'}，正文暂时留在输入框里`); }
  };
  const sum = summarizeAttachments(attachments);
  const hasText = attachments.some(a => a.status === 'ready' && a.kind !== 'image');
  const attachmentBlockReason = adding || sum.reading ? '还有附件在读取，读完即可生成' : null;
  const blockReason = attachmentBlockReason ?? (!hasText ? '放进稿件才能生成，或者直接说想做什么' : null);
  const draftTitle = attachments.find(a => a.status === 'ready' && a.kind !== 'image')?.name.replace(/\.(md|markdown|txt)$/i, '') ?? (template ? `未命名 · ${template.name}` : '未命名');
  const briefContext = useMemo<QcBriefContext>(() => ({
    revision: brief?.revision ?? 0, kind, templateId: template?.id ?? '', stylePicked,
    attachmentIds: attachments.filter(a => a.status === 'ready').map(a => a.id),
    duration: kind === 'video' ? duration : undefined,
  }), [brief?.revision, kind, template?.id, stylePicked, attachments, duration]);
  const briefMatches = !!brief && brief.kind === kind && brief.styleId === template?.id
    && (kind !== 'video' || (brief.durationChoice ?? 'auto') === duration)
    && brief.attachments.map(a => a.id).join(',') === briefContext.attachmentIds.join(',');
  const estimateKey = briefContext.attachmentIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    setEstimate(null);
    setEstimateError(null);
    if (runId || kind !== 'video') return;
    void estimateQuickCreation(estimateKey ? estimateKey.split(',') : [], duration, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.success) setEstimate(result.data);
      else setEstimateError(result.error?.message ?? '暂时无法估算');
    });
    return () => controller.abort();
  }, [duration, estimateKey, estimateRetry, kind, runId]);
  const latestMaterials = useRef({ ids: '', blocked: false });
  latestMaterials.current = { ids: briefContext.attachmentIds.join(','), blocked: attachmentBlockReason !== null };
  const syncAttempt = useRef('');
  useEffect(() => {
    if (!brief || briefMatches || pendingBrief || restoringBrief || syncingBrief || !briefContext.templateId) return;
    const key = JSON.stringify([brief.id, briefContext]);
    if (key === syncAttempt.current) return;
    syncAttempt.current = key;
    void syncBrief(briefContext);
  }, [brief, briefContext, briefMatches, pendingBrief, restoringBrief, syncingBrief, syncBrief]);

  const submitLock = useRef(false);
  const submit = async (fromBrief?: QcBriefSession, mode: 'confirm' | 'skip' = 'skip', extraAsk = ask) => {
    if (submitLock.current || (!fromBrief && (blockReason || pendingBrief || restoringBrief)) || !template
      || (fromBrief && !fromBrief.brief.ready)) return;
    if (fromBrief && (latestMaterials.current.blocked || fromBrief.attachments.map(item => item.id).join(',') !== latestMaterials.current.ids)) {
      toast.info('请先确认资料', '检查读取状态和数量，再按当前简报生成');
      return;
    }
    speech.cancel();
    submitLock.current = true;
    setSubmitting(true);
    const output = fromBrief?.kind ?? kind;
    const res = await createQuickCreationRun({
      kind: output, templateId: fromBrief?.styleId ?? template.id, ask: extraAsk.trim(),
      attachmentIds: fromBrief?.attachments.map(a => a.id) ?? briefContext.attachmentIds, title: fromBrief?.brief.title ?? draftTitle,
      destinationTeamId: output === 'web' ? destinationTeamId : undefined,
      duration: output === 'video' ? (fromBrief ? fromBrief.durationChoice ?? 'auto' : duration) : undefined,
      trial: browserFilm && output === 'video' ? (filmComparison ? false : trialChoice ?? undefined) : undefined,
      ...(fromBrief ? { briefId: fromBrief.id, briefRevision: fromBrief.revision, briefMode: mode } : {}),
    }, filmComparison).finally(() => { submitLock.current = false; setSubmitting(false); });
    if (!res.success) { toast.error('没有提交成功', `${res.error?.message || '请稍后重试'}，稿件仍在输入框里`); return; }
    openRun(res.data.id);
  };
  const quickSubmit = () => {
    if (pendingBrief || restoringBrief || syncingBrief || (brief && (!briefMatches || !brief.brief.ready))) return;
    void submit(brief ?? undefined);
  };
  const acceptBrief = (value: QcBriefSession) => {
    setKind(value.kind);
    setDuration(value.durationChoice ?? 'auto');
    setTemplateId(value.styleId);
    setStylePicked(value.brief.fields.find(field => field.key === 'style')?.source === 'pick');
  };
  const requestScript = async (value: QcBriefSession) => {
    const result = await briefFlow.send({
      id: value.id, turnId: crypto.randomUUID().replaceAll('-', ''), mode: 'script', text: '',
      context: { ...briefContext, kind: value.kind, templateId: value.styleId, revision: value.revision,
        stylePicked: value.brief.fields.find(field => field.key === 'style')?.source === 'pick',
        attachmentIds: value.attachments.map(a => a.id) },
    });
    if (result) acceptBrief(result.session);
  };
  const continueBrief = async (result: { session: QcBriefSession; start: boolean } | null) => {
    if (!result) return;
    acceptBrief(result.session);
    if (!result.start) return;
    if (result.session.kind === 'video') {
      if (result.session.script.length === 0) await requestScript(result.session);
    } else {
      await submit(result.session, 'skip', '');
    }
  };
  const sendToBrief = async (value: string) => {
    const text = value.trim();
    if (!text || !template || pendingBrief || restoringBrief || syncingBrief || adding || sum.reading || submitLock.current) return;
    speech.cancel();
    const id = briefId ?? crypto.randomUUID().replaceAll('-', '');
    if (!briefId) showPage({ brief: id }, true);
    if (ask.trim() === text) setAsk('');
    await continueBrief(await briefFlow.send({ id, turnId: crypto.randomUUID().replaceAll('-', ''), mode: 'message', text, context: briefContext }));
  };
  const selectStyle = (id: string) => { setStylePicked(true); setTemplateId(id); setPanel(null); };
  const briefDisabled = !!pendingBrief || syncingBrief || restoringBrief || !!attachmentBlockReason || submitting || !briefMatches;

  /* ---------- 任务动作 ---------- */
  const onRecover = async (action: QcFailure['actions'][number]) => {
    if (!run) return;
    const res = await retryQuickCreationRun(run.id, { action, unitIndex: run.failure?.unitIndex });
    if (res.success) { setRun(res.data); showPage({ run: res.data.id }, true); }
    else toast.error('没有重新开始', res.error?.message || '请稍后再试');
  };
  const onPublish = async () => {
    if (!run) return;
    setRun({ ...run, publish: { ...run.publish, status: 'publishing', error: undefined } });
    const res = await publishQuickCreationRun(run.id);
    if (res.success) setRun(res.data);
    else setRun({ ...run, publish: { status: 'failed', error: res.error?.message || '网页托管这次没有响应' } });
  };

  const chatting = Boolean(briefId || brief || pendingBrief);
  const badge = run && view !== 'works' ? runBadge(run) : null;
  const header = (
    <header className={`flex min-h-14 shrink-0 items-center gap-2 px-2 py-2 md:gap-3 md:px-5 ${runId || view === 'works' ? 'border-b border-token-subtle' : ''}`}>
      <button type="button" aria-label={fromHosting ? '返回网页托管' : '返回百宝箱'} onClick={() => navigate(fromHosting ? '/web-pages' : '/ai-toolbox')} className="qc-icon-btn"><ChevronLeft size={18} /></button>
      <div className="min-w-0 flex-1">
        {runId && <div className="flex items-center gap-2">
          <span className="text-[11px] text-token-muted">快速创作</span>
          {/* 窄屏把状态放到标题上方这一行，标题保持完整宽度 */}
          {badge && <span className="md:hidden"><Badge size="sm" variant={badge.variant}>{badge.label}</Badge></span>}
        </div>}
        <div className="truncate text-[15px] font-semibold text-token-primary" data-qc="project-title">
          {view === 'works' ? '我的作品' : run?.title ?? (runId || chatting || attachments.length ? draftTitle : '快速创作')}
        </div>
      </div>
      {badge && <span className="hidden md:inline-flex"><Badge variant={badge.variant}>{badge.label}</Badge></span>}
      {view !== 'works' && (
        <Button variant="ghost" size="sm" className="max-md:min-h-11" data-qc="works-link" onClick={() => {
          if (recentWorks.current) {
            setRecentTab('mine');
            recentWorks.current.scrollIntoView({ block: 'start' });
          } else showPage({ view: 'works' });
        }} aria-label={`我的作品，共 ${works.length} 个`}>
          <LayoutList size={15} /><span className="hidden sm:inline">我的作品</span> {works.length}
        </Button>
      )}
      {(runId || chatting) && view !== 'works' && <Button variant="secondary" size="sm" className="max-md:min-h-11" onClick={startNew} aria-label="新建"><Plus size={14} /><span className="hidden sm:inline">新建</span></Button>}
    </header>
  );

  if (view === 'works') {
    return (
      <div className="qc-scope flex h-full min-h-0 flex-col" data-qc-ready="works">
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorksList works={works} templates={templates} onOpen={openRun} onCreate={startNew} />
        </div>
      </div>
    );
  }

  const openManage = () => { setPanel({ mode: 'manage' }); };
  const openMaterial = (id: string) => { setPanel({ mode: 'manage', id }); };
  const openReview = (id?: string) => { setPanel({ mode: 'review', id }); setPane('preview'); };

  const chatFeed = (
    <>
    {restoringBrief && <AgentTurn><span className="inline-flex items-center gap-2 text-[13px] text-token-secondary" role="status">
      <MapSpinner size={14} />正在接回创作简报
    </span></AgentTurn>}
    <BriefConversation session={brief} pending={pendingBrief} error={briefError} templates={templates} disabled={briefDisabled}
      onRetry={() => void briefFlow.recover().then(continueBrief)}
      onSend={text => void sendToBrief(text)} onPick={selectStyle} targetDuration={estimate?.targetSec}
      trialControl={browserFilm && kind === 'video' ? <TrialToggle on={trialChoice ?? estimate?.trialDefault ?? false} estimate={estimate} onChange={setTrialChoice} /> : null}
      onScript={() => { if (brief && !briefDisabled) void requestScript(brief); }}
      onGenerate={mode => { if (brief && !briefDisabled) void submit(brief, mode); }} />
    </>
  );

  const showSend = !!ask.trim() && !hasText;
  const composerBusy = !!pendingBrief || restoringBrief || syncingBrief || adding || sum.reading > 0 || submitting;
  const quickBlockReason = blockReason ?? (brief && (!briefMatches || !brief.brief.ready) ? '请确认当前创作简报后再生成' : !template ? '正在读取风格，请稍候' : null);
  const outputSwitch = (
    <span data-qc-touch-exempt className="inline-flex shrink-0">
      <Segmented<OutputKind> label="选择产出" value={kind} onChange={setKind}
        options={[{ value: 'video', label: '视频', title: '能播放的成片：配音、字幕与画面' }, { value: 'web', label: '网页', title: '能浏览的网页：桌面与手机都能读' }]} />
    </span>
  );
  /* 「做成什么」按钮：产出、时长、先试看都收在这里，输入框上只露一个词 */
  const durationLabel = durationShort(duration, estimate);
  const outputChip = (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" data-qc="output-chip" data-output={kind} data-duration={kind === 'video' ? String(duration) : undefined}
          aria-label={`做成${OUTPUT_LABEL[kind]}${kind === 'video' ? `，${durationLabel}` : ''}，点此更换`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[13px] text-token-primary hover-bg-soft max-md:h-11 max-md:px-1">
          {kind === 'video' ? <Video size={15} className="text-token-muted" aria-hidden /> : <Globe size={15} className="text-token-muted" aria-hidden />}
          {OUTPUT_LABEL[kind]}{kind === 'video' && <span className="text-token-muted">{durationLabel.replace(/^约 /, '')}</span>}
          <ChevronDown size={13} className="text-token-muted" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} data-qc="output-popover" aria-label="做成什么"
          className="qc-menu-surface max-h-[var(--radix-popover-content-available-height)] overflow-y-auto z-[110] w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-[var(--border-default)] p-4 shadow-lg">
          <div className="text-[12.5px] text-token-muted">做成什么</div>
          <div className="mt-2">{outputSwitch}</div>
          {kind === 'video' ? (
            <>
              <div className="mt-4 text-[12.5px] text-token-muted">多长</div>
              <div className="mt-2"><DurationOptions compact value={duration} estimate={estimate} onChange={setDuration} /></div>
              {browserFilm && <div className="mt-2"><TrialToggle on={trialChoice ?? estimate?.trialDefault ?? false} estimate={estimate} onChange={setTrialChoice} /></div>}
              {estimateError && <div className="mt-2 flex items-center gap-2 text-[12px] text-token-muted" role="status">
                {estimateError}<button type="button" className="underline" onClick={() => setEstimateRetry(n => n + 1)}>重新估算</button>
              </div>}
            </>
          ) : <p className="m-0 mt-3 text-[12.5px] leading-5 text-token-secondary">网页按内容分 4–5 节，桌面和手机都能读。</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  const placeholder = speech.listening ? '正在听，直接说…'
    : hasText ? '补充要求（可不填）；想问问题按 Enter' : '说说想做什么，或者放进一份稿件';
  const composer = (
    <div>
      {brief && <BriefStrip session={brief} />}
      <div className="qc-composer relative flex flex-col" data-listening={speech.listening ? 'true' : undefined}>
        <AttachmentTray items={attachments} managing={panel?.mode === 'manage'} onRemove={removeAttachment} onManage={openManage} onOpen={openMaterial} />
        {attachments.length > 0 && <div className="mx-3 h-px bg-[var(--border-subtle)]" />}
        <label htmlFor="qc-ask" className="sr-only">发给快速创作</label>
        <textarea id="qc-ask" ref={askRef} rows={chatting ? 1 : 2} value={ask} onChange={e => {
          speech.cancel();
          setAsk(e.target.value);
        }} onPaste={e => void onAskPaste(e)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) quickSubmit();
            else void sendToBrief(ask);
          }}
          title="Enter 发给快速创作；Ctrl / ⌘ + Enter 直接生成"
          placeholder={placeholder}
          className="block w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3.5 text-base leading-relaxed text-token-primary outline-none placeholder:text-token-muted sm:text-[15px]" />
        <div className="flex min-w-0 items-center gap-0.5 px-2 pb-2 pt-1" data-qc="composer-tools">
          <input ref={fileInput} type="file" accept=".md,.markdown,.txt,.png,.jpg,.jpeg,.webp" multiple hidden data-qc="file-input"
            onChange={e => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addFiles(files);
            }} />
          <Popover.Root open={plusOpen} onOpenChange={setPlusOpen}>
            <Popover.Trigger asChild>
              <button type="button" aria-label="放进稿件" title="放进稿件" data-qc="composer-plus" className="qc-icon-btn"><Plus size={19} /></button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12} data-qc="plus-menu"
                className="qc-menu-surface z-[110] flex w-60 flex-col rounded-xl border border-[var(--border-default)] p-1 shadow-lg">
                {[
                  { qc: 'plus-upload', icon: Paperclip, label: '上传稿件或图片', on: () => fileInput.current?.click() },
                  { qc: 'plus-knowledge', icon: BookOpen, label: '从知识库选择', on: openKnowledge },
                  { qc: 'plus-sample', icon: FileText, label: '用示例稿件试一下', on: () => void addKnowledge(SAMPLE_KB_ENTRY) },
                ].map(o => (
                  <button key={o.qc} type="button" data-qc={o.qc} className="flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-token-primary hover-bg-soft md:h-10"
                    onClick={() => { setPlusOpen(false); o.on(); }}><o.icon size={16} className="text-token-secondary" aria-hidden />{o.label}</button>
                ))}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {outputChip}
          <StylePickerChip templates={templates} categories={categories} selected={template} onSelect={selectStyle}
            onBrowse={() => setStyleSheetOpen(true)} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {speech.supported && (
              <button type="button" data-qc="voice" className="qc-icon-btn" aria-pressed={speech.listening}
                aria-label={speech.listening ? '停止语音输入' : '语音输入'} onClick={toggleVoice}>
                {speech.listening ? <span className="qc-wave" aria-hidden><i /><i /><i /></span> : <Mic size={17} aria-hidden />}
              </button>
            )}
            {showSend ? (
              <button className="qc-face qc-face-send relative inline-flex items-center justify-center" type="button"
                aria-label="发给快速创作" title="发给快速创作" data-qc="brief-send" disabled={composerBusy || !template}
                onClick={() => void sendToBrief(ask)}>{pendingBrief ? <MapSpinner size={13} /> : <ArrowUp size={16} strokeWidth={2.4} aria-hidden />}</button>
            ) : (
              <Button variant={brief?.brief.ready ? 'secondary' : 'primary'} size="sm"
                className={`qc-face relative shrink-0 px-3 ${brief?.brief.ready ? 'qc-face-secondary' : 'qc-face-primary'}`}
                disabled={!!quickBlockReason || composerBusy || !template} onClick={quickSubmit} data-qc="submit"
                data-block-reason={quickBlockReason ?? undefined} title={quickBlockReason ?? '直接生成（Ctrl / ⌘ + Enter）'}
                aria-label={quickBlockReason ? `生成：${quickBlockReason}` : '生成'}>
                {submitting ? <MapSpinner size={13} /> : <Send size={13} aria-hidden />}生成
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
        <h1 className="m-0 text-center text-[34px] font-semibold leading-tight tracking-[-0.02em] text-token-primary max-md:text-[24px]">把一份文档，变成视频或网页</h1>
        <div className="mt-8 max-md:mt-6">{composer}</div>
        <Starters onSample={() => void addKnowledge(SAMPLE_KB_ENTRY)} onKnowledge={openKnowledge} onSay={t => void sendToBrief(t)} showSay={!attachments.length && !!template} />
        {fromHosting && <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => navigate('/web-pages?legacyCreate=1')}>参考网页或制作网页 PPT</Button>
        </div>}
        <StyleInspiration templates={templates} selectedId={template?.id} onSelect={selectStyle} onBrowseAll={() => setStyleSheetOpen(true)} />
        <RecentWorks sectionRef={recentWorks} tab={recentTab} onTabChange={setRecentTab} works={works} templates={templates} onOpenWork={openRun} onAllWorks={() => showPage({ view: 'works' })} currentStyleId={template?.id}
          onUseStyle={a => { selectStyle(a.templateId); toast.info(`已换成「${templates.find(t => t.id === a.templateId)?.name ?? ''}」风格`, '放进你自己的稿件就能用这个风格生成'); }}
          onOpenAsset={a => openRun(a.runId)}
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
        {template && <StyleLibrary templates={templates} categories={categories} source={styleSource} selected={template} onSelect={selectStyle} kind={kind} />}
      </Sheet>
      <Sheet open={!run && panel?.mode === 'manage'} onOpenChange={v => { if (!v) setPanel(null); }} title={`资料 · ${sum.total} 份`} qc="materials-sheet" wide>
        <MaterialsPanel mode="manage" items={attachments} activeId={panel?.id} onSelect={id => setPanel({ mode: 'manage', id })}
          onRemove={removeAttachment} onRetry={id => void retryRead(id)} onClearFailed={() => {
            attachments.filter(item => item.status === 'failed').forEach(item => failedUploads.current.delete(item.id));
            setAttachments(list => list.filter(item => item.status !== 'failed'));
          }} />
      </Sheet>
    </>
  );

  /* ---------- 左栏 · 任务：你的那一条 + 助手这一轮 ---------- */
  const runTemplate = templates.find(t => t.id === run?.templateId);
  const agentStatus = run?.status === 'failed' ? '需要你处理' : run?.status === 'trial-ready' ? '等你确认试看' : null;
  const runConversation = run && (
    <>
      <UserTurn meta={<>{run.kind === 'video' ? <Video size={12} aria-hidden /> : <Globe size={12} aria-hidden />}{OUTPUT_LABEL[run.kind]}{run.targetDurationSec ? ` · 约 ${minutesLabel(run.targetDurationSec)}` : ''} · {runTemplate?.name}</>}>
        {run.contentSource === 'chat' && <p className="m-0 px-1 text-[12px] text-token-secondary">没有稿件，内容来自和快速创作的对话</p>}
        {run.briefUserRequests && (
          <details className="px-1 text-sm text-token-primary" data-qc="brief-run-requests">
            <summary className="cursor-pointer">对话中的创作要求</summary>
            <p className="my-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-6">{run.briefUserRequests}</p>
          </details>
        )}
        {(run.ask || !run.briefUserRequests) && (
          <p className="m-0 px-1 text-[14px] leading-6 text-token-primary">{run.ask || '没有补充要求，按模板默认节奏生成'}</p>
        )}
        <SentAttachments items={run.attachments} onOpenAll={() => openReview()} onOpen={id => openReview(id)} />
      </UserTurn>
      <AgentTurn status={agentStatus}>
        {run.status === 'queued' && <QueueCard run={run} />}
        {run.status !== 'queued' && <RunProgress run={run} />}
        {run.status !== 'done' && <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-token-muted" data-qc="saved-notice">
          <Check size={13} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />
          {run.status === 'queued' || run.status === 'running' ? '已保存，可以离开，做好后在「我的作品」查看' : run.status === 'trial-ready' ? '已保存，试看会一直保留' : '稿件和要求已保存'}
        </p>}
        {run.status === 'failed' && run.failure && <FailureCard failure={run.failure} onAction={a => void onRecover(a)} />}
        {run.status === 'trial-ready' && run.trial && (
          <section className="qc-rise space-y-2" data-qc="trial-ready">
            <div className="text-[20px] font-semibold tracking-tight text-token-primary">试看好了</div>
            <div className="text-[13px] text-token-secondary">片头和第 1 幕{run.trial.seconds ? `，约 ${Math.round(run.trial.seconds)} 秒` : ''}</div>
            <p className="m-0 text-xs text-token-secondary">可以先在右侧看画面和配音。等你确认时，任务暂停。</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-qc="trial-approve" disabled={approving} onClick={() => void approveTrial(run)}>满意，继续做完</Button>
              <Button size="sm" variant="secondary" data-qc="trial-revise" disabled={approving} onClick={() => reviseTrial(run)}>不满意，回去换风格或改要求</Button>
            </div>
          </section>
        )}
        {run.trial?.status === 'approved' && run.status !== 'done' && <p className="m-0 text-xs" data-qc="trial-approved">试看已确认，接着做剩下的 {run.trial.restScenes} 幕。</p>}
        {run.status === 'done' && (
          <section className="qc-rise" data-qc="done-card">
            <div className="flex items-start">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-token-primary"><CircleCheck size={19} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />{run.kind === 'video' ? '成片好了' : '网页好了'}</div>
                <div className="mt-0.5 text-[12.5px] leading-5 text-token-secondary">
                  {run.kind === 'video' ? [
                    run.durationSec ? `实际 ${formatClock(run.durationSec)}` : null,
                    run.targetDurationSec ? `目标 ${formatClock(run.targetDurationSec)}` : null,
                    run.scenes?.length ? `${run.scenes.length} 幕` : null,
                    '在右侧播放',
                  ].filter(Boolean).join(' · ') : '在右侧预览网页'}
                </div>
              </div>
            </div>
            <div className="mt-3.5">
              {run.publish.status === 'none' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button variant="primary" className="max-md:min-h-11" onClick={() => void onPublish()} data-qc="publish"><Globe size={14} />发布到网页托管</Button>
                  <span className="text-[12px] text-token-muted">{run.bundleUrl
                    ? `发布的是能播放的网页${run.bundleBytes ? `（约 ${Math.max(1, Math.round(run.bundleBytes / (1024 * 1024)))} MB）` : ''}，不传视频文件`
                    : '发布后得到可分享的链接'}</span>
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
            {run.bundleUrl && <BrowserExport key={run.id} run={run} />}
          </section>
        )}
      </AgentTurn>
    </>
  );
  const runFooter = run && (
    <div className="flex flex-wrap items-center justify-end gap-2 px-1 text-[12px] leading-5 text-token-muted">
      {run.status === 'queued' || run.status === 'running' ? (
        <>
          <Button size="sm" variant="ghost" className="max-md:min-h-11" data-qc="leave" onClick={() => showPage({ view: 'works' })}>离开，稍后回来</Button>
        </>
      ) : run.status === 'failed' ? (
        <span className="min-w-0 flex-1">已完成的部分都已保存，可以现在处理，也可以稍后在「我的作品」里继续。</span>
      ) : (
        <>
          <Button size="sm" variant="ghost" className="max-md:min-h-11" data-qc="redo-other" onClick={() => { setAttachments(run.attachments.filter(a => a.status === 'ready')); setAsk(run.ask); setKind(run.kind === 'video' ? 'web' : 'video'); setTemplateId(run.templateId); showPage({}); setPane('chat'); }}>
            用这份稿件做{run.kind === 'video' ? '网页' : '视频'}
          </Button>
        </>
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
  const liveStage = run?.stages.find(s => s.status === 'running' || s.status === 'failed');

  if (runError) {
    previewTitle = '没有找到任务'; previewNote = runError; nextHint = '';
    body = <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-token-secondary">{runError}。可以从「我的作品」重新进入，或新建一个。</div>;
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
      onOpen={a => openRun(a.runId)}
      onUseStyle={a => {
        const name = templates.find(t => t.id === a.templateId)?.name ?? '';
        setTemplateId(a.templateId); setRightTab('select');
        if (run) { showPage({}); setPane('chat'); }
        toast.info(`已换成「${name}」风格`, run ? '放进稿件后即可用这个风格生成' : '输入框里的风格已同步');
      }}
      onOpenHosting={a => navigate(`/web-pages?focusSite=${encodeURIComponent(a.siteId ?? '')}`)} />;
  } else if (run && runTemplate) {
    if (run.status === 'done' || run.status === 'trial-ready') {
      previewTitle = run.status === 'trial-ready' ? '试看' : run.kind === 'video' ? '成片' : '网页';
      previewNote = [run.kind === 'video' && run.durationSec ? formatClock(run.durationSec) : null,
        run.kind === 'video' && run.voice ? `配音 ${run.voice}` : null, `风格 ${runTemplate.name}`].filter(Boolean).join(' · ');
      nextHint = run.status === 'trial-ready' ? '试看满意后，在对话里继续做完。' : run.publish.status === 'done' ? '已发布，网页托管里能找到它；改了稿件可以用同一份资料再做一个。' : '满意的话在左边发布到网页托管；发布只上传，不会重新生成。';
      body = run.kind === 'video' ? run.bundleUrl ? <BrowserFilmPlayer run={run} /> : <VideoPlayer run={run} template={runTemplate} /> : <WebPreview run={run} template={runTemplate} />;
    } else {
      previewTitle = run.kind === 'video' ? run.scenes?.length ? '分镜' : '视频进度' : '页面';
      previewNote = run.status === 'queued' ? '轮到后会自动开始' : run.status === 'failed' ? run.failure?.message ?? '没有完成' : liveStage ? `正在${stageName(run.kind, liveStage.key)}` : '正在生成';
      nextHint = run.status === 'failed' ? '可回看原稿与要求并重新排队。' : '执行器有可预览的结果时会显示在这里。';
      body = run.kind === 'web' && run.previewHtml
        ? <WebPreview run={run} template={runTemplate} /> : <ProgressPreview run={run} template={runTemplate} />;
    }
  }

  /* 选择与资产的页签：资料面板打开时让位给面板的动作 */
  if (run && !panel && !runError) toolbar = (
    /* 公共组件 Segmented 沿用正式实现（28px），触控高度差异记为框架债务 */
    <span data-qc-touch-exempt>
      <Segmented<'select' | 'assets'> label="选择与资产" value={rightTab} onChange={setRightTab}
        options={[{ value: 'select', label: '本次', title: '这次任务的过程与成品' }, { value: 'assets', label: '产物', title: '回看已生成的视频与网页' }]} />
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
    <div className="qc-scope flex h-full min-h-0 flex-col" data-qc-ready={ready} data-output={run?.kind ?? kind} data-run-id={run?.id ?? ''}>
      {header}
      <Dialog open={knowledgeOpen} onOpenChange={setKnowledgeOpen} title="选择知识库稿件"
        content={<KnowledgeEntryPicker recentEntries={recentKnowledge} selectedEntries={knowledgeSelection} onChange={setKnowledgeSelection} />}
        actions={<Button variant="primary" disabled={!knowledgeSelection.length || adding} onClick={() => void addSelectedKnowledge()}>
          加入资料
        </Button>} />
      {/* 窄屏：对话 / 预览切换（公共组件 PaneTabs，32px 触控高度记为框架债务） */}
      {run && <div className="flex shrink-0 items-center border-b border-token-subtle px-3 py-1.5 lg:hidden" data-qc-touch-exempt>
        <PaneTabs pane={pane} onChange={setPane} previewBadge={run?.status === 'done' ? (run.kind === 'video' ? '成片' : '网页') : undefined} />
      </div>}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div role="status" className="flex h-full items-center justify-center gap-2 text-[13px] text-token-muted"><MapSpinner size={14} />{reconnecting ? '任务状态暂时没有读到，正在重新连接…' : '正在打开任务…'}</div>
        ) : runId ? (
          <div className="flex h-full min-h-0 flex-col">
            {reconnecting && <p role="status" data-qc="reconnecting" className="m-0 shrink-0 px-3 py-2 text-[13px] text-token-secondary">连接暂时中断，正在恢复状态。这里保留了上一次读到的进度。</p>}
            <div className="min-h-0 flex-1"><WorkbenchLayout pane={runError ? 'preview' : pane} conversation={runConversation} composer={runFooter} preview={preview} /></div>
          </div>
        ) : chatting ? chatBody : landingBody}
      </div>
      {!runId && composeSheets}
    </div>
  );
}

export default QuickCreationAgentPage;
