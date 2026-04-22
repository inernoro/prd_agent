import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Settings2,
  Wand2,
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
 * AI 周报海报工坊 —— 选三下,点一次,4-5 张配图海报自动生成。
 *
 * 路径最短:模板 → 数据源 → 大按钮 → 生成结果卡片边出现边填充,
 * 最后点「发布到主页」即可在登录用户首次进主页时弹出。
 *
 * 非静态形态(fullscreen/interactive)暂为「敬请期待」徽章。
 */
export default function WeeklyPosterWizardPage() {
  const [templates, setTemplates] = useState<WeeklyPosterTemplateMeta[]>(POSTER_TEMPLATES_SEED);
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>('release');
  const [sourceType, setSourceType] = useState<WeeklyPosterSourceType>('changelog-current-week');
  const [freeformContent, setFreeformContent] = useState('');
  const [presentationMode, setPresentationMode] = useState<'static'>('static');

  const [phase, setPhase] = useState<'idle' | 'llm' | 'images' | 'ready'>('idle');
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [pageProgress, setPageProgress] = useState<Record<number, PageProgress>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const selectedTemplate = useMemo(() => findTemplate(templates, templateKey), [templates, templateKey]);

  useEffect(() => {
    void listWeeklyPosterTemplates().then((res) => {
      if (res.success && res.data?.items?.length) setTemplates(res.data.items);
    });
  }, []);

  const busy = phase === 'llm' || phase === 'images';

  // ── 一键生成:先 autopilot 拿文字草稿,再并发调 generate-image(max 3) ──
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
    const initialProgress: Record<number, PageProgress> = {};
    draft.pages.forEach((p) => {
      initialProgress[p.order] = 'pending';
    });
    setPageProgress(initialProgress);
    setPhase('images');

    // 并发生图(每次最多 3 个)
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
        // 后端每次返回整张 poster,取最新
        setPoster(gen.data);
        setPageProgress((prev) => ({ ...prev, [order]: 'done' }));
      },
    );
    setPhase('ready');
    toast.success('生成完毕,点「预览」看看效果');
  }, [busy, templateKey, sourceType, freeformContent]);

  const handleRegenerateImage = useCallback(
    async (order: number) => {
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
    },
    [poster, busy],
  );

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
    // 让当前会话也能立刻看到:清 dismissed,load 后会自动弹
    await useWeeklyPosterStore.getState().loadCurrent();
  }, [poster]);

  return (
    <div
      className="h-full min-h-0 overflow-y-auto"
      style={{ background: 'var(--bg-base)', overscrollBehavior: 'contain' }}
    >
      <div className="max-w-[1080px] mx-auto px-8 py-8 pb-24">
        {/* Hero */}
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-indigo-300/70 mb-1">
              REPORT · POSTER · AI 向导
            </div>
            <h1
              className="text-[28px] font-semibold tracking-tight"
              style={{
                background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              AI 周报海报工坊
            </h1>
            <p className="text-[13px] text-white/60 mt-1">
              选模板 · 选数据源 · 点一次 — 4-5 张配图海报自动生成
            </p>
          </div>
          <Link
            to="/weekly-poster/advanced"
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
            style={{
              color: 'rgba(255,255,255,0.65)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <Settings2 size={12} /> 高级模式(手动编辑)
          </Link>
        </div>

        {/* ① 模板 */}
        <Section index="①" title="选一个模板">
          <div className="grid grid-cols-4 gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            {templates.map((t) => {
              const active = t.key === templateKey;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTemplateKey(t.key)}
                  disabled={busy}
                  className="relative rounded-xl text-left transition-all disabled:opacity-60 disabled:cursor-not-allowed enabled:hover:-translate-y-0.5"
                  style={{
                    padding: 14,
                    background: active
                      ? 'linear-gradient(180deg, rgba(124,58,237,0.18) 0%, rgba(124,58,237,0.06) 100%)'
                      : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid rgba(124,58,237,0.55)' : '1px solid rgba(255,255,255,0.08)',
                    boxShadow: active ? '0 0 20px rgba(124,58,237,0.18)' : 'none',
                  }}
                >
                  <div className="text-[22px] mb-1.5">{t.emoji}</div>
                  <div className="text-[13px] font-semibold text-white">{t.label}</div>
                  <div className="text-[11px] text-white/55 mt-0.5 leading-relaxed line-clamp-2">
                    {t.description}
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    {t.accentPalette.slice(0, 5).map((c) => (
                      <span
                        key={c}
                        className="inline-block rounded-full"
                        style={{ width: 10, height: 10, background: c, boxShadow: `0 0 6px ${c}80` }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </Section>

        {/* ② 数据源 */}
        <Section index="②" title="选数据源">
          <div className="flex gap-2 mb-2">
            {SOURCE_TYPES.map((s) => {
              const active = s.key === sourceType;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSourceType(s.key)}
                  disabled={busy}
                  className="rounded-lg text-left transition-colors px-3 py-2 disabled:opacity-60"
                  style={{
                    flex: 1,
                    background: active ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid rgba(124,58,237,0.5)' : '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <div className="text-[12px] font-medium text-white">{s.label}</div>
                  <div className="text-[10px] text-white/55 mt-0.5">{s.description}</div>
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
              placeholder={
                '在此粘贴任何 markdown 内容 —— 周报原文、发布说明、活动介绍… AI 会自动拆成 4-5 页海报。'
              }
              className="w-full mt-2 px-3 py-2 rounded-md text-[12px] outline-none transition-colors font-mono"
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.9)',
                minHeight: 120,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.6)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
            />
          )}
        </Section>

        {/* ③ 形态 */}
        <Section index="③" title="展示形态">
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {PRESENTATION_MODES.map((m) => {
              const active = m.key === presentationMode;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => m.enabled && setPresentationMode('static')}
                  disabled={!m.enabled || busy}
                  className="relative rounded-lg text-left px-3 py-2.5 transition-colors disabled:cursor-not-allowed"
                  style={{
                    background: active ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid rgba(124,58,237,0.5)' : '1px solid rgba(255,255,255,0.1)',
                    opacity: m.enabled ? 1 : 0.55,
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <div className="text-[12px] font-medium text-white">{m.label}</div>
                    {!m.enabled && (
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                        style={{
                          background: 'rgba(251,191,36,0.18)',
                          color: '#fcd34d',
                        }}
                      >
                        WIP
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-white/55 mt-0.5">{m.description}</div>
                </button>
              );
            })}
          </div>
        </Section>

        {/* ④ 大按钮 */}
        <div className="mt-10 flex justify-center">
          <button
            type="button"
            onClick={handleAutopilot}
            disabled={busy}
            className="inline-flex items-center gap-2 px-8 h-14 rounded-full text-[16px] font-semibold text-white transition-all disabled:cursor-not-allowed enabled:hover:scale-[1.03]"
            style={{
              background: busy
                ? 'linear-gradient(135deg, rgba(124,58,237,0.5), rgba(244,63,94,0.5))'
                : 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
              boxShadow: '0 10px 30px -6px rgba(124,58,237,0.55)',
              minWidth: 320,
              justifyContent: 'center',
            }}
          >
            {phase === 'llm' ? (
              <>
                <MapSpinner size={18} /> AI 正在写文案...
              </>
            ) : phase === 'images' ? (
              <>
                <MapSpinner size={18} /> 配图生成中({countDone(pageProgress)}/{Object.keys(pageProgress).length})
              </>
            ) : phase === 'ready' ? (
              <>
                <RefreshCw size={18} /> 换个模板 / 数据源 再生成一张
              </>
            ) : (
              <>
                <Wand2 size={18} /> 一键生成本周海报 · {selectedTemplate.emoji} {selectedTemplate.label}
              </>
            )}
          </button>
        </div>

        {/* 模型可见性(规则 ai-model-visibility) */}
        {modelInfo?.model && (
          <div className="mt-3 text-center text-[11px] text-white/40 font-mono">
            ● 文案模型: {modelInfo.model}
            {modelInfo.platform ? ` · ${modelInfo.platform}` : ''}
            {sourceSummary ? ` · 数据源: ${sourceSummary}` : ''}
          </div>
        )}

        {/* ⑤ 结果卡片 */}
        {poster && (
          <div className="mt-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-semibold text-white/85">
                生成结果 · {poster.pages.length} 页
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                  style={{
                    color: 'rgba(255,255,255,0.85)',
                    border: '1px solid rgba(255,255,255,0.18)',
                  }}
                >
                  <Eye size={12} /> 预览轮播
                </button>
                <Link
                  to="/weekly-poster/advanced"
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                  style={{
                    color: 'rgba(255,255,255,0.7)',
                    border: '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <Settings2 size={12} /> 去高级编辑
                </Link>
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={publishing || phase !== 'ready'}
                  className="inline-flex items-center gap-1 px-4 h-8 rounded-md text-[12px] font-medium text-white transition-all disabled:opacity-60 enabled:hover:scale-[1.03]"
                  style={{
                    background: 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)',
                    boxShadow: '0 4px 16px rgba(124,58,237,0.3)',
                  }}
                >
                  {publishing ? <MapSpinner size={12} /> : <Send size={12} />}
                  {poster.status === 'published' ? '已发布' : '发布到主页'}
                </button>
              </div>
            </div>

            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
            >
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

      {/* 预览:复用主页弹窗组件,但把 currentPoster 临时 override */}
      {previewOpen && poster && (
        <PreviewPortal poster={poster} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 小组件
// ────────────────────────────────────────────────────────────

function Section({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <span
          className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold"
          style={{
            background: 'linear-gradient(135deg, rgba(124,58,237,0.3), rgba(0,240,255,0.3))',
            color: '#e0e7ff',
            border: '1px solid rgba(124,58,237,0.3)',
          }}
        >
          {index}
        </span>
        <h2 className="text-[14px] font-semibold text-white/85">{title}</h2>
      </div>
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
  const accent = page.accentColor || '#7c3aed';
  const showImage = !!page.imageUrl && progress !== 'generating-image';
  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {/* 图片区 */}
      <div
        className="relative"
        style={{
          aspectRatio: '16/10',
          background: `linear-gradient(135deg, ${accent}, #0a0a12)`,
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
        {/* 占位 + 状态徽章 */}
        {progress === 'generating-image' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium"
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
              }}>
              <MapSpinner size={10} /> 配图生成中
            </div>
          </div>
        )}
        {progress === 'pending' && !page.imageUrl && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/65 tracking-wider">
            等待中
          </div>
        )}
        {progress === 'failed' && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={disabled}
            className="absolute inset-0 flex items-center justify-center text-[11px] text-rose-200 transition-colors hover:bg-rose-500/15"
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
            style={{ background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      {/* 文字区 */}
      <div className="p-3">
        <div className="text-[9px] font-semibold tracking-[0.15em] uppercase mb-1"
          style={{ color: accent }}>
          Page {page.order + 1}
        </div>
        <div className="text-[13px] font-semibold text-white line-clamp-1 mb-1">
          {page.title}
        </div>
        <div className="text-[11px] leading-relaxed text-white/65 line-clamp-3">
          {page.body}
        </div>
      </div>
    </div>
  );
}

function PreviewPortal({ poster, onClose }: { poster: WeeklyPoster; onClose: () => void }) {
  // 重用主页弹窗组件:把 store 的 currentPoster 临时替换,dismiss 映射为关闭
  const state = useWeeklyPosterStore();
  useEffect(() => {
    const prev = state.currentPoster;
    useWeeklyPosterStore.setState({ currentPoster: poster, dismissedIds: new Set() });
    return () => {
      useWeeklyPosterStore.setState({
        currentPoster: prev,
        dismissedIds: prev ? new Set() : new Set([poster.id]),
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poster.id]);

  // 监听 store.dismissedIds 含当前 id 时即关闭
  useEffect(() => {
    const unsub = useWeeklyPosterStore.subscribe((s) => {
      if (s.dismissedIds.has(poster.id)) onClose();
    });
    return () => unsub();
  }, [poster.id, onClose]);

  return <WeeklyPosterModal />;
}

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────

function countDone(progress: Record<number, PageProgress>): number {
  return Object.values(progress).filter((p) => p === 'done').length;
}

/** 并发池:同时最多 N 个 task 在跑 */
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
