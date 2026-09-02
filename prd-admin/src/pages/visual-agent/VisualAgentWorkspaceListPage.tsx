
import { GlassCard } from '@/components/design/GlassCard';
import { SizePickerButton } from '@/components/visual-agent/SizePickerPanel';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  createVisualAgentWorkspace,
  deleteVisualAgentWorkspace,
  getUserPreferences,
  getUsers,
  getVisualAgentAdapterInfo,
  getVisualAgentImageGenModels,
  updateVisualAgentPreferences,
  listVisualAgentWorkspaces,
  refreshVisualAgentWorkspaceCover,
  updateVisualAgentWorkspace,
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
  Bug,
  X,
} from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useAuthStore } from '@/stores/authStore';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildVisualAgentModelOptions, type VisualAgentModelOption } from '@/pages/ai-chat/visualAgentModelOptions';
import { normalizeSizesByResolution, reconcileSize, type SizesByResolution } from '@/lib/visualModelSizes';
import { useNavigate } from 'react-router-dom';
import { buildInlineImageToken, computeRequestedSizeByRefRatio, readImageSizeFromFile } from '@/lib/visualAgentPromptUtils';
import { normalizeFileToSquareDataUrl } from '@/lib/imageSquare';
import { BackdropPhoto, PageVignette } from '@/components/effects/PageBackdrop';
import { BackdropSettings, readBackdropMode, resolveBackdrop, type BackdropMode } from '@/components/visual-agent/BackdropSettings';
import type { BackdropAsset } from '@/lib/backdropRotation';
import { BACKDROP_CATALOG, dimFor } from '@/lib/backdropCatalog';
import { readGeneratedBackdrops } from '@/lib/backdropStudio';
import { consumeWakeOnce } from '@/lib/wakeSweep';
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
 * 标题区。
 *
 * 这里**没有口号**，是刻意的。之前挂的是「先落到画布，再谈生成」，
 * 用户一句话判了死刑：很 low。回头看它确实是口号体——在教用户该怎么想，
 * 而不是帮他开始干活；而且下面那行说明已经把同一件事讲清楚了，等于说了两遍。
 *
 * 换成一句直接指向下面输入框的问句。工作台的首页不需要立场，
 * 需要的是让人立刻开始打字。同理删掉了原来那行眉标（「一次粘几张参考图开局」）：
 * 它和输入框里那句「直接按 ⌘V 粘贴」是同一句话，重复一遍只会把标题往下推。
 *
 * 更早一版是 42px 青绿渐变标题——渐变字是 2022 年的手法，而且那套青绿
 * 和产品唯一的品牌色 #D97757 毫无关系，等于页面有两套色。
 */
