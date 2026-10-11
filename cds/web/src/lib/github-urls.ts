/*
 * GitHub URL 拼装的唯一来源。
 *
 * 此前同一条 `https://github.com/{repo}/pull/{n}` 散在三处，属于
 * predicate-and-wiring-discipline 形状 3「判据分裂成多份」——改一处忘一处。
 *
 * 收敛范围仅限前端：`cds/web/**` 的所有用法一律走本模块（2026-08-06 review P2-2
 * 发现 BranchDetailDrawer 里还留着一份同名副本，已删）。后端 `cds/src/services/proxy.ts`
 * 另有两处手拼，跨端 import 不了本文件，属于**尚未收敛**的已知边界；后端若要收敛
 * 需在 `cds/src/` 下另立一份，两边靠测试对齐，不要以为这里已经管住了它。
 */

/** 分支卡 / 详情抽屉里跳转到 PR 页面。repo 形如 `owner/name`。 */
export function githubPullRequestUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

/** Exact provider attempt; reject unsafe identities instead of accepting provider hrefs. */
export function githubWorkflowAttemptUrl(repoFullName: unknown, runId: unknown, attempt: unknown): string | null {
  if (typeof repoFullName !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repoFullName)
    || repoFullName.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(runId) || (runId as number) <= 0
    || !Number.isSafeInteger(attempt) || (attempt as number) <= 0) return null;
  return `https://github.com/${repoFullName}/actions/runs/${runId}/attempts/${attempt}`;
}
