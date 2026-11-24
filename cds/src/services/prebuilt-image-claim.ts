import { CI_PREBUILT_WORKFLOW_FILE, isPrebuiltImageWorkflow } from './github-webhook-dispatcher.js';
import type { BranchEntry, BuildProfile } from '../types.js';
import { branchUsesPrebuiltMode } from './deploy-runtime.js';

export interface PrebuiltImageClaimPatch {
  githubCommitSha: string;
  lastPushAt: string;
  ciImageStatus: 'ready';
  ciTargetSha: string;
  ciWorkflowConclusion: 'success';
  ciWorkflowRunUrl: string;
  ciWaitingSince: string;
  ciImageError: string;
}

export type PrebuiltImageClaimPlan =
  | {
    ok: true;
    patch: PrebuiltImageClaimPatch;
    noChange: boolean;
    previous: {
      githubCommitSha?: string;
      ciImageStatus?: string;
      ciTargetSha?: string;
      ciWorkflowRunUrl?: string;
    };
  }
  | { ok: false; status: number; error: string; message: string };

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeWorkflowRunUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

export function preparePrebuiltImageClaim(
  branch: BranchEntry,
  profiles: BuildProfile[],
  input: {
    commitSha: string;
    workflowRunUrl?: string;
    nowIso: string;
  },
): PrebuiltImageClaimPlan {
  const commitSha = String(input.commitSha || '').trim();
  if (!FULL_GIT_SHA_RE.test(commitSha)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_commit_sha',
      message: 'commitSha 必须是 40 位 git SHA。',
    };
  }

  if (!branchUsesPrebuiltMode(profiles, branch)) {
    return {
      ok: false,
      status: 409,
      error: 'branch_not_prebuilt',
      message: '该分支当前未使用 CI 预构建镜像模式，不能认领 prebuilt 镜像。',
    };
  }

  const workflowRunUrl = normalizeWorkflowRunUrl(input.workflowRunUrl) || branch.ciWorkflowRunUrl || '';
  const previous = {
    githubCommitSha: branch.githubCommitSha,
    ciImageStatus: branch.ciImageStatus,
    ciTargetSha: branch.ciTargetSha,
    ciWorkflowRunUrl: branch.ciWorkflowRunUrl,
  };
  const patch: PrebuiltImageClaimPatch = {
    githubCommitSha: commitSha,
    lastPushAt: input.nowIso,
    ciImageStatus: 'ready',
    ciTargetSha: commitSha,
    ciWorkflowConclusion: 'success',
    ciWorkflowRunUrl: workflowRunUrl,
    ciWaitingSince: '',
    ciImageError: '',
  };
  return {
    ok: true,
    patch,
    noChange:
      previous.githubCommitSha === commitSha
      && previous.ciImageStatus === 'ready'
      && previous.ciTargetSha === commitSha
      && (previous.ciWorkflowRunUrl || '') === workflowRunUrl,
    previous,
  };
}


/** 手动补认领也读取 GitHub 的真实结果，URL 本身不构成成功证据。 */
export async function verifyPrebuiltWorkflowRun(input: {
  repository: string;
  branch: string;
  commitSha: string;
  workflowRunUrl: string;
  authorization?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; workflowRunUrl: string } | { ok: false; status: number; error: string; message: string }> {
  const invalid = { ok: false as const, status: 400, error: 'ci_evidence_required', message: '请让 Agent 自动查询本仓库的 Branch Image 运行链接，再认领镜像；不需要新人填写。' };
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repository)) return invalid;
  const unavailable = { ok: false as const, status: 503, error: 'ci_evidence_unavailable', message: '暂时无法核对 GitHub 的检查结果，未认领镜像或改变运行版本；请稍后重试。' };
  const fetcher = input.fetchImpl || fetch;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'CDS-Prebuilt-Claim',
    ...(input.authorization ? { Authorization: input.authorization } : {}) };
  const signal = AbortSignal.timeout(10_000);
  let workflowRunUrl = input.workflowRunUrl;
  try {
    if (!workflowRunUrl) {
      const query = new URLSearchParams({ branch: input.branch, head_sha: input.commitSha, per_page: '100' });
      const listed = await fetcher(`https://api.github.com/repos/${input.repository}/actions/workflows/${CI_PREBUILT_WORKFLOW_FILE}/runs?${query}`, {
        headers, signal, redirect: 'error',
      });
      if (!listed.ok) return unavailable;
      const { workflow_runs: runs } = await listed.json() as { workflow_runs?: Array<{ id?: number; repository?: { full_name?: string }; head_sha?: string; head_branch?: string; path?: string; name?: string }> };
      const run = runs?.find(run => Number.isSafeInteger(run.id) && run.id! > 0
        && run.repository?.full_name?.toLowerCase() === input.repository.toLowerCase()
        && run.head_sha?.toLowerCase() === input.commitSha.toLowerCase() && run.head_branch === input.branch
        && isPrebuiltImageWorkflow(run));
      if (!run) return { ok: false, status: 409, error: 'ci_not_successful', message: '尚未找到该分支和提交的镜像检查回执，未认领镜像或改变运行版本；请稍后重试。' };
      workflowRunUrl = `https://github.com/${input.repository}/actions/runs/${run.id}`;
    }
    let url: URL;
    try { url = new URL(workflowRunUrl); } catch { return invalid; }
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash
      || !match || match[1].toLowerCase() !== input.repository.toLowerCase()) return invalid;
    const response = await fetcher(`https://api.github.com/repos/${input.repository}/actions/runs/${match[2]}`, {
      headers, signal, redirect: 'error',
    });
    if (!response.ok) return { ok: false, status: 503, error: 'ci_evidence_unavailable', message: '暂时无法核对 GitHub 的检查结果，未认领镜像或改变运行版本；请稍后重试。' };
    const run = await response.json() as { status?: string; conclusion?: string; head_sha?: string; head_branch?: string; path?: string; name?: string; repository?: { full_name?: string } };
    if (run.repository?.full_name?.toLowerCase() !== input.repository.toLowerCase()
      || run.head_sha?.toLowerCase() !== input.commitSha.toLowerCase() || run.head_branch !== input.branch
      || !isPrebuiltImageWorkflow(run)) {
      return { ok: false, status: 409, error: 'ci_evidence_mismatch', message: 'CI 回执与本项目、分支或提交不一致，未认领镜像；请 Agent 重新核对。' };
    }
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      return { ok: false, status: 409, error: 'ci_not_successful', message: '该提交的 CI 尚未成功，不能认领镜像；当前运行版本保持不变。' };
    }
    return { ok: true, workflowRunUrl: url.href };
  } catch {
    return { ok: false, status: 503, error: 'ci_evidence_unavailable', message: '暂时无法核对 GitHub 的检查结果，未认领镜像或改变运行版本；请稍后重试。' };
  }
}
