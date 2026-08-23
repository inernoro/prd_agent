import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Replace, ListPlus, Copy, RotateCcw, Quote, Diff, Send } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { toast } from '@/lib/toast';
import { computeLineDiff, type DiffLine } from '@/lib/lineDiff';
import { streamSelectionRewrite } from '@/services/real/documentStore';
import { stripOuterFence } from './selectionEdit';
import { useSelectionRewriteActions } from './useSelectionRewriteActions';
import {
  SELECTION_OVERLAY_CHIP,
  SELECTION_OVERLAY_FIELD,
  SELECTION_OVERLAY_LABEL,
  SELECTION_OVERLAY_PANEL,
  SELECTION_OVERLAY_PRIMARY,
} from './selectionOverlayStyle';

// 划词「AI 改写」就地浮层：选动作 → SSE 流式生成 → diff 预览 → 替换原文 / 插到原文后。
// 布局遵 frontend-modal.md：createPortal 到 body + inline style 定位/高度 + min-h-0 滚动区。

export interface SelectionAiAnchor {
  selectedText: string;
  contextBefore?: string;
  contextAfter?: string;
  startOffset: number;
  endOffset: number;
  /** DOM 选区前同文出现次数（0-based）：同文多处出现时指认用户真正选的是第几处 */
  domOccurrenceIndex?: number;
  /** DOM 全文同文出现总数：与正文统计交叉校验用 */
  domOccurrenceTotal?: number;
}

type Phase = 'pick' | 'streaming' | 'done' | 'error';

