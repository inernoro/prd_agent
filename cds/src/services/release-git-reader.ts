import type { IShellExecutor } from '../types.js';
import { ShellExecutor } from './shell-executor.js';

export const RELEASE_GIT_TIMEOUT_MS = 3_000;
export type GitRunner = (args: readonly string[], signal?: AbortSignal) => string | Promise<string>;

// Production injects the shared executor. Embedded readers share this bounded fallback.
const fallbackShell = new ShellExecutor({ maxConcurrent: 1, maxQueued: 64 });
const quoteArg = (arg: string): string => "'" + arg.replace(/'/g, "'\"'\"'") + "'";
export function shellGitRunner(shell: IShellExecutor, schedulingGroup = 'release-rail'): GitRunner {
  return async (args, signal) => {
    const result = await shell.exec('git ' + args.map(quoteArg).join(' '), {
      timeout: RELEASE_GIT_TIMEOUT_MS, signal, priority: 'diagnostic', schedulingGroup,
    });
    if (result.exitCode !== 0) throw new Error('release history query unavailable');
    return result.stdout;
  };
}
export const workerGitRunner: GitRunner = shellGitRunner(fallbackShell);
