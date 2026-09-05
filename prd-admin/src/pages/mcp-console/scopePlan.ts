import type { McpCapabilityDto } from '@/services/contracts/mcpConsole';

export interface CapabilityPick {
  read: boolean;
  write: boolean;
}

export type CapabilityPicks = Record<string, CapabilityPick>;

/**
 * 「跟着我的权限走」这一档此刻包含哪几项。
 *
 * 判据与服务端 `McpCapabilityCatalog.AutoScopesFor` 同源：**我自己有的权限 ∩ 平台开放的能力**。
 * 服务端才是真值（自动模式的钥匙每次鉴权现算），这里算的是同一件事的**预览**——
 * 让用户在点下去之前就看见他要交出什么，而不是签完再去别处翻。
 *
 * 两处判据必须同口径。不同口径的后果是弹窗上写着「都给它了」，
 * 连上去却少一块 —— 把用户请到门口再关门。
 */
export function autoPicks(capabilities: McpCapabilityDto[]): CapabilityPicks {
  const picks: CapabilityPicks = {};
  for (const cap of capabilities) {
    if (!cap.availableToMe) continue;
    picks[cap.key] = {
      read: !!cap.readScope,
      // 只有读权限位的人，写入档签不出来 —— 自动模式也不能替他长出来
      write: !!cap.writeScope && cap.writeAvailableToMe,
    };
  }
  return picks;
}

/** 把勾选摊平成 scope 清单（手动模式提交用；自动模式不提交清单）。 */
export function picksToScopes(capabilities: McpCapabilityDto[], picks: CapabilityPicks): string[] {
  const list: string[] = [];
  for (const cap of capabilities) {
    const pick = picks[cap.key];
    if (!pick) continue;
    if (pick.read && cap.readScope) list.push(cap.readScope);
    if (pick.write && cap.writeScope) list.push(cap.writeScope);
  }
  return Array.from(new Set(list));
}

/** 当前勾选是不是就等于「跟着我的权限走」那一档（用来判断用户到底动没动过）。 */
export function samePicks(a: CapabilityPicks, b: CapabilityPicks): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] ?? { read: false, write: false };
    const y = b[k] ?? { read: false, write: false };
    if (x.read !== y.read || x.write !== y.write) return false;
  }
  return true;
}
