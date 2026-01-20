import type {
  IOpenPlatformService,
  PagedAppsResponse,
  CreateAppRequest,
  CreateAppResponse,
  UpdateAppRequest,
  RegenerateKeyResponse,
  PagedLogsResponse,
} from '../contracts/openPlatform';
import { apiRequest } from './apiClient';

export class OpenPlatformService implements IOpenPlatformService {
  async getApps(page: number, pageSize: number, search?: string): Promise<PagedAppsResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    if (search) {
      params.append('search', search);
    }

    const response = await apiRequest<PagedAppsResponse>(
      `/api/open-platform/apps?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '请求失败');
    }
    return response.data!;
  }

  async createApp(request: CreateAppRequest): Promise<CreateAppResponse> {
    const response = await apiRequest<CreateAppResponse>('/api/open-platform/apps', {
      method: 'POST',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '创建失败');
    }
    return response.data!;
  }

  async updateApp(id: string, request: UpdateAppRequest): Promise<void> {
    const response = await apiRequest(`/api/open-platform/apps/${id}`, {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新失败');
    }
  }

  async deleteApp(id: string): Promise<void> {
    const response = await apiRequest(`/api/open-platform/apps/${id}`, {
      method: 'DELETE',
    });
    if (!response.success) {
      throw new Error(response.error?.message || '删除失败');
    }
  }

  async regenerateKey(id: string): Promise<RegenerateKeyResponse> {
    const response = await apiRequest<RegenerateKeyResponse>(
      `/api/open-platform/apps/${id}/regenerate-key`,
      {
        method: 'POST',
        body: {},
      }
    );
    if (!response.success) {
      throw new Error(response.error?.message || '重新生成失败');
    }
    return response.data!;
  }

  async toggleAppStatus(id: string): Promise<void> {
    const response = await apiRequest(`/api/open-platform/apps/${id}/toggle`, {
      method: 'POST',
      body: {},
    });
    if (!response.success) {
      throw new Error(response.error?.message || '切换状态失败');
    }
  }

  async getLogs(
    page: number,
    pageSize: number,
    appId?: string,
    startTime?: string,
    endTime?: string,
    statusCode?: number
  ): Promise<PagedLogsResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    if (appId) params.append('appId', appId);
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    if (statusCode !== undefined) params.append('statusCode', statusCode.toString());

    const response = await apiRequest<PagedLogsResponse>(
      `/api/open-platform/logs?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取日志失败');
    }
    return response.data!;
  }
}
