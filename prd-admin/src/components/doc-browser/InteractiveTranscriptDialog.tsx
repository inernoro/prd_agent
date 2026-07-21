import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, FileText, RefreshCw, X } from 'lucide-react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { listTranscribeStyles } from '@/services';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { AudioWavePlayer } from './AudioWavePlayer';
import {
  activeSegmentIndex,
  activeSummaryModuleIndex,
  estimateTranscriptSegments,
  extractTranscriptSummary,
  hasUsableTimestamps,
  parseSummaryModules,
  parseTranscriptSegments,
} from './transcriptSegments';

type ContentView = 'transcript' | 'summary';

let styleCache: { key: string; label: string; description: string }[] | null = null;

export function InteractiveTranscriptDialog({
  src,
  noteMd,
  styleKey = 'general',
  onClose,
  onRestyle,
}: {
  src: string;
  noteMd: string;
  /** 后端 TranscribeStyleRegistry 的 key；旧录音没有元数据时按默认 general 展示。 */
  styleKey?: string;
  onClose: () => void;
  onRestyle?: () => void;
}) {
  const isMobile = useIsMobile();
  const closeRef = useRef<HTMLButtonElement>(null);
  const seekRef = useRef<((sec: number) => void) | null>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const moduleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const manualUntilRef = useRef(0);

  const rawSegments = useMemo(() => parseTranscriptSegments(noteMd), [noteMd]);
  const precise = useMemo(() => hasUsableTimestamps(rawSegments), [rawSegments]);
  const summaryMd = useMemo(() => extractTranscriptSummary(noteMd), [noteMd]);
  const summaryModules = useMemo(() => parseSummaryModules(summaryMd), [summaryMd]);
  const [duration, setDuration] = useState(0);
  const estimatedSegments = useMemo(
    () => precise ? [] : estimateTranscriptSegments(rawSegments, duration),
    [duration, precise, rawSegments],
  );
  const displaySegments = precise ? rawSegments : estimatedSegments.length > 0 ? estimatedSegments : rawSegments;
  const syncMode = precise ? 'precise' : estimatedSegments.length > 0 ? 'estimated' : 'static';

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [view, setView] = useState<ContentView>('transcript');
  const [styles, setStyles] = useState(styleCache ?? []);
  const activeModuleIdx = activeSummaryModuleIndex(summaryModules.length, currentTime, duration);
  const styleLabel = styles.find(style => style.key === styleKey)?.label ?? '整理结果';

  const markManualScroll = () => { manualUntilRef.current = Date.now() + 3000; };

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
    if (displaySegments.length === 0 || displaySegments[0].start < 0) return;
    const next = activeSegmentIndex(displaySegments, time);
    setActiveIdx(previous => previous === next ? previous : next);
  }, [displaySegments]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const dialog = closeRef.current?.closest('[role="dialog"]');
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (styleCache) return;
    void listTranscribeStyles().then((response) => {
      if (!response.success) return;
      styleCache = response.data.items;
      setStyles(response.data.items);
    });
  }, []);

  useEffect(() => {
    if (Date.now() < manualUntilRef.current) return;
    const target = view === 'transcript' ? lineRefs.current[activeIdx] : moduleRefs.current[activeModuleIdx];
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [activeIdx, activeModuleIdx, view]);

  const seekToModule = (index: number) => {
    if (duration <= 0 || summaryModules.length === 0) return;
    seekRef.current?.((index / summaryModules.length) * duration);
  };

  const content = (
    <div
      className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="interactive-transcript-title"
        className={`flex w-full flex-col overflow-hidden ${isMobile ? '' : 'max-w-[920px] rounded-[22px]'}`}
        style={{
          height: isMobile ? '100dvh' : 'min(760px, calc(100dvh - 32px))',
          maxHeight: isMobile ? '100dvh' : 'calc(100dvh - 32px)',
          background: 'var(--bg-primary)',
          border: isMobile ? 'none' : '1px solid var(--border-subtle)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.45)',
        }}
      >
        <header
          className="flex flex-shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6"
          style={{
            borderBottom: '1px solid var(--border-faint)',
            paddingTop: isMobile ? 'max(12px, env(safe-area-inset-top))' : undefined,
          }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px]"
              style={{ background: 'rgba(168,85,247,0.12)', color: 'rgba(216,180,254,0.95)' }}
            >
              <AudioLines size={19} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="interactive-transcript-title" className="text-[14px] font-semibold text-token-primary">
                  交互式播放
                </h2>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(147,197,253,0.95)' }}
                >
                  测试版
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-token-muted">
                {playing ? '正在跟随播放' : '播放后，当前内容会自动居中高亮'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {onRestyle && (
              <button
                onClick={() => { onClose(); onRestyle(); }}
                className="flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-[12px] text-token-secondary transition-colors motion-reduce:transition-none hover:bg-white/6"
                title="使用系统中的其他整理方式重新生成"
              >
                <RefreshCw size={14} />
                <span className="hidden sm:inline">换个整理方式</span>
              </button>
            )}
            <button
              ref={closeRef}
              onClick={onClose}
              className="flex h-11 w-11 items-center justify-center rounded-[10px] text-token-secondary transition-colors motion-reduce:transition-none hover:bg-white/6"
              title="关闭交互式播放"
              aria-label="关闭交互式播放"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-shrink-0 px-3 pt-3 sm:px-6 sm:pt-5">
            <AudioWavePlayer
              src={src}
              className="mx-auto"
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={setDuration}
              onPlaybackChange={setPlaying}
              registerSeek={(seek) => { seekRef.current = seek; }}
            />

            <div className="mx-auto mt-3 flex max-w-[760px] items-center gap-1 overflow-x-auto rounded-[12px] p-1"
              style={{ background: 'var(--bg-nested)' }}>
              <button
                onClick={() => setView('transcript')}
                className="flex min-h-11 flex-shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold transition-colors motion-reduce:transition-none"
                style={{
                  background: view === 'transcript' ? 'var(--bg-elevated)' : 'transparent',
                  color: view === 'transcript' ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: view === 'transcript' ? '0 2px 8px rgba(0,0,0,0.18)' : 'none',
                }}
              >
                <AudioLines size={14} /> 原文跟读
              </button>
              {summaryModules.length > 0 && (
                <button
                  onClick={() => setView('summary')}
                  className="flex min-h-11 flex-shrink-0 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold transition-colors motion-reduce:transition-none"
                  style={{
                    background: view === 'summary' ? 'var(--bg-elevated)' : 'transparent',
                    color: view === 'summary' ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: view === 'summary' ? '0 2px 8px rgba(0,0,0,0.18)' : 'none',
                  }}
                >
                  <FileText size={14} /> {styleLabel}
                </button>
              )}
              <span className="ml-auto flex-shrink-0 px-2 text-[10px] text-token-muted">
                {view === 'summary'
                  ? '顺序映射（测试）'
                  : syncMode === 'precise' ? '精准同步' : syncMode === 'estimated' ? '智能估算' : '等待音频时长'}
              </span>
            </div>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-5"
            style={view === 'transcript' ? {
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 14%, black 86%, transparent 100%)',
              maskImage: 'linear-gradient(to bottom, transparent 0, black 14%, black 86%, transparent 100%)',
            } : undefined}
            onWheel={markManualScroll}
            onTouchMove={markManualScroll}
          >
            {view === 'transcript' ? (
              <div
                className="mx-auto flex min-h-full max-w-[760px] flex-col items-center justify-center gap-2 py-[25vh]"
              >
                {displaySegments.map((segment, index) => {
                  const active = index === activeIdx && syncMode !== 'static';
                  const distance = Math.abs(index - activeIdx);
                  return (
                    <button
                      key={`${index}-${segment.text.slice(0, 18)}`}
                      ref={(element) => { lineRefs.current[index] = element; }}
                      onClick={() => { if (segment.start >= 0) seekRef.current?.(segment.start); }}
                      className="min-h-11 w-full rounded-[12px] px-4 py-2.5 text-center leading-relaxed transition-all duration-200 motion-reduce:transition-none"
                      style={{
                        color: active ? 'var(--text-primary)' : `rgba(148,163,184,${Math.max(0.28, 0.72 - distance * 0.13)})`,
                        background: active ? 'rgba(168,85,247,0.12)' : 'transparent',
                        border: active ? '1px solid rgba(168,85,247,0.18)' : '1px solid transparent',
                        fontSize: active ? 18 : 14,
                        fontWeight: active ? 650 : 400,
                        transform: active ? 'scale(1.015)' : 'scale(1)',
                      }}
                      aria-current={active ? 'true' : undefined}
                      title={segment.start >= 0 ? '点击从这句话开始播放' : undefined}
                    >
                      {segment.text}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mx-auto flex min-h-full max-w-[760px] flex-col justify-center gap-3 py-[18vh]">
                {summaryModules.map((module, index) => {
                  const active = index === activeModuleIdx;
                  return (
                    <section
                      key={`${index}-${module.title}`}
                      className="w-full rounded-[14px] p-4 text-left transition-all duration-200 motion-reduce:transition-none"
                      style={{
                        background: active ? 'rgba(59,130,246,0.10)' : 'var(--bg-nested)',
                        border: active ? '1px solid rgba(96,165,250,0.30)' : '1px solid var(--border-faint)',
                        opacity: active ? 1 : 0.55,
                        transform: active ? 'scale(1.01)' : 'scale(1)',
                      }}
                    >
                      <button
                        ref={(element) => { moduleRefs.current[index] = element; }}
                        onClick={() => seekToModule(index)}
                        className="mb-2 flex min-h-11 w-full items-center rounded-[9px] text-left text-[12px] font-semibold text-token-muted"
                        aria-current={active ? 'true' : undefined}
                        title="从这个模块对应的估算位置播放"
                      >
                        {module.title}
                      </button>
                      <MarkdownViewer content={module.markdown} />
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          <footer
            className="flex-shrink-0 px-4 py-2.5 text-center text-[10px] leading-relaxed text-token-muted sm:px-6"
            style={{
              borderTop: '1px solid var(--border-faint)',
              paddingBottom: isMobile ? 'max(10px, env(safe-area-inset-bottom))' : undefined,
            }}
          >
            {view === 'summary'
              ? '整理模块按内容顺序与播放进度估算高亮，不代表逐句精确对齐。'
              : syncMode === 'precise'
                ? '时间来自转写模型；点击任意一句可跳到对应位置。'
                : '当前转写模型未返回逐句时间戳；高亮按句子长度与音频时长估算。'}
          </footer>
        </div>
      </section>
    </div>
  );

  return createPortal(content, document.body);
}
