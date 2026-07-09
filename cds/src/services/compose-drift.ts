/**
 * compose-drift.ts — 波4 漂移巡检(repo compose = 纯结构种子)
 *
 * 设计定位见 `doc/design.cds.config-tree.md` §七 + `doc/plan.cds.status.md` §〇 波4。
 *
 * repo 的 `cds-compose.yml` 被降级为「纯结构种子」:只声明服务/依赖/路由/资源结构,
 * 零密钥零环境值。CDS 配置树(项目虚拟 compose + env scope)才是运行时 SSOT。
 * 本模块是**单向**(repo → CDS)漂移巡检的纯函数大脑:
 *
 * - 把 repo compose 的结构与 CDS 现有配置树 diff;
 * - 按权威分级(见 `config-authority.ts` 的 `classifyEnvSeed` + 字段权威表)分别归类:
 *     · repo 结构漂移(repo 声明、CDS 缺/异)→ 「同步建议」,走 pending-import 人审落地;
 *     · CDS 运行时独占(env 值 / 端口等)→ 「CDS 权威,绝不回写 repo」;
 *     · repo 携带的密钥/占位符 env → 「应剥离」违规(偿还 D1);
 * - CDS 侧运行时改动**不**触发回写 repo(单向种子)。
 *
 * 纯函数:输入 repo 解析结果 + CDS 侧快照,输出报告。不读文件、不查 DB、不打 docker。
 */

import type { CdsComposeConfig } from './compose-parser.js';
import { classifyEnvSeed, type EnvSeedBelonging } from './config-authority.js';

/** CDS 侧现有配置树的最小快照(由路由从 stateService 组装后传入)。 */
export interface LiveComposeSnapshot {
  /** 项目现有 build profile id 集合。 */
  buildProfileIds: string[];
  /** profile id → 启动命令(repo 权威结构字段,用于检测命令漂移)。 */
  profileCommands: Record<string, string | undefined>;
  /** 项目现有 infra service id 集合。 */
  infraServiceIds: string[];
  /** 项目现有路由规则 id 集合。 */
  routingRuleIds: string[];
  /** CDS 已有的 env 键(项目 customEnv scope + 全局兜底合并后的键集合)。 */
  envKeys: string[];
}

export interface EnvSeedIssue {
  key: string;
  belonging: EnvSeedBelonging;
  isSecret: boolean;
  isPlaceholder: boolean;
  reason: string;
}

export interface ComposeStructuralDrift {
  /** repo 声明、CDS 缺失的 profile(建议同步新增)。 */
  addedProfiles: string[];
  /** CDS 有、repo 已不声明的 profile(repo 结构权威;删除破坏性,仅报告不自动删)。 */
  removedProfiles: string[];
  /** 两侧都有但启动命令不同的 profile(repo 权威,建议同步)。 */
  changedProfileCommands: string[];
  /** repo 声明、CDS 缺失的 infra 服务。 */
  addedInfra: string[];
  /** repo 声明、CDS 缺失的路由规则。 */
  addedRoutes: string[];
  /** repo 结构默认 env 键(非密钥),CDS 尚无 → 建议同步。 */
  addedStructuralEnvKeys: string[];
}

export interface ComposeDriftReport {
  hasRepoCompose: boolean;
  /** repo 携带的、本应只存在于 CDS env scope 的键(密钥/占位符)→ 应剥离。 */
  secretsInRepo: EnvSeedIssue[];
  structuralDrift: ComposeStructuralDrift;
  cdsOwnedOnly: {
    /** 只在 CDS 侧存在的 env 键(CDS 运行时权威,绝不回写 repo)。 */
    envKeysOnlyInLive: string[];
    reason: string;
  };
  /** 存在 repo→CDS 结构漂移,建议开一条 repo-sync pending-import 走人审。 */
  syncRecommended: boolean;
  /** 面向人的「同步建议」清单(中文,面板/PR 评论可直接展示)。 */
  suggestions: string[];
}

const EMPTY_STRUCTURAL: ComposeStructuralDrift = {
  addedProfiles: [],
  removedProfiles: [],
  changedProfileCommands: [],
  addedInfra: [],
  addedRoutes: [],
  addedStructuralEnvKeys: [],
};

/**
 * 计算 repo compose(结构种子)与 CDS 配置树之间的单向漂移。
 *
 * @param repo   `parseCdsCompose(repoYaml)` 的结果;无 repo compose 传 null。
 * @param live   CDS 侧现有配置树快照。
 */
