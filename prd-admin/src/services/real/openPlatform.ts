import type {
  IOpenPlatformService,
  PagedAppsResponse,
  CreateAppRequest,
  CreateAppResponse,
  UpdateAppRequest,
  RegenerateKeyResponse,
  PagedLogsResponse,
  WebhookConfigResponse,
  UpdateWebhookConfigRequest,
  WebhookTestResponse,
  PagedWebhookLogsResponse,
} from '../contracts/openPlatform';
import { apiRequest } from './apiClient';
import { api } from '@/services/api';

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
      `${api.openPlatform.apps.list()}?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '请求失败');
    }
    return response.data!;
  }

  async createApp(request: CreateAppRequest): Promise<CreateAppResponse> {
    const response = await apiRequest<CreateAppResponse>(api.openPlatform.apps.list(), {
      method: 'POST',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '创建失败');
    }
    return response.data!;
  }

  async updateApp(id: string, request: UpdateAppRequest): Promise<void> {
    const response = await apiRequest(api.openPlatform.apps.byId(id), {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新失败');
    }
  }

  async deleteApp(id: string): Promise<void> {
    const response = await apiRequest(api.openPlatform.apps.byId(id), {
      method: 'DELETE',
    });
    if (!response.success) {
      throw new Error(response.error?.message || '删除失败');
    }
  }

  async regenerateKey(id: string): Promise<RegenerateKeyResponse> {
    const response = await apiRequest<RegenerateKeyResponse>(
      `${api.openPlatform.apps.byId(id)}/regenerate-key`,
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
    const response = await apiRequest(api.openPlatform.apps.toggle(id), {
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

  // ========== Webhook 配置 ==========

  async getWebhookConfig(appId: string): Promise<WebhookConfigResponse> {
    const response = await apiRequest<WebhookConfigResponse>(
      `${api.openPlatform.apps.byId(appId)}/webhook`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取 Webhook 配置失败');
    }
    return response.data!;
  }

  async updateWebhookConfig(appId: string, request: UpdateWebhookConfigRequest): Promise<void> {
    const response = await apiRequest(`${api.openPlatform.apps.byId(appId)}/webhook`, {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新 Webhook 配置失败');
    }
  }

  async testWebhook(appId: string): Promise<WebhookTestResponse> {
    const response = await apiRequest<WebhookTestResponse>(
      `${api.openPlatform.apps.byId(appId)}/webhook/test`,
      {
        method: 'POST',
        body: {},
      }
    );
    if (!response.success) {
      throw new Error(response.error?.message || '测试 Webhook 失败');
    }
    return response.data!;
  }

  async getWebhookLogs(appId: string, page: number, pageSize: number): Promise<PagedWebhookLogsResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    const response = await apiRequest<PagedWebhookLogsResponse>(
      `${api.openPlatform.apps.byId(appId)}/webhook/logs?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取 Webhook 日志失败');
    }
    return response.data!;
  }
}
