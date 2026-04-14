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
import { randomBytes } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { IShellExecutor, Project, CdsConfig } from '../types.js';
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

interface ProjectSummary extends Project {
  branchCount: number;
}

function toSummary(project: Project, branchCount: number): ProjectSummary {
  return { ...project, branchCount };
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const router = Router();
  const { stateService, shell, config } = deps;

  function countBranchesFor(project: Project): number {
    // P4 Part 17 (G9 fix): use the project-scoped helper so non-legacy
    // projects show their real branch count instead of always 0. The
    // helper treats branches without a projectId as belonging to the
    // legacy 'default' project, which preserves the pre-P4 rollup
    // behaviour for the legacy project.
    return stateService.getBranchesForProject(project.id).length;
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
  router.get('/projects', (_req, res) => {
    const projects = stateService.getProjects();
    const summaries = projects.map((p) => toSummary(p, countBranchesFor(p)));
    res.json({ projects: summaries, total: summaries.length });
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
    res.json(toSummary(project, countBranchesFor(project)));
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

    const slug = (body.slug || '').trim().toLowerCase() || slugifyName(name);
    if (!SLUG_REGEX.test(slug)) {
      res.status(400).json({
        error: 'validation',
        field: 'slug',
        message: 'slug 只能包含小写字母、数字和短横线，且不能以短横线开头或结尾',
      });
      return;
    }

    const gitRepoUrl = typeof body.gitRepoUrl === 'string' ? body.gitRepoUrl.trim() : undefined;
    const description = typeof body.description === 'string' ? body.description.trim() : undefined;

    // Duplicate slug check against existing projects (including legacy).
    const existingProjects = stateService.getProjects();
    if (existingProjects.some((p) => p.slug === slug)) {
      res.status(409).json({ error: 'duplicate', field: 'slug', message: `slug '${slug}' 已被占用` });
      return;
    }

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

    res.status(201).json({ project: toSummary(newProject, 0) });
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

    const body = (req.body || {}) as Partial<{
      name: string;
      description: string;
      gitRepoUrl: string;
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

    const patch: Partial<Pick<Project, 'name' | 'description' | 'gitRepoUrl'>> = {};
    if (body.name !== undefined) patch.name = String(body.name).trim();
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
    res.json({ project: toSummary(updated, countBranchesFor(updated)) });
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

    try {
      stateService.updateProject(project.id, {
        cloneStatus: 'cloning',
        cloneError: undefined,
      });
      sendEvent('start', {
        projectId: project.id,
        gitRepoUrl: gitUrl,
        repoPath,
      });

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
      sendEvent('progress', { line: `$ git clone ${gitUrl} ${repoPath}` });
      const clone = await shell.exec(
        `git clone "${gitUrl}" "${repoPath}"`,
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
        const errMsg = (combinedOutput(clone) || 'git clone failed').trim();
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

  return router;
}
