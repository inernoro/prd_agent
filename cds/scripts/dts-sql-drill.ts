/** Explicit loopback fixture only. The original SeaTunnel JDBC connector performs every synchronized write. */
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { strict as assert } from 'node:assert';
import { DtsService } from '../src/services/dts.js';
import { DtsStore } from '../src/services/dts-store.js';
import { withDtsSql } from '../src/services/dts-sql.js';
import { parseDfAvailableBytes } from '../src/services/infra-backup-schedule.js';
import type { StateService } from '../src/services/state.js';
import type { ServerEventLogSink } from '../src/services/server-event-log-store.js';
import type { DtsConnection, DtsKind, DtsRun } from '../src/shared/dts.js';
const folder=process.env.DTS_DRILL_DIRECTORY;
if(!folder?.startsWith('/tmp/'))throw new Error('Explicit disposable drill directory required');
const auth=JSON.parse(await readFile(folder+'/engine-private.json','utf8'));
const env:Record<string,string>={MYSQL:'mysql://root:dts_disposable_1117@127.0.0.1:18891',POSTGRES:'postgres://postgres:dts_disposable_1117@127.0.0.1:18892',ENGINE_USER:auth.username,ENGINE_PASSWORD:auth.password};
const events:unknown[]=[],sink={async recordImmediate(e:unknown){events.push(e);await appendFile(folder+'/sql-drill-audit.jsonl',JSON.stringify(e)+'\n');},async findRecent(){return events;}} as unknown as ServerEventLogSink;
const project='dts_sql_qa',table='cds_dts_qa_records';
const store=new DtsStore('mongodb://127.0.0.1:18882','dts_sql_qa');
const service=new DtsService(store,{getCustomEnv:()=>env} as unknown as StateService,sink,async()=>true,undefined,{freeBytes:async c=>{
 const container=c.kind==='mysql'?'cds-dts-qa-mysql-1117':'cds-dts-qa-postgres-1117',dir=c.kind==='mysql'?'/var/lib/mysql':'/var/lib/postgresql/data';
 const local=process.env.DTS_DRILL_LOCAL_DOCKER==='1';
 const r=await promisify(execFile)(local?'docker':'ssh',local?['exec',container,'df','-Pk',dir]:['-o','BatchMode=yes','mycds','sudo','-n','docker','exec',container,'df','-Pk',dir],{timeout:15000});
 return parseDfAvailableBytes(r.stdout)??NaN;
}});
const actor={kind:'static' as const,id:'sql-qa'},results:unknown[]=[];
async function wait(id:string){for(let i=0;i<90;i++){const r=await service.refresh(project,id);if(['completed','failed','cancelled'].includes(r.status))return r;await new Promise(r=>setTimeout(r,1000));}throw new Error('SQL native job did not settle');}
try{
 await service.configureEngine(project,{baseUrl:'http://127.0.0.1:18885',version:'3.0.0',usernameEnv:'ENGINE_USER',passwordEnv:'ENGINE_PASSWORD'});
 for(const kind of ['mysql','postgres'] as DtsKind[]){
  const base={kind,collection:table,contract:{id:'sql-qa-profiles',version:1,accepts:[1],fields:{_id:'string',name:'string',revision:'int',big:'bigint',flag:'boolean',amount:'double',at:'timestamp'}},accountFields:['name','revision'],uriEnv:kind==='mysql'?'MYSQL':'POSTGRES'};
  if(process.env.DTS_DRILL_LOCAL_DOCKER==='1')await withDtsSql({...base,database:kind==='mysql'?'mysql':'postgres'} as DtsConnection,env[base.uriEnv],async db=>{for(const name of ['dts_source','dts_target'])await db.query(`CREATE DATABASE ${name}`);});
  for(const database of ['dts_source','dts_target'])await withDtsSql({...base,database} as DtsConnection,env[base.uriEnv],async db=>{
    // Only the uniquely named drill table in the two disposable fixed fixture databases is recreated.
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.query(`CREATE TABLE ${table} (_id varchar(200) ${kind==='mysql'?'COLLATE utf8mb4_bin':''} PRIMARY KEY,name varchar(200),revision int,big bigint,flag ${kind==='mysql'?'tinyint':'boolean'},amount ${kind==='mysql'?'double':'double precision'},at timestamp,local_only varchar(200))`);
    const values=database==='dts_source'?"('existing','production',2,9223372036854775806,"+(kind==='mysql'?'1':'true')+",1.25,'2026-11-17 01:02:03','source-private'),('new','新增账号',1,9223372036854775806,"+(kind==='mysql'?'0':'false')+",1.25,'2026-11-17 01:02:03',NULL)":"('existing','standby',1,1,"+(kind==='mysql'?'0':'false')+",0.5,'2026-11-16 01:02:03','keep'),('target-only','acceptance',1,1,"+(kind==='mysql'?'0':'false')+",0.5,'2026-11-16 01:02:03','keep')";
    await db.query(`INSERT INTO ${table} VALUES ${values}`);
  });
  const source=await service.addConnection(project,{...base,database:'dts_source',name:kind+' source',environmentRole:'production'}),target=await service.addConnection(project,{...base,database:'dts_target',name:kind+' target',environmentRole:'standby',allowWrite:true});
  for(const mode of ['append-only','account-authority'] as const){
   const p=await service.plan(project,source.id,target.id,mode,actor);assert.equal(p.insertCount,mode==='append-only'?1:0);
   const r=await service.start(project,p.id,kind+':'+mode+':'+p.id,actor),done=await wait(r.id);assert.equal(done.status,'completed',done.message);
   const rows=await withDtsSql(target,env[base.uriEnv],db=>db.query(`SELECT _id,name,local_only FROM ${table} ORDER BY _id`));
   assert.equal(rows.length,3);assert.equal(rows[0].local_only,'keep');assert.equal(rows[0].name,mode==='append-only'?'standby':'production');
   results.push({kind,mode,run:service.publicRun(done)});console.log('PASS',kind,mode,'native write + exact independent verification');
  }
  await withDtsSql(source,env[base.uriEnv],db=>db.query(`INSERT INTO ${table} (_id,name,revision,big,flag,amount,at) VALUES ('policy-new','policy-new',7,9223372036854775806,${kind==='mysql'?'1':'true'},1.25,'2026-11-17 01:02:03')`));
  await assert.rejects(service.plan(project,source.id,target.id,'account-authority',actor),/只追加/);
  const scheduled=await service.addPolicy(project,{sourceId:source.id,targetId:target.id},actor);
  await store.put('policies',{...scheduled,reconcileHour:0});await service.tick([project]);
  let saved=(await service.policies(project)).find(p=>p.id===scheduled.id)!;
  const discovered=await wait(saved.lastRunId!);assert.equal(discovered.status,'completed',discovered.message);assert.equal(discovered.plan.mode,'append-only');
  const inserted=await withDtsSql(target,env[base.uriEnv],db=>db.query(`SELECT big FROM ${table} WHERE _id='policy-new'`));assert.equal(String(inserted[0].big),'9223372036854775806');
  await withDtsSql(source,env[base.uriEnv],db=>db.query(`UPDATE ${table} SET revision=3,big=99 WHERE _id='existing'`));
  saved=(await service.policies(project)).find(p=>p.id===scheduled.id)!;
  await store.put('policies',{...saved,nextDiscoveryAt:new Date(0).toISOString()});await service.tick([project]);
  saved=(await service.policies(project)).find(p=>p.id===scheduled.id)!;
  const calibrated=await wait(saved.lastRunId!);assert.equal(calibrated.status,'completed',calibrated.message);assert.equal(calibrated.plan.mode,'account-authority');
  const preserved=await withDtsSql(target,env[base.uriEnv],db=>db.query(`SELECT revision,big,local_only FROM ${table} WHERE _id='existing'`));
  assert.equal(Number(preserved[0].revision),3);assert.equal(String(preserved[0].big),'1');assert.equal(preserved[0].local_only,'keep');
  await service.setPolicy(project,scheduled.id,false,actor);
  results.push({kind,policyCreatedFullRecord:true,policyPreservedNonProfileFields:true});console.log('PASS',kind,'policy inserts full contract then reconciles whitelist only');
  if(kind==='mysql'){
    await withDtsSql(target,env.MYSQL,db=>db.query(`CREATE UNIQUE INDEX cds_dts_qa_name ON ${table}(name)`));
    await assert.rejects(service.plan(project,source.id,target.id,'account-authority',actor),/额外唯一索引/);
    await assert.rejects(service.plan(project,source.id,target.id,'append-only',actor,true),/额外唯一索引/);
    console.log('PASS mysql secondary unique index blocks account overwrite');
  }
  if(kind==='postgres'){
    await withDtsSql(target,env[base.uriEnv],db=>db.query(`CREATE UNIQUE INDEX cds_dts_qa_name ON ${table}(name)`));
    await withDtsSql(source,env[base.uriEnv],db=>db.query(`UPDATE ${table} SET name='acceptance' WHERE _id='existing'`));
    const clash=await service.plan(project,source.id,target.id,'account-authority',actor);
    const clashRun=await service.start(project,clash.id,'postgres:secondary-unique:'+clash.id,actor),rejected=await wait(clashRun.id);
    assert.equal(rejected.status,'failed',rejected.message);
    const unchanged=await withDtsSql(target,env[base.uriEnv],db=>db.query(`SELECT _id,name,local_only FROM ${table} WHERE _id IN ('existing','target-only') ORDER BY _id`));
    assert.deepEqual(unchanged.map(r=>[r._id,r.name,r.local_only]),[['existing','production','keep'],['target-only','acceptance','keep']]);
    await withDtsSql(source,env[base.uriEnv],db=>db.query(`UPDATE ${table} SET name='production' WHERE _id='existing'`));
    const fresh=await service.control(project,rejected.id,'resume',actor),settled=await wait(fresh.id);assert.equal(settled.status,'completed',settled.message);
    results.push({kind,accountSecondaryUniqueConflictProtected:true});console.log('PASS postgres profile unique conflict fails without changing the conflicting account');
  }
  await withDtsSql(source,env[base.uriEnv],db=>db.query(`INSERT INTO ${table} (_id,name,revision) VALUES ('conflict','production',3)`));
  const conflictPlan=await service.plan(project,source.id,target.id,'append-only',actor);
  const conflictRun=await service.start(project,conflictPlan.id,kind+':conflict:'+conflictPlan.id,actor),failed=await wait(conflictRun.id);
  assert.equal(failed.status,'failed',failed.message);
  const kept=await withDtsSql(target,env[base.uriEnv],db=>db.query(`SELECT _id,name FROM ${table} WHERE name='production'`));assert.equal(kept[0]._id,'existing');
  await withDtsSql(source,env[base.uriEnv],db=>db.query(`UPDATE ${table} SET name='recovered' WHERE _id='conflict'`));
  const resumed=await service.control(project,failed.id,'resume',actor),recovered=await wait(resumed.id);assert.equal(recovered.status,'completed',recovered.message);
  results.push({kind,conflictStatus:failed.status,resumed:service.publicRun(recovered)});console.log('PASS',kind,'native uniqueness failure preserves target; fresh resume completes');
 }
 await writeFile(folder+'/sql-governed-results.json',JSON.stringify(results,null,2));
}finally{await store.close();}
