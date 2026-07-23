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
import type { BranchEntry, CdsConfig, DeploymentRun } from '../types.js';
import { buildPreviewUrlForProject } from './comment-template.js';

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
  private buildDetailsUrl(branchId: string, runId?: string): string {
    const base = this.deps.config.publicBaseUrl?.replace(/\/$/, '') || `http://localhost:${this.deps.config.masterPort}`;
    const params = new URLSearchParams({ id: branchId });
    if (runId) params.set('runId', runId);
    return `${base}/branch-panel?${params.toString()}`;
  }

  private currentDeploymentRun(entry: BranchEntry): DeploymentRun | undefined {
    return entry.lastDeploymentRunId
      ? this.deps.stateService.getDeploymentRun(entry.lastDeploymentRunId)
      : undefined;
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
   *
   * 返回本次创建的 check-run id（未创建/失败时 undefined）。调用方必须用这个
   * 返回值记住「自己这轮的 id」，**禁止**在 await 之后重读 entry 上的可变指针
   * ——并发的取代方部署可能已把 githubCheckRunId 盖成它自己的，重读会把别人
   * 的 id 记成自己的、并在 superseded 收尾时误杀对方的 check run（Codex P2，
   * PR #1235）。
   */
  async ensureOpen(entry: BranchEntry): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    const repoFullName = entry.githubRepoFullName;
    const headSha = entry.githubCommitSha;
    const instId = entry.githubInstallationId;
    if (!repoFullName || !headSha || !instId) return undefined;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return undefined;
    const run = this.currentDeploymentRun(entry);

    try {
      const result = await this.deps.githubApp!.createCheckRun(
        instId,
        parsed.owner,
        parsed.repo,
        {
          name: 'CDS Deploy',
          headSha,
          status: 'in_progress',
          detailsUrl: this.buildDetailsUrl(entry.id, run?.id),
          externalId: run?.id || entry.id,
          startedAt: new Date().toISOString(),
          output: {
            title: 'Deploying to CDS…',
            summary: `分支 \`${entry.branch}\` 正在构建部署,完成后会在此更新预览链接。${run ? `\n\nDeploymentRun: \`${run.id}\`` : ''}`,
          },
        },
      );
      this.deps.stateService.updateBranchGithubMeta(entry.id, {
        githubCheckRunId: result.id,
      });
      this.deps.stateService.save();
      return result.id;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] createCheckRun failed for branch=${entry.id}:`,
        (err as Error).message,
      );
      return undefined;
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
    const run = this.currentDeploymentRun(entry);

    if (!opts.force) {
      const last = this._lastProgressMs.get(id) || 0;
      if (Date.now() - last < CheckRunRunner.PROGRESS_THROTTLE_MS) return;
    }
    this._lastProgressMs.set(id, Date.now());

    try {
      await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
        status: 'in_progress',
        detailsUrl: this.buildDetailsUrl(entry.id, run?.id),
        output: {
          title: opts.title,
          summary: run ? `${opts.summary}\n\nDeploymentRun: \`${run.id}\` · ${run.status} · ${run.phase}` : opts.summary,
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
     * 显式指定要收尾的 check-run id（缺省取 entry.githubCheckRunId）。
     * 用于「被取代的部署收尾自己的 check run」：新部署的 ensureOpen 可能已把
     * entry 上的 id 覆盖成新 run 的，旧部署若只认 state 指针就永远够不到自己
     * 那个 in_progress 的 run（Codex P2，PR #1235）。带 override 时 state 上的
     * id 仅在仍等于本 id 时才被清除（CAS），绝不误清新部署的 id。
     */
    checkRunId?: number;
    /**
     * 显式指定摘要里引用的 DeploymentRun（缺省取 entry.lastDeploymentRunId）。
     * 与 checkRunId 同因：entry 上的 run 指针可能已被新部署替换。
     */
    runId?: string;
    /**
     * Optional tail of deploy log events to embed in the check-run
     * output. Rendered as a fenced code block in `output.text` — GitHub
     * collapses `text` by default but makes it expandable under a
     * "Show more" affordance, which is perfect for failure postmortem.
     */
    logTail?: string;
    /**
     * Optional markdown rendered ABOVE the deploy-log fence — used for the
     * auto-diagnosed failure root cause + container log tail. This is the
     * channel a sandboxed agent (no CDS network/credential) reads via GitHub
     * to learn why the deploy failed, instead of begging the user for logs.
     */
    failureDetail?: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const id = opts.checkRunId ?? entry.githubCheckRunId;
    const repoFullName = entry.githubRepoFullName;
    const instId = entry.githubInstallationId;
    if (!id || !repoFullName || !instId) return;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return;
    const run = opts.runId
      ? this.deps.stateService.getDeploymentRun(opts.runId)
      : this.currentDeploymentRun(entry);

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
    if (run) summaryLines.push('', `DeploymentRun: \`${run.id}\` · ${run.status} · ${run.phase}`);

    // GitHub's output.text caps at 65535 chars; we trim to 30k to stay
    // comfortably under the limit with room for markdown chrome.
    // 失败根因(failureDetail)放在最上面,部署日志尾部(logTail)放下面。
    // 关键:截断只能砍 logTail 的尾部,绝不能把顶部的 failureDetail(根因)截掉
    // —— 否则 sandbox agent 在大日志失败时反而读不到根因(整个特性失去意义)。
    const CAP = 30_000;
    const structuredFailure = run?.failure
      ? [
          '### DeploymentRun 结构化失败',
          '',
          `- code: \`${run.failure.code}\``,
          `- owner: \`${run.failure.owner}\``,
          `- retryable: \`${String(run.failure.retryable)}\``,
          `- phase: \`${run.failure.phase || run.phase}\``,
          `- summary: ${run.failure.summary}`,
          ...(run.failure.suggestedAction ? [`- suggestedAction: ${run.failure.suggestedAction}`] : []),
        ].join('\n')
      : '';
    const detailBlock = [structuredFailure, opts.failureDetail || ''].filter(Boolean).join('\n\n').trim();
    const runLogBlock = run?.events.map((event) =>
      `[${event.seq}] [${event.status}] ${event.phase}: ${event.message}`,
    ).join('\n') || '';
    const logBlock = (runLogBlock || opts.logTail || '').trim();
    const parts: string[] = [];
    if (detailBlock) parts.push(detailBlock.length > CAP ? detailBlock.slice(0, CAP) : detailBlock);
    if (logBlock) {
      const used = parts.reduce((n, p) => n + p.length + 2, 0); // +2 ≈ '\n\n' 分隔
      const budget = CAP - used - 40; // 给 fence 标记留点余量
      if (budget > 200) {
        const tail = logBlock.length > budget ? logBlock.slice(-budget) : logBlock;
        parts.push('### Deploy log (尾部)\n\n```\n' + tail + '\n```');
      }
    }
    const text: string | undefined = parts.length > 0 ? parts.join('\n\n') : undefined;

    let patched = false;
    try {
      await this.deps.githubApp!.updateCheckRun(instId, parsed.owner, parsed.repo, id, {
        status: 'completed',
        conclusion: opts.conclusion,
        completedAt: new Date().toISOString(),
        detailsUrl: this.buildDetailsUrl(entry.id, run?.id),
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
    //
    // CAS 语义（Codex P2，PR #1235）：只有 state 上的 id 仍等于刚 PATCH 的那个
    // 才清除。并发的新一轮部署可能已经用 ensureOpen 盖上了新 id——无条件清除
    // 会把新部署的 id 抹掉，让它的 finalize 变成 no-op、check run 永远黄灯。
    if (patched) {
      const latest = this.deps.stateService.getBranch(entry.id);
      if (latest && latest.githubCheckRunId === id) {
        this.deps.stateService.updateBranchGithubMeta(entry.id, {
          githubCheckRunId: undefined,
        });
        try { this.deps.stateService.save(); } catch { /* best-effort */ }
      }
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
    return buildPreviewUrlForProject(host, entry.branch, project, entry.projectId).url || undefined;
  }

  /**
   * 为「部署从未启动」的失败直接创建一个已完结的 check run（单次 API 调用）。
   *
   * 与 ensureOpen/finalize 的适用面不同：那对组合服务于「部署路由真的跑起来了」
   * 的生命周期；而 webhook 派发失败、极速版等待 CI 镜像超时这类失败发生在
   * ensureOpen 之前——此前它们只写 CDS 内部状态（branch.errorMessage /
   * ciImageError），GitHub 上该 commit 连 "CDS Deploy" 条目都没有，用户在 PR
   * Checks 面板看到的是彻底的静默（与「部署失败但黄灯转圈」同族，2026-07-23
   * 举一反三排查发现）。本方法把这类失败显式写成红灯/灰灯。
   *
   * 不落 githubCheckRunId（已完结，无需后续 finalize；也不能覆盖在途部署的 id）。
   * best-effort：任何错误只记日志不冒泡。
   */
  async concludeWithoutDeploy(entry: BranchEntry, opts: {
    conclusion: 'failure' | 'neutral';
    title: string;
    summary: string;
    /**
     * 显式指定 check run 挂的 commit sha（缺省取 entry.githubCommitSha）。
     * webhook 派发失败必须钉住**被派发的** commitSha（Codex P2，PR #1235）：
     * 派发调用挂起期间若有新 push 刷新分支元数据，读可变的 entry 会把红灯
     * 误挂到新 HEAD 上——而新 push 会触发自己的部署与 check run，失败归属
     * 必须留在真正派发失败的那个 commit。
     */
    headSha?: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const repoFullName = entry.githubRepoFullName;
    const headSha = opts.headSha ?? entry.githubCommitSha;
    const instId = entry.githubInstallationId;
    if (!repoFullName || !headSha || !instId) return;
    const parsed = this.parseRepo(repoFullName);
    if (!parsed) return;
    const at = new Date().toISOString();
    try {
      await this.deps.githubApp!.createCheckRun(instId, parsed.owner, parsed.repo, {
        name: 'CDS Deploy',
        headSha,
        status: 'completed',
        conclusion: opts.conclusion,
        startedAt: at,
        completedAt: at,
        detailsUrl: this.buildDetailsUrl(entry.id),
        externalId: entry.id,
        output: { title: opts.title, summary: opts.summary },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[check-run] concludeWithoutDeploy failed for branch=${entry.id}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * 周期收敛「CDS 内部已终结、GitHub 上还挂着 in_progress」的 check run。
   *
   * 病根（2026-07-23 用户反馈）：部署实际已失败——DeploymentRun 被心跳收割器
   * （reconcileInterrupted）收敛为 failed、或部署被更高优先级操作取代——但这些
   * 路径都不经过部署路由末尾的 finalize()，GitHub PR Checks 面板上的
   * "CDS Deploy" 于是永远黄灯转圈（"构建第 2/3 层…Started 8m ago"），既不报错
   * 也不成功；用户点进 CDS 才发现早失败了。此前唯一的兜底 reconcileOrphans
   * 只在 CDS 重启时跑一次，运行期的 stranded check run 无人收尾。
   *
   * 本方法按分支上残留的 githubCheckRunId + 关联 DeploymentRun 的**真实终态**
   * 补收尾：
   *   - run failed    → conclusion=failure（带结构化失败根因，finalize 自动嵌入）
   *   - run cancelled → conclusion=cancelled（被取代/取消）
   *   - run running   → conclusion=success（部署其实成功了，只是当时 finalize
   *                     的 PATCH 丢失——网络抖动或进程被打断）
   *   - run 仍在途（心跳新鲜） → 不触碰，属于合法长构建
   *   - 无关联 run    → 分支已处于终结态才收尾（error→failure / running→success /
   *                     其余→neutral）；分支仍 building/starting 时不触碰，交给
   *                     deploy-stuck-reconciler 先把分支收敛，下一轮再补收尾
   *
   * 竞态防护：run 终结后需超过 terminalGraceMs（默认 3 分钟）才动手——部署路由
   * 自己的 finalize 就发生在 run 终结后的几秒内，宽限期保证不与在途收尾抢跑；
   * 动手前重读分支，githubCheckRunId 或 lastDeploymentRunId 已被新一轮部署替换
   * 则跳过（新部署的 ensureOpen 会创建新 check run，旧 id 已不归本轮管）。
   *
   * 返回本轮补收尾的数量，供调用方打日志。
   */
  async reconcileStale(options: {
    now?: Date;
    /** run 终结后的宽限期，避免与部署路由自己的 finalize 抢跑。默认 3 分钟。 */
    terminalGraceMs?: number;
  } = {}): Promise<number> {
    if (!this.enabled) return 0;
    const now = options.now ?? new Date();
    const terminalGraceMs = options.terminalGraceMs ?? 3 * 60_000;
    const TERMINAL_RUN_STATUSES = new Set(['running', 'failed', 'cancelled']);
    const NON_TERMINAL_BRANCH_STATES = new Set(['starting', 'building', 'stopping', 'restarting']);
    let finalized = 0;

    for (const entry of this.deps.stateService.getAllBranches()) {
      const id = entry.githubCheckRunId;
      if (!id || !entry.githubRepoFullName || !entry.githubInstallationId) continue;
      const run = this.currentDeploymentRun(entry);

      let conclusion: 'success' | 'failure' | 'neutral' | 'cancelled';
      let summary: string;
      if (run) {
        // 有关联 run：一切以 run 的真实终态为准（分支 status 可能自己也卡死了）。
        if (!TERMINAL_RUN_STATUSES.has(run.status)) continue; // 合法在途，不触碰
        const finishedMs = Date.parse(run.finishedAt || run.updatedAt || '');
        if (!Number.isFinite(finishedMs) || now.getTime() - finishedMs < terminalGraceMs) continue;
        if (run.status === 'failed') {
          conclusion = 'failure';
          summary = `部署已失败：${run.failure?.summary || run.events[run.events.length - 1]?.message || '原因见 DeploymentRun 事件'}（check run 由后台看门狗补收尾）`;
        } else if (run.status === 'cancelled') {
          conclusion = 'cancelled';
          summary = '部署被取消或被更高优先级操作取代（check run 由后台看门狗补收尾）';
        } else {
          // run=running：部署本体成功。但 branches.ts 在自动冒烟失败时会把
          // check conclusion 定为 failure、而 run 仍推进到 running（transition
          // 事件带 detail.smokeOk=false）——丢失的 PATCH 不能被补成绿灯，否则
          // 冒烟失败对 reviewer 隐身（Codex P2，PR #1235）。从 run 事件里回读
          // 冒烟结论：任一 running 事件带 smokeOk=false 即判 failure。
          const smokeFailed = run.events.some((ev) =>
            ev.status === 'running' && (ev.detail as { smokeOk?: unknown } | undefined)?.smokeOk === false,
          );
          if (smokeFailed) {
            conclusion = 'failure';
            summary = '部署运行完成，但自动冒烟未通过（当时的 check run 回写丢失，由后台看门狗补收尾）';
          } else {
            conclusion = 'success';
            summary = '部署已成功完成（当时的 check run 回写丢失，由后台看门狗补收尾）';
          }
        }
      } else {
        // 无关联 run（旧式部署 / run 记录缺失）：只在分支已终结时保守收尾；
        // 仍在 building/starting 的交给 deploy-stuck-reconciler 先收敛分支状态。
        if (NON_TERMINAL_BRANCH_STATES.has(entry.status)) continue;
        const startMs = Date.parse(entry.lastDeployStartedAt || '');
        if (Number.isFinite(startMs) && now.getTime() - startMs < terminalGraceMs) continue;
        if (entry.status === 'error') {
          conclusion = 'failure';
          summary = `部署已失败：${entry.errorMessage || '原因见 CDS 分支日志'}（check run 由后台看门狗补收尾）`;
        } else if (entry.status === 'running') {
          conclusion = 'success';
          summary = '部署已成功完成（当时的 check run 回写丢失，由后台看门狗补收尾）';
        } else {
          conclusion = 'neutral';
          summary = `分支当前为 ${entry.status}，部署流程早已结束但 check run 未收尾，已标记为 neutral`;
        }
      }

      // 竞态防护：重读分支，check-run id / run id 已被新一轮部署替换则跳过。
      const latest = this.deps.stateService.getBranch(entry.id);
      if (!latest || latest.githubCheckRunId !== id) continue;
      if (run && latest.lastDeploymentRunId !== run.id) continue;

      try {
        await this.finalize(latest, {
          conclusion,
          summary,
          previewUrl: conclusion === 'success' ? this.derivePreviewUrl(latest) : undefined,
        });
        finalized += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[check-run] reconcileStale: branch=${entry.id} checkRun=${id} → ${conclusion}` +
          (run ? ` (run=${run.id} status=${run.status})` : ` (branch.status=${entry.status})`),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[check-run] reconcileStale finalize failed for branch=${entry.id}:`,
          (err as Error).message,
        );
      }
    }
    return finalized;
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
      // 有关联 DeploymentRun 的分支不在本方法职责内（Codex P2，PR #1235）：
      //   - run 已终结 → 启动时先跑的 reconcileStale({terminalGraceMs:0}) 已按
      //     真实终态收尾（红/绿），本方法若再抢跑会把它灰化 + 清 id，失败信息
      //     永久丢失；
      //   - run 未终结 → 心跳收割器会在过期后把它收敛为 failed，周期
      //     reconcileStale 随后写红灯。此处灰化会把「即将有准确结论」的 run
      //     提前抹掉（且早期 webhook 新部署的 in_progress run 也可能被误灰）。
      // 本方法只兜「无关联 run 的旧式滞留 id」——那才是真正无从判定的孤儿。
      if (this.currentDeploymentRun(entry)) continue;
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
          detailsUrl: this.buildDetailsUrl(entry.id, entry.lastDeploymentRunId),
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
