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

/**
 * 模板 = 风格库里的一种风格（分类与风格取自 Lemo-Opuscar 风格库：15 类 99 种）。
 * 同一个风格既能出视频也能出网页：视频按风格说明逐帧画出成片，网页按它的配色、字体与版式出页面。
 */
export interface QcTemplate {
  /** 风格编号，等于风格库的文件夹名（例如 sketchnote） */
  id: string;
  /** 中文名 */
  name: string;
  nameEn: string;
  /** 分类编号 01–15 */
  categoryId: string;
  /** 样片海报（缩略图地址） */
  posterUrl: string;
  /** 样片标题与一句话，用来让人预判这个风格长什么样 */
  film: string;
  line: string;
  durationSec: number;
  /** 生成时交给智能体的风格说明位置（风格库 styles/<id>/STYLE.md）；界面只显示来源，不显示原文 */
  promptRef: string;
  /** 需要用户自备生图工具的风格（人物要另外画），选中时提示 */
  needsImageTool?: boolean;
  /** 原型里用模板代码渲染分镜与成片的渲染器；没有时显示样片海报 */
  frame?: FrameKey;
}

export interface QcTemplateCategory {
  id: string;
  name: string;
  nameEn: string;
}

/** 风格库来源与授权，显示在风格详情底部 */
export interface QcTemplateSource {
  name: string;
  url: string;
  posterLicense: string;
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

/**
 * 产物：已经生成的视频或网页，用来在创作时回看——自己做过的、团队做过的，同一个风格做出来是什么样。
 * 只列已生成的成品；进行中、失败的任务在「我的作品」里管理。
 */
export interface QcAsset {
  id: string;
  /** 打开这个产物对应的任务 */
  runId: string;
  title: string;
  kind: OutputKind;
  templateId: string;
  /** 视频时长（秒） */
  durationSec?: number;
  /** 网页节数 */
  sections?: number;
  /** 谁做的；自己的写「我」 */
  ownerName: string;
  mine: boolean;
  publishStatus: PublishStatus;
  /** 已发布时的网页托管站点编号，用于定位 */
  siteId?: string;
  updatedAt: string;
}

export type AssetScope = 'mine' | 'team';

export interface CreateRunInput {
  kind: OutputKind;
  templateId: string;
  ask: string;
  attachmentIds: string[];
  title?: string;
}
