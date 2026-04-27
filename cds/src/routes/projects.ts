/**
 * Projects API router.
 *
 * P1 (initial shell) served a single hard-coded "default" project.
 *
 * P4 Part 1 taught the router to read StateService.getProjects() and
 * rely on the migration that auto-creates a "legacy default" project.
 *
 * P4 Part 2 (this commit) wires up real creation and deletion:
 *   - POST /api/projects   → validates input, generates id + slug,
 *                            creates a dedicated docker network
 *                            (`cds-proj-<id>`), persists via
 *                            StateService.addProject(). Rolls the
 *                            network back if the save fails.
 *   - DELETE /api/projects/:id → refuses the legacy project, removes
 *                            the docker network, then removes the
 *                            state entry via StateService.removeProject().
 *
 * P4 Part 3 will thread projectId into Branch/BuildProfile/InfraService/
 * RoutingRule so that project-scoped listings and deletes cascade
 * correctly.
 *
 * See doc/design.cds-multi-project.md,
 * doc/plan.cds-multi-project-phases.md P4.
 */

import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { IShellExecutor, Project, CdsConfig, AgentKey } from '../types.js';
import { combinedOutput } from '../types.js';

export interface ProjectsRouterDeps {
  stateService: StateService;
  /** Shell for docker network create/inspect/rm. Injectable for tests. */
  shell: IShellExecutor;
  /** Root CDS config — unused in Part 2 but reserved for Part 3 when we derive per-project paths. */
  config?: CdsConfig;
  /** Kept for backward compat with P1 callers; ignored. */
  legacyProjectName?: string;
}

/**
 * Stable identifier of the migration-created legacy project. Exported
 * so tests can assert on it and the frontend can special-case it for
 * labelling and to hide the delete button.
 */
export const LEGACY_PROJECT_ID = 'default';

/**
 * Maximum length of `Project.name` we accept on POST. Long names would
 * overflow the UI card and the docker network name derivation.
 */
const MAX_NAME_LENGTH = 60;

/**
 * Regex for acceptable slugs. Matches kebab/alphanumeric and forbids
 * leading/trailing dashes. Kept permissive enough that the user can
 * pass their own slug, strict enough to be URL- and docker-safe.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Derive a URL-friendly slug from a free-form project name. Same
 * algorithm as CdsConfig.repoRoot → projectSlug in StateService so
 * legacy and newly-created projects use a consistent slug style.
 */
function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'project';
}

/**
 * Generate a short, stable-across-restarts-until-deletion project id.
 * We use a 12-char hex (6 random bytes) — collision-free enough for a
 * single-node CDS with at most a few dozen projects, and short enough
 * to embed into the docker network name without wrapping.
 */
function generateProjectId(): string {
  return randomBytes(6).toString('hex');
}

/** Derive the dedicated docker network name for a project. */
function dockerNetworkFor(projectId: string): string {
  return `cds-proj-${projectId}`;
}

/**
 * P4 Part 18 (Phase E audit fix #9): strip userinfo (user:password@)
 * from a git URL before storing or echoing it. This prevents the
 * common footgun where a user pastes
 *   https://token:x-oauth-basic@github.com/foo/bar.git
 * and we persist the token to state.json in plain text.
 *
 * We keep http/https/ssh/file URLs parseable via the standard URL
 * class, and fall back to a regex for the SSH shorthand
 * (git@github.com:foo/bar.git) which the URL class doesn't parse.
 */
export function _redactUrlUserInfo(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    // Not a URL the standard parser understands — keep it as-is.
    // SSH shorthand (git@host:path) has no userinfo concept, it's
    // just the user the remote expects. No redaction needed.
    return raw;
  }
}

/**
 * P4 Part 18 (Phase E audit fix #1): rewrite a public github.com
 * HTTPS URL to include the Device Flow access token so private repos
 * clone successfully.
 *
 * Rules:
 *   - URL must be https://github.com/... (any other host is left alone)
 *   - URL must not already carry userinfo (we don't override explicit
 *     credentials because the user might be intentionally testing)
 *   - token must be non-empty
 * Returns the original URL when any rule fails.
 *
 * The token is only used in the ephemeral shell argument — NEVER
 * persisted to state.json (which stores the original `gitRepoUrl`).
 */
export function _injectGithubTokenIfPossible(raw: string, token: string | undefined): string {
  if (!token) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== 'https:') return raw;
  if (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com')) return raw;
  if (u.username || u.password) return raw;
  // GitHub recommends `x-access-token` as the username for Device-Flow
  // tokens on HTTPS clones. See
  // https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

/**
 * Does the given URL look like an HTTPS github.com clone URL?
 * Used by the UF-01 preflight check in the clone route.
 */
export function _isGithubHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'github.com' || u.hostname.endsWith('.github.com');
}

/**
 * Translate a raw git clone stderr blob into a Chinese actionable
 * message when it matches known "no credentials available" patterns.
 * Returns the original message on no-match. Used by the UF-01 fix in
 * the clone route so users hitting a private-repo clone without a
 * Device Flow token see a clear "please sign in first" instead of
 * the bare english "could not read Username" error.
 */