export function SelectionAiPopover({
  entryId,
  anchor,
  anchorRect,
  scrollRef,
  canReplace,
  onApply,
  onClose,
}: {
  entryId: string;
  anchor: SelectionAiAnchor;
  /** 选区视口坐标快照（getBoundingClientRect） */
  anchorRect: { top: number; left: number; width: number; height: number };
  /** 正文滚动容器：浮层跟随滚动平移 */
  scrollRef?: RefObject<HTMLElement>;
  /** 选区能否在原文中安全定位（resolveSelectionRange 成功）；false 时禁用「替换原文」 */
  canReplace: boolean;
  onApply: (mode: 'replace' | 'insert-after', newText: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const actions = useSelectionRewriteActions();
  const [phase, setPhase] = useState<Phase>('pick');
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [output, setOutput] = useState('');
  // 模型 thinking 流（CLAUDE.md §6：支持 thinking 的模型必须展示思考过程，不能只有 spinner）
  const [thinking, setThinking] = useState('');
  const [model, setModel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [applying, setApplying] = useState<'replace' | 'insert-after' | null>(null);
  const [scrollDy, setScrollDy] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const outputBoxRef = useRef<HTMLDivElement>(null);

  // 跟随正文滚动平移（与 InlineCommentComposer 同一套 scrollDy 逻辑）
  useEffect(() => {
    const read = () => (scrollRef?.current?.scrollTop ?? 0) + window.scrollY;
    const start = read();
    const onScroll = () => setScrollDy(read() - start);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [scrollRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 卸载时中断未完成的流
  useEffect(() => () => { abortRef.current?.(); }, []);

  // 流式输出时让结果区贴底滚动（thinking 与正文都驱动）
  useEffect(() => {
    if (phase === 'streaming' && outputBoxRef.current) {
      outputBoxRef.current.scrollTop = outputBoxRef.current.scrollHeight;
    }
  }, [output, thinking, phase]);

  const run = useCallback((actionKey: string, instruction?: string) => {
    abortRef.current?.();
    setPhase('streaming');
    setActiveAction(actionKey);
    setOutput('');
    setThinking('');
    setErrorMsg('');
    setShowDiff(false);
    let acc = '';
    let thinkAcc = '';
    abortRef.current = streamSelectionRewrite(entryId, {
      selectedText: anchor.selectedText,
      contextBefore: anchor.contextBefore,
      contextAfter: anchor.contextAfter,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      occurrenceIndex: anchor.domOccurrenceIndex,
      occurrenceTotal: anchor.domOccurrenceTotal,
      actionKey,
      instruction,
      onStart: (info) => setModel(info.model ?? ''),
      onThinking: (c) => { thinkAcc += c; setThinking(thinkAcc); },
      onText: (c) => { acc += c; setOutput(acc); },
      onError: (msg) => { setErrorMsg(msg); setPhase('error'); },
      onDone: () => {
        // 模型偶发用代码围栏包整段输出，剥掉再进 diff/替换
        const cleaned = stripOuterFence(acc).trim();
        acc = cleaned;
        setOutput(cleaned);
        setPhase(cleaned ? 'done' : 'error');
        if (!cleaned) setErrorMsg('模型没有返回内容，请重试');
      },
    });
  }, [entryId, anchor]);

  const handleApply = useCallback(async (mode: 'replace' | 'insert-after') => {
    if (!output.trim() || applying) return;
    setApplying(mode);
    try {
      const ok = await onApply(mode, output.trim());
      if (ok) onClose();
    } finally {
      setApplying(null);
    }
  }, [output, applying, onApply, onClose]);

  const width = 420;
  const belowTop = anchorRect.top + anchorRect.height + 8;
  const estHeight = 360;
  const wouldOverflow = belowTop + estHeight > window.innerHeight;
  const top = wouldOverflow ? Math.max(8, anchorRect.top - estHeight - 8) : belowTop;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left));
  const busy = phase === 'streaming';

  const node = (
    <div
      className="fixed z-[120] flex flex-col"
      style={{
        top,
        left,
        width,
        maxHeight: Math.min(480, window.innerHeight - 16),
        transform: `translateY(${-scrollDy}px)`,
        padding: 12,
        ...SELECTION_OVERLAY_PANEL,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 头部：标题 + 模型可见性（ai-model-visibility）+ 关闭 */}
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className="text-[10px] font-semibold flex items-center gap-1.5" style={{ color: SELECTION_OVERLAY_LABEL }}>
          <Sparkles size={11} />
          划词 AI 改写
          {model && (
            <span className="font-mono font-normal" style={{ color: 'var(--text-muted)' }}>· {model}</span>
          )}
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover-bg-soft transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>

      {/* 选中片段引用块 */}
      <div className="flex items-center gap-1 mb-1 shrink-0">
        <Quote size={9} style={{ color: SELECTION_OVERLAY_LABEL }} />
        <span className="text-[10px] font-semibold" style={{ color: SELECTION_OVERLAY_LABEL }}>你选中的内容</span>
      </div>
      <div
        className="px-2.5 py-1.5 rounded-[8px] text-[12px] mb-2 overflow-y-auto shrink-0"
        style={{
          maxHeight: 72,
          ...SELECTION_OVERLAY_CHIP,
          borderLeft: '3px solid var(--accent-gold)',
          color: 'var(--text-primary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {anchor.selectedText.length > 160 ? anchor.selectedText.slice(0, 160) + '…' : anchor.selectedText}
      </div>

      {/* 动作 chips + 自定义指令 */}
      <div className="flex flex-wrap gap-1.5 mb-2 shrink-0">
        {actions.map((a) => {
          const active = activeAction === a.key;
          return (
            <button
              key={a.key}
              disabled={busy}
              onClick={() => run(a.key)}
              title={a.description}
              className="h-6 px-2.5 rounded-full text-[11px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={
                active
                  ? SELECTION_OVERLAY_CHIP
                  : {
                      background: 'var(--nested-block-bg)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                    }
              }
            >
              {a.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 mb-2 shrink-0">
        <input
          value={customInstruction}
          onChange={(e) => setCustomInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customInstruction.trim() && !busy) {
              e.preventDefault();
              run('custom', customInstruction.trim());
            }
          }}
          disabled={busy}
          placeholder="或输入自定义指令，如：改成表格 / 翻译成英文…"
          className="flex-1 h-7 px-2.5 rounded-[8px] text-[12px] outline-none"
          style={SELECTION_OVERLAY_FIELD}
        />
        <button
          onClick={() => customInstruction.trim() && run('custom', customInstruction.trim())}
          disabled={busy || !customInstruction.trim()}
          className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={SELECTION_OVERLAY_PRIMARY}
          title="执行自定义指令"
        >
          <Send size={12} />
        </button>
      </div>

      {/* 结果区：流式输出 / diff 预览 / 错误。flex-1 + min-h-0 承担滚动 */}
      {(phase !== 'pick') && (
        <div
          ref={outputBoxRef}
          className="rounded-[8px] px-2.5 py-2 text-[12px] mb-2 overflow-y-auto bg-token-nested border border-token-subtle"
          style={{ flex: 1, minHeight: 60, maxHeight: 200, color: 'var(--text-primary)', lineHeight: 1.6, overscrollBehavior: 'contain' }}
        >
          {phase === 'error' ? (
            <span style={{ color: 'var(--accent-fg-danger)' }}>{errorMsg}</span>
          ) : showDiff && phase === 'done' ? (
            <MiniDiff lines={computeLineDiff(anchor.selectedText, output)} />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {/* thinking 流：支持推理的模型先吐思考，必须可见（CLAUDE.md §6），只在流式期间展示尾部窗口 */}
              {busy && thinking && (
                <div
                  className="mb-1.5 pb-1.5 text-[11px]"
                  style={{
                    color: 'var(--text-muted)',
                    borderBottom: '1px dashed var(--border-subtle)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <span className="font-semibold">思考中 · </span>
                  {thinking.length > 400 ? '…' + thinking.slice(-400) : thinking}
                </div>
              )}
              <StreamingText text={output || (busy ? '' : '')} streaming={busy} />
              {busy && !output && !thinking && (
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <MapSpinner size={11} /> 正在分析选区与上下文…
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 底部操作 */}
      {phase === 'done' && (
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button
            onClick={() => handleApply('replace')}
            disabled={!canReplace || !!applying}
            /* 这个浮层只在「整段替换不安全」时才会打开，所以 canReplace 开局必为 false。
               文案不能只说其中一个原因——定位不唯一与选区卡在标记中间都会走到这里
               （2026-08-21 code review：提示把另一半原因说成了唯一原因）。 */
            title={canReplace
              ? '用 AI 结果替换选中片段'
              : '这段选区在原文里指认不到唯一位置，或者它卡在链接 / 加粗 / 行内代码的标记中间；直接替换会写错地方或破坏格式，所以禁用。可改用「插到原文后」或复制'}
            className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={SELECTION_OVERLAY_PRIMARY}
          >
            {applying === 'replace' ? <MapSpinner size={11} /> : <Replace size={11} />}
            替换原文
          </button>
          <button
            onClick={() => handleApply('insert-after')}
            disabled={!!applying}
            title="保留原文，把 AI 结果插到选中段落之后"
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-token-nested border border-token-subtle"
            style={{ color: 'var(--text-secondary)' }}
          >
            {applying === 'insert-after' ? <MapSpinner size={11} /> : <ListPlus size={11} />}
            插到原文后
          </button>
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
            style={{
              background: showDiff ? 'var(--selection-bg)' : 'var(--bg-nested)',
              border: `1px solid ${showDiff ? 'var(--selection-border)' : 'var(--border-faint)'}`,
              color: showDiff ? 'var(--selection-text)' : 'var(--text-secondary)',
            }}
            title="对比原文与 AI 结果"
          >
            <Diff size={11} /> 对比
          </button>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(output);
                toast.success('已复制');
              } catch {
                toast.error('复制失败');
              }
            }}
            className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer bg-token-nested border border-token-subtle"
            style={{ color: 'var(--text-secondary)' }}
            title="复制结果"
          >
            <Copy size={11} />
          </button>
          <button
            onClick={() => activeAction && run(activeAction, activeAction === 'custom' ? customInstruction.trim() : undefined)}
            className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer bg-token-nested border border-token-subtle"
            style={{ color: 'var(--text-secondary)' }}
            title="重新生成"
          >
            <RotateCcw size={11} />
          </button>
        </div>
      )}
      {phase === 'error' && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => activeAction && run(activeAction, activeAction === 'custom' ? customInstruction.trim() : undefined)}
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
            style={SELECTION_OVERLAY_CHIP}
          >
            <RotateCcw size={11} /> 重试
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(node, document.body);
}

/** 轻量行级 diff 渲染（绿增红删），复用 lib/lineDiff 的纯函数 */
function MiniDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="font-mono text-[11px]" style={{ lineHeight: 1.6 }}>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: l.type === 'add' ? 'rgba(34,197,94,0.12)' : l.type === 'del' ? 'rgba(248,113,113,0.12)' : 'transparent',
            color: l.type === 'add' ? 'var(--accent-fg-emerald)' : l.type === 'del' ? 'var(--accent-fg-danger)' : 'var(--text-secondary)',
            textDecoration: l.type === 'del' ? 'line-through' : undefined,
            padding: '0 4px',
            borderRadius: 3,
          }}
        >
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}
