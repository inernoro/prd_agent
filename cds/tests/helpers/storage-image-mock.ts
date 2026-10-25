import {createHash} from 'node:crypto';
import {MockShellExecutor} from '../../src/services/shell-executor.js';
/** Synthetic Docker inventory for route fixtures. These projections never count as native evidence. */
export function withStorageImages(mock:MockShellExecutor):MockShellExecutor {
 const original=mock.exec.bind(mock),created=new Map<string,any>();
 mock.exec=async(command,options)=>{
  let result=await original(command,options);
  if(/^docker create /.test(command)&&result.exitCode===0){
   const name=/--name (?:'([^']+)'|([^ ]+))/.exec(command)?.slice(1).find(Boolean);
   const image=command.match(/sha256:[a-f0-9]{64}/)?.[0];
   if(name&&image){
    const id=/^[a-f0-9]{64}$/.test(result.stdout.trim())?result.stdout.trim():createHash('sha256').update(name).digest('hex');
    const mounts=[...command.matchAll(/--mount '([^']+)'/g)].map(m=>{
     const fields=Object.fromEntries(m[1].split(',').map(x=>x.includes('=')?x.split('='): [x,true]));
     const source=String(fields.src||fields.source);return {Type:fields.type,Name:fields.type==='volume'?source:undefined,Source:fields.type==='volume'?'/var/lib/docker/volumes/'+source+'/_data':source,Destination:fields.dst,RW:!fields.readonly};
    });
    const tmpfs=Object.fromEntries([...command.matchAll(/--tmpfs '([^']+)'/g)].map(m=>[m[1],'']));
    created.set(id,[id,'/'+name,image,0,'created',mounts,Object.keys(tmpfs).length?tmpfs:null]);
    result={...result,stdout:id};
   }
  }
  if(command.startsWith('docker image inspect ')&&command.includes('[{{json .Id}},')){
   if(result.exitCode!==0)return result;
   let value:any;try{value=JSON.parse(result.stdout)}catch{/* empty success is the fixture's undeclared default inventory */}
   if(Array.isArray(value)&&value.length===2&&typeof value[0]==='string')return result;
   const row=Array.isArray(value)?value[0]:value;
   if(row&&typeof row==='object'&&typeof row.Id==='string')return {...result,stdout:JSON.stringify([row.Id,row.Config?.Volumes??null])};
   if(result.stdout.trim()===''){
    const image=command.match(/^docker image inspect '([^']+)'/)?.[1];
    return {...result,stdout:JSON.stringify([image?.startsWith('sha256:')?image:'sha256:'+'a'.repeat(64),null])};
   }
  }
  if(command.startsWith('docker inspect ')&&command.includes('json .Mounts')&&result.exitCode===0){
   const id=command.match(/[a-f0-9]{64}/g)?.at(-1),row=id&&created.get(id);
   if(row)return {...result,stdout:JSON.stringify(row)};
  }
  return result;
 };
 return mock;
}
