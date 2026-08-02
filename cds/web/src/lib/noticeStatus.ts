/**
 * 站内信处理状态的前端判定 —— 与后端 `src/services/notice-ledger.ts` 同口径。
 *
 * 为什么单独成文件而不是写在组件里：这几个判定「错了不会报错，只会静默走歪」——
 * 旧记录没有 handling 时若不归 open，全部存量告警会从「待处理」筛选里消失；
 * 认领人为空时若回退成通道桶名（'user' / 'ai'），界面会显示一个假责任人。
 * 抽成纯函数才能被单测直接断言（组件渲染冒烟证明不了这些分支）。
 *
 * 与后端的关系：后端 `noticeStatusOf` 是权威，这里是它在渲染侧的镜像。
 * 两份口径由 tests/services/notice-ledger-wiring-guard.test.ts 钉住。
 */

export type NoticeStatus = 'open' | 'working' | 'resolved';

export const NOTICE_STATUSES: readonly NoticeStatus[] = ['open', 'working', 'resolved'];

export interface NoticeHandling {
  status: NoticeStatus;
  updatedAt: string;
  actor: {
    channel: string;
    userId: string | null;
    userLabel: string | null;
    provider: string | null;
  };
}

export interface NoticeStatusMeta {
  /** 筛选条与徽标上的中文（禁 emoji，重要程度靠文案 + 色彩分级）。 */
  label: string;
  /** 徽标配色，只走主题 token，暗/亮双主题各自成立。 */
  badgeClass: string;
}

/** 注册表模式：新增状态时只改这一处，筛选条 / 徽标自动跟上。 */
export const NOTICE_STATUS_META: Record<NoticeStatus, NoticeStatusMeta> = {
  open: {
    label: '待处理',
    badgeClass: 'border-[hsl(var(--destructive))]/35 bg-[hsl(var(--destructive))]/10 text-[hsl(var(--destructive))]',
  },
  working: {
    label: '处理中',
    badgeClass: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  resolved: {
    label: '已解决',
    badgeClass: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
};

/**
 * 一条通知当前处于哪一档。
 *
 * 缺席（历史账本、后端旧构建）与非法值一律算「待处理」——最该被看见的恰恰是
 * 这些没人碰过的旧告警，把它们判成 undefined 会让筛选条直接漏掉一整批。
 */
export function noticeStatusOf(notice: { handling?: { status?: string } | null }): NoticeStatus {
  const raw = notice.handling?.status;
  return NOTICE_STATUSES.includes(raw as NoticeStatus) ? (raw as NoticeStatus) : 'open';
}

/**
 * 「谁在处理」的如实文案。
 *
 * CDS 的账号身份只在 `CDS_AUTH_MODE=github` 与 ticket SSO 会话里存在；
 * `exec_cds.sh init` 产出的标准部署是 basic 模式（全实例一把共享口令），
 * 请求上没有 `req.cdsUser`，后端会如实落 `userLabel: null`。
 *
 * 这种情况必须**明说没记到责任人**，绝不能把调用通道（'user' / 'ai'）当人名显示：
 * 那会让所有人看到同一个「责任人」，看着有人管、实际一个都没有。
 */
export function noticeHandlerText(handling: NoticeHandling | undefined | null): string | null {
  if (!handling) return null;
  const action = handling.status === 'resolved' ? '标记已解决' : handling.status === 'working' ? '正在处理' : '退回待处理';
  if (handling.actor.userLabel) return `${handling.actor.userLabel} ${action}`;
  return `${action}（当前部署未启用账号身份，未记录责任人；调用通道 ${handling.actor.channel}）`;
}
