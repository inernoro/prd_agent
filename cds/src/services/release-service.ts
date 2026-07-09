import crypto from 'node:crypto';
import type { StateService } from './state.js';
import type { BranchEntry, ReleaseArtifact, ReleasePlan, ReleaseRun, ReleaseTarget, RemoteHost } from '../types.js';
import { decryptRemoteHostSecrets } from './sidecar/remote-host-service.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';
import { releaseEvents } from './release-events.js';

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
    const sshPlanId = `${projectId}:ssh-script`;
    if (!existing.some((plan) => plan.id === sshPlanId)) {
      this.stateService.upsertReleasePlan({
        id: sshPlanId,
        projectId,
        name: 'SSH 脚本发布',
        template: 'ssh-script',
        targetType: 'ssh',
        failureStrategy: 'stop',
        rollbackStrategy: 'command',
        createdAt: new Date().toISOString(),
        steps: [
          { id: 'connect', title: '连接目标', kind: 'ssh' },
          { id: 'deploy', title: '执行发布命令', kind: 'ssh' },
          { id: 'healthcheck', title: '健康检查', kind: 'healthcheck' },
          { id: 'record', title: '记录版本', kind: 'record' },
        ],
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
    const plan = this.ensureDefaultPlans(projectId).find((item) => item.template === 'ssh-script');

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
    } else {
      push({ id: 'target', label: '发布目标', status: 'pass', message: `${target.name} (${target.ssh.user}@${target.ssh.host}:${target.ssh.port})`, blocking: false });
    }

    const canProbeTarget = Boolean(target?.ssh && target.isEnabled && target.type === 'ssh' && !projectMismatch);

    const deployCommand = !projectMismatch ? target?.ssh?.deployCommand?.trim() || '' : '';
    const deployScripts = extractReleaseScriptPaths(deployCommand);
    const previousRelease = target ? this.stateService.getLatestSuccessfulReleaseRun(target.id) : undefined;
    const isFirstLocalProdRelease = Boolean(
      target?.ssh
      && isLocalProdReleaseCommand(deployCommand)
      && !previousRelease,
    );

    if (deployCommand) {
      push({ id: 'deploy-command', label: '发布脚本已配置', status: 'pass', message: deployCommand, blocking: false });
    } else if (!projectMismatch) {
      push({ id: 'deploy-command', label: '发布脚本已配置', status: 'fail', message: '站点发布目标缺少发布脚本', blocking: true });
    }

    if (!projectMismatch && target?.ssh?.healthcheckUrl?.trim()) {
      if (isFirstLocalProdRelease) {
        push({
          id: 'healthcheck',
          label: '上线地址可访问',
          status: 'warn',
          message: '首次本机生产发布前跳过上线地址探测，发布后仍会执行健康检查',
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
          if (deployScripts.length > 0) {
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
    this.stateService.addReleaseRun(run);
    const strategy = target.ssh.rollbackCommand?.trim() ? 'rollbackCommand' : '重新发布历史版本';
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
    await this.runDeployCommand(releaseId, target, run, target.ssh.deployCommand);
    this.patchStatus(releaseId, 'healthchecking');
    this.emitLog(releaseId, 'info', `健康检查 ${target.ssh.healthcheckUrl}`, 'healthcheck');
    await probeHealthcheck(target.ssh.healthcheckUrl);
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
    if (rollbackCommand) {
      this.emitLog(releaseId, 'info', `执行回滚命令，目标版本 ${previous.releaseId}`, 'rollback');
      await this.sshExec(target, buildReleaseCommand(target, rollbackRun, rollbackCommand), releaseId, 'rollback');
    } else {
      const deployCommand = ssh.deployCommand?.trim();
      if (!deployCommand) throw new Error('未配置发布命令，无法重新发布历史版本');
      this.emitLog(releaseId, 'info', `重新发布历史成功版本 ${previous.releaseId}`, 'rollback');
      await this.runDeployCommand(releaseId, target, rollbackRun, deployCommand);
    }
    this.emitLog(releaseId, 'info', `健康检查 ${ssh.healthcheckUrl}`, 'healthcheck');
    await probeHealthcheck(ssh.healthcheckUrl);
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
