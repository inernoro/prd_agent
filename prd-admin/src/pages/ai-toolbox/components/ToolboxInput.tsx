import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { Send, Loader2 } from 'lucide-react';

const EXAMPLE_PROMPTS = [
  '帮我分析一下这个 PRD 文档的完整性',
  '生成一张科技感的产品封面图',
  '帮我写一篇关于 AI 产品的介绍文章',
  '提取这段文字中的缺陷信息并分类',
  '先分析 PRD，然后根据需求生成产品架构图',
];

export function ToolboxInput() {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, status } = useToolboxStore();

  const isProcessing = status === 'analyzing' || status === 'running';

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = async () => {
    if (!input.trim() || isProcessing) return;
    const message = input.trim();
    setInput('');
    await sendMessage(message);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleExampleClick = (example: string) => {
    setInput(example);
    textareaRef.current?.focus();
  };

  return (
    <div className="space-y-3">
      {/* Input area */}
      <div
        className="relative rounded-lg border transition-colors"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-default)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="告诉我你想做什么，我会调度最合适的 AI 专家来帮你完成..."
          disabled={isProcessing}
          rows={3}
          className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
          style={{ color: 'var(--text-primary)' }}
        />
        <div className="flex items-center justify-between px-3 pb-3">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            按 Enter 发送，Shift+Enter 换行
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!input.trim() || isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                处理中...
              </>
            ) : (
              <>
                <Send size={14} />
                发送
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Example prompts */}
      {status === 'idle' && (
        <div className="space-y-2">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            试试这些例子：
          </div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((example, index) => (
              <button
                key={index}
                onClick={() => handleExampleClick(example)}
                className="px-3 py-1.5 text-xs rounded-full border transition-colors hover:border-[var(--accent-primary)]"
                style={{
                  background: 'var(--bg-base)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-secondary)',
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
