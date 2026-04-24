import { glassBadge, glassFloatingButton, glassPanel } from '@/lib/glassStyles';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TipCard } from '@/components/daily-tips/TipCard';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { WatermarkSettingsPanel, type WatermarkSettingsPanelHandle } from '@/components/watermark/WatermarkSettingsPanel';
import { WorkflowProgressBar } from '@/components/ui/WorkflowProgressBar';
import { MarketplaceCard } from '@/components/marketplace';
import {
  CONFIG_TYPE_REGISTRY,
  getCategoryFilterOptions,
  mergeMarketplaceData,
  sortMarketplaceItems,
  filterMarketplaceItems,
  type MarketplaceItemBase,
} from '@/lib/marketplaceTypes';
import {
  createLiteraryAgentImageGenRun,
  generateArticleMarkers,
  getLiteraryAgentChatModels,
  planImageGen,
  streamLiteraryAgentImageGenRunWithRetry,
  updateArticleMarker,
  listLiteraryPrompts,
  createLiteraryPrompt,
  updateLiteraryPrompt,
  deleteLiteraryPrompt,
  getWatermarkByApp,
  getImageGenRun,
  listReferenceImageConfigs,
  createReferenceImageConfig,
  updateReferenceImageConfig,
  updateReferenceImageFile,
  deleteReferenceImageConfig,
  activateReferenceImageConfig,
  deactivateReferenceImageConfig,
  getLiteraryAgentModels,
  getLiteraryAgentImageGenResolvedModel,
  getLiteraryAgentChatResolvedModel,
  getUserPreferences,
  updateLiteraryAgentPreferences,
  optimizeLiteraryPrompt,
  getAdapterInfoByModelName,
  // 海鲜市场 API
  publishLiteraryPrompt,
  unpublishLiteraryPrompt,
  publishReferenceImageConfig,
  unpublishReferenceImageConfig,
} from '@/services';
import {
  getLiteraryAgentWorkspaceDetailReal as getVisualAgentWorkspaceDetail,
  updateLiteraryAgentWorkspaceReal as updateVisualAgentWorkspace,
  uploadLiteraryAgentWorkspaceAssetReal as uploadVisualAgentWorkspaceAsset,
} from '@/services/real/literaryAgentConfig';
import type { LiteraryAgentModelPool } from '@/services/contracts/literaryAgentConfig';
import { ImageSizePicker } from '@/components/ui/ImageSizePicker';
import { BatchSizePicker } from '@/components/ui/BatchSizePicker';
import { ASPECT_OPTIONS, type SizesByResolution } from '@/lib/imageAspectOptions';
import { Wand2, Download, Sparkles, FileText, Plus, Trash2, Edit2, Upload, Copy, DownloadCloud, MapPin, Image as ImageIcon, CheckCircle2, Pencil, Settings, Globe, User, TrendingUp, Clock, Search, GitFork, Send, Share2, ArrowLeft, Check } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { ReferenceImageConfig } from '@/services/contracts/literaryAgentConfig';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useNavigate } from 'react-router-dom';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import { extractMarkers, type ArticleMarker } from '@/lib/articleMarkerExtractor';
import { useDebounce } from '@/hooks/useDebounce';
import { createSubmission, checkSubmission } from '@/services/real/submissions';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import type { Model } from '@/types/admin';
import type { ImageGenPlanItem, CreateImageGenRunInput } from '@/services/contracts/imageGen';

// 3 个状态：0=upload, 1=editing, 2=markersGenerated
type WorkflowPhase = 0 | 1 | 2;

type MarkerRunStatus = 'idle' | 'parsing' | 'parsed' | 'running' | 'done' | 'error';

// Phase 1: 位置策略。后续阶段计划见 doc/plan.manual-image-marking-control.md
type PositionStrategy = 'auto' | 'per-h1' | 'per-h2' | 'user-anchor';

// 用户锚点占位符：匹配 [IMG] / [配图] / 【插图位置】（整行）
const USER_ANCHOR_LINE_REGEX = /^\s*(?:\[IMG\]|\[配图\]|【插图位置】)\s*$/;

function splitParagraphs(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of (content ?? '').split('\n')) {
    if (line.trim() === '') {
      if (current.length) { blocks.push(current.join('\n')); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

function joinParagraphs(blocks: string[]): string {
  return blocks.join('\n\n');
}

function isAnchorParagraph(text: string): boolean {
  return USER_ANCHOR_LINE_REGEX.test(text.trim());
}

function insertAnchorAt(content: string, insertAt: number): string {
  const blocks = splitParagraphs(content);
  const clamped = Math.max(0, Math.min(insertAt, blocks.length));
  blocks.splice(clamped, 0, '[IMG]');
  return joinParagraphs(blocks);
}

function removeParagraphAt(content: string, pIdx: number): string {
  const blocks = splitParagraphs(content);
  if (pIdx < 0 || pIdx >= blocks.length) return content;
  blocks.splice(pIdx, 1);
  return joinParagraphs(blocks);
}

const POSITION_STRATEGY_OPTIONS: Array<{ value: PositionStrategy; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '' },
  {
    value: 'per-h1',
    label: '每大标题一张',
    hint: '【位置策略】请先识别本文中所有标题里 level 最小的那一级（可能是 # 也可能是 ##，以本文实际用法为准），把它当作"大标题"。在每一个大标题之后紧邻插入 1 个 [插图] 标记，其余段落不要插入。',
  },
  {
    value: 'per-h2',
    label: '每小标题一张',
    hint: '【位置策略】请先识别本文中所有标题里 level 最小的那一级，定义为"大标题"；比它更深一层或更深的（level 更大）称为"小标题"。在每一个小标题之后紧邻插入 1 个 [插图] 标记，大标题和正文段落都不要插入。',
  },
  {
    value: 'user-anchor',
    label: '尊重用户锚点',
    hint: '【位置策略】用户已在文章中用 [IMG] / [配图] / 【插图位置】等占位符标记了期望插图的位置。请严格在这些占位符位置插入 [插图] 标记，不要在用户未标记的段落插入；若用户未标记任何占位符，再按你的判断选择 3 个最合适的场景段落插入。',
  },
];

type MarkerRunItem = {
  markerIndex: number;
  markerText: string; // 原始（从文章提取）文本
  draftText: string; // 用户可编辑（用于重新生成）
  planItem?: ImageGenPlanItem | null;
  status: MarkerRunStatus;
  runId?: string | null;
  base64?: string | null;
  url?: string | null;
  assetUrl?: string | null;
  errorMessage?: string | null;
};

const PRD_MD_STYLE = `
  .prd-md { font-size: 14px; line-height: 1.72; color: var(--text-secondary); white-space: normal; word-break: break-word; }
  .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 16px 0 10px; }
  .prd-md h1 { font-size: 20px; letter-spacing: 0.2px; }
  .prd-md h2 { font-size: 17px; }
  .prd-md h3 { font-size: 15px; }
  .prd-md p { margin: 10px 0; }
  .prd-md ul,.prd-md ol { margin: 10px 0; padding-left: 18px; }
  .prd-md li { margin: 6px 0; }
  .prd-md hr { border: 0; border-top: 1px solid var(--border-default); margin: 14px 0; }
  .prd-md blockquote { margin: 12px 0; padding: 8px 12px; border-left: 3px solid rgba(165,180,252,0.35); background: rgba(165,180,252,0.06); color: rgba(165,180,252,0.92); border-radius: 10px; }
  .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
  .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: var(--bg-input-hover); border: 1px solid var(--border-default); padding: 0 6px; border-radius: 8px; }
  .prd-md pre { background: var(--nested-block-bg); border: 1px solid var(--border-default); border-radius: 14px; padding: 12px; overflow: auto; }
  .prd-md pre code { background: transparent; border: 0; padding: 0; }
  .prd-md table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  .prd-md th,.prd-md td { border: 1px solid var(--border-default); padding: 7px 9px; vertical-align: top; }
  .prd-md th { color: var(--text-primary); background: var(--nested-block-bg); }
  .prd-md .prd-md-marker {
    background: rgba(245, 158, 11, 0.22);
    border: 1px solid rgba(245, 158, 11, 0.32);
    color: rgba(255,255,255,0.92);
    padding: 0 4px;
    border-radius: 6px;
  }
  @keyframes marker-insert-glow {
    0% { background: rgba(245, 158, 11, 0.55); box-shadow: 0 0 12px rgba(245, 158, 11, 0.4); transform: translateY(-2px); opacity: 0.7; }
    50% { background: rgba(245, 158, 11, 0.35); box-shadow: 0 0 6px rgba(245, 158, 11, 0.2); transform: translateY(0); opacity: 1; }
    100% { background: rgba(245, 158, 11, 0.22); box-shadow: none; transform: translateY(0); opacity: 1; }
  }
  .prd-md .prd-md-marker-new {
    background: rgba(245, 158, 11, 0.55);
    border: 1px solid rgba(245, 158, 11, 0.5);
    color: rgba(255,255,255,0.95);
    padding: 0 4px;
    border-radius: 6px;
    animation: marker-insert-glow 1.2s ease-out forwards;
  }

  /* 配图卡片入场发光边框 */
  @property --marker-glow-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }
  .marker-card-glow-entrance {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    z-index: 1;
    animation: marker-glow-sweep 2s ease-out forwards;
  }
  .marker-card-glow-entrance::before {
    content: "";
    position: absolute;
    inset: -2px;
    border-radius: inherit;
    padding: 2px;
    /* Fallback for browsers without conic-gradient */
    background: linear-gradient(135deg, transparent 0%, rgba(168, 85, 247, 0.7) 40%, rgba(99, 102, 241, 0.9) 60%, rgba(147, 197, 253, 0.7) 80%, transparent 100%);
    background: conic-gradient(
      from var(--marker-glow-angle),
      transparent 0%,
      transparent 55%,
      rgba(168, 85, 247, 0.7) 70%,
      rgba(99, 102, 241, 0.9) 80%,
      rgba(147, 197, 253, 0.7) 90%,
      transparent 100%
    );
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    animation: marker-glow-spin 2s ease-out forwards;
  }
  .marker-card-glow-entrance::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: inherit;
    /* Fallback for browsers without conic-gradient */
    background: linear-gradient(135deg, transparent 0%, rgba(168, 85, 247, 0.15) 40%, rgba(99, 102, 241, 0.25) 60%, rgba(147, 197, 253, 0.15) 80%, transparent 100%);
    background: conic-gradient(
      from var(--marker-glow-angle),
      transparent 0%,
      transparent 55%,
      rgba(168, 85, 247, 0.15) 70%,
      rgba(99, 102, 241, 0.25) 80%,
      rgba(147, 197, 253, 0.15) 90%,
      transparent 100%
    );
    filter: blur(8px);
    animation: marker-glow-spin 2s ease-out forwards;
    z-index: -1;
  }
  @keyframes marker-glow-spin {
    0%   { --marker-glow-angle: 0deg;   opacity: 1; }
    75%  { opacity: 1; }
    100% { --marker-glow-angle: 360deg; opacity: 0; }
  }
  @keyframes marker-glow-sweep {
    0%   { opacity: 1; }
    75%  { opacity: 1; }
    100% { opacity: 0; }
  }
  /* Safari < 17.2: @property 不支持 + mask-composite 可能失效。
     降级：隐藏伪元素，改用 box-shadow 做发光边框，纯 box-shadow 无需 mask */
  @supports not (syntax: '<angle>') {
    .marker-card-glow-entrance::before,
    .marker-card-glow-entrance::after {
      display: none !important;
    }
    .marker-card-glow-entrance {
      box-shadow:
        inset 0 0 0 1.5px rgba(99, 102, 241, 0.5),
        0 0 12px rgba(99, 102, 241, 0.3),
        0 0 28px rgba(168, 85, 247, 0.12);
    }
  }

  /* 配图卡片：prompt 文字底部浮层（默认半可见，hover 全可见） */
  .marker-card-prompt-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 24px 10px 8px;
    background: linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.35) 60%, transparent 100%);
    opacity: 0.6;
    transition: opacity 0.25s ease;
    pointer-events: none;
    cursor: pointer;
  }
  .marker-card-wrap:hover .marker-card-prompt-overlay {
    opacity: 1;
    pointer-events: auto;
  }
  .marker-card-prompt-text {
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255,255,255,0.92);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: break-all;
  }
  .marker-card-wrap:hover .marker-card-prompt-text {
    -webkit-line-clamp: 3;
  }

  /* 文章内图片显示尺寸控制 */
  .prd-md img[data-marker-idx] {
    max-width: var(--img-display-size, 50%) !important;
    transition: max-width 0.3s ease;
    display: block;
    margin-left: auto;
    margin-right: auto;
  }
`;

/**
 * 前端锚点匹配：在文章中找到锚点文本的位置（模仿后端 4 级模糊匹配）
 * 返回锚点所在行的末尾位置，失败返回 -1
 */
function findAnchorInsertPos(article: string, anchor: string): number {
  const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normalizeP = (s: string) =>
    s.replace(/，/g, ',').replace(/。/g, '.').replace(/！/g, '!').replace(/？/g, '?')
     .replace(/；/g, ';').replace(/：/g, ':').replace(/\u201c/g, '"').replace(/\u201d/g, '"')
     .replace(/\u2018/g, "'").replace(/\u2019/g, "'");

  // 1. 精确匹配
  let idx = article.indexOf(anchor);
  if (idx < 0) {
    // 2. 忽略大小写
    idx = article.toLowerCase().indexOf(anchor.toLowerCase());
  }
  if (idx < 0) {
    // 3. 归一化空白
    const na = normalizeWs(article);
    const nc = normalizeWs(anchor);
    const ni = na.indexOf(nc);
    if (ni >= 0) idx = Math.min(Math.round((ni / na.length) * article.length), article.length - 1);
  }
  if (idx < 0) {
    // 4. 归一化标点
    const na = normalizeP(normalizeWs(article));
    const nc = normalizeP(normalizeWs(anchor));
    const ni = na.indexOf(nc);
    if (ni >= 0) idx = Math.min(Math.round((ni / na.length) * article.length), article.length - 1);
  }
  if (idx < 0) return -1;
  // 找到行尾
  const lineEnd = article.indexOf('\n', idx);
  return lineEnd >= 0 ? lineEnd : article.length;
}

/**
 * 将一个新的 marker 增量插入到当前文章内容中。
 * 按锚点定位，在对应行后插入 [插图]: text。
 */
function insertMarkerIntoArticle(currentArticle: string, anchor: string, markerText: string): string {
  const pos = findAnchorInsertPos(currentArticle, anchor);
  if (pos < 0) {
    // 未匹配时追加到末尾
    return currentArticle + `\n\n[插图]: ${markerText}\n`;
  }
  return currentArticle.slice(0, pos) + `\n\n[插图]: ${markerText}\n` + currentArticle.slice(pos);
}

// 用户自定义提示词模板类型（对应后端 LiteraryPrompt）
type PromptTemplate = {
  id: string;
  title: string;
  content: string;
  isSystem?: boolean;
  scenarioType?: string | null;
  order?: number;
  // 海鲜市场字段
  isPublic?: boolean;
  forkCount?: number;
  forkedFromId?: string | null;
  forkedFromUserId?: string | null;
  forkedFromUserName?: string | null;
  forkedFromUserAvatar?: string | null;
  isModifiedAfterFork?: boolean;
};

// 将 PanelCard 移到组件外部定义，避免每次渲染时重新创建组件导致子组件卸载/重新挂载
const panelCardStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border-default)',
  boxShadow: 'var(--shadow-card)',
};

const PanelCard = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <GlassCard
    animated
    variant="subtle"
    padding="sm"
    className={cn('rounded-[16px]', className)}
    style={panelCardStyle}
  >
    {children}
  </GlassCard>
);

