import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  SlidersHorizontal,
  Play,
  Eye,
  Send,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import {
  autopilotWeeklyPoster,
  generateWeeklyPosterPageImage,
  publishWeeklyPoster,
  listWeeklyPosterTemplates,
  type WeeklyPoster,
  type WeeklyPosterPage,
  type WeeklyPosterTemplateKey,
  type WeeklyPosterTemplateMeta,
  type WeeklyPosterSourceType,
} from '@/services';
import {
  POSTER_TEMPLATES_SEED,
  findTemplate,
  PRESENTATION_MODES,
  SOURCE_TYPES,
} from '@/lib/posterTemplates';
import { WeeklyPosterModal } from '@/components/weekly-poster/WeeklyPosterModal';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

type PageProgress = 'pending' | 'generating-image' | 'done' | 'failed';

/**
 * AI 周报海报工坊 —— 选三下 + 一键生成。
 *
 * 视觉:全面走系统 Surface System(.surface / .surface-inset / .surface-interactive),
 * 不再塞超饱和紫色渐变,避免「AI 生成仪表盘」的套路观感。
 */
export default function WeeklyPosterWizardPage() {
  const [templates, setTemplates] = useState<WeeklyPosterTemplateMeta[]>(POSTER_TEMPLATES_SEED);
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>('release');
  const [sourceType, setSourceType] = useState<WeeklyPosterSourceType>('changelog-current-week');
  const [freeformContent, setFreeformContent] = useState('');
  const [presentationMode] = useState<'static'>('static');

  const [phase, setPhase] = useState<'idle' | 'llm' | 'images' | 'ready'>('idle');
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [pageProgress, setPageProgress] = useState<Record<number, PageProgress>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const selectedTemplate = useMemo(() => findTemplate(templates, templateKey), [templates, templateKey]);
  const busy = phase === 'llm' || phase === 'images';

  useEffect(() => {
    void listWeeklyPosterTemplates().then((res) => {
      if (res.success && res.data?.items?.length) setTemplates(res.data.items);
    });
  }, []);

  const handleAutopilot = useCallback(async () => {
    if (busy) return;
    if (sourceType === 'freeform' && freeformContent.trim().length < 40) {
      toast.error('自定义 markdown 至少 40 个字符');
      return;
    }
    setPhase('llm');
    setPoster(null);
    setModelInfo(null);
    setPageProgress({});

    const res = await autopilotWeeklyPoster({
      templateKey,
      sourceType,
      freeformContent: sourceType === 'freeform' ? freeformContent : undefined,
    });
    if (!res.success || !res.data) {
      setPhase('idle');
      toast.error(res.error?.message || '生成失败,换个数据源或稍后再试');
      return;
    }

    const draft = res.data.poster;
    setPoster(draft);
    setModelInfo({ model: res.data.model ?? undefined, platform: res.data.platform ?? undefined });
    setSourceSummary(res.data.sourceSummary ?? null);
    const initial: Record<number, PageProgress> = {};
    draft.pages.forEach((p) => { initial[p.order] = 'pending'; });
    setPageProgress(initial);
    setPhase('images');

    await runWithConcurrency(
      draft.pages.map((p) => p.order),
      3,
      async (order) => {
        setPageProgress((prev) => ({ ...prev, [order]: 'generating-image' }));
        const gen = await generateWeeklyPosterPageImage(draft.id, order);
        if (!gen.success || !gen.data) {
          setPageProgress((prev) => ({ ...prev, [order]: 'failed' }));
          return;
        }
        setPoster(gen.data);
        setPageProgress((prev) => ({ ...prev, [order]: 'done' }));
      },
    );
    setPhase('ready');
    toast.success('生成完毕,点「预览」看看效果');
  }, [busy, templateKey, sourceType, freeformContent]);

  const handleRegenerateImage = useCallback(async (order: number) => {
    if (!poster || busy) return;
    setPageProgress((prev) => ({ ...prev, [order]: 'generating-image' }));
    const gen = await generateWeeklyPosterPageImage(poster.id, order);
    if (!gen.success || !gen.data) {
      setPageProgress((prev) => ({ ...prev, [order]: 'failed' }));
      toast.error(gen.error?.message || '重新生图失败');
      return;
    }
    setPoster(gen.data);
    setPageProgress((prev) => ({ ...prev, [order]: 'done' }));
  }, [poster, busy]);

  const handlePublish = useCallback(async () => {
    if (!poster) return;
    setPublishing(true);
    const res = await publishWeeklyPoster(poster.id);
    setPublishing(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '发布失败');
      return;
    }
    setPoster(res.data);
    toast.success('已发布,登录用户下次访问主页即可看到');
    await useWeeklyPosterStore.getState().loadCurrent();
  }, [poster]);

  return (
    <div
      className="h-full min-h-0 overflow-y-auto"
      style={{ background: 'var(--bg-base)', overscrollBehavior: 'contain' }}
    >
      <div className="max-w-[1080px] mx-auto px-8 py-8 pb-24">
        {/* 顶栏 */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase mb-1"
              style={{ color: 'rgba(255,255,255,0.4)' }}>
              Report · Poster
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-white">
              周报海报工坊
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
              选模板 · 选数据源 · 一键生成 — 文字由 AI 写,图片自动配
            </p>
          </div>
          <Link
            to="/weekly-poster/advanced"
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-[12px] transition-colors"
            style={{
              color: 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <SlidersHorizontal size={12} /> 高级编辑
          </Link>
        </div>

        {/* 主面板 —— 液态玻璃容器 */}
        <div className="surface rounded-2xl p-6 space-y-6">
          {/* ① 模板 */}
          <Section title="模板">
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              {templates.map((t) => {
                const active = t.key === templateKey;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTemplateKey(t.key)}
                    disabled={busy}
                    className="relative rounded-lg text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:-translate-y-px"
                    style={{
                      padding: 12,
                      background: active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)',
                      border: active
                        ? '1px solid rgba(255,255,255,0.24)'
                        : '1px solid rgba(255,255,255,0.08)',
                      boxShadow: active
                        ? 'inset 0 1px 0 rgba(255,255,255,0.08)'
                        : 'none',
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[16px]">{t.emoji}</span>
                      <span className="text-[13px] font-medium text-white">{t.label}</span>
                    </div>
                    <div className="text-[11px] leading-relaxed line-clamp-2"
                      style={{ color: 'rgba(255,255,255,0.55)' }}>
                      {t.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* ② 数据源 */}
          <Section title="数据源">
            <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {SOURCE_TYPES.map((s) => {
                const active = s.key === sourceType;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSourceType(s.key)}
                    disabled={busy}
                    className="rounded-lg text-left transition-all px-3 py-2.5 disabled:opacity-50"
                    style={{
                      background: active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)',
                      border: active
                        ? '1px solid rgba(255,255,255,0.24)'
                        : '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <div className="text-[12px] font-medium text-white">{s.label}</div>
                    <div className="text-[10.5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
                      {s.description}
                    </div>
                  </button>
                );
              })}
            </div>
            {sourceType === 'freeform' && (
              <textarea
                value={freeformContent}
                onChange={(e) => setFreeformContent(e.target.value)}
                disabled={busy}
                rows={6}
                placeholder="粘贴任何 markdown —— 周报原文、发布说明、活动介绍…"
                className="w-full mt-2.5 px-3 py-2 rounded-md text-[12px] outline-none font-mono"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.9)',
                  minHeight: 120,
                }}
              />
            )}
          </Section>

          {/* ③ 展示形态 */}
          <Section title="展示形态">
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {PRESENTATION_MODES.map((m) => {
                const active = m.key === presentationMode;
                return (
                  <div
                    key={m.key}
                    className="rounded-lg px-3 py-2.5 transition-colors"
                    style={{
                      background: active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)',
                      border: active
                        ? '1px solid rgba(255,255,255,0.24)'
                        : '1px solid rgba(255,255,255,0.08)',
                      opacity: m.enabled ? 1 : 0.55,
                      cursor: m.enabled ? 'default' : 'not-allowed',
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="text-[12px] font-medium text-white">{m.label}</div>
                      {!m.enabled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)' }}>
                          敬请期待
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
                      {m.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* 生成按钮 */}
          <div className="pt-2 flex justify-center">
            <button
              type="button"
              onClick={handleAutopilot}
              disabled={busy}
              className="inline-flex items-center gap-2 px-6 h-11 rounded-lg text-[14px] font-medium transition-all disabled:cursor-not-allowed"
              style={{
                background: busy
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                boxShadow: busy ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.12)',
                minWidth: 280,
                justifyContent: 'center',
              }}
            >
              {phase === 'llm' ? (
                <><MapSpinner size={14} /> 正在写文案…</>
              ) : phase === 'images' ? (
                <><MapSpinner size={14} /> 配图生成中({countDone(pageProgress)}/{Object.keys(pageProgress).length})</>
              ) : phase === 'ready' ? (
                <><RefreshCw size={14} /> 换参数再生成一张</>
              ) : (
                <><Play size={14} /> 一键生成 · {selectedTemplate.emoji} {selectedTemplate.label}</>
              )}
            </button>
          </div>

          {modelInfo?.model && (
            <div className="text-center text-[10.5px] font-mono"
              style={{ color: 'rgba(255,255,255,0.35)' }}>
              ● {modelInfo.model}
              {modelInfo.platform ? ` · ${modelInfo.platform}` : ''}
              {sourceSummary ? `   |   ${sourceSummary}` : ''}
            </div>
          )}
        </div>

        {/* 结果区 */}
        {poster && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-white/85">
                生成结果 · {poster.pages.length} 页
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                  style={{
                    color: 'rgba(255,255,255,0.8)',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <Eye size={12} /> 预览
                </button>
                <Link
                  to="/weekly-poster/advanced"
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                  style={{
                    color: 'rgba(255,255,255,0.7)',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <SlidersHorizontal size={12} /> 微调
                </Link>
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={publishing || phase !== 'ready'}
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:bg-white/20"
                  style={{
                    background: 'rgba(255,255,255,0.12)',
                    border: '1px solid rgba(255,255,255,0.22)',
                  }}
                >
                  {publishing ? <MapSpinner size={12} /> : <Send size={12} />}
                  {poster.status === 'published' ? '已发布' : '发布到主页'}
                </button>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {poster.pages.map((p) => (
                <ResultPageCard
                  key={p.order}
                  page={p}
                  progress={pageProgress[p.order] ?? 'pending'}
                  onRegenerate={() => handleRegenerateImage(p.order)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {previewOpen && poster && (
        <PreviewPortal poster={poster} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[11px] font-semibold tracking-[0.12em] uppercase mb-2.5"
        style={{ color: 'rgba(255,255,255,0.45)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ResultPageCard({
  page,
  progress,
  onRegenerate,
  disabled,
}: {
  page: WeeklyPosterPage;
  progress: PageProgress;
  onRegenerate: () => void;
  disabled: boolean;
}) {
  const accent = page.accentColor || 'rgba(255,255,255,0.15)';
  const showImage = !!page.imageUrl && progress !== 'generating-image';
  return (
    <div
      className="surface rounded-xl overflow-hidden flex flex-col"
    >
      {/* 图片区 */}
      <div
        className="relative"
        style={{
          aspectRatio: '16/10',
          background: page.imageUrl
            ? '#0a0a12'
            : `linear-gradient(135deg, ${accent} 0%, rgba(10,10,18,0.9) 100%)`,
        }}
      >
        {showImage && (
          <img
            src={page.imageUrl!}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        )}
        {progress === 'generating-image' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px]"
              style={{
                background: 'rgba(0,0,0,0.55)',
                color: 'rgba(255,255,255,0.9)',
                border: '1px solid rgba(255,255,255,0.15)',
              }}>
              <MapSpinner size={10} /> 配图生成中
            </div>
          </div>
        )}
        {progress === 'pending' && !page.imageUrl && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] tracking-wider"
            style={{ color: 'rgba(255,255,255,0.5)' }}>
            等待中
          </div>
        )}
        {progress === 'failed' && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={disabled}
            className="absolute inset-0 flex items-center justify-center text-[11px] transition-colors hover:bg-white/5"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <RotateCcw size={12} className="mr-1" /> 生图失败,点这里重试
          </button>
        )}
        {progress === 'done' && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={disabled}
            aria-label="重新生成"
            className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-black/70"
            style={{
              background: 'rgba(0,0,0,0.4)',
              color: 'rgba(255,255,255,0.85)',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      {/* 文字区 */}
      <div className="p-3">
        <div className="text-[9px] font-semibold tracking-[0.15em] uppercase mb-1"
          style={{ color: 'rgba(255,255,255,0.4)' }}>
          Page {page.order + 1}
        </div>
        <div className="text-[13px] font-semibold line-clamp-1 mb-1"
          style={{ color: 'rgba(255,255,255,0.92)' }}>
          {page.title}
        </div>
        <div className="text-[11px] leading-relaxed line-clamp-3"
          style={{ color: 'rgba(255,255,255,0.6)' }}>
          {page.body}
        </div>
      </div>
    </div>
  );
}

function PreviewPortal({ poster, onClose }: { poster: WeeklyPoster; onClose: () => void }) {
  useEffect(() => {
    const prev = useWeeklyPosterStore.getState().currentPoster;
    useWeeklyPosterStore.setState({ currentPoster: poster, dismissedIds: new Set() });
    return () => {
      useWeeklyPosterStore.setState({
        currentPoster: prev,
        dismissedIds: prev ? new Set() : new Set([poster.id]),
      });
    };
  }, [poster]);

  useEffect(() => {
    const unsub = useWeeklyPosterStore.subscribe((s) => {
      if (s.dismissedIds.has(poster.id)) onClose();
    });
    return () => unsub();
  }, [poster.id, onClose]);

  return <WeeklyPosterModal />;
}

// ────────────────────────────────────────────────────────────

function countDone(progress: Record<number, PageProgress>): number {
  return Object.values(progress).filter((p) => p === 'done').length;
}

async function runWithConcurrency<T>(
  items: T[],
  maxConcurrent: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      try {
        await task(next);
      } catch {
        /* 单页失败不阻塞其他页 */
      }
    }
  });
  await Promise.all(workers);
}
