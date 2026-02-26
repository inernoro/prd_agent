import React from 'react';
import type { VideoGenScene } from '@/services/contracts/videoAgent';

const SCENE_TYPE_LABELS: Record<string, string> = {
  intro: '开场',
  concept: '概念',
  steps: '步骤',
  code: '代码',
  comparison: '对比',
  diagram: '图表',
  summary: '总结',
  outro: '结尾',
};

interface ScriptPreviewProps {
  scenes: VideoGenScene[];
  totalDuration: number;
}

export const ScriptPreview: React.FC<ScriptPreviewProps> = ({ scenes, totalDuration }) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{scenes.length} 个镜头</span>
        <span>总时长 {(totalDuration / 60).toFixed(1)} 分钟</span>
      </div>

      <div className="space-y-2">
        {scenes.map((scene) => (
          <div
            key={scene.index}
            className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-1"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {SCENE_TYPE_LABELS[scene.sceneType] || scene.sceneType}
              </span>
              <span className="text-sm font-medium">{scene.topic}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {scene.durationSeconds.toFixed(1)}s
              </span>
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2">{scene.narration}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
