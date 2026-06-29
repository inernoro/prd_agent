import { describe, expect, it } from 'vitest';
import { mergeBranchProfiles, isValidExtraProfileId } from '../../src/services/branch-extra-services.js';
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

describe('isValidExtraProfileId', () => {
  it('accepts normal ids', () => {
    for (const id of ['llmgw-serve', 'api', 'svc_1', 'A1', 'x']) expect(isValidExtraProfileId(id)).toBe(true);
  });
  it('rejects bad ids', () => {
    for (const id of ['', '-bad', '_bad', 'has space', 'a'.repeat(64), 'emoji😀']) {
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
