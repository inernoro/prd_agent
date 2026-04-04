import type { ApiResponse } from '@/types/api';

// ── 数据类型 ──

export type EmergenceTree = {
  id: string;
  title: string;
  description?: string;
  seedContent: string;
  seedSourceType: string;
  seedSourceId?: string;
  ownerId: string;
  nodeCount: number;
  maxDepth: number;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EmergenceNode = {
  id: string;
  treeId: string;
  parentId?: string;
  parentIds: string[];
  title: string;
  description: string;
  techPlan?: string;
  groundingContent: string;
  groundingType: string;
  groundingRef?: string;
  bridgeAssumptions: string[];
  missingCapabilities: string[];
  dimension: 1 | 2 | 3;
  nodeType: 'seed' | 'capability' | 'combination' | 'fantasy';
  valueScore: number;
  difficultyScore: number;
  status: 'idea' | 'planned' | 'building' | 'done';
  positionX: number;
  positionY: number;
  tags: string[];
  metadata: Record<string, string>;
  createdAt: string;
};

// ── 请求类型 ──

export type CreateEmergenceTreeInput = {
  title?: string;
  description?: string;
  seedContent: string;
  seedSourceType?: string;
  seedSourceId?: string;
  /** 是否注入本系统能力（分析本系统时开启） */
  injectSystemCapabilities?: boolean;
};

export type UpdateEmergenceNodeInput = {
  title?: string;
  description?: string;
  status?: string;
  positionX?: number;
  positionY?: number;
  tags?: string[];
};

// ── Contract 签名 ──

export type CreateEmergenceTreeContract = (
  input: CreateEmergenceTreeInput
) => Promise<ApiResponse<{ tree: EmergenceTree; seedNode: EmergenceNode }>>;

export type ListEmergenceTreesContract = (
  page?: number,
  pageSize?: number
) => Promise<ApiResponse<{ items: EmergenceTree[]; total: number; page: number; pageSize: number }>>;

export type GetEmergenceTreeContract = (
  treeId: string
) => Promise<ApiResponse<{ tree: EmergenceTree; nodes: EmergenceNode[] }>>;

export type DeleteEmergenceTreeContract = (
  treeId: string
) => Promise<ApiResponse<{ deleted: boolean }>>;

export type UpdateEmergenceNodeContract = (
  nodeId: string,
  input: UpdateEmergenceNodeInput
) => Promise<ApiResponse<{ updated: boolean }>>;

export type DeleteEmergenceNodeContract = (
  nodeId: string
) => Promise<ApiResponse<{ deletedCount: number }>>;

export type ExportEmergenceTreeContract = (
  treeId: string
) => Promise<ApiResponse<{ markdown: string }>>;
