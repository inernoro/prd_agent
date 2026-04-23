import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  FolderOpen,
  History,
  ImagePlus,
  Layers,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Minus,
  Monitor,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Send,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Upload,
  Wand2,
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
import { resolveAvatarUrl } from '@/lib/avatar';
import { findTemplate, POSTER_TEMPLATES_SEED, SOURCE_TYPES } from '@/lib/posterTemplates';
import { toast } from '@/lib/toast';
import { useSseStream } from '@/lib/useSseStream';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';

const DRAFT_ID_STORAGE_KEY = 'weekly-poster-wizard-draft-id';
const MAX_INLINE_MEDIA_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCENT = '#7c3aed';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type PageProgress = 'pending' | 'generating-image' | 'done' | 'failed';
type MediaSlot = 'primary' | 'secondary';
type WorkspaceMenuKey = 'project' | 'template' | 'assets' | 'agent' | 'pages' | 'publish';
type WorkspaceTab = 'content' | 'assets' | 'layout' | 'agent';
type DevicePreview = 'desktop' | 'mobile';
type CanvasOrientation = 'landscape' | 'portrait';
type AgentTarget = 'prompt' | 'body';
type AgentStatus = 'done' | 'working' | 'waiting';

interface PosterDesignerPageProps {
  embedded?: boolean;
}

interface CreatePosterInitialConfig {
  templateKey?: WeeklyPosterTemplateKey;
  sourceType?: WeeklyPosterSourceType;
  pageCount?: number;
  ctaUrl?: string;
}

interface BatchConfig {
  pageCount: number;
  templateKey: WeeklyPosterTemplateKey;
  sourceType: WeeklyPosterSourceType;
  orientation: CanvasOrientation;
  unifyTheme: boolean;
  autoCopy: boolean;
  smartImage: boolean;
}

interface PublishChannels {
  wechat: boolean;
  miniProgram: boolean;
  douyin: boolean;
  store: boolean;
  other: boolean;
}

interface AgentLogEntry {
  id: number;
  role: 'user' | 'system';
  text: string;
}

const WORKSPACE_MENU: Array<{ key: WorkspaceMenuKey; label: string; icon: React.ReactNode }> = [
  { key: 'project', label: '项目', icon: <FolderOpen size={16} /> },
  { key: 'template', label: '模板', icon: <Layers size={16} /> },
  { key: 'assets', label: '素材库', icon: <ImagePlus size={16} /> },
  { key: 'agent', label: 'AI Agent', icon: <Sparkles size={16} /> },
  { key: 'pages', label: '页面管理', icon: <FileText size={16} /> },
  { key: 'publish', label: '发布记录', icon: <History size={16} /> },
];

const FLOW_STEPS = ['模板上传', '生成方案', '预览', '发布'];
const WORKFLOW_GUIDE = [
  '用户提案',
  '内容撰写 / 素材上传',
  '选择生成方案',
  'AI Agent 生成与优化',
  '预览与确认',
  '发布上线',
];

