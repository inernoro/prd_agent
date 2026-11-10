import { describe, expect, it } from 'vitest';
import { channelState, existingChannelIds, type Channel } from '../../web/src/pages/status/monitorChannels';

const channels: Channel[] = [
  { id: 'phone', name: '值班手机', kind: 'bark', enabled: true, events: ['business-down'], projects: [] },
  { id: 'paused', name: '暂时停用的群', kind: 'webhook', enabled: false, events: ['business-down'], projects: ['project-a'] },
];

describe('共享通知选择保留真实 API 的默认与覆盖语义', () => {
  it('旧状态中的已删除通道会被过滤，但已注册停用通道不会被丢弃', () => {
    const input = {
      settings: {
        defaultChannelIds: ['removed', 'paused'],
        overrides: { 'service-a': ['phone', 'removed'], 'service-b': [] },
      },
    };
    const result = channelState({ channels, status: [] }, input);
    expect(result.settings).toEqual({ defaultChannelIds: ['paused'], overrides: { 'service-a': ['phone'], 'service-b': [] } });
    expect(input.settings.defaultChannelIds).toEqual(['removed', 'paused']);
    expect(input.settings.overrides['service-a']).toEqual(['phone', 'removed']);
  });

  it('继承默认的 undefined 与明确不通知的空数组始终不同', () => {
    const inherited = channelState({ channels, status: [] }, { settings: {} });
    const silent = channelState({ channels, status: [] }, { settings: { defaultChannelIds: [], overrides: { 'service-a': [] } } });
    expect(Object.hasOwn(inherited.settings, 'defaultChannelIds')).toBe(false);
    expect(Object.hasOwn(inherited.settings, 'overrides')).toBe(false);
    expect(silent.settings).toEqual({ defaultChannelIds: [], overrides: { 'service-a': [] } });
  });

  it('真实 legacy MAP 通道被并入注册表，保存时不会误删其既有选择', () => {
    const result = channelState({ channels, status: [] }, {
      settings: { defaultChannelIds: ['legacy-map'] },
      legacyChannel: { id: 'legacy-map', name: 'MAP 兼容通知', kind: 'map', enabled: true, events: ['business-down'], projects: [], status: 'healthy' },
    });
    expect(result.channels.map(channel => channel.id)).toEqual(['phone', 'paused', 'legacy-map']);
    expect(existingChannelIds(result.settings.defaultChannelIds!, result.channels)).toEqual(['legacy-map']);
    expect(result.status).toContainEqual({ id: 'legacy-map', status: 'healthy' });
  });
});
