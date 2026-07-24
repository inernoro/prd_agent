// Infra 容器生命周期取证器（debt.cds.replica-set #17，2026-07-24）
//
// 背景：复制集六轮验收中共享 mongod 四次「Detected unclean shutdown」，但平台
// 日志通道 tail 500 行被重启后的清理日志秒级刷满，OOM 与否、谁发的 SIGKILL
// 完全无法事后取证——每次只能靠外部监护脚本抓时间线。
//
// 本服务常驻监听 `docker events`（oom / die / kill / start / restart），把
// infra 容器（名称前缀 cds-infra-）的生命周期事件落入内存环形缓冲 + 服务器
// 事件日志。关键取证信号：
//   - `oom` 事件出现        → cgroup 级 OOM kill（容器内存上限触发）
//   - `die` exitCode=137 且无 oom → 外部 SIGKILL（宿主 OOM killer / systemd-oomd / 人为）
//   - `die` 其他 exitCode   → 进程自身退出（panic / ENOSPC / bug）
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerEventLogSink } from './server-event-log-store.js';

export interface InfraLifecycleEvent {
  ts: string;
  containerName: string;
  event: string;
  exitCode?: string;
  signal?: string;
}

const RING_LIMIT = 400;

// 模块级单例访问点：路由层（infra-data）零依赖注入即可读事件
let activeWatcher: InfraLifecycleWatcher | null = null;
export function getActiveInfraLifecycleWatcher(): InfraLifecycleWatcher | null {
  return activeWatcher;
}

export class InfraLifecycleWatcher {
  private proc: ChildProcess | null = null;
  private events: InfraLifecycleEvent[] = [];
  private stopped = false;

  constructor(private readonly deps: { serverEventLogStore?: ServerEventLogSink | null } = {}) {}

  start(): void {
    this.stopped = false;
    activeWatcher = this;
    this.spawnWatcher();
  }

  stop(): void {
    this.stopped = true;
    try { this.proc?.kill('SIGTERM'); } catch { /* noop */ }
    this.proc = null;
  }

  /** 指定容器（或全部 infra）的近期生命周期事件，新→旧。 */
  getEvents(containerName?: string): InfraLifecycleEvent[] {
    const list = containerName
      ? this.events.filter((e) => e.containerName === containerName)
      : this.events;
    return [...list].reverse();
  }

  private spawnWatcher(): void {
    if (this.stopped) return;
    const proc = spawn('docker', [
      'events',
      '--format', '{{json .}}',
      '--filter', 'type=container',
      '--filter', 'event=oom',
      '--filter', 'event=die',
      '--filter', 'event=kill',
      '--filter', 'event=start',
      '--filter', 'event=restart',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = proc;
    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.ingest(line);
        idx = buf.indexOf('\n');
      }
      if (buf.length > 64 * 1024) buf = '';
    });
    // docker daemon 重启 / 网络抖动导致 events 流断开时 5s 自愈重连
    proc.on('close', () => {
      this.proc = null;
      if (!this.stopped) setTimeout(() => this.spawnWatcher(), 5_000);
    });
    proc.on('error', () => {
      this.proc = null;
      if (!this.stopped) setTimeout(() => this.spawnWatcher(), 30_000);
    });
  }

  private ingest(line: string): void {
    let parsed: { status?: string; Action?: string; time?: number; Actor?: { Attributes?: Record<string, string> } };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const name = parsed.Actor?.Attributes?.name || '';
    if (!name.startsWith('cds-infra-')) return;
    const event: InfraLifecycleEvent = {
      ts: parsed.time ? new Date(parsed.time * 1000).toISOString() : new Date().toISOString(),
      containerName: name,
      event: parsed.Action || parsed.status || 'unknown',
      exitCode: parsed.Actor?.Attributes?.exitCode,
      signal: parsed.Actor?.Attributes?.signal,
    };
    this.events.push(event);
    if (this.events.length > RING_LIMIT) this.events = this.events.slice(-RING_LIMIT);
    // 死亡/OOM 类事件同步落服务器事件日志（可跨重启追溯）
    if (event.event === 'oom' || event.event === 'die') {
      const verdict = event.event === 'oom'
        ? 'cgroup OOM kill'
        : event.exitCode === '137'
          ? '外部 SIGKILL（宿主 OOM killer / oomd / 人为，容器无 oom 事件）'
          : `进程自身退出（exitCode=${event.exitCode ?? '?'}）`;
      this.deps.serverEventLogStore?.record({
        category: 'container',
        severity: event.event === 'oom' || event.exitCode === '137' ? 'error' : 'warn',
        source: 'infra-lifecycle-watcher',
        action: `infra.lifecycle.${event.event}`,
        message: `[infra取证] ${name} ${event.event} — ${verdict}`,
        containerName: name,
        details: event as unknown as Record<string, unknown>,
      });
    }
  }
}
