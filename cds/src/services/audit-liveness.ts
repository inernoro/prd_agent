import type { ServerEventLogSink } from './server-event-log-store.js';

/**
 * 周期自检的「活性」账本。
 *
 * ## 为什么要有
 *
 * 2026-08-18：暴露面自检的三条失败路径（读不到容器列表、任何一步抛异常）都只
 * `console.warn` 就返回。于是面板上「没跑成」和「跑了没问题」长得一模一样——
 * 最近一条结果被当成当前状态，而它其实是几小时前的快照。当天 CDS 重启三次，
 * 每次都该在启动两分钟后自检一次，却一条事件都没有，没有任何人发现。
 *
 * 直接后果：一个刚重建的容器到底收窄了没有，**至今无法回答**。
 *
 * ## 这里守的两件事
 *
 * 1. **失败必须落事件**。不落事件的失败等于没发生过，而「一个不会报错的自检」
 *    比没有自检更糟——它让人以为查过了。
 * 2. **「多久没成功过」要能看见**。单次失败可能只是抖动；连着一个完整周期都没
 *    成功，那就是这项自检已经哑了，严重程度不同，得升级。
 *
 * 判定是纯的，可以拿真实数值写回归；落事件的部分收在 {@link recordAuditFailure}，
 * 让接线守卫能数清楚「每条失败路径都报了」。
 */
export interface AuditLivenessSnapshot {
  /** 连续失败次数，成功一次归零。 */
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  /** 距上次成功多久；从没成功过则为 null。 */
  sinceLastSuccessMs: number | null;
  /**
   * 是否已经「哑了」——超过一个完整周期没有成功过。
   *
   * 从没成功过也算哑：一个刚启动就一直失败的自检，和一个跑过又坏掉的自检，
   * 对使用者是同一件事——**你现在看到的数据不可信**。
   */
  stale: boolean;
}

export class AuditLiveness {
  private failures = 0;
  private lastSuccess: number | null = null;

  constructor(
    /** 超过这个时长没成功就判「哑了」。传自检自己的周期即可。 */
    private readonly staleAfterMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  markSuccess(): void {
    this.failures = 0;
    this.lastSuccess = this.now();
  }

  markFailure(): AuditLivenessSnapshot {
    this.failures += 1;
    return this.snapshot();
  }

  snapshot(): AuditLivenessSnapshot {
    const since = this.lastSuccess === null ? null : this.now() - this.lastSuccess;
    return {
      consecutiveFailures: this.failures,
      lastSuccessAt: this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString(),
      sinceLastSuccessMs: since,
      // 从没成功过（since 为 null）且已经失败过 → 同样是哑的
      stale: this.failures > 0 && (since === null || since > this.staleAfterMs),
    };
  }
}

/**
 * 把一次自检失败如实记下来。
 *
 * 严重程度跟着活性走：偶发一次是 `warn`，连着一个周期没成功就升 `error`——
 * 前者是抖动，后者意味着「这项自检的结论已经不能信了」，两者不该长一个样。
 */
export function recordAuditFailure(opts: {
  store: ServerEventLogSink | null | undefined;
  liveness: AuditLiveness;
  /** 事件来源，与自检自身的 source 一致。 */
  source: string;
  /** 这一次为什么没跑成（读不到容器列表 / 异常信息）。 */
  reason: string;
  /** 给人看的一句话，说明这项自检是干什么的。 */
  what: string;
}): AuditLivenessSnapshot {
  const snap = opts.liveness.markFailure();
  const staleNote = snap.stale
    ? `；已连续 ${snap.consecutiveFailures} 次未成功，${snap.lastSuccessAt ? `上次成功在 ${snap.lastSuccessAt}` : '启动以来一次都没成功过'}，**当前结论不可信**`
    : '';
  opts.store?.record({
    category: 'system',
    severity: snap.stale ? 'error' : 'warn',
    source: opts.source,
    action: 'audit.run.failed',
    message: `${opts.what}没跑成：${opts.reason}${staleNote}`,
    status: snap.stale ? 'error' : 'warn',
    details: { ...snap, reason: opts.reason },
  });
  return snap;
}
