import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentVersionService, isImmutableImageReference } from '../../src/services/deployment-version.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

describe('DeploymentVersionService', () => {
  let tmpDir: string;
  let stateService: StateService;
  let branch: BranchEntry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deployment-version-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    branch = {
      id: 'b1',
      projectId: 'p1',
      branch: 'feat/version',
      worktreePath: '/tmp/b1',
      status: 'running',
      createdAt: '2026-07-10T00:00:00.000Z',
      services: {},
    };
    stateService.addBranch(branch);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function profile(overrides: Partial<BuildProfile> = {}): BuildProfile {
    return {
      id: 'web',
      projectId: 'p1',
      name: 'Web',
      dockerImage: 'ghcr.io/acme/web:sha-1234567',
      workDir: '.',
      command: 'node server.js',
      containerPort: 3000,
      prebuiltImage: true,
      ...overrides,
    };
  }

  it('computes a stable config hash without persisting environment values', () => {
    const service = new DeploymentVersionService(stateService);
    const a = service.computeConfigHash([profile()], { TOKEN: 'secret-a', PORT: '3000' });
    const b = service.computeConfigHash([profile()], { PORT: '3000', TOKEN: 'secret-a' });
    const changed = service.computeConfigHash([profile()], { PORT: '3000', TOKEN: 'secret-b' });

    expect(a).toBe(b);
    expect(changed).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates an immutable content-addressed version and reuses the same identity', () => {
    const service = new DeploymentVersionService(stateService, () => new Date('2026-07-10T01:00:00.000Z'));
    branch.services.web = {
      profileId: 'web',
      containerName: 'cds-b1-web',
      hostPort: 10001,
      status: 'running',
      deployedMode: 'express',
      deployedImage: 'ghcr.io/acme/web:sha-1234567',
    };
    const input = {
      projectId: 'p1',
      branchId: 'b1',
      commitSha: '1234567890abcdef',
      configHash: 'a'.repeat(64),
      profiles: [profile({ activeDeployMode: 'express' })],
      branch,
      createdByRunId: 'dr_1',
    };

    const first = service.create(input);
    const second = service.create({ ...input, createdByRunId: 'dr_2' });

    expect(first.id).toMatch(/^dv_[0-9a-f]{24}$/);
    expect(second).toBe(first);
    expect(first.profiles[0]).toMatchObject({
      artifactKind: 'prebuilt-image',
      reusable: true,
      artifactImage: 'ghcr.io/acme/web:sha-1234567',
    });
    expect(JSON.stringify(first)).not.toContain('secret');
  });

  it('finds and materializes reusable versions while refusing legacy combined commands', () => {
    const service = new DeploymentVersionService(stateService);
    branch.services.web = {
      profileId: 'web', containerName: 'cds-b1-web', hostPort: 10001, status: 'running',
      deployedImage: 'ghcr.io/acme/web:sha-1234567',
    };
    const reusable = service.create({
      projectId: 'p1', branchId: 'b1', commitSha: 'abc1234', configHash: 'b'.repeat(64),
      profiles: [profile()], branch, createdByRunId: 'dr_1',
    });

    expect(service.findReusable({ projectId: 'p1', branchId: 'b1', commitSha: 'abc1234', configHash: 'b'.repeat(64) })?.id)
      .toBe(reusable.id);
    expect(service.materializeProfiles(reusable, [profile()])[0]).toMatchObject({
      dockerImage: 'ghcr.io/acme/web:sha-1234567',
      prebuiltImage: true,
      fallbackImage: undefined,
    });

    branch.services.web.deployedImage = 'node:22';
    const legacy = service.create({
      projectId: 'p1', branchId: 'b1', commitSha: 'def5678', configHash: 'c'.repeat(64),
      profiles: [profile({ dockerImage: 'node:22', prebuiltImage: false, command: 'pnpm install && pnpm dev' })],
      branch, createdByRunId: 'dr_2',
    });
    expect(legacy.profiles[0].reusable).toBe(false);
    expect(() => service.materializeProfiles(legacy, [profile()])).toThrow(/legacy compose\/source/);
  });

  it('recognizes only digest and sha-tag image references as immutable', () => {
    expect(isImmutableImageReference(`repo/web@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isImmutableImageReference('repo/web:sha-abcdef1')).toBe(true);
    expect(isImmutableImageReference('repo/web:branch-main')).toBe(false);
    expect(isImmutableImageReference('repo/web:latest')).toBe(false);
  });

  it('survives a state service restart with the same immutable snapshot', async () => {
    const service = new DeploymentVersionService(stateService);
    branch.services.web = {
      profileId: 'web', containerName: 'cds-b1-web', hostPort: 10001, status: 'running',
      deployedImage: 'ghcr.io/acme/web:sha-1234567',
    };
    const version = service.create({
      projectId: 'p1', branchId: 'b1', commitSha: 'abc1234', configHash: 'd'.repeat(64),
      profiles: [profile()], branch, createdByRunId: 'dr_1',
    });
    await stateService.flush();

    const reloadedState = new StateService(path.join(tmpDir, 'state.json'));
    reloadedState.load();
    expect(reloadedState.getDeploymentVersion(version.id)).toEqual(version);
  });
});
