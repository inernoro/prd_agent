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
  // 2026-06-04:被动授权 — agent 免密发起的授权申请事件(右下角审批盒订阅)
  | 'access-request.created'
  | 'access-request.decided'
  | 'access-request.count'
  // 2026-05-29:项目虚拟 cds-compose.yml 变更(approve/手动编辑/repo 同步)
  | 'project.config.changed'
  // 2026-05-28:infra flap 熔断告警(watchdog 自动停掉烂配置容器)
  | 'infra.flap.circuit-breaker'
  // 2026-06-18:真实预览入口探测告警(区别于控制台 /healthz)
  | 'preview.canary.alert'
  | 'preview.canary.recovered'
  // 2026-06-11:Agent 请求观测台 — 会话级活动事件(创建/状态翻转/收发节点),
  // text_delta 不逐 token 发(防总线洪水),只发结构性节点
  | 'agent-session.activity'
  // 2026-07-28:生产发布生命周期。此前发布事件只跑在 release-events 那条私有
  // EventEmitter 上,只有「正打开发布中心那一屏」的人看得见 —— 关掉页面发布失败
  // 就彻底无人知晓。上总线后它才与 self.* / preview.canary.* 站在同一条通道上。
  // rollback_running 也映射成 started(回滚是一次独立 run),用 data.rollbackOf 区分。
  | 'release.started'
  | 'release.succeeded'
  | 'release.failed'
  | 'release.rolled-back'
  // 2026-07-28:生产现场漂移。远端 current 指向的版本与 CDS 台账认知不一致,
  // 意味着有人绕过 CDS 直接动了线上 —— 此时 CDS 面板上显示的「当前版本」是假的,
  // 照着它做回滚会滚到一个根本不在线上的版本。只告警不自愈(计划第六节)。
  | 'release.drift-detected'
  | 'release.drift-cleared'
  | 'heartbeat';

export interface CdsEventEnvelope<T = unknown> {
  type: CdsEventType;
  ts: string; // ISO 时间戳
  /** 任务/请求关联 id,refresh / update 类事件带 jobId,status 不带 */
  jobId?: string;
  data: T;
}

/**
 * 告警级事件白名单 —— 「哪些事件够格在没人盯屏时叫醒人」的唯一判定源。
 *
 * 为什么先立这张表、而不是等真接通道时再说:CDS 至今**没有**任何告警外发
 * (站内通知 / Webhook / 邮件),`doc/debt.cds.uptime-monitor.md` 债务 2-1 把
 * 「无告警外发」登记为 open。发布失败同样无外发。这两件事必须共用一条通道,
 * 否则会长出「存活监控一套、发布一套」两条各判各的分发逻辑 —— 那正是本仓库
 * 反复栽跟头的形状。所以先把判定收敛到这里,将来的分发器只需
 * `cdsEventsBus.subscribe` + `isAlertCdsEvent`,不许自己按事件名再判一遍。
 *
 * 穷尽 Record 是刻意的:新增 CdsEventType 时这里少一个键 TS 直接报错,逼作者
 * 显式回答「这条要不要叫醒人」。默认静默会让新的坏事件悄悄不告警,而告警缺失
 * 恰恰是最难被发现的缺陷 —— 没人会注意到「没有响过的铃」。
 */
const CDS_EVENT_ALERT_CLASS: Record<CdsEventType, boolean> = {
  'self.status': false,
  'self.refresh.started': false,
  'self.refresh.done': false,
  // git fetch 失败在网络抖动时是常态噪声,叫醒人只会训练出「忽略告警」的习惯。
  'self.refresh.failed': false,
  'self.update.started': false,
  'self.update.step': false,
  'self.update.done': false,
  'self.update.failed': true,
  'operator.request.created': false,
  'operator.request.approved': false,
  'operator.request.rejected': false,
  'operator.request.log': false,
  'operator.request.completed': false,
  'operator.request.failed': false,
  'pending-import.created': false,
  'pending-import.decided': false,
  'pending-import.count': false,
  'access-request.created': false,
  'access-request.decided': false,
  'access-request.count': false,
  'project.config.changed': false,
  'infra.flap.circuit-breaker': true,
  'preview.canary.alert': true,
  'preview.canary.recovered': false,
  'agent-session.activity': false,
  'release.started': false,
  'release.succeeded': false,
  'release.failed': true,
  // 回滚成功意味着系统已自愈,但「生产回退过一次」本身就是必须有人知道的事实。
  'release.rolled-back': true,
  // 线上被人绕过 CDS 手改过版本,是「面板在撒谎」级别的事实,必须叫醒人。
  'release.drift-detected': true,
  // 漂移解除是「已自愈」,不叫醒人;但发生过必须留痕,否则复盘时看不到它响过又停了。
  'release.drift-cleared': false,
  heartbeat: false,
};

export function isAlertCdsEvent(type: CdsEventType): boolean {
  return CDS_EVENT_ALERT_CLASS[type] === true;
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
