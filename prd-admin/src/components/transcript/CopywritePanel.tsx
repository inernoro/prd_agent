import { useState, useEffect, useCallback } from 'react';
import { FileText, Loader2, Copy, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSseStream } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import type { TranscriptItem, TranscriptTemplate } from '@/services/contracts/transcriptAgent';

interface CopywritePanelProps {
  item: TranscriptItem;
  templates: TranscriptTemplate[];
}

export function CopywritePanel({ item, templates }: CopywritePanelProps) {
  const { createCopywrite, pollRun } = useTranscriptStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  // SSE progress stream
  const { phase, phaseMessage, start: startSse, reset: resetSse } = useSseStream({
    url: runId ? `/api/transcript-agent/runs/${runId}/progress` : '',
    method: 'GET',
    onEvent: {
      'progress': (data: unknown) => {
        const d = data as { progress?: number };
        setProgress(d.progress ?? 0);
      },
      'done': async () => {
        // Fetch final result after completion
        if (runId) {
          const r = await pollRun(runId);
          if (r?.result) {
            setResult(r.result);
            toast.success('文案生成完成');
          }
        }
        setGenerating(false);
      },
      'error': (data: unknown) => {
        setGenerating(false);
        const d = data as { error?: string };
        toast.error(d?.error ?? '生成失败');
      },
    },
  });

  const handleGenerate = useCallback(async () => {
    if (!selectedTemplateId) return;
    setGenerating(true);
    setResult('');
    setProgress(0);
    resetSse();

    const run = await createCopywrite(item.id, selectedTemplateId);
    if (run) {
      setRunId(run.id);
    } else {
      setGenerating(false);
    }
  }, [selectedTemplateId, item.id, createCopywrite, resetSse]);

  // Start SSE when runId changes
  useEffect(() => {
    if (runId && generating) {
      startSse({ url: `/api/transcript-agent/runs/${runId}/progress` });
    }
  }, [runId]);

  // Progress label based on percentage
  const progressLabel = progress < 30
    ? '准备模板...'
    : progress < 50
      ? '组织转录文本...'
      : progress < 90
        ? `AI 生成中 (${progress}%)...`
        : '整理结果...';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select
          className="px-3 py-2 text-sm rounded-lg bg-muted/40 border border-border outline-none focus:border-border transition-colors min-w-[140px]"
          value={selectedTemplateId}
          onChange={e => setSelectedTemplateId(e.target.value)}
        >
          <option value="">选择模板...</option>
          {templates.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <Button size="sm" onClick={handleGenerate} disabled={!selectedTemplateId || generating}>
          {generating
            ? <Loader2 className="w-4 h-4 animate-spin mr-1" />
            : <FileText className="w-4 h-4 mr-1" />}
          生成文案
        </Button>
      </div>

      {/* Generating: SSE progress */}
      {generating && (
        <GlassCard variant="subtle" padding="sm" className="rounded-lg">
          <SsePhaseBar phase={phase} message={phaseMessage || progressLabel} />
          {progress > 0 && (
            <div className="mt-2 w-full bg-muted/30 rounded-full h-1.5">
              <div
                className="bg-primary/60 h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </GlassCard>
      )}

      {/* Result display + actions */}
      {result && !generating && (
        <GlassCard variant="subtle" padding="md" className="rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              生成结果
            </span>
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={handleGenerate}
                title="重新生成"
              >
                <RefreshCw className="w-3 h-3" />
                重新生成
              </button>
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(result);
                  toast.success('已复制到剪贴板');
                }}
              >
                <Copy className="w-3 h-3" />
                复制
              </button>
            </div>
          </div>
          <pre className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
            {result}
          </pre>
          {/* Next step guidance */}
          <div className="mt-3 pt-2 border-t border-border/30 flex items-center gap-2 text-xs text-muted-foreground/60">
            <span>💡</span>
            <span>可以复制文案到文档中使用，或切换模板重新生成不同风格的文案</span>
          </div>
        </GlassCard>
      )}
    </div>
  );
}
