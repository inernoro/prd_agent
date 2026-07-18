import crypto from 'node:crypto';
import type { StateService } from './state.js';
import type { BranchEntry, ReleaseArtifact, ReleaseExecutionMode, ReleasePlan, ReleaseRun, ReleaseTarget, RemoteHost } from '../types.js';
import { decryptRemoteHostSecrets } from './sidecar/remote-host-service.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';
import { releaseEvents } from './release-events.js';
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

export class ReleaseService {
  constructor(private readonly stateService: StateService) {}

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
    // 部署并发跑互相打架。终态为 success/failed/rollback_success/rollback_failed；
    // 其余（queued/prechecking/running/healthchecking/rollback_running）均视为在途。
    const inFlightStatuses: ReleaseRun['status'][] = [
      'queued', 'prechecking', 'running', 'healthchecking', 'rollback_running',
    ];
    const inFlight = this.stateService
      .getReleaseRuns({ targetId: preflight.target.id })
      .find((r) => inFlightStatuses.includes(r.status));
    if (inFlight) {
      throw new Error(`该发布目标已有进行中的发布（${inFlight.releaseId}，状态 ${inFlight.status}），请等待其完成后再发起`);
    }
    const releaseId = `rel_${crypto.randomBytes(8).toString('hex')}`;
    const run: ReleaseRun = {
      releaseId,
      projectId: preflight.target.projectId,
      branchId: input.branchId,
      commitSha: preflight.artifact.commitSha,
      artifact: preflight.artifact,
      targetId: preflight.target.id,
      planId: preflight.plan.id,
      status: 'queued',
      startedAt: new Date().toISOString(),
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
    void this.runRelease(releaseId).catch((err) => {
      this.failRun(releaseId, err);
    });
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

    const rollbackId = `rel_${crypto.randomBytes(8).toString('hex')}`;
    const run: ReleaseRun = {
      releaseId: rollbackId,
      projectId: current.projectId,
      branchId: previous.branchId,
      commitSha: previous.commitSha,
      artifact: previous.artifact,
      targetId: current.targetId,
      planId: current.planId,
      status: 'rollback_running',
      startedAt: new Date().toISOString(),
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
    void this.runRollback(rollbackId, target, previous).catch((err) => {
      this.failRun(rollbackId, err, 'rollback_failed');
    });
    return this.stateService.getReleaseRun(rollbackId)!;
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
    const done = this.stateService.patchReleaseRun(releaseId, {
      status: 'success',
      finishedAt: new Date().toISOString(),
    });
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId, run: done } });
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
    const done = this.stateService.patchReleaseRun(releaseId, {
      status: 'rollback_success',
      finishedAt: new Date().toISOString(),
    });
    this.emitLog(releaseId, 'info', '回滚成功', 'record');
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId, run: done } });
  }

  private failRun(releaseId: string, err: unknown, status: ReleaseRun['status'] = 'failed'): void {
    this.emitLog(releaseId, 'error', (err as Error).message || String(err), 'error');
    const run = this.stateService.patchReleaseRun(releaseId, {
      status,
      errorMessage: (err as Error).message || String(err),
      finishedAt: new Date().toISOString(),
    });
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId, run } });
  }

  private async restorePreviousAfterFailedProbe(
    releaseId: string,
    target: ReleaseTarget,
    failedRun: ReleaseRun,
    probeError: unknown,
  ): Promise<void> {
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

  private patchStatus(releaseId: string, status: ReleaseRun['status']): void {
    const run = this.stateService.patchReleaseRun(releaseId, { status });
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId, run } });
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
    const ssh2Mod = await loadSsh2();
    const { privateKey, passphrase } = decryptRemoteHostSecrets(host);
    const client = new ssh2Mod.Client() as unknown as Ssh2Client;

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch { /* ignore */ }
        fn();
      };
      const append = (level: 'info' | 'warn', chunk: unknown) => {
        const text = String(chunk);
        if (level === 'info') stdout += text;
        else stderr += text;
        if (releaseId) {
          for (const line of text.split(/\r?\n/).filter(Boolean)) {
            this.emitLog(releaseId, level, line.slice(0, 1000), logPhase);
          }
        }
      };

      client.on('ready', () => {
        client.exec(cmd, (err, stream) => {
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
        host: host.host,
        port: host.sshPort,
        username: host.sshUser,
        privateKey,
        passphrase,
        readyTimeout: 10_000,
      });
    });
  }
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
