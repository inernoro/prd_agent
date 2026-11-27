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

/** 排队看板上的一条：谁的哪份稿件，正在生成的写已运行与预计还需，排队的写预计多久后开始 */
export interface QcQueueEntry {
  ownerName: string;
  title: string;
  kind: OutputKind;
  elapsedSec?: number;
  remainSec?: number;
  startInSec?: number;
}

export interface QcQueueInfo {
  position: number;
  ahead: number;
  running: number;
  capacity: number;
  /** 预计多少秒后开始 */
  startInSec: number;
  /** 正在生成的任务（团队同时生成上限内） */
  runningItems?: QcQueueEntry[];
  /** 排在你前面的任务，按先后 */
  aheadItems?: QcQueueEntry[];
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
  /** 开工时定下的目标时长（秒）：分镜按它写，服务端校验脚本总时长落在目标的 ±15% */
  targetSec?: number;
  /** 成片的可播放形态：画面代码 + 配音 + 时间轴。播放与导出都在用户浏览器里完成，服务器不渲染视频 */
  bundle?: QcPlayBundle;
  /** 试看：先做片头和第 1 幕，满意再做完 */
  trial?: QcTrial;
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

/**
 * 对话起稿：不知道选什么时，和快速创作聊清楚再开工。
 * 创作简报是开工条件的唯一判定源，由服务端按对话和输入框里的选择结构化填写；前端只展示，不从聊天文字里猜。
 */
export type BriefFieldKey = 'output' | 'content' | 'style' | 'audience' | 'duration';

export interface QcBriefField {
  key: BriefFieldKey;
  label: string;
  /** 必填项齐了才能开工；建议项不挡开工，有默认值 */
  required: boolean;
  value?: string;
  /** 从哪来：对话、稿件、手动选择、默认值 */
  source?: 'chat' | 'doc' | 'pick' | 'default';
}

export interface QcBrief {
  fields: QcBriefField[];
  /** 必填项都齐了 */
  ready: boolean;
  /** 还缺的必填项名称 */
  missing: string[];
  /** 作品标题（取稿件标题或对话里说的主题） */
  title?: string;
  /** 两三行复述，用在「准备好了」卡和任务里 */
  summary?: string;
}

/** 推荐的风格：附一句为什么适合 */
export interface QcStyleRec {
  templateId: string;
  reason: string;
}

/** 分镜脚本的一幕：画面一句、旁白一句；秒数按配音语速（约每分钟 250 字）由服务端算出 */
export interface QcScriptScene {
  index: number;
  visual: string;
  narration: string;
  seconds?: number;
}

/**
 * 试看：先只做片头和第 1 幕（带配音），约占整片一成的时间。最费资源的是智能体写画面代码，
 * 方向不对时在这里拦下，只白做一成。等用户确认时任务暂停、不占排队名额；满意就从断点做完，试看的两幕沿用。
 */
export interface QcTrial {
  status: 'making' | 'ready' | 'approved';
  /** 试看包含几幕（片头 + 第 1 幕） */
  scenes: number;
  /** 试看的时长（秒） */
  seconds: number;
  /** 确认后还要做几幕 */
  restScenes: number;
  /** 确认后预计还要多久（分钟，下限与上限） */
  restMin: [number, number];
}

/** 成片时长：自动（服务端按内容估算）或指定目标 */
export type DurationChoice = 'auto' | 60 | 180 | 300 | 600;

/** 开工前的时长与耗时预估，由服务端给出；前端只显示，不自己算 */
export interface QcEstimate {
  choice: DurationChoice;
  /** 分镜按这个时长写（秒） */
  targetSec: number;
  /** 选「自动」时会取多长 */
  autoSec: number;
  /** 有稿件时：全文照念需要多长 */
  fullSec?: number;
  chars?: number;
  /** 预计幕数 */
  scenes: number;
  /** 预计生成耗时（分钟，下限与上限） */
  generateMin: [number, number];
  /** 一句话依据，例如「稿件 1,840 字，全文念完约 7 分钟，自动取约 3 分钟讲重点」 */
  basis: string;
  /** 默认要不要先试看（目标 3 分钟及以上默认要） */
  trialDefault: boolean;
  /** 试看预计多久出来（分钟，下限与上限） */
  trialMin: [number, number];
}

/** 成片 = 一个可播放的网页包：画面代码（Canvas / WebGL，按时间逐帧画）+ 配音 + 时间轴 */
export interface QcPlayBundle {
  /** 画面代码入口：导出 renderFrame(t) 的模块，同一个 t 永远画出同一帧 */
  codeUrl: string;
  /** 配音与音乐混好的音轨 */
  audioUrl: string;
  /** 每幕起止时间、字幕与重点 */
  timelineUrl: string;
  width: number;
  height: number;
  fps: number;
  /** 整包大小（字节），用来说明比视频文件省多少 */
  bytes: number;
}

export interface QcChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** 可以直接点的回答（只在最新一条助手消息上显示） */
  quickReplies?: string[];
  recommendations?: QcStyleRec[];
  /** 必填条件都齐了：显示「准备好了」卡 */
  ready?: boolean;
  /** 想开工但条件不够：这条消息说明还缺什么 */
  missingNote?: boolean;
  /** 开工前的分镜脚本（确认后正式排队） */
  script?: QcScriptScene[];
  /** 这版脚本按多长写的（秒） */
  scriptTargetSec?: number;
}

export interface QcBriefSession {
  id: string;
  messages: QcChatMessage[];
  brief: QcBrief;
  /** 这次对话实际用的模型（来自网关返回） */
  model?: { model: string; platform: string };
  /** 简报当前采用的风格（对话里说「第二个」选定时由服务端给出，输入框里的风格按钮随之同步） */
  styleId?: string;
  /** 简报当前采用的时长（说「长一点」或在对话里选了时长时由服务端给出，输入框里的时长随之同步） */
  durationChoice?: DurationChoice;
}

/** 每次对话都带上输入框里的当前选择，服务端据此更新简报 */
export interface BriefContext {
  kind: OutputKind;
  templateId?: string;
  attachmentIds: string[];
  duration?: DurationChoice;
}

export interface CreateRunInput {
  kind: OutputKind;
  templateId: string;
  ask: string;
  attachmentIds: string[];
  title?: string;
  /** 从对话起稿时带上简报编号；内容可以只来自对话 */
  briefId?: string;
  /** 已确认的分镜脚本（跳过时为空） */
  script?: QcScriptScene[];
  /** 目标时长：自动或指定；服务端按它决定幕数与旁白字数 */
  duration?: DurationChoice;
  /** 先试看片头和第 1 幕，满意再做完 */
  trial?: boolean;
}
