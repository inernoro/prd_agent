import { describe, it, expect } from 'vitest';
import { assertProfileStorageBoundary, assertInfraStorageBoundary } from '../../src/services/deployment-storage-boundary.js';
import type { BuildProfile, InfraService } from '../../src/types.js';

const profile = (updates: Partial<BuildProfile> = {}): BuildProfile => ({ id: 'app', projectId: 'p', name: 'App',
  workDir: '.', dockerImage: 'app:fixed', command: '', containerPort: 8080, prebuiltImage: true, ...updates });
const worktree = '/wt/p/branch';

describe('explicit unsafe deployment storage plans', () => {
  it.each(['/wt/p/.deployment-sources/branch/uuid/data', '/wt/p', '/wt', '/',
    '/outside/.deployment-sources/branch/uuid', '/wt/p/cache/../.deployment-sources'])('rejects writable cache source or ancestor %s', hostPath => {
    expect(() => assertProfileStorageBoundary(profile({ cacheMounts: [{ kind: 'bind', hostPath, containerPath: '/cache' }] }), worktree))
      .toThrow(/unsafe_deployment_storage/);
  });

  it('recognizes the source namespace when the entry already points to a UUID checkout', () => {
    expect(() => assertProfileStorageBoundary(profile({ cacheMounts: [{ hostPath: '/wt/p/.deployment-sources', containerPath: '/cache' }] }),
      '/wt/p/.deployment-sources/branch/uuid')).toThrow(/unsafe_deployment_storage/);
  });

  it.each(['.cds-data/mysql', 'dir/../.cds-run-data/objectstore'])('rejects default writable source data directory %s', workDir => {
    expect(() => assertProfileStorageBoundary(profile({ prebuiltImage: false, workDir }), worktree)).toThrow(/unsafe_deployment_storage/);
  });

  it.each(['/var/lib/mysql', '/data', '/data/db', '/var/lib/postgresql/data/sub'])('rejects source mount at catalog persistent target %s', containerWorkDir => {
    expect(() => assertProfileStorageBoundary(profile({ prebuiltImage: false, containerWorkDir }), worktree)).toThrow(/unsafe_deployment_storage/);
  });

  it('does not trust a volume flag whose value Docker interprets as a bind', () => {
    expect(() => assertProfileStorageBoundary(profile({ cacheMounts: [{ kind: 'volume', hostPath: '/wt/p/.deployment-sources/b/u', containerPath: '/data' }] }), worktree))
      .toThrow(/unsafe_deployment_storage/);
  });

  it('preserves stable external binds, named volumes and ordinary source behavior without claiming all RW source safe', () => {
    for (const p of [profile({ cacheMounts: [{ kind: 'bind', hostPath: '/cache/p', containerPath: '/data', readOnly: true }] }),
      profile({ prebuiltImage: false, workDir: 'app', containerWorkDir: '/app' }),
      profile({ workDir: '.cds-data', containerWorkDir: '/data' }),
      profile({ cacheMounts: [{ kind: 'bind', hostPath: '/wt/p/.deployment-sources-old', containerPath: '/cache', readOnly: true }] })]) {
      const before = JSON.stringify(p);
      expect(() => assertProfileStorageBoundary(p, worktree)).not.toThrow();
      expect(JSON.stringify(p)).toBe(before);
    }
  });

  it.each([false, true])('infra rejects RW source namespace but preserves explicit readonly bind: %s', readOnly => {
    const service: Pick<InfraService, 'id' | 'projectId' | 'volumes'> = { id: 'db', projectId: 'p', volumes: [
      { type: 'bind', name: '/wt/p/.deployment-sources/b/u/data', containerPath: '/var/lib/mysql', readOnly },
    ] };
    const check = () => assertInfraStorageBoundary(service, { repoRoot: '/repo', worktreeBase: '/wt' });
    if (readOnly) expect(check).not.toThrow(); else expect(check).toThrow(/unsafe_deployment_storage/);
  });

  it('preserves legacy external infra mappings byte-for-byte without creating or migrating a volume', () => {
    const service: Pick<InfraService, 'id' | 'projectId' | 'volumes'> = { id: 'db', projectId: 'p', volumes: [
      { type: 'bind', name: '.cds-data/mysql', containerPath: '/var/lib/mysql' },
      { type: 'volume', name: 'original-project-data', containerPath: '/data' },
    ] };
    const before = JSON.stringify(service);
    expect(() => assertInfraStorageBoundary(service, { repoRoot: '/repo', worktreeBase: '/wt' })).toThrow('storage-contract-required');
    expect(JSON.stringify(service)).toBe(before);
  });
});

it.each(['bind', 'volume'] as const)('future writable %s requires a declared purpose and owner before any mutation', kind => {
  expect(() => assertProfileStorageBoundary(profile({cacheMounts: [{kind, hostPath: kind === 'bind' ? '/stable/data' : 'stable-data', containerPath: '/data'}]}), worktree)).toThrow(/storage-contract-required/);
});
