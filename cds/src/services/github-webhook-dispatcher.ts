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
import { isTrunkBranch } from './branch-protection.js';
import { branchUsesPrebuiltMode, applyDefaultDeployModesToBranch } from './deploy-runtime.js';
import { decideProjectScope, resolveProjectScope } from './project-scope.js';

/**
 * 2026-06-23 极速版（CI 预构建）—— 负责构建预构建镜像的 GitHub Actions 工作流标识。
 * CDS 只在这个工作流的 workflow_run.completed 到达时才触发拉取部署,避免被 ci.yml /
 * cds.yml 等其它工作流的完成事件误触发（那时镜像还没 push 到 ghcr）。
 * 后续可做成 project 级配置以泛化到任意 public 仓库（见 doc/debt.cds.ci-prebuilt.md）。
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

/**
 * 把「同一个仓库下每个项目各自的 push 结果」收敛成一条主结果 + 其余挂在 fanout。
 *
 * 挑主结果的顺序刻意是「谁真的要干活谁当主」：先看有没有人要部署，再看有没有人
 * 不是被忽略的，最后才退回第一条。理由是 webhook 的 HTTP 响应与投递记录只显示
 * 主结果 —— 如果让一条 `ignored-out-of-scope` 当主，面板上就会显示「本次被忽略」，
 * 而实际上另一个项目正在构建，看的人会以为没动。
 *
 * 纯函数，与调用它的类无关，可直接单测。
 */
/** 这条结果有没有要求路由去做点什么（部署 / 停容器 / 删分支）。 */
function carriesAction(r: WebhookDispatchResult): boolean {
  return !!(r.deployRequest || r.stopRequest || r.branchDeleteRequest);
}

/**
 * 把同一个仓库下各项目的处理结果合成一条对外结果。
 *
 * 主结果的挑法有讲究：**优先挑真的要干活的那条**。否则面板上显示「已忽略」，
 * 而后台其实正在给另一个项目构建 —— 那种不一致比报错更难查。
 *
 * 挑出来之后其余的放进 `fanout`，路由必须与主结果同等对待。少了这一步，
 * 第二个项目就是「收得到事件、没人替它干活」，而且没有任何信号。
 */
export function mergeFanoutResults(
  results: WebhookDispatchResult[],
  projects: readonly { id: string; name: string }[],
  /** 事件名，用于凑那句可观测的后缀 */
  eventLabel = 'push',
): WebhookDispatchResult {
  if (results.length === 0) {
    return { action: 'ignored-no-project', message: `没有任何项目处理本次 ${eventLabel}` };
  }
  if (results.length === 1) return results[0];

  let primaryIndex = results.findIndex(carriesAction);
  if (primaryIndex < 0) primaryIndex = results.findIndex((r) => !r.action.startsWith('ignored-'));
  if (primaryIndex < 0) primaryIndex = 0;

  const primary = results[primaryIndex];
  const others = results.filter((_, index) => index !== primaryIndex);
  const actingCount = results.filter(carriesAction).length;
  // 主结果的 message 要带上「这个仓库还有几个项目、其中几个真的动了」，否则投递
  // 记录里只看得见一个项目，多项目分发等于没有可观测性。
  const suffix = `（本仓库共 ${projects.length} 个项目，本次 ${actingCount} 个触发处理）`;
  return {
    ...primary,
    message: `${primary.message}${suffix}`,
    fanout: others,
  };
}

