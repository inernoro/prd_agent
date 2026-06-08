import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Play,
  Globe,
  X,
  ChevronDown,
  Upload,
  Wand2,
  Zap,
  Bot,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  type MdToPptDiagEvent,
  type MdToPptEngine,
  streamMdToPptConvert,
  streamMdToPptPatch,
  publishMdToPpt,
} from '@/services/real/mdToPptService';

// ─── Types ───────────────────────────────────────────────────────────────────

type InputTab = 'text' | 'file';
type GenPhase = 'idle' | 'streaming' | 'done' | 'error' | 'patching';

// 生成阶段提示文案（按已等待秒数滚动），保证屏幕在等待时持续有变化（CLAUDE §6 / 2 秒定理）。
function genStageMsg(sec: number, isPatch: boolean): string {
  if (isPatch) return sec < 8 ? '正在理解修改指令…' : sec < 25 ? '正在重排指定页面…' : '正在收尾排版…';
  if (sec < 5) return '正在分析内容结构…';
  if (sec < 18) return '正在设计版式与配色…';
  if (sec < 38) return '正在逐页生成幻灯片…';
  if (sec < 60) return '正在排版与收尾…';
  return '内容较多，正在精修中（大模型生成约需 1 分钟）…';
}

// 校验返回的是不是一份真正的网页 PPT，而不是本应用外壳/空内容/异常返回。
// 防『预览里递归显示整个 MAP 应用』『后端重启返回 SPA index.html』等异常被当成结果渲染。
function looksLikeDeck(html: string): boolean {
  if (!html || html.length < 200) return false;
  const low = html.toLowerCase();
  if (!low.includes('<!doctype html') && !low.includes('<html')) return false;
  if (low.includes('id="root"')) return false; // SPA index.html 特征，绝不是 PPT
  return low.includes('reveal') || low.includes('<section');
}

