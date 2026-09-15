/*
 * alarm-dispatch —— 把一条渲染好的通知真的送出去。
 *
 * 分工：判定（发给谁）在 alarm-route，这里只管协议。三种：
 *   bark     手机推送，一个 GET；自建服务器也走同一条路
 *   webhook  通用形状（method + url + headers + body 模板），等价于用户手里那条 curl
 *   map      MAP 站内通知，复用既有 MapNotifier 的签名通道
 *
 * 几条刻意的取舍：
 *
 * **不重试**。上游 uptime-monitor 只在状态翻转时调一次（去抖已经做过），
 * 重试会把一次翻转变成多条通知——一个会刷屏的铃，和一个不响的铃一样会被关掉。
 *
 * **任何异常都转成结果值**。通知发不出去不该拖垮探测轮次；但也绝不能静默——
 * 每一次投递都回一条带原因的记录，面板上「铃通不通」那句话的唯一数据源就是它。
 *
 * **只走 https、不跟随跳转**。CDS 管理员本来就能部署容器，谈不上提权，但让服务端
 * 照着一条可被改写的地址去请求，是白送出去的一条内网探路——`redirect: 'manual'` 拦掉。
 *
 * **模板按目的地转义**。同一个 `{{body}}`，进 URL 要 percent-encode，进 JSON 要
 * JSON 转义。一律当纯文本塞，第一条带引号的错误信息就会把 body 变成非法 JSON，
 * 而那时通道会以「400」的形式失败——排查的人会以为是对方接口的问题。
 */
import { MapNotifier } from './map-notifier.js';
import { alarmPlaceholders, renderAlarmMessage } from './alarm-route.js';
import type { AlarmChannelConfig, AlarmEvent, AlarmMessage } from './alarm-route.js';

export interface AlarmDeliveryResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

const DEFAULT_BARK_SERVER = 'https://api.day.app';
const DEFAULT_TIMEOUT_MS = 8000;

/** Bark 支持的时效级别。写别的它会忽略，所以这里先挡住。 */
export const BARK_LEVELS: ReadonlyArray<string> = ['critical', 'active', 'timeSensitive', 'passive'];

/**
 * 渲染模板。
 *
 * 占位符是有限的一张表（alarmPlaceholders）；表里没有的名字**原样留着**，
 * 不静默替换成空串——模板写错时看到 `{{titel}}` 立刻知道错在哪，
 * 看到一段空白则要查上半天。
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  escape: (raw: string) => string,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    (key in values ? escape(values[key] ?? '') : whole));
}

const asIs = (v: string): string => v;
const jsonEscape = (v: string): string => JSON.stringify(v).slice(1, -1);

export function buildBarkUrl(channel: AlarmChannelConfig, message: AlarmMessage): string {
  const bark = channel.bark;
  if (!bark) throw new Error('bark 通道缺少配置');
  const base = (bark.serverUrl || DEFAULT_BARK_SERVER).trim().replace(/\/+$/, '');
  const url = new URL(
    `${base}/${encodeURIComponent(bark.key.trim())}`
    + `/${encodeURIComponent(message.title)}/${encodeURIComponent(message.body)}`,
  );
  url.searchParams.set('group', bark.group?.trim() || 'CDS 监控');
  if (bark.sound?.trim()) url.searchParams.set('sound', bark.sound.trim());
  // 通道没钉死级别时用消息自己的级别：业务挂了该是 critical，恢复该是 passive。
  const level = bark.level?.trim() || message.level;
  if (BARK_LEVELS.includes(level)) url.searchParams.set('level', level);
  if (message.url) url.searchParams.set('url', message.url);
  if (bark.call) url.searchParams.set('call', '1');
  return url.toString();
}

async function httpSend(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<AlarmDeliveryResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'manual' });
    if (res.ok) return { ok: true, status: res.status };
    // 对方的响应体常常才是真原因（「key 不存在」），但它可能很长也可能含敏感内容——截断。
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, reason: `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}` };
  } catch (err) {
    const e = err as Error;
    return { ok: false, reason: e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 投递一条。
 *
 * 返回值永远是结果，不抛——调用方是探测循环，它不该因为一次通知失败而断掉。
 */
export async function sendAlarm(
  channel: AlarmChannelConfig,
  event: AlarmEvent,
  opts: { boardUrl?: string; timeoutMs?: number } = {},
): Promise<AlarmDeliveryResult> {
  const message = renderAlarmMessage(event, opts.boardUrl ? { boardUrl: opts.boardUrl } : {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (channel.kind === 'bark') {
      if (!channel.bark?.key?.trim()) return { ok: false, reason: 'Bark 通道没有填 key' };
      return await httpSend(buildBarkUrl(channel, message), { method: 'GET' }, timeoutMs);
    }

    if (channel.kind === 'webhook') {
      const hook = channel.webhook;
      if (!hook?.url?.trim()) return { ok: false, reason: 'Webhook 通道没有填地址' };
      const values = alarmPlaceholders(event, message);
      // 地址里的占位符要 percent-encode；漏了这一步，一条带 & 的错误信息会把后面的
      // query 参数整个改写掉——那是一次静默的语义篡改，不是一个显式的失败。
      const url = renderTemplate(hook.url, values, encodeURIComponent);
      const contentType = hook.contentType?.trim() || 'application/json';
      const headers: Record<string, string> = { ...(hook.headers ?? {}) };
      const init: { method: string; headers: Record<string, string>; body?: string } = {
        method: hook.method,
        headers,
      };
      if (hook.method !== 'GET') {
        const isJson = contentType.includes('json');
        const template = hook.bodyTemplate?.trim()
          || '{"title":"{{title}}","body":"{{body}}","level":"{{level}}","url":"{{url}}"}';
        headers['Content-Type'] = contentType;
        init.body = renderTemplate(template, values, isJson ? jsonEscape : asIs);
      }
      return await httpSend(url, init, timeoutMs);
    }

    const map = channel.map;
    if (!map?.endpoint || !map.keyId || !map.username || !map.privateKey) {
      return { ok: false, reason: 'MAP 通道的四项凭据没配齐' };
    }
    const notifier = new MapNotifier({
      endpoint: map.endpoint,
      keyId: map.keyId,
      username: map.username,
      privateKeyPem: map.privateKey,
      timeoutMs,
    });
    return await notifier.send({
      type: event.kind.endsWith('-recovered') ? 'uptime.target.recovered' : 'uptime.target.down',
      targetId: event.targetName,
      targetName: event.targetName,
      projectId: event.projectId,
      ...(event.probeUrl ? { probeUrl: event.probeUrl } : {}),
      message: event.message,
      consecutiveFailures: event.consecutiveFailures,
      detectedAt: event.detectedAt,
    });
  } catch (err) {
    // 兜底：上面每条路都已经把异常转成结果值了，走到这里说明有一条漏了。
    return { ok: false, reason: `未捕获的投递异常: ${(err as Error).message}` };
  }
}

/** 演练用的假事件。与真实投递走同一条路——只有同一条路才证明得了真出事时它会通。 */
export function drillEvent(now: number): AlarmEvent {
  return {
    kind: 'business-down',
    projectId: 'cds',
    targetName: '演练：一条假的业务监控',
    message: '这是一次演练，没有任何业务真的出问题',
    detectedAt: new Date(now).toISOString(),
    consecutiveFailures: 1,
  };
}
