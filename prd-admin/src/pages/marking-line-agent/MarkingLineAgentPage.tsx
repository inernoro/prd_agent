import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Factory, Sparkles } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { getMarkingLineDiagramStreamUrl } from '@/services/real/markingLineAgent';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';

export function MarkingLineAgentPage() {
  const navigate = useNavigate();
  const [brief, setBrief] = useState('');
  const [modelLine, setModelLine] = useState<string | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [thinkingBuf, setThinkingBuf] = useState('');

  const streamUrl = useMemo(() => getMarkingLineDiagramStreamUrl(), []);

  const {
    phase,
    phaseMessage,
    typing,
    isStreaming,
    start,
    abort,
    reset,
  } = useSseStream({
    url: streamUrl,
    method: 'POST',
    onEvent: {
      model: (raw: unknown) => {
        const d = raw as { model?: string; platform?: string; modelGroupName?: string };
        const parts = [d.model, d.platform].filter(Boolean);
        setModelLine(parts.length > 0 ? parts.join(' · ') : null);
      },
      thinking: (raw: unknown) => {
        const d = raw as { text?: string };
        if (d.text) setThinkingBuf((p) => p + d.text);
      },
    },
    onDone: () => {
      setThinkingOpen(false);
    },
  });

  const handleGenerate = useCallback(async () => {
    setModelLine(null);
    setThinkingBuf('');
    setThinkingOpen(true);
    reset();
    await start({ body: { brief: brief.trim() } });
  }, [brief, reset, start]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-token-nested">
      <header className="shrink-0 surface mx-3 mt-3 px-4 py-2.5 flex flex-wrap items-center gap-3 rounded-2xl">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-token-secondary transition-opacity hover:opacity-90"
          aria-label="返回"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #64748b, #475569)' }}
          >
            <Factory size={14} color="white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-token-primary">赋码产线</div>
            <div className="text-[11px] text-token-muted font-mono truncate max-w-[min(100vw-12rem,42rem)]">
              {modelLine ?? '等待模型调度…'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        {isStreaming && (
          <button
            type="button"
            onClick={() => abort()}
            className="px-3 py-1.5 rounded-lg text-[12px] surface-inset text-token-secondary hover:opacity-90"
          >
            中止
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 flex flex-col gap-3 px-3 py-3 mx-0">
        <div className="shrink-0 surface rounded-2xl p-4">
          <label className="block text-[12px] text-token-muted mb-2">产线 / 工位 / 采集点描述</label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={5}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[13px] text-token-primary outline-none focus:border-white/20"
            placeholder="示例：四通道进料，裹包机内瓶码 x4、箱码 x1，龙门剔除校验 x1，爬坡后尾箱计数，末端箱码垛工位…"
            disabled={isStreaming}
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isStreaming || !brief.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium surface-action-accent disabled:opacity-40"
            >
              <Sparkles size={14} />
              生成示意图
            </button>
            <span className="text-[11px] text-token-muted">输出为 Markdown，可含 Mermaid；风格对齐常见工业培训白底示意图。</span>
          </div>
        </div>

        <div className="shrink-0">
          <SsePhaseBar phase={phase} message={phaseMessage} />
        </div>

        {thinkingBuf.length > 0 && (
          <details
            className="shrink-0 surface rounded-xl px-3 py-2"
            open={thinkingOpen}
            onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-[12px] text-token-muted select-none">思考过程</summary>
            <pre className="mt-2 text-[11px] text-token-secondary whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {thinkingBuf}
            </pre>
          </details>
        )}

        <div
          className="flex-1 surface rounded-2xl p-4 min-h-0"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          <div className="text-[12px] text-token-muted mb-2">生成结果</div>
          <StreamingText
            text={typing}
            streaming={isStreaming}
            markdown
            renderMarkdown={(c) => (
              <MarkdownContent content={c} className="text-[13px] leading-relaxed" />
            )}
            className="text-[13px] leading-relaxed text-token-primary"
          />
        </div>
      </div>
    </div>
  );
}

export default MarkingLineAgentPage;
