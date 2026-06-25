import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBatchModelStatsReal } from './llmLogs';
import { apiRequest } from './apiClient';

vi.mock('./apiClient', () => ({
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('getBatchModelStatsReal', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
    mockedApiRequest.mockResolvedValue({
      success: true,
      data: { days: 7, items: {} },
      error: null,
    });
  });

  it('passes the raw request object to apiRequest', async () => {
    const params = {
      days: 7,
      items: [
        {
          appCallerCode: 'prd-agent',
          platformId: 'openai',
          modelId: 'gpt-4.1',
        },
      ],
    };

    await getBatchModelStatsReal(params);

    expect(mockedApiRequest).toHaveBeenCalledWith('/api/logs/llm/model-stats/batch', {
      method: 'POST',
      body: params,
    });
    expect(typeof mockedApiRequest.mock.calls[0]?.[1]?.body).toBe('object');
  });
});
