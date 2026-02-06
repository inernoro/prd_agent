import type {
  IChannelService,
  PagedWhitelistResponse,
  PagedIdentityMappingResponse,
  PagedTaskResponse,
  PagedWorkflowResponse,
  ChannelWhitelist,
  ChannelIdentityMapping,
  ChannelTask,
  ChannelStatsResponse,
  ChannelTaskStats,
  CreateWhitelistRequest,
  UpdateWhitelistRequest,
  CreateIdentityMappingRequest,
  UpdateIdentityMappingRequest,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  EmailWorkflow,
  ChannelSettings,
  UpdateSettingsRequest,
  TestConnectionRequest,
  TestConnectionResult,
} from '../contracts/channels';
import { apiRequest } from './apiClient';
import { api } from '@/services/api';

export class ChannelService implements IChannelService {
  // ============ 邮箱配置 ============
  async getSettings(): Promise<ChannelSettings> {
    const response = await apiRequest<ChannelSettings>(api.channels.settings.get());
    if (!response.success) {
      throw new Error(response.error?.message || '获取邮箱配置失败');
    }
    return response.data!;
  }

  async updateSettings(request: UpdateSettingsRequest): Promise<ChannelSettings> {
    const response = await apiRequest<ChannelSettings>(api.channels.settings.update(), {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新邮箱配置失败');
    }
    return response.data!;
  }

  async testConnection(request: TestConnectionRequest): Promise<TestConnectionResult> {
    const response = await apiRequest<TestConnectionResult>(api.channels.settings.test(), {
      method: 'POST',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '测试连接失败');
    }
    return response.data!;
  }

  async triggerPoll(): Promise<{ success: boolean; message: string; emailCount?: number }> {
    const response = await apiRequest<{ success: boolean; message: string; emailCount?: number }>(
      api.channels.settings.poll(),
      {
        method: 'POST',
        body: {},
      }
    );
    if (!response.success) {
      throw new Error(response.error?.message || '触发轮询失败');
    }
    return response.data!;
  }

  // ============ 邮件工作流管理 ============
  async getWorkflows(page: number, pageSize: number): Promise<PagedWorkflowResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    const response = await apiRequest<PagedWorkflowResponse>(
      `${api.channels.workflows.list()}?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取工作流失败');
    }
    return response.data!;
  }

  async getWorkflow(id: string): Promise<EmailWorkflow> {
    const response = await apiRequest<EmailWorkflow>(api.channels.workflows.byId(id));
    if (!response.success) {
      throw new Error(response.error?.message || '获取工作流失败');
    }
    return response.data!;
  }

  async createWorkflow(request: CreateWorkflowRequest): Promise<EmailWorkflow> {
    const response = await apiRequest<EmailWorkflow>(api.channels.workflows.list(), {
      method: 'POST',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '创建工作流失败');
    }
    return response.data!;
  }

  async updateWorkflow(id: string, request: UpdateWorkflowRequest): Promise<EmailWorkflow> {
    const response = await apiRequest<EmailWorkflow>(api.channels.workflows.byId(id), {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新工作流失败');
    }
    return response.data!;
  }

  async deleteWorkflow(id: string): Promise<void> {
    const response = await apiRequest(api.channels.workflows.byId(id), {
      method: 'DELETE',
    });
    if (!response.success) {
      throw new Error(response.error?.message || '删除工作流失败');
    }
  }

  async toggleWorkflow(id: string): Promise<EmailWorkflow> {
    const response = await apiRequest<EmailWorkflow>(api.channels.workflows.toggle(id), {
      method: 'POST',
      body: {},
    });
    if (!response.success) {
      throw new Error(response.error?.message || '切换工作流状态失败');
    }
    return response.data!;
  }

  // ============ 白名单管理 ============
  async getWhitelists(
    page: number,
    pageSize: number,
    channelType?: string,
    search?: string
  ): Promise<PagedWhitelistResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    if (channelType) params.append('channelType', channelType);
    if (search) params.append('search', search);

    const response = await apiRequest<PagedWhitelistResponse>(
      `${api.channels.whitelists.list()}?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取白名单失败');
    }
    return response.data!;
  }

  async getWhitelist(id: string): Promise<ChannelWhitelist> {
    const response = await apiRequest<ChannelWhitelist>(api.channels.whitelists.byId(id));
    if (!response.success) {
      throw new Error(response.error?.message || '获取白名单失败');
    }
    return response.data!;
  }

  async createWhitelist(request: CreateWhitelistRequest): Promise<ChannelWhitelist> {
    const response = await apiRequest<ChannelWhitelist>(api.channels.whitelists.list(), {
      method: 'POST',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '创建白名单失败');
    }
    return response.data!;
  }

