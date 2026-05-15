import type { StateService } from './state.js';
import type { BuildProfile, BranchEntry } from '../types.js';
import { isReleaseDeployMode } from './deploy-runtime.js';

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
  /**
   * 全自动重部署分支（停旧 + 按当前 profileOverrides 重建）。auto-publish 用：
   * 写完 release override 后调它，走会 resolveEffectiveProfile 的部署路径，
   * 分支以发布版重新起来。注入便于测试；缺省时 auto-publish 退化为只设
   * override + stop（不推荐，仅测试/降级）。
   */
  redeployBranch?: (branchId: string) => Promise<void>;
  /** 注入时钟，方便测试。生产用 Date.now()。 */
  clock?: { now(): number };
}

// release 模式分类走 services/deploy-runtime.ts 这个 SSOT，与
// routes/branches.ts 的 summarizeBranchDeployRuntime 共用同一份正则。

/**
 * 给定 profile，找一个看起来像"发布版"的 deployMode id。找不到返回 null —— 跳过该 profile。
 * 优先 modeId 命中（更稳），其次 label 命中。
 *
 * 2026-05-14 Cursor Bugbot Low 修复：判定一律走 SSOT isReleaseDeployMode
 * （services/deploy-runtime.ts），不再裸用 RELEASE_DEPLOY_MODE_PATTERN.test
 * 各测一遍——避免与 summarizeBranchDeployRuntime / branchAutoPublishConverged
 * 的"拼接后整体匹配"语义漂移。优先级仍保持：先扫一遍只看 modeId 命中，
 * 再扫一遍带 label 命中。
 */
