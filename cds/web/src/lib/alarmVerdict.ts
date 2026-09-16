/*
 * 「出问题会不会有人被通知」——这一句的唯一判定源。
 *
 * 它单独成文件、纯函数、有守卫，是因为 2026-09-15 面板上真的撒过一次谎：
 * Bark 通道已经配好、演练通过、状态 healthy，而面板底部那一行照旧写着
 * 「出问题时不会有任何人被通知」——它只认识早先那条单一 MAP 通道，看不见新配的。
 *
 * 一条**关于铃的谎**比没有这一行更糟：它会让人以为自己还没接，或者反过来以为
 * 接好了其实没有。所以判定必须把两个来源一起看，并且只许有这一份。
 */
import type { AlarmChannelView } from './monitorCenter';

/** 多通道里每一条的状态（服务端 AlarmChannelStatusView 的前端形状）。 */
export interface AlarmChannelStatus {
  id: string;
  name: string;
  kind: string;
  status: 'unconfigured' | 'untested' | 'healthy' | 'failing';
  delivered: number;
  failed: number;
  enabled: boolean;
  last?: { at: number; ok: boolean; kind: 'alert' | 'drill'; reason?: string; status?: number };
}

export type AlarmVerdictTone = 'ok' | 'warn' | 'bad' | 'unknown';

export interface AlarmVerdict {
  tone: AlarmVerdictTone;
  text: string;
  /** 真的会响的通道数（只数成功送出过的）。0 = 现在出问题没有任何人会知道。 */
  live: number;
}

/**
 * 合并判定。
 *
 * 顺序就是严重度，且**「有一条通着」永远压过「另一条没配」**——用户配了 Bark 就是
 * 接上了，不该因为那条早先的 MAP 通道空着就继续被告知「不会有人被通知」。
 * 反过来，一条都没有才是真的没有。
 */
export function judgeAlarm(
  legacy: AlarmChannelView | undefined,
  channels: ReadonlyArray<AlarmChannelStatus> | undefined,
): AlarmVerdict {
  // 两个来源都没有 = 这个实例压根没下发通道信息。**不知道**，不许说成「没配」。
  if (!legacy && !channels) {
    return { tone: 'unknown', live: 0, text: '通知通道状态未知 —— 这个实例没有下发通道信息，出问题时有没有人被通知，现在说不准' };
  }

  const list = (channels ?? []).filter((c) => c.enabled && c.status !== 'unconfigured');
  const legacyActive = legacy && legacy.status !== 'unconfigured';
  const active = list.length + (legacyActive ? 1 : 0);
  // 「通着」= 真的成功送出过一次。failing 与 untested 都不算——和服务端 countLiveAlarmChannels
  // 同一口径；之前把它们也数进 live，芯片写「1 条通道通着」而提示却说上一次没送出去（Codex #1543 P2）。
  const healthyList = list.filter((c) => c.status === 'healthy');
  const legacyHealthy = legacy?.status === 'healthy';
  const live = healthyList.length + (legacyHealthy ? 1 : 0);

  if (active === 0) {
    const missing = legacy?.missing?.length ? `（缺 ${legacy.missing.join('、')}）` : '';
    const configured = (channels ?? []).length;
    return {
      tone: 'bad',
      live: 0,
      text: configured > 0
        ? `出问题时不会有任何人被通知 —— ${configured} 条通道全都停用或没配齐`
        : `出问题时不会有任何人被通知 —— 一条通知通道都没配${missing}`,
    };
  }

  const failing = list.filter((c) => c.status === 'failing').length + (legacy?.status === 'failing' ? 1 : 0);
  const healthyNames = healthyList.map((c) => c.name).concat(legacyHealthy ? [legacy!.channel] : []).slice(0, 3).join('、');
  if (failing > 0) {
    // 还有通着的：是部分降级，不是全灭。说成「没人会收到」会和旁边「N 条通着」的计数打架（Codex #1543 P2）
    return live > 0
      ? { tone: 'warn', live, text: `${failing} 条通道上一次没送出去，仍有 ${live} 条通着（${healthyNames}）—— 出问题还有人会收到，但坏的那条要修` }
      : { tone: 'bad', live, text: `${failing} 条通道上一次没送出去 —— 现在出问题也可能没人收到` };
  }

  const untested = list.filter((c) => c.status === 'untested').length + (legacy?.status === 'untested' ? 1 : 0);
  if (live === 0) {
    return { tone: 'warn', live, text: `${active} 条通道已接上，但都还没真发过一次 —— 能不能送到仍然是未知数，点右边演练一次` };
  }

  const delivered = healthyList.reduce((n, c) => n + c.delivered, 0) + (legacyHealthy ? (legacy?.delivered ?? 0) : 0);
  return {
    tone: untested > 0 ? 'warn' : 'ok',
    live,
    text: `${live} 条通道通着（${healthyNames}）—— 已成功送出 ${delivered} 次${untested > 0 ? `，另有 ${untested} 条还没演练过` : ''}`,
  };
}
