/**
 * 产品管理智能体 — 工作台「工作助手」右侧抽屉（问答形式）。
 *
 * 以该产品全量数据（需求/功能/缺陷/版本/客户）+ 本产品知识库文档为上下文，
 * 通过 SSE 流式问答调用 AI。预置 3 个快捷问题。占视口约 30%（createPortal 固定右侧）。
 * 遵循 frontend-modal 规则：createPortal、inline 尺寸、min-h-0 滚动、overscroll-contain、ESC/遮罩关闭。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Send, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';

const PRESETS = ['本月需求分析', '本月需求矩阵分析', '本月缺陷分析'];

interface QA {
  q: string;
  a: string;
}

export function ProductAssistantDrawer({
  productId,
  productName,
  onClose,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<QA[]>([]);
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [liveAnswer, setLiveAnswer] = useState('');
  const [input, setInput] = useState('');
  const answerRef = useRef('');
  const pendingRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const finalize = (a: string) => {
    const q = pendingRef.current;
    if (q != null) setHistory((h) => [...h, { q, a }]);
    pendingRef.current = null;
    setPendingQ(null);
    setLiveAnswer('');
    answerRef.current = '';
  };

  const sse = useSseStream({
    url: `/api/product/products/${productId}/assistant/ask`,
    method: 'POST',
    onTyping: (t) => {
      answerRef.current += t;
      setLiveAnswer(answerRef.current);
    },
    onDone: () => finalize(answerRef.current || '（无内容）'),
    onError: (m) => finalize(`出错：${m}`),
  });

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || sse.isStreaming) return;
    answerRef.current = '';
    setLiveAnswer('');
    pendingRef.current = text;
    setPendingQ(text);
    setInput('');
    void sse.start({ body: { question: text } });
  };

  // ESC 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // 新内容自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, liveAnswer, pendingQ]);

  const connecting = sse.phase === 'connecting' || (sse.isStreaming && !liveAnswer);

  const drawer = (
    <div className="fixed inset-0 z-[100]" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onClose}>
      <div
        className="absolute top-0 right-0 h-full flex flex-col"
        style={{
          width: '30vw',
          minWidth: 380,
          background: '#0f1014',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '-24px 0 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/10">
          <Sparkles size={16} className="text-cyan-300" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-white/90">工作助手</span>
            <span className="text-[11px] text-white/40 truncate">基于「{productName}」全量数据 + 知识库问答</span>
          </div>
          <button onClick={onClose} className="ml-auto text-white/50 hover:text-white" title="关闭">
            <X size={18} />
          </button>
        </div>

        {/* 消息区 */}
        <div
          ref={scrollRef}
          className="flex-1 px-4 py-3 space-y-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {history.length === 0 && !pendingQ && (
            <div className="text-[12px] text-white/40 leading-relaxed">
              我能基于本产品的需求 / 功能 / 缺陷 / 版本 / 客户与知识库回答你的问题。试试下面的快捷分析，或直接提问。
            </div>
          )}
          {history.map((m, i) => (
            <QaBlock key={i} q={m.q} a={m.a} />
          ))}
          {pendingQ && (
            <div className="space-y-2">
              <UserBubble text={pendingQ} />
              <div className="text-sm text-white/85 leading-relaxed">
                {connecting ? (
                  <span className="inline-flex items-center gap-2 text-white/50 text-[12px]">
                    <MapSpinner size={14} /> {sse.phaseMessage || '思考中…'}
                  </span>
                ) : (
                  <StreamingText text={liveAnswer} streaming markdown />
                )}
              </div>
            </div>
          )}
        </div>

        {/* 快捷问题 */}
        <div className="shrink-0 px-4 pt-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              disabled={sse.isStreaming}
              onClick={() => ask(p)}
              className="text-[12px] px-2.5 py-1 rounded-full border border-cyan-500/30 text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-40"
            >
              {p}
            </button>
          ))}
        </div>

        {/* 输入区 */}
        <div className="shrink-0 px-4 py-3 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder="输入问题，Enter 发送…"
            className="flex-1 resize-none rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 outline-none focus:border-cyan-500/40"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={() => ask(input)}
            disabled={!input.trim() || sse.isStreaming}
            className="shrink-0 flex items-center justify-center px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-40"
            title="发送"
          >
            {sse.isStreaming ? <MapSpinner size={14} /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] text-sm text-cyan-100 bg-cyan-500/15 border border-cyan-500/25 rounded-lg px-3 py-1.5 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function QaBlock({ q, a }: { q: string; a: string }) {
  return (
    <div className="space-y-2">
      <UserBubble text={q} />
      <div className="text-sm text-white/85 whitespace-pre-wrap leading-relaxed">{a}</div>
    </div>
  );
}
