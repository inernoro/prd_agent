import type { IShellExecutor } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';

export type ReleaseGitRunner = (args: readonly string[]) => string | Promise<string>;
/** 纯本地Git读取，复用已有观测池；缺执行器明确不可用，不从Master创建命令。 */
export function createReleaseGitRunner(shell?: IShellExecutor): ReleaseGitRunner {
  return async args => {
    if (!shell) throw new Error('Release Git observation executor unavailable');
    let output = '';
    let bytes = 0;
    const result = await shell.exec(['git', ...args].map(shellQuoteArg).join(' '), {
      executionLane: 'observation',
      timeout: 3000,
      captureOutput: false,
      onData: (chunk, channel) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) throw new Error('Release Git output capacity exceeded');
        if (channel !== 'stderr') output += chunk;
      },
    });
    if (result.exitCode !== 0) throw new Error('Release Git read failed');
    return output;
  };
}