function findReleaseDeployMode(profile: BuildProfile): string | null {
  const modes = profile.deployModes || {};
  for (const [modeId] of Object.entries(modes)) {
    if (isReleaseDeployMode(modeId)) return modeId;
  }
  for (const [modeId, mode] of Object.entries(modes)) {
    if (mode?.label && isReleaseDeployMode(modeId, mode.label)) return modeId;
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
export function branchAutoPublishConverged(
  branch: BranchEntry,
  profiles: BuildProfile[],
): boolean {
  for (const profile of profiles) {
    // 这个 profile 压根没有 release 模式可切 —— 不是阻塞项，跳过。
    if (!findReleaseDeployMode(profile)) continue;

    // 2026-05-14：项目默认运行模式已改为"仅建分支时拷贝"语义，运行期不再
    // 实时回退。生效模式与 resolveEffectiveProfile 保持一致：只看分支级
    // override（含建分支时拷贝进来的项目默认）+ baseline activeDeployMode。
    const override = branch.profileOverrides?.[profile.id]?.activeDeployMode;
    const effectiveMode = override ?? profile.activeDeployMode ?? '';
    const modeLabel = effectiveMode ? profile.deployModes?.[effectiveMode]?.label : undefined;
    // 可切的 profile 配置还没切到 release → 未收敛。
    if (!effectiveMode || !isReleaseDeployMode(effectiveMode, modeLabel)) return false;

    // 2026-05-14 真实态收敛：配置已是 release 还不够——必须容器**真的**
    // 以 release 跑起来才算收敛。否则 redeploy 静默失败（如 Codex P2 的
    // cluster 场景：远端按旧模式重建，master override 却是 release）会让
    // 收敛误判 true、auto-publish 永不重试，"自动切发布版"形同虚设。
    // 真相来源 = svc.deployedMode（容器实际启动时钉的模式）。
    const svc = branch.services?.[profile.id];
    // 旧数据兼容：deployedMode 字段引入前启动的容器没有该戳，无法判定
    // 真相 —— 退回"信任配置"（旧行为），不对存量分支制造无限重部署。
    if (svc?.deployedMode === undefined) continue;
    const deployedLabel = svc.deployedMode
      ? profile.deployModes?.[svc.deployedMode]?.label
      : undefined;
    // 已知真相：容器不是以 release 跑（或没在跑）→ 未收敛，继续重试。
    if (svc.status !== 'running' || !isReleaseDeployMode(svc.deployedMode, deployedLabel)) {
      return false;
    }
  }
  // 没有任何"可切但未切 / 配置 release 但容器没跟上"的 profile → 收敛。
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
          // 2026-05-14 Codex review P2 "Refresh readiness after redeploys
          // without stops"：未先停止就被 webhook/手动 redeploy 的 running
          // 分支，没有新的 lastStoppedAt，旧 lastReadyAt 幸存 → 刚 redeploy
          // 就按上一轮 age 触发 auto-stop/publish。补 lastDeployAt 作第二
          // 锚点（deploy worker 成功后 stampBranchTimestamp(lastDeployAt)）：
          // ready 戳早于最近一次 deploy 也视为陈旧、重新打戳。
          const deployMs = b.lastDeployAt ? Date.parse(b.lastDeployAt) : NaN;
          const stale =
            !b.lastReadyAt ||
            !Number.isFinite(readyMs) ||
            (Number.isFinite(stoppedMs) && readyMs <= stoppedMs) ||
            (Number.isFinite(deployMs) && readyMs <= deployMs);
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
            if (!branchAutoPublishConverged(branch, profiles)) {
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
            // 2026-05-14 "autoPublish 先行"让位规则。原实现只要 auto-publish
            // 开着且未收敛就 skip auto-stop —— 但若 autoStopMin < autoPublishMin
            // （如 stop=5 / publish=10，6 分钟时），auto-publish **还没到点**
            // 也不会 fire，auto-stop 却被无限期推迟到 publish 最终触发为止，
            // 违背用户"stop 阈值更小=先停"的预期（Cursor Bugbot Medium
            // 2026-05-14 二次反馈）。
            // 修正：只有当 auto-publish **本拍确实该动**（到点且未收敛）时
            // 才让位；auto-publish 阈值未到 → 没有待执行的 publish 要先行，
            // auto-stop 按自己的阈值正常生效。
            const autoPublishDuePending =
              autoPublishMin > 0 &&
              ageSec >= autoPublishMin * 60 &&
              !branchAutoPublishConverged(branch, profiles);
            if (autoPublishDuePending) {
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
   * 2026-05-14 用户决策的最终设计：全自动「停源码 → 重建发布版」（先后替换，
   * 同一分支同一时刻只有一个容器，无需人工点击）。
   *
   * 流程：
   *  1. 计算 plan —— 只挑「有 release 模式可切」且「当前生效模式还不是
   *     release」的 profile（已是 release 的不动，避免覆盖用户自选的
   *     release 模式 —— Cursor Bugbot Medium 修复）。
   *  2. 写 release override（先快照旧值，失败要回滚）。
   *  3. 调 redeployBranch —— 内部 HTTP 自调 /deploy，部署路由会
   *     resolveEffectiveProfile（读到刚写的 release override），自动停旧
   *     容器并以发布版重建。这是"自动切发布版"真正生效的关键，**不依赖**
   *     懒唤醒（懒唤醒路径用 raw profile 不 resolve override）。
   *  4. redeploy 失败 → 回滚 override + throw，caller 不 stamp 假成功，
   *     tick 下一拍因未收敛会重试。
   */
  private async applyAutoPublish(
    branch: BranchEntry,
    profiles: BuildProfile[],
    minutes: number,
  ): Promise<void> {
    const { stateService, stopBranch, redeployBranch } = this.deps;

    // 2026-05-14 Codex review P2 "Redeploy profiles that are already
    // configured for release"：plan 区分两类 entry——
    //  - switch：配置还不是 release → 写 release override 再重部署。
    //  - redeploy-only：配置**已是** release 但容器实际还跑源码（项目
    //    默认/手动切过 override / 之前冷启没 honor override），override
    //    不动（保留用户/项目选的具体 release 模式，Cursor Medium 约束），
    //    但仍要重部署让它真正生效。
    // 若把 redeploy-only 也 continue 掉，plan 会空 → 误记"没有可用发布版
    // 模式" + return → auto-publish 永不执行那次必要的重部署，永不收敛。
    const plan: Array<{ profileId: string; releaseMode: string; label: string; rewriteOverride: boolean }> = [];
    for (const profile of profiles) {
      const releaseMode = findReleaseDeployMode(profile);
      if (!releaseMode) continue;
      const override = branch.profileOverrides?.[profile.id]?.activeDeployMode;
      const effectiveMode = override ?? profile.activeDeployMode ?? '';
      const effectiveLabel = effectiveMode ? profile.deployModes?.[effectiveMode]?.label : undefined;
      const configIsRelease = !!effectiveMode && isReleaseDeployMode(effectiveMode, effectiveLabel);

      if (configIsRelease) {
        // 配置已是 release：看容器**真相**是否已对齐（与
        // branchAutoPublishConverged 同口径）。已对齐 → 跳过不打扰；
        // 未对齐（含旧数据无 deployedMode 戳=信任配置已对齐）→ redeploy-only。
        const svc = branch.services?.[profile.id];
        if (svc?.deployedMode === undefined) continue; // 旧数据：视为已对齐
        const deployedLabel = svc.deployedMode
          ? profile.deployModes?.[svc.deployedMode]?.label
          : undefined;
        const actuallyRelease =
          svc.status === 'running' && isReleaseDeployMode(svc.deployedMode, deployedLabel);
        if (actuallyRelease) continue; // 真已发布 → 不动
        plan.push({
          profileId: profile.id,
          releaseMode: effectiveMode, // 保留已选的具体 release 模式
          label: `${profile.name || profile.id}=${effectiveMode}(待生效)`,
          rewriteOverride: false,
        });
        continue;
      }

      plan.push({
        profileId: profile.id,
        releaseMode,
        label: `${profile.name || profile.id}=${releaseMode}`,
        rewriteOverride: true,
      });
    }
    if (plan.length === 0) {
      // 没有可切的 profile：要么全是无 release 模式的纯源码（记一次 reason
      // 提示用户），要么全部已是 release（收敛，静默返回不打扰）。
      if (branchAutoPublishConverged(branch, profiles)) return;
      const fresh = stateService.getBranch(branch.id);
      if (fresh) {
        fresh.lastStopReason = `项目设置：${minutes} 分钟后自动切发布版，但没有可用的发布版模式（请到「项目设置→新分支默认运行模式」检查 deployModes）`;
        fresh.lastStopSource = 'system';
        stateService.save();
      }
      return;
    }

    // 只有 switch 类（rewriteOverride）才动 override；redeploy-only 类
    // override 已是用户/项目选的 release，原样保留，仅靠重部署生效。
    const rewriteItems = plan.filter((p) => p.rewriteOverride);
    // 快照旧 override（仅被改写的），redeploy 失败时回滚（避免假收敛）。
    const prevOverrides = new Map<string, string | undefined>();
    for (const item of rewriteItems) {
      prevOverrides.set(item.profileId, branch.profileOverrides?.[item.profileId]?.activeDeployMode);
    }
    const restoreOverrides = (): void => {
      for (const item of rewriteItems) {
        const existing = stateService.getBranch(branch.id)?.profileOverrides?.[item.profileId];
        stateService.setBranchProfileOverride(branch.id, item.profileId, {
          ...(existing || {}),
          activeDeployMode: prevOverrides.get(item.profileId),
        });
      }
      stateService.save();
    };

    const switchedModes: string[] = plan.map((p) => p.label);
    for (const item of rewriteItems) {
      const existing = stateService.getBranch(branch.id)?.profileOverrides?.[item.profileId];
      stateService.setBranchProfileOverride(branch.id, item.profileId, {
        ...(existing || {}),
        activeDeployMode: item.releaseMode,
      });
    }
    stateService.save();

    if (redeployBranch) {
      // 全自动重部署：deploy 路由 resolveEffectiveProfile 会读到上面写的
      // release override，停旧容器 + 以发布版重建。失败回滚 override 并
      // 抛出，tick 下一拍重试。
      try {
        await redeployBranch(branch.id);
      } catch (err) {
        restoreOverrides();
        throw new Error(`auto-publish 重部署失败，已回滚 override: ${(err as Error).message}`);
      }
    } else {
      // 降级路径（仅测试 / 未注入 redeploy）：退回"停容器"老行为。
      try {
        await stopBranch(branch.id);
      } catch (err) {
        restoreOverrides();
        throw err;
      }
    }

    const fresh = stateService.getBranch(branch.id);
    if (fresh) {
      // 2026-05-14 Cursor Bugbot Medium 修复：redeploy 路径分支**重新跑
      // 起来了**（release 模式），不能再钉 lastStoppedAt——抽屉只要
      // lastStoppedAt 有值就弹琥珀色"上次停止"横幅，会在一个正在运行的
      // 分支上误报"已停止"。计时复位由 deploy 路由 stamp 的 lastDeployAt
      // （tick 陈旧检测 readyMs<=deployMs）兜底，这里无需 lastStoppedAt。
      // 仅降级 stopBranch 路径分支确实停了，才钉 stop 字段。
      const note = redeployBranch
        ? `项目设置：启动满 ${minutes} 分钟，已自动切到发布版并重新部署（${switchedModes.join(', ')}）`
        : `项目设置：启动满 ${minutes} 分钟，已切发布版并停止（${switchedModes.join(', ')}），下次访问重建`;
      if (!redeployBranch) {
        fresh.lastStoppedAt = new Date(this.clock.now()).toISOString();
        fresh.lastStopReason = note;
        fresh.lastStopSource = 'system';
      }
      stateService.save();
      try {
        stateService.appendActivityLog(fresh.projectId, {
          type: 'deploy',
          branchId: fresh.id,
          branchName: fresh.branch,
          actor: 'auto-lifecycle',
          note,
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
