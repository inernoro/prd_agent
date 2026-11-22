import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/services/real/apiClient';
import { createHostedSiteRevisionPreviewAccess, viewShare } from './webPages';

vi.mock('@/services/real/apiClient', () => ({
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('hosted site verified preview access', () => {
  afterEach(() => {
    mockedApiRequest.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('resolves a relative bootstrap URL against the configured API origin', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    mockedApiRequest.mockResolvedValue({
      success: true,
      data: {
        available: true,
        previewUrl: '/api/hosted-site-preview-files/bootstrap/ticket',
        expiresAt: '2026-09-10T18:00:00Z',
      },
      error: null,
    });

    const result = await createHostedSiteRevisionPreviewAccess('site-a', 'revision-a');

    expect(result).toEqual({
      success: true,
      data: {
        available: true,
        previewUrl: 'https://api.example.test/platform/api/hosted-site-preview-files/bootstrap/ticket',
        expiresAt: '2026-09-10T18:00:00Z',
      },
      error: null,
    });
  });

  it('keeps the legacy static-preview response without inventing a URL', async () => {
    mockedApiRequest.mockResolvedValue({
      success: true,
      data: { available: false },
      error: null,
    });

    await expect(createHostedSiteRevisionPreviewAccess('site-a', 'revision-a'))
      .resolves.toEqual({ success: true, data: { available: false }, error: null });
  });

  it('opens the approved revision with a protected session and keeps the password out of the URL', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/platform/');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        revisionId: 'fixed-revision',
        title: 'Fixed design',
        createdAt: '2026-11-21T10:00:00Z',
        previewUrl: '/platform/api/hosted-site-preview-files/shared/session/index.html',
      },
      error: null,
    })));
    vi.stubGlobal('fetch', fetcher);

    const response = await viewShare('fixture-token', 'fixture-password', 'fixed-revision');

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/platform/api/web-pages/shares/view/fixture-token/revisions/fixed-revision/access',
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ password: 'fixture-password' }) }),
    );
    expect(response).toMatchObject({ success: true, data: {
      revisionId: 'fixed-revision', title: 'Fixed design', sites: [],
      previewUrl: 'https://api.example.test/platform/api/hosted-site-preview-files/shared/session/index.html',
    } });
  });
});