export default function PosterDesignerPage({ embedded = false }: PosterDesignerPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useAuthStore((s) => s.user);
  const setFullBleedMain = useLayoutStore((s) => s.setFullBleedMain);
  const [posters, setPosters] = useState<WeeklyPoster[]>([]);
  const [poster, setPoster] = useState<WeeklyPoster | null>(null);
  const [templates, setTemplates] = useState<WeeklyPosterTemplateMeta[]>(POSTER_TEMPLATES_SEED);
  const [currentOrder, setCurrentOrder] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPoster, setLoadingPoster] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createConfig, setCreateConfig] = useState<CreatePosterInitialConfig | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [imageProgress, setImageProgress] = useState<Record<number, PageProgress>>({});
  const [activeMenu, setActiveMenu] = useState<WorkspaceMenuKey>('project');
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('agent');
  const [devicePreview, setDevicePreview] = useState<DevicePreview>('desktop');
  const [previewScale, setPreviewScale] = useState(76);
  const [batchConfig, setBatchConfig] = useState<BatchConfig>({
    pageCount: 8,
    templateKey: 'release',
    sourceType: 'changelog-current-week',
    orientation: 'landscape',
    unifyTheme: true,
    autoCopy: true,
    smartImage: true,
  });
  const [publishChannels, setPublishChannels] = useState<PublishChannels>({
    wechat: true,
    miniProgram: true,
    douyin: true,
    store: false,
    other: false,
  });
  const [publishNote, setPublishNote] = useState('');
  const [agentTarget, setAgentTarget] = useState<AgentTarget>('prompt');
  const [agentInput, setAgentInput] = useState('');
  const [agentLogs, setAgentLogs] = useState<AgentLogEntry[]>([]);
  const lastSavedSignatureRef = useRef('');
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadSlotRef = useRef<MediaSlot>('primary');
  const agentInputRef = useRef<HTMLTextAreaElement | null>(null);

  const pages = useMemo(
    () => [...(poster?.pages ?? [])].sort((a, b) => a.order - b.order),
    [poster?.pages],
  );
  const currentPage = pages.find((p) => p.order === currentOrder) ?? pages[0] ?? null;
  const selectedTemplate = useMemo(
    () => findTemplate(templates, poster?.templateKey ?? 'release'),
    [poster?.templateKey, templates],
  );
  const selectedSourceType = useMemo(
    () => SOURCE_TYPES.find((item) => item.key === coerceSourceType(poster?.sourceType)),
    [poster?.sourceType],
  );
  const userAvatarUrl = useMemo(
    () => resolveAvatarUrl({
      avatarFileName: currentUser?.avatarFileName ?? null,
      avatarUrl: currentUser?.avatarUrl ?? null,
    }),
    [currentUser?.avatarFileName, currentUser?.avatarUrl],
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
    if (!embedded && updateUrl) setSearchParams({ id: res.data.id });
  }, [embedded, setSearchParams]);

  useEffect(() => {
    void listWeeklyPosterTemplates().then((res) => {
      if (res.success && res.data?.items?.length) setTemplates(res.data.items);
    });
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (embedded) return undefined;
    setFullBleedMain(true);
    return () => setFullBleedMain(false);
  }, [embedded, setFullBleedMain]);

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

  useEffect(() => {
    setBatchConfig((prev) => ({
      ...prev,
      pageCount: clampPageCount(pages.length || selectedTemplate.defaultPages),
      templateKey: poster?.templateKey ?? prev.templateKey,
      sourceType: coerceSourceType(poster?.sourceType),
    }));
    if (poster) {
      setPublishNote((prev) => prev || `${poster.title} 发布确认，跳转 ${poster.ctaUrl || '/changelog'}`);
    }
  }, [pages.length, poster, selectedTemplate.defaultPages]);

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

  const handleAddPage = useCallback(() => {
    if (!poster) return;
    const nextOrder = pages.length;
    const nextPage = buildBlankPage(nextOrder, currentPage?.accentColor || selectedTemplate.accentPalette[0]);
    updateDraft((draft) => ({ ...draft, pages: [...(draft.pages ?? []), nextPage] }));
    setCurrentOrder(nextOrder);
    setActiveMenu('pages');
    toast.success('已添加新页面');
  }, [currentPage?.accentColor, pages.length, poster, selectedTemplate.accentPalette, updateDraft]);

  const focusAgent = useCallback(() => {
    setActiveMenu('agent');
    setWorkspaceTab('agent');
    window.requestAnimationFrame(() => agentInputRef.current?.focus());
  }, []);

  const openCreateModal = useCallback((preset?: CreatePosterInitialConfig) => {
    setCreateConfig(preset);
    setCreateOpen(true);
  }, []);

  const handleMenuSelect = (key: WorkspaceMenuKey) => {
    setActiveMenu(key);
    if (key === 'template') setWorkspaceTab('layout');
    if (key === 'assets') setWorkspaceTab('assets');
    if (key === 'agent') focusAgent();
    if (key === 'project' || key === 'pages' || key === 'publish') setWorkspaceTab('content');
  };

  const handleOpenBatchGenerator = () => {
    openCreateModal({
      templateKey: batchConfig.templateKey,
      sourceType: batchConfig.sourceType,
      pageCount: batchConfig.pageCount,
      ctaUrl: poster?.ctaUrl,
    });
  };

  const handleResetBatchConfig = () => {
    setBatchConfig({
      pageCount: clampPageCount(pages.length || selectedTemplate.defaultPages),
      templateKey: poster?.templateKey ?? selectedTemplate.key,
      sourceType: coerceSourceType(poster?.sourceType),
      orientation: 'landscape',
      unifyTheme: true,
      autoCopy: true,
      smartImage: true,
    });
  };

  const handleAgentSubmit = () => {
    const text = agentInput.trim();
    if (!text || !currentPage) return;

    if (agentTarget === 'prompt') {
      updateCurrentPage({ imagePrompt: mergeInstruction(currentPage.imagePrompt, text) });
      toast.success('已写入当前页配图提示词');
      setAgentLogs((prev) => [
        ...prev.slice(-5),
        { id: Date.now(), role: 'user', text },
        { id: Date.now() + 1, role: 'system', text: '已同步到当前页配图提示词，可继续点击 AI 生图。' },
      ]);
    } else {
      const nextBody = currentPage.body?.trim()
        ? `${currentPage.body.trim()}\n\n- ${text}`
        : `- ${text}`;
      updateCurrentPage({ body: nextBody });
      toast.success('已追加到当前页正文草稿');
      setAgentLogs((prev) => [
        ...prev.slice(-5),
        { id: Date.now(), role: 'user', text },
        { id: Date.now() + 1, role: 'system', text: '已追加到当前页正文草稿，右侧内容助手可继续微调。' },
      ]);
    }

    setAgentInput('');
  };

  const agentStatuses = useMemo(() => {
    const completedImages = pages.filter((page) => !!page.imageUrl).length;
    return [
      {
        label: '理解需求',
        detail: selectedSourceType ? `数据源：${selectedSourceType.label}` : '等待选择数据源',
        status: poster ? 'done' : 'waiting',
      },
      {
        label: '优化文案',
        detail: currentPage?.body ? '当前页正文已生成，可继续润色' : '当前页正文仍为空',
        status: currentPage?.body ? 'done' : 'waiting',
      },
      {
        label: '推荐版式',
        detail: `模板：${selectedTemplate.label}`,
        status: poster ? 'done' : 'waiting',
      },
      {
        label: '批量生成',
        detail: `${completedImages}/${pages.length || batchConfig.pageCount} 页已有主图`,
        status:
          completedImages > 0 && completedImages < Math.max(pages.length, 1)
            ? 'working'
            : completedImages === pages.length && pages.length > 0
              ? 'done'
              : 'waiting',
      },
      {
        label: '统一风格输出',
        detail: currentPage?.accentColor ? `主色：${normalizeColor(currentPage.accentColor)}` : '等待设置主题色',
        status: currentPage?.accentColor ? 'done' : 'waiting',
      },
      {
        label: '智能校验',
        detail: poster?.ctaUrl ? `CTA 已绑定 ${poster.ctaUrl}` : '等待绑定地址',
        status: poster?.ctaUrl ? 'done' : 'waiting',
      },
    ] satisfies Array<{ label: string; detail: string; status: AgentStatus }>;
  }, [batchConfig.pageCount, currentPage?.accentColor, currentPage?.body, pages, poster, selectedSourceType, selectedTemplate.label]);

  const workflowStates = useMemo(() => {
    const hasPoster = !!poster;
    const hasPages = pages.length > 0;
    const hasPreview = pages.some((page) => !!page.imageUrl || !!page.body);
    return FLOW_STEPS.map((label, index) => {
      const done =
        index === 0 ? hasPoster :
        index === 1 ? hasPages :
        index === 2 ? hasPreview :
        poster?.status === 'published';
      return { label, done };
    });
  }, [pages, poster]);

  const rootClass = embedded
    ? 'min-h-[780px] h-[calc(100vh-220px)]'
    : 'h-full min-h-0';

  return (
    <div
      className={`${rootClass} relative overflow-hidden ${embedded ? 'rounded-2xl' : ''}`}
      style={{
        background:
          'radial-gradient(circle at 14% 0%, rgba(65,150,255,0.18), transparent 28%), radial-gradient(circle at 82% 0%, rgba(145,71,255,0.18), transparent 26%), linear-gradient(180deg, #07101f 0%, #050811 58%, #06070d 100%)',
        border: embedded ? '1px solid rgba(255,255,255,0.08)' : undefined,
      }}
    >
      <style>{`
        @keyframes posterDesignerIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-x-0 top-0 h-24"
          style={{ background: 'linear-gradient(180deg, rgba(71,130,255,0.12), transparent)' }}
        />
        <div
          className="absolute inset-y-0 left-[84px] w-px"
          style={{ background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.08), transparent)' }}
        />
      </div>

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

      <div className="relative flex h-full min-h-0 flex-col">
        <header
          className="shrink-0 border-b px-4 py-3 xl:px-5"
          style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(6,12,24,0.72)' }}
        >
          <div className="flex flex-wrap items-center gap-3 xl:gap-4">
            <div className="min-w-0 xl:min-w-[220px]">
              <div className="text-[28px] leading-none font-black tracking-tight" style={{ color: '#4ecbff' }}>
                海报设计工作台
              </div>
              <div className="mt-1 text-[12px] text-white/45">AI 协作驱动的海报设计与批量生成平台</div>
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <div
                className="relative flex min-w-[240px] flex-1 items-center gap-3 rounded-xl px-3 py-2"
                style={glassCardStyle}
              >
                <div className="text-[11px] font-semibold tracking-[0.14em] uppercase text-white/38">项目</div>
                <select
                  value={poster?.id ?? ''}
                  onChange={(e) => {
                    if (e.target.value) void selectPoster(e.target.value);
                  }}
                  className="min-w-0 flex-1 bg-transparent pr-6 text-[13px] font-medium text-white outline-none"
                >
                  {!poster && <option value="" style={{ background: '#0b1120' }}>选择海报项目</option>}
                  {posters.map((item) => (
                    <option key={item.id} value={item.id} style={{ background: '#0b1120' }}>
                      {item.title || '未命名海报'}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-3 text-white/35" />
              </div>

              <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} />

              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                {workflowStates.map((step, index) => (
                  <div key={step.label} className="flex items-center gap-2 shrink-0">
                    <div
                      className="h-9 min-w-[90px] rounded-xl px-3 inline-flex items-center justify-center text-[12px] font-medium"
                      style={{
                        background: step.done ? 'rgba(91,196,123,0.16)' : 'rgba(255,255,255,0.05)',
                        border: step.done ? '1px solid rgba(91,196,123,0.35)' : '1px solid rgba(255,255,255,0.08)',
                        color: step.done ? '#9af3b1' : 'rgba(255,255,255,0.68)',
                      }}
                    >
                      {step.label}
                    </div>
                    {index < workflowStates.length - 1 && <ChevronRight size={14} className="text-white/28" />}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                disabled={!poster || pages.length === 0}
                className="h-9 rounded-xl px-4 inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  color: 'rgba(255,255,255,0.82)',
                  background: 'rgba(58,125,255,0.12)',
                  border: '1px solid rgba(78,161,255,0.28)',
                }}
              >
                <Eye size={14} /> 预览
              </button>
              <button
                type="button"
                onClick={handlePublish}
                disabled={!poster || publishing || pages.length === 0}
                className="h-9 rounded-xl px-4 inline-flex items-center gap-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  color: '#fff',
                  background: 'linear-gradient(90deg, rgba(79,93,255,0.74), rgba(170,72,255,0.84))',
                  border: '1px solid rgba(171,113,255,0.36)',
                  boxShadow: '0 0 24px rgba(123,92,255,0.24)',
                }}
              >
                {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                发布
              </button>
              <button
                type="button"
                aria-label="通知"
                className="w-9 h-9 rounded-xl inline-flex items-center justify-center text-white/72 hover:bg-white/10"
                style={glassButtonStyle}
              >
                <Bell size={15} />
              </button>
              <div
                className="w-9 h-9 rounded-full overflow-hidden inline-flex items-center justify-center text-[12px] font-semibold text-white"
                style={{ ...glassButtonStyle, background: 'rgba(255,255,255,0.06)' }}
              >
                {userAvatarUrl ? (
                  <img src={userAvatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span>{(currentUser?.displayName || currentUser?.username || 'A').slice(0, 1)}</span>
                )}
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 min-h-0 p-3 xl:p-4">
          <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[84px_280px_minmax(0,1fr)_380px]">
            <aside
              className="min-h-0 rounded-2xl p-2 flex flex-col"
              style={glassCardStyle}
            >
              <div className="space-y-1">
                {WORKSPACE_MENU.map((item) => {
                  const active = item.key === activeMenu;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => handleMenuSelect(item.key)}
                      className="w-full rounded-xl px-2 py-3 flex flex-col items-center gap-2 text-[11px] font-medium transition-all"
                      style={{
                        background: active ? 'rgba(120,84,255,0.2)' : 'transparent',
                        border: active ? '1px solid rgba(138,118,255,0.34)' : '1px solid transparent',
                        color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                        boxShadow: active ? 'inset 0 0 0 1px rgba(109,196,255,0.12)' : 'none',
                      }}
                    >
                      <span>{item.icon}</span>
                      <span className="leading-tight">{item.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-auto rounded-2xl p-3" style={{ background: 'rgba(96,66,255,0.1)', border: '1px solid rgba(126,106,255,0.26)' }}>
                <div className="flex items-center gap-2 text-[12px] font-semibold text-white">
                  <Bot size={15} />
                  AI 智能生成
                </div>
                <div className="mt-1 text-[10.5px] text-white/48">海报方案建议与协作指令</div>
                <button
                  type="button"
                  onClick={focusAgent}
                  className="mt-3 w-full h-9 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-white"
                  style={{
                    background: 'linear-gradient(90deg, rgba(96,66,255,0.88), rgba(89,186,255,0.72))',
                    border: '1px solid rgba(145,137,255,0.3)',
                  }}
                >
                  <Sparkles size={14} />
                  开始对话
                </button>
              </div>
            </aside>

            <section className="min-h-0 rounded-2xl p-4 flex flex-col" style={glassCardStyle}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold text-white/74">页面列表</div>
                  <div className="mt-1 text-[11px] text-white/42">
                    {poster ? `${poster.title || '未命名项目'} · ${pages.length} 页` : '先选择一个项目'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshList(poster?.id)}
                  aria-label="刷新列表"
                  className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-white/60 hover:bg-white/10"
                >
                  <RefreshCw size={14} className={loadingList ? 'animate-spin' : ''} />
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleOpenBatchGenerator}
                  className="h-9 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-white"
                  style={{
                    background: 'linear-gradient(90deg, rgba(83,104,255,0.78), rgba(82,202,255,0.54))',
                    border: '1px solid rgba(117,160,255,0.28)',
                  }}
                >
                  <Sparkles size={14} />
                  批量生成
                </button>
                <button
                  type="button"
                  onClick={handleAddPage}
                  disabled={!poster}
                  className="h-9 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                  style={glassButtonStyle}
                >
                  <Plus size={14} />
                  新增单页
                </button>
              </div>

              <div className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1">
                {loadingPoster && !poster ? (
                  <div className="h-40 flex items-center justify-center text-[12px] text-white/45">
                    <MapSpinner size={14} />
                    <span className="ml-2">加载项目中</span>
                  </div>
                ) : poster && pages.length > 0 ? (
                  <div className="space-y-2">
                    {pages.map((page) => (
                      <PageListItem
                        key={page.order}
                        page={page}
                        active={page.order === currentOrder}
                        progress={imageProgress[page.order]}
                        dimensionLabel={dimensionLabel(batchConfig.orientation)}
                        onClick={() => setCurrentOrder(page.order)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="h-full min-h-[320px] flex items-center justify-center text-center text-[12px] text-white/42">
                    <div>
                      <Sparkles size={28} className="mx-auto mb-3 text-white/30" />
                      选择海报项目后，这里会展示页面缩略图和状态
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleAddPage}
                disabled={!poster}
                className="mt-3 h-10 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                style={glassButtonStyle}
              >
                <Plus size={14} />
                添加页面
              </button>
            </section>

            <div className="min-h-0 flex flex-col gap-3">
              {poster && currentPage ? (
                <section className="min-h-0 flex-1 rounded-2xl p-4 flex flex-col" style={{ ...glassCardStyle, animation: 'posterDesignerIn 180ms ease-out both' }}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[12px] font-semibold text-white/78">
                        当前页：{String(currentPage.order + 1).padStart(2, '0')} · {currentPage.title || '未命名页面'}
                      </div>
                      <div className="mt-1 text-[11px] text-white/42">
                        大画布预览 · {dimensionLabel(batchConfig.orientation)} · {selectedTemplate.label}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex rounded-xl p-1" style={glassButtonStyle}>
                        <button
                          type="button"
                          onClick={() => setDevicePreview('desktop')}
                          className="w-9 h-8 rounded-lg inline-flex items-center justify-center"
                          style={{
                            background: devicePreview === 'desktop' ? 'rgba(86,119,255,0.22)' : 'transparent',
                            color: devicePreview === 'desktop' ? '#fff' : 'rgba(255,255,255,0.52)',
                          }}
                        >
                          <Monitor size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDevicePreview('mobile')}
                          className="w-9 h-8 rounded-lg inline-flex items-center justify-center"
                          style={{
                            background: devicePreview === 'mobile' ? 'rgba(86,119,255,0.22)' : 'transparent',
                            color: devicePreview === 'mobile' ? '#fff' : 'rgba(255,255,255,0.52)',
                          }}
                        >
                          <Smartphone size={14} />
                        </button>
                      </div>

                      <div className="flex items-center rounded-xl px-2 py-1.5 gap-2" style={glassButtonStyle}>
                        <button
                          type="button"
                          onClick={() => setPreviewScale((prev) => clamp(prev - 6, 52, 100))}
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center text-white/72 hover:bg-white/10"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="w-12 text-center text-[12px] font-medium text-white/82">{previewScale}%</span>
                        <button
                          type="button"
                          onClick={() => setPreviewScale((prev) => clamp(prev + 6, 52, 100))}
                          className="w-7 h-7 rounded-lg inline-flex items-center justify-center text-white/72 hover:bg-white/10"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex-1 min-h-0 rounded-[24px] p-4 flex flex-col" style={{ background: 'rgba(3,8,18,0.72)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex-1 min-h-0 overflow-auto">
                      <div className="flex h-full min-h-[420px] items-center justify-center">
                        <WorkspacePosterStage
                          poster={poster}
                          page={currentPage}
                          template={selectedTemplate}
                          devicePreview={devicePreview}
                          scale={previewScale}
                          orientation={batchConfig.orientation}
                          progress={imageProgress[currentPage.order]}
                        />
                      </div>
                    </div>

                    <div className="mt-4 border-t pt-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                      <div className="flex gap-2 overflow-x-auto">
                        {pages.map((page) => (
                          <button
                            key={page.order}
                            type="button"
                            onClick={() => setCurrentOrder(page.order)}
                            className="shrink-0 rounded-xl p-2 text-left transition-all"
                            style={{
                              width: 132,
                              background: page.order === currentOrder ? 'rgba(88,113,255,0.14)' : 'rgba(255,255,255,0.04)',
                              border: page.order === currentOrder ? '1px solid rgba(117,153,255,0.28)' : '1px solid rgba(255,255,255,0.08)',
                            }}
                          >
                            <div
                              className="relative rounded-lg overflow-hidden"
                              style={{
                                aspectRatio: batchConfig.orientation === 'portrait' ? '4 / 5' : '16 / 9',
                                background: page.imageUrl ? '#09111e' : `linear-gradient(135deg, ${page.accentColor || DEFAULT_ACCENT}, #070b14)`,
                              }}
                            >
                              {page.imageUrl && renderMedia(page.imageUrl, 'absolute inset-0 w-full h-full object-cover')}
                            </div>
                            <div className="mt-2 text-[11px] font-medium text-white/86 truncate">
                              {String(page.order + 1).padStart(2, '0')} {page.title || '未命名页面'}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="min-h-0 flex-1 rounded-2xl p-4" style={glassCardStyle}>
                  <EmptyDesignerState
                    loading={loadingPoster}
                    onCreate={() => openCreateModal({
                      templateKey: batchConfig.templateKey,
                      sourceType: batchConfig.sourceType,
                      pageCount: batchConfig.pageCount,
                      ctaUrl: poster?.ctaUrl,
                    })}
                  />
                </section>
              )}

              <div className="grid gap-3 xl:grid-cols-3">
                <section className="rounded-2xl p-4" style={glassCardStyle}>
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-white">素材上传</div>
                    <Upload size={14} className="text-white/42" />
                  </div>
                  <div className="mt-1 text-[11px] text-white/42">主图、副图和截图粘贴都在当前页生效</div>
                  <div className="mt-4 space-y-2">
                    <MiniAssetRow
                      label="主图素材"
                      ready={!!currentPage?.imageUrl}
                      actionLabel="上传主图"
                      onAction={() => openFilePicker('primary')}
                    />
                    <MiniAssetRow
                      label="副图素材"
                      ready={!!currentPage?.secondaryImageUrl}
                      actionLabel="上传副图"
                      onAction={() => openFilePicker('secondary')}
                    />
                    <div className="rounded-xl p-3 text-[11px] text-white/54" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.12)' }}>
                      支持 JPG、PNG、WEBP、MP4；也可以直接 Ctrl+V 粘贴截图。
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl p-4" style={glassCardStyle}>
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-white">Agent 生成中 / 结果确认</div>
                    <Wand2 size={14} className="text-white/42" />
                  </div>
                  <div className="mt-1 text-[11px] text-white/42">
                    当前页状态：{currentPage ? pageProgressLabel(imageProgress[currentPage.order] ?? pageQualityState(currentPage)) : '待开始'}
                  </div>
                  <div className="mt-4 space-y-2">
                    {agentStatuses.slice(0, 4).map((item) => (
                      <AgentStatusRow key={item.label} label={item.label} detail={item.detail} status={item.status} />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void regenerateImage()}
                    disabled={!poster || !currentPage}
                    className="mt-4 w-full h-9 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                    style={glassButtonStyle}
                  >
                    <Sparkles size={14} />
                    AI 重新生成当前页
                  </button>
                </section>

                <section className="rounded-2xl p-4" style={glassCardStyle}>
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-white">发布确认</div>
                    <Send size={14} className="text-white/42" />
                  </div>
                  <div className="mt-1 text-[11px] text-white/42">发布后同步更新主页海报弹窗</div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      ['wechat', '微信公众号'],
                      ['miniProgram', '小程序'],
                      ['douyin', '抖音号'],
                      ['store', '官网'],
                      ['other', '其他'],
                    ].map(([key, label]) => (
                      <CheckboxChip
                        key={key}
                        label={label}
                        checked={publishChannels[key as keyof PublishChannels]}
                        onToggle={() => setPublishChannels((prev) => ({ ...prev, [key]: !prev[key as keyof PublishChannels] }))}
                      />
                    ))}
                  </div>
                  <div className="mt-4 rounded-xl p-3 text-[11px] text-white/58" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    跳转地址：{poster?.ctaUrl || '/changelog'}
                  </div>
                  <textarea
                    value={publishNote}
                    onChange={(e) => setPublishNote(e.target.value)}
                    rows={3}
                    className="mt-3 w-full rounded-xl px-3 py-2 text-[12px] outline-none resize-none"
                    style={fieldStyle}
                    placeholder="发布备注"
                  />
                  <button
                    type="button"
                    onClick={handlePublish}
                    disabled={!poster || publishing}
                    className="mt-3 w-full h-9 rounded-xl inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
                    style={{
                      background: 'linear-gradient(90deg, rgba(90,108,255,0.8), rgba(179,82,255,0.8))',
                      border: '1px solid rgba(160,119,255,0.34)',
                    }}
                  >
                    {publishing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    确认发布
                  </button>
                </section>
              </div>
            </div>

            <aside className="min-h-0 flex flex-col gap-3">
              <section className="rounded-2xl p-4" style={glassCardStyle}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-white">批量生成设置</div>
                    <div className="mt-1 text-[11px] text-white/42">基于当前模板快速拉起一轮新海报生成</div>
                  </div>
                  <div className="w-7 h-7 rounded-full inline-flex items-center justify-center text-[11px] font-semibold text-white" style={{ background: 'rgba(96,84,255,0.28)', border: '1px solid rgba(126,112,255,0.38)' }}>
                    1
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex items-center justify-between text-[12px] text-white/70">
                    <span>生成页数</span>
                    <span className="inline-flex items-center justify-center min-w-[40px] h-8 rounded-lg px-2 font-semibold text-white" style={glassButtonStyle}>
                      {batchConfig.pageCount}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={12}
                    step={1}
                    value={batchConfig.pageCount}
                    onChange={(e) => setBatchConfig((prev) => ({ ...prev, pageCount: clampPageCount(Number(e.target.value)) }))}
                    className="mt-3 w-full accent-indigo-400"
                  />
                </div>

                <div className="mt-4">
                  <div className="text-[12px] text-white/70">选择风格</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {templates.slice(0, 4).map((template) => {
                      const active = template.key === batchConfig.templateKey;
                      return (
                        <button
                          key={template.key}
                          type="button"
                          onClick={() => setBatchConfig((prev) => ({ ...prev, templateKey: template.key }))}
                          className="rounded-xl p-2.5 text-left"
                          style={{
                            background: active ? 'rgba(88,108,255,0.16)' : 'rgba(255,255,255,0.03)',
                            border: active ? '1px solid rgba(116,149,255,0.28)' : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div className="text-[12px] font-medium text-white">{template.emoji} {template.label}</div>
                          <div className="mt-1 text-[10px] text-white/42 truncate">{template.description}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="text-[12px] text-white/70">画布方向</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {([
                      ['landscape', '横版'],
                      ['portrait', '竖版'],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setBatchConfig((prev) => ({ ...prev, orientation: value }))}
                        className="h-9 rounded-xl text-[12px] font-medium"
                        style={{
                          background: batchConfig.orientation === value ? 'rgba(88,108,255,0.16)' : 'rgba(255,255,255,0.03)',
                          border: batchConfig.orientation === value ? '1px solid rgba(116,149,255,0.28)' : '1px solid rgba(255,255,255,0.08)',
                          color: batchConfig.orientation === value ? '#fff' : 'rgba(255,255,255,0.62)',
                        }}
                      >
                        {label} ({value === 'landscape' ? '1200 × 628' : '1080 × 1350'})
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <ToggleRow
                    label="统一主题与配色"
                    checked={batchConfig.unifyTheme}
                    onToggle={() => setBatchConfig((prev) => ({ ...prev, unifyTheme: !prev.unifyTheme }))}
                  />
                  <ToggleRow
                    label="自动生成文案"
                    checked={batchConfig.autoCopy}
                    onToggle={() => setBatchConfig((prev) => ({ ...prev, autoCopy: !prev.autoCopy }))}
                  />
                  <ToggleRow
                    label="智能配图"
                    checked={batchConfig.smartImage}
                    onToggle={() => setBatchConfig((prev) => ({ ...prev, smartImage: !prev.smartImage }))}
                  />
                </div>

                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetBatchConfig}
                    className="flex-1 h-9 rounded-xl text-[12px] font-medium text-white/72"
                    style={glassButtonStyle}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenBatchGenerator}
                    className="flex-1 h-9 rounded-xl text-[12px] font-semibold text-white"
                    style={{
                      background: 'linear-gradient(90deg, rgba(90,108,255,0.82), rgba(179,82,255,0.82))',
                      border: '1px solid rgba(160,119,255,0.34)',
                    }}
                  >
                    确定生成
                  </button>
                </div>
              </section>

              <section className="min-h-0 flex-1 rounded-2xl p-4 flex flex-col" style={glassCardStyle}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-semibold text-white">协作面板</div>
                    <div className="mt-1 text-[11px] text-white/42">内容、素材、版式和 Agent 协作都收敛在这里</div>
                  </div>
                  <div className="w-7 h-7 rounded-full inline-flex items-center justify-center text-[11px] font-semibold text-white" style={{ background: 'rgba(56,139,255,0.22)', border: '1px solid rgba(105,159,255,0.26)' }}>
                    2
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-1 rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {([
                    ['content', '内容助手', <MessageSquare size={13} />],
                    ['assets', '素材上传', <ImagePlus size={13} />],
                    ['layout', '版式设置', <SlidersHorizontal size={13} />],
                    ['agent', 'AI Agent 协作', <Bot size={13} />],
                  ] as const).map(([value, label, icon]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setWorkspaceTab(value)}
                      className="h-10 rounded-lg inline-flex items-center justify-center gap-1 text-[11px] font-medium"
                      style={{
                        background: workspaceTab === value ? 'rgba(94,118,255,0.18)' : 'transparent',
                        color: workspaceTab === value ? '#fff' : 'rgba(255,255,255,0.55)',
                      }}
                    >
                      {icon}
                      <span className="hidden 2xl:inline">{label}</span>
                    </button>
                  ))}
                </div>

                {poster && currentPage ? (
                  <>
                    {workspaceTab === 'content' && (
                      <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="海报标题">
                            <input
                              value={poster.title ?? ''}
                              onChange={(e) => updatePosterFields({ title: e.target.value })}
                              className="w-full h-10 rounded-xl px-3 text-[13px] outline-none"
                              style={fieldStyle}
                            />
                          </Field>
                          <Field label="副标题">
                            <input
                              value={poster.subtitle ?? ''}
                              onChange={(e) => updatePosterFields({ subtitle: e.target.value })}
                              className="w-full h-10 rounded-xl px-3 text-[13px] outline-none"
                              style={fieldStyle}
                            />
                          </Field>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <Field label="CTA 文案">
                            <input
                              value={poster.ctaText ?? ''}
                              onChange={(e) => updatePosterFields({ ctaText: e.target.value })}
                              className="w-full h-10 rounded-xl px-3 text-[13px] outline-none"
                              style={fieldStyle}
                            />
                          </Field>
                          <Field label="绑定地址">
                            <div className="relative">
                              <LinkIcon size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35" />
                              <input
                                value={poster.ctaUrl ?? ''}
                                onChange={(e) => updatePosterFields({ ctaUrl: e.target.value })}
                                className="w-full h-10 rounded-xl pl-8 pr-3 text-[13px] outline-none"
                                style={fieldStyle}
                              />
                            </div>
                          </Field>
                        </div>

                        <Field label="当前页标题">
                          <input
                            value={currentPage.title ?? ''}
                            onChange={(e) => updateCurrentPage({ title: e.target.value })}
                            className="w-full h-10 rounded-xl px-3 text-[13px] outline-none"
                            style={fieldStyle}
                          />
                        </Field>

                        <Field label="正文编辑">
                          <textarea
                            value={currentPage.body ?? ''}
                            onChange={(e) => updateCurrentPage({ body: e.target.value })}
                            rows={10}
                            className="w-full rounded-xl px-3 py-3 text-[13px] outline-none resize-y"
                            style={{ ...fieldStyle, lineHeight: 1.65 }}
                          />
                        </Field>

                        <Field label="Markdown 预览">
                          <div className="rounded-xl p-3 min-h-[180px]" style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            <MarkdownContent content={currentPage.body || ' '} className="text-[13px] leading-relaxed" />
                          </div>
                        </Field>
                      </div>
                    )}

                    {workspaceTab === 'assets' && (
                      <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
                        <MediaSlotPanel
                          label="主视觉"
                          url={currentPage.imageUrl}
                          accent={currentPage.accentColor}
                          progress={imageProgress[currentPage.order]}
                          onUpload={() => openFilePicker('primary')}
                          onGenerate={() => void regenerateImage()}
                          onClear={() => updateCurrentPage({ imageUrl: null })}
                        />
                        <MediaSlotPanel
                          label="副图 / 素材补充"
                          hint="可选，用于双图版式或商品展示区域"
                          url={currentPage.secondaryImageUrl}
                          accent={currentPage.accentColor}
                          onUpload={() => openFilePicker('secondary')}
                          onClear={() => updateCurrentPage({ secondaryImageUrl: null })}
                        />
                        <Field label="配图提示词">
                          <textarea
                            value={currentPage.imagePrompt ?? ''}
                            onChange={(e) => updateCurrentPage({ imagePrompt: e.target.value })}
                            rows={5}
                            className="w-full rounded-xl px-3 py-2 text-[12px] outline-none resize-none"
                            style={fieldStyle}
                          />
                        </Field>
                      </div>
                    )}

                    {workspaceTab === 'layout' && (
                      <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
                        <div className="grid grid-cols-[1fr_auto] gap-3">
                          <Field label="主题色">
                            <input
                              value={currentPage.accentColor ?? DEFAULT_ACCENT}
                              onChange={(e) => updateCurrentPage({ accentColor: e.target.value })}
                              className="w-full h-10 rounded-xl px-3 text-[13px] outline-none font-mono"
                              style={fieldStyle}
                            />
                          </Field>
                          <label className="block">
                            <span className="block text-[11px] font-medium text-white/50 mb-1.5">色板</span>
                            <input
                              type="color"
                              value={normalizeColor(currentPage.accentColor)}
                              onChange={(e) => updateCurrentPage({ accentColor: e.target.value })}
                              className="h-10 w-16 rounded-xl cursor-pointer"
                              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)' }}
                            />
                          </label>
                        </div>

                        <div className="rounded-2xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <div className="flex items-center justify-between">
                            <div className="text-[12px] font-medium text-white/78">模板与版式</div>
                            <Palette size={14} className="text-white/40" />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {selectedTemplate.accentPalette.map((color) => (
                              <button
                                key={color}
                                type="button"
                                onClick={() => updateCurrentPage({ accentColor: color })}
                                className="w-9 h-9 rounded-full"
                                style={{
                                  background: color,
                                  border: normalizeColor(currentPage.accentColor) === color ? '2px solid #fff' : '2px solid rgba(255,255,255,0.16)',
                                  boxShadow: `0 0 18px ${color}40`,
                                }}
                              />
                            ))}
                          </div>
                          <div className="mt-3 text-[11px] text-white/44">
                            当前模板：{selectedTemplate.label} · 数据源：{selectedSourceType?.label || '未设置'}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <MetricTile label="页面尺寸" value={dimensionLabel(batchConfig.orientation)} />
                          <MetricTile label="展示模式" value={devicePreview === 'desktop' ? '桌面预览' : '移动预览'} />
                          <MetricTile label="当前页码" value={`第 ${currentPage.order + 1} 页`} />
                          <MetricTile label="项目状态" value={statusLabel(poster.status)} />
                        </div>
                      </div>
                    )}

                    {workspaceTab === 'agent' && (
                      <div className="mt-4 flex-1 min-h-0 flex flex-col">
                        <div className="space-y-2">
                          {agentStatuses.map((item) => (
                            <AgentStatusRow key={item.label} label={item.label} detail={item.detail} status={item.status} />
                          ))}
                        </div>

                        <div className="mt-4 flex-1 min-h-0 rounded-2xl p-3 flex flex-col" style={{ background: 'rgba(4,10,20,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-white/34">协作记录</div>
                          <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                            {agentLogs.length > 0 ? (
                              agentLogs.map((log) => (
                                <div
                                  key={log.id}
                                  className="rounded-xl px-3 py-2 text-[12px]"
                                  style={{
                                    background: log.role === 'user' ? 'rgba(86,106,255,0.16)' : 'rgba(255,255,255,0.04)',
                                    border: log.role === 'user' ? '1px solid rgba(117,153,255,0.24)' : '1px solid rgba(255,255,255,0.08)',
                                    color: log.role === 'user' ? '#dfe7ff' : 'rgba(255,255,255,0.72)',
                                  }}
                                >
                                  {log.text}
                                </div>
                              ))
                            ) : (
                              <div className="h-full min-h-[120px] flex items-center justify-center text-center text-[12px] text-white/38">
                                Agent 指令会记录在这里，方便继续协作和回看。
                              </div>
                            )}
                          </div>

                          <div className="mt-3 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setAgentTarget('prompt')}
                              className="h-8 rounded-lg px-3 text-[11px] font-medium"
                              style={{
                                background: agentTarget === 'prompt' ? 'rgba(90,109,255,0.16)' : 'rgba(255,255,255,0.04)',
                                border: agentTarget === 'prompt' ? '1px solid rgba(117,153,255,0.24)' : '1px solid rgba(255,255,255,0.08)',
                                color: agentTarget === 'prompt' ? '#fff' : 'rgba(255,255,255,0.58)',
                              }}
                            >
                              写入配图提示词
                            </button>
                            <button
                              type="button"
                              onClick={() => setAgentTarget('body')}
                              className="h-8 rounded-lg px-3 text-[11px] font-medium"
                              style={{
                                background: agentTarget === 'body' ? 'rgba(90,109,255,0.16)' : 'rgba(255,255,255,0.04)',
                                border: agentTarget === 'body' ? '1px solid rgba(117,153,255,0.24)' : '1px solid rgba(255,255,255,0.08)',
                                color: agentTarget === 'body' ? '#fff' : 'rgba(255,255,255,0.58)',
                              }}
                            >
                              追加正文草稿
                            </button>
                          </div>

                          <div className="mt-2 flex items-end gap-2">
                            <textarea
                              ref={agentInputRef}
                              value={agentInput}
                              onChange={(e) => setAgentInput(e.target.value)}
                              rows={3}
                              className="flex-1 rounded-xl px-3 py-2 text-[12px] outline-none resize-none"
                              style={fieldStyle}
                              placeholder="例如：强调优惠力度、更突出主图主体、把卖点压缩成三行"
                            />
                            <button
                              type="button"
                              onClick={handleAgentSubmit}
                              disabled={!currentPage || !agentInput.trim()}
                              className="w-11 h-11 rounded-xl inline-flex items-center justify-center text-white disabled:opacity-40"
                              style={{
                                background: 'linear-gradient(90deg, rgba(90,109,255,0.8), rgba(179,82,255,0.8))',
                                border: '1px solid rgba(160,119,255,0.34)',
                              }}
                            >
                              <Send size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-4 flex-1 min-h-[240px] flex items-center justify-center text-[12px] text-white/38 text-center">
                    选择海报后，这里会展开内容、素材、版式和 Agent 协作面板
                  </div>
                )}
              </section>
            </aside>
          </div>
        </div>

        <footer
          className="shrink-0 border-t px-3 py-3 xl:px-4"
          style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(5,9,18,0.68)' }}
        >
          <div className="flex items-center gap-2 overflow-x-auto">
            {WORKFLOW_GUIDE.map((label, index) => (
              <div key={label} className="flex shrink-0 items-center gap-2">
                <div
                  className="rounded-xl px-3 py-2 text-[11px] font-medium text-white/78"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {label}
                </div>
                {index < WORKFLOW_GUIDE.length - 1 && <ChevronRight size={14} className="text-white/24" />}
              </div>
            ))}
          </div>
        </footer>
      </div>

      {createOpen && (
        <CreatePosterModal
          templates={templates}
          initialConfig={createConfig}
          onClose={() => {
            setCreateOpen(false);
            setCreateConfig(undefined);
          }}
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

function WorkspacePosterStage({
  poster,
  page,
  template,
  devicePreview,
  scale,
  orientation,
  progress,
}: {
  poster: WeeklyPoster;
  page: WeeklyPosterPage;
  template: WeeklyPosterTemplateMeta;
  devicePreview: DevicePreview;
  scale: number;
  orientation: CanvasOrientation;
  progress?: PageProgress;
}) {
  const accent = page.accentColor || template.accentPalette[0] || DEFAULT_ACCENT;
  const width = Math.round((devicePreview === 'mobile' ? 320 : 760) * (scale / 100));
  const ratio = devicePreview === 'mobile' || orientation === 'portrait' ? '4 / 5' : '16 / 9';
  const previewBody = page.body?.trim() || '当前页正文将在这里展示，你可以在右侧内容助手继续编辑。';

  return (
    <div style={{ width, maxWidth: '100%' }}>
      <div
        className="relative overflow-hidden rounded-[28px]"
        style={{
          aspectRatio: ratio,
          background: page.imageUrl ? '#06111e' : `linear-gradient(135deg, ${accent} 0%, #07101e 72%)`,
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 28px 70px rgba(0,0,0,0.36), 0 0 48px rgba(90,109,255,0.18)',
        }}
      >
        {page.imageUrl && renderMedia(page.imageUrl, 'absolute inset-0 w-full h-full object-cover')}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(120deg, rgba(4,8,18,0.74) 18%, rgba(4,8,18,0.24) 56%, rgba(4,8,18,0.68) 100%)' }} />
        <div className="absolute inset-x-0 top-0 h-32" style={{ background: 'linear-gradient(180deg, rgba(5,8,16,0.58), transparent)' }} />

        <div className="absolute left-5 top-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.72)' }}>
          <Sparkles size={10} />
          {poster.weekKey}
        </div>

        {page.secondaryImageUrl && (
          <div
            className="absolute overflow-hidden rounded-2xl"
            style={{
              right: '5%',
              top: devicePreview === 'mobile' ? '14%' : '16%',
              width: devicePreview === 'mobile' ? '38%' : '26%',
              aspectRatio: '4 / 5',
              border: '1px solid rgba(255,255,255,0.16)',
              boxShadow: '0 18px 42px rgba(0,0,0,0.28)',
              background: 'rgba(7,12,22,0.8)',
            }}
          >
            {renderMedia(page.secondaryImageUrl, 'absolute inset-0 w-full h-full object-cover')}
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 p-6 xl:p-8">
          <div className="flex items-end justify-between gap-5">
            <div className="max-w-[72%]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/48">{template.label}</div>
              <h2 className="mt-3 text-[28px] font-black leading-[1.08] tracking-tight text-white">
                {page.title || poster.title || '未命名页面'}
              </h2>
              {poster.subtitle && <div className="mt-2 text-[13px] text-white/76">{poster.subtitle}</div>}
              <div
                className="mt-4 max-w-[520px] rounded-2xl p-4"
                style={{ background: 'rgba(7,12,22,0.54)', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)' }}
              >
                <div style={{ maxHeight: 112, overflow: 'hidden' }}>
                  <MarkdownContent content={previewBody} className="text-[12px] leading-6 text-white/82" />
                </div>
              </div>
            </div>

            <div className="shrink-0 flex flex-col items-end gap-3">
              <div className="rounded-full px-3 py-1.5 text-[10px] font-semibold text-white/72" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
                {dimensionLabel(orientation)}
              </div>
              <button
                type="button"
                className="h-10 rounded-full px-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-white"
                style={{ background: 'linear-gradient(90deg, rgba(75,126,255,0.96), rgba(88,206,255,0.76))', boxShadow: '0 0 24px rgba(78,134,255,0.26)' }}
              >
                {poster.ctaText || '查看详情'}
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </div>

        {progress === 'generating-image' && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.34)' }}>
            <span className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] text-white" style={{ background: 'rgba(4,8,18,0.78)', border: '1px solid rgba(255,255,255,0.16)' }}>
              <MapSpinner size={14} />
              AI 生图中
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function PageListItem({
  page,
  active,
  progress,
  dimensionLabel,
  onClick,
}: {
  page: WeeklyPosterPage;
  active: boolean;
  progress?: PageProgress;
  dimensionLabel: string;
  onClick: () => void;
}) {
  const stateLabel = pageProgressLabel(progress ?? pageQualityState(page));
  const stateColor = pageProgressColor(progress ?? pageQualityState(page));

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl p-3 text-left transition-all"
      style={{
        background: active ? 'rgba(86,107,255,0.16)' : 'rgba(255,255,255,0.035)',
        border: active ? '1px solid rgba(117,153,255,0.28)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow: active ? '0 0 28px rgba(89,109,255,0.12)' : 'none',
      }}
    >
      <div className="flex gap-3">
        <div
          className="relative shrink-0 overflow-hidden rounded-xl"
          style={{
            width: 88,
            aspectRatio: '16 / 9',
            background: page.imageUrl ? '#08111f' : `linear-gradient(135deg, ${page.accentColor || DEFAULT_ACCENT}, #07101b)`,
          }}
        >
          {page.imageUrl && renderMedia(page.imageUrl, 'absolute inset-0 w-full h-full object-cover')}
          <div className="absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[9px] font-semibold text-white" style={{ background: 'rgba(0,0,0,0.58)' }}>
            {String(page.order + 1).padStart(2, '0')}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-white/88 truncate">{page.title || '未命名页面'}</div>
              <div className="mt-1 text-[10.5px] text-white/44">{dimensionLabel}</div>
            </div>
            <span
              className="rounded-full px-2 py-1 text-[10px] font-medium"
              style={{ background: `${stateColor}22`, border: `1px solid ${stateColor}55`, color: stateColor }}
            >
              {stateLabel}
            </span>
          </div>
          <div className="mt-2 text-[10.5px] text-white/45 line-clamp-2">
            {page.body || page.imagePrompt || '等待补充正文和视觉素材'}
          </div>
        </div>
      </div>
    </button>
  );
}

function MiniAssetRow({
  label,
  ready,
  actionLabel,
  onAction,
}: {
  label: string;
  ready: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl p-3 flex items-center justify-between gap-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-white/78">{label}</div>
        <div className="mt-1 text-[10.5px]" style={{ color: ready ? '#95f0ad' : 'rgba(255,255,255,0.44)' }}>
          {ready ? '已就绪' : '待上传'}
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="h-8 rounded-lg px-3 inline-flex items-center justify-center text-[11px] font-medium text-white"
        style={glassButtonStyle}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function AgentStatusRow({
  label,
  detail,
  status,
}: {
  label: string;
  detail: string;
  status: AgentStatus;
}) {
  return (
    <div className="rounded-xl p-3 flex items-center justify-between gap-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-white/80">{label}</div>
        <div className="mt-1 text-[10.5px] text-white/42 truncate">{detail}</div>
      </div>
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[10.5px] font-medium" style={{ color: agentStatusColor(status) }}>
        {status === 'working' ? <Loader2 size={12} className="animate-spin" /> : status === 'done' ? <Check size={12} /> : <span className="w-2 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.24)' }} />}
        {agentStatusLabel(status)}
      </span>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full rounded-xl px-3 py-2.5 flex items-center justify-between"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <span className="text-[12px] text-white/72">{label}</span>
      <span
        className="relative inline-flex h-6 w-11 rounded-full transition-all"
        style={{ background: checked ? 'linear-gradient(90deg, rgba(88,109,255,0.95), rgba(118,209,255,0.85))' : 'rgba(255,255,255,0.12)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
          style={{ left: checked ? 22 : 2 }}
        />
      </span>
    </button>
  );
}

function CheckboxChip({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="rounded-full px-3 py-1.5 text-[11px] font-medium"
      style={{
        background: checked ? 'rgba(84,122,255,0.18)' : 'rgba(255,255,255,0.04)',
        border: checked ? '1px solid rgba(116,149,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
        color: checked ? '#fff' : 'rgba(255,255,255,0.54)',
      }}
    >
      {label}
    </button>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="text-[10.5px] text-white/40">{label}</div>
      <div className="mt-2 text-[13px] font-semibold text-white/84">{value}</div>
    </div>
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
    <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div
        className="relative"
        style={{
          aspectRatio: '16 / 10',
          background: url ? '#0a0a12' : `linear-gradient(135deg, ${accent || DEFAULT_ACCENT}, rgba(10,10,18,0.95))`,
        }}
      >
        {url ? renderMedia(url, 'absolute inset-0 w-full h-full object-cover') : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white/42">
            <ImagePlus size={30} />
            <div className="text-[12px] mt-2">{label}未设置</div>
            {hint && <div className="text-[10px] mt-1 px-6 text-center">{hint}</div>}
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.42)' }}>
            <span className="inline-flex items-center gap-2 px-3 h-8 rounded-full text-[12px] text-white" style={{ background: 'rgba(0,0,0,0.58)', border: '1px solid rgba(255,255,255,0.16)' }}>
              <MapSpinner size={13} />
              生图中
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
              className="h-8 px-2.5 rounded-lg inline-flex items-center gap-1 text-[11px] text-white/76 disabled:opacity-50 hover:bg-white/10"
              style={{ border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <Sparkles size={12} /> AI
            </button>
          )}
          <button
            type="button"
            onClick={onUpload}
            className="h-8 px-2.5 rounded-lg inline-flex items-center gap-1 text-[11px] text-white/76 hover:bg-white/10"
            style={{ border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <Upload size={12} /> 上传
          </button>
          {url && (
            <button
              type="button"
              onClick={onClear}
              aria-label={`清空${label}`}
              className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-white/50 hover:bg-white/10"
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
  initialConfig,
  onClose,
  onCreated,
}: {
  templates: WeeklyPosterTemplateMeta[];
  initialConfig?: CreatePosterInitialConfig;
  onClose: () => void;
  onCreated: (poster: WeeklyPoster) => void;
}) {
  const [templateKey, setTemplateKey] = useState<WeeklyPosterTemplateKey>(initialConfig?.templateKey ?? 'release');
  const [sourceType, setSourceType] = useState<WeeklyPosterSourceType>(initialConfig?.sourceType ?? 'changelog-current-week');
  const [pageCount, setPageCount] = useState(clampPageCount(initialConfig?.pageCount ?? 8));
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
              ctaUrl: initialConfig?.ctaUrl || '/changelog',
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
        pageCount,
        ctaUrl: initialConfig?.ctaUrl,
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
        className="rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: 'min(1080px, 94vw)',
          height: 'min(84vh, 780px)',
          maxHeight: '84vh',
          background: 'linear-gradient(180deg, #14151b 0%, #0a0a12 100%)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 40px 80px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 h-14 px-5 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div>
            <div className="text-[14px] font-semibold text-white">批量生成海报</div>
            <div className="text-[11px] text-white/42">{busy ? phaseLabel || '生成中' : '根据当前设置创建新的海报项目'}</div>
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

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[400px_1fr]">
          <div className="min-h-0 overflow-y-auto p-5 space-y-5 border-r" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <ModalSection title="模板风格">
              <div className="grid grid-cols-2 gap-2">
                {templates.map((template) => (
                  <button
                    key={template.key}
                    type="button"
                    onClick={() => setTemplateKey(template.key)}
                    disabled={busy}
                    className="rounded-xl p-3 text-left disabled:opacity-50"
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

            <ModalSection title="批量页数">
              <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="flex items-center justify-between text-[12px] text-white/72">
                  <span>生成页数</span>
                  <span className="font-semibold text-white">{pageCount} 页</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={12}
                  step={1}
                  value={pageCount}
                  onChange={(e) => setPageCount(clampPageCount(Number(e.target.value)))}
                  className="mt-3 w-full accent-indigo-400"
                  disabled={busy}
                />
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
                    className="w-full rounded-xl px-3 py-2.5 text-left disabled:opacity-50"
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
                  className="mt-3 w-full rounded-xl px-3 py-2 text-[12px] outline-none resize-none"
                  placeholder="粘贴发布公告、活动说明或周报原文"
                  style={fieldStyle}
                />
              )}
              {sourceType === 'knowledge-base' && (
                <select
                  value={kbEntryId}
                  onChange={(e) => setKbEntryId(e.target.value)}
                  disabled={busy || kbLoading}
                  className="mt-3 w-full h-10 rounded-xl px-3 text-[12px] outline-none"
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
              className="w-full h-10 rounded-xl inline-flex items-center justify-center gap-2 text-[13px] font-medium text-white disabled:opacity-55"
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
  const accent = page.accentColor || DEFAULT_ACCENT;
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
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
      className="rounded-xl p-3 font-mono text-[11px] leading-relaxed"
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
          <div className="text-[16px] font-semibold text-white/82">还没有选中海报项目</div>
          <div className="mt-2 text-[12px] text-white/44">可以直接新建一个项目，或者从顶部项目下拉里切换已有海报。</div>
          <button
            type="button"
            onClick={onCreate}
            className="mt-4 h-10 px-4 rounded-xl inline-flex items-center gap-2 text-[13px] font-medium text-white hover:bg-white/15"
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
    <div
      className="h-9 px-3 rounded-xl inline-flex items-center gap-1.5 text-[11px]"
      style={{ color: content.color, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {content.icon}
      {content.text}
    </div>
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
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : DEFAULT_ACCENT;
}

function statusLabel(status: WeeklyPoster['status']) {
  if (status === 'published') return '已发布';
  if (status === 'archived') return '已归档';
  return '草稿';
}

function formatTime(value: Date) {
  return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function countDone(progress: Record<number, PageProgress>) {
  return Object.values(progress).filter((item) => item === 'done').length;
}

function buildBlankPage(order: number, accent?: string | null): WeeklyPosterPage {
  return {
    order,
    title: `第 ${order + 1} 页`,
    body: '补充这一页的核心信息。',
    imagePrompt: '',
    imageUrl: null,
    secondaryImageUrl: null,
    accentColor: accent || DEFAULT_ACCENT,
  };
}

function coerceSourceType(value?: string | null): WeeklyPosterSourceType {
  return SOURCE_TYPES.some((item) => item.key === value)
    ? value as WeeklyPosterSourceType
    : 'changelog-current-week';
}

function clampPageCount(value: number) {
  return clamp(Number.isFinite(value) ? value : 8, 4, 12);
}

function dimensionLabel(orientation: CanvasOrientation) {
  return orientation === 'portrait' ? '1080 × 1350' : '1200 × 628';
}

function mergeInstruction(base: string | null | undefined, next: string) {
  const left = (base ?? '').trim();
  if (!left) return next;
  return `${left}\n${next}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function agentStatusLabel(status: AgentStatus) {
  if (status === 'done') return '已完成';
  if (status === 'working') return '进行中';
  return '等待中';
}

function agentStatusColor(status: AgentStatus) {
  if (status === 'done') return '#89f0a5';
  if (status === 'working') return '#89b6ff';
  return 'rgba(255,255,255,0.42)';
}

function pageQualityState(page: WeeklyPosterPage): PageProgress {
  if (page.imageUrl) return 'done';
  if (page.body || page.imagePrompt) return 'pending';
  return 'pending';
}

function pageProgressLabel(progress: PageProgress) {
  if (progress === 'generating-image') return '生图中';
  if (progress === 'done') return '已完成';
  if (progress === 'failed') return '失败';
  return '待补充';
}

function pageProgressColor(progress: PageProgress) {
  if (progress === 'generating-image') return '#8ab4ff';
  if (progress === 'done') return '#8bf2a8';
  if (progress === 'failed') return '#fca5a5';
  return '#d6c46c';
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

const glassCardStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(10,16,30,0.84), rgba(6,10,18,0.78))',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 18px 42px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
};

const glassButtonStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
};
