import { deploymentHostMemoryBudgetMB, deploymentHostPidBudget, setDeploymentPhaseHostUsage } from './deployment-phase-budget.js';
import type { StateService } from './state.js';
import type { BranchEntry } from '../types.js';
import { summarizeBuildActivity, type BuildActivitySummary } from './build-activity-tracker.js';
import { recordContainerSample } from './container-metrics-history.js';
import { serviceRuntimeRefs } from './service-runtime.js';

/**
 * 项目级资源占用采样（2026-06-23）。
 *
 * 用户痛点：「如果一个项目占用 CPU 过多，我能通过一个东西知道——目前就是一个
 * 不怎么用的项目在作死地反复构建」。本采样器周期性跑一次 `docker stats`，把每个
 * 运行容器的 CPU/内存按**项目**汇总，再叠加 build-activity-tracker 的构建频次，
 * 让资源面板一眼揪出 CPU 大户 / 频繁构建大户，并一键暂停。
 *
 * 单实例多项目共享一台机器（见 cross-project-isolation 规则）——谁在作死直接
 * 影响所有人，所以这是运维必备的可观测性。
 */

export interface ProjectResourceUsage {
  projectId: string;
  /** 该项目所有运行容器 CPU% 之和（单核 100%，多核可超 100）。 */
  cpuPercent: number;
  /** 该项目所有运行容器内存占用之和（MB）。 */
  memUsedMB: number;
  /** 正在运行的容器数。 */
  runningContainers: number;
  /** 近 1 小时构建次数（抖动型 CPU 杀手的核心信号）。 */
  recentBuilds1h: number;
  /** 近 24 小时构建次数。 */
  recentBuilds24h: number;
  /** 最近一次构建的 ISO 时间戳。 */
  lastBuildAt: string | null;
}

export interface ResourceUsageSnapshot {
  sampledAt: number;
  intervalMs: number;
  projects: ProjectResourceUsage[];
  totals: { cpuPercent: number; memUsedMB: number; runningContainers: number };
}

/**
 * 采样器自己只用 CPU% 与内存字节做项目汇总，但它拿到的是完整 stats——
 * 顺手把整帧喂给 container-metrics-history（2026-09-01）。
 * 以前这里把 net / limit 直接丢掉，导致「采了却没有历史」。
 */
interface ContainerStatLite {
  /** 容器短 ID：同名重建时会变，用来切断跨生命周期的速率差分。 */
  id?: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
  blockReadBytes?: number;
  blockWriteBytes?: number;
  pids?: number;
  pidsKnown?: boolean;
}
interface StatsProvider {
  getServiceStats(names: string[]): Promise<Map<string, ContainerStatLite>>;
  getRunningContainerNames?(): Promise<Set<string>>;
  getRunningContainerNamesSnapshot?(): Promise<Set<string> | null>;
}

const DEFAULT_INTERVAL_MS = Math.max(
  15_000,
  Number.parseInt(process.env.CDS_RESOURCE_SAMPLE_INTERVAL_MS || '', 10) || 45_000,
);

let latest: ResourceUsageSnapshot | null = null;
let observedRunningNames: ReadonlySet<string> | null = null;

/** 被动容量读取复用最后一次真实盘点；读取失败不能把既知活容器释放为零。 */
export function countReservedContainers(branches: ReadonlyArray<BranchEntry>): number {
  const names = new Set<string>();
  for (const branch of branches) {
    for (const [id, svc] of Object.entries(branch.services || {})) {
      if (['running', 'building', 'starting', 'restarting'].includes(svc.status)
        || (svc.containerName && observedRunningNames?.has(svc.containerName))) {
        names.add(svc.containerName || `${branch.id}::${id}`);
      }
      for (const runtime of serviceRuntimeRefs(svc).filter(runtime => runtime !== svc)) {
        if (!['idle', 'stopped', 'stopping'].includes(svc.status) || observedRunningNames?.has(runtime.containerName)) names.add(runtime.containerName);
      }
    }
  }
  return names.size;
}

/** 路由 / 项目摘要读取最近一次采样快照（首个 tick 前为 null）。 */
export function getLatestResourceUsage(): ResourceUsageSnapshot | null {
  return latest;
}