export default function ArticleIllustrationEditorPage({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const [mobileTab, setMobileTab] = useState<'article' | 'markers'>('article');
  const [articleContent, setArticleContent] = useState('');
  const [articleWithMarkers, setArticleWithMarkers] = useState('');
  const [articleWithImages, setArticleWithImages] = useState('');
  const [phase, setPhase] = useState<WorkflowPhase>(0); // 0=upload
  const [generating, setGenerating] = useState(false);
  const [autoSubmitEnabled, setAutoSubmitEnabled] = useState(true);
  const autoSubmitEnabledRef = useRef(true);
  useEffect(() => { autoSubmitEnabledRef.current = autoSubmitEnabled; }, [autoSubmitEnabled]);
  const [submissionState, setSubmissionState] = useState<{ submitted: boolean; submissionId?: string }>({ submitted: false });
  const submissionStateRef = useRef(submissionState);
  useEffect(() => { submissionStateRef.current = submissionState; }, [submissionState]);
  const hasGeneratedImagesRef = useRef(false); // synced from markerRunItems later
  const [markerStreaming, setMarkerStreaming] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewIndex, setImagePreviewIndex] = useState(0);
  const [watermarkStatus, setWatermarkStatus] = useState<{ enabled: boolean; name?: string | null }>({ enabled: false });
  const [pendingWatermarkEdit, setPendingWatermarkEdit] = useState(false); // 用于延迟触发水印编辑
  const handleWatermarkStatusChange = useCallback((status: { hasActiveConfig: boolean; activeId?: string; activeName?: string }) => {
    setWatermarkStatus({ enabled: status.hasActiveConfig, name: status.activeName ?? null });
  }, []);
  // 检查当前 workspace 是否已投稿
  useEffect(() => {
    checkSubmission({ workspaceId }).then((res) => {
      if (res.success) {
        setSubmissionState({ submitted: res.data.submitted, submissionId: (res.data as any).submissionId });
      }
    }).catch(() => {});
  }, [workspaceId]);

  // 自动投稿：任意图片生成成功后触发（通过 ref 读取最新值，避免闭包陈旧）
  const tryAutoSubmit = useCallback(() => {
    if (!autoSubmitEnabledRef.current || submissionStateRef.current.submitted) return;
    createSubmission({ contentType: 'literary', workspaceId })
      .then((res) => {
        if (res.success) {
          setSubmissionState({ submitted: true, submissionId: res.data.submission?.id });
          toast.success('已自动投稿到作品广场');
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  const [manualSubmitting, setManualSubmitting] = useState(false);

  // 手动投稿：将当前文学创作作为一个 Space 投稿到作品广场
  // 文学创作按 Workspace 粒度投稿（1 个 Space = 1 个卡片），不创建单图投稿
  const handleManualSubmit = useCallback(async () => {
    setManualSubmitting(true);
    try {
      if (submissionStateRef.current.submitted) {
        toast.info('该文章已投稿到作品广场');
        return;
      }

      // 检查是否至少有一张已完成的配图（通过 ref 读取，避免声明顺序问题）
      if (!hasGeneratedImagesRef.current) {
        toast.warning('请先生成至少一张配图后再投稿');
        return;
      }

      const litRes = await createSubmission({ contentType: 'literary', workspaceId });
      if (litRes.success) {
        setSubmissionState({ submitted: true, submissionId: litRes.data.submission?.id });
        toast.success('已投稿到作品广场');
      }
    } catch {
      toast.error('投稿失败，请重试');
    } finally {
      setManualSubmitting(false);
    }
  }, [workspaceId]);

  // 配置弹窗内的水印面板 ref（唯一实例，避免状态不同步）
  const watermarkPanelRef = useRef<WatermarkSettingsPanelHandle | null>(null);

  // 当配置弹窗打开且有待处理的水印编辑时，触发编辑
  useEffect(() => {
    if (promptPreviewOpen && pendingWatermarkEdit) {
      // 延迟以确保 WatermarkSettingsPanel 完全挂载并设置 ref
      const timer = setTimeout(() => {
        if (watermarkPanelRef.current) {
          watermarkPanelRef.current.editCurrentSpec();
        }
        setPendingWatermarkEdit(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [promptPreviewOpen, pendingWatermarkEdit]);

  // 风格图/参考图配置（新的多配置模型）
  const [referenceImageConfigs, setReferenceImageConfigs] = useState<ReferenceImageConfig[]>([]);
  const [referenceImageLoading, setReferenceImageLoading] = useState(false);
  const [referenceImageSaving, setReferenceImageSaving] = useState(false);
  const referenceImageInputRef = useRef<HTMLInputElement | null>(null);
  const editRefImageInputRef = useRef<HTMLInputElement | null>(null);
  const [editingRefConfig, setEditingRefConfig] = useState<ReferenceImageConfig | null>(null);
  const [editingRefConfigOpen, setEditingRefConfigOpen] = useState(false);
  const [enlargedRefImageUrl, setEnlargedRefImageUrl] = useState<string | null>(null);

  // 海鲜市场状态（使用类型注册表）
  const [configViewMode, setConfigViewMode] = useState<'mine' | 'marketplace'>('mine');
  const [marketplaceSearchKeyword, setMarketplaceSearchKeyword] = useState('');
  const [marketplaceSortBy, setMarketplaceSortBy] = useState<'hot' | 'new'>('hot');
  const [marketplaceCategoryFilter, setMarketplaceCategoryFilter] = useState<string>('all');
  const [marketplaceDataByType, setMarketplaceDataByType] = useState<Record<string, MarketplaceItemBase[]>>({});
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [forkingId, setForkingId] = useState<string | null>(null);

  // 文件上传相关状态
  const [uploadedFileName, setUploadedFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // AI 优化提示词状态
  const [optimizingPromptId, setOptimizingPromptId] = useState<string | null>(null);

  // 提取的标记列表
  const [markers, setMarkers] = useState<ArticleMarker[]>([]);

  // === 模型池状态 ===
  const [imageGenPools, setImageGenPools] = useState<LiteraryAgentModelPool[]>([]);
  const [chatPools, setChatPools] = useState<LiteraryAgentModelPool[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [imageGenModelError, setImageGenModelError] = useState<string | null>(null);
  // 无专属模型池时，通过预解析得到的自动调度模型（仅供显示，生成时由 Worker 自行 resolve）
  const [autoResolvedModel, setAutoResolvedModel] = useState<{ id: string; name: string; modelName: string; actualModelId: string; platformId: string } | null>(null);
  const [autoResolvedChatModel, setAutoResolvedChatModel] = useState<{ id: string; name: string; modelName: string; actualModelId: string; platformId: string } | null>(null);

  // 模型偏好（按账号持久化到数据库）
  const userId = useAuthStore((s) => s.user?.userId ?? '');
  const [imageModelPrefOpen, setImageModelPrefOpen] = useState(false);
  const [imageModelPrefId, setImageModelPrefId] = useState<string>('');
  const [chatModelPrefOpen, setChatModelPrefOpen] = useState(false);
  const [chatModelPrefId, setChatModelPrefId] = useState<string>('');
  const [modelPrefReady, setModelPrefReady] = useState(false);

  // 生图模型池 → 可选择列表
  type PoolModel = { poolId: string; id: string; name: string; modelName: string; actualModelId: string; platformId: string; enabled: boolean; isDedicated: boolean; isDefault: boolean; isAutoResolved?: boolean };
  const toPoolModels = useCallback((pools: LiteraryAgentModelPool[]): PoolModel[] => {
    return pools
      .filter((g) => g.models && g.models.length > 0)
      .map((g) => {
        const first = g.models[0]!;
        return {
          poolId: g.id,
          id: `pool_${g.id}`,
          name: g.name,
          modelName: g.code || first.modelId,
          actualModelId: first.modelId,
          platformId: first.platformId,
          enabled: g.models.some((m) => m.healthStatus === 'Healthy' || m.healthStatus === 'Degraded'),
          isDedicated: g.isDedicated,
          isDefault: g.isDefault,
        };
      })
      .filter((m) => m.enabled);
  }, []);

  const enabledImageModels = useMemo(() => toPoolModels(imageGenPools), [imageGenPools, toPoolModels]);
  const enabledChatModels = useMemo(() => toPoolModels(chatPools), [chatPools, toPoolModels]);

  // 有效选中模型（无 auto 概念，默认选第一个；无可选池时回退到预解析的自动模型）
  const effectiveModel = useMemo<PoolModel | null>(() => {
    const byId = imageModelPrefId ? enabledImageModels.find((m) => m.id === imageModelPrefId) : null;
    const fromPool = byId ?? enabledImageModels[0] ?? null;
    if (fromPool) return fromPool;
    // 无可选池时，显示预解析的自动调度模型（isAutoResolved=true 标记，生成时不传 platformId/modelId）
    if (autoResolvedModel) return { ...autoResolvedModel, poolId: 'auto', enabled: true, isDedicated: false, isDefault: true, isAutoResolved: true };
    return null;
  }, [enabledImageModels, imageModelPrefId, autoResolvedModel]);

  const effectiveChatModel = useMemo<PoolModel | null>(() => {
    const byId = chatModelPrefId ? enabledChatModels.find((m) => m.id === chatModelPrefId) : null;
    const fromPool = byId ?? enabledChatModels[0] ?? null;
    if (fromPool) return fromPool;
    if (autoResolvedChatModel) return { ...autoResolvedChatModel, poolId: 'auto', enabled: true, isDedicated: false, isDefault: true, isAutoResolved: true };
    return null;
  }, [enabledChatModels, chatModelPrefId, autoResolvedChatModel]);

  // 兼容旧代码：imageGenModel 由 effectiveModel 驱动
  const imageGenModel = useMemo<Model | null>(() => {
    if (!effectiveModel) return null;
    return {
      id: effectiveModel.id,
      name: effectiveModel.name,
      modelName: effectiveModel.modelName,
      platformId: effectiveModel.platformId,
      enabled: effectiveModel.enabled,
      isImageGen: true,
    } as Model;
  }, [effectiveModel]);


  // 生图模型尺寸选项（按分辨率分组，从后端 adapter-info 获取）
  const [sizesByResolutionForPicker, setSizesByResolutionForPicker] = useState<SizesByResolution>({ '1k': [], '2k': [], '4k': [] });

  // 右侧每条配图的运行状态（逐条 parse + gen）
  const [markerRunItems, setMarkerRunItems] = useState<MarkerRunItem[]>([]);
  const [markerRunItemsRestored, setMarkerRunItemsRestored] = useState(false); // 标记是否已从后端恢复

  const genAbortRef = useRef<AbortController | null>(null);
  const markerListRef = useRef<HTMLDivElement>(null); // 配图列表容器的 ref
  const articlePreviewRef = useRef<HTMLDivElement>(null); // 文章预览区域的 ref
  const thinkingPanelRef = useRef<HTMLDivElement>(null); // 思考面板的 ref（自动滚动到底部）
  const isStreamingRef = useRef<boolean>(false); // 标记是否正在流式输出
  const [glowingMarkers, setGlowingMarkers] = useState<Set<number>>(new Set()); // 正在播放入场动画的 marker 卡片
  const [editingMarkerIdx, setEditingMarkerIdx] = useState<number | null>(null); // 正在弹窗编辑 prompt 的 marker 索引
  const knownMarkerIndicesRef = useRef<Set<number>>(new Set()); // 已知的 marker 索引（用于检测新增）
  const [imageDisplaySize, setImageDisplaySize] = useState(50); // 文章内图片显示尺寸百分比
  const [rawMarkerOutput, setRawMarkerOutput] = useState(''); // Anchor 模式下 LLM 原始输出（用于视觉反馈）

  // 当新 marker 卡片出现时，触发入场发光动画
  useEffect(() => {
    const newIndices: number[] = [];
    for (const item of markerRunItems) {
      if (!knownMarkerIndicesRef.current.has(item.markerIndex)) {
        knownMarkerIndicesRef.current.add(item.markerIndex);
        newIndices.push(item.markerIndex);
      }
    }
    if (newIndices.length > 0) {
      setGlowingMarkers((prev) => {
        const next = new Set(prev);
        for (const idx of newIndices) next.add(idx);
        return next;
      });
    }
  }, [markerRunItems]);

  // 当配图列表增加时，只在流式输出过程中自动滚动到底部
  useEffect(() => {
    if (isStreamingRef.current && markerListRef.current && markerRunItems.length > 0) {
      markerListRef.current.scrollTop = markerListRef.current.scrollHeight;
    }
  }, [markerRunItems.length]);
  
  // 思考/生成面板自动滚动到底部
  useEffect(() => {
    if (thinkingPanelRef.current && (thinkingContent || rawMarkerOutput)) {
      thinkingPanelRef.current.scrollTop = thinkingPanelRef.current.scrollHeight;
    }
  }, [thinkingContent, rawMarkerOutput]);

  // 流式生成期间不滚动文章（AI 视图独占左面板，文章未渲染）
  // 文章在流式结束后才显示，无需自动滚动到 marker
  
  // 提示词模板管理（只有用户模板）
  const [userPrompts, setUserPrompts] = useState<PromptTemplate[]>([]);
  const [selectedPrompt, setSelectedPromptRaw] = useState<PromptTemplate | null>(null);
  // 从 workspace 加载的 selectedPromptId（用于 loadLiteraryPrompts 后恢复选中状态）
  const pendingSelectedPromptIdRef = useRef<string | null>(null);

  // Phase 1: 位置策略（自动 / 固定位置 / 用户锚点）
  // 存 sessionStorage，键 = 'articleMarkerStrategy:' + workspaceId
  // 下一阶段（Phase 2/3）再下沉到 workspace 持久化，见 doc/plan.manual-image-marking-control.md
  const [positionStrategy, setPositionStrategyRaw] = useState<PositionStrategy>('auto');
  const [positionStrategyOpen, setPositionStrategyOpen] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    const saved = sessionStorage.getItem(`articleMarkerStrategy:${workspaceId}`);
    if (saved && POSITION_STRATEGY_OPTIONS.some(o => o.value === saved)) {
      setPositionStrategyRaw(saved as PositionStrategy);
    }
  }, [workspaceId]);
  const setPositionStrategy = useCallback((s: PositionStrategy) => {
    setPositionStrategyRaw(s);
    if (workspaceId) sessionStorage.setItem(`articleMarkerStrategy:${workspaceId}`, s);
  }, [workspaceId]);

  // Phase 1.7: 自适应 heading 检测。
  // 用户的"大标题"不一定是 `#`，可能整篇文章都用 `##` 作为顶级（这是很常见的写法）。
  // 因此我们先扫一遍文章，取所有 heading 中 level 最小的那一级当作"大标题"，
  // 其次（min+1 以及更深）当作"小标题"。
  const headingLevelOf = (text: string): number => {
    const firstLine = text.split('\n')[0] ?? '';
    const m = /^(#{1,6})\s+/.exec(firstLine);
    return m ? m[1].length : 0;
  };
  const bigHeadingLevel = useMemo(() => {
    const levels = splitParagraphs(articleContent)
      .map(headingLevelOf)
      .filter(l => l > 0);
    return levels.length > 0 ? Math.min(...levels) : 0;
  }, [articleContent]);
  const isBigHeadingParagraph = useCallback((text: string): boolean => {
    if (bigHeadingLevel === 0) return false;
    return headingLevelOf(text) === bigHeadingLevel;
  }, [bigHeadingLevel]);
  const isSmallHeadingParagraph = useCallback((text: string): boolean => {
    if (bigHeadingLevel === 0) return false;
    const lvl = headingLevelOf(text);
    return lvl > 0 && lvl > bigHeadingLevel;
  }, [bigHeadingLevel]);

  // Phase 1: 锚点教程气泡（每个用户一次，点击"知道啦"后不再弹出）
  // null = 未加载；false = 未看过 → 应展示；true = 已看过 → 不展示
  const [anchorTutorialSeen, setAnchorTutorialSeen] = useState<boolean | null>(null);

  // Phase 1: 段落右键上下文菜单
  const [paragraphCtxMenu, setParagraphCtxMenu] = useState<{
    visible: boolean; x: number; y: number; pIdx: number; isAnchor: boolean;
  }>({ visible: false, x: 0, y: 0, pIdx: -1, isAnchor: false });
  useEffect(() => {
    if (!paragraphCtxMenu.visible) return;
    const close = () => setParagraphCtxMenu(m => ({ ...m, visible: false }));
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [paragraphCtxMenu.visible]);

  // 选择/取消提示词时同步持久化到后端
  const setSelectedPrompt = useCallback((prompt: PromptTemplate | null) => {
    setSelectedPromptRaw(prompt);
    // 异步持久化，不阻塞 UI
    void updateVisualAgentWorkspace({
      id: workspaceId,
      selectedPromptId: prompt?.id ?? '',
    }).catch((err) => console.error('Failed to persist selectedPromptId:', err));
  }, [workspaceId]);

  // 所有提示词（只有用户模板）
  const allPrompts = userPrompts;

  // 自动保存：3秒防抖（仅在允许编辑时启用；当前页面已移除手动编辑入口，保留逻辑以兼容未来扩展）
  const debouncedArticleContent = useDebounce(articleContent, 3000);

  // 加载工作空间数据
  useEffect(() => {
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 加载模型池列表（生图 + 对话）+ 用户偏好
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setImageGenModelError(null);
      setModelsLoading(true);

      const [imgPoolsRes, chatPoolsRes, prefsRes] = await Promise.all([
        getLiteraryAgentModels().catch(() => ({ success: false, data: null as LiteraryAgentModelPool[] | null })),
        getLiteraryAgentChatModels().catch(() => ({ success: false, data: null as LiteraryAgentModelPool[] | null })),
        getUserPreferences().catch(() => ({ success: false, data: null as null })),
      ]);
      if (cancelled) return;

      if (imgPoolsRes.success && imgPoolsRes.data) {
        setImageGenPools(imgPoolsRes.data);
      } else {
        setImageGenModelError('加载模型池失败');
      }

      if (chatPoolsRes.success && chatPoolsRes.data) {
        setChatPools(chatPoolsRes.data);
      }

      // 恢复用户模型偏好
      if (prefsRes.success && prefsRes.data?.literaryAgentPreferences) {
        const prefs = prefsRes.data.literaryAgentPreferences;
        setImageModelPrefId(prefs.imageModelId ?? '');
        setChatModelPrefId(prefs.chatModelId ?? '');
        setAnchorTutorialSeen(!!prefs.anchorTutorialSeen);
      } else {
        setAnchorTutorialSeen(false);
      }
      setModelPrefReady(true);
      setModelsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 持久化模型偏好（debounce 500ms）
  useEffect(() => {
    if (!modelPrefReady || !userId) return;
    const timeout = setTimeout(() => {
      void updateLiteraryAgentPreferences({
        imageModelId: imageModelPrefId || undefined,
        chatModelId: chatModelPrefId || undefined,
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timeout);
  }, [imageModelPrefId, chatModelPrefId, modelPrefReady, userId]);

  // 验证用户选择的模型是否仍在可用列表中
  useEffect(() => {
    if (modelsLoading) return;
    if (imageModelPrefId && !enabledImageModels.some((m) => m.id === imageModelPrefId)) {
      setImageModelPrefId('');
    }
    if (chatModelPrefId && !enabledChatModels.some((m) => m.id === chatModelPrefId)) {
      setChatModelPrefId('');
    }
  }, [enabledImageModels, enabledChatModels, imageModelPrefId, chatModelPrefId, modelsLoading]);

  // 无可选模型池（含全部模型不健康的情况）时，预解析 Gateway 将使用的模型
  useEffect(() => {
    if (modelsLoading) return;
    if (enabledImageModels.length > 0) {
      setAutoResolvedModel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getLiteraryAgentImageGenResolvedModel(false);
        if (!cancelled) {
          if (res.resolved && res.model) {
            setAutoResolvedModel({
              id: 'auto-resolved',
              name: res.poolName || res.model,
              modelName: res.model,
              actualModelId: res.model,
              platformId: res.platform || '',
            });
          } else {
            setImageGenModelError('未找到可用的生图模型（请绑定专属模型池或配置默认模型）');
          }
        }
      } catch {
        if (!cancelled) setImageGenModelError('未找到启用的生图模型（请绑定专属模型池）');
      }
    })();
    return () => { cancelled = true; };
  }, [enabledImageModels.length, modelsLoading]);

  // 无可选提示词模型池时，预解析 Gateway 将使用的 Chat 模型
  useEffect(() => {
    if (modelsLoading) return;
    if (enabledChatModels.length > 0) {
      setAutoResolvedChatModel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getLiteraryAgentChatResolvedModel();
        if (!cancelled) {
          if (res.resolved && res.model) {
            setAutoResolvedChatModel({
              id: 'auto-resolved-chat',
              name: res.poolName || res.model,
              modelName: res.model,
              actualModelId: res.model,
              platformId: res.platform || '',
            });
          } else {
            setAutoResolvedChatModel(null);
          }
        }
      } catch {
        if (!cancelled) setAutoResolvedChatModel(null);
      }
    })();
    return () => { cancelled = true; };
  }, [enabledChatModels.length, modelsLoading]);

  // 从 ASPECT_OPTIONS 构建默认尺寸选项（当适配器未返回尺寸时作为 fallback）
  const defaultSizesByResolution: SizesByResolution = React.useMemo(() => ({
    '1k': ASPECT_OPTIONS.map(opt => ({ size: opt.size1k, aspectRatio: opt.id })),
    '2k': ASPECT_OPTIONS.map(opt => ({ size: opt.size2k, aspectRatio: opt.id })),
    '4k': ASPECT_OPTIONS.map(opt => ({ size: opt.size4k, aspectRatio: opt.id })),
  }), []);

  // 从后端获取生图模型的尺寸选项（按分辨率分组，与视觉创作一致）
  useEffect(() => {
    const modelName = effectiveModel?.actualModelId || imageGenModel?.modelName;
    if (!modelName) {
      setSizesByResolutionForPicker(defaultSizesByResolution);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getAdapterInfoByModelName(modelName);
        if (cancelled) return;
        if (res.success && res.data?.matched && res.data.sizesByResolution) {
          const data = res.data.sizesByResolution;
          const resolved: SizesByResolution = {
            '1k': Array.isArray(data['1k']) ? data['1k'] : [],
            '2k': Array.isArray(data['2k']) ? data['2k'] : [],
            '4k': Array.isArray(data['4k']) ? data['4k'] : [],
          };
          // 适配器返回了有效尺寸则使用，否则 fallback 到默认
          const hasAny = resolved['1k'].length > 0 || resolved['2k'].length > 0 || resolved['4k'].length > 0;
          setSizesByResolutionForPicker(hasAny ? resolved : defaultSizesByResolution);
        } else {
          setSizesByResolutionForPicker(defaultSizesByResolution);
        }
      } catch {
        if (!cancelled) setSizesByResolutionForPicker(defaultSizesByResolution);
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveModel?.actualModelId, imageGenModel?.modelName, defaultSizesByResolution]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getWatermarkByApp({ appKey: 'literary-agent' });
      if (cancelled) return;
      if (res?.success && res.data) {
        const config = res.data;
        setWatermarkStatus({
          enabled: true,
          name: config.name || config.text || null,
        });
      } else {
        setWatermarkStatus({ enabled: false, name: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载风格图配置列表（按 ID 稳定排序，避免操作后重排序导致闪烁）
  const loadReferenceImageConfigs = useCallback(async () => {
    setReferenceImageLoading(true);
    try {
      const res = await listReferenceImageConfigs();
      if (res?.success && res.data?.items) {
        // 按 ID 稳定排序，避免操作后列表重排序导致页面闪烁
        const sorted = [...res.data.items].sort((a, b) => a.id.localeCompare(b.id));
        setReferenceImageConfigs(sorted);
      }
    } finally {
      setReferenceImageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReferenceImageConfigs();
  }, [loadReferenceImageConfigs]);

  // 将 loadReferenceImageConfigs 赋值给 ref 以便 handleMarketplaceFork 使用
  useEffect(() => {
    loadReferenceImageConfigsRef.current = loadReferenceImageConfigs;
  }, [loadReferenceImageConfigs]);

  // 加载海鲜市场数据（使用类型注册表）
  const loadMarketplaceData = useCallback(async () => {
    setMarketplaceLoading(true);
    try {
      const typeKeys = Object.keys(CONFIG_TYPE_REGISTRY);
      const results = await Promise.all(
        typeKeys.map(async (typeKey) => {
          const typeDef = CONFIG_TYPE_REGISTRY[typeKey];
          const res = await typeDef.api.listMarketplace({
            keyword: marketplaceSearchKeyword || undefined,
            sort: marketplaceSortBy,
          });
          return { typeKey, items: res.success && res.data ? res.data.items : [] };
        })
      );

      const dataByType: Record<string, MarketplaceItemBase[]> = {};
      for (const { typeKey, items } of results) {
        dataByType[typeKey] = items;
      }
      setMarketplaceDataByType(dataByType);
    } finally {
      setMarketplaceLoading(false);
    }
  }, [marketplaceSearchKeyword, marketplaceSortBy]);

  // 处理 Fork 下载 - 使用 ref 存储回调以避免声明顺序问题
  const loadLiteraryPromptsRef = useRef<() => Promise<void>>();
  const loadReferenceImageConfigsRef = useRef<() => Promise<void>>();

  const handleMarketplaceFork = useCallback(async (typeKey: string, id: string, customName?: string) => {
    const typeDef = CONFIG_TYPE_REGISTRY[typeKey];
    if (!typeDef) return;

    setForkingId(id);
    try {
      const res = await typeDef.api.fork({ id, name: customName });
      if (res.success) {
        toast.success('下载成功，已添加到「我的」');
        // 刷新市场数据
        void loadMarketplaceData();
        // 刷新对应类型的"我的"数据
        if (typeKey === 'prompt' && loadLiteraryPromptsRef.current) {
          void loadLiteraryPromptsRef.current();
        } else if (typeKey === 'refImage' && loadReferenceImageConfigsRef.current) {
          void loadReferenceImageConfigsRef.current();
        }
        // watermark 由 WatermarkSettingsPanel 自己管理刷新
      } else {
        toast.error('下载失败', res.error?.message || '未知错误');
      }
    } finally {
      setForkingId(null);
    }
  }, [loadMarketplaceData]);

  // 当切换到海鲜市场视图或搜索/排序变化时加载数据
  useEffect(() => {
    if (promptPreviewOpen && configViewMode === 'marketplace') {
      void loadMarketplaceData();
    }
  }, [promptPreviewOpen, configViewMode, loadMarketplaceData]);

  async function loadWorkspace() {
    try {
      const res = await getVisualAgentWorkspaceDetail({ id: workspaceId });
      if (res.success && res.data?.workspace) {
        const ws = res.data.workspace;
        const content = ws.articleContent || '';
        setArticleContent(content);
        setArticleWithMarkers(ws.articleContentWithMarkers || '');
        setArticleWithImages('');
        
        // 优先以服务端 workflow.phase 为准（保证刷新可恢复/不可跳未来）
        const workflowPhase = ws.articleWorkflow?.phase;
        if (workflowPhase) {
          setPhase(workflowPhase as WorkflowPhase);
        } else {
          // 兼容旧数据：无 workflow 时按原逻辑推导
          if (ws.articleContentWithMarkers) {
            const extracted = extractMarkers(ws.articleContentWithMarkers);
            setMarkers(extracted);
            if (extracted.length > 0) {
              setPhase(2); // MarkersGenerated
            }
          } else if (content) {
            setUploadedFileName('已上传的文章.md');
            setPhase(1); // Editing
          }
        }
        
        // 如果有生成的内容，提取标记（用于右侧列表）
        if (ws.articleContentWithMarkers) {
          const extracted = extractMarkers(ws.articleContentWithMarkers);
          setMarkers(extracted);
        }
        
        // 新增：从 workflow.markers 恢复右侧运行状态
        if (ws.articleWorkflow?.markers && ws.articleWorkflow.markers.length > 0) {
          const restoredItems: MarkerRunItem[] = ws.articleWorkflow.markers.map((m: any) => ({
            markerIndex: m.index,
            markerText: m.text || '',
            draftText: m.draftText || m.text || '',
            status: (m.status || 'idle') as MarkerRunStatus,
            // 恢复 planItem（意图解析结果）
            planItem: m.planItem ? {
              prompt: m.planItem.prompt || '',
              count: m.planItem.count || 1,
              size: m.planItem.size || undefined,
            } : null,
            runId: m.runId || null,
            // 恢复图片数据（只使用 URL，不使用 base64 以减少存储压力）
            base64: null, // 前端不从后端恢复 base64
            url: m.url || null,
            assetUrl: m.assetId ? (res.data.assets?.find((a: any) => a.id === m.assetId)?.url || null) : null,
            errorMessage: m.errorMessage || null,
          }));
          setMarkerRunItems(restoredItems);
          setMarkerRunItemsRestored(true); // 标记已恢复

          // 对于 status === 'running' 且有 runId 的 marker，查询后端 Run 的真实状态
          // 后端是状态的唯一来源，前端只是观察者
          const runningItems = restoredItems.filter(item => item.status === 'running' && item.runId);
          if (runningItems.length > 0) {
            // 异步查询每个 run 的真实状态（不阻塞 UI）
            Promise.all(runningItems.map(async (item) => {
              try {
                const runRes = await getImageGenRun({ runId: item.runId!, includeItems: true });
                if (runRes.success && runRes.data) {
                  const runStatus = runRes.data.run.status;
                  // 根据后端 Run 状态更新前端显示
                  if (runStatus === 'Failed' || runStatus === 'Cancelled') {
                    const errorMsg = runRes.data.items?.[0]?.errorMessage || '生图失败';
                    setMarkerRunItems(prev => prev.map(x => 
                      x.markerIndex === item.markerIndex 
                        ? { ...x, status: 'error' as MarkerRunStatus, errorMessage: errorMsg }
                        : x
                    ));
                  } else if (runStatus === 'Completed') {
                    // Run 已完成但 marker 状态未更新（可能是刷新时丢失了 SSE 事件）
                    const doneItem = runRes.data.items?.[0];
                    const url = doneItem?.url || doneItem?.base64 || item.url;
                    if (url) {
                      setMarkerRunItems(prev => prev.map(x => 
                        x.markerIndex === item.markerIndex 
                          ? { ...x, status: 'done' as MarkerRunStatus, url, assetUrl: url, errorMessage: null }
                          : x
                      ));
                    }
                  }
                  // 如果 runStatus 是 'Running' 或 'Queued'，保持当前状态，后续 SSE 会更新
                }
              } catch (error) {
                console.error(`Failed to query run status for runId ${item.runId}:`, error);
              }
            }));
          }
        }
        
        // 记录 workspace 中的 selectedPromptId，加载提示词后恢复选中状态
        pendingSelectedPromptIdRef.current = ws.selectedPromptId || null;
        // 加载文学创作提示词（从后端）
        await loadLiteraryPrompts();
      }
    } catch (error) {
      console.error('Failed to load workspace:', error);
    }
  }

  // markers 变化时：初始化/对齐右侧运行状态列表（保持用户已编辑内容）
  useEffect(() => {
    // 如果已经从后端恢复过状态，就不要重新初始化
    if (markerRunItemsRestored) {
      setMarkerRunItemsRestored(false); // 重置标志位，下次 markers 变化时正常处理
      return;
    }
    
    setMarkerRunItems((prev) => {
      const prevByIdx = new Map(prev.map((x) => [x.markerIndex, x]));
      const next: MarkerRunItem[] = markers.map((m) => {
        const old = prevByIdx.get(m.index);
        const markerText = String(m.text || '').trim();
        if (old) {
          return {
            ...old,
            markerText,
            draftText: old.draftText || markerText,
          };
        }
        return {
          markerIndex: m.index,
          markerText,
          draftText: markerText,
          status: 'idle',
          planItem: null,
          runId: null,
          base64: null,
          url: null,
          assetUrl: null,
          errorMessage: null,
        };
      });
      return next;
    });
  }, [markers, markerRunItemsRestored]);

  // 加载文学创作提示词（从后端，按 ID 稳定排序避免闪烁）
  const loadLiteraryPrompts = useCallback(async () => {
    try {
      const res = await listLiteraryPrompts({ scenarioType: 'article-illustration' });
      if (res.success && res.data?.items) {
        const prompts: PromptTemplate[] = res.data.items.map((p: { id: string; title: string; content: string; isSystem?: boolean; scenarioType?: string | null; order?: number }) => ({
          id: p.id,
          title: p.title,
          content: p.content,
          isSystem: p.isSystem,
          scenarioType: p.scenarioType,
          order: p.order,
        }));
        // 按 ID 稳定排序，避免操作后列表重排序导致页面闪烁
        prompts.sort((a, b) => a.id.localeCompare(b.id));
        setUserPrompts(prompts);
        // 从 workspace 恢复选中的提示词（仅首次加载时）
        const pendingId = pendingSelectedPromptIdRef.current;
        if (pendingId) {
          const matched = prompts.find(p => p.id === pendingId);
          if (matched) setSelectedPromptRaw(matched);
          pendingSelectedPromptIdRef.current = null;
        }
      }
    } catch (error) {
      console.error('Failed to load literary prompts:', error);
    }
  }, []);

  // 将 loadLiteraryPrompts 赋值给 ref 以便 handleMarketplaceFork 使用
  useEffect(() => {
    loadLiteraryPromptsRef.current = loadLiteraryPrompts;
  }, [loadLiteraryPrompts]);

  const isBusy = generating || markerStreaming;

  useEffect(() => {
    if (debouncedArticleContent && workspaceId && phase === 1 && !isBusy) { // Editing
      void saveArticleContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedArticleContent, isBusy]);

  async function saveArticleContent() {
    try {
      await updateVisualAgentWorkspace({
        id: workspaceId,
        articleContent: debouncedArticleContent,
        idempotencyKey: `save-article-${workspaceId}-${Date.now()}`,
      });
    } catch (error) {
      console.error('自动保存失败:', error);
    }
  }

  // 文件上传处理
  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name;
    
    try {
      const text = await file.text();
      setArticleContent(text);
      setUploadedFileName(fileName);
      
      // 保存到后端（提交型操作：会触发 version++，清空后续阶段）
      await updateVisualAgentWorkspace({
        id: workspaceId,
        articleContent: text,
        idempotencyKey: `upload-article-${workspaceId}-${Date.now()}`,
      });
      
      // 上传后直接进入编辑模式并启用预览
      setPhase(1); // Editing
    } catch {
      toast.error('文件读取失败');
    }

    // 重置 input，允许重新上传同一文件
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [workspaceId]);

  // 点击上传按钮
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 拖拽处理函数
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    // 检查文件类型
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.md') && !fileName.endsWith('.mdc') && !fileName.endsWith('.txt')) {
      toast.warning('仅支持 .md、.mdc、.txt 格式的文件');
      return;
    }

    try {
      const text = await file.text();
      setArticleContent(text);
      setUploadedFileName(file.name);
      
      // 保存到后端
      await updateVisualAgentWorkspace({
        id: workspaceId,
        articleContent: text,
        idempotencyKey: `upload-article-${workspaceId}-${Date.now()}`,
      });
      
      // 上传后直接进入编辑模式
      setPhase(1); // Editing
    } catch {
      toast.error('文件读取失败');
    }
  }, [workspaceId]);

  // 进入预览阶段（保留 phase=editing，表示“已上传可生成标记”）
  const handleEnterPreview = useCallback(() => {
    setPhase(1); // Editing
  }, []);

  // Phase 1: 关闭锚点教程气泡（点"知道啦"后不再弹出）
  const dismissAnchorTutorial = useCallback(() => {
    setAnchorTutorialSeen(true);
    void updateLiteraryAgentPreferences({
      imageModelId: imageModelPrefId || undefined,
      chatModelId: chatModelPrefId || undefined,
      anchorTutorialSeen: true,
    }).catch(() => {});
  }, [imageModelPrefId, chatModelPrefId]);

  // Phase 1: 段落级锚点操作（仅 phase=1 编辑阶段使用）
  const addAnchorAbove = useCallback((pIdx: number) => {
    setArticleContent(prev => insertAnchorAt(prev, pIdx));
    setPositionStrategy('user-anchor');
  }, [setPositionStrategy]);
  const addAnchorBelow = useCallback((pIdx: number) => {
    setArticleContent(prev => insertAnchorAt(prev, pIdx + 1));
    setPositionStrategy('user-anchor');
  }, [setPositionStrategy]);
  const removeAnchorParagraph = useCallback((pIdx: number) => {
    setArticleContent(prev => removeParagraphAt(prev, pIdx));
  }, []);

  const handleGenerateMarkers = async () => {
    if (!articleContent.trim()) {
      toast.warning('请先输入文章内容');
      return;
    }

    // 使用选中的风格提示词（可选，不选则后端使用系统推断风格）
    // Phase 1: 位置策略以文本提示形式拼到 userInstruction 前部，后端无需改动
    const strategyHint = POSITION_STRATEGY_OPTIONS.find(o => o.value === positionStrategy)?.hint ?? '';
    const basePrompt = selectedPrompt?.content ?? '';
    const systemPrompt = strategyHint
      ? (basePrompt ? `${strategyHint}\n\n${basePrompt}` : strategyHint)
      : basePrompt;

    setMarkerStreaming(true);
    setThinkingContent('');
    setRawMarkerOutput(''); // 重置原始输出
    setGlowingMarkers(new Set()); // 重置入场动画追踪
    knownMarkerIndicesRef.current.clear();
    isStreamingRef.current = true; // 标记开始流式输出

    // 保存当前滚动位置，phase 切换导致 DOM 重建会丢失 scrollTop
    const savedScrollTop = articlePreviewRef.current?.scrollTop ?? 0;

    // 3 状态模式：生成标记时直接跳到 MarkersGenerated，流式更新内容
    setPhase(2); // MarkersGenerated
    setMarkers([]);

    // 锚点模式：预先显示原文（LLM 不会流式返回文章内容）
    setArticleWithMarkers(articleContent);

    // 恢复滚动位置（等 React 完成渲染后）
    requestAnimationFrame(() => {
      if (articlePreviewRef.current) {
        articlePreviewRef.current.scrollTop = savedScrollTop;
      }
    });

    try {
      // 使用 SSE 流式接口
      const stream = generateArticleMarkers({
        id: workspaceId,
        articleContent,
        userInstruction: systemPrompt,
        idempotencyKey: `gen-markers-${Date.now()}`,
        insertionMode: 'anchor',
        modelId: effectiveChatModel?.actualModelId,
      });

      let fullText = '';

      const extractedMarkers: ArticleMarker[] = []; // 已提取的标记
      let runningArticle = articleContent; // 锚点模式：跟踪增量插入后的文章
      const newMarkerIndices = new Set<number>(); // 跟踪新插入的 marker 索引（用于动画）

      // 直接设置 marker 为已解析（跳过意图模型，尺寸由 LLM 直接提供）
      const setMarkerDirectParsed = (markerIndex: number, markerText: string, size: string) => {
        const planItem = { prompt: markerText, count: 1, size };
        setMarkerRunItems((prev) => {
          if (prev.some((x) => x.markerIndex === markerIndex)) return prev;
          return [
            ...prev,
            { markerIndex, markerText, draftText: markerText, status: 'parsed' as MarkerRunStatus, planItem },
          ];
        });

        void updateMarkerStatus(markerIndex, {
          status: 'parsed',
          draftText: markerText,
          planItem: { prompt: markerText, count: 1, size },
        });
      };

      for await (const chunk of stream) {
        // ====== 思考过程：实时追加显示 ======
        if (chunk.type === 'thinking' && chunk.text) {
          setThinkingContent((prev) => prev + chunk.text);
          continue;
        }

        // ====== Anchor 模式：处理 marker 事件 ======
        if (chunk.type === 'marker' && chunk.text && chunk.index != null) {
          const markerIndex = chunk.index;
          const markerText = chunk.text;
          extractedMarkers.push({
            index: markerIndex,
            text: markerText,
            startPos: -1,
            endPos: -1,
          });
          setMarkers([...extractedMarkers]);

          // 增量插入 marker 到文章中（实时反馈）
          if (chunk.anchor) {
            runningArticle = insertMarkerIntoArticle(runningArticle, chunk.anchor, markerText);
            newMarkerIndices.add(markerIndex);
            setArticleWithMarkers(runningArticle);
          }

          // Anchor 模式：marker text 即 prompt，无需意图模型解析，统一默认 1:1
          setMarkerDirectParsed(markerIndex, markerText, '1024x1024');
        }
        // ====== Delta 事件：Anchor 模式为原始输出视觉反馈 ======
        else if ((chunk.type === 'chunk' || chunk.type === 'delta') && chunk.text) {
          // Anchor 模式：LLM 原始输出仅用于视觉反馈，文章由 marker 事件增量更新
          setRawMarkerOutput((prev) => prev + chunk.text);
        }
        // ====== 后处理中事件 ======
        else if (chunk.type === 'finalizing') {
          setRawMarkerOutput((prev) => prev + '\n\n✓ 标记生成完成，正在保存…');
        }
        // ====== 完成事件 ======
        else if (chunk.type === 'done' && chunk.fullText) {
          fullText = chunk.fullText;
          setArticleWithMarkers(fullText);

          // 提取标记（确保最终状态一致）
          const extracted = extractMarkers(fullText);
          setMarkers(extracted);

          // 对于 done 事件中的标记但尚未处理的，补充直接设为 parsed（无需意图模型）
          extracted.forEach((marker) => {
            setMarkerRunItems((prev) => {
              const existingItem = prev.find((x) => x.markerIndex === marker.index);
              if (existingItem && existingItem.status !== 'idle') return prev;
              if (!existingItem) {
                return [
                  ...prev,
                  {
                    markerIndex: marker.index,
                    markerText: marker.text,
                    draftText: marker.text,
                    status: 'parsed' as MarkerRunStatus,
                    planItem: { prompt: marker.text, count: 1, size: '1024x1024' },
                  },
                ];
              }
              return prev;
            });
          });

          setPhase(2); // MarkersGenerated
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message || '生成失败');
        }
      }
    } catch (error) {
      console.error('Generate markers error:', error);
      toast.error('生成失败', error instanceof Error ? error.message : '未知错误');
      setMarkers([]);
      setPhase(1); // Editing
    } finally {
      setMarkerStreaming(false);
      isStreamingRef.current = false; // 标记流式输出结束
    }
  };

  const parseSizeFromText = (text: string): string | null => {
    // 允许：1080x608 / 1024x1024 等
    const m = /(\d{3,4}\s*x\s*\d{3,4})/i.exec(text);
    if (!m) return null;
    return m[1].replace(/\s+/g, '').toLowerCase();
  };

  const safeJsonParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  // markerRunItems 的最新快照（用于批量流程读写）
  const markerRunItemsRef = useRef<MarkerRunItem[]>([]);
  useEffect(() => {
    markerRunItemsRef.current = markerRunItems;
    hasGeneratedImagesRef.current = markerRunItems.some((x) => x.status === 'done');
  }, [markerRunItems]);

  const buildPreviewMarkdownWithImages = useCallback(
    (items: MarkerRunItem[]) => {
      const base = String(articleWithMarkers || articleContent || '');
      if (!base || markers.length === 0) return '';

      const byIndex = new Map<number, MarkerRunItem>(items.map((x) => [x.markerIndex, x]));
      const patches: Array<{ start: number; end: number; replacement: string }> = [];

      // 关键：按 markerIndex 精准替换，每个 marker 都添加 data-marker-idx 用于定位
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const it = byIndex.get(m.index);

        const url = it ? (
          String(it.assetUrl || it.url || '').trim() ||
          (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '')
        ) : '';

        // 如果有图片 URL，使用 raw <img> 确保 URL 特殊字符不破坏 markdown 语法
        if (url) {
          const safeUrl = url.replace(/"/g, '&quot;');
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `<img data-marker-idx="${i}" alt="配图 ${i + 1}" src="${safeUrl}" style="max-width:100%;border-radius:8px;margin:8px 0" />`,
          });
          continue;
        }

        // "立刻插入"：无图时点击生成后，生成中也会在对应 marker 行下方插入占位提示
        const isGenerating = it?.status === 'running';
        if (isGenerating) {
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `<span data-marker-idx="${i}">[插图] : ${m.text}</span>\n\n> 配图 ${i + 1} 生成中...`,
          });
          continue;
        }

        // 空闲/无运行项 — 包裹 data-marker-idx 用于定位（保留原文供 highlightText 高亮）
        const originalText = base.slice(m.startPos, m.endPos);
        patches.push({
          start: m.startPos,
          end: m.endPos,
          replacement: `<span data-marker-idx="${i}">${originalText}</span>`,
        });
      }

      if (patches.length === 0) return '';

      // 从后往前替换，避免偏移
      patches.sort((a, b) => b.start - a.start);
      let out = base;
      for (const p of patches) {
        out = out.slice(0, p.start) + p.replacement + out.slice(p.end);
      }
      return out;
    },
    [articleWithMarkers, articleContent, markers]
  );

  const rebuildMergedMarkdown = useCallback(
    (items: MarkerRunItem[]) => {
      setArticleWithImages(buildPreviewMarkdownWithImages(items));
    },
    [buildPreviewMarkdownWithImages]
  );

  const locateMarkerInPreview = (markerIndex: number) => {
    const container = articlePreviewRef.current;
    if (!container) return;

    const scrollAndHighlight = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid rgba(245, 158, 11, 0.8)';
      el.style.outlineOffset = '2px';
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 1500);
    };

    // 方式 1: data-marker-idx 属性（最可靠，兼容图片/标记/生成中所有状态）
    const byAttr = container.querySelector(`[data-marker-idx="${markerIndex}"]`) as HTMLElement | null;
    if (byAttr) {
      scrollAndHighlight(byAttr);
      return;
    }

    // 方式 2: marker class 按序号（articleWithImages 为空时的回退）
    const markerEls = container.querySelectorAll('.prd-md-marker, .prd-md-marker-new');
    const target = markerEls[markerIndex] as HTMLElement | undefined;
    if (target) {
      scrollAndHighlight(target);
      return;
    }

    // 方式 3: img alt 匹配（宽泛回退）
    const imgAlt = `配图 ${markerIndex + 1}`;
    const img = container.querySelector(`img[alt="${imgAlt}"]`) as HTMLElement | null;
    if (img) {
      scrollAndHighlight(img);
      return;
    }

    console.warn('[定位] 未找到匹配元素', { markerIndex, markerEls: markerEls.length });
  };

  // markerRunItems 状态变化时：立即刷新左侧预览（支持"单条先生成"不乱序）
  useEffect(() => {
    if (phase === 2) { // MarkersGenerated
      rebuildMergedMarkdown(markerRunItems);
    }
  }, [markerRunItems, phase, rebuildMergedMarkdown]);

  const runSingleMarker = async (markerIndex: number) => {
    if (!imageGenModel) {
      toast.error(imageGenModelError || '未选择生图模型');
      return;
    }
    const current = markerRunItems.find((x) => x.markerIndex === markerIndex) ?? null;
    if (!current) return;
    const text = String(current.draftText || current.markerText || '').trim();
    if (!text) {
      toast.warning('提示词为空');
      return;
    }

    const cachedPlanItem = current.planItem;
    const cachedDraft = String(current.draftText || '').trim();
    // 1) 已解析过则直接复用，避免重复 planImageGen
    setMarkerRunItems((prev) =>
      prev.map((x) =>
        x.markerIndex === markerIndex
          ? { ...x, status: 'parsing', errorMessage: null, planItem: null, runId: null, base64: null, url: null, assetUrl: null }
          : x
      )
    );
    await updateMarkerStatus(markerIndex, { status: 'parsing' }); // 保存到后端

    let plannedPrompt = '';
    let plannedSize = '';
    let planItem: ImageGenPlanItem | null = null;

    if (cachedPlanItem && String(cachedPlanItem.prompt || '').trim()) {
      planItem = cachedPlanItem;
      plannedPrompt = String(cachedPlanItem.prompt || '').trim();
      plannedSize = String(cachedPlanItem.size || '').trim();
    } else if (cachedDraft) {
      plannedPrompt = cachedDraft;
    } else {
      const planRes = await planImageGen({ text, maxItems: 1 });
      if (!planRes.success) {
        const errorMsg = planRes.error?.message || '解析失败';
        setMarkerRunItems((prev) =>
          prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
        );
        await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
        return;
      }
      const first = (planRes.data?.items ?? [])[0] ?? null;
      if (!first || !String(first.prompt || '').trim()) {
        const errorMsg = '解析失败：未返回有效 JSON';
        setMarkerRunItems((prev) =>
          prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
        );
        await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
        return;
      }
      planItem = first;
      plannedPrompt = String(first.prompt || '').trim();
      plannedSize = String(first.size || '').trim();
    }

    plannedSize = plannedSize || parseSizeFromText(plannedPrompt) || parseSizeFromText(text) || '1024x1024';

    setMarkerRunItems((prev) =>
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'parsed', planItem } : x))
    );
    if (planItem) {
      await updateMarkerStatus(markerIndex, {
        status: 'parsed',
        draftText: plannedPrompt,
        planItem: {
          prompt: planItem.prompt,
          count: planItem.count,
          size: planItem.size,
        },
      });
    } else {
      await updateMarkerStatus(markerIndex, { status: 'parsed', draftText: plannedPrompt });
    }

    // 2) 创建 run（传入 workspaceId，后端会自动保存到 COS）
    // 注意：重新生成时保留旧的图片 URL，这样预览中会继续显示旧图，直到新图生成完成
    setMarkerRunItems((prev) =>
      prev.map((x) =>
        x.markerIndex === markerIndex ? { ...x, status: 'running' } : x
      )
    );
    const idem = `article_img_${workspaceId}_${markerIndex}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    // 如果用户选择了特定模型池，传入 platformId 和 modelId；自动解析模型（isAutoResolved）不传，Worker 自行 resolve
    const runInput: CreateImageGenRunInput = {
      items: [{ prompt: plannedPrompt, count: 1, size: plannedSize }],
      size: plannedSize,
      responseFormat: 'url',
      maxConcurrency: 1,
      workspaceId,
      appKey: 'literary-agent',
      articleMarkerIndex: markerIndex,
      ...(effectiveModel && !effectiveModel.isAutoResolved ? { platformId: effectiveModel.platformId, modelId: effectiveModel.actualModelId } : {}),
    };
    const created = await createLiteraryAgentImageGenRun({
      input: runInput,
      idempotencyKey: idem,
    });
    if (!created.success) {
      const errorMsg = created.error?.message || '生图失败';
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
      );
      await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      const errorMsg = '生图失败：未返回 runId';
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
      );
      await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
      return;
    }
    setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === markerIndex ? { ...x, runId } : x)));
    await updateMarkerStatus(markerIndex, { status: 'running', runId }); // 保存

    // 3) 订阅 SSE，拿到 base64/url
    let gotBase64: string | null = null;
    let gotUrl: string | null = null;
    const ac = genAbortRef.current;
    const res = await streamLiteraryAgentImageGenRunWithRetry({
      runId,
      afterSeq: 0,
      maxAttempts: 20,
      signal: ac?.signal ?? new AbortController().signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        const obj = safeJsonParse(String(evt.data));
        if (!obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;
        const t = String(o.type ?? '');
        if (t === 'imageDone') {
          const evtRunId = String(o.runId ?? '').trim();
          if (evtRunId && evtRunId !== runId) return;
          const b64 = (o.base64 as string | null | undefined) ?? null;
          const url = (o.url as string | null | undefined) ?? null;
          gotBase64 = b64;
          gotUrl = url;
          setMarkerRunItems((prev) =>
            prev.map((x) => (x.markerIndex === markerIndex ? { ...x, base64: b64, url: url, errorMessage: null } : x))
          );
        }
        if (t === 'imageError') {
          const msg = String(o.errorMessage ?? '生图失败');
          setMarkerRunItems((prev) =>
            prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: msg } : x))
          );
        }
      },
    });
    if (!res.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: res.error?.message || '生图失败' } : x))
      );
      return;
    }

    // 4) 将结果转为可插入文章的 url：优先 SSE url；否则上传 base64 得到 asset.url
    const finalUrl = String(gotUrl || '').trim();
    const finalB64 = String(gotBase64 || '').trim();
    if (finalUrl) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl: finalUrl, url: finalUrl, errorMessage: null } : x))
      );
      // 保存图片URL到后端
      await updateMarkerStatus(markerIndex, { status: 'done' });
      try {
        await updateArticleMarker({
          workspaceId,
          markerIndex,
          url: finalUrl,
        });
      } catch (error) {
        console.error('Failed to save image url:', error);
      }
      return;
    }
    if (!finalB64) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '生图失败：未返回图片' } : x))
      );
      return;
    }

    const dataUrl = finalB64.startsWith('data:') ? finalB64 : `data:image/png;base64,${finalB64}`;
    const up = await uploadVisualAgentWorkspaceAsset({ 
      id: workspaceId, 
      data: dataUrl, 
      prompt: plannedPrompt,
      articleInsertionIndex: markerIndex,
      originalMarkerText: current.markerText
    });
    if (!up.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: up.error?.message || '图片持久化失败' } : x))
      );
      return;
    }
    const assetUrl = String(up.data?.asset?.url || '').trim();
    if (!assetUrl) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '图片持久化失败：未返回 url' } : x))
      );
      return;
    }
    setMarkerRunItems((prev) =>
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl, url: assetUrl, errorMessage: null } : x))
    );
    // 图片已经通过 uploadVisualAgentWorkspaceAsset 上传到腾讯云 COS，assetUrl 就是 COS 的 URL
    // 保存 URL 到后端（刷新后可恢复）
    await updateMarkerStatus(markerIndex, { status: 'done' });
    try {
      await updateArticleMarker({
        workspaceId,
        markerIndex,
        url: assetUrl,
      });
    } catch (error) {
      console.error('Failed to save asset url:', error);
    }
  };

  // 新增辅助函数：保存 marker 状态到后端
  const updateMarkerStatus = async (markerIndex: number, updates: {
    draftText?: string;
    status?: string;
    runId?: string;
    errorMessage?: string;
    planItem?: { prompt: string; count?: number; size?: string };
  }) => {
    try {
      const planItem = updates.planItem
        ? {
            prompt: updates.planItem.prompt,
            count: updates.planItem.count ?? 1,
            size: updates.planItem.size,
          }
        : undefined;
      await updateArticleMarker({
        workspaceId,
        markerIndex,
        ...updates,
        planItem,
      });
    } catch (error) {
      console.error('Failed to update marker status:', error);
    }
  };

  const handleBatchGenerate = async () => {
    if (!imageGenModel) {
      toast.error(imageGenModelError || '未选择生图模型');
      return;
    }
    if (markers.length === 0) {
      toast.warning('暂无配图标记');
      return;
    }
    if (!articleWithMarkers.trim()) {
      toast.warning('请先生成配图标记');
      return;
    }

    genAbortRef.current?.abort();
    const ac = new AbortController();
    genAbortRef.current = ac;

    setGenerating(true);
    setArticleWithImages('');

    try {
      // 并行发起所有生图任务：仅针对未完成（失败或未开始）的项目
      const ordered = [...markerRunItemsRef.current]
        .sort((a, b) => a.markerIndex - b.markerIndex)
        .filter(it => it.status !== 'done' && it.status !== 'running');
      
      if (ordered.length === 0) {
        toast.info('没有需要生成的配图');
        setGenerating(false);
        return;
      }

      const results = await Promise.allSettled(
        ordered.map(it => runSingleMarker(it.markerIndex))
      );
      
      // 检查是否有失败
      const anyError = results.some(r => r.status === 'rejected') || 
                       markerRunItemsRef.current.some(x => x.status === 'error');
      
      setGenerating(false);
      // 3 状态模式：生图完成后仍保持在 MarkersGenerated
      setPhase(2); // MarkersGenerated
      
      if (anyError && !ac.signal.aborted) {
        toast.warning('部分配图生成失败：可在右侧逐条修改并重新生成');
      }
      tryAutoSubmit();
    } catch (error) {
      console.error('Batch generate error:', error);
      setGenerating(false);
      setPhase(2); // MarkersGenerated
    }
  };

  const handleRegenerateOne = async (markerIndex: number) => {
    // 每个配图独立生成，不检查全局 isBusy
    try {
      await runSingleMarker(markerIndex);
      tryAutoSubmit();
    } catch (error) {
      console.error('Regenerate error:', error);
      // 确保在任何错误情况下都设置状态为 error，使按钮立即可用
      setMarkerRunItems((prev) =>
        prev.map((x) =>
          x.markerIndex === markerIndex
            ? { ...x, status: 'error' as MarkerRunStatus, errorMessage: error instanceof Error ? error.message : '生成失败' }
            : x
        )
      );
    } finally {
      // 3 状态模式：生图完成后仍保持在 MarkersGenerated
      setPhase(2); // MarkersGenerated
    }
  };

  const removeMarkerFromContent = (content: string, marker: ArticleMarker): string => {
    let start = marker.startPos;
    let end = marker.endPos;

    // 优先吃掉行尾换行；否则吃掉行首换行，避免留下空行
    const nextTwo = content.slice(end, end + 2);
    if (nextTwo === '\r\n') end += 2;
    else if (content[end] === '\n' || content[end] === '\r') end += 1;
    else if (start > 0 && (content[start - 1] === '\n' || content[start - 1] === '\r')) start -= 1;

    return content.slice(0, start) + content.slice(end);
  };

  const handleDeleteMarker = async (markerIndex: number) => {
    // 只检查当前配图状态，不检查全局 isBusy
    const currentItem = markerRunItemsRef.current.find((x) => x.markerIndex === markerIndex);
    if (currentItem?.status === 'running' || currentItem?.status === 'parsing') return;
    const marker = markers.find((m) => m.index === markerIndex) ?? null;
    if (!marker) return;

    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除配图 ${markerIndex + 1} 吗？将同时移除文章中的对应 [插图] 标记（不可恢复）。`,
      tone: 'danger',
    });
    if (!ok) return;

    const current = String(articleWithMarkers || '').trim();
    if (!current) return;

    const nextArticleWithMarkers = removeMarkerFromContent(articleWithMarkers, marker);
    const nextMarkers = extractMarkers(nextArticleWithMarkers);
    const nextRunItems = markerRunItemsRef.current
      .filter((x) => x.markerIndex !== markerIndex)
      .map((x) => (x.markerIndex > markerIndex ? { ...x, markerIndex: x.markerIndex - 1 } : x));

    setArticleWithMarkers(nextArticleWithMarkers);
    setMarkers(nextMarkers);
    setMarkerRunItems(nextRunItems);

    if (nextMarkers.length === 0) {
      setPhase(1); // Editing
    }
  };

  const handleExport = async () => {
    try {
      // 使用与预览相同的逻辑：精确替换标记为图片
      const base = String(articleWithMarkers || articleContent || '');
      if (!base) {
        toast.error('导出失败', '文章内容为空');
        return;
      }

      const byIndex = new Map<number, MarkerRunItem>(markerRunItems.map((x) => [x.markerIndex, x]));
      const patches: Array<{ start: number; end: number; replacement: string }> = [];

      // 遍历所有标记，将已完成的配图替换为图片 Markdown
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const it = byIndex.get(m.index);
        if (!it) continue;

        const url =
          String(it.assetUrl || it.url || '').trim() ||
          (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');

        if (url && it.status === 'done') {
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `![配图 ${i + 1}](${url})`,
          });
        }
      }

      // 从后往前替换，避免偏移
      patches.sort((a, b) => b.start - a.start);
      let contentWithImages = base;
      for (const p of patches) {
        contentWithImages = contentWithImages.slice(0, p.start) + p.replacement + contentWithImages.slice(p.end);
      }

      // 如果没有任何替换，提示用户
      if (patches.length === 0) {
        const ok = await systemDialog.confirm({
          title: '确认导出',
          message: '当前没有已完成的配图，是否导出原始文章（包含 [插图] 标记）？',
        });
        if (!ok) return;
        contentWithImages = base;
      }

      setArticleWithImages(contentWithImages);

      // 创建下载链接
      const blob = new Blob([contentWithImages], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${uploadedFileName || '文章配图'}.md`;
      link.click();
      URL.revokeObjectURL(url);

      toast.success('导出成功', `已导出 ${patches.length} 张配图到文章中`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('导出失败');
    }
  };

  // 创建新提示词模板
  const [creatingPrompt, setCreatingPrompt] = useState<{ title: string; content: string } | null>(null);
  // 小屏：编辑/预览切换；大屏：左右分栏同时显示
  const [promptPanel, setPromptPanel] = useState<'edit' | 'preview'>('edit');

  const handleCreatePrompt = () => {
    setPromptPanel('edit');
    setCreatingPrompt({
      title: '',
      content: '',
    });
  };

  const handleSaveNewPrompt = async () => {
    if (!creatingPrompt) return;

    try {
      const res = await createLiteraryPrompt({
        title: creatingPrompt.title,
        content: creatingPrompt.content,
        scenarioType: 'article-illustration',
      });

      if (res.success && res.data?.prompt) {
        const newPrompt: PromptTemplate = {
          id: res.data.prompt.id,
          title: res.data.prompt.title,
          content: res.data.prompt.content,
          isSystem: res.data.prompt.isSystem,
          scenarioType: res.data.prompt.scenarioType,
          order: res.data.prompt.order,
        };

        const updated = [...userPrompts, newPrompt];
        setUserPrompts(updated);
        setSelectedPrompt(newPrompt);
        setCreatingPrompt(null);
      } else {
        toast.error('创建失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to create prompt:', error);
      toast.error('创建失败');
    }
  };

  const handleCancelCreate = () => {
    setCreatingPrompt(null);
  };

  // 编辑提示词模板
  const [editingPrompt, setEditingPrompt] = useState<{ id: string; title: string; content: string } | null>(null);

  const handleEditPrompt = (prompt: PromptTemplate) => {
    setPromptPanel('edit');
    setEditingPrompt({
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
    });
  };

  const handleSaveEdit = async () => {
    if (!editingPrompt) return;

    try {
      const res = await updateLiteraryPrompt({
        id: editingPrompt.id,
        title: editingPrompt.title,
        content: editingPrompt.content,
      });

      if (res.success && res.data?.prompt) {
        const updated = userPrompts.map((p) =>
          p.id === editingPrompt.id
            ? {
                ...p,
                title: res.data.prompt.title,
                content: res.data.prompt.content,
                order: res.data.prompt.order,
              }
            : p
        );
        setUserPrompts(updated);

        if (selectedPrompt?.id === editingPrompt.id) {
          setSelectedPrompt({ ...selectedPrompt, title: editingPrompt.title, content: editingPrompt.content });
        }

        setEditingPrompt(null);
      } else {
        toast.error('保存失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to update prompt:', error);
      toast.error('保存失败');
    }
  };

  const handleCancelEdit = () => {
    setEditingPrompt(null);
  };

  // AI 优化：提取旧提示词中的风格描述，去除格式指令
  const handleOptimizePrompt = async (mode: 'edit' | 'create') => {
    const content = mode === 'edit' ? editingPrompt?.content : creatingPrompt?.content;
    if (!content?.trim()) {
      toast.warning('请先输入内容');
      return;
    }
    const targetId = mode === 'edit' ? editingPrompt?.id ?? 'new' : 'new';
    setOptimizingPromptId(targetId);
    try {
      const res = await optimizeLiteraryPrompt({ content });
      if (res.success && res.data?.optimizedContent) {
        if (mode === 'edit' && editingPrompt) {
          setEditingPrompt({ ...editingPrompt, content: res.data.optimizedContent });
        } else if (mode === 'create' && creatingPrompt) {
          setCreatingPrompt({ ...creatingPrompt, content: res.data.optimizedContent });
        }
        toast.success('已提取风格描述');
      } else {
        toast.error('优化失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Optimize prompt error:', error);
      toast.error('优化失败');
    } finally {
      setOptimizingPromptId(null);
    }
  };

  // 删除提示词模板
  const handleDeletePrompt = async (prompt: PromptTemplate) => {
    if (prompt.isSystem) {
      toast.warning('系统预置模板不可删除');
      return;
    }

    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除模板「${prompt.title}」吗？`,
      tone: 'danger',
    });
    if (!ok) return;

    // 已发布到海鲜市场的配置需要二次确认
    if (prompt.isPublic) {
      const doubleConfirmed = await systemDialog.confirm({
        title: '⚠️ 该配置已发布到海鲜市场',
        message: '删除后其他用户将无法再下载此配置，确定要删除吗？',
        tone: 'danger',
        confirmText: '确认删除',
        cancelText: '取消',
      });
      if (!doubleConfirmed) return;
    }

    try {
      const res = await deleteLiteraryPrompt({ id: prompt.id });

      if (res.success) {
        const updated = userPrompts.filter((p) => p.id !== prompt.id);
        setUserPrompts(updated);

        if (selectedPrompt?.id === prompt.id) {
          setSelectedPrompt(updated.length > 0 ? updated[0] : null);
        }
      } else {
        toast.error('删除失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to delete prompt:', error);
      toast.error('删除失败');
    }
  };

  // 发布提示词到海鲜市场
  const handlePublishPrompt = async (prompt: PromptTemplate) => {
    try {
      const res = await publishLiteraryPrompt({ id: prompt.id });
      if (res.success) {
        // 更新本地状态
        setUserPrompts((prev) =>
          prev.map((p) =>
            p.id === prompt.id ? { ...p, isPublic: true, forkCount: res.data.prompt.forkCount ?? 0 } : p
          )
        );
        toast.success('发布成功', '配置已发布到海鲜市场');
      } else {
        toast.error('发布失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to publish prompt:', error);
      toast.error('发布失败');
    }
  };

  // 取消发布提示词
  const handleUnpublishPrompt = async (prompt: PromptTemplate) => {
    const ok = await systemDialog.confirm({
      title: '确认取消发布',
      message: `确定要取消发布「${prompt.title}」吗？取消后其他用户将无法看到此配置。`,
      tone: 'neutral',
    });
    if (!ok) return;

    try {
      const res = await unpublishLiteraryPrompt({ id: prompt.id });
      if (res.success) {
        // 更新本地状态
        setUserPrompts((prev) =>
          prev.map((p) =>
            p.id === prompt.id ? { ...p, isPublic: false } : p
          )
        );
        toast.success('已取消发布');
      } else {
        toast.error('取消发布失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to unpublish prompt:', error);
      toast.error('取消发布失败');
    }
  };

  // 发布风格图到海鲜市场
  const handlePublishRefConfig = async (config: ReferenceImageConfig) => {
    try {
      const res = await publishReferenceImageConfig({ id: config.id });
      if (res.success) {
        await loadReferenceImageConfigs();
        toast.success('发布成功', '配置已发布到海鲜市场');
      } else {
        toast.error('发布失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to publish reference image config:', error);
      toast.error('发布失败');
    }
  };

  // 取消发布风格图
  const handleUnpublishRefConfig = async (config: ReferenceImageConfig) => {
    const ok = await systemDialog.confirm({
      title: '确认取消发布',
      message: `确定要取消发布「${config.name}」吗？取消后其他用户将无法看到此配置。`,
      tone: 'neutral',
    });
    if (!ok) return;

    try {
      const res = await unpublishReferenceImageConfig({ id: config.id });
      if (res.success) {
        await loadReferenceImageConfigs();
        toast.success('已取消发布');
      } else {
        toast.error('取消发布失败', res.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Failed to unpublish reference image config:', error);
      toast.error('取消发布失败');
    }
  };

  const buttonConfig = [
    {
      label: '生成配图标记',
      action: handleGenerateMarkers,
      icon: Wand2,
      disabled: !articleContent.trim(),
      show: phase === 1, // Editing
    },
    {
      label: '生成配图标记中...',
      action: async () => {},
      icon: Wand2,
      disabled: true,
      show: false, // 3 状态模式：无 MarkersGenerating 中间态
    },
    {
      label: '一键生图',
      action: handleBatchGenerate,
      icon: Sparkles,
      disabled: !imageGenModel || isBusy,
      show: phase === 2 && markerRunItems.filter(x => x.status === 'done').length === 0, // MarkersGenerated
    },
    {
      label: '一键导出',
      action: handleExport,
      icon: Download,
      disabled: false,
      show: phase === 2 && markerRunItems.filter(x => x.status === 'done').length > 0, // MarkersGenerated
    },
  ];

  const activeButton = buttonConfig.find((btn) => btn.show);

  // 左侧统一作为"预览面板"：上传时渲染原文；AI 流式生成时直接渲染带标记版本
  const leftPreviewMarkdown =
    phase === 2 // MarkersGenerated
      ? (articleWithImages || articleWithMarkers || articleContent)
      : articleContent;

  const markerRegex = /\[插图\]\s*:\s*([^\n]+)/g;
  const highlightText = (text: string) => {
    const out: Array<string | JSX.Element> = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let markerOrdinal = 0;
    markerRegex.lastIndex = 0;
    while ((m = markerRegex.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (start > last) out.push(text.slice(last, start));
      // 流式生成中的 marker 使用带动画的 class
      const isNew = markerStreaming;
      out.push(
        <mark key={`m-${markerOrdinal++}-${start}`} className={isNew ? 'prd-md-marker-new' : 'prd-md-marker'}>
          {m[0]}
        </mark>
      );
      last = end;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const highlightChildren = (children: React.ReactNode): React.ReactNode => {
    if (typeof children === 'string') return <>{highlightText(children)}</>;
    if (Array.isArray(children)) return <>{children.map((c, i) => <span key={i}>{highlightChildren(c)}</span>)}</>;
    if (React.isValidElement(children)) {
      const type = children.type;
      // 不在 code/pre 内做高亮，避免破坏代码块内容
      if (type === 'code' || type === 'pre') return children;
      const next = highlightChildren(children.props.children);
      return React.cloneElement(children, { ...children.props, children: next });
    }
    return children;
  };

  const phaseSteps: Array<{ key: WorkflowPhase; label: string }> = [
    { key: 0, label: '上传' },
    { key: 1, label: '预览' },
    { key: 2, label: '配图标记' },
  ];

  const configPillBaseClass =
    'flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer transition-colors hover:bg-white/10 min-w-0 flex-1';
  const configPillTextClass = 'text-[11px] truncate';

  const handleStepClick = async (stepKey: number) => {
    const targetPhase = stepKey as WorkflowPhase;
    if (targetPhase === phase || isBusy) return;

    // 简单切换阶段（不做复杂的服务端校验）
    setPhase(targetPhase);
  };


  return (
    <div className={cn("h-full min-h-0 flex", isMobile ? "flex-col gap-3" : "gap-4")}>
      {/* 移动端标签栏 */}
      {isMobile && (
        <div className="flex-shrink-0 flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-default)' }}>
          <button
            className={cn(
              "flex-1 px-4 py-2 text-sm font-medium transition-colors",
              mobileTab === 'article'
                ? "text-white"
                : "text-[var(--text-muted)]"
            )}
            style={mobileTab === 'article' ? { background: 'var(--accent-primary)' } : { background: 'var(--panel)' }}
            onClick={() => setMobileTab('article')}
          >
            文章预览
          </button>
          <button
            className={cn(
              "flex-1 px-4 py-2 text-sm font-medium transition-colors",
              mobileTab === 'markers'
                ? "text-white"
                : "text-[var(--text-muted)]"
            )}
            style={mobileTab === 'markers' ? { background: 'var(--accent-primary)' } : { background: 'var(--panel)' }}
            onClick={() => setMobileTab('markers')}
          >
            配图工作台
          </button>
        </div>
      )}
      {/* 左侧：文章编辑器 */}
      <div className={cn("flex-1 min-w-0 flex flex-col gap-4", isMobile && mobileTab !== 'article' && "hidden")}>
        <GlassCard animated glow className="flex-1 min-h-0 flex flex-col">
          {/* 精简头部：标题 + 模型信息 */}
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="返回"
              >
                <ArrowLeft size={16} />
              </button>
              <div className="flex items-center gap-2">
                <FileText size={16} style={{ color: 'var(--text-primary)' }} />
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {uploadedFileName || '文章内容'}
                </div>
              </div>
              
              {/* 模型切换器：提示词模型 + 生图模型 */}
              <div className="flex items-center gap-1.5">
                {/* 提示词/标记生成模型切换器 */}
                {effectiveChatModel?.isAutoResolved ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 h-6 text-[10px] font-medium truncate max-w-[180px]"
                    style={{
                      background: 'rgba(99, 102, 241, 0.08)',
                      border: '1px solid rgba(99, 102, 241, 0.25)',
                      color: 'rgba(129, 140, 248, 0.75)',
                    }}
                    title={`自动调度: ${effectiveChatModel.name}`}
                  >
                    <Sparkles size={10} className="shrink-0" />
                    <span className="truncate">自动: {effectiveChatModel.name}</span>
                  </span>
                ) : (
                <DropdownMenu.Root open={chatModelPrefOpen} onOpenChange={setChatModelPrefOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full px-2 h-6 text-[10px] font-medium truncate max-w-[180px] cursor-pointer hover:opacity-80 transition-opacity"
                      style={{
                        background: effectiveChatModel ? 'rgba(99, 102, 241, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        border: effectiveChatModel ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)',
                        color: effectiveChatModel ? 'rgba(129, 140, 248, 0.95)' : 'rgba(248, 113, 113, 0.95)',
                      }}
                      title={effectiveChatModel ? `${effectiveChatModel.name} - 点击切换提示词模型` : '选择提示词模型'}
                    >
                      <Sparkles size={10} className="shrink-0" />
                      <span className="truncate">{effectiveChatModel?.name || '选择模型'}</span>
                      <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="bottom"
                      align="start"
                      sideOffset={6}
                      className="z-50 rounded-[12px] p-2.5"
                      style={{ width: 300, maxWidth: 'min(92vw, 300px)', ...glassPanel }}
                    >
                      <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                        文生提示词模型
                      </div>
                      {enabledChatModels.length === 0 ? (
                        <div className="text-[12px] py-2" style={{ color: 'var(--text-muted)' }}>暂无可用模型池</div>
                      ) : (
                        <div className="space-y-1.5 max-h-[280px] overflow-auto">
                          {enabledChatModels.map((m) => {
                            const picked = effectiveChatModel?.id === m.id;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                className="w-full text-left rounded-[10px] px-2.5 py-1.5 hover:bg-white/5 transition-colors"
                                style={{
                                  border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.08)',
                                  background: picked ? 'rgba(250,204,21,0.06)' : 'rgba(255,255,255,0.02)',
                                }}
                                onClick={() => { setChatModelPrefId(m.id); setChatModelPrefOpen(false); }}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.name || m.modelName}</div>
                                  </div>
                                  <span className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full" style={{
                                    background: picked ? 'rgba(250,204,21,0.18)' : 'rgba(255,255,255,0.04)',
                                    border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.10)',
                                    color: picked ? 'rgba(250,204,21,0.95)' : 'rgba(255,255,255,0.28)',
                                  }}><Check size={12} /></span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                )}

                {/* 生图模型切换器：有可选模型池时显示下拉；无池但有自动解析模型时显示只读标签 */}
                {effectiveModel?.isAutoResolved ? (
                  // 自动解析模型：只读显示，无下拉（Worker 自行 resolve，不需用户选择）
                  <div
                    className="inline-flex items-center gap-1 rounded-full px-2 h-6 text-[10px] font-medium truncate max-w-[180px]"
                    style={{
                      background: 'rgba(34, 197, 94, 0.08)',
                      border: '1px solid rgba(34, 197, 94, 0.25)',
                      color: 'rgba(74, 222, 128, 0.8)',
                    }}
                    title={`自动调度: ${effectiveModel.name}（无专属模型池时 Gateway 自动选择）`}
                  >
                    <Sparkles size={10} className="shrink-0" />
                    <span className="truncate">自动: {effectiveModel.name}</span>
                  </div>
                ) : (
                <DropdownMenu.Root open={imageModelPrefOpen} onOpenChange={setImageModelPrefOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full px-2 h-6 text-[10px] font-medium truncate max-w-[180px] cursor-pointer hover:opacity-80 transition-opacity"
                      style={{
                        background: effectiveModel ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        border: effectiveModel ? '1px solid rgba(34, 197, 94, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)',
                        color: effectiveModel ? 'rgba(74, 222, 128, 0.95)' : 'rgba(248, 113, 113, 0.95)',
                      }}
                      title={effectiveModel ? `${effectiveModel.name} - 点击切换生图模型` : '选择生图模型'}
                    >
                      <Sparkles size={10} className="shrink-0" />
                      <span className="truncate">{effectiveModel?.name || '选择模型'}</span>
                      <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="bottom"
                      align="start"
                      sideOffset={6}
                      className="z-50 rounded-[12px] p-2.5"
                      style={{ width: 300, maxWidth: 'min(92vw, 300px)', ...glassPanel }}
                    >
                      <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                        生图模型
                      </div>
                      {enabledImageModels.length === 0 ? (
                        <div className="text-[12px] py-2" style={{ color: 'var(--text-muted)' }}>暂无可用模型池</div>
                      ) : (
                        <div className="space-y-1.5 max-h-[280px] overflow-auto">
                          {enabledImageModels.map((m) => {
                            const picked = effectiveModel?.id === m.id;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                className="w-full text-left rounded-[10px] px-2.5 py-1.5 hover:bg-white/5 transition-colors"
                                style={{
                                  border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.08)',
                                  background: picked ? 'rgba(250,204,21,0.06)' : 'rgba(255,255,255,0.02)',
                                }}
                                onClick={() => { setImageModelPrefId(m.id); setImageModelPrefOpen(false); }}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.name || m.modelName}</div>
                                  </div>
                                  <span className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-full" style={{
                                    background: picked ? 'rgba(250,204,21,0.18)' : 'rgba(255,255,255,0.04)',
                                    border: picked ? '1px solid rgba(250,204,21,0.35)' : '1px solid rgba(255,255,255,0.10)',
                                    color: picked ? 'rgba(250,204,21,0.95)' : 'rgba(255,255,255,0.28)',
                                  }}><Check size={12} /></span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                )}

                {/* 生图错误提示（无池且未能预解析时才显示） */}
                {imageGenModelError && enabledImageModels.length === 0 && !autoResolvedModel && (
                  <div className="text-[10px] px-1.5 py-0.5 rounded text-red-400 bg-red-500/10">
                    生图不可用
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {phase === 0 && uploadedFileName && (
                <Button size="sm" variant="primary" onClick={handleEnterPreview}>
                  <Edit2 size={14} />
                  进入预览
                </Button>
              )}
              <button
                type="button"
                onClick={() => setAutoSubmitEnabled((v) => !v)}
                className="h-7 px-2 inline-flex items-center gap-1 rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0 text-xs"
                style={{
                  color: submissionState.submitted ? 'rgba(16, 185, 129, 0.8)' : autoSubmitEnabled ? 'rgba(16, 185, 129, 0.6)' : 'var(--text-muted)',
                  background: submissionState.submitted ? 'rgba(16, 185, 129, 0.1)' : autoSubmitEnabled ? 'rgba(16, 185, 129, 0.05)' : 'transparent',
                  border: submissionState.submitted ? '1px solid rgba(16, 185, 129, 0.2)' : autoSubmitEnabled ? '1px solid rgba(16, 185, 129, 0.15)' : '1px solid transparent',
                }}
                title={submissionState.submitted ? '已投稿到作品广场' : autoSubmitEnabled ? '自动投稿已开启，生成配图后自动投稿到作品广场' : '自动投稿已关闭，点击开启'}
              >
                <Send size={13} />
                <span>{submissionState.submitted ? '已投稿' : autoSubmitEnabled ? '投稿' : '投稿关'}</span>
              </button>
              {!submissionState.submitted && (
                <button
                  type="button"
                  onClick={handleManualSubmit}
                  disabled={manualSubmitting}
                  className="h-7 px-2 inline-flex items-center gap-1 rounded-md transition-colors duration-200 hover:bg-white/10 shrink-0 text-xs"
                  style={{
                    color: 'rgba(59, 130, 246, 0.8)',
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(59, 130, 246, 0.15)',
                    opacity: manualSubmitting ? 0.5 : 1,
                  }}
                  title="手动将当前作品投稿到作品广场"
                >
                  <Send size={13} />
                  <span>{manualSubmitting ? '投稿中…' : '投稿当前'}</span>
                </button>
              )}
            </div>
          </div>

          <div 
            ref={articlePreviewRef}
            className="flex-1 min-h-0 overflow-auto relative"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <style>{PRD_MD_STYLE}</style>
            
            {/* 拖拽悬浮提示层 */}
            {isDragging && (
              <div 
                className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
                style={{
                  ...glassBadge,
                  background: 'rgba(147, 197, 253, 0.15)',
                  border: '2px dashed rgba(147, 197, 253, 0.6)',
                }}
              >
                <div className="text-center">
                  <Upload size={64} style={{ color: 'rgba(147, 197, 253, 0.95)' }} className="mx-auto mb-4" />
                  <div className="text-lg font-semibold mb-2" style={{ color: 'rgba(147, 197, 253, 0.95)' }}>
                    释放以上传文件
                  </div>
                  <div className="text-sm" style={{ color: 'rgba(147, 197, 253, 0.75)' }}>
                    支持 .md 和 .txt 格式
                  </div>
                </div>
              </div>
            )}
            
            {/* 上传阶段：显示上传区域或已上传文件信息 */}
            {phase === 0 && !uploadedFileName && ( // Upload
              <div className="h-full flex flex-col items-center justify-center p-8">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.mdc,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="text-center">
                  <Upload size={48} className="mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                  <div className="text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
                    上传文章文件
                  </div>
                  <Button variant="primary" onClick={handleUploadClick}>
                    <Upload size={16} />
                    选择文件
                  </Button>
                  <div className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                    支持 .md 和 .txt 格式
                  </div>
                </div>
              </div>
            )}
            
            {/* 上传阶段：已有文件 */}
            {phase === 0 && uploadedFileName && ( // Upload
              <div className="h-full flex flex-col items-center justify-center p-8">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.mdc,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="text-center">
                  <FileText size={48} className="mx-auto mb-4" style={{ color: 'var(--accent-primary)' }} />
                  <div className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>
                    {uploadedFileName}
                  </div>
                  <div className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                    {articleContent.length} 字符
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={handleUploadClick}>
                      <Upload size={16} />
                      重新上传
                    </Button>
                    <Button variant="primary" onClick={handleEnterPreview}>
                      <Edit2 size={16} />
                      进入预览
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 预览阶段：按段落渲染，左侧 gutter 可打锚点，右键菜单可在上/下方插入配图 */}
            {phase === 1 && ( // Editing
              <div className="p-4 relative">
                {/* 策略引导横幅：user-anchor 但还没锚点时提示用户怎么打 */}
                {positionStrategy === 'user-anchor' &&
                  !splitParagraphs(articleContent).some(isAnchorParagraph) &&
                  articleContent.trim() && (
                  <div
                    className="mb-3 rounded-xl px-3 py-2.5 flex items-center gap-2"
                    style={{
                      background: 'linear-gradient(135deg, rgba(52,211,153,0.10) 0%, rgba(147,197,253,0.06) 100%)',
                      border: '1px dashed rgba(52,211,153,0.4)',
                    }}
                  >
                    <MapPin size={14} style={{ color: 'rgba(52,211,153,0.95)', flexShrink: 0 }} className="animate-pulse" />
                    <div className="text-[12px]" style={{ color: 'var(--text-primary)', lineHeight: 1.5 }}>
                      <strong>「尊重用户锚点」已启用</strong>，但还没打锚点。
                      <span style={{ color: 'var(--text-secondary)' }}>
                        把鼠标悬停在任一段落左侧 → 点绿色 <Plus size={10} className="inline" /> 加锚点；或在段落上右键选择"在上方/下方插入配图"。
                      </span>
                    </div>
                  </div>
                )}
                {/* 策略引导横幅：per-h1/per-h2 提示"会在这些位置插入" */}
                {(positionStrategy === 'per-h1' || positionStrategy === 'per-h2') && articleContent.trim() && (
                  <div
                    className="mb-3 rounded-xl px-3 py-2 flex items-center gap-2"
                    style={{
                      background: 'rgba(147,197,253,0.06)',
                      border: '1px solid rgba(147,197,253,0.2)',
                    }}
                  >
                    <ImageIcon size={13} style={{ color: 'rgba(147,197,253,0.95)', flexShrink: 0 }} />
                    <div className="text-[12px]" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      已切到「{POSITION_STRATEGY_OPTIONS.find(o => o.value === positionStrategy)?.label}」。
                      下面预览中每个灰色占位框就是生成后配图会插入的位置。
                    </div>
                  </div>
                )}

                <div className="prd-md">
                  {(() => {
                    const paragraphs = splitParagraphs(articleContent);
                    // Phase 1.6: 基于策略计算哪些段落后方需要渲染"配图占位"ghost
                    const ghostAfter = new Set<number>();
                    if (positionStrategy === 'per-h1') {
                      paragraphs.forEach((t, i) => { if (!isAnchorParagraph(t) && isBigHeadingParagraph(t)) ghostAfter.add(i); });
                    } else if (positionStrategy === 'per-h2') {
                      paragraphs.forEach((t, i) => { if (!isAnchorParagraph(t) && isSmallHeadingParagraph(t)) ghostAfter.add(i); });
                    }
                    return paragraphs.map((text, pIdx) => {
                      const anchored = isAnchorParagraph(text);
                      const prevIsAnchor = pIdx > 0 && isAnchorParagraph(paragraphs[pIdx - 1]);
                      const nextIsAnchor = pIdx < paragraphs.length - 1 && isAnchorParagraph(paragraphs[pIdx + 1]);
                      const hasAdjacentAnchor = prevIsAnchor || nextIsAnchor;
                      const showGhostAfter = ghostAfter.has(pIdx);

                      if (anchored) {
                        // 锚点占位：展示一个与生成后配图同尺寸的 ghost 预览 + 顶栏 pill（含移除）
                        return (
                          <div
                            key={`anchor-${pIdx}`}
                            className="my-3 rounded-xl overflow-hidden"
                            style={{
                              border: '2px dashed rgba(52, 211, 153, 0.5)',
                              background: 'linear-gradient(135deg, rgba(52,211,153,0.06) 0%, rgba(52,211,153,0.02) 100%)',
                            }}
                          >
                            <div
                              className="flex items-center justify-between px-3 py-1.5"
                              style={{ borderBottom: '1px dashed rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.08)' }}
                            >
                              <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'rgba(52,211,153,0.95)' }}>
                                <MapPin size={11} />
                                <span>此处将插入配图（1:1）</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAnchorParagraph(pIdx)}
                                className="opacity-70 hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px]"
                                title="移除此锚点"
                                style={{ color: 'rgba(52, 211, 153, 0.95)' }}
                              >
                                <Trash2 size={11} />
                                移除
                              </button>
                            </div>
                            {/* 与实际生成配图同尺寸的占位（默认 1:1） */}
                            <div
                              className="flex items-center justify-center"
                              style={{
                                width: '100%',
                                aspectRatio: '1 / 1',
                                maxWidth: 360,
                                margin: '12px auto',
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px dashed rgba(52,211,153,0.3)',
                                borderRadius: 8,
                              }}
                            >
                              <div className="flex flex-col items-center gap-1.5" style={{ color: 'rgba(52,211,153,0.6)' }}>
                                <ImageIcon size={28} />
                                <span className="text-[11px]">配图占位</span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <React.Fragment key={`p-${pIdx}`}>
                          <div
                            className="group relative flex items-stretch"
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setParagraphCtxMenu({
                                visible: true,
                                x: e.clientX,
                                y: e.clientY,
                                pIdx,
                                isAnchor: false,
                              });
                            }}
                          >
                            {/* 左侧 gutter：悬停显示"+"加锚点 */}
                            <button
                              type="button"
                              onClick={() => addAnchorAbove(pIdx)}
                              className="shrink-0 w-6 flex items-start justify-center pt-2 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="在此段上方插入配图锚点"
                              style={{ cursor: 'pointer' }}
                            >
                              <span
                                className="inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px]"
                                style={{
                                  background: 'rgba(52, 211, 153, 0.15)',
                                  color: 'rgba(52, 211, 153, 0.95)',
                                  border: '1px solid rgba(52, 211, 153, 0.4)',
                                }}
                              >
                                <Plus size={10} />
                              </span>
                            </button>

                            {/* 段落内容：相邻有锚点 → 边框高亮（"框框反应"） */}
                            <div
                              className="flex-1 min-w-0 rounded-md transition-all px-2 py-0.5"
                              style={{
                                border: hasAdjacentAnchor
                                  ? '1px solid rgba(52, 211, 153, 0.35)'
                                  : '1px solid transparent',
                                background: hasAdjacentAnchor ? 'rgba(52, 211, 153, 0.04)' : 'transparent',
                              }}
                            >
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkBreaks]}
                                rehypePlugins={[rehypeRaw]}
                                components={{
                                  p: ({ node: _node, children, ...props }) => <p {...props}>{highlightChildren(children)}</p>,
                                  li: ({ node: _node, children, ...props }) => <li {...props}>{highlightChildren(children)}</li>,
                                  blockquote: ({ node: _node, children, ...props }) => <blockquote {...props}>{highlightChildren(children)}</blockquote>,
                                  h1: ({ node: _node, children, ...props }) => <h1 {...props}>{highlightChildren(children)}</h1>,
                                  h2: ({ node: _node, children, ...props }) => <h2 {...props}>{highlightChildren(children)}</h2>,
                                  h3: ({ node: _node, children, ...props }) => <h3 {...props}>{highlightChildren(children)}</h3>,
                                }}
                              >
                                {text}
                              </ReactMarkdown>
                            </div>
                          </div>
                          {/* 策略预览 ghost：per-h1/per-h2 在相应标题段落后显示配图占位（1:1，与生成后尺寸一致） */}
                          {showGhostAfter && (
                            <div
                              className="my-3 rounded-xl"
                              style={{
                                border: '2px dashed rgba(147, 197, 253, 0.45)',
                                background: 'linear-gradient(135deg, rgba(147,197,253,0.06) 0%, rgba(147,197,253,0.02) 100%)',
                              }}
                            >
                              <div
                                className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-medium"
                                style={{
                                  color: 'rgba(147,197,253,0.95)',
                                  borderBottom: '1px dashed rgba(147,197,253,0.3)',
                                  background: 'rgba(147,197,253,0.06)',
                                }}
                              >
                                <ImageIcon size={11} />
                                <span>
                                  {positionStrategy === 'per-h1' ? '策略：每大标题一张 · 生成后配图将出现在此处' : '策略：每小标题一张 · 生成后配图将出现在此处'}
                                </span>
                              </div>
                              <div
                                className="flex items-center justify-center"
                                style={{
                                  width: '100%',
                                  aspectRatio: '1 / 1',
                                  maxWidth: 360,
                                  margin: '12px auto',
                                  background: 'rgba(255,255,255,0.03)',
                                  border: '1px dashed rgba(147,197,253,0.3)',
                                  borderRadius: 8,
                                }}
                              >
                                <div className="flex flex-col items-center gap-1.5" style={{ color: 'rgba(147,197,253,0.55)' }}>
                                  <ImageIcon size={28} />
                                  <span className="text-[11px]">配图占位（1:1）</span>
                                </div>
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      );
                    });
                  })()}
                </div>
                {/* 空态提示 */}
                {splitParagraphs(articleContent).length === 0 && (
                  <div className="text-[12px] py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    请先上传文章
                  </div>
                )}
              </div>
            )}

            {/* 标记生成中：全屏 AI 输出视图（Thinking + Raw Output） */}
            {phase === 2 && markerStreaming && (
              <div
                ref={thinkingPanelRef}
                className="h-full overflow-auto p-4"
              >
                {/* Thinking 区域 */}
                {thinkingContent && (
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{
                          background: 'rgba(168, 85, 247, 0.8)',
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }}
                      />
                      <span
                        className="text-[11px] font-semibold tracking-wide uppercase"
                        style={{ color: 'rgba(168, 85, 247, 0.85)' }}
                      >
                        Thinking
                      </span>
                    </div>
                    <div
                      className="rounded-xl px-3 py-2 text-[12px] leading-relaxed prd-md"
                      style={{
                        background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.08) 0%, rgba(99, 102, 241, 0.06) 100%)',
                        border: '1px solid rgba(168, 85, 247, 0.15)',
                        color: 'rgba(255, 255, 255, 0.7)',
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {thinkingContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}

                {/* Raw LLM 输出区域 */}
                {rawMarkerOutput && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{
                          background: 'rgba(99, 102, 241, 0.8)',
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }}
                      />
                      <span
                        className="text-[11px] font-semibold tracking-wide uppercase"
                        style={{ color: 'rgba(99, 102, 241, 0.85)' }}
                      >
                        Output
                      </span>
                    </div>
                    <pre
                      className="rounded-xl px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono"
                      style={{
                        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(34, 197, 94, 0.06) 100%)',
                        border: '1px solid rgba(99, 102, 241, 0.15)',
                        color: 'rgba(147, 197, 253, 0.75)',
                        margin: 0,
                      }}
                    >
                      {rawMarkerOutput}
                    </pre>
                  </div>
                )}

                {/* 空状态：等待 LLM 响应 */}
                {!thinkingContent && !rawMarkerOutput && (
                  <div className="h-full flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <MapSpinner size={28} color="rgba(168, 85, 247, 0.6)" />
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>等待 AI 响应…</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 标记生成完成：文章预览视图 */}
            {phase === 2 && !markerStreaming && (
              <div className="p-4 relative" style={{ '--img-display-size': `${imageDisplaySize}%` } as React.CSSProperties}>
                {/* 图片显示尺寸控制 - 右上角浮动 */}
                {markerRunItems.some(x => x.assetUrl || x.url || x.base64) && (
                  <div
                    className="sticky top-2 float-right z-10 flex items-center gap-0.5 rounded-lg px-1.5 py-1"
                    style={{
                      ...glassFloatingButton,
                      background: 'rgba(0,0,0,0.55)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    <ImageIcon size={11} style={{ color: 'var(--text-muted)', marginRight: 2 }} />
                    {[30, 50, 75, 100].map(size => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setImageDisplaySize(size)}
                        className="px-1.5 py-0.5 text-[10px] rounded transition-colors"
                        style={{
                          background: imageDisplaySize === size ? 'rgba(147, 197, 253, 0.2)' : 'transparent',
                          color: imageDisplaySize === size ? '#93C5FD' : 'rgba(255,255,255,0.45)',
                          border: imageDisplaySize === size ? '1px solid rgba(147, 197, 253, 0.3)' : '1px solid transparent',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {size}%
                      </button>
                    ))}
                  </div>
                )}

                {/* 折叠的思考面板 */}
                {thinkingContent && (
                  <details
                    className="mb-4 rounded-xl overflow-hidden"
                    style={{
                      background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.06) 0%, rgba(99, 102, 241, 0.04) 100%)',
                      border: '1px solid rgba(168, 85, 247, 0.15)',
                    }}
                  >
                    <summary
                      className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-[11px] font-semibold tracking-wide uppercase"
                      style={{ color: 'rgba(168, 85, 247, 0.7)' }}
                    >
                      Thinking
                    </summary>
                    <div
                      className="px-3 py-2 text-[12px] leading-relaxed prd-md"
                      style={{
                        color: 'rgba(255, 255, 255, 0.6)',
                        maxHeight: 200,
                        overflowY: 'auto',
                        borderTop: '1px solid rgba(168, 85, 247, 0.1)',
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {thinkingContent}
                      </ReactMarkdown>
                    </div>
                  </details>
                )}

                <div className="prd-md">
                  <ReactMarkdown
                    key="article-preview-main"
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    rehypePlugins={[rehypeRaw]}
                    components={{
                      p: ({ node: _node, children, ...props }) => <p {...props}>{highlightChildren(children)}</p>,
                      li: ({ node: _node, children, ...props }) => <li {...props}>{highlightChildren(children)}</li>,
                      blockquote: ({ node: _node, children, ...props }) => <blockquote {...props}>{highlightChildren(children)}</blockquote>,
                      h1: ({ node: _node, children, ...props }) => <h1 {...props}>{highlightChildren(children)}</h1>,
                      h2: ({ node: _node, children, ...props }) => <h2 {...props}>{highlightChildren(children)}</h2>,
                      h3: ({ node: _node, children, ...props }) => <h3 {...props}>{highlightChildren(children)}</h3>,
                    }}
                  >
                    {leftPreviewMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </GlassCard>
      </div>

      {/* 右侧：工作台 */}
      <div className={cn("flex flex-col gap-3", isMobile ? "w-full" : "w-96", isMobile && mobileTab !== 'markers' && "hidden")}>
        {/* 顶部：工作流进度 + 配置折叠区 */}
        <PanelCard>
          <WorkflowProgressBar
            steps={phaseSteps}
            currentStep={phase}
            onStepClick={handleStepClick}
            disabled={isBusy}
            allCompleted={
              phase === 2 &&
              markerRunItems.length > 0 &&
              markerRunItems.every(x => x.status === 'done')
            }
          />
          {activeButton && (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void activeButton.action()}
              disabled={isBusy || activeButton.disabled}
            >
              <activeButton.icon size={16} />
              {isBusy ? '生成中...' : activeButton.label}
            </Button>
          )}

          {/* 配置区 - 单行布局：齿轮 | 三个配置项 | 配置按钮 */}
          <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <Settings size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            
            {/* 三个配置项 */}
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {/* 提示词 */}
              <div
                className={configPillBaseClass}
                style={{
                  background: selectedPrompt ? 'rgba(147, 197, 253, 0.08)' : 'var(--nested-block-bg)',
                  border: selectedPrompt ? '1px solid rgba(147, 197, 253, 0.15)' : '1px solid var(--border-subtle)'
                }}
                onClick={() => {
                  if (selectedPrompt) handleEditPrompt(selectedPrompt);
                  else setPromptPreviewOpen(true);
                }}
                title={selectedPrompt?.title || '系统推断风格（点击自定义）'}
              >
                <FileText size={12} style={{ color: selectedPrompt ? '#93C5FD' : '#9CA3AF', flexShrink: 0 }} />
                <span className={configPillTextClass} style={{ color: selectedPrompt ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {selectedPrompt?.title || '自动风格'}
                </span>
              </div>
              {/* 风格图 */}
              <div
                className={configPillBaseClass}
                style={{ 
                  background: referenceImageConfigs.find(c => c.isActive) ? 'rgba(192, 132, 252, 0.08)' : 'var(--nested-block-bg)',
                  border: referenceImageConfigs.find(c => c.isActive) ? '1px solid rgba(192, 132, 252, 0.15)' : '1px solid var(--border-subtle)' 
                }}
                onClick={() => {
                  const activeRefConfig = referenceImageConfigs.find(c => c.isActive);
                  if (activeRefConfig) {
                    setEditingRefConfig({ ...activeRefConfig });
                    setEditingRefConfigOpen(true);
                  } else {
                    setPromptPreviewOpen(true);
                  }
                }}
                title={referenceImageConfigs.find(c => c.isActive)?.name || '未选择风格图'}
              >
                <ImageIcon size={12} style={{ color: referenceImageConfigs.find(c => c.isActive) ? '#C084FC' : '#9CA3AF', flexShrink: 0 }} />
                <span className={configPillTextClass} style={{ color: referenceImageConfigs.find(c => c.isActive) ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {referenceImageConfigs.find(c => c.isActive)?.name || '风格图'}
                </span>
              </div>
              {/* 水印 */}
              <div
                className={configPillBaseClass}
                style={{
                  background: watermarkStatus.enabled ? 'rgba(251, 191, 36, 0.08)' : 'var(--nested-block-bg)',
                  border: watermarkStatus.enabled ? '1px solid rgba(251, 191, 36, 0.15)' : '1px solid var(--border-subtle)'
                }}
                onClick={() => {
                  setPendingWatermarkEdit(true);
                  setPromptPreviewOpen(true);
                }}
                title={watermarkStatus.enabled ? (watermarkStatus.name || '已启用水印') : '未启用水印'}
              >
                <Sparkles size={12} style={{ color: watermarkStatus.enabled ? '#FBBF24' : '#9CA3AF', flexShrink: 0 }} />
                <span className={configPillTextClass} style={{ color: watermarkStatus.enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {watermarkStatus.enabled ? (watermarkStatus.name || '水印') : '水印'}
                </span>
              </div>
              {/* 位置策略（Phase 1） */}
              <DropdownMenu.Root open={positionStrategyOpen} onOpenChange={setPositionStrategyOpen}>
                <DropdownMenu.Trigger asChild>
                  <div
                    className={configPillBaseClass}
                    style={{
                      background: positionStrategy !== 'auto' ? 'rgba(52, 211, 153, 0.08)' : 'var(--nested-block-bg)',
                      border: positionStrategy !== 'auto' ? '1px solid rgba(52, 211, 153, 0.15)' : '1px solid var(--border-subtle)',
                    }}
                    title="配图位置策略：控制 AI 在哪些段落插入配图标记"
                  >
                    <MapPin size={12} style={{ color: positionStrategy !== 'auto' ? '#34D399' : '#9CA3AF', flexShrink: 0 }} />
                    <span className={configPillTextClass} style={{ color: positionStrategy !== 'auto' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {POSITION_STRATEGY_OPTIONS.find(o => o.value === positionStrategy)?.label ?? '自动'}
                    </span>
                  </div>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    className="z-50 rounded-[12px] p-2.5"
                    style={{ width: 260, maxWidth: 'min(92vw, 260px)', ...glassPanel }}
                  >
                    <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                      配图位置策略
                    </div>
                    <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      选择「尊重用户锚点」时，可在文章里用 <code style={{ background: 'rgba(255,255,255,0.08)', padding: '0 4px', borderRadius: 4 }}>[IMG]</code> 标出需要配图的位置。
                    </div>
                    <div className="space-y-1.5">
                      {POSITION_STRATEGY_OPTIONS.map((opt) => {
                        const picked = positionStrategy === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            className="w-full text-left rounded-[10px] px-2.5 py-1.5 hover:bg-white/5 transition-colors"
                            style={{
                              border: picked ? '1px solid rgba(52,211,153,0.35)' : '1px solid rgba(255,255,255,0.08)',
                              background: picked ? 'rgba(52,211,153,0.06)' : 'rgba(255,255,255,0.02)',
                            }}
                            onClick={() => {
                              setPositionStrategy(opt.value);
                              setPositionStrategyOpen(false);
                              // 用户选 user-anchor 时，若当前不在「预览」tab，自动跳过去便于打锚点
                              if (opt.value === 'user-anchor' && phase !== 1 && articleContent.trim()) {
                                setPhase(1);
                                toast.info('已切到「预览」页，可以开始打锚点了');
                              } else if (opt.value !== 'auto' && phase === 1) {
                                toast.info(`已切换到「${opt.label}」，预览中会显示配图占位`);
                              }
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
                              {picked && (
                                <Check size={12} style={{ color: 'rgba(52,211,153,0.95)', flexShrink: 0 }} />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>

            {/* 配置按钮 */}
            <button
              type="button"
              className="text-[11px] px-2.5 py-1 rounded-md hover:bg-white/10 transition-colors flex-shrink-0 border"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
              onClick={() => setPromptPreviewOpen(true)}
              title="打开全部配置"
            >
              配置
            </button>
          </div>
        </PanelCard>

        {/* 配图标记列表 */}
        {phase === 2 && (
          <PanelCard className="flex-1 min-h-0 flex flex-col">
            {/* 紧凑标题栏 */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>配图标记</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                  {markerRunItems.filter(x => x.status === 'done').length}/{markerRunItems.length}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="primary"
                  disabled={isBusy || !imageGenModel || markerRunItems.filter(x => x.status !== 'done' && x.status !== 'running').length === 0}
                  onClick={handleBatchGenerate}
                  title="生成未完成的配图"
                >
                  <Sparkles size={12} />
                  生成
                </Button>
                <BatchSizePicker
                  sizesByResolution={sizesByResolutionForPicker}
                  disabled={isBusy || markerRunItems.length === 0}
                  onApply={(size) => {
                    setMarkerRunItems((prev) =>
                      prev.map((x) => ({
                        ...x,
                        planItem: { ...(x.planItem || { prompt: x.draftText || x.markerText, count: 1 }), size },
                      }))
                    );
                    // 持久化所有 marker 的尺寸到后端
                    for (const item of markerRunItems) {
                      const planItem = item.planItem || { prompt: item.draftText || item.markerText, count: 1 };
                      void updateMarkerStatus(item.markerIndex, {
                        planItem: { prompt: planItem.prompt, count: planItem.count ?? 1, size },
                      });
                    }
                    toast.success('批量修改尺寸', `已将 ${markerRunItems.length} 张配图尺寸统一更新`);
                  }}
                />
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={markerRunItems.filter(x => x.status === 'done').length === 0}
                  onClick={async () => {
                      try {
                        const JSZip = (await import('jszip')).default;
                        const zip = new JSZip();
                        
                        const doneItems = markerRunItems.filter(x => x.status === 'done' && (x.assetUrl || x.url || x.base64));
                        
                        if (doneItems.length === 0) {
                          toast.warning('无可下载图片', '还没有已完成的配图');
                          return;
                        }
                        
                        let successCount = 0;
                        for (const item of doneItems) {
                          const src = item.assetUrl || item.url || (item.base64?.startsWith('data:') ? item.base64 : `data:image/png;base64,${item.base64}`) || '';
                          
                          if (!src) {
                            console.warn(`配图 ${item.markerIndex + 1} 没有图片数据`);
                            continue;
                          }
                          
                          try {
                            let blob: Blob;
                            
                            // 如果是 data URL（base64），直接转换为 blob
                            if (src.startsWith('data:')) {
                              const response = await fetch(src);
                              blob = await response.blob();
                            } else {
                              // 对于外部 URL，使用 Image + Canvas 方式绕过 CORS
                              blob = await new Promise<Blob>((resolve, reject) => {
                                const img = new Image();
                                img.crossOrigin = 'anonymous'; // 尝试启用 CORS
                                
                                img.onload = () => {
                                  try {
                                    // 创建 canvas 并绘制图片
                                    const canvas = document.createElement('canvas');
                                    canvas.width = img.naturalWidth;
                                    canvas.height = img.naturalHeight;
                                    const ctx = canvas.getContext('2d');
                                    if (!ctx) {
                                      reject(new Error('无法创建 canvas context'));
                                      return;
                                    }
                                    ctx.drawImage(img, 0, 0);
                                    
                                    // 转换为 blob
                                    canvas.toBlob((b) => {
                                      if (b) {
                                        resolve(b);
                                      } else {
                                        reject(new Error('Canvas toBlob 失败'));
                                      }
                                    }, 'image/png');
                                  } catch (error) {
                                    reject(error);
                                  }
                                };
                                
                                img.onerror = () => {
                                  reject(new Error('图片加载失败'));
                                };
                                
                                img.src = src;
                              });
                            }
                            
                            zip.file(`配图-${item.markerIndex + 1}.png`, blob);
                            successCount++;
                          } catch (error) {
                            console.error(`Failed to download image ${item.markerIndex + 1}:`, error);
                          }
                        }
                        
                        if (successCount === 0) {
                          toast.error('下载失败', '所有图片下载失败，可能是跨域限制导致');
                          return;
                        }
                        
                        const content = await zip.generateAsync({ type: 'blob' });
                        const link = document.createElement('a');
                        link.href = URL.createObjectURL(content);
                        link.download = `配图-${new Date().getTime()}.zip`;
                        link.click();
                        URL.revokeObjectURL(link.href);
                        
                        toast.success('下载完成', `已打包 ${successCount} 张图片${successCount < doneItems.length ? `（${doneItems.length - successCount} 张失败）` : ''}`);
                      } catch (error) {
                        console.error('Batch download failed:', error);
                        toast.error('下载失败', '批量下载图片时出错');
                      }
                    }}
                    title="下载所有已生成的图片（ZIP 格式）"
                  >
                    <DownloadCloud size={12} />
                    下载
                  </Button>
              </div>
            </div>

            <div ref={markerListRef} className="flex-1 min-h-0 overflow-auto space-y-3 pr-0.5">
              {/* 标记生成中的进度提示 */}
              {markerStreaming && (
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                  style={{
                    background: 'rgba(245, 158, 11, 0.08)',
                    border: '1px solid rgba(245, 158, 11, 0.2)',
                    color: 'rgba(245, 158, 11, 0.95)',
                    animation: 'pulse 2s ease-in-out infinite',
                  }}
                >
                  <MapSpinner size={14} />
                  <span>AI 正在分析文章并生成配图标记…已识别 {markerRunItems.length} 个位置</span>
                </div>
              )}
              {markerRunItems.map((it, idx) => {
                const statusLabel =
                  it.status === 'parsing'
                    ? '解析中'
                    : it.status === 'parsed'
                      ? '已解析'
                      : it.status === 'running'
                        ? '生成中'
                        : it.status === 'done'
                          ? '完成'
                          : it.status === 'error'
                            ? '失败'
                            : '等待';

                const src =
                  String(it.assetUrl || it.url || '').trim() ||
                  (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');
                const showPlaceholder = it.status === 'running' || it.status === 'parsing';
                const canShow = Boolean(src) && it.status === 'done';
                const hasImage = Boolean(String(it.assetUrl || it.url || '').trim() || it.base64);
                const genLabel = hasImage ? '重新生成' : '生成图片';
                const genTitle = hasImage ? '重新生成该配图（会替换左侧预览中的对应插图）' : '生成该配图（会插入左侧预览中对应 [插图] 位置）';

                const isGlowing = glowingMarkers.has(it.markerIndex);

                return (
                  <div
                    key={it.markerIndex}
                    className="surface-inset rounded-xl overflow-hidden"
                    style={{ position: 'relative' }}
                  >
                    {/* 入场发光边框动画 */}
                    {isGlowing && (
                      <div
                        className="marker-card-glow-entrance"
                        onAnimationEnd={() => {
                          setGlowingMarkers((prev) => {
                            const next = new Set(prev);
                            next.delete(it.markerIndex);
                            return next;
                          });
                        }}
                      />
                    )}

                    {/* ─── 图片区（所有控件 + prompt 文字浮在图片上）─── */}
                    <div
                      className="marker-card-wrap relative group"
                      style={{
                        aspectRatio: '4 / 3',
                        padding: '6px 6px 0',
                        background: 'rgba(0,0,0,0.22)',
                        cursor: canShow ? 'pointer' : 'default',
                      }}
                      onClick={() => {
                        if (!canShow) return;
                        const allImages = markerRunItems
                          .filter(x => x.assetUrl || x.url || x.base64)
                          .map((x, i) => ({
                            url: x.assetUrl || x.url || (x.base64?.startsWith('data:') ? x.base64 : `data:image/png;base64,${x.base64}`) || '',
                            alt: `配图 ${i + 1}`,
                          }));
                        const currentIdx = allImages.findIndex((_, i) => {
                          const item = markerRunItems.filter(x => x.assetUrl || x.url || x.base64)[i];
                          return item?.markerIndex === it.markerIndex;
                        });
                        setImagePreviewIndex(currentIdx >= 0 ? currentIdx : 0);
                        setImagePreviewOpen(true);
                      }}
                    >
                      {/* 图片内容 / 占位 / 加载动画 */}
                      {showPlaceholder ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                          {it.status === 'parsing' ? (
                            <>
                              <MapSpinner size={28} color="rgba(250, 204, 21, 0.7)" />
                              <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>解析尺寸…</span>
                            </>
                          ) : (
                            <div style={{ width: '100%', height: '100%', maxWidth: 120, maxHeight: 120, aspectRatio: '1' }}>
                              <PrdPetalBreathingLoader fill />
                            </div>
                          )}
                        </div>
                      ) : canShow ? (
                        <img src={src} alt={`img-${idx + 1}`} className="w-full h-full block rounded-lg" style={{ objectFit: 'contain' }} />
                      ) : (
                        (() => {
                          const cs = it.planItem?.size || '1024x1024';
                          const [cw, ch] = cs.split(/[xX×]/).map(Number);
                          const cRatio = (cw && ch) ? cw / ch : 1;
                          const containerH = 140;
                          const containerW = 280;
                          let previewW: number, previewH: number;
                          if (cRatio >= containerW / containerH) {
                            previewW = Math.min(containerW, 240);
                            previewH = Math.round(previewW / cRatio);
                          } else {
                            previewH = Math.min(containerH, 120);
                            previewW = Math.round(previewH * cRatio);
                          }
                          return (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                              <div
                                className="rounded-lg flex items-center justify-center"
                                style={{
                                  width: previewW,
                                  height: previewH,
                                  background: 'var(--nested-block-bg)',
                                  border: '1.5px dashed rgba(99, 102, 241, 0.3)',
                                  transition: 'width 0.2s, height 0.2s',
                                }}
                              >
                                <ImageIcon size={18} style={{ opacity: 0.4 }} />
                              </div>
                            </div>
                          );
                        })()
                      )}

                      {/* 浮层：顶部 - 标签 + 尺寸 + 状态 */}
                      <div
                        className="absolute top-0 left-0 right-0 flex items-center justify-between px-2 py-1.5"
                        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, transparent 100%)' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>
                          配图 {idx + 1}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <ImageSizePicker
                            sizesByResolution={sizesByResolutionForPicker}
                            value={it.planItem?.size || '1024x1024'}
                            onChange={(s) => {
                              const updatedPlanItem = { ...(it.planItem || { prompt: it.draftText || it.markerText, count: 1 }), size: s };
                              setMarkerRunItems((prev) =>
                                prev.map((x) =>
                                  x.markerIndex === it.markerIndex
                                    ? { ...x, planItem: updatedPlanItem }
                                    : x
                                )
                              );
                              void updateMarkerStatus(it.markerIndex, {
                                planItem: { prompt: updatedPlanItem.prompt, count: updatedPlanItem.count ?? 1, size: s },
                              });
                            }}
                            disabled={it.status === 'running' || it.status === 'parsing'}
                          />
                          <div
                            className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                            style={{
                              background:
                                it.status === 'done'
                                  ? 'rgba(34, 197, 94, 0.18)'
                                  : it.status === 'error'
                                    ? 'rgba(239, 68, 68, 0.18)'
                                    : it.status === 'running' || it.status === 'parsing'
                                      ? 'rgba(250, 204, 21, 0.18)'
                                      : 'rgba(255,255,255,0.1)',
                              border:
                                it.status === 'done'
                                  ? '1px solid rgba(34, 197, 94, 0.35)'
                                  : it.status === 'error'
                                    ? '1px solid rgba(239, 68, 68, 0.35)'
                                    : it.status === 'running' || it.status === 'parsing'
                                      ? '1px solid rgba(250, 204, 21, 0.3)'
                                      : '1px solid rgba(255,255,255,0.2)',
                              color:
                                it.status === 'done'
                                  ? 'rgba(34, 197, 94, 0.95)'
                                  : it.status === 'error'
                                    ? 'rgba(239, 68, 68, 0.95)'
                                    : it.status === 'running' || it.status === 'parsing'
                                      ? 'rgba(250, 204, 21, 0.95)'
                                      : 'rgba(255,255,255,0.7)',
                            }}
                            title={it.errorMessage || ''}
                          >
                            {statusLabel}
                          </div>
                        </div>
                      </div>

                      {/* 错误信息浮层 */}
                      {it.errorMessage ? (
                        <div
                          className="absolute text-[11px] px-2 py-1 rounded"
                          style={{
                            background: 'rgba(239,68,68,0.85)',
                            color: 'white',
                            bottom: 8,
                            left: 8,
                            right: 8,
                            zIndex: 2,
                          }}
                        >
                          {it.errorMessage}
                        </div>
                      ) : null}

                      {/* prompt 文字浮层：默认半可见，hover 全可见，点击编辑 */}
                      <div
                        className="marker-card-prompt-overlay"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingMarkerIdx(it.markerIndex);
                        }}
                        title="点击编辑提示词"
                      >
                        <div className="marker-card-prompt-text">
                          {it.draftText || it.markerText || '（暂无提示词，点击编辑）'}
                        </div>
                      </div>
                    </div>

                    {/* 操作按钮栏（图片下方独立行） */}
                    <div className="px-2.5 py-2 flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={it.status === 'running' || it.status === 'parsing'}
                          onClick={() => void handleDeleteMarker(it.markerIndex)}
                          title="删除该配图提示词（同时移除文章中的对应 [插图] 标记）"
                        >
                          <Trash2 size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => locateMarkerInPreview(it.markerIndex)}
                          title="定位到正文中的配图标记位置"
                        >
                          <MapPin size={14} />
                        </Button>
                        {canShow && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(src);
                                  toast.success('已复制', '图片链接已复制到剪贴板');
                                } catch (error) {
                                  console.error('Copy failed:', error);
                                }
                              }}
                              title="复制图片链接"
                            >
                              <Copy size={14} />
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={async () => {
                                try {
                                  const response = await fetch(src);
                                  const blob = await response.blob();
                                  const blobUrl = URL.createObjectURL(blob);
                                  const link = document.createElement('a');
                                  link.href = blobUrl;
                                  link.download = `配图-${idx + 1}.png`;
                                  link.click();
                                  URL.revokeObjectURL(blobUrl);
                                } catch (error) {
                                  console.error('Download failed:', error);
                                  const link = document.createElement('a');
                                  link.href = src;
                                  link.download = `配图-${idx + 1}.png`;
                                  link.target = '_blank';
                                  link.click();
                                }
                              }}
                              title="下载图片"
                            >
                              <DownloadCloud size={14} />
                            </Button>
                          </>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={it.status === 'running' || it.status === 'parsing' || !imageGenModel}
                        onClick={() => void handleRegenerateOne(it.markerIndex)}
                        title={genTitle}
                      >
                        <Sparkles size={14} />
                        {genLabel}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              点击“一键生图”将按顺序逐条解析 JSON 并生成图片；也可在单条卡片内编辑后重生成
            </div>
          </PanelCard>
        )}
      </div>

      {/* 配图 Prompt 编辑弹窗 */}
      {editingMarkerIdx !== null && (() => {
        const editItem = markerRunItems.find(x => x.markerIndex === editingMarkerIdx);
        if (!editItem) return null;
        const editIdx = markerRunItems.indexOf(editItem);
        return (
          <Dialog
            open
            onOpenChange={(open) => { if (!open) setEditingMarkerIdx(null); }}
            title={`编辑提示词 — 配图 ${editIdx + 1}`}
            maxWidth={640}
            content={
              <div className="flex flex-col gap-3">
                <textarea
                  autoFocus
                  value={editItem.draftText}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === editingMarkerIdx ? { ...x, draftText: v, planItem: null } : x)));
                  }}
                  className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-6 outline-none resize-none font-mono prd-field"
                  style={{ minHeight: 180 }}
                  placeholder="描述配图内容、风格、构图…"
                  disabled={editItem.status === 'running' || editItem.status === 'parsing'}
                />
                <div className="flex items-center justify-between gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditingMarkerIdx(null)}>
                    关闭
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={editItem.status === 'running' || editItem.status === 'parsing' || !imageGenModel}
                    onClick={() => {
                      setEditingMarkerIdx(null);
                      void handleRegenerateOne(editItem.markerIndex);
                    }}
                  >
                    <Sparkles size={14} />
                    {editItem.assetUrl || editItem.url || editItem.base64 ? '保存并重新生成' : '保存并生成图片'}
                  </Button>
                </div>
              </div>
            }
          />
        );
      })()}

      {/* 新建提示词对话框 */}
      <Dialog
        open={!!creatingPrompt}
        onOpenChange={(open) => !open && handleCancelCreate()}
        title="新建风格模板"
        description="输入模板名称和风格描述（系统指令由系统自动提供，此处只需描述配图风格偏好）"
        maxWidth={1040}
        content={
          creatingPrompt ? (
            <div className="h-full min-h-0 flex flex-col">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板名称
                  </label>
                  <input
                    type="text"
                    value={creatingPrompt.title}
                    onChange={(e) => setCreatingPrompt({ ...creatingPrompt, title: e.target.value })}
                    placeholder="例如：产品介绍"
                    className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field"
                    autoFocus
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant={promptPanel === 'edit' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('edit')}
                      >
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant={promptPanel === 'preview' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('preview')}
                      >
                        预览
                      </Button>
                    </div>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => void handleOptimizePrompt('create')}
                      disabled={!creatingPrompt.content?.trim() || optimizingPromptId === 'new'}
                      title="AI 自动提取风格描述，去除旧格式指令"
                    >
                      <Sparkles size={12} />
                      {optimizingPromptId === 'new' ? '优化中...' : 'AI 提取风格'}
                    </Button>
                  </div>

                  {/* 编辑模式：显示 textarea */}
                  {promptPanel === 'edit' && (
                    <textarea
                      value={creatingPrompt.content}
                      onChange={(e) => setCreatingPrompt({ ...creatingPrompt, content: e.target.value })}
                      placeholder="描述配图风格偏好，例如：水彩风格、暖色调、注重细节表现、偏向写实..."
                      rows={14}
                      className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                    />
                  )}

                  {/* 预览模式：显示 markdown 只读 */}
                  {promptPanel === 'preview' && (
                    <div
                      className="rounded-[14px] px-3 py-2.5 overflow-auto"
                      style={{
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid var(--border-subtle)',
                        maxHeight: '360px',
                      }}
                    >
                      <style>{`
                        .create-prompt-md { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
                        .create-prompt-md h1,.create-prompt-md h2,.create-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 12px 0 6px; }
                        .create-prompt-md h1 { font-size: 16px; }
                        .create-prompt-md h2 { font-size: 14px; }
                        .create-prompt-md h3 { font-size: 13px; }
                        .create-prompt-md p { margin: 6px 0; }
                        .create-prompt-md ul,.create-prompt-md ol { margin: 6px 0; padding-left: 18px; }
                        .create-prompt-md li { margin: 3px 0; }
                        .create-prompt-md code { font-family: ui-monospace, monospace; font-size: 12px; background: var(--bg-input-hover); border: 1px solid var(--border-default); padding: 0 4px; border-radius: 4px; }
                        .create-prompt-md pre { background: var(--nested-block-bg); border: 1px solid var(--border-default); border-radius: 8px; padding: 10px; overflow: auto; margin: 6px 0; }
                        .create-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                      `}</style>
                      <div className="create-prompt-md">
                        {creatingPrompt.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                            {creatingPrompt.content}
                          </ReactMarkdown>
                        ) : (
                          <div style={{ color: 'var(--text-muted)' }}>（输入内容后显示预览）</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={handleCancelCreate}>
                    取消
                  </Button>
                  <Button 
                    variant="primary" 
                    onClick={handleSaveNewPrompt}
                    disabled={!creatingPrompt.title.trim() || !creatingPrompt.content.trim()}
                  >
                    确认
                  </Button>
                </div>
              </div>
            </div>
          ) : null
        }
      />

      {/* 编辑提示词对话框 */}
      <Dialog
        open={!!editingPrompt}
        onOpenChange={(open) => !open && handleCancelEdit()}
        title="编辑风格模板"
        description="编辑标题和风格描述（系统指令由系统自动提供，此处只需描述配图风格偏好）"
        maxWidth={1040}
        content={
          editingPrompt ? (
            <div className="h-full min-h-0 flex flex-col">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板标题
                  </label>
                  <input
                    type="text"
                    value={editingPrompt.title}
                    onChange={(e) => setEditingPrompt({ ...editingPrompt, title: e.target.value })}
                    placeholder="输入模板标题..."
                    className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant={promptPanel === 'edit' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('edit')}
                      >
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant={promptPanel === 'preview' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('preview')}
                      >
                        预览
                      </Button>
                    </div>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => void handleOptimizePrompt('edit')}
                      disabled={!editingPrompt.content?.trim() || optimizingPromptId === editingPrompt.id}
                      title="AI 自动提取风格描述，去除旧格式指令"
                    >
                      <Sparkles size={12} />
                      {optimizingPromptId === editingPrompt.id ? '优化中...' : 'AI 提取风格'}
                    </Button>
                  </div>

                  {/* 编辑模式：显示 textarea */}
                  {promptPanel === 'edit' && (
                    <textarea
                      value={editingPrompt.content}
                      onChange={(e) => setEditingPrompt({ ...editingPrompt, content: e.target.value })}
                      placeholder="描述配图风格偏好，例如：水彩风格、暖色调、注重细节表现、偏向写实..."
                      rows={14}
                      className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                    />
                  )}

                  {/* 预览模式：显示 markdown 只读 */}
                  {promptPanel === 'preview' && (
                    <div
                      className="rounded-[14px] px-3 py-2.5 overflow-auto"
                      style={{
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid var(--border-subtle)',
                        maxHeight: '360px',
                      }}
                    >
                      <style>{`
                        .edit-prompt-md { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
                        .edit-prompt-md h1,.edit-prompt-md h2,.edit-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 12px 0 6px; }
                        .edit-prompt-md h1 { font-size: 16px; }
                        .edit-prompt-md h2 { font-size: 14px; }
                        .edit-prompt-md h3 { font-size: 13px; }
                        .edit-prompt-md p { margin: 6px 0; }
                        .edit-prompt-md ul,.edit-prompt-md ol { margin: 6px 0; padding-left: 18px; }
                        .edit-prompt-md li { margin: 3px 0; }
                        .edit-prompt-md code { font-family: ui-monospace, monospace; font-size: 12px; background: var(--bg-input-hover); border: 1px solid var(--border-default); padding: 0 4px; border-radius: 4px; }
                        .edit-prompt-md pre { background: var(--nested-block-bg); border: 1px solid var(--border-default); border-radius: 8px; padding: 10px; overflow: auto; margin: 6px 0; }
                        .edit-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                      `}</style>
                      <div className="edit-prompt-md">
                        {editingPrompt.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                            {editingPrompt.content}
                          </ReactMarkdown>
                        ) : (
                          <div style={{ color: 'var(--text-muted)' }}>（输入内容后显示预览）</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={handleCancelEdit}>
                    取消
                  </Button>
                  <Button 
                    variant="primary" 
                    onClick={handleSaveEdit}
                    disabled={!editingPrompt.title.trim() || !editingPrompt.content.trim()}
                  >
                    保存
                  </Button>
                </div>
              </div>
            </div>
          ) : null
        }
      />

      {/* 风格提示词、底图与水印配置对话框 */}
      <Dialog
        open={promptPreviewOpen}
        onOpenChange={(open) => {
          setPromptPreviewOpen(open);
          if (!open) setConfigViewMode('mine'); // 关闭时重置为"我的"视图
        }}
        title="配置管理"
        maxWidth={1500}
        contentClassName="overflow-hidden !p-4"
        contentStyle={{ maxHeight: '75vh', height: '75vh' }}
        titleCenter={
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setConfigViewMode('mine')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                configViewMode === 'mine' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5 text-gray-400'
              }`}
            >
              <User size={14} />
              我的
            </button>
            <button
              type="button"
              onClick={() => setConfigViewMode('marketplace')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                configViewMode === 'marketplace' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5 text-gray-400'
              }`}
            >
              <Globe size={14} />
              海鲜市场
            </button>
          </div>
        }
        content={
          <div className="flex flex-col h-full min-h-0">
            {/* 我的配置视图 */}
            {configViewMode === 'mine' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* 左侧：风格提示词 */}
            <div className="min-h-0 flex flex-col h-full">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  风格提示词
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    handleCreatePrompt();
                    // 不关闭配置管理弹窗，新建完成后仍可继续配置
                  }}
                >
                  <Plus size={12} />
                  新建
                </Button>
              </div>
              {allPrompts.length === 0 ? (
                <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                  未选择风格时系统将自动推断，点击上方「新建」可自定义风格
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-auto pr-1">
                  {!selectedPrompt && (
                    <div className="text-[11px] mb-2 px-2 py-1.5 rounded-md" style={{ background: 'rgba(34, 197, 94, 0.06)', border: '1px solid rgba(34, 197, 94, 0.15)', color: 'rgba(34, 197, 94, 0.85)' }}>
                      当前使用系统推断风格，可点击下方卡片选择自定义风格
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3">
                    {allPrompts.map((prompt) => {
                      const isPromptSelected = selectedPrompt?.id === prompt.id;
                      return (
                      <GlassCard
                        animated
                        glow
                        key={prompt.id}
                        className="p-0 overflow-hidden"
                        style={isPromptSelected ? {
                          border: '2px solid rgba(34, 197, 94, 0.8)',
                          boxShadow: '0 0 16px rgba(34, 197, 94, 0.3)',
                        } : undefined}
                      >
                        <div className="group relative flex flex-col h-full">
                          {/* 上栏：标题区 */}
                          <div className="p-2 pb-1 flex-shrink-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                <Sparkles size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
                                <div
                                  className="flex-1 font-semibold text-[13px]"
                                  title={prompt.title}
                                  style={{
                                    color: 'var(--text-primary)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0,
                                  }}
                                >
                                  {prompt.title}
                                </div>
                                {prompt.isSystem && (
                                  <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(251, 191, 36, 0.12)', color: 'rgba(251, 191, 36, 0.85)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
                                    系统
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 中栏：内容预览区（压缩高度以与风格图卡片等高） */}
                          <div className="px-2 pb-1 flex-shrink-0">
                            <div
                              className="overflow-auto border rounded-[6px]"
                              style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                                height: '100px',
                              }}
                            >
                              <style>{`
                                .modal-prompt-md { font-size: 11px; line-height: 1.4; color: var(--text-secondary); padding: 6px 8px; white-space: pre-wrap; }
                                .modal-prompt-md h1,.modal-prompt-md h2,.modal-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 4px 0 2px; }
                                .modal-prompt-md h1 { font-size: 12px; }
                                .modal-prompt-md h2 { font-size: 11px; }
                                .modal-prompt-md h3 { font-size: 11px; }
                                .modal-prompt-md p { margin: 2px 0; white-space: pre-wrap; }
                                .modal-prompt-md ul,.modal-prompt-md ol { margin: 2px 0; padding-left: 14px; }
                                .modal-prompt-md li { margin: 1px 0; }
                                .modal-prompt-md code { font-family: ui-monospace, monospace; font-size: 10px; background: var(--bg-input-hover); border: 1px solid var(--border-default); padding: 0 3px; border-radius: 3px; }
                                .modal-prompt-md pre { background: var(--nested-block-bg); border: 1px solid var(--border-default); border-radius: 4px; padding: 4px 6px; overflow: auto; margin: 2px 0; }
                                .modal-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                              `}</style>
                              <div className="modal-prompt-md">
                                {prompt.content ? (
                                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                    {prompt.content}
                                  </ReactMarkdown>
                                ) : (
                                  <div style={{ color: 'var(--text-muted)' }}>（内容为空）</div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 下栏：操作按钮区（图标化布局） */}
                          <div className="px-2 pb-2 pt-1 flex-shrink-0">
                            <div className="flex items-center gap-1 justify-between">
                              {/* 左侧：发布图标 + 下载次数 */}
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10 disabled:opacity-50"
                                  style={{
                                    color: prompt.isPublic ? 'rgba(251, 146, 60, 0.9)' : 'var(--text-muted)',
                                    background: prompt.isPublic ? 'rgba(251, 146, 60, 0.1)' : 'transparent',
                                  }}
                                  onClick={() => prompt.isPublic ? void handleUnpublishPrompt(prompt) : void handlePublishPrompt(prompt)}
                                  title={prompt.isPublic ? '点击取消发布' : '发布到海鲜市场'}
                                >
                                  <Share2 size={14} />
                                </button>
                                {/* 下载次数 */}
                                {typeof prompt.forkCount === 'number' && (
                                  <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    <GitFork size={10} />
                                    {prompt.forkCount}
                                  </span>
                                )}
                              </div>
                              {/* 右侧：选择 | 编辑/删除（用分隔线区分功能组） */}
                              <div className="flex items-center gap-1">
                                {/* 选择按钮 */}
                                <button
                                  type="button"
                                  className="px-2.5 py-1.5 rounded-md transition-all duration-200 hover:bg-white/10"
                                  style={{
                                    color: isPromptSelected ? 'white' : 'rgba(156, 163, 175, 0.6)',
                                    background: isPromptSelected ? 'rgba(34, 197, 94, 0.95)' : 'transparent',
                                    border: isPromptSelected ? '1px solid rgba(34, 197, 94, 0.95)' : 'none',
                                    minWidth: 40,
                                  }}
                                  onClick={() => setSelectedPrompt(isPromptSelected ? null : prompt)}
                                  title={isPromptSelected ? '取消选择（将使用系统推断风格）' : '选择此风格'}
                                >
                                  <CheckCircle2 size={16} />
                                </button>
                                {/* 分隔线 */}
                                <div className="h-4 w-px mx-0.5" style={{ background: 'var(--border-subtle)' }} />
                                {/* 编辑/删除按钮组 */}
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10"
                                  style={{ color: 'var(--text-muted)' }}
                                  onClick={() => handleEditPrompt(prompt)}
                                  title="编辑"
                                >
                                  <Edit2 size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-red-500/10"
                                  style={{ color: 'rgba(239, 68, 68, 0.7)' }}
                                  onClick={() => void handleDeletePrompt(prompt)}
                                  title="删除"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </GlassCard>
                    );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 中间：风格图设置 */}
            <div className="min-h-0 flex flex-col h-full border-l pl-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  风格图设置
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={referenceImageSaving}
                  onClick={() => referenceImageInputRef.current?.click()}
                >
                  <Plus size={12} />
                  新增配置
                </Button>
              </div>
              <input
                ref={referenceImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = '';
                  // 弹出输入框让用户输入名称
                  const name = await systemDialog.prompt({
                    title: '新建风格图配置',
                    message: '请输入配置名称（如"科技风格"、"水墨风格"等）',
                    defaultValue: `风格图配置 ${referenceImageConfigs.length + 1}`,
                  });
                  if (!name) return;
                  setReferenceImageSaving(true);
                  try {
                    const res = await createReferenceImageConfig({ name, file });
                    if (res.success && res.data?.config) {
                      await loadReferenceImageConfigs();
                      toast.success('风格图配置创建成功');
                    } else {
                      toast.error('创建失败', res.error?.message || '未知错误');
                    }
                  } finally {
                    setReferenceImageSaving(false);
                  }
                }}
              />
              <div className="flex-1 min-h-0 overflow-auto pr-1">
                {referenceImageLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
                  </div>
                ) : referenceImageConfigs.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4 h-full">
                    <div
                      className="w-16 h-16 rounded-xl flex items-center justify-center"
                      style={{ background: 'rgba(147, 197, 253, 0.08)', border: '1px dashed rgba(147, 197, 253, 0.25)' }}
                    >
                      <ImageIcon size={28} style={{ color: 'rgba(147, 197, 253, 0.5)' }} />
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      上传一张风格图后，生成的所有图片都会参考此图的风格。
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    {referenceImageConfigs.map((config) => (
                      <GlassCard
                        animated
                        key={config.id}
                        className="p-0 overflow-hidden"
                        style={config.isActive ? {
                          border: '2px solid rgba(34, 197, 94, 0.8)',
                          boxShadow: '0 0 16px rgba(34, 197, 94, 0.3)',
                        } : undefined}
                      >
                        <div className="flex flex-col">
                          {/* 标题栏 */}
                          <div className="p-2 pb-1 flex-shrink-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                <ImageIcon size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
                                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                  {config.name}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* 内容区：左侧提示词 + 右侧图片预览（统一高度100px） */}
                          <div className="px-2 pb-1 flex-shrink-0">
                            <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: '100px' }}>
                              {/* 左侧：提示词预览 */}
                              <div
                                className="overflow-auto border rounded-[6px] p-2"
                                style={{
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                                }}
                              >
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  {config.prompt || '（无提示词）'}
                                </div>
                              </div>
                              {/* 右侧：图片预览（风格图使用简单边框，点击放大） */}
                              <div
                                className="flex items-center justify-center overflow-hidden rounded-[6px]"
                                style={{
                                  background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                                  border: '1px solid var(--border-subtle)',
                                  cursor: config.imageUrl ? 'zoom-in' : 'default',
                                }}
                                onClick={() => config.imageUrl && setEnlargedRefImageUrl(config.imageUrl)}
                                title={config.imageUrl ? '点击放大' : undefined}
                              >
                                {config.imageUrl ? (
                                  <img
                                    src={config.imageUrl}
                                    alt={config.name}
                                    className="block w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无图片</div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 操作按钮区（图标化布局） */}
                          <div className="px-2 pb-2 pt-1 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                            <div className="flex items-center gap-1 justify-between">
                              {/* 左侧：发布图标 + 下载次数 */}
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10 disabled:opacity-50"
                                  style={{
                                    color: config.isPublic ? 'rgba(251, 146, 60, 0.9)' : 'var(--text-muted)',
                                    background: config.isPublic ? 'rgba(251, 146, 60, 0.1)' : 'transparent',
                                  }}
                                  onClick={() => config.isPublic ? void handleUnpublishRefConfig(config) : void handlePublishRefConfig(config)}
                                  disabled={referenceImageSaving}
                                  title={config.isPublic ? '点击取消发布' : '发布到海鲜市场'}
                                >
                                  <Share2 size={14} />
                                </button>
                                {/* 下载次数 */}
                                {typeof config.forkCount === 'number' && (
                                  <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    <GitFork size={10} />
                                    {config.forkCount}
                                  </span>
                                )}
                              </div>
                              {/* 右侧：选择 | 编辑/删除（用分隔线区分功能组） */}
                              <div className="flex items-center gap-1">
                                {/* 选择按钮 */}
                                <button
                                  type="button"
                                  className="px-2.5 py-1.5 rounded-md transition-all duration-200 hover:bg-white/10 disabled:opacity-50"
                                  style={{
                                    color: config.isActive ? 'white' : 'rgba(156, 163, 175, 0.6)',
                                    background: config.isActive ? 'rgba(34, 197, 94, 0.95)' : 'transparent',
                                    border: config.isActive ? '1px solid rgba(34, 197, 94, 0.95)' : 'none',
                                    minWidth: 40,
                                  }}
                                  onClick={async () => {
                                    setReferenceImageSaving(true);
                                    try {
                                      const res = config.isActive
                                        ? await deactivateReferenceImageConfig({ id: config.id })
                                        : await activateReferenceImageConfig({ id: config.id });
                                      if (res.success) {
                                        await loadReferenceImageConfigs();
                                      }
                                    } finally {
                                      setReferenceImageSaving(false);
                                    }
                                  }}
                                  disabled={referenceImageSaving}
                                  title={config.isActive ? '取消选择' : '选择'}
                                >
                                  <CheckCircle2 size={16} />
                                </button>
                                {/* 分隔线 */}
                                <div className="h-4 w-px mx-0.5" style={{ background: 'var(--border-subtle)' }} />
                                {/* 编辑/删除按钮组 */}
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-white/10"
                                  style={{ color: 'var(--text-muted)' }}
                                  onClick={() => {
                                    setEditingRefConfig({ ...config });
                                    setEditingRefConfigOpen(true);
                                  }}
                                  title="编辑"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="p-1.5 rounded-md transition-all duration-200 hover:bg-red-500/10 disabled:opacity-50"
                                  style={{ color: 'rgba(239, 68, 68, 0.7)' }}
                                  onClick={async () => {
                                    const confirmed = await systemDialog.confirm({
                                      title: '删除风格图配置',
                                      message: `确定要删除「${config.name}」吗？`,
                                      confirmText: '确定删除',
                                      tone: 'danger',
                                    });
                                    if (!confirmed) return;
                                    if (config.isPublic) {
                                      const doubleConfirmed = await systemDialog.confirm({
                                        title: '⚠️ 该配置已发布到海鲜市场',
                                        message: '删除后其他用户将无法再下载此配置，确定要删除吗？',
                                        tone: 'danger',
                                        confirmText: '确认删除',
                                        cancelText: '取消',
                                      });
                                      if (!doubleConfirmed) return;
                                    }
                                    setReferenceImageSaving(true);
                                    try {
                                      const res = await deleteReferenceImageConfig({ id: config.id });
                                      if (res.success) {
                                        await loadReferenceImageConfigs();
                                        toast.success('已删除');
                                      } else {
                                        toast.error('删除失败', res.error?.message || '未知错误');
                                      }
                                    } finally {
                                      setReferenceImageSaving(false);
                                    }
                                  }}
                                  disabled={referenceImageSaving}
                                  title="删除"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </GlassCard>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 右侧：水印设置 */}
            <div className="min-h-0 flex flex-col h-full border-l pl-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  水印设置
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => watermarkPanelRef.current?.addSpec()}
                >
                  <Plus size={12} />
                  新增配置
                </Button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <WatermarkSettingsPanel ref={watermarkPanelRef} appKey="literary-agent" onStatusChange={handleWatermarkStatusChange} hideAddButton />
              </div>
            </div>
          </div>
            )}

            {/* 海鲜市场视图 - 使用类型注册表实现扩展性 */}
            {configViewMode === 'marketplace' && (
              <div className="flex flex-col h-full min-h-0 flex-1">
                {/* 搜索、分类筛选和排序栏 */}
                <div className="flex items-center gap-3 mb-4 flex-shrink-0 flex-wrap">
                  {/* 搜索框 */}
                  <div className="relative flex-1 min-w-[180px] max-w-xs">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      placeholder="搜索配置名称..."
                      value={marketplaceSearchKeyword}
                      onChange={(e) => setMarketplaceSearchKeyword(e.target.value)}
                      className="w-full h-8 pl-9 pr-3 rounded-lg text-sm"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    />
                  </div>
                  {/* 分类筛选 - 使用类型注册表动态生成 */}
                  <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
                    {getCategoryFilterOptions().map(({ key, label, icon: Icon }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setMarketplaceCategoryFilter(key)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                          marketplaceCategoryFilter === key ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                        }`}
                        style={{ color: marketplaceCategoryFilter === key ? undefined : 'var(--text-muted)' }}
                      >
                        {Icon && <Icon size={11} />}
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* 排序 */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMarketplaceSortBy('hot')}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        marketplaceSortBy === 'hot' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                      }`}
                      style={{ color: marketplaceSortBy === 'hot' ? undefined : 'var(--text-muted)' }}
                    >
                      <TrendingUp size={12} />
                      热门
                    </button>
                    <button
                      type="button"
                      onClick={() => setMarketplaceSortBy('new')}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        marketplaceSortBy === 'new' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                      }`}
                      style={{ color: marketplaceSortBy === 'new' ? undefined : 'var(--text-muted)' }}
                    >
                      <Clock size={12} />
                      最新
                    </button>
                  </div>
                </div>

                {marketplaceLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-auto">
                    {/* 使用类型注册表合并、过滤、排序数据 */}
                    {(() => {
                      // 1. 合并数据
                      const merged = mergeMarketplaceData(marketplaceDataByType, marketplaceCategoryFilter);
                      // 2. 排序
                      const sorted = sortMarketplaceItems(merged, marketplaceSortBy);
                      // 3. 搜索过滤
                      const filtered = filterMarketplaceItems(sorted, marketplaceSearchKeyword);

                      if (filtered.length === 0) {
                        return (
                          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                            暂无公开配置
                          </div>
                        );
                      }

                      return (
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                          {filtered.map((item) => (
                            <MarketplaceCard
                              key={`${item.type}-${item.data.id}`}
                              item={item}
                              onFork={handleMarketplaceFork}
                              forking={forkingId === item.data.id}
                            />
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />

      {/* Image Preview Dialog */}
      <ImagePreviewDialog
        images={markerRunItems
          .filter(x => x.assetUrl || x.url || x.base64)
          .map((x, i) => ({
            url: x.assetUrl || x.url || (x.base64?.startsWith('data:') ? x.base64 : `data:image/png;base64,${x.base64}`) || '',
            alt: `配图 ${i + 1}`,
          }))}
        initialIndex={imagePreviewIndex}
        open={imagePreviewOpen}
        onClose={() => setImagePreviewOpen(false)}
      />

      {/* 风格图放大预览对话框 */}
      <Dialog
        open={!!enlargedRefImageUrl}
        onOpenChange={(open) => !open && setEnlargedRefImageUrl(null)}
        title="图片预览"
        maxWidth={800}
        content={
          enlargedRefImageUrl && (
            <div className="flex items-center justify-center p-4">
              <img
                src={enlargedRefImageUrl}
                alt="Preview"
                className="max-w-full max-h-[70vh] object-contain rounded-lg"
              />
            </div>
          )
        }
      />

      {/* 风格图配置编辑对话框 */}
      <Dialog
        open={editingRefConfigOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditingRefConfigOpen(false);
            setEditingRefConfig(null);
          }
        }}
        title="编辑风格图配置"
        description="修改配置名称和参考图风格提示词"
        maxWidth={800}
        content={
          editingRefConfig ? (
            <div className="flex flex-col gap-4 p-2">
              {/* 左右布局：左边表单，右边图片预览 */}
              <div className="grid grid-cols-2 gap-6">
                {/* 左侧：表单 */}
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="text-sm font-medium mb-1 block" style={{ color: 'var(--text-primary)' }}>
                      配置名称
                    </label>
                    <input
                      type="text"
                      value={editingRefConfig.name}
                      onChange={(e) => setEditingRefConfig({ ...editingRefConfig, name: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg text-sm"
                      style={{
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-medium mb-1 block" style={{ color: 'var(--text-primary)' }}>
                      参考图风格提示词
                    </label>
                    <textarea
                      value={editingRefConfig.prompt}
                      onChange={(e) => setEditingRefConfig({ ...editingRefConfig, prompt: e.target.value })}
                      rows={8}
                      className="w-full px-3 py-2 rounded-lg text-sm resize-none"
                      style={{
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                      }}
                      placeholder="例如：请参考图中的风格、色调、构图和视觉元素来生成图片，保持整体美学风格的一致性。"
                    />
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      此提示词会自动追加到每个生图请求中，引导 AI 参考风格图的风格。
                    </div>
                  </div>
                </div>

                {/* 右侧：风格图预览 */}
                <div className="flex flex-col">
                  <label className="text-sm font-medium mb-1 block" style={{ color: 'var(--text-primary)' }}>
                    当前风格图
                  </label>
                  <input
                    ref={editRefImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !editingRefConfig) return;
                      e.target.value = '';
                      setReferenceImageSaving(true);
                      try {
                        const res = await updateReferenceImageFile({ id: editingRefConfig.id, file });
                        if (res.success && res.data?.config) {
                          setEditingRefConfig(res.data.config);
                          await loadReferenceImageConfigs();
                          toast.success('风格图已更新');
                        } else {
                          toast.error('更新失败', res.error?.message || '未知错误');
                        }
                      } finally {
                        setReferenceImageSaving(false);
                      }
                    }}
                  />
                  <div
                    className="flex-1 rounded-lg overflow-hidden relative group cursor-pointer"
                    style={{
                      background: editingRefConfig.imageUrl ? 'transparent' : 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                      border: editingRefConfig.imageUrl ? 'none' : '1px dashed var(--border-subtle)',
                      minHeight: '200px',
                    }}
                    onClick={() => editRefImageInputRef.current?.click()}
                  >
                    {editingRefConfig.imageUrl ? (
                      <>
                        <img
                          src={editingRefConfig.imageUrl}
                          alt={editingRefConfig.name}
                          className="w-full h-full object-cover rounded-lg"
                        />
                        {/* 悬浮替换按钮 */}
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <div
                            className="w-1/3 aspect-square rounded-xl flex items-center justify-center"
                            style={{
                              ...glassBadge,
                              background: 'rgba(0, 0, 0, 0.6)',
                            }}
                          >
                            <Upload size={32} style={{ color: 'rgba(255, 255, 255, 0.9)' }} />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                        <div className="flex flex-col items-center gap-2">
                          <Upload size={24} style={{ color: 'var(--text-muted)' }} />
                          <span>点击上传风格图</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 底部按钮 */}
              <div className="flex gap-2 justify-end pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditingRefConfigOpen(false);
                    setEditingRefConfig(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  disabled={referenceImageSaving || !editingRefConfig.name.trim()}
                  onClick={async () => {
                    if (!editingRefConfig.name.trim()) return;
                    setReferenceImageSaving(true);
                    try {
                      const res = await updateReferenceImageConfig({
                        id: editingRefConfig.id,
                        name: editingRefConfig.name.trim(),
                        prompt: editingRefConfig.prompt.trim(),
                      });
                      if (res.success) {
                        await loadReferenceImageConfigs();
                        setEditingRefConfigOpen(false);
                        setEditingRefConfig(null);
                        toast.success('保存成功');
                      } else {
                        toast.error('保存失败', res.error?.message || '未知错误');
                      }
                    } finally {
                      setReferenceImageSaving(false);
                    }
                  }}
                >
                  保存
                </Button>
              </div>
            </div>
          ) : null
        }
      />

      {/* Phase 1: 段落右键菜单（在此段上方/下方插入配图锚点） */}
      {paragraphCtxMenu.visible && (
        <div
          className="fixed z-[1000] rounded-lg py-1 min-w-[180px] shadow-lg"
          style={{
            left: Math.min(paragraphCtxMenu.x, window.innerWidth - 200),
            top: Math.min(paragraphCtxMenu.y, window.innerHeight - 120),
            ...glassPanel,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-white/10 transition-colors flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => {
              addAnchorAbove(paragraphCtxMenu.pIdx);
              setParagraphCtxMenu(m => ({ ...m, visible: false }));
            }}
          >
            <MapPin size={12} style={{ color: 'rgba(52, 211, 153, 0.95)' }} />
            在此段上方插入配图
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-white/10 transition-colors flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => {
              addAnchorBelow(paragraphCtxMenu.pIdx);
              setParagraphCtxMenu(m => ({ ...m, visible: false }));
            }}
          >
            <MapPin size={12} style={{ color: 'rgba(52, 211, 153, 0.95)' }} />
            在此段下方插入配图
          </button>
        </div>
      )}

      {/* Phase 1: 首次进入的锚点教程气泡 —— 复用全局 TipCard 组件,跟右下角「教程小书」
          抽屉卡片视觉统一(MapPin + 绿色 accent + 知道啦) */}
      {anchorTutorialSeen === false && phase !== 0 && (
        <div
          className="fixed z-[1000]"
          style={{ right: 24, bottom: 24, maxWidth: 340 }}
        >
          <TipCard
            icon={<MapPin size={14} />}
            accent="rgba(52, 211, 153, 0.95)"
            title="新功能:手动指定配图位置"
            body={
              <div>
                <div style={{ marginBottom: 6 }}>· 右上角「📍 位置策略」可切换 4 种生成策略</div>
                <div style={{ marginBottom: 6 }}>
                  · 鼠标悬停段落左侧 → 点{' '}
                  <span style={{ color: 'rgba(52, 211, 153, 0.95)' }}>+</span> 在上方打锚点
                </div>
                <div>
                  · 段落上
                  <span style={{ color: 'rgba(52, 211, 153, 0.95)' }}>右键</span> →
                  选择"在上方/下方插入配图"
                </div>
              </div>
            }
            ctaText="知道啦"
            ack
            onCta={dismissAnchorTutorial}
            variant="bubble"
          />
        </div>
      )}
    </div>
  );
}
