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
import type { IShellExecutor, CdsConfig, BranchEntry, Project } from '../types.js';
import type { GitHubAppClient } from './github-app-client.js';
import { branchEvents, nowIso } from './branch-events.js';
import path from 'node:path';
import { StateService as StateServiceClass } from './state.js';
import { analyzeChangeImpact } from './change-impact-analyzer.js';
import { branchUsesPrebuiltMode, applyDefaultDeployModesToBranch } from './deploy-runtime.js';

/**
 * 2026-06-23 极速版（CI 预构建）—— 负责构建预构建镜像的 GitHub Actions 工作流标识。
 * CDS 只在这个工作流的 workflow_run.completed 到达时才触发拉取部署,避免被 ci.yml /
 * cds.yml 等其它工作流的完成事件误触发（那时镜像还没 push 到 ghcr）。
 * 后续可做成 project 级配置以泛化到任意 public 仓库（见 doc/debt.cds-ci-prebuilt.md）。
 */
const CI_PREBUILT_WORKFLOW_FILE = 'branch-image.yml';
const CI_PREBUILT_WORKFLOW_NAME = 'Branch Image';

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

/**
 * Product-level branch policy. This is intentionally stricter than
 * isSafeGitRef(): a ref can be shell-safe but still be a URL/PR link
 * accidentally pasted or pushed as a branch name. CDS should not turn
 * those into preview environments.
 */
