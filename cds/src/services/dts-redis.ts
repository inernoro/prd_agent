import { randomUUID } from 'node:crypto';
import { createClient, RESP_TYPES } from 'redis';
import type { DtsActor,DtsConnection,DtsMode,DtsPlan,DtsRedisEntry } from '../shared/dts.js';
import { compatibleDtsFields,dtsHash,dtsReject } from './dts-policy.js';
export const REDIS_SHAKE_VERSION='4.7.0';
function endpoint(c:DtsConnection,uri:string){const u=new URL(uri);if(u.protocol!=='redis:'||u.search||u.hash||! /^(?:[0-9]|1[0-5])$/.test(c.database))dtsReject('redis_endpoint_not_verified','当前只支持独立 Redis 的选定逻辑库和明确 key 前缀',409);u.pathname='/'+c.database;return u.href;}
const info=(raw:Buffer|string)=>Object.fromEntries(String(raw).split(/\r?\n/).filter(s=>s.includes(':')).map(s=>[s.slice(0,s.indexOf(':')),s.slice(s.indexOf(':')+1)]));
export async function redisDtsSnapshot(c:DtsConnection,uri:string){
 if(Object.keys(c.contract.fields).length!==1||c.contract.fields._id!=='string'||/session|token|secret|password|credential|auth/i.test(c.collection))dtsReject('redis_scope_not_verified','Redis 仅支持已批准业务 key 前缀，不能同步登录态和凭据命名空间',409);
 const client=createClient({url:endpoint(c,uri),socket:{connectTimeout:5000,reconnectStrategy:false},disableOfflineQueue:true}).withTypeMapping({[RESP_TYPES.BLOB_STRING]:Buffer});
 client.on('error',()=>undefined);const deadline=setTimeout(()=>client.destroy(),30000);deadline.unref();
 try{
  await client.connect();const clock=await client.sendCommand(['TIME']) as Buffer[];const offsetMs=Number(clock[0])*1000+Math.floor(Number(clock[1])/1000)-Date.now();const server=info(await client.info('server')),cluster=info(await client.info('cluster')),memory=info(await client.info('memory'));
  if(!['7.4.2','8.4.0'].includes(server.redis_version)||server.redis_mode!=='standalone'||cluster.cluster_enabled!=='0')dtsReject('redis_version_not_verified','当前 Redis 版本或集群模式尚未通过该适配器验证，已阻止写入',409);
  const entries:DtsRedisEntry[]=[],seen=new Set<string>();let cursor='0',bytes=0;
  do{
   const scan=await client.scan(cursor,{MATCH:c.collection+':*',COUNT:100});cursor=String(scan.cursor);
   for(const raw of scan.keys){const key=String(raw);if(!Buffer.from(key).equals(raw)||!/^[A-Za-z0-9_.:@-]{1,200}$/.test(key))dtsReject('redis_key_not_verified','选定范围含二进制或未验证的 key，已阻止有损同步',409);if(seen.has(key))continue;seen.add(key);
    if(seen.size>10000)dtsReject('selection_too_large','Redis 选定范围超过一万个 key，请缩小前缀',409);
    const type=String(await client.type(key));if(type==='none')continue;if(!['string','hash','list','set','zset','stream'].includes(type))dtsReject('redis_type_not_verified','选定 key 类型尚未完成无损验证，已阻止写入',409);
    const usage=Number(await client.memoryUsage(key));if(!Number.isFinite(usage)||usage>8*1024*1024)dtsReject('selection_too_large','单个 Redis 值超过当前已验证的容量',409);
    const dump=await client.dump(key),expireAt=Number(await client.pExpireTime(key));if(!dump||expireAt===-2)continue;
    bytes+=dump.length;if(bytes>8*1024*1024)dtsReject('selection_too_large','Redis 本次数据超过八 MiB 传输预算，请缩小前缀',409);
    entries.push({key,type,expireAt:Math.max(0,expireAt),digest:dtsHash(dump.toString('base64')),bytes:dump.length});
   }
  }while(cursor!=='0');
  entries.sort((a,b)=>a.key.localeCompare(b.key,'en'));
  return {entries,bytes,offsetMs,version:server.redis_version,memory,identity:server.run_id+'/'+c.database+'/'+c.collection,fingerprint:dtsHash({runId:server.run_id,version:server.redis_version,connection:c,uriDigest:dtsHash(uri)})};
 }finally{clearTimeout(deadline);if(client.isOpen)client.destroy();}
}
export async function prepareDtsRedisPlan(i:{projectId:string;source:DtsConnection;target:DtsConnection;sourceUri:string;targetUri:string;mode:DtsMode;actor:DtsActor;planId?:string;freeBytes:()=>Promise<number>}):Promise<DtsPlan>{
 const fields=compatibleDtsFields(i.source,i.target,i.mode);
 if(i.mode!=='append-only')dtsReject('redis_account_mode_not_verified','Redis 业务同步仅允许追加；账号资料校准请使用登记的持久数据库',409);
 const a=await redisDtsSnapshot(i.source,i.sourceUri),b=await redisDtsSnapshot(i.target,i.targetUri);
 if(a.identity===b.identity)dtsReject('same_dataset','源和目标实际指向同一份 Redis 数据，请选择独立的目标',409);
 if(Math.abs(a.offsetMs-b.offsetMs)>1000)dtsReject('redis_clock_skew','两端 Redis 时钟差异超过当前过期时间保护预算，请先校准时钟',409);
 if(a.version!==b.version)dtsReject('redis_rdb_version_not_verified','两端 Redis 版本不同，原生序列化格式尚未确认兼容，已阻止写入',409);
 const existing=new Set(b.entries.map(e=>e.key)),entries=a.entries.filter(e=>!existing.has(e.key));
 const selectedBytes=entries.reduce((sum,e)=>sum+e.bytes,0),requiredFreeBytes=selectedBytes*4+256*1024*1024,targetFreeBytes=await i.freeBytes();
 if(!Number.isFinite(targetFreeBytes)||targetFreeBytes<requiredFreeBytes)dtsReject('capacity_unavailable','Redis 目标磁盘可用空间不足或尚未核实，已阻止写入',409);
 if(b.memory.maxmemory_policy!=='noeviction'||Number(b.memory.maxmemory)-Number(b.memory.used_memory)<selectedBytes*4+32*1024*1024)dtsReject('redis_memory_unavailable','Redis 目标须有明确内存上限、足够余量并禁用淘汰，以保留已有业务数据',409);
 return {id:i.planId??randomUUID(),projectId:i.projectId,sourceId:i.source.id,targetId:i.target.id,mode:i.mode,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),sourceFingerprint:a.fingerprint,targetFingerprint:b.fingerprint,fields,sourceCount:a.entries.length,targetCount:b.entries.length,insertCount:entries.length,updateCount:0,skipCount:a.entries.length-entries.length,selectedBytes,targetFreeBytes,requiredFreeBytes,keys:entries.map(e=>e.key),selectedDigest:dtsHash(entries),approvedBy:i.actor,sourceContract:i.source.contract,targetContract:i.target.contract,redisEntries:entries};
}
export function buildDtsRedisJob(p:DtsPlan,s:DtsConnection,t:DtsConnection,su:string,tu:string){if(!p.redisEntries)dtsReject('redis_plan_invalid','Redis 比较记录尚未核实，请重新比较',409);return {cds_adapter:'redis-shake',version:REDIS_SHAKE_VERSION,sourceUri:endpoint(s,su),targetUri:endpoint(t,tu),entries:p.redisEntries};}
export async function verifyDtsRedisPlan(p:DtsPlan,s:DtsConnection,t:DtsConnection,su:string,tu:string){
 const a=await redisDtsSnapshot(s,su),b=await redisDtsSnapshot(t,tu),sm=new Map(a.entries.map(e=>[e.key,e])),tm=new Map(b.entries.map(e=>[e.key,e]));
 if(a.fingerprint!==p.sourceFingerprint||b.fingerprint!==p.targetFingerprint||!p.redisEntries)dtsReject('verification_mismatch','Redis 连接或服务身份已变化，请重新比较后续传',409);
 let count=0;for(const expected of p.redisEntries){const x=sm.get(expected.key),y=tm.get(expected.key);if(!x&&!y&&expected.expireAt>0&&expected.expireAt<=Date.now())continue;
  if(dtsHash(x)!==dtsHash(expected)||dtsHash(y)!==dtsHash(expected))dtsReject('verification_mismatch','Redis 源数据、值类型或绝对过期时间不一致，本次未通过对账',409);count++;
 }return count;
}
