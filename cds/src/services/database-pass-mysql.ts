import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import type { DatabasePassTarget } from './database-pass-accounts.js';
import { firstFrame, mysqlFrameLength, relayFrames } from './database-pass-wire.js';

export function mysqlPassLogin(packet: Buffer, username: string, database: string): boolean {
  try {
    const body=packet.subarray(4),flags=body.readUInt32LE(0);
    if(body.length<34 || !(flags&0x800) || !(flags&8) || (flags&0x20) || (flags&0x4000000))return false;
    let cursor=32;
    const string=()=>{const end=body.indexOf(0,cursor);if(end<0)throw new Error('Missing terminator');const value=body.subarray(cursor,end).toString('utf8');cursor=end+1;return value;};
    if(string()!==username)return false;
    if(flags&0x200000){const n=body[cursor++];if(n>=0xfb)return false;cursor+=n;}
    else if(flags&0x8000)cursor+=1+body[cursor];
    else string();
    return cursor<body.length && string()===database;
  }catch{return false;}
}

/** Terminate client TLS, verify upstream CA, then inspect identity and identity-changing commands. */
export async function relayMysqlPass(client: Socket, input: {
  target: DatabasePassTarget; username: string; key: Buffer; cert: Buffer;
  remember: (socket: Socket) => Socket; denied: () => void;
}) {
  const upstream=input.remember(net.connect({host:'127.0.0.1',port:input.target.port}));
  client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
  const hello=await firstFrame(upstream,mysqlFrameLength,65536);client.write(hello);
  const ssl=await firstFrame(client,mysqlFrameLength,65536);
  if(ssl.length!==36 || !(ssl.readUInt32LE(4)&0x800)){input.denied();client.destroy();return;}
  upstream.write(ssl);
  const remote=input.remember(tls.connect({socket:upstream,ca:input.target.mysqlCa,rejectUnauthorized:true,checkServerIdentity:()=>undefined,minVersion:'TLSv1.2'})) as tls.TLSSocket;
  const local=input.remember(new tls.TLSSocket(client,{isServer:true,secureContext:tls.createSecureContext({key:input.key,cert:input.cert,minVersion:'TLSv1.2'})}));
  local.once('close',()=>remote.destroy());remote.once('close',()=>local.destroy());
  remote.setTimeout(10000,()=>remote.destroy());local.setTimeout(10000,()=>local.destroy());
  const login=await firstFrame(local,mysqlFrameLength,65536);
  if(!mysqlPassLogin(login,input.username,input.target.database)){input.denied();local.destroy();return;}
  let authenticated=false;
  relayFrames(remote,mysqlFrameLength,()=>16*1024*1024+4,packet=>{
    local.write(packet);
    if(!authenticated && packet[4]===0){authenticated=true;local.setTimeout(0);remote.setTimeout(0);}
  });
  relayFrames(local,mysqlFrameLength,()=>authenticated?1024*1024:65536,packet=>{
    if(authenticated && (packet[3]!==0 || packet[4]===0x11 || (packet[4]===2&&packet.subarray(5).toString('utf8')!==input.target.database))){input.denied();local.destroy();return;}
    remote.write(packet);
  });
  remote.write(login);remote.resume();local.resume();
}
