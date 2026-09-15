/*
 * 守卫：通知通道。
 *
 * 这条链最常见的失败不是「发失败了」，是**根本没人去接**、或者接了一半。
 * 所以这里断言的重点有三块：口径判定（哪些出问题通知谁）、脱敏（密钥只写不读）、
 * 以及「留空 = 保持原值」——少了最后一条，每改一次名字都要把私钥重敲一遍，
 * 那种设计的结局是没人敢改。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyAlert, routeAlarm, renderAlarmMessage, channelConfigured, normalizeEventKind,
  type AlarmChannelConfig, type AlarmEvent,
} from '../../src/services/alarm-route.js';
import { buildBarkUrl, renderTemplate } from '../../src/services/alarm-dispatch.js';
import { parseChannel, publicChannel } from '../../src/routes/alarm-channels.js';

const NOW = 1_700_000_000_000;

function channel(over: Partial<AlarmChannelConfig> = {}): AlarmChannelConfig {
  return {
    id: 'c1', name: '我的手机', kind: 'bark', enabled: true,
    projects: [], events: ['business-down'],
    bark: { key: 'abcd1234' },
    createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}
const EVENT: AlarmEvent = {
  kind: 'business-down', projectId: 'map', targetName: 'MAP 后端',
  message: 'HTTP 500', detectedAt: new Date(NOW).toISOString(), consecutiveFailures: 3,
};

describe('哪些出问题通知谁', () => {
  it('业务与基础设施分开，看的是 source 这个状态', () => {
    expect(classifyAlert('uptime.target.down', 'custom')).toBe('business-down');
    expect(classifyAlert('uptime.target.down', 'branch')).toBe('infra-down');
  });

  /*
   * 2026-09-15 配第一条真通道时当场量出来的：第一版把「恢复」合成一档，而 CDS 实例上
   * 有 254 个分支预览目标，创建通道后 3 秒内就有 5 条推送打到手机。合并的那一档里
   * 业务的份额接近于零——它名义上叫「恢复」，实际是「分支预览重建播报」。
   */
  it('恢复也必须按来源拆，否则那一档实际是分支预览重建播报', () => {
    expect(classifyAlert('uptime.target.recovered', 'custom')).toBe('business-recovered');
    expect(classifyAlert('uptime.target.recovered', 'branch')).toBe('infra-recovered');
  });

  it('订了业务恢复的通道，收不到预览容器的恢复', () => {
    const c = channel({ events: ['business-recovered'] });
    expect(routeAlarm([c], { ...EVENT, kind: 'business-recovered' })).toHaveLength(1);
    expect(routeAlarm([c], { ...EVENT, kind: 'infra-recovered' })).toHaveLength(0);
  });

  // 旧订阅继续工作，但只升成「业务恢复」——把它静默扩成「连预览容器也推给你」，
  // 是替用户做了一个他没同意的扩张，而这个方向的错会直接变成刷屏。
  it('存量的不分来源 recovered 按业务恢复算，不静默扩成两档', () => {
    expect(normalizeEventKind('recovered')).toBe('business-recovered');
    const legacy = channel({ events: ['recovered' as never] });
    expect(routeAlarm([legacy], { ...EVENT, kind: 'business-recovered' })).toHaveLength(1);
    expect(routeAlarm([legacy], { ...EVENT, kind: 'infra-recovered' })).toHaveLength(0);
  });

  it('写接口收得下旧名字，存的是新名字', () => {
    const next = parseChannel({ kind: 'bark', name: 'x', events: ['recovered'], bark: { key: 'k' } }, undefined, NOW);
    expect(next.events).toEqual(['business-recovered']);
  });

  it('停用的通道一条都不发', () => {
    expect(routeAlarm([channel({ enabled: false })], EVENT)).toHaveLength(0);
  });

  it('没订这一类的不发', () => {
    expect(routeAlarm([channel({ events: ['business-recovered'] })], EVENT)).toHaveLength(0);
  });

  // 空项目列表 = 全部项目。默认成「一个都不要」会造出一条从落地那天起就不响的铃。
  it('空项目列表表示全部项目', () => {
    expect(routeAlarm([channel({ projects: [] })], EVENT)).toHaveLength(1);
    expect(routeAlarm([channel({ projects: ['other'] })], EVENT)).toHaveLength(0);
    expect(routeAlarm([channel({ projects: ['map'] })], EVENT)).toHaveLength(1);
  });
});

