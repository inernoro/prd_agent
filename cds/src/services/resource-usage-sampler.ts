import type { StateService } from './state.js';
import type { BranchEntry } from '../types.js';
import { summarizeBuildActivity, type BuildActivitySummary } from './build-activity-tracker.js';

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

/** 采样只需要 CPU% 与内存字节，window 化依赖 ContainerService.getServiceStats。 */
interface ContainerStatLite {
  cpuPercent: number;
  memUsedBytes: number;
}
interface StatsProvider {
  getServiceStats(names: string[]): Promise<Map<string, ContainerStatLite>>;
}

const DEFAULT_INTERVAL_MS = Math.max(
  15_000,
  Number.parseInt(process.env.CDS_RESOURCE_SAMPLE_INTERVAL_MS || '', 10) || 45_000,
);

let latest: ResourceUsageSnapshot | null = null;

/** 路由 / 项目摘要读取最近一次采样快照（首个 tick 前为 null）。 */
export function getLatestResourceUsage(): ResourceUsageSnapshot | null {
  return latest;
}

/** 测试隔离用。 */
export function __setLatestResourceUsageForTests(snapshot: ResourceUsageSnapshot | null): void {
  latest = snapshot;
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
      if (svc.status !== 'running') continue;
      const stat = svc.containerName ? statsByContainer.get(svc.containerName) : undefined;
      const entry = ensure(projectId);
      entry.runningContainers++;
      if (stat) {
        entry.cpuPercent += stat.cpuPercent;
        entry.memUsedMB += stat.memUsedBytes / (1024 * 1024);
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
      const runningNames: string[] = [];
      for (const branch of branches) {
        for (const svc of Object.values(branch.services || {})) {
          if (svc.status === 'running' && svc.containerName) runningNames.push(svc.containerName);
        }
      }
      const statsByContainer = runningNames.length
        ? await this.containerService.getServiceStats(runningNames)
        : new Map<string, ContainerStatLite>();
      const nowMs = Date.now();
      const snapshot = computeResourceSnapshot(
        branches,
        statsByContainer,
        summarizeBuildActivity(nowMs),
        nowMs,
        this.intervalMs,
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
