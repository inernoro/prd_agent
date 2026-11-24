import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentVersionService, isImmutableImageReference } from '../../src/services/deployment-version.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
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

  it('同提交产物复用保留分支独立库和运行配置，版本仍只保存固定产物', () => {
    const service = new DeploymentVersionService(stateService);
    const baseline = profile({ env: { DATABASE_NAME: 'shared', TOKEN: '${TOKEN}' },
      deployModes: { express: { label: '极速版', prebuilt: true, env: { RUNTIME: 'production' } } } });
    branch.profileOverrides = { web: { activeDeployMode: 'express',
      env: { DATABASE_NAME: 'owned-isolated', TOKEN: 'owned-runtime-secret' } } };
    const effective = resolveEffectiveProfile(baseline, branch);
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: '1234567',
      configHash: service.computeConfigHash([effective], {}), profiles: [effective], branch, createdByRunId: 'owned-run' });
    const materialized = service.materializeProfiles(version, [baseline], branch)[0];
    expect(materialized.env).toEqual({ DATABASE_NAME: 'owned-isolated', TOKEN: 'owned-runtime-secret', RUNTIME: 'production' });
    expect(materialized.dockerImage).toBe(version.profiles[0].artifactImage);
    expect(materialized.deployModes).toBeUndefined();
    expect(JSON.stringify(version)).not.toContain('owned-runtime-secret');
    expect(baseline.env?.DATABASE_NAME).toBe('shared');
  });

  it.each([
    { buildTimeout: 30 }, { buildScope: ['src'] }, { cacheMounts: [{ hostPath: '/tmp/pnpm-cache', containerPath: '/cache' }] },
    { fallbackImage: 'node:22' }, { localArtifact: true }, { dbScope: 'per-branch' as const }, { dbInit: 'clone' as const },
    { sourceFallbackProfile: { ...profile(), command: 'node fallback.js' } },
  ])('构建、回退或数据库配置改变不得并入同提交旧目标: %j', (changed) => {
    const service = new DeploymentVersionService(stateService);
    expect(service.computeConfigHash([{ ...profile(), ...changed }], {})).not.toBe(service.computeConfigHash([profile()], {}));
  });

  it('静态模式配置进入版本快照，冷重载与物化保持准确配置且没有共享可变引用', async () => {
    const service = new DeploymentVersionService(stateService);
    const baseline = profile({ deployModes: { 'static-files': { label: '静态文件', prebuilt: true,
      staticWeb: { imagePath: '/usr/share/nginx/html', basePath: '/site', proxyRules: [{ pathPrefix: '/api', profileId: 'api' }] } } } });
    branch.profileOverrides = { web: { activeDeployMode: 'static-files' } };
    const effective = resolveEffectiveProfile(baseline, branch);
    const expected = structuredClone(effective.staticWeb);
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: '1234567', configHash: 'h',
      profiles: [effective], branch, createdByRunId: 'run-static' });
    expect(version.profiles[0]).toMatchObject({ staticWeb: expected });
    effective.staticWeb!.basePath = '/changed';
    await stateService.flush();
    const reloaded = new StateService(path.join(tmpDir, 'state.json')); reloaded.load();
    const stored = reloaded.getDeploymentVersion(version.id)!;
    const materialized = new DeploymentVersionService(reloaded).materializeProfiles(stored, [baseline], branch)[0];
    expect(materialized.staticWeb).toEqual(expected);
    expect(materialized.deployModes).toBeUndefined();
    materialized.staticWeb!.proxyRules![0].profileId = 'different';
    expect(stored.profiles[0]).toMatchObject({ staticWeb: expected });
  });

  it('普通容器旧版本物化不得继承当前静态声明', () => {
    const service = new DeploymentVersionService(stateService);
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: '1234567', configHash: 'h',
      profiles: [profile()], branch, createdByRunId: 'run-container' });
    expect(service.materializeProfiles(version, [profile({ staticWeb: { imagePath: '/new-site' } })], branch)[0].staticWeb).toBeUndefined();
  });

  it('静态运行配置改变参与目标身份，普通容器既有配置hash保持', () => {
    const service = new DeploymentVersionService(stateService);
    expect(service.computeConfigHash([profile()], {})).toBe('5aea919abf431f140cfecc70837ddd8d99fcba7d06b7a9889d09d2bb449f3583');
    const a = profile({ staticWeb: { imagePath: '/site-a' } });
    const b = profile({ staticWeb: { imagePath: '/site-b' } });
    expect(service.computeConfigHash([a], {})).not.toBe(service.computeConfigHash([b], {}));
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
    expect(service.materializeProfiles(reusable, [profile()], branch)[0]).toMatchObject({
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
    expect(() => service.materializeProfiles(legacy, [profile()], branch)).toThrow(/legacy compose\/source/);
  });

  it('recognizes only digest and sha-tag image references as immutable', () => {
    expect(isImmutableImageReference(`repo/web@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isImmutableImageReference('repo/web:sha-abcdef1')).toBe(true);
    expect(isImmutableImageReference('repo/web:branch-main')).toBe(false);
    expect(isImmutableImageReference('repo/web:latest')).toBe(false);
  });

  it('版本重放冻结原完整buildScope，旧版本缺范围不能借当前配置补证明', () => {
    const service = new DeploymentVersionService(stateService);
    const original = profile({ buildScope: ['src/**', 'Dockerfile'] });
    const version = service.create({ projectId: 'p1', branchId: 'b1', commitSha: 'b'.repeat(40), configHash: 'd'.repeat(64),
      profiles: [original], branch, createdByRunId: 'owned-scope-proof' });
    original.buildScope!.push('not-part-of-frozen-input');
    expect(service.materializeProfiles(version, [profile({ buildScope: ['src/one-file'] })], branch)[0].buildScope).toEqual(['src/**', 'Dockerfile']);
    const historical = structuredClone(version); delete historical.profiles[0].buildScope;
    expect(service.materializeProfiles(historical, [profile({ buildScope: ['src/one-file'] })], branch)[0].buildScope).toBeUndefined();
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
