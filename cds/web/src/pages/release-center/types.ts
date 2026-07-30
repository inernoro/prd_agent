/**
 * 发布中心的传输面类型。全部对齐 `GET /api/releases/center` 与
 * `GET /api/releases/targets` 的实际响应；v2 新增字段一律 optional ——
 * 跑旧构建的 CDS 不下发它们，前端必须退化而不是白屏。
 */

import type { ReleaseDoraMetrics } from '@/lib/releaseDora';
import type { ReleaseEtaEstimate } from '@/lib/releaseEta';
import type { ReleaseRunProgressLike } from '@/lib/releaseSteps';
import type { ReleaseCommitRail, ReleaseTargetCommitPosition } from '@/lib/releaseRail';
import type { EnvironmentGroupLike } from '@/lib/releaseEnvironments';

export type ReleaseExecutionMode = 'existing-script' | 'generated-compose' | 'generated-static';

export interface ReleaseStrategy {
  mode: ReleaseExecutionMode;
  command?: string;
  composeFile?: string;
  composeProject?: string;
  buildCommand?: string;
  artifactDirectory?: string;
  publicDirectory?: string;
  detectedFrom?: string[];
}

export interface ReleaseStrategyCandidate {
  mode: ReleaseExecutionMode;
  label: string;
  description: string;
  confidence: 'high' | 'medium' | 'manual';
  strategy: ReleaseStrategy;
  requirements: string[];
}

export interface ReleaseStrategyDiscovery {
  projectIdentity: { projectId: string; projectSlug: string; repository?: string };
  branchId: string;
  branchName: string;
  recommendedMode: ReleaseExecutionMode | null;
  candidates: ReleaseStrategyCandidate[];
  warnings: string[];
}

export interface ReleaseTarget {
  id: string;
  projectId: string;
  name: string;
  type: string;
  isEnabled: boolean;
  lifecycle?: 'active' | 'archived';
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  environment?: 'production' | 'staging' | 'other';
  isCanonical?: boolean;
  projectIdentity?: { projectId: string; projectSlug: string; repository?: string };
  strategy?: ReleaseStrategy;
  ssh?: {
    host: string;
    port: number;
    user: string;
    privateKeyRef: string;
    appPath: string;
    deployCommand: string;
    rollbackCommand?: string;
    healthcheckUrl: string;
  };
}

export interface ReleaseLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
}

export interface ReleaseRun {
  releaseId: string;
  projectId: string;
  branchId: string;
  commitSha: string;
  artifact: {
    type: string;
    commitSha: string;
    branchId?: string;
    branchName?: string;
    previewUrl?: string;
    imageDigest?: string;
    artifactPath?: string;
  };
  targetId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  previousReleaseId?: string;
  rollbackOf?: string;
  rollbackTargetReleaseId?: string;
  /** 后端一等公民步骤模型。存量 run 没有这个字段，步骤条会退化成通用骨架。 */
  progress?: ReleaseRunProgressLike;
  logs: ReleaseLogEntry[];
}

export interface ReleaseHealthProbe {
  status: 'healthy' | 'failed' | 'unknown';
  url: string;
  checkedAt: string;
  responseTimeMs?: number;
  message?: string;
  /** 近 24 小时可用率。字段可缺省：没开存活监控时它就是没有，不是 0。 */
  availability24h?: number | null;
  sampleCount24h?: number;
  upCount24h?: number;
  avgLatencyMs24h?: number | null;
}

/** 一次发布所用 commit 的展示元信息。台账里没有的 sha 不会出现在 map 里。 */
export interface ReleaseCommitMeta {
  sha: string;
  subject?: string;
  authorName?: string;
  committedAt?: string;
}

/** 「另一个环境跑着更新的一版，可以原样提升过来」。 */
export interface ReleasePromotionCandidate {
  fromTargetId: string;
  fromTargetName: string;
  fromEnvironment: string;
  commitSha: string;
  releaseId: string;
  /** 对方比我新几个提交。本环境从未发布过时为 null（无从比较，但确实可提升）。 */
  aheadCount: number | null;
  fromHealthStatus: string;
  fromReleasedAt: string;
  /**
   * 现在点下去能不能真的发出去。false = 来源那一版已经不是它所在分支的 tip，
   * 而发布恒按分支当前版本构建 + 版本钳制，必然被拒。旧后端不下发时按 true 处理。
   */
  executable?: boolean;
  blockedReason?: string;
}