function HeroSection() {
  return (
    <div className="relative w-full flex flex-col items-center text-center" style={{ paddingTop: 8 }}>
      <h1
        data-tour-id="visual-page-title"
        className="text-[32px] font-semibold leading-[1.2]"
        style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
      >
        今天做什么图？
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

// ============ 绘图模型选择（工具行 chip） ============
/**
 * 首页这条工具行上的模型 chip。
 *
 * 刻意**不是**编辑器那个大面板的搬运：那边挂着智能切换/严格模式/健康统计，
 * 是「我要精调这次生成」的场景；首页是「我要开始」，只需要看见用哪个模型、
 * 能换一个（好用四原则 #2 奥卡姆：首屏只暴露 80% 场景需要的）。
 * 数据源和偏好存储与编辑器完全一致，所以两边看到的默认值必然是同一个。
 */
function ModelPickerButton(props: {
  options: VisualAgentModelOption[];
  modelId?: string;
  onChange: (id: string) => void;
}) {
  const { options, modelId, onChange } = props;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.top - 8, left: rect.left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = options.find((o) => o.id === modelId) ?? null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="inline-flex items-center gap-1.5 hover-bg-soft transition-colors"
        style={{
          minHeight: 36,
          padding: '0 9px',
          borderRadius: 7,
          border: 0,
          background: open ? 'var(--bg-secondary)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontSize: 10,
          cursor: 'pointer',
        }}
        title="选择绘图模型"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <Sparkles size={13} className="shrink-0" />
        <span className="truncate" style={{ maxWidth: 120, whiteSpace: 'nowrap' }}>
          {current?.name || current?.modelName || '选择模型'}
        </span>
        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>▾</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)', zIndex: 9999 }}
        >
          <div
            className="rounded-[12px] overflow-hidden"
            style={{
              width: 260,
              maxHeight: 320,
              overflowY: 'auto',
              background: 'var(--panel-solid)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-card)',
              padding: 5,
            }}
          >
            {options.map((opt) => {
              const active = opt.id === modelId;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className="w-full text-left hover-bg-soft transition-colors"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    padding: '7px 9px',
                    borderRadius: 8,
                    border: 0,
                    background: active ? 'var(--bg-secondary)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    // 不可用的模型不隐藏、只压暗并说明：藏起来用户会以为「怎么少了一个」，
                    // 而看见「暂不可用」至少知道发生了什么（no-rootless-tree：暴露缺失）。
                    opacity: opt.enabled ? 1 : 0.45,
                  }}
                  onClick={() => { onChange(opt.id); setOpen(false); }}
                >
                  <span style={{ fontSize: 12, fontWeight: active ? 600 : 500 }}>
                    {opt.name || opt.modelName}
                    {opt.isDefault ? <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--text-muted)' }}>默认</span> : null}
                  </span>
                  <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                    {opt.enabled ? (opt.subtitle || opt.actualModelId || '') : '暂不可用'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
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
  /** 该模型支持的尺寸（来自 adapter-info）。给不出就传 null，尺寸表退回静态档位。 */
  availableSizes?: SizesByResolution | null;
  /** 绘图模型：目录 + 当前选中 + 切换。默认值来自用户上次生成用的那个模型。 */
  modelOptions?: VisualAgentModelOption[];
  modelId?: string;
  onModelChange?: (id: string) => void;
  /** 让页面拿到 textarea：选完预设格要把光标送进来。 */
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const {
    value, onChange, onSubmit, loading, onImageSelect, selectedImage, onRemoveImage,
    size = '1024x1024', onSizeChange, availableSizes, modelOptions, modelId, onModelChange, inputRef,
  } = props;
  const typingPlaceholder = useTypingPlaceholder();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  /*
   * 宽度 880。这是这一页从暗房版式落地起一直用的值，不是新拍的一个数。
   *
   * 中间它被我动过两轮，两轮都错在同一处**误判**：用户报「输入框怎么又短又小」，
   * 我当成宽度值写小了，先后改成 clamp(680,58vw,1180) 和 min(100%,1300px)。
   * 真正的原因是包裹层的 className 被 `{...rise()}` 覆盖掉、丢了 w-full 之后
   * 塌成 350（详见 rise 上方那段），**宽度值自始至终是好的**。
   * 于是两轮「修复」的结果是：塌陷还在，框倒被我越改越宽，
   * 用户只好再说一次「确实变大了，但我要的是恢复原状」。
   *
   * 教训：症状是「变窄了」不等于「宽度写小了」。先量真实盒子，
   * 判清是值的问题还是链路的问题，再决定改哪一个。
   */
  return (
    <div className="w-full mx-auto mt-5" style={{ width: 'min(880px, 100%)' }}>
      <div
        // 磨砂玻璃：底色、模糊、顶边高光、投影全在 .glass-pane 里（见 globals.css）。
        // 聚焦态要盖掉 glass-pane 自带的 box-shadow，所以这里把高光那一段一起写回去，
        // 否则一聚焦玻璃的边就没了。
        className="glass-pane overflow-hidden cursor-text transition-colors"
        style={{
          borderRadius: 8,
          border: `1px solid ${focused ? 'var(--border-focus)' : 'var(--border-subtle)'}`,
          boxShadow: focused
            ? 'inset 0 1px 0 var(--glass-edge), var(--glass-shadow), 0 0 0 3px rgba(var(--accent-primary-rgb), 0.14)'
            : undefined,
        }}
        onClick={handleContainerClick}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/*
         * 打字区。
         *
         * 上一版这块是 96 高、里面一个 2 行 60px 的 textarea——整块输入框 820x180，
         * 长宽比 4.6:1 的窄条，真正能打字的只有 60px，比一张项目卡的封面（160px）还矮。
         * 用户的原话是「是否需要像苹果的触控板一样做大点」，方向对：这块面同时还是
         * 拖放目标（「把图拖进来当参考图」），窄条不像一块能往上放东西的面。
         *
         * 没有做到触控板的 1.6:1——880 宽照那个比例是 550 高，加上顶栏、标题区、
         * 预设行，「最近项目」会被整个推到折叠线以下。取 190（整块约 3.4:1）：
         * 打字区从 60 涨到 130，参考图直接落在这块面里，而项目列表第一行仍在首屏。
         *
         * 关键前提：**高度必须由内容换来**。空的大框比空的小框更糟（零摩擦那条规则），
         * 所以参考图从下面那条 30px 的 chip 行搬进来了，占的是这块面本身。
         */}
        <div
          className="relative px-5 pt-4 pb-2 flex flex-col"
          // 190 是定值，不许改成跟视口走的 clamp。
          //
          // 我为此返工过一轮：把宽度误改到 1300 之后，190 的高看着成了细横条，
          // 于是又拿 clamp(190,19vw,360) 去「配平」——高度跟着一个本来就错的宽度长，
          // 在宽屏上顶到 360 上限，整块面成了一个空荡荡的大方块，
          // 用户一眼看出「没有这么高吧」。宽度回到 880 之后，190 本来就是对的。
          //
          // 这块面的高度是拿内容换来的（打字区 130 + 参考图槽落在面内），
          // 不是按屏幕大小分配的空间；视口一宽就跟着长，只会长出空白。
          style={{ minHeight: 190 }}
        >
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
            ref={(el) => {
              textareaRef.current = el;
              if (inputRef) inputRef.current = el;
            }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={4}
            data-tour-id="visual-prompt-input"
            className="w-full bg-transparent resize-none no-focus-ring"
            style={{
              color: 'var(--text-primary)',
              fontSize: 14,
              lineHeight: 1.65,
              flex: '1 1 auto',
              minHeight: 130,
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

          {/* 参考图落在这块面上，而不是挤在一条 30px 的附加行里。
              没有参考图时同一个位置放一个虚线空槽——把面做大之后，
              本地取证第一版这里是一片纯粹的空白（浅色下尤其明显），
              那正是「空的大框比空的小框更糟」。空槽既填住这块地方，
              又把这块面是个拖放目标这件事说清楚，图一落下它就被真图替换。 */}
          {!selectedImage && (
            /*
             * 空槽本身就是第三条入口：点它 = 打开文件选择器。
             *
             * 上一版这里挂着 pointer-events-none，理由是「它只是个提示」——但它长得
             * 完完全全像一个上传区（虚线框 + 图片图标 + 一句「拖到这里」），
             * 用户第一反应就是点它，点了没反应。看着能点就必须能点，
             * 这正是这一轮刚修掉的三个死控件的同一种错，不能自己再造一个。
             *
             * 拖放和粘贴原本就由外层容器接着，这里只补「点」这一路。
             */
            <button
              type="button"
              onClick={handleImageButtonClick}
              aria-label="选择参考图"
              className="mt-auto mr-auto pt-2.5 flex items-center gap-2.5 group/slot bg-transparent border-0 p-0 cursor-pointer text-left"
            >
              <span
                className="grid place-items-center shrink-0 transition-colors"
                style={{
                  width: 56, height: 56, borderRadius: 6,
                  border: `1px dashed ${isDragging ? 'var(--border-focus)' : 'var(--border-default)'}`,
                  color: 'var(--text-muted)',
                }}
              >
                <Image size={16} />
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.6 }}>
                点这里选图，或把参考图拖进来 / 按 {isMac ? '⌘V' : 'Ctrl+V'} 粘贴
              </span>
            </button>
          )}
          {selectedImage && (
            <div className="mt-auto pt-2.5 flex items-end gap-2">
              <div
                className="relative group/ref shrink-0"
                title={`参考图：${selectedImage.file.name}`}
              >
                <img
                  src={selectedImage.previewUrl}
                  alt=""
                  style={{
                    width: 56, height: 56, borderRadius: 6, objectFit: 'cover', display: 'block',
                    boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
                  }}
                />
                {onRemoveImage && (
                  <button
                    type="button"
                    aria-label="移除参考图"
                    onClick={(e) => { e.stopPropagation(); onRemoveImage(); }}
                    className="absolute -top-1.5 -right-1.5 grid place-items-center transition-opacity opacity-0 group-hover/ref:opacity-100 focus-visible:opacity-100"
                    style={{
                      width: 18, height: 18, borderRadius: 9, border: 0, cursor: 'pointer',
                      background: 'var(--panel-solid)', color: 'var(--text-secondary)',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                    }}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
              <span
                className="truncate pb-0.5"
                style={{ color: 'var(--text-muted)', fontSize: 10, maxWidth: 220 }}
              >
                {selectedImage.file.name}
              </span>
            </div>
          )}
        </div>

        {/* 原来这里有一条独立的「⌘V 粘贴 / 拖图进来」说明行。
            现在这句话由打字区里的虚线空槽承担——就写在那个槽旁边，
            说的正是那个槽的用法，比隔着一条分割线在下面另起一行准确，也少一行 chrome。 */}

        {/* 底部工具条：自带底色 + 上边框，与视频创作同结构。 */}
        <div
          className="glass-sub flex items-center justify-between gap-2.5"
          style={{
            minHeight: 58,
            padding: '9px 10px 9px 13px',
            borderTop: '1px solid var(--border-faint)',
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
            {/* 绘图模型。这条工具行原来没有它——首页是「开始生成」的入口，
                却看不见也选不了用哪个模型，而换模型是用户能直接感知到结果差异的
                （ai-model-visibility：这类功能必须让模型可见）。
                默认值是用户上次生成用的那个，不是每次回到「自动」。 */}
            {onModelChange && modelOptions && modelOptions.length > 0 && (
              <span data-tour-id="visual-model-btn" className="inline-flex">
                <ModelPickerButton options={modelOptions} modelId={modelId} onChange={onModelChange} />
              </span>
            )}
            {onSizeChange && (
              <span data-tour-id="visual-size-btn" className="inline-flex">
                <SizePickerButton size={size} onSizeChange={onSizeChange} availableSizes={availableSizes} />
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
      // 与上面输入台同宽，两者必须一起改——预设行比输入框宽或窄都会露出错位的边。
      style={{ width: 'min(880px, 100%)' }}
    >
      {SCENARIO_TAGS.map((tag) => {
        const Icon = tag.icon;
        const isActive = tag.isPro ? activeKey === tag.key || activeKey === null : activeKey === tag.key;
        return (
          <button
            key={tag.key}
            type="button"
            data-tour-id={tag.isPro ? 'visual-pro' : undefined}
            // MAP Pro 也要能点。它的高亮条件本来就是 activeKey === null，
            // 语义即「没选任何预设」——所以点它 = 清空输入回到自由描述。
            // 上一版这里写的是 if (!tag.isPro)，六格里默认高亮的第一格点了没有任何反应。
            onClick={() => onSelect(tag.prompt)}
            className={`${isActive ? '' : 'glass-sub '}inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-[7px] text-[9px] shrink-0 transition-colors`}
            style={{
              minHeight: 38,
              // 选中态保持实心卡面：它要从这一排里跳出来，磨砂会把它压回去。
              background: isActive ? 'var(--bg-card)' : undefined,
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
        {hasCover ? (
          <CoverMosaic title={ws.title || ws.id} assets={ws.coverAssets} />
        ) : (
          /* 还没有图的项目。上一版这里什么都不放，卡片就是一个纯色空框——
             和「封面加载失败」长得一模一样，用户分不出是没画过还是坏了。
             放项目名首字 + 一句说明，一眼就知道它是空的、不是坏的。 */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
            <span
              className="grid place-items-center"
              style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'var(--nested-block-bg)',
                color: 'var(--text-secondary)',
                fontSize: 17, fontWeight: 600,
              }}
            >
              {(ws.title || '未').trim().slice(0, 1)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>还没有图</span>
          </div>
        )}
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
/**
 * 项目卡骨架。
 *
 * 形状照着 ProjectCard 一比一：160px 的封面块 + 13px 标题条 + 11px 日期条，
 * 位置和尺寸都对得上，所以真数据落位时不会跳。这是「产物形状的骨架」——
 * 上一版这里是一个居中 spinner，它既不告诉你要来几张，也不占位，
 * 列表一到整页往下弹一截。
 *
 * 扫光沿 45 度走，和印相台的织纹同一个角度；错峰启动，免得九张卡一起闪。
 *
 * 和「统一加载组件」那条规则不冲突，别改回去：那条禁的是**裸 lucide spinner**，
 * 要求区块加载走 MapSectionLoader；而 artifact-is-experience 更进一步——
 * 有确定形状的列表要用**产物形状的骨架**，不用居中 spinner。这里取更高的那一档。
 */
function ProjectCardSkeleton({ index }: { index: number }) {
  return (
    <div aria-hidden>
      <div
        className="skeleton-sheen h-[160px] w-full rounded-xl"
        style={{ animationDelay: `${(index % 5) * 110}ms` }}
      />
      <div className="pt-2.5 px-0.5">
        <div
          className="skeleton-sheen rounded"
          style={{ height: 9, width: '58%', animationDelay: `${(index % 5) * 110 + 60}ms` }}
        />
        <div
          className="skeleton-sheen mt-2 rounded"
          style={{ height: 7, width: '32%', animationDelay: `${(index % 5) * 110 + 120}ms` }}
        />
      </div>
    </div>
  );
}

function ProjectCarousel(props: {
  onCreateFolder: () => void;
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
  const { items, loading, loadingMore, hasMore, onLoadMore, onCreate, onCreateFolder, onRename, onShare, onDelete, onOpen } = props;
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

  return (
    <div className="mt-8 flex-1 relative z-10">
      {/* 标题栏 - 增加分隔线和更好的层级。
          注意它在 loading 时也渲染：骨架期把标题和分隔线留在原位，
          列表到位时页面不会整体往下跳一截。 */}
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
          {/* 从左侧那条浮动工具栏搬过来的。带文字——匿名图标悬在页面左缘时
              没人认得出它是什么，也跟它要操作的这个列表隔着大半个屏幕。 */}
          <button
            type="button"
            onClick={onCreateFolder}
            className="glass-sub inline-flex items-center gap-1.5 rounded-md px-2.5 h-7 text-[11px] transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <FolderPlus size={12} />
            新建文件夹
          </button>
        </div>
      </div>
      {/* 网格布局，响应式列数 */}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-5 pb-6 px-5 max-w-[1340px] mx-auto"
      >
        <NewProjectCard onClick={onCreate} />
        {loading && Array.from({ length: 9 }).map((_, i) => <ProjectCardSkeleton key={`sk-${i}`} index={i} />)}
        {!loading && items.map((ws) => (
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
      {/* 翻页也用骨架，和首屏同一种形状——换成 spinner 会在同一页出现两种等待语言。 */}
      {loadingMore && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-5 pb-6 px-5 max-w-[1340px] mx-auto">
          {Array.from({ length: 5 }).map((_, i) => <ProjectCardSkeleton key={`skm-${i}`} index={i} />)}
        </div>
      )}
      {hasMore && <div ref={sentinelRef} className="h-1" />}
    </div>
  );
}

/**
 * 量出 dataURL 图片的像素尺寸。纯本地，不发网络。
 *
 * 这个值有两处用途，缺了都会出问题：
 *   1. 画布落位——尺寸未知的元素在碰撞表里没有体积，新生成的图会直接压到参考图上；
 *   2. 存进资产——后端不解码图片算尺寸，客户端不给就永远是空，下次重建画布还是没体积。
 *
 * 量不出来（解码失败 / 非图片）就返回 null，让下游走兜底档，不编一个尺寸。
 */
function measureDataUrl(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve(null);
    // 注意：这个文件从 lucide-react 引了名为 Image 的图标，遮住了全局构造器，必须走 window。
    const img = new window.Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      resolve(w > 0 && h > 0 ? { w, h } : null);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ============ 主页面 ============
export default function VisualAgentWorkspaceListPage(props: { fullscreenMode?: boolean }) {
  // fullscreenMode 参数保留用于兼容，但现在所有模式都是全屏
  const _fullscreenMode = props.fullscreenMode;
  void _fullscreenMode; // 避免 TS6133 警告
  const navigate = useNavigate();
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

  // ---- 绘图模型（首页也要能看见、能选）----
  // 目录、偏好存储、尺寸能力三样都复用编辑器已有的那套，不另起炉灶：
  // 只有共用同一个 visualAgentPreferences.modelId，两边的「上次用的模型」才是同一个。
  const [modelOptions, setModelOptions] = useState<VisualAgentModelOption[]>([]);
  const [modelId, setModelId] = useState<string>('');
  const [availableSizes, setAvailableSizes] = useState<SizesByResolution | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [poolsRes, prefRes] = await Promise.all([
        getVisualAgentImageGenModels(),
        getUserPreferences().catch(() => null),
      ]);
      if (cancelled) return;
      const options = poolsRes.success ? buildVisualAgentModelOptions(poolsRes.data ?? []) : [];
      setModelOptions(options);
      // 默认值优先级：上次生成用的那个 → 服务端标记的默认池 → 第一个可用。
      // 注意 prefs 里存的是 option.id（pool_xxx），和编辑器同一套标识，不能换成 modelName。
      const preferred = prefRes?.success ? String(prefRes.data?.visualAgentPreferences?.modelId ?? '') : '';
      const pick = options.find((o) => o.id === preferred && o.enabled)
        ?? options.find((o) => o.enabled && o.isDefault)
        ?? options.find((o) => o.enabled)
        ?? null;
      setModelId(pick?.id ?? '');
    })();
    return () => { cancelled = true; };
  }, []);

  // 选定模型 → 拉它支持的尺寸 → 当前尺寸不被支持就纠正。
  // 纠正规则在 lib/visualModelSizes（比例优先、拿不到就不动），那里有单测。
  const currentModel = useMemo(() => modelOptions.find((o) => o.id === modelId) ?? null, [modelOptions, modelId]);
  useEffect(() => {
    let cancelled = false;
    // 生成请求用池 ID，但尺寸能力必须按池内**实际上游模型**查，否则适配器命中不了、
    // 尺寸会被错误清空（编辑器那边同一个坑，注释见 AdvancedVisualAgentTab 的 adapter-info effect）。
    const modelCode = currentModel?.actualModelId || currentModel?.modelName;
    if (!modelCode) { setAvailableSizes(null); return; }
    void getVisualAgentAdapterInfo(modelCode)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data?.matched && res.data.sizesNotApplicable !== true && res.data.sizesByResolution) {
          setAvailableSizes(normalizeSizesByResolution(res.data.sizesByResolution));
        } else {
          // 没命中 / 该模型尺寸语义不适用 → 明确置空，让尺寸表退回静态档位，不假装知道。
          setAvailableSizes(null);
        }
      })
      .catch(() => { if (!cancelled) setAvailableSizes(null); });
    return () => { cancelled = true; };
  }, [currentModel]);

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
      // 1. 创建 workspace。
      //
      // 这是跳转前**唯一**必须等的网络往返——没有 workspace id 就没有目的地。
      // 偏好写回和它互不依赖，并行发，两个往返重叠成一个的时间。
      // 参考图的上传不在这里等（见下面第 2 步）。
      const [res] = await Promise.all([
        createVisualAgentWorkspace({
          title: prompt.slice(0, 20) || '未命名',
          idempotencyKey: `ws_quick_${Date.now()}`,
        }),
        // 把这次选的模型写回账号偏好。必须在跳转前落地：编辑器挂载时会读同一份
        // visualAgentPreferences，先跳转再写就是竞态，用户会看到「首页选了 A，进去却是 B」。
        // modelAuto 置 false：用户在首页显式选过了，就不该再被自动挑选覆盖。
        modelId
          ? updateVisualAgentPreferences({ modelAuto: false, modelId }).catch(() => {
            // 偏好写失败不阻断创作——这次生成仍按当前选择走，只是下次默认值可能还是旧的。
          })
          : Promise.resolve(),
      ]);
      if (!res.success) {
        toast.error(res.error?.message || '创建失败');
        return;
      }
      const ws = res.data.workspace;

      // 2. 构建消息文本（使用 [IMAGE src=... name=...] 和 (@size:...) 标记）
      // 格式：${inlineRefToken}${uiSizeToken}${display || reqText}
      // 即：[IMAGE src=... name=...] (@size:1024x1024) 文本内容
      let messageText = prompt;
      const assetId: string | null = null;
      let imageToken = '';
      let imageSize: { w: number; h: number } | null = null;

      // 2. 参考图**不在这里上传**。
      //
      // 以前是「传完图才跳转」：一张手机照片转成 base64 要多传三分之一体积，用户就对着
      // 一个不动的「生成中…」等十几秒，而这段时间画布明明已经可以打开了。
      // 现在直接把 dataURL 交给画布，由画布在生成前的既有落盘逻辑上传
      //（AdvancedVisualAgentTab 的 needEnsure 分支：dataURL 参考图先传一次拿 sha 再生成，
      //  失败会把卡片标成「未持久化」并提示，不是静默丢图）。
      //
      // 顺带把像素尺寸量出来一起交过去：画布拿它当卡片的真实体积，
      // 上传时也会带给后端，否则这张资产的 width/height 永远是空。
      if (selectedImage) {
        imageSize = await measureDataUrl(selectedImage.previewUrl);
        imageToken = buildInlineImageToken(selectedImage.previewUrl, selectedImage.file.name || '参考图');
      }

      // 构建最终消息：图片标记 + 尺寸标记 + 文本内容
      const sizeToken = selectedSize ? `(@size:${selectedSize}) ` : '';
      messageText = `${imageToken}${sizeToken}${messageText}`;

      // 3. 使用 sessionStorage 传递参数（避免刷新时重复创建）
      //
      // dataURL 可能有好几 MB，超配额时 setItem 会抛。抛了不能让整个提交挂掉——
      // 退而存一份不带图的，用户至少还能带着文字进画板（参考图需要重新拖一次）。
      const sessionKey = `visual_agent_init_${ws.id}`;
      const payload = { messageText, assetId, imageSize, timestamp: Date.now() };
      try {
        sessionStorage.setItem(sessionKey, JSON.stringify(payload));
      } catch {
        try {
          sessionStorage.setItem(sessionKey, JSON.stringify({ ...payload, messageText: `${sizeToken}${prompt}` }));
          toast.error('参考图太大，未能带入画板', '已带入文字提示，请在画板里重新拖入这张图。');
        } catch {
          // sessionStorage 完全不可用：跳转后画板就是一个空工作区，不额外报错刷屏。
        }
      }

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

  // 整页刷新时那一束光该不该放。useState 的初始化函数只跑一次，正好消费掉那一次机会；
  // 写成 useState(consumeWakeOnce()) 会在每次 render 求值（React 只用第一次的结果，
  // 但机会已经被后面的 render 白白消费掉了），SPA 内再进来就永远没有。
  const [wake] = useState(() => consumeWakeOnce());
  /**
   * 沿光路依次点亮：左上先亮，右下最后。数值是幕 2500ms 行程上的取样点。
   *
   * **base 必须从这里传进去，不能写在元素的 className 上。**
   * 上一版是 `<div className="w-full flex justify-center" {...rise(950)}>`——
   * JSX 的 spread 在后面，`className: 'wake-rise'` 把前面那串整个覆盖掉了。
   * 包裹层丢了 w-full，而它的父级是 flex-col + items-center，块级子元素在这里
   * **不拉伸**，于是塌成内容宽；输入框的 min(100%, 1300px) 把 100% 解析到那个
   * 内容宽的盒子上，1300 的长框缩成了三百多。
   *
   * 最阴的是它**只在整页刷新时发生**（wake 为 true 才走 rise），SPA 内点进来完全正常——
   * 而用户正是在刷新页面看唤醒动画时撞上的。合并 className 这件事交给这个函数，
   * 调用方就没有把它写在两个地方的机会。
   */
  const rise = (delayMs: number, base = '') =>
    wake
      ? {
          className: base ? `${base} wake-rise` : 'wake-rise',
          style: { '--wake-delay': `${delayMs}ms` } as React.CSSProperties,
        }
      : (base ? { className: base } : {});

  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // 预设格：填词 + 把光标送进输入框。
  //
  // 两处都修过，原来这一排里有一格是死的：
  // 1. ScenarioTags 的 onClick 写着 if (!tag.isPro)，MAP Pro 直接不进这个函数；
  // 2. 就算进来了，这里第一行原本是 if (!prompt) return —— 空 prompt 照样被吞掉。
  // 典型的「链路只建一半」：修了第一处不修第二处，那一格还是点了没反应。
  const onTagSelect = (prompt: string) => {
    setInputValue(prompt);
    setActiveTag(SCENARIO_TAGS.find((t) => t.prompt === prompt)?.key ?? null);
    // 无论填词还是清空，光标都落进输入框——否则「选中 MAP Pro」在输入本来就空时
    // 是一次零反馈的点击，跟没接线没有区别。
    const el = promptRef.current;
    if (el) {
      el.focus();
      const end = prompt.length;
      requestAnimationFrame(() => el.setSelectionRange(end, end));
    }
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

  const onModelChange = (id: string) => {
    setModelId(id);
  };

  // 换模型之后把尺寸纠正到新模型支持的那一个。
  // 放在 effect 里而不是 onModelChange 里：尺寸清单是异步拉回来的，
  // 在点击那一刻还不知道新模型支持什么，当场纠正必然是拿旧清单算的（形状 6：读的不是生效的那个值）。
  useEffect(() => {
    const next = reconcileSize(selectedSize, availableSizes);
    if (next && next !== selectedSize) onSelectedSizeChange(next);
    // selectedSize 不进依赖：这里只在「模型的尺寸清单变了」时纠正一次，
    // 把它加进来会让用户随后手选的尺寸被同一条规则再纠一遍，选不动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSizes]);

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
      className="surface-tone-dark h-full min-h-0 relative"
      style={{ background: 'var(--bg-base)' }}
    >
      {/* 背景两层，顺序不能反：底下是轮换的那张图（压暗罩由 BackdropPhoto 自带，
          是小字可读性的唯一保障），上面一层非重复的渐晕。
          这里曾经压着一整层程序美术（印相台），量下来五件器物只有一件看得见、
          唯一有存在感的是无意的重复纹理，已整层删除，判据见 PageBackdrop.tsx。

          它们必须挂在**滚动容器之外**这一层。上一版和内容放在同一个 overflow-auto
          容器里，absolute inset:0 在滚动容器里量的是**可视框**、而且跟着内容一起滚——
          于是往下滑两屏，背景就从画面顶上滑走了，剩下一片纯底色（用户原话：
          滑动下去背景居然消失了）。外层不滚、内层滚，背景才是钉住的。 */}
      <BackdropPhoto src={backdrop?.url ?? null} dim={dimFor(backdrop)} focus={backdrop?.focus} />
      <PageVignette />
      {/* 唤醒幕。挂在背景与内容之间、不滚动的那一层——它遮的是整屏，不是内容的某一段。
          它退到哪里，背景才第一次在那里显影。 */}
      {wake && <div className="wake-veil" aria-hidden />}
      <div className="h-full min-h-0 flex flex-col overflow-auto relative" style={{ zIndex: 1 }}>

      {/* 顶栏：品牌 + 创作/作品 + 右侧动作，与视频创作同结构。
          旧版这里只有一个孤零零的返回箭头和一枚教程胶囊，页面没有身份。 */}
      <div
        className={`glass-pane relative z-20 grid items-center px-6${wake ? ' wake-rise' : ''}`}
        style={{
          gridTemplateColumns: '1fr auto 1fr',
          minHeight: 64,
          borderBottom: '1px solid var(--border-faint)',
          ...(wake ? ({ '--wake-delay': '160ms' } as React.CSSProperties) : {}),
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
          {/*
            品牌标记：一枚套准十字，和背景印相台四角那四枚同一个符号。
            上一版是一块 34x34 的实心 --text-primary 方块——它是整页最亮的东西，
            比标题还抢眼，而里面只是个占位图标，不表示任何东西。
            线性、低对比、和背景同源：它标身份，不抢注意力。
          */}
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 30,
              height: 30,
              borderRadius: 7,
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
            aria-hidden
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="12" cy="12" r="5.5" />
              <path d="M12 3v18M3 12h18" strokeLinecap="round" />
            </svg>
          </span>
          <span className="min-w-0">
            <strong className="block" style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>视觉创作</strong>
            <small className="block" style={{ marginTop: 1, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: 'var(--text-muted)' }}>DARKROOM</small>
          </span>
        </div>

        {/* 当前位置，纯标签。
            上一版这里套着 glass-sub + padding 3 + radius 8 的分段控件外壳，里面只装了
            一个不可点的 span——看着像个开关，没有第二项可切，点了什么都不会发生
            （「只有一个选项的选择器一律不显示」）。等真做出「作品」那一栏，
            再把控件外壳加回来。 */}
        <span
          className="justify-self-center"
          style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--text-secondary)' }}
        >
          创作
        </span>

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

      {/* 这里原本挂着一条左侧浮动工具栏（新建项目 / 新建文件夹）。撤掉了：
          「新建项目」在这一页已经有两个入口（最近项目里那张大虚线卡、输入框的开始创作），
          它是第三个；而且是贴着视口左缘、没有文字、悬在空白里的图标，跟任何东西都没有
          空间关系。「新建文件夹」挪到了「最近项目」标题行，带文字。 */}

      {/* 顶部居中区域。8vh 换成固定 52px：旧版 hero 自带 260px 高度，靠 vh 顶下来才不至于贴顶；
          现在标题区是内容高度，再按视口比例留白会在大屏上空出一大块。52px 取自视频创作的舞台节奏。 */}
      <div className="flex flex-col items-center justify-center pt-[52px] pb-4 relative z-10 px-5">
        {/* Hero 区域 */}
        <div {...rise(570)}><HeroSection /></div>

        {/* 快捷输入框 */}
        <div {...rise(950, 'w-full flex justify-center')}>
        <QuickInputBox
          inputRef={promptRef}
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
          availableSizes={availableSizes}
          modelOptions={modelOptions}
          modelId={modelId}
          onModelChange={onModelChange}
        />
        </div>

        {/* 场景标签 */}
        <div {...rise(1330, 'w-full flex justify-center')}>
          <ScenarioTags onSelect={onTagSelect} activeKey={activeTag} />
        </div>
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

      {/* 项目列表。光路最后一站。
          这一层的 className 不走 rise()——ProjectCarousel 的根是 flex-1，
          外面套一个不带 flex-1 的 div 会让它塌成内容高度（full-height-layout 那条链断一层就全塌）。
          所以这里手拼：flex 链照旧，只把 wake-rise 追加上去。 */}
      <div
        className={`flex-1 min-h-0 flex flex-col${wake ? ' wake-rise' : ''}`}
        style={wake ? ({ '--wake-delay': '1740ms' } as React.CSSProperties) : undefined}
      >
        <ProjectCarousel
          onCreateFolder={onCreateFolder}
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
      </div>

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
    </div>
  );
}
