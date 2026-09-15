/*
 * alarm-route —— 「哪些出问题通知谁」的判定层，纯函数。
 *
 * 这一层单独存在，是因为通知这件事有两个完全不同的问题混在一起，混着写就都写不对：
 *   1. **该不该通知**（这条事件落不落进这条通道的口径）—— 纯判定，可测，不碰网络；
 *   2. **怎么送出去**（Bark 的 URL 怎么拼、webhook 的 body 怎么渲染）—— 有副作用，在 alarm-dispatch。
 *
 * 判定层刻意不认识任何协议：它只回答「这条事件该发给哪几条通道」。于是加一种协议
 * 不会动到口径，改口径也不会动到协议。
 *
 * 另一条刻意为之的约束：**口径是有限枚举，不是表达式**。给一个「条件表达式」输入框
 * 看着更强，实际会立刻滑向自由文本解析器——下一轮就得加同义词、加嵌套、加转义
 * （CLAUDE.md 5.5 的熔断条件之一）。这里只有两个维度：哪些项目、哪几类事件，
 * 都是勾选。答不上来的需求宁可先不做，也不开那个口子。
 */
import type { ProbeSource, UptimeAlertEventType } from './uptime-monitor.js';

/** 通道协议。加一种就在这里加一个值，并在 alarm-dispatch 里补它的渲染。 */
export type AlarmChannelKind = 'bark' | 'webhook' | 'map';

/**
 * 事件类别。三类，按「要不要立刻起床」分，不按技术来源分。
 *
 * 业务故障与基础设施故障分开，是因为它们的下一步完全不同：业务挂了是用户现在用不了，
 * 容器挂了往往是分支预览在重建。把两者塞进同一个开关，等于逼人要么被预览刷屏、
 * 要么连真故障一起关掉——而多数人会选后者，那条铃就此变成摆设。
 */
export type AlarmEventKind = 'business-down' | 'infra-down' | 'recovered';

export const ALARM_EVENT_KINDS: ReadonlyArray<AlarmEventKind> = ['business-down', 'infra-down', 'recovered'];

export const ALARM_EVENT_LABEL: Record<AlarmEventKind, string> = {
  'business-down': '业务故障',
  'infra-down': '基础设施故障',
  recovered: '恢复',
};

export interface AlarmBarkConfig {
  /** 自建 Bark 服务器；留空走官方 */
  serverUrl?: string;
  key: string;
  group?: string;
  sound?: string;
  /** Bark 时效级别，见 BARK_LEVELS */
  level?: string;
  /** 重要告警响铃 30 秒 */
  call?: boolean;
}

export interface AlarmWebhookConfig {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  contentType?: string;
  /** 请求体模板，支持 {{title}} 这类占位符；GET 时忽略 */
  bodyTemplate?: string;
  /** 附加请求头。值里可以放密钥——所以读接口永远不回它们的值。 */
  headers?: Record<string, string>;
}

/** MAP 站内通知的四件套。与既有 AlarmNotifyConfig 同形，作为通道之一。 */
export interface AlarmMapConfig {
  endpoint: string;
  keyId: string;
  username: string;
  privateKey: string;
}

export interface AlarmChannelConfig {
  id: string;
  /** 给人看的名字：「我的手机」「运维群」。出现在面板与投递记录里。 */
  name: string;
  kind: AlarmChannelKind;
  enabled: boolean;
  /** 只通知这些项目；空数组 = 全部项目 */
  projects: string[];
  /** 通知哪几类事件。至少一项，写接口拒收空数组——静音要靠 enabled，不靠「一类都不选」。 */
  events: AlarmEventKind[];
  bark?: AlarmBarkConfig;
  webhook?: AlarmWebhookConfig;
  map?: AlarmMapConfig;
  createdAt: number;
  updatedAt: number;
}

/** 一条要发出去的事。已经过分类，协议层只认它，不认 uptime 的原始事件。 */
export interface AlarmEvent {
  kind: AlarmEventKind;
  projectId: string;
  targetName: string;
  /** 探测器给的原因，例如「HTTP 500」 */
  message: string;
  detectedAt: string;
  probeUrl?: string;
  consecutiveFailures: number;
}

/**
 * 把 uptime 的原始翻转事件分类。
 *
 * 用 `source` 这个**状态**判业务还是基础设施，不去切 targetId 的前缀：
 * 前缀是 id 生成函数的实现细节，在这里再解析一遍就是第二个判定源
 * （能用状态就用状态，拿不到状态才退回匹配字符串）。
 */
