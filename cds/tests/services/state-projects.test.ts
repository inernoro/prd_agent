/**
 * Tests for the P4 Part 1 StateService.projects methods.
 *
 * P4 Part 1 adds the projects[] field to CdsState and teaches StateService
 * how to migrate pre-P4 state.json files (auto-create a legacy default
 * project) plus expose CRUD over the new collection. P4 Part 2 will make
 * the real `POST /api/projects` endpoint use addProject(); until then
 * these tests pin the storage-layer behavior directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import type { Project, CdsState } from '../../src/types.js';

function writeRawState(filePath: string, state: Partial<CdsState>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');
}

describe('StateService — projects (P4 Part 1)', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-state-projects-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('migration on load()', () => {
    it('auto-creates a legacy default project for a fresh install', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      const projects = svc.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('default');
      expect(projects[0].legacyFlag).toBe(true);
      expect(projects[0].kind).toBe('git');
      expect(projects[0].slug).toBe(svc.projectSlug);
    });

    it('auto-creates a legacy default project for a pre-P4 state.json that has branches but no projects', () => {
      writeRawState(stateFile, {
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [],
        // NOTE: no `projects` field — this is a v3.2 snapshot
      });

      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      expect(svc.getProjects()).toHaveLength(1);
      expect(svc.getLegacyProject()?.legacyFlag).toBe(true);
    });

    it('is a no-op when projects already contain entries', () => {
      const now = new Date().toISOString();
      const existingProject: Project = {
        id: 'custom-id',
        slug: 'custom-slug',
        name: 'Custom Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      };
      writeRawState(stateFile, {
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [],
        projects: [existingProject],
      });

      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      const projects = svc.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('custom-id');
      // No legacy default was added
      expect(svc.getLegacyProject()).toBeUndefined();
    });

    it('persists the migrated project so a second load is idempotent', () => {
      const svc1 = new StateService(stateFile, tmpDir);
      svc1.load();
      const firstCreatedAt = svc1.getLegacyProject()!.createdAt;

      // Second instance reads the same file — should find the migrated
      // project already there and not re-create it.
      const svc2 = new StateService(stateFile, tmpDir);
      svc2.load();
      const secondCreatedAt = svc2.getLegacyProject()!.createdAt;

      expect(svc2.getProjects()).toHaveLength(1);
      // Same createdAt → proves the second load did NOT regenerate.
      expect(secondCreatedAt).toBe(firstCreatedAt);
    });
  });

  describe('getProject / getLegacyProject', () => {
    it('getProject returns undefined for unknown ids', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      expect(svc.getProject('no-such-id')).toBeUndefined();
    });

    it('getLegacyProject finds the legacyFlag entry', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      const legacy = svc.getLegacyProject();
      expect(legacy?.id).toBe('default');
    });
  });

  describe('resolveProjectForAutoBuild', () => {
    it('prefers the legacyFlag project', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const now = new Date().toISOString();
      svc.addProject({
        id: 'other',
        slug: 'other',
        name: 'Other',
        kind: 'git',
        repoPath: '/some/path',
        createdAt: now,
        updatedAt: now,
      });

      const owner = svc.resolveProjectForAutoBuild('/does/not/matter');
      // The fresh-install migration creates a `default` project with
      // legacyFlag=true, so that wins even when another project with a
      // matching repoPath also exists.
      expect(owner?.id).toBe('default');
    });

    it('falls back to a project whose repoPath matches after legacyFlag was cleared', () => {
      // Simulate the post-rename state: the legacyFlag project has been
      // renamed (id=prd-agent, legacyFlag=false, explicit repoPath set).
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const migrated = svc.getLegacyProject()!;
      migrated.legacyFlag = false;
      migrated.id = 'prd-agent';
      migrated.repoPath = '/srv/repos/prd_agent';
      svc.save();

      const owner = svc.resolveProjectForAutoBuild('/srv/repos/prd_agent');
      expect(owner?.id).toBe('prd-agent');
    });

    it('falls back to the project with no repoPath when nothing else matches', () => {
      // Post-rename but repoPath not explicitly set on the migrated
      // project — common for single-repo CDS instances that rely on
      // config.repoRoot as the implicit default.
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const migrated = svc.getLegacyProject()!;
      migrated.legacyFlag = false;
      migrated.id = 'prd-agent';
      svc.save();

      const owner = svc.resolveProjectForAutoBuild('/srv/repos/prd_agent');
      expect(owner?.id).toBe('prd-agent');
    });

    it('falls back to the only remaining project when there is exactly one', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const legacy = svc.getLegacyProject()!;
      legacy.id = 'solo';
      legacy.legacyFlag = false;
      legacy.repoPath = '/a';
      svc.save();

      expect(svc.resolveProjectForAutoBuild('/b')?.id).toBe('solo');
    });

    it('returns undefined when the choice is ambiguous', () => {
      // Two projects, both with explicit repoPaths that do NOT match —
      // we can't reasonably pick, so the caller must refuse to create
      // an orphan.
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const legacy = svc.getLegacyProject()!;
      legacy.id = 'a';
      legacy.legacyFlag = false;
      legacy.repoPath = '/repos/a';
      const now = new Date().toISOString();
      svc.addProject({
        id: 'b',
        slug: 'b',
        name: 'b',
        kind: 'git',
        repoPath: '/repos/b',
        createdAt: now,
        updatedAt: now,
      });
      svc.save();

      expect(svc.resolveProjectForAutoBuild('/repos/c')).toBeUndefined();
    });

    it('returns undefined when two projects share the same repoPath (round-6 PR #498 review fix)', () => {
      // Step 2 used to `find()` first-match. Now mirrors step 3's
      // ambiguity rule: 2+ projects pointing at the same repoPath
      // can't be disambiguated → return undefined.
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const legacy = svc.getLegacyProject()!;
      legacy.id = 'a';
      legacy.legacyFlag = false;
      legacy.repoPath = '/repos/shared';
      const now = new Date().toISOString();
      svc.addProject({
        id: 'b',
        slug: 'b',
        name: 'b',
        kind: 'git',
        repoPath: '/repos/shared',
        createdAt: now,
        updatedAt: now,
      });
      svc.save();

      expect(svc.resolveProjectForAutoBuild('/repos/shared')).toBeUndefined();
    });

    it('returns undefined when multiple projects share the no-repoPath fallback (round-4 PR #498 review fix)', () => {
      // Both projects leave repoPath unset → step 3 of the resolver
      // used to silently return whichever the find() walked over first,
      // misattributing the auto-built branch. Must return undefined and
      // let the caller refuse rather than orphan/misattribute.
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const legacy = svc.getLegacyProject()!;
      legacy.id = 'a';
      legacy.legacyFlag = false;
      // repoPath intentionally unset on both projects.
      const now = new Date().toISOString();
      svc.addProject({
        id: 'b',
        slug: 'b',
        name: 'b',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      svc.save();

      expect(svc.resolveProjectForAutoBuild('/anything')).toBeUndefined();
    });
  });

  describe('addProject', () => {
    let svc: StateService;

    beforeEach(() => {
      svc = new StateService(stateFile, tmpDir);
      svc.load();
    });

    it('adds a new project alongside the legacy default', () => {
      const now = new Date().toISOString();
      svc.addProject({
        id: 'new-proj',
        slug: 'new-proj',
        name: 'A New Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const projects = svc.getProjects();
      expect(projects).toHaveLength(2);
      expect(svc.getProject('new-proj')?.name).toBe('A New Project');
    });

    it('rejects duplicate ids', () => {
      expect(() =>
        svc.addProject({
          id: 'default', // already exists as legacy
          slug: 'xx',
          name: 'dup',
          kind: 'git',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      ).toThrow(/already exists/);
    });

    it('rejects duplicate slugs', () => {
      const legacySlug = svc.getLegacyProject()!.slug;
      expect(() =>
        svc.addProject({
          id: 'xx',
          slug: legacySlug,
          name: 'dup',
          kind: 'git',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      ).toThrow(/already exists/);
    });
  });

  describe('removeProject', () => {
    let svc: StateService;

    beforeEach(() => {
      svc = new StateService(stateFile, tmpDir);
      svc.load();
      svc.addProject({
        id: 'second',
        slug: 'second',
        name: 'Second',
        kind: 'git',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    });

    it('removes a non-legacy project', () => {
      expect(svc.getProjects()).toHaveLength(2);
      svc.removeProject('second');
      expect(svc.getProjects()).toHaveLength(1);
    });

    it('refuses to remove the legacy project', () => {
      expect(() => svc.removeProject('default')).toThrow(/legacy default/);
    });

    it('is a no-op when the id does not exist', () => {
      svc.removeProject('no-such-id');
      expect(svc.getProjects()).toHaveLength(2);
    });
  });

  describe('updateProject', () => {
    it('patches mutable fields and bumps updatedAt', async () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const before = svc.getLegacyProject()!;

      // Force a tiny delay so updatedAt changes
      await new Promise((r) => setTimeout(r, 5));

      svc.updateProject(before.id, {
        name: 'Renamed',
        description: 'A rename',
      });

      const after = svc.getProject(before.id)!;
      expect(after.name).toBe('Renamed');
      expect(after.description).toBe('A rename');
      expect(after.updatedAt).not.toBe(before.updatedAt);
      // Immutable fields stay the same
      expect(after.id).toBe(before.id);
      expect(after.legacyFlag).toBe(before.legacyFlag);
    });

    // P4 Part 18 (G1): repoPath / cloneStatus / cloneError fields are
    // the async clone lifecycle storage. updateProject must accept them
    // so the POST /projects/:id/clone SSE endpoint can stamp progress.
    it('accepts repoPath / cloneStatus / cloneError fields', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      const p: Project = {
        id: 'proj-clone-lifecycle',
        slug: 'proj-clone-lifecycle',
        name: 'Clone Lifecycle',
        kind: 'git',
        gitRepoUrl: 'https://github.com/example/repo.git',
        legacyFlag: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        cloneStatus: 'pending',
      };
      svc.addProject(p);

      // Simulate 'cloning' → 'ready' progression
      svc.updateProject(p.id, { cloneStatus: 'cloning' });
      expect(svc.getProject(p.id)!.cloneStatus).toBe('cloning');

      svc.updateProject(p.id, {
        cloneStatus: 'ready',
        repoPath: '/repos/proj-clone-lifecycle',
      });
      const after = svc.getProject(p.id)!;
      expect(after.cloneStatus).toBe('ready');
      expect(after.repoPath).toBe('/repos/proj-clone-lifecycle');
      expect(after.cloneError).toBeUndefined();

      // Error path
      svc.updateProject(p.id, {
        cloneStatus: 'error',
        cloneError: 'fatal: repository not found',
      });
      const errAfter = svc.getProject(p.id)!;
      expect(errAfter.cloneStatus).toBe('error');
      expect(errAfter.cloneError).toBe('fatal: repository not found');
    });
  });

  // P4 Part 18 (G1): getProjectRepoRoot resolves the per-project git
  // repo root with a fallback to the global CdsConfig.repoRoot. Every
  // worktree / branch call-site uses this helper so legacy 'default'
  // projects keep working while new projects point at their own clone.
  describe('getProjectRepoRoot', () => {
    const FALLBACK = '/mnt/cds-host-repo';

    it('returns fallback when projectId is undefined', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      expect(svc.getProjectRepoRoot(undefined, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for legacy default project (no repoPath)', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      // Migration creates the 'default' project without repoPath.
      expect(svc.getProjectRepoRoot('default', FALLBACK)).toBe(FALLBACK);
    });

    it('returns project.repoPath when set', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      svc.addProject({
        id: 'proj-a',
        slug: 'proj-a',
        name: 'A',
        kind: 'git',
        legacyFlag: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        repoPath: '/repos/proj-a',
        cloneStatus: 'ready',
      });
      expect(svc.getProjectRepoRoot('proj-a', FALLBACK)).toBe('/repos/proj-a');
    });

    it('returns fallback when project exists but repoPath is empty', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      svc.addProject({
        id: 'proj-nopath',
        slug: 'proj-nopath',
        name: 'NoPath',
        kind: 'git',
        legacyFlag: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        // no repoPath — pre-clone or pre-G1 state
      });
      expect(svc.getProjectRepoRoot('proj-nopath', FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback when projectId references a nonexistent project', () => {
      const svc = new StateService(stateFile, tmpDir);
      svc.load();
      expect(svc.getProjectRepoRoot('ghost', FALLBACK)).toBe(FALLBACK);
    });
  });
});
