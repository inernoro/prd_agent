import net from 'node:net';
import { BSON } from 'mongodb';
import { afterEach, expect, it, vi } from 'vitest';
import { MongoPassIdentity, mongoPassCommand, relayMongoPass } from '../../src/services/database-pass-mongo.js';
import { firstFrame, relayFrames } from '../../src/services/database-pass-wire.js';

const message=(body:Record<string,any>,id=1,responseTo=0)=>{const b=BSON.serialize(body),header=Buffer.alloc(21);header.writeInt32LE(21+b.length);header.writeInt32LE(id,4);header.writeInt32LE(responseTo,8);header.writeInt32LE(2013,12);return Buffer.concat([header,b]);};
const start=(id=1)=>message({saslStart:1,mechanism:'SCRAM-SHA-256',payload:new BSON.Binary(Buffer.from('n,,n=temp,r=abc123')),$db:'qa'},id);
const read=(socket:net.Socket)=>firstFrame(socket,b=>b.readInt32LE(0),65536);
const sockets=new Set<net.Socket>(),servers:net.Server[]=[];
afterEach(async()=>{vi.useRealTimers();for(const socket of sockets)socket.destroy();sockets.clear();await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
const remember=(socket:net.Socket)=>{sockets.add(socket);socket.on('error',()=>{});return socket;};
async function fixture(reply:(packet:Buffer)=>Record<string,any>){
  const upstream=net.createServer(socket=>{remember(socket);relayFrames(socket,b=>b.readInt32LE(0),()=>65536,packet=>socket.write(message(reply(packet),100,packet.readInt32LE(4))));});servers.push(upstream);
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const front=net.createServer(socket=>{remember(socket);relayMongoPass(socket,{port:(upstream.address() as net.AddressInfo).port,database:'qa',username:'temp',remember,denied:()=>socket.destroy()});});servers.push(front);
  await new Promise<void>(resolve=>front.listen(0,'127.0.0.1',resolve));
  const client=remember(net.connect((front.address() as net.AddressInfo).port,'127.0.0.1'));
  await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});return client;
}
it('plain hello and repeated hello cannot remove or extend the absolute authentication deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  // Even a done-shaped hello response cannot impersonate an authentication reply.
  const client=await fixture(()=>({ok:1,done:true}));
  for(let id=1;id<=3;id++){
    client.write(message({hello:1},id));await read(client);
    if(id<3)await vi.advanceTimersByTimeAsync(4000);
  }
  client.resume();const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
  await vi.advanceTimersByTimeAsync(2001);await closed;expect(client.destroyed).toBe(true);
});
it('keeps the deadline through SCRAM continuation and permits idle sessions only after server-confirmed done',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const client=await fixture(packet=>{
    const command=mongoPassCommand(packet);return command.name==='saslstart'?{ok:1,done:false,conversationId:1}:command.name==='saslcontinue'?{ok:1,done:packet.readInt32LE(4)===3,conversationId:1}:{ok:1};
  });
  client.write(start(1));await read(client);
  client.write(message({saslContinue:1,conversationId:1,payload:new BSON.Binary(),$db:'qa'},2));await read(client);
  await vi.advanceTimersByTimeAsync(9000);expect(client.destroyed).toBe(false);
  client.write(message({saslContinue:1,conversationId:1,payload:new BSON.Binary(),$db:'qa'},3));await read(client);
  await vi.advanceTimersByTimeAsync(20000);expect(client.destroyed).toBe(false);
  client.write(message({ping:1,$db:'qa'},4));expect(mongoPassCommand(await read(client)).body.ok).toBe(1);
});
it('failed or mismatched SCRAM server responses never confirm authentication',()=>{
  for(const reply of [message({ok:0,done:true},10,1),message({ok:1,done:true},10,2),message({ok:1,done:false},10,1)]){
    const identity=new MongoPassIdentity('qa','temp');expect(identity.accept(start(1))).toBe(true);expect(identity.authenticatedReply(reply)).toBe(false);
  }
});
it('recognizes successful speculative authentication in legacy OP_REPLY',()=>{
  const identity=new MongoPassIdentity('qa','temp');
  expect(identity.accept(message({hello:1,speculativeAuthenticate:{saslStart:1,mechanism:'SCRAM-SHA-256',payload:new BSON.Binary(Buffer.from('n,,n=temp,r=abc123')),db:'qa'}},9))).toBe(true);
  const doc=BSON.serialize({ok:1,speculativeAuthenticate:{ok:1,done:true}}),header=Buffer.alloc(36);header.writeInt32LE(36+doc.length);header.writeInt32LE(9,8);header.writeInt32LE(1,12);header.writeInt32LE(1,32);
  expect(identity.authenticatedReply(Buffer.concat([header,doc]))).toBe(true);
});
