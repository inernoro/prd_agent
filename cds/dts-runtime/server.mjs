/** Thin authenticated facade. SeaTunnel remains the execution engine; RedisShake is a verified native fallback. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual, createHash } from 'node:crypto';
import { captureNativeSecrets } from './redaction.mjs';
import { runRabbitTopology } from './rabbitmq.mjs';
import { redisShakeConfig, REDIS_SHAKE_VERSION } from './redis-shake.mjs';
const root=process.env.DTS_RUNTIME_DATA, binary=process.env.DTS_REDIS_SHAKE_BINARY;
const upstream=process.env.DTS_SEATUNNEL_ORIGIN||'http://127.0.0.1:8080';
const user=process.env.DTS_ENGINE_USER,password=process.env.DTS_ENGINE_PASSWORD;
if(!root||!path.isAbsolute(root)||!binary||!user||!password)throw new Error('Private adapter configuration is incomplete');
await fs.mkdir(root,{recursive:true,mode:0o700});
const auth='Basic '+Buffer.from(user+':'+password).toString('base64'),hash=v=>createHash('sha256').update(v).digest();
captureNativeSecrets({password,authorization:auth});
let admitting=false;
const writes=new Map();
const live=new Map(),terminal=new Set(['FINISHED','FAILED','CANCELED']);
const jobPath=id=>{if(!/^[0-9]{1,16}$/.test(id)||!Number.isSafeInteger(Number(id)))throw new Error('invalid job id');return path.join(root,id);};
async function read(id){try{return JSON.parse(await fs.readFile(path.join(jobPath(id),'receipt.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function write(row){
 const prior=writes.get(row.jobId)||Promise.resolve();
 const next=prior.catch(()=>undefined).then(async()=>{const dir=jobPath(row.jobId);await fs.mkdir(dir,{recursive:true,mode:0o700});const tmp=path.join(dir,'receipt.next');await fs.writeFile(tmp,JSON.stringify(row),{mode:0o600});await fs.rename(tmp,path.join(dir,'receipt.json'));});
 writes.set(row.jobId,next);const clean=()=>{if(writes.get(row.jobId)===next)writes.delete(row.jobId);};void next.then(clean,clean);return next;
}
async function submit(id,name,config){
 if(admitting)throw new Error('adapter admission busy');admitting=true;
 try{
 const digest=createHash('sha256').update(JSON.stringify(config)).digest('hex');
 const previous=await read(id);if(previous){if(previous.jobName!==name||previous.configDigest!==digest)throw new Error('job identity conflict');return previous;}
 if(live.size)throw new Error('adapter writer busy');
 // Unknown old processes keep admission closed. They are not assumed dead after a facade restart.
 for(const item of await fs.readdir(root,{withFileTypes:true}))if(item.isDirectory()&&/^\d+$/.test(item.name)){const r=await read(item.name);if(r&&!terminal.has(r.jobStatus))throw new Error('unconfirmed previous native process');}
 const directory=jobPath(id);
 if(config.cds_adapter==='rabbitmq-definitions'){
  const row={jobId:id,jobName:name,jobStatus:'RUNNING',configDigest:digest,adapter:'rabbitmq-definitions',version:'1',stopRequested:false,upstreamReceipts:[]};await write(row);live.set(id,{row});
  void runRabbitTopology(config,()=>row.stopRequested,async receipt=>{row.upstreamReceipts.push(receipt);await write(row);}).then(async complete=>{row.jobStatus=complete?'FINISHED':'CANCELED';await write(row);}).catch(async error=>{row.jobStatus=error.unconfirmed?'UNKNOWN':'FAILED';await write(row);}).finally(()=>live.delete(id));
  return row;
 }
 const text=redisShakeConfig(config,directory);
 await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(path.join(directory,'job.toml'),text,{mode:0o600});
 const row={jobId:id,jobName:name,jobStatus:'RUNNING',configDigest:digest,adapter:'redis-shake',version:REDIS_SHAKE_VERSION,stopRequested:false};await write(row);
 const child=spawn('/bin/sh',['-c','ulimit -f 16384; exec "$1" "$2"','dts-redis-shake',binary,path.join(directory,'job.toml')],{cwd:directory,stdio:'ignore'});live.set(id,{child,row});
 const deadline=setTimeout(()=>child.kill('SIGTERM'),300000);deadline.unref();
 const settle=async(code)=>{clearTimeout(deadline);row.jobStatus=row.stopRequested?'CANCELED':code===0?'FINISHED':'FAILED';row.exitCode=code;try{await write(row);await fs.rm(path.join(directory,'job.toml'),{force:true});}finally{live.delete(id);}};
 child.once('error',()=>void settle(-1).catch(()=>undefined));child.once('exit',code=>void settle(code??-1).catch(()=>undefined));
 return row;
 }finally{admitting=false;}
}
async function body(req){const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>8*1024*1024)throw new Error('request too large');chunks.push(b);}return chunks.length?Buffer.concat(chunks):undefined;}
const server=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(!timingSafeEqual(hash(req.headers.authorization||''),hash(auth))){res.writeHead(401);res.end(JSON.stringify({error:'unauthorized'}));return;}
 try{
  const u=new URL(req.url,'http://localhost'),raw=await body(req),input=raw?JSON.parse(raw.toString('utf8')):undefined;
  if(req.method==='POST'&&u.pathname==='/submit-job')captureNativeSecrets(input);
  let result;
  if(req.method==='POST'&&u.pathname==='/submit-job'&&input?.cds_adapter){const id=u.searchParams.get('jobId'),name=u.searchParams.get('jobName');if(!/^cds-dts-[a-f0-9-]{36}$/.test(name||''))throw new Error('invalid business request');result=await submit(id,name,input);}
  else if(req.method==='GET'&&u.pathname.startsWith('/job-info/')&&(result=await read(u.pathname.slice(10)))){}
  else if(req.method==='POST'&&u.pathname==='/stop-job'&&await read(String(input?.jobId))){
    const id=String(input.jobId),row=await read(id),current=live.get(id);
    if(!terminal.has(row.jobStatus)){if(!current)throw new Error('native identity unknown; protection retained');if(!terminal.has(current.row.jobStatus)){current.row.stopRequested=true;await write(current.row);current.child?.kill('SIGTERM');}}
    result={jobId:id};
  }else{
    // Restrict the facade to the same four native operations used by CDS, never arbitrary upstream paths.
    if(!((req.method==='GET'&&u.pathname==='/overview')||(req.method==='POST'&&u.pathname==='/submit-job')||(req.method==='GET'&&/^\/job-info\/\d+$/.test(u.pathname))||(req.method==='POST'&&u.pathname==='/stop-job')))throw new Error('unsupported operation');
    const r=await fetch(upstream+u.pathname+u.search,{method:req.method,headers:{authorization:auth,'content-type':'application/json'},body:raw,redirect:'error',signal:AbortSignal.timeout(20000)});
    const text=await r.text();if(text.length>1024*1024)throw new Error('upstream reply too large');result=JSON.parse(text);res.statusCode=r.status;
    if(u.pathname==='/overview'&&r.ok)result.cdsDtsAdapters={'redis-shake':REDIS_SHAKE_VERSION,'rabbitmq-definitions':'1'};
  }
  res.end(JSON.stringify(result));
 }catch{res.writeHead(409);res.end(JSON.stringify({error:'adapter_request_unconfirmed',message:'Native operation unavailable; query the original job before retrying'}));}
});
server.listen(Number(process.env.DTS_RUNTIME_PORT||18085),process.env.DTS_RUNTIME_HOST||'127.0.0.1');
for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{for(const {child,row} of live.values()){row.stopRequested=true;child?.kill('SIGTERM');}server.close();setTimeout(()=>process.exit(0),15000).unref();});
