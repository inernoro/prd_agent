import React from "react";
import type { SceneData } from "./types";

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

/** 单场景渲染组件 —— 用于分镜预览 */
export const SingleScene: React.FC<{ title: string; scene: SceneData }> = ({
  title,
  scene,
}) => {
  const SceneComponent = SCENE_MAP[scene.sceneType] ?? SCENE_MAP.concept;
  return <SceneComponent scene={scene} videoTitle={title} />;
};
