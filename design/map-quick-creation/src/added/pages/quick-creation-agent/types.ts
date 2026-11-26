/** 快速创作：一份文档 + 一个模板 → 能播放（视频）或能浏览（网页）、能发布到网页托管的成品。 */

export type OutputKind = 'video' | 'web';

export type AttachmentKind = 'doc' | 'kb' | 'image';
export type AttachmentStatus = 'reading' | 'ready' | 'failed';

export interface QcAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  /** 例如 Markdown · 6.2 KB；知识库文档写所在空间 */
  meta: string;
  status: AttachmentStatus;
  /** 读出的字数（图片没有） */
  chars?: number;
  /** 读取中进度 0-100 */
  progress?: number;
  /** 失败原因：先说结果和下一步 */
  error?: string;
  /** 图片的用途说明 */
  note?: string;
  /** 回看用的正文摘录（稿件、知识库） */
  excerpt?: string;
}

export interface QcTemplate {
  id: string;
  kind: OutputKind;
  name: string;
  /** 一句话风格 */
  tagline: string;
  /** 适合讲什么 */
  goodFor: string;
  /** 画面渲染器 */
  frame: FrameKey;
}

export type FrameKey = 'visual-note' | 'whiteboard' | 'dark-notes' | 'guide-page' | 'card-digest';

export type StageStatus = 'done' | 'running' | 'pending' | 'failed';

export interface QcStage {
  key: string;
  label: string;
  status: StageStatus;
  /** 这一阶段在做什么，或做完后的结果 */
  detail?: string;
  /** 0-100，正在进行的阶段才有 */
  progress?: number;
}

export interface QcQueueInfo {
  position: number;
  ahead: number;
  running: number;
  capacity: number;
  /** 预计多少秒后开始 */
  startInSec: number;
}

export interface QcScene {
  index: number;
  title: string;
  /** 模板画面编号 */
  frameScene: number;
  startSec: number;
  caption: string;
  /** waiting 尚未开始；drawing 正在画；drawn 画好待配音；voicing 配音中；ready 已完成 */
  status: 'ready' | 'drawing' | 'drawn' | 'voicing' | 'failed' | 'waiting';
}

export interface QcKeyPoint {
  text: string;
  /** 视频：跳转秒数；网页：页面锚点 */
  atSec?: number;
  anchor?: string;
}

export interface QcWebSection {
  anchor: string;
  title: string;
  body: string;
}

export interface QcFailure {
  stageKey: string;
  /** 视频：第几幕；网页：第几节 */
  unitIndex?: number;
  /** 一句话说明，先说结果 */
  message: string;
  /** 已经保存下来的东西 */
  saved: string[];
  /** 可用的恢复动作 */
  actions: Array<'retry-unit' | 'retry-step' | 'skip-unit' | 'requeue'>;
}

export type PublishStatus = 'none' | 'publishing' | 'failed' | 'done';

export interface QcPublish {
  status: PublishStatus;
  siteTitle?: string;
  /** 网页托管里的站点编号，用于定位 */
  siteId?: string;
  error?: string;
  at?: string;
}

export type RunStatus = 'queued' | 'running' | 'failed' | 'done';

export interface QcRun {
  id: string;
  title: string;
  kind: OutputKind;
  templateId: string;
  ask: string;
  attachments: QcAttachment[];
  status: RunStatus;
  queue?: QcQueueInfo;
  stages: QcStage[];
  elapsedSec: number;
  /** 预计还需多少秒；给不出时为空 */
  remainSec?: number;
  /** 预计依据，例如「最近 20 次的中位数」 */
  estimateBasis?: string;
  failure?: QcFailure;
  scenes?: QcScene[];
  sections?: QcWebSection[];
  durationSec?: number;
  keyPoints?: QcKeyPoint[];
  voice?: string;
  /** 成片媒体（视频产出完成后才有）：播放器直接播放它，字幕与重点随 currentTime 切换 */
  media?: { url: string; mime: string };
  publish: QcPublish;
  createdAt: string;
  updatedAt: string;
}

export interface QcWork {
  runId: string;
  title: string;
  kind: OutputKind;
  templateId: string;
  status: RunStatus;
  publishStatus: PublishStatus;
  /** 第二行：状态补充，例如「第 4 幕配音超时」 */
  summary: string;
  updatedAt: string;
}

export interface CreateRunInput {
  kind: OutputKind;
  templateId: string;
  ask: string;
  attachmentIds: string[];
  title?: string;
}
