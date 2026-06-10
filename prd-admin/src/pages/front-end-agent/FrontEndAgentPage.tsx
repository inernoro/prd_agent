import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Bug,
  Clipboard,
  Code2,
  FileText,
  Image as ImageIcon,
  PanelsTopLeft,
  RefreshCw,
  Sparkles,
  StopCircle,
} from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { toast } from '@/lib/toast';
import {
  FRONT_END_AGENT_STREAM_URL,
  type FrontEndAgentRequest,
  type FrontEndAgentTaskType,
} from '@/services/real/frontEndAgent';
import { FrontEndPdaGuideModal, FrontEndPdaRailCard } from './FrontEndPdaGuide';
import { FrontEndProjectRailCard, FrontEndProjectTableModal } from './FrontEndProjectTable';
import { FrontEndScreenshotInput, type ScreenshotAttachment } from './FrontEndScreenshotInput';
import { FrontEndCosmosBackground } from './FrontEndCosmosBackground';
import './front-end-agent.css';

interface TaskDefinition {
  key: FrontEndAgentTaskType;
  title: string;
  shortTitle: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  placeholder: string;
  primaryContextLabel: string;
  primaryContextKey: keyof Pick<FrontEndAgentRequest, 'apiSpec' | 'existingCode' | 'errorLog' | 'screenshotNotes'>;
  contextPlaceholder: string;
}

const TASK_DEFINITIONS: TaskDefinition[] = [
  {
    key: 'api-adapter',
    title: '后端 API 前端适配器',
    shortTitle: '接 API',
    description: '把接口契约变成 TypeScript 类型、service 调用和页面示例。',
    icon: Code2,
    accent: 'emerald',
    placeholder: '例：帮我把用户列表接口接到 React 页面，支持搜索、分页、错误提示。',
    primaryContextLabel: 'API 契约 / Controller / JSON 示例',
    primaryContextKey: 'apiSpec',
    contextPlaceholder: '粘贴接口路径、请求体、响应 JSON、Controller 方法或 OpenAPI 片段。',
  },
  {
    key: 'component',
    title: 'UI 组件代码生成',
    shortTitle: '写组件',
    description: '根据自然语言生成可复制的 React/Vue 组件和接入步骤。',
    icon: PanelsTopLeft,
    accent: 'sky',
    placeholder: '例：做一个可编辑的配置表单，左侧分组，右侧表单，保存时校验必填项。',
    primaryContextLabel: '现有代码 / 组件约束',
    primaryContextKey: 'existingCode',
    contextPlaceholder: '粘贴已有组件、设计系统约束、字段配置或希望复用的代码。',
  },
  {
    key: 'debug',
    title: '前端报错诊断',
    shortTitle: '修报错',
    description: '解析控制台、构建、接口错误，给出定位路径和最小修复代码。',
    icon: Bug,
    accent: 'rose',
    placeholder: '例：页面白屏，控制台提示 Cannot read properties of undefined，帮我定位并修。',
    primaryContextLabel: '报错日志 / 构建输出',
    primaryContextKey: 'errorLog',
    contextPlaceholder: '粘贴浏览器 console、pnpm tsc、pnpm lint、接口错误或堆栈信息。',
  },
  {
    key: 'visual-diagnosis',
    title: '截图视觉诊断',
    shortTitle: '看截图',
    description: '根据截图现象或设计稿差异描述，输出 CSS 和布局修复方案。',
    icon: ImageIcon,
    accent: 'violet',
    placeholder: '例：弹窗内容超过屏幕，底部按钮看不到；移动端卡片左右溢出。',
    primaryContextLabel: '截图现象 / 设计稿差异描述',
    primaryContextKey: 'screenshotNotes',
    contextPlaceholder: '描述截图里哪里不对，或粘贴设计稿与实际页面的差异点。',
  },
];

const FRAMEWORK_OPTIONS = [
  'Vue3 + UniApp 小程序',
  'Vue 3 + TypeScript',
  'React + TypeScript',
  '纯 HTML/CSS/JS',
  '按输入材料判断',
];
const DEFAULT_TARGET_FRAMEWORK = FRAMEWORK_OPTIONS[0];

