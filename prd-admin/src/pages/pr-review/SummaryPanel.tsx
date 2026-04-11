import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollText,
  Loader2,
  Wand2,
  AlertTriangle,
  RefreshCw,
  Clock,
  Layers,
  ListChecks,
  Telescope,
} from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { getPrReviewSummaryStreamUrl, type PrSummaryReportDto } from '@/services/real/prReview';
import { usePrReviewStore } from './usePrReviewStore';

interface Props {
  itemId: string;
  cached?: PrSummaryReportDto | null;
}

/**
 * 档 1：AI 变更摘要面板。
 *
 * 30 秒看懂一个 PR 在做什么。对应后端 PrSummaryService，输出严格章节：
 *   ## 一句话
 *   ## 关键改动
 *   ## 主要影响
 *   ## 审查建议
 *
 * 与 AlignmentPanel 共享相同的 SSE 生命周期（useSseStream + phase/typing/result/error）。
 */
export function SummaryPanel({ itemId, cached }: Props) {
  const setSummaryReport = usePrReviewStore((s) => s.setSummaryReport);
  const [localResult, setLocalResult] = useState<PrSummaryReportDto | null>(cached ?? null);
  const [finalError, setFinalError] = useState<string | null>(null);
  const fullMdRef = useRef('');

  useEffect(() => {
    setLocalResult(cached ?? null);
  }, [cached]);

  const handleResult = useCallback(
    (data: unknown) => {
      const d = data as { headline?: string | null; markdown?: string };
      if (typeof d.markdown !== 'string') return;
      const report: PrSummaryReportDto = {
        headline: d.headline ?? null,
        markdown: d.markdown,
        durationMs: 0,
        createdAt: new Date().toISOString(),
      };
      setLocalResult(report);
      setSummaryReport(itemId, report);
    },
    [itemId, setSummaryReport],
  );

  const sse = useSseStream({
    url: '',
    onEvent: {
      result: handleResult,
    },
    onTyping: (text) => {
      fullMdRef.current += text;
    },
    onError: (msg) => {
      setFinalError(msg);
    },
  });

  const handleStart = useCallback(() => {
    setFinalError(null);
    fullMdRef.current = '';
    sse.reset();
    void sse.start({ url: getPrReviewSummaryStreamUrl(itemId) });
  }, [itemId, sse]);

  useEffect(() => {
    return () => {
      sse.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = sse.isStreaming || sse.phase === 'connecting';

  // ========== 空态 ==========
  if (!localResult && !isRunning && !finalError) {
    return (
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-sky-500/15 flex items-center justify-center shrink-0">
            <ScrollText size={18} className="text-sky-300" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-white">AI 变更摘要</div>
            <div className="text-xs text-white/50 mt-0.5 leading-relaxed">
              让 AI 用 30 秒帮你读完这个 PR：一句话说明意图、关键改动要点、主要影响面、审查建议。
            </div>
            <button
              type="button"
              onClick={handleStart}
              className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-500 text-white text-xs font-semibold hover:bg-sky-400 transition"
            >
              <Wand2 size={14} />
              生成摘要
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========== 运行中 ==========
  if (isRunning) {
    const phaseText = sse.phaseMessage || '正在准备...';
    const preview = sse.typing.slice(-600);
    return (
      <div className="rounded-lg border border-sky-500/30 bg-sky-500/[0.06] p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-sky-200">
          <Loader2 size={16} className="animate-spin" />
          <span className="font-semibold">{phaseText}</span>
        </div>
        {preview && (
          <pre className="text-[11px] text-white/60 font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto bg-black/30 rounded p-3 border border-white/5">
            {preview}
            <span className="inline-block w-1 h-3 bg-sky-400 animate-pulse ml-0.5" />
          </pre>
        )}
        <button
          type="button"
          onClick={() => sse.abort()}
          className="text-xs text-white/50 hover:text-white/80 transition"
        >
          中止
        </button>
      </div>
    );
  }

  // ========== 错误 ==========
  if (finalError && !localResult) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 space-y-3">
        <div className="flex items-start gap-2 text-red-200 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">AI 摘要生成失败</div>
            <div className="text-red-200/80 text-xs mt-0.5">{finalError}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleStart}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 transition"
        >
          <RefreshCw size={12} />
          重新生成
        </button>
      </div>
    );
  }

  // ========== 结果 ==========
  if (localResult) {
    return <SummaryResult report={localResult} onRerun={handleStart} error={finalError} />;
  }

  return null;
}

// ============================================================
// 结果渲染
// ============================================================

interface ResultProps {
  report: PrSummaryReportDto;
  onRerun: () => void;
  error?: string | null;
}

function SummaryResult({ report, onRerun, error }: ResultProps) {
  const sections = useMemo(() => parseSections(report.markdown), [report.markdown]);

  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] p-4 space-y-4">
      {/* 头部：一句话摘要 + 重跑按钮 */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-sky-500/15 flex items-center justify-center">
          <ScrollText size={18} className="text-sky-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-white/50">
            <Wand2 size={12} />
            <span>AI 变更摘要</span>
            {report.durationMs > 0 && (
              <>
                <span>·</span>
                <Clock size={12} />
                <span>{(report.durationMs / 1000).toFixed(1)}s</span>
              </>
            )}
          </div>
          {(sections.oneLiner || report.headline) && (
            <div className="mt-1.5 text-sm text-white font-medium leading-snug">
              {sections.oneLiner || report.headline}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRerun}
          title="重新生成"
          className="shrink-0 p-2 rounded-lg bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {error && (
        <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          上次重跑出现问题：{error}。展示的是之前缓存的结果。
        </div>
      )}

      {/* 关键改动 */}
      {sections.keyChanges.length > 0 && (
        <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-200 mb-2">
            <ListChecks size={14} />
            <span>关键改动</span>
            <span className="text-[10px] opacity-60">· {sections.keyChanges.length}</span>
          </div>
          <ul className="space-y-1.5 text-xs text-white/80">
            {sections.keyChanges.map((it, i) => (
              <li key={i} className="leading-relaxed">
                <span className="text-white/30 mr-1">•</span>
                {it}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 主要影响 */}
      {sections.impact && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-white/70 mb-1.5">
            <Layers size={14} />
            <span>主要影响</span>
          </div>
          <div className="text-xs text-white/70 leading-relaxed">{sections.impact}</div>
        </div>
      )}

      {/* 审查建议 */}
      {sections.reviewAdvice && (
        <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-200 mb-1.5">
            <Telescope size={14} />
            <span>审查建议</span>
          </div>
          <div className="text-xs text-white/80 leading-relaxed">{sections.reviewAdvice}</div>
        </div>
      )}

      {/* 原始 markdown 折叠 */}
      <details className="text-xs">
        <summary className="text-white/40 hover:text-white/60 cursor-pointer select-none">
          查看原始 Markdown
        </summary>
        <pre className="mt-2 bg-black/30 border border-white/5 rounded p-3 text-[11px] text-white/70 whitespace-pre-wrap break-words font-mono max-h-72 overflow-auto">
          {report.markdown}
        </pre>
      </details>
    </div>
  );
}

// ============================================================
// Markdown 章节解析
// ============================================================

interface ParsedSections {
  oneLiner: string | null;
  keyChanges: string[];
  impact: string | null;
  reviewAdvice: string | null;
}

function parseSections(markdown: string): ParsedSections {
  return {
    oneLiner: extractParagraph(markdown, /##\s*一句话/),
    keyChanges: extractBullets(markdown, /##\s*关键改动/),
    impact: extractParagraph(markdown, /##\s*主要影响/),
    reviewAdvice: extractParagraph(markdown, /##\s*审查建议/),
  };
}

function extractBullets(markdown: string, headingRegex: RegExp): string[] {
  const section = sliceSection(markdown, headingRegex);
  if (!section) return [];
  const lines = section.split('\n');
  const bullets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:[-*]|\d+\.)\s*(.+)$/);
    if (m) {
      bullets.push(m[1].trim());
    }
  }
  if (bullets.length === 1 && bullets[0] === '无') return [];
  return bullets;
}

function extractParagraph(markdown: string, headingRegex: RegExp): string | null {
  const section = sliceSection(markdown, headingRegex);
  if (!section) return null;
  const text = section.trim();
  return text.length > 0 ? text : null;
}

function sliceSection(markdown: string, headingRegex: RegExp): string | null {
  const match = markdown.match(headingRegex);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = rest.search(/\n##\s/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