/** 测试隔离用。 */
export function __setLatestResourceUsageForTests(snapshot: ResourceUsageSnapshot | null): void {
  latest = snapshot;
  if (!snapshot) observedRunningNames = null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 纯函数：把分支列表 + docker stats 结果 + 构建频次聚合成项目级快照。
 * 抽出来便于单测（不依赖 docker / 定时器）。
 */
export function computeResourceSnapshot(
  branches: BranchEntry[],
  statsByContainer: Map<string, ContainerStatLite>,
  buildSummary: Map<string, BuildActivitySummary>,
  nowMs: number,
  intervalMs: number,
  actualRunningNames?: ReadonlySet<string>,
): ResourceUsageSnapshot {
  const byProject = new Map<string, ProjectResourceUsage>();
  const ensure = (projectId: string): ProjectResourceUsage => {
    let entry = byProject.get(projectId);
    if (!entry) {
      entry = {
        projectId,
        cpuPercent: 0,
        memUsedMB: 0,
        runningContainers: 0,
        recentBuilds1h: 0,
        recentBuilds24h: 0,
        lastBuildAt: null,
      };
      byProject.set(projectId, entry);
    }
    return entry;
  };

  for (const branch of branches) {
    const projectId = branch.projectId || 'default';
    for (const svc of Object.values(branch.services || {})) {
      for (const runtime of serviceRuntimeRefs(svc)) {
        if (actualRunningNames ? !actualRunningNames.has(runtime.containerName) : runtime !== svc || svc.status !== 'running') continue;
        const stat = runtime.containerName ? statsByContainer.get(runtime.containerName) : undefined;
        const entry = ensure(projectId);
        entry.runningContainers++;
        if (stat) {
          entry.cpuPercent += stat.cpuPercent;
          entry.memUsedMB += stat.memUsedBytes / (1024 * 1024);
        }
      }
    }
  }

  // 合并构建频次（含当前没有运行容器、但在反复构建的项目）。
  for (const [projectId, summary] of buildSummary.entries()) {
    const entry = ensure(projectId);
    entry.recentBuilds1h = summary.recentBuilds1h;
    entry.recentBuilds24h = summary.recentBuilds24h;
    entry.lastBuildAt = summary.lastBuildAt ? new Date(summary.lastBuildAt).toISOString() : null;
  }

  const projects = [...byProject.values()].map((p) => ({
    ...p,
    cpuPercent: round1(p.cpuPercent),
    memUsedMB: Math.round(p.memUsedMB),
  }));

  const totals = projects.reduce(
    (acc, p) => {
      acc.cpuPercent += p.cpuPercent;
      acc.memUsedMB += p.memUsedMB;
      acc.runningContainers += p.runningContainers;
      return acc;
    },
    { cpuPercent: 0, memUsedMB: 0, runningContainers: 0 },
  );
  totals.cpuPercent = round1(totals.cpuPercent);

  return { sampledAt: nowMs, intervalMs, projects, totals };
}

export class ResourceUsageSampler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly stateService: StateService,
    private readonly containerService: StatsProvider,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    // 立刻跑一次，避免首屏 null；之后周期采样。
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sampleOnce(): Promise<ResourceUsageSnapshot | null> {
    if (this.running) return latest;
    this.running = true;
    try {
      const branches = this.stateService.getAllBranches();
      const actualRunningNames = this.containerService.getRunningContainerNamesSnapshot
        ? await this.containerService.getRunningContainerNamesSnapshot() : await this.containerService.getRunningContainerNames?.();
      if (actualRunningNames === null) throw new Error('实际容器盘点未确认，保留已有资源占用');
      if (actualRunningNames) observedRunningNames = actualRunningNames;
      const runningNames = new Set<string>();
      for (const branch of branches) {
        for (const svc of Object.values(branch.services || {})) {
          for (const runtime of serviceRuntimeRefs(svc)) {
            if (runtime.containerName && (actualRunningNames ? actualRunningNames.has(runtime.containerName) : runtime === svc && svc.status === 'running')) runningNames.add(runtime.containerName);
          }
        }
      }
      const sampleNames = (deploymentHostMemoryBudgetMB() !== null || deploymentHostPidBudget() !== null) && actualRunningNames ? actualRunningNames : runningNames;
      const statsByContainer = sampleNames.size
        ? await this.containerService.getServiceStats([...sampleNames])
        : new Map<string, ContainerStatLite>();
      const nowMs = Date.now();
      if (actualRunningNames && sampleNames === actualRunningNames && sampleNames.size === statsByContainer.size) {
        const all = [...statsByContainer.values()];
        if (all.every(stat => Number.isFinite(stat.memUsedBytes) && stat.memUsedBytes >= 0)) {
          const pids = all.every(stat => stat.pidsKnown !== false && Number.isInteger(stat.pids) && stat.pids! >= 0)
            ? all.reduce((sum, stat) => sum + stat.pids!, 0) : undefined;
          setDeploymentPhaseHostUsage(all.reduce((sum, stat) => sum + stat.memUsedBytes / 1048576, 0), nowMs, this.intervalMs * 2, pids);
        }
      }
      // 同一帧同时供两处用：项目汇总（下面）与按容器的历史序列。
      // 这是全宿主唯一的常驻采集点，抽屉不开也在攒，所以「关掉抽屉丢历史」不再成立。
      for (const [containerName, stat] of statsByContainer) {
        recordContainerSample(containerName, {
          containerId: stat.id,
          cpuPercent: stat.cpuPercent,
          memUsedBytes: stat.memUsedBytes,
          memLimitBytes: stat.memLimitBytes ?? 0,
          netRxBytes: stat.netRxBytes ?? 0,
          netTxBytes: stat.netTxBytes ?? 0,
          blockReadBytes: stat.blockReadBytes ?? 0,
          blockWriteBytes: stat.blockWriteBytes ?? 0,
        }, nowMs);
      }
      const snapshot = computeResourceSnapshot(
        branches,
        statsByContainer,
        summarizeBuildActivity(nowMs),
        nowMs,
        this.intervalMs,
        actualRunningNames,
      );
      latest = snapshot;
      return snapshot;
    } catch (err) {
      // 采样失败保留上一次快照，避免面板闪空；docker 不可用时静默降级。
      // eslint-disable-next-line no-console
      console.warn(`[resource-usage] sample failed: ${(err as Error).message}`);
      return latest;
    } finally {
      this.running = false;
    }
  }
}
