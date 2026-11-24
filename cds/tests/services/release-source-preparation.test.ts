import {afterEach,it,expect} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
import {releaseSourcePreparationCommand} from '../../src/services/release-source-preparation.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(declared=true){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owned-release-inputs-'));roots.push(root);const repo=path.join(root,'repo');fs.mkdirSync(repo);
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init');git('config','user.name','Owned tests');git('config','user.email','owned@invalid');
 fs.mkdirSync(path.join(repo,'scripts'));fs.mkdirSync(path.join(repo,'deploy'));fs.mkdirSync(path.join(repo,'acceptance'));
 fs.writeFileSync(path.join(repo,'scripts/verify.sh'),'echo verified');fs.writeFileSync(path.join(repo,'cds-release.sh'),'#!/bin/sh\nexit 0\n');
 fs.writeFileSync(path.join(repo,'acceptance/fixture.bin'),Buffer.alloc(2*1024*1024,42));
 if(declared)fs.writeFileSync(path.join(repo,'deploy/release-inputs.json'),JSON.stringify({schema:1,kind:'prebuilt-release-inputs',directories:['scripts','deploy']}));
 else fs.writeFileSync(path.join(repo,'deploy/README'),'fixture');
 git('add','.');git('commit','-m','fixture');const sha=git('rev-parse','HEAD'),worktree=path.join(root,'worktree');
 const run=(target=worktree)=>JSON.parse(execFileSync('bash',['-eu','-c',`repo="$1"; worktree="$2"; CDS_COMMIT_SHA="$3"; ${releaseSourcePreparationCommand('cds-release.sh')}`,'test',repo,target,sha],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim());
 return{root,repo,git,sha,worktree,run};
}
it('real release execution omits declared-out acceptance material and preserves exact source/commit',()=>{
 const f=fixture(),r=f.run();expect(r.mode).toBe('declared-inputs');expect(r.declarationSha256).toMatch(/^[a-f0-9]{64}$/);
 expect(fs.existsSync(path.join(f.worktree,'scripts/verify.sh'))).toBe(true);expect(fs.existsSync(path.join(f.worktree,'cds-release.sh'))).toBe(true);
 expect(fs.existsSync(path.join(f.worktree,'acceptance'))).toBe(false);expect(fs.statSync(path.join(f.repo,'acceptance/fixture.bin')).size).toBe(2*1024*1024);
 expect(execFileSync('git',['-C',f.worktree,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(f.sha);
});
it('missing declaration preserves full checkout and repeat execution does not modify existing data',()=>{
 const f=fixture(false);expect(f.run().mode).toBe('full-source');expect(fs.existsSync(path.join(f.worktree,'acceptance/fixture.bin'))).toBe(true);
 fs.mkdirSync(path.join(f.worktree,'.cds-data'));fs.writeFileSync(path.join(f.worktree,'.cds-data/preserve'),'owned synthetic persistent data');
 const identity=fs.statSync(f.worktree),before=fs.readFileSync(path.join(f.worktree,'.cds-data/preserve'));
 expect(f.run()).toMatchObject({mode:'reuse-existing',existingPreserved:true});expect(fs.statSync(f.worktree).ino).toBe(identity.ino);
 expect(fs.readFileSync(path.join(f.worktree,'.cds-data/preserve'))).toEqual(before);
});
it('a replaced or foreign directory is preserved after a preview rather than adopted or cleaned',()=>{
 const f=fixture();fs.mkdirSync(f.worktree);fs.writeFileSync(path.join(f.worktree,'unknown'),'preserve');
 expect(()=>f.run()).toThrow();expect(fs.readFileSync(path.join(f.worktree,'unknown'),'utf8')).toBe('preserve');
 fs.renameSync(f.worktree,f.worktree+'-saved');fs.symlinkSync(f.worktree+'-saved',f.worktree);
 expect(()=>f.run()).toThrow();expect(fs.readFileSync(path.join(f.worktree+'-saved','unknown'),'utf8')).toBe('preserve');
});
it('invalid committed scope fails before creating a release path',()=>{
 const f=fixture();fs.writeFileSync(path.join(f.repo,'deploy/release-inputs.json'),JSON.stringify({schema:1,kind:'prebuilt-release-inputs',directories:['../outside']}));
 f.git('add','.');f.git('commit','-m','invalid declaration');const sha=f.git('rev-parse','HEAD');
 expect(()=>execFileSync('bash',['-eu','-c',`repo="$1"; worktree="$2"; CDS_COMMIT_SHA="$3"; ${releaseSourcePreparationCommand()}`,'test',f.repo,f.worktree,sha],{stdio:'pipe'})).toThrow();
 expect(fs.existsSync(f.worktree)).toBe(false);
});
