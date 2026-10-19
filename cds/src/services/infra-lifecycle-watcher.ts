// Infra 容器生命周期取证器（doc/debt.cds.md「CDS 复制集模式工程债务」 #17，2026-07-24）
//
// 背景：复制集六轮验收中共享 mongod 四次「Detected unclean shutdown」，但平台
// 日志通道 tail 500 行被重启后的清理日志秒级刷满，OOM 与否、谁发的 SIGKILL
// 完全无法事后取证——每次只能靠外部监护脚本抓时间线。
//
// 本服务常驻监听 `docker events`（oom / die / kill / start / restart），把
// infra 容器（名称前缀 cds-infra-）的生命周期事件落入内存环形缓冲 + 服务器
// 事件日志。关键取证信号：
//   - `oom` 事件出现        → cgroup 级 OOM kill（容器内存上限触发）
//   - `die` exitCode=137 无可靠关联 → 原因待核实，不能凭缺失事件排除 OOM
//   - `die` 其他 exitCode   → 进程自身退出（panic / ENOSPC / bug）
import { DockerObservationEventStream } from './docker-observation-event-stream.js';
import type { ObservationStreamExecutor } from './observation-stream-executor.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export interface InfraLifecycleEvent {
  ts: string;
  containerName: string;
  containerId?: string;
  event: string;
  exitCode?: string;
  signal?: string;
}

const RING_LIMIT = 400;
/**
 * cgroup OOM 的 `oom` 与随后的 `die`(exitCode=137) 之间的关联窗口。docker 这两条
 * 事件通常间隔毫秒级；给到 10s 足以覆盖事件流抖动，又不至于把十几秒后一次无关的
 * 外部 SIGKILL 误归因成 OOM。
 */
const OOM_CORRELATION_WINDOW_MS = 10_000;
// 不依赖名称或固定 hex 格式；只保留 Docker 提供的有界实际身份。
function boundedContainerId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 128
    ? value : undefined;
}

// 模块级单例访问点：路由层（infra-data）零依赖注入即可读事件
let activeWatcher: InfraLifecycleWatcher | null = null;
export function getActiveInfraLifecycleWatcher(): InfraLifecycleWatcher | null {
  return activeWatcher;
}

/**
 * 副本成员死亡监听（2026-07-26）：取证器看到 cds-*-res-N 的 die 事件时回调，
 * 由 server.ts 注册到 ReplicaSetService.noteMemberContainerDeath——running 副本
 * 意外死亡秒级标 error 摘流，不等周期对账（死端口多接一秒流量就是一秒 503）。
 * 模块级注册避免 watcher（index.ts 构造）与 ReplicaSetService（server.ts 构造）
 * 之间的跨文件依赖注入。
 */
type ReplicaMemberDeathListener = (containerName: string, verdict: string) => void;
let replicaMemberDeathListener: ReplicaMemberDeathListener | null = null;
export function setReplicaMemberDeathListener(fn: ReplicaMemberDeathListener | null): void {
  replicaMemberDeathListener = fn;
}

export class InfraLifecycleWatcher {
  private readonly eventStream?: DockerObservationEventStream;
  private started = false;
  private events: InfraLifecycleEvent[] = [];
  /** 实际容器 ID → 本次进程代次最近的 OOM；严格受 RING_LIMIT 约束。 */
  private recentOom = new Map<string, number>();
  constructor(private readonly deps: { serverEventLogStore?: ServerEventLogSink | null; streams?: ObservationStreamExecutor } = {}) {
    if (deps.streams) this.eventStream = new DockerObservationEventStream(deps.streams,
      ['events', '--format', '{{json .}}', '--filter', 'type=container', ...['oom', 'die', 'kill', 'start', 'restart'].flatMap(event => ['--filter', `event=${event}`])],
      line => this.ingest(line),
      reason => {
        // 断流、丢行或处理未确认后，缺口中可能发生过同 ID 重启。
        // 没有连续观测证据，不能沿用缺口前的 OOM 归因。
        this.recentOom.clear();
        this.deps.serverEventLogStore?.record({ category: 'container', severity: 'warn', source: 'infra-lifecycle-watcher', action: 'infra.monitor.warning', message: reason });
      });
  }
  start(): void {
    activeWatcher = this;
    if (this.started) return;
    this.started = true;
    this.recentOom.clear();
    if (!this.eventStream) {
      this.deps.serverEventLogStore?.record({ category: 'container', severity: 'warn', source: 'infra-lifecycle-watcher', action: 'infra.monitor.unavailable', message: '事件读取执行器未配置，无法确认基础设施事件。' });
      return;
    }
    this.eventStream.start();
  }
  stop(): Promise<void> {
    this.started = false;
    this.recentOom.clear();
    return this.eventStream?.stop() ?? Promise.resolve();
  }

