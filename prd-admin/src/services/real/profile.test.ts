import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
import { generateMyAvatarPreview } from '@/services/real/profile';

vi.mock('@/services/real/apiClient', () => ({ apiRequest: vi.fn() }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ token: 'test-token' }) },
}));

const mockedApiRequest = vi.mocked(apiRequest);

describe('generateMyAvatarPreview', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
    vi.useFakeTimers();
  });

  it('创建后台任务并等待可追溯的预览资产', async () => {
    const sha = 'a'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-1', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: { status: 'running', stage: '正在生成头像' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/avatar.png',
          assetSha256: sha,
        },
        error: null,
      });

    const stages: string[] = [];
    const resultPromise = generateMyAvatarPreview({
      prompt: '改成手绘风格',
      onProgress: (stage) => stages.push(stage),
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/avatar.png', assetSha256: sha },
      error: null,
    });
    expect(stages).toEqual(['正在排队', '正在生成头像', '生成完成']);
    expect(mockedApiRequest.mock.calls[0]?.[0]).toBe('/api/profile/avatar/generation-runs');
    expect(mockedApiRequest.mock.calls.some(([path]) => String(path).includes('/api/visual-agent/image-gen/generate'))).toBe(false);
  });

  it('把代理层错误转换成用户可理解的恢复动作', async () => {
    mockedApiRequest.mockResolvedValueOnce({
      success: false,
      data: null,
      error: {
        code: 'SERVER_UNAVAILABLE',
        message: '服务器暂不可用（HTTP 504）（/api/visual-agent/image-gen/generate）',
      },
    });

    const result = await generateMyAvatarPreview({ prompt: '改成手绘风格' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('头像生成服务暂时不可用，请稍后重试。');
    expect(result.error?.message).not.toMatch(/HTTP|Provider|token|image-gen/i);
  });

  it('不向用户透传上游图片错误', async () => {
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-2', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'failed',
          stage: '生成未完成',
          errorCode: 'AVATAR_GENERATION_FAILED',
          errorMessage: 'Input must have at least 1 token',
        },
        error: null,
      });

    const resultPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('头像生成服务暂时不可用，请稍后重试。');
    expect(result.error?.message).not.toContain('token');
  });
});