export function isAllowedCdsBranchName(ref: string): boolean {
  if (!isSafeGitRef(ref)) return false;
  const lower = ref.toLowerCase();
  if (lower.startsWith('http/')) return false;
  if (lower.startsWith('https/')) return false;
  if (lower.startsWith('http:')) return false;
  if (lower.startsWith('https:')) return false;
  if (lower.includes('github.com/')) return false;
  if (/(^|\/)pull\/\d+($|\/)/i.test(ref)) return false;
  if (/(^|\/)pulls\/\d+($|\/)/i.test(ref)) return false;
  if (/(^|\/)issues\/\d+($|\/)/i.test(ref)) return false;
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
    | 'ignored-doc-only'
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
    | 'release-acknowledged'
    // 2026-06-23 极速版（CI 预构建）
    | 'ci-image-waiting'
    | 'ci-image-ready'
    | 'ci-image-failed'
    | 'workflow-acknowledged';
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
   * Populated on GitHub `delete` (branch) event — 用户反馈 2026-05-07
   * "如果分支不存在,删除分支没有触发删除事件":之前 handleDelete 只 stopRequest
   * 容器,留下 CDS branch entry,UI 上分支卡还在,用户点 deploy 拉 origin/<ref>
   * 失败 (`fatal: couldn't find remote ref`)。
   *
   * 增加此字段后,webhook 主路由会在 stopRequest 完成后**异步**调
   * DELETE /api/branches/:id 彻底清理 entry + worktree,UI 上分支卡随之消失。
   * 与 stopRequest 并存:容器先停干净再删 entry,避免野容器残留。
   */
  branchDeleteRequest?: {
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
  commits?: Array<{
    id?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  size?: number;
  distinct_size?: number;
  sender?: { login: string; avatar_url?: string };
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
  sender?: { login?: string; avatar_url?: string };
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
  sender?: { login?: string; avatar_url?: string };
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

/**
 * 2026-06-23 极速版（CI 预构建）—— GitHub Actions 构建完成事件。
 * CDS 据此把「等待中」的极速版分支按 commit SHA 拉取预构建镜像部署。
 */
export interface GitHubWorkflowRunEvent {
  action: 'requested' | 'in_progress' | 'completed';
  workflow_run?: {
    id: number;
    name?: string;
    /** 触发该 run 的 workflow 文件路径（如 `.github/workflows/branch-image.yml`）。 */
    path?: string;
    head_branch?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    event?: string;
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
   * 近期已完成的 branch-image.yml workflow_run 结果缓存（按 repo+sha）。
   * 解决「push webhook 延迟/重试,workflow_run.completed 抢先到达」的竞态:
   * 抢先到达时若没有等待分支匹配,把结果暂存这里;稍后 push 把分支置 express-waiting
   * 时先查这里 —— 命中 success 立即部署、命中 failure 直接置 failed,不必苦等
   * 第二个永远不会来的 completion 事件（Bugbot/Codex P2:don't drop early
   * workflow_run completions）。进程内缓存(重启即丢,属可接受残留,见 debt 台账)。
   */
  private readonly recentCompletedRuns = new Map<
    string,
    { conclusion: string; htmlUrl?: string; at: number }
  >();
  private static readonly RECENT_RUN_CACHE_MAX = 200;
  private static readonly RECENT_RUN_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

  // 缓存键带 head_branch:branch-image.yml 对每个分支的 push 各跑一次 workflow_run,
  // 即便两个分支指向同一 commit,GitHub 也会发两条带不同 head_branch 的事件。若只按
  // repo+sha 做键,第二条会覆盖第一条、且一次性消费会让另一分支永远认领不到
  // （Bugbot:shared CI cache single consume）。带上 branch 即可让两个分支各拿各的。
  // head_branch 缺省的旧 payload 退回 repo+sha(branch='')。
  private recentRunKey(repoFullName: string, sha: string, branch?: string): string {
    return `${repoFullName.toLowerCase()}::${(branch || '').toLowerCase()}::${sha.toLowerCase()}`;
  }

  private rememberCompletedRun(
    repoFullName: string,
    sha: string,
    branch: string | undefined,
    conclusion: string,
    htmlUrl?: string,
  ): void {
    const now = Date.now();
    // 顺手剪枝过期项,顺带把 Map 控制在上限内(超限删最旧)。
    for (const [k, v] of this.recentCompletedRuns) {
      if (now - v.at > GitHubWebhookDispatcher.RECENT_RUN_CACHE_TTL_MS) this.recentCompletedRuns.delete(k);
    }
    while (this.recentCompletedRuns.size >= GitHubWebhookDispatcher.RECENT_RUN_CACHE_MAX) {
      const oldest = this.recentCompletedRuns.keys().next().value;
      if (oldest === undefined) break;
      this.recentCompletedRuns.delete(oldest);
    }
    this.recentCompletedRuns.set(this.recentRunKey(repoFullName, sha, branch), { conclusion, htmlUrl, at: now });
  }

  private takeCompletedRun(
    repoFullName: string,
    sha: string,
    branch: string,
  ): { conclusion: string; htmlUrl?: string } | undefined {
    // 先认领「本分支专属」键,未命中再退回旧 payload 的无分支键(branch='')。
    for (const key of [this.recentRunKey(repoFullName, sha, branch), this.recentRunKey(repoFullName, sha, '')]) {
      const hit = this.recentCompletedRuns.get(key);
      if (!hit) continue;
      this.recentCompletedRuns.delete(key); // 一次性消费,避免下次 push 误用陈旧结果
      if (Date.now() - hit.at > GitHubWebhookDispatcher.RECENT_RUN_CACHE_TTL_MS) return undefined;
      return { conclusion: hit.conclusion, htmlUrl: hit.htmlUrl };
    }
    return undefined;
  }

  /**
   * 极速版分支认领「早到并已缓存」的 CI 完成结果。命中即把分支推进到 ready/failed
   * 并返回对应结果(success 带 deployRequest);未命中返回 null 让调用方继续置 waiting。
   * push 正常路径与 docs-only 推进 ciTargetSha 后都走这里,避免缓存结果被漏认领
   * （Codex P2:check cached CI runs after docs-only target changes）。
   */
  private claimCachedCiRunForExpress(
    branchId: string,
    projectId: string,
    branchName: string,
    repoFullName: string,
    commitSha: string,
  ): WebhookDispatchResult | null {
    const cached = this.takeCompletedRun(repoFullName, commitSha, branchName);
    if (!cached) return null;
    if (cached.conclusion === 'success') {
      this.deps.stateService.updateBranchGithubMeta(branchId, {
        ciImageStatus: 'ready',
        ciTargetSha: commitSha,
        ciWorkflowConclusion: cached.conclusion,
        ciWorkflowRunUrl: cached.htmlUrl,
      });
      this.deps.stateService.save();
      this.emitCiStatus(branchId, projectId, 'ready', commitSha, cached.htmlUrl);
      return {
        action: 'ci-image-ready',
        message: `极速版分支 '${branchId}' 命中已完成的 CI 镜像（commit ${commitSha.slice(0, 7)}）,直接触发部署`,
        branchId,
        deployRequest: { branchId, commitSha },
      };
    }
    // 失败 / cancelled / timed_out — 置 failed,不自动回退（与 workflow_run 路径一致）。
    this.deps.stateService.updateBranchGithubMeta(branchId, {
      ciImageStatus: 'failed',
      ciTargetSha: commitSha,
      ciWorkflowConclusion: cached.conclusion,
      ciWorkflowRunUrl: cached.htmlUrl,
    });
    this.deps.stateService.save();
    this.emitCiStatus(branchId, projectId, 'failed', commitSha, cached.htmlUrl);
    return {
      action: 'ci-image-failed',
      message: `极速版分支 '${branchId}' 的 CI 构建未成功（${cached.conclusion}）,可在分支详情切回源码编译`,
      branchId,
    };
  }

  /**
   * Dispatch a webhook event. The `dryRun` option is set by the
   * `/api/github/webhook/self-test` endpoint to skip all state
   * mutations (addBranch / updateProject / worktree create / save).
   * Parsing and routing logic still runs so the result accurately
   * describes what a REAL webhook would have triggered — just without
   * creating files on disk or writing to state.json.
   *
   * IMPORTANT: dryRun flows through as a parameter to each handler,
   * NOT as instance state. An earlier version stored it on `this`
   * with a try/finally reset, but `handle()` has `await` suspension
   * points — a concurrent self-test request could flip the instance
   * flag to true while a real webhook was mid-flight, silently
   * making the real request skip all state writes. Caught by Cursor
   * Bugbot #450 round 4.
   */
  async handle(
    eventName: string,
    payload: unknown,
    options?: { dryRun?: boolean },
  ): Promise<WebhookDispatchResult> {
    const dryRun = options?.dryRun === true;
    switch (eventName) {
      case 'ping':
        return { action: 'ignored-ping', message: 'pong' };
      case 'push':
        return this.handlePush(payload as GitHubPushEvent, dryRun);
      case 'installation':
        return this.handleInstallation(payload as GitHubInstallationEvent);
      case 'installation_repositories':
        return this.handleInstallationRepos(payload as GitHubInstallationReposEvent, dryRun);
      case 'check_run':
        return this.handleCheckRun(payload as GitHubCheckRunEvent, dryRun);
      case 'pull_request':
        return this.handlePullRequest(payload as GitHubPullRequestEvent, dryRun);
      case 'issue_comment':
        return this.handleIssueComment(payload as GitHubIssueCommentEvent);
      case 'delete':
        return this.handleDelete(payload as GitHubDeleteEvent);
      case 'repository':
        return this.handleRepository(payload as GitHubRepositoryEvent, dryRun);
      case 'release':
        return this.handleRelease(payload as GitHubReleaseEvent);
      case 'workflow_run':
        return this.handleWorkflowRun(payload as GitHubWorkflowRunEvent, dryRun);
      default:
        return { action: 'ignored-event', message: `Unhandled event type '${eventName}'` };
    }
  }

  /**
   * PR_D.2: 项目级事件 policy 门禁。返回 true → 处理；返回 false → 调用方
   * 应直接 return ignored 短路。
   *
   * 解析顺序：
   *   1. project.githubEventPolicy[eventKey] 为 false → 拒绝
   *   2. policy 缺失 / 该字段未设 → push 事件兜底 githubAutoDeploy（向后兼容老
   *      开关），其它事件默认放行
   */
  private isEventEnabled(
    project: import('../types.js').Project | undefined,
    eventKey: keyof NonNullable<import('../types.js').Project['githubEventPolicy']>,
  ): boolean {
    if (!project) return true;
    const v = project.githubEventPolicy?.[eventKey];
    if (v === false) return false;
    if (v === true) return true;
    // undefined：push 走 legacy githubAutoDeploy 兼容；其它默认放行
    if (eventKey === 'push') return project.githubAutoDeploy !== false;
    return true;
  }

  private rememberProjectInstallation(project: Project, installationId: number | undefined): void {
    if (!installationId || project.githubInstallationId) return;
    this.deps.stateService.updateProject(project.id, {
      githubInstallationId: installationId,
      githubLinkedAt: project.githubLinkedAt || nowIso(),
    });
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

  private changedPathsFromPush(event: GitHubPushEvent): string[] {
    const out = new Set<string>();
    for (const commit of event.commits || []) {
      for (const p of [...(commit.added || []), ...(commit.modified || []), ...(commit.removed || [])]) {
        const normalized = String(p || '').trim().replace(/^\/+/, '');
        if (normalized) out.add(normalized);
      }
    }
    return [...out];
  }

  private isDocsOnlyPush(event: GitHubPushEvent): { ok: boolean; changedPaths: string[] } {
    const changedPaths = this.changedPathsFromPush(event);
    const commits = event.commits || [];
    const reportedSize = typeof event.size === 'number' ? event.size : undefined;
    const distinctSize = typeof event.distinct_size === 'number' ? event.distinct_size : undefined;
    if (commits.length >= 2048) return { ok: false, changedPaths };
    if (reportedSize !== undefined && reportedSize > commits.length) return { ok: false, changedPaths };
    if (distinctSize !== undefined && distinctSize > commits.length) return { ok: false, changedPaths };
    if (changedPaths.length === 0) return { ok: false, changedPaths };
    const impact = analyzeChangeImpact(changedPaths);
    return {
      ok: !impact.needsRestart && impact.hotReloadablePaths.length === 0 && impact.irrelevantPaths.length === changedPaths.length,
      changedPaths,
    };
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
    // PR_D.2: project.githubEventPolicy.slashCommand=false → 直接忽略
    if (!this.isEventEnabled(project, 'slashCommand')) {
      return { action: 'ignored-event', message: `slash command disabled for project ${project.id}` };
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
    // PR_D.2: project.githubEventPolicy.delete=false → 不自动清容器
    if (!this.isEventEnabled(project, 'delete')) {
      return { action: 'ignored-event', message: `delete handling disabled for project ${project.id}` };
    }
    if (!isSafeGitRef(event.ref)) {
      return { action: 'ignored-event', message: `Rejected unsafe delete ref: ${event.ref.slice(0, 80)}` };
    }
    const slugified = StateServiceClass.slugify(event.ref);
    const canonicalId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    // Prefer the canonical id, but fall back to a (projectId, branch)
    // lookup so a branch created under the previous legacyFlag formula
    // is still found after the flag was flipped.
    const entry =
      this.deps.stateService.getBranch(canonicalId) ??
      this.deps.stateService.findBranchByProjectAndName(project.id, event.ref);
    if (!entry) {
      return { action: 'ignored-event', message: `branch deleted on GitHub but not tracked by CDS: ${canonicalId}` };
    }
    const branchId = entry.id;
    return {
      action: 'branch-deleted',
      message: `GitHub branch '${event.ref}' deleted; stopping CDS preview '${branchId}' + cleanup entry`,
      branchId,
      stopRequest: { branchId },
      // 2026-05-07 用户反馈"分支已删除但 CDS 端没清理":除了 stopRequest 停容器,
      // 还要 branchDeleteRequest 删 CDS state.branches[id] + worktree。
      branchDeleteRequest: { branchId },
    };
  }

  /**
   * `repository` event — repo renamed, transferred, archived, deleted.
   * We defensively detach the link in each of these cases rather than
   * trying to auto-rename (rename could also collide with another
   * project's linkage). The operator can re-link via the UI after.
   */
  private async handleRepository(event: GitHubRepositoryEvent, dryRun: boolean): Promise<WebhookDispatchResult> {
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
      if (!dryRun) {
        this.deps.stateService.updateProject(project.id, {
          githubRepoFullName: undefined,
          githubInstallationId: undefined,
          githubAutoDeploy: undefined,
          githubLinkedAt: undefined,
        });
      }
      return {
        action: event.action === 'deleted' ? 'repo-detached' : 'repo-renamed',
        message: `${dryRun ? '[dry-run] ' : ''}Project '${project.name}' unlinked because repository.${event.action} (${currentFullName})`,
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

  /** 极速版（CI 预构建）：判断 workflow_run 是否来自「构建预构建镜像」的工作流。 */
  private isPrebuiltImageWorkflow(run: NonNullable<GitHubWorkflowRunEvent['workflow_run']>): boolean {
    // workflow_run.path 形如 `.github/workflows/branch-image.yml`。只认这个工作流,
    // 避免 ci.yml / cds.yml 等其它工作流先完成就误触发部署（那时镜像还没 push）。
    const base = (run.path || '').split('/').pop() || '';
    if (base === CI_PREBUILT_WORKFLOW_FILE) return true;
    // 兜底:按 workflow name 匹配（防止个别 GitHub 投递缺 path）。
    return (run.name || '').trim() === CI_PREBUILT_WORKFLOW_NAME;
  }

  private emitCiStatus(
    branchId: string,
    projectId: string,
    status: 'waiting' | 'ready' | 'failed',
    sha: string,
    runUrl?: string,
  ): void {
    branchEvents.emitEvent({
      type: 'branch.updated',
      payload: {
        branchId,
        projectId,
        patch: { ciImageStatus: status, ciTargetSha: sha, ciWorkflowRunUrl: runUrl },
        ts: nowIso(),
      },
    });
  }

  /**
   * 2026-06-23 极速版（CI 预构建）—— GitHub Actions 构建完成。
   *
   * 只处理 `completed` + 来自预构建镜像工作流（branch-image.yml）的 run,按
   * head_sha 找到「等待中」的极速版分支:
   *   - success → 置 ready + 返回 deployRequest（路由层触发 docker pull + 部署）
   *   - 其它   → 置 failed（前端提示可切回源码编译,不自动回退）
   */
  private async handleWorkflowRun(event: GitHubWorkflowRunEvent, dryRun: boolean): Promise<WebhookDispatchResult> {
    const run = event.workflow_run;
    if (!run || event.action !== 'completed') {
      return { action: 'workflow-acknowledged', message: `workflow_run ${event.action} 已 ack（只处理 completed）` };
    }
    if (!event.repository) {
      return { action: 'workflow-acknowledged', message: 'workflow_run 缺 repository,已 ack' };
    }
    if (!this.isPrebuiltImageWorkflow(run)) {
      return { action: 'workflow-acknowledged', message: `workflow_run '${run.name || run.path || '?'}' 非预构建镜像工作流,已 ack` };
    }
    const project = this.deps.stateService.findProjectByRepoFullName(event.repository.full_name);
    if (!project) {
      return { action: 'ignored-no-project', message: `No project linked to ${event.repository.full_name}` };
    }
    const headSha = run.head_sha;
    if (typeof headSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(headSha)) {
      return { action: 'workflow-acknowledged', message: 'workflow_run head_sha 缺失/格式非法,已 ack' };
    }
    // 找等待该 SHA 的极速版分支（push 时已把 ciTargetSha 钉为该 commit）。
    // 匹配条件（Bugbot/Codex review）：
    //  1. ciTargetSha === head_sha;
    //  2. **同时**比对 head_branch —— 多个分支可能指向同一 commit,GitHub 会按分支分别
    //     跑 branch-image.yml,只按 SHA 取「第一个」会把 B 分支的 run 误派给 A 分支。
    //     head_branch 缺省时退回只按 SHA（向后兼容）。
    //  3. waiting **或** failed —— 操作员对失败的 run 点 re-run 且同 SHA 成功时,应允许
    //     failed → ready 恢复,而不是因为不再是 waiting 就 ack 不动作（只能靠再 push 恢复）。
    const branches = this.deps.stateService.getBranchesForProject(project.id);
    const matchable = (b: BranchEntry): boolean =>
      (b.ciImageStatus === 'waiting' || b.ciImageStatus === 'failed')
      && b.ciTargetSha === headSha
      && (!run.head_branch || b.branch === run.head_branch);
    let target = branches.find(matchable);
    if (!target) {
      // 兜底:push webhook 被延迟/重试,而 branch-image.yml 的 workflow_run.completed
      // 抢先到达时,分支可能还没被 stamp 成 waiting/ciTargetSha → strict matcher 落空,
      // 成功的 CI 镜像被丢弃,之后 push 把分支置 waiting 却没有第二个 completion 事件
      // 来推进 → 极速版分支卡死（Bugbot/Codex P2:don't drop early workflow_run completions）。
      // 退而按 githubCommitSha===head_sha + 极速版 + 分支名兜底:push 路径已先 stamp
      // githubCommitSha(早于 waiting),只要它已落盘就能据此恢复部署;已 ready 的不重复触发。
      const fallbackProfiles = this.deps.stateService.getBuildProfilesForProject(project.id);
      target = branches.find((b) =>
        (!run.head_branch || b.branch === run.head_branch)
        && b.githubCommitSha === headSha
        && b.ciImageStatus !== 'ready'
        && branchUsesPrebuiltMode(fallbackProfiles, b));
    }
    if (!target) {
      // 没有分支匹配:很可能是 push webhook 还没处理到(延迟/重试),分支尚未 stamp。
      // 暂存结果,等稍后 push 把分支置 express-waiting 时认领(takeCompletedRun)。
      if (!dryRun) {
        this.rememberCompletedRun(event.repository.full_name, headSha, run.head_branch, run.conclusion || 'unknown', run.html_url);
      }
      return {
        action: 'workflow-acknowledged',
        message: `workflow_run(${run.conclusion}) @ ${headSha.slice(0, 7)} 暂无匹配分支,已缓存结果待 push 认领`,
      };
    }
    const branchId = target.id;
    const conclusion = run.conclusion || 'unknown';

    if (conclusion === 'success') {
      if (!dryRun) {
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          ciImageStatus: 'ready',
          ciWorkflowConclusion: conclusion,
          ciWorkflowRunUrl: run.html_url,
        });
        this.deps.stateService.save();
        this.emitCiStatus(branchId, target.projectId, 'ready', headSha, run.html_url);
      }
      return {
        action: 'ci-image-ready',
        message: `${dryRun ? '[dry-run] ' : ''}CI 镜像就绪（${headSha.slice(0, 7)}）,触发极速版部署 '${branchId}'`,
        branchId,
        deployRequest: { branchId, commitSha: headSha },
      };
    }

    // 失败 / cancelled / timed_out — 不自动回退,等用户手动切回源码编译。
    if (!dryRun) {
      this.deps.stateService.updateBranchGithubMeta(branchId, {
        ciImageStatus: 'failed',
        ciWorkflowConclusion: conclusion,
        ciWorkflowRunUrl: run.html_url,
      });
      this.deps.stateService.save();
      this.emitCiStatus(branchId, target.projectId, 'failed', headSha, run.html_url);
    }
    return {
      action: 'ci-image-failed',
      message: `${dryRun ? '[dry-run] ' : ''}CI 构建未成功（${conclusion}），极速版分支 '${branchId}' 保持等待,可在分支详情切回源码编译`,
      branchId,
    };
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
  private async handlePullRequest(event: GitHubPullRequestEvent, dryRun: boolean): Promise<WebhookDispatchResult> {
    if (!event.pull_request || !event.repository) {
      return { action: 'ignored-event', message: 'pull_request missing pull_request/repository' };
    }
    const repoFullName = event.repository.full_name;
    const project = this.deps.stateService.findProjectByRepoFullName(repoFullName);
    if (!project) {
      return { action: 'ignored-no-project', message: `No project linked to ${repoFullName}` };
    }
    if (!dryRun) this.rememberProjectInstallation(project, event.installation?.id);

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
    const canonicalId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    // Fall back to a (projectId, branch) lookup so a legacyFlag flip
    // doesn't hide an existing entry stored under the old id.
    const entry =
      this.deps.stateService.getBranch(canonicalId) ??
      this.deps.stateService.findBranchByProjectAndName(project.id, branchName);
    const branchId = entry?.id ?? canonicalId;

    // `closed` action — tear down preview containers.
    if (event.action === 'closed') {
      // PR_D.2: project.githubEventPolicy.prClose=false → 不自动停容器
      if (!this.isEventEnabled(project, 'prClose')) {
        return { action: 'ignored-event', message: `PR-close handling disabled for project ${project.id}` };
      }
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
      // PR_D.2: project.githubEventPolicy.prOpen=false → 不自动建分支 + 部署
      if (!this.isEventEnabled(project, 'prOpen')) {
        return { action: 'ignored-event', message: `PR-open handling disabled for project ${project.id}` };
      }
      if (entry && !dryRun) {
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          githubPrNumber: event.pull_request.number,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
          githubRepoFullName: repoFullName,
          githubSenderLogin: event.sender?.login,
          githubSenderAvatarUrl: event.sender?.avatar_url,
        });
        this.deps.stateService.save();
      }
      return {
        action: 'pr-comment-posted',
        message: `${dryRun ? '[dry-run] ' : ''}PR #${event.pull_request.number} ${event.action}; marked branch '${branchId}' for comment`,
        branchId,
      };
    }

    // synchronize / edited / etc.
    return { action: 'ignored-event', message: `pull_request.${event.action} ignored` };
  }

  private async handlePush(event: GitHubPushEvent, dryRun: boolean): Promise<WebhookDispatchResult> {
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
    if (!isAllowedCdsBranchName(branchName)) {
      return {
        action: 'ignored-event',
        message: `Rejected non-branch ref from webhook: ${branchName.slice(0, 120)}`,
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
    const receivedAt = nowIso();

    const project = this.deps.stateService.findProjectByRepoFullName(repoFullName);
    if (!project) {
      return {
        action: 'ignored-no-project',
        message: `No project linked to ${repoFullName}. Ignoring push.`,
      };
    }
    if (!dryRun) this.rememberProjectInstallation(project, event.installation?.id);

    // PR_D.2: 统一走 isEventEnabled('push')，内部已 fallback 到老的
    // githubAutoDeploy；新代码用 githubEventPolicy.push。
    if (!this.isEventEnabled(project, 'push')) {
      return {
        action: 'ignored-auto-deploy-off',
        message: `Project '${project.name}' has push handling off. Ignoring push.`,
      };
    }

    // Ensure branch exists — auto-create a worktree when the push hits a
    // branch CDS hasn't tracked yet. Uses the same id convention as the
    // `POST /branches` route (legacy projects use the bare slug, named
    // projects prefix with the project slug) so frontend URLs match.
    //
    // Also fall back to a (projectId, branch) lookup so a project whose
    // `legacyFlag` was toggled after an earlier branch was stored under
    // the previous formula still resolves to that existing entry —
    // otherwise a single push would spawn a phantom duplicate (bug: same
    // repo's `main` appearing as both `main` and `<slug>-main`).
    const slugified = StateServiceClass.slugify(branchName);
    const canonicalId = project.legacyFlag ? slugified : `${project.slug}-${slugified}`;
    let entry =
      this.deps.stateService.getBranch(canonicalId) ??
      this.deps.stateService.findBranchByProjectAndName(project.id, branchName);
    const branchId = entry?.id ?? canonicalId;
    let created = false;

    // 项目构建配置（极速版判定 + created 分支默认对齐共用）。早算一次,供下面
    // docs-only / dry-run / express 分流复用,避免散落多处重复读取。
    const profiles = this.deps.stateService.getBuildProfilesForProject(project.id);
    // 判定某分支(或 webhook 即将新建的分支)是否走极速版(CI 预构建)模式。
    //  - 已存在分支:直接按其 profileOverrides 判定。
    //  - 即将新建分支(existing=undefined):webhook 建分支时会 applyDefaultDeployModesToBranch
    //    把项目默认 override 拷进去 —— 这里用临时 entry 模拟同样拷贝再判定,
    //    使 dry-run / self-test 与真实路径口径一致（Bugbot:dry-run ignores express wait path）。
    const resolveExpress = (existing: BranchEntry | undefined): boolean => {
      if (profiles.length === 0) return false;
      if (existing) return branchUsesPrebuiltMode(profiles, existing);
      if (!project.defaultDeployModes) return false;
      const sim: BranchEntry = {
        id: branchId,
        projectId: project.id,
        branch: branchName,
        worktreePath: '',
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      };
      applyDefaultDeployModesToBranch(sim, project.defaultDeployModes, profiles);
      return branchUsesPrebuiltMode(profiles, sim);
    };

    const docsOnly = entry ? this.isDocsOnlyPush(event) : { ok: false, changedPaths: [] };
    if (docsOnly.ok) {
      if (!dryRun) {
        // 极速版分支正在「等待 CI 镜像」时,docs-only push 也会让 branch-image.yml
        // 重新构建出新 commit 的镜像(CI 不做 path-filter)。若只刷新 githubCommitSha
        // 而不同步 ciTargetSha,workflow_run 匹配按 ciTargetSha===head_sha 就会落在
        // 旧 SHA 上,新 commit 的 run 永远不匹配 → 分支卡死在 waiting（Bugbot:
        // doc-only push stale CI target）。故 express + waiting 时把 ciTargetSha 一并推进。
        const docsOnlyExpressWaiting =
          !!entry && entry.ciImageStatus === 'waiting' && branchUsesPrebuiltMode(profiles, entry);
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          githubRepoFullName: repoFullName,
          githubCommitSha: commitSha,
          lastPushAt: receivedAt,
          githubSenderLogin: event.sender?.login,
          githubSenderAvatarUrl: event.sender?.avatar_url,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
          ...(docsOnlyExpressWaiting ? { ciTargetSha: commitSha } : {}),
        });
        this.deps.stateService.save();
        // docs-only 把 ciTargetSha 推进到新 commit 后,若该新 SHA 的 CI 完成事件早已
        // 到达并被缓存,这条 docs-only 路径不会再收到第二个 completion 来推进 → 必须
        // 同样认领缓存,否则分支卡死 waiting（Codex P2:check cached CI runs after
        // docs-only target changes）。命中即直接 ready+deploy / failed。
        if (docsOnlyExpressWaiting) {
          const claimed = this.claimCachedCiRunForExpress(
            branchId, entry!.projectId, branchName, repoFullName, commitSha,
          );
          if (claimed) return claimed;
        }
        const updatedEntry = this.deps.stateService.getBranch(branchId);
        if (updatedEntry) {
          branchEvents.emitEvent({
            type: 'branch.updated',
            payload: {
              branchId,
              projectId: updatedEntry.projectId,
              patch: {
                githubRepoFullName: updatedEntry.githubRepoFullName,
                githubCommitSha: updatedEntry.githubCommitSha,
                lastPushAt: updatedEntry.lastPushAt,
              },
              ts: receivedAt,
            },
          });
        }
      }
      return {
        action: 'ignored-doc-only',
        message: `${dryRun ? '[dry-run] ' : ''}Push ${commitSha.slice(0, 7)} only changed ${docsOnly.changedPaths.length} non-runtime file(s); refreshed branch metadata without deploy.`,
        branchId,
      };
    }

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

      if (dryRun) {
        // In dry-run we return the shape of "would-create" without
        // touching disk or state — self-test wants accurate signals.
        // 极速版分支建好后不会立即部署,而是等 CI 镜像 → dry-run 必须返回同样的
        // ci-image-waiting 形状(无 deployRequest),否则 self-test 会以为会部署,
        // 与真实 express 处理不一致（Bugbot:dry-run ignores express wait path）。
        if (resolveExpress(undefined)) {
          return {
            action: 'ci-image-waiting',
            message: `[dry-run] 极速版分支 '${branchId}' 将等待 CI 构建镜像（commit ${commitSha.slice(0, 7)}）后拉取部署`,
            branchId,
          };
        }
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

    if (dryRun) {
      // 已存在分支若是极速版,真实路径会置 waiting 等 CI、不返回 deployRequest。
      // dry-run 对齐这一形状（Bugbot:dry-run ignores express wait path）。
      if (resolveExpress(entry)) {
        return {
          action: 'ci-image-waiting',
          message: `[dry-run] 极速版分支 '${branchId}' 将等待 CI 构建镜像（commit ${commitSha.slice(0, 7)}）后拉取部署`,
          branchId,
        };
      }
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
      lastPushAt: receivedAt,
      githubSenderLogin: event.sender?.login,
      githubSenderAvatarUrl: event.sender?.avatar_url,
      githubInstallationId: project.githubInstallationId ?? event.installation?.id,
    });
    this.deps.stateService.save();

    // Live UI stream: notify any subscribed Dashboard about this change
    // so the branch card animates in / refreshes without a page reload.
    // `source: 'github-webhook'` drives the frontend to paint the GitHub
    // Octocat icon (vs generic branch mark) in the card title.
    const updatedEntry = this.deps.stateService.getBranch(branchId);
    if (updatedEntry) {
      if (created) {
        branchEvents.emitEvent({
          type: 'branch.created',
          payload: { branch: updatedEntry, source: 'github-webhook', ts: nowIso() },
        });
      } else {
        branchEvents.emitEvent({
          type: 'branch.updated',
          payload: {
            branchId,
            projectId: updatedEntry.projectId,
            patch: {
              githubRepoFullName: updatedEntry.githubRepoFullName,
              githubCommitSha: updatedEntry.githubCommitSha,
              lastPushAt: updatedEntry.lastPushAt,
              githubSenderLogin: updatedEntry.githubSenderLogin,
              githubSenderAvatarUrl: updatedEntry.githubSenderAvatarUrl,
            },
            ts: receivedAt,
          },
        });
      }
    }

    // ── 2026-06-23 极速版（CI 预构建）分流 ──────────────────────────────
    // webhook 自动建分支时补回项目默认 deploy mode（与 UI 建分支一致;否则新分支
    // 拿不到极速版 override）。已存在分支不动（其 override 已是 SSOT）。
    // profiles 已在 handlePush 顶部 hoist。
    if (created && project.defaultDeployModes && profiles.length > 0) {
      const fresh = this.deps.stateService.getBranch(branchId);
      if (fresh) {
        applyDefaultDeployModesToBranch(fresh, project.defaultDeployModes, profiles);
        // 显式落盘（mongo-split store 下 getBranch 可能返回副本,mutate 不持久化）
        for (const [pid, ov] of Object.entries(fresh.profileOverrides || {})) {
          this.deps.stateService.setBranchProfileOverride(branchId, pid, ov);
        }
      }
    }

    // 该分支是否走预构建镜像模式？是 → 不本机编译,改为「等待 CI 镜像就绪」,
    // 等 GitHub Actions 的 workflow_run.completed 到达后再按 commit SHA 拉取部署。
    //
    // 注意（Bugbot/Codex review）：此处**不传** project.defaultDeployModes —— 部署路径
    // resolveEffectiveProfile 按 2026-05-14 产品决策**不读**项目默认（默认只在建分支时
    // 拷贝一次写进 override）。若这里用项目默认判定,则「已存在、无 override」的分支会被
    // 误判成极速版 → 置 waiting 等 CI,但 deploy 仍走源码模式,自相矛盾。created 分支上面
    // 已 applyDefaultDeployModesToBranch 写了 override,靠 override 即可命中。
    const entryForMode = this.deps.stateService.getBranch(branchId) ?? entry;
    const isExpress = branchUsesPrebuiltMode(profiles, entryForMode);
    if (isExpress) {
      // 竞态认领:若 branch-image.yml 的 workflow_run.completed 早于本次 push 到达,
      // 结果已被 rememberCompletedRun 暂存。这里先认领 —— 命中就不必置 waiting 苦等
      // 一个永远不会再来的 completion 事件（Bugbot/Codex P2）。
      const claimed = this.claimCachedCiRunForExpress(
        branchId, entryForMode.projectId, branchName, repoFullName, commitSha,
      );
      if (claimed) return claimed;
      this.deps.stateService.updateBranchGithubMeta(branchId, {
        ciImageStatus: 'waiting',
        ciTargetSha: commitSha,
        ciWorkflowConclusion: undefined,
      });
      this.deps.stateService.save();
      const waitEntry = this.deps.stateService.getBranch(branchId);
      if (waitEntry) {
        branchEvents.emitEvent({
          type: 'branch.updated',
          payload: {
            branchId,
            projectId: waitEntry.projectId,
            patch: {
              ciImageStatus: 'waiting',
              ciTargetSha: commitSha,
              githubCommitSha: waitEntry.githubCommitSha,
            },
            ts: receivedAt,
          },
        });
      }
      return {
        action: 'ci-image-waiting',
        message: `极速版分支 '${branchId}' 等待 CI 构建镜像（commit ${commitSha.slice(0, 7)}）;CI 完成后自动拉取部署`,
        branchId,
      };
    }

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
    dryRun: boolean,
  ): Promise<WebhookDispatchResult> {
    const instId = event.installation?.id;
    if (!instId) {
      return { action: 'ignored-event', message: 'installation_repositories missing installation.id' };
    }
    // If a repo was removed from the installation AND it's linked to a
    // project, detach the link so webhooks for it stop triggering deploys.
    if (event.action === 'removed' && !dryRun) {
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

  private async handleCheckRun(event: GitHubCheckRunEvent, dryRun: boolean): Promise<WebhookDispatchResult> {
    if (event.action !== 'rerequested') {
      return { action: 'ignored-event', message: `check_run ${event.action} ignored` };
    }
    const branchId = event.check_run?.external_id;
    if (!branchId) return { action: 'ignored-event', message: 'check_run missing external_id' };
    const entry = this.deps.stateService.getBranch(branchId);
    if (!entry) return { action: 'ignored-event', message: `check_run branch '${branchId}' not found` };
    const commitSha = event.check_run?.head_sha;
    // SHA format validation — parallel to handlePush (defense-in-depth).
    // Bugbot #450 round 6 pointed out that handleCheckRun was missing
    // this check, and unvalidated SHA would get persisted + .slice()'d
    // later (throwing on undefined / malformed input).
    if (typeof commitSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commitSha)) {
      return { action: 'ignored-event', message: 'check_run has malformed or missing head_sha' };
    }
    if (!dryRun) {
      this.deps.stateService.updateBranchGithubMeta(branchId, { githubCommitSha: commitSha });
      this.deps.stateService.save();
    }
    return {
      action: 'check-run-requeued',
      message: `${dryRun ? '[dry-run] ' : ''}Queued redeploy of '${branchId}' at ${commitSha.slice(0, 7)}`,
      branchId,
      deployRequest: { branchId, commitSha },
    };
  }
}