  /** 指定容器（或全部 infra）的近期生命周期事件，新→旧。 */
  getEvents(containerName?: string): InfraLifecycleEvent[] {
    const list = containerName
      ? this.events.filter((e) => e.containerName === containerName)
      : this.events;
    return [...list].reverse();
  }

  private ingest(line: string): void {
    let parsed: { status?: string; Action?: string; time?: number; id?: unknown; Actor?: { ID?: unknown; Attributes?: Record<string, string> } };
    try {
      parsed = JSON.parse(line);
    } catch {
      this.recentOom.clear();
      return;
    }
    const name = parsed.Actor?.Attributes?.name || '';
    // 取证范围：基础设施容器（cds-infra-*）+ 复制集成员容器（cds-*-res-N）。
    // 2026-07-25 用户问「副本为什么会失败」时成员已被还原、死因无从尸检——
    // 把成员纳入取证后，下次副本死亡会留下 oom/die/exitCode 证据。
    const isInfra = name.startsWith('cds-infra-');
    const isReplicaMember = name.startsWith('cds-') && /-res-\d+$/.test(name);
    if (!isInfra && !isReplicaMember) return;
    const containerId = boundedContainerId(parsed.Actor?.ID) ?? boundedContainerId(parsed.id);
    const event: InfraLifecycleEvent = {
      ts: parsed.time ? new Date(parsed.time * 1000).toISOString() : new Date().toISOString(),
      containerName: name,
      ...(containerId ? { containerId } : {}),
      event: parsed.Action || parsed.status || 'unknown',
      exitCode: parsed.Actor?.Attributes?.exitCode,
      signal: parsed.Actor?.Attributes?.signal,
    };
    this.events.push(event);
    if (this.events.length > RING_LIMIT) this.events = this.events.slice(-RING_LIMIT);
    const now = Date.parse(event.ts);
    for (const [id, at] of this.recentOom) {
      if (now - at > OOM_CORRELATION_WINDOW_MS) this.recentOom.delete(id);
    }
    // 容器重启后即使 ID 不变，旧进程的 OOM 也不能归因给新进程。
    if (containerId && (event.event === 'start' || event.event === 'restart')) this.recentOom.delete(containerId);
    // 死亡/OOM 类事件同步落服务器事件日志（可跨重启追溯）
    if (event.event === 'oom' || event.event === 'die') {
      // cgroup OOM 的真实序列是 `oom` 紧跟一条 exitCode=137 的 `die`（Codex 第二十七轮 P2）。
      // 此前两条各判各的：第一条判 cgroup OOM、第二条判「外部 SIGKILL，容器无 oom 事件」——
      // 同一次死亡留下两条互相矛盾的证据，而这正是本取证器唯一要回答的问题。
      // 同 ID 且未跨 start/restart 的近期证据才能关联；淘汰表示未知。
      if (event.event === 'oom' && containerId) {
        this.recentOom.delete(containerId);
        if (this.recentOom.size >= RING_LIMIT) this.recentOom.delete(this.recentOom.keys().next().value!);
        this.recentOom.set(containerId, now);
      }
      const oomAt = containerId ? this.recentOom.get(containerId) : undefined;
      const oomCorrelated = typeof oomAt === 'number' && now - oomAt >= 0 && now - oomAt <= OOM_CORRELATION_WINDOW_MS;
      const verdict = event.event === 'oom'
        ? 'cgroup OOM kill'
        : event.exitCode === '137'
          ? (oomCorrelated
            ? 'cgroup OOM kill（同容器刚收到 oom 事件，exitCode=137 是其后续 die）'
            : 'SIGKILL（exitCode=137，原因待核实：未保留同容器同进程代次的近期 OOM 关联证据）')
          : `进程自身退出（exitCode=${event.exitCode ?? '?'}）`;
      if (event.event === 'die' && containerId) this.recentOom.delete(containerId);
      this.deps.serverEventLogStore?.record({
        category: 'container',
        severity: event.event === 'oom' || event.exitCode === '137' ? 'error' : 'warn',
        source: 'infra-lifecycle-watcher',
        action: `infra.lifecycle.${event.event}`,
        message: `[${isInfra ? 'infra取证' : '副本取证'}] ${name} ${event.event} — ${verdict}`,
        containerName: name,
        details: event as unknown as Record<string, unknown>,
      });
      // 副本成员死亡 → 即时通知控制面摘流（listener 未注册时仅取证）
      if (event.event === 'die' && isReplicaMember) {
        try { replicaMemberDeathListener?.(name, verdict); } catch { /* 取证不因摘流回调失败而中断 */ }
      }
    }
  }
}
