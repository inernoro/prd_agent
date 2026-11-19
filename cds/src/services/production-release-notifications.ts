import type { ReleaseTarget } from '../types.js';
import { cdsEventsBus, productionReleaseNotice } from './cds-events-bus.js';
import type { ReleaseLifecycleEventData } from './release-events.js';
import { normalizeReleaseEnvironment } from './release-environment.js';
import { renderNoticeFromEvent } from './notice-ledger.js';
import { systemForProject } from './notification-report.js';
import { routeAlarm, type AlarmChannelConfig, type AlarmEvent, type MonitorNotificationSettings } from './alarm-route.js';
import type { AlarmRelay } from './alarm-relay.js';

export function subscribeProductionReleaseNotifications(deps: {
  relay: Pick<AlarmRelay, 'owns' | 'enqueue'>;
  channels: () => AlarmChannelConfig[];
  settings: () => MonitorNotificationSettings;
  target: (id: string) => ReleaseTarget | undefined;
  projectSlug: (id: string) => string | undefined;
  publicBaseUrl?: string;
}): () => void {
  return cdsEventsBus.subscribe(envelope => {
    let data = envelope.data as ReleaseLifecycleEventData | undefined;
    if (!data?.releaseId || !data.targetId || !data.projectId) return;
    if (!data.targetEnvironment) {
      const target = deps.target(data.targetId);
      if (target?.projectId !== data.projectId) return;
      data = { ...data, targetEnvironment: normalizeReleaseEnvironment(target.environment), targetName: target.name };
    }
    const release = productionReleaseNotice(envelope.type, data);
    if (!release) return;
    const eventId = `${data.releaseId}:${envelope.type}`;
    const version = /^[a-f0-9]{7,64}$/i.test(data.commitSha) ? data.commitSha.slice(0, 12) : '版本待确认';
    const event: AlarmEvent = {
      kind: 'production-change', eventId, projectId: data.projectId, targetId: data.targetId,
      targetName: data.targetName || deps.projectSlug(data.projectId) || data.targetId,
      environmentLabel: '正式', releaseTemplate: release.template,
      notificationFacts: { environment: 'production', system: systemForProject(deps.projectSlug(data.projectId)), version },
      urgency: data.healthcheckFailed && !data.autoRestoredAt ? 'urgent' : 'normal',
      message: release.title, detectedAt: data.finishedAt || data.startedAt || envelope.ts,
      consecutiveFailures: 0,
    };
    const href = renderNoticeFromEvent({ ...envelope, data })?.href;
    const boardUrl = href && deps.publicBaseUrl ? new URL(href, deps.publicBaseUrl).href : undefined;
    for (const channel of routeAlarm(deps.channels(), event, deps.settings())) {
      if (channel.kind === 'bark' && deps.relay.owns(channel.id)) deps.relay.enqueue(channel.id, event, boardUrl);
    }
  });
}
