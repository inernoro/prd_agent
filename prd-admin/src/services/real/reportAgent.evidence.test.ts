import { beforeEach, describe, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./apiClient', () => ({ apiRequest: request, tryRefreshAdminToken: vi.fn() }));
import { getMyDailyDeliveryEvidenceReal } from './reportAgent';

beforeEach(() => { request.mockReset(); request.mockResolvedValue({ success: true, data: null }); });
describe('本日交付事实的真实客户端契约', () => {
  it('只使用当前用户的只读GET入口，不创建、生成或提交报告', async () => {
    await getMyDailyDeliveryEvidenceReal({ date: '2026-11-13' });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/api/report-agent/my/delivery-evidence?date=2026-11-13', { method: 'GET' });
  });
});
