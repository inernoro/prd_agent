import type { IntentResult } from '@/services';
import { Lightbulb, Target, Users } from 'lucide-react';

interface IntentDisplayProps {
  intent: IntentResult;
}

const INTENT_LABELS: Record<string, string> = {
  prd_analysis: 'PRD 分析',
  image_generation: '图片生成',
  content_creation: '内容创作',
  defect_management: '缺陷管理',
  multi_task: '复合任务',
  unknown: '通用任务',
};

export function IntentDisplay({ intent }: IntentDisplayProps) {
  const confidencePercent = Math.round(intent.confidence * 100);
  const confidenceColor =
    confidencePercent >= 80
      ? 'var(--status-success)'
      : confidencePercent >= 50
        ? 'var(--status-warning)'
        : 'var(--text-muted)';

  return (
    <div className="space-y-3">
      <h3
        className="text-sm font-medium flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
      >
        <Lightbulb size={14} style={{ color: 'var(--accent-primary)' }} />
        意图识别
      </h3>

      <div className="flex flex-wrap gap-4">
        {/* Primary Intent */}
        <div className="flex items-center gap-2">
          <Target size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            主要意图:
          </span>
          <span
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--accent-primary)/10', color: 'var(--accent-primary)' }}
          >
            {INTENT_LABELS[intent.primaryIntent] || intent.primaryIntent}
          </span>
        </div>

        {/* Confidence */}
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            置信度:
          </span>
          <div className="flex items-center gap-1">
            <div
              className="h-1.5 w-16 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-base)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${confidencePercent}%`,
                  background: confidenceColor,
                }}
              />
            </div>
            <span className="text-xs" style={{ color: confidenceColor }}>
              {confidencePercent}%
            </span>
          </div>
        </div>

        {/* Suggested Agents */}
        {intent.suggestedAgents.length > 0 && (
          <div className="flex items-center gap-2">
            <Users size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              调度专家:
            </span>
            <div className="flex gap-1">
              {intent.suggestedAgents.map((agent) => (
                <span
                  key={agent}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                >
                  {agent}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reasoning */}
      {intent.reasoning && (
        <div
          className="text-xs p-2 rounded"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
        >
          {intent.reasoning}
        </div>
      )}
    </div>
  );
}
