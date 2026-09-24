/**
 * .cds.env file helper — atomic read/write of the single user config file.
 *
 * The cluster bootstrap flow (see `doc/design.cds.cluster-bootstrap.md`) needs
 * to mutate `.cds.env` from within the Node process:
 *   - On mode upgrade (standalone → scheduler), write `CDS_MODE=scheduler`.
 *   - On successful executor bootstrap, persist the permanent executor token.
 *   - On `issue-token`, write a time-limited bootstrap token.
 *
 * Requirements:
 *   1. Preserve the existing file format: `export KEY="value"` per line,
 *      plus comments that the shell must be able to source.
 *   2. Atomic updates — crash mid-write must not produce a half-empty file.
 *   3. Idempotent — updating the same key twice is fine.
 *   4. Create the file if it doesn't exist (fresh install).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface EnvLine {
  /** `export` declaration, comment, or blank line. */
  type: 'export' | 'comment' | 'blank';
  /** Raw line as it appeared in the source file. */
  raw: string;
  /** Extracted key (only present for `export` lines). */
  key?: string;
  /** Extracted value with outer quotes stripped (only present for `export` lines). */
  value?: string;
}

export class EnvFileBusyError extends Error {
  constructor() {
    super('环境文件正由另一进程更新，系统已拒绝并发覆盖。');
    this.name = 'EnvFileBusyError';
  }
}

interface EnvFileLock {
  lockDir: string;
  ownerPath: string;
  nonce: string;
  dev: number;
  ino: number;
}

export function withEnvFileLock<T>(envFilePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  const lockDir = `${envFilePath}.write.lock`;
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // EEXIST 一律 fail-closed。用户态无法以 CAS 方式证明眼前仍是先前检查
    // 的旧锁；自动 rename “死锁”会让延迟接管者误删新 owner 的锁并双写。
    // 残留锁只允许停机后的单写者运维流程显式清理。
    throw new EnvFileBusyError();
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  const ownerPath = path.join(lockDir, 'owner');
  try {
    const ownerFd = fs.openSync(ownerPath, 'wx', 0o600);
    try {
      fs.writeFileSync(ownerFd, `${process.pid}\n${nonce}\n`, 'utf8');
      fs.fsyncSync(ownerFd);
    } finally {
      fs.closeSync(ownerFd);
    }
  } catch (error) {
    try { fs.rmdirSync(lockDir); } catch { /* best effort */ }
    throw error;
  }
  const owned = fs.statSync(lockDir);
  const lock: EnvFileLock = { lockDir, ownerPath, nonce, dev: owned.dev, ino: owned.ino };
  try {
    return action();
  } finally {
    try {
      const current = fs.statSync(lock.lockDir);
      const owner = fs.readFileSync(lock.ownerPath, 'utf8').split('\n')[1];
      if (current.dev === lock.dev && current.ino === lock.ino && owner === lock.nonce) {
        fs.rmSync(lock.ownerPath);
        fs.rmdirSync(lock.lockDir);
      }
    } catch { /* fail closed: never delete an unverified replacement lock */ }
  }
}

/** Parse a `.cds.env` file into a structured line list. */
export function parseEnvFile(content: string): EnvLine[] {
  const lines: EnvLine[] = [];
  for (const raw of content.split('\n')) {
    if (raw.trim() === '') {
      lines.push({ type: 'blank', raw });
      continue;
    }
    if (raw.trim().startsWith('#')) {
      lines.push({ type: 'comment', raw });
      continue;
    }
    // Match both `export KEY="value"` and `export KEY=value`. The quoted form
    // permits `\"` and `\\` escape sequences inside the value so round-tripping
    // through `applyEnvUpdates` + `serializeEnvFile` preserves the payload.
    const match = raw.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*))\s*$/);
    if (match) {
      const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
      // Unescape `\"` → `"` and `\\` → `\` inside the quoted form. Unquoted
      // values are passed through unchanged.
      const value = match[2] !== undefined ? unescapeShellDouble(rawValue) : rawValue;
      lines.push({
        type: 'export',
        raw,
        key: match[1],
        value,
      });
    } else {
      // Unknown line — preserve as comment so we don't lose user content.
      lines.push({ type: 'comment', raw });
    }
  }
  return lines;
}

/** Serialize an env-line list back to file content. */
export function serializeEnvFile(lines: EnvLine[]): string {
  return lines.map(l => l.raw).join('\n');
}

/**
 * Merge a map of updates into an existing env-line list.
 * - Existing keys are updated in place (preserving line order)
 * - New keys are appended at the end
 * - Keys mapped to `null` are removed entirely
 */
export function applyEnvUpdates(
  lines: EnvLine[],
  updates: Record<string, string | null>,
): EnvLine[] {
  const seen = new Set<string>();
  const result: EnvLine[] = [];

  for (const line of lines) {
    if (line.type !== 'export' || !line.key) {
      result.push(line);
      continue;
    }
    if (line.key in updates) {
      seen.add(line.key);
      const newValue = updates[line.key];
      if (newValue === null) {
        // Drop the line entirely
        continue;
      }
      result.push({
        type: 'export',
        raw: `export ${line.key}="${escapeShellDouble(newValue)}"`,
        key: line.key,
        value: newValue,
      });
    } else {
      result.push(line);
    }
  }

  // Append any brand-new keys
  for (const key of Object.keys(updates)) {
    if (seen.has(key)) continue;
    const value = updates[key];
    if (value === null) continue;
    result.push({
      type: 'export',
      raw: `export ${key}="${escapeShellDouble(value)}"`,
      key,
      value,
    });
  }

  // Ensure file ends with a newline — the shell's `.` builtin is happy with
  // or without it, but editors and diff tools prefer a trailing newline.
  if (result.length > 0 && result[result.length - 1].raw !== '') {
    result.push({ type: 'blank', raw: '' });
  }

  return result;
}

