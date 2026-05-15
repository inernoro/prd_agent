import type { StateService } from './state.js';
import type { BuildProfile, BranchEntry } from '../types.js';
import { RELEASE_DEPLOY_MODE_PATTERN, isReleaseDeployMode } from './deploy-runtime.js';

/**
 * 2026-05-14 引入。
 *
 * 项目级 "运行 N 分钟后自动切发布版 / 自动停止" 调度。
 *
 * 与 CDS 系统级 SchedulerService（按 lastAccessedAt 的 idleTTL 降温）正交：
 * - SchedulerService = "没人访问就降温"，按 HTTP 访问刷新。
 * - AutoLifecycleService = "启动满 N 分钟就处理"，按 BranchEntry.lastReadyAt 计时。
 *
 * 两者可同时启用，本服务在 SchedulerService 之前执行，因为停止动作走的是普通
 * containerService.stop 路径，不会和热度状态机冲突。
 *
 * 设计原则：
 * - 计时锚点用 `lastReadyAt`（容器进入 running 状态时打戳）。HTTP 流量不参与，
 *   避免长连接、轮询、自动健康检查永远刷新计时器。
 * - 只在 status === 'running' 时计时。其他状态（building / starting / error / idle / stopping）
 *   都跳过，不会"在异常态等到 N 分钟后再处理"。
 * - 任何一次成功执行后会写一条 activity log，让用户能在分支日志面板看到时间线。
 * - 容错：单个 branch 处理失败不影响其他 branch；下一 tick 重试。
 */

export interface AutoLifecycleConfig {
  /** tick 间隔秒。默认 30。生产环境跑 30~60 都合理。 */
  tickIntervalSeconds?: number;
  /** 调试用：禁用整个服务。Project 字段不读，永远 no-op。 */
  enabled?: boolean;
}

export interface AutoLifecycleDeps {
  stateService: StateService;
  /** 真正执行容器停止。注入而非直接 import ContainerService 是为了方便测试。 */
  stopBranch: (branchId: string) => Promise<void>;
  /** 注入时钟，方便测试。生产用 Date.now()。 */
  clock?: { now(): number };
}

// release 模式分类走 services/deploy-runtime.ts 这个 SSOT，与
// routes/branches.ts 的 summarizeBranchDeployRuntime 共用同一份正则。

/**
 * 给定 profile，找一个看起来像"发布版"的 deployMode id。找不到返回 null —— 跳过该 profile。
 * 优先 modeId 命中（更稳），其次 label 命中。
 */
function findReleaseDeployMode(profile: BuildProfile): string | null {
  const modes = profile.deployModes || {};
  for (const [modeId] of Object.entries(modes)) {
    if (RELEASE_DEPLOY_MODE_PATTERN.test(modeId)) return modeId;
  }
  for (const [modeId, mode] of Object.entries(modes)) {
    if (mode?.label && RELEASE_DEPLOY_MODE_PATTERN.test(mode.label)) return modeId;
  }
  return null;
}

/**
 * 判断 auto-publish 是否已经"收敛"——即没有任何还能切到发布版却仍跑源码的 profile。
 *
 * 2026-05-14 Codex review P2 修复收敛语义：
 * 老实现要求"所有 profile 都是 release"。但混合工程里常有纯源码 sidecar /
 * infra profile（deployModes 里压根没有 release 模式），它永远变不成 release，
 * 于是 branchIsAllRelease 永远 false → auto-publish 每到阈值就停一次、永不收敛。
 *
 * 正确语义：**只看"有 release 模式可切"的 profile**。
 *  - profile 没有任何 release-like deployMode（findReleaseDeployMode 返回 null）
 *    → 它本来就切不动，不算阻塞项，跳过。
 *  - profile 有 release 模式但当前生效模式不是 release → 还有事可做，未收敛。
 *  - 所有"可切"的 profile 都已经是 release，或者根本没有可切的 profile
 *    → 收敛，不再触发 auto-publish。
 */
function branchAutoPublishConverged(
  branch: BranchEntry,
  profiles: BuildProfile[],
  projectDefaults: Record<string, string> | undefined,
): boolean {
  for (const profile of profiles) {
    // 这个 profile 压根没有 release 模式可切 —— 不是阻塞项，跳过。
    if (!findReleaseDeployMode(profile)) continue;

    const override = branch.profileOverrides?.[profile.id]?.activeDeployMode;
    // projectDefault 必须和 container.ts 的 resolveEffectiveProfile 一样做
    // 有效性校验 —— 只有 '' 或 deployModes 里真实存在的 mode 才采纳，否则
    // 视为无效、回退到 profile.activeDeployMode，避免两处对"生效模式"判定
    // 不一致导致 auto-publish 误触发 / 漏触发。
    const rawProjectDefault = projectDefaults?.[profile.id];
    const projectDefaultValid =
      typeof rawProjectDefault === 'string' &&
      (rawProjectDefault === '' || !!profile.deployModes?.[rawProjectDefault]);
    const projectDefault = projectDefaultValid ? rawProjectDefault : undefined;
    const effectiveMode = override ?? projectDefault ?? profile.activeDeployMode ?? '';
    const modeLabel = effectiveMode ? profile.deployModes?.[effectiveMode]?.label : undefined;
    // 可切的 profile 还没切到 release → 未收敛。
    if (!effectiveMode || !isReleaseDeployMode(effectiveMode, modeLabel)) return false;
  }
  // 没有任何"可切但未切"的 profile → 收敛。
  return true;
}

