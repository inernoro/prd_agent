import {it,afterEach,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {buildReleaseInventoryCommand,parseRemoteReleaseInventory,buildReleaseReclaimCommand,parseRemoteReclaimOutcome} from '../../src/services/release-artifact-retention.js';
import type {ReleaseTarget,ReleaseStrategy} from '../../src/types.js';
const roots:string[]=[],containers:string[]=[];
const execute=(command:string)=>execFileSync('bash',['-e','-c',command],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
afterEach(()=>{for(const id of containers.splice(0))docker('rm','-f',id);for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-remote-reclaim-'));roots.push(root);const repo=path.join(root,'repo');fs.mkdirSync(repo);
 const git=(...a:string[])=>execFileSync('git',['-C',repo,...a],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init');git('config','user.name','Owned fixture');git('config','user.email','owned@invalid');fs.writeFileSync(path.join(repo,'file'),'generated');git('add','.');git('commit','-m','fixture');const sha=git('rev-parse','HEAD');
 const ids=['rel_0000000000000001','rel_0000000000000002','rel_0000000000000003'];const wt=path.join(root,'.cds-releases/target/worktrees');fs.mkdirSync(wt,{recursive:true});
 for(const id of ids)git('worktree','add','--detach',path.join(wt,id),sha);
 fs.symlinkSync(path.join(wt,ids[0]),path.join(wt,'../current'));fs.symlinkSync(path.join(wt,ids[1]),path.join(wt,'../previous'));
 const target={id:'target',ssh:{appPath:repo}} as ReleaseTarget,strategy={mode:'generated-compose'} as ReleaseStrategy;
 const inventory=parseRemoteReleaseInventory(execute(buildReleaseInventoryCommand(target,strategy)!));
 const proof={identities:inventory.worktreeIdentities,commits:{[ids[2]]:sha}};
 const run=(dryRun=false)=>parseRemoteReclaimOutcome(execute(buildReleaseReclaimCommand(target,strategy,{removeWorktrees:[ids[2]],removeVersions:[]},{...proof,dryRun})!));
 return{root,repo,git,wt,ids,sha,target,strategy,proof,run,old:path.join(wt,ids[2])};
}
it('real inventory identities and native Git removal agree; readonly preview leaves bytes intact',()=>{
 const f=fixture();const before=fs.statSync(f.old);expect(f.proof.identities?.[f.ids[2]]).toBe(`${before.dev}:${before.ino}`);
 expect(f.run(true).removedWorktrees).toEqual([f.ids[2]]);expect(fs.existsSync(f.old)).toBe(true);
 expect(f.run().removedWorktrees).toEqual([f.ids[2]]);expect(fs.existsSync(f.old)).toBe(false);
});
it('data without a container mount stays protected, including ignored files',()=>{
 const f=fixture();fs.writeFileSync(path.join(f.old,'.gitignore'),'unclassified/');fs.mkdirSync(path.join(f.old,'unclassified'));fs.writeFileSync(path.join(f.old,'unclassified/data'),'keep synthetic persistent data');
 expect(f.run().heldReasons?.['worktree:'+f.ids[2]]).toBe('modified-or-unknown-files');expect(fs.readFileSync(path.join(f.old,'unclassified/data'),'utf8')).toBe('keep synthetic persistent data');
});
it('a replaced directory and a newly selected current version are retained',()=>{
 const f=fixture();fs.renameSync(f.old,f.old+'-original');fs.mkdirSync(f.old);fs.writeFileSync(path.join(f.old,'unknown'),'keep');
 expect(f.run().heldReasons?.['worktree:'+f.ids[2]]).toBe('identity-changed-or-unconfirmed');
 fs.rmSync(f.old,{recursive:true,force:true});fs.renameSync(f.old+'-original',f.old);fs.unlinkSync(path.join(f.wt,'../current'));fs.symlinkSync(f.old,path.join(f.wt,'../current'));
 expect(f.run().heldReasons?.['worktree:'+f.ids[2]]).toBe('current-or-previous');expect(fs.existsSync(f.old)).toBe(true);
});
it('native stopped-container references protect the source until that exact fixture container is removed',()=>{
 const f=fixture();const id=docker('create','--name','owned-remote-'+randomUUID(),'--mount',`type=bind,src=${f.old},dst=/source,readonly`,'alpine:3.21','true');containers.push(id);
 expect(f.run().heldReasons?.['worktree:'+f.ids[2]]).toBe('running-or-stopped-container');docker('rm',id);containers.splice(containers.indexOf(id),1);
 expect(f.run().removedWorktrees).toEqual([f.ids[2]]);
});
it('query failures report unknown and preserve every requested object',()=>{
 const f=fixture(),bin=path.join(f.root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'docker'),'#!/bin/sh\nexit 91\n');fs.chmodSync(path.join(bin,'docker'),0o755);
 const command=buildReleaseReclaimCommand(f.target,f.strategy,{removeWorktrees:[f.ids[2]],removeVersions:[]},f.proof)!;
 const out=execFileSync('bash',['-e','-c',command],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH}});const r=parseRemoteReclaimOutcome(out);
 expect(r.queryError).toBeTruthy();expect(r.removedWorktrees).toEqual([]);expect(fs.existsSync(f.old)).toBe(true);
});
it('an active native release lock prevents reclamation until the physical holder finishes',()=>{
 const f=fixture();const command=buildReleaseReclaimCommand(f.target,f.strategy,{removeWorktrees:[f.ids[2]],removeVersions:[]},f.proof)!;
 const output=execFileSync('flock',['-x',path.join(f.wt,'../.retention.lock'),'bash','-e','-c',command],{encoding:'utf8'});
 const result=parseRemoteReclaimOutcome(output);
 expect(result.queryError).toBe('release-or-reclaim-in-progress');expect(fs.existsSync(f.old)).toBe(true);
 expect(f.run().removedWorktrees).toEqual([f.ids[2]]);
});
