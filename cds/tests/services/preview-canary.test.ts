import { describe, expect, it, vi } from 'vitest';
import { PreviewCanaryService } from '../../src/services/preview-canary.js';

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('PreviewCanaryService', () => {
  it('treats 2xx with a non-empty body as healthy', async () => {
    const fetchImpl = vi.fn(async () => response(200, '<html>ok</html>', { 'x-cds-request-id': 'rid-1' })) as unknown as typeof fetch;
    const alerts: unknown[] = [];
    const svc = new PreviewCanaryService({
      getTargets: () => [{ url: 'https://main-prd-agent.miduo.org/', label: 'main' }],
      fetchImpl,
      onAlert: (payload) => alerts.push(payload),
    });

    const results = await svc.runOnce();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].requestId).toBe('rid-1');
    expect(results[0].headers?.cdsRequestId).toBe('rid-1');
    expect(results[0].consecutiveFailures).toBe(0);
    expect(results[0].probeId).toBeTruthy();
    expect(results[0].runId).toBeTruthy();
    expect(alerts).toHaveLength(0);
  });

  it('alerts on empty 400 preview responses and classifies them before CDS app', async () => {
    const fetchImpl = vi.fn(async () => response(400, '')) as unknown as typeof fetch;
    const alerts: Array<{ failures: number; total: number }> = [];
    const svc = new PreviewCanaryService({
      getTargets: () => [{ url: 'https://main-prd-agent.miduo.org/', label: 'main' }],
      fetchImpl,
      onAlert: (payload) => alerts.push(payload),
    });

    const results = await svc.runOnce();
    expect(results[0].ok).toBe(false);
    expect(results[0].status).toBe(400);
    expect(results[0].bodyBytes).toBe(0);
    expect(results[0].failureKind).toBe('empty-edge-400');
    expect(results[0].suspectedLayer).toBe('edge-or-nginx');
    expect(results[0].consecutiveFailures).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ failures: 1, total: 1 });
  });

  it('classifies forwarder-visible failures with route diagnostic headers', async () => {
    const fetchImpl = vi.fn(async () => response(502, 'bad gateway', {
      'x-cds-request-id': 'rid-2',
      'x-cds-upstream': '127.0.0.1:41000',
      'x-cds-branch': 'prd-main',
      'x-cds-route-id': 'route-1',
    })) as unknown as typeof fetch;
    const svc = new PreviewCanaryService({
      getTargets: () => [{ url: 'https://main-prd-agent.miduo.org/', label: 'main' }],
      fetchImpl,
    });

    const results = await svc.runOnce();
    expect(results[0].ok).toBe(false);
    expect(results[0].failureKind).toBe('http-error');
    expect(results[0].suspectedLayer).toBe('forwarder');
    expect(results[0].headers?.cdsUpstream).toBe('127.0.0.1:41000');
    expect(results[0].headers?.cdsBranch).toBe('prd-main');
    expect(results[0].requestId).toBe('rid-2');
    expect(results[0].bodySha256).toBeTruthy();
  });

  it('emits recovery payload after a failing target becomes healthy', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(400, ''))
      .mockResolvedValueOnce(response(200, '<html>ok</html>', { 'x-cds-request-id': 'rid-ok' })) as unknown as typeof fetch;
    const recoveries: Array<{ recovered: unknown[] }> = [];
    const svc = new PreviewCanaryService({
      getTargets: () => [{ url: 'https://main-prd-agent.miduo.org/', label: 'main' }],
      fetchImpl,
      onRecovery: (payload) => recoveries.push(payload),
    });

    await svc.runOnce();
    const second = await svc.runOnce();
    expect(second[0].ok).toBe(true);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].recovered).toHaveLength(1);
  });

  it('deduplicates targets and respects sampleLimit', async () => {
    const fetchImpl = vi.fn(async () => response(200, 'ok')) as unknown as typeof fetch;
    const svc = new PreviewCanaryService({
      getTargets: () => [
        { url: 'https://a.miduo.org/' },
        { url: 'https://a.miduo.org/' },
        { url: 'https://b.miduo.org/' },
      ],
      sampleLimit: 1,
      fetchImpl,
    });

    const results = await svc.runOnce();
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://a.miduo.org/');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
