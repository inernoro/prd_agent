import type { BranchEntry, Project, ReleaseStrategy } from '../types.js';
import type { GitHubAppClient } from './github-app-client.js';
import { DEFAULT_RELEASE_CI_WORKFLOW_FILE } from '../domain/release-script-contract.js';

export interface ProjectReleaseCIResult { ok: boolean; message: string }
export type ProjectReleaseCIVerifier = (branch: BranchEntry, sha: string, strategy: ReleaseStrategy) => Promise<ProjectReleaseCIResult>;

/** Independent project CI, never the prebuilt-image webhook state. Read through
 * on every release, including after restart or a missed workflow webhook. */
export async function verifyProjectReleaseCI(
  project: Project | undefined,
  app: Pick<GitHubAppClient, 'getInstallationToken'> | undefined,
  branch: BranchEntry,
  sha: string,
  strategy: ReleaseStrategy,
  fetchImpl: typeof fetch = fetch,
): Promise<ProjectReleaseCIResult> {
  const workflow = strategy.ciWorkflowFile || DEFAULT_RELEASE_CI_WORKFLOW_FILE;
  const repo = project?.githubRepoFullName;
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[A-Za-z0-9_-]+\.ya?ml$/.test(workflow)) return { ok: false, message: '发布 CI 缺少完整提交或安全的工作流文件名' };
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !project?.githubInstallationId || !app) {
    return { ok: false, message: '项目发布 CI 需要该仓库的 GitHub App 接入与 Actions 读取权限' };
  }
  try {
    const token = await app.getInstallationToken(project.githubInstallationId);
    const query = new URLSearchParams({ head_sha: sha, branch: branch.branch, per_page: '100' });
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, message: `无法读取项目发布 CI ${workflow}（HTTP ${response.status}），不能以镜像构建代替` };
    const body = await response.json() as { total_count?: number; workflow_runs?: Array<{ id: number; run_attempt?: number; updated_at?: string; run_started_at?: string; head_sha: string; head_branch: string; path: string; status: string; conclusion: string | null; head_repository?: { full_name: string } }> };
    if ((body.total_count || 0) > (body.workflow_runs || []).length) return { ok: false, message: '项目 CI 记录未完整返回，无法证明最新结论，未放行发布' };
    const matching = (body.workflow_runs || []).filter(r => r.head_sha === sha && r.head_branch === branch.branch
      && r.path?.split('@')[0] === `.github/workflows/${workflow}`
      && r.head_repository?.full_name.toLowerCase() === repo.toLowerCase());
    const updated = (run: typeof matching[number]) => Date.parse(run.updated_at || run.run_started_at || '');
    if (matching.some(run => !Number.isFinite(updated(run)))) return { ok: false, message: '项目 CI 缺少有效运行时间证据，未放行发布' };
    // Rerunning an older run retains its ID: latest state update, not largest ID.
    const run = matching.sort((a,b) => updated(b)-updated(a) || b.id-a.id || (b.run_attempt || 0)-(a.run_attempt || 0))[0];
    const ok = run?.status === 'completed' && run.conclusion === 'success';
    return { ok, message: `${workflow} · ${sha.slice(0,12)} · ${run ? `run=${run.id}.${run.run_attempt || 1} ${run.status}/${run.conclusion || '等待结果'}` : '没有同分支、同提交的 CI 记录'}；该工作流必须验证发布脚本 check` };
  } catch {
    return { ok: false, message: `项目发布 CI ${workflow} 读取失败，请检查 GitHub App 的 Actions 权限及网络；未放行发布` };
  }
}
