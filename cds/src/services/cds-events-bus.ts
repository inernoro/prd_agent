// CDS 单一事件总线 (Single Event Channel)
//
// 目的:把零散的 /api/self-status/stream + /api/branches/stream + 各组件轮询
// 收敛成一个进程内 EventEmitter,所有 self-update / self-refresh / status
// 变化事件统一在这里发布,GET /api/cds-events SSE 端点订阅这里。
//
// 与原 broadcastSelfStatus + selfStatusClients 池的关系:
//   - 旧:broadcastSelfStatus() 直接遍历 selfStatusClients 写 SSE line
//   - 新:broadcastSelfStatus() → bus.emit('self.status', payload) → bus 订阅者
//        (cds-events SSE handler + 旧 selfStatusClients 兼容写入) 各自处理
//
// 设计要点:
//   - 单例模块级 EventEmitter,CDS 单进程单实例
//   - max listeners 提高到 100(浏览器多 tab 时每个 tab 一条 SSE 长连接)
//   - 事件名严格按文档约定:self.status / self.refresh.{started,done,failed}
//     / self.update.{started,step,done,failed} / heartbeat
//   - emit 永远不抛(包内 try/catch),listener 抛错被吞掉防止串扰

import { EventEmitter } from 'node:events';

export type CdsEventType =
  | 'self.status'
  | 'self.refresh.started'
  | 'self.refresh.done'
  | 'self.refresh.failed'
  | 'self.update.started'
  | 'self.update.step'
  | 'self.update.done'
  | 'self.update.failed'
  | 'operator.request.created'
  | 'operator.request.approved'
  | 'operator.request.rejected'
  | 'operator.request.log'
  | 'operator.request.completed'
  | 'operator.request.failed'
  // 2026-05-28:agent 导入审批事件(替代 ProjectListPage 10s 轮询)
  | 'pending-import.created'
  | 'pending-import.decided'
  | 'pending-import.count'
  // 2026-05-28:infra flap 熔断告警(watchdog 自动停掉烂配置容器)
  | 'infra.flap.circuit-breaker'
  | 'heartbeat';

export interface CdsEventEnvelope<T = unknown> {
  type: CdsEventType;
  ts: string; // ISO 时间戳
  /** 任务/请求关联 id,refresh / update 类事件带 jobId,status 不带 */
  jobId?: string;
  data: T;
}

class CdsEventsBus {
  private emitter = new EventEmitter();

  constructor() {
    // 浏览器开几个 tab + GlobalUpdateBadge + MaintenanceTab 都订阅,默认 10 不够。
    // 单进程单实例 CDS 真实并发上限就是同时打开的客户端数,100 远远够。
    this.emitter.setMaxListeners(100);
  }

  publish<T>(type: CdsEventType, data: T, opts?: { jobId?: string }): void {
    const envelope: CdsEventEnvelope<T> = {
      type,
      ts: new Date().toISOString(),
      ...(opts?.jobId ? { jobId: opts.jobId } : {}),
      data,
    };
    try {
      this.emitter.emit('cds-event', envelope);
    } catch (err) {
      // 单个 listener 抛错不影响其他订阅者
      // eslint-disable-next-line no-console
      console.warn('[cds-events-bus] publish listener error:', (err as Error).message);
    }
  }

  /**
   * 订阅所有事件。返回 unsubscribe 函数。
   * listener 自身的异常被 bus 吞掉,不会影响其他订阅者或发布方。
   */
  subscribe(listener: (envelope: CdsEventEnvelope) => void): () => void {
    const wrapped = (envelope: CdsEventEnvelope): void => {
      try {
        listener(envelope);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[cds-events-bus] subscribe handler error:', (err as Error).message);
      }
    };
    this.emitter.on('cds-event', wrapped);
    return () => {
      this.emitter.off('cds-event', wrapped);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('cds-event');
  }
}

// 单例 — 整个 CDS 进程共享一个 bus
export const cdsEventsBus = new CdsEventsBus();
