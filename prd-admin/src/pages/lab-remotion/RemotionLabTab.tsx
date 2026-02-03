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
  MatrixRain,
  matrixRainDefaults,
  GlitchText,
  glitchTextDefaults,
  Typewriter,
  typewriterDefaults,
  BarChart,
  barChartDefaults,
  TechIntro,
  techIntroDefaults,
} from './templates';
import {
  Play,
  Pause,
  RotateCcw,
  Type,
  Sparkles,
  Waves,
  Settings2,
  Wand2,
  LayoutTemplate,
  Binary,
  Zap,
  Terminal,
  BarChart3,
  Rocket,
  Code2,
  Eye,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  Plus,
  Trash2,
  Monitor,
  Smartphone,
  Square,
  ChevronDown,
  ChevronUp,
  GripVertical,
} from 'lucide-react';
import { runModelLabStream } from '@/services';
import { REMOTION_SYSTEM_PROMPT, buildUserPrompt } from './lib/remotionPrompt';
import { compileRemotionCode, validateRemotionCode } from './lib/dynamicCompiler';
import Editor from '@monaco-editor/react';

// Mode types
type LabMode = 'templates' | 'ai';
type AiViewTab = 'code' | 'preview';

// Video specification types
type AspectRatio = '16:9' | '9:16' | '1:1';

interface VideoSpec {
  aspectRatio: AspectRatio;
  duration: number; // seconds
  fps: number;
}

interface Scene {
  id: string;
  description: string;
  duration: number; // seconds
}

// Aspect ratio presets
const ASPECT_RATIO_PRESETS: Record<AspectRatio, { width: number; height: number; label: string; icon: React.ReactNode }> = {
  '16:9': { width: 1920, height: 1080, label: '横屏 16:9', icon: <Monitor size={16} /> },
  '9:16': { width: 1080, height: 1920, label: '竖屏 9:16', icon: <Smartphone size={16} /> },
  '1:1': { width: 1080, height: 1080, label: '方形 1:1', icon: <Square size={16} /> },
};

const FPS_OPTIONS = [24, 30, 60];
const DURATION_PRESETS = [3, 5, 10, 15, 30];

