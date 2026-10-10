import { describe, expect, it } from 'vitest';
import { parseCdsCompose, toCdsCompose } from '../../src/services/compose-parser.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import type { BranchEntry } from '../../src/types.js';
it('P1/P5 preserves exact commit policy across import/export, empty mode and express mode', () => {
  const input = `services:
  api:
    image: ghcr.io/imp/api:sha-\${CDS_COMMIT_SHA}
    ports: ["8080:8080"]
    labels:
      cds.path-prefix: "/"
      cds.prebuilt-image: "true"
      cds.prebuilt-commit-policy: "exact"
x-cds-deploy-modes:
  api:
    express:
      prebuilt: true
      commitPolicy: exact
      image: ghcr.io/imp/api:sha-\${CDS_COMMIT_SHA}
`;
  const imported = parseCdsCompose(input)!.buildProfiles[0];
  expect(imported.prebuiltCommitPolicy).toBe('exact');
  expect(imported.deployModes?.express.commitPolicy).toBe('exact');
  const branch = { id: 'b', branch: 'b', worktreePath: '/wt', status: 'running', createdAt: '', services: {}, githubCommitSha: 'a'.repeat(40), profileOverrides: { api: { activeDeployMode: 'express' } } } as BranchEntry;
  expect(resolveEffectiveProfile(imported, branch).prebuiltCommitPolicy).toBe('exact');
  const exported = toCdsCompose([imported], {}, [], []);
  expect(parseCdsCompose(exported)!.buildProfiles[0].deployModes?.express.commitPolicy).toBe('exact');
});
