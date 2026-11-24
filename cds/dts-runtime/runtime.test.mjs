import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { redisShakeConfig } from './redis-shake.mjs';
import { captureNativeSecrets,forwardNativeLog } from './redaction.mjs';
test('RedisShake cannot turn an admitted batch into a full overwrite or AOF tail',()=>{
 const text=redisShakeConfig({cds_adapter:'redis-shake',version:'4.7.0',sourceUri:'redis://127.0.0.1:6379/2',targetUri:'redis://127.0.0.1:6380/3',entries:[{key:'business:one',expireAt:1799999999000}]},'/tmp/owned-native-job');
 assert.match(text,/allow_keys = \["business:one"\]/);assert.match(text,/"ABSTTL"/);assert.match(text,/rdb_restore_command_behavior = "skip"/);
 assert.doesNotMatch(text,/REPLACE|\[sync_reader\]/);assert.match(text,/empty_db_before_sync = false/);
 assert.throws(()=>redisShakeConfig({cds_adapter:'redis-shake',version:'4.7.0',sourceUri:'redis://127.0.0.1/2',targetUri:'redis://127.0.0.1/3',entries:[{key:'bad"\nkey',expireAt:0}]},'/tmp/owned-native-job'));
});
test('native logs mask URI-decoded credentials even across stream chunks',async()=>{
 captureNativeSecrets({uri:'mysql://app:private%40password@db/business'});
 const input=new PassThrough(),output=new PassThrough();let result='';output.on('data',b=>result+=b.toString());forwardNativeLog(input,output);
 input.write('driver password=private@pass');input.end('word; native status FAILED\n');await new Promise(r=>input.once('end',r));
 assert.doesNotMatch(result,/private@password/);assert.match(result,/\[REDACTED\]/);assert.match(result,/native status FAILED/);
});

test('concurrent native submissions spawn once and a confirmed stop remains terminal',{timeout:15000},async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),http=await import('node:http'),cp=await import('node:child_process'),events=await import('node:events');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dts-adapter-unit-')),counter=path.join(root,'starts'),binary=path.join(root,'fixture-native');
 await fs.writeFile(binary,'#!/bin/sh\nprintf \'%s\\n\' started >> "$DTS_FIXTURE_COUNTER"\ntrap \'exit 0\' TERM\nwhile :; do sleep 0.1; done\n',{mode:0o755});
 const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const worker=cp.spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{...process.env,DTS_FIXTURE_COUNTER:counter,DTS_RUNTIME_DATA:path.join(root,'jobs'),DTS_REDIS_SHAKE_BINARY:binary,DTS_ENGINE_USER:'fixture',DTS_ENGINE_PASSWORD:'fixture-private-adapter-password',DTS_RUNTIME_PORT:String(port)},stdio:'ignore'});
 const headers={authorization:'Basic '+Buffer.from('fixture:fixture-private-adapter-password').toString('base64'),'content-type':'application/json'},base='http://127.0.0.1:'+port;
 const call=(url,body)=>fetch(base+url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
 try{
  for(let i=0;i<100;i++){try{if((await call('/unsupported')).status===409)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  const job={cds_adapter:'redis-shake',version:'4.7.0',sourceUri:'redis://127.0.0.1/2',targetUri:'redis://127.0.0.1/3',entries:[{key:'business:one',expireAt:0}]},route='/submit-job?jobId=123&jobName=cds-dts-12345678-1234-1234-1234-123456789abc';
  const replies=await Promise.all([call(route,job),call(route,job)]);assert.ok(replies.some(r=>r.status===200));assert.ok(replies.every(r=>[200,409].includes(r.status)));
  assert.equal((await call(route,job)).status,200);
  for(let i=0;i<100;i++){try{if(await fs.readFile(counter,'utf8'))break;}catch{}await new Promise(r=>setTimeout(r,20));}
  assert.equal((await fs.readFile(counter,'utf8')).trim(),'started');
  assert.equal((await call('/stop-job',{jobId:123})).status,200);let status;
  for(let i=0;i<100;i++){status=await(await call('/job-info/123')).json();if(status.jobStatus==='CANCELED')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(status.jobStatus,'CANCELED');assert.equal(status.stopRequested,true);
  assert.equal((await call('/stop-job',{jobId:123})).status,200);assert.equal((await(await call('/job-info/123')).json()).jobStatus,'CANCELED');
 }finally{worker.kill('SIGTERM');await events.once(worker,'exit');await fs.rm(root,{recursive:true,force:true});}
});
