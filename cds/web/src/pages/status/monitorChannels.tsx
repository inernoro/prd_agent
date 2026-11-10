import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '@/lib/api';

export type ChannelKind = 'bark' | 'webhook' | 'map';
export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  events: string[];
  projects: string[];
  bark?: { serverUrl: string; keySet: boolean; keyTail: string };
  webhook?: { url: string };
  map?: { username: string };
}
export interface ChannelStatus { id: string; status: string }
export interface NotificationSettings {
  defaultChannelIds?: string[];
  overrides?: Record<string, string[]>;
}
export interface ChannelsState { channels: Channel[]; status: ChannelStatus[]; settings: NotificationSettings }
export interface NotificationsPayload { settings: NotificationSettings; legacyChannel?: Channel & { status: string } }
const KIND_LABEL: Record<ChannelKind, string> = { bark: 'Bark', webhook: 'Webhook', map: 'MAP' };
const STATUS_LABEL: Record<string, string> = {
  healthy: '最近投递成功', failing: '上次未送达', untested: '尚未验证送达', unconfigured: '尚未配齐',
};

export function monitorErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作未完成，请重试；仍失败时请检查服务地址和访问权限。';
}

function destination(channel: Channel): string {
  if (channel.kind === 'map') return channel.map?.username || channel.name;
  if (channel.kind === 'bark') return channel.bark?.keySet ? `手机 · 尾号 ${channel.bark.keyTail}` : '尚未填写推送地址';
  try { return new URL(channel.webhook?.url || '').hostname; } catch { return '尚未填写接收地址'; }
}

/** Remove deleted IDs without changing empty selections or still-registered preferences. */
export function existingChannelIds(ids: readonly string[], channels: readonly Channel[]): string[] {
  const registered = new Set(channels.map((channel) => channel.id));
  return ids.filter((id) => registered.has(id));
}

export function channelState(channels: { channels: Channel[]; status: ChannelStatus[] }, notifications: NotificationsPayload): ChannelsState {
  const legacy = notifications.legacyChannel;
  const registry = legacy && !channels.channels.some((channel) => channel.id === legacy.id) ? [...channels.channels, legacy] : channels.channels;
  const settings = notifications.settings;
  return {
    channels: registry,
    status: legacy ? [...channels.status, { id: legacy.id, status: legacy.status }] : channels.status,
    settings: {
      ...settings,
      ...(settings.defaultChannelIds === undefined ? {} : { defaultChannelIds: existingChannelIds(settings.defaultChannelIds, registry) }),
      ...(settings.overrides === undefined ? {} : { overrides: Object.fromEntries(Object.entries(settings.overrides)
        .map(([targetId, ids]) => [targetId, existingChannelIds(ids, registry)])) }),
    },
  };
}

export function useChannels(): {
  data: ChannelsState | null; loading: boolean; error: string | null; reload(): Promise<void>;
} {
  const [data, setData] = useState<ChannelsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const [channels, settings] = await Promise.all([
        apiRequest<{ channels: Channel[]; status: ChannelStatus[] }>('/api/cds-system/alarm-channels'),
        apiRequest<NotificationsPayload>('/api/uptime/notifications'),
      ]);
      setData(channelState(channels, settings));
    } catch (e) { setError(monitorErrorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiRequest<{ channels: Channel[]; status: ChannelStatus[] }>('/api/cds-system/alarm-channels', { signal: controller.signal }),
      apiRequest<NotificationsPayload>('/api/uptime/notifications', { signal: controller.signal }),
    ]).then(([channels, settings]) => {
      setData(channelState(channels, settings));
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(monitorErrorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return { data, loading, error, reload };
}

function Switch({ checked, label, disabled, onChange }: {
  checked: boolean; label: string; disabled?: boolean; onChange(): void;
}): JSX.Element {
  return <button type="button" className={`sw${checked ? ' on' : ''}`} role="switch" aria-label={label}
    aria-checked={checked} disabled={disabled} onClick={onChange} />;
}

function ManageChannels({ onManage, disabled }: { onManage?(): void; disabled?: boolean }): JSX.Element {
  if (disabled) return <button type="button" className="btn ghost sm" disabled>管理通知通道</button>;
  return onManage
    ? <button type="button" className="btn ghost sm" onClick={onManage}>管理通知通道</button>
    : <Link className="btn ghost sm" to="/cds-settings#alarm-notify">管理通知通道</Link>;
}

export function ChannelFields({ data, selected, onToggle, onManage, projectId, disabled = false }: {
  data: ChannelsState; selected: string[]; onToggle(id: string): void; onManage?(): void; projectId?: string | null; disabled?: boolean;
}): JSX.Element {
  const projectMatches = (channel: Channel): boolean => projectId === undefined
    || channel.projects.length === 0 || (projectId !== null && channel.projects.includes(projectId));
  return <>
    <div className="fld"><span className="lbl2">通知谁</span>
      <div className="chips">{data.channels.map((channel) => <button type="button" key={channel.id}
        className={`chip tg${selected.includes(channel.id) && projectMatches(channel) ? ' on' : ''}`}
        aria-pressed={selected.includes(channel.id) && projectMatches(channel)}
        disabled={disabled || !channel.enabled || !projectMatches(channel)} onClick={() => onToggle(channel.id)}>{channel.name}</button>)}</div>
      {!data.channels.length && <p className="hint">还没有通知对象。先添加手机推送、群 Webhook 或 MAP 通知通道。</p>}
    </div>
    <div className="fld"><span className="lbl2">发到哪里</span>
      <div className="chrows">{data.channels.map((channel) => <div className="chrow" key={channel.id}>
        <span className="chn2">{KIND_LABEL[channel.kind]}</span>
        <span className="dest" title={channel.name}>{destination(channel)} · {!projectMatches(channel) ? '不适用于此项目' : channel.enabled
          ? STATUS_LABEL[data.status.find((item) => item.id === channel.id)?.status || 'untested'] || '状态未知' : '已停用'}</span>
        <Switch checked={selected.includes(channel.id) && projectMatches(channel)} disabled={disabled || !channel.enabled || !projectMatches(channel)} label={`通知到${channel.name}`}
          onChange={() => onToggle(channel.id)} />
      </div>)}</div>
      <div className="manage-channels"><ManageChannels onManage={onManage} disabled={disabled} /></div>
    </div>
  </>;
}
