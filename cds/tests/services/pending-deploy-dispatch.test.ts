import { afterEach, describe, expect, it, vi } from 'vitest';
import { observePendingDeployDispatch } from '../../src/services/pending-deploy-dispatch.js';

const url = 'http://127.0.0.1:9900/api/branches/owned/deploy/api';
const init = { method: 'POST', body: JSON.stringify({ commitSha: '1'.repeat(40) }) };
const responseOf = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
afterEach(() => vi.useRealTimers());

describe('bounded pending deployment observations', () => {
  it('does not accumulate reactions on the same deadline while reading many progress chunks', async () => {
    const nativeRace = Promise.race.bind(Promise); const uses = new Map<unknown, number>();
    const race = vi.spyOn(Promise, 'race').mockImplementation((values: any) => {
      const list = Array.from(values);
      for (const value of list) uses.set(value, (uses.get(value) || 0) + 1);
      return nativeRace(list) as any;
    });
    let count = 0; const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(encoder.encode(count++ < 2000 ? 'event: log\ndata: {}\n\n'
        : 'event: complete\ndata: {"ok":true}\n\n'));
    } }));
    try {
      expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toMatchObject({ outcome: 'completed' });
      expect(Math.max(0, ...uses.values())).toBeLessThanOrEqual(1);
    } finally { race.mockRestore(); }
  });

  it('never reads a rejected HTTP body or copies secrets into its result', async () => {
    const cancel = vi.fn(); const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }), { status: 503 });
    const read = vi.spyOn(response, 'text');
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'failed', reason: 'http_rejected', httpStatus: 503 });
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a stalled header wait, aborts only observation, and does not retry', async () => {
    vi.useFakeTimers();
    let settle!: (value: Response) => void;
    const fetcher = vi.fn((_url, request) => { expect(request.signal).toBeInstanceOf(AbortSignal); return new Promise<Response>(resolve => { settle = resolve; }); });
    const pending = observePendingDeployDispatch(url, init, { fetch: fetcher as typeof fetch });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ outcome: 'unknown', reason: 'response_timeout' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    const cancel = vi.fn(); settle(new Response(new ReadableStream({ cancel })));
    await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hung body independently of headers without claiming a run terminal', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const fetcher = responseOf(new Response(new ReadableStream({ cancel }), { headers: { 'X-CDS-Deployment-Run-Id': 'dr_actual' } }));
    const pending = observePendingDeployDispatch(url, init, { fetch: fetcher });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(await pending).toEqual({ outcome: 'unknown', reason: 'observation_timeout', httpStatus: 200 });
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports broken reads as uncertain, without logging their error text or retrying', async () => {
    const fetcher = responseOf(new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-token')); } })));
    const result = await observePendingDeployDispatch(url, init, { fetch: fetcher });
    expect(result).toEqual({ outcome: 'unknown', reason: 'transport_error', httpStatus: 200 });
    expect(JSON.stringify(result)).not.toContain('private-token'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an oversized unfinished frame and cancels its stream', async () => {
    const cancel = vi.fn(); const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('event: log\ndata: ' + 'x'.repeat(1024 * 1024))); }, cancel }));
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'unknown', reason: 'frame_too_large', httpStatus: 200 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('discards large amounts of completed progress frames rather than capping the full stream', async () => {
    const progress = 'event: log\ndata: {"chunk":"' + 'x'.repeat(1024) + '"}\n\n';
    const response = new Response(progress.repeat(1000) + 'event: complete\ndata: {"ok":true,"runId":"dr_actual"}\n\n');
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'completed', reason: 'deployment_completed', httpStatus: 200, deploymentRunId: 'dr_actual' });
  });

  it('handles CRLF and UTF-8 split across chunks, then prefers the actual terminal run ID', async () => {
    const bytes = new TextEncoder().encode('event: log\r\ndata: {"chunk":"处理中"}\r\n\r\nevent: complete\r\ndata: {"ok":true,"runId":"dr_actual"}\r\n\r\n');
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
      { headers: { 'X-CDS-Deployment-Run-Id': 'dr_placeholder' } });
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toMatchObject({ outcome: 'completed', deploymentRunId: 'dr_actual' });
  });

  it.each(['merged', 'joined'])('records %s as accepted, not completed; ignores a cancelled placeholder header', async operationStatus => {
    const response = new Response(JSON.stringify({ ok: true, operationStatus, ...(operationStatus === 'joined' ? { deploymentRunId: 'dr_actual' } : {}) }),
      { status: 202, headers: { 'Content-Type': 'application/json', 'X-CDS-Deployment-Run-Id': 'dr_placeholder' } });
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'accepted', reason: 'request_accepted', httpStatus: 202,
      ...(operationStatus === 'joined' ? { deploymentRunId: 'dr_actual' } : {}) });
  });

  it.each(['event: complete\ndata: {"message":"done"}\n\n', 'event: complete\ndata: broken\n\n'])('does not infer success from an invalid terminal payload', async body => {
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(new Response(body)) })).toMatchObject({ outcome: 'unknown', reason: 'invalid_terminal' });
  });

  it('does not infer deployment completion from an arbitrary JSON ok response', async () => {
    const response = new Response('{"ok":true}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toMatchObject({ outcome: 'unknown', reason: 'invalid_terminal' });
  });

  it('does not accept arbitrary response IDs into the durable event record', async () => {
    const response = new Response('event: complete\ndata: {"ok":true,"runId":"private-token"}\n\n',
      { headers: { 'X-CDS-Deployment-Run-Id': 'also-private-token' } });
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'completed', reason: 'deployment_completed', httpStatus: 200 });
  });

  it.each(['started', 'rejected'])('does not turn an unrecognized or contradictory operation status %s into completion', async operationStatus => {
    const response = new Response(`event: complete\ndata: ${JSON.stringify({ ok: true, operationStatus, runId: 'dr_' + operationStatus })}\n\n`);
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'unknown', reason: 'invalid_terminal', httpStatus: 200 });
  });

  it('preserves an explicit cancellation separately from a deployment failure', async () => {
    const response = new Response('event: error\ndata: {"operationStatus":"cancelled","runId":"dr_cancelled"}\n\n');
    expect(await observePendingDeployDispatch(url, init, { fetch: responseOf(response) })).toEqual({ outcome: 'cancelled', reason: 'deployment_cancelled', httpStatus: 200, deploymentRunId: 'dr_cancelled' });
  });
});
