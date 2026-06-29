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
    // empty desired set → idle (the empty-clear case), then error precedence, then running, else error.
    expect(source).toContain("remoteSvcStatuses.length === 0");
    // error must take precedence over running so a running+error mix reports error (matches local finalize).
    expect(source).toContain("remoteSvcStatuses.some((s) => s === 'error') ? 'error'");
    expect(source).toContain("remoteSvcStatuses.some((s) => s === 'running') ? 'running'");
  });

  it('syncs surviving services’ status from the authoritative svcMap', () => {
    expect(source).toContain("existing.status = s.status as ServiceState['status'];");
  });

  it('reconciles entry.services from BOTH complete and error events (no stale services on failed remote deploy)', () => {
    // Bugbot "Remote deploy error stale services": after moving orphan teardown before git pull, a failed
    // deploy (e.g. pull failure) emits `error` carrying the post-teardown services snapshot; the master must
    // reconcile entry.services from error too, else removed services stay running/wrong-port until heartbeat.
    expect(source).toContain("(eventName === 'complete' || eventName === 'error') && parsed.services");
    // status recompute stays complete-only so a failed deploy is not mislabeled idle/running.
    expect(source).toContain("if (eventName === 'complete') {");
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

  it('finally falls a stuck building branch to error on a streamed remote error (Bugbot "Remote deploy error stuck building")', () => {
    // A streamed `error` event sets proxyHasError + reconciles services but ③ status recompute is complete-only,
    // leaving the dispatch-time 'building'. The finally must demote building→error + backfill errorMessage.
    expect(source).toContain("if (proxyHasError && entry.status === 'building') {");
    expect(source).toContain("entry.status = 'error';");
    expect(source).toContain('entry.errorMessage = proxyErrorMessage');
  });

  it('removes the per-branch network in every cleanup flow, not just DELETE (Codex P2 "Remove branch networks from all cleanup flows")', () => {
    // DELETE + cleanup-stopped + /cleanup + /cleanup-orphans + factory-reset → at least 5 call sites.
    const occurrences = (source.match(/removeBranchNetwork\(/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(5);
  });

  it('local deploy finalize maps an empty desired set to idle, not error (Bugbot "Empty deploy marks branch error")', () => {
    // When an in-line/local-fallback deploy ends with zero active services and no error (the empty-clear
    // case), entry.status MUST be idle — matching the executor path and the local empty-cleanup early
    // return — instead of falling through to the historical `: 'error'` default.
    expect(source).toContain(": activeStatuses.length === 0 ? 'idle'");
  });
});