export interface CenterRow {
  target: ReleaseTarget;
  currentVersion: string;
  currentCommit: string;
  latestRun?: ReleaseRun;
  lastReleasedAt?: string;
  health?: ReleaseHealthProbe;
  healthStatus: string;
  lastOperator?: string;
  canRollback: boolean;
  successfulRuns?: ReleaseRun[];
  rollbackDefaultReleaseId?: string;
  releaseEstimate?: ReleaseEtaEstimate;
  /** 该环境在主干流水轴上的落点。算不出时后端给 null + reason，绝不补 0。 */
  commitPosition?: ReleaseTargetCommitPosition;
  promotion?: ReleasePromotionCandidate;
  /** 本目标近 30 天的 DORA；顶层 dora 是全项目聚合，两者不互相替代。 */
  dora?: ReleaseDoraMetrics;
}

export interface CenterResponse {
  rows: CenterRow[];
  runs: ReleaseRun[];
  dora?: ReleaseDoraMetrics;
  commitMeta?: Record<string, ReleaseCommitMeta>;
  commitRail?: ReleaseCommitRail;
  environments?: EnvironmentGroupLike[];
}

export interface RemoteHostOption {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  fingerprint: string;
  isEnabled: boolean;
}

export interface TargetsResponse {
  targets: ReleaseTarget[];
  archivedTargets: ReleaseTarget[];
  remoteHosts: RemoteHostOption[];
}

export interface ProjectLite {
  id: string;
  name: string;
  slug?: string;
}

export type WizardStep = 'server' | 'site' | 'scripts' | 'health';

export interface SiteDraft {
  id?: string;
  projectId: string;
  name: string;
  privateKeyRef: string;
  host: string;
  port: string;
  user: string;
  sitePath: string;
  publicUrl: string;
  healthPath: string;
  rollbackCommand: string;
  deployCommand: string;
  healthcheckUrl: string;
  strategyMode: ReleaseExecutionMode;
  composeFile: string;
  composeProject: string;
  buildCommand: string;
  artifactDirectory: string;
  publicDirectory: string;
  detectedFrom: string[];
  isCanonical: boolean;
  environment: 'production' | 'staging' | 'other';
}

/** 发布前检查结果。与 ReleaseService.preflight 的响应对齐。 */
export interface ReleasePreflightResult {
  ok: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
    blocking: boolean;
  }>;
}

export interface BranchOption {
  id: string;
  projectId: string;
  branch: string;
  commitSha?: string;
  githubCommitSha?: string;
  subject?: string;
  previewSlug?: string;
  status?: string;
  lastDeployAt?: string;
}

/** 定时发布规则（scheduled-jobs 的 release 动作）。 */
export interface ScheduledJobSummary {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: {
    type: 'manual' | 'interval' | 'daily';
    intervalMinutes?: number;
    timeOfDay?: string;
    timezone?: string;
  };
  actions?: Array<ScheduledJobActionSummary>;
  target?: ScheduledJobActionSummary;
  timeoutSeconds: number;
  retryCount: number;
  lastRunAt?: string;
  lastRunStatus?: string;
  nextRunAt?: string | null;
  consecutiveFailureCount?: number;
  autoDisabledAt?: string;
  autoDisabledReason?: string;
}

export interface ScheduledJobActionSummary {
  id?: string;
  name?: string;
  type: 'http' | 'command' | 'release';
  targetId?: string;
  source?: { kind: 'branch'; branchId: string } | { kind: 'promote'; fromTargetId: string };
  dryRun?: boolean;
  requireApproval?: boolean;
  rollbackOnFailure?: boolean;
  skipWhenUnchanged?: boolean;
  method?: string;
  url?: string;
  command?: string;
}

export interface ScheduledJobRunSummary {
  id: string;
  jobId: string;
  status: string;
  trigger: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  releaseId?: string;
  releaseStatus?: string;
}

/**
 * 发布目标的变更历史条目。字段对齐后端 release-target-history.ts 的
 * ReleaseTargetChange —— 变更明细在 `changes[]`（白名单字段的 before/after），
 * 不是一个 summary 字符串。接错形状的后果是这一栏永远只显示「配置更新」四个字。
 */
export interface ReleaseTargetFieldChange {
  path: string;
  /** 人话字段名，如「健康检查地址」。 */
  label: string;
  before?: string;
  after?: string;
}

export interface ReleaseTargetChange {
  id: string;
  targetId: string;
  at: string;
  actor?: string;
  reason?: string;
  kind: 'created' | 'updated' | 'archived';
  changes: ReleaseTargetFieldChange[];
}

export const RELEASE_CHANGE_KIND_LABELS: Record<ReleaseTargetChange['kind'], string> = {
  created: '创建',
  updated: '修改配置',
  archived: '归档',
};

export const RELEASE_TERMINAL_STATUSES = ['success', 'failed', 'rollback_success', 'rollback_failed'] as const;

export function isReleaseTerminal(status: string): boolean {
  return (RELEASE_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);
}

export function isReleaseFailed(status: string): boolean {
  return status === 'failed' || status === 'rollback_failed';
}
