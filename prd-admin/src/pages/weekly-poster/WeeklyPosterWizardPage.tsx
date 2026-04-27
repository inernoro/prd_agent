import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

/**
 * 服务器权威性: wizard 本地 state 只是后端 poster 的一个视图。
 * 刷新页面后通过 sessionStorage 中的 posterId 向后端重新拉取,不丢用户的生成结果。
 * (规则 .claude/rules/server-authority.md — 客户端被动、服务器权威)
 */
const DRAFT_ID_STORAGE_KEY = 'weekly-poster-wizard-draft-id';
const WIZARD_PREFS_STORAGE_KEY = 'weekly-poster-wizard-prefs';

function loadDraftId(): string | null {
  try { return sessionStorage.getItem(DRAFT_ID_STORAGE_KEY); } catch { return null; }
}
function saveDraftId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(DRAFT_ID_STORAGE_KEY, id);
    else sessionStorage.removeItem(DRAFT_ID_STORAGE_KEY);
  } catch { /* ignore */ }
}

interface WizardPrefs {
  templateKey?: WeeklyPosterTemplateKey;
  sourceType?: WeeklyPosterSourceType;
  kbEntryId?: string;
  freeformContent?: string;
}
function loadPrefs(): WizardPrefs {
  try {
    const raw = sessionStorage.getItem(WIZARD_PREFS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WizardPrefs;
  } catch { /* ignore */ }
  return {};
}
function savePrefs(p: WizardPrefs) {
  try { sessionStorage.setItem(WIZARD_PREFS_STORAGE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
import {
  SlidersHorizontal,
  Play,
  Eye,
  Send,
  RotateCcw,
  RefreshCw,
  FileText,
  LayoutTemplate,
  Monitor,
  Smartphone,
  Type,
} from 'lucide-react';
import {
  createWeeklyPoster,
  generateWeeklyPosterPageImage,
  getWeeklyPoster,
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
  SOURCE_TYPES,
} from '@/lib/posterTemplates';
import { PosterCarousel } from '@/components/weekly-poster/WeeklyPosterModal';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';

type PageProgress = 'pending' | 'generating-image' | 'done' | 'failed';
type CanvasMode = 'blank' | 'import';
type CanvasOrientation = 'landscape' | 'portrait';

const CANVAS_PRESETS: Record<CanvasOrientation, { label: string; size: string; width: number; height: number }> = {
  landscape: { label: '横版', size: '1200 x 628', width: 1200, height: 628 },
  portrait: { label: '竖版', size: '1080 x 1350', width: 1080, height: 1350 },
};

/** 计算当前 ISO 周标识 "YYYY-WXX" */
function currentWeekKey(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * AI 周报海报工坊 —— 选三下 + 一键生成。
 *
 * 视觉:全面走系统 Surface System(.surface / .surface-inset / .surface-interactive),
 * 不再塞超饱和紫色渐变,避免「AI 生成仪表盘」的套路观感。
 */
export default function WeeklyPosterWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialPrefs = useMemo(() => loadPrefs(), []);
  const [templates, setTemplates] = useState<WeeklyPosterTemplateMeta[]>(POSTER_TEMPLATES_SEED);
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>(initialPrefs.templateKey ?? 'release');
  const [sourceType, setSourceType] = useState<WeeklyPosterSourceType>(initialPrefs.sourceType ?? 'changelog-current-week');
  const [freeformContent, setFreeformContent] = useState(initialPrefs.freeformContent ?? '');
  const [presentationMode] = useState<'static'>('static');
  const [canvasMode, setCanvasMode] = useState<CanvasMode>('blank');
  const [canvasOrientation, setCanvasOrientation] = useState<CanvasOrientation>('landscape');
  const [pageCount, setPageCount] = useState(5);
  const [canvasTitle, setCanvasTitle] = useState(`本周更新 · ${currentWeekKey()}`);
  const [ctaText, setCtaText] = useState('阅读完整周报');

  const [phase, setPhase] = useState<'idle' | 'llm' | 'images' | 'ready'>('idle');
  const [phaseLabel, setPhaseLabel] = useState<string>('');
  const [typingText, setTypingText] = useState<string>('');
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [kbEntries, setKbEntries] = useState<WeeklyPosterKnowledgeEntryMeta[]>([]);
  const [kbEntryId, setKbEntryId] = useState<string>(initialPrefs.kbEntryId ?? '');
  const [kbLoading, setKbLoading] = useState(false);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [pageProgress, setPageProgress] = useState<Record<number, PageProgress>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const selectedTemplate = useMemo(() => findTemplate(templates, templateKey), [templates, templateKey]);
  const selectedCanvasPreset = CANVAS_PRESETS[canvasOrientation];
  const busy = phase === 'llm' || phase === 'images';

  useEffect(() => {
    void listWeeklyPosterTemplates().then((res) => {
      if (res.success && res.data?.items?.length) setTemplates(res.data.items);
    });
  }, []);

  // 刷新恢复:优先看 URL ?id,退而用 sessionStorage 里最近一次草稿 id,
  // 向后端拉最新 poster(服务器权威),重新建立 pageProgress。
  useEffect(() => {
    const urlId = searchParams.get('id');
    const draftId = urlId || loadDraftId();
    if (!draftId) return;
    void getWeeklyPoster(draftId).then((res) => {
      if (!res.success || !res.data) {
        // 可能已被删除 → 清 session
        if (!urlId) saveDraftId(null);
        return;
      }
      const p = res.data;
      setPoster(p);
      const pg: Record<number, PageProgress> = {};
      p.pages.forEach((pg0) => { pg[pg0.order] = pg0.imageUrl ? 'done' : 'pending'; });
      setPageProgress(pg);
      setPhase('ready');
      saveDraftId(p.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用户选择持久化(刷新后仍保留 templateKey/sourceType/freeformContent/kbEntryId)
  useEffect(() => {
    savePrefs({ templateKey, sourceType, kbEntryId, freeformContent });
  }, [templateKey, sourceType, kbEntryId, freeformContent]);

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
      saveDraftId(data.poster.id); // 落库持久化锚点,刷新后可恢复
      const orders = data.poster.pages.map((p) => p.order);
      void runImageGenPipeline(data.poster.id, orders);
      navigate(`/weekly-poster/${encodeURIComponent(data.poster.id)}`);
    },
    onError: (msg) => {
      setPhase('idle');
      setPhaseLabel('');
      toast.error(msg || '生成失败,换个数据源或稍后再试');
    },
  });

  const handleCreateCanvas = useCallback(async () => {
    if (busy) return;
    if (canvasMode === 'import' && sourceType === 'freeform' && freeformContent.trim().length < 40) {
      toast.error('自定义 markdown 至少 40 个字符');
      return;
    }
    if (canvasMode === 'import' && sourceType === 'knowledge-base' && !kbEntryId) {
      toast.error('请先选一篇知识库文档作为数据源');
      return;
    }

    // 重置
    setTypingText('');
    setPoster(null);
    setModelInfo(null);
    setSourceSummary(null);
    setPageProgress({});

    if (canvasMode === 'blank') {
      setPhase('images');
      const accents = selectedTemplate.accentPalette?.length
        ? selectedTemplate.accentPalette
        : ['#7c3aed'];
      const pages = Array.from({ length: pageCount }, (_, order) => ({
        order,
        title: order === 0 ? canvasTitle : `第 ${order + 1} 页`,
        body: '',
        imagePrompt: '',
        imageUrl: null,
        accentColor: accents[order % accents.length],
      }));
      const res = await createWeeklyPoster({
        weekKey: currentWeekKey(),
        title: canvasTitle,
        subtitle: '',
        templateKey,
        presentationMode,
        sourceType: 'freeform',
        pages,
        ctaText,
        ctaUrl: '/changelog',
      });
      setPhase('ready');
      if (!res.success || !res.data) {
        toast.error(res.error?.message || '创建画布失败');
        return;
      }
      setPoster(res.data);
      saveDraftId(res.data.id);
      const pg: Record<number, PageProgress> = {};
      res.data.pages.forEach((p) => { pg[p.order] = 'pending'; });
      setPageProgress(pg);
      toast.success('空白画布已创建,可以进入微调编辑');
      navigate(`/weekly-poster/${encodeURIComponent(res.data.id)}`);
      return;
    }

    setPhase('llm');
    setPhaseLabel('连接 AI 模型…');
    await sse.start({
      body: {
        templateKey,
        sourceType,
        freeformContent: sourceType === 'freeform' ? freeformContent : undefined,
        sourceRef: sourceType === 'knowledge-base' ? kbEntryId : undefined,
        pageCount,
        weekKey: currentWeekKey(),
      },
    });
  }, [
    busy,
    canvasMode,
    canvasTitle,
    ctaText,
    freeformContent,
    kbEntryId,
    pageCount,
    presentationMode,
    selectedTemplate.accentPalette,
    navigate,
    sourceType,
    sse,
    templateKey,
  ]);

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
    saveDraftId(null); // 发布成功,清锚点,下次进入是新空白
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
              Poster · New Canvas
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-white">
              新建海报
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
              创建成功后会进入独立工作台,继续编辑页面、素材、版式和发布参数。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {poster && (
              <button
                type="button"
                onClick={() => {
                  setPoster(null);
                  setPageProgress({});
                  setTypingText('');
                  setModelInfo(null);
                  setSourceSummary(null);
                  setPhase('idle');
                  saveDraftId(null);
                }}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-[12px] transition-colors"
                style={{
                  color: 'rgba(255,255,255,0.7)',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                新建空白
              </button>
            )}
            <Link
              to="/weekly-poster"
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-[12px] transition-colors"
              style={{
                color: 'rgba(255,255,255,0.7)',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              返回列表
            </Link>
          </div>
        </div>

        {/* 画布工作台 */}
        <div
          className="surface rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.1)' }}
        >
          <div
            className="grid min-h-[620px]"
            style={{ gridTemplateColumns: '360px minmax(0, 1fr)' }}
          >
            <aside
              className="min-h-0 overflow-y-auto px-5 py-5 space-y-5"
              style={{ borderRight: '1px solid rgba(255,255,255,0.08)', overscrollBehavior: 'contain' }}
            >
              <Section title="生成方式">
                <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <ModeButton
                    active={canvasMode === 'blank'}
                    disabled={busy}
                    icon={<FileText size={14} />}
                    title="空白画布"
                    description="先建页,再手动编辑"
                    onClick={() => setCanvasMode('blank')}
                  />
                  <ModeButton
                    active={canvasMode === 'import'}
                    disabled={busy}
                    icon={<Type size={14} />}
                    title="导入文案"
                    description="AI 生成文案和配图"
                    onClick={() => setCanvasMode('import')}
                  />
                </div>
              </Section>

              {canvasMode === 'import' && (
                <Section title="内容来源">
                  <div className="grid gap-2">
                    {SOURCE_TYPES.map((s) => {
                      const active = s.key === sourceType;
                      return (
                        <button
                          key={s.key}
                          type="button"
                          onClick={() => setSourceType(s.key)}
                          disabled={busy}
                          className="rounded-lg text-left transition-colors px-3 py-2.5 disabled:opacity-50 cursor-pointer"
                          style={{
                            background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.025)',
                            border: active
                              ? '1px solid rgba(129,140,248,0.52)'
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
                      rows={5}
                      placeholder="粘贴周报原文、发布说明或活动介绍..."
                      className="w-full mt-2.5 px-3 py-2 rounded-md text-[12px] outline-none font-mono"
                      style={{
                        background: 'rgba(0,0,0,0.25)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.9)',
                        minHeight: 112,
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
              )}

              <Section title="画布设置">
                <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <ModeButton
                    active={canvasOrientation === 'landscape'}
                    disabled={busy}
                    icon={<Monitor size={14} />}
                    title="横版"
                    description="1200 x 628"
                    onClick={() => setCanvasOrientation('landscape')}
                  />
                  <ModeButton
                    active={canvasOrientation === 'portrait'}
                    disabled={busy}
                    icon={<Smartphone size={14} />}
                    title="竖版"
                    description="1080 x 1350"
                    onClick={() => setCanvasOrientation('portrait')}
                  />
                </div>
                <div className="mt-3 rounded-xl px-3 py-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12px] font-medium text-white/75">页面数量</span>
                    <span className="text-[12px] font-semibold text-white">{pageCount} 页</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    value={pageCount}
                    onChange={(e) => setPageCount(Number(e.target.value))}
                    disabled={busy}
                    className="w-full accent-indigo-400"
                  />
                </div>
              </Section>

              <Section title="视觉模板">
                <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  {templates.map((t) => {
                    const active = t.key === templateKey;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setTemplateKey(t.key)}
                        disabled={busy}
                        className="rounded-lg text-left transition-colors disabled:opacity-50 cursor-pointer"
                        style={{
                          padding: 12,
                          background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.025)',
                          border: active
                            ? '1px solid rgba(129,140,248,0.52)'
                            : '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <LayoutTemplate size={13} style={{ color: active ? '#a5b4fc' : 'rgba(255,255,255,0.45)' }} />
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

              <Section title="基础内容">
                <label className="block">
                  <div className="text-[11px] font-medium text-white/55 mb-1">画布标题</div>
                  <input
                    value={canvasTitle}
                    onChange={(e) => setCanvasTitle(e.target.value)}
                    disabled={busy}
                    className="w-full h-9 px-3 rounded-md text-[13px] outline-none"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.9)',
                    }}
                  />
                </label>
                <label className="block mt-2.5">
                  <div className="text-[11px] font-medium text-white/55 mb-1">CTA 文案</div>
                  <input
                    value={ctaText}
                    onChange={(e) => setCtaText(e.target.value)}
                    disabled={busy}
                    className="w-full h-9 px-3 rounded-md text-[13px] outline-none"
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.9)',
                    }}
                  />
                </label>
              </Section>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleCreateCanvas}
                  disabled={busy}
                  className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg text-[14px] font-medium transition-colors disabled:cursor-not-allowed cursor-pointer"
                  style={{
                    background: busy ? 'rgba(255,255,255,0.06)' : 'rgba(129,140,248,0.18)',
                    color: '#fff',
                    border: '1px solid rgba(129,140,248,0.36)',
                  }}
                >
                  {phase === 'llm' ? (
                    <><MapSpinner size={14} /> {phaseLabel || '启动中…'}</>
                  ) : phase === 'images' ? (
                    <><MapSpinner size={14} /> 创建中</>
                  ) : canvasMode === 'blank' ? (
                    <><FileText size={14} /> 创建画布</>
                  ) : (
                    <><Play size={14} /> 生成画布</>
                  )}
                </button>
              </div>
            </aside>

            <section className="min-w-0 px-7 py-5 flex flex-col">
              <div className="shrink-0 flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-[14px] font-semibold text-white">画布预览</h2>
                  <p className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
                    当前项目内将创建 {pageCount} 页 {selectedCanvasPreset.label} 画布
                  </p>
                </div>
                <div
                  className="inline-flex items-center gap-2 px-3 h-8 rounded-full text-[11px] font-medium"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.68)' }}
                >
                  {selectedCanvasPreset.size}
                </div>
              </div>

              <CanvasPreview
                title={canvasTitle}
                ctaText={ctaText}
                mode={canvasMode}
                orientation={canvasOrientation}
                pageCount={pageCount}
                template={selectedTemplate}
              />

              {modelInfo?.model && (
                <div className="mt-4 text-center text-[10.5px] font-mono"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  ● {modelInfo.model}
                  {modelInfo.platform ? ` · ${modelInfo.platform}` : ''}
                  {sourceSummary ? `   |   ${sourceSummary}` : ''}
                </div>
              )}

              {(phase === 'llm' && typingText.length > 0) && <TypingPanel text={typingText} />}
            </section>
          </div>

          <div
            className="px-5 py-3 flex items-center justify-between"
            style={{ borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.025)' }}
          >
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
              项目由顶部管理；这里仅配置当前画布的尺寸、页数、模板和内容来源。
            </div>
            <button
              type="button"
              onClick={handleCreateCanvas}
              disabled={busy}
              className="inline-flex items-center gap-2 px-5 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:cursor-not-allowed cursor-pointer"
              style={{
                background: busy
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(255,255,255,0.1)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
            >
              {phase === 'llm' ? (
                <><MapSpinner size={14} /> {phaseLabel || '启动中…'}</>
              ) : phase === 'images' ? (
                <><MapSpinner size={14} /> 创建中</>
              ) : phase === 'ready' ? (
                <><RefreshCw size={14} /> 再建一组</>
              ) : canvasMode === 'blank' ? (
                <><FileText size={14} /> 创建画布</>
              ) : (
                <><Play size={14} /> 生成画布</>
              )}
            </button>
          </div>
        </div>

        {/* 结果区 */}
        {poster && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-white/85">
                生成结果 · {(poster.pages ?? []).length} 页
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewOpen(true)}
                  disabled={(poster.pages ?? []).length === 0}
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    color: 'rgba(255,255,255,0.8)',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <Eye size={12} /> 预览
                </button>
                <Link
                  to={poster ? `/weekly-poster/${encodeURIComponent(poster.id)}` : '/weekly-poster'}
                  className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-[12px] transition-colors hover:bg-white/10"
                  style={{
                    color: 'rgba(255,255,255,0.7)',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <SlidersHorizontal size={12} /> 进入工作台
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
              {(poster.pages ?? []).map((p, i) => (
                <ResultPageCard
                  key={`${p.order ?? `idx-${i}`}`}
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

function ModeButton({
  active,
  disabled,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      style={{
        padding: 12,
        background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.025)',
        border: active
          ? '1px solid rgba(129,140,248,0.52)'
          : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ color: active ? '#a5b4fc' : 'rgba(255,255,255,0.5)' }}>{icon}</span>
        <span className="text-[13px] font-medium text-white">{title}</span>
      </div>
      <div className="text-[10.5px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>
        {description}
      </div>
    </button>
  );
}

function CanvasPreview({
  title,
  ctaText,
  mode,
  orientation,
  pageCount,
  template,
}: {
  title: string;
  ctaText: string;
  mode: CanvasMode;
  orientation: CanvasOrientation;
  pageCount: number;
  template: WeeklyPosterTemplateMeta;
}) {
  const preset = CANVAS_PRESETS[orientation];
  const palette = template.accentPalette?.length
    ? template.accentPalette
    : ['#7c3aed', '#0ea5e9', '#22c55e'];
  const aspectRatio = `${preset.width} / ${preset.height}`;
  const isPortrait = orientation === 'portrait';

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <div
        className="relative w-full rounded-2xl overflow-hidden"
        style={{
          maxWidth: isPortrait ? 420 : 760,
          aspectRatio,
          background: `linear-gradient(135deg, ${palette[0]} 0%, rgba(9,12,22,0.94) 48%, ${palette[1] ?? palette[0]} 130%)`,
          border: '1px solid rgba(255,255,255,0.16)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.16)',
        }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 78% 12%, rgba(255,255,255,0.18), transparent 28%), linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.52) 100%)',
          }}
        />
        <div className="absolute inset-0 p-[7%] flex flex-col">
          <div className="flex items-center justify-between">
            <div
              className="inline-flex items-center gap-2 px-3 h-8 rounded-full text-[11px] font-semibold tracking-[0.12em]"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.82)' }}
            >
              {preset.size}
            </div>
            <div
              className="px-2.5 h-7 rounded-full inline-flex items-center text-[11px]"
              style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.72)' }}
            >
              {pageCount} 页
            </div>
          </div>

          <div className="mt-auto" style={{ maxWidth: isPortrait ? '92%' : '72%' }}>
            <div className="text-[11px] font-semibold tracking-[0.16em] uppercase mb-3" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {mode === 'blank' ? 'Blank Canvas' : 'AI Draft Canvas'} · {template.label}
            </div>
            <h3
              className="font-bold"
              style={{
                color: '#fff',
                fontSize: isPortrait ? 'clamp(28px, 5.4vw, 44px)' : 'clamp(28px, 4vw, 48px)',
                lineHeight: 1.08,
              }}
            >
              {title || '未命名画布'}
            </h3>
            <p className="mt-4 text-[clamp(13px,1.6vw,18px)] leading-relaxed" style={{ color: 'rgba(255,255,255,0.72)' }}>
              {mode === 'blank'
                ? '创建后进入编辑工作台,逐页填写文案、上传素材或生成配图。'
                : 'AI 会根据内容来源生成页面文案和配图,完成后可继续微调。'}
            </p>
          </div>

          <div className="mt-7 flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              {Array.from({ length: Math.min(pageCount, 8) }, (_, i) => (
                <span
                  key={i}
                  className="rounded-full"
                  style={{
                    width: i === 0 ? 22 : 7,
                    height: 7,
                    background: i === 0 ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.32)',
                  }}
                />
              ))}
            </div>
            <div
              className="shrink-0 inline-flex items-center px-4 h-9 rounded-full text-[12px] font-medium"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff' }}
            >
              {ctaText || '阅读完整周报'}
            </div>
          </div>
        </div>
      </div>
    </div>
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
