import { useState, useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Maximize2, Minimize2, ExternalLink } from 'lucide-react';

// 特效配置定义
interface EffectConfig {
  id: string;
  label: string;           // 中文标签
  functionName: string;    // 英文函数名
  fileName: string;        // 文件名
  category: EffectCategory;
}

type EffectCategory = 'loading' | 'background' | 'button' | 'card' | 'image' | 'other';

const CATEGORY_LABELS: Record<EffectCategory, string> = {
  loading: '加载动画',
  background: '背景效果',
  button: '按钮特效',
  card: '卡片效果',
  image: '图片效果',
  other: '其他特效',
};

// 所有特效配置
const EFFECT_CONFIGS: EffectConfig[] = [
  // 加载动画
  { id: 'rainbow-spinner', label: '旋转彩虹花', functionName: 'RainbowSpinner', fileName: '加载器-旋转加载-适合当前项目.html', category: 'loading' },
  { id: 'ribbon-loader', label: '丝带加载', functionName: 'RibbonLoader', fileName: '加载-丝带动画.html', category: 'loading' },
  { id: 'cat-loader', label: '小猫加载', functionName: 'CatLoader', fileName: '加载-小猫.html', category: 'loading' },
  { id: 'petal-breath', label: '花瓣呼吸', functionName: 'PetalBreath', fileName: '加载动画-花瓣呼吸.html', category: 'loading' },
  { id: 'wizard-loader', label: '巫师加载', functionName: 'WizardLoader', fileName: '加载巫师.html', category: 'loading' },
  { id: 'basic-loader', label: '基础加载', functionName: 'BasicLoader', fileName: '加载效果.html', category: 'loading' },
  { id: 'progress-loader', label: '加载进度', functionName: 'ProgressLoader', fileName: '加载进度.html', category: 'loading' },
  { id: 'simple-load', label: '简易加载', functionName: 'SimpleLoad', fileName: 'load.html', category: 'loading' },

  // 背景效果
  { id: 'starfield', label: '星空背景', functionName: 'StarfieldBackground', fileName: '星空背景.html', category: 'background' },
  { id: 'rain-effect', label: '下雨效果', functionName: 'RainEffect', fileName: '下雨效果.html', category: 'background' },
  { id: 'night-scene', label: '夜景背景', functionName: 'NightSceneBackground', fileName: '背景-夜景.html', category: 'background' },
  { id: 'colorful-flow', label: '彩色流动', functionName: 'ColorfulFlowBackground', fileName: '背景-彩色流动.html', category: 'background' },
  { id: 'morphing-shape', label: '流动形态', functionName: 'MorphingShapeBackground', fileName: '背景-流动形态.html', category: 'background' },
  { id: 'particle-universe', label: '粒子宇宙', functionName: 'ParticleUniverseBackground', fileName: '背景-粒子-我的宇宙.html', category: 'background' },
  { id: 'blackhole-vortex', label: '黑洞漩涡', functionName: 'BlackholeVortexBackground', fileName: '背景-黑洞漩涡.html', category: 'background' },
  { id: 'infinite-lines', label: '无限线条', functionName: 'InfiniteLinesBackground', fileName: '背景无限线条.html', category: 'background' },
  { id: 'snowfall', label: '雪花飘落', functionName: 'SnowfallBackground', fileName: '雪花飘落.html', category: 'background' },

  // 按钮特效
  { id: 'generate-button', label: '生成按钮', functionName: 'GenerateButton', fileName: '生成按钮.html', category: 'button' },
  { id: 'login-button', label: '登陆按钮', functionName: 'LoginButton', fileName: '登陆按钮.html', category: 'button' },
  { id: 'disabled-button', label: '不可选按钮', functionName: 'DisabledButton', fileName: '不可选中按钮.html', category: 'button' },
  { id: 'click-me', label: '点击按钮', functionName: 'ClickMeButton', fileName: 'clickme.html', category: 'button' },
  { id: 'next-step', label: '下一步按钮', functionName: 'NextStepButton', fileName: '下一步.html', category: 'button' },
  { id: 'success-button', label: '成功按钮', functionName: 'SuccessButton', fileName: 'success.html', category: 'button' },
  { id: 'delete-button', label: '删除按钮', functionName: 'DeleteButton', fileName: 'delete.html', category: 'button' },

  // 卡片效果
  { id: 'glow-card', label: '特效卡片', functionName: 'GlowCard', fileName: '特效卡片.html', category: 'card' },
  { id: 'glass-ref', label: '磨砂玻璃', functionName: 'GlassReference', fileName: '磨砂玻璃参考.html', category: 'card' },

  // 图片效果
  { id: 'ripple-slider', label: '水波纹轮播', functionName: 'RippleImageSlider', fileName: '图片加载动效.html', category: 'image' },

  // 其他特效
  { id: 'geometric-rotate', label: '几何旋转', functionName: 'GeometricRotate', fileName: '几何旋转.html', category: 'other' },
  { id: 'recursive-network', label: '递归网络', functionName: 'RecursiveNetwork', fileName: '递归网络.html', category: 'other' },
  { id: 'song-homepage', label: '歌曲首页', functionName: 'SongHomepage', fileName: '适合歌曲首页.html', category: 'other' },
  { id: 'jq-effect', label: 'JQ特效', functionName: 'JqEffect', fileName: 'jq22973.html', category: 'other' },
];

