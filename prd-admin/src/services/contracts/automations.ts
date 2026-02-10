// 自动化规则服务契约

export interface AutomationAction {
  type: string; // 'webhook' | 'admin_notification'
  webhookUrl?: string;
  webhookSecret?: string;
  notifyUserIds?: string[];
  notifyLevel?: string; // 'info' | 'warning' | 'error'
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string; // 'event' | 'incoming_webhook'
  eventType: string;
  hookId?: string;
  actions: AutomationAction[];
  titleTemplate?: string;
  contentTemplate?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}

export interface ActionSummary {
  type: string;
  webhookUrl?: string;
  notifyUserCount: number;
  notifyLevel?: string;
}

export interface RuleListItem {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: string;
  eventType: string;
  hookId?: string;
  actions: ActionSummary[];
  titleTemplate?: string;
  contentTemplate?: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}

export interface PagedRulesResponse {
  items: RuleListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateRuleRequest {
  name: string;
  enabled: boolean;
  triggerType?: string;
  eventType?: string;
  actions: AutomationAction[];
  titleTemplate?: string;
  contentTemplate?: string;
}

export interface UpdateRuleRequest {
  name?: string;
  enabled?: boolean;
  eventType?: string;
  actions?: AutomationAction[];
  titleTemplate?: string;
  contentTemplate?: string;
}

export interface TriggerRuleRequest {
  eventType?: string;
  title?: string;
  content?: string;
  values?: string[];
}

export interface ActionExecuteResult {
  success: boolean;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

export interface AutomationTriggerResult {
  ruleId: string;
  ruleName: string;
  actionResults: ActionExecuteResult[];
  allSucceeded: boolean;
}

export interface EventTypeDef {
  eventType: string;
  category: string;
  label: string;
}

export interface ActionTypeDef {
  type: string;
  label: string;
  description: string;
}

export interface NotifyTarget {
  userId: string;
  displayName: string;
  username: string;
}

export interface IAutomationsService {
  listRules(page: number, pageSize: number, eventType?: string, enabled?: boolean, triggerType?: string): Promise<PagedRulesResponse>;
  getRule(id: string): Promise<AutomationRule>;
  createRule(request: CreateRuleRequest): Promise<AutomationRule>;
  updateRule(id: string, request: UpdateRuleRequest): Promise<void>;
  deleteRule(id: string): Promise<void>;
  toggleRule(id: string): Promise<{ enabled: boolean }>;
  regenerateHook(id: string): Promise<{ hookId: string }>;
  triggerRule(id: string, request: TriggerRuleRequest): Promise<AutomationTriggerResult>;
  getEventTypes(): Promise<EventTypeDef[]>;
  getActionTypes(): Promise<ActionTypeDef[]>;
  getNotifyTargets(): Promise<NotifyTarget[]>;
}
