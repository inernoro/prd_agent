/**
 * Forwarder 数据面类型 SSOT(B'.2-forwarder)
 *
 * 对应 doc/design.cds.control-data-split.md 4.1 / 6.1 节。
 * 所有 forwarder 子模块共享这里定义的类型,不依赖外部 cds/src/types.ts(避免与 admin daemon 强耦合)。
 */

/** 路由记录健康状态:running 命中转发;unhealthy upstream 暂时不可达;unknown 初始/未探测。 */
export type RouteHealthState = 'running' | 'unhealthy' | 'unknown';

/** 路由表整体健康状态(watcher 自身视角):
 *  - live   :mongo change stream 正常
 *  - fallback:mongo 不可达,从本地 JSON 启动 / 运行
 *  - stale  :mongo 运行中断线,内存表保留最后状态等待重连
 */
export type RoutesHealthState = 'live' | 'fallback' | 'stale';

/** 数据来源,diagnostic /__forwarder/routes 暴露给运维定位。 */
export type RouteDataSource = 'mongo' | 'json-fallback';

/**
 * Forwarder 路由记录(对应 mongo collection cds_forwarder_routes 中的一行)。
 *
 * 字段保持与 doc/design.cds.control-data-split.md 6.1 节一致,_id 用 string,
 * 测试里可以是任意可比较字符串(uuid / mongo ObjectId hex / 自增字符串)。
 */
export interface RouteRecord {
  /** 主键(mongo _id 字符串化形式) */
  _id: string;
  /** 精确域名(如 demo.miduo.org)或通配 *.miduo.org */
  host: string;
  /** 可选路径前缀,空串等同 "/"(命中所有路径) */
  pathPrefix?: string;
  /** upstream 主机,默认 127.0.0.1 */
  upstreamHost?: string;
  /** upstream 端口(1-65535) */
  upstreamPort: number;
  /** 反查用:这条路由对应哪个分支(branch id) */
  branchId?: string;
  /** 原始 git 分支名(如 "claude/debug-asr-logging-ncCAj"),供 widget injection 显示 */
  branchName?: string;
  /** 灰度权重 1-100,0 表示禁用此路由(跳过匹配) */
  weight: number;
  /** 版本标(future) */
  version?: number;
  /** upstream 当前健康(由 scheduler 写入,forwarder 只读) */
  healthState?: RouteHealthState;
  /** mongo change stream 触发依据 */
  updatedAt?: Date | string;
  /** 数据来源(由 watcher 注入,不写回 mongo) */
  dataSource?: RouteDataSource;
  /**
   * 转发时是否保留客户端原始 Host header(默认 false:改写为 upstreamHost:upstreamPort)。
   * 用于 unknown host fallback 转给 master 的场景:master 需要原 Host 做 detectBranch,
   * 看到 127.0.0.1:port 会找不到分支。
   */
  preserveHost?: boolean;
}

/** 统计快照(诊断接口与 admin 自检都消费这个 schema)。 */
export interface ProxyStats {
  totalRequests: number;
  requestsByHost: Record<string, number>;
  statusCounts: Record<string, number>;
  p50LatencyMs: number;
  p99LatencyMs: number;
  last60sRps: number;
  errorCount: number;
  error503Count: number;
}

/** mongo 抽象,真实环境用 mongodb driver,测试用 in-memory mock 注入。 */
export interface MongoChange {
  kind: 'insert' | 'update' | 'delete';
  /** 完整记录(insert/update)或 { _id }(delete) */
  record: Partial<RouteRecord> & { _id: string };
}

export interface MongoLike {
  /** 一次性拉全表(启动时 + 重连时调用)。 */
  fullScan(): Promise<RouteRecord[]>;
  /** 监听 change stream;watcher 通过 for-await 消费。 */
  watch(): AsyncIterable<MongoChange>;
  /** 关闭连接 */
  close(): Promise<void>;
}

/** 统一的内部事件名,允许 watcher 与外界 onChange/告警解耦。 */
export type WatcherEventKind =
  | 'routes-replaced'
  | 'mongo-disconnected'
  | 'mongo-reconnected'
  | 'fallback-loaded'
  | 'fallback-corrupted'
  | 'snapshot-saved';

export interface WatcherEvent {
  kind: WatcherEventKind;
  at: Date;
  detail?: string;
}
