import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { SizePickerButton } from '@/components/visual-agent/SizePickerPanel';
import { glassToolbar } from '@/lib/glassStyles';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  createVisualAgentWorkspace,
  deleteVisualAgentWorkspace,
  getUsers,
  listVisualAgentWorkspaces,
  refreshVisualAgentWorkspaceCover,
  updateVisualAgentWorkspace,
  uploadVisualAgentWorkspaceAsset,
} from '@/services';
import type { AdminUser } from '@/types/admin';
import type { VisualAgentWorkspace } from '@/services/contracts/visualAgent';
import {
  Plus,
  Users2,
  Pencil,
  Trash2,
  ArrowRight,
  ArrowLeft,
  Image,
  ShoppingCart,
  PenTool,
  Video,
  LayoutGrid,
  Star,
  Sparkles,
  FolderPlus,
  FilePlus,
  Bug,
  X,
  Clipboard,
} from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useAuthStore } from '@/stores/authStore';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildInlineImageToken, computeRequestedSizeByRefRatio, readImageSizeFromFile } from '@/lib/visualAgentPromptUtils';
import { normalizeFileToSquareDataUrl } from '@/lib/imageSquare';
import { BackdropPhoto, LatentField } from '@/components/effects/LatentField';
import { BackdropSettings, readBackdropMode, resolveBackdrop, type BackdropMode } from '@/components/visual-agent/BackdropSettings';
import type { BackdropAsset } from '@/lib/backdropRotation';
import { BACKDROP_CATALOG, dimFor } from '@/lib/backdropCatalog';
import { readGeneratedBackdrops } from '@/lib/backdropStudio';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { getNextWorkspaceSkip, isVisibleWorkspace } from './workspaceListPaging';

/** 快捷键提示按平台给。写死 ⌘V 会让 Windows 用户对着一个不存在的键发呆。 */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function CoverMosaic(props: { title: string; assets: VisualAgentWorkspace['coverAssets'] }) {
  const assets = Array.isArray(props.assets) ? props.assets : [];
  const n = assets.length;

  const Tile = (p: { idx: number; style?: React.CSSProperties }) => {
    const a = assets[p.idx];
    return a?.url ? (
      <img
        src={a.url}
        alt=""
        className="h-full w-full object-cover"
        style={p.style}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    ) : (
      <div
        className="h-full w-full"
        style={{
          ...p.style,
          background: 'var(--nested-block-bg)',
        }}
      />
    );
  };

  if (n <= 0) return null;
  if (n === 1) {
    return (
      <img
        src={assets[0]?.url}
        alt={props.title || 'workspace cover'}
        className="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  if (n === 2) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(1, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        <Tile idx={0} />
        <Tile idx={1} />
      </div>
    );
  }

  if (n === 3) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        <Tile idx={0} style={{ gridColumn: '1', gridRow: '1 / span 2' }} />
        <Tile idx={1} style={{ gridColumn: '2', gridRow: '1' }} />
        <Tile idx={2} style={{ gridColumn: '2', gridRow: '2' }} />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 grid"
      style={{
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        gap: 2,
      }}
    >
      <Tile idx={0} />
      <Tile idx={1} />
      <Tile idx={2} />
      <Tile idx={3} />
    </div>
  );
}

