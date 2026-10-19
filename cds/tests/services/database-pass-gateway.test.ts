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
