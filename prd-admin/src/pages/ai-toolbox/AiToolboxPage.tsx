import { useEffect } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { useToolboxStore } from '@/stores/toolboxStore';
import { Sparkles, History, RotateCcw } from 'lucide-react';
import { ToolboxInput } from './components/ToolboxInput';
import { ExecutionPlan } from './components/ExecutionPlan';
import { ArtifactCard } from './components/ArtifactCard';
import { IntentDisplay } from './components/IntentDisplay';
import { HistoryList } from './components/HistoryList';
import { Button } from '@/components/design/Button';

export default function AiToolboxPage() {
  const {
    status,
    intent,
    steps,
    artifacts,
    finalResponse,
    errorMessage,
    streamingContent,
    loadAgents,
    loadHistory,
    reset,
  } = useToolboxStore();

  useEffect(() => {
    loadAgents();
    loadHistory();
  }, [loadAgents, loadHistory]);

  const isActive = status !== 'idle';
  const isProcessing = status === 'analyzing' || status === 'running';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title="AI 百宝箱"
        icon={<Sparkles size={16} />}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          isActive && (
            <Button variant="secondary" size="sm" onClick={reset} disabled={isProcessing}>
              <RotateCcw size={14} />
              重新开始
            </Button>
          )
        }
      />

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Input & Execution */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {/* Input */}
          <GlassCard className="p-4">
            <ToolboxInput />
          </GlassCard>

          {/* Intent Display */}
          {intent && (
            <GlassCard className="p-4">
              <IntentDisplay intent={intent} />
            </GlassCard>
          )}

          {/* Execution Plan */}
          {steps.length > 0 && (
            <GlassCard className="flex-1 min-h-0 p-4 overflow-auto">
              <ExecutionPlan steps={steps} streamingContent={streamingContent} />
            </GlassCard>
          )}

          {/* Final Response */}
          {finalResponse && (
            <GlassCard className="p-4">
              <h3
                className="text-sm font-medium mb-2 flex items-center gap-2"
                style={{ color: 'var(--text-primary)' }}
              >
                <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} />
                执行结果
              </h3>
              <div
                className="prose prose-sm max-w-none"
                style={{ color: 'var(--text-secondary)' }}
                dangerouslySetInnerHTML={{ __html: formatMarkdown(finalResponse) }}
              />
            </GlassCard>
          )}

          {/* Error */}
          {errorMessage && (
            <GlassCard className="p-4" style={{ borderColor: 'var(--status-error)' }}>
              <div className="text-sm" style={{ color: 'var(--status-error)' }}>
                {errorMessage}
              </div>
            </GlassCard>
          )}
        </div>

        {/* Right: Artifacts & History */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-4">
          {/* Artifacts */}
          {artifacts.length > 0 && (
            <GlassCard className="p-4">
              <h3
                className="text-sm font-medium mb-3 flex items-center gap-2"
                style={{ color: 'var(--text-primary)' }}
              >
                生成成果
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                >
                  {artifacts.length}
                </span>
              </h3>
              <div className="space-y-2">
                {artifacts.map((artifact) => (
                  <ArtifactCard key={artifact.id} artifact={artifact} />
                ))}
              </div>
            </GlassCard>
          )}

          {/* History */}
          <GlassCard className="flex-1 min-h-0 p-4 overflow-auto">
            <h3
              className="text-sm font-medium mb-3 flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <History size={14} />
              历史记录
            </h3>
            <HistoryList />
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

function formatMarkdown(text: string): string {
  // Simple markdown to HTML conversion for display
  return text
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="max-w-full rounded" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br />');
}
