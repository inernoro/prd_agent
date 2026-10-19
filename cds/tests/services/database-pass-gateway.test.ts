import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { openDatabasePassGateway } from '../../src/services/database-pass-gateway.js';
import { databasePassCertificates } from '../../src/services/database-pass-certificates.js';

it('keeps the copied TCP port owned; preparation rejects data and activation reuses that listener',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-wire-'));
  let connections=0;const upstream=net.createServer(socket=>{connections++;socket.end('database greeting');});
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
    gateway.activate();expect(await read()).toBe('database greeting');expect(connections).toBe(1);
  }finally{gateway.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
});
