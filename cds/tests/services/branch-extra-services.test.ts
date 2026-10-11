import { describe, expect, it } from 'vitest';
import { mergeBranchProfiles, isValidExtraProfileId, parseExtraDeploymentMetadata, assertProfileDeploymentScopes, copyBranchDeploymentConfig } from '../../src/services/branch-extra-services.js';
import type { BuildProfile, BranchEntry } from '../../src/types.js';

const p = (id: string, extra: Partial<BuildProfile> = {}): BuildProfile => ({
  id,
  name: id,
  dockerImage: `img-${id}`,
  workDir: id,
  command: 'run',
  containerPort: 8080,
  ...extra,
});

const branch = (extraProfiles?: BuildProfile[]): Pick<BranchEntry, 'extraProfiles'> => ({ extraProfiles });

describe('bounded extra deployment metadata', () => {
  it('legacy inputs remain empty and explicit metadata does not import runtime-owned qualifications', () => {
    expect(parseExtraDeploymentMetadata({ preparedArtifactId: 'forged', localArtifact: true })).toEqual({});
    expect(parseExtraDeploymentMetadata({})).toEqual({});
  });
  it('rejects oversized, malformed or unsafe scope/call projections rather than coercing them', () => {
    for (const raw of [{ buildScope: Array(129).fill('src/**') }, { buildScope: ['x'.repeat(257)] },
      { buildScope: [null] }, { buildScope: ['/absolute'] }, { buildScope: ['src/../outside'] },
      { buildScope: ['src/$(cmd)'] }, { calls: ['x'.repeat(64)] }, { calls: Array(129).fill('api') }, { calls: {} }]) {
      expect(() => parseExtraDeploymentMetadata(raw)).toThrow('extra_deployment_metadata_invalid');
    }
    expect(parseExtraDeploymentMetadata({ buildScope: ['src/**', '*.mjs'], calls: [] })).toEqual({ buildScope: ['src/**', '*.mjs'], calls: [] });
  });
  it('validates mode templates, port, count and unknown qualifications', () => {
    const mode = { label: '极速版', prebuilt: true, commitPolicy: 'exact', dockerImage: 'ghcr.io/o/r:sha-${CDS_COMMIT_SHA}' };
    expect(parseExtraDeploymentMetadata({ deployModes: { express: mode }, activeDeployMode: 'express' }).deployModes!.express.dockerImage).toBe(mode.dockerImage);
    for (const delta of [{ dockerImage: 'ghcr.io/o/r:${OTHER}' }, { containerPort: 0 }, { containerPort: '80' },
      { prebuilt: false }, { commitPolicy: 'fallback' }, { sourceFallbackProfile: {} }, { label: 'x'.repeat(129) }]) {
      expect(() => parseExtraDeploymentMetadata({ deployModes: { express: { ...mode, ...delta } } })).toThrow();
    }
    expect(() => parseExtraDeploymentMetadata({ deployModes: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`m${index}`, mode])) })).toThrow();
    expect(() => parseExtraDeploymentMetadata({ deployModes: JSON.parse('{"__proto__":{"label":"x","prebuilt":true,"commitPolicy":"exact"}}') })).toThrow();
  });
  it('clears declared metadata explicitly without making omission a downgrade', () => {
    const previous = p('api', { prebuiltImage: true, prebuiltCommitPolicy: 'exact', calls: ['other'] });
    expect(parseExtraDeploymentMetadata({}, previous)).toEqual({ prebuiltImage: true, prebuiltCommitPolicy: 'exact', calls: ['other'] });
    expect(parseExtraDeploymentMetadata({ prebuiltImage: false, prebuiltCommitPolicy: null, calls: null }, previous)).toEqual({ prebuiltImage: false });
  });
});

describe('isValidExtraProfileId', () => {
  it('accepts normal ids', () => {
    for (const id of ['llmgw-serve', 'api', 'svc_1', 'A1', 'x']) expect(isValidExtraProfileId(id)).toBe(true);
  });
  it('rejects bad ids', () => {
    for (const id of ['', '-bad', '_bad', 'has space', 'a'.repeat(64), 'bad@id', 'has/slash']) {
      expect(isValidExtraProfileId(id)).toBe(false);
    }
  });
});

