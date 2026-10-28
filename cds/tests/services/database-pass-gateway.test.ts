import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { openDatabasePassGateway } from '../../src/services/database-pass-gateway.js';
import { databasePassCertificates } from '../../src/services/database-pass-certificates.js';

it('keeps the copied TCP port owned; preparation rejects data and activation reuses that listener',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-wire-'));
  const greeting=Buffer.from([1,0,0,0,10]);
  let connections=0;const upstream=net.createServer(socket=>{connections++;socket.end(greeting);});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const target={runtime:'mysql' as const,port:(upstream.address() as net.AddressInfo).port,database:'qa',adminUser:'unused',adminPassword:'unused'};
  const gateway=await openDatabasePassGateway({target,username:'temp',bindIp:'127.0.0.1',port:0,allowlist:['127.0.0.1/32'],...databasePassCertificates(dir,'127.0.0.1'),startInactive:true,audit:()=>{}});
  const read=()=>new Promise<string>((resolve,reject)=>{
    let data='';const socket=net.connect(gateway.port,'127.0.0.1');socket.on('data',chunk=>data+=chunk);socket.once('close',()=>resolve(data));socket.once('error',reject);socket.setTimeout(2000,()=>socket.destroy(new Error('timeout')));
  });
  try{
    const competitor=net.createServer();
    const error=await new Promise<NodeJS.ErrnoException>(resolve=>{competitor.once('error',resolve);competitor.listen(gateway.port,'127.0.0.1');});
    expect(error.code).toBe('EADDRINUSE');expect(await read()).toBe('');expect(connections).toBe(0);
    gateway.activate();expect(await read()).toBe(greeting.toString());expect(connections).toBe(1);
  }finally{gateway.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
});

