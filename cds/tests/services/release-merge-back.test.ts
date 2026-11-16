import { describe, expect, it, vi } from 'vitest';
import { releaseMergeBackReader } from '../../src/services/release-merge-back.js';
import type { StateService } from '../../src/services/state.js';
const sha = 'a'.repeat(40);
const state = { getProject: () => ({ githubRepoFullName:'owner/repo',githubInstallationId:1 }) } as unknown as StateService;
const app = { getInstallationToken: async () => 'fixture-token' };
const pr = { number:12,state:'closed',merged_at:'2026-11-16T12:00:00Z',merge_commit_sha:sha,head:{sha},base:{ref:'main',repo:{full_name:'owner/repo'}} };
describe('PR 回并的 GitHub 权威回执', () => {
  it('只有 merged_at 证明已合并；关闭未合并分别记录，地址由仓库身份生成', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({...pr,html_url:'https://attacker.invalid'})));
    const read = releaseMergeBackReader(state,app,fetcher as typeof fetch);
    expect(await read('p',12)).toMatchObject({state:'merged',url:'https://github.com/owner/repo/pull/12',headSha:sha});
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/12');
    const closed = releaseMergeBackReader(state,app,async () => new Response(JSON.stringify({...pr,merged_at:null})));
    expect((await closed('p',12)).state).toBe('closed');
  });
  it('仓库、编号、版本不一致或上游失败时不放行关联，也不泄漏原始错误', async () => {
    for (const patch of [{number:13},{head:{sha:'--help'}},{base:{ref:'main',repo:{full_name:'other/repo'}}}]) {
      const read = releaseMergeBackReader(state,app,async () => new Response(JSON.stringify({...pr,...patch})));
      await expect(read('p',12)).rejects.toThrow('暂未核实');
    }
    const read = releaseMergeBackReader(state,app,async () => {throw new Error('Bearer private-token');});
    await expect(read('p',12)).rejects.toThrow('暂未核实');
    await expect(read('p',12)).rejects.not.toThrow('private-token');
  });
});
