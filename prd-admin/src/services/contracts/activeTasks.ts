/**
 * 活动任务清单 —— 前后端契约。
 *
 * 字段与 prd-api 的 ActiveTaskShared.ToDto / BuildTeamBoardAsync 一一对应。
 * 结论句（headline / fuelLabel / bossMirror）一律由后端算好下发，前端不再重算一遍阈值，
 * 否则同一个判断会分裂成两份然后各自漂移。
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
export type ActiveTaskSourceValue = (typeof ActiveTaskSource)[keyof typeof ActiveTaskSource];

export const ActiveTaskSourceLabels: Record<string, string> = {
  manual: '自己加的',
  assigned: '委派',
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
  elapsedLabel: string;
  /** 服务端给的计时起点；前端据此本地续走秒表，不轮询 */
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
  /** 委派人 —— 「看得见委派的是谁」靠这两个字段 */
  assignedBy?: string | null;
  assignedByName?: string | null;
  assignedAt?: string | null;
  doneAt?: string | null;
  dropReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MyActiveTasks {
  active: ActiveTaskDto | null;
  standby: ActiveTaskDto[];
  history: ActiveTaskDto[];
  fuelLabel: string;
  fuelLevel: 'empty' | 'low' | 'ok';
  /** 老板此刻看到的你 —— 由操作自动生成的自述句 */
  bossMirror: string;
  serverNow: string;
}

export interface TeamPerson {
  userId: string;
  displayName: string;
  status: 'running' | 'blocked' | 'overrun' | 'idle';
  current: ActiveTaskDto | null;
  standbyCount: number;
  standbyMinutes: number;
  fuelLevel: 'empty' | 'low' | 'ok';
  fuelLabel: string;
  todaySeconds: number;
  todayLabel: string;
  doneTodayCount: number;
  assignedByName?: string | null;
}

export interface TeamAction {
  kind: string;
  userId: string;
  who: string;
  text: string;
  cta: string;
}

export interface TeamBoard {
  headline: string;
  kpis: { onDuty: number; blocked: number; lowFuel: number; overrun: number; doneWeek: number };
  people: TeamPerson[];
  actions: TeamAction[];
  silentMembers: { userId: string; displayName: string }[];
  settings: {
    anonymousMode: string;
    anonymousEnabled: boolean;
    lowFuelThreshold: number;
    blockedEscalateMinutes: number;
  };
  serverNow: string;
}

export interface HistoryLeak {
  name: string;
  seconds: number;
  times: number;
  label: string;
  note: string;
}

export interface HistorySummary {
  headline: string;
  doneCount: number;
  droppedCount: number;
  avgSeconds: number;
  avgLabel: string;
  idleSeconds: number;
  idleLabel: string;
  estimatedCount: number;
  accurateCount: number;
  overrunCount: number;
  leaks: HistoryLeak[];
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
}

export interface ActiveTaskBoardSettings {
  id: string;
  anonymousMode: 'masked' | 'full' | 'headline';
  anonymousEnabled: boolean;
  blockedEscalateMinutes: number;
  lowFuelThreshold: number;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface PublicBoard {
  mode: string;
  board?: TeamBoard;
  headline?: string;
  kpis?: TeamBoard['kpis'];
  serverNow?: string;
}
