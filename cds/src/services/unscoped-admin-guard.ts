/*
 * 「借服务器级凭据且无项目语境」的操作只许管理员会话或全权全局 Key。
 *
 * 原先只在 projects.ts 里；通知通道路由（系统级、含 webhook 地址与密钥指纹）也要同一道门，
 * 而 routes 之间互相 import 会绕出环，所以把这个纯函数单独放到 services 里，两边共用一份判定。
 *
 * 两类要拦：
 *   - 项目级 key（cdsProjectKey 已盖戳）：项目语境下的东西它可以碰，系统级的不行；
 *   - 带作用域的全局 key（cdsAccess.access.projects 不是 'all'，含 create-only 的 []）：
 *     全局网关放行了它的 GET，但系统级配置不是「只读就无害」——通知通道读接口会回
 *     webhook 地址（可能带 token）、Bark 密钥尾号、MAP 端点与用户名。
 */
import type { AgentKeyAccess } from '../types.js';

export interface UnscopedAdminRequest {
  cdsProjectKey?: unknown;
  cdsAccess?: { keyId: string; access: AgentKeyAccess };
}

export function assertUnscopedAdmin(
  req: UnscopedAdminRequest,
): null | { status: number; body: Record<string, unknown> } {
  if (req.cdsProjectKey) {
    return {
      status: 403,
      body: {
        error: 'project_key_forbidden',
        message: '该操作借服务器级凭据且无项目语境，仅限管理员 / 控制台会话，项目级 key 不可用。',
      },
    };
  }
  const access = req.cdsAccess?.access;
  if (access && access.projects !== 'all') {
    return {
      status: 403,
      body: {
        error: 'scoped_key_forbidden',
        message: '该操作借服务器级凭据且无项目语境，带作用域的全局 Key 不可用；仅限管理员会话或全权全局 Key。',
      },
    };
  }
  return null;
}
