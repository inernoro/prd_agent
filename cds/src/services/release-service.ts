import crypto from 'node:crypto';
import type { StateService } from './state.js';
import type { BranchEntry, DeploymentFailure, ReleaseArtifact, ReleaseExecutionMode, ReleasePlan, ReleaseRun, ReleaseRunStatus, ReleaseTarget, RemoteHost } from '../types.js';
import { decryptRemoteHostSecrets } from './sidecar/remote-host-service.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';
import { releaseEvents } from './release-events.js';
import { classifyDeploymentFailure } from './deployment-failure-classifier.js';
import {
  buildReleaseExecution,
  buildStrategyPreflightCommand,
  effectiveReleaseStrategy,
  normalizeRepositoryIdentity,
  releaseProjectIdentity,
  validateReleaseStrategy,
} from './release-strategy.js';

type Ssh2Client = {
  connect(opts: Ssh2ConnectOptions): void;
  on(event: 'ready' | 'error' | 'end' | 'close', listener: (...args: unknown[]) => void): unknown;
  end(): void;
  exec(cmd: string, cb: (err: Error | undefined, stream: Ssh2ExecStream) => void): boolean;
};

type Ssh2ExecStream = {
  on(event: 'close' | 'data', listener: (...args: unknown[]) => void): unknown;
  stderr: { on(event: 'data', listener: (...args: unknown[]) => void): unknown };
};

interface Ssh2ConnectOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
  passphrase?: string;
  readyTimeout?: number;
}

export interface ReleasePreflightCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  blocking: boolean;
}

export interface ReleasePreflightResult {
  ok: boolean;
  checks: ReleasePreflightCheck[];
  artifact?: ReleaseArtifact;
  target?: ReleaseTarget;
  plan?: ReleasePlan;
  previousRelease?: ReleaseRun;
}

export interface ReleaseStartInput {
  branchId: string;
  targetId: string;
  operator?: string;
  previewUrl?: string;
}

export interface ReleaseHealthProbe {
  status: 'healthy' | 'failed' | 'unknown';
  url: string;
  checkedAt: string;
  responseTimeMs?: number;
  message?: string;
}

/**
 * 心跳过期阈值。与分支侧 DeploymentRunService.reconcileInterrupted 的 15 分钟同口径：
 * 超过它还没打点的非终态 run，一律视为执行体已随进程消失。
 */
export const RELEASE_HEARTBEAT_STALE_MS = 15 * 60_000;

/**
 * 执行期心跳刷新间隔。发布的绝大部分时间花在一条 SSH 命令里（构建 + 部署），
 * 这段是**长静默阶段**：没有任何事件、没有状态变化。必须在这里周期打点，
 * 否则收割器会把一次正常的慢发布误判成「执行体丢失」。
 * 30s 远小于 15 分钟过期阈值，留足容错余量。
 */
export const RELEASE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 单条发布命令的执行超时（区别于 SSH 的 10 秒**连接**超时）。
 *
 * 依据：远端脚本挂住（等交互输入、等一个永不返回的外部依赖）时，SSH 流不会
 * close，run 永不终态，在途守卫会把这个发布目标永久锁死。K8s 的
 * progressDeadlineSeconds 默认 10 分钟；CDS 这边一次发布往往含完整的后端编译 +
 * 前端构建 + 镜像启动，实测量级在十分钟上下，故取 30 分钟作为「肯定不正常」的
 * 上界：既不会误杀慢发布，又保证卡死最多 30 分钟就自动释放。
 * 可用 CDS_RELEASE_EXEC_TIMEOUT_MS 覆盖（毫秒，<=0 视为无效并回落默认值）。
 */
export const RELEASE_EXEC_TIMEOUT_MS = 30 * 60_000;

/**
 * 预检类 SSH 探测（echo / test -f / git rev-parse）的执行超时。
 * 这些命令跑在 HTTP 请求生命周期里，必须短；发布命令本身另有上面的长超时。
 */
export const RELEASE_PREFLIGHT_EXEC_TIMEOUT_MS = 60_000;

/**
 * 全量状态 → 是否终态。写成穷尽式 Record（同 deploy-drain.ts 的 RUN_STATUS_TERMINAL）：
 * 以后新增 ReleaseRunStatus 时这里少一个键 TS 直接报错，不会再有「新状态被静默
 * 当成终态、于是在途守卫放行两个并发发布」这种漏项。
 */
const RELEASE_STATUS_TERMINAL: Record<ReleaseRunStatus, boolean> = {
  queued: false,
  running: false,
  healthchecking: false,
  rollback_running: false,
  success: true,
  failed: true,
  rollback_success: true,
  rollback_failed: true,
};

/** 合法状态转移表。照抄 deployment-run.ts 的 ALLOWED_TRANSITIONS 写法。 */
const ALLOWED_RELEASE_TRANSITIONS: Record<ReleaseRunStatus, ReadonlySet<ReleaseRunStatus>> = {
  queued: new Set<ReleaseRunStatus>(['running', 'failed']),
  running: new Set<ReleaseRunStatus>(['healthchecking', 'failed']),
  healthchecking: new Set<ReleaseRunStatus>(['success', 'failed']),
  rollback_running: new Set<ReleaseRunStatus>(['rollback_success', 'rollback_failed']),
  success: new Set<ReleaseRunStatus>(),
  failed: new Set<ReleaseRunStatus>(),
  rollback_success: new Set<ReleaseRunStatus>(),
  rollback_failed: new Set<ReleaseRunStatus>(),
};

export function isReleaseRunTerminal(status: ReleaseRunStatus): boolean {
  return RELEASE_STATUS_TERMINAL[status] === true;
}

export function canTransitionReleaseRun(from: ReleaseRunStatus, to: ReleaseRunStatus): boolean {
  return ALLOWED_RELEASE_TRANSITIONS[from]?.has(to) === true;
}

export function assertReleaseRunTransition(from: ReleaseRunStatus, to: ReleaseRunStatus): void {
  if (!canTransitionReleaseRun(from, to)) {
    throw new Error(`Invalid ReleaseRun transition: ${from} -> ${to}`);
  }
}

/** 在途 = 非终态。在途守卫、排空判定都从终态表取反推导，不再手写字面量数组。 */
export function isReleaseRunInFlight(run: Pick<ReleaseRun, 'status'>): boolean {
  return !isReleaseRunTerminal(run.status);
}

/**
 * 发布链路特有的失败规则。
 *
 * 分支侧的 deployment-failure-classifier 覆盖的是「构建 / 容器」域（编译错误、
 * 端口冲突、OOM…），它不认识 SSH 传输、健康探测面、执行超时这些只有发布链路
 * 才有的失败。所以这里只补发布特有的那一小撮，其余一律委派给现有分类器——
 * 不复制它的 12 条规则，不另起炉灶。
 */
interface ReleaseFailureRule {
  code: string;
  pattern: RegExp;
  owner: DeploymentFailure['owner'];
  retryable: boolean;
  suggestedAction: string;
}

