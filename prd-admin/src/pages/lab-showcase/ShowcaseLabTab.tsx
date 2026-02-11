import { useState, useMemo, ReactNode, Suspense, useEffect, useRef } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { glassOverlay, glassPanel } from '@/lib/glassStyles';
import { Button } from '@/components/design/Button';
import {
  Maximize2,
  RefreshCw,
  Check,
  Code,
  X,
  Monitor,
  Tablet,
  Smartphone,
  Square,
  Settings2,
  Gauge,
} from 'lucide-react';

// 已改造的 React 特效组件
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';
import { RainBackground } from '@/components/effects/RainBackground';
import { CssRainBackground } from '@/components/effects/CssRainBackground';
// RibbonIcon 已删除：丝带动画组件有问题
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import ConvergingBeamsBackdrop from '@/components/login/ConvergingBeamsBackdrop';
// XAiBackdrop 已移除：设计为超低对比度衬底，不适合单独展示
// import XAiBackdrop from '@/components/login/XAiBackdrop';
// BlackHoleScene 已删除，使用新的 BlackHoleVortex 组件
import { BlackHoleVortex } from '@/components/effects/BlackHoleVortex';
import { RippleImageTransition } from '@/components/effects/RippleImageTransition';
import { SliceFlipTransition } from '@/components/effects/SliceFlipTransition';
import { SparkleButton } from '@/components/effects/SparkleButton';
import { GlowingCard } from '@/components/effects/GlowingCard';
import { NeonButtonGroup } from '@/components/effects/NeonButton';
import { OrbitLoader } from '@/components/effects/OrbitLoader';

// 预设尺寸
const PRESET_SIZES = [
  { id: 'phone', label: '手机', width: 375, height: 667, icon: Smartphone },
  { id: 'tablet', label: '平板', width: 768, height: 1024, icon: Tablet },
  { id: 'desktop', label: '桌面', width: 1280, height: 720, icon: Monitor },
  { id: 'square', label: '方形', width: 500, height: 500, icon: Square },
  { id: 'full', label: '全屏', width: 0, height: 0, icon: Maximize2 },
] as const;

// 参数定义
interface ParamDef {
  name: string;
  type: string;
  default?: string;
  description: string;
}

// 特效配置定义
interface EffectConfig {
  id: string;
  label: string;
  functionName: string;
  category: EffectCategory;
  status: 'ready' | 'pending';
  render: (size?: { width: number; height: number }) => ReactNode;
  sourceRef?: string;
  params?: ParamDef[];
  performance?: {
    animationDuration?: string;
    frameRate?: string;
    delay?: string;
    renderer?: 'CSS' | 'Canvas' | 'Three.js' | 'WebGL';
  };
}

type EffectCategory = 'loading' | 'background' | 'button' | 'card' | 'other';

const CATEGORY_LABELS: Record<EffectCategory, string> = {
  loading: '加载动画',
  background: '背景效果',
  button: '按钮特效',
  card: '卡片效果',
  other: '其他特效',
};

const CATEGORY_COLORS: Record<EffectCategory, { bg: string; text: string; border: string }> = {
  loading: { bg: 'rgba(139, 92, 246, 0.15)', text: 'rgba(139, 92, 246, 0.9)', border: 'rgba(139, 92, 246, 0.25)' },
  background: { bg: 'rgba(34, 197, 94, 0.15)', text: 'rgba(34, 197, 94, 0.9)', border: 'rgba(34, 197, 94, 0.25)' },
  button: { bg: 'rgba(251, 146, 60, 0.15)', text: 'rgba(251, 146, 60, 0.9)', border: 'rgba(251, 146, 60, 0.25)' },
  card: { bg: 'rgba(59, 130, 246, 0.15)', text: 'rgba(59, 130, 246, 0.9)', border: 'rgba(59, 130, 246, 0.25)' },
  other: { bg: 'rgba(156, 163, 175, 0.15)', text: 'rgba(156, 163, 175, 0.9)', border: 'rgba(156, 163, 175, 0.25)' },
};

