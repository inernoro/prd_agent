import assert from 'node:assert/strict';

/** 演练仅接受当前实际用到的有限网络命令格式，并核验每一个资源。 */
export function assertOwnedQueueNetworkMutation(command: string, owner: string, branchId: string,
  sharedNetwork: string | undefined, docker: (args: string[]) => string): boolean {
  if (!/^docker network (?:connect|disconnect|rm)\b/.test(command)) return false;
  const words = (command.match(/'[^']*'|[^\s]+/g) || []).map(word => word.startsWith("'") ? word.slice(1, -1) : word);
  assert.ok(words.every(word => /^[a-zA-Z0-9_.=-]+$/.test(word)), 'unsupported network command token');
  const action = words[2], positional: string[] = [];
  for (let i = 3; i < words.length; i++) {
    const word = words[i];
    if (action === 'connect' && (word === '--alias' || word === '--gw-priority')) {
      assert.ok(words[++i], 'missing network option value');
    } else { assert.ok(!word.startsWith('-'), 'unsupported network option'); positional.push(word); }
  }
  assert.equal(positional.length, action === 'rm' ? 1 : 2);
  const network = JSON.parse(docker(['network', 'inspect', positional[0]]))[0];
  if (network.Name === sharedNetwork) assert.equal(network.Labels['cds.acceptance.owner'], owner);
  else {
    assert.equal(network.Labels['cds.type'], 'replacement-network');
    assert.equal(network.Labels['cds.project.id'], owner);
    assert.equal(network.Labels['cds.branch.id'], branchId);
  }
  if (action !== 'rm') {
    const container = JSON.parse(docker(['inspect', positional[1]]))[0];
    assert.equal(container.Config.Labels['cds.acceptance.owner'], owner);
    assert.equal(container.Config.Labels['cds.project.id'], owner);
    assert.equal(container.Config.Labels['cds.branch.id'], branchId);
  }
  return true;
}
