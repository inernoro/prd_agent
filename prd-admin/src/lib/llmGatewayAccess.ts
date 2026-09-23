import { hasEffectivePermission } from '@/lib/permissionAccess';

export const LLM_GATEWAY_ACCESS_PERMISSION = 'llm-gateway.access';

/**
 * 模型网关入口只认后台有效权限，不再把 PM/DEV/QA/ADMIN 业务角色混作授权。
 */
export function canOpenLlmGateway(
  permissions: string[],
  isRoot = false,
): boolean {
  return hasEffectivePermission(permissions, LLM_GATEWAY_ACCESS_PERMISSION, isRoot);
}
