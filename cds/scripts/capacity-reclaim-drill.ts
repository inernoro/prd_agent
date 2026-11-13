/** Real automatic Janitor -> private Git/files -> notice ledger -> loopback receiver.
 * Takes about90s with production timer values. Never uses a production daemon,
 * project, notification credential or filesystem path. Failure fixtures persist.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { JanitorService, defaultDiskUsage, defaultOrphanWorktreeFs } from '../src/services/janitor.js';
import { StateService } from '../src/services/state.js';
import { WorktreeService } from '../src/services/worktree.js';
import { worktreePathActivity, WorktreeClaimHeldError } from '../src/services/worktree-path-activity.js';
import { removeOwnedDirectory } from '../src/services/worktree-directory-removal-process.js';
import { NoticeLedgerService, startNoticeLedger } from '../src/services/notice-ledger.js';
import { flushAllJsonStateStores } from '../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, Project } from '../src/types.js';

const PAYLOAD = 64 * 1024**2;
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'capacity-native-')));
const disk = await fs.statfs(root);
if (disk.bavail * disk.bsize < 6 * 1024**3 + 31 * PAYLOAD) throw new Error('isolated drill needs2GiB plus6GiB remaining reserve');
const repo = path.join(root, 'repo'); await fs.mkdir(repo);
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const codeHashes = {
  janitor: hash(await fs.readFile(fileURLToPath(new URL('../src/services/janitor.ts',import.meta.url)))),
  drill: hash(await fs.readFile(fileURLToPath(import.meta.url))),
};
const du = (dir: string) => Number(execFileSync('du', ['-sx','--block-size=1','--',dir], {encoding:'utf8'}).split(/\s+/)[0]);
git('init','-b','main');git('config','user.name','Isolated capacity drill');git('config','user.email','capacity@example.invalid');
await fs.writeFile(path.join(repo,'payload.bin'),Buffer.alloc(PAYLOAD,61));git('add','.');git('commit','-m','隔离容量原生链路');
const base = path.join(root,'worktrees'), canonical = path.join(base,'project','main');
await fs.mkdir(path.dirname(canonical),{recursive:true});git('worktree','add','--detach',canonical,'HEAD');
const bucket = WorktreeService.deploymentSourceRootFor(canonical);await fs.mkdir(bucket,{recursive:true});
const old = new Date(Date.now()-4*3600_000);
async function make() {
  const dir=path.join(bucket,randomUUID());git('worktree','add','--detach',dir,'HEAD');await fs.utimes(dir,old,old);return dir;
}
const active=await make(),rollback=await make(),inflight=await make(),data=await make();
await fs.mkdir(path.join(data,'.cds-run-data'));await fs.writeFile(path.join(data,'.cds-run-data','db'),'business sentinel');await fs.utimes(data,old,old);
const disposable:string[]=[];for(let i=0;i<25;i++)disposable.push(await make());
const claim=worktreePathActivity.tryAcquire([inflight]);assert(claim);
const protectedHash=hash(await fs.readFile(path.join(rollback,'payload.bin')));
const state=new StateService(path.join(root,'state.json'));
state.addProject({id:'project',slug:'project',name:'Isolated capacity',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as Project);
state.addBranch({id:'branch',projectId:'project',branch:'main',worktreePath:canonical,status:'running',createdAt:new Date().toISOString(),services:{
  active:{profileId:'active',status:'running',sourceCheckoutPath:active,containerName:'isolated-active',hostPort:0},
  rollback:{profileId:'rollback',status:'stopped',sourceCheckoutPath:rollback,containerName:'isolated-rollback',hostPort:0},
}} as BranchEntry);
const requests:unknown[]=[];
const receiver=createServer(async(req,res)=>{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>65536){res.writeHead(413).end();return;}}
  const message=JSON.parse(body);
  if(req.method!=='POST'||req.url!=='/api/dashboard/notifications/events'||message.source!=='system-alert'||!message.dedupKey
    ||!['info','warning','error'].includes(message.level)||!message.actionUrl){res.writeHead(400).end('invalid isolated MAP contract');return;}
  requests.push({method:req.method,path:req.url,body:message});res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({success:true,data:{id:'isolated-receipt'}}));
});
await new Promise<void>(resolve=>receiver.listen(0,'127.0.0.1',resolve));
const address=receiver.address();assert(address&&typeof address!=='string');
const ledgerPath=path.join(root,'notices.json');const ledger=new NoticeLedgerService({storePath:ledgerPath});
const subscription=startNoticeLedger({ledger,outbound:{baseUrl:`http://127.0.0.1:${address.port}`,token:'isolated-fixture-token',source:'system-alert',publicOrigin:'http://127.0.0.1'}});
let failed=false;
const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},base,
  undefined,defaultDiskUsage,undefined,undefined,{...defaultOrphanWorktreeFs,listMountedHostPaths:async()=>[],removeDir:async(dir,options)=>{
    assert(options?.identity);options.beforeStart();
    if(!failed&&disposable.includes(dir)){failed=true;return 'controlled EIO before deletion';}
    const result=await removeOwnedDirectory({...options,identity:options.identity,dir});if(result==='held')throw new WorktreeClaimHeldError();return null;
  }});
const before=du(bucket),started=performance.now();let primary:unknown=null;let completed=false;let lastHeartbeat=-1;
try {
  janitor.start();
  while(performance.now()-started<150_000){
    const snapshot=janitor.getSnapshot();
    const heartbeat=Math.floor((performance.now()-started)/10_000);
    if(heartbeat!==lastHeartbeat){lastHeartbeat=heartbeat;console.log('[capacity-drill]',JSON.stringify({elapsedSeconds:heartbeat*10,
      sourceRemoved:snapshot.lastSweep?.deploymentSources?.removed??0,sourceDeferred:snapshot.lastSweep?.deploymentSources?.deferred??null}));}
    if(!primary&&snapshot.lastSweep){
      primary=structuredClone(snapshot.lastSweep);
      assert(snapshot.lastSweep.deploymentSources!.deferred>0);assert(failed);
      assert((await fs.readdir(bucket)).length>4); // first bounded pass leaves a backlog
    }
    if(primary&&(await fs.readdir(bucket)).length===4&&ledger.list().some(r=>r.eventType==='capacity.recovered'&&r.outbound?.status==='sent'))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  janitor.stop();
  assert.equal((await fs.readdir(bucket)).length,4,'autonomous continuation must reclaim all25 disposable caches');
  for(const dir of [active,rollback,inflight,data])assert.equal(hash(await fs.readFile(path.join(dir,'payload.bin'))),protectedHash);
  assert.equal(await fs.readFile(path.join(data,'.cds-run-data','db'),'utf8'),'business sentinel');
  assert.equal((git('worktree','list','--porcelain').match(/^worktree /gm)||[]).length,6); // repo,canonical,4 holds
  const warning=ledger.list().find(r=>r.eventType==='capacity.risk');assert.equal(warning?.outbound?.status,'sent');
  assert(ledger.list().some(r=>r.eventType==='capacity.recovered'&&r.outbound?.status==='sent'));
  const reloaded=new NoticeLedgerService({storePath:ledgerPath});assert(reloaded.list().some(r=>r.eventType==='capacity.risk'));
  const after=du(bucket),elapsedMs=performance.now()-started;
  const receipt={provenance:'integration-live isolated host/files/loopback receiver;NOT production MAP delivery',payloadBytes:PAYLOAD,disposable:25,
    beforeAllocatedBytes:before,afterAllocatedBytes:after,reclaimedAllocatedBytes:before-after,elapsedMs,primary,final:janitor.getSnapshot().lastSweep,
    protectedHash,activeRollbackInflightDataPreserved:true,failureRetried:true,automaticTimersUnmodified:true,
    noticeReloadVerified:true,receiverRequests:requests,sourceSha256:codeHashes};
  if(process.env.CAPACITY_NATIVE_EVIDENCE)await fs.writeFile(process.env.CAPACITY_NATIVE_EVIDENCE,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));completed=true;
} finally {
  janitor.stop();subscription.stop();claim.release();await new Promise<void>(resolve=>receiver.close(()=>resolve()));
  await flushAllJsonStateStores();
  if(completed)await fs.rm(root,{recursive:true,force:true});else console.error('isolated failure fixture retained:',root);
}
