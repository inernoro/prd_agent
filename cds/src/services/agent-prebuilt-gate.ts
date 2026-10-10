/**
 * Agent 预构建策略门禁（agent prebuilt policy gate）—— 「这次由 Agent 发起的部署 / 模式写入，
 * 是否会让 CDS 宿主跑源码编译」的唯一判定处。
 *
 * ## 为什么要有它
 *
 * CDS 宿主的编译算力由全部项目共享。Agent 分支一旦用 dev / static 这类源码模式部署，
 * 就是在宿主上跑 dotnet build / pnpm build 试错，一条分支就能把别人的部署排到队尾。
 * 提示词本身拦不住不守规矩的 Agent；本模块把项目选择的策略变成服务端闸门：严格模式
 * 全部拒绝源码构建，优先模式只拒绝「已有预构建能力却仍选源码」的部署与模式写入。
 *
 * ## 判据
 *
 * - 「调用方是不是 Agent」只认 machine-caller.ts 的 isMachineCaller，且内部系统派发
 *   （X-CDS-Trigger，见 actor-resolver.ts）豁免——那是 webhook / 调度器代人跑的。
 * - 「模式是不是极速版」只认 deployModes.<mode>.prebuilt 为 true，或整个 profile 是
 *   预构建镜像站点（prebuiltImage）。模式名不是判据。
 * - 生效模式的解析口径与部署一致（分支覆盖 → profile 基线），不看项目默认——
 *   项目默认只在建分支时拷贝进覆盖，部署时不实时读（container.ts resolveEffectiveProfile）。
 *
 * ## 三个消费方共用（predicate-and-wiring-discipline 形状 3）
 *
 * POST /branches/:id/deploy、PUT /branches/:id/profile-overrides/:pid（含 DELETE 回退基线）、
 * PUT /build-profiles/:id/deploy-mode。任何新的「会改变生效部署模式」的入口都必须接到这里，
 * 不得另写一份判定。
 */

import type { AgentPrebuiltPolicy, BranchEntry, BuildProfile, Project } from '../types.js';
import { isMachineCaller } from './machine-caller.js';
import { resolveActiveDeployModeId } from './deploy-runtime.js';

export const AGENT_PREBUILT_ONLY_ERROR = 'agent_prebuilt_only';

const AGENT_PREBUILT_POLICIES = new Set<AgentPrebuiltPolicy>([
  'prebuilt-only',
  'prefer-prebuilt',
  'unrestricted',
]);

export interface PrebuiltGateViolation {
  profileId: string;
  profileName: string;
  /** 生效的模式 id；空串 = 没有任何模式（纯源码构建） */
  modeId: string;
  modeLabel: string;
}

/**
 * 解析项目级 Agent 部署策略。新字段优先；旧状态继续按 agentPrebuiltOnly 解释，
 * 保证升级后不会把原本的硬门禁静默放松。
 */
export function resolveAgentPrebuiltPolicy(project: Project | undefined | null): AgentPrebuiltPolicy {
  const explicit = project?.agentPrebuiltPolicy;
  if (explicit && AGENT_PREBUILT_POLICIES.has(explicit)) return explicit;
  return project?.agentPrebuiltOnly === true ? 'prebuilt-only' : 'unrestricted';
}

/** 项目是否启用了任一 Agent 预构建约束。 */
export function isAgentPrebuiltPolicyEnabled(project: Project | undefined | null): boolean {
  return resolveAgentPrebuiltPolicy(project) !== 'unrestricted';
}

/** 旧调用方兼容：只在真正的严格模式下返回 true。 */
export function isAgentPrebuiltOnly(project: Project | undefined | null): boolean {
  return resolveAgentPrebuiltPolicy(project) === 'prebuilt-only';
}

/**
 * 这个请求是否受门禁约束：机器凭据发起。
 *
 * 不看 X-CDS-Trigger：那是调用方自己写的 header，项目 Agent Key 随手加一个就能绕过全部门禁
 * （Codex PR #1513 第二轮 P1）。也不需要豁免——CDS 内部自调（webhook 派发、pending 重发、
 * auto-lifecycle、项目暂停停容器）走的是 X-CDS-Internal + loopback 的鉴权旁路，**不带机器凭据**，
 * isMachineCaller 本来就判假；真人走 cookie 会话同样判假。
 */
