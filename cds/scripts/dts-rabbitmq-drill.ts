/** Disposable RabbitMQ 3.13 vhosts only; no production AMQP connection or message consumption. */
import { readFile,appendFile,writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { DtsService } from '../src/services/dts.js';
import { DtsStore } from '../src/services/dts-store.js';
import type { StateService } from '../src/services/state.js';
import type { ServerEventLogSink } from '../src/services/server-event-log-store.js';
const folder=process.env.DTS_DRILL_DIRECTORY;if(!folder?.startsWith('/tmp/'))throw new Error('Explicit disposable directory required');
const a=JSON.parse(await readFile(folder+'/engine-private.json','utf8')),uri='http://dts_qa:dts_disposable_1117@127.0.0.1:18893/';
async function call(route:string,body?:unknown,method=body?'PUT':'GET'){
 const r=await fetch('http://127.0.0.1:18893/api/'+route,{method,headers:{authorization:'Basic '+Buffer.from('dts_qa:dts_disposable_1117').toString('base64'),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(!r.ok)throw new Error('Disposable RabbitMQ setup/status failed: '+r.status);const text=await r.text();return text?JSON.parse(text):null;
}
const env={RABBIT:uri,ENGINE_USER:a.username,ENGINE_PASSWORD:a.password},events:unknown[]=[],sink={async recordImmediate(e:unknown){events.push(e);await appendFile(folder+'/rabbit-governed-audit.jsonl',JSON.stringify(e)+'\n');},async findRecent(){return events;}} as unknown as ServerEventLogSink;
const store=new DtsStore('mongodb://127.0.0.1:18882','dts_rabbit_qa'),service=new DtsService(store,{getCustomEnv:()=>env} as unknown as StateService,sink,async()=>true);
try{
 for(const db of ['dts_source','dts_target']){
  await call('vhosts/'+db,{});await call('permissions/'+db+'/dts_qa',{configure:'.*',write:'.*',read:'.*'});
  // Re-create only the uniquely prefixed topology owned by this drill.
  const defs=await call('definitions/'+db);for(const q of defs.queues.filter((x:{name:string})=>x.name.startsWith('dtsqa.')))await call('queues/'+db+'/'+encodeURIComponent(q.name),undefined,'DELETE');for(const x of defs.exchanges.filter((x:{name:string})=>x.name.startsWith('dtsqa.')))await call('exchanges/'+db+'/'+encodeURIComponent(x.name),undefined,'DELETE');
  await call('queues/'+db+'/dtsqa.existing',{durable:true,auto_delete:false,arguments:{'x-queue-type':'classic'}});
 }
 await call('queues/dts_target/dtsqa.target-only',{durable:true,auto_delete:false,arguments:{'x-queue-type':'classic'}});
 await call('queues/dts_source/dtsqa.new',{durable:true,auto_delete:false,arguments:{'x-queue-type':'classic'}});
 await call('exchanges/dts_source/dtsqa.events',{type:'direct',durable:true,auto_delete:false,internal:false,arguments:{}});
 await call('bindings/dts_source/e/dtsqa.events/q/dtsqa.new',{routing_key:'created',arguments:{}},'POST');
 // A published message stays on the source: topology sync must never consume or copy it.
 await call('exchanges/dts_source/amq.default/publish',{properties:{},routing_key:'dtsqa.new',payload:'source-message-must-remain',payload_encoding:'string'},'POST');
 await service.configureEngine('rabbit-qa',{baseUrl:'http://127.0.0.1:'+(process.env.DTS_DRILL_ENGINE_PORT||'18887'),version:'3.0.0',usernameEnv:'ENGINE_USER',passwordEnv:'ENGINE_PASSWORD'});
 const base={kind:'rabbitmq',uriEnv:'RABBIT',collection:'dtsqa',contract:{id:'rabbit-business-topology',version:1,accepts:[1],fields:{_id:'string'}},accountFields:[]};
 const s=await service.addConnection('rabbit-qa',{...base,name:'source',database:'dts_source',environmentRole:'production'}),t=await service.addConnection('rabbit-qa',{...base,name:'target',database:'dts_target',environmentRole:'standby',allowWrite:true});
 const actor={kind:'static' as const,id:'qa'},p=await service.plan('rabbit-qa',s.id,t.id,'append-only',actor);assert.equal(p.insertCount,3);assert.equal(p.skipCount,1);
 const r=await service.start('rabbit-qa',p.id,'rabbit-native:'+p.id,actor);let done;
 for(let i=0;i<60;i++){done=await service.refresh('rabbit-qa',r.id);if(['completed','failed','cancelled'].includes(done.status))break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(done?.status,'completed',done?.message);assert.equal(done.appliedCount,3);
 const defs=await call('definitions/dts_target');assert.ok(defs.queues.some((q:{name:string})=>q.name==='dtsqa.target-only'));assert.ok(defs.bindings.some((b:{source:string})=>b.source==='dtsqa.events'));
 const sourceQueue=await call('queues/dts_source/dtsqa.new');assert.equal(sourceQueue.messages,1);const targetQueue=await call('queues/dts_target/dtsqa.new');assert.equal(targetQueue.messages,0);
 await call('exchanges/dts_target/dtsqa.events',undefined,'DELETE');await call('exchanges/dts_target/dtsqa.events',{type:'fanout',durable:true,auto_delete:false,internal:false,arguments:{}});
 await assert.rejects(service.plan('rabbit-qa',s.id,t.id,'append-only',actor),/冲突/);assert.equal((await call('exchanges/dts_target/dtsqa.events')).type,'fanout');
 await writeFile(folder+'/rabbit-governed-results.json',JSON.stringify({run:service.publicRun(done),sourceMessages:sourceQueue.messages,targetMessages:targetQueue.messages,conflictPreserved:true},null,2));
 console.log('PASS native RabbitMQ topology append + independent verification + target-only preservation + conflict blocks overwrite + source message untouched');
}finally{await store.close();}
