import { GlassCard } from '@/components/design/GlassCard';
import { SizePickerButton } from '@/components/visual-agent/SizePickerPanel';
import { glassToolbar, glassInputArea } from '@/lib/glassStyles';
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
} from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useAuthStore } from '@/stores/authStore';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildInlineImageToken, computeRequestedSizeByRefRatio, readImageSizeFromFile } from '@/lib/visualAgentPromptUtils';
import { normalizeFileToSquareDataUrl } from '@/lib/imageSquare';
import { ParticleVortex } from '@/components/effects/ParticleVortex';

// ============ 夜景背景 Canvas 组件 ============
function NightSkyBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    resize();
    window.addEventListener('resize', resize);

    // 星星类
    class StarObj {
      size: number;
      speed: number;
      x: number;
      y: number;
      opacity: number;

      constructor(x: number, y: number) {
        this.size = Math.random() * 2;
        this.speed = Math.random() * 0.03;
        this.x = x;
        this.y = y;
        this.opacity = Math.random() * 0.5 + 0.3;
      }

      reset() {
        this.size = Math.random() * 2;
        this.speed = Math.random() * 0.03;
        this.x = width;
        this.y = Math.random() * height;
        this.opacity = Math.random() * 0.5 + 0.3;
      }

      update() {
        this.x -= this.speed;
        if (this.x < 0) {
          this.reset();
        } else {
          ctx!.globalAlpha = this.opacity;
          ctx!.fillRect(this.x, this.y, this.size, this.size);
          ctx!.globalAlpha = 1;
        }
      }
    }

    // 流星类
    class ShootingStar {
      x: number;
      y: number;
      len: number;
      speed: number;
      size: number;
      waitTime: number;
      active: boolean;

      constructor() {
        this.x = 0;
        this.y = 0;
        this.len = 0;
        this.speed = 0;
        this.size = 0;
        this.waitTime = 0;
        this.active = false;
        this.reset();
      }

      reset() {
        this.x = Math.random() * width;
        this.y = 0;
        this.len = Math.random() * 80 + 10;
        this.speed = Math.random() * 10 + 6;
        this.size = Math.random() * 1 + 0.1;
        this.waitTime = Date.now() + Math.random() * 5000 + 1000;
        this.active = false;
      }

      update() {
        if (this.active) {
          this.x -= this.speed;
          this.y += this.speed;
          if (this.x < 0 || this.y >= height) {
            this.reset();
          } else {
            ctx!.lineWidth = this.size;
            ctx!.beginPath();
            ctx!.moveTo(this.x, this.y);
            ctx!.lineTo(this.x + this.len, this.y - this.len);
            ctx!.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx!.stroke();
          }
        } else {
          if (this.waitTime < Date.now()) {
            this.active = true;
          }
        }
      }
    }

    // 地形类
    class Terrain {
      terrainCanvas: HTMLCanvasElement;
      terCtx: CanvasRenderingContext2D;
      scrollDelay: number;
      lastScroll: number;
      fillStyle: string;
      mHeight: number;
      points: number[];

      constructor(options: {
        scrollDelay?: number;
        fillStyle?: string;
        mHeight?: number;
        displacement?: number;
      } = {}) {
        this.terrainCanvas = document.createElement('canvas');
        this.terCtx = this.terrainCanvas.getContext('2d')!;
        this.scrollDelay = options.scrollDelay || 90;
        this.lastScroll = Date.now();
        this.fillStyle = options.fillStyle || '#191D4C';
        this.mHeight = options.mHeight || height;
        this.points = [];

        this.terrainCanvas.width = width;
        this.terrainCanvas.height = height;

        let displacement = options.displacement || 140;
        const power = Math.pow(2, Math.ceil(Math.log(width) / Math.log(2)));

        this.points[0] = this.mHeight;
        this.points[power] = this.points[0];

        for (let i = 1; i < power; i *= 2) {
          for (let j = power / i / 2; j < power; j += power / i) {
            this.points[j] =
              (this.points[j - power / i / 2] + this.points[j + power / i / 2]) / 2 +
              Math.floor(Math.random() * -displacement + displacement);
          }
          displacement *= 0.6;
        }
      }

      update() {
        this.terCtx.clearRect(0, 0, width, height);
        this.terCtx.fillStyle = this.fillStyle;

        if (Date.now() > this.lastScroll + this.scrollDelay) {
          this.lastScroll = Date.now();
          this.points.push(this.points.shift()!);
        }

        this.terCtx.beginPath();
        for (let i = 0; i <= width; i++) {
          if (i === 0) {
            this.terCtx.moveTo(0, this.points[0]);
          } else if (this.points[i] !== undefined) {
            this.terCtx.lineTo(i, this.points[i]);
          }
        }

        this.terCtx.lineTo(width, this.terrainCanvas.height);
        this.terCtx.lineTo(0, this.terrainCanvas.height);
        this.terCtx.lineTo(0, this.points[0]);
        this.terCtx.fill();

        // 绘制到主 canvas
        ctx!.drawImage(this.terrainCanvas, 0, 0);
      }
    }

    // 初始化实体
    const stars: StarObj[] = [];
    const shootingStars: ShootingStar[] = [];
    const terrains: Terrain[] = [];

    // 创建星星
    for (let i = 0; i < Math.min(height, 300); i++) {
      stars.push(new StarObj(Math.random() * width, Math.random() * height));
    }

    // 创建流星
    shootingStars.push(new ShootingStar());
    shootingStars.push(new ShootingStar());

    // 创建地形层 - 使用金色/琥珀色调，与主题呼应
    terrains.push(
      new Terrain({
        mHeight: height / 2 - 100,
        fillStyle: 'rgba(45, 50, 85, 0.35)',  // 最远层：冷靛蓝色，较亮
        displacement: 160,
        scrollDelay: 120,
      })
    );
    terrains.push(
      new Terrain({
        displacement: 130,
        scrollDelay: 70,
        fillStyle: 'rgba(30, 35, 60, 0.55)',  // 中间层：深靛蓝色
        mHeight: height / 2 - 40,
      })
    );
    terrains.push(
      new Terrain({
        displacement: 100,
        scrollDelay: 35,
        fillStyle: 'rgba(15, 18, 35, 0.85)',  // 最近层：深靛黑
        mHeight: height / 2 + 20,
      })
    );

    function animate() {
      // 背景渐变 - 顶部深邃，底部微暖褐调配合金色山川
      const gradient = ctx!.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#080808');      // 顶部：纯黑
      gradient.addColorStop(0.3, '#08080c');    // 中上：微冷黑
      gradient.addColorStop(0.6, '#0c0c14');    // 中下：冷靛黑
      gradient.addColorStop(1, '#08080e');      // 底部：深靛
      ctx!.fillStyle = gradient;
      ctx!.fillRect(0, 0, width, height);

      // 绘制星星
      ctx!.fillStyle = '#ffffff';
      for (const star of stars) {
        star.update();
      }

      // 绘制流星
      for (const shootingStar of shootingStars) {
        shootingStar.update();
      }

      // 绘制地形
      for (const terrain of terrains) {
        terrain.update();
      }

      animationRef.current = requestAnimationFrame(animate);
    }

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}

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
        className="h-10 w-10 rounded-xl inline-flex items-center justify-center transition-all duration-200 hover:bg-white/10 hover:scale-105 active:scale-95"
        style={{ color: 'rgba(255,255,255,0.7)' }}
        onClick={props.onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {props.icon}
      </button>
      {/* Tooltip */}
      {showTooltip && (
        <div
          className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap pointer-events-none"
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
  { key: 'pro', label: 'MAP Pro', icon: Sparkles, prompt: '', isPro: true },
  { key: 'design', label: '平面设计', icon: LayoutGrid, prompt: '帮我设计一张' },
  { key: 'branding', label: '品牌设计', icon: Star, prompt: '帮我设计一个品牌视觉，包括' },
  { key: 'illustration', label: '插画创作', icon: PenTool, prompt: '帮我创作一幅插画，主题是' },
  { key: 'ecommerce', label: '电商设计', icon: ShoppingCart, prompt: '帮我设计一张电商主图，产品是' },
  { key: 'video', label: '视频封面', icon: Video, prompt: '帮我设计一张视频封面，内容是' },
];

// ============ Hero 区域 ============
function HeroSection() {
  return (
    <div className="relative w-full" style={{ height: 260 }}>
      {/* 粒子漩涡背景 — trailColor 精确匹配 #0a0a0c，无 CSS opacity 避免矩形覆盖 */}
      <div
        className="absolute inset-0"
        style={{
          maskImage: 'radial-gradient(ellipse 70% 50% at 50% 50%, black 15%, transparent 85%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 50% at 50% 50%, black 15%, transparent 85%)',
        }}
      >
        <ParticleVortex particleCount={200} mouseFollow trailColor="rgba(10,10,12,0.9)" sizeRange={[1, 3]} hueRange={[230, 280]} />
      </div>
      {/* 文字层 */}
      <div className="relative z-10 flex flex-col items-center justify-center h-full text-center">
        <h1
          className="text-[42px] font-bold tracking-tight mb-3"
          style={{
            background: 'linear-gradient(90deg, #c4b5fd, #818cf8, #6ee7b7, #818cf8, #c4b5fd)',
            backgroundSize: '200% 100%',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            letterSpacing: '-0.02em',
            animation: 'vaHoloFlow 6s ease-in-out infinite',
          }}
        >
          视觉创作 Agent
        </h1>
        <p
          className="text-[15px]"
          style={{
            color: 'rgba(199,210,254,0.58)',
            letterSpacing: '0.01em',
          }}
        >
          AI 驱动的设计助手，让创作更简单
        </p>
      </div>
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
  const openDefectDialog = useGlobalDefectStore((s) => s.openDialog);

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

  const canSubmit = value.trim() && !loading;

  return (
    <div className="max-w-full sm:max-w-[680px] w-full mx-auto px-3 sm:px-6 mt-8">
      <div
        className="rounded-[20px] overflow-hidden cursor-text transition-all duration-300"
        style={{
          ...glassInputArea,
          // 暖褐色调磨砂玻璃，与金色主题协调
          background: 'rgba(28, 24, 20, 0.82)',
          // 聚焦时边框变亮 - 使用柔和的琥珀金
          border: isFocused
            ? '1px solid rgba(99, 102, 241, 0.5)'
            : '1px solid rgba(99, 102, 241, 0.18)',
          boxShadow: isFocused
            ? '0 24px 64px rgba(0,0,0,0.5), 0 0 0 3px rgba(99, 102, 241, 0.15), 0 1px 0 rgba(199,210,254,0.08) inset'
            : '0 24px 64px rgba(0,0,0,0.5), 0 1px 0 rgba(199,210,254,0.05) inset',
        }}
        onClick={handleContainerClick}
      >
        {/* 输入区域 - 简化内边距 */}
        <div className="px-5 pt-4 pb-3 relative min-h-[80px]">
          {/* 图片预览 chip - 参考 AdvancedVisualAgentTab 样式 */}
          {selectedImage ? (
            <div
              className="absolute left-3 right-3 top-3 z-30 inline-flex items-center gap-1.5"
              style={{ pointerEvents: 'auto', flexWrap: 'wrap' }}
            >
              <button
                type="button"
                className="inline-flex items-center gap-1.5"
                style={{
                  height: 20,
                  maxWidth: 140,
                  paddingLeft: 4,
                  paddingRight: 6,
                  borderRadius: 4,
                  overflow: 'hidden',
                  border: '1px solid rgba(255,255,255,0.22)',
                  background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                  color: 'rgba(255,255,255,0.82)',
                }}
                title={`参考图：${selectedImage.file.name}`}
                aria-label="预览参考图"
                onClick={(e) => {
                  e.stopPropagation();
                  // 可以在这里打开预览对话框
                }}
              >
                {/* 序号标记 */}
                <span
                  style={{
                    minWidth: 14,
                    height: 14,
                    borderRadius: 3,
                    background: 'rgba(99, 102, 241, 0.25)',
                    border: '1px solid rgba(99, 102, 241, 0.4)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    fontWeight: 700,
                    color: 'rgba(99, 102, 241, 1)',
                    flexShrink: 0,
                  }}
                >
                  1
                </span>
                {/* 图片缩略图 */}
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.22)',
                    background: 'var(--bg-input-hover)',
                    display: 'inline-flex',
                    flex: '0 0 auto',
                  }}
                >
                  <img
                    src={selectedImage.previewUrl}
                    alt={selectedImage.file.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </span>
                {/* 文件名 */}
                <span
                  style={{
                    fontSize: 10,
                    lineHeight: '16px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 70,
                  }}
                >
                  {selectedImage.file.name.length > 8 ? `${selectedImage.file.name.slice(0, 6)}...` : selectedImage.file.name}
                </span>
                {/* 删除按钮 */}
                {onRemoveImage && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveImage();
                    }}
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 2,
                      border: 'none',
                      background: 'rgba(239,68,68,0.2)',
                      color: 'rgba(239,68,68,0.9)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      fontSize: 10,
                      padding: 0,
                      marginLeft: 2,
                    }}
                    title="移除图片"
                  >
                    ×
                  </button>
                )}
              </button>

            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            rows={2}
            className="w-full bg-transparent text-[15px] resize-none leading-relaxed no-focus-ring"
            style={{ 
              color: '#fff',
              minHeight: '52px',
              border: 'none',
              paddingTop: selectedImage ? '32px' : '0',
            }}
            disabled={loading}
          />
          {/* 自定义打字动效占位符 - 偏暖白 */}
          {!value && !selectedImage && (
            <div
              className="absolute top-4 left-5 right-5 pointer-events-none text-[15px] leading-relaxed"
              style={{ color: 'rgba(199,210,254,0.42)' }}
            >
              {typingPlaceholder}
              <span className="animate-pulse">|</span>
            </div>
          )}
        </div>
        {/* 底部工具栏 - 简化，只保留核心操作 */}
        <div className="flex items-center justify-between px-4 pb-3">
          {/* 左侧：附件按钮 + 尺寸配置 */}
          <div className="flex items-center gap-2">
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
              onClick={handleImageButtonClick}
              disabled={loading}
              className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-all duration-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'rgba(99, 102, 241, 0.1)',
                color: 'rgba(199, 210, 254, 0.55)',
                border: '1px solid rgba(99, 102, 241, 0.15)',
              }}
              title="添加图片参考"
            >
              <Image size={14} />
              <span>图片</span>
            </button>

            {/* 尺寸选择器（复用编辑器的面板组件） */}
            {onSizeChange && (
              <SizePickerButton size={size} onSizeChange={onSizeChange} />
            )}
          </div>
          {/* 右侧：Bug 按钮 + 发送按钮 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openDefectDialog}
              className="h-9 w-9 rounded-xl flex items-center justify-center transition-all duration-200 hover:bg-white/10"
              style={{
                background: 'var(--bg-input-hover)',
                color: 'rgba(255,255,255,0.5)',
                border: '1px solid var(--border-subtle)',
              }}
              title="提交缺陷 (Cmd/Ctrl+B)"
            >
              <Bug size={16} />
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              className="h-9 px-5 rounded-xl flex items-center gap-2 text-[13px] font-semibold transition-all duration-200"
              style={{
                background: canSubmit
                  ? 'linear-gradient(135deg, rgba(99,102,241,0.95) 0%, rgba(79,82,221,0.95) 100%)'
                  : 'var(--border-subtle)',
                color: canSubmit ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                boxShadow: canSubmit ? '0 4px 20px rgba(99,102,241,0.3)' : 'none',
              }}
            >
              {loading ? (
                <span>生成中...</span>
              ) : (
                <>
                  <Sparkles size={14} />
                  <span>开始创作</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ 场景标签 ============
function ScenarioTags(props: { onSelect: (prompt: string) => void; activeKey: string | null }) {
  const { onSelect, activeKey } = props;

  return (
    <div className="flex items-center justify-start sm:justify-center gap-2.5 flex-nowrap overflow-x-auto sm:flex-wrap px-3 sm:px-6 mt-6 no-scrollbar">
      {SCENARIO_TAGS.map((tag) => {
        const Icon = tag.icon;
        const isActive = activeKey === tag.key;
        const isPro = tag.isPro;

        if (isPro) {
          // PRD Agent Pro - 特殊高亮样式
          return (
            <button
              key={tag.key}
              type="button"
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold transition-all duration-200 hover:scale-[1.02] shrink-0"
              style={{
                background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(79,82,221,0.06) 100%)',
                border: '1px solid rgba(99,102,241,0.35)',
                color: 'rgba(165,180,252,0.95)',
                boxShadow: '0 0 24px rgba(99,102,241,0.08)',
              }}
              onClick={() => {}}
            >
              <Icon size={15} />
              {tag.label}
            </button>
          );
        }

        // 普通标签 - 更柔和的样式，偏暖白
        return (
          <button
            key={tag.key}
            type="button"
            onClick={() => onSelect(tag.prompt)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 hover:bg-white/8 shrink-0"
            style={{
              background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
              border: isActive ? '1px solid rgba(99,102,241,0.22)' : '1px solid rgba(255,255,255,0.1)',
              color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(199,210,254,0.55)',
            }}
          >
            <Icon size={14} style={{ opacity: isActive ? 1 : 0.65 }} />
            {tag.label}
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
        <div className="text-[13px] font-semibold truncate" style={{ color: 'rgba(255,255,255,0.9)' }}>
          {ws.title || '未命名'}
        </div>
        <div className="mt-1 text-[11px] flex items-center justify-between" style={{ color: 'rgba(255,255,255,0.45)' }}>
          <span>{formatDate(ws.updatedAt)}</span>
          <div
            className="flex items-center gap-1 opacity-0 pointer-events-none transition-all duration-150 group-hover:opacity-100 group-hover:pointer-events-auto"
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
        className="h-[160px] rounded-xl flex flex-col items-center justify-center gap-2.5 transition-all duration-300 group-hover:scale-[1.02] group-hover:border-white/25"
        style={{
          border: '1.5px dashed rgba(255,255,255,0.2)',
          background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
        }}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 group-hover:scale-110"
          style={{
            background: 'var(--bg-input-hover)',
            border: '1px solid var(--border-default)',
          }}
        >
          <Plus size={22} style={{ color: 'rgba(255,255,255,0.6)' }} />
        </div>
        <span className="text-[13px] font-medium" style={{ color: 'rgba(255,255,255,0.5)' }}>
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
  onCreate: () => void;
  onRename: (ws: VisualAgentWorkspace) => void;
  onShare: (ws: VisualAgentWorkspace) => void;
  onDelete: (ws: VisualAgentWorkspace) => void;
  onOpen: (ws: VisualAgentWorkspace) => void;
}) {
  const { items, loading, onCreate, onRename, onShare, onDelete, onOpen } = props;

  if (loading) {
    return (
      <div className="px-5 py-8">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    );
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
            className="text-[14px] font-medium tracking-wide"
            style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
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
  const [error, setError] = useState<string>('');
  const refreshBusyRef = useRef<Set<string>>(new Set());
  const lastRefreshHashRef = useRef<Map<string, string>>(new Map());

  // 快捷输入框状态
  const [inputValue, setInputValue] = useState('');
  const [inputLoading, setInputLoading] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  // 默认尺寸：从 localStorage 读取用户偏好，与编辑器共享同一 key
  const defaultSizeKey = userId ? `prdAdmin.visualAgent.defaultSize.${userId}` : '';
  const [selectedSize, setSelectedSize] = useState<string>(() => {
    if (!defaultSizeKey) return '1024x1024';
    try { return localStorage.getItem(defaultSizeKey) || '1024x1024'; } catch { return '1024x1024'; }
  });

  // 共享对话框状态
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWs, setShareWs] = useState<VisualAgentWorkspace | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberSet, setMemberSet] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => Array.from(memberSet), [memberSet]);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listVisualAgentWorkspaces({ limit: 30 });
      if (!res.success) {
        setError(res.error?.message || '加载 workspace 失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      const filtered = list.filter((item) => item.scenarioType !== 'article-illustration');
      setItems(filtered);
    } finally {
      setLoading(false);
    }
  };

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
    if (defaultSizeKey) { try { localStorage.setItem(defaultSizeKey, size); } catch { /* ignore */ } }
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
      className="h-full min-h-0 flex flex-col overflow-auto relative"
      style={{ background: '#0a0a0c' }}
    >
      {/* 夜景背景 */}
      <NightSkyBackground />

      {/* 浮动工具栏 - 桌面端页面左侧垂直居中，移动端隐藏 */}
      {!isMobile && (
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
          <FloatingToolbar onNewProject={onCreate} onNewFolder={onCreateFolder} />
        </div>
      )}

      {/* 顶部居中区域 - 调整间距使布局更紧凑 */}
      <div className="flex flex-col items-center justify-center pt-[8vh] pb-4 relative z-10">
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
                        className="w-full flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
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
