import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Check,
  Eye,
  ImagePlus,
  Layers,
  Link as LinkIcon,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  generateWeeklyPosterPageImage,
  getWeeklyPoster,
  listWeeklyPosterKnowledgeEntries,
  listWeeklyPosters,
  listWeeklyPosterTemplates,
  publishWeeklyPoster,
  updateWeeklyPoster,
  type WeeklyPoster,
  type WeeklyPosterKnowledgeEntryMeta,
  type WeeklyPosterPage,
  type WeeklyPosterSourceType,
  type WeeklyPosterTemplateKey,
  type WeeklyPosterTemplateMeta,
} from '@/services';
import { PosterCarousel } from '@/components/weekly-poster/WeeklyPosterModal';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { findTemplate, POSTER_TEMPLATES_SEED, SOURCE_TYPES } from '@/lib/posterTemplates';
import { toast } from '@/lib/toast';
import { useSseStream } from '@/lib/useSseStream';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';

const DRAFT_ID_STORAGE_KEY = 'weekly-poster-wizard-draft-id';
const MAX_INLINE_MEDIA_BYTES = 2 * 1024 * 1024;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type PageProgress = 'pending' | 'generating-image' | 'done' | 'failed';
type MediaSlot = 'primary' | 'secondary';

interface PosterDesignerPageProps {
  embedded?: boolean;
}

