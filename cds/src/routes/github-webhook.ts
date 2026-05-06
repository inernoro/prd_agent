/**
 * GitHub webhook receiver + GitHub App integration endpoints.
 *
 * Mounted at /api so the public webhook URL is
 * `https://<cds>/api/github/webhook`. Relies on a raw-body middleware
 * installed in `server.ts` (before `express.json()`) that writes the
 * unparsed body to `req.rawBody` — we need the exact bytes GitHub
 * signed, not the re-serialized JSON.
 *
 * Endpoints:
 *   POST /api/github/webhook
 *     GitHub-facing webhook receiver. Verifies signature, dispatches
 *     the event, and optionally kicks off a branch deploy.
 *
 *   GET /api/github/app
 *     Whether the GitHub App is configured + the install URL.
 *
 *   GET /api/github/installations
 *     List installations (used by the Settings page for linking).
 *
 *   GET /api/github/installations/:id/repos
 *     List repos accessible to an installation.
 *
 *   POST /api/projects/:id/github/link
 *     Link a project to an (installationId, repoFullName) pair.
 *
 *   DELETE /api/projects/:id/github/link
 *     Remove the link.
 */

import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { WorktreeService } from '../services/worktree.js';
import type { IShellExecutor, CdsConfig } from '../types.js';
import {
  GitHubAppClient,
  buildInstallUrl,
  verifyWebhookSignature,
} from '../services/github-app-client.js';
import {
  GitHubWebhookDispatcher,
  type WebhookDispatchResult,
} from '../services/github-webhook-dispatcher.js';
import {
  DEFAULT_TEMPLATE_BODY,
  buildDashboardUrl,
  buildPreviewUrl,
  buildTemplateVariables,
  renderTemplate,
} from '../services/comment-template.js';
import { broadcastSelfStatus } from './branches.js';

export interface GitHubWebhookRouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  shell: IShellExecutor;
  config: CdsConfig;
  /** Optional override for tests — production sets it from the App config. */
  githubApp?: GitHubAppClient | null;
  /**
   * Internal deploy dispatcher. Called after a successful webhook to
   * trigger `POST /api/branches/:id/deploy` without re-implementing the
   * full deploy pipeline. In production this is a localhost HTTP call
   * with the X-CDS-Internal header that bypasses cookie auth. Injected
   * so tests can observe without spinning a full Express server.
   */
  dispatchDeploy?: (branchId: string, commitSha: string) => Promise<void>;
}

/**
 * Build a request type so we can type `req.rawBody` without augmenting
 * the Express global.
 */
type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Events the dispatcher actively reacts to (creates/refreshes branches,
 * posts comments, runs slash commands, etc.). Anything outside this set
 * is routed through a cheap ack path that skips the dispatcher entirely
 * — avoids running parse/validate work for events CDS can't action.
 *
 * Kept in sync with the switch in GitHubWebhookDispatcher.handle().
 */
const SUPPORTED_EVENTS: ReadonlySet<string> = new Set([
  'ping',
  'push',
  'installation',
  'installation_repositories',
  'check_run',
  'pull_request',
  'issue_comment',
  'delete',
  'repository',
  'release',
]);

/**
 * Deploy dispatch dedup window. When a GitHub App is subscribed to
 * many events (or GitHub retries a delivery because we returned a
 * non-2xx), the SAME (branchId, commitSha) can arrive as a push AND
 * as a check_run.rerequested within seconds. Without dedup the build
 * fires twice back-to-back, tearing down containers the first build
 * just started. We remember recent dispatches and skip duplicates
 * within the window. Slash commands (`/cds redeploy`) bypass this
 * because they go through a separate code path.
 */
const DEPLOY_DEDUP_WINDOW_MS = 30_000;
const recentDeployDispatches = new Map<string, number>();

function shouldSkipDuplicateDispatch(branchId: string, commitSha: string): boolean {
  const key = `${branchId}:${commitSha}`;
  const now = Date.now();
  // Tidy stale entries so the map doesn't grow unbounded on a chatty
  // install (one entry per push over the service's lifetime).
  for (const [k, ts] of recentDeployDispatches) {
    if (now - ts > DEPLOY_DEDUP_WINDOW_MS * 2) {
      recentDeployDispatches.delete(k);
    }
  }
  const prev = recentDeployDispatches.get(key);
  if (prev && now - prev < DEPLOY_DEDUP_WINDOW_MS) return true;
  recentDeployDispatches.set(key, now);
  return false;
}

