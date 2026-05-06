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

  clearPatterns(): void {
    this.patterns = [];
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    this.cwds.push(options?.cwd);

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
