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