export function classifyAlert(type: UptimeAlertEventType, source: ProbeSource): AlarmEventKind {
  if (type === 'uptime.target.recovered') return 'recovered';
  return source === 'custom' ? 'business-down' : 'infra-down';
}

/**
 * 这条事件该发给哪几条通道。
 *
 * 三道闸依次收窄：开着的 → 订了这类事件的 → 管这个项目的。
 * 空项目列表表示「全部项目」——不是「一个都不要」，因为新建一条通道时最常见的
 * 意图就是「先什么都收着」，把它默认成静音会造出一条从落地那天起就不响的铃。
 */
export function routeAlarm(
  channels: ReadonlyArray<AlarmChannelConfig>,
  event: AlarmEvent,
): AlarmChannelConfig[] {
  return channels.filter((c) => {
    if (!c.enabled) return false;
    if (!c.events.includes(event.kind)) return false;
    if (c.projects.length > 0 && !c.projects.includes(event.projectId)) return false;
    return true;
  });
}

/** 一条渲染好的通知。协议层只管把它变成各自的请求，不再自己拼句子。 */
export interface AlarmMessage {
  title: string;
  body: string;
  /** 给 Bark 这类支持分级的协议；webhook 模板也能用 */
  level: 'critical' | 'active' | 'passive';
  /** 点通知跳到哪 —— 没有就没有，不编一个 */
  url?: string;
}

/**
 * 唯一的句子构造器。
 *
 * 三类事件不许各自拼字符串：那样「结论掉到第二句」「没给下一步」这类漏法会一条一条
 * 地犯，然后靠十几条守卫去抽查措辞（external-cause-first 第四节的原话）。
 * 顺序写死在这里：**谁出了什么事 → 要不要紧 → 下一步**，分支只填值。
 */
export function renderAlarmMessage(event: AlarmEvent, opts: { boardUrl?: string } = {}): AlarmMessage {
  const where = event.projectId ? `项目 ${event.projectId}` : '未归属项目';
  if (event.kind === 'recovered') {
    return {
      title: `${event.targetName} 恢复了`,
      body: `${where} · 探测已连续成功，这一条重新可用。无需处理。`,
      level: 'passive',
      ...(opts.boardUrl ? { url: opts.boardUrl } : {}),
    };
  }
  const isBusiness = event.kind === 'business-down';
  // 第一句就把「要不要紧」说完：业务挂了是用户现在用不了，基础设施挂了是服务本身没起来。
  const impact = isBusiness
    ? '用户现在用不了这条业务'
    : '这项基础设施没通，依赖它的业务随时会跟着挂';
  const times = event.consecutiveFailures > 1 ? `已连续 ${event.consecutiveFailures} 次` : '';
  return {
    title: `${event.targetName} 挂了`,
    body: [
      `${where} · ${impact}。`,
      `${times}判据未通过：${event.message}`,
      opts.boardUrl ? `去看：${opts.boardUrl}` : '',
    ].filter(Boolean).join(' '),
    level: isBusiness ? 'critical' : 'active',
    ...(opts.boardUrl ? { url: opts.boardUrl } : {}),
  };
}

/** 模板占位符。有限的一张表——模板里写别的名字就是原样留着，不静默变空。 */
export function alarmPlaceholders(event: AlarmEvent, message: AlarmMessage): Record<string, string> {
  return {
    title: message.title,
    body: message.body,
    level: message.level,
    url: message.url ?? '',
    projectId: event.projectId,
    targetName: event.targetName,
    message: event.message,
    detectedAt: event.detectedAt,
    kind: event.kind,
    probeUrl: event.probeUrl ?? '',
  };
}

/**
 * 这条通道的必填项齐了没有。
 *
 * 「齐没齐」必须是判定，不是感觉：半套凭据存进去只会在真出事那天以 401 的形式暴露，
 * 而那正是最不该出意外的时刻。面板上「铃通不通」那句话的第一档就读它。
 */
export function channelConfigured(channel: AlarmChannelConfig): boolean {
  if (channel.kind === 'bark') return Boolean(channel.bark?.key?.trim());
  if (channel.kind === 'webhook') return Boolean(channel.webhook?.url?.trim());
  const m = channel.map;
  return Boolean(m?.endpoint?.trim() && m.keyId?.trim() && m.username?.trim() && m.privateKey?.trim());
}

export const CHANNEL_KIND_LABEL: Record<AlarmChannelKind, string> = {
  bark: 'Bark 手机推送',
  webhook: 'Webhook（等价于一条 curl）',
  map: 'MAP 站内通知',
};
