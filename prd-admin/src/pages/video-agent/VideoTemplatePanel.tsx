import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, FileUp } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import type { VideoGenRun, VideoTemplate, VideoTemplateInput } from '@/services/contracts/videoAgent';
import {
  createVideoTemplateReal,
  getVideoGenRunReal,
  listVideoTemplatesReal,
  publishVideoTemplateReal,
} from '@/services/real/videoAgent';

const MAX_ARTICLE_CHARS = 100_000;
const terminalStatuses = new Set(['Completed', 'Failed', 'Cancelled']);
const progressLabels: Record<string, string> = {
  scripting: '正在阅读稿件和编写分镜',
  'template-voice': '正在为各段生成配音',
  'template-rendering': '正在合成画面、配音和字幕',
  'template-saving': '正在保存成片',
};

function TemplateForm({ template, initialRun, onCreated }: {
  template: VideoTemplate;
  initialRun?: VideoGenRun;
  onCreated: (id: string) => void;
}) {
  const [article, setArticle] = useState(initialRun?.articleMarkdown ?? '');
  const [title, setTitle] = useState(initialRun?.articleTitle ?? '');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<VideoTemplateInput | null>(null);

  async function readArticle(file?: File) {
    if (!file) return;
    setError('');
    if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > MAX_ARTICLE_CHARS * 4) {
      setError('请选择 UTF-8 编码的 Markdown 或 TXT 稿件，最多 100,000 个字符。');
      return;
    }
    setReading(true);
    try {
      const contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (contents.length > MAX_ARTICLE_CHARS || contents.trim().length < 20) {
        setError('稿件需要 20 至 100,000 个字符。');
        return;
      }
      setArticle(contents);
      setFileName(file.name);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 150));
    } catch {
      setError('稿件读取失败，请确认文件使用 UTF-8 编码。');
    } finally {
      setReading(false);
    }
  }

  async function generate() {
    const previous = request.current;
    const articleTitle = title.trim() || undefined;
    const input = previous?.articleTitle === articleTitle && previous?.articleMarkdown === article
      ? previous
      : { templateId: template.id, templateRequestId: crypto.randomUUID(), articleTitle, articleMarkdown: article };
    if (!input) return;
    request.current = input;
    setError('');
    setSending(true);
    try {
      const response = await createVideoTemplateReal(input);
      if (response.success) onCreated(response.data.runId);
      else setError(response.error?.message ?? '创建任务失败，请稍后重试。');
    } catch {
      setError('连接中断，可以用同一份稿件重试提交。');
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="flex max-w-[720px] flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
      <label className="flex flex-col gap-1.5 text-sm">视频标题
        <input className="rounded-lg border border-[var(--border-subtle)] bg-transparent px-3 py-2"
          value={title} maxLength={150} onChange={(event) => setTitle(event.target.value)} placeholder={template.name} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">原始稿件
        <textarea className="min-h-32 rounded-lg border border-[var(--border-subtle)] bg-transparent p-3"
          value={article} onChange={(event) => { setArticle(event.target.value); setFileName(''); }}
          maxLength={MAX_ARTICLE_CHARS} placeholder="粘贴完整稿件，或上传 Markdown / TXT" />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm focus-within:ring-2">
          <FileUp size={16} />{reading ? '正在读取稿件' : fileName || '上传 Markdown / TXT'}
          <input className="sr-only" type="file" accept=".md,.markdown,.txt" disabled={sending || reading}
            onChange={(event) => { void readArticle(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </label>
        <Button type="submit" variant="primary" disabled={sending || reading || article.trim().length < 20}>
          {sending && <MapSpinner size={14} />}
          {sending ? '正在提交' : initialRun ? '用这份稿件重新生成' : '生成视频'}
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}

export function VideoTemplateGallery({ onCreated }: { onCreated: (id: string) => void }) {
  const [items, setItems] = useState<VideoTemplate[]>([]);
  const [selected, setSelected] = useState<VideoTemplate | null>(null);
  const [availability, setAvailability] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let mounted = true;
    void listVideoTemplatesReal().then((response) => {
      if (!mounted) return;
      if (!response.success) {
        setAvailability(response.error?.message ?? '无法加载模板。');
        return;
      }
      setItems(response.data.items);
      setAvailability(!response.data.canGenerate ? '当前账号没有生成配音的权限。'
        : !response.data.speechReady ? '当前环境暂未配置普通配音。' : '');
    }).catch(() => {
      if (mounted) setAvailability('连接中断，无法加载模板。');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [reload]);

  return (
    <section className="video-create-library" aria-label="视频模板">
      <div className="video-create-section-heading"><div><BookOpen size={16} /><strong>视频模板</strong></div></div>
      {loading && <p className="flex items-center gap-2 text-sm"><MapSpinner size={14} />正在加载模板</p>}
      {!loading && availability && (
        <div className="flex items-center gap-2 text-sm">
          <p role="status">{availability}</p>
          {!items.length && <button type="button" className="underline" onClick={() => { setLoading(true); setReload(reload + 1); }}>重试</button>}
        </div>
      )}
      <div className="grid max-w-4xl grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        {items.map((template) => (
          <button type="button" key={template.id} aria-expanded={selected?.id === template.id}
            onClick={() => setSelected(selected?.id === template.id ? null : template)}
            className="group flex w-full max-w-[320px] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] text-left transition hover:border-[var(--text-primary)] focus-visible:outline-[var(--text-primary)]">
            <img className="aspect-video w-full object-cover" src="/video-studio/sketchnote.jpg" alt="点阵纸上的手绘视觉笔记缩略图" />
            <span className="flex w-full items-start justify-between gap-2 p-3">
              <span><strong className="block">{template.name}</strong><span className="mt-1 block text-sm opacity-75">{template.description}</span></span>
              <ArrowUpRight size={17} className="mt-1 shrink-0" />
            </span>
          </button>
        ))}
      </div>
      {selected && !availability && <div className="mt-4"><TemplateForm key={selected.id} template={selected} onCreated={onCreated} /></div>}
    </section>
  );
}

export function VideoTemplateResult({ runId, onBack, onCreated }: {
  runId: string;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const canPublish = useAuthStore((state) => hasEffectivePermission(state.permissions, 'web-pages.write', state.isRoot));
  const [run, setRun] = useState<VideoGenRun | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mediaError, setMediaError] = useState(false);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [publishError, setPublishError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [retry, setRetry] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function refresh() {
      let again = true;
      try {
        const response = await getVideoGenRunReal(runId);
        if (!active) return;
        if (response.success) {
          setRun(response.data);
          setLoadError('');
          setSiteId(response.data.publishedSiteId ?? '');
          again = !terminalStatuses.has(response.data.status);
        } else {
          setLoadError(response.error?.message ?? '暂时无法读取生成任务。');
          again = !['NOT_FOUND', 'PERMISSION_DENIED'].includes(response.error?.code ?? '');
        }
      } catch {
        if (active) setLoadError('连接中断，恢复后会继续读取生成进度。');
      } finally {
        if (active && again) timer = window.setTimeout(() => { void refresh(); }, 2500);
      }
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [runId]);

  async function publish() {
    setPublishing(true);
    setPublishError('');
    try {
      const response = await publishVideoTemplateReal(runId);
      if (response.success) setSiteId(response.data.siteId);
      else setPublishError(response.error?.message ?? '发布失败，成片已保留。');
    } catch {
      setPublishError('连接中断，成片已保留。可以重试发布。');
    } finally {
      setPublishing(false);
    }
  }

  const inProgress = run && !terminalStatuses.has(run.status);
  return (
    <main className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-5xl">
        <button type="button" className="mb-5 inline-flex items-center gap-2 text-sm" onClick={onBack}><ArrowLeft size={16} />返回视频制作台</button>
        <h1 className="mb-4 text-2xl font-semibold">{run?.articleTitle || '模板视频'}</h1>
        {!run && !loadError && <p className="flex gap-2"><MapSpinner size={16} />正在读取生成任务</p>}
        {loadError && <p role="status" className="text-sm">{loadError}</p>}
        {inProgress && (
          <div role="status" className="max-w-xl">
            <p className="flex items-center gap-2"><MapSpinner size={16} />{progressLabels[run.currentPhase] ?? '等待云端任务开始'}</p>
            <progress className="mt-3 h-2 w-full" aria-label="视频生成进度" max={100} value={run.phaseProgress || undefined} />
          </div>
        )}
        {run && (run.status === 'Failed' || run.status === 'Cancelled') && (
          <div className="space-y-3">
            <p role="status">{run.errorMessage ?? '任务已停止，原始稿件已保留。'}</p>
            <p className="text-xs opacity-70">任务编号 {run.id}</p>
            {run.errorCode !== 'UPSTREAM_RESULT_UNKNOWN' && <Button onClick={() => setRetry(!retry)}>{retry ? '收起稿件' : '查看稿件并重试'}</Button>}
            {retry && <TemplateForm template={{ id: run.templateId ?? '', name: '模板视频', description: '' }}
              initialRun={run} onCreated={onCreated} />}
          </div>
        )}
        {run?.status === 'Completed' && run.videoAssetUrl && (
          <>
            <video key={mediaAttempt} className="aspect-video w-full rounded-xl bg-black" src={run.videoAssetUrl} controls playsInline
              preload="metadata" aria-label="云端成片预览（内嵌字幕）" onError={() => setMediaError(true)} />
            {mediaError && <button type="button" className="mt-2 text-sm underline"
              onClick={() => { setMediaError(false); setMediaAttempt(mediaAttempt + 1); }}>视频未能加载，重试预览</button>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm opacity-75">已内嵌字幕 · {Math.round(run.totalDurationSeconds)} 秒</span>
              {siteId
                ? <a className="inline-flex items-center gap-2 font-medium underline" href={`/web-pages?focusSite=${encodeURIComponent(siteId)}`}>在网页托管中查看 <ArrowUpRight size={16} /></a>
                : canPublish
                  ? <Button variant="primary" onClick={() => void publish()} disabled={publishing}>{publishing ? '正在发布' : '发布到网页托管'}</Button>
                  : <span className="text-sm opacity-75">当前账号没有网页托管发布权限</span>}
            </div>
            {publishError && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{publishError}</p>}
          </>
        )}
      </div>
    </main>
  );
}
