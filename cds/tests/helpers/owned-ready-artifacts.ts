import type { MockShellExecutor } from '../../src/services/shell-executor.js';

/** Docker protocol fixture: real schema, immutable content and exact source revision; no Daemon verdict. */
export function ownedReadyArtifacts(shell: MockShellExecutor, target: () => string): void {
  const images = new Map<string, any>();
  shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker version/, () => ({ stdout: 'amd64', stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker pull /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  shell.addResponsePattern(/docker image inspect (.+)/, ([command]) => {
    const ref = /'([^']+)'$/.exec(command)?.[1] || '';
    let info = images.get(ref);
    if (!info) {
      const sha = /:sha-([0-9a-f]{40})/.exec(ref)?.[1];
      if (!sha || sha !== target()) return { stdout: '', stderr: 'No such owned fixture artifact', exitCode: 1 };
      const id = `sha256:${sha + sha.slice(0, 24)}`, repo = ref.replace(/:sha-[0-9a-f]{40}.*$/, '');
      info = { Id: id, RepoDigests: [`${repo}@${id}`], Architecture: 'amd64', Os: 'linux', Config: { Labels: { 'org.opencontainers.image.revision': sha } } };
      images.set(ref, info); images.set(id, info);
    }
    return { stdout: command.includes('--format') ? JSON.stringify({ id: info.Id, repoDigests: info.RepoDigests,
      architecture: info.Architecture, os: info.Os, revision: info.Config.Labels['org.opencontainers.image.revision'] }) : JSON.stringify([info]), stderr: '', exitCode: 0 };
  });
}