const RELEASE_RULES: ReleaseFailureRule[] = [
  {
    code: 'release.ssh.auth',
    pattern: /All configured authentication methods failed|Authentication failure|Permission denied \(publickey|Encrypted private key detected|Cannot parse privateKey/i,
    owner: 'config', retryable: false,
    suggestedAction: '核对发布目标的服务器凭据（privateKeyRef、口令）与远端 authorized_keys 后重试',
  },
  {
    code: 'release.ssh.unreachable',
    pattern: /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|Timed out while waiting for handshake|connect ETIMEDOUT/i,
    owner: 'external', retryable: true,
    suggestedAction: '确认目标主机在线、SSH 端口与防火墙放行后重试',
  },
  {
    code: 'release.exec.timeout',
    pattern: /发布命令执行超时/,
    owner: 'code', retryable: true,
    suggestedAction: '登录目标主机确认发布脚本是否卡在交互式输入或外部依赖；必要时拆分脚本或调高 CDS_RELEASE_EXEC_TIMEOUT_MS',
  },
  {
    code: 'release.cancelled',
    pattern: /发布已被.*取消/,
    owner: 'cds', retryable: true,
    suggestedAction: '确认目标主机上的发布脚本是否已中断，必要时回滚到上一成功版本后重新发布',
  },
  {
    code: 'release.interrupted',
    pattern: /CDS 重启导致执行体丢失/,
    owner: 'cds', retryable: true,
    suggestedAction: '确认目标主机上的实际版本，再重新发起一次发布',
  },
  {
    code: 'release.healthcheck.failed',
    pattern: /healthcheck (?:HTTP|timeout|failed)|healthcheckUrl must be|static (?:surface|entry)|最终入口探测失败/i,
    owner: 'code', retryable: true,
    suggestedAction: '确认上线地址返回 200 且入口 JS/CSS 可访问；确认无误前不要重复发布，必要时回滚到上一成功版本',
  },
  {
    code: 'release.script.missing',
    pattern: /missing script:|script is not executable:|ssh exec exit=4[12]\b/,
    owner: 'config', retryable: false,
    suggestedAction: '确认远端发布目录下的脚本存在且具备可执行权限后重试',
  },
];

/**
 * 结构化发布失败。先匹配发布特有规则，未命中则委派给分支侧分类器
 * （它能从流式日志里认出编译错误、依赖缺失、端口冲突等真正的失败根因）。
 */
export function classifyReleaseFailure(input: {
  message: string;
  phase: string;
  evidenceRefs?: string[];
  logText?: string;
  /**
   * 强制指定 code，跳过文本推断。取消 / 心跳收割这类失败是**确定事实**，
   * 不能让残留日志（比如上一步的 ECONNREFUSED 警告）把归因带偏。
   */
  forceCode?: string;
}): DeploymentFailure {
  const text = `${input.phase}\n${input.message}\n${input.logText || ''}`;
  const rule = input.forceCode
    ? RELEASE_RULES.find((candidate) => candidate.code === input.forceCode)
    : RELEASE_RULES.find((candidate) => candidate.pattern.test(text));
  const evidenceRefs = (input.evidenceRefs || []).slice(0, 20);
  if (rule) {
    return {
      code: rule.code,
      owner: rule.owner,
      retryable: rule.retryable,
      summary: sanitizeFailureSummary(input.message),
      phase: input.phase,
      evidenceRefs,
      suggestedAction: rule.suggestedAction,
    };
  }
  const delegated = classifyDeploymentFailure({
    message: `${input.message}\n${input.logText || ''}`.trim(),
    phase: input.phase,
    evidenceRefs,
  });
  return { ...delegated, summary: sanitizeFailureSummary(input.message) };
}

function sanitizeFailureSummary(message: string): string {
  return String(message || '发布失败').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2 * 1024);
}

/** 注入式 SSH 执行请求。把「连哪台、跑什么、何时中止」与「怎么连」解耦，便于回归测试。 */
export interface ReleaseSshExecRequest {
  host: RemoteHost;
  privateKey: string | Buffer;
  passphrase?: string;
  command: string;
  /** 中止信号：执行超时、取消发布、心跳收割都通过它掐断在跑的 SSH。 */
  signal: AbortSignal;
  onOutput(level: 'info' | 'warn', chunk: string): void;
}

export type ReleaseSshExecutor = (req: ReleaseSshExecRequest) => Promise<string>;

export interface ReleaseServiceOptions {
  now?: () => Date;
  /** 发布命令执行超时（毫秒）。缺省读 CDS_RELEASE_EXEC_TIMEOUT_MS，再缺省用常量。 */
  execTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  sshExecutor?: ReleaseSshExecutor;
}

export interface ReleaseCancelResult {
  ok: boolean;
  reason?: string;
}

/** 本进程内在跑的发布执行体。进程一死这张表就没了——正是心跳收割存在的理由。 */
interface ReleaseExecutionHandle {
  controller: AbortController;
  cancelledBy?: string;
}

export class ReleaseService {
  private readonly now: () => Date;
  private readonly execTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly sshExecutor: ReleaseSshExecutor;
  private readonly inFlight = new Map<string, ReleaseExecutionHandle>();

  constructor(private readonly stateService: StateService, options: ReleaseServiceOptions = {}) {
    this.now = options.now || (() => new Date());
    this.execTimeoutMs = resolvePositiveMs(options.execTimeoutMs)
      ?? resolvePositiveMs(Number(process.env.CDS_RELEASE_EXEC_TIMEOUT_MS))
      ?? RELEASE_EXEC_TIMEOUT_MS;
    this.heartbeatIntervalMs = resolvePositiveMs(options.heartbeatIntervalMs) ?? RELEASE_HEARTBEAT_INTERVAL_MS;
    this.sshExecutor = options.sshExecutor || defaultReleaseSshExecutor;
  }

  ensureDefaultPlans(projectId: string): ReleasePlan[] {
    const existing = this.stateService.getReleasePlans(projectId);
    const definitions: Array<Pick<ReleasePlan, 'id' | 'name' | 'template' | 'rollbackStrategy' | 'steps'>> = [
      {
        id: `${projectId}:ssh-script`,
        name: '项目现有脚本发布',
        template: 'ssh-script',
        rollbackStrategy: 'command',
        steps: [
          { id: 'connect', title: '连接目标', kind: 'ssh' },
          { id: 'deploy', title: '执行项目发布命令', kind: 'ssh' },
          { id: 'healthcheck', title: '验证最终入口', kind: 'healthcheck' },
          { id: 'record', title: '记录版本与脚本哈希', kind: 'record' },
        ],
      },
      {
        id: `${projectId}:generated-compose`,
        name: 'CDS 动态 Compose 发布',
        template: 'generated-compose',
        rollbackStrategy: 'previous-release',
        steps: [
          { id: 'connect', title: '连接目标', kind: 'ssh' },
          { id: 'prepare', title: '建立 commit 隔离 worktree', kind: 'ssh' },
          { id: 'deploy', title: '生成并执行 Compose 发布脚本', kind: 'ssh' },
          { id: 'healthcheck', title: '验证最终入口', kind: 'healthcheck' },
          { id: 'record', title: '记录版本与脚本哈希', kind: 'record' },
        ],
      },
      {
        id: `${projectId}:generated-static`,
        name: 'CDS 动态静态站发布',
        template: 'generated-static',
        rollbackStrategy: 'previous-release',
        steps: [
          { id: 'connect', title: '连接目标', kind: 'ssh' },
          { id: 'prepare', title: '建立 commit 隔离 worktree', kind: 'ssh' },
          { id: 'deploy', title: '构建并离线验证静态产物', kind: 'ssh' },
          { id: 'healthcheck', title: '验证页面与入口资源', kind: 'healthcheck' },
          { id: 'record', title: '记录 current、previous 与脚本哈希', kind: 'record' },
        ],
      },
    ];
    for (const definition of definitions) {
      if (existing.some((plan) => plan.id === definition.id)) continue;
      this.stateService.upsertReleasePlan({
        ...definition,
        projectId,
        targetType: 'ssh',
        failureStrategy: 'stop',
        createdAt: new Date().toISOString(),
      });
    }
    return this.stateService.getReleasePlans(projectId);
  }

