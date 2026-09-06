import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  describeSealedStorage,
  initializeSealedStorage,
  SealedStorageBootstrapError,
} from '../../src/services/sealed-storage-bootstrap.js';

describe('sealed-storage-bootstrap service', () => {
  let dir: string;
  let envFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-seal-service-'));
    envFile = path.join(dir, '.cds.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('磁盘 key 与运行时 key 冲突时拒绝覆盖两边', () => {
    fs.writeFileSync(envFile, 'export CDS_SECRET_KEY="disk-key"\n', { mode: 0o600 });
    const env = { CDS_SECRET_KEY: 'runtime-key' };
    expect(() => initializeSealedStorage({ env, envFilePath: () => envFile }))
      .toThrowError(SealedStorageBootstrapError);
    expect(env.CDS_SECRET_KEY).toBe('runtime-key');
    expect(fs.readFileSync(envFile, 'utf8')).toContain('disk-key');
    expect(fs.readFileSync(envFile, 'utf8')).not.toContain('runtime-key');
  });

  it('单引号磁盘 key 也参与冲突校验且不能被运行时覆盖', () => {
    const diskSecret = 'aa'.repeat(32);
    const runtimeSecret = 'bb'.repeat(32);
    fs.writeFileSync(envFile, `export CDS_SECRET_KEY='${diskSecret}'\n`, { mode: 0o600 });
    const env = { CDS_SECRET_KEY: runtimeSecret };

    expect(() => initializeSealedStorage({ env, envFilePath: () => envFile }))
      .toThrowError(/不一致/);
    expect(env.CDS_SECRET_KEY).toBe(runtimeSecret);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(diskSecret);
    expect(fs.readFileSync(envFile, 'utf8')).not.toContain(runtimeSecret);
  });

  it('单引号磁盘 key 可原样激活且不会生成第二把 key', () => {
    const diskSecret = 'cd'.repeat(32);
    fs.writeFileSync(envFile, `export CDS_SECRET_KEY='${diskSecret}'\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    let generated = 0;

    const before = describeSealedStorage({ env, envFilePath: () => envFile });
    expect(before).toMatchObject({ enabled: false, persisted: false, restartRequired: true });
    const after = initializeSealedStorage({
      env,
      envFilePath: () => envFile,
      randomBytes: () => {
        generated++;
        return Buffer.alloc(32, 0x41);
      },
    });

    expect(after).toMatchObject({ enabled: true, persisted: true, restartRequired: false });
    expect(env.CDS_SECRET_KEY).toBe(diskSecret);
    expect(generated).toBe(0);
  });

  it('持久化失败时不激活新 key，也不留下临时文件', () => {
    const blockingParent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blockingParent, 'block');
    const impossibleEnvFile = path.join(blockingParent, '.cds.env');
    const env: NodeJS.ProcessEnv = {};
    expect(() => initializeSealedStorage({
      env,
      envFilePath: () => impossibleEnvFile,
      randomBytes: () => Buffer.alloc(32, 0x41),
    })).toThrowError(/未持久化/);
    expect(env.CDS_SECRET_KEY).toBeUndefined();
    expect(fs.readdirSync(dir).some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('状态查询不返回 key，磁盘有 key 但当前进程未加载时标记需要重启', () => {
    fs.writeFileSync(envFile, 'export CDS_SECRET_KEY="disk-only-key"\n', { mode: 0o600 });
    const status = describeSealedStorage({ env: {}, envFilePath: () => envFile });
    expect(status).toMatchObject({ enabled: false, persisted: false, restartRequired: true });
    expect(status.fingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(JSON.stringify(status)).not.toContain('disk-only-key');
  });

  it('拒绝换行或过短的已有运行时 key，不会谎报持久化', () => {
    for (const invalid of ['short-key', `a${'b'.repeat(31)}\nnext-line`]) {
      const env = { CDS_SECRET_KEY: invalid };
      expect(() => initializeSealedStorage({ env, envFilePath: () => envFile }))
        .toThrowError(/不满足持久化要求/);
      expect(env.CDS_SECRET_KEY).toBe(invalid);
      expect(fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').not.toContain(invalid);
    }
  });

  it('跨进程初始化锁存在时快速拒绝，不生成或激活第二把 key', () => {
    const lockPath = `${envFile}.write.lock`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner'), `${process.pid}\nowner\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    let generated = 0;
    expect(() => initializeSealedStorage({
      env,
      envFilePath: () => envFile,
      randomBytes: () => {
        generated++;
        return Buffer.alloc(32, 0x41);
      },
    })).toThrowError(/另一个 CDS 进程/);
    expect(generated).toBe(0);
    expect(env.CDS_SECRET_KEY).toBeUndefined();
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('新进程启动器会从标准 .cds.env 恢复同一 key', () => {
    const secret = 'ab'.repeat(32);
    fs.writeFileSync(envFile, `export CDS_SECRET_KEY="${secret}"\n`, { mode: 0o600 });
    const loaderUrl = pathToFileURL(path.resolve(process.cwd(), 'src/load-env.ts')).href;
    const tsxLoader = path.resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs');
    const body = [
      `await import('${loaderUrl}')`,
      `if (process.env.CDS_SECRET_KEY !== '${secret}') process.exit(7)`,
      "process.stdout.write('loaded')",
    ].join(';');
    const script = `(async () => { ${body} })().catch(() => process.exit(8))`;
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--eval', script], {
      cwd: dir,
      env: { ...process.env, CDS_ENV_FILE: '', CDS_SECRET_KEY: '' },
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('loaded');
  });

  it('新进程只接受外部 CDS_ENV_FILE 覆盖并忽略文件内自重定向', () => {
    const selected = path.join(dir, 'selected.env');
    const selectedSecret = 'ef'.repeat(32);
    const ignoredSecret = '12'.repeat(32);
    fs.writeFileSync(selected, [
      'export CDS_ENV_FILE="/tmp/untrusted-redirect.env"',
      `export CDS_SECRET_KEY="${selectedSecret}"`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(envFile, `export CDS_SECRET_KEY="${ignoredSecret}"\n`, { mode: 0o600 });
    const loaderUrl = pathToFileURL(path.resolve(process.cwd(), 'src/load-env.ts')).href;
    const tsxLoader = path.resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs');
    const script = `(async () => { await import('${loaderUrl}');`
      + `if (process.env.CDS_SECRET_KEY !== '${selectedSecret}') process.exit(7);`
      + `if (process.env.CDS_ENV_FILE !== '${selected}') process.exit(8);`
      + `process.stdout.write('selected'); })().catch(() => process.exit(9))`;
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--eval', script], {
      cwd: dir,
      env: { ...process.env, CDS_ENV_FILE: selected, CDS_SECRET_KEY: '' },
      encoding: 'utf8',
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('selected');
  });

  it('标准文件内的 CDS_ENV_FILE 不能污染子进程配置权威', () => {
    const secret = '34'.repeat(32);
    fs.writeFileSync(envFile, [
      'export CDS_ENV_FILE="/tmp/untrusted-redirect.env"',
      `export CDS_SECRET_KEY="${secret}"`,
      '',
    ].join('\n'), { mode: 0o600 });
    const loaderUrl = pathToFileURL(path.resolve(process.cwd(), 'src/load-env.ts')).href;
    const tsxLoader = path.resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs');
    const script = `(async () => { await import('${loaderUrl}');`
      + `if (process.env.CDS_SECRET_KEY !== '${secret}') process.exit(7);`
      + `if (process.env.CDS_ENV_FILE) process.exit(8);`
      + `process.stdout.write('ignored'); })().catch(() => process.exit(9))`;
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--eval', script], {
      cwd: dir,
      env: { ...process.env, CDS_ENV_FILE: '', CDS_SECRET_KEY: '' },
      encoding: 'utf8',
    });

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('ignored');
  });
});
