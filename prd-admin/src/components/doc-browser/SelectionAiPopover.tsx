import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Replace, ListPlus, Copy, RotateCcw, Quote, Diff, Send } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { toast } from '@/lib/toast';
import { computeLineDiff, type DiffLine } from '@/lib/lineDiff';
import {
  listSelectionRewriteActions,
  streamSelectionRewrite,
  type SelectionRewriteActionItem,
} from '@/services/real/documentStore';

// 划词「AI 改写」就地浮层：选动作 → SSE 流式生成 → diff 预览 → 替换原文 / 插到原文后。
// 布局遵 frontend-modal.md：createPortal 到 body + inline style 定位/高度 + min-h-0 滚动区。

// 动作清单是后端 SSOT（selection-rewrite/actions），模块级缓存一次拉取
let cachedActions: SelectionRewriteActionItem[] | null = null;

export interface SelectionAiAnchor {
  selectedText: string;
  contextBefore?: string;
  contextAfter?: string;
  startOffset: number;
  endOffset: number;
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
  const [actions, setActions] = useState<SelectionRewriteActionItem[]>(cachedActions ?? []);
  const [phase, setPhase] = useState<Phase>('pick');
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [output, setOutput] = useState('');
  const [model, setModel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [applying, setApplying] = useState<'replace' | 'insert-after' | null>(null);
  const [scrollDy, setScrollDy] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const outputBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cachedActions) return;
    (async () => {
      const res = await listSelectionRewriteActions();
      if (res.success) {
        cachedActions = res.data.items;
        setActions(res.data.items);
      }
    })();
  }, []);

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

  // 流式输出时让结果区贴底滚动
  useEffect(() => {
    if (phase === 'streaming' && outputBoxRef.current) {
      outputBoxRef.current.scrollTop = outputBoxRef.current.scrollHeight;
    }
  }, [output, phase]);

  const run = useCallback((actionKey: string, instruction?: string) => {
    abortRef.current?.();
    setPhase('streaming');
    setActiveAction(actionKey);
    setOutput('');
    setErrorMsg('');
    setShowDiff(false);
    let acc = '';
    abortRef.current = streamSelectionRewrite(entryId, {
      selectedText: anchor.selectedText,
      contextBefore: anchor.contextBefore,
      contextAfter: anchor.contextAfter,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      actionKey,
      instruction,
      onStart: (info) => setModel(info.model ?? ''),
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
        borderRadius: 14,
        padding: 12,
        background: 'linear-gradient(180deg, rgba(30,28,46,0.97), rgba(20,19,28,0.98))',
        border: '1px solid rgba(168,85,247,0.4)',
        boxShadow: '0 18px 44px -10px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(40px)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 头部：标题 + 模型可见性（ai-model-visibility）+ 关闭 */}
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className="text-[10px] font-semibold flex items-center gap-1.5" style={{ color: 'rgba(216,180,254,0.9)' }}>
          <Sparkles size={11} />
          划词 AI 改写
          {model && (
            <span className="font-mono font-normal" style={{ color: 'var(--text-muted)' }}>· {model}</span>
          )}
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>

      {/* 选中片段引用块 */}
      <div className="flex items-center gap-1 mb-1 shrink-0">
        <Quote size={9} style={{ color: 'rgba(216,180,254,0.75)' }} />
        <span className="text-[10px] font-semibold" style={{ color: 'rgba(216,180,254,0.85)' }}>你选中的内容</span>
      </div>
      <div
        className="px-2.5 py-1.5 rounded-[8px] text-[12px] mb-2 overflow-y-auto shrink-0"
        style={{
          maxHeight: 72,
          background: 'rgba(168,85,247,0.12)',
          border: '1px solid rgba(168,85,247,0.22)',
          borderLeft: '3px solid rgba(168,85,247,0.7)',
          color: 'rgba(232,210,255,0.98)',
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
              style={{
                background: active ? 'rgba(168,85,247,0.28)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${active ? 'rgba(168,85,247,0.55)' : 'rgba(255,255,255,0.1)'}`,
                color: active ? 'rgba(232,210,255,0.98)' : 'var(--text-secondary)',
              }}
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
          style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.09)', color: 'var(--text-primary)' }}
        />
        <button
          onClick={() => customInstruction.trim() && run('custom', customInstruction.trim())}
          disabled={busy || !customInstruction.trim()}
          className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.35)', color: 'rgba(216,180,254,0.97)' }}
          title="执行自定义指令"
        >
          <Send size={12} />
        </button>
      </div>

      {/* 结果区：流式输出 / diff 预览 / 错误。flex-1 + min-h-0 承担滚动 */}
      {(phase !== 'pick') && (
        <div
          ref={outputBoxRef}
          className="rounded-[8px] px-2.5 py-2 text-[12px] mb-2 overflow-y-auto"
          style={{
            flex: 1,
            minHeight: 60,
            maxHeight: 200,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            color: 'var(--text-primary)',
            lineHeight: 1.6,
            overscrollBehavior: 'contain',
          }}
        >
          {phase === 'error' ? (
            <span style={{ color: 'rgba(248,113,113,0.9)' }}>{errorMsg}</span>
          ) : showDiff && phase === 'done' ? (
            <MiniDiff lines={computeLineDiff(anchor.selectedText, output)} />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <StreamingText text={output || (busy ? '' : '')} streaming={busy} />
              {busy && !output && (
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
            title={canReplace ? '用 AI 结果替换选中片段' : '选区在原文中出现多处且无法唯一定位，为避免替换错位置已禁用；可改用「插入」或复制'}
            className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'rgba(168,85,247,0.22)', border: '1px solid rgba(168,85,247,0.45)', color: 'rgba(232,210,255,0.98)' }}
          >
            {applying === 'replace' ? <MapSpinner size={11} /> : <Replace size={11} />}
            替换原文
          </button>
          <button
            onClick={() => handleApply('insert-after')}
            disabled={!!applying}
            title="保留原文，把 AI 结果插到选中段落之后"
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
          >
            {applying === 'insert-after' ? <MapSpinner size={11} /> : <ListPlus size={11} />}
            插到原文后
          </button>
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
            style={{
              background: showDiff ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${showDiff ? 'rgba(59,130,246,0.35)' : 'rgba(255,255,255,0.12)'}`,
              color: showDiff ? 'rgba(147,197,253,0.95)' : 'var(--text-secondary)',
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
            className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
            title="复制结果"
          >
            <Copy size={11} />
          </button>
          <button
            onClick={() => activeAction && run(activeAction, activeAction === 'custom' ? customInstruction.trim() : undefined)}
            className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
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
            style={{ background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.35)', color: 'rgba(216,180,254,0.97)' }}
          >
            <RotateCcw size={11} /> 重试
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(node, document.body);
}

/** 模型偶发把整段输出包进 ``` 围栏；只剥最外层成对围栏，不动内部代码块 */
function stripOuterFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z-]*\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : t;
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
            color: l.type === 'add' ? 'rgba(134,239,172,0.95)' : l.type === 'del' ? 'rgba(252,165,165,0.9)' : 'var(--text-secondary)',
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
