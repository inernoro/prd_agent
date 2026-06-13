import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Copy, ExternalLink, FileText, Globe, Loader2, Play, RefreshCcw, Share2, Video } from 'lucide-react';
import {
  createShortVideoTutorialRun,
  listDocumentStores,
  type DocumentStore,
  type ShortVideoTutorialRunResponse,
  type ShortVideoTutorialStage,
} from '@/services';
import { toast } from '@/lib/toast';

const STYLES = [
  { value: 'guide', label: '标准教程' },
  { value: 'fresh', label: '清爽实操' },
  { value: 'studio', label: '工作室' },
  { value: 'paper', label: '文档风' },
];

const DEFAULT_STAGES: ShortVideoTutorialStage[] = [
  { key: 'parse', label: '解析短视频文案', status: 'pending', message: '等待提交', at: '' },
  { key: 'kb', label: '写入知识库', status: 'pending', message: '等待提交', at: '' },
  { key: 'image', label: '自动配图', status: 'pending', message: '等待提交', at: '' },
  { key: 'site', label: '生成网页教程', status: 'pending', message: '等待提交', at: '' },
  { key: 'share', label: '发布分享', status: 'pending', message: '等待提交', at: '' },
  { key: 'analytics', label: '访问统计', status: 'pending', message: '等待提交', at: '' },
];

function statusClass(status: ShortVideoTutorialStage['status']) {
  if (status === 'done') return 'border-token-success bg-token-success-soft text-token-success';
  if (status === 'running') return 'border-token-accent bg-token-accent-soft text-token-accent';
  if (status === 'failed') return 'border-token-error bg-token-error-soft text-token-error';
  return 'border-token-subtle bg-token-nested text-token-muted';
}

function statusIcon(status: ShortVideoTutorialStage['status']) {
  if (status === 'done') return <Check size={13} />;
  if (status === 'running') return <Loader2 size={13} className="animate-spin" />;
  if (status === 'failed') return <RefreshCcw size={13} />;
  return <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />;
}

