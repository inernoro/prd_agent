/**
 * 产品管理智能体 — 工作台「AI助手」右侧抽屉（问答形式）。
 *
 * 以该产品全量数据（需求/功能/缺陷/版本/客户/人员）+ 知识库文档为上下文，SSE 流式问答。
 * 主流聊天样式：用户/AI 各带头像 + 气泡（底色+边框），AI 回答可一键复制。
 * 对话保存在 sessionStorage（按产品隔离），关闭重开不丢，支持手动清除。
 * 遵 frontend-modal 规则：createPortal、inline 尺寸、min-h-0 滚动、overscroll-contain、ESC/遮罩关闭。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Send, X, Copy, Check, Trash2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { useAuthStore } from '@/stores/authStore';
import { resolveAvatarUrl } from '@/lib/avatar';
import { stripMarkdown } from '@/lib/stripMarkdown';

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
  const storageKey = `pa-ai-assistant:${productId}`;
  const me = useAuthStore((s) => s.user);
  const myAvatar = resolveAvatarUrl({ username: me?.username, avatarFileName: me?.avatarFileName });

  const [history, setHistory] = useState<QA[]>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as QA[]) : [];
    } catch {
      return [];
    }
  });
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [liveAnswer, setLiveAnswer] = useState('');
  const [input, setInput] = useState('');
  const answerRef = useRef('');
  const pendingRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 对话持久化（按产品隔离，sessionStorage：关闭重开不丢，手动清除才没）
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(history));
    } catch {
      /* ignore quota */
    }
  }, [history, storageKey]);

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
    onDone: () => finalize(stripMarkdown(answerRef.current) || '（无内容）'),
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

  const clearAll = () => {
    sse.abort();
    pendingRef.current = null;
    answerRef.current = '';
    setPendingQ(null);
    setLiveAnswer('');
    setHistory([]);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
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
            <span className="text-sm font-semibold text-white/90">AI助手</span>
            <span className="text-[11px] text-white/40 truncate">基于「{productName}」全量数据 + 知识库问答</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {history.length > 0 && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 px-1.5 py-1 rounded hover:bg-white/5"
                title="清除全部对话"
              >
                <Trash2 size={13} /> 清除
              </button>
            )}
            <button onClick={onClose} className="text-white/50 hover:text-white p-1" title="关闭">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 消息区 */}
        <div
          ref={scrollRef}
          className="flex-1 px-3.5 py-3 space-y-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {history.length === 0 && !pendingQ && (
            <div className="text-[12px] text-white/40 leading-relaxed px-1">
              我能基于本产品的需求 / 功能 / 缺陷 / 版本 / 客户与知识库回答你的问题。试试下面的快捷分析，或直接提问。
            </div>
          )}
          {history.map((m, i) => (
            <div key={i} className="space-y-2.5">
              <UserRow text={m.q} avatar={myAvatar} />
              <AiRow text={m.a} />
            </div>
          ))}
          {pendingQ && (
            <div className="space-y-2.5">
              <UserRow text={pendingQ} avatar={myAvatar} />
              <AiRow streaming>
                {connecting ? (
                  <span className="inline-flex items-center gap-2 text-white/50 text-[12px]">
                    <MapSpinner size={14} /> {sse.phaseMessage || '思考中…'}
                  </span>
                ) : (
                  <StreamingText text={stripMarkdown(liveAnswer)} streaming />
                )}
              </AiRow>
            </div>
          )}
        </div>

        {/* 快捷问题 */}
        <div className="shrink-0 px-3.5 pt-2 flex flex-wrap gap-1.5">
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
        <div className="shrink-0 px-3.5 py-3 flex items-end gap-2">
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
            className="flex-1 resize-none rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-[13px] text-white/90 outline-none focus:border-cyan-500/40"
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

/** 用户消息行：头像在右，气泡右对齐。 */
function UserRow({ text, avatar }: { text: string; avatar: string }) {
  return (
    <div className="flex items-start gap-2 justify-end">
      <div className="max-w-[80%] text-[13px] text-cyan-50 bg-cyan-500/15 border border-cyan-500/25 rounded-2xl rounded-tr-sm px-3 py-2 whitespace-pre-wrap leading-relaxed">
        {text}
      </div>
      <img src={avatar} alt="" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full object-cover shrink-0 mt-0.5" />
    </div>
  );
}

/** AI 消息行：头像在左，气泡带底色+边框，hover 出现复制按钮（已完成的回答 text 传入）。 */
function AiRow({ text, streaming, children }: { text?: string; streaming?: boolean; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex items-start gap-2">
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center bg-cyan-500/15 border border-cyan-500/30 mt-0.5">
        <Sparkles size={14} className="text-cyan-300" />
      </div>
      <div className="group relative max-w-[85%] text-[13px] text-white/85 bg-white/[0.04] border border-white/10 rounded-2xl rounded-tl-sm px-3 py-2 leading-relaxed whitespace-pre-wrap">
        {children ?? text}
        {!streaming && text && (
          <button
            onClick={copy}
            className="absolute -bottom-2.5 right-1 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1c22] border border-white/10 text-white/50 hover:text-white/90 opacity-0 group-hover:opacity-100 transition-opacity"
            title="复制内容"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>
    </div>
  );
}
