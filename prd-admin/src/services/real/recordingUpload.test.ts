import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';
import { completeRecordingUpload, getRecordingUpload } from './documentStore';

vi.mock('./apiClient', () => ({
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('recording upload request bounds', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
    mockedApiRequest.mockResolvedValue({
      success: false,
      data: null as never,
      error: { code: 'TIMEOUT', message: '请求超时' },
    });
  });

  it('uses the default completion timeout and the remaining status budget', async () => {
    await completeRecordingUpload('session-1');
    await getRecordingUpload('session-1', 500);

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      '/api/document-store/recording-uploads/session-1/complete',
      { method: 'POST', timeoutMs: 15_000 },
    );
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      '/api/document-store/recording-uploads/session-1',
      { method: 'GET', timeoutMs: 500 },
    );
  });

  it('clamps caller budgets to a positive request timeout and the per-request ceiling', async () => {
    await completeRecordingUpload('session-1', 60_000);
    await getRecordingUpload('session-1', 0);

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      '/api/document-store/recording-uploads/session-1/complete',
      { method: 'POST', timeoutMs: 15_000 },
    );
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      '/api/document-store/recording-uploads/session-1',
      { method: 'GET', timeoutMs: 1 },
    );
  });
});