  async updateWhitelist(id: string, request: UpdateWhitelistRequest): Promise<ChannelWhitelist> {
    const response = await apiRequest<ChannelWhitelist>(api.channels.whitelists.byId(id), {
      method: 'PUT',
      body: request,
    });
    if (!response.success) {
      throw new Error(response.error?.message || '更新白名单失败');
    }
    return response.data!;
  }

  async deleteWhitelist(id: string): Promise<void> {
    const response = await apiRequest(api.channels.whitelists.byId(id), {
      method: 'DELETE',
    });
    if (!response.success) {
      throw new Error(response.error?.message || '删除白名单失败');
    }
  }

  async toggleWhitelist(id: string): Promise<ChannelWhitelist> {
    const response = await apiRequest<ChannelWhitelist>(api.channels.whitelists.toggle(id), {
      method: 'POST',
      body: {},
    });
    if (!response.success) {
      throw new Error(response.error?.message || '切换状态失败');
    }
    return response.data!;
  }

  // ============ 身份映射管理 ============
  async getIdentityMappings(
    page: number,
    pageSize: number,
    channelType?: string,
    search?: string
  ): Promise<PagedIdentityMappingResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    if (channelType) params.append('channelType', channelType);
    if (search) params.append('search', search);

    const response = await apiRequest<PagedIdentityMappingResponse>(
      `${api.channels.identityMappings.list()}?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取身份映射失败');
    }
    return response.data!;
  }

  async getIdentityMapping(id: string): Promise<ChannelIdentityMapping> {
    const response = await apiRequest<ChannelIdentityMapping>(
      api.channels.identityMappings.byId(id)
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取身份映射失败');
    }
    return response.data!;
  }

  async createIdentityMapping(
    request: CreateIdentityMappingRequest
  ): Promise<ChannelIdentityMapping> {
    const response = await apiRequest<ChannelIdentityMapping>(
      api.channels.identityMappings.list(),
      {
        method: 'POST',
        body: request,
      }
    );
    if (!response.success) {
      throw new Error(response.error?.message || '创建身份映射失败');
    }
    return response.data!;
  }

  async updateIdentityMapping(
    id: string,
    request: UpdateIdentityMappingRequest
  ): Promise<ChannelIdentityMapping> {
    const response = await apiRequest<ChannelIdentityMapping>(
      api.channels.identityMappings.byId(id),
      {
        method: 'PUT',
        body: request,
      }
    );
    if (!response.success) {
      throw new Error(response.error?.message || '更新身份映射失败');
    }
    return response.data!;
  }

  async deleteIdentityMapping(id: string): Promise<void> {
    const response = await apiRequest(api.channels.identityMappings.byId(id), {
      method: 'DELETE',
    });
    if (!response.success) {
      throw new Error(response.error?.message || '删除身份映射失败');
    }
  }

  // ============ 任务管理 ============
  async getTasks(
    page: number,
    pageSize: number,
    channelType?: string,
    status?: string,
    search?: string
  ): Promise<PagedTaskResponse> {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });
    if (channelType) params.append('channelType', channelType);
    if (status) params.append('status', status);
    if (search) params.append('search', search);

    const response = await apiRequest<PagedTaskResponse>(
      `${api.channels.tasks.list()}?${params.toString()}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取任务失败');
    }
    return response.data!;
  }

  async getTask(id: string): Promise<ChannelTask> {
    const response = await apiRequest<ChannelTask>(api.channels.tasks.byId(id));
    if (!response.success) {
      throw new Error(response.error?.message || '获取任务失败');
    }
    return response.data!;
  }

  async retryTask(id: string): Promise<ChannelTask> {
    const response = await apiRequest<ChannelTask>(api.channels.tasks.retry(id), {
      method: 'POST',
      body: {},
    });
    if (!response.success) {
      throw new Error(response.error?.message || '重试任务失败');
    }
    return response.data!;
  }

  async cancelTask(id: string): Promise<ChannelTask> {
    const response = await apiRequest<ChannelTask>(api.channels.tasks.cancel(id), {
      method: 'POST',
      body: {},
    });
    if (!response.success) {
      throw new Error(response.error?.message || '取消任务失败');
    }
    return response.data!;
  }

  // ============ 统计 ============
  async getStats(): Promise<ChannelStatsResponse> {
    const response = await apiRequest<ChannelStatsResponse>(api.channels.stats());
    if (!response.success) {
      throw new Error(response.error?.message || '获取统计失败');
    }
    return response.data!;
  }

  async getTaskStats(channelType?: string): Promise<ChannelTaskStats> {
    const params = channelType ? `?channelType=${channelType}` : '';
    const response = await apiRequest<ChannelTaskStats>(
      `${api.channels.tasks.stats()}${params}`
    );
    if (!response.success) {
      throw new Error(response.error?.message || '获取任务统计失败');
    }
    return response.data!;
  }
}
