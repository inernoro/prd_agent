import { describe, expect, it } from 'vitest';
import { prepareExactPrebuiltArtifacts } from '../../src/services/prebuilt-artifact-gate.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BuildProfile } from '../../src/types.js';
const sha = 'b'.repeat(40);
const profile = (id: string): BuildProfile => ({ id, name: id, dockerImage: `ghcr.io/imp/${id}:sha-${'a'.repeat(40)}`, prebuiltImage: true, workDir: '.', command: '', containerPort: 8080 });
function shell() {
  const mock = new MockShellExecutor();
  mock.addResponsePattern(/docker pull/, () => ({ stdout: 'pulled', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker version/, () => ({ stdout: 'amd64', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify({ architecture: 'amd64', os: 'linux', revision: sha, id: `sha256:${'c'.repeat(64)}` }), stderr: '', exitCode: 0 }));
  return mock;
}
describe('P1 exact artifact admission', () => {
  it('checks the entire requested collection against the exact SHA without mutating profiles', async () => {
    const mock = shell(); const input = [profile('api'), profile('worker')];
    const ready = await prepareExactPrebuiltArtifacts(mock, input, sha);
    expect(ready.map(item => item.dockerImage)).toEqual(input.map(item => `ghcr.io/imp/${item.id}:sha-${sha}`));
    expect(input[0].dockerImage).toContain('a'.repeat(40));
    expect(mock.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(2);
    expect(mock.commands.some(command => /docker (rm|run|create)/.test(command))).toBe(false);
  });
  it('preserves a pinned registry digest and verifies its original commit instead of rewriting identity', async () => {
    const mock = shell(); const image = `ghcr.io/imp/api@sha256:${'d'.repeat(64)}`;
    mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify({ architecture: 'amd64', os: 'linux', revision: sha, id: `sha256:${'c'.repeat(64)}`, repoDigests: [image] }), stderr: '', exitCode: 0 }));
    const [ready] = await prepareExactPrebuiltArtifacts(mock, [{ ...profile('api'), dockerImage: image }], sha);
    expect(mock.commands.filter(command => command.startsWith('docker pull'))).toEqual([`docker pull '${image}'`]);
    expect(ready.dockerImage).toBe(image);
    expect(ready.preparedArtifactRef).toBe(image);
  });
  it('refuses a cached execution ID that has the target SHA but does not belong to the pinned digest', async () => {
    const mock = shell(); const image = `ghcr.io/imp/api@sha256:${'d'.repeat(64)}`;
    mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify({ architecture: 'amd64', os: 'linux', revision: sha, id: `sha256:${'c'.repeat(64)}`, repoDigests: [`ghcr.io/imp/api@sha256:${'e'.repeat(64)}`] }), stderr: '', exitCode: 0 }));
    await expect(prepareExactPrebuiltArtifacts(mock, [{ ...profile('api'), dockerImage: image,
      preparedArtifactId: `sha256:${'c'.repeat(64)}`, preparedCommitSha: sha }], sha)).rejects.toThrow('artifact_identity_mismatch');
  });
  it('fails missing artifacts and never tries another SHA, source image or destructive command', async () => {
    const mock = shell();
    mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
    await expect(prepareExactPrebuiltArtifacts(mock, [profile('api')], sha)).rejects.toThrow('artifact_pull_failed');
    expect(mock.commands.filter(command => command.startsWith('docker pull'))).toEqual([`docker pull 'ghcr.io/imp/api:sha-${sha}'`]);
  });
  it('rejects unsupported architecture and mislabelled revisions after a successful authenticated pull', async () => {
    for (const metadata of [{ architecture: 'arm64', os: 'linux', revision: sha }, { architecture: 'amd64', os: 'linux', revision: 'a'.repeat(40) }]) {
      const mock = shell(); mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify(metadata), stderr: '', exitCode: 0 }));
      await expect(prepareExactPrebuiltArtifacts(mock, [profile('api')], sha)).rejects.toThrow('artifact_identity_mismatch');
    }
  });
  it('fails closed before touching Docker when exact target identity is missing or cancelled', async () => {
    const mock = shell();
    await expect(prepareExactPrebuiltArtifacts(mock, [profile('api')], 'short')).rejects.toThrow('artifact_target_invalid');
    const abort = new AbortController(); abort.abort();
    await expect(prepareExactPrebuiltArtifacts(mock, [profile('api')], sha, { signal: abort.signal })).rejects.toThrow('artifact_cancelled');
    expect(mock.commands).toEqual([]);
  });
});