export default function PosterDesignerPage({ embedded = false }: PosterDesignerPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [posters, setPosters] = useState<WeeklyPoster[]>([]);
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [templates, setTemplates] = useState<WeeklyPosterTemplateMeta[]>(POSTER_TEMPLATES_SEED);
  const [currentOrder, setCurrentOrder] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPoster, setLoadingPoster] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [imageProgress, setImageProgress] = useState<Record<number, PageProgress>>({});
  const lastSavedSignatureRef = useRef('');
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadSlotRef = useRef<MediaSlot>('primary');

  const pages = useMemo(
    () => [...(poster?.pages ?? [])].sort((a, b) => a.order - b.order),
    [poster?.pages],
  );
  const currentPage = pages.find((p) => p.order === currentOrder) ?? pages[0] ?? null;
  const selectedTemplate = useMemo(
    () => findTemplate(templates, poster?.templateKey ?? 'release'),
    [poster?.templateKey, templates],
  );

  const refreshList = useCallback(async (preferredId?: string | null) => {
    setLoadingList(true);
    const res = await listWeeklyPosters({ pageSize: 50 });
    setLoadingList(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载海报列表失败');
      return;
    }

    const items = res.data.items ?? [];
    setPosters(items);
    const nextId = preferredId || searchParams.get('id') || loadDraftId() || items[0]?.id || null;
    if (nextId) void selectPoster(nextId, false);
    else {
      setPoster(null);
      setSaveStatus('idle');
      lastSavedSignatureRef.current = '';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectPoster = useCallback(async (id: string, updateUrl = true) => {
    setLoadingPoster(true);
    const res = await getWeeklyPoster(id);
    setLoadingPoster(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '加载海报失败');
      return;
    }
    setPoster(res.data);
    setCurrentOrder(res.data.pages?.[0]?.order ?? 0);
    setImageProgress({});
    setSaveStatus('saved');
    setLastSavedAt(new Date());
    lastSavedSignatureRef.current = buildPosterSignature(res.data);
    saveDraftId(res.data.id);
    if (updateUrl && !embedded) setSearchParams({ id: res.data.id });
  }, [embedded, setSearchParams]);

  useEffect(() => {
    void listWeeklyPosterTemplates().then((res) => {
      if (res.success && res.data?.items?.length) setTemplates(res.data.items);
    });
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (pages.length === 0) return;
    if (!pages.some((p) => p.order === currentOrder)) {
      setCurrentOrder(pages[0].order);
    }
  }, [currentOrder, pages]);

  useEffect(() => {
    if (!poster?.id) return;
    const signature = buildPosterSignature(poster);
    if (!lastSavedSignatureRef.current || signature === lastSavedSignatureRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    saveTimerRef.current = window.setTimeout(async () => {
      setSaveStatus('saving');
      const savingSignature = buildPosterSignature(poster);
      const res = await updateWeeklyPoster(poster.id, toUpsertInput(poster));
      if (!res.success || !res.data) {
        setSaveStatus('failed');
        toast.error(res.error?.message || '自动保存失败');
        return;
      }

      lastSavedSignatureRef.current = savingSignature;
      setSaveStatus('saved');
      setLastSavedAt(new Date());
      setPosters((prev) => upsertPosterSummary(prev, res.data));
      setPoster((prev) => {
        if (!prev || prev.id !== res.data.id) return prev;
        return buildPosterSignature(prev) === savingSignature ? res.data : prev;
      });
    }, 1000);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [poster]);

  useEffect(() => {
    if (!poster || !currentPage || createOpen) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void handleUploadFile(file, 'primary');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poster?.id, currentPage?.order, createOpen]);

  const updateDraft = useCallback((updater: (draft: WeeklyPoster) => WeeklyPoster) => {
    setPoster((prev) => (prev ? updater(prev) : prev));
  }, []);

  const updatePosterFields = useCallback((patch: Partial<WeeklyPoster>) => {
    updateDraft((draft) => ({ ...draft, ...patch }));
  }, [updateDraft]);

  const updateCurrentPage = useCallback((patch: Partial<WeeklyPosterPage>) => {
    if (!currentPage) return;
    updateDraft((draft) => ({
      ...draft,
      pages: (draft.pages ?? []).map((page) =>
        page.order === currentPage.order ? { ...page, ...patch } : page,
      ),
    }));
  }, [currentPage, updateDraft]);

  const openFilePicker = (slot: MediaSlot) => {
    uploadSlotRef.current = slot;
    fileInputRef.current?.click();
  };

  const handleUploadFile = async (file: File, slot: MediaSlot) => {
    if (!currentPage) return;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      toast.error('只能上传图片或视频文件');
      return;
    }
    if (file.size > MAX_INLINE_MEDIA_BYTES) {
      toast.error('文件不能超过 2MB。当前版本会内联保存到海报草稿里。');
      return;
    }
    const dataUri = await fileToDataUri(file);
    updateCurrentPage(slot === 'primary'
      ? { imageUrl: dataUri }
      : { secondaryImageUrl: dataUri });
    toast.success(slot === 'primary' ? '主图已更新' : '副图已更新');
  };

  const regenerateImage = async () => {
    if (!poster || !currentPage) return;
    const prompt = currentPage.imagePrompt?.trim();
    if (!prompt) {
      toast.error('先填写配图提示词');
      return;
    }
    setImageProgress((prev) => ({ ...prev, [currentPage.order]: 'generating-image' }));
    const res = await generateWeeklyPosterPageImage(poster.id, currentPage.order, prompt);
    if (!res.success || !res.data) {
      setImageProgress((prev) => ({ ...prev, [currentPage.order]: 'failed' }));
      toast.error(res.error?.message || '重新生图失败');
      return;
    }
    setPoster(res.data);
    setPosters((prev) => upsertPosterSummary(prev, res.data));
    lastSavedSignatureRef.current = buildPosterSignature(res.data);
    setSaveStatus('saved');
    setLastSavedAt(new Date());
    setImageProgress((prev) => ({ ...prev, [currentPage.order]: 'done' }));
  };

  const handlePublish = async () => {
    if (!poster || publishing) return;
    setPublishing(true);
    const res = await publishWeeklyPoster(poster.id);
    setPublishing(false);
    if (!res.success || !res.data) {
      toast.error(res.error?.message || '发布失败');
      return;
    }
    setPoster(res.data);
    setPosters((prev) => upsertPosterSummary(prev, res.data));
    lastSavedSignatureRef.current = buildPosterSignature(res.data);
    setSaveStatus('saved');
    setLastSavedAt(new Date());
    saveDraftId(null);
    await useWeeklyPosterStore.getState().loadCurrent();
    toast.success('已发布到主页弹窗');
  };

  const handleCreated = async (created: WeeklyPoster) => {
    saveDraftId(created.id);
    await refreshList(created.id);
    if (!embedded) setSearchParams({ id: created.id });
  };

  const rootClass = embedded
    ? 'min-h-[720px] h-[calc(100vh-220px)]'
    : 'h-full min-h-0';

  return (
    <div
      className={`${rootClass} flex flex-col overflow-hidden rounded-xl`}
      style={{
        background: 'var(--bg-base)',
        border: embedded ? '1px solid rgba(255,255,255,0.08)' : undefined,
      }}
    >
      <style>{`
        @keyframes posterDesignerIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.currentTarget.value = '';
          if (file) void handleUploadFile(file, uploadSlotRef.current);
        }}
      />

      <div className="grid flex-1 min-h-0 grid-cols-1 xl:grid-cols-[260px_minmax(360px,1fr)_420px]">
        <aside
          className="min-h-0 flex flex-col border-b xl:border-b-0 xl:border-r"
          style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.025)' }}
        >
          <div className="shrink-0 p-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="w-full h-9 inline-flex items-center justify-center gap-2 rounded-md text-[13px] font-medium text-white transition-colors hover:bg-white/15"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)' }}
            >
              <Plus size={14} /> 新建海报
            </button>
            <Link
              to="/weekly-poster/advanced"
              className="mt-2 w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-md text-[12px] transition-colors hover:bg-white/10"
              style={{ color: 'rgba(255,255,255,0.62)', background: 'rgba(255,255,255,0.04)' }}
            >
              <Layers size={12} /> 高级编辑
            </Link>
          </div>

          <div className="px-4 py-3 flex items-center justify-between">
            <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-white/45">我的海报</div>
            <button
              type="button"
              onClick={() => void refreshList(poster?.id)}
              aria-label="刷新列表"
              className="w-7 h-7 rounded-md inline-flex items-center justify-center hover:bg-white/10 text-white/55"
            >
              <RefreshCw size={13} className={loadingList ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
            {loadingList && posters.length === 0 ? (
              <div className="h-28 flex items-center justify-center text-[12px] text-white/45">
                <MapSpinner size={14} /> <span className="ml-2">加载中</span>
              </div>
            ) : posters.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/12 p-4 text-center text-[12px] text-white/45">
                还没有海报
              </div>
            ) : (
              <div className="space-y-2">
                {posters.map((item) => (
                  <PosterListItem
                    key={item.id}
                    poster={item}
                    active={item.id === poster?.id}
                    onClick={() => void selectPoster(item.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 flex flex-col">
          <header
            className="shrink-0 min-h-[58px] px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-semibold text-white truncate">
                  {poster?.title || '海报设计器'}
                </h1>
                {poster && <StatusPill status={poster.status} />}
              </div>
              <div className="text-[11px] mt-0.5 text-white/45">
                {poster ? `${poster.weekKey} · ${selectedTemplate.label}` : '选择一张海报，或新建一张'}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} />
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                disabled={!poster || pages.length === 0}
                className="h-8 px-3 rounded-md inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:bg-white/10"
                style={{ color: 'rgba(255,255,255,0.76)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                <Eye size={13} /> 预览
              </button>
              <button
                type="button"
                onClick={handlePublish}
                disabled={!poster || publishing || pages.length === 0}
                className="h-8 px-3 rounded-md inline-flex items-center gap-1.5 text-[12px] font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:bg-white/20"
                style={{ background: 'rgba(255,255,255,0.11)', border: '1px solid rgba(255,255,255,0.2)' }}
              >
                {publishing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {poster?.status === 'published' ? '重新发布' : '发布到主页'}
              </button>
            </div>
          </header>

          {poster && pages.length > 0 ? (
            <>
              <div
                className="shrink-0 px-4 py-2 border-b flex items-center gap-2 overflow-x-auto"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              >
                {pages.map((page, i) => (
                  <button
                    key={`${page.order ?? `idx-${i}`}`}
                    type="button"
                    onClick={() => setCurrentOrder(page.order)}
                    className="shrink-0 h-8 px-3 rounded-md text-[12px] inline-flex items-center gap-1.5 transition-colors"
                    style={{
                      background: page.order === currentOrder ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.035)',
                      border: page.order === currentOrder ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.08)',
                      color: page.order === currentOrder ? '#fff' : 'rgba(255,255,255,0.62)',
                    }}
                  >
                    <span className="font-mono text-[10px]">{page.order + 1}</span>
                    <span className="max-w-[140px] truncate">{page.title || '未命名页面'}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-4">
                <div className="grid gap-4 lg:grid-cols-2" style={{ animation: 'posterDesignerIn 180ms ease-out both' }}>
                  <div className="space-y-4">
                    <MediaSlotPanel
                      label="主图"
                      url={currentPage?.imageUrl}
                      accent={currentPage?.accentColor}
                      progress={currentPage ? imageProgress[currentPage.order] : undefined}
                      onUpload={() => openFilePicker('primary')}
                      onGenerate={() => void regenerateImage()}
                      onClear={() => updateCurrentPage({ imageUrl: null })}
                    />
                    <MediaSlotPanel
                      label="副图"
                      hint="可选，用于双图版式或运营素材占位"
                      url={currentPage?.secondaryImageUrl}
                      accent={currentPage?.accentColor}
                      onUpload={() => openFilePicker('secondary')}
                      onClear={() => updateCurrentPage({ secondaryImageUrl: null })}
                    />
                  </div>

                  <div className="space-y-4">
                    <Field label="页面标题">
                      <input
                        value={currentPage?.title ?? ''}
                        onChange={(e) => updateCurrentPage({ title: e.target.value })}
                        className="w-full h-10 rounded-md px-3 text-[14px] outline-none"
                        style={fieldStyle}
                      />
                    </Field>
                    <Field label="配图提示词">
                      <textarea
                        value={currentPage?.imagePrompt ?? ''}
                        onChange={(e) => updateCurrentPage({ imagePrompt: e.target.value })}
                        rows={3}
                        className="w-full rounded-md px-3 py-2 text-[12px] outline-none resize-none"
                        style={fieldStyle}
                      />
                    </Field>
                    <div className="grid grid-cols-[1fr_auto] gap-3">
                      <Field label="主题色">
                        <input
                          value={currentPage?.accentColor ?? '#7c3aed'}
                          onChange={(e) => updateCurrentPage({ accentColor: e.target.value })}
                          className="w-full h-10 rounded-md px-3 text-[13px] outline-none font-mono"
                          style={fieldStyle}
                        />
                      </Field>
                      <label className="block">
                        <span className="block text-[11px] font-medium text-white/50 mb-1.5">色板</span>
                        <input
                          type="color"
                          value={normalizeColor(currentPage?.accentColor)}
                          onChange={(e) => updateCurrentPage({ accentColor: e.target.value })}
                          className="h-10 w-14 rounded-md cursor-pointer"
                          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)' }}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <EmptyDesignerState loading={loadingPoster} onCreate={() => setCreateOpen(true)} />
          )}
        </main>

        <section
          className="min-h-0 flex flex-col border-t xl:border-t-0 xl:border-l"
          style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.018)' }}
        >
          <div className="shrink-0 px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="text-[12px] font-semibold text-white/75">文案与发布地址</div>
            <div className="text-[11px] text-white/40 mt-0.5">正文支持 Markdown，右侧实时预览</div>
          </div>

          {poster && currentPage ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="海报标题">
                  <input
                    value={poster.title ?? ''}
                    onChange={(e) => updatePosterFields({ title: e.target.value })}
                    className="w-full h-9 rounded-md px-3 text-[13px] outline-none"
                    style={fieldStyle}
                  />
                </Field>
                <Field label="副标题">
                  <input
                    value={poster.subtitle ?? ''}
                    onChange={(e) => updatePosterFields({ subtitle: e.target.value })}
                    className="w-full h-9 rounded-md px-3 text-[13px] outline-none"
                    style={fieldStyle}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="CTA 文案">
                  <input
                    value={poster.ctaText ?? ''}
                    onChange={(e) => updatePosterFields({ ctaText: e.target.value })}
                    className="w-full h-9 rounded-md px-3 text-[13px] outline-none"
                    style={fieldStyle}
                  />
                </Field>
                <Field label="绑定地址">
                  <div className="relative">
                    <LinkIcon size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
                    <input
                      value={poster.ctaUrl ?? ''}
                      onChange={(e) => updatePosterFields({ ctaUrl: e.target.value })}
                      className="w-full h-9 rounded-md pl-8 pr-3 text-[13px] outline-none"
                      style={fieldStyle}
                    />
                  </div>
                </Field>
              </div>

              <Field label="正文编辑">
                <textarea
                  value={currentPage.body ?? ''}
                  onChange={(e) => updateCurrentPage({ body: e.target.value })}
                  className="w-full min-h-[220px] rounded-md px-3 py-2 text-[13px] outline-none resize-y"
                  style={{ ...fieldStyle, lineHeight: 1.65 }}
                />
              </Field>

              <Field label="Markdown 预览">
                <div
                  className="rounded-md p-3 min-h-[220px]"
                  style={{
                    background: 'rgba(0,0,0,0.24)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <MarkdownContent
                    content={currentPage.body || ' '}
                    className="text-[13px] leading-relaxed"
                  />
                </div>
              </Field>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] text-white/42 p-8 text-center">
              选择海报后可以编辑文案、CTA 和 Markdown 正文
            </div>
          )}
        </section>
      </div>

      {createOpen && (
        <CreatePosterModal
          templates={templates}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => void handleCreated(created)}
        />
      )}
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

function PosterListItem({
  poster,
  active,
  onClick,
}: {
  poster: WeeklyPoster;
  active: boolean;
  onClick: () => void;
}) {
  const cover = poster.pages?.find((p) => !!p.imageUrl)?.imageUrl;
  const accent = poster.pages?.[0]?.accentColor || '#64748b';
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg overflow-hidden text-left transition-colors"
      style={{
        background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.035)',
        border: active ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div
        className="relative"
        style={{
          aspectRatio: '16 / 8',
          background: cover ? '#0a0a12' : `linear-gradient(135deg, ${accent}, rgba(10,10,18,0.92))`,
        }}
      >
        {cover && renderMedia(cover, 'absolute inset-0 w-full h-full object-cover')}
        <span
          className="absolute left-2 top-2 px-1.5 py-0.5 rounded text-[9px] font-semibold"
          style={{ background: 'rgba(0,0,0,0.55)', color: statusColor(poster.status) }}
        >
          {statusLabel(poster.status)}
        </span>
        <span
          className="absolute right-2 top-2 px-1.5 py-0.5 rounded text-[9px]"
          style={{ background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.68)' }}
        >
          {poster.pages?.length ?? 0} 页
        </span>
      </div>
      <div className="p-2.5">
        <div className="text-[12px] font-medium text-white/88 truncate">{poster.title || '未命名海报'}</div>
        <div className="text-[10.5px] text-white/42 mt-0.5">
          {poster.weekKey} · {formatDate(poster.updatedAt)}
        </div>
      </div>
    </button>
  );
}

function MediaSlotPanel({
  label,
  hint,
  url,
  accent,
  progress,
  onUpload,
  onGenerate,
  onClear,
}: {
  label: string;
  hint?: string;
  url?: string | null;
  accent?: string | null;
  progress?: PageProgress;
  onUpload: () => void;
  onGenerate?: () => void;
  onClear: () => void;
}) {
  const busy = progress === 'generating-image';
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div
        className="relative"
        style={{
          aspectRatio: '16 / 10',
          background: url ? '#0a0a12' : `linear-gradient(135deg, ${accent || '#475569'}, rgba(10,10,18,0.95))`,
        }}
      >
        {url ? renderMedia(url, 'absolute inset-0 w-full h-full object-cover') : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/42">
            <ImagePlus size={28} />
            <div className="text-[12px] mt-2">{label}未设置</div>
            {hint && <div className="text-[10px] mt-1 px-6 text-center">{hint}</div>}
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.42)' }}>
            <span className="inline-flex items-center gap-2 px-3 h-8 rounded-full text-[12px] text-white"
              style={{ background: 'rgba(0,0,0,0.58)', border: '1px solid rgba(255,255,255,0.16)' }}>
              <MapSpinner size={13} /> 生图中
            </span>
          </div>
        )}
      </div>
      <div className="p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-white/75">{label}</div>
          <div className="text-[10.5px] text-white/40 truncate">
            {url ? mediaKindLabel(url) : '支持上传图片/视频，也可以直接 Ctrl+V 粘贴截图'}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          {onGenerate && (
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy}
              className="h-8 px-2.5 rounded-md inline-flex items-center gap-1 text-[11px] text-white/76 disabled:opacity-50 hover:bg-white/10"
              style={{ border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <Sparkles size={12} /> AI
            </button>
          )}
          <button
            type="button"
            onClick={onUpload}
            className="h-8 px-2.5 rounded-md inline-flex items-center gap-1 text-[11px] text-white/76 hover:bg-white/10"
            style={{ border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <Upload size={12} /> 上传
          </button>
          {url && (
            <button
              type="button"
              onClick={onClear}
              aria-label={`清空${label}`}
              className="w-8 h-8 rounded-md inline-flex items-center justify-center text-white/50 hover:bg-white/10"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CreatePosterModal({
  templates,
  onClose,
  onCreated,
}: {
  templates: WeeklyPosterTemplateMeta[];
  onClose: () => void;
  onCreated: (poster: WeeklyPoster) => void;
}) {
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>('release');
  const [sourceType, setSourceType] = useState<WeeklyPosterSourceType>('changelog-current-week');
  const [freeformContent, setFreeformContent] = useState('');
  const [kbEntryId, setKbEntryId] = useState('');
  const [kbEntries, setKbEntries] = useState<WeeklyPosterKnowledgeEntryMeta[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'llm' | 'images'>('idle');
  const [phaseLabel, setPhaseLabel] = useState('');
  const [typingText, setTypingText] = useState('');
  const [generatedPoster, setGeneratedPoster] = useState<WeeklyPoster | null>(null);
  const [pageProgress, setPageProgress] = useState<Record<number, PageProgress>>({});
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const busy = phase !== 'idle';
  const selectedTemplate = useMemo(() => findTemplate(templates, templateKey), [templateKey, templates]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (sourceType !== 'knowledge-base' || kbEntries.length > 0 || kbLoading) return;
    setKbLoading(true);
    void listWeeklyPosterKnowledgeEntries().then((res) => {
      setKbLoading(false);
      if (res.success && res.data) setKbEntries(res.data.items);
    });
  }, [sourceType, kbEntries.length, kbLoading]);

  const runImageGenPipeline = useCallback(async (basePoster: WeeklyPoster) => {
    const orders = (basePoster.pages ?? []).map((p) => p.order);
    if (orders.length === 0) {
      onCreated(basePoster);
      onClose();
      return;
    }

    setPhase('images');
    let latest = basePoster;
    await runWithConcurrency(orders, 3, async (order) => {
      setPageProgress((prev) => ({ ...prev, [order]: 'generating-image' }));
      const gen = await generateWeeklyPosterPageImage(basePoster.id, order);
      if (!gen.success || !gen.data) {
        setPageProgress((prev) => ({ ...prev, [order]: 'failed' }));
        return;
      }
      latest = gen.data;
      setGeneratedPoster(gen.data);
      setPageProgress((prev) => ({ ...prev, [order]: 'done' }));
    });
    toast.success('海报已生成');
    onCreated(latest);
    onClose();
  }, [onClose, onCreated]);

  const sse = useSseStream<unknown>({
    url: '/api/weekly-posters/autopilot/stream',
    method: 'POST',
    onEvent: {
      phase: (data) => {
        const d = data as { label?: string; phase?: string; message?: string };
        setPhaseLabel(d.label || d.message || d.phase || '');
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
        if (d.delta) setTypingText((prev) => prev + d.delta);
      },
      page: (data) => {
        const d = data as { page?: WeeklyPosterPage };
        const nextPage = d.page;
        if (!nextPage) return;
        setGeneratedPoster((prev) => {
          if (!prev) {
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
              pages: [nextPage],
              ctaText: '查看详情',
              ctaUrl: '/changelog',
              publishedAt: null,
              updatedAt: new Date().toISOString(),
            };
          }
          if (prev.pages?.some((p) => p.order === nextPage.order)) return prev;
          return { ...prev, pages: [...(prev.pages ?? []), nextPage].sort((a, b) => a.order - b.order) };
        });
        setPageProgress((prev) => ({ ...prev, [nextPage.order]: 'pending' }));
      },
    },
    onDone: (raw) => {
      const data = raw as { poster?: WeeklyPoster };
      if (!data.poster) {
        setPhase('idle');
        toast.error('生成响应缺少 poster 字段');
        return;
      }
      setGeneratedPoster(data.poster);
      saveDraftId(data.poster.id);
      void runImageGenPipeline(data.poster);
    },
    onError: (msg) => {
      setPhase('idle');
      toast.error(msg || '生成失败');
    },
  });

  const startGenerate = async () => {
    if (busy) return;
    if (sourceType === 'freeform' && freeformContent.trim().length < 40) {
      toast.error('自定义 markdown 至少 40 个字符');
      return;
    }
    if (sourceType === 'knowledge-base' && !kbEntryId) {
      toast.error('先选择一篇知识库文档');
      return;
    }

    setPhase('llm');
    setPhaseLabel('连接 AI 模型');
    setTypingText('');
    setGeneratedPoster(null);
    setPageProgress({});
    setModelInfo(null);
    await sse.start({
      body: {
        templateKey,
        sourceType,
        freeformContent: sourceType === 'freeform' ? freeformContent : undefined,
        sourceRef: sourceType === 'knowledge-base' ? kbEntryId : undefined,
      },
    });
  };

  const modal = (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ background: 'rgba(3,3,6,0.78)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="rounded-xl overflow-hidden flex flex-col"
        style={{
          width: 'min(1040px, 94vw)',
          height: 'min(82vh, 760px)',
          maxHeight: '82vh',
          background: 'linear-gradient(180deg, #14151b 0%, #0a0a12 100%)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 40px 80px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 h-14 px-5 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div>
            <div className="text-[14px] font-semibold text-white">新建海报</div>
            <div className="text-[11px] text-white/42">{busy ? phaseLabel || '生成中' : '选择模板与数据源后生成草稿'}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            className="w-8 h-8 rounded-md inline-flex items-center justify-center text-white/65 hover:bg-white/10 disabled:opacity-30"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[380px_1fr]">
          <div className="min-h-0 overflow-y-auto p-5 space-y-5 border-r" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <ModalSection title="模板">
              <div className="grid grid-cols-2 gap-2">
                {templates.map((template) => (
                  <button
                    key={template.key}
                    type="button"
                    onClick={() => setTemplateKey(template.key)}
                    disabled={busy}
                    className="rounded-lg p-3 text-left disabled:opacity-50"
                    style={{
                      background: template.key === templateKey ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)',
                      border: template.key === templateKey ? '1px solid rgba(255,255,255,0.24)' : '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <div className="text-[13px] font-medium text-white">{template.emoji} {template.label}</div>
                    <div className="text-[10.5px] text-white/45 mt-1 line-clamp-2">{template.description}</div>
                  </button>
                ))}
              </div>
            </ModalSection>

            <ModalSection title="数据源">
              <div className="space-y-2">
                {SOURCE_TYPES.map((source) => (
                  <button
                    key={source.key}
                    type="button"
                    onClick={() => setSourceType(source.key)}
                    disabled={busy}
                    className="w-full rounded-lg px-3 py-2.5 text-left disabled:opacity-50"
                    style={{
                      background: source.key === sourceType ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)',
                      border: source.key === sourceType ? '1px solid rgba(255,255,255,0.24)' : '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <div className="text-[12px] font-medium text-white">{source.label}</div>
                    <div className="text-[10.5px] text-white/45 mt-0.5">{source.description}</div>
                  </button>
                ))}
              </div>
              {sourceType === 'freeform' && (
                <textarea
                  value={freeformContent}
                  onChange={(e) => setFreeformContent(e.target.value)}
                  disabled={busy}
                  rows={6}
                  className="mt-3 w-full rounded-md px-3 py-2 text-[12px] outline-none resize-none"
                  placeholder="粘贴发布公告、活动说明或周报原文"
                  style={fieldStyle}
                />
              )}
              {sourceType === 'knowledge-base' && (
                <select
                  value={kbEntryId}
                  onChange={(e) => setKbEntryId(e.target.value)}
                  disabled={busy || kbLoading}
                  className="mt-3 w-full h-9 rounded-md px-3 text-[12px] outline-none"
                  style={fieldStyle}
                >
                  <option value="" style={{ background: '#111' }}>{kbLoading ? '加载中...' : '选择知识库文档'}</option>
                  {kbEntries.map((entry) => (
                    <option key={entry.id} value={entry.id} style={{ background: '#111' }}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              )}
            </ModalSection>

            <button
              type="button"
              onClick={() => void startGenerate()}
              disabled={busy}
              className="w-full h-10 rounded-md inline-flex items-center justify-center gap-2 text-[13px] font-medium text-white disabled:opacity-55"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}
            >
              {phase === 'llm' ? <MapSpinner size={14} /> : phase === 'images' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {phase === 'llm'
                ? phaseLabel || '写文案中'
                : phase === 'images'
                  ? `配图中 ${countDone(pageProgress)}/${Object.keys(pageProgress).length}`
                  : `生成 · ${selectedTemplate.label}`}
            </button>
          </div>

          <div className="min-h-0 flex flex-col">
            <div className="shrink-0 px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="text-[12px] font-medium text-white/72">生成进度</div>
              {modelInfo?.model && <div className="text-[10px] font-mono text-white/34">{modelInfo.model}</div>}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              {typingText && phase === 'llm' && <TypingPanel text={typingText} />}
              {generatedPoster ? (
                <div className="grid gap-3 mt-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  {[...(generatedPoster.pages ?? [])].sort((a, b) => a.order - b.order).map((page, i) => (
                    <GeneratedPageCard
                      key={`${page.order ?? `idx-${i}`}`}
                      page={page}
                      progress={pageProgress[page.order] ?? 'pending'}
                    />
                  ))}
                </div>
              ) : (
                <div className="h-full min-h-[260px] flex items-center justify-center text-center text-[12px] text-white/42">
                  <div>
                    <Sparkles size={26} className="mx-auto mb-3 text-white/28" />
                    点击生成后，这里会显示 AI 实时输出和页面卡片
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function GeneratedPageCard({ page, progress }: { page: WeeklyPosterPage; progress: PageProgress }) {
  const accent = page.accentColor || '#64748b';
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="relative" style={{ aspectRatio: '16 / 9', background: page.imageUrl ? '#0a0a12' : `linear-gradient(135deg, ${accent}, #0a0a12)` }}>
        {page.imageUrl && renderMedia(page.imageUrl, 'absolute inset-0 w-full h-full object-cover')}
        <div className="absolute inset-x-0 bottom-0 p-2 text-[10px] text-white/72" style={{ background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.72))' }}>
          Page {page.order + 1}
        </div>
        {progress === 'generating-image' && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.38)' }}>
            <MapSpinner size={16} />
          </div>
        )}
      </div>
      <div className="p-2.5">
        <div className="text-[12px] font-medium text-white/86 truncate">{page.title}</div>
        <div className="text-[10.5px] text-white/48 line-clamp-2 mt-1">{page.body}</div>
      </div>
    </div>
  );
}

function TypingPanel({ text }: { text: string }) {
  const tail = text.split('\n').slice(-8).join('\n');
  return (
    <div
      className="rounded-lg p-3 font-mono text-[11px] leading-relaxed"
      style={{
        background: 'rgba(0,0,0,0.32)',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(190,210,255,0.76)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <div className="flex items-center justify-between mb-2 text-[9px] uppercase tracking-[0.12em] text-white/34">
        <span>AI 实时输出</span>
        <span>{text.length} 字</span>
      </div>
      {tail}
    </div>
  );
}

function EmptyDesignerState({ loading, onCreate }: { loading: boolean; onCreate: () => void }) {
  return (
    <div className="flex-1 min-h-[360px] flex items-center justify-center p-8 text-center">
      {loading ? (
        <div className="inline-flex items-center gap-2 text-[13px] text-white/52">
          <MapSpinner size={15} /> 加载海报中
        </div>
      ) : (
        <div>
          <Sparkles size={30} className="mx-auto mb-3 text-white/30" />
          <div className="text-[15px] font-medium text-white/82">还没有选中海报</div>
          <button
            type="button"
            onClick={onCreate}
            className="mt-4 h-9 px-4 rounded-md inline-flex items-center gap-2 text-[13px] font-medium text-white hover:bg-white/15"
            style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)' }}
          >
            <Plus size={14} /> 新建海报
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-white/50 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function ModalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-white/44 mb-2.5">{title}</div>
      {children}
    </section>
  );
}

function SaveIndicator({ status, lastSavedAt }: { status: SaveStatus; lastSavedAt: Date | null }) {
  const content = status === 'saving'
    ? { icon: <Loader2 size={12} className="animate-spin" />, text: '正在保存', color: 'rgba(255,255,255,0.66)' }
    : status === 'failed'
      ? { icon: <X size={12} />, text: '保存失败', color: '#fca5a5' }
      : status === 'saved'
        ? { icon: <Check size={12} />, text: lastSavedAt ? `已保存 ${formatTime(lastSavedAt)}` : '已保存', color: '#86efac' }
        : { icon: <Save size={12} />, text: '未修改', color: 'rgba(255,255,255,0.42)' };
  return (
    <div className="h-8 px-2.5 rounded-md inline-flex items-center gap-1.5 text-[11px]"
      style={{ color: content.color, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {content.icon}
      {content.text}
    </div>
  );
}

function StatusPill({ status }: { status: WeeklyPoster['status'] }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
      style={{ color: statusColor(status), background: 'rgba(255,255,255,0.06)', border: `1px solid ${statusColor(status)}40` }}
    >
      {statusLabel(status)}
    </span>
  );
}

function buildPosterSignature(poster: WeeklyPoster) {
  return JSON.stringify(toUpsertInput(poster));
}

function toUpsertInput(poster: WeeklyPoster) {
  return {
    weekKey: poster.weekKey,
    title: poster.title,
    subtitle: poster.subtitle ?? null,
    templateKey: poster.templateKey,
    presentationMode: poster.presentationMode,
    sourceType: poster.sourceType ?? null,
    sourceRef: poster.sourceRef ?? null,
    pages: poster.pages ?? [],
    ctaText: poster.ctaText,
    ctaUrl: poster.ctaUrl,
  };
}

function upsertPosterSummary(items: WeeklyPoster[], poster: WeeklyPoster) {
  const rest = items.filter((item) => item.id !== poster.id);
  return [poster, ...rest].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function loadDraftId(): string | null {
  try {
    return sessionStorage.getItem(DRAFT_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveDraftId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(DRAFT_ID_STORAGE_KEY, id);
    else sessionStorage.removeItem(DRAFT_ID_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function renderMedia(url: string, className: string) {
  if (isVideoUrl(url)) {
    return <video src={url} className={className} muted playsInline autoPlay loop />;
  }
  return <img src={url} alt="" className={className} draggable={false} />;
}

function isVideoUrl(url: string) {
  return /^data:video\//i.test(url) || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
}

function mediaKindLabel(url: string) {
  return isVideoUrl(url) ? '视频素材' : '图片素材';
}

function normalizeColor(value?: string | null) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : '#7c3aed';
}

function statusLabel(status: WeeklyPoster['status']) {
  if (status === 'published') return '已发布';
  if (status === 'archived') return '已归档';
  return '草稿';
}

function statusColor(status: WeeklyPoster['status']) {
  if (status === 'published') return '#86efac';
  if (status === 'archived') return '#94a3b8';
  return '#fde68a';
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('zh-CN');
}

function formatTime(value: Date) {
  return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function countDone(progress: Record<number, PageProgress>) {
  return Object.values(progress).filter((item) => item === 'done').length;
}

async function runWithConcurrency<T>(
  items: T[],
  maxConcurrent: number,
  task: (item: T) => Promise<void>,
) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      try {
        await task(next);
      } catch {
        /* single page failure should not block the rest */
      }
    }
  });
  await Promise.all(workers);
}

const fieldStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.26)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: 'rgba(255,255,255,0.9)',
};
