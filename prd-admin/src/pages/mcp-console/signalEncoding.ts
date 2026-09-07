import type { McpCapabilityDto, McpClientDto } from '@/services/contracts/mcpConsole';
import { isReadOnlyTier } from './scopePlan';

/**
 * 一块能力对一把钥匙处在哪一档。色点的形状与颜色都由它决定。
 *
 * - `write` 这块能力分读写两档，钥匙拿到了写档（实心点）
 * - `full`  这块能力只有一档（视觉/文学只有写档、海鲜市场只有读档），钥匙拿到了它（实心点）
 * - `read`  只拿到了读档，而这块能力确实还有一个写档（空心圆环）
 * - `none`  一点都没给（虚线空圈）
 *
 * `full` 与 `write` 形状相同、说法不同：海鲜市场拿到 `marketplace.skills:read` 是完整权限，
 * 但后端并没有给它任何写接口，标成「能写」就是在撒谎（review 里抓出来的）。
 */
export type CapabilityTier = 'write' | 'full' | 'read' | 'none';

export interface CapabilitySignal {
  key: string;
  title: string;
  tier: CapabilityTier;
}

export interface ClientSignal {
  /** 五块能力按目录顺序排好，顺序本身也是识别通道之一 */
  dots: CapabilitySignal[];
  grantedCount: number;
  readOnlyCount: number;
  /** 色点旁那句摘要。色点是主通道，这句话是它的文字冗余，不是装饰 */
  summary: string;
  /** 能力卡认领不到的 scope：登记表里的开放接口 */
  extraScopes: string[];
  /** 手动档 —— 左侧那道色带用它 */
  pinned: boolean;
}

/**
 * 这块能力对这把钥匙处在哪一档。
 *
 * 判据只此一处，并且**复用** <c>isReadOnlyTier</c> —— 「只读」这件事在本模块里
 * 再判一次的话，两处迟早各漂各的。而这个判断有两个反直觉的形状，各自都出过事：
 *
 * - 视觉创作与文学创作**只有写档**（`readScope` 为空）：拿到那一个 scope 就是完整权限；
 * - 海鲜市场**只有读档**（`writeScope` 为空）：拿到那一个 scope 也是完整权限，
 *   不能标成「只读」—— 那等于暗示还有一档没给他，而那一档根本不存在。
 *
 * 所以「只读」的充分条件不是「没拿到写档」，而是「有写档、且没拿到」。
 */
export function capabilityTier(
  cap: Pick<McpCapabilityDto, 'readScope' | 'writeScope'>,
  heldLowercase: ReadonlySet<string>,
): CapabilityTier {
  const hasWrite = !!cap.writeScope && heldLowercase.has(cap.writeScope.toLowerCase());
  const hasRead = !!cap.readScope && heldLowercase.has(cap.readScope.toLowerCase());
  if (!hasWrite && !hasRead) return 'none';
  if (isReadOnlyTier(cap, heldLowercase)) return 'read';
  // 只有一档的能力：拿到那一档就是完整权限，但它未必是「写」——按能力实际的档位形状说话
  const singleTier = !cap.readScope || !cap.writeScope;
  return singleTier ? 'full' : 'write';
}

/** 色点的三种形状：实心 = 拿满了；圆环 = 只拿到读档；虚线圈 = 一点没给 */
export type DotShape = 'solid' | 'ring' | 'dashed';

/**
 * 档位注册表：一档的说法与形状登记在同一处（frontend-architecture 的注册表模式）。
 * 新增一档时 TypeScript 会逼着在这里补一行，标签与形状不会各漂各的。
 */
export const TIER_REGISTRY: Record<CapabilityTier, { label: string; shape: DotShape }> = {
  write: { label: '能写', shape: 'solid' },
  full: { label: '已开', shape: 'solid' },
  read: { label: '只能看', shape: 'ring' },
  none: { label: '未开', shape: 'dashed' },
};

/** 一个色点该怎么念（读屏与长按提示都用它）。文字与色点同源，不会各说各的。 */
export function tierLabel(tier: CapabilityTier): string {
  return TIER_REGISTRY[tier].label;
}

/**
 * 把一把钥匙的授权算成「一行色点 + 一句摘要」。
 *
 * 这是视觉编码方向的核心：**通用的解释交给图例说一次**，每张卡上只留这一行；
 * 而具体到某把钥匙的例外（停用、过期、手动档还缺哪几块）仍然是文字，
 * 因为那几句是要用户去做点什么的，不是可以靠认颜色学会的常识。
 */
export function clientSignal(
  client: Pick<McpClientDto, 'scopes' | 'scopeMode'>,
  capabilities: McpCapabilityDto[],
): ClientSignal {
  const held = new Set((client.scopes ?? []).map((s) => s.toLowerCase()));
  const dots = capabilities.map((cap) => ({
    key: cap.key,
    title: cap.title,
    tier: capabilityTier(cap, held),
  }));

  const grantedCount = dots.filter((d) => d.tier !== 'none').length;
  const readOnlyCount = dots.filter((d) => d.tier === 'read').length;

  // 能力卡认领掉的 scope 之外还剩什么 —— 登记表里的开放接口走 `agent.*`，
  // 网关照样把它们当工具列出来，这一行不提就等于报一个假的零。
  const named = new Set(
    capabilities
      .filter((cap) => capabilityTier(cap, held) !== 'none')
      .flatMap((cap) => [cap.readScope, cap.writeScope].filter(Boolean).map((s) => s!.toLowerCase())),
  );
  const extraScopes = (client.scopes ?? []).filter((s) => !named.has(s.toLowerCase()));

  return {
    dots,
    grantedCount,
    readOnlyCount,
    summary: summaryOf(grantedCount, readOnlyCount, dots.length),
    extraScopes,
    pinned: client.scopeMode !== 'auto',
  };
}

/**
 * 色点旁那句话。
 *
 * 它不是给色点配的标题，是色点的**文字冗余** —— 色觉障碍的用户、以及还没学会
 * 这套点的人，靠这句话也能读出同一件事。所以它必须自带数字，不能写成「已授权」。
 */
function summaryOf(granted: number, readOnly: number, total: number): string {
  if (granted === 0) return `${total} 块都没开`;
  // 有只读的时候不许说「全开」——上一版写的是「5 块全开 · 2 块只能看」，
  // 一句话自己跟自己打架（真机上看出来的）。granted 把只读也算在内，
  // 所以「全开」只在**一块只读都没有**时才成立。
  // 完整那一档统一说「已开」不说「能写」：只有读档的能力（海鲜市场）拿满了也不能写。
  if (readOnly > 0) return `${granted - readOnly} 块已开 · ${readOnly} 块只能看`;
  return granted === total ? `${total} 块全开` : `${granted}/${total} 块已开`;
}
