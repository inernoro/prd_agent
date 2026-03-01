import React from "react";
import { Series } from "remotion";
import type { VideoData, SceneData } from "./types";

import { IntroScene } from "./scenes/IntroScene";
import { ConceptScene } from "./scenes/ConceptScene";
import { StepsScene } from "./scenes/StepsScene";
import { CodeDemoScene } from "./scenes/CodeDemoScene";
import { ComparisonScene } from "./scenes/ComparisonScene";
import { DiagramScene } from "./scenes/DiagramScene";
import { SummaryScene } from "./scenes/SummaryScene";
import { OutroScene } from "./scenes/OutroScene";

/** 场景类型 → React 组件映射 */
const SCENE_MAP: Record<
  string,
  React.FC<{ scene: SceneData; videoTitle: string }>
> = {
  intro: IntroScene,
  concept: ({ scene }) => <ConceptScene scene={scene} />,
  steps: ({ scene }) => <StepsScene scene={scene} />,
  code: ({ scene }) => <CodeDemoScene scene={scene} />,
  comparison: ({ scene }) => <ComparisonScene scene={scene} />,
  diagram: ({ scene }) => <DiagramScene scene={scene} />,
  summary: ({ scene }) => <SummaryScene scene={scene} />,
  outro: OutroScene,
};

/** 主视频序列 - 数据驱动渲染 */
export const TutorialVideo: React.FC<VideoData> = ({
  title,
  scenes,
}) => {
  return (
    <Series>
      {scenes.map((scene) => {
        const SceneComponent =
          SCENE_MAP[scene.sceneType] ?? SCENE_MAP.concept;

        return (
          <Series.Sequence
            key={scene.index}
            durationInFrames={scene.durationInFrames}
          >
            <SceneComponent scene={scene} videoTitle={title} />
          </Series.Sequence>
        );
      })}
    </Series>
  );
};
