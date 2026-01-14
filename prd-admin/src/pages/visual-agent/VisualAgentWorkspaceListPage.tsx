import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { systemDialog } from '@/lib/systemDialog';
import {
  createImageMasterWorkspace,
  deleteImageMasterWorkspace,
  getUsers,
  listImageMasterWorkspaces,
  refreshImageMasterWorkspaceCover,
  updateImageMasterWorkspace,
  uploadImageMasterWorkspaceAsset,
} from '@/services';
import type { AdminUser } from '@/types/admin';
import type { ImageMasterWorkspace } from '@/services/contracts/imageMaster';
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
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ASPECT_OPTIONS } from '@/lib/imageAspectOptions';

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
        fillStyle: 'rgba(85, 65, 45, 0.35)',  // 最远层：暖金褐色，较亮
        displacement: 160,
        scrollDelay: 120,
      })
    );
    terrains.push(
      new Terrain({
        displacement: 130,
        scrollDelay: 70,
        fillStyle: 'rgba(55, 42, 28, 0.55)',  // 中间层：深琥珀色
        mHeight: height / 2 - 40,
      })
    );
    terrains.push(
      new Terrain({
        displacement: 100,
        scrollDelay: 35,
        fillStyle: 'rgba(30, 22, 15, 0.85)',  // 最近层：深褐黑
        mHeight: height / 2 + 20,
      })
    );

    function animate() {
      // 背景渐变 - 顶部深邃，底部微暖褐调配合金色山川
      const gradient = ctx!.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#080808');      // 顶部：纯黑
      gradient.addColorStop(0.3, '#0a0908');    // 中上：微暖黑
      gradient.addColorStop(0.6, '#12100c');    // 中下：暖褐黑
      gradient.addColorStop(1, '#0d0b08');      // 底部：深褐
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

function CoverMosaic(props: { title: string; assets: ImageMasterWorkspace['coverAssets'] }) {
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
          background: 'rgba(255,255,255,0.03)',
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
            border: '1px solid rgba(255,255,255,0.1)',
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
        background: 'rgba(18, 18, 22, 0.6)',
        border: '1px solid rgba(255,255,255,0.08)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
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
  { key: 'pro', label: 'PRD Agent Pro', icon: Sparkles, prompt: '', isPro: true },
  { key: 'design', label: '平面设计', icon: LayoutGrid, prompt: '帮我设计一张' },
  { key: 'branding', label: '品牌设计', icon: Star, prompt: '帮我设计一个品牌视觉，包括' },
  { key: 'illustration', label: '插画创作', icon: PenTool, prompt: '帮我创作一幅插画，主题是' },
  { key: 'ecommerce', label: '电商设计', icon: ShoppingCart, prompt: '帮我设计一张电商主图，产品是' },
  { key: 'video', label: '视频封面', icon: Video, prompt: '帮我设计一张视频封面，内容是' },
];

// ============ Hero 区域 ============
function HeroSection() {
  return (
    <div className="text-center py-8">
      {/* Logo - 独立展示，增加视觉焦点 */}
      <div className="flex items-center justify-center mb-5">
        <PrdPetalBreathingLoader size={56} variant="gold" />
      </div>
      {/* 主标题 - 加大字号，建立视觉层级 */}
      <h1
        className="text-[42px] font-bold tracking-tight mb-3 visual-agent-title-breath"
        style={{
          background: 'linear-gradient(135deg, rgba(255, 250, 240, 1) 0%, rgba(255, 240, 200, 1) 50%, rgba(218, 175, 75, 0.95) 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          letterSpacing: '-0.02em',
          animation: 'visualAgentTitleBreath 3s ease-in-out infinite',
        }}
      >
        视觉创作 Agent
      </h1>
      {/* 副标题 - 偏暖白色调 */}
      <p
        className="text-[15px]"
        style={{
          color: 'rgba(255,248,235,0.58)',  // 暖白
          letterSpacing: '0.01em',
        }}
      >
        AI 驱动的设计助手，让创作更简单
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

// 从尺寸字符串检测档位
function detectTierFromSize(size: string): '1k' | '2k' | '4k' {
  const s = (size || '').trim().toLowerCase();
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size4k.toLowerCase() === s) return '4k';
    if (opt.size2k.toLowerCase() === s) return '2k';
    if (opt.size1k.toLowerCase() === s) return '1k';
  }
  return '1k';
}

// 从尺寸字符串检测比例
function detectAspectFromSize(size: string): string {
  const s = (size || '').trim().toLowerCase();
  for (const opt of ASPECT_OPTIONS) {
    if (opt.size1k.toLowerCase() === s || opt.size2k.toLowerCase() === s || opt.size4k.toLowerCase() === s) {
      return opt.id;
    }
  }
  return '1:1';
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
        void systemDialog.alert('请选择图片文件');
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
    <div className="max-w-[680px] w-full mx-auto px-6 mt-8">
      <div
        className="rounded-[20px] overflow-hidden cursor-text transition-all duration-300"
        style={{
          // 暖褐色调磨砂玻璃，与金色主题协调
          background: 'rgba(28, 24, 20, 0.82)',
          backdropFilter: 'blur(24px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
          // 聚焦时边框变亮 - 使用柔和的琥珀金
          border: isFocused
            ? '1px solid rgba(212, 170, 85, 0.5)'
            : '1px solid rgba(180, 150, 100, 0.18)',
          boxShadow: isFocused
            ? '0 24px 64px rgba(0,0,0,0.5), 0 0 0 3px rgba(212, 170, 85, 0.15), 0 1px 0 rgba(255,240,200,0.08) inset'
            : '0 24px 64px rgba(0,0,0,0.5), 0 1px 0 rgba(255,240,200,0.05) inset',
        }}
        onClick={handleContainerClick}
      >
        {/* 输入区域 - 简化内边距 */}
        <div className="px-5 pt-4 pb-3 relative min-h-[80px]">
          {/* 图片预览 chip - 参考 AdvancedImageMasterTab 样式 */}
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
                  background: 'rgba(255,255,255,0.02)',
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
                    background: 'rgba(255,255,255,0.06)',
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

              {/* 尺寸选择器（参考 AdvancedImageMasterTab 样式） */}
              {onSizeChange && (
                <>
                  {/* 档位选择器（1K/2K/4K） */}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5"
                        style={{
                          height: 20,
                          paddingLeft: 6,
                          paddingRight: 6,
                          borderRadius: 4,
                          overflow: 'hidden',
                          border: '1px solid rgba(255,255,255,0.22)',
                          background: 'rgba(255,255,255,0.02)',
                          color: 'rgba(255,255,255,0.82)',
                        }}
                        title="选择档位"
                        aria-label="选择档位"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const tier = detectTierFromSize(size);
                          return (
                            <>
                              <span style={{ fontSize: 10, lineHeight: '18px', fontWeight: 600 }}>
                                {tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K'}
                              </span>
                              <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                                ▾
                              </span>
                            </>
                          );
                        })()}
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="rounded-[12px] p-1 min-w-[80px]"
                        style={{
                          outline: 'none',
                          zIndex: 90,
                          background: 'rgba(28, 24, 20, 0.95)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                        }}
                      >
                        {(['1k', '2k', '4k'] as const).map((tier) => {
                          const currentTier = detectTierFromSize(size);
                          const isSelected = currentTier === tier;
                          const label = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
                          const currentAspect = detectAspectFromSize(size);
                          const targetOpt = ASPECT_OPTIONS.find((o) => o.id === currentAspect);
                          if (!targetOpt) return null;

                          return (
                            <DropdownMenu.Item
                              key={tier}
                              className="flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-sm cursor-pointer outline-none"
                              style={{
                                color: 'rgba(255,255,255,0.9)',
                                background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                borderLeft: isSelected ? '2px solid rgb(99, 102, 241)' : '2px solid transparent',
                              }}
                              onSelect={() => {
                                const newSize = tier === '1k' ? targetOpt.size1k : tier === '2k' ? targetOpt.size2k : targetOpt.size4k;
                                onSizeChange(newSize);
                              }}
                            >
                              <span className="font-semibold">{label}</span>
                            </DropdownMenu.Item>
                          );
                        })}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  {/* 比例选择器 */}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        style={{
                          height: 20,
                          paddingLeft: 6,
                          paddingRight: 6,
                          borderRadius: 4,
                          overflow: 'hidden',
                          border: '1px solid rgba(255,255,255,0.22)',
                          background: 'rgba(255,255,255,0.02)',
                          color: 'rgba(255,255,255,0.82)',
                        }}
                        title="选择比例"
                        aria-label="选择比例"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const currentAspect = detectAspectFromSize(size);
                          const opt = ASPECT_OPTIONS.find((o) => o.id === currentAspect);
                          const iconW = opt?.iconW ?? 20;
                          const iconH = opt?.iconH ?? 20;
                          return (
                            <>
                              <span
                                style={{
                                  width: iconW,
                                  height: iconH,
                                  borderRadius: 2,
                                  border: '1px solid rgba(255,255,255,0.3)',
                                  background: 'rgba(255,255,255,0.1)',
                                  display: 'inline-block',
                                  flexShrink: 0,
                                }}
                              />
                              <span style={{ fontSize: 10, lineHeight: '18px', fontWeight: 600 }}>
                                {opt?.label || '1:1'}
                              </span>
                              <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                                ▾
                              </span>
                            </>
                          );
                        })()}
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="rounded-[12px] p-1 min-w-[120px]"
                        style={{
                          outline: 'none',
                          zIndex: 90,
                          background: 'rgba(28, 24, 20, 0.95)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                        }}
                      >
                        {ASPECT_OPTIONS.map((opt) => {
                          const currentTier = detectTierFromSize(size);
                          const currentSize = currentTier === '1k' ? opt.size1k : currentTier === '2k' ? opt.size2k : opt.size4k;
                          const isSelected = size.toLowerCase() === currentSize.toLowerCase();
                          return (
                            <DropdownMenu.Item
                              key={opt.id}
                              className="flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-sm cursor-pointer outline-none"
                              style={{
                                color: 'rgba(255,255,255,0.9)',
                                background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                                borderLeft: isSelected ? '2px solid rgb(99, 102, 241)' : '2px solid transparent',
                              }}
                              onSelect={() => {
                                onSizeChange(currentSize);
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  style={{
                                    width: opt.iconW,
                                    height: opt.iconH,
                                    borderRadius: 2,
                                    border: '1px solid rgba(255,255,255,0.3)',
                                    background: 'rgba(255,255,255,0.1)',
                                    display: 'inline-block',
                                    flexShrink: 0,
                                  }}
                                />
                                <span className="font-semibold">{opt.label}</span>
                              </div>
                            </DropdownMenu.Item>
                          );
                        })}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </>
              )}
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
              style={{ color: 'rgba(255,248,235,0.42)' }}
            >
              {typingPlaceholder}
              <span className="animate-pulse">|</span>
            </div>
          )}
        </div>
        {/* 底部工具栏 - 简化，只保留核心操作 */}
        <div className="flex items-center justify-between px-4 pb-3">
          {/* 左侧：附件按钮 */}
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
                background: 'rgba(180, 150, 100, 0.1)',
                color: 'rgba(255, 240, 210, 0.55)',
                border: '1px solid rgba(180, 150, 100, 0.15)',
              }}
              title="添加图片参考"
            >
              <Image size={14} />
              <span>图片</span>
            </button>
          </div>
          {/* 右侧：发送按钮 - 增强视觉权重 */}
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="h-9 px-5 rounded-xl flex items-center gap-2 text-[13px] font-semibold transition-all duration-200"
            style={{
              background: canSubmit
                ? 'linear-gradient(135deg, rgba(218,175,75,0.95) 0%, rgba(195,155,65,0.95) 100%)'
                : 'rgba(255,255,255,0.08)',
              color: canSubmit ? 'rgba(15,12,5,0.95)' : 'rgba(255,255,255,0.35)',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              boxShadow: canSubmit ? '0 4px 20px rgba(195,155,65,0.3)' : 'none',
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
  );
}