  async preflight(input: ReleaseStartInput): Promise<ReleasePreflightResult> {
    const checks: ReleasePreflightCheck[] = [];
    const push = (check: ReleasePreflightCheck): void => { checks.push(check); };
    const branch = this.stateService.getBranch(input.branchId);
    const target = this.stateService.getReleaseTarget(input.targetId);
    const projectMismatch = Boolean(branch && target && branch.projectId !== target.projectId);
    const projectId = branch?.projectId || target?.projectId || 'default';
    const strategy = target ? effectiveReleaseStrategy(target) : { mode: 'existing-script' as const, command: '' };
    const planTemplate = strategy.mode === 'existing-script' ? 'ssh-script' : strategy.mode;
    const plan = this.ensureDefaultPlans(projectId).find((item) => item.template === planTemplate);

    if (!branch) {
      push({ id: 'branch', label: '分支存在', status: 'fail', message: `分支不存在: ${input.branchId}`, blocking: true });
    } else if (branch.status !== 'running') {
      push({ id: 'branch', label: '分支部署成功', status: 'fail', message: `当前状态是 ${branch.status}，只允许从成功运行的分支发布`, blocking: true });
    } else {
      push({ id: 'branch', label: '分支部署成功', status: 'pass', message: `${branch.branch} 正在运行`, blocking: false });
    }

    const commitSha = resolveCommitSha(branch);
    if (!commitSha) {
      push({ id: 'commit', label: 'commit 明确', status: 'fail', message: '分支没有 githubCommitSha 或 pinnedCommit', blocking: true });
    } else {
      push({ id: 'commit', label: 'commit 明确', status: 'pass', message: commitSha, blocking: false });
    }

    const previewUrl = input.previewUrl || '';
    if (branch && commitSha && previewUrl) {
      push({ id: 'artifact', label: '可发布产物', status: 'pass', message: 'branch-preview artifact 已就绪', blocking: false });
    } else {
      push({ id: 'artifact', label: '可发布产物', status: 'fail', message: '缺少预览地址或 commit，无法形成 ReleaseArtifact', blocking: true });
    }

    if (!target) {
      push({ id: 'target', label: '发布目标', status: 'fail', message: `目标不存在: ${input.targetId}`, blocking: true });
    } else if (!target.isEnabled) {
      push({ id: 'target', label: '发布目标', status: 'fail', message: `${target.name} 已禁用`, blocking: true });
    } else if (target.type !== 'ssh' || !target.ssh) {
      push({ id: 'target', label: '发布目标', status: 'fail', message: 'MVP 只支持站点发布目标', blocking: true });
    } else if (projectMismatch) {
      push({
        id: 'project-scope',
        label: '项目一致',
        status: 'fail',
        message: `分支属于 ${branch?.projectId || 'default'}，发布目标属于 ${target.projectId || 'default'}，禁止跨项目发布`,
        blocking: true,
      });
    } else if (target.lifecycle === 'archived') {
      push({ id: 'target', label: '发布目标', status: 'fail', message: `${target.name} 已归档，只保留审计记录`, blocking: true });
    } else {
      push({ id: 'target', label: '发布目标', status: 'pass', message: `${target.name} (${target.ssh.user}@${target.ssh.host}:${target.ssh.port})`, blocking: false });
    }

    const project = target ? this.stateService.getProject(target.projectId) : undefined;
    if (target && project) {
      const expectedIdentity = releaseProjectIdentity(project);
      const storedIdentity = target.projectIdentity;
      if (!storedIdentity) {
        push({ id: 'project-identity', label: '项目身份锁定', status: 'warn', message: '历史目标没有项目身份快照，建议重新保存目标以补齐', blocking: false });
      } else if (storedIdentity.projectId !== expectedIdentity.projectId
        || storedIdentity.projectSlug !== expectedIdentity.projectSlug
        || normalizeRepositoryIdentity(storedIdentity.repository) !== normalizeRepositoryIdentity(expectedIdentity.repository)) {
        push({ id: 'project-identity', label: '项目身份锁定', status: 'fail', message: '目标保存的项目身份与当前项目不一致，禁止发布', blocking: true });
      } else {
        push({ id: 'project-identity', label: '项目身份锁定', status: 'pass', message: `${storedIdentity.projectSlug}${storedIdentity.repository ? ` · ${storedIdentity.repository}` : ''}`, blocking: false });
      }
    }

    const canProbeTarget = Boolean(target?.ssh && target.isEnabled && target.lifecycle !== 'archived' && target.type === 'ssh' && !projectMismatch);

    const deployCommand = !projectMismatch && strategy.mode === 'existing-script'
      ? strategy.command?.trim() || target?.ssh?.deployCommand?.trim() || ''
      : '';
    const deployScripts = extractReleaseScriptPaths(deployCommand);
    const previousRelease = target ? this.stateService.getLatestSuccessfulReleaseRun(target.id) : undefined;
    const isFirstManagedRelease = Boolean(
      target?.ssh
      && (isLocalProdReleaseCommand(deployCommand) || strategy.mode !== 'existing-script')
      && !previousRelease,
    );

    const strategyError = validateReleaseStrategy(strategy);
    if (strategyError && !projectMismatch) {
      push({ id: 'deploy-command', label: '发布策略完整', status: 'fail', message: strategyError, blocking: true });
    } else if (!projectMismatch) {
      const strategyMessage = strategy.mode === 'existing-script'
        ? deployCommand
        : strategy.mode === 'generated-compose'
          ? `CDS 将动态生成脚本并执行 ${strategy.composeFile}`
          : `CDS 将动态生成静态发布脚本: ${strategy.buildCommand} → ${strategy.artifactDirectory}`;
      push({ id: 'deploy-command', label: '发布策略完整', status: 'pass', message: strategyMessage, blocking: false });
    }

    if (!projectMismatch && target?.ssh?.healthcheckUrl?.trim()) {
      if (isFirstManagedRelease) {
        const firstReleaseMessage = isLocalProdReleaseCommand(deployCommand)
          ? '首次本机生产发布前跳过上线地址探测，发布后仍会执行健康检查'
          : '首次动态发布前允许上线地址尚未就绪，发布后仍会强制验证最终入口';
        push({
          id: 'healthcheck',
          label: '上线地址可访问',
          status: 'warn',
          message: firstReleaseMessage,
          blocking: false,
        });
      } else if (canProbeTarget) {
        try {
          await probeHealthcheck(target.ssh.healthcheckUrl);
          push({ id: 'healthcheck', label: '上线地址可访问', status: 'pass', message: target.ssh.healthcheckUrl, blocking: false });
        } catch (err) {
          push({ id: 'healthcheck', label: '上线地址可访问', status: 'fail', message: (err as Error).message, blocking: true });
        }
      } else {
        push({ id: 'healthcheck', label: '上线地址可访问', status: 'warn', message: '目标未启用，已跳过健康检查探测', blocking: false });
      }
    } else if (!projectMismatch) {
      push({ id: 'healthcheck', label: '上线地址可访问', status: 'fail', message: '站点发布目标缺少上线地址', blocking: true });
    }

    if (canProbeTarget && target?.ssh?.privateKeyRef) {
      const host = this.stateService.getRemoteHost(target.ssh.privateKeyRef);
      if (!host) {
        push({ id: 'ssh', label: '目标主机可连接', status: 'fail', message: `服务器凭据不存在: ${target.ssh.privateKeyRef}`, blocking: true });
      } else {
        try {
          await this.sshExec(target, 'echo cds-release-connect-ok');
          push({ id: 'ssh', label: '目标主机可连接', status: 'pass', message: `fingerprint=${host.sshPrivateKeyFingerprint}`, blocking: false });
        } catch (err) {
          push({ id: 'ssh', label: '目标主机可连接', status: 'fail', message: (err as Error).message, blocking: true });
        }

        if (checks.some((check) => check.id === 'ssh' && check.status === 'pass')) {
          if (isLocalProdReleaseCommand(deployCommand)) {
            push({
              id: 'remote-repository',
              label: '远端项目身份一致',
              status: 'pass',
              message: 'CDS 内置本机发布按分支产物与项目 ID 锁定，不依赖远端 Git 目录',
              blocking: false,
            });
          } else {
            const expectedRepository = normalizeRepositoryIdentity(project
              ? releaseProjectIdentity(project).repository
              : undefined);
            if (!expectedRepository) {
              push({
                id: 'remote-repository',
                label: '远端项目身份一致',
                status: 'fail',
                message: '项目没有绑定 Git 仓库，无法证明远端发布目录属于当前项目',
                blocking: true,
              });
            } else {
              try {
                const output = await this.sshExec(target, buildRemoteRepositoryCheckCommand(target));
                const remoteRepository = parseRemoteRepositoryIdentity(output);
                if (remoteRepository !== expectedRepository) {
                  push({
                    id: 'remote-repository',
                    label: '远端项目身份一致',
                    status: 'fail',
                    message: `远端仓库 ${remoteRepository || '无法识别'} 与项目仓库 ${expectedRepository} 不一致，禁止发布`,
                    blocking: true,
                  });
                } else {
                  push({
                    id: 'remote-repository',
                    label: '远端项目身份一致',
                    status: 'pass',
                    message: expectedRepository,
                    blocking: false,
                  });
                }
              } catch (err) {
                push({
                  id: 'remote-repository',
                  label: '远端项目身份一致',
                  status: 'fail',
                  message: `远端目录不是可验证的项目 Git 根目录: ${(err as Error).message}`,
                  blocking: true,
                });
              }
            }
          }
          const strategyCheck = buildStrategyPreflightCommand(target);
          if (strategyCheck) {
            try {
              await this.sshExec(target, strategyCheck);
              push({ id: 'scripts', label: '动态发布依赖可用', status: 'pass', message: strategy.mode, blocking: false });
            } catch (err) {
              push({ id: 'scripts', label: '动态发布依赖可用', status: 'fail', message: (err as Error).message, blocking: true });
            }
          } else if (deployScripts.length > 0) {
            try {
              await this.sshExec(target, buildScriptCheckCommand(target, deployScripts));
              push({ id: 'scripts', label: '发布脚本可执行', status: 'pass', message: deployScripts.join('、'), blocking: false });
            } catch (err) {
              push({ id: 'scripts', label: '发布脚本可执行', status: 'fail', message: (err as Error).message, blocking: true });
            }
          } else if (deployCommand) {
            push({ id: 'scripts', label: '发布脚本可执行', status: 'warn', message: '自定义发布命令未识别到 ./script.sh，已跳过脚本文件检查', blocking: false });
          }
        }
      }
    } else if (deployScripts.length > 0 && !target?.ssh?.privateKeyRef && canProbeTarget) {
      push({ id: 'scripts', label: '发布脚本可执行', status: 'fail', message: '站点发布目标缺少服务器凭据，无法检查脚本', blocking: true });
    }

    if (previousRelease) {
      push({ id: 'rollback-version', label: '可回滚版本', status: 'pass', message: `${previousRelease.commitSha.slice(0, 12)} (${previousRelease.releaseId})`, blocking: false });
    } else {
      push({ id: 'rollback-version', label: '可回滚版本', status: 'warn', message: '这是该目标首次发布，成功前没有可回滚版本', blocking: false });
    }

    const artifact = branch && commitSha
      ? buildArtifact(branch, commitSha, previewUrl)
      : undefined;
    return {
      ok: checks.every((check) => !check.blocking || check.status !== 'fail'),
      checks,
      artifact,
      target,
      plan,
      previousRelease,
    };
  }

