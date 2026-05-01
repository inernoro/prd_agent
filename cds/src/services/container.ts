import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState, InfraService, DeployModeOverride, BuildProfileOverride, ReadinessProbe } from '../types.js';
import { combinedOutput } from '../types.js';
import { resolveEnvTemplates } from './compose-parser.js';
import { applyPerBranchDbIsolation } from './db-scope-isolation.js';

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
      // 不 clean，不 --no-incremental；如需破缓存走 🧹 清理按钮（force-rebuild）。
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
    resolved = {
      ...profile,
      command: override.command ?? profile.command,
      dockerImage: override.dockerImage ?? profile.dockerImage,
      env: override.env
        ? { ...profile.env, ...override.env }
        : profile.env,
    };
  }
  // Hot reload 优先级最高
  const hrCmd = resolveHotReloadCommand(resolved);
  if (hrCmd) {
    return { ...resolved, command: hrCmd };
  }
  return resolved;
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
 * The branch override can even change the active deploy mode, so it is applied
 * before `resolveProfileWithMode`.
 *
 * All call sites that previously used `resolveProfileWithMode(profile)` directly
 * should switch to `resolveEffectiveProfile(profile, branch)` so per-branch
 * overrides take effect.
 */
export function resolveEffectiveProfile(profile: BuildProfile, branch?: BranchEntry): BuildProfile {
  const branchOverride = branch?.profileOverrides?.[profile.id];
  const withBranchOverride = applyProfileOverride(profile, branchOverride);
  return resolveProfileWithMode(withBranchOverride);
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
  ) {}

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
  ): Promise<void> {
    const network = this.getNetworkForProject(entry.projectId);
    await this.ensureNetwork(network);

    // Remove any existing container
    await this.shell.exec(`docker rm -f ${service.containerName}`);

    const srcMount = path.join(entry.worktreePath, profile.workDir);
    const containerWorkDir = profile.containerWorkDir || '/app';
    // Phase 7 fix(B17,2026-05-01)— 预构建镜像模式跳过 srcMount。
    // 详见 BuildProfile.prebuiltImage 注释。
    const skipSrcMount = profile.prebuiltImage === true;

    // Build environment variables (later entries override earlier ones)
    // Priority: customEnv (user dashboard) < profile.env (per-profile)
    const mergedEnv: Record<string, string> = {};

    // User-defined env vars from dashboard (includes CDS_* vars from infra services)
    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    // JWT
    mergedEnv['Jwt__Secret'] = this.config.jwt.secret;
    mergedEnv['Jwt__Issuer'] = this.config.jwt.issuer;

    // Inject git branch name so frontend build tools (e.g. Vite __GIT_BRANCH__) can pick it up.
    if (entry.branch) {
      mergedEnv['VITE_GIT_BRANCH'] = entry.branch;
    }

    // Detect Node.js containers by image name (node:*, *node:*, etc.)
    const isNodeContainer = /\bnode:/.test(profile.dockerImage);

    // For Node.js containers: move pnpm store outside the bind-mounted source directory.
    // Without this, pnpm creates .pnpm-store inside /app (the bind mount), and Vite's
    // chokidar watches all those files, quickly exhausting the kernel inotify limit (ENOSPC).
    // Setting PNPM_HOME=/pnpm puts the store at /pnpm/store (container overlay FS),
    // invisible to Vite's file watcher. pnpm falls back to copying instead of hard-linking,
    // which is fine for dev environments.
    if (isNodeContainer) {
      mergedEnv['PNPM_HOME'] = mergedEnv['PNPM_HOME'] || '/pnpm';
      // Move pnpm content-addressable store outside the project directory.
      // Without this, pnpm creates <project>/.pnpm-store and Vite's chokidar
      // watches all those files, exhausting the kernel inotify limit (ENOSPC).
      // pnpm reads store-dir from npm_config_store_dir (NOT "PNPM_STORE_DIR").
      // See: https://github.com/orgs/pnpm/discussions/6566
      mergedEnv['npm_config_store_dir'] = mergedEnv['npm_config_store_dir'] || '/pnpm/store';
      // Ensure pnpm binary is on PATH after corepack enable
      const currentPath = mergedEnv['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      if (!currentPath.includes('/pnpm')) {
        mergedEnv['PATH'] = `/pnpm:${currentPath}`;
      }
    }

    // Profile-specific env (highest priority)
    if (profile.env) {
      Object.assign(mergedEnv, profile.env);
    }

    // Phase 5(2026-05-01)— 多分支 DB 隔离:
    //   profile.dbScope==='per-branch' 时,把 MYSQL_DATABASE 等 DB-name 类 env
    //   后缀 _<branchSlug>,实现"同一 DB 实例下每分支独立 database"。
    //   必须在 resolveEnvTemplates 之前调用 — 这样 ${MYSQL_DATABASE} 引用会
    //   展开成新值,连接串也会跟着变。
    //   shared 模式(默认)是 noop,保持现有行为不变。
    const isolatedEnv = applyPerBranchDbIsolation(mergedEnv, profile.dbScope, entry.branch);

    // Resolve ${CDS_*} env var templates in all values
    // e.g., MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"
    // → "mongodb://172.17.0.1:37821"
    const missingTemplates = missingEnvTemplates(isolatedEnv);
    if (missingTemplates.length > 0) {
      throw new Error(
        `环境变量模板缺少值: ${missingTemplates.join(', ')}。请在项目环境变量中填写，或先启动对应基础设施服务后再部署。`,
      );
    }
    // Phase 7 B16 + Bugbot 三轮迭代(PR #521)— 三个场景同时要 work:
    //   1. B16 自引用:profile.env.X="${X}" 时,resolve 应拿 customEnv.X 真值
    //   2. profile-local:URL=${HOST}:${PORT},HOST/PORT 在 isolatedEnv 应可查
    //   3. per-branch isolation:isolatedEnv.CDS_POSTGRES_DB="app_feat_login"
    //      (Phase 5 修改的)不应被 customEnv 的 'app' 覆盖回去 → 否则
    //      ${CDS_POSTGRES_DB} 在 CDS_DATABASE_URL 解析回 'app',隔离完全失效
    //
    // 之前 fix 用 `{...isolatedEnv, ...customEnv}` 满足 1+2 但破坏 3。
    // 正解:isolatedEnv 是真值源(per-branch + profile.env + customEnv 已合并),
    //       仅当某 key 在 isolatedEnv 里值就是字面量 "${K}" 自引用时,才回退
    //       到 customEnv 拿真值。这样三个场景全 work。
    const resolveVars: Record<string, string> = { ...isolatedEnv };
    if (customEnv) {
      for (const [k, v] of Object.entries(isolatedEnv)) {
        // 自引用模式 ${K} 字面量(== 自己的 key) → 回退到 customEnv 真值
        if (v === `\${${k}}` && customEnv[k] !== undefined) {
          resolveVars[k] = customEnv[k];
        }
      }
    }
    const resolvedEnv = resolveEnvTemplates(isolatedEnv, resolveVars);

    // Write to temp file — avoids shell escaping issues with special chars
    const envFilePath = this.writeEnvFile(resolvedEnv);
    const envFlag = `--env-file "${envFilePath}"`;

    // Shared cache mounts (avoid duplicating node_modules, nuget, etc.)
    // Phase 7 (B17): prebuiltImage 模式跳过 srcMount,不覆盖 image 自带文件
    const volumeFlags: string[] = skipSrcMount
      ? []
      : [`-v "${srcMount}":"${containerWorkDir}"`];
    if (skipSrcMount) {
      onOutput?.(`── 预构建镜像模式: 跳过 source mount(image 已含应用文件)──\n`);
    }

    if (profile.cacheMounts) {
      for (const cm of profile.cacheMounts) {
        // Ensure host path exists
        const mkdir = await this.shell.exec(`mkdir -p "${cm.hostPath}"`);
        if (mkdir.exitCode !== 0) {
          throw new Error(`创建缓存目录失败: ${cm.hostPath}: ${combinedOutput(mkdir)}`);
        }
        volumeFlags.push(`-v "${cm.hostPath}":"${cm.containerPath}"`);
      }
    }

    // ffmpeg: 静态编译版 bind mount（零依赖，单文件）
    // 优先使用 /opt/ffmpeg-static/（用户下载的静态版），否则尝试宿主机 /usr/bin/ffmpeg
    const ffmpegPaths = ['/opt/ffmpeg-static/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    const ffprobePaths = ['/opt/ffmpeg-static/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'];
    const findResult = await this.shell.exec(
      `for p in ${ffmpegPaths.join(' ')}; do [ -f "$p" ] && echo "$p" && break; done`
    );
    const ffmpegPath = findResult.stdout?.trim();
    if (ffmpegPath) {
      volumeFlags.push(`-v "${ffmpegPath}:/usr/local/bin/ffmpeg:ro"`);
      // ffprobe
      const findProbe = await this.shell.exec(
        `for p in ${ffprobePaths.join(' ')}; do [ -f "$p" ] && echo "$p" && break; done`
      );
      const ffprobePath = findProbe.stdout?.trim();
      if (ffprobePath) {
        volumeFlags.push(`-v "${ffprobePath}:/usr/local/bin/ffprobe:ro"`);
      }
    }

    try {
      const command = profile.command || '';
      if (!command) {
        throw new Error(`构建配置 "${profile.id}" 缺少 command 字段`);
      }

      onOutput?.(`── 运行: ${command} ──\n`);
      if (isNodeContainer) {
        onOutput?.(`── Node.js 容器: node_modules 已隔离到 Docker volume ──\n`);
      }

      // Phase 2 resilience: enforce per-container cgroup limits when configured.
      // Unset = legacy behavior (no limits). See doc/design.cds-resilience.md Phase 2.
      const resourceFlags: string[] = [];
      if (profile.resources?.memoryMB && profile.resources.memoryMB > 0) {
        resourceFlags.push(`--memory ${profile.resources.memoryMB}m`);
        // Match memory-swap to memory so we don't leak into swap under pressure.
        resourceFlags.push(`--memory-swap ${profile.resources.memoryMB}m`);
      }
      if (profile.resources?.cpus && profile.resources.cpus > 0) {
        resourceFlags.push(`--cpus ${profile.resources.cpus}`);
      }
      if (resourceFlags.length > 0) {
        onOutput?.(`── 资源限制: ${resourceFlags.join(' ')} ──\n`);
      }

      // Phase 7 fix(B10,2026-05-01)— --entrypoint 覆盖。
      // 默认不传(走 image 自带 ENTRYPOINT)。指定时:
      //   - profile.entrypoint === ""  →  --entrypoint=""(清空)
      //   - profile.entrypoint === "sh -c"  →  --entrypoint "sh -c"(覆盖为 sh -c)
      // 用于 image 自带 wrapper ENTRYPOINT 跟 CDS 部署模式不兼容时(Twenty CRM 实战)。
      const entrypointFlags: string[] = [];
      if (profile.entrypoint !== undefined) {
        // docker --entrypoint 接收单个 token,空字符串走显式 ""。我们用 sh 引用安全
        const ep = profile.entrypoint;
        if (ep === '') {
          entrypointFlags.push(`--entrypoint=""`);
        } else {
          entrypointFlags.push(`--entrypoint ${JSON.stringify(ep)}`);
        }
        onOutput?.(`── entrypoint 覆盖: ${ep || '(清空)'} ──\n`);
      }

      const runCmd = [
        'docker run -d',
        `--name ${service.containerName}`,
        `--network ${network}`,
        `-p ${service.hostPort}:${profile.containerPort}`,
        ...volumeFlags,
        ...resourceFlags,
        ...entrypointFlags,
        `-w ${containerWorkDir}`,
        envFlag,
        '--tmpfs /tmp',
        this.appLabels(entry.id, profile.id, network),
        profile.dockerImage,
        `sh -c "${command.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const result = await this.shell.exec(runCmd);
      if (result.exitCode !== 0) {
        throw new Error(`启动服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
      }

      // Phase 1: Liveness — verify the container process hasn't crashed immediately.
      // docker run -d returns immediately; the process inside may crash shortly after.
      // Poll a few times to catch early exits (e.g., ENOSPC, missing deps, syntax errors).
      await this.waitForContainerAlive(service.containerName, onOutput);
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
          onOutput?.(`── 检测到启动信号: "${signal}" ✓ ──\n`);
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
    if (probe?.noHttp) {
      onOutput?.(`── 就绪探测: noHttp 模式(后台服务,跳过 HTTP 探测,仅靠容器存活)──\n`);
      // 直接返回 true:waitForContainerAlive(6 秒生死探活)已经在 runService
      // 之前跑过了。如果容器跑了 6 秒还活着,我们认为 worker 就绪。
      onAttempt?.({ attempt: 1, max: 1, stage: 'tcp', ok: true });
      return true;
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
        onOutput?.(`── 就绪探测: TCP ${host}:${hostPort} 已就绪 ✓ ──\n`);
      }

      const httpRes = await this.probeHttp(host, hostPort, probePath, Math.min(5000, intervalMs));
      onAttempt?.({ attempt, max: maxAttempts, stage: 'http', ok: httpRes.ok, error: httpRes.error });
      if (httpRes.ok) {
        onOutput?.(`── 就绪探测: HTTP ${probePath} 返回 ${httpRes.status} ✓ ──\n`);
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
  async restartServiceInPlace(containerName: string, onOutput?: (chunk: string) => void): Promise<boolean> {
    const inspect = await this.shell.exec(`docker inspect --format="{{.State.Status}}" ${containerName}`);
    if (inspect.exitCode !== 0) {
      onOutput?.(`── 容器 ${containerName} 不存在，无法原地重启 ──\n`);
      return false;
    }
    onOutput?.(`── 原地重启: docker restart ${containerName} ──\n`);
    const result = await this.shell.exec(`docker restart ${containerName}`);
    if (result.exitCode !== 0) {
      onOutput?.(`── docker restart 失败: ${combinedOutput(result)} ──\n`);
      return false;
    }
    try {
      await this.waitForContainerAlive(containerName, onOutput);
      return true;
    } catch (err) {
      onOutput?.(`── 重启后容器未存活: ${(err as Error).message} ──\n`);
      return false;
    }
  }

  async stop(containerName: string): Promise<void> {
    await this.shell.exec(`docker stop ${containerName}`);
    await this.shell.exec(`docker rm ${containerName}`);
  }

  async isRunning(containerName: string): Promise<boolean> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Running}}" ${containerName}`,
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async getLogs(containerName: string, tail = 500): Promise<string> {
    const result = await this.shell.exec(`docker logs --tail ${tail} ${containerName}`);
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
    const child = spawn('docker', ['logs', '-f', '--tail', String(tail), containerName], {
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

  /** Docker labels applied to all CDS-managed app containers */
  private appLabels(branchId: string, profileId: string, network: string): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=app',
      `--label cds.branch.id=${branchId}`,
      `--label cds.profile.id=${profileId}`,
      `--label cds.network=${network}`,
    ].join(' ');
  }

  /** Docker labels applied to all CDS-managed infra containers */
  private infraLabels(service: InfraService, network: string): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=infra',
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

    // Remove any existing container with the same name
    await this.shell.exec(`docker rm -f ${service.containerName}`);

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
    const aliasFlags = [`--network-alias ${service.id}`];

    const cmd = [
      'docker run -d',
      `--name ${service.containerName}`,
      `--network ${network}`,
      ...aliasFlags,
      `-p ${service.hostPort}:${service.containerPort}`,
      ...volumeFlags,
      ...envFlags,
      ...healthFlags,
      this.infraLabels(service, network),
      '--restart unless-stopped',
      service.dockerImage,
    ].join(' ');

    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`启动基础设施服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
    }
  }

  /** Stop and remove an infrastructure service container */
  async stopInfraService(containerName: string): Promise<void> {
    await this.shell.exec(`docker stop ${containerName}`);
    await this.shell.exec(`docker rm ${containerName}`);
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
  async discoverAppContainers(): Promise<Map<string, { running: boolean; containerName: string; branchId: string; profileId: string }>> {
    const result = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=app" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
    );

    const discovered = new Map<string, { running: boolean; containerName: string; branchId: string; profileId: string }>();
    if (result.exitCode !== 0 || !result.stdout.trim()) return discovered;

    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [name, state, labels] = line.split('|');
      const branchMatch = labels?.match(/cds\.branch\.id=([^,]+)/);
      const profileMatch = labels?.match(/cds\.profile\.id=([^,]+)/);
      if (branchMatch && profileMatch) {
        const key = `${branchMatch[1]}/${profileMatch[1]}`;
        discovered.set(key, {
          running: state === 'running',
          containerName: name,
          branchId: branchMatch[1],
          profileId: profileMatch[1],
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
}
