import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IShellExecutor, ExecOptions } from '../types.js';
import type { ReleaseConflictCheck } from '../domain/release-governance.js';
import { shellQuoteArg } from './secure-database-cli.js';
import type { StateService } from './state.js';
import { mergeGitAuthEnv, type GitAuthEnvResult } from './git-auth-env.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export function resolveReleaseProjectRepository(state: Pick<StateService, 'getProject' | 'getProjectRepoRoot'>, projectId: string, fallbackRoot: string): string | undefined {
  const project = state.getProject(projectId);
  if (!project || (project.gitRepoUrl && !project.repoPath)) return undefined;
  return state.getProjectRepoRoot(projectId, fallbackRoot);
}

export const FULL_SHA = /^[a-f0-9]{40}$/i;
export interface GovernanceGitResult { stdout: string; exitCode: number | null }
export interface GovernanceGitFetchContext { projectId: string; purpose: 'main-fetch' | 'pr-fetch'; candidateSha: string; prNumber?: number }
export type GovernanceGitRunner = (args: string[], cwd: string, isolated?: boolean, context?: GovernanceGitFetchContext) => Promise<GovernanceGitResult>;

/** Bounded, non-urgent execution. Merge output is written only into a disposable bare repository. */
export function governanceGitRunner(shell?: IShellExecutor,
  gitAuth?: (repoRoot: string) => Promise<GitAuthEnvResult>, auditSink?: ServerEventLogSink | null): GovernanceGitRunner {
  return async (args, cwd, isolated = false, context) => {
    if (!shell?.execBackgroundObservation) throw new Error('Git 核验执行器不可用');
    const observe=shell.execBackgroundObservation.bind(shell);
    let interruptedOutput='';
    const prefix = 'GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 ' + (isolated ? 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null ' : '');
    const execute = async (commandArgs: string[], auth?: GitAuthEnvResult) => {
      let stdout='',stderr='',bytes=0;
      const options: ExecOptions={cwd,timeout:30_000,captureOutput:false,onData:(chunk,channel)=>{
        bytes+=Buffer.byteLength(chunk);
        if(bytes>1024*1024)throw new Error('Git 核验结果超过容量限制');
        if(channel==='stderr')stderr+=chunk;else stdout+=chunk;
      }};
      try{
        const result=await observe(prefix+['git',...commandArgs].map(shellQuoteArg).join(' '),auth?mergeGitAuthEnv(options,auth):options);
        return {stdout,stderr,exitCode:result.exitCode};
      }catch(error){interruptedOutput=stderr||stdout;throw error;}
    };
    if(isolated||args[0]!=='-C'||args[2]!=='fetch')return execute(args);
    const origin=await execute(['-C',cwd,'remote','get-url','origin']);
    const remote=origin.stdout.trim();
    if(origin.exitCode!==0||!remote)throw new Error('Git 来源未核实，未执行远端读取');
    const scp=remote.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
    const local=/^(?:\/|file:\/\/|[A-Za-z]:[\\/])/.test(remote)||!scp&&!/^[a-z][a-z0-9+.-]*:/i.test(remote);
    const auditUrl=/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)?remote:scp?`ssh://${scp[1]}/${scp[2]}`:remote;
    if(!local&&!context?.projectId)throw new Error('Git 读取缺少项目关联，未执行远端读取');
    const audit=!local?createExternalResponseAudit(auditSink,{projectId:context!.projectId,
      remoteProjectId:`${context!.projectId}:${context!.purpose}:${context!.candidateSha}:${context!.prNumber||''}`,policy:'release-governance-git',dryRun:true},
      {source:'release-governance-git',action:'release.git.response',message:'发布治理 Git 远端读取证据'}):undefined;
    audit?.assertAvailable();
    const started=Date.now();let auth:GitAuthEnvResult|undefined,result:Awaited<ReturnType<typeof execute>>|undefined,failure:unknown;
    try{
      auth=await gitAuth?.(cwd);
      if(context&&auth?.projectId&&auth.projectId!==context.projectId)throw new Error('Git 凭据不属于当前项目，未执行远端读取');
      result=await execute(args,auth);
    }catch(error){failure=error;}
    if(audit){
      const secrets:string[]=[];
      try{const url=new URL(remote);if(url.password)secrets.push(url.password,decodeURIComponent(url.password));if(url.username&&!['git','x-access-token'].includes(url.username))secrets.push(url.username,decodeURIComponent(url.username));}catch{/* SCP or local syntax has no URL password. */}
      for(const [key,value] of Object.entries(auth?.env||{}))if(key.startsWith('GIT_CONFIG_VALUE_')){
        secrets.push(value);const basic=value.match(/basic\s+(\S+)/i)?.[1];
        if(basic){const decoded=Buffer.from(basic,'base64').toString('utf8');secrets.push(basic,decoded,decoded.slice(decoded.indexOf(':')+1));}
      }
      const json={status:result?.exitCode??'execution-failed',message:failure instanceof Error?`${failure.message}\n${interruptedOutput}`:result?.stderr||result?.stdout||'',code:result?.exitCode??'execution-failed'};
      // 原生 Git 的结构化执行结果与诊断流；没有上游 HTTP 状态或请求号，不补造。
      await audit.record({peerId:'git-origin',url:auditUrl,method:'GIT FETCH',startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,
        timeoutMs:30_000,responseReceived:Boolean(result||interruptedOutput),httpStatus:null,upstreamRequestId:null,contentType:'application/json',text:JSON.stringify(json),json,parseState:'json',
        localDecision:failure?'execution-failed':result?.exitCode===0?'success':'git-error',secrets});
    }
    if(failure||!result)throw new Error('Git 读取未完成，请核对项目远端诊断后重试');
    return {stdout:result.stdout,exitCode:result.exitCode};
  };
}

