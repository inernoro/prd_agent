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
    expect(alerts).toHaveLength(0);
  });

  it('alerts on empty 400 preview responses', async () => {
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
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ failures: 1, total: 1 });
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
