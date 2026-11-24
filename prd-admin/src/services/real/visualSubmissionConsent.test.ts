import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';
import { updateVisualAgentWorkspaceReal } from './visualAgent';
import { autoSubmitImages } from './submissions';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

describe('视觉投稿配置请求', () => {
  beforeEach(() => vi.clearAllMocks());

  it('保存关闭意图时保留原封面，显式清空封面仍可传 null', async () => {
    await updateVisualAgentWorkspaceReal({ id: 'workspace', suppressAutoSubmit: true });
    const options = vi.mocked(apiRequest).mock.calls[0][1];
    const wireBody = JSON.parse(JSON.stringify(options?.body));
    expect(wireBody).toEqual({ suppressAutoSubmit: true });
    await updateVisualAgentWorkspaceReal({ id: 'workspace', coverAssetId: null });
    expect(vi.mocked(apiRequest).mock.calls[1][1]?.body).toMatchObject({ coverAssetId: null });
  });

  it('自动投稿与用户明确手动重新投稿使用不同的触发来源', async () => {
    await autoSubmitImages(['asset']);
    expect(vi.mocked(apiRequest).mock.calls[0][1]?.body).toEqual({ imageAssetIds: ['asset'], trigger: 'auto' });
    await autoSubmitImages(['asset'], 'manual');
    expect(vi.mocked(apiRequest).mock.calls[1][1]?.body).toEqual({ imageAssetIds: ['asset'], trigger: 'manual' });
  });
});
