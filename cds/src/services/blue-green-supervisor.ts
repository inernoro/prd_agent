/**
 * Blue-Green Supervisor — 蓝绿切换编排器(B'.3+)
 *
 * 职责:在 self-update 完成 esbuild 后,接管整个切换流程
 *   spawn 新 daemon(standby)→ 等 healthz → 写 nginx → reload → promote → SIGTERM 旧
 * 任一阶段失败自动回滚到旧 daemon 仍服务的状态。
 *
 * 设计要点(对应 spec.cds-blue-green-mece-acceptance.md):
 *   - C-1.6 全流程编排
 *   - C-1.7 回滚 / SIGKILL 强杀 / 失败标记
 *   - C-5.2 锁文件 + 单实例
 *   - C-5.3 reconcile 残留 daemon
 *   - C-7.3 SSE 进度推送
 *   - C-8.2 整个流程旧 daemon 持续服务
 *   - C-8.5 连续失败 ≥ 3 次自动禁用
 *
 * 依赖只 import 不修改:
 *   - active-color-store.ts(B'.2)
 *   - standby-controller.ts(B'.2,supervisor 通过 callPromote 间接驱动)
 *   - nginx-upstream-writer.ts(B'.4)
 *   - graceful-shutdown.ts(B'.3,旧 daemon 内自处理)
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  SupervisorDeps,
  SupervisorEvent,
  SupervisorStage,
  SupervisorStageEvent,
  SwitchActiveOpts,
  SwitchResult,
} from './blue-green-supervisor.types.js';
import type { ActiveColor } from './active-color-store.js';

const LOCK_REL_PATH = path.join('.cds', 'blue-green.lock');
const ACTIVE_PORT_REL_PATH = path.join('.cds', 'active-port');
const DISABLED_REL_PATH = path.join('.cds', 'blue-green-disabled');
const DEFAULT_HEALTHZ_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_FORCE_KILL_MS = 30_000;
const DEFAULT_AUTO_DISABLE_THRESHOLD = 3;

/** 锁文件结构。 */
interface LockFileContent {
  pid: number;
  startedAt: string;
}

/** auto-disable 累计文件结构。 */
interface DisableFileContent {
  failures: number;
  lastFailureAt: string;
  disabled?: boolean;
}

/**
 * 默认 isProcessAlive:用 process.kill(pid, 0) 探活。
 * pid 不存在时抛 ESRCH;权限不够抛 EPERM(也算活着)。
 */
function defaultIsProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // 进程在,只是没权限
    return false;
  }
}

/** 中文 stage 文案,运维友好。 */
const STAGE_LABEL_CN: Record<SupervisorStage, string> = {
  'lock-acquire': '获取切换锁',
  'spawn-green': '启动新 daemon',
  'wait-healthz': '等绿就绪',
  'nginx-write': '写 nginx 配置',
  'nginx-validate': '校验 nginx 配置',
  'nginx-reload': '切流',
  'verify-target': '验证流量到位',
  'promote-green': '激活新 daemon',
  'shutdown-blue': '退役蓝',
  'commit-color': '提交颜色',
  done: '完成',
};