describe('mergeBranchProfiles', () => {
  const project = [p('api'), p('admin')];

  it('no extras (absent) → project profiles unchanged (legacy zero-regression)', () => {
    expect(mergeBranchProfiles(project, undefined)).toBe(project);
    expect(mergeBranchProfiles(project, branch())).toBe(project);
    expect(mergeBranchProfiles(project, branch([]))).toBe(project);
  });

  it('adds a branch-local extra service after the project baseline', () => {
    const merged = mergeBranchProfiles(project, branch([p('llmgw-serve')]));
    expect(merged.map((x) => x.id)).toEqual(['api', 'admin', 'llmgw-serve']);
    // does not mutate the input project list
    expect(project.map((x) => x.id)).toEqual(['api', 'admin']);
  });

  it('an extra id colliding with a project profile is ignored (project baseline wins)', () => {
    const merged = mergeBranchProfiles(project, branch([p('api', { dockerImage: 'hijack' }), p('extra')]));
    expect(merged.map((x) => x.id)).toEqual(['api', 'admin', 'extra']);
    // the colliding 'api' kept the project image, not the branch's
    expect(merged.find((x) => x.id === 'api')!.dockerImage).toBe('img-api');
  });

  it('dedupes repeated extra ids (keeps first)', () => {
    const merged = mergeBranchProfiles(project, branch([p('extra', { dockerImage: 'first' }), p('extra', { dockerImage: 'second' })]));
    expect(merged.filter((x) => x.id === 'extra')).toHaveLength(1);
    expect(merged.find((x) => x.id === 'extra')!.dockerImage).toBe('first');
  });

  it('skips invalid-id extras', () => {
    const merged = mergeBranchProfiles(project, branch([p('-bad'), p('good')]));
    expect(merged.map((x) => x.id)).toEqual(['api', 'admin', 'good']);
  });

  it('two branches with the same extra service id do not interfere (pure per-branch)', () => {
    const a = mergeBranchProfiles(project, branch([p('dbg')]));
    const b = mergeBranchProfiles(project, branch([])); // sibling without extras
    expect(a.map((x) => x.id)).toEqual(['api', 'admin', 'dbg']);
    expect(b.map((x) => x.id)).toEqual(['api', 'admin']); // sibling unaffected
  });
});

describe('declarative placement controls', () => {
  const scope = { projectId: 'default', branchId: 'main', repoBranch: 'main' };
  it('matches the logical owner only, preserves omission, permits explicit null, and keeps malformed input bounded', () => {
    const profile = p('rpc', { deploymentScope: scope });
    expect(parseExtraDeploymentMetadata({}, profile).deploymentScope).toEqual(scope);
    expect(parseExtraDeploymentMetadata({ deploymentScope: null }, profile).deploymentScope).toBeUndefined();
    expect(() => assertProfileDeploymentScopes([profile], { id: 'main', branch: 'main' })).not.toThrow();
    for (const bad of [null, [], {}, { ...scope, alias: 'main' }, { ...scope, branchId: 'x'.repeat(129) }, { ...scope, projectId: 'bad/' }, { ...scope, repoBranch: 'main\n' }, { ...scope, repoBranch: 1 }]) {
      if (bad !== null) expect(() => parseExtraDeploymentMetadata({ deploymentScope: bad })).toThrow('extra_deployment_metadata_invalid');
      expect(() => assertProfileDeploymentScopes([p('rpc', { deploymentScope: bad as any })], { id: 'main', branch: 'main' })).toThrow('deployment_scope_mismatch');
    }
    for (const target of [{ id: 'same-name', branch: 'main' }, { id: 'main', projectId: 'other', branch: 'main' }, { id: 'main', branch: 'feature' }]) {
      expect(() => assertProfileDeploymentScopes([profile], target)).toThrow('deployment_scope_mismatch');
    }
  });
  it('never removes the stable project override when a rejected extra collides with its id', () => {
    const source = { extraProfiles: [p('api', { deploymentScope: scope })], profileOverrides: { api: { env: { KEY: 'stable' } } } } as any;
    const copied = copyBranchDeploymentConfig(source, { id: 'feature', branch: 'feature' }, new Set(['api']));
    expect(copied.extraProfiles).toEqual([]); expect(copied.profileOverrides?.api.env?.KEY).toBe('stable');
    expect(source.extraProfiles).toHaveLength(1);
  });
  it('keeps a misplaced live declaration in the effective service denominator', () => {
    const rpc = p('rpc', { deploymentScope: scope });
    expect(mergeBranchProfiles([p('api')], branch([rpc])).map(profile => profile.id)).toEqual(['api', 'rpc']);
  });
});
