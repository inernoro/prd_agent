import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState, InfraService, DeployModeOverride, BuildProfileOverride, ReadinessProbe, ExecResult } from '../types.js';
import { combinedOutput } from '../types.js';
import { resolveCommandTemplate, resolveEnvTemplates } from './compose-parser.js';
import { sanitizeDockerRestartPolicy } from '../config/docker-restart-policy.js';
import { applyPerBranchDbIsolation } from './db-scope-isolation.js';
import { nodeModulesVolumeName } from '../util/node-modules-volume.js';
import {
  collectContainerDiagnostics,
  recordContainerLifecycleIntent,
  type ContainerLifecycleIntentKind,
} from './container-diagnostics.js';
import type { ServerEventLogSink, ServerEventRecord, ServerEventSeverity } from './server-event-log-store.js';

/**
 * 项目级 docker network 解析器接口。
 * ContainerService 通过这个接口查询 project.dockerNetwork（避免直接耦合 StateService）。
 *
 * Week 4.9 多项目网络隔离：每个项目都有独立 docker network `cds-proj-<id>`,
 * 跨项目容器互相不可见。老项目（pre-P4 / dockerNetwork 字段缺失）回退到
 * config.dockerNetwork 共享网络,保持 backward compat。
 */
export interface ProjectNetworkResolver {
  /** 返回该项目的 dockerNetwork,缺失则返回 undefined（调用方走 config 兜底）。 */
  getDockerNetwork(projectId: string): string | undefined;
  /**
   * 返回该项目的 slug(可读名,如 `mdimp` / `prd-agent`),缺失/未实现则返回
   * undefined。Bug D-residual 用于把"短别名启发式"的 projectMarker 从 id
   * (随机后缀) 升级为 slug。可选方法,旧实现不实现也不会编译错(运行时
   * fallback 到 projectId)。
   */
  getProjectSlug?(projectId: string): string | undefined;
}

export interface ContainerRemoveContext {
  kind?: ContainerLifecycleIntentKind;
  reason?: string;
  projectId?: string | null;
  branchId?: string | null;
  profileId?: string | null;
  serviceId?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  actor?: string | null;
  trigger?: string | null;
  operation?: string | null;
  source?: string | null;
  details?: Record<string, unknown>;
}

function isDockerNoSuchContainer(result: { stderr?: string; stdout?: string }): boolean {
  return /No such container:/i.test(`${result.stderr || ''}\n${result.stdout || ''}`);
}

function classifyRemoveCompletion(rmResult: { exitCode: number; stderr?: string; stdout?: string }): {
  severity: ServerEventSeverity;
  status: 'removed' | 'already-absent' | 'failed';
} {
  if (rmResult.exitCode === 0) return { severity: 'info', status: 'removed' };
  if (isDockerNoSuchContainer(rmResult)) return { severity: 'warn', status: 'already-absent' };
  return { severity: 'error', status: 'failed' };
}

/**
 * 2026-04-22 —— 热更新命令模板。enabled 时由 resolveProfileWithMode 优先应用。
 * 依据 hotReload.mode 生成 watcher 命令；mode='custom' 时用 hotReload.command。
 *
 * 为什么 dotnet-restart 比 dotnet-watch 可靠（见 types.ts HotReloadConfig 注释）：
 *   watch 的 hot-reload 偶尔只更新内存不重启进程，加上 MSBuild 增量编译有概率
 *   误判"项目引用未变"跳过 compile，会出现 DLL 里有新字符串、源码和 DLL 都对
 *   但运行进程加载的还是老字节码。dotnet-restart 的轮询脚本强制：
 *     1) 每次循环先 `dotnet clean` + `rm -rf bin obj`（cleanBeforeBuild=true）
 *     2) `dotnet build --no-incremental` 禁用增量编译
 *     3) kill 旧 PID + 等 wait 再起新进程，保证字节码一定重新加载
 */
export function resolveHotReloadCommand(profile: BuildProfile): string | null {
  const hr = profile.hotReload;
  if (!hr || !hr.enabled) return null;
  const port = profile.containerPort;
  const watchEnv = hr.usePolling ? 'DOTNET_USE_POLLING_FILE_WATCHER=1 CHOKIDAR_USEPOLLING=1 ' : '';
  switch (hr.mode) {
    case 'dotnet-run': {
      // 快路径：相信 MSBuild 增量 + dotnet run，文件变 → kill + 再跑。
      // 不 clean，不 --no-incremental；如需破缓存走清理按钮（force-rebuild）。
      const lines = [
        `set +e`,
        `STAMP=/tmp/cds-hr-${profile.id}-stamp`,
        `touch "$STAMP"`,
        `while true; do`,
        `echo "[hot-reload/${profile.id}] dotnet run (增量) at $(date +%T)"`,
        `touch "$STAMP"`,
        `dotnet run --urls http://0.0.0.0:${port} &`,
        `DOTNET_PID=$!`,
        `echo "[hot-reload/${profile.id}] pid=$DOTNET_PID"`,
        `while kill -0 $DOTNET_PID 2>/dev/null; do`,
        `  sleep 2`,
        `  CHANGED=$(find . -type f \\( -name "*.cs" -o -name "*.csproj" -o -name "*.json" \\) -not -path "*/bin/*" -not -path "*/obj/*" -newer "$STAMP" 2>/dev/null | head -1)`,
        `  if [ -n "$CHANGED" ]; then echo "[hot-reload/${profile.id}] change detected: $CHANGED"; break; fi`,
        `done`,
        `kill -TERM $DOTNET_PID 2>/dev/null || true; sleep 1; kill -KILL $DOTNET_PID 2>/dev/null || true`,
        `wait $DOTNET_PID 2>/dev/null || true`,
        `done`,
      ];
      return `${watchEnv}sh -c ${JSON.stringify(lines.join('; '))}`;
    }
    case 'dotnet-restart': {
      const clean = hr.cleanBeforeBuild !== false;
      const cleanStep = clean
        ? 'dotnet clean -v q >/dev/null 2>&1 || true; find . -type d \\( -name bin -o -name obj \\) -prune -exec rm -rf {} +;'
        : '';
      // 单行 shell 脚本（容器 command 一行串）：
      //   1) STAMP 文件记录上次 build 完成时间；用于 find -newer 判断是否有源码变更
      //   2) build 失败：sleep 10 重试（避免无限占 CPU）
      //   3) 启动 dotnet run 作为子进程，捕获 PID
      //   4) 每 2 秒 poll 一次：源码比 STAMP 新 → break 循环进入 kill+rebuild；
      //      或进程意外死亡 → break 进入重启
      //   5) SIGTERM + 1s 宽限 + SIGKILL，保证 dotnet 真死（不然端口会占着）
      const lines = [
        `set +e`,
        `STAMP=/tmp/cds-hr-${profile.id}-stamp`,
        `touch "$STAMP"`,
        `while true; do`,
        cleanStep,
        `echo "[hot-reload/${profile.id}] build start $(date +%T)"`,
        `dotnet build -c Debug --no-incremental -v m`,
        `BUILD_RC=$?`,
        `if [ $BUILD_RC -ne 0 ]; then echo "[hot-reload/${profile.id}] build failed rc=$BUILD_RC, retry in 10s"; sleep 10; continue; fi`,
        `touch "$STAMP"`,
        `dotnet run --no-build --urls http://0.0.0.0:${port} &`,
        `DOTNET_PID=$!`,
        `echo "[hot-reload/${profile.id}] started pid=$DOTNET_PID at $(date +%T)"`,
        `while kill -0 $DOTNET_PID 2>/dev/null; do`,
        `  sleep 2`,
        `  CHANGED=$(find . -type f \\( -name "*.cs" -o -name "*.csproj" -o -name "*.json" \\) -newer "$STAMP" 2>/dev/null | head -1)`,
        `  if [ -n "$CHANGED" ]; then echo "[hot-reload/${profile.id}] change detected: $CHANGED, restarting"; break; fi`,
        `done`,
        `kill -TERM $DOTNET_PID 2>/dev/null || true`,
        `sleep 1`,
        `kill -KILL $DOTNET_PID 2>/dev/null || true`,
        `wait $DOTNET_PID 2>/dev/null || true`,
        `done`,
      ];
      return `${watchEnv}sh -c ${JSON.stringify(lines.join('; '))}`;
    }
    case 'dotnet-watch':
      // 保留但不推荐。UI 上标红提示用户有 MSBuild 增量误判的风险。
      return `${watchEnv}dotnet watch run --non-interactive --urls http://0.0.0.0:${port}`;
    case 'pnpm-dev':
      return `${watchEnv}pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port ${port}`;
    case 'vite':
      return `${watchEnv}pnpm install --prefer-frozen-lockfile && pnpm vite --host 0.0.0.0 --port ${port}`;
    case 'next-dev':
      return `${watchEnv}pnpm install --prefer-frozen-lockfile && pnpm next dev -p ${port}`;
    case 'custom':
      return hr.command ? `${watchEnv}${hr.command}` : null;
    default:
      return null;
  }
}

/**
 * Resolve a BuildProfile with active deploy mode overrides applied.
 * Returns a new profile object with command/dockerImage/env merged from the mode.
 *
 * 2026-04-22 —— hotReload 在最后叠加；enabled 时直接覆盖 command，
 * 让容器跑 watcher 命令而非一次性构建。
 */
export function resolveProfileWithMode(profile: BuildProfile): BuildProfile {
  const mode = profile.activeDeployMode;
  let resolved: BuildProfile = profile;
  if (mode && profile.deployModes?.[mode]) {
    const override = profile.deployModes[mode];
    // 2026-06-23 极速版：prebuilt 模式跳过 source mount(复用 prebuiltImage 语义),
    // containerPort 覆盖预构建镜像监听端口(api/admin 生产镜像 8080,与源码模式不同)。
    const willBePrebuilt = override.prebuilt ?? profile.prebuiltImage ?? false;
    resolved = {
      ...profile,
      // prebuilt 模式若未显式给 command,**不继承** baseline 的源码构建命令
      // (镜像里没有 SDK/源码,跑 baseline 命令必失败),置空 → runService 用镜像
      // 自带 ENTRYPOINT/CMD 启动。
      command: override.command ?? (willBePrebuilt ? '' : profile.command),
      dockerImage: override.dockerImage ?? profile.dockerImage,
      env: override.env
        ? { ...profile.env, ...override.env }
        : profile.env,
      ...(override.prebuilt !== undefined ? { prebuiltImage: override.prebuilt } : {}),
      ...(override.containerPort !== undefined ? { containerPort: override.containerPort } : {}),
      // 极速版「逐组件回退主分支」:把本模式的 fallbackImage 一并带出,供 runService 在
      // 本 commit 无该组件镜像时回退（path-filter 只构建改动组件,某些 commit 缺镜像）。
      ...(override.fallbackImage !== undefined ? { fallbackImage: override.fallbackImage } : {}),
    };
  }
  // 极速版(prebuilt)不跑 hot reload watcher —— 镜像里是编译产物,没有源码可 watch。
  if (resolved.prebuiltImage) {
    return resolved;
  }
  // Hot reload 优先级最高
  const hrCmd = resolveHotReloadCommand(resolved);
  if (hrCmd) {
    return { ...resolved, command: hrCmd };
  }
  return resolved;
}

/**
 * 2026-06-23 极速版 —— 解析 dockerImage 里的部署期模板变量。
 *
 * 极速版镜像 tag 由 commit SHA 决定（CI 按 `github.sha` 推 `sha-<SHA>` tag），
 * 必须在拿到具体分支上下文时才能确定。支持:
 *   - `${CDS_COMMIT_SHA}`  → **优先 branch.ciTargetSha**，退而 branch.githubCommitSha
 *   - `${CDS_BRANCH_SLUG}` → 分支名 slugify（与 CI 的 branch-<slug> 移动 tag 对齐）
 *
 * 为何优先 ciTargetSha（Bugbot High: prebuilt image tag ignores ciTargetSha）：
 *   ciTargetSha 是「CI 真正构建出镜像的那个 commit」的 SSOT；githubCommitSha 只是
 *   「最近一次 push 的 commit」，会被 docs-only push / 被闸门拦下的 check_run 重跑悄悄推进，
 *   而它们并不产生新镜像。若用 githubCommitSha 渲染 tag，会拉到错 SHA 的镜像或静默回退
 *   branch-main，使预览与已就绪的 CI 产物不一致。故极速版 tag 锁定 ciTargetSha。
 *   ciTargetSha 未设（如从未走过 CI 的分支）时退回 githubCommitSha，行为不变。
 *
 * 纯函数,export 给单测用。无模板变量时原样返回。
 */
export function resolveImageTemplate(image: string | undefined, branch?: BranchEntry): string | undefined {
  if (!image || image.indexOf('${') === -1) return image;
  const sha = branch?.ciTargetSha || branch?.githubCommitSha || '';
  const slug = slugifyBranchForImage(branch?.branch || '');
  return image
    .replace(/\$\{CDS_COMMIT_SHA\}/g, sha)
    .replace(/\$\{CDS_BRANCH_SLUG\}/g, slug);
}

/**
 * 分支名 → 镜像 tag slug。**必须与 CI 的 `.github/workflows/branch-image.yml` 经
 * docker/metadata-action `type=ref,event=branch,prefix=branch-` 推送的 tag 一致**,
 * 否则 path-filter 跳过某组件时 `branch-${CDS_BRANCH_SLUG}` 回退会找不到本分支镜像
 * （Codex P2: align branch-image fallback slugging）。docker/metadata-action 的 sanitizeTag:
 *   - 只把**不属于 Docker tag 合法字符集** `[A-Za-z0-9._-]` 的连续序列替换为 '-';
 *   - **保留大小写**、保留 '_' 和 '.'（不像旧实现那样小写 + 改写 '_'/'.'）;
 *   - 例: `my/branch`→`my-branch`、`Codex/fix`→`Codex-fix`、`release/v1.2`→`release-v1.2`。
 * 额外去掉前导 '.'/'-'(Docker tag 不能以它们开头) + 截到 128 字符上限。
 */
