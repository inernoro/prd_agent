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
  /** TTS 生成的音频文件 URL（可选，有则作为场景旁白） */
  audioUrl?: string;
}

export interface VideoData {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: SceneData[];
  /** 是否启用 TTS 语音 */
  enableTts?: boolean;
}