export class BlueGreenSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly lockPath: string;
  private readonly activePortPath: string;
  private readonly disabledPath: string;
  private readonly threshold: number;
  /** 内存级 in-progress 标记(单进程内并发拒)。 */
  private _inProgress = false;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.lockPath = path.join(deps.cdsRoot, LOCK_REL_PATH);
    this.activePortPath = path.join(deps.cdsRoot, ACTIVE_PORT_REL_PATH);
    this.disabledPath = path.join(deps.cdsRoot, DISABLED_REL_PATH);
    this.threshold = deps.autoDisableThreshold ?? DEFAULT_AUTO_DISABLE_THRESHOLD;
  }

  isInProgress(): boolean {
    return this._inProgress || this.isLockHeldByLiveProcess();
  }

  /** 主流程入口。 */
  async switchActive(opts: SwitchActiveOpts = {}): Promise<SwitchResult> {
    const startedAt = this.now();
    const events: SupervisorEvent[] = [];
    const onStage = opts.onStage;

    const fromColor = opts.fromColor ?? this.deps.readActiveColor() ?? 'blue';
    const toColor: ActiveColor = fromColor === 'blue' ? 'green' : 'blue';
    const fromPort = fromColor === 'blue' ? this.deps.bluePort : this.deps.greenPort;
    const toPort = toColor === 'blue' ? this.deps.bluePort : this.deps.greenPort;

    const baseResult: SwitchResult = {
      ok: false,
      fromColor,
      toColor,
      fromPort,
      toPort,
      totalElapsedMs: 0,
      rolledBack: false,
      events,
    };

    // 0a. 检查 auto-disable 标志
    if (this.isAutoDisabled()) {
      const ev = this.makeStageEvent('lock-acquire', 'error', startedAt, '蓝绿切换已被自动禁用');
      events.push(ev);
      this.deps.recordEvent(ev);
      onStage?.('lock-acquire', ev.message);
      return {
        ...baseResult,
        failedStage: 'lock-acquire',
        error: 'blue-green auto-disabled',
        totalElapsedMs: this.now() - startedAt,
      };
    }

    // 0b. 检查 in-progress(锁文件 + 内存)
    if (this.isInProgress()) {
      const ev = this.makeStageEvent('lock-acquire', 'error', startedAt, '正在切换中');
      events.push(ev);
      this.deps.recordEvent(ev);
      onStage?.('lock-acquire', ev.message);
      return {
        ...baseResult,
        failedStage: 'lock-acquire',
        error: '正在切换中',
        totalElapsedMs: this.now() - startedAt,
      };
    }

    // 1. 获取锁
    this._inProgress = true;
    let lockAcquired = false;
    try {
      this.acquireLock();
      lockAcquired = true;
    } catch (err) {
      const ev = this.makeStageEvent(
        'lock-acquire',
        'error',
        startedAt,
        `获取锁失败: ${(err as Error).message}`,
      );
      events.push(ev);
      this.deps.recordEvent(ev);
      onStage?.('lock-acquire', ev.message);
      this._inProgress = false;
      return {
        ...baseResult,
        failedStage: 'lock-acquire',
        error: (err as Error).message,
        totalElapsedMs: this.now() - startedAt,
      };
    }

    this.emit(events, 'lock-acquire', 'done', startedAt, '切换锁已获取', onStage);

    let newPid: number | null = null;
    let oldPid: number | null = null;
    if (this.deps.readDaemonPid) {
      try {
        oldPid = this.deps.readDaemonPid(fromColor) ?? null;
      } catch {
        oldPid = null;
      }
    }

    try {
      // 2. spawn-green
      this.emit(events, 'spawn-green', 'running', startedAt, `启动新 daemon (${toColor}:${toPort})`, onStage);
      try {
        const spawned = await this.deps.spawnDaemon({
          color: toColor,
          port: toPort,
          standby: true,
        });
        newPid = spawned.pid;
      } catch (err) {
        return this.handleFailure(
          'spawn-green',
          err as Error,
          startedAt,
          events,
          baseResult,
          onStage,
          { newPid: null, oldPid, fromColor, fromPort },
        );
      }
      this.emit(events, 'spawn-green', 'done', startedAt, `新 daemon 已启动 pid=${newPid}`, onStage);

      // 3. wait-healthz
      const healthTimeout = opts.healthCheckTimeoutMs ?? DEFAULT_HEALTHZ_TIMEOUT_MS;
      this.emit(events, 'wait-healthz', 'running', startedAt, '等绿就绪', onStage);
      const healthRes = await this.deps.waitForHealthz(toPort, { timeoutMs: healthTimeout });
      if (!healthRes.ok) {
        return this.handleFailure(
          'wait-healthz',
          new Error(healthRes.lastError ?? 'healthz timeout'),
          startedAt,
          events,
          baseResult,
          onStage,
          { newPid, oldPid, fromColor, fromPort },
        );
      }
      this.emit(events, 'wait-healthz', 'done', startedAt, '新 daemon 健康', onStage);

      // 4. nginx-write + validate + reload + verify(由 nginxWriter.swap 一步完成)
      this.emit(events, 'nginx-write', 'running', startedAt, '写 nginx 配置', onStage);
      const swapRes = await this.deps.nginxWriter.swap({
        absPath: this.deps.nginxConfPath,
        allowDir: this.deps.nginxAllowDir,
        port: toPort,
        executor: this.deps.shell,
        verifyTargetUrl: this.deps.verifyAdminTargetUrl
          ? this.deps.verifyAdminTargetUrl(toPort)
          : undefined,
      });
      if (!swapRes.ok) {
        // 把 nginx-writer 内部 stage 翻译成 supervisor stage
        const failedStage = this.mapNginxStage(swapRes.stage);
        return this.handleFailure(
          failedStage,
          new Error(swapRes.error ?? `nginx ${swapRes.stage} failed`),
          startedAt,
          events,
          baseResult,
          onStage,
          { newPid, oldPid, fromColor, fromPort, nginxRolledBack: swapRes.rolledBack },
        );
      }
      this.emit(events, 'nginx-write', 'done', startedAt, 'nginx 配置已写入', onStage);
      this.emit(events, 'nginx-validate', 'done', startedAt, 'nginx -t 通过', onStage);
      this.emit(events, 'nginx-reload', 'done', startedAt, 'nginx reload 完成,流量切到新 daemon', onStage);
      if (this.deps.verifyAdminTargetUrl) {
        this.emit(events, 'verify-target', 'done', startedAt, '探测新 daemon 200', onStage);
      }

      // 5. promote-green
      this.emit(events, 'promote-green', 'running', startedAt, '激活新 daemon', onStage);
      const promoteRes = await this.deps.callPromote(toPort);
      if (!promoteRes.ok) {
        return this.handleFailure(
          'promote-green',
          new Error(promoteRes.error ?? 'promote failed'),
          startedAt,
          events,
          baseResult,
          onStage,
          { newPid, oldPid, fromColor, fromPort, nginxRolledBack: false, needsNginxRollback: true },
        );
      }
      this.emit(events, 'promote-green', 'done', startedAt, '新 daemon 已激活', onStage);

      // 6. shutdown-blue
      this.emit(events, 'shutdown-blue', 'running', startedAt, '退役蓝', onStage);
      try {
        if (oldPid && oldPid > 0) {
          await this.shutdownOldDaemon(
            oldPid,
            opts.shutdownForceKillAfterMs ?? DEFAULT_SHUTDOWN_FORCE_KILL_MS,
            startedAt,
            events,
            onStage,
          );
        }
        this.emit(events, 'shutdown-blue', 'done', startedAt, '旧 daemon 已退役', onStage);
      } catch (err) {
        // 旧 daemon 杀不掉不致命,告警继续
        this.emit(
          events,
          'shutdown-blue',
          'error',
          startedAt,
          `退役旧 daemon 失败(非致命): ${(err as Error).message}`,
          onStage,
        );
      }

      // 7. commit-color
      this.emit(events, 'commit-color', 'running', startedAt, '提交新颜色', onStage);
      try {
        await this.deps.writeActiveColor(toColor);
        this.writeActivePort(toPort);
      } catch (err) {
        // active-color 写不下来不致命,reconcile 时修复
        this.emit(
          events,
          'commit-color',
          'error',
          startedAt,
          `commit 失败(非致命,reconcile 时修复): ${(err as Error).message}`,
          onStage,
        );
      }
      this.emit(events, 'commit-color', 'done', startedAt, 'active-color 已写入', onStage);

      this.emit(events, 'done', 'done', startedAt, '蓝绿切换完成', onStage);

      // 成功 → 清 auto-disable 计数
      this.clearFailureCount();

      return {
        ok: true,
        fromColor,
        toColor,
        fromPort,
        toPort,
        totalElapsedMs: this.now() - startedAt,
        rolledBack: false,
        events,
      };
    } finally {
      if (lockAcquired) {
        this.releaseLock();
      }
      this._inProgress = false;
    }
  }

  /**
   * crash recovery:列出蓝/绿端口的 pid,与 active-color 对照,杀多余 standby。
   */
  async reconcileResidualDaemon(): Promise<{ killed: number; remaining: number }> {
    const activeColor = this.deps.readActiveColor();
    const colors: ActiveColor[] = ['blue', 'green'];
    let killed = 0;
    let remaining = 0;
    for (const color of colors) {
      const pid = this.deps.readDaemonPid ? this.deps.readDaemonPid(color) : null;
      if (!pid || pid <= 0) continue;
      const isActive = activeColor === color;
      const alive = (this.deps.isProcessAlive ?? defaultIsProcessAlive)(pid);
      if (!alive) continue;
      if (isActive) {
        remaining += 1;
      } else {
        // 多余的 standby,杀掉
        try {
          this.deps.killProcess(pid, 'SIGTERM');
          killed += 1;
        } catch {
          // 杀失败留给下一轮 reconcile
        }
      }
    }
    return { killed, remaining };
  }

  // ============== private helpers ==============

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private makeStageEvent(
    stage: SupervisorStage,
    status: 'running' | 'done' | 'error',
    startedAt: number,
    message: string,
  ): SupervisorStageEvent {
    return {
      stage,
      status,
      elapsedMs: this.now() - startedAt,
      message,
    };
  }

  private emit(
    events: SupervisorEvent[],
    stage: SupervisorStage,
    status: 'running' | 'done' | 'error',
    startedAt: number,
    message: string,
    onStage?: SwitchActiveOpts['onStage'],
  ): void {
    const ev = this.makeStageEvent(stage, status, startedAt, message);
    events.push(ev);
    this.deps.recordEvent(ev);
    onStage?.(stage, message);
  }

  private mapNginxStage(stage: 'backup' | 'write' | 'validate' | 'reload' | 'verify' | 'done'): SupervisorStage {
    switch (stage) {
      case 'backup':
      case 'write':
        return 'nginx-write';
      case 'validate':
        return 'nginx-validate';
      case 'reload':
        return 'nginx-reload';
      case 'verify':
        return 'verify-target';
      case 'done':
        return 'done';
    }
  }

  /**
   * 失败处理:根据 stage 决定是否 kill 新 daemon / 是否回滚 nginx。
   * 始终 record rollback 事件,bump 失败计数,可能触发 auto-disable。
   */
  private async handleFailure(
    stage: SupervisorStage,
    err: Error,
    startedAt: number,
    events: SupervisorEvent[],
    baseResult: SwitchResult,
    onStage: SwitchActiveOpts['onStage'],
    ctx: {
      newPid: number | null;
      oldPid: number | null;
      fromColor: ActiveColor;
      fromPort: number;
      nginxRolledBack?: boolean;
      needsNginxRollback?: boolean;
    },
  ): Promise<SwitchResult> {
    this.emit(events, stage, 'error', startedAt, `${STAGE_LABEL_CN[stage]}失败: ${err.message}`, onStage);

    // promote 失败:把 nginx 切回 fromPort
    if (ctx.needsNginxRollback) {
      try {
        await this.deps.nginxWriter.swap({
          absPath: this.deps.nginxConfPath,
          allowDir: this.deps.nginxAllowDir,
          port: ctx.fromPort,
          executor: this.deps.shell,
          verifyTargetUrl: this.deps.verifyAdminTargetUrl
            ? this.deps.verifyAdminTargetUrl(ctx.fromPort)
            : undefined,
        });
      } catch {
        // 失败也无法挽回,旧 daemon 仍在,nginx 已经指向新 daemon 是最坏情况
      }
    }

    // 杀掉新 daemon(spawn 之后所有失败都需要)
    if (ctx.newPid && ctx.newPid > 0) {
      try {
        this.deps.killProcess(ctx.newPid, 'SIGTERM');
      } catch {
        // ignore
      }
    }

    // record rollback 汇总事件
    const rbEvent: SupervisorEvent = {
      kind: 'rollback',
      reason: `${stage}: ${err.message}`,
      recoveredColor: ctx.fromColor,
      elapsedMs: this.now() - startedAt,
    };
    events.push(rbEvent);
    this.deps.recordEvent(rbEvent);

    // bump 失败计数,可能 auto-disable
    const failures = this.bumpFailureCount();
    if (failures >= this.threshold) {
      this.markAutoDisabled();
      const adEvent: SupervisorEvent = {
        kind: 'auto-disable',
        reason: `连续失败 ${failures} 次,自动禁用蓝绿`,
        failures,
        elapsedMs: this.now() - startedAt,
      };
      events.push(adEvent);
      this.deps.recordEvent(adEvent);
    }

    return {
      ...baseResult,
      ok: false,
      rolledBack: true,
      failedStage: stage,
      error: err.message,
      totalElapsedMs: this.now() - startedAt,
      events,
    };
  }

  private async shutdownOldDaemon(
    pid: number,
    forceKillAfterMs: number,
    startedAt: number,
    events: SupervisorEvent[],
    onStage: SwitchActiveOpts['onStage'],
  ): Promise<void> {
    this.deps.killProcess(pid, 'SIGTERM');
    const isAlive = this.deps.isProcessAlive ?? defaultIsProcessAlive;
    const deadline = this.now() + forceKillAfterMs;
    while (this.now() < deadline) {
      if (!isAlive(pid)) return; // 优雅退出
      await sleep(Math.min(100, Math.max(10, forceKillAfterMs / 50)));
    }
    // 还活着 → SIGKILL
    if (isAlive(pid)) {
      this.emit(
        events,
        'shutdown-blue',
        'error',
        startedAt,
        `旧 daemon SIGTERM 30s 未退出,强杀 (forced-kill pid=${pid})`,
        onStage,
      );
      try {
        this.deps.killProcess(pid, 'SIGKILL');
      } catch {
        // 已死
      }
    }
  }

  // -------- lock --------

  private acquireLock(): void {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(this.lockPath)) {
      // stale 锁?
      if (this.isLockHeldByLiveProcess()) {
        throw new Error('lock held by another supervisor');
      }
      // 死锁,清掉
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // 清不掉就继续 try
      }
    }
    const content: LockFileContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    // wx 防 race
    fs.writeFileSync(this.lockPath, JSON.stringify(content), { flag: 'wx', mode: 0o644 });
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }

  private isLockHeldByLiveProcess(): boolean {
    if (!fs.existsSync(this.lockPath)) return false;
    let raw: string;
    try {
      raw = fs.readFileSync(this.lockPath, 'utf8');
    } catch {
      return false;
    }
    let parsed: LockFileContent | null = null;
    try {
      parsed = JSON.parse(raw) as LockFileContent;
    } catch {
      return false;
    }
    if (!parsed || typeof parsed.pid !== 'number') return false;
    return (this.deps.isProcessAlive ?? defaultIsProcessAlive)(parsed.pid);
  }

  // -------- active-port --------

  private writeActivePort(port: number): void {
    const dir = path.dirname(this.activePortPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.activePortPath}.tmp`;
    fs.writeFileSync(tmp, String(port), { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, this.activePortPath);
  }

  // -------- auto-disable counter --------

  private readDisableFile(): DisableFileContent | null {
    if (!fs.existsSync(this.disabledPath)) return null;
    try {
      const raw = fs.readFileSync(this.disabledPath, 'utf8');
      return JSON.parse(raw) as DisableFileContent;
    } catch {
      return null;
    }
  }

  private writeDisableFile(content: DisableFileContent): void {
    const dir = path.dirname(this.disabledPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.disabledPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(content), { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, this.disabledPath);
  }

  private isAutoDisabled(): boolean {
    const f = this.readDisableFile();
    return !!(f && f.disabled === true);
  }

  private bumpFailureCount(): number {
    const cur = this.readDisableFile();
    const failures = (cur?.failures ?? 0) + 1;
    const next: DisableFileContent = {
      failures,
      lastFailureAt: new Date().toISOString(),
      disabled: cur?.disabled === true ? true : undefined,
    };
    this.writeDisableFile(next);
    return failures;
  }

  private markAutoDisabled(): void {
    const cur = this.readDisableFile();
    const next: DisableFileContent = {
      failures: cur?.failures ?? this.threshold,
      lastFailureAt: cur?.lastFailureAt ?? new Date().toISOString(),
      disabled: true,
    };
    this.writeDisableFile(next);
  }

  private clearFailureCount(): void {
    if (fs.existsSync(this.disabledPath)) {
      try {
        fs.unlinkSync(this.disabledPath);
      } catch {
        // ignore
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
