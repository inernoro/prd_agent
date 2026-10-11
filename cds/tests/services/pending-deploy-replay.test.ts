import { afterEach, describe, expect, it, vi } from 'vitest';
import { replayPendingDeploy } from '../../src/services/pending-deploy-replay.js';

const pending: any = { operationId: 'op_pending', branchId: 'owned', generation: 2, mergedCount: 1,
  updatedAt: '2026-10-11T00:00:00Z', request: { branchId: 'owned', projectId: 'p', profileId: 'api/name',
    kind: 'deploy-profile', trigger: 'manual', commitSha: 'a'.repeat(40), requestId: 'request_pending' } };
function fixture(fetcher: typeof fetch) {
  const events: any[] = [];
  const deps: any = { stateService: { getBranch: () => ({ id: 'owned', projectId: 'p' }) },
    config: { masterPort: 9900 }, fetch: fetcher,
    activeServerEventLogStore: { record: (event: any) => events.push(event) } };
  return { events, deps };
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)); }
afterEach(() => vi.useRealTimers());

describe('shared pending replay from background and route completions', () => {
  it('keeps the exact single-service URL, SHA and trigger instead of replaying the entire branch', async () => {
    const fetcher = vi.fn(async () => new Response('event: complete\ndata: {"ok":true,"runId":"dr_actual"}\n\n'));
    const { deps } = fixture(fetcher as typeof fetch); replayPendingDeploy(pending, deps); await settle();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:9900/api/branches/owned/deploy/api%2Fname');
    const request = (fetcher.mock.calls[0] as any)[1];
    expect(JSON.parse(request.body)).toEqual({ commitSha: 'a'.repeat(40) });
    expect(request.headers).toMatchObject({ 'X-CDS-Trigger': 'manual', 'X-CDS-Source-Project-Id': 'p',
      'X-CDS-Source-Branch-Id': 'owned', 'X-CDS-Request-Id': 'request_pending' });
  });

  it('logs only the bounded rejection classification and never reads its private HTTP body', async () => {
    const response = new Response('PASSWORD=private-token-do-not-log', { status: 503 });
    const text = vi.spyOn(response, 'text'); const { deps, events } = fixture((async () => response) as typeof fetch);
    replayPendingDeploy(pending, deps); await settle();
    expect(text).not.toHaveBeenCalled(); expect(JSON.stringify(events)).not.toContain('private-token-do-not-log');
    expect(events.find(e => e.action === 'branch.operation.pending-dispatch.failed')?.details)
      .toMatchObject({ outcome: 'failed', reason: 'http_rejected', httpStatus: 503 });
  });

  it('records a false terminal as failure even when HTTP itself succeeded', async () => {
    const { deps, events } = fixture((async () => new Response('event: complete\ndata: {"ok":false,"runId":"dr_actual"}\n\n')) as typeof fetch);
    replayPendingDeploy(pending, deps); await settle();
    expect(events.find(e => e.action === 'branch.operation.pending-dispatch.failed')?.details)
      .toMatchObject({ outcome: 'failed', reason: 'deployment_failed', deploymentRunId: 'dr_actual' });
  });

  it('bounds an unanswered background replay without retrying or declaring execution cancelled', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, _request) => new Promise<Response>(() => {}));
    const { deps, events } = fixture(fetcher as typeof fetch); deps.observation = { headersTimeoutMs: 20 };
    replayPendingDeploy(pending, deps); await vi.advanceTimersByTimeAsync(21);
    expect(events.find(e => e.action === 'branch.operation.pending-dispatch.unknown')?.details)
      .toMatchObject({ outcome: 'unknown', reason: 'response_timeout' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(events.some(e => e.action === 'branch.operation.pending-dispatch.cancelled')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps whole-branch replay whole and treats a joined operation as accepted, not completed', async () => {
    const fetcher = vi.fn(async () => new Response('event: complete\ndata: {"ok":true,"operationStatus":"joined","operationId":"op_existing"}\n\n'));
    const { deps, events } = fixture(fetcher as typeof fetch);
    replayPendingDeploy({ ...pending, request: { ...pending.request, kind: 'deploy', profileId: undefined } }, deps);
    await settle();
    expect((fetcher.mock.calls[0] as any)[0]).toBe('http://127.0.0.1:9900/api/branches/owned/deploy');
    expect(events.find(e => e.action === 'branch.operation.pending-dispatch.accepted')?.details)
      .toMatchObject({ outcome: 'accepted', operationId: 'op_pending' });
    expect(events.some(e => e.action === 'branch.operation.pending-dispatch.completed')).toBe(false);
  });

  it('drops a deleted branch without dispatching or retrying an obsolete target', async () => {
    const fetcher = vi.fn(); const { deps, events } = fixture(fetcher as typeof fetch);
    deps.stateService.getBranch = () => undefined;
    replayPendingDeploy(pending, deps); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.map(e => e.action)).toEqual(['branch.operation.pending-drop']);
  });


  it('does not reattribute an old request to a replacement branch owned by another project', async () => {
    const fetcher = vi.fn(); const { deps, events } = fixture(fetcher as typeof fetch);
    deps.stateService.getBranch = () => ({ id: 'owned', projectId: 'new-project' });
    replayPendingDeploy(pending, deps); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ action: 'branch.operation.pending-drop', projectId: 'p',
      details: { reason: 'project_mismatch' } });
    expect(JSON.stringify(events)).not.toContain('new-project');
  });

  it('fails closed if a single-service target is missing instead of expanding it to whole branch', async () => {
    const fetcher = vi.fn(); const { deps, events } = fixture(fetcher as typeof fetch);
    replayPendingDeploy({ ...pending, request: { ...pending.request, profileId: undefined } }, deps); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ action: 'branch.operation.pending-drop', details: { reason: 'invalid_scope' } });
  });

  it('rejects an unknown original project and contradictory branch or service scopes', async () => {
    for (const request of [
      { ...pending.request, projectId: undefined },
      { ...pending.request, branchId: 'different' },
      { ...pending.request, kind: 'deploy' },
      { ...pending.request, kind: 'stop' },
    ]) {
      const fetcher = vi.fn(); const { deps, events } = fixture(fetcher as typeof fetch);
      replayPendingDeploy({ ...pending, request }, deps); await settle();
      expect(fetcher).not.toHaveBeenCalled();
      expect(events[0].action).toBe('branch.operation.pending-drop');
    }
  });

  it('keeps an unpinned manual whole intent unpinned rather than sending the old cached SHA', async () => {
    const fetcher = vi.fn(async () => new Response('event: complete\ndata: {"ok":true,"runId":"dr_latest"}\n\n'));
    const { deps } = fixture(fetcher as typeof fetch);
    replayPendingDeploy({ ...pending, request: { ...pending.request, kind: 'deploy', profileId: null, commitPinned: false } }, deps);
    await settle(); expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({});
  });

});
