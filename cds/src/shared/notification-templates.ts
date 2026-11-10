import catalog from './notification-templates.json' with { type: 'json' };
/** 通知文案、分类名称和环境名称的唯一维护文件；服务端与报告中心共同消费。 */
export const NOTIFICATION_CATEGORIES = catalog.categories;
export const NOTIFICATION_SYSTEMS = catalog.systems;
export const NOTIFICATION_ENVIRONMENTS = catalog.environments;
export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export type NotificationSystem = keyof typeof NOTIFICATION_SYSTEMS;
export type NotificationEnvironment = keyof typeof NOTIFICATION_ENVIRONMENTS;
export interface ReportClassification {
  categories: NotificationCategory[];
  primarySystem: NotificationSystem;
  relatedSystems: NotificationSystem[];
  environments: NotificationEnvironment[];
}
export interface NotificationFacts {
  environment: NotificationEnvironment;
  system: NotificationSystem;
  function?: string;
  provider?: string;
  window?: string;
  count?: number;
  modelCount?: number;
  version?: string;
  total?: number;
  failed?: number;
  blocked?: number;
  task?: string;
  waitingFor?: string;
  shortTitle?: string;
  documentType?: string;
  resource?: string;
  days?: number;
  channel?: string;
}
interface Template {
  categories: NotificationCategory[];
  text: string;
  required?: Array<keyof NotificationFacts>;
}
export const NOTIFICATION_TEMPLATES = catalog.templates as unknown as { [K in keyof typeof catalog.templates]: Template };
export type NotificationTemplateId = keyof typeof NOTIFICATION_TEMPLATES;
export const UNKNOWN_CLASSIFICATION: ReportClassification = { categories: [], primarySystem: 'unknown', relatedSystems: [], environments: ['unknown'] };

/** 同维度 OR，跨维度 AND；每份报告始终只返回一次。 */
export function matchesClassification(value: ReportClassification | undefined, filters: { categories?: string[]; systems?: string[]; environments?: string[] }): boolean {
  const c = value || UNKNOWN_CLASSIFICATION;
  return (!filters.categories?.length || filters.categories.some(k => c.categories.includes(k as NotificationCategory)))
    && (!filters.systems?.length || filters.systems.some(k => [c.primarySystem, ...c.relatedSystems].includes(k as NotificationSystem)))
    && (!filters.environments?.length || filters.environments.some(k => c.environments.includes(k as NotificationEnvironment)));
}

/** 不从报告标题、发送服务器或 NODE_ENV 猜环境。预览绑定优先于声明。 */
export function notificationEnvironment(input: { previewBound?: boolean; declared?: string }): NotificationEnvironment {
  if (input.previewBound) return 'preview';
  if (Object.hasOwn(NOTIFICATION_ENVIRONMENTS, input.declared || '')) return input.declared as NotificationEnvironment;
  const label = Object.entries(NOTIFICATION_ENVIRONMENTS).find(([, label]) => label === input.declared)?.[0];
  return (label || (catalog.environmentAliases as Record<string, string>)[input.declared || ''] || 'unknown') as NotificationEnvironment;
}

export function parseReportClassification(raw: unknown): ReportClassification {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请提供类别、主体系统、关联系统和环境');
  const r = raw as Record<string, unknown>;
  function list<T extends string>(v: unknown, labels: Record<T, string>, field: string): T[] {
    if (!Array.isArray(v) || v.length > 20 || v.some(k => typeof k !== 'string' || !Object.hasOwn(labels, k))) throw new Error(`${field}包含未登记的分类`);
    return [...new Set(v)] as T[];
  }
  if (typeof r.primarySystem !== 'string' || !Object.hasOwn(NOTIFICATION_SYSTEMS, r.primarySystem)) throw new Error('请选择主体系统');
  const environments = list(r.environments, NOTIFICATION_ENVIRONMENTS, '环境');
  if (!environments.length) throw new Error('环境缺失时请选择环境待确认');
  return { categories: list(r.categories, NOTIFICATION_CATEGORIES, '类别'), primarySystem: r.primarySystem as NotificationSystem,
    relatedSystems: list(r.relatedSystems, NOTIFICATION_SYSTEMS, '关联系统').filter(k => k !== r.primarySystem), environments };
}

