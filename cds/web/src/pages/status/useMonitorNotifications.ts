import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { judgeAlarm } from '@/lib/alarmVerdict';
import type { UptimeSummary, UptimeTargetSummary } from '@/lib/monitorCenter';

export interface WorkspaceChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  projects: string[];
  events: string[];
}

export interface WorkspaceNotificationSettings {
  defaultChannelIds?: string[];
  overrides?: Record<string, string[]>;
  mutedUntil?: Record<string, number>;
  acknowledgedAt?: Record<string, number>;
}

export interface NotificationSnapshot {
  settings?: WorkspaceNotificationSettings;
  definitions?: WorkspaceChannel[];
  error: string;
  updateSettings: (settings: WorkspaceNotificationSettings) => void;
}

export function useWorkspaceNotifications(generatedAt: number): NotificationSnapshot {
  const [settings, setSettings] = useState<WorkspaceNotificationSettings>();
  const [definitions, setDefinitions] = useState<WorkspaceChannel[]>();
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const requestRevision = revision.current;
    void Promise.all([
      apiRequest<{ settings: WorkspaceNotificationSettings }>('/api/uptime/notifications', { signal: controller.signal }),
      apiRequest<{ channels: WorkspaceChannel[] }>('/api/cds-system/alarm-channels', { signal: controller.signal }),
    ]).then(([response, channels]) => {
      if (controller.signal.aborted) return;
      // A polling response started before a successful local save must not
      // restore the previous mute/acknowledgement selection.
      if (requestRevision === revision.current) setSettings(response.settings);
      setDefinitions(channels.channels);
      setError('');
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '通知设置读取失败，请重试。');
    });
    return () => controller.abort();
  }, [generatedAt]);
  return { settings, definitions, error, updateSettings: (value) => { revision.current++; setSettings(value); setError(''); } };
}

export function effectiveNotifications(snapshot: NotificationSnapshot, summary: UptimeSummary, target?: UptimeTargetSummary) {
  const known = snapshot.settings !== undefined && snapshot.definitions !== undefined && !snapshot.error;
  const channelIds = target ? snapshot.settings?.overrides?.[target.id] ?? snapshot.settings?.defaultChannelIds : snapshot.settings?.defaultChannelIds;
  const mutedUntil = target ? snapshot.settings?.mutedUntil?.[target.id] ?? 0 : 0;
  const selectedIds = new Set(snapshot.definitions?.filter((channel) => channel.enabled
    && (channelIds === undefined || channelIds.includes(channel.id))
    && (!target || ((!channel.projects.length || channel.projects.includes(target.projectId))
      && channel.events.includes(target.source === 'custom' ? 'business-down' : 'infra-down')))).map((channel) => channel.id));
  const channels = known ? summary.alarmChannels?.filter((channel) => selectedIds.has(channel.id)) ?? [] : [];
  const legacy = known && (channelIds === undefined || channelIds.includes('legacy-map')) ? summary.alarm : undefined;
  const verdict = known ? judgeAlarm(legacy, channels) : judgeAlarm(undefined, undefined);
  return { known, channelIds, mutedUntil, channels, legacy, verdict };
}
