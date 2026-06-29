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
    expect(source).toContain("entry.services[pid].status = s.status as ServiceState['status'];");
  });
});
