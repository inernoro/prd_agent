/**
 * 控制面压力快照（2026-09-08 宿主过载复盘）。
 *
 * 「CDS 打不开」在既有日志里是盲区：HTTP 日志只记跑完的请求，探活监控卡死 24 小时
 * 也没有任何地方变红。本模块把会让 CDS 自己变慢或变哑的信号汇成一个对象挂在
 * /healthz 上，任何人 curl 一下就能回答「现在是不是宿主过载 / master 被饿 /
 * 哪个子系统停摆」，不必再翻五个端点拼图。
 *
 * 纯函数：所有来源通过入参注入，便于单测钉住每条告警的判据。
 */
import os from 'node:os';
import type { EventLoopLagSnapshot } from './event-loop-lag.js';
import type { BuildLoadPressure } from './build-gate.js';
import type { UptimeCycleHealth } from './uptime-monitor.js';
import type { WorkloadCgroupStatus } from './workload-cgroup.js';
import type { WebhookNoiseStats } from './github-webhook-noise.js';
import type { OffHostAuditBreakerState } from './offhost-audit-log.js';

export interface ControlPlanePressureInput {
  host?: { cores: number; loadAvg: [number, number, number]; totalMB: number; freeMB: number };
  eventLoop: EventLoopLagSnapshot;
  buildGate: { active: number; queued: number; max: number; load: BuildLoadPressure };
  uptimeMonitor: UptimeCycleHealth | null;
  workloadCgroup: WorkloadCgroupStatus;
  webhookNoise: WebhookNoiseStats | null;
  offhostAudit: OffHostAuditBreakerState | null;
}

export interface ControlPlanePressureWarning {
  level: 'warning' | 'critical';
  code: string;
  message: string;
}

export interface ControlPlanePressure {
  host: {
    cores: number;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    /** loadAvg1 / cores，1.0 = 刚好吃满 */
    loadRatio: number;
    memPercent: number;
  };
  eventLoop: EventLoopLagSnapshot;
  buildGate: ControlPlanePressureInput['buildGate'];
  uptimeMonitor: UptimeCycleHealth | null;
  workloadCgroup: WorkloadCgroupStatus;
  webhookNoise: WebhookNoiseStats | null;
  offhostAudit: OffHostAuditBreakerState | null;
  warnings: ControlPlanePressureWarning[];
  /** 有 critical 告警即 degraded；不影响 /healthz 的 ok（那是「进程活着」的语义） */
  degraded: boolean;
}

/** 事件循环 p99 超过这个值，master 自己已经在被饿。 */
export const EVENT_LOOP_LAG_WARN_MS = 200;
export const EVENT_LOOP_LAG_CRITICAL_MS = 1000;
/**
 * 宿主 load1 / 核数：1.0 起算饱和，1.3 起算过载。09-08 事故当天 18 核 load 26（1.46 倍）、
 * 15 分钟均值 20（1.14 倍）——1.3 把「事故态」与「忙但还能撑」分开，也与构建闸门的
 * 1.2 收紧线相邻（先收紧构建，再报过载）。
 */
export const HOST_LOAD_SATURATED_RATIO = 1.0;
export const HOST_LOAD_OVERLOADED_RATIO = 1.3;

export function readHostSample(): NonNullable<ControlPlanePressureInput['host']> {
  const cores = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1;
  const load = os.loadavg();
  return {
    cores,
    loadAvg: [load[0] || 0, load[1] || 0, load[2] || 0],
    totalMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeMB: Math.round(os.freemem() / (1024 * 1024)),
  };
}

export function collectControlPlanePressure(input: ControlPlanePressureInput): ControlPlanePressure {
  const host = input.host || readHostSample();
  const cores = Math.max(1, host.cores || 1);
  const loadRatio = Number((host.loadAvg[0] / cores).toFixed(2));
  const memPercent = host.totalMB > 0 ? Math.round(((host.totalMB - host.freeMB) / host.totalMB) * 100) : 0;
  const warnings: ControlPlanePressureWarning[] = [];

  if (loadRatio >= HOST_LOAD_OVERLOADED_RATIO) {
    warnings.push({ level: 'critical', code: 'host-overloaded', message: `宿主 load1 ${host.loadAvg[0].toFixed(1)} 是核数 ${cores} 的 ${loadRatio} 倍：控制面与容器、构建同权抢 CPU，页面会变慢` });
  } else if (loadRatio >= HOST_LOAD_SATURATED_RATIO) {
    warnings.push({ level: 'warning', code: 'host-saturated', message: `宿主 load1 ${host.loadAvg[0].toFixed(1)} 已达核数 ${cores}（${loadRatio} 倍）` });
  }
  if (memPercent >= 90) {
    warnings.push({ level: 'critical', code: 'memory-critical', message: `内存已用 ${memPercent}%` });
  }

  const lag = input.eventLoop;
  const p99 = Math.max(lag.current.p99Ms, lag.previous?.p99Ms || 0);
  if (lag.enabled && p99 >= EVENT_LOOP_LAG_CRITICAL_MS) {
    warnings.push({ level: 'critical', code: 'event-loop-stalled', message: `master 事件循环 p99 延迟 ${p99}ms：有同步阻塞或宿主饿 CPU，所有请求一起变慢` });
  } else if (lag.enabled && p99 >= EVENT_LOOP_LAG_WARN_MS) {
    warnings.push({ level: 'warning', code: 'event-loop-lagging', message: `master 事件循环 p99 延迟 ${p99}ms` });
  }

  if (input.buildGate.load.saturated) {
    warnings.push({ level: 'warning', code: 'build-throttled-by-load', message: `宿主过载，构建准入已收紧为 1 并发（${input.buildGate.active} 在跑 / ${input.buildGate.queued} 排队 / 上限 ${input.buildGate.max}）` });
  }

  if (input.uptimeMonitor && input.uptimeMonitor.stale) {
    const ago = input.uptimeMonitor.sinceLastCycleMs === null ? '从未完成' : `${Math.round(input.uptimeMonitor.sinceLastCycleMs / 60000)} 分钟前`;
    warnings.push({ level: 'critical', code: 'uptime-monitor-stale', message: `探活监控停摆：上一轮完成于 ${ago}，状态页数据不可信` });
  }

  if (input.workloadCgroup.enabled && !input.workloadCgroup.weightManaged) {
    warnings.push({ level: 'warning', code: 'workload-cgroup-unmanaged', message: input.workloadCgroup.reason });
  } else if (!input.workloadCgroup.enabled) {
    warnings.push({ level: 'warning', code: 'workload-cgroup-disabled', message: `托管容器未挂低权重 slice：${input.workloadCgroup.reason}` });
  }

  if (input.offhostAudit?.open) {
    warnings.push({ level: 'warning', code: 'offhost-audit-breaker-open', message: `离机审计外发熔断中（连续失败 ${input.offhostAudit.consecutiveFailures} 次，已跳过 ${input.offhostAudit.skippedWhileOpen} 条）` });
  }

  return {
    host: {
      cores,
      loadAvg1: Number(host.loadAvg[0].toFixed(2)),
      loadAvg5: Number(host.loadAvg[1].toFixed(2)),
      loadAvg15: Number(host.loadAvg[2].toFixed(2)),
      loadRatio,
      memPercent,
    },
    eventLoop: lag,
    buildGate: input.buildGate,
    uptimeMonitor: input.uptimeMonitor,
    workloadCgroup: input.workloadCgroup,
    webhookNoise: input.webhookNoise,
    offhostAudit: input.offhostAudit,
    warnings,
    degraded: warnings.some((w) => w.level === 'critical'),
  };
}
