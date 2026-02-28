export type SceneType =
  | "intro"
  | "concept"
  | "steps"
  | "code"
  | "comparison"
  | "diagram"
  | "summary"
  | "outro";

export interface SceneData {
  index: number;
  topic: string;
  narration: string;
  visualDescription: string;
  durationSeconds: number;
  durationInFrames: number;
  sceneType: SceneType;
  /** AI 生成的背景图 URL（可选，有则渲染为场景背景） */
  backgroundImageUrl?: string;
}

export interface VideoData {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: SceneData[];
}