export class ReleaseGovernanceGit {
  private active = 0;
  constructor(private readonly root: (projectId: string) => string | undefined,
    private readonly defaultBranch: (projectId: string) => string,
    private readonly run: GovernanceGitRunner) {}

  async resolveCommit(projectId: string, revision: string): Promise<string> {
    const root = this.root(projectId);
    if (!root || !/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error('固定版本不是有效提交，请重新固定分支版本');
    const result = await this.run(['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], root);
    const sha = result.stdout.trim().toLowerCase();
    if (result.exitCode !== 0 || !FULL_SHA.test(sha)) throw new Error('固定版本无法唯一核实，请同步分支后重新固定版本');
    return sha;
  }

  async includes(projectId: string, ancestor: string, descendant: string): Promise<boolean> {
    const root = this.root(projectId);
    if (!root || !FULL_SHA.test(ancestor) || !FULL_SHA.test(descendant)) throw new Error('缺少完整 Git 版本');
    const result = await this.run(['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], root);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('Git 包含关系未核实');
    return result.exitCode === 0;
  }

  async includesPr(projectId: string, sourceSha: string, number: number, headSha: string): Promise<boolean> {
    const root = this.root(projectId);
    if (!root || !Number.isSafeInteger(number) || number < 1 || !FULL_SHA.test(sourceSha) || !FULL_SHA.test(headSha)) throw new Error('PR 版本依据不完整');
    const reference = `refs/cds/release-pr/${number}`;
    const fetched = await this.run(['-C',root,'fetch','--no-tags','origin',`+refs/pull/${number}/head:${reference}`],root,false,
      {projectId,purpose:'pr-fetch',candidateSha:sourceSha,prNumber:number});
    const observed = await this.run(['-C',root,'rev-parse','--verify',`${reference}^{commit}`],root);
    if (fetched.exitCode !== 0 || observed.exitCode !== 0 || observed.stdout.trim() !== headSha) throw new Error('PR 已变化或源码未取齐，请刷新后重试');
    return this.includes(projectId,sourceSha,headSha);
  }

  async inspect(projectId: string, candidateSha: string, basisSha?: string): Promise<ReleaseConflictCheck> {
    const result: ReleaseConflictCheck = { projectId, candidateSha, mainSha: '', checkedAt: new Date().toISOString(),
      status: 'unknown', conflicts: [], changedPaths: [], includesBaseline: false };
    let temporary: string | undefined;
    if (this.active >= 2) return { ...result, reason: 'Git 核验正在处理其他请求，请稍后重试' };
    this.active++;
    try {
      const root = this.root(projectId), branch = this.defaultBranch(projectId);
      if (!root || !FULL_SHA.test(candidateSha) || basisSha && !FULL_SHA.test(basisSha)
        || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error();
      const checked = async (args: string[], cwd = root, isolated = false) => {
        const value = await this.run(args, cwd, isolated);
        if (value.exitCode !== 0) throw new Error();
        return value.stdout;
      };
      // Explicit user/preflight operation, never a side effect of reading the release center.
      const fetched=await this.run(['-C', root, 'fetch', '--no-tags', 'origin', `+${branch}:refs/remotes/origin/${branch}`],root,false,
        {projectId,purpose:'main-fetch',candidateSha});
      if(fetched.exitCode!==0)throw new Error();
      result.mainSha = (await checked(['-C', root, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
      if (!FULL_SHA.test(result.mainSha)) throw new Error();
      await checked(['-C', root, 'cat-file', '-e', `${candidateSha}^{commit}`]);
      const basis = basisSha || result.mainSha;
      result.includesBaseline = await this.includes(projectId, basis, candidateSha);
      const net = await checked(['-C', root, 'diff', '--name-only', '-z', '--no-renames', basis, candidateSha, '--']);
      const common = (await checked(['-C', root, 'rev-parse', '--git-common-dir'])).trim();
      const objects = await fs.realpath(path.resolve(root, common, 'objects'));
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-release-merge-'));
      await checked(['init', '--bare', '--quiet', temporary], temporary, true);
      await fs.writeFile(path.join(temporary, 'objects/info/alternates'), objects + '\n');
      // 普通提交仍累计已撤回的修改；双父合并只计手工解决的差异，避免把已在线上的基线重复算作调试修改。
      // remerge 会生成临时对象，必须与冲突核验共用隔离仓库，不能写原对象库或使用项目合并驱动配置。
      const range = `${basis}..${candidateSha}`;
      const history = await checked(['-C', temporary, 'log', '--format=', '--name-only', '-z', '--no-renames',
        '--diff-merges=remerge', range, '--'], temporary, true);
      // Git 仅能重算双父合并；多父合并沿用原先逐父累计的保守检查，不能静默漏过其历史修改。
      const octopus = await checked(['-C', temporary, 'log', '--format=', '--name-only', '-z', '--no-renames',
        '--min-parents=3', '--diff-merges=separate', range, '--'], temporary, true);
      if ([net, history, octopus].some(value => value && !value.endsWith('\0'))) throw new Error();
      result.changedPaths = [...new Set([net, history, octopus].flatMap(value => value.split('\0')).filter(Boolean))].sort();
      if (result.changedPaths.length > 10_000) throw new Error();
      const merged = await this.run(['-C', temporary, '-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree',
        '--name-only', '--no-messages', '-z', result.mainSha, candidateSha], temporary, true);
      if (merged.exitCode !== 0 && merged.exitCode !== 1 || !merged.stdout.endsWith('\0')) throw new Error();
      const [tree, ...files] = merged.stdout.split('\0');
      if (!FULL_SHA.test(tree)) throw new Error();
      result.conflicts = [...new Set(files.filter(Boolean))];
      if (merged.exitCode === 1 && !result.conflicts.length) throw new Error();
      result.status = merged.exitCode === 0 ? 'clean' : 'conflicts';
    } catch {
      result.status = 'unknown'; result.reason = '主干更新或隔离合并未完成，请刷新核验后重试；未判定为无冲突';
    } finally {
      try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
      finally { this.active--; }
    }
    return result;
  }
}
