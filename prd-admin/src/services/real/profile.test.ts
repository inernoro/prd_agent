import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMultipartRequest, apiRequest } from '@/services/real/apiClient';
import { connectSse } from '@/lib/useSseStream';
import {
  applyGeneratedMyAvatar,
  generateMyAvatarPreview,
  getPendingMyAvatarGenerationRunId,
  hasRecoverableMyAvatarGeneration,
  resumeMyAvatarPreview,
  uploadMyAvatar,
} from '@/services/real/profile';

vi.mock('@/services/real/apiClient', () => ({
  apiRequest: vi.fn(),
  apiMultipartRequest: vi.fn(),
}));
vi.mock('@/lib/useSseStream', () => ({ connectSse: vi.fn() }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: { getState: () => ({ token: 'test-token', user: { userId: 'user-1' } }) },
}));

const mockedApiRequest = vi.mocked(apiRequest);
const mockedApiMultipartRequest = vi.mocked(apiMultipartRequest);
const mockedConnectSse = vi.mocked(connectSse);
const sessionValues = new Map<string, string>();
const testSessionStorage = {
  get length() { return sessionValues.size; },
  clear: () => sessionValues.clear(),
  getItem: (key: string) => sessionValues.get(key) ?? null,
  key: (index: number) => [...sessionValues.keys()][index] ?? null,
  removeItem: (key: string) => { sessionValues.delete(key); },
  setItem: (key: string, value: string) => { sessionValues.set(key, String(value)); },
} satisfies Storage;
vi.stubGlobal('sessionStorage', testSessionStorage);