const UNSAFE_NOTIFICATION_TEXT = /[\r\n<>]|https?:|sk-|bearer\s|api[_-]?key|[\u0000-\u001f]/i;
export function notificationFunction(value: string | undefined): string {
  return value && Array.from(value).length <= 8 && !UNSAFE_NOTIFICATION_TEXT.test(value) ? value : '监控';
}

/** 只接收已确认、脱敏后的短事实；拒绝长原文、地址和凭据，不截断型号或数字。 */
export function renderNotification(id: NotificationTemplateId, facts: NotificationFacts, subject?: NotificationSystem): { title: string; body: string; sentence: string } {
  const template: Template = NOTIFICATION_TEMPLATES[id];
  if (!template) throw new Error('通知模板未登记');
  if (!Object.hasOwn(NOTIFICATION_ENVIRONMENTS, facts.environment) || !Object.hasOwn(NOTIFICATION_SYSTEMS, facts.system)) throw new Error('通知来源尚未确认');
  for (const [key, value] of Object.entries(facts)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || (value === 0 && key !== 'days'))) throw new Error('通知统计必须为已确认的正整数');
    if (typeof value === 'string' && (Array.from(value).length > 24 || UNSAFE_NOTIFICATION_TEXT.test(value))) throw new Error('通知请使用脱敏短名称');
  }
  for (const key of template.required || []) if (facts[key] === undefined || facts[key] === '') throw new Error(`通知缺少已确认事实：${key}`);
  if ((id === 'GW-06' || id === 'GW-07') && facts.system !== 'llmgw') throw new Error('价格用量通知的主体应为 LLMGW');
  const system = id === 'MON-02' ? 'cds' : facts.system;
  const title = `${NOTIFICATION_ENVIRONMENTS[facts.environment]} ${NOTIFICATION_SYSTEMS[system]}`;
  const body = template.text.replace(/\{(\w+)\}/g, (_, key: string) => key === 'subject'
    ? NOTIFICATION_SYSTEMS[subject || facts.system] : String(facts[key as keyof NotificationFacts] ?? '')).replace(/\s+/g, ' ').trim();
  const sentence = `${title} ${body}`;
  if (Array.from(sentence).length > 40) throw new Error('通知超过40字，请使用已登记的更短名称');
  return { title, body, sentence };
}

export interface MonitorEventSnapshot {
  detectedAt: string;
  kind: string;
  templateId: NotificationTemplateId;
  sentence: string;
  consecutiveFailedChecks: number;
}
export interface ReportMonitorEvent {
  incidentId?: string;
  eventId: string;
  targetId: string;
  state: 'open' | 'recovered' | 'drill';
  snapshots: MonitorEventSnapshot[];
}


export const NOTIFICATION_DIGEST = { ...catalog.digest, text: NOTIFICATION_TEMPLATES['MSG-01'].text };
export function renderNotificationDigest(facts: Array<NotificationFacts | undefined>, count: number) {
  const environments = new Set(facts.map(f => f?.environment || 'unknown'));
  const systems = new Set(facts.map(f => f?.system || 'unknown'));
  const title = `${environments.size === 1 ? NOTIFICATION_ENVIRONMENTS[[...environments][0]] : NOTIFICATION_DIGEST.mixedEnvironment} ${systems.size === 1 ? NOTIFICATION_SYSTEMS[[...systems][0]] : NOTIFICATION_DIGEST.mixedSystem}`;
  return { title, body: NOTIFICATION_DIGEST.text.replace('{count}', String(count)) };
}
