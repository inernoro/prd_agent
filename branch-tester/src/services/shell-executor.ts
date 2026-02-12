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

      cp.on('error', () => {
        resolve({ stdout: '', stderr: 'Process error', exitCode: 1 });
      });
    });
  }
}

type PatternHandler = (match: RegExpMatchArray) => ExecResult;

export class MockShellExecutor implements IShellExecutor {
  readonly commands: string[] = [];
  private responses = new Map<string, ExecResult>();
  private patterns: Array<{ regex: RegExp; handler: PatternHandler }> = [];

  addResponse(command: string, result: ExecResult): void {
    this.responses.set(command, result);
  }

  addResponsePattern(regex: RegExp, handler: PatternHandler): void {
    this.patterns.push({ regex, handler });
  }

  async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);

    const exact = this.responses.get(command);
    if (exact) return exact;

    for (const { regex, handler } of this.patterns) {
      const match = command.match(regex);
      if (match) return handler(match);
    }

    return {
      stdout: '',
      stderr: `Command not mocked: ${command}`,
      exitCode: 1,
    };
  }
}
