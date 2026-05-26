/**
 * 任务复盘抽屉 — 一键拿到上周「数字 + 没干完的原因 + 下周建议」毒舌点评。
 *
 * 流程：
 *   1) 用户选时段（本周 / 近 7 天 / 近 30 天 / 自定义）
 *   2) 点开始 → SSE 阶段提示（统计中 → 点评中 → 出建议）
 *   3) LLM 流式输出 markdown，前端 ReactMarkdown 渲染
 *   4) 完成后吐 sessionId，可点击「在历史里查看」跳转到对应会话
 *
 * 布局：右侧滑出 Drawer，inline style 高度 + createPortal + min-h:0（参考 frontend-modal 规则）。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X, ChevronDown, Calendar, Play, Loader2, RotateCcw, CheckCircle, AlertTriangle,
} from 'lucide-react';
import {
  streamPaReview,
  type PaReviewRange,
  type PaReviewStageEvent,
} from '@/services/real/paAgentService';

interface Props {
  open: boolean;
  onClose: () => void;
}

const RANGE_OPTIONS: { value: PaReviewRange; label: string; hint: string }[] = [
  { value: 'weekly',  label: '本周',     hint: '本周一至今' },
  { value: 'last7d',  label: '近 7 天',  hint: '今天往前 7 天' },
  { value: 'last30d', label: '近 30 天', hint: '今天往前 30 天' },
  { value: 'custom',  label: '自定义',   hint: '指定起止日期' },
];

const STAGE_LABEL: Record<PaReviewStageEvent['stage'], { label: string; hint: string }> = {
  aggregating: { label: '统计中', hint: '正在数你这段时间干了多少事' },
  scoring:     { label: '点评中', hint: 'AI 正在毒舌点评' },
  suggesting:  { label: '出建议', hint: '在生成下周 next action' },
};

export function PaReviewDrawer({ open, onClose }: Props) {
  const [range, setRange] = useState<PaReviewRange>('last7d');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<PaReviewStageEvent | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content, stage, error]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 切换打开时重置
  useEffect(() => {
    if (open) {
      setRunning(false);
      setStage(null);
      setContent('');
      setError(null);
      setDone(false);
      setSessionId(null);
    } else {
      abortRef.current?.();
      abortRef.current = null;
    }
  }, [open]);

  const handleRun = useCallback(async () => {
    if (running) return;
    if (range === 'custom' && (!startDate || !endDate)) {
      setError('自定义时段请同时选择起止日期');
      return;
    }
    setRunning(true);
    setStage(null);
    setContent('');
    setError(null);
    setDone(false);
    setSessionId(null);

    abortRef.current = await streamPaReview({
      range,
      startDate: range === 'custom' ? startDate : undefined,
      endDate: range === 'custom' ? endDate : undefined,
      onStage: evt => setStage(evt),
      onDelta: chunk => setContent(prev => prev + chunk),
      onDone: evt => {
        setRunning(false);
        setDone(true);
        setSessionId(evt.sessionId ?? null);
        abortRef.current = null;
      },
      onError: err => {
        setRunning(false);
        setError(err);
        abortRef.current = null;
      },
    });
  }, [range, startDate, endDate, running]);

  const handleAbort = () => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
  };

  const handleRetry = () => {
    setError(null);
    void handleRun();
  };

  if (!open) return null;

  const drawer = (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col shadow-2xl"
        style={{
          width: 'min(560px, 100vw)',
          height: '100vh',
          maxHeight: '100vh',
          background: '#0f1014',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between px-5 py-3"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg,#f59e0b,#ef4444)' }}
            >
              <RotateCcw size={14} color="#fff" />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                任务复盘
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                毒舌秘书会给你一份「数字 + 原因 + 下周建议」
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div
          className="shrink-0 px-5 py-3 space-y-2"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
        >
          <div className="flex flex-wrap gap-2">
            {RANGE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setRange(opt.value)}
                disabled={running}
                title={opt.hint}
                className="text-xs px-3 py-1.5 rounded-xl transition-all disabled:opacity-50"
                style={{
                  background: range === opt.value
                    ? 'linear-gradient(135deg,#f59e0b,#ef4444)'
                    : 'rgba(255,255,255,0.03)',
                  color: range === opt.value ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${range === opt.value ? 'transparent' : 'rgba(255,255,255,0.08)'}`,
                  fontWeight: range === opt.value ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="flex items-center gap-2">
              <Calendar size={12} style={{ color: 'var(--text-muted)' }} />
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                disabled={running}
                className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-transparent outline-none"
                style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              <ChevronDown size={11} style={{ color: 'var(--text-muted)' }} />
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                disabled={running}
                className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-transparent outline-none"
                style={{ color: 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            {running ? (
              <button
                onClick={handleAbort}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.4)' }}
              >
                <X size={13} />
                停止
              </button>
            ) : (
              <button
                onClick={() => void handleRun()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all"
                style={{ background: 'linear-gradient(135deg,#f59e0b,#ef4444)', color: '#fff' }}
              >
                <Play size={13} />
                开始复盘
              </button>
            )}
          </div>

          {/* Stage indicator */}
          {(stage || running) && (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <Loader2 size={11} className="animate-spin" style={{ color: '#fcd34d' }} />
              <span style={{ color: '#fcd34d' }}>
                {stage ? STAGE_LABEL[stage.stage]?.label : '准备中'}
              </span>
              <span>·</span>
              <span>{stage?.message ?? '连接秘书'}</span>
            </div>
          )}
        </div>

        {/* Result */}
        <div
          ref={scrollRef}
          className="flex-1 px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {error ? (
            <div
              className="flex items-start gap-2 p-3 rounded-xl"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              <AlertTriangle size={14} style={{ color: '#f87171' }} />
              <div className="flex-1 text-xs leading-relaxed" style={{ color: '#fca5a5' }}>
                {error}
                <button
                  onClick={handleRetry}
                  className="ml-2 underline"
                  style={{ color: '#fca5a5' }}
                >
                  重试
                </button>
              </div>
            </div>
          ) : content ? (
            <article
              className="prose prose-sm max-w-none"
              style={{ color: 'var(--text-primary)' }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              {running && (
                <span
                  className="inline-block w-0.5 h-4 align-middle animate-pulse ml-0.5"
                  style={{ background: '#fcd34d' }}
                />
              )}
            </article>
          ) : !running ? (
            <div
              className="text-center py-12 text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              选个时段，点【开始复盘】。
              <br />
              秘书会拿任务表里的数据点你过去做得怎么样、下周该干嘛。
            </div>
          ) : null}

          {done && sessionId && (
            <div
              className="mt-4 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ background: 'rgba(34,197,94,0.08)', color: '#86efac', border: '1px solid rgba(34,197,94,0.25)' }}
            >
              <CheckCircle size={12} />
              本次复盘已保存到会话历史。
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}
