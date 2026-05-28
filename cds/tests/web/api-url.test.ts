import { describe, expect, it } from 'vitest';

import { apiUrl, shouldPreferCdsPassthrough } from '../../web/src/lib/api';

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
});
