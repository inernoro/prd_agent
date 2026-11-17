import { createHash } from 'node:crypto';
/** Original RabbitMQ HTTP declarations reject inequivalent existing objects. No message read/ack operation exists here. */
export async function runRabbitTopology(config,stopped,record){
 if(config.version!=='1'||!Array.isArray(config.objects)||config.objects.length>200)throw new Error('unsupported topology contract');
 const base=new URL(config.targetUri);if(!['http:','https:'].includes(base.protocol)||base.search||base.hash||base.pathname!=='/')throw new Error('invalid management endpoint');
 const secrets=[base.password,decodeURIComponent(base.password),base.username,decodeURIComponent(base.username)].filter(Boolean);
 const auth='Basic '+Buffer.from(decodeURIComponent(base.username)+':'+decodeURIComponent(base.password)).toString('base64');base.username='';base.password='';
 for(const o of config.objects){
  if(stopped())return false;
  const v=o.value,db=encodeURIComponent(config.vhost),name=encodeURIComponent(v.name||'');let suffix,method,payload;
  if(o.kind==='exchange'){suffix=`exchanges/${db}/${name}`;method='PUT';payload=v;}
  else if(o.kind==='queue'){suffix=`queues/${db}/${name}`;method='PUT';payload=v;}
  else if(o.kind==='binding'){if(!['queue','exchange'].includes(v.destination_type))throw new Error('invalid binding');suffix=`bindings/${db}/e/${encodeURIComponent(v.source)}/${v.destination_type==='queue'?'q':'e'}/${encodeURIComponent(v.destination)}`;method='POST';payload={routing_key:v.routing_key,arguments:v.arguments};}
  else throw new Error('unverified topology object');
  const start=Date.now();let status=null,raw='',decision='unknown';
  try{
   const r=await fetch(new URL('api/'+suffix,base),{method,headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(20000)});status=r.status;
   const reader=r.body?.getReader(),chunks=[];let size=0;if(reader)for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>65536){await reader.cancel();throw new Error('response limit');}chunks.push(n.value);}raw=Buffer.concat(chunks).toString('utf8');
   decision=r.ok?'success':'rejected';
   if(!r.ok){const error=new Error('native declaration rejected');error.confirmed=true;throw error;}
  }catch(error){if(!error.confirmed)error.unconfirmed=true;throw error;}
  finally{
   let text=raw;for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
   await record({operation:o.kind,httpStatus:status,rawBytes:Buffer.byteLength(raw),sha256:createHash('sha256').update(raw).digest('hex'),text:text.slice(0,2048),durationMs:Date.now()-start,decision});
  }
 }
 return true;
}
