/** Explicit disposable loopback exercise of the governed RedisShake path, including native TTL preservation. */
import { readFile,appendFile,writeFile,statfs } from 'node:fs/promises';
import { createClient } from 'redis';
import { strict as assert } from 'node:assert';
import { DtsService } from '../src/services/dts.js';
import { DtsStore } from '../src/services/dts-store.js';
import type { StateService } from '../src/services/state.js';
import type { ServerEventLogSink } from '../src/services/server-event-log-store.js';
const folder=process.env.DTS_DRILL_DIRECTORY;if(!folder?.startsWith('/tmp/'))throw new Error('Explicit disposable directory required');
const port=process.env.DTS_REDIS_DRILL_PORT||'18883';if(!['18883','18894'].includes(port))throw new Error('Only owned loopback fixtures are allowed');
const a=JSON.parse(await readFile(folder+'/engine-private.json','utf8')),env={REDIS:'redis://127.0.0.1:'+port,ENGINE_USER:a.username,ENGINE_PASSWORD:a.password};
const source=createClient({url:env.REDIS+'/2'}),target=createClient({url:env.REDIS+'/3'});await source.connect();await target.connect();
const events:unknown[]=[],sink={async recordImmediate(e:unknown){events.push(e);await appendFile(folder+'/redis-governed-audit.jsonl',JSON.stringify(e)+'\n');},async findRecent(){return events;}} as unknown as ServerEventLogSink;
const store=new DtsStore('mongodb://127.0.0.1:18882','dts_redis_qa_'+port);
const service=new DtsService(store,{getCustomEnv:()=>env} as unknown as StateService,sink,async()=>true,undefined,{freeBytes:async()=>{const f=await statfs(folder);return f.bsize*f.bavail;}});
try{
 for(const db of [source,target]){let cursor='0';do{const r=await db.scan(cursor,{MATCH:'dtsqa:*',COUNT:100});cursor=r.cursor;for(const key of r.keys)await db.del(key);}while(cursor!=='0');}
 await source.set('dtsqa:existing','source',{PX:300000});await target.set('dtsqa:existing','target-must-remain',{PX:120000});await target.set('dtsqa:target-only','keep');
 await source.set('dtsqa:new','中文',{PX:300000});await source.hSet('dtsqa:hash',{one:'一',two:'二'});await source.rPush('dtsqa:list',['one','two']);await source.sAdd('dtsqa:set',['one','two']);await source.zAdd('dtsqa:zset',[{score:1.5,value:'one'},{score:2.5,value:'two'}]);await source.xAdd('dtsqa:stream','1-0',{f:'v'});await source.xGroupCreate('dtsqa:stream','qa-group','0');
 const expiry=await source.pExpireTime('dtsqa:new'),existingExpiry=await target.pExpireTime('dtsqa:existing');
 await service.configureEngine('redis-qa',{baseUrl:'http://127.0.0.1:'+(process.env.DTS_DRILL_ENGINE_PORT||'18887'),version:'3.0.0',usernameEnv:'ENGINE_USER',passwordEnv:'ENGINE_PASSWORD'});
 const base={kind:'redis',uriEnv:'REDIS',collection:'dtsqa',contract:{id:'business-cache',version:1,accepts:[1],fields:{_id:'string'}},accountFields:[]};
 const s=await service.addConnection('redis-qa',{...base,name:'source',database:'2',environmentRole:'production'}),t=await service.addConnection('redis-qa',{...base,name:'target',database:'3',environmentRole:'standby',allowWrite:true});
 const actor={kind:'static' as const,id:'qa'},p=await service.plan('redis-qa',s.id,t.id,'append-only',actor);assert.equal(p.insertCount,6);assert.equal(p.skipCount,1);
 const r=await service.start('redis-qa',p.id,'redis-native:'+p.id,actor);let done;
 for(let i=0;i<90;i++){done=await service.refresh('redis-qa',r.id);if(['completed','failed','cancelled'].includes(done.status))break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(done?.status,'completed',done?.message);assert.equal(done.appliedCount,6);
 assert.equal(await target.get('dtsqa:existing'),'target-must-remain');assert.equal(await target.pExpireTime('dtsqa:existing'),existingExpiry);assert.equal(await target.pExpireTime('dtsqa:new'),expiry);assert.equal(await target.get('dtsqa:target-only'),'keep');assert.equal((await target.xInfoGroups('dtsqa:stream'))[0].name,'qa-group');
 await writeFile(folder+'/redis-governed-results-'+port+'.json',JSON.stringify(service.publicRun(done),null,2));
 console.log('PASS governed RedisShake native append + exact six-type/stream metadata/absolute TTL verification + target preservation');
}finally{source.destroy();target.destroy();await store.close();}
