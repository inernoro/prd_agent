import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type LocalRemoval = { mergeCommitSha: string; parentCommitSha: string; observedHeadSha: string };
export type PlanningFileAnchorProbe = (projectId: string, repository: string, branch: string,
  files: readonly string[], mergedCommits: ReadonlySet<string>) => Promise<ReadonlyMap<string, LocalRemoval>>;

const run = promisify(execFile);
const commitSha = /^[a-f0-9]{40}$/;

export function fileAnchorPath(ref: string): string | undefined {
  const file = ref.replace(/^\.\//, '');
  if (/[\\\u0000-\u001f\u007f]/u.test(file) || !file.split('/').every(part => part && part !== '.' && part !== '..')
    || /^[a-z][\w+.-]*:/i.test(file)) return undefined;
  return file;
}

function githubOrigin(value: string): string | undefined {
  const ssh = value.match(/^git@github\.com:([\w.-]+\/[\w.-]+)$/i);
  if (ssh) return ssh[1].replace(/\.git$/i, '').toLowerCase();
  try {
    const url = new URL(value);
    if (url.host !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)) return undefined;
    return url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/?$/)?.[1].replace(/\.git$/i, '').toLowerCase();
  } catch { return undefined; }
}

export function createPlanningFileAnchorProbe(repoRootFor: (projectId: string) => string | undefined): PlanningFileAnchorProbe {
  return async (projectId, repository, branch, files, mergedCommits) => {
    const removals = new Map<string, LocalRemoval>();
    const cwd = repoRootFor(projectId);
    if (!cwd) return removals;
    const read = async (...args: string[]): Promise<string | undefined> => {
      try {
        const { stdout } = await run('git', ['--no-pager', '--literal-pathspecs', ...args], { cwd, timeout: 5000, maxBuffer: 512 * 1024,
          env: { ...process.env, GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' } });
        return stdout;
      } catch { return undefined; }
    };
    const tracking = `refs/remotes/origin/${branch}`;
    if (await read('check-ref-format', tracking) === undefined) return removals;
    const getOrigin = async () => githubOrigin((await read('config', '--local', '--get', 'remote.origin.url'))?.trim() ?? '');
    if (await getOrigin() !== repository.toLowerCase()) return removals;
    const getHead = async () => (await read('rev-parse', '--verify', `${tracking}^{commit}`))?.trim();
    const observedHeadSha = await getHead();
    if (!observedHeadSha || !commitSha.test(observedHeadSha)) return removals;

    for (const file of files) {
      const current = await read('ls-tree', '-rz', '--full-tree', '--name-only', observedHeadSha, '--', file);
      if (current !== '') continue;
      // Read the deletion on the current trunk's first-parent history. Changes on a topic branch
      // alone or files restored later cannot become a current deletion signal.
      const mergeCommitSha = (await read('log', '--first-parent', '--diff-merges=first-parent', '--no-ext-diff', '--no-renames',
        '--diff-filter=D', '--no-patch', '--format=%H', '-n', '1', observedHeadSha, '--', file))?.trim();
      if (!mergeCommitSha || !mergedCommits.has(mergeCommitSha)) continue;
      const parentCommitSha = (await read('rev-parse', '--verify', `${mergeCommitSha}^1`))?.trim();
      if (!parentCommitSha || !commitSha.test(parentCommitSha)) continue;
      const delta = await read('diff', '--no-ext-diff', '--no-renames', '--diff-filter=D', '--name-only', '-z', parentCommitSha, mergeCommitSha, '--', file);
      if (delta?.split('\0').includes(file)) removals.set(file, { mergeCommitSha, parentCommitSha, observedHeadSha });
    }

    // Publish only a complete observation of the same tracking ref and repository.
    if (await getHead() !== observedHeadSha || await getOrigin() !== repository.toLowerCase() || repoRootFor(projectId) !== cwd) return new Map();
    return removals;
  };
}
