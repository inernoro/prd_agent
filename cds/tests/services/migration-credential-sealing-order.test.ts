import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateLegacyDataMigrationCredentials, publicDataMigration } from '../../src/services/secure-database-cli.js';
import type { DataMigration } from '../../src/types.js';

/**
 * 密封旧版迁移凭据时的两处顺序要害（Codex P1 x2，2026-09-15）。两条都是
 * 「这次变更把判据自己的输入毁掉了」的同一种形状。
 */
describe('密封旧版迁移凭据的顺序', () => {
  // 密封需要密钥；没有它 sealMigrationConnections 会 fail-closed 直接抛。
  const previousKey = process.env.CDS_SECRET_KEY;
  beforeAll(() => { process.env.CDS_SECRET_KEY = 'test-sealing-key'; });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.CDS_SECRET_KEY;
    else process.env.CDS_SECRET_KEY = previousKey;
  });

  const legacy = (): DataMigration => ({
    id: 'dm_legacy',
    source: { kind: 'mongodb', uri: 'mongodb://h/db', username: 'u', password: 'p@ss-SOURCE' },
    target: { kind: 'mongodb', uri: 'mongodb://h2/db', username: 'u', password: 'p@ss-TARGET' },
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    log: 'mongodump --username u --password p@ss-SOURCE\nmongorestore --password p@ss-TARGET\n',
  } as unknown as DataMigration);

  it('先脱敏日志再密封——否则明文没了，脱敏永远抹不掉那串密码', () => {
    const migration = legacy();
    // companion：夹具确实带着明文密码与含密码的日志，否则下面的断言无意义。
    expect(migration.log).toContain('p@ss-SOURCE');

    expect(migrateLegacyDataMigrationCredentials([migration]).changed).toBe(true);

    // 密封之后明文已不在 source/target 上。
    expect(migration.source.password).toBeUndefined();
    // 日志里那两串必须在密封之前就被抹掉，否则 GET .../log 会原样吐出去。
    expect(migration.log, '密封把可比对的明文拿走了，日志里的密码从此永久暴露')
      .not.toContain('p@ss-SOURCE');
    expect(migration.log).not.toContain('p@ss-TARGET');

    // 对外投影同样不得再出现明文。
    const pub = publicDataMigration(migration);
    expect(pub.log ?? '').not.toContain('p@ss-SOURCE');
    expect(pub.log ?? '').not.toContain('p@ss-TARGET');
  });

  it('短口令也要掩掉——旗标后面那一个值不看长度', () => {
    // 创建接口对口令长度没有下限（POST /data-migrations 只校验必填字段），
    // 所以一两位的口令是合法存量。它一旦跳过脱敏，密封又把可比对的明文拿走，
    // 日志里那串密码就永久留在 GET .../log 里了（Codex P2，2026-09-15）。
    const migration = legacy();
    migration.source.password = 'ab';
    migration.target.password = 'x';
    migration.log = [
      'mongodump --username u --password ab --uri mongodb://h/db',
      "mongorestore --password 'ab'",
      'mongosh -p x --quiet',
      'redis-cli -a x --no-auth-warning',
      'connect mongodb://u:ab@h/db',
      // 自由文本里的短串不许被牵连——单字母整串替换会把整份日志抹成星号，
      // 那种「脱敏」等于毁掉日志。
      'restored 12 collections from ab-cluster into xanadu',
    ].join('\n');

    // companion：夹具确实带着短口令与含口令的命令行。
    expect(migration.log).toContain('--password ab');

    expect(migrateLegacyDataMigrationCredentials([migration]).changed).toBe(true);

    const log = migration.log ?? '';
    expect(log, '短口令跳过脱敏，密封之后这串密码就永久暴露了').not.toContain('--password ab');
    expect(log).not.toContain("--password 'ab'");
    expect(log).not.toContain('-p x ');
    expect(log).not.toContain('-a x ');
    expect(log).not.toContain('mongodb://u:ab@h/db');
    expect(log).toContain('--password ******');
    expect(log).toContain(':******@');
    // 没有旗标的那一行原样保留。
    expect(log).toContain('restored 12 collections from ab-cluster into xanadu');

    // 对外投影同样干净（两处共用同一个脱敏口径，不许各写一套）。
    const pub = publicDataMigration(migration);
    expect(pub.log ?? '').not.toContain('--password ab');
  });

  it('落盘顺序是备份在前、主文件在后——崩在中途仍可续', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/services/state.ts'),
      'utf8',
    );
    // 锚在定义而不是第一次出现——第一次出现是上面的调用点，窗口会落在方法体之前。
    const start = source.indexOf('private persistLegacyDataMigrationCredentialUpgrade()');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 4000);

    // companion：确实截到了那段（它会枚举 .bak. 备份）。
    expect(body).toContain('.bak.');

    const declared = body.indexOf('const snapshots');
    const pushBackup = body.indexOf('snapshots.push({ file: backupPath');
    const pushPrimary = body.indexOf('snapshots.push({ file: this.filePath');
    expect(declared).toBeGreaterThan(-1);
    expect(pushBackup).toBeGreaterThan(declared);
    expect(pushPrimary, '主文件必须最后入列；先写主文件的话，崩在中途会让备份里的明文永远不再被重扫')
      .toBeGreaterThan(pushBackup);
    // 声明处不得直接把主文件塞进初值（那等于又排到了第一个）。
    expect(body.slice(declared, pushBackup)).not.toContain('this.filePath');
  });
});