const DEMO_IMAGES = [
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=450&fit=crop',
  'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?w=800&h=450&fit=crop',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&h=450&fit=crop',
];

// 所有特效配置
const EFFECT_CONFIGS: EffectConfig[] = [
  // ============ 加载动画 ============
  {
    id: 'petal-breath-gold',
    label: '花瓣呼吸 (金)',
    functionName: 'PrdPetalBreathingLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载动画-花瓣呼吸.html',
    params: [
      { name: 'size', type: 'number', default: '92', description: '尺寸 (px)' },
      { name: 'variant', type: "'gold' | 'red'", default: "'gold'", description: '主题色' },
      { name: 'fill', type: 'boolean', default: 'false', description: '是否铺满父容器' },
      { name: 'paused', type: 'boolean', default: 'false', description: '暂停动画' },
      { name: 'grayscale', type: 'boolean', default: 'false', description: '灰度模式' },
    ],
    performance: { animationDuration: '2s', delay: '80ms × 层数', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full">
        <PrdPetalBreathingLoader size={120} variant="gold" />
      </div>
    ),
  },
  {
    id: 'petal-breath-red',
    label: '花瓣呼吸 (红)',
    functionName: 'PrdPetalBreathingLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载动画-花瓣呼吸.html',
    params: [
      { name: 'size', type: 'number', default: '92', description: '尺寸 (px)' },
      { name: 'variant', type: "'gold' | 'red'", default: "'gold'", description: '主题色' },
    ],
    performance: { animationDuration: '2s', delay: '80ms × 层数', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full">
        <PrdPetalBreathingLoader size={120} variant="red" />
      </div>
    ),
  },
  {
    id: 'petal-breath-fill',
    label: '花瓣呼吸 (铺满)',
    functionName: 'PrdPetalBreathingLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载动画-花瓣呼吸.html',
    params: [{ name: 'fill', type: 'boolean', default: 'false', description: '铺满父容器' }],
    performance: { animationDuration: '2s', renderer: 'CSS' },
    render: () => (
      <div className="w-full h-full">
        <PrdPetalBreathingLoader fill variant="gold" />
      </div>
    ),
  },
  {
    id: 'simple-loader',
    label: '3D 旋转球',
    functionName: 'PrdLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: 'load.html',
    params: [{ name: 'size', type: 'number', default: '44', description: '尺寸 (px)' }],
    performance: { animationDuration: '1s', frameRate: '60fps', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full">
        <PrdLoader size={64} />
      </div>
    ),
  },
  // 丝带动画已删除：组件有问题

  // ============ 背景效果 ============
  {
    id: 'rain-three',
    label: '下雨效果 (Three.js)',
    functionName: 'RainBackground',
    category: 'background',
    status: 'ready',
    sourceRef: '下雨效果.html',
    params: [
      { name: 'opacity', type: 'number', default: '0.3', description: '透明度 (0-1)' },
      { name: 'rainCount', type: 'number', default: '15000', description: '雨滴数量' },
      { name: 'cloudCount', type: 'number', default: '25', description: '云朵数量' },
      { name: 'rainSpeed', type: 'number', default: '0.1', description: '下落速度' },
    ],
    performance: { frameRate: '60fps (RAF)', renderer: 'Three.js' },
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#11111f' }}>
        <RainBackground opacity={0.5} rainCount={8000} cloudCount={15} />
      </div>
    ),
  },
  {
    id: 'rain-css',
    label: '下雨效果 (CSS)',
    functionName: 'CssRainBackground',
    category: 'background',
    status: 'ready',
    sourceRef: '下雨效果.html',
    params: [
      { name: 'opacity', type: 'number', default: '0.3', description: '透明度' },
      { name: 'rainCount', type: 'number', default: '100', description: '雨滴数量' },
      { name: 'color', type: 'string', default: 'rgba(174,194,224,0.8)', description: '雨滴颜色' },
    ],
    performance: { animationDuration: '0.5-1s', renderer: 'CSS' },
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#11111f' }}>
        <CssRainBackground opacity={0.6} rainCount={80} />
      </div>
    ),
  },
  {
    id: 'recursive-grid',
    label: '递归网格',
    functionName: 'RecursiveGridBackdrop',
    category: 'background',
    status: 'ready',
    sourceRef: '递归网络.html',
    params: [
      { name: 'depth', type: 'number', default: '100', description: '嵌套层数' },
      { name: 'speedDegPerSec', type: 'number', default: '1.2', description: '旋转速度 (度/秒)' },
      { name: 'stroke', type: 'string', default: 'rgba(255,105,180,0.8)', description: '线条颜色' },
      { name: 'lineWidth', type: 'number', default: '1', description: '线宽 (px)' },
      { name: 'scalePerLevel', type: 'number', default: '0.97', description: '每层缩放比' },
    ],
    performance: { frameRate: '60fps (RAF)', renderer: 'Canvas' },
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#050507' }}>
        <RecursiveGridBackdrop depth={60} speedDegPerSec={1.5} stroke="rgba(255, 105, 180, 0.6)" />
      </div>
    ),
  },
  {
    id: 'converging-beams',
    label: '光束汇聚',
    functionName: 'ConvergingBeamsBackdrop',
    category: 'background',
    status: 'ready',
    params: [
      { name: 'durationMs', type: 'number', default: '3000', description: '动画时长 (ms)' },
      { name: 'stopAt', type: 'number', default: '0.5', description: '停止位置 (0-1)' },
    ],
    performance: { animationDuration: '3-4s', renderer: 'CSS' },
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#050507' }}>
        <ConvergingBeamsBackdrop durationMs={4000} stopAt={0.6} />
      </div>
    ),
  },
  // XAiBackdrop 已移除：设计为超低对比度衬底（透明度仅 1.6%-4.5%），不适合单独展示
  {
    id: 'blackhole-vortex',
    label: '黑洞漩涡',
    functionName: 'BlackHoleVortex',
    category: 'background',
    status: 'ready',
    sourceRef: '背景-黑洞漩涡.html',
    params: [{ name: 'className', type: 'string', description: '自定义类名' }],
    performance: { frameRate: '60fps', renderer: 'WebGL' },
    render: () => (
      <div className="relative w-full h-full">
        <BlackHoleVortex />
      </div>
    ),
  },

  // ============ 按钮特效 ============
  {
    id: 'success-confetti',
    label: '完结撒花',
    functionName: 'SuccessConfettiButton',
    category: 'button',
    status: 'ready',
    sourceRef: 'success.html',
    params: [
      { name: 'size', type: "'sm' | 'md'", default: "'sm'", description: '按钮尺寸' },
      { name: 'readyText', type: 'string', default: "'动效'", description: '待提交文案' },
      { name: 'loadingText', type: 'string', default: "'...'", description: '加载中文案' },
      { name: 'successText', type: 'string', default: "'OK'", description: '成功文案' },
      { name: 'loadingMinMs', type: 'number', default: '650', description: '最小加载时长' },
      { name: 'successHoldMs', type: 'number', default: '3300', description: '成功展示时长' },
      { name: 'completeMode', type: "'autoReset' | 'hold'", default: "'autoReset'", description: '完成后行为' },
    ],
    performance: { animationDuration: '650ms 加载 + 3.3s 成功', frameRate: '60fps (撒花)', renderer: 'Canvas' },
    render: () => (
      <div className="flex items-center justify-center h-full gap-4">
        <SuccessConfettiButton
          readyText="点击试试"
          successText="完成!"
          size="md"
          onAction={() => new Promise((r) => setTimeout(r, 800))}
        />
      </div>
    ),
  },

  // ============ 其他特效 ============
  {
    id: 'ripple-slider',
    label: '水波纹轮播',
    functionName: 'RippleImageTransition',
    category: 'other',
    status: 'ready',
    sourceRef: '图片加载动效.html',
    params: [
      { name: 'images', type: 'string[]', description: '图片 URL 数组' },
      { name: 'width', type: 'number', default: '681', description: '宽度 (px)' },
      { name: 'height', type: 'number', default: '384', description: '高度 (px)' },
      { name: 'autoPlay', type: 'boolean', default: 'false', description: '自动播放' },
      { name: 'interval', type: 'number', default: '5000', description: '切换间隔 (ms)' },
    ],
    performance: { animationDuration: '1.4s', delay: '50ms × 圆环', renderer: 'CSS' },
    render: (size) => (
      <div className="flex items-center justify-center h-full p-4">
        <RippleImageTransition
          images={DEMO_IMAGES}
          width={size ? Math.min(size.width - 32, 400) : 340}
          height={size ? Math.min(size.height - 32, 225) : 190}
          autoPlay
          interval={4000}
        />
      </div>
    ),
  },
  {
    id: 'slice-flip',
    label: '水波纹切换',
    functionName: 'SliceFlipTransition',
    category: 'other',
    status: 'ready',
    params: [
      { name: 'imageA', type: 'string', description: '图片A的URL' },
      { name: 'imageB', type: 'string', description: '图片B的URL' },
      { name: 'labelA', type: 'string', default: "'方案 A'", description: '按钮A文字' },
      { name: 'labelB', type: 'string', default: "'方案 B'", description: '按钮B文字' },
    ],
    performance: { animationDuration: '1.4s', delay: '50ms × 圆环', renderer: 'CSS' },
    render: (size) => (
      <div className="flex items-center justify-center h-full p-4" style={{ background: '#0a0a12' }}>
        <SliceFlipTransition
          imageA={DEMO_IMAGES[0]}
          imageB={DEMO_IMAGES[1]}
          width={size ? Math.min(size.width - 32, 400) : 340}
          height={size ? Math.min(size.height - 32, 280) : 240}
          labelA="Before"
          labelB="After"
        />
      </div>
    ),
  },

  // ============ 新增按钮特效 ============
  {
    id: 'sparkle-button',
    label: '闪烁生成按钮',
    functionName: 'SparkleButton',
    category: 'button',
    status: 'ready',
    sourceRef: '生成按钮.html',
    params: [
      { name: 'text', type: 'string', default: "'Generate'", description: '按钮文字' },
      { name: 'onClick', type: '() => void', description: '点击回调' },
    ],
    performance: { animationDuration: '1.8s 闪烁', frameRate: '60fps', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full" style={{ background: 'hsl(260 97% 6%)' }}>
        <SparkleButton text="Generate Site" />
      </div>
    ),
  },
  {
    id: 'neon-buttons',
    label: '霓虹灯按钮',
    functionName: 'NeonButton',
    category: 'button',
    status: 'ready',
    sourceRef: '下一步.html',
    params: [
      { name: 'text', type: 'string', default: "'Next Step'", description: '按钮文字' },
      { name: 'color', type: "'pink' | 'blue' | 'green'", default: "'pink'", description: '霓虹颜色' },
    ],
    performance: { animationDuration: '0.5s 悬停', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full p-4" style={{ background: 'linear-gradient(to bottom, #5d326c, #350048)' }}>
        <NeonButtonGroup />
      </div>
    ),
  },

  // ============ 新增卡片特效 ============
  {
    id: 'glowing-card',
    label: '发光边框卡片',
    functionName: 'GlowingCard',
    category: 'card',
    status: 'ready',
    sourceRef: '特效卡片.html',
    params: [
      { name: 'title', type: 'string', default: "'Glowing shadows'", description: '卡片标题' },
      { name: 'label', type: 'string', default: "'cool'", description: '标签文字' },
    ],
    performance: { animationDuration: '4s 色相循环', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full" style={{ background: 'hsl(260 100% 3%)' }}>
        <GlowingCard title="Glowing shadows" label="cool" />
      </div>
    ),
  },

  // ============ 新增加载动画 ============
  {
    id: 'orbit-loader',
    label: '轨道加载器',
    functionName: 'OrbitLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载进度.html',
    params: [
      { name: 'size', type: 'number', default: '128', description: '尺寸 (px)' },
    ],
    performance: { animationDuration: '3s', renderer: 'CSS' },
    render: () => (
      <div className="flex items-center justify-center h-full" style={{ background: 'hsl(223 10% 10%)' }}>
        <OrbitLoader size={100} />
      </div>
    ),
  },
];

