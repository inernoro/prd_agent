/**
 * 快速创作智能体：一份文档 + 一个模板 → 能播放的视频或能浏览的网页，并发布到网页托管。
 * - 生成在服务端排队执行，离开页面不取消；地址里的 ?run= 让用户回到同一个任务。
 * - 左栏：资料、要求与过程；右栏：预览。窄屏用 SplitToTabLayout 切成「创作 / 预览」。
 * - 与「视频创作智能体」的区别：那边用生成式视频模型出镜头，这里用文稿 + 配音 + 可复用的模板画面代码。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, Check, ChevronLeft, ExternalLink, Globe, LayoutList, Paperclip, Plus, Send, Video } from 'lucide-react';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { SplitToTabLayout } from '@/components/design/SplitToTabLayout';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  addKnowledgeAttachment, createQuickCreationRun, getQuickCreationRun, listQuickCreationTemplates, listQuickCreationWorks,
  publishQuickCreationRun, retryAttachmentRead, retryQuickCreationRun, uploadQuickCreationAttachment,
} from '@/services/real/quickCreation';
import { AttachmentReview, AttachmentTray, SentAttachmentSummary } from './AttachmentTray';
import { FailureCard, QueueCard, RunProgress } from './RunProgress';
import { ProgressPreview, TemplatePreview, VideoPlayer, WebPreview } from './ResultPanel';
import { TemplateFrame } from './TemplateFrames';
import { WorksList } from './WorksList';
import { MAX_ATTACHMENTS, formatClock, summarizeAttachments } from './format';
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
  const [review, setReview] = useState<{ open: boolean; id?: string }>({ open: false });
  const fileInput = useRef<HTMLInputElement>(null);

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

  /* 按任务编号加载并轮询，直到终态；发布中也继续轮询 */
  useEffect(() => {
    setRun(null); setRunError(null); setReview({ open: false });
    if (!runId) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      const res = await getQuickCreationRun(runId);
      if (stop) return;
      if (!res.success) { setRunError(res.error?.message || '没有找到这个任务'); return; }
      setRun(res.data);
      const live = res.data.status === 'queued' || res.data.status === 'running' || res.data.publish.status === 'publishing';
      if (live) timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [runId]);

  const openRun = (id: string) => setParams({ run: id });
  const startNew = () => { setParams({}); setAsk(''); setAttachments([]); };

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
    if (res.success) setAttachments(list => list.map(a => (a.id === id ? res.data : a)));
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

  /* ---------- 左栏：创作 ---------- */
  const composeLeft = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-5">
        <div>
          <h1 className="m-0 text-[17px] font-semibold text-token-primary">把一份文档变成能播、能发的成品</h1>
          <p className="m-0 mt-1.5 text-[13px] leading-6 text-token-secondary">选产出和模板，放进稿件，点快捷生成。配音、字幕或版式会按稿件自动排好，完成后可发布到网页托管。</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-token-secondary">产出</span>
          {/* 公共组件 SegmentedTabs 沿用正式实现（32px），触控高度差异记为框架债务，不在单页改 */}
          <span data-qc-touch-exempt><SegmentedTabs<OutputKind>
            ariaLabel="选择产出"
            value={kind}
            onChange={k => { setKind(k); setTemplateId(templates.find(t => t.kind === k)?.id ?? ''); }}
            items={[{ key: 'video', label: '视频' }, { key: 'web', label: '网页' }]}
          /></span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-token-secondary">模板</span>
          <span className="text-[11.5px] text-token-muted">缩略图来自真实{kind === 'video' ? '成片' : '页面'}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="选择模板">
          {kindTemplates.map(t => {
            const on = t.id === template?.id;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => setTemplateId(t.id)}
                className={cn('flex flex-col gap-2 rounded-[var(--radius-card)] border p-2 text-left hover-bg-soft',
                  on ? 'border-[color:var(--accent-primary)] shadow-[inset_0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle')}>
                <span className="block overflow-hidden rounded-[var(--radius-control)]"><TemplateFrame frame={t.frame} scene={1} /></span>
                <span className="flex items-center gap-1.5 px-0.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-token-primary">{t.name}</span>
                  {on && <Check size={14} className="text-[color:var(--accent-primary)]" aria-hidden />}
                </span>
              </button>
            );
          })}
        </div>
        {!attachments.length && (
          <div className="rounded-[var(--radius-card)] border border-dashed border-token-subtle p-3.5 text-[12.5px] leading-6 text-token-secondary">
            稿件支持 Markdown、TXT，也可以从知识库选择或直接粘贴正文。项目名默认取稿件标题。
            <button type="button" data-qc="sample-doc" className="ml-1 font-medium text-[color:var(--accent-primary)] hover:underline" onClick={() => void addKnowledge(SAMPLE_KB_ENTRY)}>用示例稿件试一下</button>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-token-subtle px-3 pb-3 pt-2.5 md:px-5">
        <div className="space-y-2 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--panel-solid)] p-2.5 focus-within:border-[var(--border-focus)]">
          <AttachmentTray items={attachments} onRemove={id => setAttachments(l => l.filter(a => a.id !== id))} onRetry={id => void retryRead(id)}
            onClearFailed={() => setAttachments(l => l.filter(a => a.status !== 'failed'))} />
          <label htmlFor="qc-ask" className="sr-only">补充要求</label>
          <textarea id="qc-ask" rows={2} value={ask} onChange={e => setAsk(e.target.value)}
            placeholder="可选：加一句要求，例如「稍微快一点，先提醒我三个重点，给新同事看」；也可以直接粘贴正文"
            className="block w-full resize-none border-0 bg-transparent px-1 text-[13.5px] leading-6 text-token-primary outline-none placeholder:text-token-muted" />
          <div className="flex items-center gap-1">
            <input ref={fileInput} type="file" accept=".md,.markdown,.txt,image/*" multiple hidden
              onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; files.forEach(f => void addFile(f)); }} />
            <button type="button" aria-label="上传稿件或图片" className="qc-icon-btn" onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button>
            <button type="button" aria-label="从知识库选择" data-qc="pick-knowledge" className="qc-icon-btn" onClick={() => void addKnowledge('kb-picker')}><BookOpen size={16} /></button>
            <Badge size="sm" icon={kind === 'video' ? <Video size={11} /> : <Globe size={11} />}>{OUTPUT_LABEL[kind]} · {template?.name ?? ''}</Badge>
            <Button variant="primary" className="ml-auto" disabled={!!blockReason || submitting} onClick={() => void submit()} data-qc="submit">
              {submitting ? <MapSpinner size={13} /> : <Send size={14} />}快捷生成
            </Button>
          </div>
        </div>
        {blockReason && <div className="mt-1.5 px-1 text-[11.5px] text-token-muted" data-qc="block-reason">{blockReason}</div>}
      </div>
    </div>
  );

  const runLeft = run && (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-5">
        <div className="qc-rise ml-auto flex max-w-[92%] flex-col items-end gap-1.5">
          <SentAttachmentSummary items={run.attachments} onOpenAll={() => setReview({ open: true })} onOpen={id => setReview({ open: true, id })} />
          {run.ask && <div className="rounded-[12px_12px_4px_12px] bg-[var(--bg-card-hover)] px-3 py-2 text-[13.5px] leading-6 text-token-primary">{run.ask}</div>}
          <Badge size="sm" icon={run.kind === 'video' ? <Video size={11} /> : <Globe size={11} />}>{OUTPUT_LABEL[run.kind]} · {template?.name}</Badge>
        </div>
        <div className="qc-rise flex items-center gap-2 rounded-[var(--radius-field)] border border-token-subtle bg-token-nested px-3 py-2 text-[12.5px] text-token-secondary">
          <Check size={14} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />
          稿件和要求已保存。生成在后台进行，离开页面也会继续。
        </div>
        {run.status === 'queued' && <QueueCard run={run} />}
        <RunProgress run={run} />
        {run.status === 'failed' && run.failure && <FailureCard failure={run.failure} onAction={a => void onRecover(a)} />}
        {run.status === 'done' && (
          <div className="qc-rise space-y-2.5 rounded-[var(--radius-card)] border border-token-subtle bg-[var(--bg-card)] p-3.5" data-qc="done-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-token-primary">{run.kind === 'video' ? '成片已生成' : '网页已生成'}</span>
              <Badge size="sm">{run.kind === 'video' ? `${formatClock(run.durationSec ?? 0)} · ${run.scenes?.length ?? 0} 幕 · 1080p` : `${run.sections?.length ?? 0} 节 · 适配手机`}</Badge>
            </div>
            {run.ask && <div className="text-[12.5px] leading-6 text-token-secondary">按你的要求：{run.ask}</div>}
            {run.publish.status === 'none' && (
              <Button variant="primary" onClick={() => void onPublish()} data-qc="publish"><Globe size={14} />发布到网页托管</Button>
            )}
            {run.publish.status === 'publishing' && <div className="flex items-center gap-2 text-[12.5px] text-token-secondary"><MapSpinner size={13} />正在上传到网页托管…</div>}
            {run.publish.status === 'failed' && (
              <div className="space-y-2 rounded-[var(--radius-field)] border border-[color:var(--accent-fg-error)]/35 bg-[color:var(--accent-fg-error)]/[0.06] p-3" role="alert" data-qc="publish-failed">
                <div className="text-[13px] font-medium text-[color:var(--accent-fg-error)]">发布没有完成</div>
                <div className="text-[12px] leading-5 text-token-secondary">{run.publish.error}。{run.kind === 'video' ? '成片' : '网页'}已保存在作品里，右侧照常可看；重试只上传，不会重新生成。</div>
                <Button size="sm" variant="primary" className="max-md:min-h-11" onClick={() => void onPublish()}>重试发布</Button>
              </div>
            )}
            {run.publish.status === 'done' && (
              <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[color:var(--accent-fg-success)]/35 bg-[color:var(--accent-fg-success)]/[0.06] p-3" data-qc="published">
                <Check size={15} className="text-[color:var(--accent-fg-success)]" aria-hidden />
                <span className="min-w-0 flex-1 text-[12.5px] text-token-primary">已发布到网页托管 · {run.publish.siteTitle}</span>
                <Button size="sm" variant="secondary" className="max-md:min-h-11" onClick={() => navigate(`/web-pages?focusSite=${encodeURIComponent(run.publish.siteId ?? '')}`)}>
                  <ExternalLink size={13} />在网页托管中查看
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-token-subtle px-4 py-3 text-[12px] text-token-muted md:px-5">
        {run.status === 'queued' || run.status === 'running' ? (
          <>
            <span className="min-w-0 flex-1">可以离开，完成后会发站内通知，也能在「我的作品」找到它。</span>
            <Button size="sm" variant="secondary" className="max-md:min-h-11" onClick={() => setParams({ view: 'works' })}>离开，稍后回来</Button>
          </>
        ) : run.status === 'failed' ? (
          <span className="min-w-0 flex-1">已完成的部分都已保存，可以现在处理，也可以稍后在「我的作品」里继续。</span>
        ) : (
          <>
            <span className="min-w-0 flex-1">想换个模板或产出？用同一份稿件再做一个。</span>
            <Button size="sm" variant="secondary" className="max-md:min-h-11" onClick={() => { setAttachments(run.attachments.filter(a => a.status === 'ready')); setAsk(run.ask); setKind(run.kind === 'video' ? 'web' : 'video'); setTemplateId(''); setParams({}); }}>
              用这份稿件做{run.kind === 'video' ? '网页' : '视频'}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  /* ---------- 右栏：预览 ---------- */
  const rightTitle = review.open ? '附件回看' : !run ? '模板预览'
    : run.status === 'done' ? (run.kind === 'video' ? '成片预览' : '网页预览')
      : run.kind === 'video' ? '分镜预览' : '大纲预览';
  const right = (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-token-secondary">{rightTitle}</span>
        {run?.status === 'done' && !review.open && (
          <span className="ml-auto flex flex-wrap justify-end gap-1.5">
            <button type="button" className="inline-flex items-center max-md:min-h-11" onClick={() => setReview({ open: true })}><Badge size="sm" icon={<Paperclip size={11} />}>原稿 · {run.attachments.filter(a => a.status === 'ready').length} 个附件</Badge></button>
            <Badge size="sm">模板 · {template?.name}</Badge>
            {run.voice && <Badge size="sm">配音 · {run.voice}</Badge>}
          </span>
        )}
      </div>
      {runError && <div className="rounded-[var(--radius-field)] border border-token-subtle p-4 text-[13px] text-token-secondary">{runError}。可以从「我的作品」重新进入，或新建一个。</div>}
      {!runError && review.open && run && (
        <AttachmentReview items={run.attachments} activeId={review.id} onSelect={id => setReview({ open: true, id })} onBack={() => setReview({ open: false })} />
      )}
      {!runError && !review.open && template && (
        !run ? <TemplatePreview template={template} />
          : run.status === 'done' ? (run.kind === 'video' ? <VideoPlayer run={run} template={template} /> : <WebPreview run={run} template={template} />)
            : <ProgressPreview run={run} template={template} />
      )}
    </div>
  );

  const loading = runId && !run && !runError;
  const ready = loading ? undefined : run ? `run-${run.status}` : 'compose';
  return (
    <div className="flex h-full min-h-0 flex-col" data-qc-ready={ready}>
      {header}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-token-muted"><MapSpinner size={14} />正在打开任务…</div>
        ) : (
          <SplitToTabLayout
            gap="gap-0"
            className="h-full"
            defaultActiveKey="create"
            panels={[
              { key: 'create', label: '创作', desktopWidth: 'w-[440px] xl:w-[480px] shrink-0 border-r border-token-subtle', content: run ? runLeft : composeLeft },
              { key: 'preview', label: run?.status === 'done' ? `预览 · ${run.kind === 'video' ? '成片' : '网页'}` : '预览', desktopWidth: 'flex-1 min-w-0', content: right },
            ]}
          />
        )}
      </div>
    </div>
  );
}

export default QuickCreationAgentPage;
