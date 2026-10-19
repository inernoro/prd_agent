import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { relayMysqlPass } from './database-pass-mysql.js';
import { relayMongoPass } from './database-pass-mongo.js';
import type { DatabasePassTarget } from './database-pass-accounts.js';

/** PostgreSQL's decrypted startup packet must bind both database and generated user. */
export function postgresPassStartup(packet: Buffer, database: string, username: string): boolean {
  if (packet.length < 8 || packet.length > 8192 || packet.readUInt32BE(0) !== packet.length || packet.readUInt32BE(4) !== 196608) return false;
  const values = packet.subarray(8).toString('utf8').split('\0');
  const fields: Record<string,string> = {};
  for (let i=0;i+1<values.length && values[i];i+=2) { if (values[i] in fields) return false; fields[values[i]]=values[i+1]; }
  return fields.database === database && fields.user === username;
}

export async function openDatabasePassGateway(input: {
  target: DatabasePassTarget; username: string; bindIp: string; port: number; allowlist: string[];
  key: Buffer; cert: Buffer; startInactive?: boolean; audit: (event: string, details: Record<string, unknown>) => void;
}): Promise<{ port: number; activate: () => void; close: () => void }> {
  const block = new net.BlockList();
  for (const cidr of input.allowlist) { const [ip,bits]=cidr.split('/'); block.addSubnet(ip,Number(bits),'ipv4'); }
  const sockets = new Set<Socket>();
  const remember = (socket: Socket) => { sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); socket.on('error',()=>socket.destroy()); return socket; };
  let closed = false;
  let active = !input.startInactive;
  const pipe = (client: Socket, first?: Buffer) => {
    const upstream = remember(net.connect({host:'127.0.0.1',port:input.target.port}));
    upstream.once('connect',()=>{ if(first)upstream.write(first); client.pipe(upstream);upstream.pipe(client); });
    client.once('close',()=>upstream.destroy()); upstream.once('close',()=>client.destroy());
  };
  const accept = (client: Socket) => {
    const ip=(client.remoteAddress || '').replace(/^::ffff:/,'');
    try {
      if(closed || !active || sockets.size>=128 || !block.check(ip,'ipv4')) { input.audit('connection-denied',{ip,reason:!active?'通行证尚未放行':'IP不在白名单'});client.destroy();return; }
      input.audit('connection-accepted',{ip});
    } catch { client.destroy();return; } // An unavailable audit sink must not permit a new connection.
    remember(client);
    client.once('close',()=>{ try{input.audit('connection-closed',{ip});}catch{/* network is already closed */} });
    const denied=()=>{try{input.audit('authentication-denied',{ip,reason:'账号或数据库与通行证不匹配，或客户端协议不受支持'});}finally{client.destroy();}};
    if(input.target.runtime==='mysql') {
      client.setTimeout(10000,()=>client.destroy());
      void relayMysqlPass(client,{target:input.target,username:input.username,key:input.key,cert:input.cert,remember,denied}).catch(()=>client.destroy());return;
    }
    const encrypted = input.target.runtime==='postgres'
      ? (socket: Socket) => new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key:input.key,cert:input.cert,minVersion:'TLSv1.2'})})
      : undefined;
    if(input.target.runtime==='mongodb') {relayMongoPass(client,{port:input.target.port,database:input.target.database,username:input.username,remember,denied});return;}
    let greeting=Buffer.alloc(0);
    let gssRefused=false;
    client.setTimeout(5000,()=>client.destroy());
    const sslRequest=(chunk:Buffer)=>{
      greeting=Buffer.concat([greeting,chunk]);
      if(greeting.length<8)return;
      if(greeting.readUInt32BE(0)!==8){client.destroy();return;}
      if(greeting.readUInt32BE(4)===80877104&&!gssRefused){
        gssRefused=true;greeting=greeting.subarray(8);client.write('N');
        if(greeting.length===0)return;
        if(greeting.length<8)return;
      }
      client.removeListener('data',sslRequest);
      if(greeting.length!==8 || greeting.readUInt32BE(0)!==8 || greeting.readUInt32BE(4)!==80877103){client.destroy();return;}
      client.write('S');
      const secured=remember(encrypted!(client));
      let startup=Buffer.alloc(0);
      const onStartup=(chunk:Buffer)=>{
        startup=Buffer.concat([startup,chunk]);
        if(startup.length>8192){secured.destroy();return;}
        if(startup.length<4 || startup.length<startup.readUInt32BE(0))return;
        secured.removeListener('data',onStartup);
        if(!postgresPassStartup(startup,input.target.database,input.username)){denied();secured.destroy();return;}
        secured.setTimeout(0);client.setTimeout(0);pipe(secured,startup);
      };
      secured.on('data',onStartup);
    };
    client.on('data',sslRequest);
  };
  // MongoDB negotiates TLS immediately; SQL engines use their native handshake.
  const server=input.target.runtime==='mongodb'
    ? tls.createServer({key:input.key,cert:input.cert,minVersion:'TLSv1.2',handshakeTimeout:5000},accept)
    : net.createServer(accept);
  if(input.target.runtime==='mongodb')server.on('connection',(socket:Socket)=>{
    // Include incomplete TLS handshakes in expiry cleanup and reject non-allowlisted peers early.
    remember(socket);const ip=(socket.remoteAddress||'').replace(/^::ffff:/,'');
    if(closed||!active||!block.check(ip,'ipv4')){try{input.audit('connection-denied',{ip,reason:!active?'通行证尚未放行':'IP不在白名单'});}catch{/* fail closed */}finally{socket.destroy();}}
  });
  server.on('tlsClientError',()=>{});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(input.port,input.bindIp,()=>{server.removeListener('error',reject);resolve();});});
  return {port:(server.address() as net.AddressInfo).port,activate:()=>{if(closed)throw new Error('通行证入口已关闭');active=true;},close:()=>{closed=true;server.close();for(const socket of sockets)socket.destroy();}};
}
