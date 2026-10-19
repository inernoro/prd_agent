import {it,expect} from 'vitest';
import {BSON} from 'mongodb';
import {mysqlPassLogin} from '../../src/services/database-pass-mysql.js';
import {MongoPassIdentity} from '../../src/services/database-pass-mongo.js';
import {normalizeReadOnlyStatement,stripSqlComments} from '../../src/services/sql-statement-policy.js';
const message=(body:Record<string,any>)=>{const b=BSON.serialize(body),h=Buffer.alloc(21);h.writeInt32LE(h.length+b.length);h.writeInt32LE(2013,12);return Buffer.concat([h,b]);};
const scram=(username:string)=>new BSON.Binary(Buffer.from(`n,,n=${username},r=abc123`));
it('MySQL subtraction cannot conceal a COMMIT/write script from read policy',()=>{
  for(const space of ['', '1','x'])expect(()=>normalizeReadOnlyStatement(`SELECT 1--${space}1; COMMIT; UPDATE items SET value=1`,'mysql')).toThrow();
  expect(stripSqlComments('SELECT 1--x; UPDATE t SET x=1',{dialect:'mysql'})).toContain('UPDATE');
  expect(stripSqlComments('SELECT 1-- comment; UPDATE t SET x=1',{dialect:'mysql'})).not.toContain('UPDATE');
  expect(stripSqlComments('SELECT 1--x; UPDATE t SET x=1',{dialect:'postgres'})).not.toContain('UPDATE');
});
it('MySQL binds SSL handshake user and database; compression and other credentials are rejected',()=>{
  const login=(user:string,db:string,extra=0)=>{const b=Buffer.alloc(32);b.writeUInt32LE(0x800|8|0x8000|extra);return Buffer.concat([Buffer.alloc(4),b,Buffer.from(user+'\0'),Buffer.from([0]),Buffer.from(db+'\0')]);};
  expect(mysqlPassLogin(login('temp','qa'),'temp','qa')).toBe(true);
  for(const b of [login('root','qa'),login('temp','other'),login('temp','qa',32),Buffer.alloc(2)])expect(mysqlPassLogin(b,'temp','qa')).toBe(false);
});
it('MongoDB only authenticates the generated identity and keeps data commands within its database',()=>{
  const id=new MongoPassIdentity('qa','temp');
  expect(id.accept(message({find:'x',$db:'qa'}))).toBe(false);
  expect(id.accept(message({hello:1,compression:[]}))).toBe(true);
  expect(id.accept(message({hello:1,compression:['none']}))).toBe(true);
  expect(id.accept(message({hello:1,saslSupportedMechs:'admin.root'}))).toBe(false);
  expect(id.accept(message({hello:1,compression:['zlib']}))).toBe(false);
  expect(id.accept(message({saslStart:1,mechanism:'SCRAM-SHA-256',payload:scram('root'),$db:'qa'}))).toBe(false);
  expect(id.accept(message({saslStart:1,mechanism:'SCRAM-SHA-256',payload:scram('temp'),$db:'qa'}))).toBe(true);
  expect(id.accept(message({saslContinue:1,conversationId:1,payload:new BSON.Binary(),$db:'qa'}))).toBe(true);
  expect(id.accept(message({find:'x',$db:'qa'}))).toBe(true);
  expect(id.accept(message({find:'x',$db:'other'}))).toBe(false);
  expect(id.accept(message({authenticate:1,user:'root',$db:'admin'}))).toBe(false);
});
it('MongoDB rejects duplicate BSON keys, compressed opcodes and hidden numeric-key authentication',()=>{
  const id=new MongoPassIdentity('qa','temp');
  expect(id.accept(message({hello:1,speculativeAuthenticate:{saslStart:1,mechanism:'SCRAM-SHA-256',payload:scram('root'),db:'qa'}}))).toBe(false);
  const body=BSON.serialize({hello:1}),dup=Buffer.concat([body.subarray(0,-1),body.subarray(4)]);dup.writeInt32LE(dup.length);
  const header=Buffer.alloc(21);header.writeInt32LE(21+dup.length);header.writeInt32LE(2013,12);
  expect(id.accept(Buffer.concat([header,dup]))).toBe(false);
  const compressed=message({hello:1});compressed.writeInt32LE(2012,12);expect(id.accept(compressed)).toBe(false);
  expect(id.accept(message({0:1,hello:1}))).toBe(false);
});
it('read validation also rejects transaction escapes under standard string server modes',()=>{
  for(const dialect of ['mysql','postgres'] as const){
    expect(()=>normalizeReadOnlyStatement("SELECT 'x\\'; COMMIT; UPDATE items SET value=1; --'",dialect)).toThrow();
  }
});