  async startRelease(input: ReleaseStartInput): Promise<ReleaseRun> {
    const preflight = await this.preflight(input);
    if (!preflight.ok || !preflight.artifact || !preflight.target || !preflight.plan) {
      throw new Error(`发布前检查未通过: ${preflight.checks.filter((c) => c.blocking && c.status === 'fail').map((c) => c.label).join(', ')}`);
    }
    // 并发串行化：同一发布目标已有在途 run（未到终态）时拒绝新发布，避免两个 SSH
    // 部署并发跑互相打架。在途 = 非终态，从 RELEASE_STATUS_TERMINAL 取反推导，
    // 不再手写字面量数组（旧数组里还挂着一个永不出现的 prechecking）。
    //
    // 这道守卫是「卡死」的放大器：执行体随 CDS 重启消失后 run 永远停在 running，
    // 该目标从此发不出去。所以先做一次心跳收割，把已经死掉的 run 收敛掉再判定。
    this.reconcileInterruptedReleases();
    this.assertTargetFree(preflight.target.id, '发布');
    const releaseId = `rel_${crypto.randomBytes(8).toString('hex')}`;
    const startedAt = this.nowIso();
    const run: ReleaseRun = {
      releaseId,
      projectId: preflight.target.projectId,
      branchId: input.branchId,
      commitSha: preflight.artifact.commitSha,
      artifact: preflight.artifact,
      targetId: preflight.target.id,
      planId: preflight.plan.id,
      status: 'queued',
      startedAt,
      heartbeatAt: startedAt,
      operator: input.operator,
      previousReleaseId: preflight.previousRelease?.releaseId,
      logs: [],
      seq: 0,
    };
    const execution = buildReleaseExecution(preflight.target, run);
    run.executionSnapshot = {
      mode: execution.mode,
      scriptSha256: execution.scriptSha256,
      summary: execution.summary,
      strategy: effectiveReleaseStrategy(preflight.target),
    };
    this.stateService.addReleaseRun(run);
    this.emitLog(releaseId, 'info', 'release queued', 'queued');
    void this.execute(releaseId, () => this.runRelease(releaseId), 'failed');
    return this.stateService.getReleaseRun(releaseId)!;
  }

  async startRollback(releaseId: string, operator?: string, targetReleaseId?: string): Promise<ReleaseRun> {
    const current = this.stateService.getReleaseRun(releaseId);
    if (!current) throw new Error(`ReleaseRun not found: ${releaseId}`);
    const target = this.stateService.getReleaseTarget(current.targetId);
    if (!target?.ssh) throw new Error('回滚需要站点发布目标');
    if (target.lifecycle === 'archived') throw new Error(`${target.name} 已归档，禁止回滚`);
    if (!target.isEnabled) throw new Error(`${target.name} 已禁用，禁止回滚`);
    const previous = targetReleaseId
      ? this.stateService.getReleaseRun(targetReleaseId)
      : current.previousReleaseId
        ? this.stateService.getReleaseRun(current.previousReleaseId)
        : this.stateService.getLatestSuccessfulReleaseRun(current.targetId, current.releaseId);
    if (!previous) throw new Error('没有可回滚的上一版本');
    if (previous.targetId !== current.targetId) throw new Error('回滚目标版本不属于当前发布目标');
    if (!['success', 'rollback_success'].includes(previous.status)) throw new Error('只能回滚到成功版本');

    // 回滚同样是往目标机器跑 SSH 写操作，必须过与发布同一道并发闸：
    // 此前这里一道闸都没有，取消后紧接着回滚会和尚未退出的老执行体并发写
    // （Codex PR #1273 P1）。先收一轮心跳过期的僵尸 run，免得闸门被死 run 卡住。
    this.reconcileInterruptedReleases();
    this.assertTargetFree(current.targetId, '回滚');

    const rollbackId = `rel_${crypto.randomBytes(8).toString('hex')}`;
    const rollbackStartedAt = this.nowIso();
    const run: ReleaseRun = {
      releaseId: rollbackId,
      projectId: current.projectId,
      branchId: previous.branchId,
      commitSha: previous.commitSha,
      artifact: previous.artifact,
      targetId: current.targetId,
      planId: current.planId,
      status: 'rollback_running',
      startedAt: rollbackStartedAt,
      heartbeatAt: rollbackStartedAt,
      operator,
      previousReleaseId: current.releaseId,
      rollbackOf: current.releaseId,
      rollbackTargetReleaseId: previous.releaseId,
      logs: [],
      seq: 0,
    };
    const rollbackStrategy = previous.executionSnapshot?.strategy || effectiveReleaseStrategy(target);
    const rollbackExecution = buildReleaseExecution({ ...target, strategy: rollbackStrategy }, run);
    run.executionSnapshot = {
      mode: rollbackExecution.mode,
      scriptSha256: rollbackExecution.scriptSha256,
      summary: `回滚到 ${previous.releaseId}: ${rollbackExecution.summary}`,
      strategy: rollbackStrategy,
    };
    this.stateService.addReleaseRun(run);
    const strategy = shouldUseCustomRollbackCommand(rollbackExecution.mode, target.ssh.rollbackCommand)
      ? 'rollbackCommand'
      : '重新发布历史版本';
    this.emitLog(rollbackId, 'info', `rollback queued to ${previous.releaseId} via ${strategy}`, 'rollback');
    void this.execute(rollbackId, () => this.runRollback(rollbackId, target, previous), 'rollback_failed');
    return this.stateService.getReleaseRun(rollbackId)!;
  }