export function _mapGitCloneError(rawMsg: string, isGithubUrl: boolean, hasDeviceToken: boolean): string {
  const msg = rawMsg || '';
  const looksLikeAuthProblem =
    /could not read Username/i.test(msg) ||
    /terminal prompts disabled/i.test(msg) ||
    /Authentication failed/i.test(msg) ||
    /remote: Repository not found/i.test(msg);
  if (!looksLikeAuthProblem) return msg;
  if (isGithubUrl && !hasDeviceToken) {
    return (
      '无法访问该 GitHub 仓库:未登录 GitHub。\n' +
      '请点击 Settings → GitHub 完成 Device Flow 登录,或在创建对话框内点击"使用 GitHub 登录",然后重试克隆。\n\n' +
      '原始 git 错误:\n' + msg
    );
  }
  if (isGithubUrl && hasDeviceToken) {
    return (
      '已登录 GitHub 但仍无法访问该仓库。可能原因:\n' +
      '- 当前 token 的 scope 不包含该仓库(请确认授权时勾选了 repo)\n' +
      '- 该仓库属于未授权给 GitHub App 的组织\n' +
      '- token 已过期或被撤销(请在 Settings → GitHub 重新登录)\n\n' +
      '原始 git 错误:\n' + msg
    );
  }
  return msg;
}

/**
 * Format a plaintext Agent Key preview for display.
 * Returns `cdsp_<slug>_<first12>…<last4>` so the UI can show "this is the
 * one" without exposing the full secret. Only called at sign time when we
 * still have the plaintext in hand.
 */
function formatKeyPreview(plaintext: string): string {
  const lastUnderscore = plaintext.lastIndexOf('_');
  if (lastUnderscore < 0) return plaintext;
  const prefix = plaintext.slice(0, lastUnderscore + 1);
  const suffix = plaintext.slice(lastUnderscore + 1);
  if (suffix.length <= 16) return plaintext;
  return prefix + suffix.slice(0, 12) + '…' + suffix.slice(-4);
}

/**
 * Minimal helper that enforces a project-key request can only touch its
 * own project. Returns null when access is allowed (or when the request
 * isn't using a project key at all), or a `{ status, body }` object for
 * the caller to `res.status(x).json(y)` on mismatch.
 *
 * This is NOT a middleware — we inline-call it at the top of the 5-6
 * write-heavy routes we care about. Read-only GETs don't need it.
 */
export function assertProjectAccess(
  req: { cdsProjectKey?: { projectId: string; keyId: string } },
  targetProjectId: string | undefined,
): null | { status: number; body: Record<string, unknown> } {
  const projectKey = req.cdsProjectKey;
  if (!projectKey) return null; // bootstrap key or cookie auth — no scope check
  if (!targetProjectId) return null; // no target to check against
  if (projectKey.projectId === targetProjectId) return null;
  return {
    status: 403,
    body: {
      error: 'project_mismatch',
      expected: projectKey.projectId,
      got: targetProjectId,
      message:
        '这把 key 只能操作 ' + projectKey.projectId + ' 项目，请让用户在目标项目页重新「授权 Agent」',
    },
  };
}

/**
 * Roll-up runtime stats rendered on the project list card so the user
 * can tell at a glance whether a project is alive without clicking in.
 *
 * - branchCount: total branches in the project (including cold / error)
 * - runningBranchCount: branches with at least one running service
 * - runningServiceCount: sum of services in `running` state across branches
 * - lastDeployedAt: max(lastAccessedAt) across branches; BranchEntry
 *   updates lastAccessedAt on deploy completion (branches.ts:1210/1366),
 *   so this is a good "latest deploy" proxy. null when no branch ever
 *   deployed. Cached values from state.json — not a live docker check.
 */
interface ProjectStats {
  branchCount: number;
  runningBranchCount: number;
  runningServiceCount: number;
  lastDeployedAt: string | null;
}

const EMPTY_STATS: ProjectStats = {
  branchCount: 0,
  runningBranchCount: 0,
  runningServiceCount: 0,
  lastDeployedAt: null,
};

interface ProjectSummary extends Project, ProjectStats {}

