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
  generateWeeklyPosterPageImage,
  publishWeeklyPoster,
  listWeeklyPosterTemplates,
  listWeeklyPosterKnowledgeEntries,
  type WeeklyPoster,
  type WeeklyPosterPage,
  type WeeklyPosterTemplateKey,
  type WeeklyPosterTemplateMeta,
  type WeeklyPosterSourceType,
  type WeeklyPosterKnowledgeEntryMeta,
} from '@/services';
import {
  POSTER_TEMPLATES_SEED,
  findTemplate,
  PRESENTATION_MODES,
  SOURCE_TYPES,
} from '@/lib/posterTemplates';
import { PosterCarousel } from '@/components/weekly-poster/WeeklyPosterModal';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
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
  const [phaseLabel, setPhaseLabel] = useState<string>('');
  const [typingText, setTypingText] = useState<string>('');
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [kbEntries, setKbEntries] = useState<WeeklyPosterKnowledgeEntryMeta[]>([]);
  const [kbEntryId, setKbEntryId] = useState<string>('');
  const [kbLoading, setKbLoading] = useState(false);
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

  // 切到知识库数据源时懒加载条目列表
  useEffect(() => {
    if (sourceType !== 'knowledge-base' || kbEntries.length > 0 || kbLoading) return;
    setKbLoading(true);
    void listWeeklyPosterKnowledgeEntries().then((res) => {
      setKbLoading(false);
      if (res.success && res.data) setKbEntries(res.data.items);
    });
  }, [sourceType, kbEntries.length, kbLoading]);

  // ── 图片生成流水线(SSE done 后调用;单页重生也复用) ──
  const runImageGenPipeline = useCallback(
    async (posterId: string, orders: number[]) => {
      setPhase('images');
      await runWithConcurrency(orders, 3, async (order) => {
        setPageProgress((prev) => ({ ...prev, [order]: 'generating-image' }));
        const gen = await generateWeeklyPosterPageImage(posterId, order);
        if (!gen.success || !gen.data) {
          setPageProgress((prev) => ({ ...prev, [order]: 'failed' }));
          return;
        }
        setPoster(gen.data);
        setPageProgress((prev) => ({ ...prev, [order]: 'done' }));
      });
      setPhase('ready');
      toast.success('生成完毕,点「预览」看看效果');
    },
    [],
  );

  // ── SSE 流:阶段 / 数据源 / 模型 / 逐页 / 完成 / 错误 ──
  const sse = useSseStream<unknown>({
    url: '/api/weekly-posters/autopilot/stream',
    method: 'POST',
    onEvent: {
      phase: (data) => {
        const d = data as { label?: string; phase?: string };
        setPhaseLabel(d.label || d.phase || '');
      },
      source: (data) => {
        const d = data as { summary?: string };
        setSourceSummary(d.summary ?? null);
      },
      model: (data) => {
        const d = data as { model?: string; platform?: string };
        setModelInfo({ model: d.model, platform: d.platform });
      },
      chunk: (data) => {
        const d = data as { delta?: string };
        if (d.delta) setTypingText((prev) => prev + d.delta);
      },
      thinking: (data) => {
        const d = data as { delta?: string };
        // 思考内容也一起显示在 typing 区,前缀加灰度提示
        if (d.delta) setTypingText((prev) => prev + d.delta);
      },
      page: (data) => {
        const d = data as { page: WeeklyPosterPage };
        setPoster((prev) => {
          if (!prev) {
            // 未出现过的海报 stub:用当前模板兜底,done 事件会覆盖为完整对象
            return {
              id: '',
              weekKey: '',
              title: '',
              subtitle: null,
              status: 'draft',
              templateKey,
              presentationMode: 'static',
              sourceType,
              sourceRef: null,
              pages: [d.page],
              ctaText: '',
              ctaUrl: '/changelog',
              publishedAt: null,
              updatedAt: new Date().toISOString(),
            };
          }
          if (prev.pages.some((p) => p.order === d.page.order)) return prev;
          return { ...prev, pages: [...prev.pages, d.page].sort((a, b) => a.order - b.order) };
        });
        setPageProgress((prev) => ({ ...prev, [d.page.order]: 'pending' }));
      },
    },
    onDone: (raw) => {
      const data = raw as { poster?: WeeklyPoster };
      if (!data.poster) {
        toast.error('生成响应缺少 poster 字段');
        setPhase('idle');
        return;
      }
      setPoster(data.poster);
      const orders = data.poster.pages.map((p) => p.order);
      void runImageGenPipeline(data.poster.id, orders);
    },
    onError: (msg) => {
      setPhase('idle');
      setPhaseLabel('');
      toast.error(msg || '生成失败,换个数据源或稍后再试');
    },
  });

  const handleAutopilot = useCallback(async () => {
    if (busy) return;
    if (sourceType === 'freeform' && freeformContent.trim().length < 40) {
      toast.error('自定义 markdown 至少 40 个字符');
      return;
    }
    if (sourceType === 'knowledge-base' && !kbEntryId) {
      toast.error('请先选一篇知识库文档作为数据源');
      return;
    }

    // 重置
    setPhase('llm');
    setPhaseLabel('连接 AI 模型…');
    setTypingText('');
    setPoster(null);
    setModelInfo(null);
    setSourceSummary(null);
    setPageProgress({});

    await sse.start({
      body: {
        templateKey,
        sourceType,
        freeformContent: sourceType === 'freeform' ? freeformContent : undefined,
        sourceRef: sourceType === 'knowledge-base' ? kbEntryId : undefined,
      },
    });
  }, [busy, templateKey, sourceType, freeformContent, kbEntryId, sse]);

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
      <style>{`
        @keyframes posterPageIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes posterCaretBlink {
          0%, 49%   { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
      `}</style>
      <div className="max-w-[1080px] mx-auto px-8 py-8 pb-24">
        {/* 顶栏 */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] uppercase mb-1"
              style={{ color: 'rgba(255,255,255,0.4)' }}>
              Homepage · Poster
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-white">
              海报工坊
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
              把更新 / 公告 / 活动一键做成主页弹窗海报 — AI 写文字,自动配图
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
            {sourceType === 'knowledge-base' && (
              <div className="mt-2.5">
                {kbLoading ? (
                  <div className="flex items-center gap-2 text-[12px] text-white/50 px-3 py-2">
                    <MapSpinner size={12} /> 加载知识库列表…
                  </div>
                ) : kbEntries.length === 0 ? (
                  <div className="text-[12px] text-white/50 px-3 py-2">
                    知识库里还没有可用文档,去「百宝箱 → 知识库」上传一份再来。
                  </div>
                ) : (
                  <select
                    value={kbEntryId}
                    onChange={(e) => setKbEntryId(e.target.value)}
                    disabled={busy}
                    className="w-full px-3 py-2 rounded-md text-[12px] outline-none"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.9)',
                    }}
                  >
                    <option value="">— 选一篇文档 —</option>
                    {kbEntries.map((entry) => (
                      <option key={entry.id} value={entry.id} style={{ background: '#111' }}>
                        {entry.title} ({entry.contentChars} 字)
                      </option>
                    ))}
                  </select>
                )}
              </div>
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
                <><MapSpinner size={14} /> {phaseLabel || '启动中…'}</>
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

          {/* 打字机面板:LLM 流式输出实时滚动,满足规则 #6 禁止空白等待 */}
          {(phase === 'llm' && typingText.length > 0) && <TypingPanel text={typingText} />}
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
        <PosterCarousel
          poster={poster}
          onDismiss={() => setPreviewOpen(false)}
          navigateOnCta={false}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────

/**
 * 打字机面板 — 把 LLM 流式 chunk 实时显示成滚动文字,
 * 满足 CLAUDE.md #6「LLM 等待时屏幕必须有持续变化的内容」。
 */
function TypingPanel({ text }: { text: string }) {
  // 取尾部 4 行,模拟终端输出
  const tailLines = text.split('\n').slice(-4).join('\n');
  return (
    <div
      className="mt-3 mx-auto rounded-md p-3 font-mono"
      style={{
        maxWidth: 540,
        background: 'rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(180,210,255,0.7)',
        fontSize: 11,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        minHeight: 70,
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.35)' }}>
          AI · 实时输出
        </span>
        <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
          {text.length} 字
        </span>
      </div>
      {tailLines}
      <span
        className="inline-block ml-0.5 align-middle"
        style={{
          width: 6,
          height: 11,
          background: 'rgba(180,210,255,0.7)',
          animation: 'posterCaretBlink 1s steps(2) infinite',
        }}
      />
    </div>
  );
}

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
      style={{
        animation: 'posterPageIn 320ms ease-out both',
      }}
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