// ============ 浮动工具栏按钮 ============
function ToolbarButton(props: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        className="h-10 w-10 rounded-xl inline-flex items-center justify-center transition-all duration-200 hover-bg-soft hover:scale-105 active:scale-95"
        style={{ color: 'var(--text-secondary)' }}
        onClick={props.onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {props.icon}
      </button>
      {/* Tooltip */}
      {showTooltip && (
        <div
          className="surface-tone-dark absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap pointer-events-none"
          style={{
            background: 'rgba(30, 30, 35, 0.95)',
            color: '#fff',
            border: '1px solid var(--border-default)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {props.label}
        </div>
      )}
    </div>
  );
}

// ============ 浮动工具栏 ============
function FloatingToolbar(props: {
  onNewProject: () => void;
  onNewFolder: () => void;
}) {
  const { onNewProject, onNewFolder } = props;

  return (
    <div
      className="rounded-2xl p-1.5 flex flex-col gap-1 bg-transparent"
      style={{
        ...glassToolbar,
        background: 'rgba(18, 18, 22, 0.6)',
      }}
    >
      <ToolbarButton
        icon={<FilePlus size={17} />}
        label="新建项目"
        onClick={onNewProject}
      />
      <ToolbarButton
        icon={<FolderPlus size={17} />}
        label="新建文件夹"
        onClick={onNewFolder}
      />
    </div>
  );
}

// ============ 场景标签定义 ============
const SCENARIO_TAGS = [
  // hue 是每格左侧那根色条。它是本页**唯一**的彩色：其余一切走 #D97757 单色 + 三档灰。
  // 六格等宽（视频创作的风格档同构），所以 label 一律控制在四个字以内。
  { key: 'pro', label: 'MAP Pro', icon: Sparkles, prompt: '', isPro: true, hue: 'var(--accent-primary)' },
  { key: 'design', label: '平面设计', icon: LayoutGrid, prompt: '帮我设计一张', hue: '#6fd5ef' },
  { key: 'branding', label: '品牌设计', icon: Star, prompt: '帮我设计一个品牌视觉，包括', hue: '#E8A87C' },
  { key: 'illustration', label: '插画创作', icon: PenTool, prompt: '帮我创作一幅插画，主题是', hue: '#77e3b2' },
  { key: 'ecommerce', label: '电商设计', icon: ShoppingCart, prompt: '帮我设计一张电商主图，产品是', hue: '#fb7185' },
  { key: 'video', label: '视频封面', icon: Video, prompt: '帮我设计一张视频封面，内容是', hue: '#a78bfa' },
];

// ============ Hero 区域 ============
/**
 * 标题区。相对旧版的三处改动，每一处都有具体理由：
 *
 * 1. 42px 青绿渐变标题 → 32px 实心标题。渐变字是 2022 年的手法，且那套青绿
 *    (#c4b5fd→#6ee7b7) 和产品里唯一的品牌色 #D97757 没有任何关系，等于页面有两套色。
 * 2. 加一行小眉标。视频创作用的是同一套节奏（眉标 + 标题 + 一句说明），
 *    两个 Agent 因此读起来是一家人。
 * 3. 副标题从「AI 驱动的设计助手，让创作更简单」换成一句只对这个产品成立的话——
 *    前者放到任何产品上都成立，等于没说。
 */
function HeroSection() {
  return (
    <div className="relative w-full flex flex-col items-center text-center" style={{ paddingTop: 8 }}>
      <span
        className="inline-flex items-center gap-[7px] text-[11px] font-bold"
        style={{ color: 'var(--accent-gold-2)' }}
      >
        <Sparkles size={13} />
        一次粘几张参考图开局，之后都在画布上改
      </span>

      <h1
        data-tour-id="visual-page-title"
        className="mt-2.5 text-[32px] font-semibold leading-[1.2]"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        先落到画布，再谈生成
      </h1>

      <p
        data-tour-id="visual-subtitle"
        className="mt-2.5 text-[13px] leading-[1.6]"
        style={{ color: 'var(--text-muted)' }}
      >
        生成只是其中一步。出图之后还能拆图层、局部重绘、扩展画幅——都在同一张画布上。
      </p>
    </div>
  );
}


// ============ 打字动效占位符 ============
const TYPING_TEXTS = [
  '帮我设计一张活动海报...',
  '帮我创作一个品牌LOGO...',
  '帮我设计一张电商主图...',
  '帮我创作一幅插画作品...',
];

function useTypingPlaceholder() {
  const [displayText, setDisplayText] = useState('');
  const [textIndex, setTextIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    const currentText = TYPING_TEXTS[textIndex] || '';

    const timeout = setTimeout(() => {
      if (!isDeleting) {
        // 打字中
        if (charIndex < currentText.length) {
          setDisplayText(currentText.slice(0, charIndex + 1));
          setCharIndex(charIndex + 1);
        } else {
          // 打完了，等待后开始删除
          setTimeout(() => setIsDeleting(true), 1500);
        }
      } else {
        // 删除中
        if (charIndex > 0) {
          setDisplayText(currentText.slice(0, charIndex - 1));
          setCharIndex(charIndex - 1);
        } else {
          // 删完了，切换到下一个文本
          setIsDeleting(false);
          setTextIndex((textIndex + 1) % TYPING_TEXTS.length);
        }
      }
    }, isDeleting ? 25 : 45);

    return () => clearTimeout(timeout);
  }, [charIndex, isDeleting, textIndex]);

  return displayText;
}

// ============ 快捷输入框（深色卡片样式） ============
function QuickInputBox(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
  onImageSelect?: (file: File) => void;
  selectedImage?: { file: File; previewUrl: string } | null;
  onRemoveImage?: () => void;
  size?: string;
  onSizeChange?: (size: string) => void;
}) {
  const { value, onChange, onSubmit, loading, onImageSelect, selectedImage, onRemoveImage, size = '1024x1024', onSizeChange } = props;
  const typingPlaceholder = useTypingPlaceholder();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const openDefectDialog = useGlobalDefectStore((s) => s.openDialog);

  // 从剪贴板 / 拖拽事件里提取第一张图片文件（与编辑器画板保持一致的交互）
  const pickFirstImageFile = (list: FileList | null | undefined, items?: DataTransferItemList | null): File | null => {
    const fromFiles = Array.from(list ?? []).find((f) => (f.type || '').startsWith('image/'));
    if (fromFiles) return fromFiles;
    const fromItems = Array.from(items ?? [])
      .filter((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
      .map((it) => it.getAsFile())
      .find((f): f is File => Boolean(f));
    return fromItems ?? null;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  // 点击整个输入框区域时聚焦到textarea
  const handleContainerClick = () => {
    textareaRef.current?.focus();
  };

  // 处理图片按钮点击
  const handleImageButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡到容器，避免触发 handleContainerClick
    fileInputRef.current?.click();
  };

  // 处理文件选择
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // 验证文件类型
      if (!file.type.startsWith('image/')) {
        toast.warning('请选择图片文件');
        e.target.value = '';
        return;
      }
      // 调用回调
      if (onImageSelect) {
        onImageSelect(file);
      }
    }
    // 清空 input 值，允许重复选择同一文件
    e.target.value = '';
  };

  // 粘贴剪贴板里的图片（Ctrl/Cmd+V）——首页此前缺失，仅编辑器支持
  const handlePaste = (e: React.ClipboardEvent) => {
    if (loading || !onImageSelect) return;
    const img = pickFirstImageFile(e.clipboardData?.files, e.clipboardData?.items);
    if (!img) return; // 没有图片时放行，允许正常粘贴文本
    e.preventDefault();
    onImageSelect(img);
  };

  // 拖拽图片到输入框
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (loading || !onImageSelect) return;
    const img = pickFirstImageFile(e.dataTransfer?.files, e.dataTransfer?.items);
    if (!img) {
      toast.warning('请拖入图片文件');
      return;
    }
    onImageSelect(img);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (loading || !onImageSelect) return;
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault();
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // 只有真正离开容器时才清除高亮:指针移入内部子元素(如 textarea / 按钮)也会触发 dragleave,
    // relatedTarget 仍在容器内时保持 isDragging,避免拖拽悬停时提示蒙层/高亮边框闪烁(Bugbot)。
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setIsDragging(false);
  };

  const canSubmit = value.trim() && !loading;

  // 暗房档的输入区。行为一行没改（粘贴 / 拖入 / 选文件 / 尺寸 / 缺陷 / 回车提交都在），
  // 换掉的是那套「老」：20px 大圆角 + 靛蓝描边 + 渐变主按钮 + 15px 正文。
  // 靛蓝是这一页唯一和品牌色无关的颜色，删掉之后整页只剩 #D97757 一种强调色。
  const focused = isFocused || isDragging;
  return (
    <div className="w-full mx-auto mt-5" style={{ width: 'min(820px, 100%)' }}>
      <div
        className="overflow-hidden cursor-text transition-colors"
        style={{
          borderRadius: 8,
          background: 'var(--bg-elevated)',
          border: `1px solid ${focused ? 'var(--border-focus)' : 'var(--border-subtle)'}`,
          boxShadow: focused
            ? 'var(--shadow-card), 0 0 0 3px rgba(var(--accent-primary-rgb), 0.14)'
            : 'var(--shadow-card)',
        }}
        onClick={handleContainerClick}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="relative px-5 pt-4 pb-2" style={{ minHeight: 96 }}>
          {isDragging && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center gap-2 pointer-events-none"
              style={{
                borderRadius: 6,
                background: 'var(--panel-solid)',
                border: '1px dashed var(--border-focus)',
                color: 'var(--text-secondary)',
              }}
            >
              <Image size={15} />
              <span className="text-[12px]">松开，把图片作为参考图</span>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={2}
            data-tour-id="visual-prompt-input"
            className="w-full bg-transparent resize-none no-focus-ring"
            style={{
              color: 'var(--text-primary)',
              fontSize: 14,
              lineHeight: 1.65,
              minHeight: 60,
              border: 'none',
            }}
            disabled={loading}
          />
          {!value && (
            <div
              className="absolute left-5 right-5 pointer-events-none"
              style={{ top: 16, color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.65 }}
            >
              {typingPlaceholder}
              <span className="animate-pulse">|</span>
            </div>
          )}
        </div>

        {/* 参考图 chip 行。空着时不占位——一个常驻的空行会让输入区看起来「有个坏掉的槽」。 */}
        {selectedImage ? (
          <div className="flex flex-wrap items-center gap-[7px] px-5 pb-1.5">
            <span
              className="inline-flex items-center gap-1.5"
              style={{
                height: 30,
                padding: '3px 4px',
                borderRadius: 6,
                background: 'var(--bg-secondary)',
                color: 'var(--text-secondary)',
                fontSize: 10,
              }}
              title={`参考图：${selectedImage.file.name}`}
            >
              <img
                src={selectedImage.previewUrl}
                alt=""
                style={{ width: 24, height: 24, flex: '0 0 auto', borderRadius: 4, objectFit: 'cover', display: 'block' }}
              />
              <span className="truncate" style={{ maxWidth: 120, paddingRight: 2 }}>{selectedImage.file.name}</span>
              {onRemoveImage && (
                <button
                  type="button"
                  aria-label="移除参考图"
                  onClick={(e) => { e.stopPropagation(); onRemoveImage(); }}
                  className="grid place-items-center hover-bg-soft"
                  style={{ width: 20, height: 20, borderRadius: 4, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          </div>
        ) : null}

        {/* 一行说明：这是与视频创作的分界——那边只吃一段文字。 */}
        <div
          className="flex items-center gap-1.5 px-5 pb-3"
          style={{ color: 'var(--text-muted)', fontSize: 10 }}
        >
          <Clipboard size={12} />
          直接按 {isMac ? '⌘V' : 'Ctrl+V'} 粘贴，或把图拖进来当参考图
        </div>

        {/* 底部工具条：自带底色 + 上边框，与视频创作同结构。 */}
        <div
          className="flex items-center justify-between gap-2.5"
          style={{
            minHeight: 58,
            padding: '9px 10px 9px 13px',
            borderTop: '1px solid var(--border-faint)',
            background: 'var(--bg-secondary)',
          }}
        >
          <div className="flex items-center gap-[3px]">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
              disabled={loading}
            />
            <button
              type="button"
              data-tour-id="visual-image-btn"
              onClick={handleImageButtonClick}
              disabled={loading}
              className="inline-flex items-center gap-1.5 hover-bg-soft disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ minHeight: 36, padding: '0 9px', borderRadius: 7, border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 10, cursor: 'pointer' }}
              title="添加参考图（也可粘贴或拖入）"
            >
              <Image size={13} />
              参考图
            </button>
            {onSizeChange && (
              <span data-tour-id="visual-size-btn" className="inline-flex">
                <SizePickerButton size={size} onSizeChange={onSizeChange} />
              </span>
            )}
            <button
              type="button"
              data-tour-id="visual-defect-btn"
              onClick={(e) => { e.stopPropagation(); openDefectDialog(); }}
              className="inline-flex items-center gap-1.5 hover-bg-soft"
              style={{ minHeight: 36, padding: '0 9px', borderRadius: 7, border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 10, cursor: 'pointer' }}
              title="提交缺陷 (Cmd/Ctrl+B)"
            >
              <Bug size={13} />
              反馈
            </button>
          </div>

          {/* 反色主按钮：视频创作的主操作就是这么做的，也是「控制台感」里最见效的一笔。 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSubmit(); }}
            disabled={!canSubmit}
            data-tour-id="visual-submit-btn"
            className="inline-flex items-center gap-[7px] transition-opacity"
            style={{
              minHeight: 40,
              padding: '0 16px',
              borderRadius: 7,
              border: 0,
              background: canSubmit ? 'var(--text-primary)' : 'var(--bg-tertiary)',
              color: canSubmit ? 'var(--bg-base)' : 'var(--text-muted)',
              fontSize: 12,
              fontWeight: 650,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {loading ? '生成中…' : (<><Sparkles size={14} />开始创作</>)}
          </button>
        </div>
      </div>
    </div>
  );
}


// ============ 场景标签 ============
function ScenarioTags(props: { onSelect: (prompt: string) => void; activeKey: string | null }) {
  const { onSelect, activeKey } = props;

  // 六格等宽（与视频创作的风格档同构），窄屏退回横向滚动而不是换行——
  // 换行会让这一排在手机上吃掉两倍高度，把输入框挤出首屏（mobile-first-density 规则 3）。
  return (
    <div
      data-tour-id="visual-scenarios"
      className="mt-3 grid grid-flow-col auto-cols-[minmax(96px,1fr)] sm:grid-flow-row sm:auto-cols-auto sm:grid-cols-6 gap-1.5 overflow-x-auto no-scrollbar"
      style={{ width: 'min(820px, 100%)' }}
    >
      {SCENARIO_TAGS.map((tag) => {
        const Icon = tag.icon;
        const isActive = tag.isPro ? activeKey === tag.key || activeKey === null : activeKey === tag.key;
        return (
          <button
            key={tag.key}
            type="button"
            data-tour-id={tag.isPro ? 'visual-pro' : undefined}
            onClick={() => { if (!tag.isPro) onSelect(tag.prompt); }}
            className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-[7px] text-[9px] shrink-0 transition-colors"
            style={{
              minHeight: 38,
              background: isActive ? 'var(--bg-card)' : 'var(--bg-secondary)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: isActive
                ? `inset 0 0 0 1px ${tag.hue}, var(--shadow-card-sm)`
                : undefined,
            }}
          >
            <i
              aria-hidden
              className="block shrink-0 rounded-[3px]"
              style={{ width: 8, height: 22, background: tag.hue }}
            />
            <Icon size={11} className="shrink-0" style={{ opacity: isActive ? 1 : 0.7 }} />
            <span className="truncate">{tag.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============ 项目卡片（网格布局） ============
function ProjectCard(props: {
  workspace: VisualAgentWorkspace;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onClick: () => void;
}) {
  const { workspace: ws, onRename, onShare, onDelete, onClick } = props;
  const hasCover = ws.coverAssets && ws.coverAssets.length > 0;
  // 触屏无 hover：移动端操作按钮常驻显示，桌面维持 hover 浮现
  const { isMobile } = useBreakpoint();

  return (
    <div
      className="group cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* 封面区域 */}
      <div
        className="h-[160px] w-full relative overflow-hidden rounded-xl transition-all duration-300 group-hover:scale-[1.02]"
        data-ws-card="1"
        data-ws-id={ws.id}
        style={{
          background: hasCover ? 'transparent' : 'var(--bg-input)',
          border: hasCover ? 'none' : '1px solid var(--border-default)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        }}
      >
        {hasCover && <CoverMosaic title={ws.title || ws.id} assets={ws.coverAssets} />}
        {/* Hover 遮罩 */}
        <div
          className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 50%)',
          }}
        />
      </div>
      {/* 信息区域 */}
      <div className="pt-2.5 px-0.5">
        <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
          {ws.title || '未命名'}
        </div>
        <div className="mt-1 text-[11px] flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
          <span>{formatDate(ws.updatedAt)}</span>
          <div
            className={
              isMobile
                ? 'flex items-center gap-1'
                : 'flex items-center gap-1 opacity-0 pointer-events-none transition-all duration-150 group-hover:opacity-100 group-hover:pointer-events-auto'
            }
          >
            <Button
              size="xs"
              variant="secondary"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onRename(); }}
              title="重命名"
            >
              <Pencil size={10} />
            </Button>
            <Button
              size="xs"
              variant="secondary"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onShare(); }}
              title="共享"
            >
              <Users2 size={10} />
            </Button>
            <Button
              size="xs"
              variant="danger"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="删除"
            >
              <Trash2 size={10} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ 新建项目卡片（网格布局） ============
function NewProjectCard(props: { onClick: () => void }) {
  return (
    <div
      data-tour-id="visual-new-project"
      className="cursor-pointer group"
      onClick={props.onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      {/* 封面区域 - 与其他卡片高度一致 */}
      <div
        className="h-[160px] rounded-xl flex flex-col items-center justify-center gap-2.5 transition-all duration-300 group-hover:scale-[1.02] group-hover:border-token-subtle bg-token-nested"
        style={{ border: '1.5px dashed var(--border-subtle)' }}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 group-hover:scale-110"
          style={{
            background: 'var(--bg-input-hover)',
            border: '1px solid var(--border-default)',
          }}
        >
          <Plus size={22} style={{ color: 'var(--text-secondary)' }} />
        </div>
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          新建项目
        </span>
      </div>
    </div>
  );
}

// ============ 项目列表（网格布局，一排5个） ============
function ProjectCarousel(props: {
  items: VisualAgentWorkspace[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onCreate: () => void;
  onRename: (ws: VisualAgentWorkspace) => void;
  onShare: (ws: VisualAgentWorkspace) => void;
  onDelete: (ws: VisualAgentWorkspace) => void;
  onOpen: (ws: VisualAgentWorkspace) => void;
}) {
  const { items, loading, loadingMore, hasMore, onLoadMore, onCreate, onRename, onShare, onDelete, onOpen } = props;
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 无限滚动：当哨兵元素进入视口时加载更多
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  if (loading) {
    return <MapSectionLoader />;
  }

  return (
    <div className="mt-8 flex-1 relative z-10">
      {/* 标题栏 - 增加分隔线和更好的层级 */}
      <div className="max-w-[1340px] mx-auto px-5 mb-4">
        <div
          className="flex items-center justify-between py-3"
          style={{ borderTop: '1px solid var(--nested-block-border)' }}
        >
          <h2
            data-tour-id="visual-projects"
            className="text-[14px] font-medium tracking-wide"
            style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            最近项目
          </h2>
        </div>
      </div>
      {/* 网格布局，响应式列数 */}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-5 pb-6 px-5 max-w-[1340px] mx-auto"
      >
        <NewProjectCard onClick={onCreate} />
        {items.map((ws) => (
          <ProjectCard
            key={ws.id}
            workspace={ws}
            onRename={() => onRename(ws)}
            onShare={() => onShare(ws)}
            onDelete={() => onDelete(ws)}
            onClick={() => onOpen(ws)}
          />
        ))}
      </div>
      {/* 加载更多指示器 + 哨兵 */}
      {loadingMore && <MapSectionLoader />}
      {hasMore && <div ref={sentinelRef} className="h-1" />}
    </div>
  );
}

// ============ 主页面 ============
export default function VisualAgentWorkspaceListPage(props: { fullscreenMode?: boolean }) {
  // fullscreenMode 参数保留用于兼容，但现在所有模式都是全屏
  const _fullscreenMode = props.fullscreenMode;
  void _fullscreenMode; // 避免 TS6133 警告
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const userId = useAuthStore((s) => s.user?.userId ?? '');

  // 统一使用 /visual-agent 路径（现在所有模式都是全屏）
  const getEditorPath = (workspaceId: string) => {
    return `/visual-agent/${encodeURIComponent(workspaceId)}`;
  };
  const [items, setItems] = useState<VisualAgentWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string>('');
  const nextWorkspaceSkipRef = useRef(0);
  const loadMoreBusyRef = useRef(false);
  const refreshBusyRef = useRef<Set<string>>(new Set());
  const lastRefreshHashRef = useRef<Map<string, string>>(new Map());

  // 快捷输入框状态
  const [inputValue, setInputValue] = useState('');
  const [inputLoading, setInputLoading] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // ---- 首页背景 ----
  // 素材池 = 随包四张专门为「当背景」而画的暗调图 + 用户自己生成的。
  // 第一版把池子接成「你自己项目的封面图」，取证之后推翻了：真实封面绝大多数是白底产品图，
  // 压到暗罩底下整页从近黑变成一片平灰，暗房的黑没了，那张图自己也糊成一团认不出来。
  // 详见 backdropCatalog.ts 的注释。
  const [backdropMode, setBackdropMode] = useState<BackdropMode>(() => readBackdropMode());
  const [generatedBackdrops, setGeneratedBackdrops] = useState<BackdropAsset[]>(() => readGeneratedBackdrops());
  const backdropAssets = useMemo<BackdropAsset[]>(
    () => [...BACKDROP_CATALOG, ...generatedBackdrops],
    [generatedBackdrops],
  );
  const backdrop = useMemo(() => resolveBackdrop(backdropAssets, backdropMode), [backdropAssets, backdropMode]);
  const [selectedImage, setSelectedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  // 默认尺寸：从 sessionStorage 读取用户偏好，与编辑器共享同一 key
  const defaultSizeKey = userId ? `prdAdmin.visualAgent.defaultSize.${userId}` : '';
  const [selectedSize, setSelectedSize] = useState<string>(() => {
    if (!defaultSizeKey) return '1024x1024';
    try { return sessionStorage.getItem(defaultSizeKey) || '1024x1024'; } catch { return '1024x1024'; }
  });

  // 共享对话框状态
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWs, setShareWs] = useState<VisualAgentWorkspace | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberSet, setMemberSet] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => Array.from(memberSet), [memberSet]);

  const PAGE_SIZE = 30;

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listVisualAgentWorkspaces({ limit: PAGE_SIZE, skip: 0 });
      if (!res.success) {
        setError(res.error?.message || '加载 workspace 失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      const filtered = list.filter(isVisibleWorkspace);
      setItems(filtered);
      nextWorkspaceSkipRef.current = getNextWorkspaceSkip(0, list);
      setHasMore(res.data?.hasMore ?? false);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (loadMoreBusyRef.current || !hasMore) return;
    loadMoreBusyRef.current = true;
    setLoadingMore(true);
    try {
      const skip = nextWorkspaceSkipRef.current;
      const res = await listVisualAgentWorkspaces({ limit: PAGE_SIZE, skip });
      if (!res.success) return;
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      nextWorkspaceSkipRef.current = getNextWorkspaceSkip(skip, list);
      const filtered = list.filter(isVisibleWorkspace);
      setItems((prev) => [...prev, ...filtered]);
      setHasMore(res.data?.hasMore ?? false);
    } finally {
      loadMoreBusyRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore]);

  useEffect(() => {
    void reload();
  }, []);

  // 封面刷新逻辑
  useEffect(() => {
    if (items.length === 0) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-ws-card="1"][data-ws-id]'));
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const el = ent.target as HTMLElement;
          const wid = String(el.getAttribute('data-ws-id') || '').trim();
          if (!wid) continue;

          const ws = items.find((x) => x.id === wid);
          if (!ws) continue;
          if (!ws.coverStale) continue;

          const contentHash = String(ws.contentHash ?? '').trim();
          const last = lastRefreshHashRef.current.get(wid) ?? '';
          if (contentHash && last === contentHash) continue;
          if (refreshBusyRef.current.has(wid)) continue;

          refreshBusyRef.current.add(wid);
          lastRefreshHashRef.current.set(wid, contentHash);

          void (async () => {
            try {
              const res = await refreshVisualAgentWorkspaceCover({
                id: wid,
                limit: 6,
                idempotencyKey: contentHash ? `ws_cover_${wid}_${contentHash}` : `ws_cover_${wid}_${Date.now()}`,
              });
              if (res.success && res.data?.workspace) {
                const next = res.data.workspace;
                setItems((prev) => prev.map((x) => (x.id === wid ? { ...x, ...next } : x)));
              }
            } finally {
              refreshBusyRef.current.delete(wid);
            }
          })();
        }
      },
      { root: null, threshold: 0.15 }
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);

  // 创建新 workspace（无初始 prompt）
  const onCreate = async () => {
    const title = await systemDialog.prompt({
      title: '新建 Workspace',
      message: '请输入项目名称',
      defaultValue: '未命名',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await createVisualAgentWorkspace({ title: title.trim() || '未命名', idempotencyKey: `ws_create_${Date.now()}` });
    if (!res.success) {
      toast.error(res.error?.message || '创建失败');
      return;
    }
    const ws = res.data.workspace;
    navigate(getEditorPath(ws.id));
  };

  // 快捷输入提交：创建 workspace 并跳转（带初始 prompt 和图片）
  const onQuickSubmit = async () => {
    const prompt = inputValue.trim();
    if (!prompt) return;

    setInputLoading(true);
    try {
      // 1. 创建 workspace
      const res = await createVisualAgentWorkspace({
        title: prompt.slice(0, 20) || '未命名',
        idempotencyKey: `ws_quick_${Date.now()}`,
      });
      if (!res.success) {
        toast.error(res.error?.message || '创建失败');
        return;
      }
      const ws = res.data.workspace;

      // 2. 构建消息文本（使用 [IMAGE src=... name=...] 和 (@size:...) 标记）
      // 格式：${inlineRefToken}${uiSizeToken}${display || reqText}
      // 即：[IMAGE src=... name=...] (@size:1024x1024) 文本内容
      let messageText = prompt;
      let assetId: string | null = null;
      let imageToken = '';

      // 如果有选中的图片，上传图片并添加到消息中
      if (selectedImage) {
        const uploadRes = await uploadVisualAgentWorkspaceAsset({
          id: ws.id,
          data: selectedImage.previewUrl,
          prompt: selectedImage.file.name || '参考图',
          idempotencyKey: `ws_asset_${ws.id}_${Date.now()}`,
        });
        if (uploadRes.success) {
          const asset = uploadRes.data.asset;
          assetId = asset.id;
          // 使用 [IMAGE src=... name=...] 标记（不是 @img1）
          // 注意：buildInlineImageToken 会对 URL 进行 encodeURIComponent，这是正确的
          imageToken = buildInlineImageToken(asset.url, selectedImage.file.name || asset.prompt || '参考图');
        } else {
          // 图片上传失败，但仍然继续（只使用文本提示）
          toast.error('图片上传失败', `${uploadRes.error?.message || '未知错误'}。将仅使用文本提示创建项目。`);
        }
      }

      // 构建最终消息：图片标记 + 尺寸标记 + 文本内容
      const sizeToken = selectedSize ? `(@size:${selectedSize}) ` : '';
      messageText = `${imageToken}${sizeToken}${messageText}`;

      // 3. 使用 sessionStorage 传递参数（避免刷新时重复创建）
      const sessionKey = `visual_agent_init_${ws.id}`;
      sessionStorage.setItem(sessionKey, JSON.stringify({
        messageText,
        assetId,
        timestamp: Date.now(),
      }));

      // 4. 跳转到 workspace 页面（不传递 URL 参数，避免刷新重复创建）
      navigate(getEditorPath(ws.id));

      // 清空输入和图片
      setInputValue('');
      setSelectedImage(null);
      setSelectedSize('1024x1024');
    } finally {
      setInputLoading(false);
    }
  };

  // 场景标签选择
  const onTagSelect = (prompt: string) => {
    if (!prompt) return;
    setInputValue(prompt);
    const tag = SCENARIO_TAGS.find((t) => t.prompt === prompt);
    setActiveTag(tag?.key ?? null);
  };

  // 处理图片选择
  const onImageSelect = async (file: File) => {
    // 验证文件大小（例如限制为 10MB）
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      toast.warning('图片文件过大，请选择小于 10MB 的图片');
      return;
    }
    const dim = await readImageSizeFromFile(file);
    const autoSize = computeRequestedSizeByRefRatio(dim) ?? '1024x1024';
    setSelectedSize(autoSize);
    // 生成预览 URL
    const normalized = await normalizeFileToSquareDataUrl(file);
    let previewUrl = normalized.dataUrl || '';
    if (!previewUrl) {
      previewUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
    }
    if (previewUrl) {
      setSelectedImage({ file, previewUrl });
    }
  };

  // 移除图片
  const onRemoveImage = () => {
    setSelectedImage(null);
  };

  const onSelectedSizeChange = (size: string) => {
    setSelectedSize(size);
    if (defaultSizeKey) { try { sessionStorage.setItem(defaultSizeKey, size); } catch { /* ignore */ } }
  };

  // 新建文件夹（目前作为占位功能，后续可接入后端）
  const onCreateFolder = async () => {
    const folderName = await systemDialog.prompt({
      title: '新建文件夹',
      message: '请输入文件夹名称',
      defaultValue: '新文件夹',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (folderName == null) return;
    // TODO: 后端尚未支持文件夹功能，暂时提示
    toast.info(`文件夹功能正在开发中，将创建名为「${folderName.trim() || '新文件夹'}」的文件夹。`);
  };

  const onRename = async (ws: VisualAgentWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新名称',
      defaultValue: ws.title || '',
      confirmText: '保存',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await updateVisualAgentWorkspace({
      id: ws.id,
      title: title.trim() || '未命名',
      idempotencyKey: `ws_rename_${Date.now()}`,
    });
    if (!res.success) {
      toast.error(res.error?.message || '重命名失败');
      return;
    }
    await reload();
  };

  const onDelete = async (ws: VisualAgentWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确认删除「${ws.title || '未命名'}」？（将删除画布与消息，资产记录会被清理）`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteVisualAgentWorkspace({ id: ws.id, idempotencyKey: `ws_del_${Date.now()}` });
    if (!res.success) {
      toast.error(res.error?.message || '删除失败');
      return;
    }
    await reload();
  };

  const openShare = async (ws: VisualAgentWorkspace) => {
    setShareWs(ws);
    setMemberSet(new Set((ws.memberUserIds ?? []).filter(Boolean)));
    setShareOpen(true);
    if (users.length === 0 && !usersLoading) {
      setUsersLoading(true);
      try {
        const res = await getUsers({ page: 1, pageSize: 200, role: 'ADMIN' });
        if (res.success) {
          setUsers(Array.isArray(res.data?.items) ? res.data.items : []);
        }
      } finally {
        setUsersLoading(false);
      }
    }
  };

  const saveShare = async () => {
    const ws = shareWs;
    if (!ws) return;
    const res = await updateVisualAgentWorkspace({
      id: ws.id,
      memberUserIds: memberIds,
      idempotencyKey: `ws_share_${Date.now()}`,
    });
    if (!res.success) {
      toast.error(res.error?.message || '保存共享失败');
      return;
    }
    setShareOpen(false);
    setShareWs(null);
    await reload();
  };

  return (
    <div
      className="surface-tone-dark h-full min-h-0 flex flex-col overflow-auto relative"
      style={{ background: 'var(--bg-base)' }}
    >
      {/* 潜像场：织纹周期与生图等待卡同源，「等待」和「首页」是同一种材质。
          旧版这里是星空插画 + 粒子漩涡——那是可以贴在任何产品上的装饰。 */}
      <LatentField />
      {/* 轮换背景。压暗罩由 BackdropPhoto 自带——那一层是 9-13px 小字可读性的唯一保障。 */}
      <BackdropPhoto src={backdrop?.url ?? null} dim={dimFor(backdrop)} />

      {/* 顶栏：品牌 + 创作/作品 + 右侧动作，与视频创作同结构。
          旧版这里只有一个孤零零的返回箭头和一枚教程胶囊，页面没有身份。 */}
      <div
        className="relative z-20 grid items-center px-6"
        style={{
          gridTemplateColumns: '1fr auto 1fr',
          minHeight: 64,
          borderBottom: '1px solid var(--border-faint)',
          background: 'var(--panel-solid)',
          backdropFilter: 'blur(16px)',
        }}
      >
        <div className="flex items-center gap-2.5 justify-self-start">
          <button
            type="button"
            aria-label="返回"
            onClick={() => navigate(-1)}
            className="grid place-items-center hover-bg-soft"
            style={{ width: 30, height: 30, borderRadius: 7, border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            <ArrowLeft size={16} />
          </button>
          <span
            className="grid place-items-center shrink-0"
            style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--text-primary)', color: 'var(--bg-base)' }}
          >
            <Image size={17} />
          </span>
          <span className="min-w-0">
            <strong className="block" style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>视觉创作</strong>
            <small className="block" style={{ marginTop: 1, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: 'var(--text-muted)' }}>DARKROOM</small>
          </span>
        </div>

        <div className="flex items-center gap-0.5 justify-self-center" style={{ height: 38, padding: 3, borderRadius: 8, background: 'var(--bg-secondary)' }}>
          <span
            className="grid place-items-center"
            style={{ minWidth: 64, height: 32, borderRadius: 6, background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 11, boxShadow: 'var(--shadow-card-sm)' }}
          >
            创作
          </span>
        </div>

        <div className="flex items-center gap-1.5 justify-self-end">
          <BackdropSettings
            assets={backdropAssets}
            generated={generatedBackdrops}
            onGeneratedChange={setGeneratedBackdrops}
            mode={backdropMode}
            onModeChange={setBackdropMode}
          />
          <TipsEntryButton compact />
        </div>
      </div>

      {/* 浮动工具栏 - 桌面端页面左侧垂直居中，移动端隐藏 */}
      {!isMobile && (
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
          <FloatingToolbar onNewProject={onCreate} onNewFolder={onCreateFolder} />
        </div>
      )}

      {/* 顶部居中区域。8vh 换成固定 52px：旧版 hero 自带 260px 高度，靠 vh 顶下来才不至于贴顶；
          现在标题区是内容高度，再按视口比例留白会在大屏上空出一大块。52px 取自视频创作的舞台节奏。 */}
      <div className="flex flex-col items-center justify-center pt-[52px] pb-4 relative z-10 px-5">
        {/* Hero 区域 */}
        <HeroSection />

        {/* 快捷输入框 */}
        <QuickInputBox
          value={inputValue}
          onChange={(v) => {
            setInputValue(v);
            const tag = SCENARIO_TAGS.find((t) => t.prompt === v);
            setActiveTag(tag?.key ?? null);
          }}
          onSubmit={onQuickSubmit}
          loading={inputLoading}
          onImageSelect={onImageSelect}
          selectedImage={selectedImage}
          onRemoveImage={onRemoveImage}
          size={selectedSize}
          onSizeChange={onSelectedSizeChange}
        />

        {/* 场景标签 */}
        <ScenarioTags onSelect={onTagSelect} activeKey={activeTag} />
      </div>

      {/* 错误提示 */}
      {error ? (
        <div className="px-5 mt-4">
          <GlassCard animated glow>
            <div className="text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>
              {error}
            </div>
          </GlassCard>
        </div>
      ) : null}

      {/* 项目列表 */}
      <ProjectCarousel
        items={items}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onCreate={onCreate}
        onRename={onRename}
        onShare={openShare}
        onDelete={onDelete}
        onOpen={(ws) => navigate(getEditorPath(ws.id))}
      />

      {/* 共享对话框 */}
      <Dialog
        open={shareOpen}
        onOpenChange={(o) => {
          setShareOpen(o);
          if (!o) setShareWs(null);
        }}
        title="共享 Workspace"
        description="选择可访问该 Workspace 的管理员账号（最小共享：成员可编辑）。"
        maxWidth={720}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              当前项目：{shareWs?.title || '未命名'}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              已选成员：{memberIds.length} 个
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-xl" style={{ border: '1px solid var(--border-subtle)' }}>
              {usersLoading ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  加载管理员列表中...
                </div>
              ) : users.length === 0 ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  未加载到管理员用户
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {users.map((u) => {
                    const checked = memberSet.has(u.userId);
                    return (
                      <button
                        key={u.userId}
                        type="button"
                        className="w-full flex items-center gap-3 rounded-lg px-3 py-2 hover-bg-soft"
                        style={{ border: '1px solid transparent', color: 'var(--text-primary)' }}
                        onClick={() => {
                          setMemberSet((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.userId)) next.delete(u.userId);
                            else next.add(u.userId);
                            return next;
                          });
                        }}
                      >
                        <input type="checkbox" checked={checked} readOnly />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">{u.displayName || u.username}</div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {u.userId}
                          </div>
                        </div>
                        <ArrowRight size={16} style={{ opacity: 0.6 }} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void saveShare()} disabled={!shareWs}>
                保存
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
