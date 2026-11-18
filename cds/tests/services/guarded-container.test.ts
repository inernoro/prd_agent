import { describe, it, expect, vi } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, CdsConfig, ServiceRuntimeRef } from '../../src/types.js';
const cid = 'b'.repeat(64), sha = 'a'.repeat(40), image = 'registry.example/preview@sha256:' + 'c'.repeat(64);
function fixture(overrides: Record<string, unknown> = {}) {
  const shell = new MockShellExecutor();
  shell.addResponsePattern(/docker inspect/, () => ({ stdout: JSON.stringify({
    id: cid, image, revision: sha, running: false, mounts: [], ...overrides,
  }), stderr: '', exitCode: 0 }));
  const service = new ContainerService(shell, { dockerNetwork: 'test' } as CdsConfig);
  const runtime = { containerId: cid, containerName: 'name-is-not-authority', hostPort: 1000 } as ServiceRuntimeRef;
  const own = vi.spyOn(service, 'inspectOwnedRuntime').mockResolvedValue(runtime);
  return { shell, service, runtime, own };
}
describe('guarded physical runtime identity', () => {
  it('uses the exact CID and verifies immutable image, revision, stopped state and no mounted data', async () => {
    const f = fixture();
    expect(await f.service.inspectGuardedRuntime({ id: 'branch' } as BranchEntry, 'api', f.runtime, image, sha, false)).toBe(f.runtime);
    expect(f.own).toHaveBeenCalledWith(expect.anything(), 'api', f.runtime, false);
    expect(f.shell.commands).toHaveLength(1);
    expect(f.shell.commands[0]).toContain(cid);
    expect(f.shell.commands[0]).not.toContain(f.runtime.containerName);
  });
  it.each([
    { id: 'd'.repeat(64) }, { revision: 'd'.repeat(40) }, { image: 'registry.example/preview:latest' },
    { image: 'other.example/preview@sha256:' + 'c'.repeat(64) }, { running: true },
    { mounts: [{ Type: 'bind', Source: '/synthetic/private', Destination: '/data' }] }, { mounts: null },
  ])('rejects a mismatched or unknown physical fact before mutation: %j', async value => {
    const f = fixture(value);
    await expect(f.service.inspectGuardedRuntime({ id: 'branch' } as BranchEntry, 'api', f.runtime, image, sha, false)).rejects.toThrow('物理提交');
  });
  it('an unconfirmed owner or disappeared retained container never grants control', async () => {
    const f = fixture(); f.own.mockResolvedValue(null);
    expect(await f.service.inspectGuardedRuntime({ id: 'branch' } as BranchEntry, 'api', f.runtime, image, sha, false)).toBeNull();
    expect(f.shell.commands).toEqual([]);
  });
});
