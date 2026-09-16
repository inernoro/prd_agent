/*
 * alarm-channel —— 通知通道自己的健康状态。
 *
 * 为什么单独有这么一层：`void mapNotifier?.send(...)` 里那个 `?.` 是整条链最危险的
 * 一个字符。没配凭据时它是一次**静默的 no-op**——探测照跑、面板照绿、告警照样
 * 「发」了，只是没有任何人收到。启动日志里确实打了一句「不会有人被通知」，
 * 但没有任何一条验收会去读 CDS 的启动日志。
 *
 * 规则 degradation-must-alarm 原话：**静默禁用就是装了个永不会响的铃，
 * 那正是这条链路要治的病。** 这个文件就是那句话的判据：把「铃能不能响」
 * 和「上一次响得怎么样」变成面板读得到的字段，而不是只存在于 stdout。
 *
 * 刻意做成纯粹的内存状态机：
 *   - 不落库。它描述的是「此刻这个进程的通知能力」，进程换了就该重新证明一次；
 *   - 不重试、不排队。投递策略归 MapNotifier，这里只**记账**；
 *   - 没有「假设健康」的初始值：没配就是 unconfigured，没发过就是 never，
 *     两者都不许被渲染成「正常」。
 */

/** 通道当前能不能把铃送出去。 */
export type AlarmChannelStatus =
  /** 凭据没配齐 —— 出问题时不会有任何人被通知 */
  | 'unconfigured'
  /** 配好了，但这个进程还没真发过一次 —— 能不能送到仍然是未知数 */
  | 'untested'
  /** 最近一次投递成功 */
  | 'healthy'
  /** 最近一次投递失败 */
  | 'failing';

export interface AlarmDeliveryRecord {
  at: number;
  ok: boolean;
  /** 这次送的是什么：真告警还是演练 */
  kind: 'alert' | 'drill';
  /** 失败原因（成功时没有）。已由 MapNotifier 截断，不含密钥。 */
  reason?: string;
  status?: number;
}

export interface AlarmChannelSnapshot {
  status: AlarmChannelStatus;
  /** 通道名，给人看的（「MAP 站内通知」），不是 endpoint —— 地址不该出现在面板上 */
  channel: string;
  /** 这个进程投递成功过几次 */
  delivered: number;
  /** 失败几次 */
  failed: number;
  /** 最近一次投递的结果；从没发过时没有这个字段，**不许补一个假的** */
  last?: AlarmDeliveryRecord;
  /**
   * 没配齐时缺哪几个环境变量。
   *
   * 只出**变量名**，永远不出值——名字是配置线索，值是密钥。
   */
  missing?: string[];
}

/** MapNotifier 需要的四个环境变量。缺任何一个，铃就是哑的。 */
export const ALARM_ENV_KEYS = [
  'CDS_MAP_NOTIFY_ENDPOINT',
  'CDS_MAP_NOTIFY_KEY_ID',
  'CDS_MAP_NOTIFY_USERNAME',
  'CDS_MAP_NOTIFY_PRIVATE_KEY',
] as const;

/** 哪几个没配。返回**变量名**，不碰值。 */
export function missingAlarmEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return ALARM_ENV_KEYS.filter((key) => !(env[key] || '').trim());
}

/**
 * 通道记账本。
 *
 * `configured` 必须由构造方显式传入，**不给默认值**：默认 true 会让忘了接线的
 * 调用方拿到一个「看起来健康」的通道，那正是这个文件要防的事。
 */
export class AlarmChannel {
  private delivered = 0;
  private failed = 0;
  private last?: AlarmDeliveryRecord;

  /**
   * `configured` / `missing` 都是**取值函数**而不是快照。
   *
   * 配置随时可改；定死一个启动时的布尔值，会让「刚刚配好」和「压根没配」
   * 在面板上长得一模一样——那正是这个文件要防的那类静默。
   */
  constructor(
    private readonly configured: () => boolean,
    private readonly channel: string,
    private readonly missing: () => string[] = () => [],
  ) {}

