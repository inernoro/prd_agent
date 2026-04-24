/**
 * Tests for the scoped customEnv store (2026-04-18).
 *
 * Covers:
 *   1) Legacy flat state.json migrates into { _global: {...} } on load
 *   2) getCustomEnv() default returns global-only (pre-feature behaviour)
 *   3) getCustomEnv(projectId) merges { ..._global, ...project } with
 *      project winning on key conflict
 *   4) setCustomEnvVar writes into the requested scope and doesn't leak
 *   5) dropCustomEnvScope clears one project without touching others
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { GLOBAL_ENV_SCOPE } from '../../src/types.js';

describe('StateService customEnv scoped store', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-env-scope-test-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates legacy flat customEnv into { _global: <flat> } on load', () => {
    // Hand-crafted pre-migration state.json with flat customEnv.
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: { GLOBAL_ONE: 'a', GLOBAL_TWO: 'b' },
        infraServices: [],
      }),
    );

    const svc = new StateService(stateFile, tmpDir);
    svc.load();

    // Default call returns the migrated _global bucket
    expect(svc.getCustomEnv()).toEqual({ GLOBAL_ONE: 'a', GLOBAL_TWO: 'b' });
    // Raw shape is nested
    const raw = svc.getCustomEnvRaw();
    expect(raw[GLOBAL_ENV_SCOPE]).toEqual({ GLOBAL_ONE: 'a', GLOBAL_TWO: 'b' });
  });

  it('already-nested state.json passes through unchanged', () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: {
          _global: { G: '1' },
          proj1: { P: '2' },
        },
        infraServices: [],
      }),
    );

    const svc = new StateService(stateFile, tmpDir);
    svc.load();

    expect(svc.getCustomEnv()).toEqual({ G: '1' });
    expect(svc.getCustomEnv('proj1')).toEqual({ G: '1', P: '2' });
    expect(svc.getCustomEnvScope('proj1')).toEqual({ P: '2' });
  });

  it('getCustomEnv(projectId) merges with project override winning', () => {
    const svc = new StateService(stateFile, tmpDir);
    svc.load();
    svc.setCustomEnv({ SHARED: 'global', ONLY_GLOBAL: 'g' }); // _global
    svc.setCustomEnv({ SHARED: 'project', ONLY_PROJECT: 'p' }, 'projA');

    expect(svc.getCustomEnv()).toEqual({ SHARED: 'global', ONLY_GLOBAL: 'g' });
    expect(svc.getCustomEnv('projA')).toEqual({
      SHARED: 'project', // project wins
      ONLY_GLOBAL: 'g',
      ONLY_PROJECT: 'p',
    });
    // A different project sees only _global
    expect(svc.getCustomEnv('projB')).toEqual({
      SHARED: 'global',
      ONLY_GLOBAL: 'g',
    });
  });

  it('setCustomEnvVar and removeCustomEnvVar honour the scope arg', () => {
    const svc = new StateService(stateFile, tmpDir);
    svc.load();
    svc.setCustomEnvVar('K', 'v1');             // _global by default
    svc.setCustomEnvVar('K', 'v2', 'projA');    // project override

    expect(svc.getCustomEnvScope(GLOBAL_ENV_SCOPE)).toEqual({ K: 'v1' });
    expect(svc.getCustomEnvScope('projA')).toEqual({ K: 'v2' });

    svc.removeCustomEnvVar('K', 'projA');
    expect(svc.getCustomEnvScope('projA')).toEqual({});
    // Global is untouched
    expect(svc.getCustomEnvScope(GLOBAL_ENV_SCOPE)).toEqual({ K: 'v1' });
  });

  it('dropCustomEnvScope removes one project bucket without touching _global', () => {
    const svc = new StateService(stateFile, tmpDir);
    svc.load();
    svc.setCustomEnvVar('GK', 'g');
    svc.setCustomEnvVar('PK', 'p', 'projA');

    svc.dropCustomEnvScope('projA');
    expect(svc.getCustomEnvScope('projA')).toEqual({});
    expect(svc.getCustomEnv()).toEqual({ GK: 'g' });
    // Refuses to drop _global (silent no-op)
    svc.dropCustomEnvScope(GLOBAL_ENV_SCOPE);
    expect(svc.getCustomEnv()).toEqual({ GK: 'g' });
  });

  it('removeProject cascade also drops the project customEnv scope', () => {
    const svc = new StateService(stateFile, tmpDir);
    svc.load();

    svc.addProject({
      id: 'projA',
      slug: 'proj-a',
      name: 'Project A',
      kind: 'git',
      dockerNetwork: 'cds-proj-a',
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    svc.setCustomEnvVar('JWT_SECRET', 'super', 'projA');
    expect(svc.getCustomEnvScope('projA')).toEqual({ JWT_SECRET: 'super' });

    svc.removeProject('projA');
    expect(svc.getCustomEnvScope('projA')).toEqual({});
  });
});