const THEME_OPTIONS = [
  { value: 'dark-glass', label: '深色玻璃' },
  { value: 'light-clean', label: '浅色简洁' },
  { value: 'gradient-purple', label: '紫色渐变' },
  { value: 'corporate-blue', label: '商务蓝' },
  { value: 'warm-earth', label: '暖色大地' },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export function MdToPptAgentPage() {
  // Input state
  const [tab, setTab] = useState<InputTab>('text');
  const [textContent, setTextContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [theme, setTheme] = useState('dark-glass');
  const [slideCount, setSlideCount] = useState<number | undefined>(undefined);

  // Engine toggle
  const [engine, setEngine] = useState<MdToPptEngine>('map');

  // Generation state
  const [phase, setPhase] = useState<GenPhase>('idle');
  const [streamBuffer, setStreamBuffer] = useState('');
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [modelInfo, setModelInfo] = useState<{ model: string; platform: string } | null>(null);

  // Diag log (agent engine only)
  const [diagLines, setDiagLines] = useState<MdToPptDiagEvent[]>([]);

  // 等待计时（秒）—— 用于生成期间的进度反馈，避免静止空白（CLAUDE §6）
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (phase !== 'streaming' && phase !== 'patching') {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(0);
    const t = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  // Patch state
  const [patchRequest, setPatchRequest] = useState('');
  const [patchSlideIndex, setPatchSlideIndex] = useState<number | undefined>(undefined);
  const [isPatchPanelOpen, setIsPatchPanelOpen] = useState(false);

  // Publish state
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState('');

  // Refs
  const cleanupRef = useRef<(() => void) | null>(null);
  const streamDivRef = useRef<HTMLDivElement>(null);
  const diagDivRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll streaming area
  useEffect(() => {
    if (phase === 'streaming' && streamDivRef.current) {
      streamDivRef.current.scrollTop = streamDivRef.current.scrollHeight;
    }
  }, [streamBuffer, phase]);

  // Auto-scroll diag area
  useEffect(() => {
    if (diagDivRef.current && diagLines.length > 0) {
      diagDivRef.current.scrollTop = diagDivRef.current.scrollHeight;
    }
  }, [diagLines]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);
      const text = await file.text();
      setTextContent(text);
    },
    []
  );

  const handleGenerate = useCallback(() => {
    const content = textContent.trim();
    if (!content) return;

    cleanupRef.current?.();
    setPhase('streaming');
    setStreamBuffer('');
    setGeneratedHtml('');
    setErrorMsg('');
    setModelInfo(null);
    setDiagLines([]);
    setPublishedUrl('');
    setIsPatchPanelOpen(false);

    const cleanup = streamMdToPptConvert({
      content,
      theme,
      slideCount,
      engine,
      onStart: () => {
        // Phase already set to streaming above
      },
      onModel: (info) => {
        setModelInfo(info);
      },
      onDiag: (data) => {
        setDiagLines((prev) => [...prev, data]);
      },
      onDelta: (text) => {
        setStreamBuffer((prev) => prev + text);
      },
      onDone: (result) => {
        const html = String((result as { html?: unknown }).html ?? '');
        if (!looksLikeDeck(html)) {
          setErrorMsg('生成结果异常：未得到有效的网页 PPT（可能后端在重启或返回了非预期内容），请重试。');
          setPhase('error');
          return;
        }
        setGeneratedHtml(html);
        setPhase('done');
      },
      onError: (msg) => {
        setErrorMsg(msg);
        setPhase('error');
      },
    });

    cleanupRef.current = cleanup;
  }, [textContent, theme, slideCount, engine]);

  const handleAbort = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setPhase('idle');
  }, []);

  const handlePatch = useCallback(() => {
    if (!patchRequest.trim() || !generatedHtml) return;

    cleanupRef.current?.();
    setPhase('patching');
    setModelInfo(null);
    setDiagLines([]);

    const cleanup = streamMdToPptPatch({
      currentHtml: generatedHtml,
      slideRequest: patchRequest.trim(),
      slideIndex: patchSlideIndex,
      engine,
      onStart: () => {
        setStreamBuffer('');
      },
      onModel: (info) => {
        setModelInfo(info);
      },
      onDiag: (data) => {
        setDiagLines((prev) => [...prev, data]);
      },
      onDelta: (text) => {
        setStreamBuffer((prev) => prev + text);
      },
      onDone: (result) => {
        const html = String((result as { html?: unknown }).html ?? '');
        if (!looksLikeDeck(html)) {
          setErrorMsg('修改结果异常：未得到有效的网页 PPT，请重试。');
          setPhase('error');
          return;
        }
        setGeneratedHtml(html);
        setPhase('done');
        setPatchRequest('');
      },
      onError: (msg) => {
        setErrorMsg(msg);
        setPhase('error');
      },
    });

    cleanupRef.current = cleanup;
  }, [patchRequest, patchSlideIndex, generatedHtml, engine]);

  const handlePublish = useCallback(async () => {
    if (!generatedHtml) return;
    setIsPublishing(true);
    const result = await publishMdToPpt({
      htmlContent: generatedHtml,
      title: fileName ? fileName.replace(/\.[^.]+$/, '') : 'PPT 演示',
    });
    setIsPublishing(false);
    if (result.success && result.siteUrl) {
      setPublishedUrl(result.siteUrl);
    } else {
      setErrorMsg(result.error ?? '发布失败');
    }
  }, [generatedHtml, fileName]);

  // ─── Derived ────────────────────────────────────────────────────────────────

  const isStreaming = phase === 'streaming' || phase === 'patching';
  const hasDone = phase === 'done';
  const hasContent = textContent.trim().length > 0;
  // 是否有诊断事件需要显示（agent 路径）
  const hasDiag = engine === 'agent' && diagLines.length > 0;

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-white/8">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-purple-500/15 flex items-center justify-center">
            <FileText size={15} className="text-purple-400" />
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Markdown / 文件 转网页 PPT
          </span>
          {modelInfo && (
            <span className="text-[11px] text-[var(--text-tertiary)] font-mono ml-2">
              {modelInfo.model} · {modelInfo.platform}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 引擎切换开关 */}
          <div className="flex items-center rounded-md border border-white/10 overflow-hidden text-[11px]">
            <button
              onClick={() => setEngine('map')}
              className={[
                'flex items-center gap-1 px-2.5 py-1 transition-colors',
                engine === 'map'
                  ? 'bg-purple-500/20 text-purple-300'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
              ].join(' ')}
              title="MAP 直调：速度快、稳定，适合日常使用"
            >
              <Zap size={10} />
              MAP 直调
            </button>
            <button
              onClick={() => setEngine('agent')}
              className={[
                'flex items-center gap-1 px-2.5 py-1 border-l border-white/10 transition-colors',
                engine === 'agent'
                  ? 'bg-blue-500/20 text-blue-300'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
              ].join(' ')}
              title="CDS Agent：可观测诊断，显示实时 diag 事件"
            >
              <Bot size={10} />
              CDS Agent
            </button>
          </div>

          {isStreaming && (
            <button
              onClick={handleAbort}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20"
            >
              <X size={12} />
              中止
            </button>
          )}
          {hasDone && (
            <button
              onClick={handlePublish}
              disabled={isPublishing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/20 border border-blue-500/25 disabled:opacity-50"
            >
              {isPublishing ? <MapSpinner size={12} /> : <Globe size={12} />}
              {isPublishing ? '发布中…' : '发布为网页'}
            </button>
          )}
        </div>
      </div>

      {/* Published URL banner */}
      {publishedUrl && (
        <div className="shrink-0 flex items-center gap-2 px-5 py-2 bg-green-500/8 border-b border-green-500/15 text-xs text-green-400">
          <Globe size={13} />
          <span>已发布：</span>
          <a
            href={publishedUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-green-300"
          >
            {publishedUrl}
          </a>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel – Input */}
        <div
          className="w-80 shrink-0 flex flex-col border-r border-white/8"
          style={{ minHeight: 0 }}
        >
          {/* Tab bar */}
          <div className="shrink-0 flex border-b border-white/8">
            {(['text', 'file'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  'flex-1 py-2 text-xs font-medium transition-colors',
                  tab === t
                    ? 'text-[var(--text-primary)] border-b-2 border-purple-400'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                {t === 'text' ? '粘贴文本' : '上传文件'}
              </button>
            ))}
          </div>

          {/* Content input area */}
          <div
            className="flex-1 p-3"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {tab === 'text' ? (
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder={
                  '粘贴 Markdown 内容或任意文字，AI 将自动生成完整网页 PPT...\n\n例：\n# 产品发布计划\n\n## 现状分析\n- 当前市场占有率 15%\n- 竞品分析三大痛点\n\n## 解决方案\n...'
                }
                className="w-full h-full resize-none bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none font-mono leading-relaxed"
                style={{ minHeight: '200px' }}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center gap-2 p-6 rounded-lg border-2 border-dashed border-white/10 hover:border-white/20 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  <Upload size={20} />
                  <span className="text-xs text-center">
                    点击上传 Markdown / TXT 文件
                    <br />
                    <span className="text-[10px] opacity-60">支持 .md .txt .markdown</span>
                  </span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt,.markdown"
                  onChange={handleFileChange}
                  className="hidden"
                />
                {fileName && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white/4 text-xs text-[var(--text-secondary)]">
                    <FileText size={12} className="shrink-0 text-purple-400" />
                    <span className="truncate">{fileName}</span>
                  </div>
                )}
                {textContent && (
                  <div className="text-[10px] text-[var(--text-tertiary)]">
                    已读取 {textContent.length.toLocaleString()} 字符
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Options */}
          <div className="shrink-0 border-t border-white/8 p-3 flex flex-col gap-2">
            {/* Theme selector */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-[var(--text-tertiary)] w-10 shrink-0">
                主题
              </label>
              <div className="relative flex-1">
                <select
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                  className="w-full appearance-none text-xs py-1.5 pl-2.5 pr-7 rounded-md bg-white/5 text-[var(--text-primary)] border border-white/8 outline-none cursor-pointer hover:border-white/16"
                >
                  {THEME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={11}
                  className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]"
                />
              </div>
            </div>

            {/* Slide count */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-[var(--text-tertiary)] w-10 shrink-0">
                页数
              </label>
              <input
                type="number"
                min={3}
                max={30}
                placeholder="自动"
                value={slideCount ?? ''}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  setSlideCount(isNaN(v) ? undefined : v);
                }}
                className="flex-1 text-xs py-1.5 px-2.5 rounded-md bg-white/5 text-[var(--text-primary)] border border-white/8 outline-none focus:border-purple-500/40"
              />
            </div>

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={!hasContent || isStreaming}
              className={[
                'w-full flex items-center justify-center gap-2 py-2 rounded-md text-xs font-semibold transition-all',
                !hasContent || isStreaming
                  ? 'bg-white/5 text-[var(--text-tertiary)] cursor-not-allowed'
                  : 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/25',
              ].join(' ')}
            >
              {isStreaming ? (
                <>
                  <MapSpinner size={12} />
                  {phase === 'patching' ? '修改中…' : '生成中…'}
                </>
              ) : (
                <>
                  <Play size={12} />
                  生成 PPT
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right panel – Preview */}
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 0 }}>
          {/* Idle state */}
          {phase === 'idle' && !generatedHtml && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
              <div className="w-12 h-12 rounded-2xl bg-purple-500/10 flex items-center justify-center">
                <Wand2 size={22} className="text-purple-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--text-secondary)]">
                  在左侧粘贴内容，点击「生成 PPT」
                </p>
                <p className="text-xs mt-1">
                  AI 将直接生成完整 reveal.js 网页 PPT，支持多种版式和富视觉设计
                </p>
                <p className="text-[10px] mt-2 text-[var(--text-tertiary)]">
                  当前引擎：{engine === 'map' ? 'MAP 直调（快速）' : 'CDS Agent（可观测，右上角可切换）'}
                </p>
              </div>
            </div>
          )}

          {/* Streaming view */}
          {(phase === 'streaming' || phase === 'patching') && (
            <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
              {/* Diag panel — agent 路径显示 */}
              {hasDiag && (
                <div
                  ref={diagDivRef}
                  className="shrink-0 border-b border-white/8 bg-[var(--bg-elevated)]"
                  style={{
                    maxHeight: '180px',
                    overflowY: 'auto',
                    overscrollBehavior: 'contain',
                  }}
                >
                  <div className="px-3 py-1.5 text-[10px] text-[var(--text-tertiary)] font-semibold border-b border-white/5 flex items-center gap-1">
                    <Bot size={10} />
                    Agent 实时诊断
                  </div>
                  {diagLines.map((d, i) => (
                    <div
                      key={i}
                      className={[
                        'px-3 py-1 text-[10px] font-mono border-b border-white/4',
                        d.stage === 'tool_call' || d.stage === 'tool_loop_alarm'
                          ? 'text-orange-400 bg-orange-500/5'
                          : d.stage === 'first_text_delta'
                          ? 'text-green-400'
                          : d.stage === 'done'
                          ? 'text-blue-400'
                          : d.stage === 'timeout'
                          ? 'text-red-400'
                          : 'text-[var(--text-secondary)]',
                      ].join(' ')}
                    >
                      <span className="text-[var(--text-tertiary)] mr-1.5">[{d.stage}]</span>
                      {d.elapsedMs !== undefined && (
                        <span className="text-[var(--text-tertiary)] mr-1.5">
                          +{d.elapsedMs}ms
                        </span>
                      )}
                      {d.warning
                        ? String(d.warning)
                        : d.message
                        ? String(d.message)
                        : d.tool
                        ? `tool=${d.tool} totalCalls=${d.totalToolCalls}`
                        : d.status
                        ? String(d.status)
                        : d.model
                        ? `${d.model}`
                        : ''}
                    </div>
                  ))}
                </div>
              )}

              {/* Stream output */}
              <div
                ref={streamDivRef}
                className="flex-1 p-4 font-mono text-[11px] leading-relaxed text-green-300/80 bg-[var(--bg-base)]"
                style={{
                  minHeight: 0,
                  overflowY: 'auto',
                  overscrollBehavior: 'contain',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                <div className="text-[10px] text-[var(--text-tertiary)] mb-2 font-sans flex items-center gap-2">
                  <span>{phase === 'patching' ? '正在修改指定页面…' : '正在生成 HTML PPT…'}</span>
                  {engine === 'agent' && (
                    <span className="text-blue-400/70">（CDS Agent 路径）</span>
                  )}
                  <span className="ml-auto tabular-nums text-[var(--text-secondary)]">{elapsedSec}s</span>
                </div>
                {/* 持续变化的阶段提示 + 品牌 spinner，避免空白等待（CLAUDE §6） */}
                <div className="mb-3 flex items-center gap-2 text-[11px] text-[var(--text-secondary)] font-sans">
                  <MapSpinner size={12} />
                  <span>{genStageMsg(elapsedSec, phase === 'patching')}</span>
                </div>
                {streamBuffer}
                <span className="inline-block w-1 h-3 bg-green-400 animate-pulse ml-0.5" />
              </div>
            </div>
          )}

          {/* Error state */}
          {phase === 'error' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
              <div className="text-sm font-medium text-red-400">生成失败</div>
              <div className="text-xs text-[var(--text-tertiary)] text-center max-w-xs">
                {errorMsg}
              </div>
              {/* 错误时显示诊断 */}
              {diagLines.length > 0 && (
                <div className="w-full max-w-sm mt-2 rounded-md bg-white/3 border border-white/8 overflow-hidden">
                  <div className="px-3 py-1.5 text-[10px] text-[var(--text-tertiary)] font-semibold border-b border-white/5">
                    诊断日志
                  </div>
                  <div
                    style={{ maxHeight: '120px', overflowY: 'auto', overscrollBehavior: 'contain' }}
                  >
                    {diagLines.map((d, i) => (
                      <div
                        key={i}
                        className={[
                          'px-3 py-0.5 text-[10px] font-mono',
                          d.stage === 'tool_call' || d.stage === 'tool_loop_alarm'
                            ? 'text-orange-400'
                            : d.stage === 'timeout'
                            ? 'text-red-400'
                            : 'text-[var(--text-secondary)]',
                        ].join(' ')}
                      >
                        [{d.stage}]{' '}
                        {d.message ? String(d.message) : d.warning ? String(d.warning) : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={handleGenerate}
                disabled={!hasContent}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-white/5 text-[var(--text-secondary)] hover:bg-white/8 border border-white/10"
              >
                <Play size={11} />
                重试
              </button>
            </div>
          )}

          {/* Done – iframe preview */}
          {phase === 'done' && generatedHtml && (
            <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
              {/* Patch panel toggle */}
              <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/8">
                <span className="text-xs text-[var(--text-tertiary)]">
                  {generatedHtml.length.toLocaleString()} 字符 HTML
                </span>
                <button
                  onClick={() => setIsPatchPanelOpen((v) => !v)}
                  className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                >
                  <Wand2 size={11} />
                  局部修改
                  <ChevronDown
                    size={11}
                    className={`transition-transform ${isPatchPanelOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              </div>

              {/* Patch input */}
              {isPatchPanelOpen && (
                <div className="shrink-0 flex items-start gap-2 px-4 py-3 border-b border-white/8 bg-white/2">
                  <div className="flex flex-col gap-1.5 flex-1">
                    <textarea
                      value={patchRequest}
                      onChange={(e) => setPatchRequest(e.target.value)}
                      placeholder="描述你想修改的内容，例如：把第 3 页的标题改为「市场策略」，并添加三个竞争优势要点"
                      rows={2}
                      className="w-full resize-none text-xs bg-white/4 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none border border-white/8 rounded-md px-2.5 py-2 focus:border-purple-500/40"
                    />
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-[var(--text-tertiary)]">
                        指定第几页（留空=全文）：
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="自动"
                        value={patchSlideIndex ?? ''}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          setPatchSlideIndex(isNaN(v) ? undefined : v);
                        }}
                        className="w-16 text-xs py-1 px-2 rounded-md bg-white/4 text-[var(--text-primary)] border border-white/8 outline-none focus:border-purple-500/40"
                      />
                    </div>
                  </div>
                  <button
                    onClick={handlePatch}
                    disabled={!patchRequest.trim() || isStreaming}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-purple-500/15 text-purple-300 hover:bg-purple-500/20 border border-purple-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isStreaming ? <MapSpinner size={11} /> : <Wand2 size={11} />}
                    修改
                  </button>
                </div>
              )}

              {/* Iframe —— 关键：不要 allow-same-origin。否则生成的 HTML 跑在本应用
                  同源里，reveal.js 的 history/hash 操作或任何相对跳转会把 iframe 导航到
                  本应用 `/`，预览里就会递归显示整个 MAP 应用而不是幻灯。allow-scripts
                  让 reveal.js（CDN 绝对地址）正常跑，但拿到的是不透明源，无法跳回本应用。 */}
              <iframe
                className="flex-1 w-full border-0"
                srcDoc={generatedHtml}
                sandbox="allow-scripts"
                title="PPT 预览"
                style={{ minHeight: 0 }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MdToPptAgentPage;
