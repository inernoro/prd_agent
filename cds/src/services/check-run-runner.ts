/**
 * CheckRunRunner — thin helper that bridges CDS deploys and GitHub
 * check-run API calls.
 *
 * The branch deploy route calls `ensureOpen()` at the start of a build and
 * `finalize()` when the build ends. Both are best-effort: any failure is
 * logged but does NOT crash the deploy — GitHub connectivity problems
 * shouldn't block a CDS preview going live.
 *
 * All check-run calls skip silently when:
 *   - The GitHub App isn't configured (no client passed in)
 *   - The branch isn't linked to a GitHub repo (no githubRepoFullName)
 *   - The branch has no commit SHA (no githubCommitSha)
 *
 * Configuration and state mutations happen via StateService so the
 * check-run id survives restarts and concurrent requests see a consistent
 * view.
 */

import type { StateService } from './state.js';
import type { GitHubAppClient } from './github-app-client.js';
import type { BranchEntry, CdsConfig } from '../types.js';
import { buildPreviewUrl } from './comment-template.js';

export interface CheckRunRunnerDeps {
  stateService: StateService;
  githubApp?: GitHubAppClient;
  config: CdsConfig;
}

export class CheckRunRunner {
  constructor(private readonly deps: CheckRunRunnerDeps) {}

  // Tracks the last progress PATCH time per check-run id so we don't
  // flood GitHub's API during a chatty deploy (dozens of log lines
  // per second). 5s throttle = ~12 PATCHes/minute, well under the
  // 5000/hour core limit even for a single noisy deploy.
  private readonly _lastProgressMs = new Map<number, number>();
  private static readonly PROGRESS_THROTTLE_MS = 5_000;

  private get enabled(): boolean {
    return Boolean(this.deps.githubApp);
  }

  /**
   * Build the `details_url` linking GitHub's "Details" button back to
   * this branch's deploy panel. Falls back to a stable "branch list"
   * path when publicBaseUrl isn't set (dev-only install).
   */
  private buildDetailsUrl(branchId: string): string {
    const base = this.deps.config.publicBaseUrl?.replace(/\/$/, '') || `http://localhost:${this.deps.config.masterPort}`;
    return `${base}/branch-panel?id=${encodeURIComponent(branchId)}`;
  }

