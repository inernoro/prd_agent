import { describe, expect, it } from 'vitest';
import { parseCdsCompose, toCdsCompose } from '../../src/services/compose-parser.js';
import { resolveCandidateReplacement } from '../../src/services/candidate-replacement-policy.js';
import type { BuildProfile } from '../../src/types.js';
const profile = (overrides: Partial<BuildProfile> = {}) => ({ id: 'api', role: 'api', prebuiltImage: true,
  prebuiltCommitPolicy: 'exact', preparedCommitSha: 'a'.repeat(40), preparedArtifactId: 'sha256:' + 'b'.repeat(64),
  cacheMounts: [], ...overrides } as BuildProfile);
describe('P3 candidate replacement constraints', () => {
  it('defaults workers, inferred workers and writable mounts to stop-and-restore', () => {
    for (const p of [profile({ role: 'worker' }), profile({ id: 'job-worker', role: undefined }), profile({ cacheMounts: [{ hostPath: 'data', containerPath: '/data' }] })]) {
      expect(resolveCandidateReplacement(p, []).strategy).toBe('stop-and-restore');
      expect(() => resolveCandidateReplacement({ ...p, replacementStrategy: 'parallel' }, [])).toThrow('replacement_constraint');
    }
    expect(resolveCandidateReplacement(profile(), ['/data']).strategy).toBe('stop-and-restore');
    expect(() => resolveCandidateReplacement(profile({ replacementStrategy: 'parallel' }), ['/data'])).toThrow('replacement_constraint');
  });
  it('only allows parallel prebuilt stateless candidates and honors an explicit fixed-resource stop constraint', () => {
    expect(resolveCandidateReplacement(profile(), []).strategy).toBe('parallel');
    expect(resolveCandidateReplacement(profile({ replacementStrategy: 'stop-and-restore' }), []).strategy).toBe('stop-and-restore');
    for (const invalid of [profile({ prebuiltImage: false }), profile({ prebuiltCommitPolicy: undefined }),
      profile({ preparedCommitSha: 'short' }), profile({ preparedArtifactId: undefined })]) {
      expect(() => resolveCandidateReplacement(invalid, [])).toThrow('replacement_artifact');
    }
  });
  it('round-trips the explicit compose strategy and rejects an unknown strategy', () => {
    const compose = (strategy: string) => `services:\n  api:\n    image: app\n    ports: ["8080"]\n    volumes: [".:/app"]\n    labels:\n      cds.replacement-strategy: "${strategy}"\n`;
    const parsed = parseCdsCompose(compose('stop-and-restore'))!;
    expect(parsed.buildProfiles[0].replacementStrategy).toBe('stop-and-restore');
    const roundTrip = parseCdsCompose(toCdsCompose(parsed.buildProfiles, {}, [], parsed.routingRules))!;
    expect(roundTrip.buildProfiles[0].replacementStrategy).toBe('stop-and-restore');
    expect(() => parseCdsCompose(compose('unknown'))).toThrow('replacement_strategy');
  });
});
