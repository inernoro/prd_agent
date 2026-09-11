import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/services/real/apiClient';
import { createHostedSiteRevisionPreviewAccess } from './webPages';

vi.mock('@/services/real/apiClient', () => ({
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('hosted site verified preview access', () => {
  afterEach(() => {
    mockedApiRequest.mockReset();
    vi.unstubAllEnvs();
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
});