type Phase = 'idle' | 'streaming' | 'done' | 'error';

function safeJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getTaskDefinition(key: FrontEndAgentTaskType): TaskDefinition {
  return TASK_DEFINITIONS.find((t) => t.key === key) ?? TASK_DEFINITIONS[0];
}

function accentClasses(accent: string): { border: string; bg: string; text: string; soft: string; glow: string } {
  const map: Record<string, { border: string; bg: string; text: string; soft: string; glow: string }> = {
    emerald: { border: 'border-emerald-400/30', bg: 'bg-emerald-500/10', text: 'text-emerald-200', soft: 'text-emerald-300/70', glow: 'shadow-[0_0_24px_rgba(16,185,129,0.15)]' },
    sky: { border: 'border-sky-400/30', bg: 'bg-sky-500/10', text: 'text-sky-200', soft: 'text-sky-300/70', glow: 'shadow-[0_0_24px_rgba(14,165,233,0.15)]' },
    rose: { border: 'border-rose-400/30', bg: 'bg-rose-500/10', text: 'text-rose-200', soft: 'text-rose-300/70', glow: 'shadow-[0_0_24px_rgba(244,63,94,0.15)]' },
    violet: { border: 'border-violet-400/30', bg: 'bg-violet-500/10', text: 'text-violet-200', soft: 'text-violet-300/70', glow: 'shadow-[0_0_24px_rgba(139,92,246,0.15)]' },
  };
  return map[accent] ?? map.emerald;
}

