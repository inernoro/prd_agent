import { describe, expect, it } from 'vitest';
import {
  buildNotificationPushDraftFromPreset,
  getSelectedNotificationPushPresetKey,
} from './NotificationSubscriptionsPanel';
import type { AdminPushPresetDefinition } from '@/services/contracts/notifications';

const presets: AdminPushPresetDefinition[] = [
  {
    key: 'bark-protocol',
    label: 'Bark 协议',
    channelType: 'bark',
    method: 'GET',
    urlTemplate: '',
    bodyTemplate: null,
    contentType: 'application/json',
  },
  {
    key: 'bark-url',
    label: 'URL 请求 / Bark',
    channelType: 'url',
    method: 'GET',
    urlTemplate: 'https://api.day.app/YOUR_KEY/MAP System-{{appname}}/{{message}}',
    bodyTemplate: null,
    contentType: 'application/json',
  },
  {
    key: 'generic-webhook',
    label: '通用 Webhook JSON',
    channelType: 'webhook',
    method: 'POST',
    urlTemplate: 'https://example.com/webhook',
    bodyTemplate: '{"title":"{{title}}","message":"{{message}}"}',
    contentType: 'application/json',
  },
];

describe('NotificationSubscriptionsPanel helpers', () => {
  it('keeps enabled state when applying a preset', () => {
    const draft = buildNotificationPushDraftFromPreset(presets[2], true);

    expect(draft.enabled).toBe(true);
    expect(draft.channelType).toBe('webhook');
    expect(draft.method).toBe('POST');
    expect(draft.bodyTemplate).toContain('{{message}}');
  });

  it('keeps user-provided URL templates as custom presets', () => {
    const draft = {
      ...buildNotificationPushDraftFromPreset(presets[1], true),
      urlTemplate: 'https://api.day.app/CUSTOM_KEY/MAP System-{{appname}}/{{message}}',
    };

    expect(getSelectedNotificationPushPresetKey(draft, presets)).toBe('custom');
  });

  it('supports Bark protocol with only a key as required input', () => {
    const draft = {
      ...buildNotificationPushDraftFromPreset(presets[0], true),
      barkKey: 'BARK_KEY',
    };

    expect(draft.channelType).toBe('bark');
    expect(draft.method).toBe('GET');
    expect(draft.barkServerUrl).toBe('https://api.day.app');
    expect(getSelectedNotificationPushPresetKey(draft, presets)).toBe('bark-protocol');
  });
});
