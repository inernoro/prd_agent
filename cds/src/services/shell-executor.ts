import { exec as cpExec, spawn, type ChildProcess } from 'node:child_process';
import type { IShellExecutor, ExecResult, ExecOptions } from '../types.js';
import { cleanObservationGroup } from './observation-process-group.js';

/** 仅供私有观测进程使用，不暴露 shell RPC 或状态写入能力。 */
export interface OwnedShellControl {
  env: NodeJS.ProcessEnv;
  cancelled: () => boolean;
  onSpawn: (child: ChildProcess) => void;
  /** 独立 actor 的根进程组；查询子进程继承它，以便 PID 尚未返回时也能清理。 */
  processGroup?: number;
}

export function executeShellCommand(command: string, options?: ExecOptions, owned?: OwnedShellControl): Promise<ExecResult> {
  if (owned) return executeOwnedShellCommand(command, options, owned);
  return new Promise((resolve) => {
    const cp = cpExec(command, {
      cwd: options?.cwd,
      timeout: options?.timeout,
      maxBuffer: 10 * 1024 * 1024,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    }, (error, stdout, stderr) => {
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: error ? (error.code ?? 1) : 0 });
    });
    if (options?.stdin !== undefined) cp.stdin?.end(options.stdin);
    if (options?.onData) {
      cp.stdout?.on('data', (d: Buffer) => options.onData!(d.toString()));
      cp.stderr?.on('data', (d: Buffer) => options.onData!(d.toString()));
    }
    cp.on('error', () => resolve({ stdout: '', stderr: 'Process error', exitCode: 1 }));
  });
}

function executeOwnedShellCommand(command: string, options: ExecOptions | undefined, owned: OwnedShellControl): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    let overflow = false;
    let failed = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // exec/execFile 不下传 detached；必须用 spawn 创建独立进程组才能回收 shell 的子进程。
    const child = spawn(command, { shell: true, detached: !owned.processGroup && process.platform !== 'win32', cwd: options?.cwd, env: owned.env });
    const kill = (): void => {
      if (!child.pid) return;
      try { process.kill(owned.processGroup || process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    };
    const check = (): void => { if (owned.cancelled()) { cancelled = true; kill(); } };
    const poll = setInterval(check, 20);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (options?.captureOutput !== false && stdoutBytes > 10 * 1024 * 1024) { overflow = true; kill(); return; }
      if (options?.captureOutput !== false) stdout += chunk;
      options?.onData?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (options?.captureOutput !== false && stderrBytes > 10 * 1024 * 1024) { overflow = true; kill(); return; }
      if (options?.captureOutput !== false) stderr += chunk;
      options?.onData?.(chunk);
    });
    child.on('error', () => { failed = true; });
    child.stdin?.on('error', () => { /* 子进程提前退出时以 close 结果为准 */ });
    child.on('close', (code) => {
      clearInterval(poll);
      kill();
      void (owned.processGroup ? cleanObservationGroup(owned.processGroup, owned.processGroup) : Promise.resolve()).then(() => {
        if (cancelled) reject(new Error('Observation execution cancelled'));
        else resolve({ stdout, stderr: failed ? 'Process error' : stderr, exitCode: failed || overflow ? 1 : code ?? 1 });
      }, reject);
    });
    owned.onSpawn(child);
    if (options?.stdin !== undefined) child.stdin?.end(options.stdin);
    check();
  });
}

export class ShellExecutor implements IShellExecutor {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return executeShellCommand(command, options);
  }
}

type PatternHandler = (match: RegExpMatchArray, options?: ExecOptions) => ExecResult;

export class MockShellExecutor implements IShellExecutor {
  readonly commands: string[] = [];
  /** 与 commands 平行：每次 exec 收到的 stdin（没给就是 undefined）。
   *  凭据走 stdin 之后，回归要能断言「密钥确实没进命令行、而是进了这里」。 */
  readonly stdins: Array<string | undefined> = [];
  /**
   * Parallel to `commands`: the `cwd` value passed with each exec() call
   * (may be undefined). Added in P4 Part 18 (G1.2) so the concurrent
   * stateless-WorktreeService test can assert that two concurrent calls
   * used different repoRoots without interference.
   */
  readonly cwds: Array<string | undefined> = [];
  private responses = new Map<string, ExecResult>();
  private patterns: Array<{ regex: RegExp; handler: PatternHandler }> = [];

  addResponse(command: string, result: ExecResult): void {
    this.responses.set(command, result);
  }

  addResponsePattern(regex: RegExp, handler: PatternHandler): void {
    this.patterns.push({ regex, handler });
  }

  /**
   * 同 addResponsePattern，但插到队首 —— exec() 是**首个命中即返回**，所以在
   * beforeEach 里注册过通用桩之后，单个用例想覆盖其中一条只能靠这个（往后追加永远
   * 匹配不到）。用于「这个用例的场景与通用桩的默认值不符」的局部修正。
   */
  addResponsePatternFirst(regex: RegExp, handler: PatternHandler): void {
    this.patterns.unshift({ regex, handler });
  }

  clearPatterns(): void {
    this.patterns = [];
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    this.cwds.push(options?.cwd);
    this.stdins.push(options?.stdin);

    const exact = this.responses.get(command);
    if (exact) return exact;

    for (const { regex, handler } of this.patterns) {
      const match = command.match(regex);
      if (match) return handler(match, options);
    }

    return {
      stdout: '',
      stderr: `Command not mocked: ${command}`,
      exitCode: 1,
    };
  }
}
