/**
 * Projects API router — P1 shell implementation.
 *
 * This is the first step of the CDS v4 multi-project refactor
 * (see doc/design.cds-multi-project.md). In P1 we expose the `/api/projects`
 * surface as a thin shell backed by a hard-coded "default" project that
 * wraps the existing single-tenant state.json. Real multi-project support
 * (create/delete, per-project Docker networks, per-project data filter)
 * lands in P4.
 *
 * Endpoints:
 *   GET  /api/projects           → list (always returns exactly one project)
 *   GET  /api/projects/default   → details for the legacy project
 *   POST /api/projects           → 501 Not Implemented (landing in P4)
 *
 * The router is intentionally independent of StateService so that P1 can
 * ship without touching the data layer. In later phases this router will
 * own the `projects` MongoDB collection.
 */

import { Router } from 'express';
import type { StateService } from '../services/state.js';

export interface ProjectsRouterDeps {
  stateService: StateService;
  /** Display name of the legacy project (typically the git repo basename). */
  legacyProjectName?: string;
}

/**
 * The single "legacy project" identifier used until P4 introduces real
 * multi-project support. All existing state.json data is considered to
 * belong to this project.
 */
export const LEGACY_PROJECT_ID = 'default';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: 'git' | 'manual';
  workspaceId: string;
  legacyFlag: boolean;
  branchCount: number;
  createdAt: string;
  updatedAt: string;
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;
  const legacyName = deps.legacyProjectName || 'prd_agent';

  // A fixed timestamp so the legacy project has a stable createdAt value
  // across restarts. Not persisted anywhere; this is P1 shell data only.
  const legacyCreatedAt = '2026-04-12T00:00:00.000Z';

  function buildLegacyProject(): ProjectSummary {
    const state = stateService.getState();
    const branchCount = Object.keys(state.branches || {}).length;
    return {
      id: LEGACY_PROJECT_ID,
      slug: LEGACY_PROJECT_ID,
      name: legacyName,
      description: '默认项目(由 P1 外壳自动创建,包含所有现有分支和配置)',
      kind: 'git',
      workspaceId: 'system',
      legacyFlag: true,
      branchCount,
      createdAt: legacyCreatedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  // GET /api/projects — list all projects visible to the current user.
  // P1: always returns exactly one entry (the legacy project).
  router.get('/projects', (_req, res) => {
    res.json({
      projects: [buildLegacyProject()],
      total: 1,
    });
  });

  // GET /api/projects/:id — project detail.
  // P1: only 'default' is valid; anything else returns 404.
  router.get('/projects/:id', (req, res) => {
    if (req.params.id !== LEGACY_PROJECT_ID) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist. Only the default project is available until P4.`,
      });
      return;
    }
    res.json(buildLegacyProject());
  });

  // POST /api/projects — creation is not yet implemented.
  // P1 returns 501 with a pointer to the phase plan so UI can explain.
  router.post('/projects', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      message: 'Creating additional projects will land in P4. See doc/plan.cds-multi-project-phases.md.',
      availablePhase: 'P4',
    });
  });

  // DELETE /api/projects/:id — deletion is not yet implemented either.
  router.delete('/projects/:id', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      message: 'Deleting projects will land in P4. The legacy project cannot be deleted.',
      availablePhase: 'P4',
    });
  });

  return router;
}