it('relays native MySQL TLS with CA verification, rejects other users and identity switching',async()=>{
  const {default:tls}=await import('node:tls');
  const {firstFrame,mysqlFrameLength}=await import('../../src/services/database-pass-wire.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-mysql-tls-'));
  const certs=databasePassCertificates(dir,'127.0.0.1');
  const packet=(body:Buffer,seq=0)=>{const h=Buffer.alloc(4);h.writeUIntLE(body.length,0,3);h[3]=seq;return Buffer.concat([h,body]);};
  let forwardedLogins=0,forwardedChanges=0;const backendSockets=new Set<net.Socket>();
  const upstream=net.createServer(socket=>{
    backendSockets.add(socket);socket.once('close',()=>backendSockets.delete(socket));socket.on('error',()=>{});
    void(async()=>{
      socket.write(packet(Buffer.from('fake greeting')));
      await firstFrame(socket,mysqlFrameLength,65536);
      const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext(certs)});secure.on('error',()=>{});
      await firstFrame(secure,mysqlFrameLength,65536);forwardedLogins++;secure.write(packet(Buffer.from([0]),3));
      secure.on('data',()=>forwardedChanges++);secure.resume();
    })().catch(()=>socket.destroy());
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const target={runtime:'mysql' as const,port:(upstream.address() as net.AddressInfo).port,database:'qa',adminUser:'admin',adminPassword:'unused',mysqlCa:certs.cert.toString()};
  const gateway=await openDatabasePassGateway({target,username:'temp',bindIp:'127.0.0.1',port:0,allowlist:['127.0.0.1/32'],...certs,audit:()=>{}});
  const login=async(user:string)=>{
    const raw=net.connect(gateway.port,'127.0.0.1');raw.on('error',()=>{});await firstFrame(raw,mysqlFrameLength,65536);
    const b=Buffer.alloc(32);b.writeUInt32LE(0x800|8|0x8000);raw.write(packet(b,1));
    const secure=tls.connect({socket:raw,ca:certs.cert,checkServerIdentity:(_host,cert)=>tls.checkServerIdentity('127.0.0.1',cert)});secure.on('error',()=>{});
    secure.write(packet(Buffer.concat([b,Buffer.from(user+'\0'),Buffer.from([0]),Buffer.from('qa\0')]),2));return secure;
  };
  try{
    const valid=await login('temp');expect((await firstFrame(valid,mysqlFrameLength,65536))[4]).toBe(0);expect(forwardedLogins).toBe(1);
    const closed=new Promise<void>(resolve=>valid.once('close',()=>resolve()));valid.write(packet(Buffer.from([0x11])));valid.resume();await closed;expect(forwardedChanges).toBe(0);
    const wrong=await login('root');await expect(firstFrame(wrong,mysqlFrameLength,65536)).rejects.toThrow();expect(forwardedLogins).toBe(1);
  }finally{gateway.close();for(const s of backendSockets)s.destroy();await new Promise<void>(resolve=>upstream.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
},15000);

it('declines PostgreSQL GSSENC then requires TLS before forwarding a bound startup',async()=>{
 const tls=await import('node:tls');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-pg-gss-'));const certs=databasePassCertificates(dir,'127.0.0.1');
 let receivedResolve:(packet:Buffer)=>void=()=>{};const received=new Promise<Buffer>(resolve=>{receivedResolve=resolve;});const backendSockets=new Set<net.Socket>();
 const upstream=net.createServer(socket=>{backendSockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>backendSockets.delete(socket));socket.once('data',packet=>{receivedResolve(packet);socket.end();});});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const gateway=await openDatabasePassGateway({target:{runtime:'postgres',port:(upstream.address() as net.AddressInfo).port,database:'qa',adminUser:'unused',adminPassword:'unused'},username:'temp',bindIp:'127.0.0.1',port:0,allowlist:['127.0.0.1/32'],...certs,audit:()=>{}});
 const request=(code:number)=>{const packet=Buffer.alloc(8);packet.writeUInt32BE(8);packet.writeUInt32BE(code,4);return packet;};
 const client=net.connect(gateway.port,'127.0.0.1');client.on('error',()=>{});const byte=()=>new Promise<string>((resolve,reject)=>{client.once('data',data=>resolve(data.toString()));client.once('error',reject);});
 try{
  let reply=byte();client.write(request(80877104).subarray(0,3));client.write(request(80877104).subarray(3));expect(await reply).toBe('N');
  reply=byte();client.write(request(80877103));expect(await reply).toBe('S');
  const secure=tls.connect({socket:client,ca:certs.cert,checkServerIdentity:(_host,cert)=>tls.checkServerIdentity('127.0.0.1',cert)});secure.on('error',()=>{});await new Promise<void>((resolve,reject)=>{secure.once('secureConnect',resolve);secure.once('error',reject);});
  const body=Buffer.from('user\0temp\0database\0qa\0\0'),head=Buffer.alloc(8);head.writeUInt32BE(body.length+8);head.writeUInt32BE(196608,4);const startup=Buffer.concat([head,body]);secure.write(startup);expect(await received).toEqual(startup);secure.destroy();
 }finally{client.destroy();gateway.close();for(const socket of backendSockets)socket.destroy();await new Promise<void>(resolve=>upstream.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
},10000);

it('enforces the MongoDB socket ceiling before unauthenticated TLS handshakes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-mongo-cap-')),clients:net.Socket[]=[];let release:(value:boolean)=>void=()=>{};
 const denied=new Promise<boolean>(resolve=>{release=resolve;});
 const gateway=await openDatabasePassGateway({target:{runtime:'mongodb',port:1,database:'qa',adminUser:'unused',adminPassword:'unused'},username:'temp',bindIp:'127.0.0.1',port:0,allowlist:['127.0.0.1/32'],...databasePassCertificates(dir,'127.0.0.1'),audit:(event,details)=>{if(event==='connection-denied'&&details.reason==='连接数已达上限')release(true);}});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.all(Array.from({length:129},()=>new Promise<void>((resolve,reject)=>{const socket=net.connect(gateway.port,'127.0.0.1');clients.push(socket);socket.on('error',()=>{});socket.once('connect',()=>{socket.resume();resolve();});socket.once('error',error=>(error as NodeJS.ErrnoException).code==='ECONNRESET'?resolve():reject(error));} )));
  const bounded=await Promise.race([denied,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
  expect(bounded).toBe(true);
 }finally{if(timer)clearTimeout(timer);for(const socket of clients)socket.destroy();gateway.close();fs.rmSync(dir,{recursive:true,force:true});}
},10000);
