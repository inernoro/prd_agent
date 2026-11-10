import { monitorIncidentPath } from './monitor-incident-link.js';
import { createHash } from 'node:crypto';
import type { StateService } from './state.js';
import type { AlarmEvent } from './alarm-route.js';
import { NOTIFICATION_TEMPLATES, NOTIFICATION_CATEGORIES, NOTIFICATION_SYSTEMS, NOTIFICATION_ENVIRONMENTS, renderNotification, notificationFunction,
  type ReportClassification, type NotificationFacts, type NotificationTemplateId, type NotificationSystem } from '../shared/notification-templates.js';

export type { ReportMonitorEvent } from '../shared/notification-templates.js';
import type { ReportMonitorEvent } from '../shared/notification-templates.js';

export function alarmNotification(event: AlarmEvent) {
  const system = event.notificationFacts?.system || 'unknown';
  const facts: NotificationFacts = event.notificationFacts || { environment: 'unknown', system, function: notificationFunction(event.targetName) };
  const id: NotificationTemplateId = event.drill ? 'MSG-02' : event.kind.endsWith('-recovered') ? 'MON-03' : event.assessment === 'observation-unavailable' ? 'MON-02' : event.urgency === 'urgent' ? 'MON-01' : 'MON-04';
  const resolvedFacts = !event.drill && event.assessment === 'observation-unavailable' && event.kind.endsWith('-recovered') ? { ...facts, system: 'cds' as const, function: '监控读取' } : facts;
  return { id, facts: resolvedFacts, ...renderNotification(id, resolvedFacts, system) };
}

export function systemForProject(slug: string | undefined): NotificationSystem {
  return slug === 'prd-agent' || slug === 'map' ? 'map' : slug === 'llmgw' ? 'llmgw' : slug === 'cds' || slug === '__self__' || slug === 'cds-self' || slug === 'cds-self-monitor' ? 'cds' : slug ? 'other' : 'unknown';
}
function markdownText(value: string): string { return value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>|]/g, '\\$&'); }
function reportContent(name: string, classification: ReportClassification, monitor: ReportMonitorEvent): string {
  const labels = classification.categories.map(k => NOTIFICATION_CATEGORIES[k]).join('、');
  return `# ${markdownText(name)}\n\n${monitor.snapshots.at(-1)!.sentence}\n\n`
    + `类别：${labels}\n\n主体系统：${NOTIFICATION_SYSTEMS[classification.primarySystem]}；关联系统：${classification.relatedSystems.map(k => NOTIFICATION_SYSTEMS[k]).join('、') || '无'}\n\n`
    + `环境：${classification.environments.map(k => NOTIFICATION_ENVIRONMENTS[k]).join('、')}\n\n事件编号：${monitor.eventId}\n\n`
    + `[查看同一监控目标](${monitorIncidentPath(monitor.targetId, monitor.incidentId, monitor.snapshots[0]?.detectedAt)})\n\n## 发生与恢复记录\n\n`
    + monitor.snapshots.map(s => `- ${s.detectedAt}：${s.sentence}；连续失败检查 ${s.consecutiveFailedChecks} 次`).join('\n')
    + '\n\n统计口径为监控检查，不能据此推断上游调用次数或失败用户任务数。恢复记录追加保存，不覆盖发生时的事实。\n';
}

/** 复用报告对象存储；按监控目标串行归档，恢复追加同一事件，重复回调不增报告。 */
export class NotificationReportRecorder {
  private chains = new Map<string, Promise<unknown>>();
  constructor(private state: StateService) {}
  record(event: AlarmEvent): Promise<{ reportId: string; eventId: string }> {
    const key = JSON.stringify([event.projectId, event.targetId, event.notificationFacts?.environment, event.identity?.subject.id]);
    const task = (this.chains.get(key) || Promise.resolve()).catch(() => {}).then(() => this.save(event, key));
    this.chains.set(key, task);
    void task.finally(() => { if (this.chains.get(key) === task) this.chains.delete(key); }).catch(() => {});
    return task;
  }
  private async save(event: AlarmEvent, key: string) {
    const notification = alarmNotification(event);
    const subject = event.notificationFacts?.system || 'unknown';
    const recovered = event.kind.endsWith('-recovered');
    const project = this.state.getProject(event.projectId);
    const projectId = project?.id || null;
    const existing = this.state.listAcceptanceReports(projectId).filter(r => (r.projectId || null) === projectId && r.sourcePath === key && r.monitorEvent
      && !event.drill && r.monitorEvent.state !== 'drill')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const duplicate = existing.find(r => r.monitorEvent!.snapshots.some(s => s.detectedAt === event.detectedAt && s.kind === event.kind));
    if (duplicate) return { reportId: duplicate.id, eventId: duplicate.monitorEvent!.eventId };
    const previous = existing.find(r => r.monitorEvent!.state === 'open');
    // 未稳定恢复前的再次异常仍属于同一未关闭事件，避免冷却重报留下多个永久打开的报告。
    const appendTo = event.drill ? undefined : previous;
    const eventId = appendTo?.monitorEvent!.eventId || createHash('sha256').update(JSON.stringify([key, event.detectedAt, event.drill])).digest('hex');
    const classification: ReportClassification = { categories: [...NOTIFICATION_TEMPLATES[notification.id].categories],
      primarySystem: event.assessment === 'observation-unavailable' && !event.drill ? 'cds' : subject,
      relatedSystems: event.assessment === 'observation-unavailable' && subject !== 'cds' && !event.drill ? [subject] : [], environments: [notification.facts.environment] };
    const monitorEvent: ReportMonitorEvent = { incidentId: appendTo?.monitorEvent?.incidentId || event.incidentId, eventId, targetId: event.targetId || '', state: event.drill ? 'drill' : recovered ? 'recovered' : 'open',
      snapshots: [...(appendTo?.monitorEvent!.snapshots || []), { detectedAt: event.detectedAt, kind: event.kind,
        templateId: notification.id, sentence: notification.sentence, consecutiveFailedChecks: event.consecutiveFailures }] };
    const content = reportContent(event.targetName, classification, monitorEvent);
    const report = appendTo ? await this.state.updateAcceptanceReportAsync(appendTo.id, { content, classification, monitorEvent })
      : await this.state.createAcceptanceReportAsync({ title: notification.sentence, format: 'md', content, projectId,
        folderId: this.state.findOrCreateFolderPath(projectId, event.drill ? '通知系统/通知演练' : '监控事件'),
        classification, monitorEvent, sourceId: `monitor:${eventId}`, sourcePath: key, createdBy: 'monitor' });
    if (!report) throw new Error('监控事件报告未保存');
    return { reportId: report.id, eventId };
  }
}