describe('generateMyAvatarPreview', () => {
  beforeEach(() => {
    mockedApiRequest.mockReset();
    mockedConnectSse.mockReset();
    mockedConnectSse.mockResolvedValue({
      success: false,
      errorCode: 'NETWORK_ERROR',
      errorMessage: '测试环境未建立 SSE',
    });
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-1');
  });

  it('优先通过本人头像状态流接收进度并完成预览', async () => {
    const sha = '6'.repeat(64);
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { runId: 'run-stream', status: 'queued', stage: '正在排队' },
      error: null,
    });
    mockedConnectSse.mockImplementationOnce(async ({ url, onEvent }) => {
      expect(url).toBe('/api/profile/avatar/generation-runs/run-stream/stream');
      onEvent({ event: 'status', data: JSON.stringify({ status: 'running', stage: '正在生成头像' }) });
      onEvent({
        event: 'status',
        data: JSON.stringify({
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/stream-avatar.png',
          assetSha256: sha,
        }),
      });
      return { success: true };
    });

    const stages: string[] = [];
    const result = await generateMyAvatarPreview({
      prompt: '通过状态流生成头像',
      onProgress: (stage) => stages.push(stage),
    });

    expect(result).toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/stream-avatar.png', assetSha256: sha },
      error: null,
    });
    expect(stages).toEqual(['正在排队', '正在生成头像', '生成完成']);
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
  });

  it('头像状态流跟随独立 API 域名和路径前缀', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/platform/');
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { runId: 'run-prefixed', status: 'queued', stage: '正在排队' },
      error: null,
    });
    mockedConnectSse.mockImplementationOnce(async ({ url, onEvent }) => {
      expect(url).toBe('https://api.example.com/platform/api/profile/avatar/generation-runs/run-prefixed/stream');
      onEvent({
        event: 'status',
        data: JSON.stringify({ status: 'failed', stage: '生成未完成', errorCode: 'IMAGE_GEN_UNAVAILABLE' }),
      });
      return { success: true };
    });

    const result = await generateMyAvatarPreview({ prompt: '验证独立 API 状态流' });

    expect(result.success).toBe(false);
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
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

  it('创建请求断线后保留原幂等键，重新打开可恢复已计费任务', async () => {
    const sha = '7'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: false,
        data: null,
        error: { code: 'DISCONNECTED', message: '网络连接已中断，请检查网络后重试。' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-disconnected-recovered', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/disconnected-recovered.png',
          assetSha256: sha,
        },
        error: null,
      });

    const firstResult = await generateMyAvatarPreview({ prompt: '断线后恢复头像任务' });
    const firstKey = mockedApiRequest.mock.calls[0]?.[1]?.headers?.['Idempotency-Key'];
    expect(firstResult.success).toBe(false);
    expect(hasRecoverableMyAvatarGeneration()).toBe(true);

    const resumedResult = resumeMyAvatarPreview({});
    await vi.runAllTimersAsync();
    await expect(resumedResult).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/disconnected-recovered.png', assetSha256: sha },
      error: null,
    });
    expect(mockedApiRequest.mock.calls[1]?.[1]?.headers?.['Idempotency-Key']).toBe(firstKey);
  });

  it('创建请求结果不确定时重新打开可自动用原幂等键恢复任务', async () => {
    const sha = '9'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: false,
        data: null,
        error: { code: 'TIMEOUT', message: '请求超时' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-auto-resume', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/auto-resumed-avatar.png',
          assetSha256: sha,
        },
        error: null,
      });

    const firstResult = await generateMyAvatarPreview({ prompt: '恢复这次创建请求' });
    const firstKey = mockedApiRequest.mock.calls[0]?.[1]?.headers?.['Idempotency-Key'];
    expect(firstResult.success).toBe(false);
    expect(hasRecoverableMyAvatarGeneration()).toBe(true);

    const resumedResult = resumeMyAvatarPreview({});
    await vi.runAllTimersAsync();

    await expect(resumedResult).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/auto-resumed-avatar.png', assetSha256: sha },
      error: null,
    });
    expect(mockedApiRequest.mock.calls[1]?.[1]?.headers?.['Idempotency-Key']).toBe(firstKey);
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-auto-resume');
  });

  it('旧预览与新创建记录并存时优先恢复较新的创建请求', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-run:user-1', 'run-old-preview');
    sessionStorage.setItem('prd-admin:avatar-generation-create:user-1', JSON.stringify({
      prompt: '生成一个更新的头像',
      idempotencyKey: 'profile-avatar-newer-creation',
    }));
    const sha = '8'.repeat(64);
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: 'run-newer-preview', status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          status: 'completed',
          stage: '生成完成',
          previewUrl: 'https://assets.example/newer-avatar.png',
          assetSha256: sha,
        },
        error: null,
      });

    const resultPromise = resumeMyAvatarPreview({});
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      success: true,
      data: { previewUrl: 'https://assets.example/newer-avatar.png', assetSha256: sha },
      error: null,
    });
    expect(mockedApiRequest.mock.calls[0]?.[0]).toBe('/api/profile/avatar/generation-runs');
    expect(mockedApiRequest.mock.calls[0]?.[1]?.headers?.['Idempotency-Key']).toBe('profile-avatar-newer-creation');
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-newer-preview');
  });

  it('创建已被服务端接受时先保存任务引用再响应关闭取消', async () => {
    mockedApiRequest.mockImplementationOnce(() => new Promise((resolve) => {
      globalThis.setTimeout(() => resolve({
        success: true,
        data: { runId: 'run-accepted-before-close', status: 'queued', stage: '正在排队' },
        error: null,
      }), 50);
    }));
    const controller = new AbortController();

    const resultPromise = generateMyAvatarPreview({
      prompt: '创建期间关闭弹窗',
      signal: controller.signal,
    });
    controller.abort();
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.error?.code).toBe('AVATAR_GENERATION_CANCELLED');
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-accepted-before-close');
    expect(hasRecoverableMyAvatarGeneration()).toBe(true);
    expect(mockedApiRequest.mock.calls[0]?.[1]?.signal).toBeUndefined();
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

  it('描述超过限制时提示缩短描述而不是重新上传头像', async () => {
    const result = await generateMyAvatarPreview({ prompt: '字'.repeat(501) });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AVATAR_PROMPT_TOO_LONG');
    expect(result.error?.message).toBe('头像修改描述不能超过 500 字，请缩短描述后重试。');
    expect(result.error?.message).not.toContain('上传');
    expect(mockedApiRequest).not.toHaveBeenCalled();
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

  it.each([
    {
      expectedCode: 'AVATAR_GENERATION_NOT_FOUND',
      pollResponse: {
        success: false as const,
        data: null,
        error: { code: 'AVATAR_GENERATION_NOT_FOUND', message: '任务不存在' },
      },
    },
    {
      expectedCode: 'AVATAR_RESULT_UNAVAILABLE',
      pollResponse: {
        success: true as const,
        data: { status: 'completed' as const, stage: '生成完成' },
        error: null,
      },
    },
  ])('任务或结果不可恢复时明确引导重新生成：$expectedCode', async ({ expectedCode, pollResponse }) => {
    mockedApiRequest
      .mockResolvedValueOnce({
        success: true,
        data: { runId: `run-${expectedCode}`, status: 'queued', stage: '正在排队' },
        error: null,
      })
      .mockResolvedValueOnce(pollResponse);

    const resultPromise = generateMyAvatarPreview({ prompt: '改成手绘风格' });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(expectedCode);
    expect(result.error?.message).toBe('这次头像生成任务或结果已失效，请重新生成头像。');
    expect(result.error?.message).not.toContain('稍后');
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

  it('重新打开编辑器时恢复任务并在完成后保留结果引用', async () => {
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
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-resume');
  });

  it('应用生成头像成功后才清理已保留的结果引用', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-run:user-1', 'run-applied');
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { userId: 'user-1', avatarFileName: 'generated-avatar.png' },
      error: null,
    });

    const result = await applyGeneratedMyAvatar('e'.repeat(64));

    expect(result.success).toBe(true);
    expect(mockedApiRequest.mock.calls[0]?.[0]).toBe('/api/profile/avatar/apply-generated');
    expect(getPendingMyAvatarGenerationRunId()).toBeNull();
  });

  it('应用生成头像失败时保留结果引用供用户重试', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-run:user-1', 'run-apply-retry');
    mockedApiRequest.mockResolvedValueOnce({
      success: false,
      data: null,
      error: { code: 'IMAGE_ASSET_NOT_FOUND', message: '结果暂不可用' },
    });

    const result = await applyGeneratedMyAvatar('f'.repeat(64));

    expect(result.success).toBe(false);
    expect(getPendingMyAvatarGenerationRunId()).toBe('run-apply-retry');
  });
});

