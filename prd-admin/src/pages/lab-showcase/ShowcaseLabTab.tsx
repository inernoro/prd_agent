import { useState, useMemo, ReactNode, Suspense } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Maximize2, Minimize2, RefreshCw, Check, Code } from 'lucide-react';

// 已改造的 React 特效组件
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { SuccessConfettiButton } from '@/components/ui/SuccessConfettiButton';
import { RainBackground } from '@/components/effects/RainBackground';
import { CssRainBackground } from '@/components/effects/CssRainBackground';
import { RibbonIcon } from '@/components/effects/BlackHoleIcon';
import RecursiveGridBackdrop from '@/components/background/RecursiveGridBackdrop';
import ConvergingBeamsBackdrop from '@/components/login/ConvergingBeamsBackdrop';
import { RippleImageTransition } from '@/components/effects/RippleImageTransition';

// 特效配置定义
interface EffectConfig {
  id: string;
  label: string;           // 中文标签
  functionName: string;    // 英文函数名
  category: EffectCategory;
  status: 'ready' | 'pending';  // ready: 已改造, pending: 待改造
  render: () => ReactNode;      // 渲染函数
  sourceRef?: string;           // 原始参考文件
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

// 示例图片 URLs（用于轮播组件演示）
const DEMO_IMAGES = [
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=450&fit=crop',
  'https://images.unsplash.com/photo-1454496522488-7a8e488e8606?w=800&h=450&fit=crop',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&h=450&fit=crop',
];

// 所有特效配置 - 按已改造状态分类
const EFFECT_CONFIGS: EffectConfig[] = [
  // ============ 已改造的加载动画 ============
  {
    id: 'petal-breath',
    label: '花瓣呼吸',
    functionName: 'PrdPetalBreathingLoader',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载动画-花瓣呼吸.html',
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
    render: () => (
      <div className="flex items-center justify-center h-full">
        <PrdPetalBreathingLoader size={120} variant="red" />
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
    render: () => (
      <div className="flex items-center justify-center h-full">
        <PrdLoader size={64} />
      </div>
    ),
  },
  {
    id: 'ribbon-loader',
    label: '丝带动画',
    functionName: 'RibbonIcon',
    category: 'loading',
    status: 'ready',
    sourceRef: '加载-丝带动画.html',
    render: () => (
      <div className="flex items-center justify-center h-full">
        <RibbonIcon size={120} />
      </div>
    ),
  },

  // ============ 已改造的背景效果 ============
  {
    id: 'rain-three',
    label: '下雨效果 (Three.js)',
    functionName: 'RainBackground',
    category: 'background',
    status: 'ready',
    sourceRef: '下雨效果.html',
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
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#050507' }}>
        <RecursiveGridBackdrop
          depth={60}
          speedDegPerSec={1.5}
          stroke="rgba(255, 105, 180, 0.6)"
        />
      </div>
    ),
  },
  {
    id: 'converging-beams',
    label: '光束汇聚',
    functionName: 'ConvergingBeamsBackdrop',
    category: 'background',
    status: 'ready',
    render: () => (
      <div className="relative w-full h-full" style={{ background: '#050507' }}>
        <ConvergingBeamsBackdrop durationMs={4000} stopAt={0.6} />
      </div>
    ),
  },

  // ============ 已改造的按钮特效 ============
  {
    id: 'success-confetti',
    label: '完结撒花',
    functionName: 'SuccessConfettiButton',
    category: 'button',
    status: 'ready',
    sourceRef: 'success.html',
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

  // ============ 已改造的其他特效 ============
  {
    id: 'ripple-slider',
    label: '水波纹轮播',
    functionName: 'RippleImageTransition',
    category: 'other',
    status: 'ready',
    sourceRef: '图片加载动效.html',
    render: () => (
      <div className="flex items-center justify-center h-full p-2">
        <RippleImageTransition
          images={DEMO_IMAGES}
          width={340}
          height={190}
          autoPlay
          interval={4000}
        />
      </div>
    ),
  },
];

// 特效卡片组件
function EffectCard({ config, onRefresh }: { config: EffectConfig; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState(0);
  const colors = CATEGORY_COLORS[config.category];

  const handleRefresh = () => {
    setKey((k) => k + 1);
    onRefresh();
  };

  return (
    <GlassCard
      className={`transition-all duration-300 flex flex-col ${expanded ? 'col-span-2 row-span-2' : ''}`}
    >
      {/* 卡片头部 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {config.label}
          </div>
          <div className="text-xs font-mono mt-0.5 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <Code size={12} />
            {config.functionName}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleRefresh}
            title="重新加载"
          >
            <RefreshCw size={14} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
        </div>
      </div>

      {/* 状态和分类标签 */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
          style={{
            background: colors.bg,
            color: colors.text,
            border: `1px solid ${colors.border}`,
          }}
        >
          {CATEGORY_LABELS[config.category]}
        </span>
        {config.status === 'ready' && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(34, 197, 94, 0.15)',
              color: 'rgba(34, 197, 94, 0.9)',
              border: '1px solid rgba(34, 197, 94, 0.25)',
            }}
          >
            <Check size={10} />
            已改造
          </span>
        )}
        {config.sourceRef && (
          <span
            className="text-xs truncate max-w-[120px]"
            style={{ color: 'var(--text-muted)' }}
            title={`参考: ${config.sourceRef}`}
          >
            ← {config.sourceRef}
          </span>
        )}
      </div>

      {/* 预览区域 */}
      <div
        className="relative rounded-lg overflow-hidden flex-1"
        style={{
          minHeight: expanded ? '360px' : '200px',
          background: 'rgba(0, 0, 0, 0.4)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <PrdLoader size={32} />
            </div>
          }
        >
          <div key={key} className="w-full h-full">
            {config.render()}
          </div>
        </Suspense>
      </div>
    </GlassCard>
  );
}

export default function ShowcaseLabTab() {
  const [selectedCategory, setSelectedCategory] = useState<EffectCategory | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);

  const filteredEffects = useMemo(() => {
    const effects = selectedCategory === 'all'
      ? EFFECT_CONFIGS
      : EFFECT_CONFIGS.filter((config) => config.category === selectedCategory);
    // 已改造的排在前面
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
      {/* 头部 */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            特效展示
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            已改造 React 组件一览，共 {readyCount} 个可用效果
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="刷新所有"
        >
          <RefreshCw size={14} className="mr-1" />
          刷新全部
        </Button>
      </div>

      {/* 分类筛选 */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => {
          const count = cat === 'all'
            ? EFFECT_CONFIGS.length
            : EFFECT_CONFIGS.filter((c) => c.category === cat).length;
          const readyInCat = cat === 'all'
            ? readyCount
            : EFFECT_CONFIGS.filter((c) => c.category === cat && c.status === 'ready').length;

          return (
            <Button
              key={cat}
              variant={selectedCategory === cat ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSelectedCategory(cat)}
            >
              {cat === 'all' ? '全部' : CATEGORY_LABELS[cat]}
              <span className="ml-1 text-xs opacity-60">
                ({readyInCat}/{count})
              </span>
            </Button>
          );
        })}
      </div>

      {/* 特效卡片网格 */}
      <div
        key={refreshKey}
        className="grid gap-4"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        }}
      >
        {filteredEffects.map((config) => (
          <EffectCard
            key={config.id}
            config={config}
            onRefresh={() => {}}
          />
        ))}
      </div>

      {filteredEffects.length === 0 && (
        <div
          className="text-center py-12"
          style={{ color: 'var(--text-muted)' }}
        >
          该分类暂无已改造的特效组件
        </div>
      )}
    </div>
  );
}
