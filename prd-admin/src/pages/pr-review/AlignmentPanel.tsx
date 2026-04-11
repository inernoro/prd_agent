import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Loader2,
  Wand2,
  AlertTriangle,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  TriangleAlert,
} from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { getPrReviewAlignmentStreamUrl, type PrAlignmentReportDto } from '@/services/real/prReview';
import { usePrReviewStore } from './usePrReviewStore';

interface Props {
  itemId: string;
  cached?: PrAlignmentReportDto | null;
}

/**
 * 档 3：AI 对齐度检查面板。
 *
 * UX 状态机：
 *   idle (无缓存) → 点击按钮启动
 *   cached (有旧结果) → 展示缓存 + "重新分析"按钮
 *   streaming → 阶段条（preparing/fetching/analyzing）+ 典型字段的 typing 文本
 *   done → 解析分数 + 渲染 markdown 各章节
 *   error → 错误信息 + 重试按钮
 *
 * 设计原则（llm-visibility）：
 *   - 任何时刻屏幕都有持续变化的内容，禁止静止 spinner > 2s
 *   - phase 事件驱动"当前在做什么"的文案
 *   - typing 事件驱动增量渲染（打字机效果）
 *   - done 后替换为结构化渲染
 */
export function AlignmentPanel({ itemId, cached }: Props) {
  const setAlignmentReport = usePrReviewStore((s) => s.setAlignmentReport);
  const [localResult, setLocalResult] = useState<PrAlignmentReportDto | null>(cached ?? null);
  const [finalError, setFinalError] = useState<string | null>(null);
  const fullMdRef = useRef('');

  // 缓存刷新时同步本地态
  useEffect(() => {
    setLocalResult(cached ?? null);
  }, [cached]);

  const handleResult = useCallback(
    (data: unknown) => {
      const d = data as { score?: number; summary?: string | null; markdown?: string };
      if (typeof d.markdown !== 'string') return;
      const report: PrAlignmentReportDto = {
        score: typeof d.score === 'number' ? d.score : 0,
        summary: d.summary ?? null,
        markdown: d.markdown,
        durationMs: 0,
        createdAt: new Date().toISOString(),
      };
      setLocalResult(report);
      setAlignmentReport(itemId, report);
    },
    [itemId, setAlignmentReport],
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
    void sse.start({ url: getPrReviewAlignmentStreamUrl(itemId) });
  }, [itemId, sse]);

  // 卸载时中止，避免孤立连接
  useEffect(() => {
    return () => {
      sse.abort();
    };
    // 只在挂载/卸载时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = sse.isStreaming || sse.phase === 'connecting';

  // ========== 空态：没缓存也没在跑 ==========
  if (!localResult && !isRunning && !finalError) {
    return (
      <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-violet-500/15 flex items-center justify-center shrink-0">
            <Sparkles size={18} className="text-violet-300" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-white">AI 对齐度检查</div>
            <div className="text-xs text-white/50 mt-0.5 leading-relaxed">
              对比 PR 作者描述与实际代码变更，检测"说了没做 / 做了没说"的偏差，
              并给出一个 0-100 的对齐度分数。
            </div>
            <button
              type="button"
              onClick={handleStart}
              className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500 text-white text-xs font-semibold hover:bg-violet-400 transition"
            >
              <Wand2 size={14} />
              开始分析
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========== 运行中：phase + 增量 markdown ==========
  if (isRunning) {
    const phaseText = sse.phaseMessage || '正在准备...';
    const preview = sse.typing.slice(-600); // 只显示最近 600 字
    return (
      <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-violet-200">
          <Loader2 size={16} className="animate-spin" />
          <span className="font-semibold">{phaseText}</span>
        </div>
        {preview && (
          <pre className="text-[11px] text-white/60 font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto bg-black/30 rounded p-3 border border-white/5">
            {preview}
            <span className="inline-block w-1 h-3 bg-violet-400 animate-pulse ml-0.5" />
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

  // ========== 错误：允许重试 ==========
  if (finalError && !localResult) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 space-y-3">
        <div className="flex items-start gap-2 text-red-200 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">AI 对齐分析失败</div>
            <div className="text-red-200/80 text-xs mt-0.5">{finalError}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleStart}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 transition"
        >
          <RefreshCw size={12} />
          重新分析
        </button>
      </div>
    );
  }

  // ========== 结果：完整结构化渲染 ==========
  if (localResult) {
    return <AlignmentResult report={localResult} onRerun={handleStart} error={finalError} />;
  }

  return null;
}

// ============================================================
// 结果渲染：把 markdown 按章节拆成色彩化卡片
// ============================================================

interface ResultProps {
  report: PrAlignmentReportDto;
  onRerun: () => void;
  error?: string | null;
}

function AlignmentResult({ report, onRerun, error }: ResultProps) {
  const sections = useMemo(() => parseSections(report.markdown), [report.markdown]);

  const scoreColor =
    report.score >= 90
      ? 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10'
      : report.score >= 75
      ? 'text-sky-300 border-sky-400/30 bg-sky-400/10'
      : report.score >= 60
      ? 'text-amber-300 border-amber-400/30 bg-amber-400/10'
      : 'text-red-300 border-red-400/30 bg-red-400/10';

  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-4 space-y-4">
      {/* 头部：分数 + 总结 + 重跑按钮 */}
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-14 h-14 rounded-xl border flex flex-col items-center justify-center ${scoreColor}`}>
          <div className="text-xl font-bold leading-none">{report.score}</div>
          <div className="text-[9px] uppercase tracking-wide mt-0.5">score</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-white/50">
            <Sparkles size={12} />
            <span>AI 对齐度检查</span>
            {report.durationMs > 0 && (
              <>
                <span>·</span>
                <Clock size={12} />
                <span>{(report.durationMs / 1000).toFixed(1)}s</span>
              </>
            )}
          </div>
          {report.summary && (
            <div className="mt-1.5 text-sm text-white font-medium leading-snug">{report.summary}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onRerun}
          title="重新分析"
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

      {/* 章节 */}
      <div className="space-y-3">
        <Section
          title="已落实"
          color="emerald"
          icon={<CheckCircle2 size={14} />}
          items={sections.implemented}
        />
        <Section
          title="描述里没提但动了"
          color="amber"
          icon={<TriangleAlert size={14} />}
          items={sections.undocumented}
        />
        <Section
          title="描述里提了但没见到"
          color="red"
          icon={<XCircle size={14} />}
          items={sections.missing}
        />
        {sections.linkedIssue && (
          <InlineBlock title="关联 Issue 对齐" content={sections.linkedIssue} />
        )}
        {sections.architectFocus.length > 0 && (
          <Section
            title="架构师关注点"
            color="violet"
            icon={<Sparkles size={14} />}
            items={sections.architectFocus}
          />
        )}
      </div>

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

interface SectionProps {
  title: string;
  color: 'emerald' | 'amber' | 'red' | 'violet';
  icon: React.ReactNode;
  items: string[];
}

function Section({ title, color, icon, items }: SectionProps) {
  if (items.length === 0) return null;

  const palette = {
    emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200',
    amber: 'border-amber-500/20 bg-amber-500/5 text-amber-200',
    red: 'border-red-500/20 bg-red-500/5 text-red-200',
    violet: 'border-violet-500/20 bg-violet-500/5 text-violet-200',
  }[color];

  return (
    <div className={`rounded-lg border ${palette} p-3`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2">
        {icon}
        <span>{title}</span>
        <span className="text-[10px] opacity-60">· {items.length}</span>
      </div>
      <ul className="space-y-1.5 text-xs text-white/80">
        {items.map((it, i) => (
          <li key={i} className="leading-relaxed">
            <span className="text-white/30 mr-1">•</span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InlineBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="text-xs font-semibold text-white/70 mb-1">{title}</div>
      <div className="text-xs text-white/70 leading-relaxed">{content}</div>
    </div>
  );
}

// ============================================================
// Markdown 章节解析（严格按 PrAlignmentService 的 prompt 约定）
// ============================================================

interface ParsedSections {
  implemented: string[];
  undocumented: string[];
  missing: string[];
  linkedIssue: string | null;
  architectFocus: string[];
}

function parseSections(markdown: string): ParsedSections {
  return {
    implemented: extractBullets(markdown, /##\s*✅?\s*已落实/),
    undocumented: extractBullets(markdown, /##\s*⚠️?\s*描述里没提但动了/),
    missing: extractBullets(markdown, /##\s*❌?\s*描述里提了但没见到/),
    linkedIssue: extractParagraph(markdown, /##\s*关联\s*Issue\s*对齐/),
    architectFocus: extractBullets(markdown, /##\s*架构师关注点/),
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
    // 匹配 "- xxx" 或 "* xxx" 或 "1. xxx"
    const m = line.match(/^(?:[-*]|\d+\.)\s*(.+)$/);
    if (m) {
      bullets.push(m[1].trim());
    }
  }
  // "无" 当作空列表
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
  // 找下一个 ## 作为结束
  const nextHeading = rest.search(/\n##\s/);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
