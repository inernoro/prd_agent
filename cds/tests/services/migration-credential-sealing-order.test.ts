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

    expect(migrateLegacyDataMigrationCredentials([migration])).toBe(true);

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