export function slugifyBranchForImage(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 128);
}

/**
 * Merge a branch-level BuildProfileOverride onto the shared baseline profile.
 * Only fields set in the override take effect; env is key-wise merged on top
 * of the baseline (override wins per key). Returns a NEW object — the baseline
 * is never mutated.
 */
export function applyProfileOverride(baseline: BuildProfile, override?: BuildProfileOverride): BuildProfile {
  if (!override) return baseline;
  return {
    ...baseline,
    ...(override.dockerImage !== undefined ? { dockerImage: override.dockerImage } : {}),
    ...(override.command !== undefined ? { command: override.command } : {}),
    ...(override.containerWorkDir !== undefined ? { containerWorkDir: override.containerWorkDir } : {}),
    ...(override.containerPort !== undefined ? { containerPort: override.containerPort } : {}),
    ...(override.pathPrefixes !== undefined ? { pathPrefixes: override.pathPrefixes } : {}),
    ...(override.resources !== undefined ? { resources: override.resources } : {}),
    ...(override.activeDeployMode !== undefined ? { activeDeployMode: override.activeDeployMode } : {}),
    ...(override.startupSignal !== undefined ? { startupSignal: override.startupSignal } : {}),
    ...(override.readinessProbe !== undefined ? { readinessProbe: override.readinessProbe } : {}),
    ...(override.dbScope !== undefined ? { dbScope: override.dbScope } : {}),
    ...(override.entrypoint !== undefined ? { entrypoint: override.entrypoint } : {}),
    env: override.env
      ? { ...(baseline.env || {}), ...override.env }
      : baseline.env,
  };
}

/**
 * Resolve the final effective profile for a specific branch deployment.
 *
 * Merge order (later wins per field):
 *   1. baseline BuildProfile         — the shared public definition
 *   2. branch-level override         — BranchEntry.profileOverrides[profileId]
 *   3. deploy-mode override          — profile.deployModes[activeDeployMode]
 *
 * 2026-05-14：用户明确选择「项目默认运行模式只在创建分支时拷贝一次」
 * （保留旧 UI 承诺「不改已有分支」）。因此这里**不再**读
 * Project.defaultDeployModes 做实时回退——项目默认由 branches.ts 的
 * applyProjectDefaultDeployModes() 在建分支时写进 branch.profileOverrides，
 * 之后就是普通的分支级 override，本函数只认 branch override + baseline。
 */
export function resolveEffectiveProfile(profile: BuildProfile, branch?: BranchEntry): BuildProfile {
  const branchOverride = branch?.profileOverrides?.[profile.id];
  const withBranchOverride = applyProfileOverride(profile, branchOverride);
  const withMode = resolveProfileWithMode(withBranchOverride);
  // 2026-06-23 极速版：deploy-mode 解析完后,把 dockerImage / fallbackImage 里的
  // ${CDS_COMMIT_SHA} 等模板变量按当前分支上下文替换。无模板变量时是 no-op。
  // fallbackImage 可为字符串或有序数组(逐组件回退链),逐元素解析。
  const resolvedImage = resolveImageTemplate(withMode.dockerImage, branch);
  const resolvedFallback = Array.isArray(withMode.fallbackImage)
    ? withMode.fallbackImage.map((f) => resolveImageTemplate(f, branch) || f)
    : resolveImageTemplate(withMode.fallbackImage, branch);
  const imageChanged = resolvedImage !== withMode.dockerImage;
  const fallbackChanged = JSON.stringify(resolvedFallback) !== JSON.stringify(withMode.fallbackImage);
  if (imageChanged || fallbackChanged) {
    return {
      ...withMode,
      dockerImage: resolvedImage || withMode.dockerImage,
      ...(withMode.fallbackImage !== undefined ? { fallbackImage: resolvedFallback } : {}),
    };
  }
  return withMode;
}

/** 把 BuildProfile.fallbackImage(string | string[] | undefined) 规整为有序候选数组。 */
export function normalizeFallbackImages(fallback: string | string[] | undefined): string[] {
  if (!fallback) return [];
  return (Array.isArray(fallback) ? fallback : [fallback]).map((s) => (s || '').trim()).filter(Boolean);
}

/**
 * 2026-06-24 发布探活分阶段（R4）。发布(部署)首启可能很慢（构建/迁移/JVM 暖机），
 * 给足探测时间避免被探活超时误杀；运行期重启/唤醒不走这里，保持各 profile 自己的短超时。
 * 下限解析优先级：项目覆盖 > 系统默认 > 1200 兜底。纯函数，可单测。
 */
export function resolveDeployReadinessFloorSeconds(
  systemDefault: number | null | undefined,
  projectOverride: number | null | undefined,
): number {
  if (typeof projectOverride === 'number' && projectOverride > 0) return projectOverride;
  if (typeof systemDefault === 'number' && systemDefault > 0) return systemDefault;
  return 1200;
}

/**
 * 把就绪探测 timeout 抬到部署下限（取 max），其余字段(path/interval/noHttp)原样保留。
 * 只在部署路径调用；返回新对象不改原 probe。floor<=0 时原样返回。
 */
export function applyDeployReadinessFloor(
  probe: ReadinessProbe | undefined,
  floorSeconds: number,
): ReadinessProbe | undefined {
  if (!(floorSeconds > 0)) return probe;
  const current = probe?.timeoutSeconds ?? 0;
  if (current >= floorSeconds) return probe;
  return { ...(probe ?? {}), timeoutSeconds: floorSeconds };
}

function missingEnvTemplates(env: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const value of Object.values(env)) {
    value.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_match, name: string, defaultVal: string | undefined) => {
      if (env[name] === undefined && process.env[name] === undefined && defaultVal === undefined) {
        missing.add(name);
      }
      return '';
    });
  }
  return Array.from(missing).sort();
}

/** docker stats 单容器瞬时值(2026-05-04 Phase B) */
export interface ContainerStats {
  name: string;
  /** 0-100,可超过 100(多核场景);UI 显示时按 cores 归一 */
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
  /** 容器生命周期累计;前端做 ring buffer 算 delta 才能得到瞬时速率 */
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

/** 把 docker stats 输出的 "1.234MiB" / "5.6kB" / "2.1GiB" 解析为 bytes */
function parseDockerSize(s: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B|B)?$/i.exec(s.trim());
  if (!m) return 0;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] || 'B').toUpperCase();
  // docker 用 IEC(KiB=1024)和 SI(kB=1000)混用,docker stats 默认 IEC。
  // 我们统一按 IEC 解析(差距 ~2.4%,UI 展示用不到精确)。
  const multipliers: Record<string, number> = {
    'B': 1,
    'KIB': 1024, 'KB': 1024,
    'MIB': 1024 ** 2, 'MB': 1024 ** 2,
    'GIB': 1024 ** 3, 'GB': 1024 ** 3,
    'TIB': 1024 ** 4, 'TB': 1024 ** 4,
  };
  return value * (multipliers[unit] || 1);
}