// FPS 计数器 Hook
function useFpsCounter() {
  const [fps, setFps] = useState(0);
  const frameCount = useRef(0);
  const lastTime = useRef(performance.now());
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const tick = () => {
      frameCount.current++;
      const now = performance.now();
      const delta = now - lastTime.current;
      if (delta >= 1000) {
        setFps(Math.round((frameCount.current * 1000) / delta));
        frameCount.current = 0;
        lastTime.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return fps;
}

// 模态窗口组件
function EffectModal({ config, onClose }: { config: EffectConfig; onClose: () => void }) {
  const [selectedSize, setSelectedSize] = useState<string>('full');
  const [key, setKey] = useState(0);
  const [showParams, setShowParams] = useState(false);
  const fps = useFpsCounter();
  const colors = CATEGORY_COLORS[config.category];

  const currentSize = useMemo(() => {
    const preset = PRESET_SIZES.find((s) => s.id === selectedSize);
    if (!preset || preset.width === 0) return null;
    return { width: preset.width, height: preset.height };
  }, [selectedSize]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        ...glassOverlay,
        background: 'rgba(0, 0, 0, 0.6)',
      }}
      onClick={onClose}
    >
      <div
        className="relative flex flex-col max-w-[95vw] max-h-[95vh] rounded-xl"
        style={{
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部工具栏 - 液态玻璃效果 */}
        <div
          className="flex items-center justify-between px-4 py-3 rounded-t-xl"
          style={{
            ...glassPanel,
            background: `
              radial-gradient(ellipse 80% 50% at 50% 0%, rgba(255, 255, 255, 0.15) 0%, transparent 50%),
              linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.04) 100%)
            `,
            border: undefined,
            borderBottom: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 1px 0 0 rgba(255, 255, 255, 0.1) inset, 0 -1px 0 0 rgba(0, 0, 0, 0.1) inset',
          }}
        >
          <div className="flex items-center gap-3">
            <div>
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {config.label}
              </div>
              <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {config.functionName}
              </div>
            </div>
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
              style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}
            >
              {CATEGORY_LABELS[config.category]}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* 尺寸切换 */}
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }}>
              {PRESET_SIZES.map((size) => {
                const Icon = size.icon;
                return (
                  <Button
                    key={size.id}
                    variant={selectedSize === size.id ? 'primary' : 'ghost'}
                    size="xs"
                    onClick={() => {
                      setSelectedSize(size.id);
                      setKey((k) => k + 1);
                    }}
                    title={`${size.label}${size.width ? ` (${size.width}×${size.height})` : ''}`}
                  >
                    <Icon size={14} />
                  </Button>
                );
              })}
            </div>

            {/* FPS 显示 */}
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs"
              style={{ background: 'rgba(255,255,255,0.05)', color: fps >= 50 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171' }}
            >
              <Gauge size={12} />
              {fps} FPS
            </div>

            {/* 参数面板切换 */}
            <Button variant={showParams ? 'primary' : 'ghost'} size="xs" onClick={() => setShowParams(!showParams)} title="参数信息">
              <Settings2 size={14} />
            </Button>

            {/* 刷新 */}
            <Button variant="ghost" size="xs" onClick={() => setKey((k) => k + 1)} title="刷新">
              <RefreshCw size={14} />
            </Button>

            {/* 关闭 */}
            <Button variant="ghost" size="xs" onClick={onClose} title="关闭 (ESC)">
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* 主体内容 */}
        <div className="flex flex-1 min-h-0">
          {/* 预览区域 - 固定尺寸，内容自适应，液态玻璃效果 */}
          <div
            className="relative flex items-center justify-center overflow-hidden rounded-bl-xl"
            style={{
              ...glassPanel,
              background: 'linear-gradient(180deg, rgba(30, 30, 40, 0.5) 0%, rgba(20, 20, 30, 0.6) 100%)',
              border: undefined,
              width: '70vw',
              height: '70vh',
              minWidth: 600,
              minHeight: 400,
              boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 1px 0 0 rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div
              key={key}
              className="relative overflow-hidden rounded-lg"
              style={{
                width: currentSize ? currentSize.width : '100%',
                height: currentSize ? currentSize.height : '100%',
                maxWidth: '100%',
                maxHeight: '100%',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <Suspense fallback={<div className="flex items-center justify-center h-full"><PrdLoader size={32} /></div>}>
                {config.render(currentSize || undefined)}
              </Suspense>
            </div>

            {currentSize && (
              <div className="absolute bottom-2 right-2 text-xs px-2 py-1 rounded" style={{ background: 'rgba(0,0,0,0.6)', color: 'var(--text-muted)' }}>
                {currentSize.width} × {currentSize.height}
              </div>
            )}
          </div>

          {/* 参数面板 - 液态玻璃效果 */}
          {showParams && (
            <div
              className="w-80 overflow-y-auto rounded-br-xl"
              style={{
                ...glassPanel,
                background: `
                  radial-gradient(ellipse 100% 30% at 0% 0%, rgba(255, 255, 255, 0.1) 0%, transparent 50%),
                  linear-gradient(180deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%)
                `,
                border: undefined,
                borderLeft: '1px solid rgba(255, 255, 255, 0.12)',
                boxShadow: '1px 0 0 0 rgba(255, 255, 255, 0.05) inset',
              }}
            >
              <div className="p-4 space-y-4">
                {/* 性能信息 */}
                {config.performance && (
                  <div>
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>性能信息</div>
                    <div className="space-y-1">
                      {config.performance.renderer && (
                        <div className="flex justify-between text-xs">
                          <span style={{ color: 'var(--text-muted)' }}>渲染器</span>
                          <span style={{ color: 'var(--text-primary)' }}>{config.performance.renderer}</span>
                        </div>
                      )}
                      {config.performance.animationDuration && (
                        <div className="flex justify-between text-xs">
                          <span style={{ color: 'var(--text-muted)' }}>动画周期</span>
                          <span style={{ color: 'var(--text-primary)' }}>{config.performance.animationDuration}</span>
                        </div>
                      )}
                      {config.performance.frameRate && (
                        <div className="flex justify-between text-xs">
                          <span style={{ color: 'var(--text-muted)' }}>帧率</span>
                          <span style={{ color: 'var(--text-primary)' }}>{config.performance.frameRate}</span>
                        </div>
                      )}
                      {config.performance.delay && (
                        <div className="flex justify-between text-xs">
                          <span style={{ color: 'var(--text-muted)' }}>延迟</span>
                          <span style={{ color: 'var(--text-primary)' }}>{config.performance.delay}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 参数列表 */}
                {config.params && config.params.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>可用参数</div>
                    <div className="space-y-2">
                      {config.params.map((param) => (
                        <div key={param.name} className="p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                          <div className="flex items-center gap-2">
                            <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(139, 92, 246, 0.2)', color: 'rgba(139, 92, 246, 0.9)' }}>
                              {param.name}
                            </code>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{param.type}</span>
                          </div>
                          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {param.description}
                            {param.default && <span style={{ color: 'var(--text-primary)' }}> (默认: {param.default})</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 来源参考 */}
                {config.sourceRef && (
                  <div>
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>参考来源</div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{config.sourceRef}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 特效卡片组件
function EffectCard({ config, onClick }: { config: EffectConfig; onClick: () => void }) {
  const [key, setKey] = useState(0);
  const colors = CATEGORY_COLORS[config.category];

  return (
    <GlassCard className="flex flex-col cursor-pointer hover:ring-1 hover:ring-white/20 transition-all" onClick={onClick}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{config.label}</div>
          <div className="text-xs font-mono mt-0.5 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <Code size={12} />
            {config.functionName}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); setKey((k) => k + 1); }} title="重新加载">
            <RefreshCw size={14} />
          </Button>
          <Button variant="ghost" size="xs" title="放大查看">
            <Maximize2 size={14} />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: colors.bg, color: colors.text, border: `1px solid ${colors.border}` }}>
          {CATEGORY_LABELS[config.category]}
        </span>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(34, 197, 94, 0.15)', color: 'rgba(34, 197, 94, 0.9)', border: '1px solid rgba(34, 197, 94, 0.25)' }}>
          <Check size={10} />
          已改造
        </span>
        {config.performance?.renderer && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{config.performance.renderer}</span>
        )}
      </div>

      <div className="relative rounded-lg overflow-hidden flex-1" style={{ minHeight: '180px', background: 'rgba(0, 0, 0, 0.4)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <Suspense fallback={<div className="flex items-center justify-center h-full"><PrdLoader size={32} /></div>}>
          <div key={key} className="w-full h-full">{config.render()}</div>
        </Suspense>
      </div>
    </GlassCard>
  );
}

export default function ShowcaseLabTab() {
  const [selectedCategory, setSelectedCategory] = useState<EffectCategory | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [modalConfig, setModalConfig] = useState<EffectConfig | null>(null);

  const filteredEffects = useMemo(() => {
    const effects = selectedCategory === 'all' ? EFFECT_CONFIGS : EFFECT_CONFIGS.filter((config) => config.category === selectedCategory);
    return effects.sort((a, b) => {
      if (a.status === 'ready' && b.status !== 'ready') return -1;
      if (a.status !== 'ready' && b.status === 'ready') return 1;
      return 0;
    });
  }, [selectedCategory]);

  const categories: (EffectCategory | 'all')[] = ['all', 'loading', 'background', 'button', 'card', 'other'];
  const readyCount = EFFECT_CONFIGS.filter((c) => c.status === 'ready').length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>特效展示</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            已改造 React 组件一览，共 {readyCount} 个可用效果 · 点击卡片放大查看
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setRefreshKey((k) => k + 1)} title="刷新所有">
          <RefreshCw size={14} className="mr-1" />
          刷新全部
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => {
          const count = cat === 'all' ? EFFECT_CONFIGS.length : EFFECT_CONFIGS.filter((c) => c.category === cat).length;
          const readyInCat = cat === 'all' ? readyCount : EFFECT_CONFIGS.filter((c) => c.category === cat && c.status === 'ready').length;
          return (
            <Button key={cat} variant={selectedCategory === cat ? 'primary' : 'ghost'} size="sm" onClick={() => setSelectedCategory(cat)}>
              {cat === 'all' ? '全部' : CATEGORY_LABELS[cat]}
              <span className="ml-1 text-xs opacity-60">({readyInCat}/{count})</span>
            </Button>
          );
        })}
      </div>

      <div key={refreshKey} className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {filteredEffects.map((config) => (
          <EffectCard key={config.id} config={config} onClick={() => setModalConfig(config)} />
        ))}
      </div>

      {filteredEffects.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>该分类暂无已改造的特效组件</div>
      )}

      {modalConfig && <EffectModal config={modalConfig} onClose={() => setModalConfig(null)} />}
    </div>
  );
}
