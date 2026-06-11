/**
 * 项目管理智能体 — 首页「便捷操作」注册表（SSOT，遵循 frontend-architecture 注册表模式）。
 *
 * 操作分两组：
 * - create：新建对象（创建项目走立项弹窗；创建目标/里程碑/任务预填 AI 助手对话模板，
 *           由 AI 对话补全项目与字段后通过动作协议落库——首页是跨项目工作台，免去先选项目的弹窗）
 * - goto：页面直达（切换工作台一级导航）
 *
 * 注意：这里只登记"系统里真实存在的入口"（无根之木禁令）——新增页面/操作时在此追加一行，
 * 首页便捷操作配置弹窗即自动可选。后端只存 id 有序列表（UserPreferences.PmAgentPreferences）。
 */
import type { LucideIcon } from 'lucide-react';
import {
  FolderPlus,
  Target,
  Milestone,
  ListPlus,
  FolderKanban,
  TrendingUp,
  ShieldCheck,
} from 'lucide-react';

export interface PmQuickActionContext {
  /** 打开立项弹窗 */
  openCreateProject: () => void;
  /** 把模板文本填进 AI 助手输入框（用户补全后发送） */
  fillAssistant: (text: string) => void;
  /** 切换工作台一级导航 */
  gotoNav: (nav: string) => void;
}

export interface PmQuickActionDef {
  id: string;
  label: string;
  icon: LucideIcon;
  /** 分组：create 新建对象 / goto 页面直达 */
  group: 'create' | 'goto';
  /** 需要的权限（缺省所有人可见） */
  permission?: string;
  run: (ctx: PmQuickActionContext) => void;
}

export const PM_QUICK_ACTION_GROUP_LABEL: Record<PmQuickActionDef['group'], string> = {
  create: '新建',
  goto: '页面直达',
};

/** 未配置时的默认便捷操作（对话式创建四件套） */
export const DEFAULT_PM_QUICK_ACTION_IDS = ['create-project', 'create-goal', 'create-milestone', 'create-task'];

export const PM_QUICK_ACTION_REGISTRY: PmQuickActionDef[] = [
  // ── 新建 ──
  { id: 'create-project', label: '创建项目', icon: FolderPlus, group: 'create', run: ({ openCreateProject }) => openCreateProject() },
  {
    id: 'create-goal', label: '创建目标', icon: Target, group: 'create',
    run: ({ fillAssistant }) => fillAssistant('帮我在「项目名称」项目创建一个目标：<目标内容>，量化指标：<可选>'),
  },
  {
    id: 'create-milestone', label: '创建里程碑', icon: Milestone, group: 'create',
    run: ({ fillAssistant }) => fillAssistant('帮我在「项目名称」项目创建一个里程碑：<里程碑名称>，计划完成日期 <yyyy-mm-dd>'),
  },
  {
    id: 'create-task', label: '创建任务', icon: ListPlus, group: 'create',
    run: ({ fillAssistant }) => fillAssistant('帮我在「项目名称」项目创建一个任务：<任务标题>，优先级 <高/中/低>，截止 <yyyy-mm-dd>，我来负责'),
  },
  // ── 页面直达 ──
  { id: 'goto-projects', label: '项目列表', icon: FolderKanban, group: 'goto', run: ({ gotoNav }) => gotoNav('projects') },
  { id: 'goto-dashboard', label: 'NPSS 看板', icon: TrendingUp, group: 'goto', permission: 'pm-agent.dashboard', run: ({ gotoNav }) => gotoNav('dashboard') },
  { id: 'goto-audit', label: '审计日志', icon: ShieldCheck, group: 'goto', permission: 'pm-agent.audit', run: ({ gotoNav }) => gotoNav('audit') },
];

const BY_ID = new Map(PM_QUICK_ACTION_REGISTRY.map((a) => [a.id, a]));

/** id 列表 → 操作定义（忽略已下线/未知 id，保证向前兼容） */
export function resolvePmQuickActions(ids: string[]): PmQuickActionDef[] {
  return ids.map((id) => BY_ID.get(id)).filter((a): a is PmQuickActionDef => a != null);
}
