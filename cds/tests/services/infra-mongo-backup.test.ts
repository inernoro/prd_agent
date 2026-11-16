import { describe, expect, it } from 'vitest';
import { buildMongoBackupInvocation } from '../../src/services/infra-mongo-backup.js';

const system = { id: 'cds-state-mongo', projectId: '__system__', scope: 'system' as const,
  containerName: 'cds-infra-cds-state-mongo' };
const base = { variables: {}, outputPath: '/private/output.archive.gz' };

describe('Mongo 备份认证来源隔离', () => {
  it('系统台账无账号时沿用 CDS 的已配置认证，密码仅经 stdin 且 URI 不改变导出目标', async () => {
    const password = "fixture'password-$ only";
    const uri = `mongodb://backup:${encodeURIComponent(password)}@db.example:27018/?authSource=backup_auth&authMechanism=SCRAM-SHA-256`;
    const result = await buildMongoBackupInvocation({ ...base, service: system, systemMongoUri: uri });
    expect(result.credentialSource).toBe('cds-state-uri');
    expect(result.command).toContain('--authenticationDatabase=\'backup_auth\'');
    expect(result.command).toContain('--authenticationMechanism=\'SCRAM-SHA-256\'');
    expect(result.command).toContain("docker exec -i 'cds-infra-cds-state-mongo' mongodump");
    expect(result.command).not.toContain(password);
    expect(result.command).not.toContain('db.example');
    expect(result.command).not.toContain(uri);
    expect(result.stdin).toBe(`password: ${JSON.stringify(password)}\n`);
    expect(result.accessCheck?.command).toContain('mongosh');
    expect(result.accessCheck?.command).not.toContain(password);
    expect(result.accessCheck?.command).not.toContain('db.example');
    expect(result.accessCheck?.stdin).toBe(`${password}\n`);
  });

  it('项目 Mongo 不借用 CDS 连接的凭据，即使服务 id 相同', async () => {
    for (const service of [
      { ...system, scope: 'project' as const },
      { ...system, projectId: 'other-project' },
      { ...system, id: 'other-mongo' },
      { ...system, containerName: 'untrusted-container' },
    ]) {
      const result = await buildMongoBackupInvocation({ ...base, service, systemMongoUri: 'invalid secret URI',
        systemMongoBackupUri: 'invalid dedicated secret URI' });
      expect(result.credentialSource).toBe('none');
      expect(result.stdin).toBeUndefined();
      expect(result.accessCheck).toBeUndefined();
      expect(result.command).not.toContain('--username');
    }
  });

  it('已轮换的项目账号优先，并用所属项目变量展开', async () => {
    const result = await buildMongoBackupInvocation({ ...base,
      service: { ...system, scope: 'project', projectId: 'p1', containerName: 'cds-infra-p1-mongo',
        env: { MONGO_USERNAME: '${USER}', MONGO_PASSWORD: '${PASS}' } },
      variables: { USER: 'rotated_user', PASS: 'rotated_password' },
      systemMongoUri: 'invalid secret URI',
    });
    expect(result.credentialSource).toBe('service');
    expect(result.command).toContain("--username='rotated_user'");
    expect(result.command).not.toContain('rotated_password');
    expect(result.stdin).toBe('password: "rotated_password"\n');
    expect(result.accessCheck).toBeUndefined();
  });

  it('损坏 URI 的错误不会暴露凭据，或退回未认证导出', async () => {
    await expect(buildMongoBackupInvocation({ ...base, service: system,
      systemMongoUri: 'mongodb://user:private-secret@[invalid',
    })).rejects.toThrow('系统数据库备份认证配置无效或不受支持，本轮未导出；请联系管理员检查备份账号后重试。');
  });

  it('现有账号缺口令时保留失败，禁止用另一来源静默替换身份', async () => {
    await expect(buildMongoBackupInvocation({ ...base,
      service: { ...system, env: { MONGO_USERNAME: 'configured' } },
      systemMongoUri: 'mongodb://other:other-secret@db.example/',
    })).rejects.toThrow('数据库备份账号缺少密码；请联系管理员补全后重试。');
  });

  it('无认证的历史实例继续使用容器本地导出', async () => {
    const result = await buildMongoBackupInvocation({ ...base, service: system,
      systemMongoUri: 'mongodb://db.example/cds_state_db',
    });
    expect(result.credentialSource).toBe('none');
    expect(result.stdin).toBeUndefined();
    expect(result.command).toBe("docker exec 'cds-infra-cds-state-mongo' mongodump --archive --gzip > '/private/output.archive.gz'");
  });

  it('拒绝把多行口令交给单行密码提示通道', async () => {
    await expect(buildMongoBackupInvocation({ ...base, service: system,
      systemMongoUri: 'mongodb://backup:line1%0Aline2@db.example/?authSource=admin',
    })).rejects.toThrow('系统数据库备份密码格式不受支持，本轮未导出；请联系管理员更新备份密码后重试。');
  });

  it('独立备份认证优先于应用连接，不能改变目标或借给项目', async () => {
    const result = await buildMongoBackupInvocation({ ...base, service: system,
      systemMongoUri: 'invalid application secret URI',
      systemMongoBackupUri: 'mongodb://dedicated:dedicated-secret@ignored.example/?authSource=admin',
    });
    expect(result.credentialSource).toBe('cds-state-backup-uri');
    expect(result.command).toContain("--username='dedicated'");
    expect(result.command).not.toContain('dedicated-secret');
    expect(result.command).not.toContain('ignored.example');
    expect(result.stdin).toBe('password: "dedicated-secret"\n');
    expect(result.accessCheck).toBeDefined();
  });

  it('独立备份配置无效或无认证时不退回应用连接', async () => {
    for (const systemMongoBackupUri of ['invalid dedicated-secret', 'mongodb://ignored.example/']) {
      await expect(buildMongoBackupInvocation({ ...base, service: system, systemMongoBackupUri,
        systemMongoUri: 'mongodb://app:app-secret@db.example/',
      })).rejects.toThrow('系统数据库备份认证配置无效或不受支持，本轮未导出；请联系管理员检查备份账号后重试。');
    }
  });

  it('系统服务显式账号仍有完整权限核验，不被备份 URI 覆盖', async () => {
    const result = await buildMongoBackupInvocation({ ...base,
      service: { ...system, env: { MONGO_USERNAME: 'configured', MONGO_PASSWORD: 'configured-secret' } },
      systemMongoBackupUri: 'invalid dedicated-secret',
    });
    expect(result.credentialSource).toBe('service');
    expect(result.command).toContain("--username='configured'");
    expect(result.accessCheck).toBeDefined();
  });
});
