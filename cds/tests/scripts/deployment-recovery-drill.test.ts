import { describe, expect, it } from 'vitest';
import { assertIsolatedDatabase, assertIsolatedCiContainer } from '../../scripts/deployment-recovery-drill.js';

describe('独立 Mongo 恢复演练目标保护', () => {
  it('只允许无凭据的127.0.0.1和独立验收数据库', () => {
    expect(() => assertIsolatedDatabase('mongodb://127.0.0.1:27017/?directConnection=true', 'cds_acceptance_12345678')).not.toThrow();
  });
  it.each([
    ['mongodb://62.146.168.225:27017/', 'cds_acceptance_12345678'],
    ['mongodb://user:password@127.0.0.1:27017/', 'cds_acceptance_12345678'],
    ['mongodb://127.0.0.1:27017/cds_state_db', 'cds_acceptance_12345678'],
    ['mongodb://127.0.0.1:27017/?readPreference=secondary', 'cds_acceptance_12345678'],
    ['mongodb://127.0.0.1:27017/', 'cds_state_db'],
  ])('拒绝非隔离目标 %s / %s', (uri, database) => {
    expect(() => assertIsolatedDatabase(uri, database)).toThrow();
  });
  const container = () => ({ State: { Running: true }, Config: { Image: 'mongo:7.0' }, NetworkSettings: { Ports: { '27017/tcp': [{ HostIp: '127.0.0.1', HostPort: '27017' }] } } });
  it('确认专用CI和实际本机端口映射后才允许访问容器', () => {
    expect(() => assertIsolatedCiContainer('mongodb://127.0.0.1:27017/', 'a'.repeat(64), container(), 'true')).not.toThrow();
  });
  it.each(['outside-ci', 'shared-port', 'stopped'])('拒绝%s环境中的数据库操作', (failure) => {
    const target = container();
    if (failure === 'shared-port') target.NetworkSettings.Ports['27017/tcp'][0].HostIp = '0.0.0.0';
    if (failure === 'stopped') target.State.Running = false;
    expect(() => assertIsolatedCiContainer('mongodb://127.0.0.1:27017/', 'a'.repeat(64), target, failure === 'outside-ci' ? undefined : 'true')).toThrow();
  });
});
