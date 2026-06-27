/**
 * Forwarder 路由表监听器(B'.2-forwarder)
 *
 * 对应 doc/report.cds.forwarder-success.md
 *
 * 职责:
 *   1. 启动 fullScan 加载全表 → atomic 替换内存表 → 写 JSON 快照
 *   2. 订阅 mongo change stream(insert / update / delete)实时增量更新
 *   3. mongo 不可达(启动 / 运行)→ 加载 .cds/forwarder-routes.json + healthState=fallback
 *   4. mongo 运行中断线 → 心跳 5s × 3 失败切 stale,30s 重连尝试
 *   5. mongo 恢复 → 重新 fullScan + 切回 live
 *   6. JSON 损坏 → 空表 + 告警事件
 *
 * 设计要点:
 *   - 内存表用"整体替换"保证读到的总是完整快照,不会读到一半
 *   - mongo 抽象 MongoLike 由调用方注入,本服务只对 MongoLike 编程
 *   - 心跳 / 重连 / 快照间隔均可注入,便于单测加速
 *   - 不直接 throw;失败用 WatcherEvent 事件流 + healthState 暴露
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  MongoChange,
  MongoLike,
  RouteDataSource,
  RouteRecord,
  RoutesHealthState,
  WatcherEvent,
  WatcherEventKind,
} from './types.js';

export interface RouteWatcherOptions {
  /** mongo 连接工厂(失败抛任意 Error 都接住) */
  mongoConnect: () => Promise<MongoLike>;
  /** 本地 JSON 兜底路径,启动时 mongo 失败 / 运行中持久化都用它 */
  jsonFallbackPath: string;
  /** 心跳间隔 ms,默认 5000 */
  heartbeatIntervalMs?: number;
  /** 心跳失败几次切 stale,默认 3 */
  heartbeatFailureThreshold?: number;
  /** 切 stale 后多久尝试一次重连,默认 30000 */
  reconnectIntervalMs?: number;
  /** 是否在 fullScan 后自动写一次快照(默认 true) */
  saveSnapshot?: boolean;
  /** logger 注入(测试中可静音) */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export type RouteChangeHandler = (routes: RouteRecord[]) => void;
export type EventHandler = (e: WatcherEvent) => void;

export class RouteWatcher {
  private routes: RouteRecord[] = [];
  private health: RoutesHealthState = 'live';
  private dataSource: RouteDataSource = 'mongo';
  private mongo: MongoLike | null = null;
  private watchAbort = false;
  private watchPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailCount = 0;
  private changeHandlers: Set<RouteChangeHandler> = new Set();
  private eventHandlers: Set<EventHandler> = new Set();
  private opts: Required<Omit<RouteWatcherOptions, 'mongoConnect' | 'jsonFallbackPath' | 'logger'>> &
    Pick<RouteWatcherOptions, 'mongoConnect' | 'jsonFallbackPath' | 'logger'>;
  private stopped = false;

  constructor(opts: RouteWatcherOptions) {
    this.opts = {
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5000,
      heartbeatFailureThreshold: opts.heartbeatFailureThreshold ?? 3,
      reconnectIntervalMs: opts.reconnectIntervalMs ?? 30000,
      saveSnapshot: opts.saveSnapshot ?? true,
      mongoConnect: opts.mongoConnect,
      jsonFallbackPath: opts.jsonFallbackPath,
      logger: opts.logger,
    };
  }

