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
