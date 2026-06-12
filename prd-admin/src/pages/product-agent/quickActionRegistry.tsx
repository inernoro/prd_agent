/**
 * 产品管理智能体 — 工作台「快捷操作」注册表（SSOT，遵循 frontend-architecture 注册表模式）。
 *
 * 把单产品视图内的既有操作入口统一登记为可配置的快捷操作：
 * - create：直达新建页（需求 / 功能 / 缺陷）
 * - goto：页面直达（切换单产品视图 tab）
 *
 * 注意：这里只登记"系统里真实存在的入口"（无根之木禁令）——新增页面/操作时在此追加一行，
 * 工作台快捷操作配置弹窗即自动可选。后端只存 id 有序列表（UserPreferences.ProductAgentPreferences）。
 */
import type { LucideIcon } from 'lucide-react';
import type { NavigateFunction } from 'react-router-dom';
import {
  Plus,
  Bug,
  Puzzle,
  GitBranch,
  ListChecks,
  LayoutGrid,
  BarChart3,
  Table2,
  UserCog,
  BookOpen,
  Share2,
} from 'lucide-react';

export interface QuickActionContext {
  productId: string;
  navigate: NavigateFunction;
  /** 切换单产品视图 tab（key 与 SingleProductView 的 Section 一致） */
  gotoTab: (tab: string) => void;
}

export interface QuickActionDef {
  id: string;
  label: string;
  icon: LucideIcon;
  /** 分组：create 新建对象 / goto 页面直达 */
  group: 'create' | 'goto';
  run: (ctx: QuickActionContext) => void;
}

export const QUICK_ACTION_GROUP_LABEL: Record<QuickActionDef['group'], string> = {
  create: '新建',
  goto: '页面直达',
};

/** 未配置时的默认快捷操作 */
export const DEFAULT_QUICK_ACTION_IDS = ['create-requirement', 'create-defect'];

export const QUICK_ACTION_REGISTRY: QuickActionDef[] = [
  // ── 新建 ──
  { id: 'create-requirement', label: '创建需求', icon: Plus, group: 'create', run: ({ productId, navigate }) => navigate(`/product-agent/p/${productId}/requirement/new`) },
  { id: 'create-defect', label: '创建缺陷', icon: Bug, group: 'create', run: ({ productId, navigate }) => navigate(`/product-agent/p/${productId}/defect/new`) },
  { id: 'create-feature', label: '创建功能', icon: Puzzle, group: 'create', run: ({ productId, navigate }) => navigate(`/product-agent/p/${productId}/feature/new`) },
  // ── 页面直达 ──
  { id: 'goto-board', label: '看板', icon: LayoutGrid, group: 'goto', run: ({ gotoTab }) => gotoTab('board') },
  { id: 'goto-reports', label: '报表', icon: BarChart3, group: 'goto', run: ({ gotoTab }) => gotoTab('reports') },
  { id: 'goto-versions', label: '版本管理', icon: GitBranch, group: 'goto', run: ({ gotoTab }) => gotoTab('versions') },
  { id: 'goto-requirements', label: '需求列表', icon: ListChecks, group: 'goto', run: ({ gotoTab }) => gotoTab('requirements') },
  { id: 'goto-rtm', label: '追溯矩阵', icon: Table2, group: 'goto', run: ({ gotoTab }) => gotoTab('rtm') },
  { id: 'goto-features', label: '功能列表', icon: Puzzle, group: 'goto', run: ({ gotoTab }) => gotoTab('features') },
  { id: 'goto-defects', label: '缺陷列表', icon: Bug, group: 'goto', run: ({ gotoTab }) => gotoTab('defects') },
  { id: 'goto-team', label: '团队', icon: UserCog, group: 'goto', run: ({ gotoTab }) => gotoTab('team') },
  { id: 'goto-knowledge', label: '知识库', icon: BookOpen, group: 'goto', run: ({ gotoTab }) => gotoTab('knowledge') },
  { id: 'goto-graph', label: '图谱', icon: Share2, group: 'goto', run: ({ gotoTab }) => gotoTab('graph') },
];

const BY_ID = new Map(QUICK_ACTION_REGISTRY.map((a) => [a.id, a]));

/** id 列表 → 操作定义（忽略已下线/未知 id，保证向前兼容） */
export function resolveQuickActions(ids: string[]): QuickActionDef[] {
  return ids.map((id) => BY_ID.get(id)).filter((a): a is QuickActionDef => a != null);
}