/** Test-only: reset dedup state between cases so they don't leak. */
export function __resetWebhookDedupForTests(): void {
  recentDeployDispatches.clear();
  cdsHostBranchCache = null;
}

/**
 * CDS 进程当前 checkout 的分支(用于判断 push 事件是否影响"我"的 self-status)。
 *
 * 启动后基本不变(self-update 切分支会重启进程),所以只在第一次 push 时探测,
 * 之后命中内存缓存。失败 → null,broadcast 简单跳过(对 GlobalUpdateBadge 无副作用,
 * 用户最多看到角标稍微滞后一点)。
 */
let cdsHostBranchCache: string | null = null;
async function getCdsHostBranch(
  shell: IShellExecutor,
  repoRoot: string,
): Promise<string | null> {
  if (cdsHostBranchCache !== null) return cdsHostBranchCache;
  try {
    const r = await shell.exec('git rev-parse --abbrev-ref HEAD', {
      cwd: repoRoot,
      timeout: 5_000,
    });
    if (r.exitCode === 0) {
      const branch = r.stdout.trim();
      if (branch) {
        cdsHostBranchCache = branch;
        return branch;
      }
    }
  } catch {
    /* 探测失败容忍 — 见函数 doc */
  }
  return null;
}

export function createGithubWebhookRouter(deps: GitHubWebhookRouterDeps): Router {
  const router = Router();
  const {
    stateService,
    worktreeService,
    shell,
    config,
    githubApp,
    dispatchDeploy,
  } = deps;

  const dispatcher = new GitHubWebhookDispatcher({
    stateService,
    worktreeService,
    shell,
    config,
    githubApp: githubApp || undefined,
  });

  // ── POST /api/github/webhook ───────────────────────────────────────
  router.post('/github/webhook', async (req: RawBodyRequest, res) => {
    const githubAppConfig = config.githubApp;
    if (!githubAppConfig) {
      res.status(503).json({
        error: 'not_configured',
        message: 'GitHub App webhook not configured (CDS_GITHUB_APP_ID et al. missing).',
      });
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const eventName = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!eventName) {
      res.status(400).json({ error: 'missing_event_header' });
      return;
    }
    const rawBody = req.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      res.status(400).json({
        error: 'missing_raw_body',
        message: 'Raw body unavailable — webhook route must be mounted before express.json().',
      });
      return;
    }

    const verified = verifyWebhookSignature(rawBody, signature, githubAppConfig.webhookSecret);
    if (!verified) {
      // eslint-disable-next-line no-console
      console.warn(`[webhook] signature verification failed (delivery=${deliveryId || '?'})`);
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    // Stash the event name on res.locals so the activity middleware can
    // render a finer-grained label (e.g. "GitHub Webhook · push" vs
    // "GitHub Webhook · check_run"). Must come before any early-return
    // below so the label is set even on noise-filtered events.
    (res.locals as { cdsGithubEvent?: string }).cdsGithubEvent = eventName;

    // ── Noise filter ─────────────────────────────────────────────────
    // If a user subscribes the GitHub App to "all events", a single
    // push can flood CDS with check_suite / workflow_run / status /
    // pull_request_review / ... deliveries. We don't act on any of
    // those, so short-circuit before the dispatcher and tell the
    // activity stream to skip the entry so the operator's monitor
    // isn't drowned out. Signature verification runs first, so this
    // path still requires a valid HMAC.
    if (!SUPPORTED_EVENTS.has(eventName)) {
      res.setHeader('X-CDS-Suppress-Activity', '1');
      res.json({
        ok: true,
        event: eventName,
        delivery: deliveryId,
        action: 'ignored-unsubscribed',
        message: `Event '${eventName}' not handled by CDS; acknowledged without dispatch.`,
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch (err) {
      res.status(400).json({ error: 'invalid_json', message: (err as Error).message });
      return;
    }

    let result: WebhookDispatchResult;
    try {
      result = await dispatcher.handle(eventName, payload);
    } catch (err) {
      // Return 200 on dispatcher failure so GitHub DOES NOT retry the
      // delivery. A retry storm (5xx → GitHub re-POSTs every few
      // minutes for up to 8 hours) was visibly rebuilding the user's
      // app in a loop. The error is still recorded server-side so an
      // operator can grep it. Also persist the error body as a 200 so
      // the Dashboard activity entry surfaces the failure clearly.
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] dispatch error event=${eventName} delivery=${deliveryId || '?'}:`,
        err,
      );
      res.status(200).json({
        ok: false,
        event: eventName,
        delivery: deliveryId,
        error: 'dispatch_error',
        message: (err as Error).message,
      });
      return;
    }

    // Kick off the deploy asynchronously. The webhook response is sent
    // back to GitHub within the GitHub 10s timeout regardless of how
    // long the build takes.
    //
    // Dedup by (branchId, commitSha) within a short window: the same
    // SHA can legitimately arrive twice — once as a `push`, once as a
    // `check_run.rerequested` piggy-backed on our own check-run PATCH,
    // plus any GitHub retries. Building twice tears down the first
    // build's containers mid-flight and doubles the user's wait. The
    // /cds redeploy slash command doesn't go through this branch (it
    // posts directly from runSlashCommand), so explicit redeploys are
    // unaffected.
    let deployDedupSkipped = false;
    if (result.deployRequest) {
      const request = result.deployRequest;
      if (shouldSkipDuplicateDispatch(request.branchId, request.commitSha)) {
        deployDedupSkipped = true;
        // eslint-disable-next-line no-console
        console.log(
          `[webhook] skip duplicate deploy dispatch branch=${request.branchId} sha=${request.commitSha.slice(0, 7)} (within ${DEPLOY_DEDUP_WINDOW_MS}ms)`,
        );
      } else {
        // Use the injected dispatcher for tests; default to a localhost HTTP
        // call to this same CDS instance.
        const dispatcherFn = dispatchDeploy || defaultLocalhostDeploy(config);
        dispatcherFn(request.branchId, request.commitSha).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[webhook] deploy dispatch failed for branch=${request.branchId}:`,
            (err as Error).message,
          );
        });
      }
    }

    // PR opened/reopened → post (or refresh) the preview-URL bot comment.
    // PR closed → stop the branch's containers.
    // Fire-and-forget; failures log to stderr, never bubble to the
    // webhook response (GitHub only cares we returned 200 in time).
    if (result.action === 'pr-comment-posted' && result.branchId && githubApp) {
      void postOrUpdatePrComment(
        stateService,
        githubApp,
        config,
        result.branchId,
        payload as { pull_request?: { number: number; html_url?: string; title?: string } },
      ).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[webhook] PR comment failed for branch=${result.branchId}:`,
          (err as Error).message,
        );
      });
    }
    if (result.stopRequest) {
      const stopReq = result.stopRequest;
      void defaultLocalhostStop(config, stopReq.branchId).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[webhook] stop dispatch failed for branch=${stopReq.branchId}:`,
          (err as Error).message,
        );
      });
    }

    // Slash commands — run the command + post a reply comment on the PR.
    // Route-layer handles it so all GitHub API calls sit together, and
    // the dispatcher stays pure (easy to unit-test).
    if (result.slashCommand && githubApp) {
      const sc = result.slashCommand;
      const repoFullName = (payload as { repository?: { full_name: string } })?.repository?.full_name || '';
      void runSlashCommand(
        stateService,
        githubApp,
        config,
        repoFullName,
        sc,
        dispatchDeploy,
      ).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[webhook] slash command failed for '${sc.command}':`,
          (err as Error).message,
        );
      });
    }

    // Actions that are pure "received but nothing to do" — same UX as
    // the noise filter above. Keeps the activity stream focused on
    // events that actually moved state.
    if (result.action === 'ignored-event' || result.action === 'ignored-ping') {
      res.setHeader('X-CDS-Suppress-Activity', '1');
    }

    // 2026-05-05:push 命中 CDS 自身当前分支 → 主动 broadcast self-status
    // 给所有 GlobalUpdateBadge SSE 客户端,前端无需轮询即可感知"有新 commit"。
    //
    // 仅当 push 事件 且 ref 解析出的分支等于 CDS 当前分支时才 broadcast,
    // 避免任意分支 push 都触发(无意义的网络/git fetch)。fire-and-forget,
    // 失败不阻塞 webhook 200 返回(GitHub 在意的是 10s 内 ack)。
    if (eventName === 'push') {
      const pushRef = (payload as { ref?: string })?.ref || '';
      const pushedBranch = pushRef.startsWith('refs/heads/')
        ? pushRef.slice('refs/heads/'.length)
        : '';
      if (pushedBranch) {
        void getCdsHostBranch(shell, config.repoRoot).then((hostBranch) => {
          if (hostBranch && hostBranch === pushedBranch) {
            return broadcastSelfStatus();
          }
          return undefined;
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[webhook] broadcastSelfStatus 失败 (push branch=${pushedBranch}):`,
            (err as Error).message,
          );
        });
      }
    }

    res.json({
      ok: true,
      event: eventName,
      delivery: deliveryId,
      action: result.action,
      message: result.message,
      branchId: result.branchId,
      deployDispatched: Boolean(result.deployRequest) && !deployDedupSkipped,
      deployDedupSkipped: deployDedupSkipped || undefined,
      stopDispatched: Boolean(result.stopRequest),
      slashCommand: result.slashCommand?.command,
    });
  });

  // ── GET /api/github/app ────────────────────────────────────────────
  router.get('/github/app', (_req, res) => {
    const ghApp = config.githubApp;
    if (!ghApp) {
      res.json({ configured: false });
      return;
    }
    res.json({
      configured: true,
      appId: ghApp.appId,
      appSlug: ghApp.appSlug || null,
      installUrl: buildInstallUrl(ghApp.appSlug),
      publicBaseUrl: config.publicBaseUrl || null,
      webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/api/github/webhook` : null,
    });
  });

  // ── GET /api/github/installations ──────────────────────────────────
  router.get('/github/installations', async (_req, res) => {
    if (!githubApp) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    try {
      const installations = await githubApp.listInstallations();
      res.json({ installations });
    } catch (err) {
      res.status(500).json({
        error: 'list_installations_failed',
        message: (err as Error).message,
      });
    }
  });

  // ── GET /api/github/installations/:id/repos ────────────────────────
  router.get('/github/installations/:id/repos', async (req, res) => {
    if (!githubApp) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    const installationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(installationId)) {
      res.status(400).json({ error: 'invalid_installation_id' });
      return;
    }
    try {
      const repos = await githubApp.listInstallationRepos(installationId);
      res.json({ repos });
    } catch (err) {
      res.status(500).json({
        error: 'list_repos_failed',
        message: (err as Error).message,
      });
    }
  });

  // ── POST /api/projects/:id/github/link ─────────────────────────────
  router.post('/projects/:id/github/link', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const body = (req.body || {}) as Partial<{
      installationId: number;
      repoFullName: string;
      autoDeploy: boolean;
    }>;
    const installationId = typeof body.installationId === 'number' ? body.installationId : NaN;
    const repoFullName = typeof body.repoFullName === 'string' ? body.repoFullName.trim() : '';
    if (!Number.isFinite(installationId) || !repoFullName) {
      res.status(400).json({
        error: 'validation',
        message: 'installationId (number) 和 repoFullName (string) 都是必填项',
      });
      return;
    }
    // Strict allow-list: GitHub owner/repo names use ASCII alnum plus
    // a handful of safe punctuation. Previous looser regex let through
    // shell/JS meta-characters (single quotes, backticks) which were
    // picked up by the client-side onclick handler and caused XSS.
    // Matches what GitHub itself accepts + what our client-side chip
    // renderer will accept. Caught by Cursor Bugbot #450 round 5.
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoFullName)) {
      res.status(400).json({
        error: 'validation',
        field: 'repoFullName',
        message: 'repoFullName 必须是 "owner/repo" 格式,仅允许字母/数字/点/下划线/短横线',
      });
      return;
    }
    const existing = stateService.findProjectByRepoFullName(repoFullName);
    if (existing && existing.id !== project.id) {
      res.status(409).json({
        error: 'already_linked',
        message: `${repoFullName} 已经绑定到项目 ${existing.name}`,
      });
      return;
    }
    const autoDeploy = body.autoDeploy === undefined ? true : Boolean(body.autoDeploy);
    stateService.updateProject(project.id, {
      githubInstallationId: installationId,
      githubRepoFullName: repoFullName,
      githubAutoDeploy: autoDeploy,
      githubLinkedAt: new Date().toISOString(),
    });
    const updated = stateService.getProject(project.id)!;
    res.json({ project: updated });
  });

  // ── POST /api/github/webhook/self-test ─────────────────────────────
  //
  // Synthetic webhook dispatcher — lets the admin exercise the event
  // handler path WITHOUT depending on GitHub actually delivering a
  // webhook. Critical for diagnosing "is slash command flow broken, or
  // is the App just not subscribed to issue_comment?"
  //
  // Request body: { eventName, payload } — same shape GitHub sends.
  // No HMAC verification (auth sits at the outer /api middleware).
  //
  // Returns the dispatcher result + whether deploy/stop/comment
  // actions were triggered. Safe to invoke from Settings UI.
  router.post('/github/webhook/self-test', async (req, res) => {
    if (!config.githubApp) {
      res.status(503).json({ error: 'not_configured', message: 'GitHub App 未配置' });
      return;
    }
    const body = (req.body || {}) as {
      eventName?: string;
      payload?: unknown;
    };
    const eventName = typeof body.eventName === 'string' ? body.eventName : '';
    if (!eventName) {
      res.status(400).json({ error: 'missing_event', message: 'eventName (e.g. "push", "issue_comment") is required' });
      return;
    }
    const payload = body.payload ?? {};
    let result;
    try {
      // dryRun=true: dispatcher parses events & returns what WOULD
      // happen but skips every state mutation (addBranch / worktree
      // create / updateProject / save). This is safe for diagnosing
      // slash commands / signature chain without corrupting state.
      // Caught by Cursor Bugbot #450 round 3.
      result = await dispatcher.handle(eventName, payload, { dryRun: true });
    } catch (err) {
      // Don't leak the stack trace to the client — file paths, module
      // versions, and internal structure help post-auth attackers.
      // Log it server-side for operator access.
      // eslint-disable-next-line no-console
      console.warn(`[webhook/self-test] dispatch error: ${(err as Error).stack || (err as Error).message}`);
      res.status(500).json({
        error: 'dispatch_error',
        message: (err as Error).message,
      });
      return;
    }
    // Neither the dispatcher mutations NOR the post-dispatch
    // side-effects (deploy / stop / PR comment) fire in self-test.
    res.json({
      ok: true,
      event: eventName,
      dryRun: true,
      dispatcherResult: result,
      sideEffectsSimulated: {
        deployDispatch: Boolean(result.deployRequest),
        stopDispatch: Boolean(result.stopRequest),
        prComment: result.action === 'pr-comment-posted',
        slashCommand: result.slashCommand?.command,
      },
    });
  });

  // ── DELETE /api/projects/:id/github/link ───────────────────────────
  router.delete('/projects/:id/github/link', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    stateService.updateProject(project.id, {
      githubInstallationId: undefined,
      githubRepoFullName: undefined,
      githubAutoDeploy: undefined,
      githubLinkedAt: undefined,
    });
    res.json({ ok: true });
  });

  return router;
}

/**
 * Default deploy dispatcher — does an internal POST to
 * `http://localhost:<masterPort>/api/branches/:id/deploy` with the
 * `X-CDS-Internal: 1` header so it passes any cookie auth middleware.
 * The response body is an SSE stream; we don't read it (deploy events
 * are logged server-side anyway).
 */
function defaultLocalhostDeploy(config: CdsConfig): (branchId: string, commitSha: string) => Promise<void> {
  return async (branchId, commitSha) => {
    const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(branchId)}/deploy`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDS-Internal': '1',
      },
      // Pass the triggering commit SHA so the deploy route can stamp it
      // authoritatively instead of racing against concurrent pushes
      // that may have updated the branch entry between dispatch and
      // the route's own re-read. The deploy route falls back to
      // `entry.githubCommitSha` when body.commitSha is missing.
      body: JSON.stringify({ commitSha }),
    });
    // Drain the SSE stream so Node doesn't complain about unhandled
    // socket errors. We don't care about the events here — the deploy
    // route already persists logs and updates branch state.
    if (res.body && typeof (res.body as any).getReader === 'function') {
      const reader = (res.body as any).getReader();
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* ignore */
        }
      })();
    }
  };
}

/**
 * POST /api/branches/:id/stop to tear down a branch's preview containers.
 * Called when a PR gets closed (merged or not) so we don't leave stale
 * preview containers eating RAM after the PR is gone.
 */
async function defaultLocalhostStop(config: CdsConfig, branchId: string): Promise<void> {
  const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(branchId)}/stop`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CDS-Internal': '1' },
    body: JSON.stringify({}),
  });
  if (res.body && typeof (res.body as any).getReader === 'function') {
    const reader = (res.body as any).getReader();
    (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch { /* ignore */ }
    })();
  }
}

