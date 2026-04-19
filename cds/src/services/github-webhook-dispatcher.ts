/**
 * GitHubWebhookDispatcher — processes an already-verified GitHub webhook
 * and translates it into CDS state changes.
 *
 * Kept separate from the Express route so unit tests can exercise the
 * business logic without spinning up a server + HTTP client. The route
 * is a thin shell that verifies the HMAC and delegates here.
 *
 * Supported events (v1):
 *   - `ping`                     — health check, no-op
 *   - `push`                     — auto-create+deploy branch, post check run
 *   - `installation`             — log/refresh installation id for matching projects
 *   - `installation_repositories`— adjust which repos an installation covers
 *   - `check_run.rerequested`    — re-run the deploy that produced this check
 *
 * Unknown events return a soft 'ignored' so GitHub doesn't retry the
 * delivery (those retries fill the App's webhook delivery log with noise).
 */

import type { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';
import type { IShellExecutor, CdsConfig, BranchEntry } from '../types.js';
import type { GitHubAppClient } from './github-app-client.js';
import path from 'node:path';
import { StateService as StateServiceClass } from './state.js';

export interface WebhookDispatchResult {
  /** Machine-readable outcome. */
  action:
    | 'ignored-no-project'
    | 'ignored-delete'
    | 'ignored-non-branch'
    | 'ignored-non-push-branch'
    | 'ignored-auto-deploy-off'
    | 'ignored-ping'
    | 'ignored-event'
    | 'branch-created'
    | 'branch-refreshed'
    | 'installation-acknowledged'
    | 'check-run-requeued'
    | 'pr-comment-posted'
    | 'pr-branch-stopped';
  /** Short human message for the response + logs. */
  message: string;
  /** Populated when a branch was touched. */
  branchId?: string;
  /** Populated when a deploy should be fired after the dispatcher returns. */
  deployRequest?: {
    branchId: string;
    commitSha: string;
  };
  /**
   * Populated on `pull_request.closed` to ask the route to tear down the
   * preview containers. Separate from deployRequest so the route decides
   * between "deploy" and "stop".
   */
  stopRequest?: {
    branchId: string;
  };
}

export interface GitHubPushEvent {
  ref?: string;
  /** `true` when the push deletes the ref — we ignore those. */
  deleted?: boolean;
  before?: string;
  after?: string;
  repository?: {
    id: number;
    full_name: string;
    default_branch?: string;
  };
  installation?: { id: number };
  head_commit?: { id: string; message: string } | null;
  sender?: { login: string };
}

export interface GitHubInstallationEvent {
  action: 'created' | 'deleted' | 'new_permissions_accepted' | 'suspend' | 'unsuspend';
  installation?: { id: number; account?: { login: string } };
  repositories?: Array<{ full_name: string }>;
}

export interface GitHubInstallationReposEvent {
  action: 'added' | 'removed';
  installation?: { id: number };
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
}

export interface GitHubCheckRunEvent {
  action: 'created' | 'completed' | 'rerequested' | 'requested_action';
  check_run?: {
    id: number;
    head_sha: string;
    external_id?: string;
    check_suite: { id: number };
  };
  repository?: { full_name: string };
  installation?: { id: number };
}

export interface GitHubPullRequestEvent {
  action: 'opened' | 'closed' | 'reopened' | 'synchronize' | 'edited' | 'ready_for_review' | string;
  number: number;
  pull_request?: {
    number: number;
    state: 'open' | 'closed';
    merged?: boolean;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
    title: string;
  };
  repository?: { full_name: string };
  installation?: { id: number };
}

export interface WebhookDispatcherDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  shell: IShellExecutor;
  config: CdsConfig;
  githubApp?: GitHubAppClient;
}

export class GitHubWebhookDispatcher {
  constructor(private readonly deps: WebhookDispatcherDeps) {}

  /**
   * Entry point. `eventName` comes from the `X-GitHub-Event` header.
   * The caller is responsible for HMAC verification — signatures that
   * don't match must be rejected BEFORE reaching this method.
   */
  async handle(eventName: string, payload: unknown): Promise<WebhookDispatchResult> {
    switch (eventName) {
      case 'ping':
        return { action: 'ignored-ping', message: 'pong' };
      case 'push':
        return this.handlePush(payload as GitHubPushEvent);
      case 'installation':
        return this.handleInstallation(payload as GitHubInstallationEvent);
      case 'installation_repositories':
        return this.handleInstallationRepos(payload as GitHubInstallationReposEvent);
      case 'check_run':
        return this.handleCheckRun(payload as GitHubCheckRunEvent);
      case 'pull_request':
        return this.handlePullRequest(payload as GitHubPullRequestEvent);
      default:
        return { action: 'ignored-event', message: `Unhandled event type '${eventName}'` };
    }
  }

