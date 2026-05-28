import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, apiUrl, shouldPreferCdsPassthrough } from '../../web/src/lib/api';

function setLocationHostname(hostname: string): void {
  vi.stubGlobal('window', { location: { hostname } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard api url routing', () => {
  it('prefers CDS master passthrough on production-like hosts', () => {
    expect(apiUrl('/api/self-status', 'cds.miduo.org')).toBe('/_cds/api/self-status');
    expect(apiUrl('/api/pending-imports?limit=20', 'preview.example.com')).toBe(
      '/_cds/api/pending-imports?limit=20'
    );
  });

  it('keeps vite dev proxy paths on localhost', () => {
    expect(apiUrl('/api/self-status', 'localhost')).toBe('/api/self-status');
    expect(apiUrl('/api/self-status', '127.0.0.1')).toBe('/api/self-status');
    expect(apiUrl('/api/self-status', '::1')).toBe('/api/self-status');
  });

  it('does not double-prefix passthrough or non-api paths', () => {
    expect(apiUrl('/_cds/api/self-status', 'cds.miduo.org')).toBe('/_cds/api/self-status');
    expect(apiUrl('/assets/app.js', 'cds.miduo.org')).toBe('/assets/app.js');
  });

  it('exposes a deterministic host preference predicate', () => {
    expect(shouldPreferCdsPassthrough('cds.miduo.org')).toBe(true);
    expect(shouldPreferCdsPassthrough('localhost')).toBe(false);
  });

  it('does not retry production passthrough failures against bare /api', async () => {
    setLocationHostname('cds.miduo.org');
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/api/pending-imports')).rejects.toMatchObject({ status: 404 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/_cds/api/pending-imports');
  });

  it('keeps the local dev alternate retry for unreadable GET failures', async () => {
    setLocationHostname('localhost');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/api/pending-imports')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/pending-imports');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/_cds/api/pending-imports');
  });
});