export function isAgentGatedRequest(req: unknown): boolean {
  return isMachineCaller(req);
}

/**
 * 某个模式 id 在该 profile 上是不是极速版。口径与 container.ts resolveProfileWithMode 一致：
 * 模式自己声明的 prebuilt 优先（`override.prebuilt ?? profile.prebuiltImage`），所以镜像站点上
 * 显式 `prebuilt: false` 的源码模式仍算源码；没选模式（基线）只看 prebuiltImage。
 */
export function isPrebuiltMode(profile: BuildProfile, modeId: string | undefined): boolean {
  // managedBuild 是宿主上的源码构建（runService 先于 prebuilt 路径调 buildManagedArtifact，
  // 拷 worktree 跑 install / build），带着它的 profile 不管标了什么都不算极速版（Codex 第五轮 P1）。
  if (profile.managedBuild) return false;
  const mode = modeId ? profile.deployModes?.[modeId] : undefined;
  if (mode && mode.prebuilt !== undefined) return mode.prebuilt === true;
  return profile.prebuiltImage === true;
}

function modeLabel(profile: BuildProfile, modeId: string | undefined): string {
  if (!modeId) return '源码构建（无部署模式）';
  return profile.deployModes?.[modeId]?.label || modeId;
}

/**
 * 找出这条分支上会走源码编译的服务。`pending` 是「这次请求想写成的模式」：
 * PUT 覆盖时用它预演写入后的结果，而不是只看写入前的状态。
 */
export function findNonPrebuiltProfiles(
  profiles: BuildProfile[],
  branch: BranchEntry | undefined,
  pending?: { profileId: string; modeId: string | undefined },
): PrebuiltGateViolation[] {
  const out: PrebuiltGateViolation[] = [];
  for (const profile of profiles) {
    const modeId = pending && pending.profileId === profile.id
      ? pending.modeId
      : resolveActiveDeployModeId(profile, branch);
    if (isPrebuiltMode(profile, modeId)) continue;
    out.push({
      profileId: profile.id,
      profileName: profile.name || profile.id,
      modeId: modeId || '',
      modeLabel: modeLabel(profile, modeId),
    });
  }
  return out;
}

/**
 * 该 profile 有哪些极速版模式可选（给拒绝信息用，Agent 据此知道该切成什么）。
 * 与 isPrebuiltMode 同一判据：镜像站点上未声明 prebuilt 的模式继承 prebuiltImage，也算可切
 * （Codex 第四轮 P2：只列显式 true 会让 Agent 收到「没有极速版模式」而无法自救）。
 */
export function listPrebuiltModeIds(profile: BuildProfile): string[] {
  return Object.keys(profile.deployModes || {}).filter((id) => isPrebuiltMode(profile, id));
}

/** profile 基线或任一具名模式是否具备真正的预构建能力。 */
export function hasPrebuiltCapability(profile: BuildProfile): boolean {
  return isPrebuiltMode(profile, undefined) || listPrebuiltModeIds(profile).length > 0;
}

/**
 * 把“会走源码构建”的事实按项目策略过滤成真正应阻断的集合。
 * prefer-prebuilt 只阻断已经具备极速版能力、却仍选择源码模式的服务；尚未接 CI
 * 预构建的服务允许继续部署。判据集中在这里，所有部署和模式写入口共用。
 */
export function enforceAgentPrebuiltPolicy(
  project: Project | undefined | null,
  profiles: BuildProfile[],
  violations: PrebuiltGateViolation[],
): PrebuiltGateViolation[] {
  const policy = resolveAgentPrebuiltPolicy(project);
  if (policy === 'unrestricted') return [];
  if (policy === 'prebuilt-only') return violations;
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return violations.filter((violation) => {
    const profile = byId.get(violation.profileId);
    return Boolean(profile && hasPrebuiltCapability(profile));
  });
}

/**
 * 镜像拉取失败时是否必须禁止回退到宿主源码编译。严格模式全部禁止；优先模式
 * 只对已经拥有极速版能力的服务禁止，未接入预构建的服务仍按原配置运行。
 */