  /**
   * 取消一次在途发布：终态化 run、尽力中止在跑的 SSH、释放在途守卫。
   *
   * 终态选 failed（回滚 run 选 rollback_failed）而不是新增一个 cancelled 状态：
   * ReleaseRun 的状态枚举被前端与统计口径直接消费，阶段一是止血不是改架构，
   * 新增状态会把涟漪扩散到 UI；「被取消」这件事由结构化失败的
   * code=release.cancelled 承载，信息一点没丢。
   *
   * 幂等：run 已是终态时不抛异常、不改状态，直接返回 ok。
   */
  cancelRelease(releaseId: string, actor: string): ReleaseCancelResult {
    const run = this.stateService.getReleaseRun(releaseId);
    if (!run) return { ok: false, reason: `ReleaseRun not found: ${releaseId}` };
    const operator = String(actor || '').trim() || 'unknown';
    const message = `发布已被 ${operator} 取消`;
    const handle = this.inFlight.get(releaseId);
    if (handle) {
      handle.cancelledBy = operator;
      handle.controller.abort(new Error(message));
      // 关键：**不**在这里摘牌。abort 只是「请你停」，不是「你已经停了」——
      // 最终入口探测（probeReleaseSurface）是普通 HTTP 请求，不接 abort 信号，
      // 取消时它还在飞。若此刻就摘牌 + 把 run 打成终态，在途守卫会认为该目标空闲，
      // 下一次发布立刻放行；等那个老探测最终失败，runRelease 仍会走
      // restorePreviousAfterFailedProbe，用 SSH 把「上一版本」推上去，
      // 正好覆盖掉刚开始的新发布（Codex PR #1273 P1）。
      // 摘牌统一交给 execute() 的 finally——执行体真的退出了才算释放。
    }
    if (isReleaseRunTerminal(run.status)) return { ok: true };
    this.emitLog(releaseId, 'warn', message, 'cancel');
    this.patchStatus(releaseId, run.status === 'rollback_running' ? 'rollback_failed' : 'failed', {
      errorMessage: message,
      failure: this.buildFailure(releaseId, message, 'cancel', 'release.cancelled'),
    });
    return { ok: true };
  }

