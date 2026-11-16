import { apiRequest } from './api';

export interface RemoteBranch { name: string; date?: string; author?: string; subject?: string; isDefault?: boolean }

/** Cache-only on entry; explicitly refresh through the existing project-bound git fetch. */
export async function listRemoteBranches(projectId: string, forceFetch = false, signal?: AbortSignal): Promise<RemoteBranch[]> {
  const query = new URLSearchParams({ project: projectId });
  if (!forceFetch) query.set('nofetch', 'true');
  else query.set('force', 'true');
  const result = await apiRequest<{ branches: RemoteBranch[]; defaultBranch?: string | null }>(`/api/remote-branches?${query}`, { signal });
  return (result.branches || []).map(branch => ({ ...branch, isDefault: branch.isDefault || branch.name === result.defaultBranch }))
    .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
}