  record(result: { ok: boolean; status?: number; reason?: string }, kind: 'alert' | 'drill', now: number): void {
    if (result.ok) this.delivered += 1;
    else this.failed += 1;
    this.last = {
      at: now,
      ok: result.ok,
      kind,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  snapshot(): AlarmChannelSnapshot {
    // 顺序就是严重度：没配 > 没测过 > 上次失败 > 健康。
    // 「没配」排最前是因为它连失败都不会有——最安静的那种坏。
    const missing = this.missing();
    const status: AlarmChannelStatus = !this.configured()
      ? 'unconfigured'
      : this.last === undefined
        ? 'untested'
        : this.last.ok ? 'healthy' : 'failing';
    return {
      status,
      channel: this.channel,
      delivered: this.delivered,
      failed: this.failed,
      ...(this.last ? { last: this.last } : {}),
      ...(status === 'unconfigured' && missing.length > 0 ? { missing } : {}),
    };
  }
}

/**
 * 面板上那句话。
 *
 * 判定口诀：**这句话念给没看过代码的人听，他知不知道「出事了会不会有人告诉他」？**
 * 每一档都必须能回答这个问题，所以四档一个都不能省成「未知」。
 */
export function describeAlarmChannel(snapshot: AlarmChannelSnapshot): string {
  switch (snapshot.status) {
    case 'unconfigured':
      return `出问题时不会有任何人被通知 —— ${snapshot.channel}的凭据没配齐`;
    case 'untested':
      return `${snapshot.channel}已接上，但这个进程还没真发过一次 —— 能不能送到仍然是未知数`;
    case 'failing':
      return `上一次通知没送出去：${snapshot.last?.reason || '原因不明'} —— 现在出问题也不会有人收到`;
    case 'healthy':
      return `${snapshot.channel}通着，已成功送出 ${snapshot.delivered} 次`;
  }
}

/**
 * 多通道的投递记账本。
 *
 * 与上面那个单通道 AlarmChannel 同一套语义（没配 > 没测过 > 上次失败 > 健康），
 * 只是按通道 id 分开记。刻意仍然不落库：它描述的是「此刻这个进程的通知能力」，
 * 进程换了就该重新证明一次——一条「上个月成功过」的记录，在今天出事时毫无意义。
 */
export interface AlarmChannelStatusView {
  id: string;
  name: string;
  kind: string;
  status: AlarmChannelStatus;
  delivered: number;
  failed: number;
  last?: AlarmDeliveryRecord;
  /** 这条通道订了哪几类事件、管哪些项目——面板要能一眼看出「谁会收到什么」 */
  events: string[];
  projects: string[];
  enabled: boolean;
}

interface LedgerEntry { delivered: number; failed: number; last?: AlarmDeliveryRecord }

/**
 * 「真的会响」的通道数——自监控与面板都用这一份判定。
 * 只看「配齐了」不够：最近一次投递（真告警或演练）失败的通道，台账已经标成 failing，
 * 自检若还把它算成活的，就是在铃已经哑了的时候报「1 条通道通着」（Codex #1543 P1）。
 * untested（配齐了、从没发过）算活：它没有失败的证据，只是还没被验证过。
 */
export function countLiveAlarmChannels(
  views: ReadonlyArray<{ enabled: boolean; status: AlarmChannelStatus }>,
  legacy: { status: AlarmChannelStatus } | null | undefined,
): number {
  const alive = (status: AlarmChannelStatus): boolean => status === 'healthy' || status === 'untested';
  return views.filter((v) => v.enabled && alive(v.status)).length + (legacy && alive(legacy.status) ? 1 : 0);
}

export class AlarmLedger {
  private readonly byId = new Map<string, LedgerEntry>();

  record(channelId: string, result: { ok: boolean; status?: number; reason?: string }, kind: 'alert' | 'drill', now: number): void {
    const entry = this.byId.get(channelId) ?? { delivered: 0, failed: 0 };
    if (result.ok) entry.delivered += 1;
    else entry.failed += 1;
    entry.last = {
      at: now,
      ok: result.ok,
      kind,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
    this.byId.set(channelId, entry);
  }

  forget(channelId: string): void {
    this.byId.delete(channelId);
  }

  view(channel: {
    id: string; name: string; kind: string; enabled: boolean;
    events: ReadonlyArray<string>; projects: ReadonlyArray<string>;
  }, configured: boolean): AlarmChannelStatusView {
    const entry = this.byId.get(channel.id);
    const status: AlarmChannelStatus = !configured
      ? 'unconfigured'
      : entry?.last === undefined
        ? 'untested'
        : entry.last.ok ? 'healthy' : 'failing';
    return {
      id: channel.id,
      name: channel.name,
      kind: channel.kind,
      status,
      delivered: entry?.delivered ?? 0,
      failed: entry?.failed ?? 0,
      ...(entry?.last ? { last: entry.last } : {}),
      events: [...channel.events],
      projects: [...channel.projects],
      enabled: channel.enabled,
    };
  }
}
