import type { ApiResponse } from '@/types/api';
import type {
  ModelTestStub,
  UpsertTestStubRequest,
  SimulateDowngradeRequest,
  SimulateRecoverRequest,
  GroupMonitoring,
} from '../../types/modelTest';
import type { IModelTestService } from '../contracts/modelTest';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class ModelTestService implements IModelTestService {
  async getTestStubs(): Promise<ApiResponse<ModelTestStub[]>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.stubs.list()}`, {
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`获取测试桩失败: ${res.status}`);
    }

    return res.json();
  }

  async upsertTestStub(
    request: UpsertTestStubRequest
  ): Promise<ApiResponse<ModelTestStub>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.stubs.list()}`, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`创建/更新测试桩失败: ${res.status}`);
    }

    return res.json();
  }

  async deleteTestStub(id: string): Promise<ApiResponse<{ id: string }>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.stubs.byId(id)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`删除测试桩失败: ${res.status}`);
    }

    return res.json();
  }

  async clearTestStubs(): Promise<
    ApiResponse<{ deletedCount: number; message: string }>
  > {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.stubs.clear()}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`清空测试桩失败: ${res.status}`);
    }

    return res.json();
  }

  async simulateDowngrade(
    request: SimulateDowngradeRequest
  ): Promise<ApiResponse<object>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.simulate.downgrade()}`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`模拟降权失败: ${res.status}`);
    }

    return res.json();
  }

  async simulateRecover(
    request: SimulateRecoverRequest
  ): Promise<ApiResponse<object>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.simulate.recover()}`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`模拟恢复失败: ${res.status}`);
    }

    return res.json();
  }

  async triggerHealthCheck(): Promise<ApiResponse<{ message: string }>> {
    const res = await fetch(`${API_BASE}${api.lab.modelTest.healthCheck()}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    if (!res.ok) {
      throw new Error(`触发健康检查失败: ${res.status}`);
    }

    return res.json();
  }

  async getGroupMonitoring(
    groupId: string
  ): Promise<ApiResponse<GroupMonitoring>> {
    const res = await fetch(
      `${API_BASE}${api.lab.modelTest.groupMonitoring(groupId)}`,
      {
        headers: getAuthHeaders(),
      }
    );

    if (!res.ok) {
      throw new Error(`获取监控数据失败: ${res.status}`);
    }

    return res.json();
  }
}
