import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bug,
  CalendarClock,
  CheckCircle2,
  AlertTriangle,
  Megaphone,
  Server,
  MessageSquareHeart,
  Activity,
  ListTodo,
  ClipboardCheck,
  Workflow,
} from 'lucide-react';
import type { AdminNotificationItem } from '@/services/contracts/notifications';

/**
 * 通知类型注册表（Registry Pattern，见 .claude/rules/frontend-architecture.md）
 *
 * 一条通知「长什么样」由类型决定：不同来源（缺陷协作 / 周报 / 系统告警 / 管理员通知 …）
 * 展示不同的图标、强调色、类型标签与弹窗气质（default / celebrate / alert）。
 * 禁止在组件里 switch 硬编码类型 → 图标/颜色映射，全部从这里取。
 */

export type NotificationPopupStyle = 'default' | 'celebrate' | 'alert';

export interface NotificationTypeConfig {
  /** 稳定 key，等于后端 source（或派生的语义类型） */
  key: string;
  /** 类型中文标签，展示在通知卡片的类型 chip 上 */
  label: string;
  /** 类型图标 */
  icon: LucideIcon;
  /**
   * 类型强调色（CSS 颜色字符串）。用于卡片左侧色条 / 图标徽章底色 / chip 文字。
   * 与 level 语义色解耦：level 表达「严重程度」，accent 表达「这是哪类通知」。
   */
  accent: string;
  /** 弹窗气质：庆祝（成功完成）/ 告警（需注意）/ 默认 */
  popupStyle: NotificationPopupStyle;
}

const DEFAULT_TYPE: NotificationTypeConfig = {
  key: 'system',
  label: '通知',
  icon: Bell,
  accent: '#93c5fd',
  popupStyle: 'default',
};

/**
 * source → 类型配置。source 取值对齐后端 AdminNotificationSourceCatalog。
 */
export const NOTIFICATION_TYPE_REGISTRY: Record<string, NotificationTypeConfig> = {
  'defect-agent': { key: 'defect-agent', label: '缺陷协作', icon: Bug, accent: '#c084fc', popupStyle: 'default' },
  'report-agent': { key: 'report-agent', label: '周报月报', icon: CalendarClock, accent: '#5eead4', popupStyle: 'default' },
  'pm-agent': { key: 'pm-agent', label: '项目待办', icon: ListTodo, accent: '#7dd3fc', popupStyle: 'default' },
  'review-agent': { key: 'review-agent', label: '产品评审', icon: ClipboardCheck, accent: '#a5b4fc', popupStyle: 'default' },
  'workflow-agent': { key: 'workflow-agent', label: '工作流', icon: Workflow, accent: '#93c5fd', popupStyle: 'default' },
  'admin-notice': { key: 'admin-notice', label: '管理员通知', icon: Megaphone, accent: '#fcd34d', popupStyle: 'default' },
  'system': { key: 'system', label: '系统通知', icon: Bell, accent: '#93c5fd', popupStyle: 'default' },
  'system-alert': { key: 'system-alert', label: '系统告警', icon: AlertTriangle, accent: '#fca5a5', popupStyle: 'alert' },
  'server-expiry': { key: 'server-expiry', label: '服务器', icon: Server, accent: '#fdba74', popupStyle: 'alert' },
  'user-voice': { key: 'user-voice', label: '用户之声', icon: MessageSquareHeart, accent: '#f9a8d4', popupStyle: 'default' },
  'api-request-alert': { key: 'api-request-alert', label: 'API 告警', icon: Activity, accent: '#fca5a5', popupStyle: 'alert' },
};

/**
 * 判断是否为「催办 / 超时提醒」类通知（已下线的 defect-escalation / defect-reminder / pm-reminder）。
 * 用户要求：通知右下角不再出现催办。作为兜底，前端不渲染任何残留的催办通知。
 * 与后端 AdminPushNotificationService.IsDefectReminderNotification 判定口径保持一致。
 */
export function isEscalationNotification(
  item: Pick<AdminNotificationItem, 'source' | 'key' | 'title' | 'message'>
): boolean {
  const source = (item.source ?? '').toLowerCase();
  if (source === 'defect-escalation' || source === 'defect-reminder' || source === 'pm-reminder') return true;
  const key = (item.key ?? '').toLowerCase();
  if (key.startsWith('defect-escalation') || key.startsWith('defect-reminder')) return true;
  const title = item.title ?? '';
  if (title.includes('催办')) return true;
  // 与后端 IsDefectReminderNotification 对齐：兜底命中「仅正文」透出催办语义的残留提醒。
  const message = item.message ?? '';
  return message.includes('请尽快跟进') || (message.includes('超时') && message.includes('未处理'));
}

/**
 * 解析一条通知的类型配置。
 * 优先按 source 命中注册表；命中不到时，用 level 兜底给出「告警 / 默认」气质。
 * 特例：缺陷来源 + success 语义（如「缺陷已解决，待你验收」）走 celebrate 气质。
 */
export function getNotificationType(
  item: Pick<AdminNotificationItem, 'source' | 'level' | 'title'>
): NotificationTypeConfig {
  const source = (item.source ?? '').toLowerCase();
  const level = (item.level ?? '').toLowerCase();
  const base = NOTIFICATION_TYPE_REGISTRY[source];

  if (base) {
    // 缺陷协作 + 成功语义 → 庆祝气质（缺陷已解决 / 已修复）
    if (base.key === 'defect-agent' && level === 'success') {
      return { ...base, icon: CheckCircle2, accent: '#86efac', popupStyle: 'celebrate' };
    }
    return base;
  }

  // 未注册来源：按 level 兜底
  if (level === 'warning' || level === 'error') {
    return { ...DEFAULT_TYPE, key: 'alert', label: '系统告警', icon: AlertTriangle, accent: '#fca5a5', popupStyle: 'alert' };
  }
  if (level === 'success') {
    return { ...DEFAULT_TYPE, key: 'success', icon: CheckCircle2, accent: '#86efac', popupStyle: 'celebrate' };
  }
  return DEFAULT_TYPE;
}