/**
 * Post or refresh the preview-URL bot comment on a PR.
 *
 * First call for a branch creates the comment + stores its id on the
 * branch (`githubPreviewCommentId`). Subsequent calls (e.g. triggered
 * by a re-open) PATCH the same comment so the PR thread stays quiet.
 *
 * When the stored comment id fails to update (404 = user deleted it),
 * we transparently recreate it.
 */
async function postOrUpdatePrComment(
  stateService: StateService,
  githubApp: GitHubAppClient,
  config: CdsConfig,
  branchId: string,
  payload: { pull_request?: { number: number; html_url?: string; title?: string } },
): Promise<void> {
  const branch = stateService.getBranch(branchId);
  if (!branch) return;
  const repoFullName = branch.githubRepoFullName;
  const instId = branch.githubInstallationId;
  const prNumber = branch.githubPrNumber || payload.pull_request?.number;
  if (!repoFullName || !instId || !prNumber) return;
  const parts = repoFullName.split('/');
  if (parts.length !== 2) return;
  const [owner, repo] = parts;

  // Build the comment body by rendering the user-editable template
  // from state (services/comment-template.ts). When no template has
  // been saved we fall back to DEFAULT_TEMPLATE_BODY, which is
  // byte-equivalent to the pre-customisation hard-coded markdown +
  // a new "PR Review" deeplink line.
  //
  // All the dynamic bits (branch, SHA, preview URL, dashboard URL,
  // PR review deeplink) go through buildTemplateVariables so the
  // settings-panel preview and the live render stay in lock-step.
  const host = config.previewDomain || config.rootDomains?.[0];
  // 走 v3 公式（tail-prefix-projectSlug）需要分支原名 + 项目 slug，
  // 不能再传 entry id（那是内部存储 key）。详见 preview-slug.ts 头部注释。
  const project = branch.projectId ? stateService.getProject(branch.projectId) : undefined;
  const projectSlug = project?.slug || branch.projectId;
  const previewUrl = buildPreviewUrl(host, branch.branch, projectSlug);
  const dashboardUrl = buildDashboardUrl(config.publicBaseUrl, branchId);
  // 走 per-project 模板：项目自己的优先，未设回退到旧 state.commentTemplate。
  const settings = stateService.getCommentTemplateFor(branch.projectId);
  const templateBody = settings?.body && settings.body.length > 0 ? settings.body : DEFAULT_TEMPLATE_BODY;
  const vars = buildTemplateVariables({
    branch: branch.branch,
    commitSha: branch.githubCommitSha || '',
    previewUrl,
    dashboardUrl,
    repoFullName,
    prNumber,
    prUrl: payload.pull_request?.html_url || '',
  });
  const body = renderTemplate(templateBody, vars);

  if (branch.githubPreviewCommentId) {
    try {
      await githubApp.updateIssueComment(instId, owner, repo, branch.githubPreviewCommentId, body);
      return;
    } catch (err) {
      // Fall through to recreate if PATCH fails (user deleted the comment)
      // eslint-disable-next-line no-console
      console.warn(
        `[webhook] PR comment PATCH failed (id=${branch.githubPreviewCommentId}), will recreate:`,
        (err as Error).message,
      );
    }
  }

  const result = await githubApp.createIssueComment(instId, owner, repo, prNumber, body);
  stateService.updateBranchGithubMeta(branchId, {
    githubPreviewCommentId: result.id,
  });
  stateService.save();
}

