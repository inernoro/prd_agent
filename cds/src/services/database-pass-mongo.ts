import net, { type Socket } from 'node:net';
import { BSON } from 'mongodb';
import { relayFrames } from './database-pass-wire.js';

// Reject ambiguous BSON before deserialization (duplicate keys can have different
// interpretations in drivers and mongod). Bound recursion and every byte range.
function bsonKeys(buffer: Buffer, start: number, depth=0): {end:number;first:string} {
  if(depth>32 || start+5>buffer.length)throw new Error('Invalid BSON');
  const end=start+buffer.readInt32LE(start);if(end>buffer.length || end<start+5 || buffer[end-1]!==0)throw new Error('Invalid BSON');
  let at=start+4,first='';const keys=new Set<string>();
  const cstring=()=>{const z=buffer.indexOf(0,at);if(z<at||z>=end)throw new Error('Invalid BSON key');const s=buffer.subarray(at,z).toString('utf8');at=z+1;return s;};
  const string=()=>{const n=buffer.readInt32LE(at);if(n<1||at+4+n>=end||buffer[at+3+n]!==0)throw new Error('Invalid BSON string');at+=4+n;};
  while(at<end-1){
    const type=buffer[at++],key=cstring();if(keys.has(key))throw new Error('Duplicate BSON key');keys.add(key);if(keys.size===1)first=key;
    if(type===3||type===4){at=bsonKeys(buffer,at,depth+1).end;}
    else if(type===2||type===13||type===14)string();
    else if(type===5){const n=buffer.readInt32LE(at);if(n<0)throw new Error('Invalid BSON binary');at+=5+n;}
    else if(type===11){cstring();cstring();}
    else if(type===12){string();at+=12;}
    else if(type===15){throw new Error('Executable BSON is not supported');}
    else {const n:Record<number,number>={1:8,6:0,7:12,8:1,9:8,10:0,16:4,17:8,18:8,19:16,127:0,255:0};if(!(type in n))throw new Error('Unknown BSON type');at+=n[type];}
    if(at>end-1)throw new Error('Invalid BSON value');
  }
  if(at!==end-1)throw new Error('Invalid BSON boundary');return {end,first};
}

export function mongoPassCommand(packet:Buffer): {body:Record<string,any>;name:string;legacy:boolean} {
  if(packet.length<21||packet.readInt32LE(0)!==packet.length)throw new Error('Invalid Mongo frame');
  const opcode=packet.readInt32LE(12);let at:number,limit=packet.length,legacy=false;
  if(opcode===2004){legacy=true;const z=packet.indexOf(0,20);if(z<0||packet.subarray(20,z).toString()!=='admin.$cmd')throw new Error('Only legacy hello is supported');at=z+9;}
  else if(opcode===2013){const flags=packet.readUInt32LE(16);if(flags&~0x10002)throw new Error('Unsupported Mongo flags');if(packet[20]!==0)throw new Error('Missing command body');at=21;}
  else throw new Error('Only uncompressed commands are supported');
  const doc=bsonKeys(packet,at);const body=BSON.deserialize(packet.subarray(at,doc.end));at=doc.end;
  // Document sequences have no authentication semantics, but still validate their framing.
  while(!legacy&&at<limit){if(packet[at++]!==1)throw new Error('Multiple command bodies');const sectionEnd=at+packet.readInt32LE(at);at+=4;const z=packet.indexOf(0,at);if(z<0||z>=sectionEnd||sectionEnd>limit)throw new Error('Invalid sequence');at=z+1;while(at<sectionEnd)at=bsonKeys(packet,at).end;if(at!==sectionEnd)throw new Error('Invalid sequence');}
  if(at!==limit)throw new Error('Invalid command boundary');return {body,name:doc.first.toLowerCase(),legacy};
}

export class MongoPassIdentity {
  private started=false;
  constructor(private database:string,private username:string){}
  private start(body:Record<string,any>,nested=false):boolean {
    if(Object.keys(body)[0]!=='saslStart' || body.saslStart!==1 || !['SCRAM-SHA-1','SCRAM-SHA-256'].includes(body.mechanism) || (body[nested?'db':'$db']!==this.database) || (nested&&body.$db!==undefined&&body.$db!==this.database))return false;
    const payload=body.payload?.buffer; if(!payload)return false;
    const text=Buffer.from(payload).toString('utf8');
    return text.startsWith(`n,,n=${this.username},r=`) && /^[\x21-\x2b\x2d-\x7e]+$/.test(text.substring(`n,,n=${this.username},r=`.length));
  }
  accept(packet:Buffer):boolean {
    try {
      const {body,name,legacy}=mongoPassCommand(packet);
      if(name==='hello'||name==='ismaster'){
        if((body.compression!==undefined&&(!Array.isArray(body.compression)||body.compression.some((value:unknown)=>value!=='none'))) || (body.saslSupportedMechs!==undefined&&body.saslSupportedMechs!==`${this.database}.${this.username}`))return false;
        if(body.speculativeAuthenticate){if(!this.start(body.speculativeAuthenticate,true))return false;this.started=true;}
        return true;
      }
      if(legacy)return false;
      if(name==='saslstart'){if(!this.start(body))return false;this.started=true;return true;}
      if(name==='saslcontinue')return this.started&&body.$db===this.database;
      if(name==='authenticate'||name==='getnonce'||name==='logout')return false;
      if(!this.started)return false;
      return body.$db===this.database || (body.$db==='admin'&&['ping','buildinfo','endsessions','connectionstatus','listdatabases'].includes(name));
    } catch {return false;}
  }
}

export function relayMongoPass(client:Socket,input:{port:number;database:string;username:string;remember:(socket:Socket)=>Socket;denied:()=>void}) {
  const identity=new MongoPassIdentity(input.database,input.username);
  const upstream=input.remember(net.connect({host:'127.0.0.1',port:input.port}));
  client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
  client.setTimeout(10000,()=>client.destroy());
  upstream.on('data',chunk=>client.write(chunk));
  relayFrames(client,b=>b.readInt32LE(0),()=>16*1024*1024,packet=>{
    if(!identity.accept(packet)){input.denied();client.destroy();return;}
    client.setTimeout(0);upstream.write(packet);
  });
}