function parseFloatSafe(s: string): number {
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Bug D fix(2026-05-10) — profile 容器 docker network alias 计算。
 *
 * 输入:profile.id(如 'imp-api-mdimp' / 'mysql-mdimp' / 'web-2')和 entry.projectId
 * (用来去掉项目后缀)。
 *
 * 输出:alias 列表,**保证不空**(profile.id 永远是第一个 alias)。可能多于一个:
 *   - 'imp-api-mdimp' + 'imp-api'(去掉项目后缀产生的短名)
 *   - 'mysql-mdimp'   + 'mysql'
 *   - 'web-2'         + 'web-2'(没有项目后缀,只有自己)
 *
 * 启发式去后缀:profile.id 形如 `<service>-<projectMarker>` 时,projectMarker
 * 通常包含项目 slug 的前几位或全部。我们安全的做法:**只**剥掉 `-<projectId-prefix>`
 * 或 `-<最后一个连字符段>` 当后者长度 ≤ 12,且不会产生空串。
 *
 * 边界:
 *   - profile.id 不含 '-' → 只有自己一个 alias
 *   - 去后缀后等于 profile.id 自己(去重)→ 只返回 profile.id
 *
 * 这是纯函数,export 出来给 unit test 用。
 */
export function computeProfileAliases(
  profileId: string,
  projectMarkers: string | string[],
): string[] {
  const aliases = new Set<string>();
  if (profileId) aliases.add(profileId);

  // Bug D-residual followup(2026-05-10):callers 传的"项目标识"可能是
  // project.id(随机后缀如 `defd4695ab5f`)也可能是 project.slug(可读名如
  // `mdimp`)。若 profile.id 形如 `mysql-mdimp` 但传入的 projectMarker 是
  // `defd4695ab5f`,startsWith 比对永远 false → 短别名 `mysql` 永远加不上。
  // 这里把 projectMarkers 标准化成数组,任一 marker 命中即可,鲁棒覆盖
  // (id, slug, [id, slug]) 三种调用方式,旧调用方零改动。
  const markers = Array.isArray(projectMarkers) ? projectMarkers : [projectMarkers];
  const normalizedMarkers = markers
    .map((m) => (m || '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter((m) => m.length > 0);

  const lastDashIdx = profileId.lastIndexOf('-');
  if (lastDashIdx > 0 && lastDashIdx < profileId.length - 1) {
    const head = profileId.slice(0, lastDashIdx);
    const tail = profileId.slice(lastDashIdx + 1);
    const tailNorm = tail.toLowerCase();
    const tailWellFormed =
      tail.length > 0 &&
      tail.length <= 12 &&
      /^[a-z0-9]+$/.test(tailNorm);
    const looksLikeProjectMarker =
      tailWellFormed &&
      normalizedMarkers.some(
        (m) => m.startsWith(tailNorm) || tailNorm === m.slice(0, tail.length),
      );
    if (looksLikeProjectMarker && head.length >= 2) {
      aliases.add(head);
    }
  }
  return Array.from(aliases);
}

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: CdsConfig,
    /**
     * 可选的项目网络解析器。Week 4.9 多项目网络隔离：传入后,容器会跑在
     * `project.dockerNetwork`（默认 `cds-proj-<id>`）上,跨项目隔离。
     * 缺省（不传）则全部跑在 `config.dockerNetwork` 上,等同 pre-P4 共享网络。
     *
     * 历史调用方迁移：所有线上代码（index.ts / executor / branches）应注入
     * StateService 适配器（见 index.ts new ContainerService(...)）。测试可省略
     * 这个参数走兜底分支。
     */
    private readonly networkResolver?: ProjectNetworkResolver,
    private readonly serverEventLogStore?: ServerEventLogSink | null,
  ) {}

  private recordContainerEvent(record: {
    severity: ServerEventSeverity;
    source: string;
    action: string;
    message?: string;
    projectId?: string | null;
    branchId?: string | null;
    profileId?: string | null;
    serviceId?: string | null;
    requestId?: string | null;
    operationId?: string | null;
    containerName?: string | null;
    status?: string | null;
    exitCode?: number | null;
    oomKilled?: boolean | null;
    inspect?: Record<string, unknown>;
    logs?: ServerEventRecord['logs'];
    command?: { name?: string; exitCode?: number; stdoutPreview?: string; stderrPreview?: string };
    error?: { code?: string; message?: string };
    details?: Record<string, unknown>;
  }): void {
    this.serverEventLogStore?.record({
      category: 'container',
      ...record,
    });
  }

  private async captureContainerDiagnostics(containerName: string, tailLines = 200): Promise<{
    inspect?: Record<string, unknown>;
    logs?: ServerEventRecord['logs'];
    error?: { message: string };
  }> {
    return collectContainerDiagnostics(this.shell, containerName, tailLines);
  }

  private noteLifecycleIntent(
    containerName: string,
    kind: ContainerLifecycleIntentKind,
    reason: string,
    context: ContainerRemoveContext = {},
  ): void {
    recordContainerLifecycleIntent({ containerName, kind, reason, ...context });
  }

  /**
   * 解析特定项目的 docker network 名称。Week 4.9 多项目网络隔离：
   *   1. 调用方传 projectId 且 networkResolver 已注入 → 优先用 project.dockerNetwork
   *   2. project.dockerNetwork 字段为空（老项目） → 兜底用 config.dockerNetwork
   *   3. 没传 projectId → 兜底用 config.dockerNetwork
   *
   * 三个兜底点合在一处,确保任何调用路径都不会拿到空字符串导致 docker run 报错。
   */
  private getNetworkForProject(projectId?: string | null): string {
    if (!projectId || !this.networkResolver) return this.config.dockerNetwork;
    return this.networkResolver.getDockerNetwork(projectId) || this.config.dockerNetwork;
  }

  /**
   * Bug D-residual followup(2026-05-10):为 computeProfileAliases 收集"项目
   * 标识候选"——同时返回 projectId(随机后缀)和 slug(可读名)。短别名启发式
   * 命中任一即可,不会因为 profile.id 用 slug 而 projectId 用 id 而漏判。
   */
  private getProjectMarkers(projectId?: string | null): string[] {
    if (!projectId) return [];
    const markers: string[] = [projectId];
    const slug = this.networkResolver?.getProjectSlug?.(projectId);
    if (slug && slug !== projectId) markers.push(slug);
    return markers;
  }

  /**
   * Write env vars to a temp file and return its path.
   * Uses --env-file instead of -e to avoid shell escaping issues
   * with special characters (@, #, !, etc.) in values.
   */
  private writeEnvFile(mergedEnv: Record<string, string>): string {
    const envFilePath = path.join(os.tmpdir(), `cds-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const lines = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envFilePath, lines.join('\n'), 'utf-8');
    return envFilePath;
  }

  private removeEnvFile(envFilePath: string): void {
    try { fs.unlinkSync(envFilePath); } catch { /* ok */ }
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private resolveProfileRuntimeEnv(
    entry: BranchEntry,
    profile: BuildProfile,
    customEnv?: Record<string, string>,
  ): Record<string, string> {
    const mergedEnv: Record<string, string> = {};

    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    // JWT — CDS 自身鉴权密钥不得穿透进项目容器。
    // 历史行为曾把 CDS_JWT_SECRET 兜底映射为项目 Jwt__Secret，导致 CDS
    // 自身密钥轮换会破坏业务项目登录签名和 prd-agent 存量平台密文。
    // 现在只允许项目 scope 自己提供 Jwt__Secret；兼容旧 compose 的
    // JWT_SECRET 也必须来自项目 env，而不是 CDS 全局 config.jwt.secret。
    if (!mergedEnv['Jwt__Secret'] && mergedEnv['JWT_SECRET']) {
      mergedEnv['Jwt__Secret'] = mergedEnv['JWT_SECRET'];
    }
    if (!mergedEnv['Jwt__Issuer']) mergedEnv['Jwt__Issuer'] = this.config.jwt.issuer;

    const isNodeContainer = /\bnode:/.test(profile.dockerImage);
    if (isNodeContainer) {
      mergedEnv['PNPM_HOME'] = mergedEnv['PNPM_HOME'] || '/pnpm';
      mergedEnv['npm_config_store_dir'] = mergedEnv['npm_config_store_dir'] || '/pnpm/store';
      const currentPath = mergedEnv['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      if (!currentPath.includes('/pnpm')) {
        mergedEnv['PATH'] = `/pnpm:${currentPath}`;
      }
    }

    if (profile.env) {
      Object.assign(mergedEnv, profile.env);
    }

    const deployCommit = entry.pinnedCommit || entry.githubCommitSha || entry.lastDeployDispatchCommitSha;
    if (entry.branch) {
      mergedEnv['VITE_GIT_BRANCH'] = entry.branch;
    }
    if (deployCommit) {
      // 平台版本元数据必须覆盖项目 env，供发布中心和 /api/version 判断当前部署 commit。
      mergedEnv['GIT_COMMIT'] = deployCommit;
      mergedEnv['COMMIT_SHA'] = deployCommit;
      mergedEnv['GITHUB_SHA'] = deployCommit;
      mergedEnv['SOURCE_VERSION'] = deployCommit;
      mergedEnv['CDS_COMMIT_SHA'] = deployCommit;
      mergedEnv['VITE_BUILD_ID'] = deployCommit.slice(0, 12);
    }
    const deployTime = entry.lastDeployDispatchAt || entry.lastPushAt || entry.createdAt;
    if (deployTime) {
      mergedEnv['CDS_BUILD_TIME'] = deployTime;
    }

    const isolatedEnv = applyPerBranchDbIsolation(mergedEnv, profile.dbScope, entry.branch);
    const missingTemplates = missingEnvTemplates(isolatedEnv);
    if (missingTemplates.length > 0) {
      throw new Error(
        `环境变量模板缺少值: ${missingTemplates.join(', ')}。请在项目环境变量中填写，或先启动对应基础设施服务后再部署。`,
      );
    }

    const resolveVars: Record<string, string> = { ...isolatedEnv };
    if (customEnv) {
      for (const [k, v] of Object.entries(isolatedEnv)) {
        if (v === `\${${k}}` && customEnv[k] !== undefined) {
          resolveVars[k] = customEnv[k];
        }
      }
    }
    return resolveEnvTemplates(isolatedEnv, resolveVars);
  }

  private async buildProfileVolumeFlags(
    entry: BranchEntry,
    profile: BuildProfile,
    command: string,
    onOutput?: (chunk: string) => void,
  ): Promise<{ containerWorkDir: string; volumeFlags: string[]; isNodeContainer: boolean; skipSrcMount: boolean }> {
    const srcMount = path.join(entry.worktreePath, profile.workDir);
    const containerWorkDir = profile.containerWorkDir || '/app';
    const skipSrcMount = profile.prebuiltImage === true;
    const isNodeContainer = /\bnode:/.test(profile.dockerImage);
    const volumeFlags: string[] = skipSrcMount
      ? []
      : [`-v "${srcMount}":"${containerWorkDir}"`];

    if (skipSrcMount) {
      onOutput?.(`── 预构建镜像模式: 跳过 source mount(image 已含应用文件)──\n`);
    }

    if (isNodeContainer && !skipSrcMount && /\bpnpm\b/.test(command)) {
      volumeFlags.push(`-v "${nodeModulesVolumeName(entry.id, profile.id)}":"${containerWorkDir}/node_modules"`);
    }

    if (profile.cacheMounts) {
      for (const cm of profile.cacheMounts) {
        const mkdir = await this.shell.exec(`mkdir -p "${cm.hostPath}"`);
        if (mkdir.exitCode !== 0) {
          throw new Error(`创建缓存目录失败: ${cm.hostPath}: ${combinedOutput(mkdir)}`);
        }
        volumeFlags.push(`-v "${cm.hostPath}":"${cm.containerPath}"`);
      }
    }

    const ffmpegPaths = ['/opt/ffmpeg-static/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    const ffprobePaths = ['/opt/ffmpeg-static/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'];
    const findResult = await this.shell.exec(
      `for p in ${ffmpegPaths.join(' ')}; do [ -f "$p" ] && echo "$p" && break; done`
    );
    const ffmpegPath = findResult.stdout?.trim();
    if (ffmpegPath) {
      volumeFlags.push(`-v "${ffmpegPath}:/usr/local/bin/ffmpeg:ro"`);
      const findProbe = await this.shell.exec(
        `for p in ${ffprobePaths.join(' ')}; do [ -f "$p" ] && echo "$p" && break; done`
      );
      const ffprobePath = findProbe.stdout?.trim();
      if (ffprobePath) {
        volumeFlags.push(`-v "${ffprobePath}:/usr/local/bin/ffprobe:ro"`);
      }
    }

    return { containerWorkDir, volumeFlags, isNodeContainer, skipSrcMount };
  }

  private buildEntrypointFlags(profile: BuildProfile, onOutput?: (chunk: string) => void): string[] {
    const entrypointFlags: string[] = [];
    if (profile.entrypoint !== undefined) {
      const ep = profile.entrypoint;
      if (ep === '') {
        entrypointFlags.push(`--entrypoint=""`);
        onOutput?.(`── entrypoint 覆盖: (清空 image ENTRYPOINT) ──\n`);
      } else if (/\s/.test(ep)) {
        onOutput?.(
          `── [警告] cds.entrypoint="${ep}" 含空格无效:Docker --entrypoint 只接收单个可执行文件名 ──\n` +
          `── [警告] 如需 sh -c 包装行为,改用 cds.entrypoint: "" 清空 image ENTRYPOINT ` +
          `(CDS 已默认 sh -c 包装 command) ──\n` +
          `── [警告] 本次跳过 entrypoint 覆盖,沿用 image 自带 ENTRYPOINT ──\n`
        );
      } else {
        entrypointFlags.push(`--entrypoint ${JSON.stringify(ep)}`);
        onOutput?.(`── entrypoint 覆盖: ${ep} ──\n`);
      }
    }
    return entrypointFlags;
  }

  /**
   * Remove stale CDS app containers for the same branch/profile before a new
   * docker run attaches service aliases. Docker DNS keeps every container that
   * still has a matching network alias, so a leftover endpoint can make
   * `getent hosts <service-alias>` alternate between old and new containers.
   *
   * Scope is intentionally narrow: same branchId + same profileId, excluding
   * the container name we are about to recreate. Other branches may legitimately
   * run the same profile id on the same project network.
   */
  private async pruneStaleAppContainersForProfile(
    entry: BranchEntry,
    profile: BuildProfile,
    service: ServiceState,
    network: string,
    aliases: string[],
    onOutput?: (chunk: string) => void,
    context: Pick<ContainerRemoveContext, 'requestId' | 'operationId' | 'actor' | 'trigger'> = {},
  ): Promise<void> {
    if (aliases.length === 0) return;
    const removed = new Set<string>();
    const isSameServiceFallbackName = (name: string): boolean =>
      name === service.containerName || name.startsWith(`${service.containerName}-`);
    const removeStale = async (name: string, staleAliases: string[], source: string, id?: string): Promise<void> => {
      const cleanName = name.replace(/^\/+/, '');
      const target = id || cleanName;
      if (cleanName === service.containerName || removed.has(target)) return;
      onOutput?.(`── 清理同 alias 的旧 endpoint(${source}): ${cleanName} (${staleAliases.join(', ')}) ──\n`);
      const reason = `清理同 alias 的旧 endpoint(${source})`;
      this.noteLifecycleIntent(cleanName, 'cds-stale-cleanup', reason, {
        projectId: entry.projectId,
        branchId: entry.id,
        profileId: profile.id,
        requestId: context.requestId ?? null,
        operationId: context.operationId ?? null,
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
        operation: 'deploy-stale-alias-cleanup',
        source: 'container.pruneStaleAppContainersForProfile',
      });
      const rm = await this.shell.exec(`docker rm -f ${this.shellQuote(target)}`);
      this.recordContainerEvent({
        severity: rm.exitCode === 0 ? 'warn' : 'error',
        source: 'cds-container-service',
        action: 'app.stale-alias-rm',
        message: `stale alias cleanup for ${cleanName}`,
        projectId: entry.projectId,
        branchId: entry.id,
        profileId: profile.id,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName: cleanName,
        command: {
          name: 'docker rm -f',
          exitCode: rm.exitCode,
          stdoutPreview: rm.stdout,
          stderrPreview: rm.stderr,
        },
        details: {
          reason,
          staleAliases,
          target,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
        },
      });
      if (rm.exitCode !== 0) {
        await this.shell.exec(
          `docker network disconnect -f ${this.shellQuote(network)} ${this.shellQuote(target)}`,
        );
      }
      removed.add(target);
    };

    const list = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=app" --format "{{.Names}}"`,
    );
    const aliasSet = new Set(aliases);

    if (list.exitCode === 0 && list.stdout.trim()) {
      const format = [
        '{{index .Config.Labels "cds.branch.id"}}',
        '{{index .Config.Labels "cds.profile.id"}}',
        `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{json .Aliases}}{{else}}[]{{end}}`,
      ].join('|');

      for (const name of list.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)) {
        if (name === service.containerName) continue;
        const inspect = await this.shell.exec(
          `docker inspect --format=${this.shellQuote(format)} ${this.shellQuote(name)}`,
        );
        if (inspect.exitCode !== 0) continue;
        const [branchId = '', profileId = '', aliasesJson = '[]'] = inspect.stdout.trim().split('|');
        if (branchId !== entry.id || profileId !== profile.id) continue;

        let staleAliases: string[] = [];
        try {
          const parsed = JSON.parse(aliasesJson);
          if (Array.isArray(parsed)) staleAliases = parsed.filter((item): item is string => typeof item === 'string');
        } catch {
          staleAliases = [];
        }
        if (!staleAliases.some((item) => aliasSet.has(item))) continue;

        await removeStale(name, staleAliases, 'labels');
      }
    }

    const networkContainers = await this.shell.exec(
      `docker ps -aq --filter ${this.shellQuote(`network=${network}`)}`,
    );
    if (networkContainers.exitCode === 0 && networkContainers.stdout.trim()) {
      const format = [
        '{{.Id}}',
        '{{.Name}}',
        `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{json .Aliases}}{{else}}[]{{end}}`,
      ].join('|');
      for (const id of networkContainers.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)) {
        const inspect = await this.shell.exec(
          `docker inspect --format=${this.shellQuote(format)} ${this.shellQuote(id)}`,
        );
        if (inspect.exitCode !== 0) continue;
        const [containerId = id, name = '', aliasesJson = '[]'] = inspect.stdout.trim().split('|');
        const cleanName = name.replace(/^\/+/, '');
        if (!cleanName || cleanName === service.containerName || removed.has(containerId)) continue;
        if (!isSameServiceFallbackName(cleanName)) continue;
        let staleAliases: string[] = [];
        try {
          const parsed = JSON.parse(aliasesJson);
          if (Array.isArray(parsed)) staleAliases = parsed.filter((item): item is string => typeof item === 'string');
        } catch {
          staleAliases = [];
        }
        if (!staleAliases.some((item) => aliasSet.has(item))) continue;

        await removeStale(cleanName, staleAliases, 'network-containers', containerId);
      }
    }

    // Older CDS-created containers may not have cds.* labels. Docker DNS is
    // driven by network endpoints, and a service alias cannot be shared on the
    // same project network without round-robin responses. Inspect the network
    // as a second line of defense and keep this profile's aliases unique.
    const networkInspect = await this.shell.exec(
      `docker network inspect --format='{{json .Containers}}' ${this.shellQuote(network)}`,
    );
    if (networkInspect.exitCode !== 0 || !networkInspect.stdout.trim()) return;

    let containers: Record<string, { Name?: string; Aliases?: unknown }> = {};
    try {
      const parsed = JSON.parse(networkInspect.stdout.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        containers = parsed as Record<string, { Name?: string; Aliases?: unknown }>;
      }
    } catch {
      return;
    }

    for (const endpoint of Object.values(containers)) {
      const name = typeof endpoint.Name === 'string' ? endpoint.Name : '';
      const cleanName = name.replace(/^\/+/, '');
      if (!cleanName || cleanName === service.containerName || removed.has(cleanName)) continue;
      if (!isSameServiceFallbackName(cleanName)) continue;
      const staleAliases = Array.isArray(endpoint.Aliases)
        ? endpoint.Aliases.filter((item): item is string => typeof item === 'string')
        : [];
      if (!staleAliases.some((item) => aliasSet.has(item))) continue;

      await removeStale(cleanName, staleAliases, 'network');
    }
  }

  /**
   * Run a branch service from source using a build profile.
   * Mounts the worktree + shared cache volumes into a Docker container.
   * Uses profile.command to run everything in one persistent container.
   */
  async runService(
    entry: BranchEntry,
    profile: BuildProfile,
    service: ServiceState,
    onOutput?: (chunk: string) => void,
    customEnv?: Record<string, string>,
    context: Pick<ContainerRemoveContext, 'requestId' | 'operationId' | 'actor' | 'trigger'> & {
      assertCurrent?: (step: string) => void;
    } = {},
  ): Promise<void> {
    const network = this.getNetworkForProject(entry.projectId);
    await this.ensureNetwork(network);
    const profileAliases = computeProfileAliases(
      profile.id,
      this.getProjectMarkers(entry.projectId),
    );
    await this.pruneStaleAppContainersForProfile(entry, profile, service, network, profileAliases, onOutput, context);

    context.assertCurrent?.(`runService before pre-run-rm ${profile.id}`);
    // Remove any existing container
    this.noteLifecycleIntent(service.containerName, 'cds-pre-run-replace', '部署前替换同名旧容器', {
      projectId: entry.projectId,
      branchId: entry.id,
      profileId: profile.id,
      requestId: context.requestId ?? null,
      operationId: context.operationId ?? null,
      actor: context.actor ?? null,
      trigger: context.trigger ?? null,
      operation: 'deploy-pre-run-replace',
      source: 'container.runService',
    });
    const preRunRemove = await this.shell.exec(`docker rm -f ${service.containerName}`);
    this.recordContainerEvent({
      severity: preRunRemove.exitCode === 0 ? 'info' : 'warn',
      source: 'cds-container-service',
      action: 'app.pre-run-rm',
      message: `pre-run cleanup for ${service.containerName}`,
      projectId: entry.projectId,
      branchId: entry.id,
      profileId: profile.id,
      requestId: context.requestId ?? undefined,
      operationId: context.operationId ?? undefined,
      containerName: service.containerName,
      command: {
        name: 'docker rm -f',
        exitCode: preRunRemove.exitCode,
        stdoutPreview: preRunRemove.stdout,
        stderrPreview: preRunRemove.stderr,
      },
      details: {
        operation: 'deploy-pre-run-replace',
        reason: '部署前替换同名旧容器',
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
      },
    });

    const command = profile.command || '';
    // 2026-06-23 极速版：预构建镜像自带 ENTRYPOINT（api=`dotnet PrdAgent.Api.dll`,
    // admin=`serve -s dist`）,允许 command 为空 —— 此时不 `sh -c` 包装,直接用
    // 镜像默认 ENTRYPOINT/CMD 启动。非预构建模式仍强制要求 command。
    const usePrebuiltEntrypoint = profile.prebuiltImage === true && !command;
    if (!command && !usePrebuiltEntrypoint) {
      throw new Error(`构建配置 "${profile.id}" 缺少 command 字段`);
    }

    // 极速版：运行前显式 docker pull 外部 ghcr 镜像（按 commit SHA tag 不可变）。
    // 显式 pull 而非依赖 docker run 隐式拉取,是为了把「镜像缺失/拉取失败」第一时间
    // 暴露给用户（对应「等待+提示,手动切回源码编译」兜底），并在 SSE 日志给反馈
    // 而非空白等待。
    if (profile.prebuiltImage === true) {
      // 极速版「逐组件有序回退」(用户 2026-06-23 决策 + Codex P1)：CI 按 path-filter 只构建
      // 改动的组件(不重复构建),所以某 commit 可能缺本组件镜像。按**有序回退链**尝试:
      //   ① 本 commit 镜像(dockerImage,:sha-<X>)
      //   ② fallbackImage 链:先 :branch-<slug>(本分支该组件最近一次构建,保住本分支已有改动)
      //      再 :branch-main(本分支从未构建过该组件时退到主分支)。
      // 任一拉到即用它跑容器,**不硬失败**;全部拉不到才报错。
      const isUnresolved = (im: string): boolean => {
        if (!im) return true;
        if (im.includes('${')) return true; // 模板变量没解析
        const tag = im.includes(':') ? im.slice(im.lastIndexOf(':') + 1) : '';
        return tag === '' || tag.endsWith('-'); // tag 被空串替换成 :sha-/:branch-
      };
      const primary = (profile.dockerImage || '').trim();
      const fallbackList = normalizeFallbackImages(profile.fallbackImage);
      const candidates: Array<{ image: string; kind: 'primary' | 'fallback' }> = [];
      const seen = new Set<string>();
      if (!isUnresolved(primary)) { candidates.push({ image: primary, kind: 'primary' }); seen.add(primary); }
      for (const fb of fallbackList) {
        if (isUnresolved(fb) || seen.has(fb)) continue;
        candidates.push({ image: fb, kind: 'fallback' });
        seen.add(fb);
      }

      if (candidates.length === 0) {
        const reason = `极速版镜像 tag 未解析且无可用回退镜像: ${primary || '(空)'} —— 缺 commit SHA / 分支 slug。`;
        onOutput?.(`── ${reason} ──\n`);
        this.recordContainerEvent({
          severity: 'error',
          source: 'cds-container-service',
          action: 'app.pull.unresolved-tag',
          message: `prebuilt image tag unresolved: ${primary}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId: profile.id,
          requestId: context.requestId ?? undefined,
          operationId: context.operationId ?? undefined,
          details: { image: primary, fallback: fallbackList, reason: '极速版镜像 tag 模板变量为空/未解析且无回退' },
        });
        throw new Error(`${reason}\n请确认分支已有 commit（push 或部署请求携带 commitSha）,或配置回退镜像 / 切回源码编译。`);
      }

      let pulledImage: string | null = null;
      let lastDetail = '';
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        onOutput?.(cand.kind === 'fallback'
          ? `── 本 commit 无该组件 CI 镜像,按回退链尝试 ${cand.image} ──\n`
          : `── 极速版: 拉取 CI 预构建镜像 ${cand.image}（CDS 不再本机编译）──\n`);
        context.assertCurrent?.(`runService before docker-pull ${profile.id}`);
        const pull = await this.shell.exec(`docker pull ${cand.image}`);
        if (pull.stdout) onOutput?.(pull.stdout + '\n');
        if (pull.exitCode === 0) { pulledImage = cand.image; break; }
        lastDetail = (pull.stderr || pull.stdout || '').trim();
        const hasNext = i < candidates.length - 1;
        onOutput?.(`── 拉取失败: ${lastDetail}${hasNext ? `（改用下一个回退镜像 ${candidates[i + 1].image}）` : ''} ──\n`);
      }

      if (!pulledImage) {
        onOutput?.(`── 极速版镜像拉取失败(含回退) ──\n`);
        this.recordContainerEvent({
          severity: 'error',
          source: 'cds-container-service',
          action: 'app.pull.failed',
          message: `docker pull failed for prebuilt image(s): ${candidates.map((c) => c.image).join(', ')}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId: profile.id,
          requestId: context.requestId ?? undefined,
          operationId: context.operationId ?? undefined,
          command: { name: 'docker pull', exitCode: 1, stdoutPreview: '', stderrPreview: lastDetail },
          details: { images: candidates.map((c) => c.image), reason: '极速版预构建镜像(含回退)拉取失败' },
        });
        throw new Error(`极速版镜像拉取失败(含回退): ${candidates.map((c) => c.image).join(' / ')}\n${lastDetail}\n（CI 镜像可能尚未就绪或未设为 public,可在分支详情切回源码编译）`);
      }
      // 用实际拉到的镜像(可能是回退主分支镜像)跑容器:下游 docker run 读 profile.dockerImage。
      if (pulledImage !== profile.dockerImage) profile.dockerImage = pulledImage;
      onOutput?.(`── 镜像就绪: ${pulledImage} ──\n`);
    }

    const resolvedEnv = this.resolveProfileRuntimeEnv(entry, profile, customEnv);

    const envFilePath = this.writeEnvFile(resolvedEnv);
    const envFlag = `--env-file "${envFilePath}"`;
    const { containerWorkDir, volumeFlags, isNodeContainer, skipSrcMount } =
      await this.buildProfileVolumeFlags(entry, profile, command, onOutput);

    try {
      onOutput?.(usePrebuiltEntrypoint
        ? `── 运行: ${profile.dockerImage}（镜像默认 ENTRYPOINT）──\n`
        : `── 运行: ${command} ──\n`);
      // Bugbot 2026-05-06 1f32c1da:之前 log 的条件是 isNodeContainer && !skipSrcMount,
      // 比真正挂 volume 的条件(还要 /\bpnpm\b/.test(command))宽,npm/yarn 项目会
      // 看到"走 docker volume"的误导日志。改为与真实 mount 条件完全一致。
      if (isNodeContainer && !skipSrcMount && /\bpnpm\b/.test(command)) {
        onOutput?.(`── Node.js 容器: node_modules 走 docker volume(跨部署持久化,首次会装满,后续秒过)──\n`);
      }

      // 2026-05-28 用户反馈"100GB 内存,不允许任何容器限制":彻底删除所有
      // docker 运行时资源限制(--memory / --memory-swap / --cpus)。
      // memoryMB / cpus 字段仅作 capacity 调度规划提示,不下发到 docker run。
      // 不下发任何 --memory / --memory-swap / --cpus,避免任何容器构造慢。
      const resourceFlags: string[] = [];

      // Phase 7 fix(B10,2026-05-01)— --entrypoint 覆盖。
      // 默认不传(走 image 自带 ENTRYPOINT)。指定时:
      //   - profile.entrypoint === ""    →  --entrypoint=""(清空 wrapper,最常用)
      //   - profile.entrypoint === "sh"  →  --entrypoint sh(单 token 覆盖)
      // 用于 image 自带 wrapper ENTRYPOINT 跟 CDS 部署模式不兼容时(Twenty CRM 实战)。
      //
      // Bugbot fix(PR #521 第十三轮 Bug 3)— Docker --entrypoint 只接收
      // 单个可执行 token,**不**接受 "sh -c" 这种多词形式(Docker 会查找
      // 字面文件名 "sh -c" 启动失败 "executable file not found")。CDS 默认
      // 已用 sh -c "command" 包装应用 command(line 467-ish),
      // 想强制 sh -c 行为只需 cds.entrypoint: "" 清空 wrapper 即可。
      const entrypointFlags = this.buildEntrypointFlags(profile, onOutput);

      // Bug D fix(2026-05-10) — profile 容器需要 --network-alias,否则 network
      // 内只能用 container_name(全局唯一长名 cds-app-...) 互访,不能用短 service 名。
      // 同 infra 的 B15 修法:加 alias 让同 project network 内 `getent hosts <name>`
      // 能解析到这个 profile。alias 列表:
      //   1. profile.id        — SSOT,如 'imp-api-mdimp' / 'mysql-mdimp'
      //   2. shortAlias        — 去掉项目后缀,如 'imp-api' / 'mysql'(如果与
      //      profile.id 不同)
      // 多 alias 用多个 --network-alias 标志(docker 支持任意多个)。
      const profileAliasFlags = profileAliases.map((a) => `--network-alias ${a}`);

      const runCmd = [
        'docker run -d',
        `--name ${service.containerName}`,
        `--network ${network}`,
        ...profileAliasFlags,
        `-p ${service.hostPort}:${profile.containerPort}`,
        ...volumeFlags,
        ...resourceFlags,
        ...entrypointFlags,
        // 极速版预构建镜像无 command 时,不覆盖 -w（用镜像自带 WORKDIR）也不 sh -c 包装,
        // 直接让镜像 ENTRYPOINT/CMD 启动。
        ...(usePrebuiltEntrypoint ? [] : [`-w ${containerWorkDir}`]),
        envFlag,
        '--tmpfs /tmp',
        this.appLabels(entry.projectId, entry.id, profile.id, network),
        profile.dockerImage,
        ...(usePrebuiltEntrypoint ? [] : [`sh -c "${command.replace(/"/g, '\\"')}"`]),
      ].join(' ');

      context.assertCurrent?.(`runService before docker-run ${profile.id}`);
      const result = await this.shell.exec(runCmd);
      if (result.exitCode !== 0) {
        this.recordContainerEvent({
          severity: 'error',
          source: 'cds-container-service',
          action: 'app.run.failed',
          message: `docker run failed for ${service.containerName}`,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId: profile.id,
          requestId: context.requestId ?? undefined,
          operationId: context.operationId ?? undefined,
          containerName: service.containerName,
          command: {
            name: 'docker run',
            exitCode: result.exitCode,
            stdoutPreview: result.stdout,
            stderrPreview: result.stderr,
          },
          details: {
            image: profile.dockerImage,
            hostPort: service.hostPort,
            containerPort: profile.containerPort,
            network,
          },
        });
        throw new Error(`启动服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
      }
      this.recordContainerEvent({
        severity: 'info',
        source: 'cds-container-service',
        action: 'app.run.started',
        message: `docker run started ${service.containerName}`,
        projectId: entry.projectId,
        branchId: entry.id,
        profileId: profile.id,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName: service.containerName,
        command: {
          name: 'docker run',
          exitCode: result.exitCode,
          stdoutPreview: result.stdout,
          stderrPreview: result.stderr,
        },
        details: {
          image: profile.dockerImage,
          hostPort: service.hostPort,
          containerPort: profile.containerPort,
          network,
        },
      });

      // Phase 1: Liveness — verify the container process hasn't crashed immediately.
      // docker run -d returns immediately; the process inside may crash shortly after.
      // Poll a few times to catch early exits (e.g., ENOSPC, missing deps, syntax errors).
      try {
        await this.waitForContainerAlive(service.containerName, onOutput);
      } catch (err) {
        const diagnostics = await this.captureContainerDiagnostics(service.containerName, 300);
        const state = diagnostics.inspect?.state as Record<string, unknown> | undefined;
        this.recordContainerEvent({
          severity: 'error',
          source: 'cds-container-service',
          action: 'app.early-exit',
          message: (err as Error).message,
          projectId: entry.projectId,
          branchId: entry.id,
          profileId: profile.id,
          requestId: context.requestId ?? undefined,
          operationId: context.operationId ?? undefined,
          containerName: service.containerName,
          status: typeof state?.status === 'string' ? state.status : undefined,
          exitCode: Number.isFinite(Number(state?.exitCode)) ? Number(state?.exitCode) : undefined,
          oomKilled: typeof state?.oomKilled === 'boolean' ? state.oomKilled : undefined,
          inspect: diagnostics.inspect,
          logs: diagnostics.logs,
          error: diagnostics.error || { message: (err as Error).message },
        });
        throw err;
      }
    } finally {
      this.removeEnvFile(envFilePath);
    }
  }

  /**
   * Run a short-lived command in the same profile runtime environment as
   * runService. Database migrations use this so DATABASE_URL, per-branch DB
   * isolation, source mounts, and package caches match the app container.
   */
  async runProfileCommand(
    entry: BranchEntry,
    profile: BuildProfile,
    command: string,
    onOutput?: (chunk: string) => void,
    customEnv?: Record<string, string>,
    context: Pick<ContainerRemoveContext, 'requestId' | 'operationId' | 'actor' | 'trigger'> & {
      assertCurrent?: (step: string) => void;
      timeoutMs?: number;
    } = {},
  ): Promise<ExecResult> {
    const network = this.getNetworkForProject(entry.projectId);
    await this.ensureNetwork(network);

    const resolvedEnv = this.resolveProfileRuntimeEnv(entry, profile, customEnv);
    const envFilePath = this.writeEnvFile(resolvedEnv);
    const envFlag = `--env-file "${envFilePath}"`;
    const { containerWorkDir, volumeFlags, isNodeContainer, skipSrcMount } =
      await this.buildProfileVolumeFlags(entry, profile, command, onOutput);

    try {
      if (!command.trim()) {
        throw new Error(`构建配置 "${profile.id}" 缺少迁移命令`);
      }
      onOutput?.(`── 执行一次性命令: ${command} ──\n`);
      if (isNodeContainer && !skipSrcMount && /\bpnpm\b/.test(command)) {
        onOutput?.(`── Node.js 容器: node_modules 走 docker volume(跨部署持久化,首次会装满,后续秒过)──\n`);
      }

      const entrypointFlags = this.buildEntrypointFlags(profile, onOutput);
      const runCmd = [
        'docker run --rm',
        `--network ${network}`,
        ...volumeFlags,
        ...entrypointFlags,
        `-w ${containerWorkDir}`,
        envFlag,
        '--tmpfs /tmp',
        `--label cds.managed=true`,
        `--label cds.type=job`,
        `--label cds.project.id=${entry.projectId || 'default'}`,
        `--label cds.branch.id=${entry.id}`,
        `--label cds.profile.id=${profile.id}`,
        profile.dockerImage,
        `sh -c "${command.replace(/"/g, '\\"')}"`,
      ].join(' ');

      context.assertCurrent?.(`runProfileCommand before docker-run ${profile.id}`);
      const result = await this.shell.exec(runCmd, {
        timeout: context.timeoutMs ?? profile.buildTimeout ?? 600_000,
      });
      this.recordContainerEvent({
        severity: result.exitCode === 0 ? 'info' : 'error',
        source: 'cds-container-service',
        action: result.exitCode === 0 ? 'profile.job.completed' : 'profile.job.failed',
        message: `profile command ${result.exitCode === 0 ? 'completed' : 'failed'} for ${profile.id}`,
        projectId: entry.projectId,
        branchId: entry.id,
        profileId: profile.id,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        command: {
          name: 'docker run --rm',
          exitCode: result.exitCode,
          stdoutPreview: result.stdout,
          stderrPreview: result.stderr,
        },
        details: {
          image: profile.dockerImage,
          network,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
        },
      });
      onOutput?.(combinedOutput(result));
      return result;
    } finally {
      this.removeEnvFile(envFilePath);
    }
  }

  /**
   * Phase 1: Liveness check — poll container status to catch early crashes.
   * Checks 3 times over ~6 seconds. If the container exits during this window,
   * it grabs the last 30 lines of logs and throws an error so deploy is marked failed.
   */
  private async waitForContainerAlive(
    containerName: string,
    onOutput?: (chunk: string) => void,
  ): Promise<void> {
    const CHECKS = 3;
    const INTERVAL_MS = 2000;

    for (let i = 0; i < CHECKS; i++) {
      await new Promise(r => setTimeout(r, INTERVAL_MS));

      const inspect = await this.shell.exec(
        `docker inspect --format="{{.State.Status}}|{{.State.ExitCode}}" ${containerName}`,
      );
      if (inspect.exitCode !== 0) {
        throw new Error(`容器 "${containerName}" 已消失`);
      }

      const [status, exitCode] = inspect.stdout.trim().split('|');

      if (status === 'running') {
        onOutput?.(`── 存活检查 ${i + 1}/${CHECKS}: 容器运行中 ──\n`);
        continue;
      }

      if (status === 'exited' || status === 'dead') {
        const logs = await this.getLogs(containerName, 30);
        throw new Error(
          `容器 "${containerName}" 启动后退出 (exit code: ${exitCode}):\n${logs}`,
        );
      }

      onOutput?.(`── 容器状态: ${status}, 等待中... ──\n`);
    }
  }

  /**
   * Phase 2 alternative: Watch container logs for a startup signal string.
   * Monitors docker logs in real-time; resolves true when the signal appears,
   * false on timeout. More reliable than HTTP probes for services that print
   * a known banner on successful startup.
   */
  async waitForStartupSignal(
    containerName: string,
    signal: string,
    onOutput?: (chunk: string) => void,
    timeoutSeconds = 300,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        onOutput?.(`── 启动信号超时 (${timeoutSeconds}s)，未检测到: "${signal}" ──\n`);
        resolve(false);
      }, timeoutSeconds * 1000);

      const child = spawn('docker', ['logs', '-f', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      const checkChunk = (data: Buffer) => {
        if (resolved) return;
        const text = data.toString();
        if (text.includes(signal)) {
          resolved = true;
          clearTimeout(timeout);
          child.kill();
          onOutput?.(`── 检测到启动信号: "${signal}" OK ──\n`);
          resolve(true);
        }
      };

      child.stdout?.on('data', checkChunk);
      child.stderr?.on('data', checkChunk);
      child.on('error', () => {
        if (!resolved) { clearTimeout(timeout); resolve(false); }
      });
      child.on('exit', () => {
        if (!resolved) { clearTimeout(timeout); resolve(false); }
      });
    });
  }

  /**
   * Readiness probe — the missing half of the "container alive ≠ app ready"
   * gap that used to produce Cloudflare 502 errors. Runs after
   * `waitForContainerAlive` and before the service is marked `running`:
   *
   *   1. TCP probe on hostPort (connection accepted = listening)
   *   2. Optional HTTP GET on probe.path (status 2xx/3xx = ready)
   *
   * Emits one `onAttempt` callback per probe round so the deploy SSE stream
   * can surface "attempt 3/30, last: connection refused" to the user.
   * Returns true when both checks pass, false on timeout.
   *
   * See `.claude/rules/cds-auto-deploy.md` — users should never face a raw
   * 502 during build/restart windows.
   */
  async waitForReadiness(
    hostPort: number,
    probe: ReadinessProbe | undefined,
    onAttempt?: (info: { attempt: number; max: number; stage: 'tcp' | 'http'; ok: boolean; error?: string }) => void,
    onOutput?: (chunk: string) => void,
  ): Promise<boolean> {
    const intervalMs = Math.max(1, (probe?.intervalSeconds ?? 2)) * 1000;
    const timeoutMs = Math.max(intervalMs, (probe?.timeoutSeconds ?? 180) * 1000);
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    // CDS build profiles represent HTTP preview/admin/API services. A bare TCP
    // accept can happen before the framework has finished booting, which marks
    // the branch running while users still get empty replies or 502s. Probe "/"
    // by default; 4xx still means the HTTP server is alive.
    const probePath = probe?.path ?? '/';
    const host = '127.0.0.1';

    // Phase 7 fix(B11,2026-05-01)— noHttp 模式:跳过 HTTP probe,只跑 TCP
    // liveness。给后台 worker / job runner / queue consumer 等不监听 HTTP
    // 的 service 用,杜绝 90 次 ECONNRESET 之后超时的灾难。
    // 触发条件:probe.noHttp === true(由 cds.no-http-readiness label 设置)
    //
    // Bug G fix(2026-05-10)— noHttp:true 不再"立即返回 true",而是 fallback
    // 到 TCP 探测 hostPort(== profile.containerPort 的对外映射)。
    // 之前的实现跳过任何探测,导致 mysql 之类绑定 socket 失败的 service 也被
    // 标 ready,后续连接全部 refused。改成:noHttp=true → 跑 TCP 阶段(不跑 HTTP),
    // TCP accept 通过即 ready。这样:
    //   - 真正的后台 worker(完全不 listen)→ TCP 连不上 → timeout 后报错(预期,
    //     用户应改用 startupSignal 模式)
    //   - 后台带 TCP server(MySQL/Postgres/Redis)→ 端口 accept → ready
    if (probe?.noHttp) {
      onOutput?.(`── 就绪探测: noHttp 模式(跳过 HTTP,仅 TCP 探测 ${host}:${hostPort})──\n`);
      let lastErr = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const tcp = await this.probeTcp(host, hostPort, Math.min(3000, intervalMs));
        onAttempt?.({ attempt, max: maxAttempts, stage: 'tcp', ok: tcp.ok, error: tcp.error });
        if (tcp.ok) {
          onOutput?.(`── 就绪探测: TCP ${host}:${hostPort} 已就绪 OK (noHttp)──\n`);
          return true;
        }
        lastErr = tcp.error || 'tcp refused';
        onOutput?.(`── 就绪探测 ${attempt}/${maxAttempts}: TCP ${host}:${hostPort} 未就绪 (${lastErr}) ──\n`);
        await new Promise(r => setTimeout(r, intervalMs));
      }
      onOutput?.(`── noHttp 就绪探测超时 (${Math.round(timeoutMs / 1000)}s),最后错误: ${lastErr} ──\n`);
      return false;
    }

    let tcpOk = false;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!tcpOk) {
        const tcp = await this.probeTcp(host, hostPort, Math.min(3000, intervalMs));
        onAttempt?.({ attempt, max: maxAttempts, stage: 'tcp', ok: tcp.ok, error: tcp.error });
        if (!tcp.ok) {
          lastError = tcp.error || 'tcp refused';
          onOutput?.(`── 就绪探测 ${attempt}/${maxAttempts}: TCP ${host}:${hostPort} 未就绪 (${lastError}) ──\n`);
          await new Promise(r => setTimeout(r, intervalMs));
          continue;
        }
        tcpOk = true;
        onOutput?.(`── 就绪探测: TCP ${host}:${hostPort} 已就绪 OK ──\n`);
      }

      const httpRes = await this.probeHttp(host, hostPort, probePath, Math.min(5000, intervalMs));
      onAttempt?.({ attempt, max: maxAttempts, stage: 'http', ok: httpRes.ok, error: httpRes.error });
      if (httpRes.ok) {
        onOutput?.(`── 就绪探测: HTTP ${probePath} 返回 ${httpRes.status} OK ──\n`);
        return true;
      }
      lastError = httpRes.error || `http ${httpRes.status}`;
      onOutput?.(`── 就绪探测 ${attempt}/${maxAttempts}: HTTP ${probePath} (${lastError}) ──\n`);
      await new Promise(r => setTimeout(r, intervalMs));
    }

    onOutput?.(`── 就绪探测超时 (${Math.round(timeoutMs / 1000)}s)，最后错误: ${lastError} ──\n`);
    return false;
  }

  private probeTcp(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ok, error });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'tcp timeout'));
      socket.once('error', (err: NodeJS.ErrnoException) => done(false, err.code || err.message));
      socket.connect(port, host);
    });
  }

  private probeHttp(host: string, port: number, path: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string }> {
    return new Promise((resolve) => {
      const req = http.request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        const status = res.statusCode || 0;
        res.resume();
        // 2xx/3xx = ready; 4xx = route exists but maybe needs auth, still "ready"
        // Only 5xx / no response counts as not ready.
        if (status >= 200 && status < 500) resolve({ ok: true, status });
        else resolve({ ok: false, status, error: `http ${status}` });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'http timeout' }); });
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, error: err.code || err.message }));
      req.end();
    });
  }

  /**
   * Restart an existing container in place via `docker restart` — preserves
   * the container id, volume mounts, and env. Intended for hot-reload paths
   * where the image tag hasn't changed (bind-mounted source, config-only
   * tweak). Returns true on success, false if the container doesn't exist
   * or restart failed (caller should fall back to full rm+run).
   */
  async restartServiceInPlace(
    containerName: string,
    onOutput?: (chunk: string) => void,
    context: Pick<ContainerRemoveContext, 'projectId' | 'branchId' | 'profileId' | 'requestId' | 'operationId' | 'actor' | 'trigger' | 'operation' | 'source' | 'reason'> = {},
  ): Promise<boolean> {
    const inspect = await this.shell.exec(`docker inspect --format="{{.State.Status}}" ${containerName}`);
    if (inspect.exitCode !== 0) {
      onOutput?.(`── 容器 ${containerName} 不存在，无法原地重启 ──\n`);
      this.recordContainerEvent({
        severity: 'warn',
        source: 'cds-container-service',
        action: 'container.restart.missing',
        message: `container ${containerName} missing before docker restart`,
        projectId: context.projectId ?? undefined,
        branchId: context.branchId ?? undefined,
        profileId: context.profileId ?? undefined,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName,
        command: { name: 'docker inspect', exitCode: inspect.exitCode, stdoutPreview: inspect.stdout, stderrPreview: inspect.stderr },
        details: {
          reason: context.reason ?? null,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
          operation: context.operation ?? null,
          source: context.source ?? null,
        },
      });
      return false;
    }
    onOutput?.(`── 原地重启: docker restart ${containerName} ──\n`);
    const result = await this.shell.exec(`docker restart ${containerName}`);
    if (result.exitCode !== 0) {
      onOutput?.(`── docker restart 失败: ${combinedOutput(result)} ──\n`);
      const diagnostics = await this.captureContainerDiagnostics(containerName, 200);
      this.recordContainerEvent({
        severity: 'error',
        source: 'cds-container-service',
        action: 'container.restart.failed',
        message: `docker restart failed for ${containerName}`,
        projectId: context.projectId ?? undefined,
        branchId: context.branchId ?? undefined,
        profileId: context.profileId ?? undefined,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName,
        command: { name: 'docker restart', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
        inspect: diagnostics.inspect,
        logs: diagnostics.logs,
        error: diagnostics.error,
        details: {
          reason: context.reason ?? null,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
          operation: context.operation ?? null,
          source: context.source ?? null,
        },
      });
      return false;
    }
    try {
      await this.waitForContainerAlive(containerName, onOutput);
      const diagnostics = await this.captureContainerDiagnostics(containerName, 80);
      this.recordContainerEvent({
        severity: 'info',
        source: 'cds-container-service',
        action: 'container.restart.completed',
        message: `docker restart completed for ${containerName}`,
        projectId: context.projectId ?? undefined,
        branchId: context.branchId ?? undefined,
        profileId: context.profileId ?? undefined,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName,
        command: { name: 'docker restart', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
        inspect: diagnostics.inspect,
        logs: diagnostics.logs,
        details: {
          reason: context.reason ?? null,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
          operation: context.operation ?? null,
          source: context.source ?? null,
        },
      });
      return true;
    } catch (err) {
      onOutput?.(`── 重启后容器未存活: ${(err as Error).message} ──\n`);
      const diagnostics = await this.captureContainerDiagnostics(containerName, 300);
      this.recordContainerEvent({
        severity: 'error',
        source: 'cds-container-service',
        action: 'container.restart.early-exit',
        message: (err as Error).message,
        projectId: context.projectId ?? undefined,
        branchId: context.branchId ?? undefined,
        profileId: context.profileId ?? undefined,
        requestId: context.requestId ?? undefined,
        operationId: context.operationId ?? undefined,
        containerName,
        inspect: diagnostics.inspect,
        logs: diagnostics.logs,
        error: diagnostics.error || { message: (err as Error).message },
        details: {
          reason: context.reason ?? null,
          actor: context.actor ?? null,
          trigger: context.trigger ?? null,
          operation: context.operation ?? null,
          source: context.source ?? null,
        },
      });
      return false;
    }
  }

  /**
   * 容器停止前往其 PID1 stdout 写一行 [CDS-STOP] 哨兵,让 `docker logs`
   * 末尾留下"这是 CDS 主动停的"证据,与"莫名崩溃"区分。best-effort:
   * 容器无 sh / distroless / exec 失败都静默跳过 —— 判定"正常 vs 异常
   * 停止"的权威源是 CDS 侧的 lastStopSource / 活动日志(见 index.ts
   * runAutoRestartTick),哨兵只是给人查 docker logs 时的肉眼便利。
   */
  private async writeStopSentinel(containerName: string, reason: string): Promise<void> {
    // 容器名拼进 shell 前硬校验(与 getServiceStats 同款白名单:不符合
    // docker 命名规则的一定不是合法容器名 → 直接放弃写哨兵,reject 比
    // escape 更安全)。
    const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
    if (!validName.test(containerName)) return;
    // reason 仅供人读。白名单保留:ASCII 字母数字/空格/_.:- + CJK 汉字
    // (U+4E00–U+9FA5) + CJK 标点 (U+3000–U+303F:、。「」【】) + 全角符号
    // (U+FF00–U+FFEF:（），：等)。这些区段都不含任何 shell 元字符,**单引号
    // (')、双引号(")、$、反引号、\、; 等一律落在白名单外被剔除** —— 即便
    // 未来调用方乱传也进不了 shell。下面用单引号包裹 line,单引号串里唯一
    // 能破坏引用的字符就是单引号本身,而它已被白名单排除:不再依赖"过滤
    // 引号"来做 shell 转义(Cursor Bugbot #640 加固)。
    const safeReason =
      (reason || 'cds-stop')
        .replace(/[^一-龥　-〿＀-￯a-zA-Z0-9 _.:-]/g, '')
        .slice(0, 120) || 'cds-stop';
    const line = `[CDS-STOP] reason=${safeReason} ts=${new Date().toISOString()}`;
    try {
      await this.shell.exec(
        `docker exec ${containerName} sh -c "echo '${line}' > /proc/1/fd/1 2>/dev/null"`,
        { timeout: 3000 },
      );
    } catch {
      /* best-effort:哨兵写失败不影响停止,判定走 CDS 账本 */
    }
  }

  /**
   * 停止容器但**保留**它(不 docker rm)。容器进入 exited 状态:
   *  - 不占端口 / CPU / 内存,仅保留可写层与 `docker logs`
   *  - 可被 /restart(docker restart)或 auto-restart(docker start)秒级唤醒
   *  - docker logs 末尾留有 [CDS-STOP] 哨兵 → 与莫名崩溃区分
   * 用于:手动停止 / 调度器降温 / auto-lifecycle / 执行器停止 等"还要回来"
   * 的场景。需要彻底销毁容器(删分支 / reset / 孤儿清理 / force-rebuild)
   * 请改用 remove()。
   */
  async stop(
    containerName: string,
    reason = 'cds-stop',
    context: Pick<ContainerRemoveContext, 'projectId' | 'branchId' | 'profileId' | 'serviceId' | 'requestId' | 'operationId' | 'actor' | 'trigger' | 'operation' | 'source'> = {},
  ): Promise<void> {
    const before = await this.captureContainerDiagnostics(containerName, 80);
    this.recordContainerEvent({
      severity: 'info',
      source: 'cds-container-service',
      action: 'container.stop.requested',
      message: `CDS requested docker stop for ${containerName}: ${reason}`,
      projectId: context.projectId ?? undefined,
      branchId: context.branchId ?? undefined,
      profileId: context.profileId ?? undefined,
      serviceId: context.serviceId ?? undefined,
      requestId: context.requestId ?? undefined,
      operationId: context.operationId ?? undefined,
      containerName,
      inspect: before.inspect,
      logs: before.logs,
      details: {
        reason,
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
        operation: context.operation ?? null,
        source: context.source ?? null,
      },
    });
    await this.writeStopSentinel(containerName, reason);
    this.noteLifecycleIntent(containerName, 'cds-stop', reason, {
      projectId: context.projectId ?? null,
      branchId: context.branchId ?? null,
      profileId: context.profileId ?? null,
      serviceId: context.serviceId ?? null,
      requestId: context.requestId ?? null,
      operationId: context.operationId ?? null,
      actor: context.actor ?? null,
      trigger: context.trigger ?? null,
      operation: context.operation ?? null,
      source: context.source ?? null,
    });
    const result = await this.shell.exec(`docker stop ${containerName}`);
    const after = await this.captureContainerDiagnostics(containerName, 120);
    const state = after.inspect?.state as Record<string, unknown> | undefined;
    this.recordContainerEvent({
      severity: result.exitCode === 0 ? 'info' : 'error',
      source: 'cds-container-service',
      action: 'container.stop.completed',
      message: `docker stop completed for ${containerName}: ${reason}`,
      projectId: context.projectId ?? undefined,
      branchId: context.branchId ?? undefined,
      profileId: context.profileId ?? undefined,
      serviceId: context.serviceId ?? undefined,
      requestId: context.requestId ?? undefined,
      operationId: context.operationId ?? undefined,
      containerName,
      status: typeof state?.status === 'string' ? state.status : undefined,
      exitCode: Number.isFinite(Number(state?.exitCode)) ? Number(state?.exitCode) : undefined,
      oomKilled: typeof state?.oomKilled === 'boolean' ? state.oomKilled : undefined,
      command: { name: 'docker stop', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
      inspect: after.inspect,
      logs: after.logs,
      error: after.error,
      details: {
        reason,
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
        operation: context.operation ?? null,
        source: context.source ?? null,
      },
    });
  }

  /**
   * 彻底销毁容器:docker stop + docker rm,容器与其 docker logs 一并消失。
   * 仅用于明确"销毁"语义的路径(删除分支 / 重置 / 孤儿清理 /
   * force-rebuild / janitor 回收)。停止后还想唤醒请用 stop()。
   * (这是 2026-05 重构前 stop() 的原始行为,改名以显式暴露"删"的语义。)
   */
  async remove(containerName: string, context: ContainerRemoveContext = {}): Promise<void> {
    const reason = context.reason || 'CDS 显式 remove 调用触发容器销毁';
    const kind = context.kind || 'cds-remove';
    const before = await this.captureContainerDiagnostics(containerName, 300);
    this.recordContainerEvent({
      severity: 'warn',
      source: 'cds-container-service',
      action: 'container.remove.requested',
      message: `CDS requested docker stop/rm for ${containerName}`,
      projectId: context.projectId ?? undefined,
      branchId: context.branchId ?? undefined,
      profileId: context.profileId ?? undefined,
      serviceId: context.serviceId ?? undefined,
      requestId: context.requestId ?? undefined,
      operationId: context.operationId ?? undefined,
      containerName,
      inspect: before.inspect,
      logs: before.logs,
      error: before.error,
      details: {
        reason,
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
        operation: context.operation ?? null,
        source: context.source ?? null,
        ...(context.details ? { context: context.details } : {}),
      },
    });
    this.noteLifecycleIntent(containerName, kind, reason, context);
    const stopResult = await this.shell.exec(`docker stop ${containerName}`);
    const rmResult = await this.shell.exec(`docker rm ${containerName}`);
    const completion = classifyRemoveCompletion(rmResult);
    this.recordContainerEvent({
      severity: completion.severity,
      source: 'cds-container-service',
      action: 'container.remove.completed',
      message: completion.status === 'already-absent'
        ? `docker rm skipped for ${containerName}: container already absent`
        : `docker rm completed for ${containerName}`,
      projectId: context.projectId ?? undefined,
      branchId: context.branchId ?? undefined,
      profileId: context.profileId ?? undefined,
      serviceId: context.serviceId ?? undefined,
      requestId: context.requestId ?? undefined,
      operationId: context.operationId ?? undefined,
      containerName,
      command: {
        name: 'docker stop && docker rm',
        exitCode: rmResult.exitCode,
        stdoutPreview: `${stopResult.stdout || ''}${rmResult.stdout || ''}`,
        stderrPreview: `${stopResult.stderr || ''}${rmResult.stderr || ''}`,
      },
      details: {
        reason,
        removeStatus: completion.status,
        actor: context.actor ?? null,
        trigger: context.trigger ?? null,
        operation: context.operation ?? null,
        source: context.source ?? null,
      },
    });
  }

  async isRunning(containerName: string): Promise<boolean> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Running}}" ${containerName}`,
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /**
   * Batch variant of `isRunning` — returns the **set of running container
   * names** in a single `docker ps` call. Use this when you need to test
   * many containers at once (e.g. reconciling N branches × M services in
   * `GET /branches`); it replaces N×M sequential `docker inspect` round
   * trips (each ~50–150 ms) with one call that completes in a few hundred
   * ms regardless of project size.
   *
   * Returns an empty set if the docker daemon is unreachable; callers
   * should treat that as "no containers running" (the same outcome
   * `isRunning` would converge to after each per-name probe failed).
   */
  async getRunningContainerNames(): Promise<Set<string>> {
    const result = await this.shell.exec(`docker ps --format "{{.Names}}"`);
    if (result.exitCode !== 0) return new Set<string>();
    return new Set(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }

  /**
   * 批量取一组容器的 `docker stats --no-stream` 瞬时值(2026-05-04 Phase B)。
   *
   * docker stats 单次往返 ~300-800ms(取决于容器数量和 docker daemon 负载),
   * 比 N 次 docker inspect 快得多。`--no-stream` 让 docker 只输出一次就退出,
   * 不进入持续 streaming 模式;`--format` 用 `\t` 分隔保证解析稳定。
   *
   * 容器名传空数组时调 `docker stats --all` 会拉所有容器(开销高),所以这里
   * 显式 return 空 map 短路。
   *
   * 返回:`Map<containerName, ContainerStats>`,容器不存在 / 已停止时缺席。
   */
  async getServiceStats(containerNames: string[]): Promise<Map<string, ContainerStats>> {
    const out = new Map<string, ContainerStats>();
    if (containerNames.length === 0) return out;

    // 容器名拼进 shell 命令前必须做 hard validation(Bugbot PR #524 第四轮反馈)。
    // 之前用 JSON.stringify 是错的:JSON 双引号并不是 shell-safe escaping —
    // 双引号串里 `$(...)` / 反引号 / `$VAR` 仍会被 shell 展开成命令注入。
    // Docker 容器名的字符集严格限制为 [a-zA-Z0-9][a-zA-Z0-9_.-]*,任何不符合
    // 的名字一定不是合法容器名 → 直接拒绝(reject 比 escape 更安全:不需要
    // 信任任何 escape 函数实现的正确性)。
    const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
    const safeNames = containerNames.filter((n) => validName.test(n));
    if (safeNames.length === 0) return out;
    // \t 分隔字段,后续 JS split('\t') 解析。每行一条容器。
    // 字段顺序固定不能改 — 解析按 index 取值。
    // safeNames 已通过白名单 regex,不含任何 shell 元字符,直接拼接安全。
    const cmd = `docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}\\t{{.PIDs}}" ${safeNames.join(' ')}`;
    const result = await this.shell.exec(cmd, { timeout: 5000 });
    if (result.exitCode !== 0) {
      // 容器全停 / 名字全错时 docker stats 返回非 0,但 stderr 一般是
      // "No such container",这种情况返回空 map 让调用方静默降级。
      return out;
    }

    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 7) continue;
      const [name, cpuPerc, memUsage, memPerc, netIO, blockIO, pids] = parts;
      out.set(name, {
        name,
        cpuPercent: parseFloatSafe(cpuPerc.replace('%', '')),
        memUsedBytes: parseDockerSize((memUsage.split('/')[0] || '').trim()),
        memLimitBytes: parseDockerSize((memUsage.split('/')[1] || '').trim()),
        memPercent: parseFloatSafe(memPerc.replace('%', '')),
        netRxBytes: parseDockerSize((netIO.split('/')[0] || '').trim()),
        netTxBytes: parseDockerSize((netIO.split('/')[1] || '').trim()),
        blockReadBytes: parseDockerSize((blockIO.split('/')[0] || '').trim()),
        blockWriteBytes: parseDockerSize((blockIO.split('/')[1] || '').trim()),
        pids: parseFloatSafe(pids),
      });
    }
    return out;
  }

  async getLogs(containerName: string, tail = 500): Promise<string> {
    const result = await this.shell.exec(`docker logs --timestamps --tail ${tail} ${containerName}`);
    return combinedOutput(result);
  }

  /**
   * Stream container logs via `docker logs -f`. Returns an AbortController
   * to stop the stream. Calls onData with each chunk, onClose when done.
   */
  streamLogs(
    containerName: string,
    onData: (chunk: string) => void,
    onClose: () => void,
    tail = 200,
  ): AbortController {
    const ac = new AbortController();
    const child = spawn('docker', ['logs', '--timestamps', '-f', '--tail', String(tail), containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (data: Buffer) => {
      if (!ac.signal.aborted) onData(data.toString());
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('close', () => { if (!ac.signal.aborted) onClose(); });
    child.on('error', () => onClose());
    ac.signal.addEventListener('abort', () => { child.kill(); });
    return ac;
  }

  async getEnv(containerName: string): Promise<string> {
    // Use docker inspect instead of docker exec to support stopped containers
    const result = await this.shell.exec(
      `docker inspect ${containerName} --format='{{range .Config.Env}}{{println .}}{{end}}'`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`获取环境变量失败:\n${combinedOutput(result)}`);
    }
    return result.stdout;
  }

  // ── Container labels & discovery ──

  /**
   * Docker labels applied to all CDS-managed app containers.
   * 2026-05-28 起新增 `cds.project.id` 用于跨项目隔离与按项目过滤清理。
   */
  private appLabels(projectId: string, branchId: string, profileId: string, network: string): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=app',
      `--label cds.project.id=${projectId || '_unknown'}`,
      `--label cds.branch.id=${branchId}`,
      `--label cds.profile.id=${profileId}`,
      `--label cds.network=${network}`,
    ].join(' ');
  }

  /**
   * Docker labels applied to all CDS-managed infra containers.
   * 2026-05-28 起新增 `cds.project.id`(老 legacy infra 用 `_legacy`)。
   */
  private infraLabels(service: InfraService, network: string): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=infra',
      `--label cds.project.id=${service.projectId || '_legacy'}`,
      `--label cds.service.id=${service.id}`,
      `--label cds.network=${network}`,
    ].join(' ');
  }

  /**
   * Start an infrastructure service container.
   * Uses Docker named volumes for persistence and labels for discovery.
   *
   * customEnv (2026-05-01 Phase 1):用项目级 customEnv 展开 service.env
   * 里的 ${VAR} 引用,保证 mongo/mysql 等 infra 容器拿到的 USER/PASSWORD
   * 是真实值而不是字面量。调用方应该从 stateService.getCustomEnv(projectId)
   * 取并传入。为兼容老调用方,customEnv 可省略 → 走原行为(env 里有
   * ${VAR} 字面量,容器拿到空值)。
   */
  async startInfraService(
    service: InfraService,
    customEnv?: Record<string, string>,
  ): Promise<void> {
    const network = this.getNetworkForProject(service.projectId);
    await this.ensureNetwork(network);

    // 幂等启动（2026-05-05 修 P0 bug）
    //
    // 历史行为：直接 `docker rm -f ${name}` 然后 `docker run` 重建。这条路径
    // 在 deploy 流程触发时会**杀掉用户正在共享使用的 mongo / redis 等
    // long-lived infra 容器**——所有连接被 kill、SSE/WebSocket 断、用户在
    // 用的页面瞬间 502。同时还会偶发 race-condition：rm 完成前 docker run
    // 已经发起 → "container name already in use" → deploy 整体 fail。
    //
    // 修法：分三档处理已存在的同名容器：
    //   - running    → noop 复用（共享语义。不删不停不重建，连接不断）
    //   - stopped    → docker start 唤醒（保留 volume / 端口绑定 / 网络配置）
    //   - 不存在     → docker run 创建（首次启动）
    //   - 唤醒失败   → fallback rm-f + run（image 升级或 cmdline 改变时）
    //
    // 配合用户的设计意图："默认共享数据库"——deploy 跑到这里时，如果共享
    // mongo 已经在跑，本函数立刻返回，零副作用。
    //
    // 关于配置漂移（Bugbot Review 2026-05-06 Medium 8cf58fe4 提出）
    //
    // docker start 用的是容器**创建时**的 image / env / port / volume / health。
    // 如果运维通过 admin UI 改了 InfraService 定义（升级 image，改 env，
    // 加 volume），这里的 idempotent reuse 路径**不会**应用新定义 —— 这是
    // 故意的，符合"共享 infra 是 long-lived，配置变更走专门动作"的语义。
    //
    // 让配置变更生效的正确姿势：
    //   POST /api/infra/:id/restart 或 stopInfraService + startInfraService
    //   组合 —— 前者会 `docker stop && docker rm`，下次 startInfraService 看不
    //   到容器走 docker run 新 config 重建。
    //
    // 如果未来要做"自动检测 config drift 触发 rebuild"，建议方案：
    //   - 创建容器时打 label `cds.config.fingerprint=<sha256(image+ports+volumes)>`
    //   - 这里 inspect labels 比对 fingerprint，不一致 → rm + run；一致 → start
    //   - env 不进 fingerprint（频繁变 + 用户不期待杀连接）
    // 暂未实现 —— 当前共享 mongo/redis 实战中 image 几乎不变，drift 风险低。
    // Bugbot 2026-05-06 cd577195:service.containerName 直接拼进
    // child_process.exec 会让 shell metacharacters 改变命令行为。
    // Docker 容器名规范是 [a-zA-Z0-9][a-zA-Z0-9_.-]+,完全 alnum/dot/dash,
    // 这里加 defense-in-depth 守门拒绝异常值。
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service.containerName)) {
      throw new Error(`Infra service container name 含非法字符: ${JSON.stringify(service.containerName).slice(0, 80)}`);
    }
    const inspect = await this.shell.exec(
      `docker inspect --format='{{.State.Status}}' ${service.containerName}`,
    );
    // Bug D-residual fix(2026-05-10):reuse / wake 路径都需要保证 infra 容器
    // 在 network 上同时拥有"长名 + 短别名",否则 profile 容器内 getent hosts
    // mysql 仍 NXDOMAIN。这里和 docker run 路径走同一份 alias 列表。
    const desiredAliases = computeProfileAliases(
      service.id,
      this.getProjectMarkers(service.projectId),
    );
    if (inspect.exitCode === 0) {
      const dockerStatus = inspect.stdout.trim();
      if (dockerStatus === 'running') {
        // 已经在跑 —— 共享复用，不动它
        // Bug C fix(2026-05-10):reused 路径必须确保 infra 连到当前 project
        // network。场景:project network 被重建(deploy 流程 / project 重建)后,
        // 老 infra 容器仍连在老 network 上,profile 容器解析 nacos/redis 拿到
        // NXDOMAIN。这里 best-effort connect → 已连返回非零(已存在)幂等可忽略。
        await this.ensureInfraOnNetwork(service.containerName, desiredAliases, network);
        this.recordContainerEvent({
          severity: 'info',
          source: 'cds-container-service',
          action: 'infra.reuse-running',
          message: `infra container already running: ${service.containerName}`,
          projectId: service.projectId,
          serviceId: service.id,
          containerName: service.containerName,
          status: dockerStatus,
          details: { image: service.dockerImage, hostPort: service.hostPort, containerPort: service.containerPort, network },
        });
        return;
      }
      // 存在但 stopped/exited/created —— 用 docker start 唤醒
      const startResult = await this.shell.exec(`docker start ${service.containerName}`);
      if (startResult.exitCode === 0) {
        // 同样:wake 后保证 network attach
        await this.ensureInfraOnNetwork(service.containerName, desiredAliases, network);
        const diagnostics = await this.captureContainerDiagnostics(service.containerName, 120);
        this.recordContainerEvent({
          severity: 'info',
          source: 'cds-container-service',
          action: 'infra.start-existing.completed',
          message: `docker start completed for infra ${service.containerName}`,
          projectId: service.projectId,
          serviceId: service.id,
          containerName: service.containerName,
          command: { name: 'docker start', exitCode: startResult.exitCode, stdoutPreview: startResult.stdout, stderrPreview: startResult.stderr },
          inspect: diagnostics.inspect,
          logs: diagnostics.logs,
        });
        return;
      }
      // 唤醒失败（image 升级 / 命令行变了）—— fallback：删了重建
      const diagnostics = await this.captureContainerDiagnostics(service.containerName, 200);
      this.recordContainerEvent({
        severity: 'warn',
        source: 'cds-container-service',
        action: 'infra.start-existing.failed',
        message: `docker start failed for infra ${service.containerName}; fallback to rm/run`,
        projectId: service.projectId,
        serviceId: service.id,
        containerName: service.containerName,
        command: { name: 'docker start', exitCode: startResult.exitCode, stdoutPreview: startResult.stdout, stderrPreview: startResult.stderr },
        inspect: diagnostics.inspect,
        logs: diagnostics.logs,
      });
      this.noteLifecycleIntent(service.containerName, 'cds-infra-recreate', 'infra docker start 失败后删除重建');
      const rmResult = await this.shell.exec(`docker rm -f ${service.containerName}`);
      this.recordContainerEvent({
        severity: rmResult.exitCode === 0 ? 'warn' : 'error',
        source: 'cds-container-service',
        action: 'infra.fallback-rm',
        message: `fallback docker rm -f for infra ${service.containerName}`,
        projectId: service.projectId,
        serviceId: service.id,
        containerName: service.containerName,
        command: { name: 'docker rm -f', exitCode: rmResult.exitCode, stdoutPreview: rmResult.stdout, stderrPreview: rmResult.stderr },
      });
    }

    // Build volume flags (named volumes + bind mounts)
    const volumeFlags = service.volumes.map(v => {
      const roSuffix = v.readOnly ? ':ro' : '';
      if (v.type === 'bind') {
        // Resolve relative paths against repo root
        const hostPath = v.name.startsWith('/') ? v.name : `${this.config.repoRoot}/${v.name}`;
        return `-v "${hostPath}":"${v.containerPath}${roSuffix}"`;
      }
      return `-v "${v.name}":"${v.containerPath}${roSuffix}"`;
    });

    // 展开 ${VAR} 引用(2026-05-01 Phase 1):用 customEnv 作 lookup
    // 表先把 service.env 里的 ${MONGO_USER} / ${MONGO_PASSWORD} 等
    // 替换成真实值。customEnv 缺失时跳过(老行为)。
    const resolvedEnv = customEnv
      ? resolveEnvTemplates(service.env, customEnv)
      : service.env;

    // Build env flags
    const envFlags = Object.entries(resolvedEnv).map(
      ([k, v]) => `-e "${k}=${v}"`,
    );

    // Health check flags
    const healthFlags: string[] = [];
    if (service.healthCheck) {
      healthFlags.push(
        `--health-cmd="${service.healthCheck.command.replace(/"/g, '\\"')}"`,
        `--health-interval=${service.healthCheck.interval}s`,
        `--health-retries=${service.healthCheck.retries}`,
        `--health-start-period=10s`,
      );
    }

    // Phase 7 fix(B15,2026-05-01)— 加 --network-alias <service.id>。
    // CDS 容器名是 cds-infra-<projectSlug>-<id>(全局唯一),docker network DNS
    // 默认只能解析全名。但 cds-compose 里其它 service 用短名(如 db / mysql /
    // redis)做 host 引用 → DNS 解析失败 → nc 报 "bad address 'db'"。
    // --network-alias 给 container 在 network 里再加一个短名,DNS 就能解析。
    //
    // Bug D-residual fix(2026-05-10):service.id 在多项目场景下经常是
    // `<short>-<projectIdSlug>`(如 `mysql-mdimp` / `redis-mdimp`),profile
    // 容器内代码却用裸短名(`mysql` / `redis` / `nacos`)做 host 引用 ——
    // getent hosts mysql 还是 NXDOMAIN。复用 computeProfileAliases 的同款
    // 启发式:剥掉看起来像 project marker 的尾段,再注册一个短别名。
    //   - mysql-mdimp + project mdimp → 加 --network-alias mysql
    //   - mysql       + project mdimp → 不加(已是短名)
    //   - mysql-other + project mdimp → 不加(尾段不像本项目 marker)
    const aliasFlags = computeProfileAliases(
      service.id,
      this.getProjectMarkers(service.projectId),
    ).map((a) => `--network-alias ${a}`);

    // 2026-05-28 灾难修复:
    //   1) yaml 的 `command:` / `entrypoint:` 必须传给 docker run,否则容器
    //      用 image 默认 ENTRYPOINT,minio/elasticsearch 这类需要子命令的
    //      image 会立刻 exit 0 → unless-stopped 无限重启拖垮整个 host
    //   2) `--restart` 默认从 unless-stopped 改成 on-failure:3,避免烂配
    //      置一直 churn;可在 yaml 用 restart: 字段覆盖
    //   3) image 之后跟 cmd suffix,顺序符合 docker run [OPTIONS] IMAGE [COMMAND]
    // 2026-05-28 Bugbot Medium 修复:数组形态的 entrypoint,docker `--entrypoint`
    // 只接 executable,余下元素必须 prepend 到 cmd 才会生效。
    // 例:entrypoint: ["python3","-m","http.server"] →
    //   --entrypoint python3  ... image  -m http.server
    // 2026-05-29 灾难修复:之前 service.env 走了 resolveEnvTemplates 但 command /
    // entrypoint 没走 — yaml 里 `command: redis-server --requirepass ${CDS_REDIS_PASSWORD}`
    // 透传到 child_process.exec,host shell 找不到 CDS_REDIS_PASSWORD(那是项目
    // 级 customEnv,不是 systemd CDS 进程 env)→ 展开成空 → redis 启动看到
    // `--requirepass ` 缺值,FATAL CONFIG ERROR 无限重启。把 command/entrypoint
    // 也过一遍同一份 customEnv 模板替换,根治。
    const resolvedCommand = resolveCommandTemplate(service.command, customEnv);
    const resolvedEntrypoint = resolveCommandTemplate(service.entrypoint, customEnv);
    const explicitCmdParts = resolvedCommand === undefined
      ? []
      : Array.isArray(resolvedCommand)
        ? resolvedCommand.map((c) => this.shellQuote(String(c)))
        : [String(resolvedCommand)]; // string 形态 yaml 中通常是 shell 语法,不再 quote
    let entrypointFlag = '';
    let entrypointExtraArgs: string[] = [];
    if (resolvedEntrypoint !== undefined) {
      if (Array.isArray(resolvedEntrypoint)) {
        const [head, ...rest] = resolvedEntrypoint;
        entrypointFlag = `--entrypoint ${this.shellQuote(String(head ?? ''))}`;
        entrypointExtraArgs = rest.map((r) => this.shellQuote(String(r)));
      } else {
        entrypointFlag = `--entrypoint ${this.shellQuote(String(resolvedEntrypoint))}`;
      }
    }
    const cmdParts = [...entrypointExtraArgs, ...explicitCmdParts];
    // Codex review(PR #684, P1 安全):restartPolicy 会被原样拼进经 shell 执行的
    // docker run 字符串。新增的 POST /api/infra 把 body.restartPolicy 落库、yaml 的
    // restart: 也会进来 —— 若值是 `no; touch /tmp/pwn` 之类,shell 会在 host 上执行
    // 注入的后缀。这里按 Docker 合法 restart 策略白名单校验(no / always /
    // unless-stopped / on-failure[:N]),非法值一律回落默认,杜绝命令注入。
    const restartPolicy = sanitizeDockerRestartPolicy(service.restartPolicy);

    const cmd = [
      'docker run -d',
      `--name ${service.containerName}`,
      `--network ${network}`,
      ...aliasFlags,
      `-p ${service.hostPort}:${service.containerPort}`,
      ...volumeFlags,
      ...envFlags,
      ...healthFlags,
      ...(entrypointFlag ? [entrypointFlag] : []),
      this.infraLabels(service, network),
      `--restart ${restartPolicy}`,
      service.dockerImage,
      ...cmdParts,
    ].filter(Boolean).join(' ');

    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      this.recordContainerEvent({
        severity: 'error',
        source: 'cds-container-service',
        action: 'infra.run.failed',
        message: `docker run failed for infra ${service.containerName}`,
        projectId: service.projectId,
        serviceId: service.id,
        containerName: service.containerName,
        command: { name: 'docker run', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
        details: { image: service.dockerImage, hostPort: service.hostPort, containerPort: service.containerPort, network },
      });
      throw new Error(`启动基础设施服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
    }
    this.recordContainerEvent({
      severity: 'info',
      source: 'cds-container-service',
      action: 'infra.run.started',
      message: `docker run started infra ${service.containerName}`,
      projectId: service.projectId,
      serviceId: service.id,
      containerName: service.containerName,
      command: { name: 'docker run', exitCode: result.exitCode, stdoutPreview: result.stdout, stderrPreview: result.stderr },
      details: { image: service.dockerImage, hostPort: service.hostPort, containerPort: service.containerPort, network },
    });
  }

  /** Stop and remove an infrastructure service container */
  async stopInfraService(containerName: string): Promise<void> {
    const before = await this.captureContainerDiagnostics(containerName, 300);
    this.recordContainerEvent({
      severity: 'warn',
      source: 'cds-container-service',
      action: 'infra.remove.requested',
      message: `CDS requested infra stop/rm for ${containerName}`,
      containerName,
      inspect: before.inspect,
      logs: before.logs,
      error: before.error,
    });
    this.noteLifecycleIntent(containerName, 'cds-infra-recreate', 'infra stop/rm 重建或删除');
    const stopResult = await this.shell.exec(`docker stop ${containerName}`);
    const rmResult = await this.shell.exec(`docker rm ${containerName}`);
    this.recordContainerEvent({
      severity: rmResult.exitCode === 0 ? 'info' : 'error',
      source: 'cds-container-service',
      action: 'infra.remove.completed',
      message: `docker rm completed for infra ${containerName}`,
      containerName,
      command: {
        name: 'docker stop && docker rm',
        exitCode: rmResult.exitCode,
        stdoutPreview: `${stopResult.stdout || ''}${rmResult.stdout || ''}`,
        stderrPreview: `${stopResult.stderr || ''}${rmResult.stderr || ''}`,
      },
    });
  }

  /**
   * 2026-05-29 显式删除 named volumes(仅 resync"含数据卷重装"路径调用)。
   * 普通 stop/rm **不删** volume(数据保留是默认契约)。这个方法是用户在
   * 弹窗里显式勾选"是否删数据卷"后才走。bind mount(type=bind)跳过。
   * 返回每个 volume 的删除结果,失败不抛(volume 可能被其他容器占用)。
   */
  async removeNamedVolumes(volumeNames: string[]): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const name of volumeNames) {
      if (!name || !name.trim()) continue;
      const r = await this.shell.exec(`docker volume rm ${this.shellQuote(name)}`);
      const ok = r.exitCode === 0;
      results.push({ name, ok, ...(ok ? {} : { error: (r.stderr || '').slice(0, 200) }) });
      this.recordContainerEvent({
        severity: ok ? 'warn' : 'error',
        source: 'cds-container-service',
        action: 'infra.volume.remove',
        message: `docker volume rm ${name} — ${ok ? 'ok' : 'failed'}`,
        command: { name: 'docker volume rm', exitCode: r.exitCode, stdoutPreview: r.stdout, stderrPreview: r.stderr },
      });
    }
    return results;
  }

  /**
   * Discover CDS-managed infra containers by Docker labels.
   * Returns a map of service.id → container status.
   *
   * Week 4.9 多项目网络隔离：以前 filter 里硬编码了
   * `cds.network=${this.config.dockerNetwork}`,在每个项目独立 network 后会
   * 漏掉跨项目容器。现改为只 filter `cds.managed=true` + `cds.type=infra`,
   * 让发现逻辑覆盖所有 network。状态机仍按 service.id 关联到 state.json
   * 里的 InfraService（已携带 projectId）,不会跨项目串数据。
   */
  /**
   * Map key 是 **container name**(全局唯一),不是 svc.id。
   *
   * 历史版本 key 用 cds.service.id,但 service.id 在跨项目场景下不唯一
   * (project A 和 B 都可能有 svc.id='mongodb'),Map.set 会互相覆盖,
   * 导致 reconcile / deploy infra 检查拿到错的容器。Phase 2 修复:
   * key 改为 cds-infra-{slug}-{id} 这种 docker container name 格式。
   *
   * caller 在用 svc 查 actual 状态时,应用 svc.containerName 当 key。
   */
  async discoverInfraContainers(): Promise<Map<string, { running: boolean; containerName: string; serviceId: string }>> {
    const result = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=infra" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
    );

    const discovered = new Map<string, { running: boolean; containerName: string; serviceId: string }>();
    if (result.exitCode !== 0 || !result.stdout.trim()) return discovered;

    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [name, state, labels] = line.split('|');
      const idMatch = labels?.match(/cds\.service\.id=([^,]+)/);
      const serviceId = idMatch?.[1] || '';
      // 用 container name 做 key(全局唯一);value 同时携带 serviceId 供老 caller 兼容
      discovered.set(name, {
        running: state === 'running',
        containerName: name,
        serviceId,
      });
    }
    return discovered;
  }

  /**
   * Discover CDS-managed app containers by Docker labels.
   * Returns a map of "branchId/profileId" → { running, containerName }.
   *
   * 同 discoverInfraContainers：移除了 `cds.network=` filter,改用 branchId
   * 关联,branch 自带 projectId 不会跨项目串数据。
   */
  async discoverAppContainers(): Promise<Map<string, { running: boolean; containerName: string; branchId: string; profileId: string; network?: string }>> {
    const result = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=app" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
    );

    const discovered = new Map<string, { running: boolean; containerName: string; branchId: string; profileId: string; network?: string }>();
    if (result.exitCode !== 0 || !result.stdout.trim()) return discovered;

    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [name, state, labels] = line.split('|');
      const branchMatch = labels?.match(/cds\.branch\.id=([^,]+)/);
      const profileMatch = labels?.match(/cds\.profile\.id=([^,]+)/);
      const networkMatch = labels?.match(/cds\.network=([^,]+)/);
      if (branchMatch && profileMatch) {
        const key = `${branchMatch[1]}/${profileMatch[1]}`;
        discovered.set(key, {
          running: state === 'running',
          containerName: name,
          branchId: branchMatch[1],
          profileId: profileMatch[1],
          ...(networkMatch?.[1] ? { network: networkMatch[1] } : {}),
        });
      }
    }
    return discovered;
  }

  /** Check health of an infrastructure container */
  async getInfraHealth(containerName: string): Promise<'healthy' | 'unhealthy' | 'starting' | 'none'> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Health.Status}}" ${containerName} 2>/dev/null || echo none`,
    );
    const status = result.stdout.trim();
    if (['healthy', 'unhealthy', 'starting'].includes(status)) {
      return status as 'healthy' | 'unhealthy' | 'starting';
    }
    return 'none';
  }

  /**
   * 确保指定的 docker network 存在。Week 4.9 起每个项目有独立 network
   * `cds-proj-<id>`,deploy 前先 ensure 当前 entry/service 的 network。
   *
   * 兼容老调用方：网络名缺省时退回到 config.dockerNetwork（pre-P4 共享网络）。
   */
  private async ensureNetwork(network?: string): Promise<void> {
    const target = network || this.config.dockerNetwork;
    const inspect = await this.shell.exec(`docker network inspect ${target}`);
    if (inspect.exitCode !== 0) {
      const create = await this.shell.exec(`docker network create ${target}`);
      if (create.exitCode !== 0) {
        throw new Error(`创建 Docker 网络 "${target}" 失败:\n${combinedOutput(create)}`);
      }
    }
  }

  /**
   * Bug C fix(2026-05-10) — 把现有 infra 容器幂等连到 project network 上。
   *
   * 场景:project network 被重建 / project 被删后重建 / 用户手动 docker network
   * rm 之后,running infra 容器仍连在老 network 上,profile 容器(连在新 network)
   * 内 `getent hosts redis nacos` 拿到 NXDOMAIN。
   *
   * 调用时机:startInfraService 复用 running 容器或 docker start 唤醒之后。
   *
   * 失败语义:
   *   - 已经连上 → docker 报 "endpoint with name X already exists" exitCode!=0,
   *     吞掉,这是预期幂等。
   *   - network 不存在 → 上层 ensureNetwork 已先建,不会发生。
   *   - 其它失败 → 仅 console.warn,不抛 — infra reuse 路径必须保持
   *     "默认共享数据库不动" 的语义,失败也别 break 上层 deploy。
   */
  private async ensureInfraOnNetwork(
    containerName: string,
    aliases: string[],
    network: string,
  ): Promise<void> {
    const aliasFlags = (aliases || []).filter(Boolean).map((a) => `--alias ${a}`).join(' ');
    const result = await this.shell.exec(
      `docker network connect ${aliasFlags} ${network} ${containerName}`,
    );
    if (result.exitCode === 0) return;
    const stderr = (result.stderr || '').toLowerCase();
    // 已经在 network 上 → 检查别名是否齐,缺则 disconnect+reconnect 修补
    // (Bug D-residual 2026-05-10):reuse 路径下老容器只有长别名,本次升级后
    // 需要补短别名(mysql-mdimp → mysql),否则 profile 容器仍 NXDOMAIN。
    if (stderr.includes('already exists') || stderr.includes('already connected')) {
      await this.reconcileNetworkAliases(containerName, aliases, network);
      return;
    }
    // 容器不存在(race:被人手动删了) → 上层 reconcile 会发现并重建
    if (stderr.includes('no such container')) return;
    console.warn(
      `[infra] network connect ${network} → ${containerName} 失败(忽略,继续): ${(result.stderr || result.stdout || '').slice(0, 200)}`,
    );
  }

  /**
   * Bug D-residual(2026-05-10):用 docker inspect 检查容器在 network 上的现有
   * 别名,与 desired 集合对比;缺则 disconnect + reconnect 重建,补齐别名。
   *
   * disconnect+reconnect 会瞬断这个容器在该 network 上的连接(< 1 秒),对
   * shared infra 是可接受的代价 —— alternative 是逼用户手动删容器重建,体验
   * 更差。已经齐全则直接 return,零副作用。
   */
  private async reconcileNetworkAliases(
    containerName: string,
    desiredAliases: string[],
    network: string,
  ): Promise<void> {
    const desired = (desiredAliases || []).filter(Boolean);
    if (desired.length === 0) return;
    // 取容器在 target network 上的现有 aliases
    const inspect = await this.shell.exec(
      `docker inspect --format='{{json .NetworkSettings.Networks.${network}.Aliases}}' ${containerName}`,
    );
    if (inspect.exitCode !== 0) {
      console.warn(`[infra] inspect ${containerName} on ${network} 失败,跳过 alias 修补`);
      return;
    }
    let existing: string[] = [];
    try {
      const raw = inspect.stdout.trim();
      if (raw && raw !== 'null') existing = JSON.parse(raw) || [];
    } catch {
      // 解析失败也走"补齐"路径,disconnect+reconnect 一次保险
    }
    const missing = desired.filter((a) => !existing.includes(a));
    if (missing.length === 0) return;
    // 有缺失 → 重连补齐
    const aliasFlags = desired.map((a) => `--alias ${a}`).join(' ');
    await this.shell.exec(`docker network disconnect ${network} ${containerName}`);
    const reconnect = await this.shell.exec(
      `docker network connect ${aliasFlags} ${network} ${containerName}`,
    );
    if (reconnect.exitCode !== 0) {
      console.warn(
        `[infra] reconcile aliases ${desired.join(',')} on ${containerName} 失败: ${(reconnect.stderr || '').slice(0, 200)}`,
      );
    }
  }
}