/** Escape a value for a shell-sourced `export KEY="value"` declaration. */
function escapeShellDouble(value: string): string {
  // Inside shell double quotes, backslash, quote, dollar and backtick retain
  // special meaning. Escape all four so a persisted secret can never trigger
  // parameter expansion or command substitution when `.cds.env` is sourced.
  return value.replace(/([\\"$`])/g, '\\$1');
}

/** Inverse of `escapeShellDouble`. Applied on parse for round-trip fidelity. */
function unescapeShellDouble(value: string): string {
  return value.replace(/\\([\\"$`])/g, '$1');
}

/**
 * Read `.cds.env` at the given path. Returns an empty line list if the file
 * doesn't exist — callers can still call `applyEnvUpdates` to create fresh
 * content.
 */
export function readEnvFile(envFilePath: string): EnvLine[] {
  if (!fs.existsSync(envFilePath)) return [];
  const content = fs.readFileSync(envFilePath, 'utf-8');
  return parseEnvFile(content);
}

/**
 * Atomically write content to `envFilePath`.
 *
 * Strategy: write to a temp file in the same directory, then `rename` onto
 * the target. POSIX guarantees `rename` is atomic within the same filesystem,
 * so readers either see the old file or the new file — never a partial one.
 *
 * Side effects:
 *   - Creates parent directory if missing
 *   - Backs up existing file to `<path>.bak` before overwriting (used by the
 *     mode upgrade rollback path)
 *   - Sets mode 0600 on the output file to protect the token
 */
export function writeEnvFileAtomic(envFilePath: string, content: string): void {
  const dir = path.dirname(envFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Backup existing file if present. We must chmod the backup explicitly
  // because `copyFileSync` does NOT preserve mode bits — the destination
  // inherits from the umask (typically 0644 on Linux), which would expose
  // the bootstrap/permanent token to other users on a multi-user system.
  if (fs.existsSync(envFilePath)) {
    const backupPath = `${envFilePath}.bak`;
    const backupTmp = `${backupPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    let backupFd: number | null = null;
    try {
      backupFd = fs.openSync(backupTmp, 'wx', 0o600);
      fs.writeFileSync(backupFd, fs.readFileSync(envFilePath));
      fs.fsyncSync(backupFd);
      fs.closeSync(backupFd);
      backupFd = null;
      fs.renameSync(backupTmp, backupPath);
      fs.chmodSync(backupPath, 0o600);
      const persistedBackupFd = fs.openSync(backupPath, 'r');
      try { fs.fsyncSync(persistedBackupFd); } finally { fs.closeSync(persistedBackupFd); }
    } catch {
      // Best-effort backup; continue with the write regardless.
      if (backupFd !== null) {
        try { fs.closeSync(backupFd); } catch { /* best effort */ }
      }
      try { fs.rmSync(backupTmp, { force: true }); } catch { /* best effort */ }
    }
  }

  // Write to a sibling temp file, then rename.
  const tmpPath = `${envFilePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  let tmpFd: number | null = null;
  try {
    tmpFd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(tmpFd, content, 'utf8');
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    tmpFd = null;
    fs.renameSync(tmpPath, envFilePath);
    fs.chmodSync(envFilePath, 0o600);
    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } catch (error) {
    // A failed rename/write must not leave a plaintext secret in a sibling
    // temp file. The original target is still intact because replacement only
    // happens at rename time.
    if (tmpFd !== null) {
      try { fs.closeSync(tmpFd); } catch { /* best effort */ }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Convenience: update a set of keys in `.cds.env` in place.
 *
 *   updateEnvFile('/path/.cds.env', { CDS_MODE: 'scheduler' });
 *   updateEnvFile('/path/.cds.env', { CDS_BOOTSTRAP_TOKEN: null }); // remove
 */
export function updateEnvFile(
  envFilePath: string,
  updates: Record<string, string | null>,
): void {
  withEnvFileLock(envFilePath, () => updateEnvFileWhileLocked(envFilePath, updates));
}

/** Caller must already hold `withEnvFileLock` for this exact path. */
export function updateEnvFileWhileLocked(
  envFilePath: string,
  updates: Record<string, string | null>,
): void {
  const lines = readEnvFile(envFilePath);
  const updated = applyEnvUpdates(lines, updates);
  writeEnvFileAtomic(envFilePath, serializeEnvFile(updated));
}

/** Startup-only override shared by the loader, server routes and shell entry. */
export function explicitCdsEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = String(env.CDS_ENV_FILE || '').trim();
  return configured ? path.resolve(configured) : null;
}

/**
 * 唯一的 `.cds.env` 候选顺序。启动 loader 与全部 Node 写入端必须共用；
 * 禁止依赖数据库可热更新的 repoRoot，也禁止各自维护不同 fallback。
 */
export function cdsEnvFileCandidates(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string[] {
  const explicit = explicitCdsEnvFilePath(env);
  if (explicit) return [explicit];
  const candidates = [
    path.resolve(cwd, '.cds.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cds.env'),
  ];
  return [...new Set(candidates)];
}

/** Existing candidate wins; a fresh install writes the first canonical candidate. */
export function resolveCdsEnvFilePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const candidates = cdsEnvFileCandidates(env, cwd);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** Backward-compatible name for existing writers; delegates to the shared SSOT. */
export function defaultEnvFilePath(): string {
  return resolveCdsEnvFilePath();
}
