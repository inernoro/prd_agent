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
  // 2026-07-29:定时发布(scheduled-job 的 release 动作)的两条治理事件。
  // 它们不是发布生命周期(那四条由 release-events 按 ReleaseRunStatus 映射),
  // 而是「调度器决定不发」的时刻 —— 恰恰是最容易无声无息过去的两种:
  //   approval-required:规则要求人工确认,到点只跑了预检,等人拍板;
  //   schedule.disabled:连续失败达阈值,规则被自动停用,不再自己重试。
  // 两条都 alert=true:没人被叫醒的话,前者等于「永远没人确认」,后者等于
  // 「定时发布从此静默消失」,而这两件事都不会在任何页面上自己冒出来。
  | 'release.schedule.approval-required'
  | 'release.schedule.disabled'
  // 2026-07-29:存活监控判定「连续失败 → down / 恢复」。此前 uptime-monitor 只把
  // 故障写进自己那份 incidents 台账,谁都不会被叫醒 —— 状态页没人盯着的时候,
  // 生产掉线和没掉线在 CDS 这边是同一种沉默。上总线后它才和发布失败同一条通道。
  | 'uptime.target.down'
  | 'uptime.target.recovered'

  // 验收报告归档后的阻断级结论。判据（哪份报告算阻断）在 acceptance-severity.ts，
  // 这里只登记「它够格叫醒人」与「叫醒时说什么」。
  | 'acceptance.report.blocking'
  // 2026-07-29:服务端通知账本记下一条新站内信。**必须 alert=false**,
  // 否则账本订阅到自己发的事件会无限递归记账。
  | 'notice.created'
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
 * (站内通知 / Webhook / 邮件),`doc/debt.cds.md「CDS 存活监控（uptime-monitor）」` 债务 2-1 把
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
  // 待人工确认不叫醒人 = 永远没人确认;自动停用不叫醒人 = 定时发布静默消失。
  'release.schedule.approval-required': true,
  'release.schedule.disabled': true,
  // 连续失败达阈值才判 down(去抖已在 uptime-metrics 做过),到这一步就是真掉线。
  'uptime.target.down': true,
  // 恢复是好消息,不叫醒人。
  'uptime.target.recovered': false,
  // 验收报出 P0/判定不通过/结论与缺陷自相矛盾 —— 不叫醒人就只有主动翻报告中心的人知道,
  // 而「没人翻」正是常态。判据刻意排除了「有条件通过 + 若干 P1」这种每日常态形状,
  // 所以这条响起来时一定是真事(判据与取舍见 acceptance-severity.ts)。
  'acceptance.report.blocking': true,
  // 账本自己发的事件绝不能是告警级 —— 否则订阅方记一条又发一条,无限递归。
  'notice.created': false,
  heartbeat: false,
};

export function isAlertCdsEvent(type: CdsEventType): boolean {
  return CDS_EVENT_ALERT_CLASS[type] === true;
}

/**
 * 事件 → 站内信文案。
 *
 * 为什么放在**这个**文件而不是通知账本里:tests/services/release-event-source-guard.ts
 * 只豁免 release-events.ts 与本文件出现发布事件字面量,别处一旦按事件名分支就判红。
 * 这条约束是刻意的 —— 「哪些事件叫醒人」「叫醒时说什么」「点开去哪」必须是同一张表,
 * 拆成两处就会漂移(存活监控一套、发布一套正是本仓库反复栽的形状)。
 *
 * 通知账本因此只做一件事:拿这里给的 copy + envelope.data 的结构化字段渲染,
 * 自己不认识任何事件名。
 *
 * link 是深链**类别**不是具体 URL:具体 id 只有 envelope.data 里才有,
 * 拼接由账本做;但「这类事件该落到哪一屏」的判定留在这里。
 */
export interface CdsEventNoticeCopy {
  /** 站内信标题(中文,不带项目名 —— 项目名由账本从 data 里取并单独展示) */
  title: string;
  /** 来源标签,前端据此选图标:release / uptime / drift / system */
  source: string;
  level: 'info' | 'warning' | 'danger';
  /** 深链类别。release=发布中心;status=状态页;maintenance=系统维护;report=报告中心;none=不给链接 */
  link: 'release' | 'status' | 'maintenance' | 'report' | 'none';
  actionLabel?: string;
}