describe('通知正文', () => {
  // 唯一构造器：顺序写死为「谁出了什么事 → 要不要紧 → 下一步」，分支只填值。
  it('第一句就说清谁出事、要不要紧，并给下一步', () => {
    const m = renderAlarmMessage(EVENT, { boardUrl: 'https://cds.example.com/status' });
    expect(m.title).toContain('MAP 后端');
    expect(m.body).toContain('用户现在用不了');
    expect(m.body).toContain('已连续 3 次');
    expect(m.body).toContain('https://cds.example.com/status');
    expect(m.level).toBe('critical');
  });

  it('基础设施故障不冒充业务故障', () => {
    const m = renderAlarmMessage({ ...EVENT, kind: 'infra-down' });
    expect(m.body).toContain('依赖它的业务');
    expect(m.level).toBe('active');
  });

  it('恢复是 passive，并明说无需处理', () => {
    const m = renderAlarmMessage({ ...EVENT, kind: 'business-recovered' });
    expect(m.level).toBe('passive');
    expect(m.body).toContain('无需处理');
  });

  it('拿不到面板地址就不放 —— 不编一个点不开的链接', () => {
    expect(renderAlarmMessage(EVENT).url).toBeUndefined();
    expect(renderAlarmMessage(EVENT).body).not.toContain('去看');
  });
});

describe('模板按目的地转义', () => {
  it('JSON 体里带引号的消息不会把请求体弄成非法 JSON', () => {
    const body = renderTemplate('{"m":"{{message}}"}', { message: 'he said "hi"' },
      (v) => JSON.stringify(v).slice(1, -1));
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body).m).toBe('he said "hi"');
  });

  // 漏了这一步，一条带 & 的错误信息会把后面的 query 参数整个改写掉 —— 那是一次
  // 静默的语义篡改，不是一个显式的失败。
  it('URL 里的占位符会被 percent-encode', () => {
    const url = renderTemplate('https://x/?m={{message}}', { message: 'a&b=c' }, encodeURIComponent);
    expect(url).toBe('https://x/?m=a%26b%3Dc');
  });

  it('表里没有的占位符原样留着，不静默变空', () => {
    expect(renderTemplate('{{titel}}', { title: 'x' }, (v) => v)).toBe('{{titel}}');
  });
});

describe('Bark URL', () => {
  it('标题与正文进路径且转义，级别跟事件走', () => {
    const url = buildBarkUrl(channel(), renderAlarmMessage(EVENT));
    expect(url.startsWith('https://api.day.app/abcd1234/')).toBe(true);
    expect(url).toContain('level=critical');
    expect(url).toContain('group=');
    // 中文标题必须是转义过的，不能裸出现在 URL 里
    expect(url).not.toContain('MAP 后端');
  });

  it('通道钉死了级别就用通道的', () => {
    const url = buildBarkUrl(channel({ bark: { key: 'k', level: 'passive' } }), renderAlarmMessage(EVENT));
    expect(url).toContain('level=passive');
  });
});

describe('写接口', () => {
  it('必须至少勾一类事件 —— 静音靠开关，不靠清空事件', () => {
    expect(() => parseChannel({ kind: 'bark', name: 'x', events: [], bark: { key: 'k' } }, undefined, NOW))
      .toThrow(/至少勾一类事件/);
  });

  it('明文地址一律拒', () => {
    expect(() => parseChannel({ kind: 'webhook', name: 'x', events: ['business-down'], webhook: { url: 'http://x.com' } }, undefined, NOW))
      .toThrow(/https/);
  });

  it('已有通道不能改协议', () => {
    expect(() => parseChannel({ kind: 'webhook', name: 'x', events: ['business-down'], webhook: { url: 'https://x.com' } }, channel(), NOW))
      .toThrow(/不能改协议/);
  });

  // 读接口从不回密钥，所以前端也交不回来。强求必填 = 每改一次名字都要重敲一遍。
  it('留空的密钥保持原值', () => {
    const next = parseChannel({ kind: 'bark', name: '改了名', events: ['business-recovered'], bark: { key: '' } }, channel(), NOW);
    expect(next.bark?.key).toBe('abcd1234');
    expect(next.name).toBe('改了名');
    expect(next.id).toBe('c1');
    expect(next.createdAt).toBe(NOW);
  });

  it('请求头给空值表示删掉那一条', () => {
    const base = channel({
      kind: 'webhook', bark: undefined,
      webhook: { method: 'POST', url: 'https://x.com', headers: { Authorization: 'Bearer old', 'X-Keep': '1' } },
    });
    const next = parseChannel(
      { kind: 'webhook', name: 'x', events: ['business-down'], webhook: { url: 'https://x.com', headers: { Authorization: '' } } },
      base, NOW,
    );
    expect(next.webhook?.headers).toEqual({ 'X-Keep': '1' });
  });
});

