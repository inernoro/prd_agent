import type { StateService } from './state.js';
import type { GitHubAppClient } from './github-app-client.js';
import type { MergeBackReader } from './release-governance.js';
import { FULL_SHA } from './release-governance-git.js';

export function releaseMergeBackReader(state: StateService,
  app?: Pick<GitHubAppClient, 'getInstallationToken'>, fetchImpl: typeof fetch = fetch): MergeBackReader {
  return async (projectId, number) => {
    const project = state.getProject(projectId), repository = project?.githubRepoFullName;
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !project.githubInstallationId || !app) {
      throw new Error('项目尚未接入 GitHub PR 读取权限，请先完成仓库授权');
    }
    try {
      const token = await app.getInstallationToken(project.githubInstallationId);
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${number}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const pr = await response.json() as { number: number; state: string; merged_at?: string; merge_commit_sha?: string;
        head?: { sha: string }; base?: { ref: string; repo?: { full_name: string } } };
      if (pr.number !== number || pr.base?.repo?.full_name.toLowerCase() !== repository.toLowerCase()
        || !pr.head?.sha || !FULL_SHA.test(pr.head.sha) || !['open','closed'].includes(pr.state)) throw new Error();
      return { repository, number, url: `https://github.com/${repository}/pull/${number}`, state: pr.merged_at ? 'merged' : pr.state as 'open' | 'closed',
        headSha: pr.head.sha, baseRef: pr.base.ref, mergedAt: pr.merged_at || undefined,
        mergeCommitSha: pr.merge_commit_sha && FULL_SHA.test(pr.merge_commit_sha) ? pr.merge_commit_sha : undefined,
        checkedAt: new Date().toISOString() };
    } catch { throw new Error('GitHub PR 状态暂未核实，请检查项目仓库权限后重试；未判定为已回并'); }
  };
}