// 获取 HTML 文件 URL
function getEffectUrl(fileName: string): string {
  // 使用相对路径访问 thirdparty/ref 目录下的文件
  return `/thirdparty/ref/${encodeURIComponent(fileName)}`;
}

// 特效卡片组件
function EffectCard({ config }: { config: EffectConfig }) {
  const [expanded, setExpanded] = useState(false);
  const url = getEffectUrl(config.fileName);

  return (
    <GlassCard className={`transition-all duration-300 ${expanded ? 'col-span-2 row-span-2' : ''}`}>
      {/* 卡片头部 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {config.label}
          </div>
          <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {config.functionName}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => window.open(url, '_blank')}
            title="新窗口打开"
          >
            <ExternalLink size={14} />
          </Button>
        </div>
      </div>

      {/* 分类标签 */}
      <div className="mb-2">
        <span
          className="inline-block text-xs px-2 py-0.5 rounded-full"
          style={{
            background: 'rgba(139, 92, 246, 0.15)',
            color: 'rgba(139, 92, 246, 0.9)',
            border: '1px solid rgba(139, 92, 246, 0.25)',
          }}
        >
          {CATEGORY_LABELS[config.category]}
        </span>
      </div>

      {/* 预览区域 */}
      <div
        className="relative rounded-lg overflow-hidden"
        style={{
          height: expanded ? '400px' : '180px',
          background: 'rgba(0, 0, 0, 0.3)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        <iframe
          src={url}
          title={config.label}
          className="w-full h-full border-0"
          style={{
            transform: expanded ? 'scale(1)' : 'scale(0.5)',
            transformOrigin: 'top left',
            width: expanded ? '100%' : '200%',
            height: expanded ? '100%' : '200%',
          }}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </GlassCard>
  );
}

export default function ShowcaseLabTab() {
  const [selectedCategory, setSelectedCategory] = useState<EffectCategory | 'all'>('all');

  const filteredEffects = useMemo(() => {
    if (selectedCategory === 'all') return EFFECT_CONFIGS;
    return EFFECT_CONFIGS.filter((config) => config.category === selectedCategory);
  }, [selectedCategory]);

  const categories: (EffectCategory | 'all')[] = ['all', 'loading', 'background', 'button', 'card', 'image', 'other'];

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            特效展示
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            第三方参考组件特效一览，共 {EFFECT_CONFIGS.length} 个效果
          </div>
        </div>
      </div>

      {/* 分类筛选 */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <Button
            key={cat}
            variant={selectedCategory === cat ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSelectedCategory(cat)}
          >
            {cat === 'all' ? '全部' : CATEGORY_LABELS[cat]}
            {cat === 'all' && (
              <span className="ml-1 text-xs opacity-60">({EFFECT_CONFIGS.length})</span>
            )}
            {cat !== 'all' && (
              <span className="ml-1 text-xs opacity-60">
                ({EFFECT_CONFIGS.filter((c) => c.category === cat).length})
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* 特效卡片网格 */}
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        }}
      >
        {filteredEffects.map((config) => (
          <EffectCard key={config.id} config={config} />
        ))}
      </div>
    </div>
  );
}