describe('密钥只写不读', () => {
  it('Bark key 只回末四位', () => {
    const v = publicChannel(channel()) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(v)).not.toContain('abcd1234');
    expect(v.bark.keyTail).toBe('1234');
    expect(v.bark.keySet).toBe(true);
  });

  it('请求头只回名字不回值', () => {
    const v = publicChannel(channel({
      kind: 'webhook', bark: undefined,
      webhook: { method: 'POST', url: 'https://x.com', headers: { Authorization: 'Bearer secret-token' } },
    }));
    expect(JSON.stringify(v)).not.toContain('secret-token');
    expect(JSON.stringify(v)).toContain('Authorization');
  });

  it('MAP 私钥只回指纹', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----';
    const v = publicChannel(channel({ kind: 'map', bark: undefined, map: { endpoint: 'https://m', keyId: 'k', username: 'u', privateKey: pem } })) as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(v)).not.toContain('MIIsecret');
    expect(String(v.map.privateKeyFingerprint)).toHaveLength(16);
  });
});

describe('配齐了没有', () => {
  it('缺必填项就是没配齐 —— 半套凭据只会在真出事那天以 401 暴露', () => {
    expect(channelConfigured(channel())).toBe(true);
    expect(channelConfigured(channel({ bark: { key: '' } }))).toBe(false);
    expect(channelConfigured(channel({ kind: 'webhook', bark: undefined }))).toBe(false);
    expect(channelConfigured(channel({
      kind: 'map', bark: undefined,
      map: { endpoint: 'https://m', keyId: 'k', username: '', privateKey: 'p' },
    }))).toBe(false);
  });
});

/*
 * 接线守卫（形状 2：建好了没人调用，删掉也不会红）。
 *
 * 整个多通道体系可以一行不错地存在，却一条通知都发不出去——只要 onAlert 没接上它。
 * 而那种失败是完全静默的：面板照绿、通道列表照样列着，只是永远没有人收到。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('通知通道接上线了', () => {
  const index = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');

  it('告警事件真的被分类并派发到用户配的通道', () => {
    expect(index).toMatch(/classifyAlert\(type, data\.source\)/);
    expect(index).toMatch(/routeAlarm\(stateService\.listAlarmChannels\(\), event\)/);
    expect(index).toMatch(/sendAlarm\(channel, event/);
  });

  it('每一次投递都记账 —— 面板上「铃通不通」的唯一数据源', () => {
    expect(index).toMatch(/alarmLedger\.record\(channel\.id[^)]*'alert'/);
    // 成功与失败两条路都要记：只记一边会让失败静默消失。
    expect(index.match(/alarmLedger\.record\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('读写与演练的路由真的注册了', () => {
    expect(index).toContain('registerAlarmChannelRoutes(r, {');
  });

  it('通道状态跟着监控摘要下发', () => {
    expect(index).toMatch(/alarmChannels: \(\) => stateService\.listAlarmChannels\(\)/);
  });

  it('告警事件带上了 source —— 分类靠状态不靠切 id 前缀', () => {
    const monitor = readFileSync(fileURLToPath(new URL('../../src/services/uptime-monitor.ts', import.meta.url)), 'utf8');
    expect(monitor).toMatch(/source: target\.source,/);
  });
});
