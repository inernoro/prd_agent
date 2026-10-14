import { describe, expect, it, vi } from 'vitest';
import { assertOwnedReplicaMember, readReplicaReadiness } from '../../scripts/replica-confirmation-drill.js';

const owner = 'cds_acceptance_0123456789abcdef';
const member = () => ({
  Id: 'a'.repeat(64),
  Config: { Image: 'mongo:7.0', Labels: { 'cds.acceptance.owner': owner },
    Cmd: ['mongod', '--replSet', owner, '--bind_ip', '127.0.0.1', '--port', '27901'] },
  HostConfig: { NetworkMode: 'host', NanoCpus: 1_000_000_000, Memory: 1_073_741_824 },
});

describe('隔离副本演练实际可写前提', () => {
  it('拓扑已选主但直连成员仍不可写时继续等待，下一次实际读取可写才就绪', async () => {
    const command = vi.fn().mockResolvedValueOnce({ members: [{ state: 1 }, { state: 2 }, { state: 2 }] })
      .mockResolvedValueOnce({ isWritablePrimary: false })
      .mockResolvedValueOnce({ members: [{ state: 1 }, { state: 2 }, { state: 2 }] })
      .mockResolvedValueOnce({ isWritablePrimary: true });
    expect(await readReplicaReadiness({ command })).toEqual({ primaries: 1, secondaries: 2, writablePrimary: false, ready: false });
    expect(await readReplicaReadiness({ command })).toEqual({ primaries: 1, secondaries: 2, writablePrimary: true, ready: true });
    expect(command.mock.calls).toEqual([[{ replSetGetStatus: 1 }], [{ hello: 1 }], [{ replSetGetStatus: 1 }], [{ hello: 1 }]]);
  });
  it('直连可写但两个副本还未就绪时不能开始暂停多数故障', async () => {
    const command = vi.fn().mockResolvedValueOnce({ members: [{ state: 1 }, { state: 2 }, { state: 0 }] })
      .mockResolvedValueOnce({ isWritablePrimary: true });
    expect((await readReplicaReadiness({ command })).ready).toBe(false);
  });
});

describe('隔离副本演练暂停与删除的归属保护', () => {
  it('接受本次完整匹配的专用成员', () => {
    expect(() => assertOwnedReplicaMember(member(), owner, 27901)).not.toThrow();
  });
  it.each(['id', 'owner', 'image', 'network', 'cpu', 'memory', 'bind', 'replica', 'port', 'shared-port'])('拒绝%s不匹配，不能操作共享容器', (field) => {
    const target = member(); let port = 27901;
    if (field === 'id') target.Id = 'other-container';
    if (field === 'owner') target.Config.Labels['cds.acceptance.owner'] = 'another-owner';
    if (field === 'image') target.Config.Image = 'mongo:latest';
    if (field === 'network') target.HostConfig.NetworkMode = 'bridge';
    if (field === 'cpu') target.HostConfig.NanoCpus = 0;
    if (field === 'memory') target.HostConfig.Memory = 0;
    if (field === 'bind') target.Config.Cmd[4] = '0.0.0.0';
    if (field === 'replica') target.Config.Cmd[2] = 'shared';
    if (field === 'port') target.Config.Cmd[6] = '27017';
    if (field === 'shared-port') { port = 27017; target.Config.Cmd[6] = String(port); }
    expect(() => assertOwnedReplicaMember(target, owner, port)).toThrow();
  });
  it('拒绝非本次随机生成的验收身份', () => {
    expect(() => assertOwnedReplicaMember(member(), 'cds', 27901)).toThrow();
  });
});
