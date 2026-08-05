/*
 * GitHub URL 拼装的唯一来源。
 *
 * 此前同一条 `https://github.com/{repo}/pull/{n}` 散在三处（BranchDetailDrawer 与
 * 后端 proxy.ts 两处），属于 predicate-and-wiring-discipline 形状 3「判据分裂成多份」——
 * 改一处忘一处。新增用法一律走本模块。
 */

/** 分支卡 / 详情抽屉里跳转到 PR 页面。repo 形如 `owner/name`。 */
export function githubPullRequestUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}