export class AutoLifecycleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly enabled: boolean;
  private readonly clock: { now(): number };
  private running = false;

  constructor(
    private readonly deps: AutoLifecycleDeps,
    config?: AutoLifecycleConfig,
  ) {
    this.tickIntervalMs = Math.max(5, config?.tickIntervalSeconds ?? 30) * 1000;
    this.enabled = config?.enabled !== false;
    this.clock = deps.clock || { now: () => Date.now() };
  }

  start(): void {
    if (!this.enabled) return;
    if (this.timer) return;
    // 启动时延后一拍跑首次 tick，避免和其他启动任务争锁。
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[auto-lifecycle] tick failed:', (err as Error).message);
      });
    }, this.tickIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref?: () => void }).unref!();
    }
    console.log(`[auto-lifecycle] started (tick=${Math.round(this.tickIntervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return; // 上一拍还没跑完，跳过这拍
    this.running = true;
    try {
      const { stateService } = this.deps;
      const projects = stateService.getProjects();
      for (const project of projects) {
        const autoPublishMin = Number(project.autoPublishAfterMinutes) || 0;
        const autoStopMin = Number(project.autoStopAfterMinutes) || 0;
        if (autoPublishMin <= 0 && autoStopMin <= 0) continue;

        const profiles = stateService.getBuildProfilesForProject(project.id);
        const projectDefaults = project.defaultDeployModes;

        // 2026-05-14 Codex review P2 修复：deploy / auto-build / webhook 等
        // headless 路径直接 `svc.status='running'` + 分支状态，**不一定**走
        // reconcileBranchStatus()，导致 lastReadyAt 永远不被打戳，本调度器
        // 过滤条件 `b.lastReadyAt` 会把这些分支永久跳过。
        //
        // 这里做集中式防御性回填，两种情况都重新打戳并跳过本拍
        // （不立刻动作，保证至少跑满一个完整周期）：
        //   (a) running 但缺 lastReadyAt —— headless 首次部署。
        //   (b) running 但 lastReadyAt 早于 lastStoppedAt —— 分支被
        //       auto-stop/手动/调度器停过又经 deploy/auto-build 重启，
        //       旧 ready 戳是上一轮的陈旧值。若不刷新，下一拍会按上一轮
        //       的 age 立刻把刚重启的容器又 auto-stop/auto-publish 掉。
        //       （2026-05-14 Codex review P2 "Refresh stale ready timestamps"）
        // 代价是 headless 路径计时最多晚一个 tick（默认 30s），对分钟级
        // 策略可接受；好处是覆盖当前 + 未来任何 running 转移路径，无需逐处埋点。
        const runningBranches = stateService.getAllBranches()
          .filter(b => b.projectId === project.id && b.status === 'running');
        let backfilled = false;
        for (const b of runningBranches) {
          const readyMs = b.lastReadyAt ? Date.parse(b.lastReadyAt) : NaN;
          const stoppedMs = b.lastStoppedAt ? Date.parse(b.lastStoppedAt) : NaN;
          const stale =
            !b.lastReadyAt ||
            !Number.isFinite(readyMs) ||
            (Number.isFinite(stoppedMs) && readyMs <= stoppedMs);
          if (stale) {
            b.lastReadyAt = new Date(this.clock.now()).toISOString();
            backfilled = true;
          }
        }
        if (backfilled) stateService.save();

        const branches = runningBranches.filter(b => b.lastReadyAt);
        if (branches.length === 0) continue;

        for (const branch of branches) {
          const readyMs = Date.parse(branch.lastReadyAt!);
          if (!Number.isFinite(readyMs) || readyMs <= 0) continue;
          const ageSec = Math.floor((this.clock.now() - readyMs) / 1000);

          // ── Auto-publish ───────────────────────────────────────────
          // 已收敛（所有"可切到发布版"的 profile 都已是 release）的分支不再触发，
          // 避免纯源码 sidecar / infra profile 让分支被反复无意义重启。
          if (autoPublishMin > 0 && ageSec >= autoPublishMin * 60) {
            if (!branchAutoPublishConverged(branch, profiles, projectDefaults)) {
              try {
                await this.applyAutoPublish(branch, profiles, autoPublishMin);
                continue; // 切完发布版后停下；下次 ready 再走 auto-stop 计时
              } catch (err) {
                console.error(`[auto-lifecycle] auto-publish "${branch.id}" failed:`, (err as Error).message);
              }
            }
          }

          // ── Auto-stop ───────────────────────────────────────────────
          if (autoStopMin > 0 && ageSec >= autoStopMin * 60) {
            // 2026-05-14 Cursor Bugbot review (Medium)：types.ts / PR 描述
            // 承诺"autoPublish 先行（先切发布版），autoStop 在新的 ready
            // 计时上再起效"。若 autoStopMin < autoPublishMin，auto-stop 会
            // 抢在 auto-publish 之前停掉分支，违背该承诺。这里显式让位：
            // auto-publish 开着且尚未收敛时，跳过本次 auto-stop，等
            // auto-publish 在 autoPublishMin 到点后先切发布版（停 + 换模式）
            // → 重启后新 ready 计时 → 此时已收敛 → auto-stop 才接管。
            if (autoPublishMin > 0 && !branchAutoPublishConverged(branch, profiles, projectDefaults)) {
              continue;
            }
            try {
              await this.applyAutoStop(branch, autoStopMin);
            } catch (err) {
              console.error(`[auto-lifecycle] auto-stop "${branch.id}" failed:`, (err as Error).message);
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 把分支的所有 profile override 翻到 release 模式，然后停止容器。
   * 不直接重新拉起 —— 用户下一次访问会被 auto-build 路径以新模式构建。
   * 这样实现避免和 deploy SSE 路由耦合，复用 wake 机制。
   */
  private async applyAutoPublish(
    branch: BranchEntry,
    profiles: BuildProfile[],
    minutes: number,
  ): Promise<void> {
    const { stateService, stopBranch } = this.deps;
    // 2026-05-14 Codex review P2：先只"计算"要切哪些 profile，**不写**
    // profileOverrides。否则 stopBranch 在远端失败 throw 时，override 已被
    // 持久化（且被 restoreRunning 的 save 落盘），分支仍跑旧容器但 state
    // 显示已是 release → 下一拍 branchAutoPublishConverged 误判收敛、不再
    // 重试（若 auto-stop 关着）。override 推迟到 stop 成功后再写。
    const plan: Array<{ profileId: string; releaseMode: string; label: string }> = [];
    for (const profile of profiles) {
      const releaseMode = findReleaseDeployMode(profile);
      if (!releaseMode) continue;
      plan.push({
        profileId: profile.id,
        releaseMode,
        label: `${profile.name || profile.id}=${releaseMode}`,
      });
    }
    if (plan.length === 0) {
      // 没有任何 profile 有 release 模式可切，记录一次 reason 后跳过。
      const fresh = stateService.getBranch(branch.id);
      if (fresh) {
        fresh.lastStopReason = `项目设置：${minutes} 分钟后自动切发布版，但没有可用的发布版模式（请到「项目设置→新分支默认运行模式」检查 deployModes）`;
        fresh.lastStopSource = 'system';
        stateService.save();
      }
      return;
    }

    // 先停。stopBranch 远端失败会 throw，此时 override 尚未写入，state 保持
    // 原样，caller 的 try/catch 接住后 tick 下一拍重试，不会误判收敛。
    await stopBranch(branch.id);

    // 停成功后再写 override —— 下次访问 auto-build 会以 release 模式构建。
    const switchedModes: string[] = [];
    for (const item of plan) {
      const existing = stateService.getBranch(branch.id)?.profileOverrides?.[item.profileId];
      stateService.setBranchProfileOverride(branch.id, item.profileId, {
        ...(existing || {}),
        activeDeployMode: item.releaseMode,
      });
      switchedModes.push(item.label);
    }

    // 重新读出 branch（stopBranch 可能改了状态），打 reason。
    const fresh = stateService.getBranch(branch.id);
    if (fresh) {
      fresh.lastStoppedAt = new Date(this.clock.now()).toISOString();
      fresh.lastStopReason = `项目设置：启动满 ${minutes} 分钟，自动切到发布版（${switchedModes.join(', ')}），下次访问会以发布模式重新构建`;
      fresh.lastStopSource = 'system';
      stateService.save();
      try {
        stateService.appendActivityLog(fresh.projectId, {
          type: 'stop',
          branchId: fresh.id,
          branchName: fresh.branch,
          actor: 'auto-lifecycle',
          note: fresh.lastStopReason,
        });
      } catch { /* 辅助信息，失败不影响 */ }
    }
  }

  private async applyAutoStop(branch: BranchEntry, minutes: number): Promise<void> {
    const { stateService, stopBranch } = this.deps;
    await stopBranch(branch.id);
    const fresh = stateService.getBranch(branch.id);
    if (fresh) {
      fresh.lastStoppedAt = new Date(this.clock.now()).toISOString();
      fresh.lastStopReason = `项目设置：启动满 ${minutes} 分钟，自动停止（节省资源）`;
      fresh.lastStopSource = 'system';
      stateService.save();
      try {
        stateService.appendActivityLog(fresh.projectId, {
          type: 'stop',
          branchId: fresh.id,
          branchName: fresh.branch,
          actor: 'auto-lifecycle',
          note: fresh.lastStopReason,
        });
      } catch { /* */ }
    }
  }
}
