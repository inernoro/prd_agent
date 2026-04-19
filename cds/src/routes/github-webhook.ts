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
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] dispatch error event=${eventName} delivery=${deliveryId || '?'}:`,
        err,
      );
      res.status(500).json({
        error: 'dispatch_error',
        message: (err as Error).message,
      });
      return;
    }

    // Kick off the deploy asynchronously. The webhook response is sent
    // back to GitHub within the GitHub 10s timeout regardless of how
    // long the build takes.
    if (result.deployRequest) {
      const request = result.deployRequest;
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

    res.json({
      ok: true,
      event: eventName,
      delivery: deliveryId,
      action: result.action,
      message: result.message,
      branchId: result.branchId,
      deployDispatched: Boolean(result.deployRequest),
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
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
      res.status(400).json({
        error: 'validation',
        field: 'repoFullName',
        message: 'repoFullName 必须是 "owner/repo" 格式',
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
  return async (branchId) => {
    const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(branchId)}/deploy`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDS-Internal': '1',
      },
      body: JSON.stringify({}),
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

  // Build the comment body — Railway-style: bold "CDS Deploy" header +
  // preview link + branch/SHA ref + autoDeploy toggle hint.
  const host = config.previewDomain || config.rootDomains?.[0];
  const previewUrl = host ? `https://${branchId}.${host}` : null;
  const shortSha = (branch.githubCommitSha || '').slice(0, 7);
  const lines = [
    '## 🚀 CDS Deploy Preview',
    '',
    previewUrl
      ? `- **Preview**: [${previewUrl}](${previewUrl})`
      : '- **Preview**: (当前 CDS 未配置 previewDomain / rootDomains, 预览 URL 不可用)',
    `- **Branch**: \`${branch.branch}\`${shortSha ? ` @ ${shortSha}` : ''}`,
    `- **CDS Dashboard**: [${branchId}](${(config.publicBaseUrl || '').replace(/\/$/, '')}/branch-panel?id=${encodeURIComponent(branchId)})`,
    '',
    '<sub>push 到此分支会自动触发新部署, 本条评论会在每次部署后原地刷新。</sub>',
  ];
  const body = lines.join('\n');

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
