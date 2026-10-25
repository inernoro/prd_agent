import {it,afterEach,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {WorktreeService,deploymentNeedsSourceCheckout} from '../../src/services/worktree.js';
import {ShellExecutor} from '../../src/services/shell-executor.js';
import type {IShellExecutor} from '../../src/types.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const git=(cwd:string,...args:string[])=>execFileSync('/usr/bin/git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-source-free-runtime-'));roots.push(dir);const remote=dir+'/remote',repo=dir+'/repo',base=dir+'/worktrees',canonical=WorktreeService.worktreePathFor(base,'p','metadata-only'),recovery={kind:'managed-missing' as const,worktreeBase:base,projectId:'p',branchId:'metadata-only'};
 fs.mkdirSync(remote);git(remote,'init','-b','main');git(remote,'config','user.email','owned@invalid');git(remote,'config','user.name','Owned tests');fs.writeFileSync(remote+'/version.txt','A');git(remote,'add','.');git(remote,'commit','-m','A');const A=git(remote,'rev-parse','HEAD');git(dir,'clone',remote,repo);
 fs.writeFileSync(remote+'/version.txt','B');fs.writeFileSync(remote+'/config.json','{"revision":"B"}');fs.writeFileSync(remote+'/schema.sql','-- B exact source');git(remote,'add','.');git(remote,'commit','-m','B');const B=git(remote,'rev-parse','HEAD');git(repo,'fetch','origin','main');
 const real=new ShellExecutor(),commands:{command:string;cwd?:string}[]=[];let offline=false;const shell:IShellExecutor={exec:(command,options)=>{commands.push({command,cwd:options?.cwd});if(command.startsWith('git fetch ')&&offline)return Promise.resolve({exitCode:128,stdout:'',stderr:'controlled transport failure after exact B accepted'});return real.exec(command,{...options,timeout:10000,env:{...options?.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}})}};
 return{dir,remote,repo,canonical,recovery,A,B,commands,service:new WorktreeService(shell),offline:()=>{offline=true}};
}
it('cold metadata-only canonical resolves fixed B from project repo after origin advances C, without fetching or creating canonical',async()=>{
 const f=fixture();fs.writeFileSync(f.remote+'/version.txt','C');git(f.remote,'commit','-am','C');f.offline();const r=await f.service.resolveDeploymentCommit(f.repo,'main',f.canonical,f.B,f.recovery);
 expect(r.afterFull).toBe(f.B);expect(r.before).toBe('');expect(fs.existsSync(f.canonical)).toBe(false);expect(f.commands.some(c=>c.command.startsWith('git fetch '))).toBe(false);expect(f.commands.filter(c=>!['git check-ref-format', 'git rev-parse HEAD'].some(prefix=>c.command.startsWith(prefix))).every(c=>c.cwd===f.repo)).toBe(true);
});
it('new ordinary source dependency creates B under branch UUID root while canonical remains absent',async()=>{
 const f=fixture();expect(deploymentNeedsSourceCheckout([{prebuiltImage:false,command:'node app.js'} as any])).toBe(true);f.offline();const r=await f.service.prepareDeploymentSource(f.repo,'main',f.canonical,f.B,f.recovery);
 expect(fs.readFileSync(r.sourcePath+'/config.json','utf8')).toBe('{"revision":"B"}');expect(path.dirname(r.sourcePath)).toBe(WorktreeService.deploymentSourceRootFor(f.canonical));expect(git(r.sourcePath,'rev-parse','HEAD')).toBe(f.B);expect(fs.existsSync(f.canonical)).toBe(false);expect(git(f.repo,'rev-parse','HEAD')).toBe(f.A);
});
it('new managed dependency uses B and keeps two branch source roots separate',async()=>{
 const f=fixture();expect(deploymentNeedsSourceCheckout([{prebuiltImage:true,managedBuild:{stack:'node'}} as any])).toBe(true);f.offline();const a=await f.service.prepareDeploymentSource(f.repo,'main',f.canonical,f.B,f.recovery),b=await f.service.prepareDeploymentSource(f.repo,'main',WorktreeService.worktreePathFor(f.recovery.worktreeBase,'p','other'),f.B,{...f.recovery,branchId:'other'});
 expect(fs.readFileSync(a.sourcePath+'/version.txt','utf8')).toBe('B');expect(path.dirname(a.sourcePath)).not.toBe(path.dirname(b.sourcePath));expect(fs.existsSync(f.canonical)).toBe(false);
});
it('DB initialization tree scan and detached read both consume exact B with no canonical',async()=>{
 const f=fixture();f.offline();const target=await f.service.resolveDeploymentCommit(f.repo,'main',f.canonical,f.B,f.recovery);expect(await f.service.needsDatabaseInitializationSource(f.repo,target.afterFull,['.'])).toBe(true);const r=await f.service.prepareDeploymentSource(f.repo,'main',f.canonical,target.afterFull,f.recovery);
 expect(fs.readFileSync(r.sourcePath+'/schema.sql','utf8')).toBe('-- B exact source');expect(fs.existsSync(f.canonical)).toBe(false);
});
it('existing canonical A wins as original repository coordinate, preserving before A and its content',async()=>{
 const f=fixture();f.offline();const r=await f.service.prepareDeploymentSource(f.repo,'main',f.repo,f.B);expect(r.before).toBe(f.A);expect(fs.readFileSync(r.sourcePath+'/version.txt','utf8')).toBe('B');expect(fs.readFileSync(f.repo+'/version.txt','utf8')).toBe('A');expect(git(f.repo,'rev-parse','HEAD')).toBe(f.A);
});
