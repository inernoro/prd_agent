/**
 * Blue-Green Supervisor 类型 SSOT(B'.3+)
 *
 * 把 supervisor.ts 里跨 service 的 type 抽出来,避免循环 import。
 */
import type { ChildProcess } from 'node:child_process';
import type { ActiveColor } from './active-color-store.js';
import type { NginxUpstreamWriter } from './nginx-upstream-writer.js';
import type { IShellExecutor } from '../types.js';

export type SupervisorStage =
  | 'lock-acquire'
  | 'spawn-green'
  | 'wait-healthz'
  | 'nginx-write'
  | 'nginx-validate'
  | 'nginx-reload'
  | 'verify-target'
  | 'promote-green'
  | 'shutdown-blue'
  | 'commit-color'
  | 'done';

export type SupervisorEventStatus = 'running' | 'done' | 'error';

export interface SupervisorStageEvent {
  stage: SupervisorStage;
  status: SupervisorEventStatus;
  /** 自 switchActive 入口起算的相对时间 ms */
  elapsedMs: number;
  /** 中文人类可读消息(对运维友好) */
  message: string;
}

export interface SupervisorRollbackEvent {
  kind: 'rollback';
  reason: string;
  recoveredColor: ActiveColor;
  elapsedMs: number;
}

export interface SupervisorAutoDisableEvent {
  kind: 'auto-disable';
  reason: string;
  failures: number;
  elapsedMs: number;
}

export type SupervisorEvent =
  | SupervisorStageEvent
  | SupervisorRollbackEvent
  | SupervisorAutoDisableEvent;

export interface WaitHealthzOpts {
  timeoutMs: number;
  intervalMs?: number;
}

export interface WaitHealthzResult {
  ok: boolean;
  lastError?: string;
}

export interface PromoteResult {
  ok: boolean;
  error?: string;
}

export interface SupervisorDeps {
  shell: IShellExecutor;
  nginxWriter: typeof NginxUpstreamWriter;
  spawnDaemon: (opts: {
    color: ActiveColor;
    port: number;
    standby: true;
  }) => Promise<{ pid: number; child?: ChildProcess }>;
  killProcess: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** 探活旧 daemon pid,true=活着。supervisor 用来判断 SIGTERM 后是否需要 SIGKILL。 */
  isProcessAlive?: (pid: number) => boolean;
  waitForHealthz: (port: number, opts: WaitHealthzOpts) => Promise<WaitHealthzResult>;
  callPromote: (port: number) => Promise<PromoteResult>;
  callStandby?: (port: number) => Promise<{ ok: boolean }>;
  readActiveColor: () => ActiveColor | null;
  writeActiveColor: (color: ActiveColor) => Promise<void>;
  recordEvent: (event: SupervisorEvent) => void;
  cdsRoot: string;
  bluePort: number;
  greenPort: number;
  /** 分别对应 blue / green 的 daemon pid 文件查找(单测注入)。null 表示未找到。 */
  readDaemonPid?: (color: ActiveColor) => number | null;
  nginxConfPath: string;
  nginxAllowDir: string;
  verifyAdminTargetUrl?: (port: number) => string;
  /** 自动禁用阈值,默认 3。 */
  autoDisableThreshold?: number;
  /** 单测注入的当前时间戳 hooks(便于断言 elapsedMs)。 */
  now?: () => number;
}

export interface SwitchActiveOpts {
  fromColor?: ActiveColor;
  healthCheckTimeoutMs?: number;
  shutdownGracefulMs?: number;
  /** SIGTERM 后等多久才 SIGKILL,默认 30000ms。 */
  shutdownForceKillAfterMs?: number;
  onStage?: (stage: SupervisorStage, msg: string) => void;
}

export interface SwitchResult {
  ok: boolean;
  fromColor: ActiveColor;
  toColor: ActiveColor;
  fromPort: number;
  toPort: number;
  totalElapsedMs: number;
  rolledBack: boolean;
  failedStage?: SupervisorStage;
  error?: string;
  events: SupervisorEvent[];
}
