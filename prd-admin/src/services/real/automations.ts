import { apiRequest } from './apiClient';
import type {
  IAutomationsService,
  PagedRulesResponse,
  AutomationRule,
  CreateRuleRequest,
  UpdateRuleRequest,
  TriggerRuleRequest,
  AutomationTriggerResult,
  EventTypeDef,
  ActionTypeDef,
} from '../contracts/automations';

const BASE = '/api/automations';

export class AutomationsService implements IAutomationsService {
  async listRules(page: number, pageSize: number, eventType?: string, enabled?: boolean, triggerType?: string): Promise<PagedRulesResponse> {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (eventType) params.append('eventType', eventType);
    if (enabled !== undefined) params.append('enabled', String(enabled));
    if (triggerType) params.append('triggerType', triggerType);
    const res = await apiRequest<PagedRulesResponse>(`${BASE}/rules?${params}`);
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async getRule(id: string): Promise<AutomationRule> {
    const res = await apiRequest<AutomationRule>(`${BASE}/rules/${id}`);
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async createRule(request: CreateRuleRequest): Promise<AutomationRule> {
    const res = await apiRequest<AutomationRule>(`${BASE}/rules`, { method: 'POST', body: request });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async updateRule(id: string, request: UpdateRuleRequest): Promise<void> {
    const res = await apiRequest(`${BASE}/rules/${id}`, { method: 'PUT', body: request });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
  }

  async deleteRule(id: string): Promise<void> {
    const res = await apiRequest(`${BASE}/rules/${id}`, { method: 'DELETE' });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
  }

  async toggleRule(id: string): Promise<{ enabled: boolean }> {
    const res = await apiRequest<{ enabled: boolean }>(`${BASE}/rules/${id}/toggle`, { method: 'POST' });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async regenerateHook(id: string): Promise<{ hookId: string }> {
    const res = await apiRequest<{ hookId: string }>(`${BASE}/rules/${id}/regenerate-hook`, { method: 'POST' });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async triggerRule(id: string, request: TriggerRuleRequest): Promise<AutomationTriggerResult> {
    const res = await apiRequest<AutomationTriggerResult>(`${BASE}/rules/${id}/trigger`, { method: 'POST', body: request });
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!;
  }

  async getEventTypes(): Promise<EventTypeDef[]> {
    const res = await apiRequest<{ items: EventTypeDef[] }>(`${BASE}/event-types`);
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!.items;
  }

  async getActionTypes(): Promise<ActionTypeDef[]> {
    const res = await apiRequest<{ items: ActionTypeDef[] }>(`${BASE}/action-types`);
    if (!res.success) throw new Error(res.error?.message || '请求失败');
    return res.data!.items;
  }
}
