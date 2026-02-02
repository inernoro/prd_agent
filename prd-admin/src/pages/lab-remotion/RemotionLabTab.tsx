import { useState, useMemo, useCallback, useRef } from 'react';
import { Player, PlayerRef } from '@remotion/player';
import { GlassCard } from '@/components/design/GlassCard';
import { cn } from '@/lib/cn';
import {
  TextReveal,
  textRevealDefaults,
  LogoAnimation,
  logoAnimationDefaults,
  ParticleWave,
  particleWaveDefaults,
} from './templates';
import {
  Play,
  Pause,
  RotateCcw,
  Type,
  Sparkles,
  Waves,
  Settings2,
} from 'lucide-react';

// Template types
type TemplateKey = 'textReveal' | 'logoAnimation' | 'particleWave';

interface TemplateConfig {
  key: TemplateKey;
  name: string;
  description: string;
  icon: React.ReactNode;
  component: React.FC<any>;
  defaults: Record<string, any>;
  fields: FieldConfig[];
}

interface FieldConfig {
  key: string;
  label: string;
  type: 'text' | 'color' | 'number' | 'range';
  min?: number;
  max?: number;
  step?: number;
}

// Template configurations
const templates: TemplateConfig[] = [
  {
    key: 'textReveal',
    name: '文字揭示',
    description: '逐词弹出的文字动画效果',
    icon: <Type size={18} />,
    component: TextReveal,
    defaults: textRevealDefaults,
    fields: [
      { key: 'text', label: '文字内容', type: 'text' },
      { key: 'color', label: '文字颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'fontSize', label: '字体大小', type: 'range', min: 24, max: 120, step: 4 },
    ],
  },
  {
    key: 'logoAnimation',
    name: 'Logo 动画',
    description: '旋转光环 + 文字淡入效果',
    icon: <Sparkles size={18} />,
    component: LogoAnimation,
    defaults: logoAnimationDefaults,
    fields: [
      { key: 'logoText', label: 'Logo 文字', type: 'text' },
      { key: 'primaryColor', label: '主色', type: 'color' },
      { key: 'secondaryColor', label: '副色', type: 'color' },
      { key: 'backgroundColor', label: '背景色', type: 'color' },
    ],
  },
  {
    key: 'particleWave',
    name: '粒子波浪',
    description: '流动的粒子波浪效果',
    icon: <Waves size={18} />,
    component: ParticleWave,
    defaults: particleWaveDefaults,
    fields: [
      { key: 'particleColor', label: '粒子颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'particleCount', label: '粒子数量', type: 'range', min: 20, max: 100, step: 5 },
      { key: 'waveSpeed', label: '波浪速度', type: 'range', min: 0.5, max: 3, step: 0.1 },
    ],
  },
];

// Video config
const VIDEO_CONFIG = {
  fps: 30,
  durationInFrames: 90, // 3 seconds
  width: 1280,
  height: 720,
};

export default function RemotionLabTab() {
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey>('textReveal');
  const [params, setParams] = useState<Record<TemplateKey, Record<string, any>>>({
    textReveal: { ...textRevealDefaults },
    logoAnimation: { ...logoAnimationDefaults },
    particleWave: { ...particleWaveDefaults },
  });
  const [isPlaying, setIsPlaying] = useState(true);
  const playerRef = useRef<PlayerRef>(null);

  const currentTemplate = useMemo(
    () => templates.find((t) => t.key === selectedTemplate)!,
    [selectedTemplate]
  );

  const currentParams = params[selectedTemplate];

  const handleParamChange = useCallback(
    (key: string, value: string | number) => {
      setParams((prev) => ({
        ...prev,
        [selectedTemplate]: {
          ...prev[selectedTemplate],
          [key]: value,
        },
      }));
    },
    [selectedTemplate]
  );

  const handleReset = useCallback(() => {
    setParams((prev) => ({
      ...prev,
      [selectedTemplate]: { ...currentTemplate.defaults },
    }));
  }, [selectedTemplate, currentTemplate]);

  const handlePlayPause = useCallback(() => {
    if (playerRef.current) {
      if (isPlaying) {
        playerRef.current.pause();
      } else {
        playerRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying]);

  const handleSeekToStart = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.seekTo(0);
      playerRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  return (
    <div className="h-full flex flex-col lg:flex-row gap-4">
      {/* Left: Template selector + Controls */}
      <div className="w-full lg:w-80 flex flex-col gap-4 shrink-0">
        {/* Template selector */}
        <GlassCard padding="md" glow>
          <div className="flex items-center gap-2 mb-3">
            <Settings2 size={16} className="text-[var(--text-secondary)]" />
            <h3 className="text-sm font-medium text-[var(--text-primary)]">选择模板</h3>
          </div>
          <div className="flex flex-col gap-2">
            {templates.map((template) => (
              <button
                key={template.key}
                onClick={() => setSelectedTemplate(template.key)}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg transition-all',
                  'hover:bg-white/5',
                  selectedTemplate === template.key
                    ? 'bg-white/10 border border-white/20'
                    : 'border border-transparent'
                )}
              >
                <div
                  className={cn(
                    'p-2 rounded-lg',
                    selectedTemplate === template.key
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-white/5 text-[var(--text-secondary)]'
                  )}
                >
                  {template.icon}
                </div>
                <div className="text-left">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    {template.name}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)]">
                    {template.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </GlassCard>

        {/* Parameter controls */}
        <GlassCard padding="md" className="flex-1 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">参数调节</h3>
            <button
              onClick={handleReset}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1"
            >
              <RotateCcw size={12} />
              重置
            </button>
          </div>
          <div className="flex flex-col gap-4">
            {currentTemplate.fields.map((field) => (
              <div key={field.key}>
                <label className="text-xs text-[var(--text-secondary)] mb-1.5 block">
                  {field.label}
                </label>
                {field.type === 'text' && (
                  <input
                    type="text"
                    value={currentParams[field.key] || ''}
                    onChange={(e) => handleParamChange(field.key, e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500/50"
                  />
                )}
                {field.type === 'color' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={currentParams[field.key] || '#ffffff'}
                      onChange={(e) => handleParamChange(field.key, e.target.value)}
                      className="w-10 h-10 rounded-lg cursor-pointer bg-transparent border-0"
                    />
                    <input
                      type="text"
                      value={currentParams[field.key] || ''}
                      onChange={(e) => handleParamChange(field.key, e.target.value)}
                      className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:border-blue-500/50"
                    />
                  </div>
                )}
                {field.type === 'range' && (
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={currentParams[field.key] || field.min}
                      onChange={(e) => handleParamChange(field.key, parseFloat(e.target.value))}
                      className="flex-1 h-2 rounded-full appearance-none bg-white/10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:cursor-pointer"
                    />
                    <span className="text-xs text-[var(--text-secondary)] w-12 text-right font-mono">
                      {currentParams[field.key]}
                    </span>
                  </div>
                )}
                {field.type === 'number' && (
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={currentParams[field.key] || 0}
                    onChange={(e) => handleParamChange(field.key, parseFloat(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500/50"
                  />
                )}
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* Right: Video player */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        <GlassCard padding="none" className="flex-1 flex flex-col overflow-hidden">
          {/* Player area */}
          <div className="flex-1 flex items-center justify-center p-4 bg-black/20">
            <div className="w-full max-w-[960px] aspect-video rounded-lg overflow-hidden shadow-2xl">
              <Player
                ref={playerRef}
                component={currentTemplate.component}
                inputProps={currentParams}
                durationInFrames={VIDEO_CONFIG.durationInFrames}
                fps={VIDEO_CONFIG.fps}
                compositionWidth={VIDEO_CONFIG.width}
                compositionHeight={VIDEO_CONFIG.height}
                style={{ width: '100%', height: '100%' }}
                loop
                autoPlay
              />
            </div>
          </div>

          {/* Playback controls */}
          <div className="p-4 border-t border-white/10 flex items-center justify-center gap-4">
            <button
              onClick={handleSeekToStart}
              className="p-2 rounded-lg hover:bg-white/10 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="从头播放"
            >
              <RotateCcw size={18} />
            </button>
            <button
              onClick={handlePlayPause}
              className="p-3 rounded-full bg-blue-500 hover:bg-blue-600 text-white transition-colors"
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <div className="text-xs text-[var(--text-tertiary)] font-mono">
              {VIDEO_CONFIG.fps} FPS · {VIDEO_CONFIG.durationInFrames} 帧 · {(VIDEO_CONFIG.durationInFrames / VIDEO_CONFIG.fps).toFixed(1)}s
            </div>
          </div>
        </GlassCard>

        {/* Info card */}
        <GlassCard padding="md" variant="subtle">
          <div className="text-sm text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">Remotion</strong> - 使用 React 创建视频的框架。
            每一帧都是 React 组件的渲染结果，通过 <code className="px-1.5 py-0.5 rounded bg-white/10 text-xs">useCurrentFrame()</code> 获取当前帧号来实现动画。
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
