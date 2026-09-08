/**
 * Agent 极速版门禁（agent prebuilt-only gate）—— 「这次由 Agent 发起的部署 / 模式写入，
 * 是否会让 CDS 宿主跑源码编译」的唯一判定处。
 *
 * ## 为什么要有它
 *
 * CDS 宿主的编译算力由全部项目共享。Agent 分支一旦用 dev / static 这类源码模式部署，
 * 就是在宿主上跑 dotnet build / pnpm build 试错，一条分支就能把别人的部署排到队尾。
 * 接入口令已经把「只用极速版」写成硬约束，但口令拦不住不守规矩的 Agent；本模块把它
 * 变成服务端的闸：项目开启 `agentPrebuiltOnly` 后，机器凭据的部署与模式写入在入口被拒。
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

import type { BranchEntry, BuildProfile, Project } from '../types.js';
import { isMachineCaller } from './machine-caller.js';
import { resolveActiveDeployModeId } from './deploy-runtime.js';

export const AGENT_PREBUILT_ONLY_ERROR = 'agent_prebuilt_only';

export interface PrebuiltGateViolation {
  profileId: string;
  profileName: string;
  /** 生效的模式 id；空串 = 没有任何模式（纯源码构建） */
  modeId: string;
  modeLabel: string;
}

/** 项目是否开启了「Agent 只允许极速版」。缺省关闭：老项目零变化。 */
export function isAgentPrebuiltOnly(project: Project | undefined | null): boolean {
  return project?.agentPrebuiltOnly === true;
}

/**
 * 这个请求是否受门禁约束：机器凭据发起、且不是内部系统派发。
 * X-CDS-Trigger 是 webhook / 调度器 / 自动生命周期的自标（actor-resolver 解成 system:*），
 * 它们代人跑、不是 Agent 在试错，放行。
 */
export function isAgentGatedRequest(req: unknown): boolean {
  if (!isMachineCaller(req)) return false;
  const headers = (req as { headers?: Record<string, unknown> })?.headers || {};
  const trigger = headers['x-cds-trigger'];
  if (typeof trigger === 'string' && trigger) return false;
  if (Array.isArray(trigger) && trigger[0]) return false;
  return true;
}

/** 某个模式 id 在该 profile 上是不是极速版。空模式 = 基线源码构建，只有镜像站点才算过。 */
export function isPrebuiltMode(profile: BuildProfile, modeId: string | undefined): boolean {
  if (profile.prebuiltImage === true) return true;
  if (!modeId) return false;
  return profile.deployModes?.[modeId]?.prebuilt === true;
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

/** 该 profile 有哪些极速版模式可选（给拒绝信息用，Agent 据此知道该切成什么）。 */
export function listPrebuiltModeIds(profile: BuildProfile): string[] {
  return Object.entries(profile.deployModes || {})
    .filter(([, mode]) => mode?.prebuilt === true)
    .map(([id]) => id);
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
 * 里有哪些写成了非极速版。空串 = 不设默认（回到 profile 基线），按基线判。
 */
export function findNonPrebuiltDefaultModes(
  profiles: BuildProfile[],
  defaults: Record<string, string>,
): PrebuiltGateViolation[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const out: PrebuiltGateViolation[] = [];
  for (const [profileId, rawMode] of Object.entries(defaults)) {
    const profile = byId.get(profileId);
    if (!profile) continue;
    const modeId = (rawMode || '').trim() || profile.activeDeployMode || undefined;
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

/** Agent 在门禁下不得改动的 profile 字段：它们定义了「什么算极速版」，改了就能把源码模式标成 prebuilt。 */
export const PREBUILT_DEFINITION_FIELDS = ['deployModes', 'prebuiltImage'] as const;

export interface PrebuiltGateRejection {
  error: typeof AGENT_PREBUILT_ONLY_ERROR;
  message: string;
  projectId: string;
  violations: Array<PrebuiltGateViolation & { prebuiltModes: string[] }>;
  hint: string;
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
  }));
  const summary = detailed
    .map((v) => `${v.profileName}（当前 ${v.modeLabel}${v.prebuiltModes.length ? `，可切 ${v.prebuiltModes.join(' / ')}` : '，该服务没有极速版模式'}）`)
    .join('；');
  const projectLabel = project.aliasName || project.name || project.id;
  const opLabel = context.operation === 'deploy'
    ? '部署被拦截'
    : context.operation === 'branch-override'
      ? '分支部署模式覆盖被拒绝'
      : context.operation === 'project-default'
        ? '项目默认运行模式（defaultDeployModes）写入被拒绝'
        : '项目默认部署模式修改被拒绝';
  const fix = context.operation === 'profile-default' || context.operation === 'project-default'
    ? '项目默认只能由真人在项目设置页修改；Agent 请用 cdscli branch set-mode <branchId> <profileId> <极速版模式> 只改自己的分支。'
    : context.branchId
      ? `请对每个服务运行 cdscli branch set-mode ${context.branchId} <profileId> <极速版模式> 后重新部署。`
      : '请用 cdscli branch set-mode <branchId> <profileId> <极速版模式> 切到极速版后重新部署。';
  const noPrebuilt = detailed.some((v) => v.prebuiltModes.length === 0);
  return {
    error: AGENT_PREBUILT_ONLY_ERROR,
    message: `项目「${projectLabel}」要求 Agent 只使用极速版（CI 预构建）部署，${opLabel}：${summary}。${fix}`,
    projectId: project.id,
    violations: detailed,
    hint: noPrebuilt
      ? '有服务没有任何极速版模式：这是项目还没接 CI 预构建的缺口，请如实报告给用户，不要切到源码模式顶替。'
      : '极速版生效判据：cdscli branch status <branchId> 的 deployRuntime.prebuilt 为 true。',
  };
}
