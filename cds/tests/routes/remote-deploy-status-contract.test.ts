import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the master→executor proxy `complete` handler (Bugbot Medium
 * "Remote complete leaves branch building"). The handler is driven by a live SSE stream from a
 * remote executor, so it is exercised behaviorally only on real clusters; this guards the
 * regression at the source level (matching the repo's other *-contract source-assertion tests):
 * after pruning entry.services to the executor's authoritative svcMap, the branch status MUST be
 * realigned (empty → idle, some running → running, else error) instead of staying at the
 * dispatch-time `building`.
 */
const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/routes/branches.ts'),
  'utf8',
);

describe('remote deploy complete: branch status realign contract', () => {
  it('realigns entry.status from the executor svcMap after the prune (no stuck building)', () => {
    expect(source).toContain('const remoteSvcStatuses = Object.values(svcMap).map((s) => s?.status);');
    // empty desired set → idle (the empty-clear case), some running → running, else error.
    expect(source).toContain("remoteSvcStatuses.length === 0");
    expect(source).toContain("remoteSvcStatuses.some((s) => s === 'running') ? 'running' : 'error'");
  });

  it('syncs surviving services’ status from the authoritative svcMap', () => {
    expect(source).toContain("existing.status = s.status as ServiceState['status'];");
  });

  it('syncs surviving services’ hostPort / containerName from the authoritative svcMap (no stale port)', () => {
    // Bugbot "Remote complete skips hostPort sync": existing rows must also adopt the executor's
    // authoritative containerName/hostPort, else preview/routing use the master's stale port until heartbeat.
    expect(source).toContain('existing.containerName = s.containerName;');
    expect(source).toContain('existing.hostPort = s.hostPort;');
  });

  it('upserts executor-only services (full reconcile, not just prune) so the map is complete on complete', () => {
    // Bugbot "Remote complete skips service upsert": services that exist only on the executor must be
    // copied into entry.services, not left for the next heartbeat.
    expect(source).toContain('const existing = entry.services[pid];');
    expect(source).toContain('typeof s.containerName === \'string\' && s.containerName');
    expect(source).toContain('entry.services[pid] = {');
  });
});
