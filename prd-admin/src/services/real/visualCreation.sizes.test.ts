import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
import { listVisualSizes } from './visualCreation';

vi.mock('@/services/real/apiClient', () => ({
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('listVisualSizes', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
  });

  it('keeps user-selectable sizes for prompt-transport adaptive models', async () => {
    mockedApiRequest.mockResolvedValue({
      success: true,
      data: {
        matched: true,
        modelId: 'gpt-image-2-all',
        isAdaptive: true,
        sizesNotApplicable: false,
        sizesByResolution: {
          '1k': [
            { size: '1024x1024', aspectRatio: '1:1' },
            { size: '768x1024', aspectRatio: '3:4' },
          ],
          '2k': [],
          '4k': [],
        },
      },
      error: null,
    });

    await expect(listVisualSizes('gpt-image-2-all')).resolves.toEqual(['1024x1024', '768x1024']);
  });

  it('hides sizes only when the model declares size semantics not applicable', async () => {
    mockedApiRequest.mockResolvedValue({
      success: true,
      data: {
        matched: true,
        modelId: 'fal-qwen-image-layered',
        isAdaptive: true,
        sizesNotApplicable: true,
        sizesByResolution: { '1k': [], '2k': [], '4k': [] },
      },
      error: null,
    });

    await expect(listVisualSizes('fal-qwen-image-layered')).resolves.toEqual([]);
  });
});
