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
}

export interface VideoData {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: SceneData[];
}
