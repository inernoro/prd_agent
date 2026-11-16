import fs from 'node:fs';

/** One versioned Python implementation serves remote release execution and the
 * operator CLI. It is copied into dist with the existing runtime-asset chain. */
export function releaseSourcePreparationCommand(requiredFile = ''): string {
  const source = fs.readFileSync(new URL('./release-source-preparation.py', import.meta.url), 'utf8');
  if (!/^[A-Za-z0-9._/-]*$/.test(requiredFile) || requiredFile.split('/').includes('..')) throw new Error('invalid release script path');
  return `python3 - --repo "$repo" --worktree "$worktree" --commit "$CDS_COMMIT_SHA" --required-file '${requiredFile}' --apply <<'CDS_RELEASE_SOURCE_PY'
${source}
CDS_RELEASE_SOURCE_PY`;
}