export default function ShortVideoTutorialPage() {
  const [params] = useSearchParams();
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [title, setTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [storeId, setStoreId] = useState('');
  const [style, setStyle] = useState('guide');
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<ShortVideoTutorialStage[]>(DEFAULT_STAGES);
  const [result, setResult] = useState<ShortVideoTutorialRunResponse | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listDocumentStores(1, 100);
      if (alive && res.success) setStores(res.data.items);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const initialStoreId = params.get('storeId');
    if (initialStoreId) setStoreId(initialStoreId);
    const initialUrl = params.get('url');
    if (initialUrl) setVideoUrl(initialUrl);
  }, [params]);

  const canSubmit = useMemo(() => videoUrl.trim().length > 8 && !running, [videoUrl, running]);

  const submit = async () => {
    if (!canSubmit) return;
    setRunning(true);
    setResult(null);
    setStages(DEFAULT_STAGES.map((s, idx) => idx === 0
      ? { ...s, status: 'running', message: '已提交到服务器，等待权威结果' }
      : s));
    const started = window.setInterval(() => {
      setStages(prev => prev.map((s, idx) => {
        if (idx !== 0 || s.status !== 'running') return s;
        return { ...s, message: '服务器处理中，结果将以服务端返回为准' };
      }));
    }, 1800);

    try {
      const res = await createShortVideoTutorialRun({
        videoUrl: videoUrl.trim(),
        title: title.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
        storeId: storeId || undefined,
        style,
      });
      if (!res.success || !res.data) {
        toast.error('生成失败', res.error?.message);
        setStages(prev => prev.map((s, idx) => idx === 0 ? { ...s, status: 'failed', message: res.error?.message || '生成失败' } : s));
        return;
      }
      setResult(res.data);
      setStages(res.data.run.stages);
      toast.success('短视频教程已生成');
    } finally {
      window.clearInterval(started);
      setRunning(false);
    }
  };

  const copyShare = async () => {
    if (!result?.shareUrl) return;
    await navigator.clipboard.writeText(result.shareUrl);
    toast.success('分享链接已复制');
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-token-bg text-token-primary">
      <div className="shrink-0 border-b border-token-subtle px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-token-accent-soft text-token-accent">
            <Video size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[18px] font-semibold tracking-normal">短视频教程流水线</h1>
            <p className="text-[12px] text-token-muted">短视频链接到知识库文档、网页托管、分享统计</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid grid-cols-[minmax(360px,520px)_minmax(0,1fr)] gap-5 max-xl:grid-cols-1">
          <section className="surface-panel rounded-[8px] border border-token-subtle p-4">
            <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold">
              <FileText size={15} className="text-token-accent" />
              输入
            </div>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">短视频链接</span>
                <textarea
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  rows={3}
                  className="prd-field w-full resize-none rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="粘贴抖音、TikTok、快手、B 站等短视频分享链接"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">标题</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="prd-field w-full rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="不填则由服务器生成"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">字幕、文案或要点</span>
                <textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  rows={8}
                  className="prd-field w-full resize-none rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="有字幕或口播稿时粘贴在这里；没有时服务器会先生成教程骨架"
                />
              </label>

              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-token-secondary">目标知识库</span>
                  <select
                    value={storeId}
                    onChange={(e) => setStoreId(e.target.value)}
                    className="prd-field w-full rounded-[8px] px-3 py-2 text-[13px]"
                  >
                    <option value="">自动创建/使用短视频教程库</option>
                    {stores.map(store => (
                      <option key={store.id} value={store.id}>{store.name}</option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-token-secondary">网页风格</span>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="prd-field w-full rounded-[8px] px-3 py-2 text-[13px]"
                  >
                    {STYLES.map(item => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[8px] bg-token-accent px-4 text-[13px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {running ? '服务器生成中' : '生成教程并发布'}
              </button>
            </div>
          </section>

          <section className="surface-panel rounded-[8px] border border-token-subtle p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <ArrowRight size={15} className="text-token-accent" />
                生命周期
              </div>
              {result && (
                <span className="rounded-full border border-token-success bg-token-success-soft px-2 py-1 text-[11px] text-token-success">
                  服务端已完成
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
              {stages.map(stage => (
                <div key={stage.key} className={`rounded-[8px] border px-3 py-3 ${statusClass(stage.status)}`}>
                  <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current">
                      {statusIcon(stage.status)}
                    </span>
                    {stage.label}
                  </div>
                  <p className="text-[11px] leading-relaxed opacity-85">{stage.message}</p>
                </div>
              ))}
            </div>

            {result && (
              <div className="mt-5 border-t border-token-subtle pt-4">
                <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
                  <Globe size={15} className="text-token-accent" />
                  结果
                </div>
                <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
                  <ResultLink icon={<BookOpen size={15} />} label="知识库文档" href={result.documentUrl} />
                  <ResultLink icon={<Globe size={15} />} label="网页预览" href={result.shareUrl} />
                  <ResultLink icon={<Share2 size={15} />} label="网页托管" href={result.analyticsUrl} />
                  <button
                    type="button"
                    onClick={copyShare}
                    className="surface-row flex items-center justify-between gap-3 rounded-[8px] border border-token-subtle px-3 py-3 text-left text-[12px]"
                  >
                    <span className="inline-flex items-center gap-2"><Copy size={15} /> 复制分享链接</span>
                    <span className="text-token-muted">{result.shareViewCount} 次访问</span>
                  </button>
                </div>
                <div className="mt-3 rounded-[8px] border border-token-subtle bg-token-nested px-3 py-2 text-[11px] text-token-muted">
                  运行记录：{result.run.id}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ResultLink({ icon, label, href }: { icon: ReactNode; label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="surface-row flex items-center justify-between gap-3 rounded-[8px] border border-token-subtle px-3 py-3 text-[12px]"
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <ExternalLink size={13} className="shrink-0 text-token-muted" />
    </a>
  );
}