describe('uploadMyAvatar', () => {
  beforeEach(() => {
    sessionValues.clear();
    mockedApiMultipartRequest.mockReset();
    vi.stubGlobal('sessionStorage', testSessionStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('把网络层失败映射为带恢复动作的用户可读错误', async () => {
    mockedApiMultipartRequest.mockResolvedValue({
      success: false,
      data: null,
      error: { code: 'NETWORK_ERROR', message: '网络连接异常，请检查网络后重试。' },
    });

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

  it('把代理或服务端提前返回的 413 归类为头像文件过大', async () => {
    mockedApiMultipartRequest.mockResolvedValue({
      success: false,
      data: null,
      error: { code: 'DOCUMENT_TOO_LARGE', message: '文件超过当前大小限制，请缩小文件后重新上传。' },
    });

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result.error).toEqual({
      code: 'DOCUMENT_TOO_LARGE',
      message: '文件超过当前大小限制，请缩小文件后重新上传。',
    });
    expect(result.error?.message).not.toMatch(/html|request entity/i);
  });

  it('不向用户显示无法解析的 HTTP 响应诊断', async () => {
    mockedApiMultipartRequest.mockResolvedValue({
      success: false,
      data: null,
      error: { code: 'INVALID_FORMAT', message: '服务返回格式异常' },
    });

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result.error).toEqual({
      code: 'INVALID_FORMAT',
      message: '头像上传未完成，请稍后重新上传。',
    });
  });

  it('直接上传新头像成功后清理被替代的生成结果引用', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-run:user-1', 'run-superseded-by-upload');
    mockedApiMultipartRequest.mockResolvedValue({
      success: true,
      data: { userId: 'user-1', avatarFileName: 'uploaded-avatar.png' },
      error: null,
    });

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result.success).toBe(true);
    expect(getPendingMyAvatarGenerationRunId()).toBeNull();
  });

  it('直接上传新头像成功后清理尚未返回任务号的创建记录', async () => {
    sessionStorage.setItem('prd-admin:avatar-generation-create:user-1', JSON.stringify({
      prompt: '已经被手动上传替代',
      idempotencyKey: 'profile-avatar-superseded-creation',
    }));
    mockedApiMultipartRequest.mockResolvedValue({
      success: true,
      data: { userId: 'user-1', avatarFileName: 'uploaded-avatar.png' },
      error: null,
    });

    const result = await uploadMyAvatar({
      file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
    });

    expect(result.success).toBe(true);
    expect(sessionStorage.getItem('prd-admin:avatar-generation-create:user-1')).toBeNull();
    expect(hasRecoverableMyAvatarGeneration()).toBe(false);
  });
});