// ============ 场景标签 ============
function ScenarioTags(props: { onSelect: (prompt: string) => void; activeKey: string | null }) {
  const { onSelect, activeKey } = props;

  return (
    <div className="flex items-center justify-center gap-2.5 flex-wrap px-6 mt-6">
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
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold transition-all duration-200 hover:scale-[1.02]"
              style={{
                background: 'linear-gradient(135deg, rgba(212,170,85,0.12) 0%, rgba(195,155,65,0.06) 100%)',
                border: '1px solid rgba(212,170,85,0.35)',
                color: 'rgba(218,180,95,0.95)',
                boxShadow: '0 0 24px rgba(195,155,65,0.08)',
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
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 hover:bg-white/8"
            style={{
              background: isActive ? 'rgba(255,250,240,0.1)' : 'transparent',
              border: isActive ? '1px solid rgba(255,250,240,0.22)' : '1px solid rgba(255,255,255,0.1)',
              color: isActive ? 'rgba(255,252,245,0.95)' : 'rgba(255,248,235,0.55)',
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
  workspace: ImageMasterWorkspace;
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
          background: hasCover ? 'transparent' : 'rgba(255,255,255,0.04)',
          border: hasCover ? 'none' : '1px solid rgba(255,255,255,0.1)',
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
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 group-hover:scale-110"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
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
  items: ImageMasterWorkspace[];
  loading: boolean;
  onCreate: () => void;
  onRename: (ws: ImageMasterWorkspace) => void;
  onShare: (ws: ImageMasterWorkspace) => void;
  onDelete: (ws: ImageMasterWorkspace) => void;
  onOpen: (ws: ImageMasterWorkspace) => void;
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
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <h2
            className="text-[14px] font-medium tracking-wide"
            style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            最近项目
          </h2>
        </div>
      </div>
      {/* 网格布局，固定5列，居中 */}
      <div
        className="grid gap-5 pb-6 px-5 max-w-[1340px] mx-auto"
        style={{
          gridTemplateColumns: 'repeat(5, 250px)',
        }}
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
  const { fullscreenMode = false } = props;
  const navigate = useNavigate();

  // 根据模式决定导航路径前缀
  const getEditorPath = (workspaceId: string) => {
    return fullscreenMode
      ? `/visual-agent-fullscreen/${encodeURIComponent(workspaceId)}`
      : `/visual-agent/${encodeURIComponent(workspaceId)}`;
  };
  const [items, setItems] = useState<ImageMasterWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const refreshBusyRef = useRef<Set<string>>(new Set());
  const lastRefreshHashRef = useRef<Map<string, string>>(new Map());

  // 快捷输入框状态
  const [inputValue, setInputValue] = useState('');
  const [inputLoading, setInputLoading] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [selectedSize, setSelectedSize] = useState<string>('1024x1024');

  // 共享对话框状态
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWs, setShareWs] = useState<ImageMasterWorkspace | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberSet, setMemberSet] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => Array.from(memberSet), [memberSet]);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listImageMasterWorkspaces({ limit: 30 });
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
              const res = await refreshImageMasterWorkspaceCover({
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
    const res = await createImageMasterWorkspace({ title: title.trim() || '未命名', idempotencyKey: `ws_create_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '创建失败');
      return;
    }
    const ws = res.data.workspace;
    navigate(getEditorPath(ws.id));
  };

  // 构建内联图片标记（参考 AdvancedImageMasterTab 的 buildInlineImageToken）
  const buildInlineImageToken = (src: string, name?: string): string => {
    const s = String(src ?? '').trim();
    if (!s) return '';
    // 不把大内容塞进消息：data/blob URL 不可持久化也不应写入数据库
    if (s.startsWith('data:') || s.startsWith('blob:')) return '';
    const n = String(name ?? '').trim();
    const safeSrc = encodeURIComponent(s);
    const safeName = n ? encodeURIComponent(n) : '';
    // v2 token：可扩展 kv
    return safeName ? `[IMAGE src=${safeSrc} name=${safeName}] ` : `[IMAGE src=${safeSrc}] `;
  };

  // 快捷输入提交：创建 workspace 并跳转（带初始 prompt 和图片）
  const onQuickSubmit = async () => {
    const prompt = inputValue.trim();
    if (!prompt) return;

    setInputLoading(true);
    try {
      // 1. 创建 workspace
      const res = await createImageMasterWorkspace({
        title: prompt.slice(0, 20) || '未命名',
        idempotencyKey: `ws_quick_${Date.now()}`,
      });
      if (!res.success) {
        await systemDialog.alert(res.error?.message || '创建失败');
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
        const uploadRes = await uploadImageMasterWorkspaceAsset({
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
          await systemDialog.alert(`图片上传失败：${uploadRes.error?.message || '未知错误'}\n\n将仅使用文本提示创建项目。`);
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
      await systemDialog.alert('图片文件过大，请选择小于 10MB 的图片');
      return;
    }
    // 生成预览 URL
    const previewUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (previewUrl) {
      setSelectedImage({ file, previewUrl });
    }
  };

  // 移除图片
  const onRemoveImage = () => {
    setSelectedImage(null);
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
    await systemDialog.alert(`文件夹功能正在开发中，将创建名为「${folderName.trim() || '新文件夹'}」的文件夹。`);
  };

  const onRename = async (ws: ImageMasterWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新名称',
      defaultValue: ws.title || '',
      confirmText: '保存',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      title: title.trim() || '未命名',
      idempotencyKey: `ws_rename_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '重命名失败');
      return;
    }
    await reload();
  };

  const onDelete = async (ws: ImageMasterWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确认删除「${ws.title || '未命名'}」？（将删除画布与消息，资产记录会被清理）`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteImageMasterWorkspace({ id: ws.id, idempotencyKey: `ws_del_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '删除失败');
      return;
    }
    await reload();
  };

  const openShare = async (ws: ImageMasterWorkspace) => {
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
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      memberUserIds: memberIds,
      idempotencyKey: `ws_share_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '保存共享失败');
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

      {/* 浮动工具栏 - 页面左侧垂直居中 */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
        <FloatingToolbar onNewProject={onCreate} onNewFolder={onCreateFolder} />
      </div>

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
          onSizeChange={setSelectedSize}
        />

        {/* 场景标签 */}
        <ScenarioTags onSelect={onTagSelect} activeKey={activeTag} />
      </div>

      {/* 错误提示 */}
      {error ? (
        <div className="px-5 mt-4">
          <Card>
            <div className="text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>
              {error}
            </div>
          </Card>
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