// Template types
type TemplateKey = 'techIntro' | 'textReveal' | 'logoAnimation' | 'particleWave' | 'matrixRain' | 'glitchText' | 'typewriter' | 'barChart';

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
    key: 'techIntro',
    name: '科技片头',
    description: '粒子网格 + 光效扫描 + 标题动画',
    icon: <Rocket size={18} />,
    component: TechIntro,
    defaults: techIntroDefaults,
    fields: [
      { key: 'title', label: '主标题', type: 'text' },
      { key: 'subtitle', label: '副标题', type: 'text' },
      { key: 'primaryColor', label: '主色', type: 'color' },
      { key: 'secondaryColor', label: '副色', type: 'color' },
    ],
  },
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
  {
    key: 'matrixRain',
    name: 'Matrix 代码雨',
    description: '黑客帝国风格代码雨',
    icon: <Binary size={18} />,
    component: MatrixRain,
    defaults: matrixRainDefaults,
    fields: [
      { key: 'charColor', label: '字符颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'columnCount', label: '列数', type: 'range', min: 10, max: 50, step: 5 },
      { key: 'speed', label: '速度', type: 'range', min: 0.5, max: 3, step: 0.1 },
    ],
  },
  {
    key: 'glitchText',
    name: '故障文字',
    description: 'Glitch 故障风格特效',
    icon: <Zap size={18} />,
    component: GlitchText,
    defaults: glitchTextDefaults,
    fields: [
      { key: 'text', label: '文字内容', type: 'text' },
      { key: 'textColor', label: '文字颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'glitchIntensity', label: '故障强度', type: 'range', min: 0.5, max: 2, step: 0.1 },
    ],
  },
  {
    key: 'typewriter',
    name: '打字机',
    description: '终端风格逐字打印',
    icon: <Terminal size={18} />,
    component: Typewriter,
    defaults: typewriterDefaults,
    fields: [
      { key: 'text', label: '文字内容', type: 'text' },
      { key: 'textColor', label: '文字颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'typingSpeed', label: '打字速度', type: 'range', min: 1, max: 6, step: 1 },
    ],
  },
  {
    key: 'barChart',
    name: '柱状图',
    description: '动态数据图表动画',
    icon: <BarChart3 size={18} />,
    component: BarChart,
    defaults: barChartDefaults,
    fields: [
      { key: 'title', label: '标题', type: 'text' },
      { key: 'barColor', label: '柱子颜色', type: 'color' },
      { key: 'backgroundColor', label: '背景颜色', type: 'color' },
      { key: 'textColor', label: '文字颜色', type: 'color' },
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

// 视频类型预设
const VIDEO_TYPE_PRESETS = [
  { label: '产品宣传', description: '展示产品特性和优势' },
  { label: '品牌片头', description: 'Logo 动画和品牌展示' },
  { label: '数据可视化', description: '图表和数据动态展示' },
  { label: '社交媒体', description: '短视频和动态海报' },
  { label: '教程演示', description: '步骤说明和功能演示' },
  { label: '活动预告', description: '活动信息和倒计时' },
];

// 空白占位组件
const PlaceholderComponent: React.FC = () => {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0f172a',
        color: '#64748b',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✨</div>
        <div style={{ fontSize: 18 }}>输入描述，AI 将为你生成动画</div>
      </div>
    </div>
  );
};

export default function RemotionLabTab() {
  // Mode state
  const [mode, setMode] = useState<LabMode>('templates');

  // Template mode state
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey>('techIntro');
  const [params, setParams] = useState<Record<TemplateKey, Record<string, any>>>({
    techIntro: { ...techIntroDefaults },
    textReveal: { ...textRevealDefaults },
    logoAnimation: { ...logoAnimationDefaults },
    particleWave: { ...particleWaveDefaults },
    matrixRain: { ...matrixRainDefaults },
    glitchText: { ...glitchTextDefaults },
    typewriter: { ...typewriterDefaults },
    barChart: { ...barChartDefaults },
  });

  // AI mode state
  const [aiViewTab, setAiViewTab] = useState<AiViewTab>('preview');
  const [aiComponent, setAiComponent] = useState<React.FC | null>(null);
  const [aiCode, setAiCode] = useState('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiValidationWarning, setAiValidationWarning] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [copied, setCopied] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Video creation workflow state
  const [videoTheme, setVideoTheme] = useState(''); // 视频主题描述
  const [videoSpec, setVideoSpec] = useState<VideoSpec>({
    aspectRatio: '16:9',
    duration: 5,
    fps: 30,
  });
  const [scenes, setScenes] = useState<Scene[]>([
    { id: '1', description: '', duration: 3 },
  ]);
  const [expandedSection, setExpandedSection] = useState<'theme' | 'spec' | 'scenes'>('theme');

  // Player state
  const [isPlaying, setIsPlaying] = useState(true);
  const playerRef = useRef<PlayerRef>(null);

  const currentTemplate = useMemo(
    () => templates.find((t) => t.key === selectedTemplate)!,
    [selectedTemplate]
  );

  const currentParams = params[selectedTemplate];

  // 当前要渲染的组件
  const currentComponent = useMemo(() => {
    if (mode === 'ai') {
      return aiComponent || PlaceholderComponent;
    }
    return currentTemplate.component;
  }, [mode, aiComponent, currentTemplate]);

  // 当前组件的 props
  const currentInputProps = useMemo(() => {
    if (mode === 'ai') {
      return {};
    }
    return currentParams;
  }, [mode, currentParams]);

  // 计算视频配置（基于 videoSpec）
  const computedVideoConfig = useMemo(() => {
    const preset = ASPECT_RATIO_PRESETS[videoSpec.aspectRatio];
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0) || videoSpec.duration;
    return {
      width: preset.width,
      height: preset.height,
      fps: videoSpec.fps,
      durationInFrames: totalDuration * videoSpec.fps,
    };
  }, [videoSpec, scenes]);

  // 场景管理
  const addScene = useCallback(() => {
    const newId = String(Date.now());
    setScenes(prev => [...prev, { id: newId, description: '', duration: 3 }]);
  }, []);

  const removeScene = useCallback((id: string) => {
    setScenes(prev => prev.filter(s => s.id !== id));
  }, []);

  const updateScene = useCallback((id: string, updates: Partial<Scene>) => {
    setScenes(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  // 构建完整的生成 prompt
  const buildFullPrompt = useCallback(() => {
    const specInfo = ASPECT_RATIO_PRESETS[videoSpec.aspectRatio];
    const parts: string[] = [];

    parts.push(`【视频主题】${videoTheme || '未指定'}`);
    parts.push(`【视频规格】${specInfo.label} (${specInfo.width}x${specInfo.height}), ${videoSpec.fps}fps`);

    if (scenes.length > 0 && scenes.some(s => s.description.trim())) {
      parts.push('【场景分解】');
      scenes.forEach((scene, idx) => {
        if (scene.description.trim()) {
          parts.push(`  场景 ${idx + 1} (${scene.duration}秒): ${scene.description}`);
        }
      });
    }

    return parts.join('\n');
  }, [videoTheme, videoSpec, scenes]);

  // 检查是否可以生成
  const canGenerate = useMemo(() => {
    return videoTheme.trim().length > 0 || scenes.some(s => s.description.trim().length > 0);
  }, [videoTheme, scenes]);

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

  // AI 生成相关
  const handleGenerate = useCallback(async () => {
    if (!canGenerate || isGenerating) return;

    const fullPrompt = buildFullPrompt();

    setIsGenerating(true);
    setAiError(null);
    setAiValidationWarning(null);
    setAiCode('');
    setStreamingText('');
    setAiViewTab('code'); // 生成时切换到代码 Tab

    abortControllerRef.current = new AbortController();

    try {
      let fullResponse = '';

      await runModelLabStream({
        input: {
          suite: 'custom',
          promptText: buildUserPrompt(fullPrompt),
          systemPromptOverride: REMOTION_SYSTEM_PROMPT,
          includeMainModelAsStandard: true,
          params: {
            temperature: 0.7,
            maxTokens: 4000,
            timeoutMs: 60000,
            maxConcurrency: 1,
            repeatN: 1,
          },
        },
        onEvent: (event) => {
          if (!event.data) return;

          try {
            const parsed = JSON.parse(event.data);

            // 处理流式内容
            if (event.event === 'model' && parsed.type === 'delta' && parsed.content) {
              fullResponse += parsed.content;
              setStreamingText(fullResponse);
            }
            // 处理完成
            else if (event.event === 'run' && parsed.type === 'runDone') {
              setAiCode(fullResponse);

              // 先校验代码格式
              const validation = validateRemotionCode(fullResponse);
              if (!validation.valid) {
                setAiValidationWarning(validation.reason || '代码格式可能有问题');
              }

              // 尝试编译
              const result = compileRemotionCode(fullResponse);
              if (result.success && result.component) {
                setAiComponent(() => result.component!);
                setAiError(null);
                setAiViewTab('preview'); // 成功后切换到预览
                // 重新播放
                setTimeout(() => {
                  if (playerRef.current) {
                    playerRef.current.seekTo(0);
                    playerRef.current.play();
                    setIsPlaying(true);
                  }
                }, 100);
              } else {
                setAiError(result.error || '编译失败');
                // 编译失败保持在代码 Tab
              }
            }
            // 处理错误
            else if (parsed.type === 'error') {
              setAiError(parsed.errorMessage || parsed.message || '生成失败');
            }
          } catch {
            // 忽略解析错误
          }
        },
        signal: abortControllerRef.current.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setAiError(err.message);
      }
    } finally {
      setIsGenerating(false);
    }
  }, [canGenerate, buildFullPrompt, isGenerating]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsGenerating(false);
  }, []);

  const handleCodeChange = useCallback((newCode: string | undefined) => {
    setAiCode(newCode || '');
    setAiError(null);
    setAiValidationWarning(null);
  }, []);

  const handleRunCode = useCallback(() => {
    if (!aiCode.trim()) return;

    // 校验
    const validation = validateRemotionCode(aiCode);
    if (!validation.valid) {
      setAiValidationWarning(validation.reason || '代码格式可能有问题');
    } else {
      setAiValidationWarning(null);
    }

    // 编译
    const result = compileRemotionCode(aiCode);
    if (result.success && result.component) {
      setAiComponent(() => result.component!);
      setAiError(null);
      setAiViewTab('preview');
      setTimeout(() => {
        if (playerRef.current) {
          playerRef.current.seekTo(0);
          playerRef.current.play();
          setIsPlaying(true);
        }
      }, 100);
    } else {
      setAiError(result.error || '编译失败');
    }
  }, [aiCode]);

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(aiCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('复制失败', err);
    }
  }, [aiCode]);

  // 显示的代码（生成中显示 streaming，否则显示最终代码）
  const displayCode = isGenerating ? streamingText : aiCode;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Mode switcher */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('templates')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg transition-all',
            mode === 'templates'
              ? 'bg-blue-500 text-white'
              : 'bg-white/5 text-[var(--text-secondary)] hover:bg-white/10'
          )}
        >
          <LayoutTemplate size={16} />
          预设模板
        </button>
        <button
          onClick={() => setMode('ai')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg transition-all',
            mode === 'ai'
              ? 'bg-purple-500 text-white'
              : 'bg-white/5 text-[var(--text-secondary)] hover:bg-white/10'
          )}
        >
          <Wand2 size={16} />
          AI 生成
          <span className="text-xs px-1.5 py-0.5 rounded bg-white/20">Beta</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
        {/* Left Panel */}
        <div className="w-full lg:w-80 flex flex-col gap-4 shrink-0 overflow-auto">
          {mode === 'templates' ? (
            <>
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
            </>
          ) : (
            /* AI 模式左侧：专业视频创作工作流 */
            <div className="flex flex-col gap-3 overflow-auto">
              {/* 第一步：视频主题 */}
              <GlassCard padding="none" glow={expandedSection === 'theme'} accentHue={270}>
                <button
                  onClick={() => setExpandedSection(expandedSection === 'theme' ? 'theme' : 'theme')}
                  className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-xs font-bold">1</div>
                    <span className="text-sm font-medium text-[var(--text-primary)]">视频主题</span>
                  </div>
                  {expandedSection === 'theme' ? <ChevronUp size={16} className="text-[var(--text-tertiary)]" /> : <ChevronDown size={16} className="text-[var(--text-tertiary)]" />}
                </button>
                {expandedSection === 'theme' && (
                  <div className="px-3 pb-3 space-y-3">
                    <textarea
                      value={videoTheme}
                      onChange={(e) => setVideoTheme(e.target.value)}
                      placeholder="描述你想要创建的视频...&#10;例如：一个展示 AI 技术的科技感片头"
                      className="w-full h-20 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-purple-500/50"
                      disabled={isGenerating}
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {VIDEO_TYPE_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => setVideoTheme(preset.description)}
                          className="px-2 py-1 text-xs rounded-md bg-white/5 hover:bg-white/10 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                          disabled={isGenerating}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </GlassCard>

              {/* 第二步：视频规格 */}
              <GlassCard padding="none" glow={expandedSection === 'spec'}>
                <button
                  onClick={() => setExpandedSection(expandedSection === 'spec' ? 'theme' : 'spec')}
                  className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs font-bold">2</div>
                    <span className="text-sm font-medium text-[var(--text-primary)]">视频规格</span>
                    <span className="text-xs text-[var(--text-tertiary)]">
                      {ASPECT_RATIO_PRESETS[videoSpec.aspectRatio].label} · {videoSpec.fps}fps
                    </span>
                  </div>
                  {expandedSection === 'spec' ? <ChevronUp size={16} className="text-[var(--text-tertiary)]" /> : <ChevronDown size={16} className="text-[var(--text-tertiary)]" />}
                </button>
                {expandedSection === 'spec' && (
                  <div className="px-3 pb-3 space-y-4">
                    {/* 画面比例 */}
                    <div>
                      <label className="text-xs text-[var(--text-secondary)] mb-2 block">画面比例</label>
                      <div className="flex gap-2">
                        {(Object.keys(ASPECT_RATIO_PRESETS) as AspectRatio[]).map((ratio) => {
                          const preset = ASPECT_RATIO_PRESETS[ratio];
                          return (
                            <button
                              key={ratio}
                              onClick={() => setVideoSpec(prev => ({ ...prev, aspectRatio: ratio }))}
                              className={cn(
                                'flex-1 flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors',
                                videoSpec.aspectRatio === ratio
                                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                                  : 'bg-white/5 border-white/10 text-[var(--text-secondary)] hover:bg-white/10'
                              )}
                            >
                              {preset.icon}
                              <span className="text-xs">{ratio}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 帧率 */}
                    <div>
                      <label className="text-xs text-[var(--text-secondary)] mb-2 block">帧率 (FPS)</label>
                      <div className="flex gap-2">
                        {FPS_OPTIONS.map((fps) => (
                          <button
                            key={fps}
                            onClick={() => setVideoSpec(prev => ({ ...prev, fps }))}
                            className={cn(
                              'flex-1 py-1.5 rounded-lg border text-sm transition-colors',
                              videoSpec.fps === fps
                                ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                                : 'bg-white/5 border-white/10 text-[var(--text-secondary)] hover:bg-white/10'
                            )}
                          >
                            {fps}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 默认时长 */}
                    <div>
                      <label className="text-xs text-[var(--text-secondary)] mb-2 block">默认时长（秒）</label>
                      <div className="flex gap-2">
                        {DURATION_PRESETS.slice(0, 4).map((dur) => (
                          <button
                            key={dur}
                            onClick={() => setVideoSpec(prev => ({ ...prev, duration: dur }))}
                            className={cn(
                              'flex-1 py-1.5 rounded-lg border text-sm transition-colors',
                              videoSpec.duration === dur
                                ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                                : 'bg-white/5 border-white/10 text-[var(--text-secondary)] hover:bg-white/10'
                            )}
                          >
                            {dur}s
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </GlassCard>

              {/* 第三步：场景分解 */}
              <GlassCard padding="none" glow={expandedSection === 'scenes'}>
                <button
                  onClick={() => setExpandedSection(expandedSection === 'scenes' ? 'theme' : 'scenes')}
                  className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">3</div>
                    <span className="text-sm font-medium text-[var(--text-primary)]">场景分解</span>
                    <span className="text-xs text-[var(--text-tertiary)]">
                      {scenes.length} 个场景 · {scenes.reduce((s, sc) => s + sc.duration, 0)}s
                    </span>
                  </div>
                  {expandedSection === 'scenes' ? <ChevronUp size={16} className="text-[var(--text-tertiary)]" /> : <ChevronDown size={16} className="text-[var(--text-tertiary)]" />}
                </button>
                {expandedSection === 'scenes' && (
                  <div className="px-3 pb-3 space-y-2">
                    {scenes.map((scene, idx) => (
                      <div key={scene.id} className="flex gap-2 items-start">
                        <div className="flex items-center gap-1 pt-2">
                          <GripVertical size={14} className="text-[var(--text-tertiary)]" />
                          <span className="text-xs text-[var(--text-tertiary)] w-4">{idx + 1}</span>
                        </div>
                        <div className="flex-1">
                          <input
                            type="text"
                            value={scene.description}
                            onChange={(e) => updateScene(scene.id, { description: e.target.value })}
                            placeholder={`场景 ${idx + 1} 描述...`}
                            className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-green-500/50"
                            disabled={isGenerating}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={1}
                            max={30}
                            value={scene.duration}
                            onChange={(e) => updateScene(scene.id, { duration: parseInt(e.target.value) || 1 })}
                            className="w-12 px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-[var(--text-primary)] text-center focus:outline-none focus:border-green-500/50"
                            disabled={isGenerating}
                          />
                          <span className="text-xs text-[var(--text-tertiary)]">秒</span>
                          {scenes.length > 1 && (
                            <button
                              onClick={() => removeScene(scene.id)}
                              className="p-1 rounded hover:bg-red-500/20 text-[var(--text-tertiary)] hover:text-red-400 transition-colors"
                              disabled={isGenerating}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={addScene}
                      className="w-full flex items-center justify-center gap-1 py-2 rounded-lg border border-dashed border-white/20 text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors text-sm"
                      disabled={isGenerating}
                    >
                      <Plus size={14} />
                      添加场景
                    </button>
                  </div>
                )}
              </GlassCard>

              {/* 生成按钮 */}
              <GlassCard padding="md" glow accentHue={270}>
                {isGenerating ? (
                  <button
                    onClick={handleCancel}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                  >
                    <Loader2 size={18} className="animate-spin" />
                    取消生成
                  </button>
                ) : (
                  <button
                    onClick={handleGenerate}
                    disabled={!canGenerate}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-all"
                  >
                    <Sparkles size={18} />
                    生成视频动画
                  </button>
                )}
                <div className="mt-2 text-xs text-center text-[var(--text-tertiary)]">
                  {ASPECT_RATIO_PRESETS[videoSpec.aspectRatio].width}×{ASPECT_RATIO_PRESETS[videoSpec.aspectRatio].height} · {videoSpec.fps}fps · {scenes.reduce((s, sc) => s + sc.duration, 0) || videoSpec.duration}秒
                </div>
              </GlassCard>

              {/* 错误/警告提示 */}
              {(aiError || aiValidationWarning) && (
                <GlassCard padding="sm" accentHue={aiError ? 0 : 45}>
                  <div className={cn('flex items-start gap-2', aiError ? 'text-red-400' : 'text-yellow-400')}>
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <div className="flex-1 text-sm">
                      {aiError || aiValidationWarning}
                    </div>
                  </div>
                </GlassCard>
              )}
            </div>
          )}
        </div>

        {/* Right Panel */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {mode === 'templates' ? (
            /* 模板模式：只显示预览 */
            <GlassCard padding="none" className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 flex items-center justify-center p-4 bg-black/20">
                <div className="w-full max-w-[960px] aspect-video rounded-lg overflow-hidden shadow-2xl">
                  <Player
                    ref={playerRef}
                    component={currentComponent}
                    inputProps={currentInputProps}
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
          ) : (
            /* AI 模式：代码/预览 Tab 切换 */
            <GlassCard padding="none" className="flex-1 flex flex-col overflow-hidden">
              {/* Tab 切换器 */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
                <div className="flex gap-1">
                  <button
                    onClick={() => setAiViewTab('code')}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
                      aiViewTab === 'code'
                        ? 'bg-white/10 text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-white/5'
                    )}
                  >
                    <Code2 size={14} />
                    代码
                    {isGenerating && (
                      <Loader2 size={12} className="animate-spin text-purple-400" />
                    )}
                  </button>
                  <button
                    onClick={() => setAiViewTab('preview')}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
                      aiViewTab === 'preview'
                        ? 'bg-white/10 text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-white/5'
                    )}
                  >
                    <Eye size={14} />
                    预览
                  </button>
                </div>

                {/* 操作按钮 */}
                {aiViewTab === 'code' && displayCode && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleRunCode}
                      disabled={isGenerating || !displayCode.trim()}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Play size={12} />
                      运行
                    </button>
                    <button
                      onClick={handleCopyCode}
                      disabled={!displayCode.trim()}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg hover:bg-white/10 text-[var(--text-secondary)] transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check size={12} className="text-green-400" />
                          <span className="text-green-400">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy size={12} />
                          复制
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* 内容区 */}
              <div className="flex-1 min-h-0">
                {aiViewTab === 'code' ? (
                  /* 代码编辑器 */
                  displayCode ? (
                    <Editor
                      height="100%"
                      defaultLanguage="typescript"
                      value={displayCode}
                      onChange={handleCodeChange}
                      theme="vs-dark"
                      options={{
                        readOnly: isGenerating,
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        tabSize: 2,
                        automaticLayout: true,
                        padding: { top: 12, bottom: 12 },
                        scrollbar: {
                          verticalScrollbarSize: 8,
                          horizontalScrollbarSize: 8,
                        },
                        overviewRulerBorder: false,
                        hideCursorInOverviewRuler: true,
                        renderLineHighlight: 'none',
                      }}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-[var(--text-tertiary)]">
                      <div className="text-center">
                        <Code2 size={48} className="mx-auto mb-3 opacity-30" />
                        <div className="text-sm">生成动画后，代码将显示在这里</div>
                      </div>
                    </div>
                  )
                ) : (
                  /* 预览 */
                  <div className="h-full flex flex-col">
                    <div className="flex-1 flex items-center justify-center p-4 bg-black/20">
                      <div
                        className="rounded-lg overflow-hidden shadow-2xl"
                        style={{
                          width: '100%',
                          maxWidth: videoSpec.aspectRatio === '9:16' ? '400px' : '960px',
                          aspectRatio: videoSpec.aspectRatio === '16:9' ? '16/9' : videoSpec.aspectRatio === '9:16' ? '9/16' : '1/1',
                        }}
                      >
                        <Player
                          ref={playerRef}
                          component={currentComponent}
                          inputProps={currentInputProps}
                          durationInFrames={computedVideoConfig.durationInFrames}
                          fps={computedVideoConfig.fps}
                          compositionWidth={computedVideoConfig.width}
                          compositionHeight={computedVideoConfig.height}
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
                        {computedVideoConfig.fps} FPS · {computedVideoConfig.durationInFrames} 帧 · {(computedVideoConfig.durationInFrames / computedVideoConfig.fps).toFixed(1)}s
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </GlassCard>
          )}
        </div>
      </div>
    </div>
  );
}
