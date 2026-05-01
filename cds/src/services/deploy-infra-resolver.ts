/**
 * Deploy Infra Resolver — 决定 deploy 阶段需要启动哪些 infra service。
 *
 * 抽取自 cds/src/routes/branches.ts(Phase 2,2026-05-01)。
 * 抽出来的目的:让"哪些 infra 需要起"这件事变成纯函数,可单测,
 * 不需要拉一个完整的 Express + StateService + ContainerService 才能验。
 *
 * 决策两层(都在下面 computeRequiredInfra 里):
 *
 *   Layer 1 — 显式 dependsOn:
 *     遍历每个 BuildProfile.dependsOn,如果 dep 不是另一个 profile
 *     而是项目的 InfraService.id,就加进 required 集合。
 *
 *   Layer 2 — 兜底自动起(Phase 2):
 *     即使没声明 dependsOn,把项目下所有 *非 stopped* 且 *docker 实际未 running*
 *     的 infra 都加进 required 集合。原因:
 *       1. cdscli scan 生成的 yaml 通常不写 dependsOn(用户也不会手填)
 *       2. 应用通过项目级 customEnv 里的 ${MONGODB_URL} 引用 infra,
 *          不需要显式声明依赖,但 infra 必须 running 才能 DNS 解析
 *       3. mongo/redis 等 infra 无论如何都该跑,启动开销低
 *
 *   状态同步(Phase 2 关键修正):
 *     state 里 status==='running' 但 docker 实际 Exited 的情况
 *     (CDS 重启后 reconcile 来不及跑,或者用户 docker stop 了容器)也要补。
 *     通过 actualInfraState(从 ContainerService.discoverInfraContainers 得到)
 *     取真实运行状态,**以 docker 为准,不信 state**。
 *
 *     用户主动通过 API stop 的 infra,status='stopped',跳过。
 *
 *   Map key 必须用 containerName(全局唯一),不能用 svc.id。Phase 2 修过的
 *   跨项目 svc.id 撞 key 的 bug 就在这里。详见 container.ts:813 注释。
 */

import type { BuildProfile, InfraService } from '../types.js';

/** discoverInfraContainers 返回的 Map value 形状(container.ts 同步) */
export interface ActualInfraContainerState {
  running: boolean;
  containerName: string;
  serviceId: string;
}

/**
 * 计算 deploy 阶段需要启动的 infra service id 集合。
 *
 * @param profiles    本次 deploy 涉及的应用 BuildProfile(已过滤过 active 的)
 * @param projectInfra 项目下所有 InfraService(包含 stopped / running / error)
 * @param actualInfraState  ContainerService.discoverInfraContainers() 的结果,
 *                          key 是 docker containerName(全局唯一)
 * @returns 需要在 deploy 流程里 start 的 infra service id 集合
 *
 * 纯函数,无副作用。所有调用点见 git grep computeRequiredInfra。
 */
export function computeRequiredInfra(
  profiles: BuildProfile[],
  projectInfra: InfraService[],
  actualInfraState: Map<string, ActualInfraContainerState>,
): Set<string> {
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const requiredInfraIds = new Set<string>();

  // Layer 1 — 显式 dependsOn:profile 引用了 infra service id
  for (const profile of profiles) {
    for (const dep of profile.dependsOn || []) {
      if (!profileIds.has(dep) && projectInfra.some((service) => service.id === dep)) {
        requiredInfraIds.add(dep);
      }
    }
  }

  // Layer 2 — 兜底:项目下所有非 stopped 且 docker 实际未 running 的 infra
  for (const svc of projectInfra) {
    if (svc.status === 'stopped') continue;
    // ★ 必须用 containerName 当 key — svc.id 跨项目可重复,会撞 key
    const actual = actualInfraState.get(svc.containerName);
    const trulyRunning = actual?.running === true;
    if (trulyRunning) continue;
    requiredInfraIds.add(svc.id);
  }

  return requiredInfraIds;
}
