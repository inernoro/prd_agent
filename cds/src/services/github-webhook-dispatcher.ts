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

/**
 * Validate a git ref (branch/tag) name against a strict allow-list before
 * interpolating it into any shell command. Git's own rules
 * (git-check-ref-format) are more permissive but pass through characters
 * that survive a single pair of double quotes (`"$(cmd)"`, `"`x``),
 * enabling command injection when the ref is fed to `sh -c`.
 *
 * Our allow-list is deliberately narrower than git's: ASCII alnum,
 * dot, underscore, dash, slash. This covers every real-world branch
 * name we've seen (feature/x, claude/fix-foo-bzAzq, v1.2.3, main,
 * hotfix_123) while blocking all shell meta-characters.
 *
 * Webhook-originated branch names come from untrusted GitHub users who
 * can push to the linked repo (including fork PRs), so this is
 * defense-in-depth: the attacker must first get a push ack'd, then the
 * branch name must pass this check — only THEN is it interpolated.
 */
export function isSafeGitRef(ref: string): boolean {
  if (typeof ref !== 'string') return false;
  if (ref.length === 0 || ref.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) return false;
  // git-check-ref-format also forbids `..`, trailing `.lock`, leading `-`.
  if (ref.includes('..')) return false;
  if (ref.endsWith('.lock')) return false;
  if (ref.endsWith('/')) return false;
  if (ref.includes('//')) return false;
  return true;
}

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
    | 'pr-branch-stopped'
    | 'slash-command-invoked'
    | 'branch-deleted'
    | 'repo-renamed'
    | 'repo-detached'
    | 'release-acknowledged';
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
   * Populated on `pull_request.closed` or `delete` (branch) to ask the
   * route to tear down the preview containers. Separate from
   * deployRequest so the route decides between "deploy" and "stop".
   */
  stopRequest?: {
    branchId: string;
  };
  /**
   * Populated on slash-command events (`/cds <cmd>` in issue_comment).
   * The route layer wires the command to the right action + posts a
   * reply comment on the PR.
   */
  slashCommand?: {
    command: 'redeploy' | 'stop' | 'logs' | 'help' | 'unknown';
    branchId?: string;
    prNumber: number;
    commentId: number;
    arg?: string;
    commenter: string;
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

/**
 * `issue_comment` event — GitHub fires this for BOTH issue and PR
 * comments (PR is an issue under the hood). We only act on comments
 * where `issue.pull_request` is set (meaning it's a PR comment) AND
 * the body matches our `/cds <cmd>` slash-command pattern.
 */
export interface GitHubIssueCommentEvent {
  action: 'created' | 'edited' | 'deleted';
  comment?: {
    id: number;
    body: string;
    user: { login: string };
  };
  issue?: {
    number: number;
    pull_request?: { url: string; html_url: string };
  };
  repository?: { full_name: string };
  installation?: { id: number };
}

/**
 * `delete` event — fires when a branch or tag is deleted on GitHub
 * (push of an empty ref). We care about branches so we can tear down
 * their preview containers on CDS.
 */
export interface GitHubDeleteEvent {
  ref: string;
  ref_type: 'branch' | 'tag';
  repository?: { full_name: string };
  installation?: { id: number };
}

/**
 * `repository` event — fires on repo-level lifecycle changes
 * (renamed, transferred, archived, edited, deleted). We auto-unlink
 * projects that reference a repo that's been renamed or removed so
 * the link dictionary doesn't accumulate stale entries.
 */
export interface GitHubRepositoryEvent {
  action: 'created' | 'deleted' | 'renamed' | 'transferred' | 'archived' | 'unarchived' | 'edited' | 'publicized' | 'privatized';
  repository?: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
  changes?: {
    repository?: {
      name?: { from: string };
      owner?: { from: { user?: { login: string }; organization?: { login: string } } };
    };
  };
  installation?: { id: number };
}

/**
 * `release` event — currently acknowledged but not wired to a deploy
 * action. Hook for a future production-tag deploy feature.
 */
export interface GitHubReleaseEvent {
  action: 'published' | 'created' | 'edited' | 'deleted' | 'prereleased' | 'released';
  release?: {
    tag_name: string;
    name: string;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
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
  /**
   * Dispatch a webhook event. The `dryRun` option is set by the
   * `/api/github/webhook/self-test` endpoint to skip all state
   * mutations (addBranch / updateProject / worktree create / save).
   * Parsing and routing logic still runs so the result accurately
   * describes what a REAL webhook would have triggered — just without
   * creating files on disk or writing to state.json.
   */
  private _dryRun = false;
  async handle(
    eventName: string,
    payload: unknown,
    options?: { dryRun?: boolean },
  ): Promise<WebhookDispatchResult> {
    this._dryRun = options?.dryRun === true;
    try {
      switch (eventName) {
        case 'ping':
          return { action: 'ignored-ping', message: 'pong' };
        case 'push':
          return await this.handlePush(payload as GitHubPushEvent);
        case 'installation':
          return await this.handleInstallation(payload as GitHubInstallationEvent);
        case 'installation_repositories':
          return await this.handleInstallationRepos(payload as GitHubInstallationReposEvent);
        case 'check_run':
          return await this.handleCheckRun(payload as GitHubCheckRunEvent);
        case 'pull_request':
          return await this.handlePullRequest(payload as GitHubPullRequestEvent);
        case 'issue_comment':
          return await this.handleIssueComment(payload as GitHubIssueCommentEvent);
        case 'delete':
          return await this.handleDelete(payload as GitHubDeleteEvent);
        case 'repository':
          return await this.handleRepository(payload as GitHubRepositoryEvent);
        case 'release':
          return await this.handleRelease(payload as GitHubReleaseEvent);
        default:
          return { action: 'ignored-event', message: `Unhandled event type '${eventName}'` };
      }
    } finally {
      this._dryRun = false;
    }
  }

  /**
   * Guard for state-mutating ops: honored by every handler that
   * would otherwise call addBranch/updateProject/worktree.create.
   * When true, the handler returns its result as if the mutation
   * happened (for accurate self-test output) but skips writes.
   */
  private get dryRun(): boolean {
    return this._dryRun;
  }

  /**
   * Parse a slash command from a PR comment body. Format:
   *   /cds <command> [arg…]
   * Leading whitespace tolerated. Only the FIRST line is inspected so a
   * comment like "/cds redeploy\n\nThis should force a new build" still
   * parses as a redeploy command.
   */
  private parseSlashCommand(body: string): { command: WebhookDispatchResult['slashCommand'] extends infer R ? R extends { command: infer C } ? C : never : never; arg?: string } | null {
    if (!body) return null;
    const firstLine = body.split(/\r?\n/)[0].trim();
    const match = firstLine.match(/^\/cds(?:\s+(\S+))?(?:\s+(.*))?$/i);
    if (!match) return null;
    const cmd = (match[1] || 'help').toLowerCase();
    const arg = match[2]?.trim() || undefined;
    if (cmd === 'redeploy' || cmd === 'rebuild' || cmd === 'deploy') return { command: 'redeploy', arg };
    if (cmd === 'stop' || cmd === 'pause' || cmd === 'shutdown') return { command: 'stop', arg };
    if (cmd === 'logs' || cmd === 'log' || cmd === 'tail') return { command: 'logs', arg };
    if (cmd === 'help' || cmd === '?' || cmd === '-h') return { command: 'help', arg };
    return { command: 'unknown', arg: cmd };
  }

  /**
   * Resolve the CDS branchId associated with a PR. We stored
   * githubPrNumber on the branch entry when the PR was opened, so we
   * walk the branches list for that project looking for a match.
   * Falls back to null if no branch found (comment on a PR CDS doesn't
   * track yet — maybe the user linked the repo after PR was open).
   */
  private findBranchForPr(projectId: string, prNumber: number): string | null {
    const branches = this.deps.stateService.getBranchesForProject(projectId);
    const hit = branches.find((b) => b.githubPrNumber === prNumber);
    return hit ? hit.id : null;
  }

  /**
   * Handle `issue_comment.created` events. We only act when the comment
   * is on a PR (issue.pull_request is set) and starts with `/cds`.
   * The route layer does the actual work (triggering deploy / stop /
   * posting reply) because those all need the GitHubAppClient.
   */
  private async handleIssueComment(event: GitHubIssueCommentEvent): Promise<WebhookDispatchResult> {
    if (event.action !== 'created') {
      return { action: 'ignored-event', message: `issue_comment.${event.action} ignored` };
    }
    if (!event.issue?.pull_request || !event.comment || !event.repository) {
      return { action: 'ignored-event', message: 'issue_comment not on a PR or missing fields' };
    }
    const parsed = this.parseSlashCommand(event.comment.body);
    if (!parsed) {
      return { action: 'ignored-event', message: 'comment not a /cds slash command' };
    }
    const repoFullName = event.repository.full_name;
    const project = this.deps.stateService.findProjectByRepoFullName(repoFullName);
    if (!project) {
      return { action: 'ignored-no-project', message: `No project linked to ${repoFullName}` };
    }
    const branchId = this.findBranchForPr(project.id, event.issue.number) || undefined;
    return {
      action: 'slash-command-invoked',
      message: `/cds ${parsed.command} invoked by @${event.comment.user.login} on PR #${event.issue.number}`,
      branchId,
      slashCommand: {
        command: parsed.command,
        branchId,
        prNumber: event.issue.number,
        commentId: event.comment.id,
        arg: parsed.arg,
        commenter: event.comment.user.login,
      },
    };
  }

  /**
   * `delete` event — branch or tag removed on GitHub. For branches we
   * stop the corresponding CDS preview container so the user deleting
   * on GitHub's side automatically cleans up CDS too.
   */
  private async handleDelete(event: GitHubDeleteEvent): Promise<WebhookDispatchResult> {
    if (event.ref_type !== 'branch') {
      return { action: 'ignored-event', message: `delete ref_type=${event.ref_type} ignored` };
    }
    if (!event.repository) {
      return { action: 'ignored-event', message: 'delete event missing repository' };
    }
    const project = this.deps.stateService.findProjectByRepoFullName(event.repository.full_name);
    if (!project) {
      return { action: 'ignored-no-project', message: `No project linked to ${event.repository.full_name}` };
    }
    if (!isSafeGitRef(event.ref)) {
      return { action: 'ignored-event', message: `Rejected unsafe delete ref: ${event.ref.slice(0, 80)}` };
    }
    const slugified = StateServiceClass.slugify(event.ref);
    const branchId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    const entry = this.deps.stateService.getBranch(branchId);
    if (!entry) {
      return { action: 'ignored-event', message: `branch deleted on GitHub but not tracked by CDS: ${branchId}` };
    }
    return {
      action: 'branch-deleted',
      message: `GitHub branch '${event.ref}' deleted; stopping CDS preview '${branchId}'`,
      branchId,
      stopRequest: { branchId },
    };
  }

  /**
   * `repository` event — repo renamed, transferred, archived, deleted.
   * We defensively detach the link in each of these cases rather than
   * trying to auto-rename (rename could also collide with another
   * project's linkage). The operator can re-link via the UI after.
   */
  private async handleRepository(event: GitHubRepositoryEvent): Promise<WebhookDispatchResult> {
    if (!event.repository) {
      return { action: 'ignored-event', message: 'repository event missing payload' };
    }
    const currentFullName = event.repository.full_name;
    // Try to find a project matching either the new OR the old full name
    // (renamed/transferred events pass the new name in repository but
    // include the old name in changes.repository.{name,owner}).
    let project = this.deps.stateService.findProjectByRepoFullName(currentFullName);
    if (!project && event.action === 'renamed') {
      const oldName = event.changes?.repository?.name?.from;
      if (oldName) {
        const owner = event.repository.owner.login;
        project = this.deps.stateService.findProjectByRepoFullName(`${owner}/${oldName}`);
      }
    }
    if (!project && event.action === 'transferred') {
      const oldOwner = event.changes?.repository?.owner?.from?.user?.login
        || event.changes?.repository?.owner?.from?.organization?.login;
      if (oldOwner) {
        project = this.deps.stateService.findProjectByRepoFullName(`${oldOwner}/${event.repository.name}`);
      }
    }
    if (!project) {
      return { action: 'ignored-event', message: `repository.${event.action} for ${currentFullName} — no linked project` };
    }

    // For destructive actions, detach entirely so the stale link doesn't
    // accept future webhooks. For a rename, we COULD auto-update to the
    // new name — kept detached for now so the operator explicitly
    // re-binds via the UI, avoiding silent cross-wiring.
    if (event.action === 'deleted' || event.action === 'renamed' || event.action === 'transferred') {
      if (!this.dryRun) {
        this.deps.stateService.updateProject(project.id, {
          githubRepoFullName: undefined,
          githubInstallationId: undefined,
          githubAutoDeploy: undefined,
          githubLinkedAt: undefined,
        });
      }
      return {
        action: event.action === 'deleted' ? 'repo-detached' : 'repo-renamed',
        message: `${this.dryRun ? '[dry-run] ' : ''}Project '${project.name}' unlinked because repository.${event.action} (${currentFullName})`,
      };
    }
    return { action: 'ignored-event', message: `repository.${event.action} acknowledged` };
  }

  /**
   * `release` event — currently just acknowledged. Future: trigger a
   * production-flavored deploy on `released` / `published` action, pin
   * a specific build profile ("prod"), or post a release-notes comment.
   */
  private async handleRelease(event: GitHubReleaseEvent): Promise<WebhookDispatchResult> {
    const tag = event.release?.tag_name || '?';
    return { action: 'release-acknowledged', message: `release.${event.action} (${tag}) — future: production deploy` };
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
    // PR head refs come from untrusted forks too — reject shell-unsafe
    // names. Note: pull_request handler doesn't itself shell-exec, but
    // downstream paths (stop/deploy routes) may, so enforce the
    // invariant at dispatch time.
    if (!isSafeGitRef(branchName)) {
      return {
        action: 'ignored-event',
        message: `Rejected unsafe PR branch name: ${branchName.slice(0, 80)}`,
      };
    }
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
      if (entry && !this.dryRun) {
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          githubPrNumber: event.pull_request.number,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
          githubRepoFullName: repoFullName,
        });
        this.deps.stateService.save();
      }
      return {
        action: 'pr-comment-posted',
        message: `${this.dryRun ? '[dry-run] ' : ''}PR #${event.pull_request.number} ${event.action}; marked branch '${branchId}' for comment`,
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
    // Defense-in-depth: reject shell-unsafe branch names before they
    // reach any `shell.exec()` call further down (git worktree add /
    // mkdir / git fetch). See isSafeGitRef above.
    if (!isSafeGitRef(branchName)) {
      return {
        action: 'ignored-event',
        message: `Rejected unsafe branch name from webhook: ${branchName.slice(0, 80)}`,
      };
    }
    // commitSha must be a 40-hex git SHA. Rejecting anything else
    // prevents command injection even if attacker can push a malformed
    // "after" field (unlikely — GitHub always sends real SHAs).
    if (typeof event.after !== 'string' || !/^[0-9a-f]{7,40}$/i.test(event.after)) {
      return { action: 'ignored-event', message: 'Rejected non-hex commit SHA from webhook' };
    }
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

      if (this.dryRun) {
        // In dry-run we return the shape of "would-create" without
        // touching disk or state — self-test wants accurate signals.
        return {
          action: 'branch-created',
          message: `[dry-run] Would create branch '${branchId}' from push at ${commitSha.slice(0, 7)}`,
          branchId,
          deployRequest: { branchId, commitSha },
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

    if (this.dryRun) {
      return {
        action: created ? 'branch-created' : 'branch-refreshed',
        message: `[dry-run] Would stamp ${commitSha.slice(0, 7)} on '${branchId}'`,
        branchId,
        deployRequest: { branchId, commitSha },
      };
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
    if (event.action === 'removed' && !this.dryRun) {
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
    if (!this.dryRun) {
      this.deps.stateService.updateBranchGithubMeta(branchId, { githubCommitSha: commitSha });
      this.deps.stateService.save();
    }
    return {
      action: 'check-run-requeued',
      message: `${this.dryRun ? '[dry-run] ' : ''}Queued redeploy of '${branchId}' at ${commitSha.slice(0, 7)}`,
      branchId,
      deployRequest: { branchId, commitSha },
    };
  }
}

