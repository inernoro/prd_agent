import { describe, expect, it, vi } from 'vitest';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { replayPendingDeploy } from '../../src/services/pending-deploy-replay.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request: any = { branchId: 'owned', projectId: 'p', kind: 'deploy', trigger: 'webhook', commitSha: 'a'.repeat(40) };
describe('pending persistence barriers at existing coordinator and replay seams', () => {
  it('returns a persistence barrier for merged acceptance instead of acknowledging held IO', async () => {
    let finish!: () => void;
    const upsert = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const journal = { upsert, blockReason: () => null, cancel: vi.fn(async () => {}), queued: () => [] };
    const coordinator = new (BranchOperationCoordinator as any)(undefined, undefined, journal);
    coordinator.begin(request);
    const merged = coordinator.begin({ ...request, commitSha: 'b'.repeat(40) });
    let acknowledged = false;
    const barrier = Promise.resolve(merged.persistence).then(() => { acknowledged = true; });
    await tick();
    expect(upsert).toHaveBeenCalledOnce(); expect(acknowledged).toBe(false);
    finish(); await barrier; expect(acknowledged).toBe(true);
  });
  it('does not POST until the coordinator has durably claimed the dequeued request', async () => {
    let finish!: (claimed: boolean) => void;
    const claimPending = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const markPendingSent = vi.fn(() => true); const settlePending = vi.fn(async () => {});
    const fetcher = vi.fn(async () => new Response('event: complete\ndata: {"ok":true,"runId":"dr_owned"}\n\n'));
    const pending: any = { operationId: 'op_owned', generation: 2, branchId: 'owned', request, mergedCount: 1, updatedAt: new Date().toISOString() };
    const branch = { id: 'owned', projectId: 'p' } as any;
    replayPendingDeploy(pending, { stateService: { getBranch: () => branch }, config: { masterPort: 9900 }, fetch: fetcher as typeof fetch,
      coordinator: { claimPending, markPendingSent, settlePending } } as any);
    await tick(); expect(claimPending).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
    finish(true); for (let i = 0; i < 10; i++) await tick();
    expect(markPendingSent).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[0] as any)[1].headers).toMatchObject({ 'X-CDS-Pending-Operation-Id': 'op_owned', 'X-CDS-Pending-Generation': '2' });
    expect(settlePending).toHaveBeenCalledOnce();
  });
});
