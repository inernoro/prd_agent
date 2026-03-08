import React from "react";
import { Audio } from "remotion";
import {
  TransitionSeries,
  linearTiming,
  springTiming,
} from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import type { VideoData, SceneData } from "./types";
import { GENERATED_SCENES } from "./scenes/generated";

import { IntroScene } from "./scenes/IntroScene";
import { ConceptScene } from "./scenes/ConceptScene";
import { StepsScene } from "./scenes/StepsScene";
import { CodeDemoScene } from "./scenes/CodeDemoScene";
import { ComparisonScene } from "./scenes/ComparisonScene";
import { DiagramScene } from "./scenes/DiagramScene";
import { SummaryScene } from "./scenes/SummaryScene";
import { OutroScene } from "./scenes/OutroScene";

/** 场景类型 → React 组件映射（硬编码兜底） */
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

/** 获取场景组件：优先 LLM 生成，兜底硬编码 */
function getSceneComponent(
  scene: SceneData
): React.FC<{ scene: SceneData; videoTitle: string }> {
  if (scene.hasGeneratedCode) {
    const generated = GENERATED_SCENES[scene.index];
    if (generated) {
      return generated as React.FC<{ scene: SceneData; videoTitle: string }>;
    }
  }
  return SCENE_MAP[scene.sceneType] ?? SCENE_MAP.concept;
}

/** 主视频序列 - TransitionSeries 丝滑转场 */
export const TutorialVideo: React.FC<VideoData> = ({
  title,
  scenes,
}) => {
  return (
    <TransitionSeries>
      {scenes.map((scene, i) => {
        const SceneComponent = getSceneComponent(scene);

        const elements: React.ReactNode[] = [];

        // 从第二个场景开始添加转场（交替使用不同效果）
        if (i > 0) {
          const pattern = i % 3;
          if (pattern === 0) {
            elements.push(
              <TransitionSeries.Transition
                key={`t-${scene.index}`}
                presentation={slide({ direction: i % 2 === 0 ? "from-right" : "from-left" })}
                timing={springTiming({ config: { damping: 14 }, durationInFrames: 25 })}
              />
            );
          } else if (pattern === 1) {
            elements.push(
              <TransitionSeries.Transition
                key={`t-${scene.index}`}
                presentation={fade()}
                timing={linearTiming({ durationInFrames: 20 })}
              />
            );
          } else {
            elements.push(
              <TransitionSeries.Transition
                key={`t-${scene.index}`}
                presentation={wipe({ direction: i % 2 === 0 ? "from-left" : "from-right" })}
                timing={linearTiming({ durationInFrames: 22 })}
              />
            );
          }
        }

        elements.push(
          <TransitionSeries.Sequence
            key={`s-${scene.index}`}
            durationInFrames={scene.durationInFrames}
          >
            <SceneComponent scene={scene} videoTitle={title} />
            {/* TTS 语音旁白 */}
            {scene.audioUrl && <Audio src={scene.audioUrl} />}
          </TransitionSeries.Sequence>
        );

        return elements;
      })}
    </TransitionSeries>
  );
};
