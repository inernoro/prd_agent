import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Send, X, CornerDownLeft, Quote } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';

// 划词后「就地输入」批注的小浮层（取代甩到右侧抽屉）。
// 锚在选区附近，写完 ⌘/Ctrl+Enter 发送；遵 frontend-modal.md：createPortal 到 body + inline style 定位。

export function InlineCommentComposer({
  selectedText,
  anchorRect,
  scrollRef,
  onSubmit,
  onClose,
}: {
  selectedText: string;
  /** 选区的视口坐标（getBoundingClientRect），用于定位浮层 */
  anchorRect: { top: number; left: number; width: number; height: number };
  /** 正文滚动容器：浮层跟随其滚动平移，避免滚动后浮层留在错误位置（Bugbot Medium） */
  scrollRef?: RefObject<HTMLElement>;
  onSubmit: (content: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 打开时清了选区、坐标是当时快照；滚动后按「累计滚动位移」把浮层平移回锚点处
  const [scrollDy, setScrollDy] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const read = () => (scrollRef?.current?.scrollTop ?? 0) + window.scrollY;
    const start = read();
    const onScroll = () => setScrollDy(read() - start);
    // capture=true 捕获正文内层滚动容器；resize 兜底
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

  const handleSubmit = async () => {
    const t = draft.trim();
    if (!t || submitting) return;
    setSubmitting(true);
    const ok = await onSubmit(t);
    setSubmitting(false);
    if (ok) { setDraft(''); onClose(); }
  };

  const width = 320;
  // 默认放选区下方；贴近底部时翻到上方
  const belowTop = anchorRect.top + anchorRect.height + 8;
  const wouldOverflow = belowTop + 190 > window.innerHeight;
  const top = wouldOverflow ? Math.max(8, anchorRect.top - 198) : belowTop;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left));

  const node = (
    <div
      className="fixed z-[120]"
      style={{
        top,
        left,
        width,
        // 正文滚动 dy 后锚点上移 dy，浮层同步上移，保持贴着选区
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
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>划词批注</span>
        <button onClick={onClose} className="w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors"
          style={{ color: 'var(--text-muted)' }} title="关闭">
          <X size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1 mb-1">
        <Quote size={9} style={{ color: 'rgba(216,180,254,0.75)' }} />
        <span className="text-[10px] font-semibold" style={{ color: 'rgba(216,180,254,0.85)' }}>你选中的内容</span>
      </div>
      <div
        className="px-2.5 py-1.5 rounded-[8px] text-[12px] mb-2 max-h-24 overflow-y-auto"
        style={{
          background: 'rgba(168,85,247,0.12)',
          borderLeft: '3px solid rgba(168,85,247,0.7)',
          border: '1px solid rgba(168,85,247,0.22)',
          borderLeftWidth: 3,
          color: 'rgba(232,210,255,0.98)',
          fontStyle: 'italic',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        title={selectedText}
      >
        {selectedText.length > 200 ? selectedText.slice(0, 200) + '…' : selectedText}
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); }
        }}
        placeholder="写下你的批注…（⌘/Ctrl + Enter 发送）"
        rows={3}
        className="w-full px-2.5 py-2 rounded-[8px] text-[12px] outline-none resize-none"
        style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.09)', color: 'var(--text-primary)' }}
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <CornerDownLeft size={9} className="inline mr-1" />
          ⌘/Ctrl + Enter
        </span>
        <button
          onClick={handleSubmit}
          disabled={submitting || !draft.trim()}
          className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.35)', color: 'rgba(216,180,254,0.97)' }}
        >
          {submitting ? <MapSpinner size={11} /> : <Send size={11} />}
          发送
        </button>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
