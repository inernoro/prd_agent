/*
 * branch-network — 分支级网络隔离的纯函数 SSOT。
 *
 * 背景（2026-06-29）：同一项目的所有分支共享一张 docker 网络（project.dockerNetwork，
 * 默认 cds-proj-<id>），app 容器用 `--network-alias <服务名>`（apigateway / imp-api …）
 * 注册服务发现别名，而别名是项目级、不带分支前缀的。当某分支把 apigateway 拆成独立服务，
 * 多个分支在同一张网上注册同名别名 → Docker 内置 DNS 轮询 → A 分支后端可能解析到 B 分支
 * 的网关 → 跨分支串流。端口（allocatePort 全局去重）与容器名（cds-<分支>-<服务>）都已隔离，
 * 唯独网络别名按项目共享、没按分支隔离。
 *
 * 根治：每分支一张 app 网（cds-br-<分支id>）承载 app↔app 服务发现（别名仅本分支可见），
 * 共享 infra 网（沿用 project.dockerNetwork）承载 app↔infra（mysql/redis 仍共享，不浪费）。
 * app 容器主网 = 分支网（带 app 别名）+ 运行后 connect 到共享网（无别名，仅为可达 infra）。
 * infra 容器不变（留在共享网，带 infra 别名）。一次性 job 容器无别名 → 不碰，留共享网。
 *
 * 设计原则（2026-06-29 用户校正）：**自动逐分支隔离，不做项目级硬开关，也不限制分支**。
 *   - 一个分支随便部署多少个（临时/实验）容器，都只落在它自己的分支网里，永远「影响不到别的分支」。
 *   - 不是「项目级开关一拨影响所有分支」（那本身就是『一个影响多个』的设计误差），而是隔离作为
 *     每个分支天然的沙箱默认存在；不 block、不限额、不禁止分支加服务——只是把爆炸半径收到本分支。
 *   - 迁移天然渐进：分支下次部署即自动落到分支网，存量容器照常运行，无需 flag day。
 *   - 只保留一个**全局逃生开关**（系统级 env `CDS_BRANCH_NETWORK_ISOLATION`，万一线上异常可一键回退到
 *     旧共享网行为），而非任何「一处配置耦合多分支」的项目级旋钮。
 *
 * 详见 doc/design.cds.branch-network-isolation.md。
 */

/**
 * 全局逃生开关：分支级网络隔离是否启用。默认**开**（每分支自动隔离）。
 * 仅当系统级 env `CDS_BRANCH_NETWORK_ISOLATION` 显式置为 `0` / `false` / `off`（大小写不敏感）时
 * 才全局回退到旧的「全分支共享一张项目网」行为。这是系统级逃生阀，不是项目/分支级旋钮——
 * 不耦合任何单个分支，杜绝「一处配置影响多个分支」。
 */
export function branchNetworkIsolationEnabled(
  env: Record<string, string | undefined> = {},
): boolean {
  const raw = String(env.CDS_BRANCH_NETWORK_ISOLATION ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return true;
}

export interface BranchNetworkPlan {
  /** docker run 的主网络（--network）。隔离时 = 分支网；否则 = 共享网。 */
  runNetwork: string;
  /** 主网络上的 --network-alias 列表（app↔app 服务发现）。 */
  runAliases: string[];
  /**
   * 容器 run 之后需要 `docker network connect`（无别名）的附加网络。
   * 隔离时 = [共享 infra 网]，让 app 能解析 mysql/redis 等共享 infra；
   * 不带别名，故兄弟分支无法在共享网上按 app 别名解析到本容器（杜绝串流）。
   */
  connectNetworks: string[];
}

/** docker 网络名合法字符：[a-zA-Z0-9][a-zA-Z0-9_.-]*。分支 id 一般已是安全 slug，仍防御性 sanitize。 */
export function branchAppNetworkName(branchId: string): string {
  const safe = String(branchId || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 60)
    || 'branch';
  return `cds-br-${safe}`;
}

/**
 * 计算一个 app/profile 容器的网络方案（纯函数，便于单测，container.ts 据此拼 docker 命令）。
 *
 * - isolated=false（默认 / 老项目）：runNetwork = 共享网，带 app 别名，无附加连接 —— 与现状完全一致。
 * - isolated=true：runNetwork = 分支网（带 app 别名，app↔app 仅本分支可见）+ connectNetworks=[共享网]
 *   （无别名，仅为可达共享 infra）。
 */
export function resolveAppNetworkPlan(opts: {
  isolated: boolean;
  sharedNetwork: string;
  branchId: string;
  aliases: string[];
}): BranchNetworkPlan {
  const aliases = (opts.aliases || []).filter(Boolean);
  if (!opts.isolated) {
    return { runNetwork: opts.sharedNetwork, runAliases: aliases, connectNetworks: [] };
  }
  const branchNetwork = branchAppNetworkName(opts.branchId);
  // 防御：分支网恰好等于共享网（理论上不会，命名前缀不同）时，退化为不隔离，避免自连自身。
  if (branchNetwork === opts.sharedNetwork) {
    return { runNetwork: opts.sharedNetwork, runAliases: aliases, connectNetworks: [] };
  }
  return {
    runNetwork: branchNetwork,
    runAliases: aliases,
    connectNetworks: [opts.sharedNetwork],
  };
}
