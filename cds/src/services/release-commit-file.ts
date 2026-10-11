import type { IShellExecutor } from '../types.js';
import { ShellExecutor } from './shell-executor.js';

export interface CommitClockFileIO {
  load(): Promise<unknown>;
  save(serialized: string): Promise<void>;
}
export const COMMIT_FILE_TIMEOUT_MS = 3_000;
const fallback = new ShellExecutor({ maxConcurrent: 1, maxQueued: 32 });
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const READ = `// release-commit-file-read
const fs = require('node:fs');
let raw;
try { raw = fs.readFileSync(process.argv[1], 'utf8'); }
catch (error) { if (error.code === 'ENOENT') { process.stdout.write('null'); process.exit(0); } throw error; }
const data = JSON.parse(raw);
if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.entries)) throw new Error('invalid commit clock file');
process.stdout.write(JSON.stringify({ version: data.version, entries: data.entries.slice(-Number(process.argv[2])) }));`;
const WRITE = `// release-commit-file-write
const fs = require('node:fs'), path = require('node:path');
const target = process.argv[1], temporary = target + '.tmp.' + process.pid;
try {
  const raw = fs.readFileSync(0, 'utf8');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, raw, { mode: 0o600 });
  fs.renameSync(temporary, target);
} finally { try { fs.rmSync(temporary, { force: true }); } catch {} }`;

/** File IO/parse runs in the shared command worker; payload never enters argv. */
export function commitClockFileIO(filePath: string, maxEntries: number, shell: IShellExecutor = fallback): CommitClockFileIO {
  const command = (script: string, args: string[]) => [process.execPath, '-e', script, ...args].map(quote).join(' ');
  const options = { timeout: COMMIT_FILE_TIMEOUT_MS, priority: 'diagnostic' as const, schedulingGroup: 'release-meta-file' };
  return {
    load: async () => {
      const result = await shell.exec(command(READ, [filePath, String(maxEntries)]), { ...options });
      if (result.exitCode !== 0) throw new Error('commit clock load unavailable');
      return JSON.parse(result.stdout);
    },
    save: async serialized => {
      const result = await shell.exec(command(WRITE, [filePath]), { ...options, stdin: serialized });
      if (result.exitCode !== 0) throw new Error('commit clock write unavailable');
    },
  };
}
