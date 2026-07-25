/**
 * 复制集每容器专属色（2026-07-24 用户拍板：分支卡与画布都按容器标颜色 + xN）。
 * 稳定 hash → 调色板：同一 profileId 在分支卡徽章 / 容器级画布 / 项目级节点
 * 三处颜色一致，用户扫一眼即可对应。
 */
export const REPLICA_PROFILE_PALETTE = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#14b8a6', // teal
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#22c55e', // green
  '#c2372f', // brick
] as const;

export function profileColor(profileId: string): string {
  let h = 0;
  for (let i = 0; i < profileId.length; i += 1) h = (h * 31 + profileId.charCodeAt(i)) >>> 0;
  return REPLICA_PROFILE_PALETTE[h % REPLICA_PROFILE_PALETTE.length];
}

/** 分支卡短名：去掉与项目 id 重复的尾缀（api-prd-agent → api） */
export function profileShortName(profileId: string, projectId?: string): string {
  if (projectId && profileId.endsWith(`-${projectId}`)) return profileId.slice(0, -(projectId.length + 1));
  return profileId;
}
