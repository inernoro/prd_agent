import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const net = require('node:net') as typeof import('node:net');
const dns = require('node:dns') as typeof import('node:dns');

// 仅测试：缺 host 的临时监听必须与 127.0.0.1 客户端同族。
// macOS 允许 :: 与已存在的特定 IPv4 listener 同端口，不能把其响应当本 fixture 的结果。
export function rewriteEphemeralListenArgs(args: any[]): any[] | null {
 const first=args[0];
 if(first===0){
  if(args.slice(1).some(v=>v!==undefined&&v!==null&&typeof v!=='number'&&typeof v!=='function'))return null;
  return [{port:0,host:'127.0.0.1'},...args.slice(1)];
 }
 if(first&&typeof first==='object'&&!Array.isArray(first)&&(first.port===0||first.port==='0')&&!['host','path','fd','handle','ipv6Only','family','reusePort'].some(k=>k in first))return [{...first,host:'127.0.0.1'},...args.slice(1)];
 return null;
}
export function installEphemeralLoopbackFixture(): () => void{
 const descriptor=Object.getOwnPropertyDescriptor(net.Server.prototype,'listen')!;
 const original=descriptor.value;
 function listen(this: any, ...args: any[]){
  const rewritten=rewriteEphemeralListenArgs(args);
  if(!rewritten)return Reflect.apply(original,this,args);
  const lookupDescriptor=Object.getOwnPropertyDescriptor(dns,'lookup')!;
  const originalLookup=lookupDescriptor.value;
  Object.defineProperty(dns,'lookup',{...lookupDescriptor,value:function(this: any, hostname: string, ...lookupArgs: any[]){
   if(hostname!=='127.0.0.1')return Reflect.apply(originalLookup,this,[hostname,...lookupArgs]);
   const callback=lookupArgs.at(-1),options=lookupArgs[0];
   if(typeof callback!=='function')return Reflect.apply(originalLookup,this,[hostname,...lookupArgs]);
   if(options&&typeof options==='object'&&options.all===true)callback(null,[{address:'127.0.0.1',family:4}]);
   else callback(null,'127.0.0.1',4);
  }});
  try{return Reflect.apply(original,this,rewritten);}finally{Object.defineProperty(dns,'lookup',lookupDescriptor);}
 }
 Object.defineProperty(net.Server.prototype,'listen',{...descriptor,value:listen});
 return ()=>{if(net.Server.prototype.listen!==listen)throw new Error('test listen patch ownership changed');Object.defineProperty(net.Server.prototype,'listen',descriptor);};
}