export function FrontEndAgentPage() {
  const [taskType, setTaskType] = useState<FrontEndAgentTaskType>('api-adapter');
  const [requirement, setRequirement] = useState('');
  const [targetFramework, setTargetFramework] = useState(DEFAULT_TARGET_FRAMEWORK);
  const [styleGuidance, setStyleGuidance] = useState('遵循当前项目风格，优先使用 TypeScript、清晰状态和基础错误处理。');
  const [apiSpec, setApiSpec] = useState('');
  const [existingCode, setExistingCode] = useState('');
  const [errorLog, setErrorLog] = useState('');
  const [screenshotNotes, setScreenshotNotes] = useState('');
  const [screenshotImages, setScreenshotImages] = useState<ScreenshotAttachment[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [model, setModel] = useState<{ name?: string; platform?: string }>({});
  const [thinking, setThinking] = useState('');
  const [output, setOutput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [pdaModalOpen, setPdaModalOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeTask = getTaskDefinition(taskType);
  const activeAccent = accentClasses(activeTask.accent);
  const isStreaming = phase === 'streaming';

  const primaryContextValue = useMemo(() => {
    if (activeTask.primaryContextKey === 'apiSpec') return apiSpec;
    if (activeTask.primaryContextKey === 'existingCode') return existingCode;
    if (activeTask.primaryContextKey === 'errorLog') return errorLog;
    return screenshotNotes;
  }, [activeTask.primaryContextKey, apiSpec, existingCode, errorLog, screenshotNotes]);

  const setPrimaryContextValue = useCallback((value: string) => {
    if (activeTask.primaryContextKey === 'apiSpec') setApiSpec(value);
    else if (activeTask.primaryContextKey === 'existingCode') setExistingCode(value);
    else if (activeTask.primaryContextKey === 'errorLog') setErrorLog(value);
    else setScreenshotNotes(value);
  }, [activeTask.primaryContextKey]);

  const handleUploadTextFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const lower = file.name.toLowerCase();
    const supported = ['.txt', '.md', '.json', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.log'].some((ext) => lower.endsWith(ext));
    if (!supported) {
      toast.error('仅支持文本类文件：txt、md、json、ts、tsx、js、css、html、log');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('文件超过 2MB，请截取关键片段后再上传');
      return;
    }
    try {
      const text = await file.text();
      setPrimaryContextValue(primaryContextValue.trim() ? `${primaryContextValue}\n\n--- ${file.name} ---\n${text}` : text);
      toast.success(`已读入 ${file.name}`);
    } catch (err) {
      toast.error('文件读取失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, [primaryContextValue, setPrimaryContextValue]);

  const handleGenerate = useCallback(async () => {
    const hasScreenshots = screenshotImages.length > 0;
    if (!requirement.trim() && !(taskType === 'visual-diagnosis' && (hasScreenshots || screenshotNotes.trim()))) {
      toast.error(taskType === 'visual-diagnosis'
        ? '请填写问题描述，或至少粘贴一张截图并补充现象说明'
        : '请先填写需求或问题描述');
      return;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase('streaming');
    setPhaseMsg('连接中...');
    setOutput('');
    setThinking('');
    setErrorMsg(null);
    setModel({});

    const body: FrontEndAgentRequest = {
      taskType,
      requirement: requirement.trim(),
      targetFramework,
      styleGuidance: styleGuidance.trim() || undefined,
      apiSpec: apiSpec.trim() || undefined,
      existingCode: existingCode.trim() || undefined,
      errorLog: errorLog.trim() || undefined,
      screenshotNotes: screenshotNotes.trim() || undefined,
      screenshotImages: screenshotImages.length > 0
        ? screenshotImages.map((item) => item.dataUrl)
        : undefined,
    };

    const result = await connectSse({
      url: FRONT_END_AGENT_STREAM_URL,
      method: 'POST',
      body,
      signal: controller.signal,
      onEvent: (evt) => {
        const data = safeJson(evt.data);
        if (!data) return;
        if (evt.event === 'phase') {
          setPhaseMsg(typeof data.message === 'string' ? data.message : '');
        } else if (evt.event === 'model') {
          setModel({
            name: typeof data.model === 'string' ? data.model : undefined,
            platform: typeof data.platform === 'string' ? data.platform : undefined,
          });
        } else if (evt.event === 'thinking') {
          if (typeof data.text === 'string') setThinking((prev) => prev + data.text);
        } else if (evt.event === 'typing') {
          if (typeof data.text === 'string') setOutput((prev) => prev + data.text);
        } else if (evt.event === 'done') {
          setPhase('done');
          setPhaseMsg('完成');
        } else if (evt.event === 'error') {
          setPhase('error');
          setErrorMsg(typeof data.message === 'string' ? data.message : '生成失败');
        }
      },
    });

    if (!result.success && !controller.signal.aborted) {
      setPhase('error');
      setErrorMsg(result.errorMessage || '连接失败');
    }
  }, [apiSpec, errorLog, existingCode, requirement, screenshotImages, screenshotNotes, styleGuidance, targetFramework, taskType]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
    setPhase('idle');
    setPhaseMsg('已中止');
  }, []);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setRequirement('');
    setApiSpec('');
    setExistingCode('');
    setErrorLog('');
    setScreenshotNotes('');
    setScreenshotImages([]);
    setOutput('');
    setThinking('');
    setModel({});
    setPhase('idle');
    setPhaseMsg('');
    setErrorMsg(null);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!output.trim()) return;
    await navigator.clipboard.writeText(output);
    toast.success('已复制结果');
  }, [output]);

  const ActiveIcon = activeTask.icon;

  return (
    <div className="fea-page h-full min-h-0 flex flex-col overflow-hidden relative bg-[#080604]">
      <FrontEndCosmosBackground />

      <header className="relative shrink-0 px-6 pt-5 pb-3 fea-fade-up">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight fea-title-shimmer">前端搭档智能体</h1>
              <span className="fea-vintage-badge px-2 py-0.5 rounded-full border">WIP</span>
            </div>
            <p className="mt-1.5 text-sm fea-subtitle-warm italic">
              你的前端同事没有离去，只是变成了智能体。
            </p>
            <p className="mt-1 text-xs fea-subtitle-muted">
              把 API、报错、截图现象和页面需求变成可复制的前端交付方案。
            </p>
            <div className="fea-header-rule max-w-2xl" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
            {model.name ? (
              <span className="fea-chip px-2.5 py-1 rounded-lg">
                {model.name}{model.platform ? ` · ${model.platform}` : ''}
              </span>
            ) : (
              <span className="fea-subtitle-muted">等待选择任务并生成</span>
            )}
            {phaseMsg && (
              <span className="fea-chip px-2.5 py-1 rounded-lg">
                {phaseMsg}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {TASK_DEFINITIONS.map((task) => {
            const Icon = task.icon;
            const selected = task.key === taskType;
            const colors = accentClasses(task.accent);
            return (
              <button
                key={task.key}
                type="button"
                onClick={() => setTaskType(task.key)}
                className={`fea-task-pill inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-left ${
                  selected
                    ? `${colors.border} ${colors.bg} ${colors.text} ${colors.glow} fea-task-pill-active`
                    : 'fea-task-pill-idle'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${selected ? colors.text : 'text-white/45'}`} />
                <span className="text-xs font-medium">{task.shortTitle}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="relative flex-1 min-h-0 px-6 pb-5 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_280px] gap-4">
        <section className="fea-panel min-h-0 rounded-2xl border flex flex-col overflow-hidden fea-fade-up">
          <div className="fea-panel-header shrink-0 px-4 py-3 border-b flex items-center gap-2">
            <ActiveIcon className={`w-4 h-4 ${activeAccent.soft}`} />
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-white truncate">{activeTask.title}</h2>
              <p className="text-[11px] text-white/45">{activeTask.description}</p>
            </div>
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <label className="block">
              <span className="fea-section-label text-xs font-medium">需求或问题描述</span>
              <textarea
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                placeholder={activeTask.placeholder}
                className="fea-input mt-2 w-full min-h-[96px] rounded-xl border px-3 py-2 text-sm outline-none transition-colors duration-200"
              />
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="fea-section-label text-xs font-medium">目标技术栈</span>
                <select
                  value={targetFramework}
                  onChange={(e) => setTargetFramework(e.target.value)}
                  className="fea-input mt-2 w-full h-9 rounded-xl border px-3 text-sm outline-none"
                >
                  {FRAMEWORK_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="fea-section-label text-xs font-medium">样式 / 项目约束</span>
                <input
                  value={styleGuidance}
                  onChange={(e) => setStyleGuidance(e.target.value)}
                  className="fea-input mt-2 w-full h-9 rounded-xl border px-3 text-sm outline-none"
                  placeholder="例如：使用 Tailwind、不能新增依赖"
                />
              </label>
            </div>

            {activeTask.primaryContextKey === 'screenshotNotes' ? (
              <FrontEndScreenshotInput
                notes={screenshotNotes}
                onNotesChange={setScreenshotNotes}
                screenshots={screenshotImages}
                onScreenshotsChange={setScreenshotImages}
                placeholder={activeTask.contextPlaceholder}
              />
            ) : (
              <label className="block">
                <span className="fea-section-label text-xs font-medium">{activeTask.primaryContextLabel}</span>
                <textarea
                  value={primaryContextValue}
                  onChange={(e) => setPrimaryContextValue(e.target.value)}
                  placeholder={activeTask.contextPlaceholder}
                  className="fea-input mt-2 w-full min-h-[120px] rounded-xl border px-3 py-2 font-mono text-xs leading-5 outline-none transition-colors duration-200"
                />
              </label>
            )}

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.log"
              onChange={handleUploadTextFile}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="fea-btn h-8 px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs text-white/70 inline-flex items-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                上传文本
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="fea-btn h-8 px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-xs text-white/55 inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                清空
              </button>
            </div>
          </div>

          <div className="fea-panel-header shrink-0 p-4 border-t">
            {isStreaming ? (
              <button
                type="button"
                onClick={handleAbort}
                className="fea-btn fea-btn-danger w-full h-10 rounded-xl border border-rose-400/25 bg-rose-500/10 hover:bg-rose-500/15 text-sm text-rose-100 inline-flex items-center justify-center gap-2"
              >
                <StopCircle className="w-4 h-4" />
                中止
              </button>
            ) : (
              <button
                type="button"
                onClick={handleGenerate}
                className={`fea-btn fea-btn-primary w-full h-10 rounded-xl border text-sm inline-flex items-center justify-center gap-2 ${activeAccent.border} ${activeAccent.bg} ${activeAccent.text}`}
              >
                <Sparkles className="w-4 h-4" />
                生成前端方案
              </button>
            )}
          </div>
        </section>

        <section className="fea-panel min-h-0 rounded-2xl border flex flex-col overflow-hidden fea-fade-up">
          <div className="fea-panel-header shrink-0 px-4 py-3 border-b flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-white">输出结果</h2>
              <p className="text-[11px] text-white/45 truncate">
                {isStreaming ? '流式生成中' : output.trim() ? '可复制完整结果' : '等待生成'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!output.trim()}
              className="fea-btn h-8 px-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-xs text-white/65 inline-flex items-center gap-1.5"
            >
              <Clipboard className="w-3.5 h-3.5" />
              复制
            </button>
          </div>

          <div className="flex-1 min-h-0 p-4" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {errorMsg ? (
              <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-100 flex gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            ) : output.trim() ? (
              <div className="space-y-4">
                {thinking.trim() && isStreaming && (
                  <details className="rounded-xl border border-white/10 bg-white/[0.035] p-3 text-xs text-white/50">
                    <summary className="cursor-pointer text-white/65">模型思考过程</summary>
                    <pre className="mt-2 whitespace-pre-wrap font-mono leading-5">{thinking}</pre>
                  </details>
                )}
                <StreamingText
                  text={output}
                  streaming={isStreaming}
                  mode="blur"
                  className="font-mono text-sm leading-7 text-white/80 whitespace-pre-wrap break-words"
                />
              </div>
            ) : isStreaming ? (
              <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-white/55">
                <MapSpinner size={30} />
                <p className="mt-4 text-sm">{phaseMsg || 'AI 正在处理...'}</p>
              </div>
            ) : (
              <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center text-white/45 px-4">
                <Code2 className="w-10 h-10 mb-3 text-white/20" />
                <p className="text-sm text-white/65">选择任务类型并输入材料</p>
                <p className="mt-2 text-xs max-w-sm">建议提供接口 JSON、代码片段、报错日志或截图现象，结果会更具体。</p>
              </div>
            )}
          </div>

          {phase !== 'idle' && (
            <div className="fea-panel-header shrink-0 px-4 py-2 border-t text-[11px] fea-subtitle-muted flex items-center gap-2">
              <span>状态：{phase === 'streaming' ? '生成中' : phase === 'done' ? '完成' : phase === 'error' ? '失败' : '待输入'}</span>
              {phaseMsg && <span>· {phaseMsg}</span>}
            </div>
          )}
        </section>

        <aside className="min-h-0 flex flex-col gap-3 xl:max-h-full fea-fade-up">
          <div className="shrink-0">
            <p className="fea-section-label text-[10px] uppercase mb-2 px-0.5">前端资源</p>
            <div className="space-y-3">
              <FrontEndPdaRailCard onOpen={() => setPdaModalOpen(true)} />
              <FrontEndProjectRailCard onOpen={() => setProjectModalOpen(true)} />
            </div>
          </div>
          <div className="fea-aside-hint hidden xl:flex flex-1 min-h-0 rounded-2xl border border-dashed p-4 text-center items-center justify-center">
            <p className="text-[11px] leading-5">
              右侧快速入口：PDA 手册与前端项目表按需弹窗打开，主工作区专注 AI 生成。
            </p>
          </div>
        </aside>
      </div>

      <FrontEndProjectTableModal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} />
      <FrontEndPdaGuideModal open={pdaModalOpen} onClose={() => setPdaModalOpen(false)} />
    </div>
  );
}
