/**
 * Tests for P4 Part 3a — projectId scoping on BranchEntry / BuildProfile
 * / InfraService / RoutingRule.
 *
 * Part 3a is additive: it introduces an optional projectId field, a
 * migration that stamps pre-P4 entries with 'default', and read-only
 * getXxxForProject helpers. Part 3b (next) threads the scope through
 * the HTTP layer.
 *
 * What these tests pin down:
 *   1. migration: a pre-P4 state.json (entries without projectId) is
 *      updated so every branch/profile/infra/rule carries 'default'
 *   2. invariance: new entries added via addBranch/addBuildProfile/etc
 *      without an explicit projectId end up on 'default'
 *   3. helpers: getXxxForProject returns only entries scoped to that
 *      projectId; unknown project ids return an empty array
 *   4. migration is idempotent — running it twice doesn't double-stamp
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, BuildProfile, InfraService, RoutingRule } from '../../src/types.js';

function writeRawState(filePath: string, state: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');
}

/** Build a BranchEntry shape that passes TypeScript but without projectId. */
function makeBranch(id: string, overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id,
    branch: id,
    worktreePath: '/tmp/' + id,
    services: {},
    status: 'idle',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as BranchEntry;
}

function makeProfile(id: string, overrides: Partial<BuildProfile> = {}): BuildProfile {
  return {
    id,
    name: id,
    dockerImage: 'node:22',
    workDir: '/app',
    containerPort: 3000,
    hostPortPreference: 0,
    buildCommand: 'echo build',
    ...overrides,
  } as BuildProfile;
}

function makeInfra(id: string, overrides: Partial<InfraService> = {}): InfraService {
  return {
    id,
    name: id,
    dockerImage: 'redis:7',
    containerPort: 6379,
    hostPort: 6379,
    status: 'stopped',
    ...overrides,
  } as InfraService;
}

function makeRule(id: string, overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id,
    name: id,
    type: 'header',
    value: 'X-Branch',
    targetBranchId: 'main',
    priority: 100,
    enabled: true,
    ...overrides,
  } as RoutingRule;
}

