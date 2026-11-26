/**
 * 快速创作智能体：一份文档 + 一个模板 → 能播放的视频或能浏览的网页，并发布到网页托管。
 * - 生成在服务端排队执行，离开页面不取消；地址里的 ?run= 让用户回到同一个任务。
 * - 版式沿用网页生成工作台（WorkbenchLayout）：左栏一个对话 + 底部一个输入框；右栏是选模板、管理资料和预览。窄屏切成「对话 / 预览」。
 * - 与「视频创作智能体」的区别：那边用生成式视频模型出镜头，这里用文稿 + 配音 + 可复用的模板画面代码。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, Check, ChevronLeft, ChevronRight, CircleCheck, ExternalLink, FileText, Globe, LayoutList, Paperclip, Plus, Send, Upload, Video } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { PaneTabs, Segmented, WorkbenchLayout, WorkbenchPreview, fitComposerHeight, type WorkbenchPane } from '@/components/web-hosting/workbench/WorkbenchParts';
import {
  addKnowledgeAttachment, createQuickCreationRun, getQuickCreationRun, listQuickCreationTemplates, listQuickCreationWorks,
  addTextAttachment, publishQuickCreationRun, retryAttachmentRead, retryQuickCreationRun, uploadQuickCreationAttachment,
} from '@/services/real/quickCreation';
import { AttachmentTray, MaterialsPanel, SentAttachments } from './AttachmentTray';
import { AgentTurn, UserTurn } from './Conversation';
import { FailureCard, QueueCard, RunProgress } from './RunProgress';
import { ProgressPreview, TemplateGallery, VideoPlayer, WebPreview } from './ResultPanel';
import { WorksList } from './WorksList';
import { MAX_ATTACHMENTS, formatChars, formatClock, summarizeAttachments } from './format';
import type { OutputKind, QcAttachment, QcFailure, QcRun, QcTemplate, QcWork } from './types';
import './quickCreation.css';

const OUTPUT_LABEL: Record<OutputKind, string> = { video: '视频', web: '网页' };
const SAMPLE_KB_ENTRY = 'sample-review-habits';

function runBadge(run: QcRun) {
  if (run.status === 'queued') return { label: `排队中 · 第 ${run.queue?.position ?? '-'} 位`, variant: 'new' as const };
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
  const [works, setWorks] = useState<QcWork[]>([]);
  const [run, setRun] = useState<QcRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [kind, setKind] = useState<OutputKind>('video');
  const [templateId, setTemplateId] = useState<string>('');
  const [attachments, setAttachments] = useState<QcAttachment[]>([]);
  const [ask, setAsk] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /* 右栏此刻显示什么：资料面板（发送前管理 / 发送后回看）优先，否则按任务状态显示模板、过程或成品 */
  const [panel, setPanel] = useState<{ mode: 'manage' | 'review'; id?: string } | null>(null);
  const [pane, setPane] = useState<WorkbenchPane>('chat');
  const fileInput = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (askRef.current) fitComposerHeight(askRef.current); }, [ask]);

  useEffect(() => {
    void listQuickCreationTemplates().then(res => { if (res.success) setTemplates(res.data.items); });
  }, []);
  const refreshWorks = useCallback(() => {
    void listQuickCreationWorks().then(res => { if (res.success) setWorks(res.data.items); });
  }, []);
  useEffect(() => { refreshWorks(); }, [refreshWorks, runId, view]);

  const kindTemplates = templates.filter(t => t.kind === kind);
  const template = templates.find(t => t.id === (run?.templateId ?? templateId)) ?? kindTemplates[0];
  useEffect(() => {
    if (!templateId && kindTemplates[0]) setTemplateId(kindTemplates[0].id);
  }, [kindTemplates, templateId]);

  /* 按任务编号加载 */
  useEffect(() => {
    setRun(null); setRunError(null); setPanel(null);
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
  const blockReason = !hasText ? '放进至少一份稿件或知识库文档后即可生成' : sum.reading ? '还有附件在读取，读完即可生成' : null;
  const draftTitle = attachments.find(a => a.status === 'ready' && a.kind !== 'image')?.name.replace(/\.(md|markdown|txt)$/i, '') ?? (template ? `未命名 · ${template.name}` : '未命名');

  const submit = async () => {
    if (blockReason || !template) return;
    setSubmitting(true);
    const res = await createQuickCreationRun({
      kind, templateId: template.id, ask: ask.trim(),
      attachmentIds: attachments.filter(a => a.status === 'ready').map(a => a.id), title: draftTitle,
    });
    setSubmitting(false);
    if (!res.success) { toast.error('没有提交成功', `${res.error?.message || '请稍后重试'}，稿件仍在输入框里`); return; }
    openRun(res.data.id);
  };

  /* ---------- 任务动作 ---------- */
  const onRecover = async (action: QcFailure['actions'][number]) => {
    if (!run) return;
    const res = await retryQuickCreationRun(run.id, { action, unitIndex: run.failure?.unitIndex });
    if (res.success) { setRun(res.data); setParams({ run: run.id }, { replace: true }); }
    else toast.error('没有重新开始', res.error?.message || '请稍后再试');
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
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-token-subtle px-2 py-2 md:gap-3 md:px-5">
      <button type="button" aria-label="返回百宝箱" onClick={() => navigate('/ai-toolbox')} className="qc-icon-btn"><ChevronLeft size={18} /></button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-token-muted">快速创作</span>
          {/* 窄屏把状态放到标题上方这一行，标题保持完整宽度 */}
          {badge && <span className="md:hidden"><Badge size="sm" variant={badge.variant}>{badge.label}</Badge></span>}
        </div>
        <div className="truncate text-[15px] font-semibold text-token-primary" data-qc="project-title">
          {view === 'works' ? '我的作品' : run?.title ?? draftTitle}
        </div>
      </div>
      {badge && <span className="hidden md:inline-flex"><Badge variant={badge.variant}>{badge.label}</Badge></span>}
      {view !== 'works' && (
        <Button variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => setParams({ view: 'works' })} aria-label={`我的作品，共 ${works.length} 个`}>
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
  const KindIcon = (kind === 'video' ? Video : Globe);

  /* ---------- 左栏 · 新建：助手的开场 + 输入框 ---------- */
  const startOptions = (
    <div className="overflow-hidden rounded-[12px] border border-token-subtle bg-[var(--bg-input)] shadow-[var(--shadow-site-card)]">
      {[
        { key: 'sample', icon: FileText, title: '用示例稿件试一下', sub: '需求评审的三个习惯 · Markdown', qc: 'sample-doc', on: () => void addKnowledge(SAMPLE_KB_ENTRY) },
        { key: 'kb', icon: BookOpen, title: '从知识库选择', sub: '引用个人或团队知识库里的文档', on: () => void addKnowledge('kb-picker') },
        { key: 'upload', icon: Upload, title: '上传稿件', sub: 'Markdown、TXT；图片作为画面参考', on: () => fileInput.current?.click() },
      ].map((o, i) => (
        <button key={o.key} type="button" data-qc={o.qc} onClick={o.on}
          className={`flex min-h-[52px] w-full items-center gap-3 px-3 py-2 text-left hover-bg-soft ${i ? 'border-t border-token-subtle' : ''}`}>
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--selection-bg)] text-[color:var(--accent-primary)]"><o.icon size={15} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-token-primary">{o.title}</span>
            <span className="block truncate text-[11.5px] text-token-muted">{o.sub}</span>
          </span>
          <ChevronRight size={15} className="shrink-0 text-token-muted" aria-hidden />
        </button>
      ))}
    </div>
  );
  const composeConversation = (
    <AgentTurn>
      <div>
        <p className="m-0 text-[15px] font-semibold leading-6 text-token-primary">把一份文档交给我</p>
        <p className="m-0 mt-1 text-[13px] leading-6 text-token-secondary">在预览区选好产出和模板，我来排好配音、字幕或版式，做成能播放的视频或能浏览的网页，完成后可以直接发布到网页托管。</p>
      </div>
      {!attachments.length ? (
        <>
          {startOptions}
          <p className="m-0 text-[12px] leading-5 text-token-muted">也可以把正文直接粘贴进下面的输入框，超过 300 字会自动变成一份稿件。</p>
        </>
      ) : (
        <div className="qc-card px-3.5 py-3 text-[13px] leading-6 text-token-secondary" data-qc="materials-note">
          收到 <span className="font-medium text-token-primary">{sum.total} 份资料</span>，可用 {formatChars(sum.chars)} 字。
          {sum.failed > 0 && <>{sum.failed} 份读取失败，不会用于生成，点资料栏的「管理」重试或移除。</>}
          {sum.reading > 0 ? <>{sum.reading} 份还在读取，读完就能生成。</> : sum.failed === 0 && <>确认模板后点「快捷生成」。</>}
        </div>
      )}
    </AgentTurn>
  );

  const composer = (
    <div>
      <div className="flex flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-input)] shadow-[var(--shadow-input-inset)] transition-[border-color,box-shadow] has-[textarea:focus]:border-[color:var(--accent-primary)] has-[textarea:focus]:shadow-[0_0_0_3px_var(--selection-bg)]">
        <AttachmentTray items={attachments} managing={panel?.mode === 'manage'} onRemove={id => setAttachments(l => l.filter(a => a.id !== id))} onManage={openManage} />
        {attachments.length > 0 && <div className="mx-3 h-px bg-[var(--border-subtle)]" />}
        <label htmlFor="qc-ask" className="sr-only">补充要求</label>
        <textarea id="qc-ask" ref={askRef} rows={2} value={ask} onChange={e => void onAskChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          placeholder="可选：加一句要求，例如「先提醒三个重点，给新同事看」"
          className="block w-full resize-none overflow-y-auto bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed text-token-primary outline-none placeholder:text-token-muted sm:text-[14px]" />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <input ref={fileInput} type="file" accept=".md,.markdown,.txt,image/*" multiple hidden data-qc="file-input"
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; files.forEach(f => void addFile(f)); }} />
          <button type="button" aria-label="上传稿件或图片" title="上传稿件或图片" className="qc-icon-btn" onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
          <button type="button" aria-label="从知识库选择" title="从知识库选择" data-qc="pick-knowledge" className="qc-icon-btn" onClick={() => void addKnowledge('kb-picker')}><BookOpen size={16} /></button>
          <span className="mx-1 h-4 w-px bg-[var(--border-subtle)]" aria-hidden />
          <button type="button" onClick={() => { setPanel(null); setPane('preview'); }} aria-label={`产出与模板：${OUTPUT_LABEL[kind]} · ${template?.name ?? ''}，点此更换`}
            className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-token-secondary hover-bg-soft max-md:h-11">
            <KindIcon size={13} className="shrink-0" aria-hidden />
            <span className="truncate">{OUTPUT_LABEL[kind]} · {template?.name ?? ''}</span>
            <ChevronRight size={13} className="shrink-0 text-token-muted lg:hidden" aria-hidden />
          </button>
          <Button variant="primary" size="sm" className="ml-auto shrink-0 max-md:min-h-11" disabled={!!blockReason || submitting} onClick={() => void submit()} data-qc="submit">
            {submitting ? <MapSpinner size={13} /> : <Send size={13} />}快捷生成
          </Button>
        </div>
      </div>
      {blockReason
        ? <p className="m-0 px-2 pt-1.5 text-[11.5px] text-token-muted" data-qc="block-reason">{blockReason}</p>
        : <p className="m-0 hidden px-2 pt-1.5 text-[11.5px] text-token-muted lg:block">Ctrl / ⌘ + Enter 也可以生成 · 生成在后台进行，可以离开</p>}
    </div>
  );

  /* ---------- 左栏 · 任务：你的那一条 + 助手这一轮 ---------- */
  const runTemplate = templates.find(t => t.id === run?.templateId);
  const agentStatus = !run ? null : run.status === 'queued' ? '已排队 · 后台进行' : run.status === 'running' ? '后台进行中 · 可以离开' : run.status === 'failed' ? '需要你处理' : '已完成';
  const runConversation = run && (
    <>
      <UserTurn meta={<>{run.kind === 'video' ? <Video size={12} aria-hidden /> : <Globe size={12} aria-hidden />}{OUTPUT_LABEL[run.kind]} · {runTemplate?.name}</>}>
        <p className="m-0 px-1 text-[14px] leading-6 text-token-primary">{run.ask || '没有补充要求，按模板默认节奏生成'}</p>
        <SentAttachments items={run.attachments} onOpenAll={() => openReview()} onOpen={id => openReview(id)} />
      </UserTurn>
      <AgentTurn status={agentStatus}>
        <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-token-secondary" data-qc="saved-notice">
          <Check size={14} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />稿件和要求已保存，生成在后台进行，离开页面也会继续。
        </p>
        {run.status === 'queued' && <QueueCard run={run} />}
        {run.status !== 'queued' && <RunProgress run={run} />}
        {run.status === 'failed' && run.failure && <FailureCard failure={run.failure} onAction={a => void onRecover(a)} />}
        {run.status === 'done' && (
          <section className="qc-card qc-rise p-4" data-qc="done-card">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--semantic-success-soft)] text-[color:var(--accent-fg-success)]"><CircleCheck size={17} aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-token-primary">{run.kind === 'video' ? '成片已生成' : '网页已生成'}</div>
                <div className="mt-0.5 text-[12.5px] leading-5 text-token-secondary">
                  {run.kind === 'video' ? `${formatClock(run.durationSec ?? 0)} · ${run.scenes?.length ?? 0} 幕 · 1080p` : `${run.sections?.length ?? 0} 节 · 适配手机`}，右边可以直接{run.kind === 'video' ? '播放' : '浏览'}。
                </div>
              </div>
            </div>
            <div className="mt-3.5">
              {run.publish.status === 'none' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button variant="primary" className="max-md:min-h-11" onClick={() => void onPublish()} data-qc="publish"><Globe size={14} />发布到网页托管</Button>
                  <span className="text-[12px] text-token-muted">发布后得到可分享的链接</span>
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
          </section>
        )}
      </AgentTurn>
    </>
  );
  const runFooter = run && (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3.5 py-2.5 text-[12px] leading-5 text-token-secondary">
      {run.status === 'queued' || run.status === 'running' ? (
        <>
          <span className="min-w-0 flex-1">可以离开，完成后会发站内通知，也能在「我的作品」找到它。</span>
          <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="leave" onClick={() => setParams({ view: 'works' })}>离开，稍后回来</Button>
        </>
      ) : run.status === 'failed' ? (
        <span className="min-w-0 flex-1">已完成的部分都已保存，可以现在处理，也可以稍后在「我的作品」里继续。</span>
      ) : (
        <>
          <span className="min-w-0 flex-1">想换个模板或产出？用同一份稿件再做一个。</span>
          <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="redo-other" onClick={() => { setAttachments(run.attachments.filter(a => a.status === 'ready')); setAsk(run.ask); setKind(run.kind === 'video' ? 'web' : 'video'); setTemplateId(''); setParams({}); setPane('chat'); }}>
            用这份稿件做{run.kind === 'video' ? '网页' : '视频'}
          </Button>
        </>
      )}
    </div>
  );

  /* ---------- 右栏 ---------- */
  let previewTitle = '选择模板';
  let previewNote = `${OUTPUT_LABEL[kind]} · ${kindTemplates.length} 个模板，缩略图取自真实${kind === 'video' ? '成片' : '页面'}`;
  let nextHint = '选好模板后，在左边放进稿件，点「快捷生成」。';
  let toolbar: ReactNode = !run && !panel ? (
    /* 公共组件 Segmented 沿用正式实现（28px），触控高度差异记为框架债务，不在单页改 */
    <span data-qc-touch-exempt>
      <Segmented<OutputKind> label="选择产出" value={kind} onChange={k => { setKind(k); setTemplateId(templates.find(t => t.kind === k)?.id ?? ''); }}
        options={[{ value: 'video', label: '视频' }, { value: 'web', label: '网页' }]} />
    </span>
  ) : null;
  let actions: ReactNode = null;
  let body: ReactNode = null;
  const liveStage = run?.stages.find(s => s.status === 'running' || s.status === 'failed');

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
  } else if (!run && template) {
    body = <TemplateGallery templates={kindTemplates} selected={template} onSelect={setTemplateId} />;
  } else if (run && runTemplate) {
    toolbar = <Badge size="sm">模板 · {runTemplate.name}</Badge>;
    if (run.status === 'done') {
      previewTitle = run.kind === 'video' ? '成片' : '网页';
      previewNote = run.kind === 'video' ? `${formatClock(run.durationSec ?? 0)} · ${run.scenes?.length ?? 0} 幕 · 1080p${run.voice ? ` · 配音 ${run.voice}` : ''}` : `${run.sections?.length ?? 0} 节 · 桌面与手机都能读`;
      nextHint = run.publish.status === 'done' ? '已发布，网页托管里能找到它；改了稿件可以用同一份资料再做一个。' : '满意的话在左边发布到网页托管；发布只上传，不会重新生成。';
      body = run.kind === 'video' ? <VideoPlayer run={run} template={runTemplate} /> : <WebPreview run={run} template={runTemplate} />;
    } else {
      previewTitle = run.kind === 'video' ? '分镜' : '页面';
      previewNote = run.status === 'queued' ? '排到后先出分镜，这里会逐幕亮起' : run.status === 'failed' ? `${run.failure?.message ?? '没有完成'} · 已完成的部分保留` : liveStage?.detail ?? '正在生成';
      nextHint = run.status === 'failed' ? '恢复后只重做没完成的部分，这里会接着亮起。' : run.kind === 'video' ? '每幕配完音就标为已完成，全部完成后自动合成成片。' : '每写好一节就出现在页面里，全部完成后可以发布。';
      body = <ProgressPreview run={run} template={runTemplate} />;
    }
  }

  const preview = (
    <WorkbenchPreview title={previewTitle} note={previewNote} toolbar={toolbar} actions={actions} nextHint={nextHint}>
      {body}
    </WorkbenchPreview>
  );

  const loading = runId && !run && !runError;
  const ready = loading ? undefined : run ? `run-${run.status}` : 'compose';
  return (
    <div className="flex h-full min-h-0 flex-col" data-qc-ready={ready} data-output={run?.kind ?? kind} data-run-id={run?.id ?? ''}>
      {header}
      {/* 窄屏：对话 / 预览切换（公共组件 PaneTabs，32px 触控高度记为框架债务） */}
      <div className="flex shrink-0 items-center border-b border-token-subtle px-3 py-1.5 lg:hidden" data-qc-touch-exempt>
        <PaneTabs pane={pane} onChange={setPane} previewBadge={run?.status === 'done' ? (run.kind === 'video' ? '成片' : '网页') : undefined} />
      </div>
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-token-muted"><MapSpinner size={14} />正在打开任务…</div>
        ) : (
          <WorkbenchLayout pane={pane} conversation={run ? runConversation : composeConversation} composer={run ? runFooter : composer} preview={preview} />
        )}
      </div>
    </div>
  );
}

export default QuickCreationAgentPage;