/**
 * Execute a `/cds <cmd>` slash command received via issue_comment on a
 * PR. Dispatches the command and posts a reply comment on the PR so
 * the user (or collaborator) sees a confirmation in the thread.
 */
async function runSlashCommand(
  stateService: StateService,
  githubApp: GitHubAppClient,
  config: CdsConfig,
  repoFullName: string,
  sc: {
    command: 'redeploy' | 'stop' | 'logs' | 'help' | 'unknown';
    branchId?: string;
    prNumber: number;
    commentId: number;
    arg?: string;
    commenter: string;
  },
  dispatchDeploy?: (branchId: string, commitSha: string) => Promise<void>,
): Promise<void> {
  const parts = repoFullName.split('/');
  if (parts.length !== 2) return;
  const [owner, repo] = parts;

  // Any command other than `help` needs a CDS branch to target. If we
  // can't resolve one, reply with a hint instead of silently failing.
  const project = stateService.findProjectByRepoFullName(repoFullName);
  const instId = project?.githubInstallationId;
  if (!instId) return;

  const postReply = (body: string) =>
    githubApp.createIssueComment(instId, owner, repo, sc.prNumber, body).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[slash] reply comment failed: ${(err as Error).message}`);
    });

  if (sc.command === 'help' || sc.command === 'unknown') {
    const unknownLine = sc.command === 'unknown' ? `未知命令 \`${sc.arg}\` — 列一下支持的:\n\n` : '';
    await postReply(
      '## 🤖 CDS Slash Commands\n\n' +
      unknownLine +
      '| 命令 | 说明 |\n' +
      '|------|------|\n' +
      '| `/cds redeploy` | 强制触发一次新部署(适用于代码没变但想重跑构建) |\n' +
      '| `/cds stop` | 停掉这个 PR 分支的预览容器 |\n' +
      '| `/cds logs` | 回复一段最近 40 条部署日志尾部 |\n' +
      '| `/cds help` | 显示本帮助 |\n\n' +
      '<sub>@' + sc.commenter + ' 输入命令即可,无需引号。push 到分支也会自动触发 redeploy。</sub>',
    );
    return;
  }

  if (!sc.branchId) {
    await postReply(
      `@${sc.commenter} ⚠ 这个 PR 的分支 CDS 还没跟踪到,无法执行 \`/cds ${sc.command}\`。` +
      `通常等一次 push 触发 webhook 后就能跟踪到; 或者手动推一次空 commit 再试。`,
    );
    return;
  }

  const branch = stateService.getBranch(sc.branchId);
  if (!branch) {
    await postReply(`@${sc.commenter} ⚠ CDS 分支 \`${sc.branchId}\` 不存在或已被删除。`);
    return;
  }

  if (sc.command === 'redeploy') {
    const dispatcherFn = dispatchDeploy || defaultLocalhostDeploy(config);
    // We pass whatever SHA is currently on the branch entry. For a
    // pure /cds redeploy without a preceding push, this may be stale
    // or empty — the deploy route then falls back to `git rev-parse
    // HEAD` on the worktree.
    const sha = branch.githubCommitSha || '';
    await postReply(
      `@${sc.commenter} 🔄 已排队重新部署 \`${sc.branchId}\`${sha ? ` @ ${sha.slice(0, 7)}` : ''}。` +
      `进度见 Checks 面板的 "CDS Deploy" 条目。`,
    );
    dispatcherFn(sc.branchId, sha).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[slash] redeploy dispatch failed: ${(err as Error).message}`);
    });
    return;
  }

  if (sc.command === 'stop') {
    await postReply(`@${sc.commenter} 🛑 正在停止 \`${sc.branchId}\` 的预览容器…`);
    try {
      await defaultLocalhostStop(config, sc.branchId);
      await postReply(`@${sc.commenter} ✓ 预览容器已停。push 或 \`/cds redeploy\` 可重新启动。`);
    } catch (err) {
      await postReply(`@${sc.commenter} ✖ 停止失败: ${(err as Error).message}`);
    }
    return;
  }

  if (sc.command === 'logs') {
    // Pull the latest deploy's last 40 events — same data the
    // check-run tail shows, but surfaced inline for quick diagnosis.
    const logs = stateService.getLogs?.(sc.branchId) || stateService.getState().logs?.[sc.branchId] || [];
    const latest = logs.length > 0 ? logs[logs.length - 1] : null;
    if (!latest) {
      await postReply(`@${sc.commenter} ℹ 分支 \`${sc.branchId}\` 暂无部署日志。`);
      return;
    }
    const events = (latest.events || []).slice(-40);
    const rendered = events.map((ev) => `[${ev.status || '?'}] ${ev.step}: ${ev.title || ''}`).join('\n');
    const tail = rendered.slice(-8000);
    await postReply(
      `@${sc.commenter} 📋 \`${sc.branchId}\` 最近 ${events.length} 条部署事件:\n\n` +
      '```\n' + tail + '\n```\n\n' +
      `<sub>完整日志: ${(config.publicBaseUrl || '').replace(/\/$/, '')}/branch-panel?id=${encodeURIComponent(sc.branchId)}</sub>`,
    );
    return;
  }
}