/**
 * 穷尽 Record:新增 CdsEventType 时这里少一个键 TS 直接报错,逼作者显式回答
 * 「这条要不要进站内信」。null = 不进账本。
 */
const CDS_EVENT_NOTICE_COPY: Record<CdsEventType, CdsEventNoticeCopy | null> = {
  'self.status': null,
  'self.refresh.started': null,
  'self.refresh.done': null,
  'self.refresh.failed': null,
  'self.update.started': null,
  'self.update.step': null,
  'self.update.done': null,
  'self.update.failed': { title: 'CDS 自更新失败', source: 'self-update', level: 'danger', link: 'maintenance', actionLabel: '查看维护面板' },
  'operator.request.created': null,
  'operator.request.approved': null,
  'operator.request.rejected': null,
  'operator.request.log': null,
  'operator.request.completed': null,
  'operator.request.failed': null,
  'pending-import.created': null,
  'pending-import.decided': null,
  'pending-import.count': null,
  'access-request.created': null,
  'access-request.decided': null,
  'access-request.count': null,
  'project.config.changed': null,
  'infra.flap.circuit-breaker': { title: '基础设施反复重启已熔断', source: 'system', level: 'danger', link: 'status', actionLabel: '查看状态页' },
  'preview.canary.alert': { title: '预览入口探测失败', source: 'uptime', level: 'warning', link: 'status', actionLabel: '查看状态页' },
  'preview.canary.recovered': null,
  'agent-session.activity': null,
  'release.started': null,
  // 成功默认不入账(见 shouldLedgerEvent):只有自动触发的那种成功才值得打扰人。
  'release.succeeded': { title: '生产发布完成', source: 'release', level: 'info', link: 'release', actionLabel: '查看发布记录' },
  'release.failed': { title: '生产发布失败', source: 'release', level: 'danger', link: 'release', actionLabel: '查看发布记录' },
  'release.rolled-back': { title: '生产已回滚', source: 'release', level: 'warning', link: 'release', actionLabel: '查看发布记录' },
  'release.drift-detected': { title: '生产现场与 CDS 台账不一致', source: 'drift', level: 'danger', link: 'release', actionLabel: '查看发布目标' },
  'release.drift-cleared': null,
  'release.schedule.approval-required': { title: '定时发布待人工确认', source: 'release', level: 'warning', link: 'release', actionLabel: '前往发布中心' },
  'release.schedule.disabled': { title: '定时发布已自动停用', source: 'release', level: 'danger', link: 'release', actionLabel: '查看发布中心' },
  'uptime.target.down': { title: '生产服务健康掉线', source: 'uptime', level: 'danger', link: 'status', actionLabel: '查看状态页' },
  'uptime.target.recovered': null,
  'acceptance.report.blocking': { title: '验收发现阻断级缺陷', source: 'acceptance', level: 'danger', link: 'report', actionLabel: '查看验收报告' },
  'notice.created': null,
  heartbeat: null,
};

export function cdsEventNoticeCopy(type: CdsEventType): CdsEventNoticeCopy | null {
  return CDS_EVENT_NOTICE_COPY[type] ?? null;
}

/**
 * 这条事件要不要记进站内信账本 —— **唯一**判定源,别处不许再按事件名判一遍。
 *
 * 两段口径:
 *  1. 有文案 + 告警级 → 一律入账(告警的定义就是「没人盯屏时也要叫醒人」);
 *  2. 有文案但非告警级(即成功类)→ 只有**自动触发**的才入账。判据是 payload 里
 *     带 rollbackOf(这次成功属于一次回滚 run)或 autoRestoredAt(自动恢复)。
 *     人点按钮发出来的成功他自己看得见,再发一条站内信纯属噪声;而系统半夜自己
 *     回滚过一次,不通知就等于没发生。
 */
export function shouldLedgerEvent(type: CdsEventType, data: unknown): boolean {
  if (!CDS_EVENT_NOTICE_COPY[type]) return false;
  if (isAlertCdsEvent(type)) return true;
  const payload = (data ?? {}) as { rollbackOf?: unknown; autoRestoredAt?: unknown };
  const auto = payload.rollbackOf ?? payload.autoRestoredAt;
  return typeof auto === 'string' && auto.trim().length > 0;
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
