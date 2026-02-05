import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { ArrowLeft, Loader2, Check, AlertCircle, RotateCcw, Copy } from 'lucide-react';
import { useState } from 'react';

export function ToolRunner() {
  const { selectedItem, runStatus, runOutput, runError, backToGrid, setView } = useToolboxStore();
  const [copied, setCopied] = useState(false);

  if (!selectedItem) return null;

  const isRunning = runStatus === 'running';
  const isCompleted = runStatus === 'completed';
  const isFailed = runStatus === 'failed';

  const handleCopy = async () => {
    if (!runOutput) return;
    await navigator.clipboard.writeText(runOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRunAgain = () => {
    setView('detail');
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={selectedItem.name}
        icon={<span className="text-lg">{selectedItem.icon}</span>}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              返回列表
            </Button>
            {(isCompleted || isFailed) && (
              <Button variant="primary" size="sm" onClick={handleRunAgain}>
                <RotateCcw size={14} />
                再次运行
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        {/* Status bar */}
        <GlassCard className="p-4 flex items-center gap-3">
          {isRunning && (
            <>
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />
              <span style={{ color: 'var(--text-primary)' }}>正在执行...</span>
            </>
          )}
          {isCompleted && (
            <>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: 'var(--status-success)/20' }}
              >
                <Check size={14} style={{ color: 'var(--status-success)' }} />
              </div>
              <span style={{ color: 'var(--status-success)' }}>执行完成</span>
            </>
          )}
          {isFailed && (
            <>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: 'var(--status-error)/20' }}
              >
                <AlertCircle size={14} style={{ color: 'var(--status-error)' }} />
              </div>
              <span style={{ color: 'var(--status-error)' }}>执行失败</span>
            </>
          )}

          {/* Copy button */}
          {runOutput && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopy}
              className="ml-auto"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制结果'}
            </Button>
          )}
        </GlassCard>

        {/* Output */}
        <GlassCard className="flex-1 min-h-0 p-4 overflow-auto">
          {runError ? (
            <div
              className="p-4 rounded-lg"
              style={{ background: 'var(--status-error)/10', color: 'var(--status-error)' }}
            >
              <div className="font-medium mb-2">错误信息</div>
              <div className="text-sm">{runError}</div>
            </div>
          ) : runOutput ? (
            <div className="prose prose-sm max-w-none" style={{ color: 'var(--text-primary)' }}>
              <pre
                className="whitespace-pre-wrap font-sans text-sm leading-relaxed"
                style={{ color: 'var(--text-primary)' }}
              >
                {runOutput}
                {isRunning && (
                  <span
                    className="inline-block w-2 h-4 ml-1 animate-pulse"
                    style={{ background: 'var(--accent-primary)' }}
                  />
                )}
              </pre>
            </div>
          ) : isRunning ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-center">
                <Loader2
                  size={24}
                  className="animate-spin mx-auto mb-2"
                  style={{ color: 'var(--text-muted)' }}
                />
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  等待响应...
                </div>
              </div>
            </div>
          ) : null}
        </GlassCard>
      </div>
    </div>
  );
}
