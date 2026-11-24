import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const manifest=JSON.parse(await fs.readFile(new URL('./artifacts.json',import.meta.url),'utf8'));
await fs.mkdir('/artifacts',{recursive:true});
for(const item of manifest){
 let verified=false;
 for(const [index,url]of [item.url,...(item.mirrors||[])].entries()){
  console.log('Downloading pinned artifact',item.file,'source',index+1);
  try{
   const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(300000)});if(!r.ok||!r.body)throw new Error('Artifact source rejected HTTP '+r.status);
   const digest=createHash(item.algorithm),stream=Readable.fromWeb(r.body);let bytes=0;
   stream.on('data',chunk=>{bytes+=chunk.length;if(item.bytes&&bytes>item.bytes)stream.destroy(new Error('Artifact size exceeds pinned release'));digest.update(chunk);});
   await pipeline(stream,createWriteStream('/artifacts/'+item.file));
   if(digest.digest('hex')!==item.digest||(item.bytes&&bytes!==item.bytes)){const e=new Error('Pinned artifact digest mismatch: '+item.file);e.code='DIGEST_MISMATCH';throw e;}
   console.log('Verified upstream artifact',item.file,bytes,'bytes');verified=true;break;
  }catch(error){
   await fs.rm('/artifacts/'+item.file,{force:true});
   if(error.code==='DIGEST_MISMATCH')throw error;
   console.warn('Artifact source unavailable',item.file,error.name);
  }
 }
 if(!verified)throw new Error('No verified upstream source available: '+item.file);
}
