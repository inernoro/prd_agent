import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const manifest=JSON.parse(await fs.readFile(new URL('./artifacts.json',import.meta.url),'utf8'));
await fs.mkdir('/artifacts',{recursive:true});
for(const item of manifest){
 const r=await fetch(item.url,{redirect:'follow',signal:AbortSignal.timeout(300000)});if(!r.ok||!r.body)throw new Error('Pinned artifact download rejected: '+r.status);
 const digest=createHash(item.algorithm),stream=Readable.fromWeb(r.body);stream.on('data',chunk=>digest.update(chunk));
 await pipeline(stream,createWriteStream('/artifacts/'+item.file));
 if(digest.digest('hex')!==item.digest)throw new Error('Pinned artifact digest mismatch: '+item.file);
 console.log('Verified upstream artifact',item.file);
}
