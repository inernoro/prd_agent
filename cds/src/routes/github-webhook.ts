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

    res.json({
      ok: true,
      event: eventName,
      delivery: deliveryId,
      action: result.action,
      message: result.message,
      branchId: result.branchId,
      deployDispatched: Boolean(result.deployRequest),
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