  /** 启动:优先 mongo,失败 fallback 到 JSON。 */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      const mongo = await this.opts.mongoConnect();
      this.mongo = mongo;
      const initial = await mongo.fullScan();
      this.replaceRoutes(initial, 'mongo');
      this.health = 'live';
      this.dataSource = 'mongo';
      this.startWatchLoop();
      this.startHeartbeat();
      if (this.opts.saveSnapshot) this.saveSnapshotSafe();
    } catch (err) {
      this.opts.logger?.warn?.(`[route-watcher] mongo 不可达,fallback 到 JSON:${(err as Error).message}`);
      this.loadFallbackJson();
      this.health = 'fallback';
      this.dataSource = 'json-fallback';
      this.startReconnectLoop();
    }
  }

  /** 停止:取消 watch,关 mongo,清 timer。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watchAbort = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.mongo) {
      try {
        await this.mongo.close();
      } catch {
        // noop
      }
      this.mongo = null;
    }
    if (this.watchPromise) {
      try {
        await this.watchPromise;
      } catch {
        // noop
      }
      this.watchPromise = null;
    }
  }

  /** O(1) 取当前内存表(返回引用快照,调用方不可改)。 */
  getRoutes(): RouteRecord[] {
    return this.routes;
  }

  healthState(): RoutesHealthState {
    return this.health;
  }

  getDataSource(): RouteDataSource {
    return this.dataSource;
  }

  /** 注册 routes 替换 / 增量更新回调。 */
  onChange(cb: RouteChangeHandler): () => void {
    this.changeHandlers.add(cb);
    return () => this.changeHandlers.delete(cb);
  }

  /** 注册告警事件回调(mongo 断线 / fallback 损坏 / 快照成功等)。 */
  onEvent(cb: EventHandler): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  // ---- 内部 ----

  private replaceRoutes(rs: RouteRecord[], source: RouteDataSource) {
    // 整体替换,带数据来源 stamp;读取方在 atomic 替换前读到老 array,在替换后读到新 array
    const stamped = rs.map((r) => ({ ...r, dataSource: source }));
    this.routes = stamped;
    this.dataSource = source;
    this.emit('routes-replaced');
    for (const h of this.changeHandlers) {
      try {
        h(this.routes);
      } catch {
        // 隔离 handler 故障
      }
    }
  }

  private applyIncremental(change: MongoChange) {
    const next = this.routes.slice();
    const idx = next.findIndex((r) => String(r._id) === String(change.record._id));
    if (change.kind === 'delete') {
      if (idx >= 0) next.splice(idx, 1);
    } else if (change.kind === 'insert') {
      if (idx < 0) {
        next.push({ ...(change.record as RouteRecord), dataSource: this.dataSource });
      }
    } else if (change.kind === 'update') {
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...change.record, dataSource: this.dataSource };
      } else {
        // 不存在则当作 insert,保证最终一致
        next.push({ ...(change.record as RouteRecord), dataSource: this.dataSource });
      }
    }
    this.routes = next;
    for (const h of this.changeHandlers) {
      try {
        h(this.routes);
      } catch {
        // 隔离
      }
    }
  }

  private startWatchLoop() {
    if (!this.mongo) return;
    this.watchAbort = false;
    const mongo = this.mongo;
    this.watchPromise = (async () => {
      try {
        for await (const ch of mongo.watch()) {
          if (this.watchAbort) return;
          this.applyIncremental(ch);
        }
      } catch (err) {
        if (this.stopped) return;
        this.opts.logger?.warn?.(`[route-watcher] change stream 异常:${(err as Error).message}`);
        this.transitionToStale(`change-stream:${(err as Error).message}`);
      }
    })();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatFailCount = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped) return;
      if (!this.mongo) {
        this.heartbeatFailCount += 1;
      } else {
        // 心跳:轻量调一次 fullScan 探测;失败计数,成功重置
        this.mongo
          .fullScan()
          .then(() => {
            this.heartbeatFailCount = 0;
          })
          .catch(() => {
            this.heartbeatFailCount += 1;
            if (this.heartbeatFailCount >= this.opts.heartbeatFailureThreshold) {
              this.transitionToStale('heartbeat');
            }
          });
      }
    }, this.opts.heartbeatIntervalMs);
    // 防止 timer 阻塞 process exit
    if (this.heartbeatTimer && typeof (this.heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as { unref?: () => void }).unref!();
    }
  }

  private transitionToStale(_reason: string) {
    if (this.health === 'stale') return;
    this.health = 'stale';
    this.watchAbort = true;
    this.emit('mongo-disconnected');
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.startReconnectLoop();
  }

  private startReconnectLoop() {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = setInterval(() => {
      if (this.stopped) return;
      void this.tryReconnect();
    }, this.opts.reconnectIntervalMs);
    if (this.reconnectTimer && typeof (this.reconnectTimer as { unref?: () => void }).unref === 'function') {
      (this.reconnectTimer as { unref?: () => void }).unref!();
    }
  }

  /** 直接触发一次重连尝试(测试中可用,不必等定时器)。 */
  async tryReconnect(): Promise<boolean> {
    try {
      const mongo = await this.opts.mongoConnect();
      const initial = await mongo.fullScan();
      // 关闭旧 mongo(如果还在)
      if (this.mongo && this.mongo !== mongo) {
        try {
          await this.mongo.close();
        } catch {
          // noop
        }
      }
      this.mongo = mongo;
      this.replaceRoutes(initial, 'mongo');
      this.health = 'live';
      this.dataSource = 'mongo';
      this.emit('mongo-reconnected');
      this.watchAbort = false;
      this.startWatchLoop();
      this.startHeartbeat();
      if (this.reconnectTimer) {
        clearInterval(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.opts.saveSnapshot) this.saveSnapshotSafe();
      return true;
    } catch (err) {
      this.opts.logger?.warn?.(`[route-watcher] 重连失败:${(err as Error).message}`);
      return false;
    }
  }

  private loadFallbackJson() {
    const p = this.opts.jsonFallbackPath;
    try {
      if (!fs.existsSync(p)) {
        // 不存在视为空表(未告警:首次启动正常情况)
        this.routes = [];
        this.dataSource = 'json-fallback';
        this.emit('fallback-loaded', 'empty');
        return;
      }
      const txt = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(txt);
      if (!Array.isArray(parsed)) throw new Error('JSON not array');
      this.routes = (parsed as RouteRecord[]).map((r) => ({ ...r, dataSource: 'json-fallback' as const }));
      this.dataSource = 'json-fallback';
      this.emit('fallback-loaded', `${this.routes.length} routes`);
    } catch (err) {
      this.opts.logger?.error?.(`[route-watcher] JSON 损坏 ${(err as Error).message},空表启动`);
      this.routes = [];
      this.dataSource = 'json-fallback';
      this.emit('fallback-corrupted', (err as Error).message);
    }
  }

  private saveSnapshotSafe() {
    const p = this.opts.jsonFallbackPath;
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      // 落盘时不带 dataSource 字段(它是 watcher 注入的运行时元数据)
      const dump = this.routes.map(({ dataSource: _ds, ...rest }) => rest);
      fs.writeFileSync(tmp, JSON.stringify(dump, null, 2), 'utf8');
      fs.renameSync(tmp, p);
      this.emit('snapshot-saved', `${this.routes.length} routes`);
    } catch (err) {
      this.opts.logger?.warn?.(`[route-watcher] 快照写盘失败:${(err as Error).message}`);
    }
  }

  private emit(kind: WatcherEventKind, detail?: string) {
    const e: WatcherEvent = { kind, at: new Date(), detail };
    for (const h of this.eventHandlers) {
      try {
        h(e);
      } catch {
        // 隔离
      }
    }
  }
}
