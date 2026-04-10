/**
 * .cds.env file helper — atomic read/write of the single user config file.
 *
 * The cluster bootstrap flow (see `doc/design.cds-cluster-bootstrap.md`) needs
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
import os from 'node:os';

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
    const match = raw.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))\s*$/);
    if (match) {
      const rawValue = match[2] !== undefined ? match[2] : (match[3] ?? '');
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

/** Escape a value for `export KEY="value"` — only need to escape `"` and `\`. */
function escapeShellDouble(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Inverse of `escapeShellDouble`. Applied on parse for round-trip fidelity. */
function unescapeShellDouble(value: string): string {
  // Two passes: `\"` → `"` first, then `\\` → `\`. Order matters so that
  // `\\"` (a literal backslash followed by a quote-escape) comes out as `\"`.
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
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

  // Backup existing file if present
  if (fs.existsSync(envFilePath)) {
    const backupPath = `${envFilePath}.bak`;
    try {
      fs.copyFileSync(envFilePath, backupPath);
    } catch {
      // Best-effort backup; continue with the write regardless.
    }
  }

  // Write to a sibling temp file, then rename.
  const tmpPath = `${envFilePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, envFilePath);
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
  const lines = readEnvFile(envFilePath);
  const updated = applyEnvUpdates(lines, updates);
  writeEnvFileAtomic(envFilePath, serializeEnvFile(updated));
}

/** Default `.cds.env` path resolution — prefer CDS_ENV_FILE env override. */
export function defaultEnvFilePath(): string {
  if (process.env.CDS_ENV_FILE) return process.env.CDS_ENV_FILE;
  // When CDS is started from `cds/` (via exec_cds.sh), process.cwd() = cds/
  const candidate = path.resolve(process.cwd(), '.cds.env');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: $HOME/.cds.env (for edge-case non-container installs)
  return path.join(os.homedir(), '.cds.env');
}
