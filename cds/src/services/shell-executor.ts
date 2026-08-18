import { exec as cpExec } from 'node:child_process';
import type { IShellExecutor, ExecResult, ExecOptions } from '../types.js';

export class ShellExecutor implements IShellExecutor {
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const cp = cpExec(
        command,
        {
          cwd: options?.cwd,
          timeout: options?.timeout,
          maxBuffer: 10 * 1024 * 1024,
          // 2026-05-04:支持调用方覆盖部分 env 变量。提供 env 时与
          // process.env 合并,本字段后写覆盖。不提供时沿用 process.env(默认行为)。
          // 2026-05-06 起 self-update / web build 不再下发 NODE_OPTIONS 上限,V8 自适应主机 RAM。
          ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error ? (error.code ?? 1) : 0,
          });
        },
      );

      // 只在调用方显式给了 stdin 时才碰它。写完必须 end()，否则子进程里的
      // `sh -s` 会一直等输入结束，直到 exec 超时才被杀——那种挂起最难查。
      if (options?.stdin !== undefined) {
        cp.stdin?.end(options.stdin);
      }

      if (options?.onData) {
        cp.stdout?.on('data', (d: Buffer) => options.onData!(d.toString()));
        cp.stderr?.on('data', (d: Buffer) => options.onData!(d.toString()));
      }

      cp.on('error', () => {
        resolve({ stdout: '', stderr: 'Process error', exitCode: 1 });
      });
    });
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