  /**
   * 中断收敛：心跳过期的非终态 run 收敛为失败，并释放在途守卫。
   *
   * 这是阶段一最重要的一件事——CDS 自更新是日常操作，`void this.runRelease(...)`
   * 的执行体随进程消失后，run 永远停在 running，在途守卫会拒绝该目标的一切新发布，
   * 而此前既没有超时也没有取消，这个发布目标只能改库才能复活。
   * 启动时与周期收割都调它（照抄 deployment-run.ts::reconcileInterrupted 的范式），
   * 但两者的判据**不同**，见 `assumeAllOrphaned`。
   *
   * @param options.assumeAllOrphaned 启动收敛专用。进程刚起来时本进程不可能持有
   *   任何执行体，所以**每一条**持久化的非终态 run 都已经没有人能推进它——心跳
   *   新鲜与否毫无意义（那个心跳是上一个已经死掉的进程打的）。若仍按 15 分钟阈值
   *   放过，刚打过心跳就被重启的发布会继续堵住它的目标至少 15 分钟、最坏还要再等
   *   一轮周期收割（Codex PR #1273 P1）。周期收割则必须保留心跳阈值，否则会把正在
   *   正常执行的发布误杀。
   */
  reconcileInterruptedReleases(
    now = this.now(),
    options: { assumeAllOrphaned?: boolean } = {},
  ): { reconciled: number } {
    const nowMs = now.getTime();
    const assumeAllOrphaned = options.assumeAllOrphaned === true;
    let reconciled = 0;
    for (const run of this.stateService.getReleaseRuns()) {
      if (isReleaseRunTerminal(run.status)) continue;
      // 本进程正握着执行体的 run 永远不收：它活着，正在推进。
      // （启动收敛时这个表必然是空的，所以这条判断只在周期收割生效。）
      if (this.inFlight.has(run.releaseId)) continue;
      if (!assumeAllOrphaned) {
        const beat = Date.parse(run.heartbeatAt || run.startedAt || '');
        // 心跳字段缺失（存量 run）时 Date.parse 得到 NaN，一律按已过期处理：
        // 存量在途 run 本来就是这次要清理掉的那批。
        if (Number.isFinite(beat) && nowMs - beat < RELEASE_HEARTBEAT_STALE_MS) continue;
      }
      const message = assumeAllOrphaned
        ? 'CDS 已重启，本次发布的执行体随上一个进程消失，已收敛为失败（发布目标已释放，可重试）'
        : '发布执行心跳已过期，CDS 重启导致执行体丢失，本次发布已收敛为失败';
      try {
        // 本进程可能还挂着一个心跳已停但 SSH 仍连着的执行体，一并中止。
        const handle = this.inFlight.get(run.releaseId);
        if (handle) {
          handle.controller.abort(new Error(message));
          this.inFlight.delete(run.releaseId);
        }
        // 日志是装饰，解锁才是目的：写日志失败绝不能挡住下面的状态收敛，否则
        // 一次日志异常就让这个发布目标继续被永久锁死（收割器是最后一道闸）。
        try {
          this.emitLog(run.releaseId, 'error', message, 'reconcile');
        } catch (logErr) {
          console.warn(`[release] ${run.releaseId} 收敛日志写入失败（不影响收敛）: ${(logErr as Error).message}`);
        }
        const nextStatus: ReleaseRunStatus = run.status === 'rollback_running' ? 'rollback_failed' : 'failed';
        const patch: Partial<ReleaseRun> = {
          errorMessage: message,
          failure: this.buildFailure(run.releaseId, message, 'reconcile', 'release.interrupted'),
        };
        if (canTransitionReleaseRun(run.status, nextStatus)) {
          this.patchStatus(run.releaseId, nextStatus, patch);
        } else {
          // 存量 / 未登记状态（历史上的 prechecking 之类）没有合法转移边。收割器是
          // 「目标被永久锁死」的最后一道闸，绝不能因为一条状态怪异的记录就放弃 ——
          // 直接终态化并留下告警，宁可绕过状态机也不让目标发不出去。
          console.warn(`[release] ${run.releaseId} 状态 ${run.status} 无合法转移边，收割器强制终态化`);
          const forced = this.stateService.patchReleaseRun(run.releaseId, {
            ...patch,
            status: nextStatus,
            heartbeatAt: this.nowIso(),
            finishedAt: this.nowIso(),
          });
          releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId: run.releaseId, run: forced } });
        }
        reconciled += 1;
      } catch (err) {
        // 单条收敛失败不能中断整轮收割，否则一条坏记录会把所有目标一起锁死。
        console.warn(`[release] 收敛 ${run.releaseId} 失败: ${(err as Error).message}`);
      }
    }
    return { reconciled };
  }

  /**
   * 统一的执行体包装：登记在途句柄（供取消/收割中止）、兜住异常、结束后摘牌。
   * 句柄必须在返回调用方之前**同步**登记，否则「点了发布立刻点取消」会取消不掉。
   */
  /**
   * 同一发布目标的并发闸（**唯一判定源**）。startRelease 与 startRollback 必须都走它：
   * 两者都会对同一台机器跑 SSH 写操作，只挡住一边等于没挡——上一轮给 startRelease
   * 加了 settling 判定却漏了回滚，取消后紧接着的回滚仍能和没退出的老执行体并发写，
   * 最终线上留下的是「谁后跑完」的那个版本（Codex PR #1273 P1）。
   *
   * 两层都要查：
   *   - run 状态非终态 = 明面上还在跑；
   *   - 执行体未退出 = run 已终态（比如刚被取消）但 SSH/探测还在飞。
   */
  private assertTargetFree(targetId: string, action: '发布' | '回滚'): void {
    const inFlight = this.stateService
      .getReleaseRuns({ targetId })
      .find((r) => isReleaseRunInFlight(r));
    if (inFlight) {
      throw new Error(`该发布目标已有进行中的发布（${inFlight.releaseId}，状态 ${inFlight.status}），请等待其完成后再发起${action}`);
    }
    const settling = this.findSettlingExecution(targetId);
    if (settling) {
      throw new Error(`该发布目标上一次发布（${settling}）已停止但执行体尚未退出，请稍候再发起${action}`);
    }
  }

  /** 该发布目标上是否还有「已终态但执行体没退出」的 run；有则返回它的 releaseId。 */
  private findSettlingExecution(targetId: string): string | undefined {
    for (const releaseId of this.inFlight.keys()) {
      const run = this.stateService.getReleaseRun(releaseId);
      if (run?.targetId === targetId) return releaseId;
    }
    return undefined;
  }

  /** 这次发布是否已被取消（handle 还在、但已 abort）。自动恢复等副作用必须先问它。 */
  private isCancelled(releaseId: string): boolean {
    const handle = this.inFlight.get(releaseId);
    return handle ? handle.controller.signal.aborted : false;
  }

  private execute(
    releaseId: string,
    fn: () => Promise<void>,
    failStatus: ReleaseRunStatus,
  ): Promise<void> {
    const handle: ReleaseExecutionHandle = { controller: new AbortController() };
    this.inFlight.set(releaseId, handle);
    return fn()
      .catch((err) => {
        // 收尾本身再抛就会变成 unhandled rejection（调用方是 void 调用），
        // 足以拖垮整个 CDS 进程。这里必须吞掉并记录。
        try {
          this.failRun(releaseId, err, failStatus);
        } catch (failErr) {
          console.warn(`[release] ${releaseId} 失败收尾异常: ${errorText(failErr)}`);
        }
      })
      .finally(() => {
        if (this.inFlight.get(releaseId) === handle) this.inFlight.delete(releaseId);
      });
  }

  private async runRelease(releaseId: string): Promise<void> {
    const run = this.stateService.getReleaseRun(releaseId);
    if (!run) throw new Error(`ReleaseRun not found: ${releaseId}`);
    const target = this.stateService.getReleaseTarget(run.targetId);
    if (!target?.ssh) throw new Error('SSH target not found');
    this.patchStatus(releaseId, 'running');
    this.emitLog(releaseId, 'info', `连接目标 ${target.ssh.user}@${target.ssh.host}:${target.ssh.port}`, 'connect');
    await this.sshExec(target, 'echo cds-release-connect-ok', releaseId, 'connect');
    this.emitLog(releaseId, 'info', `进入站点目录 ${target.ssh.appPath || '.'}`, 'prepare');
    const executionTarget = run.executionSnapshot?.strategy ? { ...target, strategy: run.executionSnapshot.strategy } : target;
    const execution = buildReleaseExecution(executionTarget, run);
    if (run.executionSnapshot && execution.scriptSha256 !== run.executionSnapshot.scriptSha256) {
      throw new Error('发布执行脚本与预检快照不一致，已拒绝执行');
    }
    this.emitLog(releaseId, 'info', `${execution.summary} · sha256=${execution.scriptSha256}`, 'plan');
    await this.runDeployCommand(releaseId, executionTarget, run, execution.command);
    this.patchStatus(releaseId, 'healthchecking');
    this.emitLog(releaseId, 'info', `健康检查 ${target.ssh.healthcheckUrl}`, 'healthcheck');
    try {
      await probeReleaseSurface(target.ssh.healthcheckUrl, execution.mode);
    } catch (err) {
      await this.restorePreviousAfterFailedProbe(releaseId, target, run, err);
      throw err;
    }
    this.emitLog(releaseId, 'info', '标记成功', 'record');
    this.patchStatus(releaseId, 'success');
  }

  private async runRollback(releaseId: string, target: ReleaseTarget, previous: ReleaseRun): Promise<void> {
    const ssh = target.ssh;
    if (!ssh) throw new Error('回滚需要站点发布目标');
    const rollbackRun = this.stateService.getReleaseRun(releaseId);
    if (!rollbackRun) throw new Error(`ReleaseRun not found: ${releaseId}`);
    const rollbackCommand = ssh.rollbackCommand?.trim();
    const rollbackMode = rollbackRun.executionSnapshot?.mode || effectiveReleaseStrategy(target).mode;
    if (shouldUseCustomRollbackCommand(rollbackMode, rollbackCommand)) {
      this.emitLog(releaseId, 'info', `执行回滚命令，目标版本 ${previous.releaseId}`, 'rollback');
      await this.sshExec(target, buildReleaseCommand(target, rollbackRun, rollbackCommand), releaseId, 'rollback');
    } else {
      const executionTarget = rollbackRun.executionSnapshot?.strategy
        ? { ...target, strategy: rollbackRun.executionSnapshot.strategy }
        : target;
      const execution = buildReleaseExecution(executionTarget, rollbackRun);
      this.emitLog(releaseId, 'info', `重新发布历史成功版本 ${previous.releaseId}`, 'rollback');
      await this.runDeployCommand(releaseId, executionTarget, rollbackRun, execution.command);
    }
    this.emitLog(releaseId, 'info', `健康检查 ${ssh.healthcheckUrl}`, 'healthcheck');
    await probeReleaseSurface(ssh.healthcheckUrl, rollbackMode);
    this.emitLog(releaseId, 'info', '回滚成功', 'record');
    this.patchStatus(releaseId, 'rollback_success');
  }

  /**
   * 失败终态化。两条纪律：
   *  1. 幂等——run 已终态（被取消 / 被收割）时直接返回，不抛异常。否则取消一次发布
   *     会紧接着触发执行体的 abort 异常，再次进入这里就会因非法转移把错误抛进
   *     Promise catch 之外，变成 unhandled rejection。
   *  2. 结构化——写 failure（code / owner / retryable / evidenceRefs / suggestedAction），
   *     errorMessage 只作人类可读摘要保留。
   */
  private failRun(releaseId: string, err: unknown, status: ReleaseRunStatus = 'failed'): void {
    const run = this.stateService.getReleaseRun(releaseId);
    if (!run || isReleaseRunTerminal(run.status)) return;
    const message = errorText(err);
    const phase = run.logs[run.logs.length - 1]?.phase || 'error';
    this.emitLog(releaseId, 'error', message, 'error');
    const nextStatus = canTransitionReleaseRun(run.status, status)
      ? status
      : (run.status === 'rollback_running' ? 'rollback_failed' : 'failed');
    this.patchStatus(releaseId, nextStatus, {
      errorMessage: message,
      failure: this.buildFailure(releaseId, message, phase),
    });
  }

  /** 结构化失败事实。证据引用指向本次 run 与它最后几条错误日志。 */
  private buildFailure(releaseId: string, message: string, phase: string, forceCode?: string): DeploymentFailure {
    const run = this.stateService.getReleaseRun(releaseId);
    const errorLogs = (run?.logs || []).filter((log) => log.level === 'error' || log.level === 'warn').slice(-10);
    return classifyReleaseFailure({
      message,
      phase,
      forceCode,
      logText: errorLogs.map((log) => `${log.phase || ''} ${log.message}`).join('\n'),
      evidenceRefs: [
        `release-run:${releaseId}`,
        ...errorLogs.map((log) => `release-run:${releaseId}:log:${log.seq}`),
      ],
    });
  }

  private async restorePreviousAfterFailedProbe(
    releaseId: string,
    target: ReleaseTarget,
    failedRun: ReleaseRun,
    probeError: unknown,
  ): Promise<void> {
    // 已取消就不要再往目标机器上写任何东西。取消之后的自动恢复是纯粹的越权副作用：
    // 用户已经喊停，它却把「上一版本」SSH 推上去，可能正好盖掉别人刚发的新版本
    // （Codex PR #1273 P1）。
    if (this.isCancelled(releaseId)) {
      this.emitLog(releaseId, 'warn', '发布已被取消，跳过自动恢复（不再对目标机器做任何写操作）', 'auto-restore');
      return;
    }
    if (failedRun.executionSnapshot?.mode === 'existing-script' || !failedRun.previousReleaseId) return;
    const previous = this.stateService.getReleaseRun(failedRun.previousReleaseId);
    if (!previous) return;
    const strategy = previous.executionSnapshot?.strategy || failedRun.executionSnapshot?.strategy;
    if (!strategy) return;
    const restoreRun: ReleaseRun = {
      ...previous,
      releaseId: `${releaseId}-auto-restore`,
      previousReleaseId: failedRun.releaseId,
      rollbackOf: failedRun.releaseId,
      logs: [],
      seq: 0,
      startedAt: new Date().toISOString(),
      executionSnapshot: previous.executionSnapshot,
    };
    const executionTarget = { ...target, strategy };
    const execution = buildReleaseExecution(executionTarget, restoreRun, { preservePrevious: true });
    this.emitLog(releaseId, 'warn', `最终入口探测失败，正在自动恢复 ${previous.releaseId}: ${(probeError as Error).message}`, 'auto-restore');
    try {
      await this.runDeployCommand(releaseId, executionTarget, restoreRun, execution.command);
      await probeReleaseSurface(target.ssh!.healthcheckUrl, execution.mode);
      this.emitLog(releaseId, 'warn', `已恢复上一成功版本 ${previous.releaseId}`, 'auto-restore');
    } catch (restoreError) {
      this.emitLog(releaseId, 'error', `自动恢复失败: ${(restoreError as Error).message}`, 'auto-restore');
      throw new Error(`最终入口探测失败，且自动恢复失败: ${(restoreError as Error).message}`);
    }
  }

  /**
   * 唯一的状态写入口。所有状态变更都必须经过它，才能保证转移合法性断言不被绕过
   * （旧代码有三处直接 patchReleaseRun 写 status，等于状态机没有守卫）。
   */
  private patchStatus(
    releaseId: string,
    status: ReleaseRunStatus,
    extra: Partial<ReleaseRun> = {},
  ): ReleaseRun {
    const current = this.stateService.getReleaseRun(releaseId);
    if (!current) throw new Error(`ReleaseRun not found: ${releaseId}`);
    assertReleaseRunTransition(current.status, status);
    const at = this.nowIso();
    const run = this.stateService.patchReleaseRun(releaseId, {
      ...extra,
      status,
      heartbeatAt: at,
      ...(isReleaseRunTerminal(status) ? { finishedAt: extra.finishedAt || at } : {}),
    });
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId, run } });
    return run;
  }

  /**
   * 心跳打点。SSH 长静默阶段由 sshExec 的定时器周期调用；失败绝不打断发布执行
   * （心跳只是收割器的输入，写不进去最坏结果是被收割，不该反过来炸掉发布本身）。
   */
  private touchHeartbeat(releaseId: string): void {
    try {
      const run = this.stateService.getReleaseRun(releaseId);
      if (!run || isReleaseRunTerminal(run.status)) return;
      this.stateService.patchReleaseRun(releaseId, { heartbeatAt: this.nowIso() });
    } catch {
      /* 心跳写失败不影响发布执行 */
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async runDeployCommand(releaseId: string, target: ReleaseTarget, run: ReleaseRun, rawCommand: string): Promise<void> {
    const scripts = extractReleaseScriptPaths(rawCommand);
    if (isDefaultScriptChain(rawCommand, scripts)) {
      for (const script of scripts) {
        const phase = releaseScriptPhase(script);
        this.emitLog(releaseId, 'info', `执行 ${script}`, phase);
        try {
          await this.sshExec(target, buildReleaseCommand(target, run, script), releaseId, phase);
        } catch (err) {
          this.emitLog(releaseId, 'error', `脚本 ${script} 执行失败: ${(err as Error).message}`, phase);
          throw err;
        }
      }
      return;
    }
    this.emitLog(releaseId, 'info', '执行发布命令', 'deploy');
    await this.sshExec(target, buildReleaseCommand(target, run, rawCommand), releaseId, 'deploy');
  }

  private emitLog(releaseId: string, level: 'info' | 'warn' | 'error', message: string, phase?: string): void {
    const run = this.stateService.appendReleaseRunLog(releaseId, { level, message: maskLog(message), phase });
    const log = run.logs[run.logs.length - 1];
    releaseEvents.emitEvent({ type: 'release.log', payload: { releaseId, log } });
  }

  /**
   * 执行一条远端命令。
   *
   * 三件止血在这里合流：
   *  - **执行超时**：ssh2 的 readyTimeout 只覆盖握手；远端脚本挂住时流永不 close，
   *    run 永不终态，目标被永久锁死。这里给命令本身加执行超时，超时即中止并判失败。
   *  - **可取消**：与本次 run 的在途句柄联动，cancelRelease / 心跳收割能掐断在跑的 SSH。
   *  - **心跳**：命令执行期是最长的静默段，必须周期打点，否则收割器误杀慢发布。
   */
  private async sshExec(target: ReleaseTarget, cmd: string, releaseId?: string, logPhase = 'ssh'): Promise<string> {
    if (!target.ssh) throw new Error('target is not SSH');
    const keyHost = this.stateService.getRemoteHost(target.ssh.privateKeyRef);
    if (!keyHost) throw new Error(`privateKeyRef not found: ${target.ssh.privateKeyRef}`);
    const host: RemoteHost = {
      ...keyHost,
      host: target.ssh.host,
      sshPort: target.ssh.port,
      sshUser: target.ssh.user,
    };
    const { privateKey, passphrase } = decryptRemoteHostSecrets(host);

    // 预检类探测跑在 HTTP 请求生命周期里，用短超时；发布命令用长超时。
    const timeoutMs = releaseId ? this.execTimeoutMs : RELEASE_PREFLIGHT_EXEC_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = global.setTimeout(
      () => controller.abort(new Error(`发布命令执行超时（${timeoutMs}ms 内未结束），已中止 SSH 执行`)),
      timeoutMs,
    );
    const runHandle = releaseId ? this.inFlight.get(releaseId) : undefined;
    const onRunAbort = () => controller.abort(runHandle?.controller.signal.reason);
    if (runHandle) {
      if (runHandle.controller.signal.aborted) onRunAbort();
      else runHandle.controller.signal.addEventListener('abort', onRunAbort, { once: true });
    }
    const heartbeat = releaseId
      ? global.setInterval(() => this.touchHeartbeat(releaseId), this.heartbeatIntervalMs)
      : undefined;
    heartbeat?.unref?.();

    try {
      return await this.sshExecutor({
        host,
        privateKey,
        passphrase,
        command: cmd,
        signal: controller.signal,
        onOutput: (level, chunk) => {
          if (!releaseId) return;
          for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
            this.emitLog(releaseId, level, line.slice(0, 1000), logPhase);
          }
        },
      });
    } finally {
      global.clearTimeout(timer);
      if (heartbeat) global.clearInterval(heartbeat);
      runHandle?.controller.signal.removeEventListener('abort', onRunAbort);
    }
  }
}