export interface WebhookDispatchResult {
  /** Machine-readable outcome. */
  action:
    | 'ignored-no-project'
    | 'ignored-delete'
    | 'ignored-non-branch'
    | 'ignored-non-push-branch'
    | 'ignored-auto-deploy-off'
    | 'ignored-project-paused'
    | 'ignored-bot-push'
    // 一仓多项目：该项目声明了构建输入范围，而本次改动一条都没落进去
    | 'ignored-out-of-scope'
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
    // 2026-07-09 入口校验：仓库缺 branch-image.yml，不进 waiting 直接归因失败
    | 'ci-image-workflow-missing'
    | 'workflow-acknowledged';
  /** Short human message for the response + logs. */
  message: string;
  /**
   * 一仓多项目 push 分发：除主结果之外，同一个仓库下其它项目各自的处理结果。
   *
   * 只在 push 事件、且该仓库确实挂着多个项目时出现。路由必须把它和主结果**同等
   * 对待**（尤其是各自的 deployRequest），否则第二个项目又会退回到「收得到事件、
   * 但没人替它部署」——那是比收不到事件更难发现的一种半接线。
   */
  fanout?: WebhookDispatchResult[];
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
   * Populated on `pull_request.closed` —— 让路由层写一条分支墓碑，使过期分支
   * 预览页能区分"已合并到主分支"（引导切主分支）与"已放弃"（跳 PR/commit）。
   * 路由层据此计算 previewSlug + 解析默认分支后调 stateService.recordRemovedBranch。
   */
  tombstoneRequest?: {
    branchId: string;
    branch: string;
    projectId: string;
    reason: 'merged' | 'abandoned';
    prNumber?: number;
    prUrl?: string;
    mergeCommitSha?: string;
    baseRef?: string;
    /** 删除前的自定义子域别名快照，供别名访问 gone 页时兜底匹配墓碑。 */
    aliases?: string[];
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
  sender?: { login?: string; avatar_url?: string; type?: string };
}

/**
 * GitHub 的 bot 账号通常同时带 type=Bot 与 `[bot]` login；两种信号都接收，
 * 兼容 webhook fixture、旧 GitHub Enterprise 和字段不完整的代理转发。
 */
export function isGitHubBotSender(sender: GitHubPushEvent['sender']): boolean {
  if (!sender) return false;
  if (sender.type?.toLowerCase() === 'bot') return true;
  return typeof sender.login === 'string' && /\[bot\]$/i.test(sender.login.trim());
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
    merge_commit_sha?: string;
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
  /**
   * 发布中心「自动发布规则」的触发钩子（ScheduledJobService.runPushRules）。
   *
   * 用回调而不是直接注入 ScheduledJobService：dispatcher 只负责「发生了什么事件」，
   * 「谁该被这个事件叫醒」是发布侧的判据，两边不该互相 import。
   * 缺省不注入时整条规则链路静默不启用——所以 server 的接线有守卫盯着。
   */
  runPushRules?: (ctx: {
    projectId: string;
    branch: string;
    event: 'push' | 'pr-open';
    changedPaths: string[];
    /** 本次 push 的 commit。路径过滤按它判，发布也必须钉在它上面。 */
    commitSha?: string;
  }) => Promise<number>;
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
  /**
   * 极速版 workflow 存在性缓存（repo@branch → 结果 + 时间戳，TTL 10 分钟）。
   * webhook 每次 push 都可能触发校验，同分支高频 push 不该每次都打一次
   * GitHub contents API。只缓存确定性结果（exists/missing）；unknown 属瞬态
   * API 异常，不缓存（下次 push 再试）。
   */
  private readonly workflowPresenceCache = new Map<string, { result: 'exists' | 'missing'; checkedAt: number }>();

  private async checkExpressWorkflowPresence(
    repoFullName: string,
    branchName: string,
    commitSha: string,
    installationId: number | undefined,
  ): Promise<'exists' | 'missing' | 'unknown'> {
    if (!this.deps.githubApp || !installationId) return 'unknown';
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) return 'unknown';
    const cacheKey = `${repoFullName}@${branchName}`;
    const cached = this.workflowPresenceCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 10 * 60 * 1000) return cached.result;
    const result = await this.deps.githubApp.workflowFileExists(installationId, owner, repo, commitSha);
    if (result !== 'unknown') {
      this.workflowPresenceCache.set(cacheKey, { result, checkedAt: Date.now() });
    }
    return result;
  }

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
  //
  // 还要带 projectId（2026-09-02）：一个仓库喂多个项目之后，同一条 head_branch
  // 在每个项目下各有一条分支，它们要各自认领同一次 CI 完成。只按 repo+branch+sha
  // 做键时是**一次性消费**——第一个项目拿走，第二个项目再也认领不到，于是永远停在
  // 等待中且没有任何报错。这正是上面那条 Bugbot 修复在多项目下的同一形状。
  private recentRunKey(repoFullName: string, sha: string, branch?: string, projectId?: string): string {
    return `${(projectId || '').toLowerCase()}::${repoFullName.toLowerCase()}::${(branch || '').toLowerCase()}::${sha.toLowerCase()}`;
  }

  private rememberCompletedRun(
    repoFullName: string,
    sha: string,
    branch: string | undefined,
    conclusion: string,
    htmlUrl: string | undefined,
    projectId: string,
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
    this.recentCompletedRuns.set(this.recentRunKey(repoFullName, sha, branch, projectId), { conclusion, htmlUrl, at: now });
  }

  private takeCompletedRun(
    repoFullName: string,
    sha: string,
    branch: string,
    projectId: string,
  ): { conclusion: string; htmlUrl?: string } | undefined {
    // 先认领「本项目 + 本分支专属」键,未命中再退回旧 payload 的无分支键(branch='')。
    for (const key of [
      this.recentRunKey(repoFullName, sha, branch, projectId),
      this.recentRunKey(repoFullName, sha, '', projectId),
    ]) {
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
    const cached = this.takeCompletedRun(repoFullName, commitSha, branchName, projectId);
    if (!cached) return null;
    if (cached.conclusion === 'success') {
      this.deps.stateService.updateBranchGithubMeta(branchId, {
        ciImageStatus: 'ready',
        ciTargetSha: commitSha,
        ciWorkflowConclusion: cached.conclusion,
        ciWorkflowRunUrl: cached.htmlUrl,
        ciWaitingSince: '',
        ciImageError: '',
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
    // 必须同样写 ciImageError + 清 ciWaitingSince：此路径让分支脱离 waiting，看门狗不再兜底，
    // 若不写归因，已打开的看板翻 failed 却显示空/旧错误文案（Codex P2）。
    this.deps.stateService.updateBranchGithubMeta(branchId, {
      ciImageStatus: 'failed',
      ciTargetSha: commitSha,
      ciWorkflowConclusion: cached.conclusion,
      ciWorkflowRunUrl: cached.htmlUrl,
      ciWaitingSince: '',
      ciImageError: `CI 构建未成功（${cached.conclusion}）。可在分支详情切回源码编译重试。`,
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
   *   0. project.paused === true → 整个项目冻结，所有事件一律拒绝
   *   1. project.githubEventPolicy[eventKey] 为 false → 拒绝
   *   2. policy 缺失 / 该字段未设 → push 事件兜底 githubAutoDeploy（向后兼容老
   *      开关），其它事件默认放行
   */
  private isEventEnabled(
    project: import('../types.js').Project | undefined,
    eventKey: keyof NonNullable<import('../types.js').Project['githubEventPolicy']>,
  ): boolean {
    if (!project) return true;
    // 2026-06-23：项目暂停 = 冻结所有 webhook 行为（push/PR/delete/comment）。
    // 暂停时不再自动建分支 / 部署 / 清理容器，是「反复构建止血」的核心闸门。
    if (project.paused === true) return false;
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

  /**
   * 这次 push 的改动清单是不是完整的。
   *
   * GitHub 的 push payload 会截断 commits（`size` / `distinct_size` 报的是真实
   * 条数），截断之后 `changedPathsFromPush` 返回的是一份**非空但不全**的清单 ——
   * 这是最危险的一种输入：它看起来像证据，实际会让任何「按改动路径下判断」的
   * 逻辑得出反向结论。所以凡是拿改动清单做判断的地方都必须先问这一句。
   */
  private changedPathsComplete(event: GitHubPushEvent): boolean {
    const commits = event.commits || [];
    const reportedSize = typeof event.size === 'number' ? event.size : undefined;
    const distinctSize = typeof event.distinct_size === 'number' ? event.distinct_size : undefined;
    if (commits.length >= 2048) return false;
    if (reportedSize !== undefined && reportedSize > commits.length) return false;
    if (distinctSize !== undefined && distinctSize > commits.length) return false;
    return true;
  }

  private isDocsOnlyPush(event: GitHubPushEvent): { ok: boolean; changedPaths: string[] } {
    const changedPaths = this.changedPathsFromPush(event);
    if (!this.changedPathsComplete(event)) return { ok: false, changedPaths };
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
  /**
   * 删分支：仓库下每个项目各有一条同名预览分支，得逐个清理。
   *
   * 只清第一个的后果不会报错，只会留下一堆没人管的容器和分支卡 —— 而且用户
   * 在 GitHub 上删了分支，本来预期的就是「都收拾干净」。
   */
  private async handleDelete(event: GitHubDeleteEvent): Promise<WebhookDispatchResult> {
    if (event.ref_type !== 'branch') {
      return { action: 'ignored-event', message: `delete ref_type=${event.ref_type} ignored` };
    }
    if (!event.repository) {
      return { action: 'ignored-event', message: 'delete event missing repository' };
    }
    // ref 合不合法是仓库级的事，不是项目级的 —— 放进循环会让一次仓库级拒绝
    // 被报成「N 个项目各拒了一次」。
    if (!isSafeGitRef(event.ref)) {
      return { action: 'ignored-event', message: `Rejected unsafe delete ref: ${event.ref.slice(0, 80)}` };
    }
    const projects = this.deps.stateService.findProjectsByRepoFullName(event.repository.full_name);
    if (projects.length === 0) {
      return { action: 'ignored-no-project', message: `No project linked to ${event.repository.full_name}` };
    }
    const results: WebhookDispatchResult[] = [];
    for (const project of projects) {
      results.push(await this.handleDeleteForProject(event, project));
    }
    return mergeFanoutResults(results, projects, 'delete');
  }

  private async handleDeleteForProject(
    event: GitHubDeleteEvent,
    project: Project,
  ): Promise<WebhookDispatchResult> {
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
    // 主干兜底（2026-07-27 P0：CDS 把 main 回收删掉）：GitHub 上删除主干是极端事件，
    // 更常见的是 webhook 误判（ref 实为 tag、分支名匹配错、仓库刚改过默认分支）。
    // 任何情况下都不允许由一条 webhook 自动删掉主干预览 —— 拒绝停容器 + 拒绝删 entry，
    // 只留一条可读的日志（webhook 投递记录里的 dispatchReason 就是这条 message）。
    // 真要删主干，走 CDS UI 的手动删除，由人确认。
    // 这里刻意也不写墓碑：墓碑语义是「该分支已放弃」，而我们恰恰在拒绝放弃它，
    // 写了会让 gone 页/历史台账把还活着的主干标成已放弃。
    if (isTrunkBranch(entry, project)) {
      return {
        action: 'ignored-event',
        message: `拒绝自动删除主干分支 "${entry.branch}"（CDS 分支 ${branchId}）：主干受保护，webhook 不会停容器也不会删除分支条目。如确需删除请在 CDS 手动操作。`,
        branchId,
      };
    }
    // 墓碑（gone 页用的「已放弃」元数据）独立于 delete「自动清容器」策略，任何删除都记。
    // 否则 delete 策略关闭时不写墓碑 → 过期预览仍落泛化「启动失败」而非「已放弃」（Bugbot）。
    // 与 PR-close 路径一致：reason 固定 abandoned（delete 事件无合并语义），若此前 PR 合并
    // 已写 'merged' 墓碑，recordRemovedBranch 的 merged 粘性保证不被降级。
    const tombstoneRequest = {
      branchId,
      branch: entry.branch || event.ref,
      projectId: project.id,
      reason: 'abandoned' as const,
      aliases: entry.subdomainAliases,
    };
    // PR_D.2: project.githubEventPolicy.delete=false → 不自动清容器（但墓碑照记）
    if (!this.isEventEnabled(project, 'delete')) {
      return {
        action: 'ignored-event',
        message: `delete auto-cleanup disabled for project ${project.id}（仅记墓碑，不停容器/不删 entry）`,
        tombstoneRequest,
      };
    }
    return {
      action: 'branch-deleted',
      message: `GitHub branch '${event.ref}' deleted; stopping CDS preview '${branchId}' + cleanup entry`,
      branchId,
      stopRequest: { branchId },
      // 2026-05-07 用户反馈"分支已删除但 CDS 端没清理":除了 stopRequest 停容器,
      // 还要 branchDeleteRequest 删 CDS state.branches[id] + worktree。
      branchDeleteRequest: { branchId },
      tombstoneRequest,
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
    // 真正驱动 UI 的不是这里的 patch —— /api/branches/stream 的 branch.updated 会从 state
    // 重新序列化整个 branch 下发，BranchList 按 data.branch merge。所以 ciImageError 等的
    // 清空必须在 **state** 里写 '' 而非 undefined（见各 updateBranchGithubMeta 调用），否则
    // JSON.stringify 丢字段、客户端 merge 保留旧值（failed→ready 恢复时旧错误文案不消失）。
    // patch 这里仍带上同名字段作语义说明，用 '' 兜底保持与 state 一致。
    const fresh = this.deps.stateService.getBranch(branchId);
    branchEvents.emitEvent({
      type: 'branch.updated',
      payload: {
        branchId,
        projectId,
        patch: {
          ciImageStatus: status,
          ciTargetSha: sha,
          ciWorkflowRunUrl: runUrl ?? '',
          ciWorkflowConclusion: fresh?.ciWorkflowConclusion ?? '',
          ciImageError: fresh?.ciImageError ?? '',
        },
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
    // 极速版下这一步最不能只认第一个项目：多个项目的分支都在等同一个 head_sha
    // 的镜像，只推进第一个，其余会**永远停在等待中**，而且没有任何报错。
    const projects = this.deps.stateService.findProjectsByRepoFullName(event.repository.full_name);
    if (projects.length === 0) {
      return { action: 'ignored-no-project', message: `No project linked to ${event.repository.full_name}` };
    }
    const wfResults: WebhookDispatchResult[] = [];
    for (const project of projects) {
      wfResults.push(await this.handleWorkflowRunForProject(event, project, dryRun));
    }
    return mergeFanoutResults(wfResults, projects, 'workflow_run');
  }

  private async handleWorkflowRunForProject(
    event: GitHubWorkflowRunEvent,
    project: Project,
    dryRun: boolean,
  ): Promise<WebhookDispatchResult> {
    // 编排层已经确认过这两个字段，这里收窄类型，避免每处再判一次空。
    const run = event.workflow_run!;
    const repoFullName = event.repository!.full_name;
    const headSha = run.head_sha;
    // 这一条既是校验也是收窄类型，所以留在这里，不上提到编排层。
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
    // 只按「显式等待标记」匹配:ciTargetSha===head_sha + waiting/failed + 分支名。
    //  - ciTargetSha 是 push 路径**显式**置 waiting 时钉下的「我在等这个 SHA 的 CI 镜像」,
    //    是部署意图的可信标记;docs-only 等不该部署的 push 不会置它。
    //  - **不**用 githubCommitSha 兜底:那只是「最近一次 push 的 commit」,docs-only push
    //    也会刷新它 → 按它匹配会把 docs-only 显式跳过的 commit 也部署掉
    //    （Codex P2: don't fallback-deploy docs-only CI runs）。
    //  - 延迟/重试导致 workflow_run 早于 push 到达的竞态,由下方 rememberCompletedRun 缓存
    //    兜底(push 置 waiting 时 takeCompletedRun 认领),不靠 githubCommitSha 猜。
    //  - waiting **或** failed:操作员对失败 run 点 re-run 且同 SHA 成功时允许 failed→ready 恢复。
    //  - head_branch 比对:多分支可能指向同一 commit,GitHub 按分支分别跑 branch-image.yml,
    //    缺省时退回只按 SHA(向后兼容)。
    // 还要校验分支**当前**仍是极速版（Codex P2: re-check mode before consuming CI
    // completions）:用户若把 override 从 express 切回 dev/static,旧的 ciImageStatus/
    // ciTargetSha 可能还在,此时不该再认 CI 完成事件去自动重部署一个已退出极速版的分支。
    const wfProfiles = this.deps.stateService.getBuildProfilesForProject(project.id);
    const matchable = (b: BranchEntry): boolean =>
      (b.ciImageStatus === 'waiting' || b.ciImageStatus === 'failed')
      && b.ciTargetSha === headSha
      && (!run.head_branch || b.branch === run.head_branch)
      && branchUsesPrebuiltMode(wfProfiles, b);
    const target = branches.find(matchable);
    if (!target) {
      // 没有分支匹配:很可能是 push webhook 还没处理到(延迟/重试),分支尚未 stamp。
      // 暂存结果,等稍后 push 把分支置 express-waiting 时认领(takeCompletedRun)。
      if (!dryRun) {
        this.rememberCompletedRun(repoFullName, headSha, run.head_branch, run.conclusion || 'unknown', run.html_url, project.id);
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
          // 把 ciTargetSha 钉到本次 head_sha:fallback matcher 可能按 githubCommitSha
          // 匹配到一个 ciTargetSha 仍是旧值的分支,不同步会让 check_run 闸门
          //（ready && ciTargetSha===head_sha）永远卡住（Bugbot: CI ready omits target SHA）。
          ciTargetSha: headSha,
          ciWorkflowConclusion: conclusion,
          ciWorkflowRunUrl: run.html_url,
          // 真 CI 完成事件到达 → 清掉看门狗计时与超时文案（若此前已被判超时 failed,
          // 这里允许 failed → ready 恢复,见下方 matcher 的 waiting||failed 条件）。
          ciWaitingSince: '',
          ciImageError: '',
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
        ciTargetSha: headSha, // 同上:保持 ciTargetSha 与本次 run 的 head_sha 一致
        ciWorkflowConclusion: conclusion,
        ciWorkflowRunUrl: run.html_url,
        // 真 CI 失败有了归因（conclusion + run 链接），停掉看门狗计时并写明原因,
        // 区别于「超时无 run」的看门狗失败。
        ciWaitingSince: '',
        ciImageError: `CI 构建未成功（${conclusion}）。可在分支详情切回源码编译重试。`,
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
    // 关 PR 要把每个项目的预览都收掉。只收第一个，其余容器会一直挂着 ——
    // 而用户关 PR 时的预期正是「相关的都停了」。
    const prProjects = this.deps.stateService.findProjectsByRepoFullName(repoFullName);
    if (prProjects.length === 0) {
      return { action: 'ignored-no-project', message: `No project linked to ${repoFullName}` };
    }
    const prResults: WebhookDispatchResult[] = [];
    for (const project of prProjects) {
      prResults.push(await this.handlePullRequestForProject(event, project, dryRun));
    }
    return mergeFanoutResults(prResults, prProjects, 'pull_request');
  }

  private async handlePullRequestForProject(
    event: GitHubPullRequestEvent,
    project: Project,
    dryRun: boolean,
  ): Promise<WebhookDispatchResult> {
    // 编排层已确认过这两个字段，这里收窄一次，后面就不用每处再判空。
    const pr = event.pull_request!;
    const repoFullName = event.repository!.full_name;
    if (!dryRun) this.rememberProjectInstallation(project, event.installation?.id);

    const branchName = pr.head.ref;
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
      const merged = pr.merged === true;
      // 墓碑（gone 页区分「已合并 → 切主分支」vs「已放弃 → 跳 PR」）是纯展示元数据，
      // 与 prClose「是否自动停容器」策略无关，任何关闭都要记。**必须独立于 prClose 闸门**：
      // 否则 prClose=false 时不写 merged 墓碑，而随后 GitHub 删分支的 delete 事件仍写
      // abandoned，导致「合并的分支被错显为已放弃」（recordRemovedBranch 的 merged 粘性
      // 也救不了——因为压根没写过 merged）。entry 存在才有 branch 名可落库。
      // **不以 entry 存在为前提构建墓碑**：若 delete webhook 先到、CDS 清理已删掉 entry，
      // 再处理 pull_request.closed 时 entry 为 null。此时 delete 路径已写了 abandoned 墓碑，
      // 若这里因 entry 缺失而不写 merged 墓碑，合并的 PR 会被错显为已放弃（Codex P2）。
      // 分支名用 head.ref（branchName，恒有值），branchId 用已算好的 canonicalId 兜底；
      // merged 粘性 + 元数据承袭会把已有 abandoned 升级为 merged 并保留别名等字段。
      const tombstoneRequest = {
        branchId,
        branch: entry?.branch || branchName,
        projectId: project.id,
        reason: (merged ? 'merged' : 'abandoned') as 'merged' | 'abandoned',
        prNumber: pr.number,
        prUrl: pr.html_url,
        mergeCommitSha: merged ? pr.merge_commit_sha : undefined,
        baseRef: pr.base?.ref,
        aliases: entry?.subdomainAliases,
      };

      // PR_D.2: project.githubEventPolicy.prClose=false → 不自动停容器（但墓碑照记）
      if (!this.isEventEnabled(project, 'prClose')) {
        return {
          action: 'ignored-event',
          message: `PR-close auto-stop disabled for project ${project.id}（仅记墓碑，不停容器）`,
          tombstoneRequest,
        };
      }
      if (!entry) {
        // entry 已被先到的 delete 清理：没容器可停，但墓碑照记（merged 粘性会把
        // delete 写的 abandoned 升级为 merged），否则合并 PR 会被错显为已放弃（Codex P2）。
        return {
          action: 'ignored-event',
          message: `PR closed but branch '${branchId}' not in CDS（仅记墓碑）`,
          tombstoneRequest,
        };
      }
      return {
        action: 'pr-branch-stopped',
        message: `PR #${pr.number} ${merged ? 'merged' : 'closed'}; stopping preview`,
        branchId,
        stopRequest: { branchId },
        tombstoneRequest,
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
          githubPrNumber: pr.number,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
          githubRepoFullName: repoFullName,
          githubSenderLogin: event.sender?.login,
          githubSenderAvatarUrl: event.sender?.avatar_url,
        });
        // 波3 配置树:PR base 分支是可靠的派生信号 → **仅回填溯源指针,不拷贝配置**
        // (分支往往已按项目模板部署,静默改写 overrides 违反最小惊讶;要拷贝走显式
        // POST /branches/:id/copy-config-from/:sourceId)。已设指针不覆盖(idempotent)。
        const baseRef = pr.base?.ref;
        if (baseRef && baseRef !== branchName) {
          const baseSlug = StateServiceClass.slugify(baseRef);
          const baseCanonicalId = project.legacyFlag ? baseSlug : `${project.slug}-${baseSlug}`;
          const baseEntry =
            this.deps.stateService.getBranch(baseCanonicalId) ??
            this.deps.stateService.findBranchByProjectAndName(project.id, baseRef);
          if (baseEntry && baseEntry.id !== branchId) {
            this.deps.stateService.setBranchDerivedFrom(branchId, {
              branchId: baseEntry.id,
              branchName: baseEntry.branch,
            });
          }
        }
        this.deps.stateService.save();
      }
      return {
        action: 'pr-comment-posted',
        message: `${dryRun ? '[dry-run] ' : ''}PR #${pr.number} ${event.action}; marked branch '${branchId}' for comment`,
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

    // ── 一仓多项目分发（2026-09-01）────────────────────────────────────
    // 一个 git 仓库可以同时喂多个 CDS 项目（本仓库就是：主项目与自托管项目共用
    // 同一个 repo）。此前这里只取第一个匹配项目，于是第二个及以后的项目**永远
    // 收不到 push**，只能手动建分支手动部署。判据是「取第一个」，语义却是「全部」。
    //
    // 现在逐个项目判定，并在分发之前先过一道项目级作用域（该项目名下全部服务
    // buildScope 的并集）：只改 cds/** 的提交不必惊动主项目，反之亦然。未声明
    // 作用域的项目按全通配处理，行为与启用前逐字节一致。
    const projects = this.deps.stateService.findProjectsByRepoFullName(repoFullName);
    if (projects.length === 0) {
      return {
        action: 'ignored-no-project',
        message: `No project linked to ${repoFullName}. Ignoring push.`,
      };
    }

    // 清单被截断时当作「判不准」——传空数组进去，作用域判据据此 fail-open。
    // 拿一份不全的清单当权威，会把某个项目判成「未被波及」而静默跳过它的部署，
    // 而这正是本次改动最不该引入的失败模式（漏部署没有任何信号）。
    const changedPaths = this.changedPathsComplete(event) ? this.changedPathsFromPush(event) : [];
    const perProject: WebhookDispatchResult[] = [];
    for (const project of projects) {
      const scope = resolveProjectScope(this.deps.stateService.getBuildProfilesForProject(project.id));
      const decision = decideProjectScope(scope, changedPaths);
      if (!decision.matched) {
        perProject.push({
          action: 'ignored-out-of-scope',
          message: `项目 '${project.name}' 未被本次改动波及：${decision.reason}`,
        });
        continue;
      }
      perProject.push(
        await this.handlePushForProject(
          event,
          project,
          { branchName, commitSha, repoFullName, receivedAt },
          dryRun,
        ),
      );
    }
    return mergeFanoutResults(perProject, projects);
  }

  /**
   * 单个项目视角的 push 处理。
   *
   * 从 {@link handlePush} 原样抽出，逐字节保留原有行为；唯一的差别是项目由参数
   * 传入而不是自己去查——因为「这个仓库对应哪些项目」现在是上一层的事。
   */
  private async handlePushForProject(
    event: GitHubPushEvent,
    project: Project,
    ctx: { branchName: string; commitSha: string; repoFullName: string; receivedAt: string },
    dryRun: boolean,
  ): Promise<WebhookDispatchResult> {
    const { branchName, commitSha, repoFullName, receivedAt } = ctx;
    if (!dryRun) this.rememberProjectInstallation(project, event.installation?.id);

    // PR_D.2: 统一走 isEventEnabled('push')，内部已 fallback 到老的
    // githubAutoDeploy；新代码用 githubEventPolicy.push。
    if (!this.isEventEnabled(project, 'push')) {
      if (project.paused === true) {
        return {
          action: 'ignored-project-paused',
          message: `Project '${project.name}' 已暂停，忽略 push 自动部署。`,
        };
      }
      return {
        action: 'ignored-auto-deploy-off',
        message: `Project '${project.name}' has push handling off. Ignoring push.`,
      };
    }

    // 项目级机器人版本过滤默认开启（undefined 也视为开启）。必须在创建 worktree、
    // 写入分支版本元数据和派发构建之前短路，避免 dependabot[bot]、
    // github-actions[bot] 等自动账号持续消耗构建与运行资源。
    if (project.githubBotPushFilterEnabled !== false && isGitHubBotSender(event.sender)) {
      const senderLogin = event.sender?.login || 'unknown';
      return {
        action: 'ignored-bot-push',
        message: `Project '${project.name}' 已过滤机器人账号 '${senderLogin}' 的 push，不创建 CDS 版本。`,
      };
    }

    // 发布中心「自动发布规则」（design_handoff_release_center §4）。
    //
    // 位置刻意放在这里：机器人过滤之后（机器人 push 不该自动发生产），但在
    // docs-only 提前 return **之前**——`docs/** → docs-site` 这类规则要的正好是
    // docs-only 那种 push，放在 return 之后它永远不会被触发。
    //
    // 不 await：规则执行会真的跑一次发布，可能几分钟；webhook 必须尽快回 200，
    // 否则 GitHub 会判超时重投，同一个 push 被处理多次。失败只记日志，绝不
    // 影响下面的建分支 / 部署链路。
    //
    // 2026-08-16 修正时序（Codex P1）：原来在这里**直接触发**。但触发点在分支
    // 创建与 `githubCommitSha` 落库之前，而 `runPushRules` 立刻按分支名去 state
    // 里找记录、并按记录上的 commit 发布。后果两条，都静默：
    //   - 首次推送一条新分支：记录还不存在 → 规则被跳过，只留一行 warn
    //   - 后续推送：记录在，但 `githubCommitSha` 还是**上一个** commit → 发旧版本
    // 所以改成先包成闭包，等分支状态落定后再点火；下面每条出口各点一次，
    // `fired` 保证只点一次。位置约束不变：docs-only 出口也必须点，
    // 因为 `docs/** → docs-site` 这类规则要的正好是 docs-only 那种 push。
    let pushRulesFired = false;
    const firePushRules = (): void => {
      if (pushRulesFired || dryRun || !this.deps.runPushRules) return;
      pushRulesFired = true;
      // 不 await：规则执行会真的跑一次发布，可能几分钟；webhook 必须尽快回 200，
      // 否则 GitHub 判超时重投，同一个 push 被处理多次。失败只记日志。
      void this.deps.runPushRules({
        projectId: project.id,
        branch: branchName,
        event: 'push',
        changedPaths: this.changedPathsFromPush(event),
        // 路径过滤读的是这个 commit 的改动清单，发布就必须发这个 commit——
        // 否则紧挨着的第二次 push 会被第一个事件的授权发出去。
        ...(event.after ? { commitSha: event.after } : {}),
      }).catch((err) => {
        console.error('[webhook] 自动发布规则执行失败:', project.id, branchName, (err as Error).message);
      });
    };

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
        // docs-only push 不动 CI 状态（2026-06-23 path-filter + 回退模型修正,Bugbot:
        // CI ready without image builds）。理由：极速版镜像由 CI **按改动路径**构建
        // （prd-api/** → api、prd-admin/** → admin），docs-only commit 不会产生任何
        // sha-* 镜像。此前为「每个 commit 都构建」模型把 ciTargetSha 推进到 docs commit,
        // 在 path-filter 下会:① 把正在构建的**代码 commit** 的 in-flight build 顶掉(孤儿,
        // 永不部署);② 让分支显示「CI ready」却指向一个没有镜像的 SHA、只能全回退 main。
        // 正确做法:docs-only 只刷新展示用 metadata,ciImageStatus/ciTargetSha 保持不动 ——
        // 继续等待正在构建的代码 commit;docs 改动本就不进运行时镜像,无需重部署。
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          githubRepoFullName: repoFullName,
          githubCommitSha: commitSha,
          lastPushAt: receivedAt,
          githubSenderLogin: event.sender?.login,
          githubSenderAvatarUrl: event.sender?.avatar_url,
          githubInstallationId: project.githubInstallationId ?? event.installation?.id,
        });
        this.deps.stateService.save();
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
        // docs-only 也要点火：`docs/** → docs-site` 这类规则要的正好是这种 push。
        // 放在元数据刷新之后，规则拿到的才是本次的 commit。
        firePushRules();
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

    // 分支记录与 commit 都已落定，这时候规则才能找到分支、并按**本次**的 commit 发布。
    firePushRules();
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
      // 入口校验（doc/debt.cds.md「CDS 过期分支预览页」 #7，2026-07-09）：进 waiting 前确认
      // 仓库该 commit 下真的有 branch-image.yml。缺文件时 CI 完成事件永远不会来，
      // 与其让分支苦等 15 分钟看门狗超时，不如立即按看门狗同一失败语义归因。
      // API 失败/无凭据 = unknown → fail-open 照旧 waiting（看门狗仍兜底）。
      const workflowPresence = await this.checkExpressWorkflowPresence(
        repoFullName, branchName, commitSha, project.githubInstallationId ?? event.installation?.id,
      );
      if (workflowPresence === 'missing') {
        const missingError = '仓库该提交下不存在 .github/workflows/branch-image.yml，极速版镜像不会被 CI 构建。请为仓库添加该 workflow，或在构建配置中把分支切回源码编译模式。';
        this.deps.stateService.updateBranchGithubMeta(branchId, {
          ciImageStatus: 'failed',
          ciTargetSha: commitSha,
          ciWorkflowConclusion: '',
          ciWorkflowRunUrl: '',
          ciWaitingSince: '',
          ciImageError: missingError,
        });
        this.deps.stateService.save();
        const failedEntry = this.deps.stateService.getBranch(branchId);
        if (failedEntry) {
          branchEvents.emitEvent({
            type: 'branch.updated',
            payload: {
              branchId,
              projectId: failedEntry.projectId,
              patch: {
                ciImageStatus: 'failed',
                ciTargetSha: commitSha,
                ciImageError: missingError,
              },
              ts: receivedAt,
            },
          });
        }
        return {
          action: 'ci-image-workflow-missing',
          message: `极速版分支 '${branchId}' 未进入等待：仓库缺少 branch-image.yml workflow（commit ${commitSha.slice(0, 7)}）`,
          branchId,
        };
      }
      this.deps.stateService.updateBranchGithubMeta(branchId, {
        ciImageStatus: 'waiting',
        ciTargetSha: commitSha,
        ciWorkflowConclusion: '',
        // 同时清掉上一次 run 的链接,否则「等待 CI 镜像」卡片的「查看构建」会指向
        // 旧的(可能失败/无关)Actions run（Bugbot: stale CI run link on wait）。
        ciWorkflowRunUrl: '',
        // 看门狗据此判定 waiting 是否超时（CI 完成事件永不到达时翻 failed + 留归因）；
        // 同时清掉上次的超时/失败文案,本次重新计时。
        ciWaitingSince: receivedAt,
        ciImageError: '',
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
    // 极速版 CI 闸门（Bugbot: check run skips CI wait / ignores CI target SHA）：
    // check_run re-run 不得绕过「等 CI 镜像」直接部署预构建镜像 —— ghcr 镜像可能还没
    // push,docker pull 必失败。放行条件必须**同时**满足:① 镜像 ready;② ready 的就是
    // 本次 head_sha（ciTargetSha===commitSha）。否则(waiting/failed/未构建,或 ready 的是
    // 别的 commit)只 ack,不返回 deployRequest。非极速版分支维持原「re-run=重部署」不变。
    const checkProfiles = this.deps.stateService.getBuildProfilesForProject(entry.projectId || 'default');
    const expressReadyForThisSha =
      entry.ciImageStatus === 'ready' && entry.ciTargetSha === commitSha;
    if (branchUsesPrebuiltMode(checkProfiles, entry) && !expressReadyForThisSha) {
      return {
        action: 'ci-image-waiting',
        message: `${dryRun ? '[dry-run] ' : ''}极速版分支 '${branchId}' 等待 CI 镜像就绪,check_run 重跑不触发预构建部署（状态:${entry.ciImageStatus || '未构建'}, 目标 SHA:${(entry.ciTargetSha || '-').slice(0, 7)} vs ${commitSha.slice(0, 7)}）`,
        branchId,
      };
    }
    return {
      action: 'check-run-requeued',
      message: `${dryRun ? '[dry-run] ' : ''}Queued redeploy of '${branchId}' at ${commitSha.slice(0, 7)}`,
      branchId,
      deployRequest: { branchId, commitSha },
    };
  }
}
