import { describe, it, expect, vi } from 'vitest';
import { verifyProjectReleaseCI } from '../../src/services/project-release-ci.js';
import { buildReleaseInventoryCommand } from '../../src/services/release-artifact-retention.js';
import type { BranchEntry, Project, ReleaseTarget } from '../../src/types.js';

const sha = 'a'.repeat(40);
const project = { githubRepoFullName: 'owner/repo', githubInstallationId: 12 } as Project;
const branch = { branch: 'main' } as BranchEntry;
const app = { getInstallationToken: vi.fn(async () => 'fixture-token') };
const run = { id: 10, updated_at:'2026-10-20T10:01:00Z',run_started_at:'2026-10-20T10:00:00Z', head_sha: sha, head_branch: 'main', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_repository: { full_name: 'owner/repo' } };
async function verify(runs: unknown[], strategy = {mode:'project-script' as const}) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ workflow_runs: runs })));
  const result = await verifyProjectReleaseCI(project, app, branch, sha, strategy, fetcher as typeof fetch);
  return { result, fetcher };
}
describe('authoritative project release CI', () => {
  it('reads the declared workflow for a source-mode branch without image CI/webhook state', async () => {
    const {result,fetcher} = await verify([run]);
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0][0]).toContain('/actions/workflows/ci.yml/runs?head_sha='+sha);
  });
  it('never accepts image-workflow, another commit, branch or fork results', async () => {
    for (const change of [{path:'.github/workflows/branch-image.yml'}, {head_sha:'b'.repeat(40)}, {head_branch:'dev'}, {head_repository:{full_name:'fork/repo'}}, {head_repository:undefined}]) {
      expect((await verify([{...run,...change}])).result.ok).toBe(false);
    }
  });
  it('the latest pending/failed/cancelled rerun defeats an earlier green run', async () => {
    for (const change of [{status:'in_progress',conclusion:null}, {conclusion:'failure'}, {conclusion:'cancelled'}]) {
      expect((await verify([run,{...run,id:11,...change}])).result.ok).toBe(false);
    }
    expect((await verify([{...run,run_attempt:1}, {...run,run_attempt:2,conclusion:'failure'}])).result.ok).toBe(false);
  });
  it('fails closed without an App, permissions, network or a matching run', async () => {
    expect((await verifyProjectReleaseCI(project, undefined, branch, sha, {mode:'project-script'})).ok).toBe(false);
    expect((await verify([])).result.ok).toBe(false);
    for (const fetcher of [async()=>new Response('',{status:403}), async()=>{throw Error('offline')}]) {
      expect((await verifyProjectReleaseCI(project,app,branch,sha,{mode:'project-script'},fetcher as typeof fetch)).ok).toBe(false);
    }
  });
  it('a newly rerun lower-ID attempt supersedes a higher-ID old success', async () => {
    for(const change of [{status:'queued',conclusion:null},{status:'in_progress',conclusion:null},{conclusion:'failure'},{conclusion:'cancelled'}]){
      const oldIdRerun={...run,id:9,run_attempt:2,updated_at:'2026-10-20T10:03:00Z',...change};
      expect((await verify([run,oldIdRerun])).result.ok).toBe(false);
    }
    expect((await verify([{...run,id:11,conclusion:'failure'}, {...run,id:9,run_attempt:3,updated_at:'2026-10-20T10:04:00Z'}])).result.ok).toBe(true);
  });
  it('missing time or incomplete result windows cannot silently reuse a green result', async () => {
    expect((await verify([{...run,updated_at:undefined,run_started_at:undefined}])).result.ok).toBe(false);
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({total_count:101,workflow_runs:[run]})));
    expect((await verifyProjectReleaseCI(project,app,branch,sha,{mode:'project-script'},fetcher as typeof fetch)).ok).toBe(false);
  });
  it('supports an explicitly configured project workflow, not a hardcoded image gate', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({workflow_runs:[{...run,path:'.github/workflows/release-check.yaml'}]})));
    expect((await verifyProjectReleaseCI(project,app,branch,sha,{mode:'project-script',ciWorkflowFile:'release-check.yaml'},fetcher as typeof fetch)).ok).toBe(true);
  });
  it.each(['project-script','managed-script'] as const)('inventories %s at the same protected worktree root as Compose', mode => {
    const target = {id:'target',ssh:{appPath:'/opt/repo'}} as ReleaseTarget;
    const expected = buildReleaseInventoryCommand(target,{mode:'generated-compose'});
    expect(buildReleaseInventoryCommand(target,{mode})).toBe(expected);
    expect(expected).toContain('root="$(dirname "$wt")"');
    expect(expected).not.toContain('root=\'\'');
  });
});