/** 默认 SSH 执行实现（ssh2）。中止信号一到就断连接并以中止原因 reject。 */
export const defaultReleaseSshExecutor: ReleaseSshExecutor = async (req) => {
  const ssh2Mod = await loadSsh2();
  const client = new ssh2Mod.Client() as unknown as Ssh2Client;
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.signal.removeEventListener('abort', onAbort);
      try { client.end(); } catch { /* ignore */ }
      fn();
    };
    function onAbort(): void {
      settle(() => reject(abortReasonError(req.signal)));
    }
    if (req.signal.aborted) return onAbort();
    req.signal.addEventListener('abort', onAbort, { once: true });

    const append = (level: 'info' | 'warn', chunk: unknown) => {
      const text = String(chunk);
      if (level === 'info') stdout += text;
      else stderr += text;
      req.onOutput(level, text);
    };

    client.on('ready', () => {
      client.exec(req.command, (err, stream) => {
        if (err) return settle(() => reject(err));
        stream.on('data', (chunk) => append('info', chunk));
        stream.stderr.on('data', (chunk) => append('warn', chunk));
        stream.on('close', (code: unknown) => {
          const exitCode = typeof code === 'number' ? code : 0;
          if (exitCode === 0) return settle(() => resolve(stdout));
          settle(() => reject(new Error(`ssh exec exit=${exitCode} stderr=${stderr.slice(0, 500)}`)));
        });
      });
    });
    client.on('error', (err) => settle(() => reject(err as Error)));
    client.connect({
      host: req.host.host,
      port: req.host.sshPort,
      username: req.host.sshUser,
      privateKey: req.privateKey,
      passphrase: req.passphrase,
      readyTimeout: 10_000,
    });
  });
};

function abortReasonError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(reason ? String(reason) : '发布执行已被中止');
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function resolvePositiveMs(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value as number) > 0 ? Number(value) : undefined;
}

function resolveCommitSha(branch?: BranchEntry): string {
  return branch?.pinnedCommit || branch?.githubCommitSha || '';
}

function buildArtifact(branch: BranchEntry, commitSha: string, previewUrl: string): ReleaseArtifact {
  return {
    type: 'branch-preview',
    commitSha,
    branchId: branch.id,
    branchName: branch.branch,
    previewUrl,
    artifactPath: branch.worktreePath,
  };
}

const RELEASE_SCRIPT_PATH_RE = /(?:\.\/|\/)[A-Za-z0-9._/@+-]+\.sh/g;

export function extractReleaseScriptPaths(rawCommand: string): string[] {
  const matches = rawCommand.match(RELEASE_SCRIPT_PATH_RE) || [];
  return Array.from(new Set(matches));
}

