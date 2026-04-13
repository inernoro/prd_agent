/**
 * Projects API router.
 *
 * P1 (initial shell) served a single hard-coded "default" project.
 * P4 Part 1 (this commit) reads the real projects list from
 * StateService.getProjects(). The migration in StateService.load()
 * guarantees that at least one project always exists — the "legacy
 * default" created from the current repo's slug — so the response
 * shape is identical to the P1 shell for existing callers.
 *
 * Endpoints:
 *   GET    /api/projects          → list real projects from state.json
 *   GET    /api/projects/:id      → one project's details
 *   POST   /api/projects          → 501 (real creation in P4 Part 2)
 *   DELETE /api/projects/:id      → 501 (real deletion in P4 Part 2)
 *
 * The POST / DELETE endpoints are kept as 501 placeholders so the
 * frontend can toast "coming soon" at the right moment; when P4 Part 2
 * lands they flip to real behavior (docker network create/remove +
 * StateService.addProject/removeProject).
 *
 * See doc/design.cds-multi-project.md,
 * doc/plan.cds-multi-project-phases.md P4.
 */

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { Project } from '../types.js';

export interface ProjectsRouterDeps {
  stateService: StateService;
  /** Kept for backward compat with P1 callers; ignored in Part 1. */
  legacyProjectName?: string;
}

/**
 * Stable identifier of the migration-created legacy project. Exported
 * so tests can assert on it and the frontend can special-case it when
 * it wants to show a "Legacy" badge.
 */
export const LEGACY_PROJECT_ID = 'default';

/**
 * Shape returned by `/api/projects`. Adds derived fields (branchCount)
 * that are not persisted on Project itself.
 */
interface ProjectSummary extends Project {
  /** Number of branches currently scoped to this project. */
  branchCount: number;
}

function toSummary(project: Project, branchCount: number): ProjectSummary {
  return { ...project, branchCount };
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  /**
   * Count branches attributed to a project. In Part 1 there is only
   * ever the legacy project, so every branch belongs to it. Part 3
   * will thread real projectId onto BranchEntry and make this a proper
   * filter.
   */
  function countBranchesFor(project: Project): number {
    const state = stateService.getState();
    const totalBranches = Object.keys(state.branches || {}).length;
    return project.legacyFlag ? totalBranches : 0;
  }

  // GET /api/projects — list all projects.
  router.get('/projects', (_req, res) => {
    const projects = stateService.getProjects();
    const summaries = projects.map((p) => toSummary(p, countBranchesFor(p)));
    res.json({
      projects: summaries,
      total: summaries.length,
    });
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

  // POST /api/projects — real creation lands in P4 Part 2.
  router.post('/projects', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      message: 'Creating additional projects will land in P4 Part 2. See doc/plan.cds-multi-project-phases.md.',
      availablePhase: 'P4 Part 2',
    });
  });

  // DELETE /api/projects/:id — real deletion lands in P4 Part 2.
  router.delete('/projects/:id', (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      message: 'Deleting projects will land in P4 Part 2. The legacy project will never be deletable.',
      availablePhase: 'P4 Part 2',
    });
  });

  return router;
}
