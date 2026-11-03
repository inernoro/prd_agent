import { beforeEach, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';
import { updateAgentApiKeyReal } from './agentApiKeys';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn().mockResolvedValue({ success: true, data: { item: null } }) }));
vi.mock('@/services/api', () => ({ api: { agentApiKeys: { update: (id: string) => `/api/agent-api-keys/${id}` } } }));
beforeEach(() => vi.clearAllMocks());

it.each([true, false])('PATCH 原样传输显式公开授权 %s，不预先序列化对象', async (enabled) => {
  await updateAgentApiKeyReal({ id: 'key/one', webPublicExposureAllowed: enabled, mcpDailyWriteQuota: 250 });
  expect(apiRequest).toHaveBeenCalledWith('/api/agent-api-keys/key%2Fone', {
    method: 'PATCH', body: expect.objectContaining({ webPublicExposureAllowed: enabled, mcpDailyWriteQuota: 250 }),
  });
});
it('普通设置 PATCH 不包含公开授权字段', async () => {
  await updateAgentApiKeyReal({ id: 'key', mcpDailyWriteQuota: 300 });
  const options = vi.mocked(apiRequest).mock.calls[0][1];
  expect(options?.body).not.toHaveProperty('webPublicExposureAllowed');
});