describe('StateService — project scoping (P4 Part 3a)', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-state-scoping-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('migrateProjectScoping on load', () => {
    it('stamps legacy projectId on all pre-P4 entries', () => {
      // Simulate a pre-P4 state.json — has branches/profiles/etc but
      // none of them carry projectId.
      writeRawState(stateFile, {
        routingRules: [makeRule('r1'), makeRule('r2')],
        buildProfiles: [makeProfile('web'), makeProfile('api')],
        branches: {
          'b1': makeBranch('b1'),
          'b2': makeBranch('b2'),
        },
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [makeInfra('redis'), makeInfra('mongo')],
      });

      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      // Every entry now carries projectId='default'
      const branches = Object.values(svc.getState().branches);
      expect(branches.every((b) => b.projectId === 'default')).toBe(true);
      expect(svc.getState().buildProfiles.every((p) => p.projectId === 'default')).toBe(true);
      expect(svc.getState().infraServices.every((i) => i.projectId === 'default')).toBe(true);
      expect(svc.getState().routingRules.every((r) => r.projectId === 'default')).toBe(true);
    });

    it('leaves entries alone when they already carry a non-legacy projectId', () => {
      writeRawState(stateFile, {
        routingRules: [],
        buildProfiles: [makeProfile('web', { projectId: 'custom-1' } as any)],
        branches: {
          'b1': makeBranch('b1', { projectId: 'custom-1' } as any),
        },
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [],
      });

      const svc = new StateService(stateFile, tmpDir);
      svc.load();

      const branches = Object.values(svc.getState().branches);
      expect(branches[0].projectId).toBe('custom-1');
      expect(svc.getState().buildProfiles[0].projectId).toBe('custom-1');
    });

    it('is idempotent across reloads', () => {
      writeRawState(stateFile, {
        routingRules: [],
        buildProfiles: [],
        branches: { b1: makeBranch('b1') },
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {},
        infraServices: [],
      });

      const svc1 = new StateService(stateFile, tmpDir);
      svc1.load();
      const firstBranch = svc1.getState().branches.b1;

      // Second load should find projectId already set and not re-save.
      const svc2 = new StateService(stateFile, tmpDir);
      svc2.load();
      const secondBranch = svc2.getState().branches.b1;
      expect(secondBranch.projectId).toBe('default');
      expect(secondBranch.projectId).toBe(firstBranch.projectId);
    });
  });

  describe('default projectId stamping on add*', () => {
    let svc: StateService;

    beforeEach(() => {
      svc = new StateService(stateFile, tmpDir);
      svc.load();
    });

    it('addBranch stamps default when projectId is omitted', () => {
      svc.addBranch(makeBranch('new1'));
      expect(svc.getBranch('new1')?.projectId).toBe('default');
    });

    it('addBranch preserves an explicit projectId', () => {
      svc.addBranch(makeBranch('new2', { projectId: 'my-proj' } as any));
      expect(svc.getBranch('new2')?.projectId).toBe('my-proj');
    });

    it('addBuildProfile stamps default when projectId is omitted', () => {
      svc.addBuildProfile(makeProfile('prof1'));
      expect(svc.getBuildProfile('prof1')?.projectId).toBe('default');
    });

    it('addInfraService stamps default when projectId is omitted', () => {
      svc.addInfraService(makeInfra('infra1'));
      const entry = svc.getInfraServices().find((s) => s.id === 'infra1');
      expect(entry?.projectId).toBe('default');
    });

    it('addRoutingRule stamps default when projectId is omitted', () => {
      svc.addRoutingRule(makeRule('rule1'));
      const rule = svc.getRoutingRules().find((r) => r.id === 'rule1');
      expect(rule?.projectId).toBe('default');
    });
  });

  describe('getXxxForProject helpers', () => {
    let svc: StateService;

    beforeEach(() => {
      svc = new StateService(stateFile, tmpDir);
      svc.load();

      // Seed a mixture: one legacy entry, one custom-proj entry
      svc.addBranch(makeBranch('legacy-branch'));
      svc.addBranch(makeBranch('alt-branch', { projectId: 'alt' } as any));

      svc.addBuildProfile(makeProfile('legacy-profile'));
      svc.addBuildProfile(makeProfile('alt-profile', { projectId: 'alt' } as any));

      svc.addInfraService(makeInfra('legacy-infra'));
      svc.addInfraService(makeInfra('alt-infra', { projectId: 'alt' } as any));

      svc.addRoutingRule(makeRule('legacy-rule'));
      svc.addRoutingRule(makeRule('alt-rule', { projectId: 'alt' } as any));
    });

    it('getBranchesForProject filters correctly', () => {
      expect(svc.getBranchesForProject('default').map((b) => b.id)).toEqual(['legacy-branch']);
      expect(svc.getBranchesForProject('alt').map((b) => b.id)).toEqual(['alt-branch']);
      expect(svc.getBranchesForProject('no-such-proj')).toEqual([]);
    });

    it('getBuildProfilesForProject filters correctly', () => {
      expect(svc.getBuildProfilesForProject('default').map((p) => p.id)).toEqual(['legacy-profile']);
      expect(svc.getBuildProfilesForProject('alt').map((p) => p.id)).toEqual(['alt-profile']);
    });

    it('getInfraServicesForProject filters correctly', () => {
      expect(svc.getInfraServicesForProject('default').map((i) => i.id)).toEqual(['legacy-infra']);
      expect(svc.getInfraServicesForProject('alt').map((i) => i.id)).toEqual(['alt-infra']);
    });

    it('getCdsEnvVars only exposes running infra for the requested project', () => {
      svc.updateInfraService('legacy-infra', { status: 'running', hostPort: 37017 }, 'default');
      svc.updateInfraService('alt-infra', { status: 'running', hostPort: 47017 }, 'alt');

      expect(svc.getCdsEnvVars('default')).toMatchObject({
        CDS_LEGACY_INFRA_PORT: '37017',
        CDS_LEGACY_INFRA_HOST: '172.17.0.1',
      });
      expect(svc.getCdsEnvVars('default')).not.toHaveProperty('CDS_ALT_INFRA_PORT');

      expect(svc.getCdsEnvVars('alt')).toMatchObject({
        CDS_ALT_INFRA_PORT: '47017',
        CDS_ALT_INFRA_HOST: '172.17.0.1',
      });
      expect(svc.getCdsEnvVars('alt')).not.toHaveProperty('CDS_LEGACY_INFRA_PORT');
    });

    it('getRoutingRulesForProject filters correctly', () => {
      expect(svc.getRoutingRulesForProject('default').map((r) => r.id)).toEqual(['legacy-rule']);
      expect(svc.getRoutingRulesForProject('alt').map((r) => r.id)).toEqual(['alt-rule']);
    });

    it('treats a missing projectId on a handcrafted entry as "default"', () => {
      // Directly poke state so the helper can exercise the defensive
      // `|| 'default'` fallback in case someone bypasses add*() helpers.
      svc.getState().buildProfiles.push({
        ...makeProfile('legacy-manual'),
        // no projectId
      });
      // Delete the auto-stamped one so the fallback path triggers.
      const last = svc.getState().buildProfiles[svc.getState().buildProfiles.length - 1];
      delete (last as any).projectId;

      const defaults = svc.getBuildProfilesForProject('default').map((p) => p.id);
      expect(defaults).toContain('legacy-manual');
    });
  });
});