export function computeComposeDrift(
  repo: CdsComposeConfig | null,
  live: LiveComposeSnapshot,
): ComposeDriftReport {
  if (!repo) {
    return {
      hasRepoCompose: false,
      secretsInRepo: [],
      structuralDrift: { ...EMPTY_STRUCTURAL },
      cdsOwnedOnly: { envKeysOnlyInLive: [], reason: 'CDS 运行时 env 由 env scope 权威管理,不回写 repo' },
      syncRecommended: false,
      suggestions: ['仓库没有 cds-compose.yml;结构种子缺失,漂移巡检跳过(可用 cdscli scan 生成后再纳管)'],
    };
  }

  // ── env 分级 ──────────────────────────────────────────────
  const repoEnv = repo.envVars || {};
  const liveEnvSet = new Set(live.envKeys);
  const secretsInRepo: EnvSeedIssue[] = [];
  const addedStructuralEnvKeys: string[] = [];
  for (const [key, value] of Object.entries(repoEnv)) {
    const cls = classifyEnvSeed(key, value);
    if (cls.belonging === 'cds-env-scope') {
      secretsInRepo.push({
        key,
        belonging: cls.belonging,
        isSecret: cls.isSecret,
        isPlaceholder: cls.isPlaceholder,
        reason: cls.reason,
      });
      continue;
    }
    // repo-structural:CDS 尚无该键 → 结构漂移(建议同步)。
    if (!liveEnvSet.has(key)) addedStructuralEnvKeys.push(key);
  }
  const repoEnvKeys = new Set(Object.keys(repoEnv));
  const envKeysOnlyInLive = live.envKeys.filter((k) => !repoEnvKeys.has(k));

  // ── profile / infra / route 结构 diff ─────────────────────
  const liveProfileIds = new Set(live.buildProfileIds);
  const repoProfileIds = new Set(repo.buildProfiles.map((p) => p.id));
  const addedProfiles = repo.buildProfiles.map((p) => p.id).filter((id) => !liveProfileIds.has(id));
  const removedProfiles = live.buildProfileIds.filter((id) => !repoProfileIds.has(id));
  const changedProfileCommands = repo.buildProfiles
    .filter((p) => liveProfileIds.has(p.id))
    .filter((p) => {
      const liveCmd = live.profileCommands[p.id];
      // 只在两侧都声明了命令且不同才算漂移(避免 undefined vs '' 噪音)。
      return p.command !== undefined && liveCmd !== undefined && p.command !== liveCmd;
    })
    .map((p) => p.id);

  const liveInfraIds = new Set(live.infraServiceIds);
  const addedInfra = repo.infraServices.map((s) => s.id).filter((id) => !liveInfraIds.has(id));

  const liveRouteIds = new Set(live.routingRuleIds);
  const addedRoutes = (repo.routingRules || []).map((r) => r.id).filter((id) => !liveRouteIds.has(id));

  const structuralDrift: ComposeStructuralDrift = {
    addedProfiles,
    removedProfiles,
    changedProfileCommands,
    addedInfra,
    addedRoutes,
    addedStructuralEnvKeys,
  };

  const syncRecommended =
    addedProfiles.length > 0 ||
    changedProfileCommands.length > 0 ||
    addedInfra.length > 0 ||
    addedRoutes.length > 0 ||
    addedStructuralEnvKeys.length > 0;

  // ── 同步建议(人可读)──────────────────────────────────────
  const suggestions: string[] = [];
  if (secretsInRepo.length > 0) {
    suggestions.push(
      `仓库 cds-compose.yml 仍携带 ${secretsInRepo.length} 个密钥/占位符键(${secretsInRepo
        .map((s) => s.key)
        .join(', ')});应从结构种子剥离,实际值走 CDS env scope`,
    );
  }
  if (addedProfiles.length > 0) suggestions.push(`repo 新增 ${addedProfiles.length} 个构建配置:${addedProfiles.join(', ')}`);
  if (removedProfiles.length > 0) suggestions.push(`repo 已不再声明 ${removedProfiles.length} 个 CDS 现存构建配置:${removedProfiles.join(', ')}(删除破坏性,请人工确认)`);
  if (changedProfileCommands.length > 0) suggestions.push(`repo 修改了 ${changedProfileCommands.length} 个构建配置的启动命令:${changedProfileCommands.join(', ')}`);
  if (addedInfra.length > 0) suggestions.push(`repo 新增 ${addedInfra.length} 个基础设施:${addedInfra.join(', ')}`);
  if (addedRoutes.length > 0) suggestions.push(`repo 新增 ${addedRoutes.length} 条路由规则:${addedRoutes.join(', ')}`);
  if (addedStructuralEnvKeys.length > 0) suggestions.push(`repo 新增 ${addedStructuralEnvKeys.length} 个结构默认 env 键:${addedStructuralEnvKeys.join(', ')}`);
  if (envKeysOnlyInLive.length > 0) suggestions.push(`${envKeysOnlyInLive.length} 个 env 键仅存在于 CDS(运行时权威,不回写 repo)`);
  if (suggestions.length === 0) suggestions.push('repo 结构种子与 CDS 配置树一致,无漂移');

  return {
    hasRepoCompose: true,
    secretsInRepo,
    structuralDrift,
    cdsOwnedOnly: {
      envKeysOnlyInLive,
      reason: 'CDS 运行时 env 由 env scope 权威管理,repo 结构种子不声明其值,漂移巡检不回写 repo',
    },
    syncRecommended,
    suggestions,
  };
}
