import { describe, expect, it } from 'vitest';
import { singleServiceArtifactSet } from '../../src/services/single-service-artifact-set.js';
import type { BuildProfile } from '../../src/types.js';
const profile = (id: string, dependencies: string[] = []): BuildProfile => ({ id, projectId: 'project', name: id,
  workDir: '.', command: '', dockerImage: 'ghcr.io/x/' + id + ':sha-' + 'a'.repeat(40), containerPort: 80,
  prebuiltImage: true, prebuiltCommitPolicy: 'exact', dependsOn: dependencies });
describe('exact single service required artifact closure', () => {
  it('includes transitive shared dependencies once and excludes unrelated services without mutating input', () => {
    const input = [profile('api', ['bridge', 'worker']), profile('bridge', ['worker', 'redis']), profile('worker'), profile('unrelated')];
    const frozen = JSON.stringify(input);
    expect(singleServiceArtifactSet(input, 'api', new Set(['redis'])).map(item => item.id)).toEqual(['worker', 'bridge', 'api']);
    expect(JSON.stringify(input)).toBe(frozen);
  });
  it('fails closed when infrastructure is not available or a declared application dependency is missing', () => {
    expect(() => singleServiceArtifactSet([profile('api', ['redis'])], 'api', new Set())).toThrow('artifact_dependency_unavailable');
    expect(() => singleServiceArtifactSet([profile('api', ['bridge']), profile('bridge', ['missing'])], 'api', new Set())).toThrow('artifact_dependency_unavailable');
  });
  it('rejects a cycle before any artifact admission', () => {
    expect(() => singleServiceArtifactSet([profile('api', ['bridge']), profile('bridge', ['api'])], 'api', new Set())).toThrow('artifact_dependency_cycle');
  });
  it.each(['foreign', 'source', 'non-exact', 'duplicate'])('rejects ambiguous dependencies: %s', variant => {
    const input = [profile('api', ['worker']), profile('worker')];
    if (variant === 'foreign') input[1].projectId = 'foreign';
    if (variant === 'source') input[1].prebuiltImage = false;
    if (variant === 'non-exact') delete input[1].prebuiltCommitPolicy;
    if (variant === 'duplicate') input.push(profile('worker'));
    expect(() => singleServiceArtifactSet(input, 'api', new Set())).toThrow(/artifact_dependency_(scope|mode|graph)/);
  });
});
