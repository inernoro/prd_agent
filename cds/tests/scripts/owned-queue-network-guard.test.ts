import { describe, expect, it } from 'vitest';
import { assertOwnedQueueNetworkMutation } from '../../scripts/owned-queue-network-guard.js';

describe('队列演练网络双资源归属', () => {
  const owner = 'cds_queue_owned', branch = `${owner}-branch`, cid = 'a'.repeat(64);
  function docker(args: string[]) {
    const name = args.at(-1)!;
    if (args[0] === 'network') return JSON.stringify([{ Id: 'b'.repeat(64), Name: name,
      Labels: name === 'shared' ? { 'cds.acceptance.owner': owner } : {
        'cds.type': 'replacement-network', 'cds.project.id': name === 'foreign' ? 'other' : owner, 'cds.branch.id': branch } }]);
    return JSON.stringify([{ Config: { Labels: { 'cds.acceptance.owner': name === 'foreign-cid' ? 'other' : owner,
      'cds.project.id': owner, 'cds.branch.id': branch } } }]);
  }
  it.each(['connect', 'disconnect'])('自己的CID不能授权外来网络：%s', action => {
    expect(() => assertOwnedQueueNetworkMutation(`docker network ${action} 'foreign' '${cid}'`, owner, branch, 'shared', docker)).toThrow();
  });
  it('自己的网络不能授权外来容器，即使命令包含owner', () => {
    expect(() => assertOwnedQueueNetworkMutation(`docker network connect '${owner}-net' 'foreign-cid'`, owner, branch, 'shared', docker)).toThrow();
  });
  it('有限参数解析不会把alias当成网络，两个实际资源分别核验', () => {
    expect(assertOwnedQueueNetworkMutation(`docker network connect --gw-priority -1 --alias 'foreign' '${owner}-net' '${cid}'`, owner, branch, 'shared', docker)).toBe(true);
  });
  it('共享项目网和替换网均通过实际标签核验', () => {
    expect(assertOwnedQueueNetworkMutation(`docker network connect shared ${cid}`, owner, branch, 'shared', docker)).toBe(true);
    expect(assertOwnedQueueNetworkMutation(`docker network rm '${owner}-net'`, owner, branch, 'shared', docker)).toBe(true);
  });
  it('未知选项和复合Shell拒绝执行', () => {
    expect(() => assertOwnedQueueNetworkMutation(`docker network disconnect --force shared ${cid}`, owner, branch, 'shared', docker)).toThrow();
    expect(() => assertOwnedQueueNetworkMutation(`docker network rm shared; true`, owner, branch, 'shared', docker)).toThrow();
  });
});
