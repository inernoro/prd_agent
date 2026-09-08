/**
 * GitHub webhook 噪声分流（2026-09-08 宿主过载复盘）。
 *
 * 线上 12 小时 8678 条投递里 91% 是 workflow_job / check_run / workflow_run /
 * check_suite 这类 CI 状态流。CDS 对它们**不做任何事**，却给每一条都走了完整的
 * 落盘链：state 全量 save（投递日志）+ 服务器事件 + 离机审计上传 + HTTP 日志，
 * 平均一条 442ms，合计约占 master 一成时间。
 *
 * 本模块只回答一个问题：这条投递是不是「收下即可、什么都不必记」的噪声。判定
 * 必须与 dispatcher 的真实动作一致（predicate-and-wiring 形状 3：同一个判断只在
 * 一处）：
 *   - 不在 SUPPORTED_EVENTS 里的事件（workflow_job / check_suite / status …）；
 *   - check_run 只有 `rerequested` 会触发重部署，其它 action 一律 ack；
 *   - workflow_run 只有 `completed` 才可能触发预构建镜像部署，其它 action 一律 ack。
 *
 * 噪声只在内存里计数，按需聚合成一条服务器事件（默认每 10 分钟至多一条），
 * 让「CI 噪声有多少、被压掉多少」仍然可观测，而不是每条都写一次库。
 */

export interface WebhookNoiseVerdict {
  noise: boolean;
  /** 给投递日志/响应用的原因短句；非噪声为 null */
  reason: string | null;
}

/** 与路由里的 SUPPORTED_EVENTS 保持一致（路由从这里 import，避免两份清单）。 */
export const WEBHOOK_SUPPORTED_EVENTS: ReadonlySet<string> = new Set([
  'ping',
  'push',
  'installation',
  'installation_repositories',
  'check_run',
  'pull_request',
  'issue_comment',
  'delete',
  'repository',
  'release',
  // 2026-06-23 极速版（CI 预构建）：监听 GitHub Actions 构建完成,据此按 commit SHA
  // 拉取预构建镜像部署（替代 CDS 本机编译）。
  'workflow_run',
]);

export function classifyWebhookNoise(
  eventName: string,
  payload: unknown,
): WebhookNoiseVerdict {
  if (!WEBHOOK_SUPPORTED_EVENTS.has(eventName)) {
    return { noise: true, reason: `event '${eventName}' 不在 CDS 处理范围` };
  }
  const action = typeof (payload as { action?: unknown })?.action === 'string'
    ? String((payload as { action: string }).action)
    : '';
  if (eventName === 'check_run' && action !== 'rerequested') {
    return { noise: true, reason: `check_run.${action || '?'} 不触发动作（只有 rerequested 会重部署）` };
  }
  if (eventName === 'workflow_run' && action !== 'completed') {
    return { noise: true, reason: `workflow_run.${action || '?'} 不触发动作（只处理 completed）` };
  }
  return { noise: false, reason: null };
}

export interface WebhookNoiseStats {
  /** 进程启动以来压掉的噪声总数 */
  suppressedTotal: number;
  /** 上次聚合上报以来压掉的数量 */
  suppressedSinceFlush: number;
  /**
   * 压掉的这些请求仍然消耗的 master 时间累计（毫秒，进程启动以来）。
   *
   * 廉价 ack 不写 HTTP 日志，于是它们从「按日志统计 webhook 耗时」的口径里整个消失。
   * 只看那个口径，改后必然显示大幅下降——但一部分下降只是因为不再观测（签名校验、
   * 读 body、路由这些活照做）。所以这里在内存里如实记账，度量尺拿它对齐口径
   * （Codex PR #1516 四轮 P2）。
   */
  suppressedDurationMs: number;
  byEvent: Record<string, number>;
  lastFlushAt: string | null;
}

const DEFAULT_FLUSH_INTERVAL_MS = 10 * 60 * 1000;

export class WebhookNoiseCounter {
  private total = 0;
  private sinceFlush = 0;
  private totalDurationMs = 0;
  private durationSinceFlush = 0;
  private byEvent = new Map<string, number>();
  private lastFlushAt: number | null = null;

  constructor(
    private readonly opts: {
      now?: () => number;
      flushIntervalMs?: number;
      /** 聚合上报出口；不接则只计数 */
      report?: (summary: { suppressed: number; durationMs: number; byEvent: Record<string, number> }) => void;
    } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /**
   * 记一条噪声；到点就把这段时间的聚合吐给 report（至多一条）。
   * `durationMs` 是这条请求在 master 里实际花掉的时间，不传按 0 记。
   */
  note(eventName: string, action?: string, durationMs = 0): void {
    this.total += 1;
    this.sinceFlush += 1;
    const spent = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    this.totalDurationMs += spent;
    this.durationSinceFlush += spent;
    const key = action ? `${eventName}.${action}` : eventName;
    this.byEvent.set(key, (this.byEvent.get(key) || 0) + 1);
    const interval = this.opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const now = this.now();
    if (this.lastFlushAt === null) {
      // 首条不上报，只起表：否则每次进程重启都会多一条「压掉 1 条」。
      this.lastFlushAt = now;
      return;
    }
    if (now - this.lastFlushAt >= interval) this.flush();
  }

  flush(): void {
    if (this.sinceFlush === 0) return;
    const byEvent: Record<string, number> = {};
    for (const [k, v] of this.byEvent) byEvent[k] = v;
    const suppressed = this.sinceFlush;
    const durationMs = Math.round(this.durationSinceFlush);
    this.sinceFlush = 0;
    this.durationSinceFlush = 0;
    this.byEvent.clear();
    this.lastFlushAt = this.now();
    this.opts.report?.({ suppressed, durationMs, byEvent });
  }

  stats(): WebhookNoiseStats {
    const byEvent: Record<string, number> = {};
    for (const [k, v] of this.byEvent) byEvent[k] = v;
    return {
      suppressedTotal: this.total,
      suppressedSinceFlush: this.sinceFlush,
      suppressedDurationMs: Math.round(this.totalDurationMs),
      byEvent,
      lastFlushAt: this.lastFlushAt === null ? null : new Date(this.lastFlushAt).toISOString(),
    };
  }
}