  /**
   * Parse "owner/repo" from a repo full name. GitHub always uses one slash
   * separating exactly two segments so split+validate is adequate.
   */
  private parseRepo(fullName: string): { owner: string; repo: string } | null {
    const parts = fullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  /**
   * Create (or reuse) an in-progress check run for a branch that's about
   * to deploy. Updates `branch.githubCheckRunId` so the companion
   * `finalize()` call can PATCH the right record.
   *
   * No-op when GitHub is disabled or the branch isn't linked. Best-effort —
   * any HTTP or state error is swallowed after logging.
   */
  async ensureOpen(entry: BranchEntry): Promise<void> {
    if (!this.enabled) return;
    const repoFullName = entry.githubRepoFullName;
    const headSha = entry.githubCommitSha;
    const instId = entry.githubInstallationId;
    if (!repoFullName || !headSha || !instId) return;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return;

    try {
      const result = await this.deps.githubApp!.createCheckRun(
        instId,
        parsed.owner,
        parsed.repo,
        {
          name: 'CDS Deploy',
          headSha,
          status: 'in_progress',
          detailsUrl: this.buildDetailsUrl(entry.id),
          externalId: entry.id,
          startedAt: new Date().toISOString(),
          output: {
            title: 'Deploying to CDS…',
            summary: `分支 \`${entry.branch}\` 正在构建部署,完成后会在此更新预览链接。`,
          },
        },
      );
      this.deps.stateService.updateBranchGithubMeta(entry.id, {
        githubCheckRunId: result.id,
      });
      this.deps.stateService.save();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] createCheckRun failed for branch=${entry.id}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Push an intermediate progress update. Keeps status=in_progress but
   * updates the output title + summary so users refreshing GitHub's PR
   * Checks panel see "正在构建 admin (1/2)…" instead of a stale
   * "Deploying to CDS…" for the entire build.
   *
   * Throttled per check-run so we don't spam GitHub during a chatty
   * deploy. `force=true` bypasses the throttle (use for layer start /
   * layer done milestones that should always land).
   */
  async progress(entry: BranchEntry, opts: {
    title: string;
    summary: string;
    force?: boolean;
  }): Promise<void> {
    if (!this.enabled) return;
    const id = entry.githubCheckRunId;
    const repoFullName = entry.githubRepoFullName;
    const instId = entry.githubInstallationId;
    if (!id || !repoFullName || !instId) return;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return;

    if (!opts.force) {
      const last = this._lastProgressMs.get(id) || 0;
      if (Date.now() - last < CheckRunRunner.PROGRESS_THROTTLE_MS) return;
    }
    this._lastProgressMs.set(id, Date.now());

    try {
      await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
        status: 'in_progress',
        detailsUrl: this.buildDetailsUrl(entry.id),
        output: {
          title: opts.title,
          summary: opts.summary,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] progress PATCH failed for branch=${entry.id}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Close out the check run with the final status + a summary the user
   * can read in GitHub's UI. No-op when no check-run was opened.
   */
  async finalize(entry: BranchEntry, opts: {
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled';
    summary: string;
    previewUrl?: string;
    /**
     * Optional tail of deploy log events to embed in the check-run
     * output. Rendered as a fenced code block in `output.text` — GitHub
     * collapses `text` by default but makes it expandable under a
     * "Show more" affordance, which is perfect for failure postmortem.
     */
    logTail?: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const id = entry.githubCheckRunId;
    const repoFullName = entry.githubRepoFullName;
    const instId = entry.githubInstallationId;
    if (!id || !repoFullName || !instId) return;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return;

    const title =
      opts.conclusion === 'success'
        ? 'Deploy successful'
        : opts.conclusion === 'failure'
        ? 'Deploy failed'
        : opts.conclusion === 'cancelled'
        ? 'Deploy cancelled'
        : 'Deploy finished';
    const summaryLines = [opts.summary];
    if (opts.previewUrl) summaryLines.push('', `预览地址: ${opts.previewUrl}`);

    // GitHub's output.text caps at 65535 chars; we trim to 30k to stay
    // comfortably under the limit with room for markdown chrome.
    let text: string | undefined;
    if (opts.logTail && opts.logTail.trim()) {
      const tail = opts.logTail.slice(-30_000);
      text = '### Deploy log (尾部)\n\n```\n' + tail + '\n```';
    }

    let patched = false;
    try {
      await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
        status: 'completed',
        conclusion: opts.conclusion,
        completedAt: new Date().toISOString(),
        detailsUrl: this.buildDetailsUrl(entry.id),
        output: {
          title,
          summary: summaryLines.join('\n'),
          ...(text ? { text } : {}),
        },
      });
      patched = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] updateCheckRun failed for branch=${entry.id}:`,
        (err as Error).message,
      );
    }
    this._lastProgressMs.delete(id);
    // After GitHub confirms the completed state, clear the stamped id
    // from state so the next CDS restart's reconcileOrphans doesn't
    // re-PATCH this already-completed run to `neutral` (which would
    // overwrite green/red with grey). If the PATCH failed we KEEP the
    // id so the reconciler can try again. Caught by Cursor Bugbot
    // review on #450.
    if (patched) {
      this.deps.stateService.updateBranchGithubMeta(entry.id, {
        githubCheckRunId: undefined,
      });
      try { this.deps.stateService.save(); } catch { /* best-effort */ }
    }
  }

  /**
   * Derive the preview URL used in check-run summaries. 走 buildPreviewUrl
   * 这一全栈唯一入口，自动跟随 v3 公式（tail-prefix-projectSlug）。
   */
  derivePreviewUrl(entry: BranchEntry): string | undefined {
    const host = this.deps.config.previewDomain || this.deps.config.rootDomains?.[0];
    if (!host) return undefined;
    const project = entry.projectId
      ? this.deps.stateService.getProject(entry.projectId)
      : undefined;
    const projectSlug = project?.slug || entry.projectId;
    if (!projectSlug) return undefined;
    return buildPreviewUrl(host, entry.branch, projectSlug) || undefined;
  }

  /**
   * Reconcile orphan check-runs on CDS startup.
   *
   * Background: when CDS restarts mid-deploy (self-update / self-force-
   * sync / crash), the deploy's check-run was set to `in_progress` but
   * never got its `finalize()` PATCH, so GitHub keeps showing a yellow
   * spinner forever. Every commit on the page ends up with "pending"
   * status even though the branch has long since finished deploying
   * (or errored out).
   *
   * At startup we walk every tracked branch and for each one that:
   *   - has a `githubCheckRunId` stored, AND
   *   - is NOT currently building/starting,
   * we PATCH the check run to `conclusion: 'neutral'` with a short
   * "superseded by restart" note. GitHub replaces the spinner with a
   * grey neutral dot — accurate and no longer "stuck".
   *
   * Safe to call repeatedly; already-completed check-runs are no-ops
   * on GitHub (PATCH of completed → completed is idempotent).
   */
  async reconcileOrphans(): Promise<void> {
    if (!this.enabled) return;
    const branches = this.deps.stateService.getAllBranches();
    for (const entry of branches) {
      const id = entry.githubCheckRunId;
      const repoFullName = entry.githubRepoFullName;
      const instId = entry.githubInstallationId;
      if (!id || !repoFullName || !instId) continue;
      // DON'T skip building/starting statuses — those are EXACTLY the
      // ones we need to reconcile. reconcileOrphans is only called once
      // at boot; at that moment no deploy is actually in flight in this
      // process, so a "building" status can only be a leftover from the
      // crash/restart that stranded this check run.
      // (An earlier version skipped these, which defeated the whole
      // purpose. Caught by Cursor Bugbot review on #450.)
      const parsed = this.parseRepo(repoFullName);
      if (!parsed) continue;
      try {
        await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
          status: 'completed',
          conclusion: 'neutral',
          completedAt: new Date().toISOString(),
          detailsUrl: this.buildDetailsUrl(entry.id),
          output: {
            title: 'Deploy state unknown after CDS restart',
            summary:
              '此 check run 的 CDS 部署过程被 self-update / 重启打断,' +
              '无法确认最终状态。已标记为 neutral 供展示参考,' +
              `push 或 \`/cds redeploy\` 会触发一次干净的新部署。` +
              (entry.status === 'running' ? '\n\n(当前分支: running 运行中)' : '') +
              (entry.status === 'error' ? '\n\n(当前分支: error — 查看 CDS 日志)' : ''),
          },
        });
        // Drop the stale id so next deploy creates a fresh check run
        // instead of PATCHing this one to in_progress.
        //
        // Compare-and-swap: if a concurrent webhook-triggered deploy
        // already called ensureOpen() between our iteration start and
        // here, the branch entry's checkRunId would have been replaced
        // by a NEW id. Clearing blindly would wipe that fresh id,
        // leaving the deploy's finalize() unable to close the run.
        // Only clear when the id still matches the one we just PATCHed.
        // Caught by Cursor Bugbot #450 round 5.
        const latest = this.deps.stateService.getBranch(entry.id);
        if (latest && latest.githubCheckRunId === id) {
          this.deps.stateService.updateBranchGithubMeta(entry.id, { githubCheckRunId: undefined });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[check-run] reconcileOrphans failed for branch=${entry.id}:`,
          (err as Error).message,
        );
      }
    }
    try { this.deps.stateService.save(); } catch { /* best-effort */ }
  }
}