export function isDefaultScriptChain(rawCommand: string, scripts = extractReleaseScriptPaths(rawCommand)): boolean {
  return rawCommand.replace(/\s+/g, ' ').trim() === './fast.sh && ./exec_dep.sh'
    && scripts.length === 2
    && scripts[0] === './fast.sh'
    && scripts[1] === './exec_dep.sh';
}

export function isLocalProdReleaseCommand(rawCommand: string): boolean {
  return extractReleaseScriptPaths(rawCommand)
    .some((script) => script.endsWith('/local-prod-release.sh') || script === './local-prod-release.sh');
}

export function shouldUseCustomRollbackCommand(
  mode: ReleaseExecutionMode,
  rollbackCommand: string | undefined,
): rollbackCommand is string {
  return mode === 'existing-script' && Boolean(rollbackCommand?.trim());
}

export function buildScriptCheckCommand(target: ReleaseTarget, scripts: string[]): string {
  if (!target.ssh) throw new Error('target is not SSH');
  const uniqueScripts = Array.from(new Set(scripts));
  if (uniqueScripts.length === 0) {
    return `cd ${shellQuote(target.ssh.appPath || '.')} && true`;
  }
  const renderedScripts = uniqueScripts.map((script) => shellQuote(script)).join(' ');
  if (uniqueScripts.some((script) => script.endsWith('/local-prod-release.sh') || script === './local-prod-release.sh')) {
    return `for f in ${renderedScripts}; do test -f "$f" || { echo "missing script: $f"; exit 41; }; test -x "$f" || { echo "script is not executable: $f"; exit 42; }; done`;
  }
  return `cd ${shellQuote(target.ssh.appPath || '.')} && for f in ${renderedScripts}; do test -f "$f" || { echo "missing script: $f"; exit 41; }; test -x "$f" || { echo "script is not executable: $f"; exit 42; }; done`;
}

export function buildRemoteRepositoryCheckCommand(target: ReleaseTarget): string {
  if (!target.ssh) throw new Error('target is not SSH');
  const appPath = shellQuote(target.ssh.appPath || '.');
  return `cd ${appPath} && test "$(git rev-parse --show-toplevel)" = "$(pwd -P)" && printf 'CDS_REPO_ORIGIN=%s\\n' "$(git remote get-url origin)"`;
}

export function parseRemoteRepositoryIdentity(output: string): string {
  const line = output.split(/\r?\n/).find((item) => item.startsWith('CDS_REPO_ORIGIN='));
  return normalizeRepositoryIdentity(line?.slice('CDS_REPO_ORIGIN='.length));
}

export function releaseScriptPhase(script: string): string {
  return `script:${script.replace(/^\.\//, '').replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export function buildReleaseCommand(target: ReleaseTarget, run: ReleaseRun, rawCommand: string, releaseIdOverride?: string): string {
  const ssh = target.ssh!;
  const env: Record<string, string> = {
    CDS_PROJECT_ID: run.projectId,
    CDS_BRANCH_ID: run.branchId,
    CDS_TARGET_ID: run.targetId,
    CDS_PLAN_ID: run.planId,
    CDS_COMMIT_SHA: run.commitSha,
    CDS_RELEASE_ID: releaseIdOverride || run.releaseId,
    CDS_BRANCH_NAME: run.artifact.branchName || '',
    CDS_PREVIEW_URL: run.artifact.previewUrl || '',
    CDS_IMAGE_DIGEST: run.artifact.imageDigest || '',
    CDS_ARTIFACT_PATH: run.artifact.artifactPath || '',
    CDS_PREVIOUS_RELEASE_ID: run.previousReleaseId || '',
    CDS_ROLLBACK_OF: run.rollbackOf || '',
  };
  const renderedEnv = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const appPath = ssh.appPath || '.';
  if (isLocalProdReleaseCommand(rawCommand) && appPath !== '.') {
    return `mkdir -p ${shellQuote(appPath)} && cd ${shellQuote(appPath)} && export ${renderedEnv} && ${rawCommand}`;
  }
  return `cd ${shellQuote(ssh.appPath || '.')} && export ${renderedEnv} && ${rawCommand}`;
}

async function probeHealthcheck(url: string, timeoutMs = 8_000): Promise<void> {
  const result = await probeHealthcheckStatus(url, timeoutMs);
  if (result.status !== 'healthy') throw new Error(result.message || 'healthcheck failed');
}

export async function probeReleaseSurface(
  healthcheckUrl: string,
  mode: ReleaseExecutionMode,
  timeoutMs = 8_000,
): Promise<void> {
  await probeHealthcheck(healthcheckUrl, timeoutMs);
  if (mode === 'generated-static') {
    await probeStaticSiteSurface(healthcheckUrl, timeoutMs);
  }
}

export async function probeStaticSiteSurface(healthcheckUrl: string, timeoutMs = 8_000): Promise<void> {
  let surfaceUrl: URL;
  try {
    surfaceUrl = new URL('/', healthcheckUrl);
  } catch {
    throw new Error('healthcheckUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(surfaceUrl.protocol)) {
    throw new Error('healthcheckUrl must be http or https');
  }

  const htmlResponse = await fetchSurfaceResource(surfaceUrl, timeoutMs, 'static surface root');
  const htmlType = htmlResponse.contentType;
  if (!htmlType.includes('text/html') && !htmlType.includes('application/xhtml+xml')) {
    throw new Error(`static surface root has non-HTML content-type: ${htmlType || 'missing'}`);
  }
  const html = Buffer.from(htmlResponse.body).toString('utf8');
  const refs = Array.from(html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/gi))
    .map((match) => match[1]);
  if (refs.length === 0) throw new Error('static surface root has no JS/CSS entry reference');

  const sameOriginEntries = refs
    .map((ref) => new URL(ref, surfaceUrl))
    .filter((entry) => entry.origin === surfaceUrl.origin);
  if (sameOriginEntries.length === 0) {
    throw new Error('static surface root has no same-origin JS/CSS entry reference');
  }

  for (const entry of sameOriginEntries) {
    const response = await fetchSurfaceResource(entry, timeoutMs, `static entry ${entry.pathname}`);
    const contentType = response.contentType;
    const isCss = entry.pathname.toLowerCase().endsWith('.css');
    const mimeOk = isCss
      ? contentType.includes('text/css')
      : contentType.includes('javascript');
    if (!mimeOk) {
      throw new Error(`static entry ${entry.pathname} has invalid content-type: ${contentType || 'missing'}`);
    }
    if (response.body.byteLength === 0) throw new Error(`static entry ${entry.pathname} is empty`);
  }
}

async function fetchSurfaceResource(
  url: URL,
  timeoutMs: number,
  label: string,
): Promise<{ contentType: string; body: ArrayBuffer }> {
  const ctrl = new AbortController();
  const timer = global.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    return {
      contentType: response.headers.get('content-type')?.toLowerCase() || '',
      body,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`${label} timeout after ${timeoutMs}ms`);
    throw err;
  } finally {
    global.clearTimeout(timer);
  }
}

export async function probeHealthcheckStatus(url: string, timeoutMs = 8_000): Promise<ReleaseHealthProbe> {
  const checkedAt = new Date().toISOString();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'failed', url, checkedAt, message: 'healthcheckUrl must be a valid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { status: 'failed', url, checkedAt, message: 'healthcheckUrl must be http or https' };
  }
  const ctrl = new AbortController();
  const started = Date.now();
  const timer = global.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    await res.arrayBuffer().catch(() => undefined);
    const responseTimeMs = Date.now() - started;
    if (!res.ok) return { status: 'failed', url, checkedAt, responseTimeMs, message: `healthcheck HTTP ${res.status}` };
    return { status: 'healthy', url, checkedAt, responseTimeMs };
  } catch (err) {
    return {
      status: 'failed',
      url,
      checkedAt,
      responseTimeMs: Date.now() - started,
      message: (err as Error).name === 'AbortError' ? `healthcheck timeout after ${timeoutMs}ms` : (err as Error).message,
    };
  } finally {
    global.clearTimeout(timer);
  }
}

function maskLog(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, '***PRIVATE_KEY***')
    .replace(/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY)=([^\s]+)/gi, '$1=***');
}

async function loadSsh2(): Promise<{ Client: new () => unknown }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('ssh2').catch((err) => {
    throw new Error(`ssh2 module not available: ${(err as Error).message}`);
  });
  return { Client: mod.Client || mod.default?.Client };
}
