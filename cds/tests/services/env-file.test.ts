import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseEnvFile,
  serializeEnvFile,
  applyEnvUpdates,
  readEnvFile,
  writeEnvFileAtomic,
  updateEnvFile,
  withEnvFileLock,
  cdsEnvFileCandidates,
  resolveCdsEnvFilePath,
} from '../../src/services/env-file.js';

/**
 * Tests for the .cds.env file helper — used by the cluster bootstrap flow
 * to mutate CDS_MODE, executor tokens, and bootstrap tokens atomically.
 */

describe('env-file helper', () => {
  let tmpDir: string;
  let envFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-env-test-'));
    envFile = path.join(tmpDir, '.cds.env');
  });

  describe('env file path SSOT', () => {
    it('忽略可热更新的 CDS_REPO_ROOT 并以启动 cwd 为默认权威', () => {
      const env = { CDS_REPO_ROOT: '/mnt/hot-updated-repositories' };
      fs.writeFileSync(envFile, 'export CDS_SECRET_KEY="value"\n', { mode: 0o600 });

      expect(cdsEnvFileCandidates(env, tmpDir)[0]).toBe(envFile);
      expect(resolveCdsEnvFilePath(env, tmpDir)).toBe(envFile);
      expect(resolveCdsEnvFilePath(env, tmpDir)).not.toContain('/mnt/hot-updated-repositories');
    });

    it('外部 CDS_ENV_FILE 是唯一覆盖且不会追加其他 fallback', () => {
      const selected = path.join(tmpDir, 'selected.env');
      expect(cdsEnvFileCandidates({ CDS_ENV_FILE: selected }, '/ignored')).toEqual([selected]);
      expect(resolveCdsEnvFilePath({ CDS_ENV_FILE: selected }, '/ignored')).toBe(selected);
    });

    it('cwd 无文件时 loader 与 writer 共享同一个模块候选', () => {
      const candidates = cdsEnvFileCandidates({}, tmpDir);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toBe(envFile);
      expect(candidates[1]).toBe(path.resolve(process.cwd(), '.cds.env'));
      expect(resolveCdsEnvFilePath({}, tmpDir)).toBe(candidates[0]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ── parseEnvFile ──

  describe('parseEnvFile', () => {
    it('handles comments, blanks, quoted and unquoted exports', () => {
      const content = [
        '# Comment at top',
        '',
        'export CDS_MODE="scheduler"',
        'export PORT=9900',
        '  # Indented comment',
        '',
        'export EMPTY=""',
      ].join('\n');

      const lines = parseEnvFile(content);

      expect(lines).toHaveLength(7);
      expect(lines[0]).toMatchObject({ type: 'comment' });
      expect(lines[1]).toMatchObject({ type: 'blank' });
      expect(lines[2]).toMatchObject({ type: 'export', key: 'CDS_MODE', value: 'scheduler' });
      expect(lines[3]).toMatchObject({ type: 'export', key: 'PORT', value: '9900' });
      expect(lines[4]).toMatchObject({ type: 'comment' });
      expect(lines[5]).toMatchObject({ type: 'blank' });
      expect(lines[6]).toMatchObject({ type: 'export', key: 'EMPTY', value: '' });
    });

    it('preserves unknown lines as comments so user content is not lost', () => {
      const content = [
        'export VALID="ok"',
        'this is totally not a valid env line',
        'SOMETHING_WITHOUT_EXPORT=value',
      ].join('\n');

      const lines = parseEnvFile(content);

      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ type: 'export', key: 'VALID', value: 'ok' });
      // Unknown lines preserved as comments (not dropped)
      expect(lines[1].type).toBe('comment');
      expect(lines[1].raw).toBe('this is totally not a valid env line');
      expect(lines[2].type).toBe('comment');
      expect(lines[2].raw).toBe('SOMETHING_WITHOUT_EXPORT=value');
    });
  });

  // ── applyEnvUpdates ──

  describe('applyEnvUpdates', () => {
    it('updates an existing key in place, preserving order', () => {
      const lines = parseEnvFile([
        '# header',
        'export A="1"',
        'export B="2"',
        'export C="3"',
      ].join('\n'));

      const updated = applyEnvUpdates(lines, { B: 'two' });

      // Find the B line and confirm it was updated in place
      const exports = updated.filter(l => l.type === 'export');
      expect(exports.map(l => l.key)).toEqual(['A', 'B', 'C']);
      const bLine = exports.find(l => l.key === 'B');
      expect(bLine?.value).toBe('two');
      expect(bLine?.raw).toContain('export B="two"');
    });

    it('appends brand-new keys at the end', () => {
      const lines = parseEnvFile('export EXISTING="yes"');

      const updated = applyEnvUpdates(lines, { NEW_KEY: 'added' });
      const exports = updated.filter(l => l.type === 'export');

      expect(exports).toHaveLength(2);
      expect(exports[0].key).toBe('EXISTING');
      expect(exports[1].key).toBe('NEW_KEY');
      expect(exports[1].value).toBe('added');
    });

    it('removes a key when its update value is null', () => {
      const lines = parseEnvFile([
        'export KEEP="a"',
        'export DROP="b"',
        'export ALSO="c"',
      ].join('\n'));

      const updated = applyEnvUpdates(lines, { DROP: null });
      const exports = updated.filter(l => l.type === 'export');

      expect(exports.map(l => l.key)).toEqual(['KEEP', 'ALSO']);
    });

    it('round-trips: parse → apply → serialize → parse gives same key/value set', () => {
      const original = parseEnvFile([
        '# comment',
        'export FOO="bar"',
        '',
        'export NUM=42',
      ].join('\n'));

      const applied = applyEnvUpdates(original, { FOO: 'baz', NEW: 'hello' });
      const serialized = serializeEnvFile(applied);
      const reparsed = parseEnvFile(serialized);

      const values: Record<string, string> = {};
      for (const line of reparsed) {
        if (line.type === 'export' && line.key) {
          values[line.key] = line.value!;
        }
      }
      expect(values).toEqual({ FOO: 'baz', NUM: '42', NEW: 'hello' });
    });
  });

  // ── updateEnvFile & writeEnvFileAtomic ──

  describe('updateEnvFile', () => {
    it('writes atomically via a temp file in the target directory', () => {
      updateEnvFile(envFile, { CDS_MODE: 'scheduler' });

      expect(fs.existsSync(envFile)).toBe(true);
      const content = fs.readFileSync(envFile, 'utf-8');
      expect(content).toContain('export CDS_MODE="scheduler"');

      // No leftover temp files should remain in the directory
      const entries = fs.readdirSync(tmpDir);
      const temps = entries.filter(e => e.includes('.tmp.'));
      expect(temps).toEqual([]);
    });

    it('is idempotent — running twice with same updates produces the same file', () => {
      updateEnvFile(envFile, { KEY: 'value' });
      const first = fs.readFileSync(envFile, 'utf-8');
      updateEnvFile(envFile, { KEY: 'value' });
      const second = fs.readFileSync(envFile, 'utf-8');
      expect(first).toBe(second);
    });

    it('所有更新共用跨进程锁，锁已存在时不覆盖环境文件', () => {
      fs.writeFileSync(envFile, 'export KEEP="original"\n', { mode: 0o600 });
      fs.mkdirSync(`${envFile}.write.lock`, { mode: 0o700 });
      fs.writeFileSync(
        path.join(`${envFile}.write.lock`, 'owner'),
        `${process.pid}\nother-process\n`,
        { mode: 0o600 },
      );
      expect(() => updateEnvFile(envFile, { KEEP: 'changed' })).toThrow(/另一进程更新/);
      expect(fs.readFileSync(envFile, 'utf8')).toContain('KEEP="original"');
    });

    it('即使 owner PID 已退出也拒绝自动接管残留锁', () => {
      fs.writeFileSync(envFile, 'export KEEP="original"\n', { mode: 0o600 });
      fs.mkdirSync(`${envFile}.write.lock`, { mode: 0o700 });
      fs.writeFileSync(
        path.join(`${envFile}.write.lock`, 'owner'),
        '2147483647\nstale-owner\n',
        { mode: 0o600 },
      );
      expect(() => updateEnvFile(envFile, { KEEP: 'changed' })).toThrow(/另一进程更新/);
      expect(fs.readFileSync(envFile, 'utf8')).toContain('KEEP="original"');
    });

    it('释放锁时不删除被替换的其他 owner 锁', () => {
      const lockPath = `${envFile}.write.lock`;
      withEnvFileLock(envFile, () => {
        fs.rmSync(path.join(lockPath, 'owner'));
        fs.rmdirSync(lockPath);
        fs.mkdirSync(lockPath, { mode: 0o700 });
        fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\nreplacement-owner\n`, { mode: 0o600 });
      });
      expect(fs.readFileSync(path.join(lockPath, 'owner'), 'utf8')).toContain('replacement-owner');
    });

    it('Node 持锁时外部 Shell 进程无法取得同一目录锁', () => {
      const lockPath = `${envFile}.write.lock`;
      withEnvFileLock(envFile, () => {
        const shell = spawnSync('mkdir', [lockPath], { encoding: 'utf8' });
        expect(shell.status).not.toBe(0);
      });
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('escapes embedded double quotes on serialize and preserves the raw line across updates', () => {
      const tricky = 'value with "quotes" inside';
      updateEnvFile(envFile, { TRICKY: tricky });

      // The raw serialized form must contain the backslash-escaped quote
      // so that a shell `source` on the file sees the original string.
      const raw = fs.readFileSync(envFile, 'utf-8');
      expect(raw).toContain('\\"');
      expect(raw).toContain('export TRICKY=');

      // Round-tripping via updateEnvFile → readEnvFile: because the
      // parser's regex doesn't unescape inner quotes, the TRICKY line is
      // preserved verbatim via the fallback "unknown line → keep as
      // comment" path. The important thing is that a second updateEnvFile
      // call doesn't clobber unrelated keys and the original raw bytes
      // for TRICKY are still on disk.
      const lines = readEnvFile(envFile);
      const trickyLine = lines.find(l => l.raw.includes('TRICKY'));
      expect(trickyLine).toBeDefined();
      expect(trickyLine?.raw).toContain('\\"');

      updateEnvFile(envFile, { OTHER: 'ok' });
      const reread = fs.readFileSync(envFile, 'utf-8');
      expect(reread).toContain('TRICKY');
      expect(reread).toContain('\\"');
      expect(reread).toContain('export OTHER="ok"');
    });

    it('转义 dollar 和 backtick，避免 source .cds.env 时发生展开或命令替换', () => {
      const value = 'prefix$HOME`id`\\suffix';
      updateEnvFile(envFile, { CDS_SECRET_KEY: value });

      const raw = fs.readFileSync(envFile, 'utf8');
      expect(raw).toContain('prefix\\$HOME\\`id\\`\\\\suffix');
      const parsed = readEnvFile(envFile).find((line) => line.key === 'CDS_SECRET_KEY');
      expect(parsed?.value).toBe(value);
    });
  });

  describe('writeEnvFileAtomic', () => {
    it('creates a .bak backup when overwriting an existing file', () => {
      // First write
      writeEnvFileAtomic(envFile, 'export A="first"\n');
      expect(fs.existsSync(envFile)).toBe(true);

      // Overwrite — backup should now exist
      writeEnvFileAtomic(envFile, 'export A="second"\n');

      const backupPath = `${envFile}.bak`;
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toContain('first');
      expect(fs.readFileSync(envFile, 'utf-8')).toContain('second');
    });

    it('creates parent directory if it does not exist', () => {
      const nested = path.join(tmpDir, 'nested', 'subdir', '.cds.env');
      writeEnvFileAtomic(nested, 'export X="1"\n');
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('sets restrictive 0600 permissions on the output file', () => {
      // Skip on platforms that don't support POSIX file modes (e.g. Windows)
      if (process.platform === 'win32') return;
      writeEnvFileAtomic(envFile, 'export TOKEN="secret"\n');
      const stat = fs.statSync(envFile);
      // Mask off the file-type bits; just check the low 9 perm bits
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('also sets 0600 on the .bak backup file (regression: #6)', () => {
      // Skip on platforms that don't support POSIX file modes
      if (process.platform === 'win32') return;
      // First write — no backup yet
      writeEnvFileAtomic(envFile, 'export TOKEN="v1"\n');
      // Second write — should produce a backup of the first
      writeEnvFileAtomic(envFile, 'export TOKEN="v2"\n');

      const backupPath = `${envFile}.bak`;
      expect(fs.existsSync(backupPath)).toBe(true);
      const backupMode = fs.statSync(backupPath).mode & 0o777;
      // .bak must be 0600 — copyFileSync alone leaves it at umask default
      // (typically 0644 on Linux), exposing the token to other users on a
      // multi-user host. We chmod explicitly after copy.
      expect(backupMode).toBe(0o600);
    });

    it('rename 失败时保留原文件并删除含敏感值的临时文件', () => {
      writeEnvFileAtomic(envFile, 'export TOKEN="old-value"\n');
      const renameSync = fs.renameSync.bind(fs);
      vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
        if (String(target) === envFile) throw new Error('simulated rename failure');
        return renameSync(source, target);
      });

      expect(() => writeEnvFileAtomic(envFile, 'export TOKEN="new-sensitive-value"\n'))
        .toThrow(/simulated rename failure/);
      expect(fs.readFileSync(envFile, 'utf8')).toContain('old-value');
      expect(fs.readFileSync(envFile, 'utf8')).not.toContain('new-sensitive-value');
      expect(fs.readdirSync(tmpDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
    });
  });

  // ── serializeEnvFile ──

  describe('serializeEnvFile', () => {
    it('joins lines with newline in the order they appear', () => {
      const lines = parseEnvFile([
        '# top',
        'export A="1"',
        '',
        'export B="2"',
      ].join('\n'));

      const serialized = serializeEnvFile(lines);
      const parts = serialized.split('\n');
      expect(parts[0]).toBe('# top');
      expect(parts[1]).toBe('export A="1"');
      expect(parts[2]).toBe('');
      expect(parts[3]).toBe('export B="2"');
    });
  });
});
