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
  });
});