export function shouldDisableSourceFallback(
  project: Project | undefined | null,
  profile: BuildProfile,
): boolean {
  const policy = resolveAgentPrebuiltPolicy(project);
  if (policy === 'prebuilt-only') return true;
  if (policy === 'prefer-prebuilt') return hasPrebuiltCapability(profile);
  return false;
}

/**
 * 门禁下的部署不许回退源码编译。resolveEffectiveProfile 会给极速版 profile 挂一个
 * sourceFallbackProfile，runService 在镜像拉不到时据此**在宿主上编译**——恰是门禁要禁的事
 * （Codex PR #1513 P1）。受门禁约束的部署把它摘掉：镜像拉不到就失败、等 CI，不偷偷编译。
 */
export function withoutSourceFallback<T extends { sourceFallbackProfile?: unknown }>(profile: T): T {
  if (profile.sourceFallbackProfile === undefined) return profile;
  return { ...profile, sourceFallbackProfile: undefined };
}

/**
 * 项目默认 defaultDeployModes（建分支时拷贝进覆盖、align-deploy-modes 会刷进全部分支）
 * 生效后有哪些 profile 会落到非极速版。空串 / 缺项 = 不设默认（回到 profile 基线），按基线判。
 *
 * `coverAllProfiles`：PUT 是**整体替换**这张表，所以要按项目全部 profile 判——只判表里有的项，
 * 机器凭据传一张空表就能把 `{api: express}` 换掉，新分支落回源码基线（Codex 第二轮 P1）。
 * align 只刷表里有的 profile，按条目判即可。
 */
export function findNonPrebuiltDefaultModes(
  profiles: BuildProfile[],
  defaults: Record<string, string>,
  options: { coverAllProfiles?: boolean } = {},
): PrebuiltGateViolation[] {
  const out: PrebuiltGateViolation[] = [];
  const targets = options.coverAllProfiles
    ? profiles
    : profiles.filter((p) => Object.prototype.hasOwnProperty.call(defaults, p.id));
  for (const profile of targets) {
    const profileId = profile.id;
    // 「键不存在」与「键存在但为空串」是两回事（Codex 第四轮 P1）：applyDefaultDeployModesToBranch
    // 会把空串原样写进分支覆盖，resolveActiveDeployModeId 里 `?? ` 让空串胜出 = 不选模式 = 源码基线；
    // 缺键才真正回到 profile 基线 activeDeployMode。
    const hasKey = Object.prototype.hasOwnProperty.call(defaults, profileId);
    const modeId = hasKey
      ? ((defaults[profileId] || '').trim() || undefined)
      : (profile.activeDeployMode || undefined);
    if (isPrebuiltMode(profile, modeId)) continue;
    out.push({
      profileId,
      profileName: profile.name || profile.id,
      modeId: modeId || '',
      modeLabel: modeLabel(profile, modeId),
    });
  }
  return out;
}

/**
 * Agent 在门禁下不得改动的 profile 字段：它们定义了「什么算极速版」，改了就能把源码模式标成 prebuilt。
 * managedBuild 也在内：它让 runService 先在宿主上跑 install / build 再起容器，机器凭据给极速版配置
 * 加上它，直接部署虽被 isPrebuiltMode 拦下，随后的 push 走豁免的 webhook 派发照样在宿主编译（Codex 第八轮 P1）。
 */
export const PREBUILT_DEFINITION_FIELDS = ['deployModes', 'prebuiltImage', 'managedBuild'] as const;

export interface PrebuiltGateRejection {
  error: typeof AGENT_PREBUILT_ONLY_ERROR;
  message: string;
  projectId: string;
  policy: AgentPrebuiltPolicy;
  settingsPath: string;
  violations: Array<PrebuiltGateViolation & { prebuiltModes: string[]; prebuiltBaseline: boolean }>;
  hint: string;
  recovery: {
    kind: 'switch-to-prebuilt' | 'configure-prebuilt-or-change-policy';
    requiresHuman: boolean;
    commands: string[];
  };
}

/** 模式定义类写入的统一拒绝体：同样向 Agent 暴露项目策略和真人恢复入口。 */
export function buildPrebuiltPolicyMutationRejection(
  project: Project,
  message: string,
  hint: string,
): PrebuiltGateRejection {
  return {
    error: AGENT_PREBUILT_ONLY_ERROR,
    message,
    projectId: project.id,
    policy: resolveAgentPrebuiltPolicy(project),
    settingsPath: `/settings/${encodeURIComponent(project.id)}#general`,
    violations: [],
    hint,
    recovery: {
      kind: 'configure-prebuilt-or-change-policy',
      requiresHuman: true,
      commands: [],
    },
  };
}

