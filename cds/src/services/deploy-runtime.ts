/**
 * 部署模式分类的单一数据源（SSOT）。
 *
 * 2026-05-14 Cursor Bugbot review (Low) 修复：原来 `branches.ts` 的
 * `classifyDeployRuntime` 和 `auto-lifecycle.ts` 的 `RELEASE_PATTERN /
 * isReleaseMode` 是手抄两份正则。任一处加关键词（如 preview/staging）另一处
 * 不会同步，导致 `branchAutoPublishConverged` 与 `summarizeBranchDeployRuntime`
 * 对"什么算 release"判断不一致。抽到这里，改一处生效全局。
 */

/** modeId / label 命中即视为"发布版/生产"运行模式。 */
export const RELEASE_DEPLOY_MODE_PATTERN =
  /(prod|production|release|static|publish|published|dist|standalone|built|发布|生产|正式|构建)/i;

/**
 * 给定一个具体 deploy mode（id + 可选 label），判断它是否属于"发布版"。
 * 空 modeId 视为非 release（源码/热加载默认）。
 */
export function isReleaseDeployMode(modeId: string, modeLabel?: string): boolean {
  if (!modeId) return false;
  return RELEASE_DEPLOY_MODE_PATTERN.test(`${modeId} ${modeLabel || ''}`);
}

/** 把 deploy mode 归类为 'source' | 'release'。无 modeId 时为 'source'。 */
export function classifyDeployRuntime(
  modeId?: string,
  modeLabel?: string,
): 'source' | 'release' {
  return modeId && isReleaseDeployMode(modeId, modeLabel) ? 'release' : 'source';
}

/**
 * P0 止血(2026-05-29):期望态 vs 实际态漂移检测(纯函数 SSOT)。
 *
 * 病根(openvisual 事故暴露):分支的 services 是"上次部署时的快照",项目新增
 * build profile 后,已部署分支不会自动回灌 —— 于是同一项目下 main 有 3 个服务、
 * PR 分支只有 2 个,UI 只显示数量,看不出"少了哪个 / 哪个挂了"。
 *
 * 这里把期望(项目所有 build profile)与实际(分支 services)做 diff:
 *  - missingProfileIds:profile 存在但分支没有对应服务条目(需补部署)
 *  - unhealthyProfileIds:服务存在但不是 running(error / stopped)
 *  - healthyCount:running 的服务数;expectedCount:profile 总数
 *  - hasDrift:仅对"部署过"(至少有一个服务条目)的分支判,从未部署的 0 服务
 *    分支不算漂移(那是"未部署",由分支 status 表达,不重复报警)
 *
 * 注意:这是**容器级**漂移(容器在不在 / 跑没跑)。"容器在跑但应用 503"那层
 * 需要 live 探针,state 里没存,留作后续 reconcile 升级。
 */
export interface ServiceDrift {
  expectedCount: number;
  healthyCount: number;
  missingProfileIds: string[];
  unhealthyProfileIds: string[];
  hasDrift: boolean;
}

export function computeServiceDrift(
  profileIds: string[],
  services: Record<string, { status?: string } | undefined> | undefined,
): ServiceDrift {
  const svcMap = services || {};
  const missingProfileIds: string[] = [];
  const unhealthyProfileIds: string[] = [];
  let healthyCount = 0;
  let knownServiceCount = 0;
  for (const profileId of profileIds) {
    const svc = svcMap[profileId];
    if (!svc) {
      missingProfileIds.push(profileId);
      continue;
    }
    knownServiceCount += 1;
    if (svc.status === 'running') healthyCount += 1;
    else if (svc.status === 'error' || svc.status === 'stopped') unhealthyProfileIds.push(profileId);
  }
  return {
    expectedCount: profileIds.length,
    healthyCount,
    missingProfileIds,
    unhealthyProfileIds,
    hasDrift: knownServiceCount > 0
      && (missingProfileIds.length > 0 || unhealthyProfileIds.length > 0),
  };
}
