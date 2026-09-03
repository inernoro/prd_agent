/** 任务调度页与其派生视图逻辑共用的数据形状，对齐 cds/src/types.ts 的服务端契约。 */

export type ScheduleType = 'manual' | 'interval' | 'daily';
export type TargetType = 'http' | 'command' | 'release';
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ScheduledJobTarget {
  type: TargetType;
  method?: HttpMethod;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  command?: string;
  cwd?: string;
  // release 动作（定时发布）。本页这一轮只做「看得见 + 能启停 + 能看运行记录」，
  // 编辑表单在发布中心的「自动发布」页签落地；这些字段必须原样带回后端，
  // 否则用户在本页改个名字就会把发布配置整块抹掉。
  targetId?: string;
  source?: { kind: 'branch'; branchId: string } | { kind: 'promote'; fromTargetId: string };
  dryRun?: boolean;
  requireApproval?: boolean;
  rollbackOnFailure?: boolean;
  skipWhenUnchanged?: boolean;
}

export interface ScheduledJobAction extends ScheduledJobTarget {
  id: string;
  name?: string;
}

export interface ScheduledJob {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: { type: ScheduleType; intervalMinutes?: number; timeOfDay?: string; timezone?: string };
  target?: ScheduledJobTarget;
  actions?: ScheduledJobAction[];
  timeoutSeconds: number;
  retryCount: number;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
  nextRunAt?: string | null;
  /** 服务端投影的后续触发时刻。前端不自己按 schedule 推算，避免复制一份到期判定。 */
  nextRuns?: string[];
  consecutiveFailureCount?: number;
  autoDisabledAt?: string;
  autoDisabledReason?: string;
}

export interface ScheduledJobRunStep {
  index: number;
  name: string;
  type: TargetType;
  status: 'success' | 'failed' | 'skipped' | 'not-run';
  durationMs?: number;
  httpStatus?: number;
  exitCode?: number;
  error?: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  projectId: string;
  trigger: 'schedule' | 'manual' | 'push';
  status: RunStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  httpStatus?: number;
  log?: string;
  error?: string;
  steps?: ScheduledJobRunStep[];
}
