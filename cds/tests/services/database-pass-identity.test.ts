import {it,expect} from 'vitest';
import {BSON} from 'mongodb';
import {mysqlPassLogin} from '../../src/services/database-pass-mysql.js';
import {MongoPassIdentity} from '../../src/services/database-pass-mongo.js';
import {normalizeReadOnlyStatement,normalizeConsoleWrite,stripSqlComments} from '../../src/services/sql-statement-policy.js';
let requestId=0;
const message=(body:Record<string,any>)=>{const b=BSON.serialize(body),h=Buffer.alloc(21);h.writeInt32LE(h.length+b.length);h.writeInt32LE(++requestId,4);h.writeInt32LE(2013,12);return Buffer.concat([h,b]);};
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
  expect(id.accept(message({hello:1,speculativeAuthenticate:{authenticate:1,saslStart:1,mechanism:'SCRAM-SHA-256',payload:scram('temp'),db:'qa'}}))).toBe(false);
  expect(id.accept(message({saslStart:1,mechanism:'SCRAM-SHA-256',payload:scram('temp,r=abc,n=root'),$db:'qa'}))).toBe(false);
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
it('read queries reject MariaDB executable comments, including version-prefixed and single-statement forms',()=>{
  for(const sql of ['SELECT 1; /*M! COMMIT */; /*M! UPDATE items SET value=1 */','SELECT 1 /*M! INTO @x */','SELECT 1; /*M!100100 COMMIT */; /*M!100100 DELETE FROM items */'])expect(()=>normalizeReadOnlyStatement(sql,'mysql')).toThrow(/可执行注释/);
  expect(()=>normalizeReadOnlyStatement('SELECT 1 /* ordinary comment */; SELECT 2','mysql')).not.toThrow();
});
it('PostgreSQL nested comments and dollar-quoted strings cannot conceal following transaction controls',()=>{
  for(const sql of ["SELECT $$'$$; COMMIT; UPDATE items SET value=1; --'", "SELECT 1 /* outer /* inner */ ' */; COMMIT; UPDATE items SET value=1; --'", 'SELECT a$$ FROM items; COMMIT; UPDATE items SET value=1; SELECT $$$$'])expect(()=>normalizeReadOnlyStatement(sql,'postgres')).toThrow();
  expect(()=>normalizeReadOnlyStatement("SELECT $tag$-- ' ; UPDATE demo$tag$; SELECT 2",'postgres')).not.toThrow();
  expect(()=>normalizeReadOnlyStatement('SELECT 1 /* outer /* nested */ still a comment */; SELECT 2','postgres')).not.toThrow();
});

it('every batch statement is admitted; file COPY and large-object file functions are forbidden',()=>{
  for(const sql of ["SELECT 1; COPY pg_catalog.pg_class TO '/tmp/leak'", "SELECT 1; COPY t FROM E'/tmp/file'", 'SELECT 1; COPY t TO $$filename$$', "DO $$BEGIN COPY t TO '/tmp/file'; END$$;SELECT 1", "SELECT lo_export(1,'/tmp/file')", "SELECT lo_import('/etc/passwd')", 'SELECT pg_catalog."lo_export"(1, $path$/tmp/file$path$)']){
    expect(()=>normalizeConsoleWrite(sql,'postgres'),sql).toThrow(/宿主文件|外部进程/);
    expect(()=>normalizeReadOnlyStatement(sql,'postgres')).toThrow();
  }
  expect(()=>normalizeConsoleWrite('SELECT 1; COPY t TO STDOUT','postgres')).toThrow(/不支持/);
  expect(()=>normalizeConsoleWrite('SELECT 1; DISCARD ALL','postgres')).toThrow(/不支持/);
  expect(()=>normalizeConsoleWrite('BEGIN; SELECT 1; UPDATE items SET n=2; ROLLBACK; SELECT 3','postgres')).not.toThrow();
});
