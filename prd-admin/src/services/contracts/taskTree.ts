import type { ApiResponse } from '@/types/api';

// ── 数据类型 ──

export type TaskStatus = 'idea' | 'planned' | 'building' | 'done' | 'blocked';

export type TaskTree = {
  id: string;
  title: string;
  description?: string;
  ownerId: string;
  nodeCount: number;
  maxDepth: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskNode = {
  id: string;
  treeId: string;
  ownerId: string;
  parentId?: string | null;
  dependsOn: string[];
  title: string;
  description?: string;
  status: TaskStatus;
  blocker?: string | null;
  blockedSince?: string | null;
  order: number;
  positionX: number;
  positionY: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

/** 卡点上报项 */
export type TaskBlockerItem = {
  node: TaskNode;
  ownerName: string;
  treeTitle: string;
  stuckDays: number;
  blocks: string[];
};

// ── 请求类型 ──

export type CreateTaskTreeInput = {
  title: string;
  description?: string;
  rootStatus?: TaskStatus;
};

export type CreateTaskNodeInput = {
  parentId?: string | null;
  title: string;
  description?: string;
  status?: TaskStatus;
  blocker?: string;
  dependsOn?: string[];
  order?: number;
};

export type UpdateTaskNodeInput = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  blocker?: string;
  parentId?: string | null;
  order?: number;
  positionX?: number;
  positionY?: number;
};

// ── Contract 签名 ──

export type CreateTaskTreeContract = (
  input: CreateTaskTreeInput
) => Promise<ApiResponse<{ tree: TaskTree; root: TaskNode }>>;

export type ListTaskTreesContract = (
  includeArchived?: boolean
) => Promise<ApiResponse<{ items: TaskTree[]; total: number }>>;

export type GetTaskTreeContract = (
  treeId: string
) => Promise<ApiResponse<{ tree: TaskTree; nodes: TaskNode[] }>>;

export type DeleteTaskTreeContract = (
  treeId: string
) => Promise<ApiResponse<{ deleted: boolean }>>;

export type CreateTaskNodeContract = (
  treeId: string,
  input: CreateTaskNodeInput
) => Promise<ApiResponse<TaskNode>>;

export type UpdateTaskNodeContract = (
  nodeId: string,
  input: UpdateTaskNodeInput
) => Promise<ApiResponse<TaskNode>>;

export type DeleteTaskNodeContract = (
  nodeId: string
) => Promise<ApiResponse<{ deleted: number }>>;

export type AddTaskDependencyContract = (
  nodeId: string,
  dependsOnId: string
) => Promise<ApiResponse<{ added: boolean }>>;

export type RemoveTaskDependencyContract = (
  nodeId: string,
  dependsOnId: string
) => Promise<ApiResponse<{ removed: boolean }>>;

export type ListTaskBlockersContract = (
  scope?: 'mine' | 'all'
) => Promise<
  ApiResponse<{ items: TaskBlockerItem[]; total: number; canViewAll: boolean; scope: string }>
>;
