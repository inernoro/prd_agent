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

export interface CheckRunRunnerDeps {
  stateService: StateService;
  githubApp?: GitHubAppClient;
  config: CdsConfig;
}

export class CheckRunRunner {
  constructor(private readonly deps: CheckRunRunnerDeps) {}

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
   * Close out the check run with the final status + a summary the user
   * can read in GitHub's UI. No-op when no check-run was opened.
   */
  async finalize(entry: BranchEntry, opts: {
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled';
    summary: string;
    previewUrl?: string;
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

    try {
      await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
        status: 'completed',
        conclusion: opts.conclusion,
        completedAt: new Date().toISOString(),
        detailsUrl: this.buildDetailsUrl(entry.id),
        output: {
          title,
          summary: summaryLines.join('\n'),
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] updateCheckRun failed for branch=${entry.id}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Derive the preview URL used in check-run summaries. Uses the first
   * configured rootDomain / previewDomain like the rest of CDS. Returns
   * undefined when no domain is configured.
   */
  derivePreviewUrl(entry: BranchEntry): string | undefined {
    const host = this.deps.config.previewDomain || this.deps.config.rootDomains?.[0];
    if (!host) return undefined;
    return `https://${entry.id}.${host}`;
  }
}