/**
 * 没有密封密钥时必须能开得了机（Codex P1，2026-09-16）。
 *
 * 这个迁移跑在 initStateService 里、HTTP 服务起来之前，而唯一能装上密钥的入口
 * （POST /cds-system/sealed-storage/initialize）正是那个还没起来的 HTTP 服务。
 * 在这里抛错，等于让一台「存着旧明文凭据、又没配密钥」的实例永远开不了机，
 * 连来装钥匙都做不到——用变更前的状态去 gate 那个正好能修好它的变更。
 */
describe('没有密封密钥时的启动路径', () => {
  const previousKey = process.env.CDS_SECRET_KEY;
  beforeAll(() => { delete process.env.CDS_SECRET_KEY; });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.CDS_SECRET_KEY;
    else process.env.CDS_SECRET_KEY = previousKey;
  });

  const legacy = (id: string): DataMigration => ({
    id,
    source: { kind: 'mongodb', uri: 'mongodb://h/db', username: 'u', password: 'p@ss-SOURCE' },
    target: { kind: 'mongodb', uri: 'mongodb://h2/db', username: 'u', password: 'p@ss-TARGET' },
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as DataMigration);

  it('推迟而不是抛错，实例照常起得来', () => {
    const migrations = [legacy('dm_a'), legacy('dm_b')];

    const result = migrateLegacyDataMigrationCredentials(migrations);

    expect(result.changed).toBe(false);
    expect(result.deferred).toEqual(['dm_a', 'dm_b']);
  });

  it('推迟时一个字节都不写：明文留在它本来就在的地方，等有钥匙再按原顺序升', () => {
    const migration = legacy('dm_a');

    migrateLegacyDataMigrationCredentials([migration]);

    expect(migration.source.password).toBe('p@ss-SOURCE');
    expect(migration.target.password).toBe('p@ss-TARGET');
    expect(migration.credentialsEncrypted).toBeUndefined();
  });

  it('装上密钥之后，同一份状态能正常升上去', () => {
    const migration = legacy('dm_a');
    migrateLegacyDataMigrationCredentials([migration]);

    process.env.CDS_SECRET_KEY = 'test-sealing-key';
    try {
      const result = migrateLegacyDataMigrationCredentials([migration]);
      expect(result.changed).toBe(true);
      expect(result.deferred).toEqual([]);
      expect(migration.source.password).toBeUndefined();
      expect(migration.credentialsEncrypted).toBeDefined();
    } finally {
      delete process.env.CDS_SECRET_KEY;
    }
  });

  it('明文与密封凭据同时存在仍然抛错：那是状态损坏，装钥匙也修不好', () => {
    const migration = legacy('dm_corrupt');
    (migration as unknown as { credentialsEncrypted: unknown }).credentialsEncrypted = { v: 1 };

    expect(() => migrateLegacyDataMigrationCredentials([migration])).toThrow(/同时包含明文与密封凭据/);
  });
});
