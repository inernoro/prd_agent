import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataMigration, MongoConnectionConfig } from '../../src/types.js';
import { StateService } from '../../src/services/state.js';
import {
  buildSecureMongoHostInvocation,
  buildSecureRedisDockerInvocation,
  clearMigrationCredentials,
  describeSecureInvocation,
  publicDataMigration,
  redactSecretValues,
  sealMigrationConnections,
  unsealMigrationConnections,
} from '../../src/services/secure-database-cli.js';

const originalSecretKey = process.env.CDS_SECRET_KEY;

afterEach(() => {
  if (originalSecretKey === undefined) delete process.env.CDS_SECRET_KEY;
  else process.env.CDS_SECRET_KEY = originalSecretKey;
});

function connection(password?: string): MongoConnectionConfig {
  return {
    type: 'remote',
    host: 'mongo.internal',
    port: 27017,
    database: 'app',
    username: 'app',
    password,
    authDatabase: 'admin',
  };
}

describe('secure database CLI invocation', () => {
  it('keeps the audited route sources free of password-bearing Mongo/Redis commands', () => {
    const files = [
      'src/routes/infra-data.ts',
      'src/routes/infra-backup.ts',
      'src/routes/branches.ts',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/mongodump[^\n`]*(?:--uri|--password)/);
      expect(source, file).not.toMatch(/mongorestore[^\n`]*(?:--uri|--password)/);
      expect(source, file).not.toMatch(/redis-cli[^\n`]{0,160}['"]-a['"]/);
    }
  });

  it('keeps Mongo and Redis canary secrets out of argv and display logs', () => {
    const mongoSecret = 'mongo-canary-argv-log';
    const redisSecret = 'redis-canary-argv-log';
    const mongo = buildSecureMongoHostInvocation(
      'mongodump',
      ['--host', 'mongo.internal', '--archive', '--gzip'],
      mongoSecret,
    );
    const redis = buildSecureRedisDockerInvocation('redis-main', ['PING'], redisSecret);

    for (const [invocation, secret] of [[mongo, mongoSecret], [redis, redisSecret]] as const) {
      expect(JSON.stringify([invocation.command, ...invocation.argv])).not.toContain(secret);
      expect(describeSecureInvocation(invocation)).not.toContain(secret);
    }
    expect(mongo.stdinPrefix).not.toContain(mongoSecret);
    expect(redis.stdinPrefix).not.toContain(redisSecret);
    expect(redactSecretValues(`failed: ${mongoSecret}`, [mongoSecret])).toBe('failed: ******');
  });

  it('uses the mongosh stdin password prompt without config or a secret-bearing argv', async () => {
    const secret = 'mongosh-canary-stdin-only';
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-secure-mongosh-test-'));
    const fakeTool = path.join(box, 'mongosh');
    fs.writeFileSync(fakeTool, [
      '#!/bin/sh',
      'printf "ARGV=%s\\n" "$*"',
      'last_arg=""',
      'for arg in "$@"; do last_arg="$arg"; done',
      '[ "$last_arg" = "--password" ] || exit 41',
      'IFS= read -r supplied_password',
      '[ "$supplied_password" = "mongosh-canary-stdin-only" ] || exit 42',
      'printf "AUTH=accepted\\n"',
    ].join('\n'), { mode: 0o700 });

    try {
      const invocation = buildSecureMongoHostInvocation(
        'mongosh',
        ['--host', 'mongo.internal', '--eval', 'db.adminCommand({ping:1})', '--quiet'],
        secret,
      );
      const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.argv, {
          env: { ...process.env, PATH: `${box}:${process.env.PATH || ''}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
        child.stdin.end(invocation.stdinPrefix);
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('AUTH=accepted');
      expect(result.stdout).not.toContain(secret);
      expect(invocation.argv).toContain('--password');
      expect(invocation.argv).not.toContain('--config');
      expect(JSON.stringify(invocation.argv)).not.toContain(secret);
      expect(invocation.stdinPrefix).toBe(`${secret}\n`);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  it('creates a mode-600 Mongo config and removes it after a failing tool exits', async () => {
    const secret = 'mongo-canary-cleanup';
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-secure-mongo-test-'));
    const fakeTool = path.join(box, 'mongodump');
    fs.writeFileSync(fakeTool, [
      '#!/bin/sh',
      'config=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--config" ]; then config="$2"; shift 2; else shift; fi',
      'done',
      'printf "CONFIG_PATH=%s\\n" "$config"',
      'printf "CONFIG_MODE=%s\\n" "$(stat -f %Lp "$config" 2>/dev/null || stat -c %a "$config")"',
      'grep -q "mongo-canary-cleanup" "$config"',
      'exit 23',
    ].join('\n'), { mode: 0o700 });

    try {
      const invocation = buildSecureMongoHostInvocation('mongodump', ['--archive'], secret);
      const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.argv, {
          env: { ...process.env, PATH: `${box}:${process.env.PATH || ''}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
        child.stdin.end(invocation.stdinPrefix);
      });

      expect(result.code).toBe(23);
      expect(result.stdout).toContain('CONFIG_MODE=600');
      const configPath = result.stdout.match(/CONFIG_PATH=(.+)/)?.[1]?.trim();
      expect(configPath).toBeTruthy();
      expect(fs.existsSync(configPath!)).toBe(false);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});

describe('sealed data migration credentials', () => {
  it('fails closed when sealing is disabled', () => {
    delete process.env.CDS_SECRET_KEY;
    expect(() => sealMigrationConnections(connection('must-not-persist'), connection()))
      .toThrow(/CDS_SECRET_KEY/);
  });

  it('survives JSON persistence and restart-style rehydration without exposing canaries', () => {
    process.env.CDS_SECRET_KEY = '7af3ce4ff2a9e3210d7648c75403a621776cf378d140f213963b68246ca07919';
    const sourceSecret = 'source-canary-state-response';
    const targetSecret = 'target-canary-state-response';
    const sealed = sealMigrationConnections(connection(sourceSecret), connection(targetSecret));
    const migration: DataMigration = {
      id: 'migration-1',
      name: '可恢复迁移',
      dbType: 'mongodb',
      source: sealed.source,
      target: sealed.target,
      credentialsEncrypted: sealed.credentialsEncrypted,
      status: 'pending',
      progress: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
    };

    const persisted = JSON.stringify(migration);
    expect(persisted).not.toContain(sourceSecret);
    expect(persisted).not.toContain(targetSecret);

    const restarted = JSON.parse(persisted) as DataMigration;
    const hydrated = unsealMigrationConnections(restarted);
    expect(hydrated.source.password).toBe(sourceSecret);
    expect(hydrated.target.password).toBe(targetSecret);

    const publicJson = JSON.stringify(publicDataMigration(restarted));
    expect(publicJson).not.toContain(sourceSecret);
    expect(publicJson).not.toContain(targetSecret);
    expect(publicJson).not.toContain('credentialsEncrypted');
    expect(publicJson).not.toContain('__sealed');
    expect(publicJson).not.toContain('password');

    clearMigrationCredentials(restarted);
    expect(JSON.stringify(restarted)).not.toContain('credentialsEncrypted');
    expect(() => unsealMigrationConnections(restarted)).not.toThrow();
  });

  it('migrates legacy plaintext state and rolling backups before restart completes', async () => {
    const sourceSecret = 'legacy-source-canary-disk';
    const targetSecret = 'legacy-target-canary-disk';
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-migration-state-test-'));
    const statePath = path.join(box, 'state.json');
    const backupPath = `${statePath}.bak.legacy`;
    const legacy: DataMigration = {
      id: 'legacy-migration',
      name: '旧迁移任务',
      dbType: 'mongodb',
      source: connection(sourceSecret),
      target: connection(targetSecret),
      status: 'pending',
      progress: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
    };

    const legacyState = new StateService(statePath, box);
    legacyState.load();
    legacyState.addDataMigration(legacy);
    legacyState.save();
    await legacyState.flush();
    fs.copyFileSync(statePath, backupPath);
    expect(fs.readFileSync(statePath, 'utf8')).toContain(sourceSecret);

    process.env.CDS_SECRET_KEY = '7af3ce4ff2a9e3210d7648c75403a621776cf378d140f213963b68246ca07919';
    const restarted = new StateService(statePath, box);
    restarted.load();
    await restarted.flush();

    try {
      for (const file of [statePath, backupPath]) {
        const serialized = fs.readFileSync(file, 'utf8');
        expect(serialized).not.toContain(sourceSecret);
        expect(serialized).not.toContain(targetSecret);
        expect(serialized).toContain('credentialsEncrypted');
      }
      const hydrated = unsealMigrationConnections(restarted.getDataMigration('legacy-migration')!);
      expect(hydrated.source.password).toBe(sourceSecret);
      expect(hydrated.target.password).toBe(targetSecret);
      expect(JSON.stringify(publicDataMigration(restarted.getDataMigration('legacy-migration')!))).not.toContain(sourceSecret);
    } finally {
      await restarted.flush();
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  it('refuses to load legacy plaintext migration state without a sealing key', async () => {
    delete process.env.CDS_SECRET_KEY;
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-migration-fail-closed-test-'));
    const statePath = path.join(box, 'state.json');
    const state = new StateService(statePath, box);
    state.load();
    state.addDataMigration({
      id: 'legacy-without-key',
      name: '必须阻断',
      dbType: 'mongodb',
      source: connection('legacy-no-key-canary'),
      target: connection(),
      status: 'pending',
      progress: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
    });
    state.save();
    await state.flush();

    try {
      expect(() => new StateService(statePath, box).load()).toThrow(/CDS_SECRET_KEY/);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});
