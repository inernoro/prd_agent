/**
 * 分支独立库初始化方式的枚举 SSOT（数据库隔离收敛 4）。
 * 独立成文件是为了让台账（db-ledger）与克隆初始化（per-branch-db-init）都能引用而不成环。
 */
import type { BuildProfile } from '../types.js';

export const DB_INIT_MODES = ['empty', 'clone'] as const;
export type DbInitMode = (typeof DB_INIT_MODES)[number];
export const DB_INIT_LABEL: Record<DbInitMode, string> = { empty: '空库重跑迁移', clone: '从共享库时间点克隆' };

export function isDbInitMode(v: unknown): v is DbInitMode {
  return v === 'empty' || v === 'clone';
}

/** 未声明时按空库（应用启动时自己建库、跑迁移）折算 */
export function effectiveDbInit(profile: Pick<BuildProfile, 'dbInit'>): DbInitMode {
  return isDbInitMode(profile.dbInit) ? profile.dbInit : 'empty';
}

export const MONGO_CLONE_REFUSAL = 'mongo 的分支独立库暂不支持时间点克隆：共享 mongo 实例大批量写入会崩（复制集通道为此改用专用实例），按空库初始化';
