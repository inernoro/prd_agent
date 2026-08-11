import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/services/real/apiClient';
import {
  generateMyAvatarPreview,
  getPendingMyAvatarGenerationRunId,
  resumeMyAvatarPreview,
  uploadMyAvatar,
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
    expect(mockedApiRequest.mock.calls[0]?.[1]?.headers?.['Idempotency-Key']).toMatch(/^profile-avatar-/);
    expect(mockedApiRequest.mock.calls.some(([path]) => String(path).includes('/api/visual-agent/image-gen/generate'))).toBe(false);
  });

  it('创建请求超时后以同一幂等键重试，避免重复生成计费任务', async () => {
    const sha = 'c'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: false,
        data: null,
        error: { code: 'TIMEOUT', message: '请求超时' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-recovered', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/recovered-avatar.png',
          assetSha256: sha,
        },
        error: null,
      });

    const firstResult = await generateMyAvatarPreview({ prompt: '改成手绘风格' });
    expect(firstResult.success).toBe(false);
    const firstKey = mockedApiRequest.mock.calls[0]?.[1]?.headers?.['Idempotency-Key'];

    const retryPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
    await vi.runAllTimersAsync();
    await expect(retryPromise).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/recovered-avatar.png', assetSha256: sha },
      error: null,
    });
    const retryKey = mockedApiRequest.mock.calls[1]?.[1]?.headers?.['Idempotency-Key'];
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBe(firstKey);
  });

  it('浏览器拒绝会话存储时仍完成已创建头像任务', async () => {
    const availableSessionStorage = globalThis.sessionStorage;
    const storageDenied = () => { throw new DOMException('Access denied', 'SecurityError'); };
    vi.stubGlobal('sessionStorage', {
      get length() { return storageDenied(); },
      clear: storageDenied,
      getItem: storageDenied,
      key: storageDenied,
      removeItem: storageDenied,
      setItem: storageDenied,
    } as Storage);
    const sha = 'd'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-storage-denied', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/storage-denied.png',
          assetSha256: sha,
        },
        error: null,
      });

    try {
      const resultPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
      await vi.runAllTimersAsync();
      await expect(resultPromise).resolves.toEqual({
        success: true,
        data: { previewUrl: 'https://assets.example/storage-denied.png', assetSha256: sha },
        error: null,
      });
    } finally {
      vi.stubGlobal('sessionStorage', availableSessionStorage);
    }
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

  it.each([
    ['IMAGE_GEN_REQUEST_REJECTED', '图片生成请求未被接受，请调整描述或素材后重试。'],
    ['LLM_QUOTA_EXCEEDED', '当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。'],
    ['IMAGE_GEN_TIMEOUT', '图片生成等待超时，请稍后查看结果或重新生成。'],
  ])('保留头像生成失败分类并给出对应恢复动作：%s', async (errorCode, expectedMessage) => {
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: `run-${errorCode}`, status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'failed',
          stage: '生成未完成',
          errorCode,
          errorMessage: 'raw provider diagnostic',
        },
        error: null,
      });

    const resultPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(errorCode);
    expect(result.error?.message).toBe(expectedMessage);
    expect(result.error?.message).not.toMatch(/provider|diagnostic/i);
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

describe('uploadMyAvatar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把网络层失败映射为带恢复动作的用户可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result).toEqual({
      success: false,
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: '服务暂时不可用，请检查网络后重新上传。',
      },
    });
    expect(result.error?.message).not.toContain('Failed to fetch');
  });

  it('不向用户显示无法解析的 HTTP 响应诊断', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html>Bad Gateway</html>'),
    }));

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result.error).toEqual({
      code: 'INVALID_FORMAT',
      message: '头像上传未完成，请稍后重新上传。',
    });
  });
});
