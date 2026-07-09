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
