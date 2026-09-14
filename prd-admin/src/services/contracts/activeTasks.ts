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
  estimateMinutes: number;
  elapsedSeconds: number;
  /** 做了多久的人话，如「3 小时」。刻意不给秒 —— 精确到秒的计时是监工。 */
  elapsedLabel: string;
  startedAt?: string | null;
  running: boolean;
  blocked: boolean;
  blockedOn?: string | null;
  blockedSeconds: number;
  blockedLabel: string;
  overrun: boolean;
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
  /** 有几个人要老板看一下 */
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
