import { randomUUID } from 'node:crypto';
import type { DtsActor,DtsConnection,DtsMode,DtsPlan,DtsRabbitObject } from '../shared/dts.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { compatibleDtsFields,dtsHash,dtsReject } from './dts-policy.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
async function read(c:DtsConnection,uri:string,route:string,sink:ServerEventLogSink|null|undefined,businessId:string){
 const url=new URL(uri);if(!['http:','https:'].includes(url.protocol)||url.search||url.hash||url.pathname!=='/'||!url.username||!url.password)dtsReject('rabbit_management_required','RabbitMQ 拓扑同步需引用已有私密管理接口连接，不能使用消息消费地址',409);
 const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password),auth=Buffer.from(user+':'+password).toString('base64');url.username='';url.password='';
 const endpoint=new URL('api/'+route,url).href,start=Date.now();let response:Response|undefined,raw='',parsed:unknown,decision='unknown';
 const audit=createExternalResponseAudit(sink,{projectId:c.projectId,remoteProjectId:c.projectId,policy:'dts-rabbitmq',dryRun:true,businessRequestId:businessId},{source:'dts',action:'dts.rabbitmq.response',message:'消息服务拓扑预检响应'});audit.assertAvailable();
 try{
  response=await fetch(endpoint,{headers:{authorization:'Basic '+auth},redirect:'error',signal:AbortSignal.timeout(10000)});
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;if(reader)for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>1024*1024){await reader.cancel();dtsReject('rabbit_response_limit','RabbitMQ 拓扑超出当前已验证的容量，请缩小范围',409);}chunks.push(n.value);}raw=Buffer.concat(chunks).toString('utf8');parsed=JSON.parse(raw);
  if(!response.ok)dtsReject('rabbit_unavailable','无法读取选定 RabbitMQ 虚拟主机，请核对管理权限与连接',503);decision='success';return parsed as Record<string,unknown>;
 }finally{await audit.record({peerId:c.id,url:endpoint,method:'GET',startedAt:new Date(start).toISOString(),durationMs:Date.now()-start,timeoutMs:10000,responseReceived:Boolean(response),httpStatus:response?.status??null,contentType:response?.headers.get('content-type')??null,upstreamRequestId:null,text:raw,json:parsed,parseState:parsed?'json':'unparsed',localDecision:decision,secrets:[uri,user,password,auth]});}
}
const value=(v:unknown)=>v as Record<string,unknown>;
function topology(c:DtsConnection,definitions:Record<string,unknown>):DtsRabbitObject[]{
 if(Object.keys(c.contract.fields).length!==1||c.contract.fields._id!=='string')dtsReject('rabbit_scope_not_verified','RabbitMQ 仅支持选定拓扑前缀，不支持字段转换，请使用固定范围契约',409);
 const prefix=c.collection+'.',out:DtsRabbitObject[]=[];
 for(const [kind,key] of [['exchange','exchanges'],['queue','queues']] as const)for(const x of (definitions[key]??[]) as Record<string,unknown>[]){
  if(typeof x.name!=='string'||!x.name.startsWith(prefix))continue;
  if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(x.name)||x.auto_delete!==false||x.durable!==true)dtsReject('rabbit_topology_not_verified','仅支持选定前缀的持久拓扑，临时或自动删除对象尚未开放',409);
  const args={...value(x.arguments??{})};
  if(kind==='queue'){
   if(Object.keys(args).some(k=>k!=='x-queue-type')||(args['x-queue-type']&&args['x-queue-type']!=='classic'))dtsReject('rabbit_queue_not_verified','当前仅验证经典队列拓扑，其他队列参数需先验证',409);
   args['x-queue-type']='classic';
  }else if(Object.keys(args).length||!['direct','topic','fanout','headers'].includes(String(x.type))||x.internal!==false)dtsReject('rabbit_exchange_not_verified','交换器类型或参数尚未验证，已阻止写入',409);
  out.push({kind,id:kind+':'+x.name,value:{name:x.name,durable:true,auto_delete:false,arguments:args,...(kind==='exchange'?{type:x.type,internal:false}:{})}});
 }
 for(const x of (definitions.bindings??[]) as Record<string,unknown>[]){
  if(typeof x.source!=='string'||!x.source.startsWith(prefix)||typeof x.destination!=='string'||!x.destination.startsWith(prefix))continue;
  if(!['queue','exchange'].includes(String(x.destination_type))||typeof x.routing_key!=='string'||x.routing_key.length>200)dtsReject('rabbit_binding_not_verified','绑定范围尚未核实，已阻止写入',409);
  if(Object.keys(value(x.arguments??{})).length)dtsReject('rabbit_binding_parameters_not_verified','带参数的消息绑定尚未完成无损验证，已阻止写入',409);
  const v={source:x.source,destination:x.destination,destination_type:x.destination_type,routing_key:x.routing_key,arguments:x.arguments??{}};
  out.push({kind:'binding',id:'binding:'+dtsHash(v),value:v});
 }
 if(out.length>200||Buffer.byteLength(JSON.stringify(out))>1024*1024)dtsReject('selection_too_large','RabbitMQ 首轮每批最多两百个拓扑对象，请缩小前缀',409);
 return out.sort((a,b)=>a.id.localeCompare(b.id,'en'));
}
async function snapshot(c:DtsConnection,uri:string,sink:ServerEventLogSink|null|undefined,id:string,target=false){
 const overview=await read(c,uri,'overview',sink,id),version=String(overview.rabbitmq_version);
 if(!version.startsWith('3.13.'))dtsReject('rabbit_version_not_verified','该 RabbitMQ 版本尚未完成拓扑同步验证，已阻止写入',409);
 const defs=await read(c,uri,'definitions/'+encodeURIComponent(c.database),sink,id),objects=topology(c,defs);
 let freeBytes=0;
 if(target){
  const nodes=await read(c,uri,'nodes',sink,id) as unknown as Record<string,unknown>[];
  if(!Array.isArray(nodes)||!nodes.length||nodes.some(n=>n.running!==true||n.disk_free_alarm||n.mem_alarm||!Array.isArray(n.partitions)||n.partitions.length||!Number.isFinite(Number(n.disk_free))))dtsReject('rabbit_capacity_unknown','RabbitMQ 节点容量、分区或健康状态未通过检查，已阻止写入',409);
  freeBytes=Math.min(...nodes.map(n=>Number(n.disk_free)-Number(n.disk_free_limit)));
  const channels=await read(c,uri,'channels',sink,id) as unknown as Record<string,unknown>[];
  if(!Array.isArray(channels)||channels.some(ch=>ch.vhost===c.database))dtsReject('rabbit_target_active','目标虚拟主机仍有活动消息通道，请先隔离消费者和发布者再同步拓扑',409);
 }
 return {objects,version,freeBytes,fingerprint:dtsHash({connection:c,uriDigest:dtsHash(uri),version,node:overview.node}),identity:String(overview.cluster_name)+'/'+c.database+'/'+c.collection};
}
export async function prepareDtsRabbitPlan(i:{projectId:string;source:DtsConnection;target:DtsConnection;sourceUri:string;targetUri:string;mode:DtsMode;actor:DtsActor;planId?:string;sink:ServerEventLogSink|null|undefined}):Promise<DtsPlan>{
 const fields=compatibleDtsFields(i.source,i.target,i.mode);if(i.mode!=='append-only')dtsReject('rabbit_account_mode_not_verified','RabbitMQ 首轮仅追加拓扑配置，不同步账号凭据或消费消息',409);
 const id=i.planId??randomUUID(),a=await snapshot(i.source,i.sourceUri,i.sink,id),b=await snapshot(i.target,i.targetUri,i.sink,id,true);
 if(a.identity===b.identity)dtsReject('same_dataset','源和目标实际指向同一 RabbitMQ 拓扑，请选择独立的虚拟主机',409);
 if(a.version!==b.version)dtsReject('incompatible_version','两端 RabbitMQ 版本不同，尚未确认配置兼容，已阻止写入',409);
 const existing=new Map(b.objects.map(o=>[o.id,o]));
 if(a.objects.some(o=>existing.has(o.id)&&dtsHash(existing.get(o.id))!==dtsHash(o)))dtsReject('rabbit_topology_conflict','已有拓扑与正式环境定义冲突，已保留目标配置并阻止写入；请先核对对象范围',409);
 const selected=a.objects.filter(o=>!existing.has(o.id)),selectedBytes=Buffer.byteLength(JSON.stringify(selected)),requiredFreeBytes=256*1024*1024+selectedBytes*4;
 if(b.freeBytes<requiredFreeBytes)dtsReject('capacity_unavailable','RabbitMQ 目标磁盘余量不足，已阻止新增拓扑',409);
 return {id,projectId:i.projectId,sourceId:i.source.id,targetId:i.target.id,mode:i.mode,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),sourceFingerprint:a.fingerprint,targetFingerprint:b.fingerprint,fields,sourceCount:a.objects.length,targetCount:b.objects.length,insertCount:selected.length,updateCount:0,skipCount:a.objects.length-selected.length,selectedBytes,targetFreeBytes:b.freeBytes,requiredFreeBytes,keys:selected.map(o=>o.id),selectedDigest:dtsHash(selected),approvedBy:i.actor,sourceContract:i.source.contract,targetContract:i.target.contract,rabbitObjects:selected};
}
export function buildDtsRabbitJob(p:DtsPlan,_s:DtsConnection,t:DtsConnection,_su:string,tu:string){if(!p.rabbitObjects)dtsReject('rabbit_plan_invalid','拓扑比较记录无效，请重新比较',409);const order={exchange:0,queue:1,binding:2};return {cds_adapter:'rabbitmq-definitions',version:'1',targetUri:tu,vhost:t.database,objects:[...p.rabbitObjects].sort((a,b)=>order[a.kind]-order[b.kind])};}
export async function verifyDtsRabbitPlan(p:DtsPlan,s:DtsConnection,t:DtsConnection,su:string,tu:string,sink:ServerEventLogSink|null|undefined){
 const a=await snapshot(s,su,sink,p.id),b=await snapshot(t,tu,sink,p.id),keys=new Set(p.keys);
 if(a.fingerprint!==p.sourceFingerprint||b.fingerprint!==p.targetFingerprint||dtsHash(a.objects.filter(o=>keys.has(o.id)))!==p.selectedDigest||dtsHash(b.objects.filter(o=>keys.has(o.id)))!==p.selectedDigest)dtsReject('verification_mismatch','RabbitMQ 源拓扑或目标定义不一致，本次未通过独立对账',409);return p.keys.length;
}
