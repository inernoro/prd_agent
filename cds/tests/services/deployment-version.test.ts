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


  it.each([undefined, { projectId: 'p1', branchId: 'b1', repoBranch: 'feat/version' }])('freezes placement presence or absence across real JSON restore %j', async expected => {
    const svc = new DeploymentVersionService(stateService);
    const p = profile({ deploymentScope: expected } as any);
    const ordinaryHash = svc.computeConfigHash([profile()], {});
    if (expected) expect(svc.computeConfigHash([p], {})).not.toBe(ordinaryHash);
    const version = svc.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'scope-' + JSON.stringify(expected), profiles: [p], branch, createdByRunId: 'scope-run' });
    if (expected) expected.repoBranch = 'mutated-after-capture';
    await stateService.flush(); const reloaded = new StateService(path.join(tmpDir, 'state.json')); reloaded.load();
    const restored = new DeploymentVersionService(reloaded).materializeProfiles(reloaded.getDeploymentVersion(version.id)!, [profile({ deploymentScope: { projectId: 'foreign', branchId: 'foreign', repoBranch: 'foreign' } } as any)])[0] as any;
    expect(restored.deploymentScope).toEqual(expected ? { projectId: 'p1', branchId: 'b1', repoBranch: 'feat/version' } : undefined);
  });

  it('computes a stable config hash without persisting environment values', () => {
    const service = new DeploymentVersionService(stateService);
    const a = service.computeConfigHash([profile()], { TOKEN: 'secret-a', PORT: '3000' });
    const b = service.computeConfigHash([profile()], { PORT: '3000', TOKEN: 'secret-a' });
    const changed = service.computeConfigHash([profile()], { PORT: '3000', TOKEN: 'secret-b' });

    expect(a).toBe(b);
    expect(changed).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('source changes affect the config identity', () => {
    const service = new DeploymentVersionService(stateService);
    const source = 'https://github.com/md-imp/mdimp'; const later = 'https://github.com/foreign/repo';
    expect(service.computeConfigHash([profile({ artifactSource: source })], {})).not.toBe(service.computeConfigHash([profile()], {}));
    expect(service.computeConfigHash([profile({ artifactSource: source })], {})).not.toBe(service.computeConfigHash([profile({ artifactSource: later })], {}));
  });
  it.each([undefined, 'https://github.com/md-imp/mdimp'])('version restore preserves declared or absent source %s', async expected => {
      const service = new DeploymentVersionService(stateService);
      const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'source-' + expected,
        profiles: [profile({ artifactSource: expected })], branch, createdByRunId: 'run' });
      await stateService.flush();
      const reloaded = new StateService(path.join(tmpDir, 'state.json')); reloaded.load();
      const restored = new DeploymentVersionService(reloaded).materializeProfiles(reloaded.getDeploymentVersion(version.id)!, [profile({ artifactSource: 'https://github.com/foreign/repo' })])[0];
      expect(restored.artifactSource).toBe(expected);
  });

  it('includes replacement role, strategy, mount and exact policy in the frozen configuration', () => {
    const service = new DeploymentVersionService(stateService);
    const baseline = service.computeConfigHash([profile()], {});
    for (const change of [{ role: 'worker' as const }, { replacementStrategy: 'stop-and-restore' as const },
      { cacheMounts: [{ hostPath: 'data', containerPath: '/data' }] }, { prebuiltCommitPolicy: 'exact' as const }]) {
      expect(service.computeConfigHash([profile(change)], {})).not.toBe(baseline);
    }
  });

  it('materializes frozen replacement constraints rather than current weaker declarations', () => {
    const service = new DeploymentVersionService(stateService);
    const original = profile({ role: 'worker', replacementStrategy: 'stop-and-restore', cacheMounts: [{ hostPath: 'data', containerPath: '/data' }] });
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'frozen',
      profiles: [original], branch, createdByRunId: 'run' });
    original.cacheMounts![0].hostPath = 'changed-after-capture';
    const restored = service.materializeProfiles(version, [profile({ role: 'api', replacementStrategy: 'parallel', cacheMounts: [] })])[0];
    expect(restored.role).toBe('worker'); expect(restored.replacementStrategy).toBe('stop-and-restore');
    expect(restored.cacheMounts).toEqual([{ hostPath: 'data', containerPath: '/data' }]);
  });

  it('freezes new-version absent constraints across reload instead of inheriting later current configuration', async () => {
    const service = new DeploymentVersionService(stateService);
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'frozen',
      profiles: [profile()], branch, createdByRunId: 'run' });
    await stateService.flush();
    const restoredState = new StateService(path.join(tmpDir, 'state.json')); restoredState.load();
    const restored = new DeploymentVersionService(restoredState).materializeProfiles(restoredState.getDeploymentVersion(version.id)!,
      [profile({ role: 'worker', replacementStrategy: 'stop-and-restore', cacheMounts: [{ hostPath: 'new', containerPath: '/new' }], prebuiltCommitPolicy: 'exact' })])[0];
    expect(restored.role).toBeUndefined(); expect(restored.replacementStrategy).toBeUndefined();
    expect(restored.cacheMounts).toEqual([]); expect(restored.prebuiltCommitPolicy).toBeUndefined();
  });

  it.each([2, '1', null])('rejects explicit unsupported replacement contract schema %s', (schema) => {
    const service = new DeploymentVersionService(stateService);
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'frozen',
      profiles: [profile()], branch, createdByRunId: 'run' });
    (version.profiles[0] as any).replacementContractVersion = schema;
    expect(() => service.materializeProfiles(version, [profile({ role: 'worker', replacementStrategy: 'stop-and-restore' })]))
      .toThrow('replacement_contract_version');
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

  it('captures the pullable artifact reference separately from the local immutable execution ID', () => {
    const service = new DeploymentVersionService(stateService);
    const ref = `ghcr.io/acme/web@sha256:${'d'.repeat(64)}`;
    branch.services.web = {
      profileId: 'web', containerName: 'cds-b1-web', hostPort: 10001, status: 'running',
      deployedImage: `sha256:${'c'.repeat(64)}`, deployedArtifactRef: ref,
      deployedPrebuilt: true, deployedCommitSha: 'a'.repeat(40),
    };
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'a'.repeat(40), configHash: 'e'.repeat(64),
      profiles: [profile({ prebuiltCommitPolicy: 'exact' })], branch, createdByRunId: 'dr_exact' });
    expect(version.profiles[0]).toMatchObject({ reusable: true, artifactImage: ref, prebuiltCommitPolicy: 'exact' });
    expect(service.materializeProfiles(version, [profile()])[0]).toMatchObject({ dockerImage: ref, prebuiltCommitPolicy: 'exact' });
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
