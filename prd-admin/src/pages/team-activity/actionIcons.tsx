/**
 * 动作类型 → 图标注册表（GitLab 时间线式事件图标）。
 * 按关键词有序匹配动作复合键（如 DocumentStore.AddEntry / DefectAgent.ResolveDefect），
 * 不在表内的动作走兜底图标，永不崩溃。遵循 frontend-architecture.md 注册表模式。
 */
import {
  Activity,
  Check,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  Upload,
  UserPlus,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

/** 有序匹配：先命中先用（Delete 要先于 Create 等宽泛词不冲突，按语义独立排列） */
const ACTION_ICON_RULES: Array<{ keywords: string[]; icon: LucideIcon }> = [
  { keywords: ['Delete'], icon: Trash2 },
  { keywords: ['Upload'], icon: Upload },
  { keywords: ['Comment', 'Message'], icon: MessageSquare },
  { keywords: ['Assign'], icon: UserPlus },
  { keywords: ['Resolve', 'VerifyPass'], icon: Check },
  { keywords: ['Reject', 'Return'], icon: Undo2 },
  { keywords: ['Close'], icon: XCircle },
  { keywords: ['Reopen'], icon: RotateCcw },
  { keywords: ['Submit', 'Review'], icon: Send },
  { keywords: ['Update', 'Save'], icon: Pencil },
  { keywords: ['Create', 'Add'], icon: Plus },
];

export function getActionIcon(action: string): LucideIcon {
  for (const rule of ACTION_ICON_RULES) {
    if (rule.keywords.some((k) => action.includes(k))) return rule.icon;
  }
  return Activity;
}
