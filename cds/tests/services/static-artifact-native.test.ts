import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseInventoryCommand, buildReleaseReclaimCommand, parseRemoteReleaseInventory,
  parseRemoteReclaimOutcome,
} from '../../src/services/release-artifact-retention.js';
import type { ReleaseStrategy, ReleaseTarget } from '../../src/types.js';

const roots: string[] = [];
const helper = fileURLToPath(new URL('../../src/services/static-artifact-proof.py', import.meta.url));
const id = (n: number) => 'rel_' + n.toString(16).padStart(16, '0');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'static-proof-'))); roots.push(root);
  const repo = path.join(root, 'repo'), publicRoot = path.join(root, 'public');
  const releaseRoot = path.join(root, '.cds-releases', 'fixture');
  await fs.mkdir(repo); await fs.mkdir(path.join(releaseRoot, 'worktrees'), {recursive:true});
  await fs.mkdir(path.join(publicRoot, '.releases'), {recursive:true});
  const git = (...args: string[]) => execFileSync('git', ['-C',repo,...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Capacity fixture');
  await fs.writeFile(path.join(repo,'source.txt'),'historical source');git('add','.');git('commit','-m','隔离静态成品');
  const commit = git('rev-parse','HEAD');
  const target = {id:'fixture',ssh:{appPath:repo}} as ReleaseTarget;
  const strategy = {mode:'generated-static',publicDirectory:publicRoot} as ReleaseStrategy;
  const bin = path.join(root,'bin');await fs.mkdir(bin);
  // Explicit empty inventory; separate real Docker mount cases must opt in.
  await fs.writeFile(path.join(bin,'docker'),'#!/bin/sh\n[ "$1" = ps ] && exit 0\nexit 1\n',{mode:0o755});
  const env = {...process.env,PATH:bin+path.delimiter+process.env.PATH};
  const version = (n:number) => path.join(publicRoot,'.releases',id(n));
  const make = async (n:number, seal=true) => {
    await fs.mkdir(version(n));await fs.writeFile(path.join(version(n),'index.html'),Buffer.alloc(64*1024,n));
    if(seal)execFileSync('python3',[helper,'seal',version(n),releaseRoot,'fixture',id(n),commit]);
  };
  await make(1);await make(2);await fs.symlink(version(1),path.join(publicRoot,'current'));await fs.symlink(version(2),path.join(publicRoot,'previous'));
  const inventory = () => parseRemoteReleaseInventory(execFileSync('/bin/sh',['-c',buildReleaseInventoryCommand(target,strategy)!],{encoding:'utf8',env}));
  const command = (names:number[], dryRun=false) => {
    const inv=inventory();const proof = {commits:Object.fromEntries(names.map(n=>[id(n),commit])),identities:inv.worktreeIdentities,versionIdentities:inv.versionIdentities,dryRun};
    return buildReleaseReclaimCommand(target,strategy,{removeWorktrees:[],removeVersions:names.map(id)},proof)!;
  };
  const reclaim = (names:number[], dryRun=false) => parseRemoteReclaimOutcome(execFileSync('/bin/sh',['-c',command(names,dryRun)],{encoding:'utf8',env}));
  const protectedHash = digest(await fs.readFile(path.join(version(1),'index.html')));
  return {root,repo,releaseRoot,publicRoot,target,strategy,commit,env,make,version,inventory,command,reclaim,protectedHash};
}

describe('proved static artifact native reclamation',()=>{
  it('reclaims only a sealed unreferenced version and preserves current/previous bytes and links',async()=>{
    const f=await fixture();await f.make(3);
    const refs=await Promise.all(['current','previous'].map(n=>fs.readlink(path.join(f.publicRoot,n))));
    const out=f.reclaim([3]);
    expect(out.queryError).toBeUndefined();
    expect(out.removedVersions).toEqual([id(3)]);
    await expect(fs.stat(f.version(3))).rejects.toMatchObject({code:'ENOENT'});
    expect(digest(await fs.readFile(path.join(f.version(1),'index.html')))).toBe(f.protectedHash);
    expect(await Promise.all(['current','previous'].map(n=>fs.readlink(path.join(f.publicRoot,n))))).toEqual(refs);
    expect(await fs.readdir(path.join(f.releaseRoot,'static-proofs'))).toEqual([id(1)+'.json',id(2)+'.json']);
  });

  it.each(['legacy','changed','added','data','symlink','hardlink','replaced','wrong-commit','wrong-target','corrupt-proof','public-proof'] as const)(
    'holds %s content without changing bytes or claiming removal',async(kind)=>{
      const f=await fixture();await f.make(3,kind!=='legacy');
      const file=path.join(f.version(3),'index.html'), proof=path.join(f.releaseRoot,'static-proofs',id(3)+'.json');
      if(kind==='changed')await fs.writeFile(file,Buffer.alloc(64*1024,99));
      if(kind==='added')await fs.writeFile(path.join(f.version(3),'unknown.db'),'unknown business bytes');
      if(kind==='data')await fs.mkdir(path.join(f.version(3),'.cds-run-data'));
      if(kind==='symlink')await fs.symlink(f.repo,path.join(f.version(3),'unknown-link'));
      if(kind==='hardlink')await fs.link(file,path.join(f.root,'retained-hardlink'));
      if(kind==='replaced'){await fs.rename(f.version(3),f.version(3)+'-retained');await fs.mkdir(f.version(3));await fs.writeFile(file,Buffer.alloc(64*1024,3));}
      if(kind==='corrupt-proof')await fs.writeFile(proof,'{');
      if(kind==='public-proof')await fs.chmod(proof,0o644);
      if(kind==='wrong-commit'||kind==='wrong-target'){
        const value=JSON.parse(await fs.readFile(proof,'utf8'));value[kind==='wrong-commit'?'commit':'target']='wrong';await fs.writeFile(proof,JSON.stringify(value));
      }
      const before=digest(await fs.readFile(file));const out=f.reclaim([3]);
      expect(out.removedVersions).toEqual([]);expect(out.heldReasons?.['version:'+id(3)]).toBeTruthy();
      expect(digest(await fs.readFile(file))).toBe(before);
      expect(digest(await fs.readFile(path.join(f.version(1),'index.html')))).toBe(f.protectedHash);
    });

  it('rechecks current/previous even when a caller supplies them as candidates and previews without deletion',async()=>{
    const f=await fixture();await f.make(3);
    const forced=f.reclaim([1,2]);expect(forced.removedVersions).toEqual([]);
    expect(forced.heldReasons).toMatchObject({['version:'+id(1)]:'static-current-or-previous',['version:'+id(2)]:'static-current-or-previous'});
    const preview=f.reclaim([3],true);expect(preview.removedVersions).toEqual([id(3)]);
    expect(await fs.readFile(path.join(f.version(3),'index.html'))).toHaveLength(64*1024);
    expect(await fs.readdir(path.join(f.releaseRoot,'static-proofs'))).not.toContain(id(3)+'.deleting');
  });

  it('fails closed on a running/stopped Docker mount and an in-flight target lock',async()=>{
    const f=await fixture();await f.make(3);const container='a'.repeat(64);
    await fs.writeFile(path.join(f.root,'bin','docker'),`#!/bin/sh\nif [ "$1" = ps ]; then echo ${container}; exit 0; fi\nif [ "$1" = inspect ]; then printf '%s\\n' '${JSON.stringify([{Type:'bind',Source:f.version(3)}])}'; exit 0; fi\nexit 1\n`,{mode:0o755});
    const mounted=f.reclaim([3]);expect(mounted.removedVersions).toEqual([]);
    expect(mounted.heldReasons?.['version:'+id(3)]).toBe('static-running-or-stopped-container');
    const locker=spawn('flock',['-x',path.join(f.releaseRoot,'.retention.lock'),'sh','-c','echo locked; cat'],{stdio:['pipe','pipe','pipe']});
    try{await once(locker.stdout,'data');const locked=f.reclaim([3]);expect(locked.queryError).toBe('release-or-reclaim-in-progress');expect(locked.removedVersions).toEqual([]);}
    finally{locker.stdin.end();await once(locker,'close');}
    expect(await fs.readFile(path.join(f.version(3),'index.html'))).toHaveLength(64*1024);
  });

  it('resumes a real SIGKILL after unlink without adopting later additions or clearing unknown terminal state',async()=>{
    const f=await fixture();await f.make(3,false);
    for(let i=0;i<5000;i++)await fs.writeFile(path.join(f.version(3),'part-'+i),Buffer.alloc(4096,i%256));
    execFileSync('python3',[helper,'seal',f.version(3),f.releaseRoot,'fixture',id(3),f.commit]);
    const child=spawn('/bin/sh',['-c',f.command([3])],{env:f.env,stdio:['ignore','pipe','pipe']});
    let output='',killedPid=0;child.stdout.on('data',bytes=>{output+=String(bytes);const m=output.match(/CDS_RELEASE_STATIC_RECLAIM_STARTED=\S+\t(\d+)/);if(m&&!killedPid){killedPid=Number(m[1]);process.kill(killedPid,'SIGKILL');}});
    const [code]=await once(child,'close');expect(code).not.toBe(0);expect(killedPid).toBeGreaterThan(0);
    const remaining=(await fs.readdir(f.version(3))).length;expect(remaining).toBeGreaterThan(0);expect(remaining).toBeLessThan(5001);
    expect(await fs.readFile(path.join(f.releaseRoot,'static-proofs',id(3)+'.deleting'),'utf8')).toContain('manifestSha256');
    const unknown=path.join(f.version(3),'business.db');await fs.writeFile(unknown,'late unknown bytes');
    const held=f.reclaim([3]);expect(held.removedVersions).toEqual([]);expect(held.failedVersions).toEqual([id(3)]);
    expect(await fs.readFile(unknown,'utf8')).toBe('late unknown bytes');
    await fs.unlink(unknown);const retried=f.reclaim([3]);expect(retried.failedVersions).toEqual([]);expect(retried.removedVersions).toEqual([id(3)]);
    expect(digest(await fs.readFile(path.join(f.version(1),'index.html')))).toBe(f.protectedHash);
  },30000);

  it('retains a real unlink permission failure and succeeds only after that filesystem fault is repaired',async()=>{
    const f=await fixture();await f.make(3);await fs.chmod(f.version(3),0o555);
    try{
      const failed=f.reclaim([3]);expect(failed.removedVersions).toEqual([]);expect(failed.failedVersions).toEqual([id(3)]);
      expect(await fs.readFile(path.join(f.version(3),'index.html'))).toHaveLength(64*1024);
    }finally{await fs.chmod(f.version(3),0o755);}
    expect(f.reclaim([3]).removedVersions).toEqual([id(3)]);
  });
});
