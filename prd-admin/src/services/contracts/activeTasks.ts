/**
 * 任务台 —— 前后端契约。
 *
 * 与后端 ActiveTaskShared.ToDto / BuildTeamBoardAsync 一一对应。
 * 排序、标签、阈值一律由后端算好下发，前端不重算一遍，否则同一个判断会分裂成两份各自漂移。
 */

export const ActiveTaskState = {
  Active: 'active',
  Standby: 'standby',
  Done: 'done',
  Dropped: 'dropped',
} as const;
export type ActiveTaskStateValue = (typeof ActiveTaskState)[keyof typeof ActiveTaskState];

export const ActiveTaskSource = {
  Manual: 'manual',
  Assigned: 'assigned',
  ImPaste: 'im_paste',
  Defect: 'defect',
  PmTask: 'pm_task',
} as const;

export const ActiveTaskSourceLabels: Record<string, string> = {
  manual: '自己加的',
  assigned: '派的',
  im_paste: '从聊天粘贴',
  defect: '缺陷池',
  pm_task: '项目任务',
};

export interface ActiveTaskDto {
  id: string;
  userId: string;
  userDisplayName?: string | null;
  title: string;
  note?: string | null;
  state: ActiveTaskStateValue;
  orderKey: number;
  /** 什么时候要（可选）。刻意不是「预估耗时」——那个一有就会长出估准度。 */
  dueAt?: string | null;
  /** 「今天」「明天」「周五」「昨天要的」——后端算好，前端不重算 */
  dueLabel?: string | null;
  overdue: boolean;
  elapsedSeconds: number;
  /** 做了多久的人话，如「3 小时」。刻意不给秒 —— 精确到秒的计时是监工。 */
  elapsedLabel: string;
  startedAt?: string | null;
  running: boolean;
  blocked: boolean;
  blockedOn?: string | null;
  blockedSeconds: number;
  blockedLabel: string;
  source: string;
  sourceRefType?: string | null;
  sourceRefId?: string | null;
  assignedBy?: string | null;
  assignedByName?: string | null;
  assignedAt?: string | null;
  doneAt?: string | null;
  /** 做成了什么样 —— 结案时留的那句话，历史的全部价值在这里 */
  closingNote?: string | null;
  dropReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MyActiveTasks {
  /** 实心圆那条 */
  active: ActiveTaskDto | null;
  /** 下面待做的，按顺序 */
  standby: ActiveTaskDto[];
  /** 做完的（含放下的） */
  history: ActiveTaskDto[];
  displayName: string;
  serverNow: string;
}

export type TeamStatus = 'running' | 'blocked' | 'empty' | 'silent';

export interface TeamPerson {
  userId: string;
  displayName: string;
  status: TeamStatus;
  /** 一句话：在做什么 / 卡住了在等谁 / 没活了 / 还没说在做什么 */
  task: string;
  /** 队列里堆了多少件 —— 负载，不是绩效 */
  standbyCount: number;
  assignedByName?: string | null;
  blockedSeconds: number;
  /** 卡够 blockedEscalateMinutes 了吗 —— 后端算好下发，前端别自己拿阈值再算一遍 */
  escalated: boolean;
}

export interface ClosedItem {
  id: string;
  who?: string | null;
  title: string;
  closingNote?: string | null;
  doneAt?: string | null;
}

export interface TeamBoard {
  headline: string;
  /** 有几个人需要看一下 */
  needsYou: number;
  /** 堆到几件算多，后端配置 */
  heavyStackThreshold: number;
  people: TeamPerson[];
  recentlyClosed: ClosedItem[];
  serverNow: string;
}

export interface HistorySummary {
  headline: string;
  doneCount: number;
  droppedCount: number;
}

export interface ActiveTaskHistory {
  days: number;
  items: ActiveTaskDto[];
  summary: HistorySummary;
  serverNow: string;
}

export interface AssignableMember {
  userId: string;
  displayName: string;
  username: string;
  standbyCount: number;
  currentTitle?: string | null;
  busy: boolean;
  /** 「没活了」/「堆 5 件」—— 派活前看一眼，别往已经堆满的人身上加 */
  stackHint?: string | null;
}

export interface ActiveTaskBoardSettings {
  id: string;
  anonymousMode: 'masked' | 'full' | 'headline';
  anonymousEnabled: boolean;
  blockedEscalateMinutes: number;
  heavyStackThreshold: number;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface PublicBoard {
  mode: string;
  board?: TeamBoard;
  headline?: string;
  serverNow?: string;
}

// ── 建议（和派活是两码事：提了不会变成任务，等收件人自己吸取）──

export interface TaskSuggestion {
  id: string;
  text: string;
  fromUserId: string;
  fromUserName?: string | null;
  state: 'pending' | 'absorbed' | 'dismissed';
  absorbedTaskIds: string[];
  emergenceTreeId?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface SuggestionInbox {
  items: TaskSuggestion[];
  /** 上次引用了哪几个知识库 —— 服务端记着，换台电脑也还在 */
  lastStoreIds: string[];
  lastExtraHint?: string | null;
}

export interface SuggestPerson {
  userId: string;
  displayName: string;
  username: string;
  standbyCount: number;
}

export interface KnowledgeStoreRef {
  id: string;
  name: string;
  description?: string | null;
}

/** AI 拆出来的一条候选任务 —— 还没入库，等人勾 */
export interface DraftTask {
  title: string;
  dueAt?: string | null;
  /** 哪个人提的（吸取建议时才有） */
  from?: string | null;
  /** 原文里哪句让它这么判的 */
  why?: string | null;
}

// ── 债务 ───────────────────────────────────

/**
 * 一条工程债务。
 *
 * 正文（title / status / closeCondition）是仓库 doc/debt.*.md 推过来的快照；
 * 归属与状态（owner / state / convertedTaskIds）是任务台这一侧的事实。
 * 界面上别把这两半混成一个可编辑表单 —— 正文在这里改了也存不住。
 */
export interface DebtItem {
  id: string;
  /** 稳定标识，形如 platform.active-tasks#15 */
  key: string;
  /** 台账模块，如 platform.active-tasks */
  module: string;
  /** 台账表格里的编号 */
  num: number;
  title: string;
  status?: string | null;
  /** 什么条件下该补 */
  closeCondition?: string | null;
  /** 台账文件在仓库里的路径 */
  sourcePath: string;
  ownerUserId?: string | null;
  ownerUserName?: string | null;
  /** 是不是我认领的 */
  mine: boolean;
  /** open / claimed / converted / closed */
  state: string;
  /** 转成了哪几条任务 */
  convertedTaskIds: string[];
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一块债务看板。
 *
 * 分清两种数：headline / total / mineCount / unclaimedCount 是**整块看板**的事实，
 * 不跟着 module / mineOnly 走；items 才是筛过的那几条，个数看 shownCount。
 * 混成一个的后果：开「只看我的」时结论句会说「其余都有人管了」，而实际还有一百多条没人管。
 */
export interface DebtBoard {
  /** 一句话结论，不是三个数字让人自己算 */
  headline: string;
  total: number;
  mineCount: number;
  unclaimedCount: number;
  /** 当前筛选之后列出了几条 */
  shownCount: number;
  items: DebtItem[];
  modules: string[];
}