  /**
   * Handle `pull_request` events. The three actions we care about:
   *   - `opened` / `reopened`: remember the PR number on the branch so
   *     later deploys can refresh the preview-URL bot comment. The actual
   *     comment is posted by the route layer (it has the GitHubAppClient).
   *   - `closed` (merged or not): flag the branch so the route can stop
   *     its containers — saves resources and declutters the dashboard.
   *   - `synchronize`: already covered by the accompanying `push` event,
   *     so we no-op here.
   *
   * All other actions (edited / labeled / assigned / review_requested /
   * ready_for_review / etc.) are acknowledged but don't trigger anything.
   */
  private async handlePullRequest(event: GitHubPullRequestEvent): Promise<WebhookDispatchResult> {
    if (!event.pull_request || !event.repository) {
      return { action: 'ignored-event', message: 'pull_request missing pull_request/repository' };
    }
    const repoFullName = event.repository.full_name;
    const project = this.deps.stateService.findProjectByRepoFullName(repoFullName);
    if (!project) {
      return { action: 'ignored-no-project', message: `No project linked to ${repoFullName}` };
    }

    const branchName = event.pull_request.head.ref;
    const slugified = StateServiceClass.slugify(branchName);
    const branchId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    const entry = this.deps.stateService.getBranch(branchId);

    // `closed` action — tear down preview containers.
    if (event.action === 'closed') {
      if (!entry) {
        return { action: 'ignored-event', message: `PR closed but branch '${branchId}' not in CDS` };
      }
      return {
        action: 'pr-branch-stopped',
        message: `PR #${event.pull_request.number} ${event.pull_request.merged ? 'merged' : 'closed'}; stopping preview`,
        branchId,
        stopRequest: { branchId },
      };
    }

    // `opened` / `reopened` — stash the PR number on the branch so the
    // route-layer comment poster has it, and let the push handler (which
    // already runs in parallel from synchronize) drive the deploy.
    if (event.action === 'opened' || event.action === 'reopened') {
      if (entry) {
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          githubPrNumber: event.pull_request.number,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
          githubRepoFullName: repoFullName,
        });
        this.deps.stateService.save();
      }
      return {
        action: 'pr-comment-posted',
        message: `PR #${event.pull_request.number} ${event.action}; marked branch '${branchId}' for comment`,
        branchId,
      };
    }

    // synchronize / edited / etc.
    return { action: 'ignored-event', message: `pull_request.${event.action} ignored` };
  }

  private async handlePush(event: GitHubPushEvent): Promise<WebhookDispatchResult> {
    if (!event.ref || !event.repository) {
      return { action: 'ignored-non-push-branch', message: 'Push payload missing ref/repository' };
    }
    // Delete pushes arrive with after='00..0' and we deliberately skip them
    // BEFORE requiring `after` because GitHub's delete event semantically
    // has no "new SHA". Checked before the ref-kind guard so delete-of-tag
    // still returns ignored-delete (more informative than ignored-non-branch).
    if (event.deleted) {
      return { action: 'ignored-delete', message: `Branch delete ignored (ref=${event.ref})` };
    }
    if (!event.after) {
      return { action: 'ignored-non-push-branch', message: 'Push payload missing after SHA' };
    }
    // ref is "refs/heads/<branch>" for branch pushes, "refs/tags/<tag>" for tags.
    if (!event.ref.startsWith('refs/heads/')) {
      return { action: 'ignored-non-branch', message: `Non-branch ref ignored (${event.ref})` };
    }
    const branchName = event.ref.substring('refs/heads/'.length);
    const commitSha = event.after;
    const repoFullName = event.repository.full_name;

    const project = this.deps.stateService.findProjectByRepoFullName(repoFullName);
    if (!project) {
      return {
        action: 'ignored-no-project',
        message: `No project linked to ${repoFullName}. Ignoring push.`,
      };
    }

    if (project.githubAutoDeploy === false) {
      return {
        action: 'ignored-auto-deploy-off',
        message: `Project '${project.name}' has autoDeploy=off. Ignoring push.`,
      };
    }

    // Ensure branch exists — auto-create a worktree when the push hits a
    // branch CDS hasn't tracked yet. Uses the same id convention as the
    // `POST /branches` route (legacy projects use the bare slug, named
    // projects prefix with the project slug) so frontend URLs match.
    const slugified = StateServiceClass.slugify(branchName);
    const branchId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    let entry = this.deps.stateService.getBranch(branchId);
    let created = false;

    if (!entry) {
      // Refuse to auto-clone if the project's own clone isn't ready yet —
      // matches the guard in POST /branches so a webhook racing against a
      // slow first-clone doesn't leave us in a half-state.
      if (project.cloneStatus && project.cloneStatus !== 'ready') {
        return {
          action: 'ignored-no-project',
          message: `Project '${project.name}' clone not ready (${project.cloneStatus}). Skipping push.`,
        };
      }

      const repoRoot = this.deps.stateService.getProjectRepoRoot(project.id, this.deps.config.repoRoot);
      const worktreePath = (await import('./worktree.js')).WorktreeService.worktreePathFor(
        this.deps.config.worktreeBase,
        project.id,
        branchId,
      );
      await this.deps.shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
      try {
        await this.deps.worktreeService.create(repoRoot, branchName, worktreePath);
      } catch (err) {
        // A push for a branch our local clone hasn't fetched yet can fail
        // because `git worktree add` refuses unknown refs. Try a fetch and
        // retry once; give up if that also fails.
        await this.deps.shell.exec(`git fetch origin "${branchName}":"${branchName}"`, { cwd: repoRoot }).catch(() => {});
        await this.deps.worktreeService.create(repoRoot, branchName, worktreePath);
        void err;
      }
      entry = {
        id: branchId,
        projectId: project.id,
        branch: branchName,
        worktreePath,
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      };
      this.deps.stateService.addBranch(entry);
      created = true;
    }

    // Stamp GitHub metadata on the branch so the deploy route and check-run
    // hooks can find the repo + installation without re-walking the project.
    this.deps.stateService.updateBranchGithubMeta(branchId, {
      githubRepoFullName: repoFullName,
      githubCommitSha: commitSha,
      githubInstallationId: project.githubInstallationId ?? event.installation?.id,
    });
    this.deps.stateService.save();

    return {
      action: created ? 'branch-created' : 'branch-refreshed',
      message: created
        ? `Created branch '${branchId}' from push at ${commitSha.slice(0, 7)}`
        : `Refreshed branch '${branchId}' with push ${commitSha.slice(0, 7)}`,
      branchId,
      deployRequest: { branchId, commitSha },
    };
  }

  private async handleInstallation(event: GitHubInstallationEvent): Promise<WebhookDispatchResult> {
    const instId = event.installation?.id;
    if (!instId) {
      return { action: 'ignored-event', message: 'installation event missing installation.id' };
    }
    // We don't auto-link projects on `installation` — the operator picks
    // a specific repo via the Settings UI. The event is acknowledged so
    // the App's delivery log is clean.
    return {
      action: 'installation-acknowledged',
      message: `Installation ${event.action} for id=${instId}`,
    };
  }

  private async handleInstallationRepos(
    event: GitHubInstallationReposEvent,
  ): Promise<WebhookDispatchResult> {
    const instId = event.installation?.id;
    if (!instId) {
      return { action: 'ignored-event', message: 'installation_repositories missing installation.id' };
    }
    // If a repo was removed from the installation AND it's linked to a
    // project, detach the link so webhooks for it stop triggering deploys.
    if (event.action === 'removed') {
      for (const repo of event.repositories_removed || []) {
        const project = this.deps.stateService.findProjectByRepoFullName(repo.full_name);
        if (project && project.githubInstallationId === instId) {
          this.deps.stateService.updateProject(project.id, {
            githubRepoFullName: undefined,
            githubInstallationId: undefined,
            githubAutoDeploy: undefined,
            githubLinkedAt: undefined,
          });
        }
      }
    }
    return {
      action: 'installation-acknowledged',
      message: `installation_repositories ${event.action}`,
    };
  }

  private async handleCheckRun(event: GitHubCheckRunEvent): Promise<WebhookDispatchResult> {
    if (event.action !== 'rerequested') {
      return { action: 'ignored-event', message: `check_run ${event.action} ignored` };
    }
    const branchId = event.check_run?.external_id;
    if (!branchId) return { action: 'ignored-event', message: 'check_run missing external_id' };
    const entry = this.deps.stateService.getBranch(branchId);
    if (!entry) return { action: 'ignored-event', message: `check_run branch '${branchId}' not found` };
    const commitSha = event.check_run!.head_sha;
    this.deps.stateService.updateBranchGithubMeta(branchId, { githubCommitSha: commitSha });
    this.deps.stateService.save();
    return {
      action: 'check-run-requeued',
      message: `Queued redeploy of '${branchId}' at ${commitSha.slice(0, 7)}`,
      branchId,
      deployRequest: { branchId, commitSha },
    };
  }
}

/**
 * Type guard the route uses to decide whether to kick off a deploy.
 * Exported so mocks don't need to duplicate the check.
 */
export function shouldDispatchDeploy(result: WebhookDispatchResult): boolean {
  return Boolean(result.deployRequest);
}
