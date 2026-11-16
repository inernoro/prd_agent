import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';
import { releaseMergeBackReader } from '../../src/services/release-merge-back.js';
import type { StateService } from '../../src/services/state.js';
const sha = 'a'.repeat(40);
const state = { getProject: () => ({ githubRepoFullName:'owner/repo',githubInstallationId:1 }) } as unknown as StateService;
const app = { getInstallationToken: async () => 'fixture-token' };
const pr = { number:12,state:'closed',merged_at:'2026-11-16T12:00:00Z',merge_commit_sha:sha,head:{sha},base:{ref:'main',repo:{full_name:'owner/repo'}} };
let root: string, auditFile: string, sink: ServerEventLogSink;
const readAudit = () => JSON.parse(fs.readFileSync(auditFile, 'utf8')) as any[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pr-response-')); auditFile = path.join(root, 'audit.json');
  fs.writeFileSync(auditFile, '[]');
  sink = { record() {}, recordImmediate: async row => {
    fs.writeFileSync(auditFile, JSON.stringify([...readAudit(), row]));
  }, findRecent: async filter => readAudit().filter(row => row.projectId === filter?.projectId && row.requestId === filter?.requestId) };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('PR 回并的 GitHub 权威回执', () => {
  it('只有 merged_at 证明已合并；关闭未合并分别记录，地址由仓库身份生成', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({...pr,html_url:'https://attacker.invalid'})));
    const read = releaseMergeBackReader(state,app,fetcher as typeof fetch,sink);
    expect(await read('p',12)).toMatchObject({state:'merged',url:'https://github.com/owner/repo/pull/12',headSha:sha});
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/12');
    expect(readAudit()[0]).toMatchObject({projectId:'p',action:'release.merge-back.response',details:{localDecision:'success',parseState:'json',httpStatus:200,responseReceived:true}});
    const closed = releaseMergeBackReader(state,app,async () => new Response(JSON.stringify({...pr,merged_at:null})),sink);
    expect((await closed('p',12)).state).toBe('closed');
  });
  it('仓库、编号、版本不一致或上游失败时不放行关联，也不泄漏原始错误', async () => {
    for (const patch of [{number:13},{head:{sha:'--help'}},{base:{ref:'main',repo:{full_name:'other/repo'}}}]) {
      const read = releaseMergeBackReader(state,app,async () => new Response(JSON.stringify({...pr,...patch})),sink);
      await expect(read('p',12)).rejects.toThrow('暂未核实');
    }
    const read = releaseMergeBackReader(state,app,async () => {throw new Error('Bearer private-token');},sink);
    await expect(read('p',12)).rejects.toThrow('暂未核实');
    await expect(read('p',12)).rejects.not.toThrow('private-token');
  });
  it('拒绝、解析失败和无响应分别持久留证，令牌和个人信息不写入', async () => {
    const responses = [new Response(JSON.stringify({message:'API rate limit exceeded; token=fixture-token',email:'person@example.com'}),{status:403,headers:{'x-github-request-id':'GH-TRACE-42','content-type':'application/json'}}),new Response('<html>bad gateway</html>',{status:502}),new Response('not-json',{status:200})];
    for (const response of responses) await expect(releaseMergeBackReader(state,app,async()=>response,sink)('p',12)).rejects.toThrow('暂未核实');
    await expect(releaseMergeBackReader(state,app,async()=>{throw new Error('private-token');},sink)('p',12)).rejects.toThrow('暂未核实');
    const rows=readAudit();
    expect(rows.map(row=>row.details.localDecision)).toEqual(['http-forbidden','http-error','invalid-json','no-response']);
    expect(rows[0].details).toMatchObject({upstreamRequestId:'GH-TRACE-42',httpStatus:403,parseState:'json'});
    expect(rows[0].details.snapshot).toContain('rate limit');
    expect(rows[1].details).toMatchObject({httpStatus:502,parseState:'invalid-json',responseReceived:true});
    expect(rows[3].details).toMatchObject({httpStatus:null,responseReceived:false,parseState:'no-response'});
    expect(JSON.stringify(rows)).not.toMatch(/fixture-token|private-token|person@example.com/);
    expect(new Set(rows.map(row=>row.operationId)).size).toBe(4);
  });
  it('持久化不可用时不请求 GitHub，审计写入失败时不返回成功',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(pr)));
    await expect(releaseMergeBackReader(state,app,fetcher)('p',12)).rejects.toThrow('暂未核实');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(releaseMergeBackReader(state,app,fetcher,{record(){},recordImmediate:async()=>{throw new Error('offline');},findRecent:async()=>[]})('p',12)).rejects.toThrow('暂未核实');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
