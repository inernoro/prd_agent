/**
 * Comment template admin API — lets the operator customise the
 * GitHub PR preview comment body from the Settings panel instead of
 * redeploying CDS to change text.
 *
 * Endpoints:
 *   GET  /api/comment-template            — current body + variable catalog
 *   PUT  /api/comment-template            — save body (only body — {{prReviewUrl}}
 *                                           is derived from each branch's previewUrl
 *                                           at render time, no separate base URL)
 *   POST /api/comment-template/preview    — render a trial body with sample vars,
 *                                           so the panel can live-preview before saving
 *
 * Auth: mounted under `/api` which is covered by the cookie/token or
 * github auth middleware in server.ts — no extra guard here. We don't
 * enforce per-project scope because the template is a single global
 * setting (per-project override is a deliberate non-goal for v1).
 *
 * Storage: goes through StateService.setCommentTemplate, which rides
 * on the same state-save pipeline as routingRules/customEnv. In JSON
 * mode it lands in state.json; in Mongo mode it lands in the cds_state
 * document. The user sees no difference between modes.
 */

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { CdsConfig, CommentTemplateSettings } from '../types.js';
import {
  DEFAULT_TEMPLATE_BODY,
  VARIABLE_DEFS,
  buildDashboardUrl,
  buildTemplateVariables,
  renderTemplate,
} from '../services/comment-template.js';

export interface CommentTemplateRouterDeps {
  stateService: StateService;
  config: CdsConfig;
}

/**
 * Guard rails on body size. A runaway template would enlarge every
 * single PR comment CDS posts, which is both noisy and costs
 * GitHub's 65536-char comment limit. 16KB is plenty for anything
 * reasonable and leaves headroom after placeholder substitution.
 */
const MAX_BODY_LENGTH = 16 * 1024;

/**
 * Sample values used by /preview. Chosen to be obviously-fake so the
 * preview looks like a preview, not real data. Keep roughly aligned
 * with VARIABLE_DEFS examples.
 */
const PREVIEW_SAMPLE = {
  branch: 'feature/preview',
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
  prNumber: 123,
  prUrl: 'https://github.com/acme/demo/pull/123',
  repoFullName: 'acme/demo',
};

export function createCommentTemplateRouter(deps: CommentTemplateRouterDeps): Router {
  const router = Router();
  const { stateService, config } = deps;

  /**
   * Compute the `{{previewUrl}}` the webhook would use for a given
   * branch id. Mirrors the inline logic in github-webhook.ts so the
   * preview mode and the real path stay consistent.
   */
  function previewUrlFor(branchId: string): string {
    const host = config.previewDomain || config.rootDomains?.[0];
    return host ? `https://${branchId}.${host}` : '';
  }

  // GET /api/comment-template
  //
  // Returns the current saved settings (or null if never saved),
  // the default body, and the variable catalog so the UI can render
  // a consistent "available variables" sidebar without hard-coding
  // the list on the frontend.
  router.get('/comment-template', (_req, res) => {
    const current = stateService.getCommentTemplate();
    res.json({
      ok: true,
      body: current?.body || DEFAULT_TEMPLATE_BODY,
      updatedAt: current?.updatedAt || null,
      isDefault: !current,
      defaultBody: DEFAULT_TEMPLATE_BODY,
      variables: VARIABLE_DEFS,
    });
  });

  // PUT /api/comment-template
  //
  // Saves a new body. Empty body is accepted and is interpreted as
  // "reset to default" — the renderer falls back when `body` is
  // falsy (see postOrUpdatePrComment).
  router.put('/comment-template', (req, res) => {
    const { body } = (req.body || {}) as { body?: string };

    if (body !== undefined && typeof body !== 'string') {
      res.status(400).json({ ok: false, message: 'body 必须是字符串' });
      return;
    }
    const trimmedBody = (body ?? '').slice(0, MAX_BODY_LENGTH);

    const settings: CommentTemplateSettings = {
      body: trimmedBody,
      updatedAt: new Date().toISOString(),
    };
    stateService.setCommentTemplate(settings);
    stateService.save();

    res.json({
      ok: true,
      body: settings.body,
      updatedAt: settings.updatedAt,
    });
  });

  // POST /api/comment-template/preview
  //
  // Renders the submitted body with sample variables so the Settings
  // panel can show "this is what it would look like on a real PR"
  // before the user hits save. Also usable against the saved body
  // (omit `body`) for a "did I break anything" sanity check.
  router.post('/comment-template/preview', (req, res) => {
    const { body, branchId } = (req.body || {}) as { body?: string; branchId?: string };
    const source =
      typeof body === 'string' && body.length > 0
        ? body
        : stateService.getCommentTemplate()?.body || DEFAULT_TEMPLATE_BODY;

    // Pick a real branch id if one was provided + exists, otherwise
    // fall back to a synthetic preview id so URLs look reasonable.
    const effectiveBranchId =
      (branchId && stateService.getBranch(branchId)?.id) || 'preview-branch';

    const vars = buildTemplateVariables({
      branch: PREVIEW_SAMPLE.branch,
      commitSha: PREVIEW_SAMPLE.commitSha,
      previewUrl: previewUrlFor(effectiveBranchId),
      dashboardUrl: buildDashboardUrl(config.publicBaseUrl, effectiveBranchId),
      repoFullName: PREVIEW_SAMPLE.repoFullName,
      prNumber: PREVIEW_SAMPLE.prNumber,
      prUrl: PREVIEW_SAMPLE.prUrl,
    });
    const rendered = renderTemplate(source, vars);
    res.json({ ok: true, rendered, variables: vars });
  });

  return router;
}
