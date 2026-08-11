import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
import {
  generateMyAvatarPreview,
  getPendingMyAvatarGenerationRunId,
  resumeMyAvatarPreview,
} from '@/services/real/profile';

vi.mock('@/services/real/apiClient', () => ({ apiRequest: vi.fn() }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ token: 'test-token', user: { userId: 'user-1' } }) },
}));

const mockedApiRequest = vi.mocked(apiRequest);
const sessionValues = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  get length() { return sessionValues.size; },
  clear: () => sessionValues.clear(),
  getItem: (key: string) => sessionValues.get(key) ?? null,
  key: (index: number) => [...sessionValues.keys()][index] ?? null,
  removeItem: (key: string) => { sessionValues.delete(key); },
  setItem: (key: string, value: string) => { sessionValues.set(key, String(value)); },
} satisfies Storage);

describe('generateMyAvatarPreview', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('关闭编辑器后停止后续轮询请求', async () => {
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { runId: 'run-cancel', status: 'queued', stage: '正在排队' },
      error: null,
    });
    const controller = new AbortController();

    const resultPromise = generateMyAvatarPreview({
      prompt: '改成手绘风格',
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AVATAR_GENERATION_CANCELLED');
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-cancel');
  });

  it('轮询超时后保留任务以便重新打开时恢复', async () => {
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-waiting', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValue({
        success: true,
        data: { status: 'running', stage: '正在生成头像' },
        error: null,
      });

    const resultPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AVATAR_GENERATION_WAITING');
    expect(result.error?.message).toContain('重新打开头像编辑器会自动恢复');
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-waiting');
  });

  it('重新打开编辑器时恢复未完成任务并在完成后清理记录', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-run:user-1', 'run-resume');
    const sha = 'b'.repeat(64);
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'completed',
        stage: '生成完成',
        previewUrl: 'https://assets.example/resumed-avatar.png',
        assetSha256: sha,
      },
      error: null,
    });

    const resultPromise = resumeMyAvatarPreview({});
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/resumed-avatar.png', assetSha256: sha },
      error: null,
    });
    expect(mockedApiRequest.mock.calls[0]?.[0]).toBe('/api/profile/avatar/generation-runs/run-resume');
    expect(getPendingMyAvatarGenerationRunId()).toBeNull();
  });
});
