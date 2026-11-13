import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_RETENTION_PROGRAM } from '../../src/services/backup-retention-program.js';
import { BackupRetentionService } from '../../src/services/backup-retention.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
const roots:string[]=[];const now=Date.now();
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'backup-output-lifecycle-'));roots.push(directory);
 const proc=fs.mkdtempSync(path.join(os.tmpdir(),'backup-output-proc-'));roots.push(proc);fs.mkdirSync(path.join(proc,String(process.pid)));fs.symlinkSync(`/proc/${process.pid}/fd`,path.join(proc,String(process.pid),'fd'));
 const program=BACKUP_RETENTION_PROGRAM.replace('def backup_mount_references():\n','def backup_mount_references():\n return [] # Unit descriptor fixture; Docker mounts are exercised in the real VM.\n').replace("pathlib.Path('/proc')",`pathlib.Path(${JSON.stringify(proc)})`);
 const defaults={directories:[directory],catalog:path.join(directory,'.cds-retention'),instanceId:'owned',nowMs:now,disposition:'reproducible-artifact',attestedBy:'unit-fixture-owner',dispositionReason:'Synthetic fixture bytes, no business data'};
 const run=(input:Record<string,unknown>)=>JSON.parse(execFileSync('python3',['-c',program],{input:JSON.stringify({...defaults,...input}),encoding:'utf8'}));
 const output=path.join(directory,'.tmp/round-unique/test.archive.gz');fs.mkdirSync(path.dirname(output),{recursive:true});
 return {directory,program,defaults,run,output};
}
describe('temporary backup output birth and retirement',()=>{
 it('keeps a nonempty unfinished business export until a verified backup of the same source exists',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db',disposition:'business-backup',sourceFingerprint:'a'.repeat(64)});fs.writeFileSync(f.output,'partial business-like fixture');f.run({action:'close-output',path:f.output});
  expect(f.run({action:'reconcile'}).held.some((row:any)=>row.reason==='unfinished-business-backup-needs-verified-replacement')).toBe(true);
  const replacement=path.join(f.directory,'complete.gz');fs.writeFileSync(replacement,gzipSync('complete synthetic replacement'));
  f.run({action:'register',path:replacement,projectId:'p',serviceId:'db',origin:'automatic',disposition:'business-backup',sourceFingerprint:'a'.repeat(64),sourceComplete:true});
  expect(f.run({action:'reconcile'}).removed).toEqual([f.output]);expect(fs.existsSync(replacement)).toBe(true);
 });
 it('promotes by the registered inode without overwriting an existing recovery point',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,gzipSync('new synthetic export'));const final=path.join(f.directory,'existing.gz');fs.writeFileSync(final,gzipSync('preserve existing recovery'));const original=fs.readFileSync(final);
  expect(()=>f.run({action:'promote-output',path:f.output,destination:final})).toThrow();expect(fs.readFileSync(final)).toEqual(original);expect(fs.existsSync(f.output)).toBe(true);
 });
 it('retains an interrupted promoted backup and rejects a replaced inode before registration',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,gzipSync('complete synthetic export'));const final=path.join(f.directory,'promoted.gz');
  f.run({action:'promote-output',path:f.output,destination:final});expect(f.run({action:'reconcile'}).unknown.some((row:any)=>row.path===final&&row.reason==='promoted-backup-awaits-owner-registration')).toBe(true);
  fs.renameSync(final,final+'.original');fs.writeFileSync(final,gzipSync('replacement foreign object'));
  expect(()=>f.run({action:'register',path:final,projectId:'p',serviceId:'db',origin:'automatic',requireManagedOutput:true,sourceFingerprint:'a'.repeat(64),sourceComplete:true})).toThrow();expect(fs.existsSync(final+'.original')).toBe(true);
 });
 it('clears only the promotion metadata after the exact final backup is registered',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,gzipSync('synthetic final export'));const final=path.join(f.directory,'complete.gz');
  f.run({action:'promote-output',path:f.output,destination:final});f.run({action:'register',path:final,projectId:'p',serviceId:'db',origin:'automatic',requireManagedOutput:true,disposition:'business-backup',sourceFingerprint:'a'.repeat(64),sourceComplete:true});
  fs.rmdirSync(path.dirname(f.output));expect(f.run({action:'reconcile'}).removed).toEqual([]);expect(fs.existsSync(final)).toBe(true);
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(f.directory,'.cds-retention/backups.json'),'utf8')).outputs)).toEqual([]);
 });
 it('writes a real cancellation marker scoped to the current job identity',async()=>{
  const f=fixture();f.run({action:'lease',projectId:'p',serviceId:'db',token:'token',kind:'restore'});
  const service=new BackupRetentionService({shell:new ShellExecutor(),state:{} as any,repoRoot:f.directory,instanceId:'owned'});
  (service as any).execution={id:'a'.repeat(32),status:'running',startedAt:new Date().toISOString(),directory:f.directory};
  await service.cancel('a'.repeat(32));expect(fs.statSync(path.join(f.directory,'.cds-retention','cancel-'+'a'.repeat(32))).isFile()).toBe(true);
  await expect(service.cancel('b'.repeat(32))).rejects.toThrow();
 });
 it('retires failed gzip output by its registered identity, while preserving an undeclared file',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,'failed-partial-gzip');
  f.run({action:'close-output',path:f.output});fs.writeFileSync(path.join(path.dirname(f.output),'unknown.gz'),'unknown');
  const result=f.run({action:'reconcile'});expect(result.removed).toEqual([f.output]);expect(result.unknown).toHaveLength(1);expect(fs.readFileSync(path.join(path.dirname(f.output),'unknown.gz'),'utf8')).toBe('unknown');
 });
 it('protects leases and open FDs, then expires abandoned outputs after 24h',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,'partial');
  const lease={projectId:'p',serviceId:'db',token:'test-token',kind:'backup'};f.run({action:'lease',...lease});f.run({action:'close-output',path:f.output});
  expect(f.run({action:'reconcile'}).removed).toEqual([]);f.run({action:'release',...lease});const fd=fs.openSync(f.output,'r');
  try{expect(f.run({action:'reconcile'}).held.some((r:any)=>r.reason==='file-still-open')).toBe(true);}finally{fs.closeSync(fd);}
  expect(f.run({action:'reconcile'}).removed).toEqual([f.output]);
  fs.mkdirSync(path.dirname(f.output),{recursive:true});f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.writeFileSync(f.output,'interrupted');
  expect(f.run({action:'reconcile'}).removed).toEqual([]);expect(f.run({action:'reconcile',nowMs:now+86400001}).removed).toEqual([f.output]);
 });
 it('preserves a replacement output and a replaced round directory',()=>{
  const f=fixture();f.run({action:'output',path:f.output,projectId:'p',serviceId:'db'});fs.renameSync(f.output,f.output+'.original');fs.writeFileSync(f.output,'replacement');
  let result=f.run({action:'reconcile',nowMs:now+2*86400000});expect(result.removed).toEqual([]);expect(result.held.some((r:any)=>r.reason==='temporary-output-identity-changed')).toBe(true);
  fs.renameSync(path.dirname(f.output),path.dirname(f.output)+'-original');fs.mkdirSync(path.dirname(f.output));fs.writeFileSync(f.output,'replacement-round');
  result=f.run({action:'reconcile',nowMs:now+2*86400000});expect(result.removed).toEqual([]);expect(fs.readFileSync(f.output,'utf8')).toBe('replacement-round');
 });
 it('allows a new restore lease during checksum work, then revalidates it before deletion',async()=>{
  const f=fixture(),file=path.join(f.directory,'old.gz');fs.writeFileSync(file,gzipSync('known recovery point'));fs.utimesSync(file,new Date(now-20*86400000),new Date(now-20*86400000));f.run({action:'register',path:file,projectId:'p',serviceId:'db',origin:'historical',disposition:'reproducible-artifact',attestedBy:'unit-fixture-owner',dispositionReason:'synthetic bytes in unit fixture'});
  // Explicit checksum pause only in this unit fixture; the production worker is unchanged.
  const paused=f.program.replace('try:return proof(p,verify)',`try:\n  if req.get('pauseHash'):\n   pathlib.Path(${JSON.stringify(path.join(f.directory,'hash-paused'))}).touch()\n   while not pathlib.Path(${JSON.stringify(path.join(f.directory,'continue-hash'))}).exists():time.sleep(.01)\n  return proof(p,verify)`);
  const child=spawn('python3',['-c',paused],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);const ended=new Promise<number|null>(resolve=>child.once('exit',resolve));child.stdin.end(JSON.stringify({...f.defaults,action:'reconcile',pauseHash:true}));
  try{
   const until=Date.now()+3000;while(!fs.existsSync(path.join(f.directory,'hash-paused'))){if(Date.now()>until)throw new Error('Checksum fixture did not pause');await new Promise(r=>setTimeout(r,5));}
   f.run({action:'lease',projectId:'p',serviceId:'db',token:'concurrent-restore',kind:'restore'});
   const competing=f.run({action:'reconcile'});expect(competing.removed).toEqual([]);expect(competing.held.some((r:any)=>r.reason.includes('execution-still-active'))).toBe(true);
   fs.writeFileSync(path.join(f.directory,'continue-hash'),'continue');expect(await ended,stderr).toBe(0);const result=JSON.parse(stdout);expect(result.removed).toEqual([]);expect(result.held.some((r:any)=>r.reason==='active-backup-or-restore-lease')).toBe(true);expect(fs.existsSync(file)).toBe(true);
  }finally{child.kill('SIGKILL');await ended;}
 });
});