function toSummary(project: Project, stats: ProjectStats): ProjectSummary {
  return { ...project, ...stats };
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const router = Router();
  const { stateService, shell, config } = deps;

  function statsFor(project: Project): ProjectStats {
    // P4 Part 17 (G9 fix): use the project-scoped helper so non-legacy
    // projects show their real branch count instead of always 0. The
    // helper treats branches without a projectId as belonging to the
    // legacy 'default' project, which preserves the pre-P4 rollup
    // behaviour for the legacy project.
    const branches = stateService.getBranchesForProject(project.id);
    let runningBranchCount = 0;
    let runningServiceCount = 0;
    let lastDeployedAt: string | null = null;
    for (const b of branches) {
      const services = Object.values(b.services || {});
      const runningHere = services.filter((s) => s.status === 'running').length;
      if (runningHere > 0) runningBranchCount++;
      runningServiceCount += runningHere;
      if (b.lastAccessedAt && (!lastDeployedAt || b.lastAccessedAt > lastDeployedAt)) {
        lastDeployedAt = b.lastAccessedAt;
      }
    }
    return {
      branchCount: branches.length,
      runningBranchCount,
      runningServiceCount,
      lastDeployedAt,
    };
  }

  /**
   * Idempotent docker network create. If the network already exists
   * (exit code 0 from `docker network inspect`) this is a no-op.
   * Otherwise we run `docker network create` and throw on failure so
   * the caller can roll back the state mutation.
   */
  async function ensureDockerNetwork(name: string): Promise<void> {
    const inspect = await shell.exec(`docker network inspect ${name}`);
    if (inspect.exitCode === 0) return;
    const create = await shell.exec(`docker network create ${name}`);
    if (create.exitCode !== 0) {
      throw new Error(
        `Failed to create Docker network "${name}": ${combinedOutput(create)}`,
      );
    }
  }

  /**
   * Remove a docker network. Best-effort: we log on failure but don't
   * block the state deletion, because a dangling network is far less
   * harmful than a zombie project entry that the user can't remove.
   */
  async function removeDockerNetwork(name: string): Promise<{ ok: boolean; detail?: string }> {
    // Check existence first so we don't emit a spurious error on a
    // re-attempted delete.
    const inspect = await shell.exec(`docker network inspect ${name}`);
    if (inspect.exitCode !== 0) return { ok: true, detail: 'network already gone' };
    const rm = await shell.exec(`docker network rm ${name}`);
    if (rm.exitCode !== 0) {
      return { ok: false, detail: combinedOutput(rm) };
    }
    return { ok: true };
  }

  // GET /api/projects — list all projects.
  //
  // Wrapped in try/catch so an unexpected exception inside
  // statsFor (e.g. a malformed branch entry in state.json)
  // surfaces a clear 500 with diagnostics instead of bubbling out as
  // an opaque Express default response. Without this, the dashboard
  // showed the unhelpful "加载项目列表失败：HTTP 400" with no clue
  // what triggered the failure.
  router.get('/projects', (_req, res) => {
    try {
      const projects = stateService.getProjects();
      const summaries = projects.map((p) => toSummary(p, statsFor(p)));
      // Sort: legacy pinned first (existing UX), then by runtime liveness
      // so projects with running services bubble up — useful once you
      // have many projects and only a few are active.
      summaries.sort((a, b) => {
        if (a.legacyFlag && !b.legacyFlag) return -1;
        if (!a.legacyFlag && b.legacyFlag) return 1;
        if (a.runningServiceCount !== b.runningServiceCount) {
          return b.runningServiceCount - a.runningServiceCount;
        }
        const at = a.lastDeployedAt || '';
        const bt = b.lastDeployedAt || '';
        if (at !== bt) return bt.localeCompare(at);
        return 0;
      });
      res.json({ projects: summaries, total: summaries.length });
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      // eslint-disable-next-line no-console
      console.error('[projects] GET /api/projects failed:', err);
      res.status(500).json({
        error: 'projects_list_failed',
        message: `项目列表读取失败: ${msg}`,
      });
    }
  });

  // GET /api/projects/:id — project detail.
  router.get('/projects/:id', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    res.json(toSummary(project, statsFor(project)));
  });

  // PR_C.4: 项目活动日志（供 UI 渲染时间线 / 浮窗）。
  // limit 默认 50，最大 200（与 ring buffer 上限一致，避免一次拉爆）。
  router.get('/projects/:id/activity-logs', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    const logs = stateService.getActivityLogs(project.id, { limit, sinceIso });
    res.json({ projectId: project.id, logs, total: logs.length });
  });

  // POST /api/projects — real creation (P4 Part 2).
  //
  // Request body: { name, slug?, description?, gitRepoUrl? }
  // Responses:
  //   201 { project }          — success
  //   400 { error: 'validation', field, message }
  //   409 { error: 'duplicate', field }
  //   500 { error: 'docker', message } — docker create failed
  router.post('/projects', async (req, res) => {
    // Project keys are bound to a single project — they may not mint
    // new projects. Only the bootstrap key / cookie-auth may.
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_create',
        message: 'Project-scoped Agent Key 无权创建新项目；请在 CDS 管理页手动新建。',
      });
      return;
    }

    const body = (req.body || {}) as Partial<{
      name: string;
      slug: string;
      description: string;
      gitRepoUrl: string;
    }>;

    // — Validation —
    const name = (body.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'validation', field: 'name', message: '项目名称不能为空' });
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      res.status(400).json({
        error: 'validation',
        field: 'name',
        message: `项目名称长度不能超过 ${MAX_NAME_LENGTH}`,
      });
      return;
    }

    // Track whether the slug was explicitly supplied by the caller.
    // When the caller leaves slug blank, we derive it from the project
    // name and silently auto-suffix on collision (-2, -3, ...) so
    // pasting a Git URL whose repo name happens to match an existing
    // project just works. When the caller supplies an explicit slug,
    // we keep the strict 409 behaviour so the user knows their pick
    // collided.
    const slugProvidedExplicitly = Boolean((body.slug || '').trim());
    const baseSlug = slugProvidedExplicitly
      ? (body.slug as string).trim().toLowerCase()
      : slugifyName(name);
    if (!SLUG_REGEX.test(baseSlug)) {
      res.status(400).json({
        error: 'validation',
        field: 'slug',
        message: 'slug 只能包含小写字母、数字和短横线，且不能以短横线开头或结尾',
      });
      return;
    }
    // 2026-04-22 规则：禁止再用 'default' 作为项目 id，避免和遗留迁移项目冲突，
    // 也避免「default」被当成兜底值到处蔓延（就是用户在抱怨的老问题）。
    if (baseSlug === LEGACY_PROJECT_ID) {
      res.status(400).json({
        error: 'validation',
        field: 'slug',
        message: 'slug 不能为 "default"（保留给遗留迁移占位）。请用项目真实名称的派生 slug，例如 my-app。',
      });
      return;
    }

    // P4 Part 18 (Phase E audit fix #9): redact embedded userinfo
    // before persisting. Users who paste tokens in the URL by mistake
    // still get a working project, but the token never hits state.json.
    // Private repo auth should go through the Device Flow token
    // (injected at clone time via _injectGithubTokenIfPossible).
    const rawGitRepoUrl = typeof body.gitRepoUrl === 'string' ? body.gitRepoUrl.trim() : undefined;
    const gitRepoUrl = rawGitRepoUrl ? _redactUrlUserInfo(rawGitRepoUrl) : undefined;
    const description = typeof body.description === 'string' ? body.description.trim() : undefined;

    // Resolve the final slug. Auto-derived slugs walk -2, -3, ... on
    // collision so the user never has to manually disambiguate when
    // pasting a URL whose repo name matches an existing project (the
    // common case: legacy "prd-agent" project + a fresh Git repo also
    // named prd_agent). Capped at 99 attempts so a corrupted state
    // can't hang the request.
    const existingProjects = stateService.getProjects();
    const takenSlugs = new Set(existingProjects.map((p) => p.slug));
    let slug = baseSlug;
    if (takenSlugs.has(slug)) {
      if (slugProvidedExplicitly) {
        res.status(409).json({ error: 'duplicate', field: 'slug', message: `slug '${slug}' 已被占用` });
        return;
      }
      let suffix = 2;
      while (takenSlugs.has(`${baseSlug}-${suffix}`) && suffix < 100) suffix++;
      const candidate = `${baseSlug}-${suffix}`;
      if (takenSlugs.has(candidate)) {
        res.status(409).json({ error: 'duplicate', field: 'slug', message: `slug '${baseSlug}' 已被占用，且自动追加序号也未能找到空闲位` });
        return;
      }
      slug = candidate;
    }
    const slugAutoAdjusted = slug !== baseSlug;

    // — Build the new project —
    const now = new Date().toISOString();
    const id = generateProjectId();
    const network = dockerNetworkFor(id);
    // P4 Part 18 (G1.3): when a gitRepoUrl is supplied AND CDS has
    // been configured with a reposBase, stamp the new project with a
    // per-project repoPath and mark cloneStatus='pending'. The actual
    // `git clone` happens out-of-band via POST /api/projects/:id/clone
    // so the create request stays fast. When reposBase isn't set we
    // leave repoPath undefined and the project falls back to the
    // legacy single-repo root at every worktree call-site — this is
    // what pre-G1 CDS installs will see.
    const reposBase = config?.reposBase;
    const willClone = Boolean(gitRepoUrl && reposBase);
    const newProject: Project = {
      id,
      slug,
      name,
      description,
      kind: 'git',
      gitRepoUrl: gitRepoUrl || undefined,
      dockerNetwork: network,
      legacyFlag: false,
      createdAt: now,
      updatedAt: now,
      ...(willClone
        ? {
            repoPath: `${reposBase}/${id}`,
            cloneStatus: 'pending' as const,
          }
        : {}),
    };

    // — Side effects with rollback —
    //
    // Create the docker network first. If that fails, nothing is
    // persisted and the user can retry. If the state save fails after
    // the network exists, we attempt to roll the network back so the
    // user isn't left with an orphaned network blocking future creates
    // with the same id.
    try {
      await ensureDockerNetwork(network);
    } catch (err) {
      res.status(500).json({
        error: 'docker',
        message: (err as Error).message,
      });
      return;
    }

    try {
      stateService.addProject(newProject);
    } catch (err) {
      // Rollback the network we just created. Best-effort — we log the
      // rollback result but still return the original save error so the
      // caller knows why the request failed.
      await removeDockerNetwork(network).catch(() => { /* already reported */ });
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    res.status(201).json({
      project: toSummary(newProject, EMPTY_STATS),
      // Surface the auto-suffix so the frontend can show a friendly
      // toast like "已自动调整 slug 为 prd-agent-2 (原 slug 已被占用)".
      slugAutoAdjusted: slugAutoAdjusted ? { from: baseSlug, to: slug } : undefined,
    });
  });

  // PUT /api/projects/:id — patch mutable project fields.
  //
  // P4 Part 13 (Project Settings page). Accepts {name, description,
  // gitRepoUrl} and delegates to StateService.updateProject which
  // bumps updatedAt + persists. Immutable fields (id, slug, kind,
  // legacyFlag, dockerNetwork, createdAt) are intentionally not
  // patchable through this endpoint — changing slug would break the
  // URL routing and changing dockerNetwork would orphan containers.
  router.put('/projects/:id', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }

    const body = (req.body || {}) as Partial<{
      name: string;
      aliasName: string;
      aliasSlug: string;
      description: string;
      gitRepoUrl: string;
      autoSmokeEnabled: boolean;
      // PR_D.3: 5 个 per-event toggle，对应 Project.githubEventPolicy
      githubEventPolicy: {
        push?: boolean;
        delete?: boolean;
        prClose?: boolean;
        prOpen?: boolean;
        slashCommand?: boolean;
      };
    }>;

    // Validate name when supplied
    if (body.name !== undefined) {
      const trimmed = String(body.name).trim();
      if (!trimmed) {
        res.status(400).json({ error: 'validation', field: 'name', message: '项目名称不能为空' });
        return;
      }
      if (trimmed.length > MAX_NAME_LENGTH) {
        res.status(400).json({
          error: 'validation',
          field: 'name',
          message: `项目名称长度不能超过 ${MAX_NAME_LENGTH}`,
        });
        return;
      }
    }

    // Validate aliasName when supplied. Empty string = clear the alias.
    if (body.aliasName !== undefined) {
      const trimmed = String(body.aliasName).trim();
      if (trimmed.length > MAX_NAME_LENGTH) {
        res.status(400).json({
          error: 'validation',
          field: 'aliasName',
          message: `显示别名长度不能超过 ${MAX_NAME_LENGTH}`,
        });
        return;
      }
    }

    // Validate aliasSlug when supplied. Empty string = clear. Non-empty
    // must pass SLUG_REGEX AND not collide with any project's slug /
    // aliasSlug (including the current project's own slug — that would
    // be redundant and confusing).
    if (body.aliasSlug !== undefined) {
      const trimmed = String(body.aliasSlug).trim().toLowerCase();
      if (trimmed !== '') {
        if (!SLUG_REGEX.test(trimmed)) {
          res.status(400).json({
            error: 'validation',
            field: 'aliasSlug',
            message: '别名 slug 只能包含小写字母、数字和短横线，且不能以短横线开头或结尾',
          });
          return;
        }
        if (trimmed === project.slug) {
          res.status(400).json({
            error: 'validation',
            field: 'aliasSlug',
            message: '别名 slug 不能与项目原 slug 相同',
          });
          return;
        }
        // Walk every OTHER project and check both slug and aliasSlug.
        const collision = stateService
          .getProjects()
          .find(
            (p) =>
              p.id !== project.id &&
              (p.slug === trimmed || p.aliasSlug === trimmed),
          );
        if (collision) {
          res.status(409).json({
            error: 'duplicate',
            field: 'aliasSlug',
            message: `别名 slug '${trimmed}' 已被项目 '${collision.name}' 占用`,
          });
          return;
        }
      }
    }

    const patch: Partial<Pick<Project, 'name' | 'aliasName' | 'aliasSlug' | 'description' | 'gitRepoUrl' | 'autoSmokeEnabled' | 'githubEventPolicy'>> = {};
    // PR_D.3: 合并 5 个 toggle 到 githubEventPolicy（partial patch — 仅
    // 对显式传入的 key 更新，不影响其它 key）。
    if (body.githubEventPolicy && typeof body.githubEventPolicy === 'object') {
      const incoming = body.githubEventPolicy;
      const existing = project.githubEventPolicy || {};
      const merged: NonNullable<Project['githubEventPolicy']> = { ...existing };
      const allowedKeys = ['push', 'delete', 'prClose', 'prOpen', 'slashCommand'] as const;
      for (const k of allowedKeys) {
        if (incoming[k] !== undefined) merged[k] = incoming[k] === true;
      }
      patch.githubEventPolicy = merged;
    }
    if (body.autoSmokeEnabled !== undefined) {
      // Booleans come in as true / false / 'true' / 'false' depending on
      // the UI; coerce everything truthy but 'false' into a real boolean.
      patch.autoSmokeEnabled = body.autoSmokeEnabled === true || body.autoSmokeEnabled === 'true' as unknown as boolean;
    }
    if (body.name !== undefined) patch.name = String(body.name).trim();
    // For alias fields an empty string explicitly clears them so the UI
    // can revert to showing `name` / `slug`. updateProject() serialises
    // undefined fields out via spread, so we pass undefined (not '') to
    // remove the key entirely — keeps state.json tidy.
    if (body.aliasName !== undefined) {
      const trimmed = String(body.aliasName).trim();
      patch.aliasName = trimmed === '' ? undefined : trimmed;
    }
    if (body.aliasSlug !== undefined) {
      const trimmed = String(body.aliasSlug).trim().toLowerCase();
      patch.aliasSlug = trimmed === '' ? undefined : trimmed;
    }
    if (body.description !== undefined) patch.description = String(body.description).trim();
    if (body.gitRepoUrl !== undefined) patch.gitRepoUrl = String(body.gitRepoUrl).trim();

    try {
      stateService.updateProject(project.id, patch);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    const updated = stateService.getProject(project.id)!;
    res.json({ project: toSummary(updated, statsFor(updated)) });
  });

  // POST /api/projects/:id/clone — run the async git clone (P4 Part 18 G1.3).
  //
  // Contract:
  //   Trigger: POST /api/projects/:id/clone  (SSE response)
  //   Events:
  //     event: start     { projectId, gitRepoUrl, repoPath }
  //     event: progress  { line }             — one line of git clone output
  //     event: complete  { projectId, repoPath }
  //     event: error     { message }
  //
  // The clone is called only once per project — the endpoint refuses
  // if cloneStatus is already 'cloning' or 'ready' so repeated clicks
  // don't spawn parallel git processes. To re-clone after an error,
  // the client PATCHes cloneStatus back to 'pending' first (or just
  // retries if cloneStatus is currently 'error').
  //
  // This endpoint intentionally leaves the repoPath in place on
  // failure so the operator can inspect it. Successful clone flips
  // cloneStatus → 'ready' and the branch deploy path becomes usable
  // via StateService.getProjectRepoRoot().
  router.post('/projects/:id/clone', async (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const cloneMismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (cloneMismatch) {
      res.status(cloneMismatch.status).json(cloneMismatch.body);
      return;
    }
    if (!project.gitRepoUrl) {
      res.status(400).json({
        error: 'no_git_url',
        message: '项目未配置 gitRepoUrl，无法克隆。',
      });
      return;
    }
    if (!project.repoPath) {
      res.status(400).json({
        error: 'no_repo_path',
        message: 'CDS 未配置 reposBase（见 exec_cds.sh），无法确定克隆目标路径。',
      });
      return;
    }
    if (project.cloneStatus === 'cloning') {
      res.status(409).json({
        error: 'already_cloning',
        message: '该项目正在克隆中，请等待当前任务结束或刷新状态。',
      });
      return;
    }
    if (project.cloneStatus === 'ready') {
      res.status(409).json({
        error: 'already_ready',
        message: '该项目已克隆完成。如需重新克隆请先删除 repoPath 目录。',
      });
      return;
    }

    // Open SSE immediately so the client sees "cloning" as soon as
    // the request is accepted, even before mkdir returns.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client disconnected — update below still runs via server authority */
      }
    };

    const repoPath = project.repoPath;
    const gitUrl = project.gitRepoUrl;

    // P4 Part 18 (Phase E audit fix #1): if the URL points at github.com
    // AND a GitHub Device Flow token is stored, inject the token into
    // the clone URL so private repos work. The token is ephemerally
    // inserted into the shell command only — never persisted back to
    // state.json. If Device Flow isn't connected we try the bare URL,
    // which works for public repos.
    //
    // Also (audit fix #9): the displayed gitUrl in events is the
    // ORIGINAL user-supplied URL, but we DO redact any embedded
    // userinfo before logging so pasted credentials don't leak into
    // the SSE log or state.json.
    const displayUrl = _redactUrlUserInfo(gitUrl);
    const deviceToken = stateService.getGithubDeviceAuth()?.token;
    const cloneUrl = _injectGithubTokenIfPossible(gitUrl, deviceToken);

    // UF-01 preflight: when the URL points at github.com but we have
    // no Device Flow token, warn the user up-front. For public repos
    // this is harmless (we still attempt the clone), but for private
    // repos the bare URL will fail with
    //   fatal: could not read Username for 'https://github.com'
    // and the user sees an english git error with no actionable hint.
    // We emit a 'progress' warning now and map the error below.
    const isGithubUrl = _isGithubHttpsUrl(gitUrl);
    const needsAuthHint = isGithubUrl && !deviceToken;

    try {
      stateService.updateProject(project.id, {
        cloneStatus: 'cloning',
        cloneError: undefined,
      });
      sendEvent('start', {
        projectId: project.id,
        gitRepoUrl: displayUrl,
        repoPath,
      });
      if (needsAuthHint) {
        sendEvent('progress', {
          line: '⚠ 未检测到 GitHub Device Flow 登录。若这是私有仓库,clone 会因无法获取 Username 而失败。请关闭对话框,点击"使用 GitHub 登录"后重试。',
        });
      }

      // Ensure parent directory exists (reposBase / …)
      const lastSep = repoPath.lastIndexOf('/');
      const parentDir = lastSep > 0 ? repoPath.substring(0, lastSep) : '.';
      const mkdir = await shell.exec(`mkdir -p "${parentDir}"`);
      if (mkdir.exitCode !== 0) {
        throw new Error(`创建父目录失败: ${combinedOutput(mkdir)}`);
      }

      // Clean up a stale target dir if one exists (e.g. from a
      // previous errored clone). The cloneStatus guard above already
      // refuses 'ready', so we can only land here in 'pending' /
      // 'error' — both safe to blow away.
      const check = await shell.exec(`test -d "${repoPath}"`);
      if (check.exitCode === 0) {
        sendEvent('progress', { line: `清理残留目录: ${repoPath}` });
        const rm = await shell.exec(`rm -rf "${repoPath}"`);
        if (rm.exitCode !== 0) {
          throw new Error(`清理残留目录失败: ${combinedOutput(rm)}`);
        }
      }

      // Run the clone with streaming. git clone prints to stderr by
      // default but the MockShellExecutor's onData fires for both,
      // which is fine because the SSE stream is a cat of everything.
      // Always use `displayUrl` in the echoed shell line so tokens
      // don't leak into the SSE stream.
      sendEvent('progress', { line: `$ git clone ${displayUrl} ${repoPath}` });
      const clone = await shell.exec(
        `GIT_TERMINAL_PROMPT=0 git clone "${cloneUrl}" "${repoPath}"`,
        {
          timeout: 10 * 60 * 1000, // 10 minutes max; cancel any stuck clone
          onData: (chunk: string) => {
            // git often emits carriage-return progress updates for
            // "Receiving objects: 34%" etc. Split on both \n and \r
            // so the SSE client sees incremental updates instead of
            // a single giant line at the end.
            for (const line of chunk.split(/[\r\n]/)) {
              const trimmed = line.trim();
              if (trimmed) sendEvent('progress', { line: trimmed });
            }
          },
        },
      );

      if (clone.exitCode !== 0) {
        const rawErr = (combinedOutput(clone) || 'git clone failed').trim();
        // UF-01: translate "could not read Username" into a clear,
        // actionable Chinese message pointing the user at Device Flow.
        const errMsg = _mapGitCloneError(rawErr, isGithubUrl, !!deviceToken);
        stateService.updateProject(project.id, {
          cloneStatus: 'error',
          cloneError: errMsg,
        });
        sendEvent('error', { message: errMsg });
        res.end();
        return;
      }

      stateService.updateProject(project.id, {
        cloneStatus: 'ready',
        cloneError: undefined,
      });
      sendEvent('complete', { projectId: project.id, repoPath });
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      stateService.updateProject(project.id, {
        cloneStatus: 'error',
        cloneError: errMsg,
      });
      sendEvent('error', { message: errMsg });
    } finally {
      res.end();
    }
  });

  // DELETE /api/projects/:id — real deletion (P4 Part 2).
  //
  // Cascading branch/profile cleanup will happen in P4 Part 3 once
  // those entities carry projectId. For now a project is just a
  // top-level entry plus a docker network, so deletion touches only
  // those two things.
  router.delete('/projects/:id', async (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const delMismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (delMismatch) {
      res.status(delMismatch.status).json(delMismatch.body);
      return;
    }
    if (project.legacyFlag) {
      res.status(403).json({
        error: 'legacy_protected',
        message: '默认项目不可删除。',
      });
      return;
    }

    // Drop the docker network first so that even if state save fails,
    // the operator can retry and succeed without network collisions.
    if (project.dockerNetwork) {
      const result = await removeDockerNetwork(project.dockerNetwork);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[projects] failed to remove docker network ${project.dockerNetwork}: ${result.detail}`,
        );
        // Continue anyway — zombie network is less harmful than zombie
        // project entry. State cascade will clean up the rest.
      }
    }

    // P4 Part 17 (G8 fix): cascade-remove branches/profiles/infra/routing
    // belonging to this project so deleting a project no longer leaves
    // orphans in state.json. The state service returns a summary so we
    // can hand it back to the operator (and the next agent log replay
    // can spot what was lost). Container teardown is intentionally NOT
    // done here — the previous list view's per-branch DELETE already
    // handles that, and chasing it from a project DELETE would slow the
    // request to multi-second territory. We log the cascade summary so
    // operators can run `docker ps` and see the leftovers.
    let summary: ReturnType<typeof stateService.removeProject>;
    try {
      summary = stateService.removeProject(project.id);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    const totalCascade =
      summary.branches.length +
      summary.buildProfiles.length +
      summary.infraServices.length +
      summary.routingRules.length;
    if (totalCascade > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[projects] cascade-removed for project ${project.id}: ` +
          `${summary.branches.length} branches, ` +
          `${summary.buildProfiles.length} buildProfiles, ` +
          `${summary.infraServices.length} infraServices, ` +
          `${summary.routingRules.length} routingRules`,
      );
    }

    res.status(200).json({
      ok: true,
      projectId: project.id,
      cascade: summary,
    });
  });

  // ── Project-scoped Agent Keys ──
  //
  // POST /api/projects/:id/agent-keys — sign a new project-bound agent key
  //   body: { label?: string }
  //   201 { keyId, plaintext, preview }  (plaintext shown ONCE, never stored)
  //
  // GET /api/projects/:id/agent-keys — list metadata (no plaintext, no hash)
  //
  // DELETE /api/projects/:id/agent-keys/:keyId — revoke (200 / 404)
  //
  // See doc rule no-rootless-tree + CLAUDE.md §6 — plaintext is the root
  // users bootstrap their Agent with; CDS never caches or echoes it again.

  router.post('/projects/:id/agent-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    // Project-key holders may only sign keys for their own project.
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }

    const body = (req.body || {}) as { label?: string };
    const now = new Date();
    // Label: auto-generate from timestamp when the user didn't supply one.
    const defaultLabel =
      '签发于 ' +
      now.toISOString().replace('T', ' ').slice(0, 16);
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 100)
      : defaultLabel;

    // Plaintext layout: cdsp_<slugHead12>_<base64url 32 bytes>
    // - slugHead: first 12 chars of project.slug (lowercased). slug regex
    //   already forbids `_` and `/`, so the prefix splits cleanly on `_`.
    // - suffix: 32 random bytes, base64url — ~43 chars, entropy sufficient.
    const slugHead = project.slug.slice(0, 12).toLowerCase();
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsp_${slugHead}_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');

    // Capture signer identity from the github-auth middleware when present.
    const ghUser = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;

    const entry: AgentKey = {
      id: keyId,
      label,
      hash,
      scope: 'rw',
      createdAt: now.toISOString(),
      createdBy: ghUser?.login || undefined,
    };
    try {
      stateService.addAgentKey(project.id, entry);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    res.status(201).json({
      keyId,
      plaintext,
      preview: formatKeyPreview(plaintext),
    });
  });

  router.get('/projects/:id/agent-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const entries = stateService.getAgentKeys(project.id);
    res.json({
      keys: entries.map((e) => ({
        id: e.id,
        label: e.label,
        scope: e.scope,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
        lastUsedAt: e.lastUsedAt,
        revokedAt: e.revokedAt,
        status: e.revokedAt ? 'revoked' : 'active',
      })),
    });
  });

  router.delete('/projects/:id/agent-keys/:keyId', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }
    const ok = stateService.revokeAgentKey(project.id, req.params.keyId);
    if (!ok) {
      res.status(404).json({
        error: 'key_not_found',
        message: `Agent key '${req.params.keyId}' not found in project.`,
      });
      return;
    }
    res.json({ ok: true, keyId: req.params.keyId });
  });

  // ── Global (bootstrap-equivalent) Agent Keys ──
  //
  // POST /api/global-agent-keys — sign a new bootstrap key
  //   body: { label?: string }
  //   201 { keyId, plaintext, preview }
  //   403 when the caller is using a project-scoped key (those can't
  //       escalate their own scope; only cookie auth or the bootstrap
  //       AI_ACCESS_KEY may mint globals).
  //
  // GET /api/global-agent-keys — list metadata (no plaintext)
  // DELETE /api/global-agent-keys/:keyId — revoke
  //
  // Global keys use the `cdsg_` prefix (parallel to `cdsp_` for project
  // keys) so the auth middleware can route them without a projectId
  // lookup. See server.ts findGlobalAgentKeyForAuth path.

  router.post('/global-agent-keys', (req, res) => {
    // Project-scoped keys may not mint bootstrap-level keys — that would
    // be a privilege escalation (project key → global key → new project).
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_mint_global',
        message:
          '项目级 Agent Key 无权签发全局通行证。请在浏览器登录 CDS，或使用 bootstrap AI_ACCESS_KEY 操作。',
      });
      return;
    }

    const body = (req.body || {}) as { label?: string };
    const now = new Date();
    const defaultLabel = 'Global bootstrap 签发于 ' + now.toISOString().replace('T', ' ').slice(0, 16);
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 100)
      : defaultLabel;

    // Plaintext layout: cdsg_<base64url 32 bytes>. No slug head — global
    // keys have no project scope, so the auth path walks the full list
    // (small, bounded) looking for a hash match.
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsg_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');

    const ghUser = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;

    const entry = {
      id: keyId,
      label,
      hash,
      scope: 'rw' as const,
      createdAt: now.toISOString(),
      createdBy: ghUser?.login || undefined,
    };
    try {
      stateService.addGlobalAgentKey(entry);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    res.status(201).json({
      keyId,
      plaintext,
      preview: formatKeyPreview(plaintext),
    });
  });

  router.get('/global-agent-keys', (_req, res) => {
    const entries = stateService.getGlobalAgentKeys();
    res.json({
      keys: entries.map((e) => ({
        id: e.id,
        label: e.label,
        scope: e.scope,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
        lastUsedAt: e.lastUsedAt,
        revokedAt: e.revokedAt,
        status: e.revokedAt ? 'revoked' : 'active',
      })),
    });
  });

  router.delete('/global-agent-keys/:keyId', (req, res) => {
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_revoke_global',
        message: '项目级 Agent Key 无权吊销全局通行证。',
      });
      return;
    }
    const ok = stateService.revokeGlobalAgentKey(req.params.keyId);
    if (!ok) {
      res.status(404).json({
        error: 'key_not_found',
        message: `Global agent key '${req.params.keyId}' not found.`,
      });
      return;
    }
    res.json({ ok: true, keyId: req.params.keyId });
  });

  return router;
}
