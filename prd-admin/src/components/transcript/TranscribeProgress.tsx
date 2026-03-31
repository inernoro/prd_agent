import { useState, useEffect } from 'react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { api } from '@/services/api';
import { Loader2 } from 'lucide-react';

interface TranscribeProgressProps {
  runId: string;
  itemName: string;
  onCompleted?: () => void;
}

export function TranscribeProgress({ runId, itemName, onCompleted }: TranscribeProgressProps) {
  const [progress, setProgress] = useState(0);
  const [liveText, setLiveText] = useState('');

  const { phase, phaseMessage, start } = useSseStream({
    url: api.transcriptAgent.runProgress(runId),
    method: 'GET',
    phaseEvent: 'progress',
    onEvent: {
      progress: (data: unknown) => {
        const d = data as { progress?: number };
        setProgress(d.progress ?? 0);
      },
      typing: (data: unknown) => {
        setLiveText((data as { text?: string }).text ?? '');
      },
      done: () => {
        onCompleted?.();
      },
    },
    onError: (msg) => {
      // error state handled by useSseStream phase
      console.error('[TranscribeProgress]', msg);
    },
  });

  useEffect(() => {
    start();
  }, [runId]);

  // 阶段文字映射
  const stageLabel =
    progress < 10
      ? '排队中...'
      : progress < 30
        ? '正在下载音频...'
        : progress < 50
          ? '准备转录...'
          : progress < 80
            ? `转录中 (${progress}%)...`
            : progress < 100
              ? '整理结果...'
              : '转录完成';

  return (
    <div className="flex flex-col items-center justify-center h-full px-8">
      <div className="w-full max-w-md space-y-6">
        {/* 文件名 */}
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center">
            <Loader2 className="w-7 h-7 text-primary animate-spin" />
          </div>
          <p className="text-sm font-medium text-foreground">{itemName}</p>
          <p className="text-xs text-muted-foreground mt-1">{stageLabel}</p>
        </div>

        {/* 进度条 */}
        <div className="space-y-2">
          <div className="w-full bg-muted/60 rounded-full h-2 overflow-hidden">
            <div
              className="bg-primary/80 h-2 rounded-full transition-all duration-500 ease-out"
              style={{ width: `${Math.max(progress, 2)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{stageLabel}</span>
            <span>{progress}%</span>
          </div>
        </div>

        {/* 实时识别文字 */}
        {liveText && (
          <SseTypingBlock
            text={liveText}
            label="实时识别"
            maxHeight={120}
            tailChars={200}
          />
        )}

        {/* 阶段条 */}
        <SsePhaseBar phase={phase} message={phaseMessage || stageLabel} />
      </div>
    </div>
  );
}