/** 统一的 409 响应体。message 面向 Agent：说清被拦的服务、当前模式、该切成什么、用哪条命令。 */
export function buildPrebuiltGateRejection(
  project: Project,
  profiles: BuildProfile[],
  violations: PrebuiltGateViolation[],
  context: { branchId?: string; operation: 'deploy' | 'branch-override' | 'profile-default' | 'project-default' },
): PrebuiltGateRejection {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const detailed = violations.map((v) => ({
    ...v,
    prebuiltModes: listPrebuiltModeIds(byId.get(v.profileId) || ({ deployModes: {} } as BuildProfile)),
    prebuiltBaseline: isPrebuiltMode(byId.get(v.profileId) || ({ deployModes: {} } as BuildProfile), undefined),
  }));
  const summary = detailed
    .map((v) => `${v.profileName}（当前 ${v.modeLabel}${
      v.prebuiltModes.length
        ? `，可切 ${v.prebuiltModes.join(' / ')}`
        : v.prebuiltBaseline
          ? '，可回到极速版基线'
          : '，该服务没有极速版模式'
    }）`)
    .join('；');
  const projectLabel = project.aliasName || project.name || project.id;
  const policy = resolveAgentPrebuiltPolicy(project);
  const policyLabel = policy === 'prebuilt-only'
    ? '仅极速版（CI 预构建）'
    : policy === 'prefer-prebuilt'
      ? '优先极速版（有预构建能力时必须使用）'
      : '不限制';
  const settingsPath = `/settings/${encodeURIComponent(project.id)}#general`;
  const opLabel = context.operation === 'deploy'
    ? '部署被拦截'
    : context.operation === 'branch-override'
      ? '分支部署模式覆盖被拒绝'
      : context.operation === 'project-default'
        ? '项目默认运行模式（defaultDeployModes）写入被拒绝'
        : '项目默认部署模式修改被拒绝';
  const exactCommands = context.branchId
    ? detailed
      .filter((violation) => violation.prebuiltModes.length > 0 || violation.prebuiltBaseline)
      .map((violation) => violation.prebuiltModes.length > 0
        ? `cdscli branch set-mode ${context.branchId} ${violation.profileId} ${violation.prebuiltModes[0]}`
        : `cdscli branch set-mode ${context.branchId} ${violation.profileId} ""`)
    : [];
  const fix = context.operation === 'profile-default' || context.operation === 'project-default'
    ? '项目默认只能由真人在项目设置页修改；Agent 请用 cdscli branch set-mode <branchId> <profileId> <极速版模式> 只改自己的分支。'
    : exactCommands.length > 0
      ? `请运行 ${exactCommands.join('；')} 后重新部署。`
      : '请用 cdscli branch set-mode <branchId> <profileId> <极速版模式> 切到极速版后重新部署。';
  const noPrebuilt = detailed.some((v) => v.prebuiltModes.length === 0 && !v.prebuiltBaseline);
  return {
    error: AGENT_PREBUILT_ONLY_ERROR,
    message: `项目「${projectLabel}」的 Agent 部署策略为「${policyLabel}」，${opLabel}：${summary}。${fix}`,
    projectId: project.id,
    policy,
    settingsPath,
    violations: detailed,
    hint: noPrebuilt
      ? `有服务没有任何极速版模式：这是项目还没接 CI 预构建的缺口。请准确说明这是项目级策略，不是 CDS 全局限制；真人可在项目设置 ${settingsPath} 改为「优先极速版」或「不限制」，Agent 不得自行修改。`
      : '极速版生效判据：cdscli branch status <branchId> 的 deployRuntime.prebuilt 为 true。',
    recovery: {
      kind: noPrebuilt ? 'configure-prebuilt-or-change-policy' : 'switch-to-prebuilt',
      requiresHuman: noPrebuilt || context.operation === 'profile-default' || context.operation === 'project-default',
      commands: exactCommands,
    },
  };
}
