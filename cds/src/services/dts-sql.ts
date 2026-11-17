/** JDBC is the writer. These bounded reads establish contracts and verify the result independently. */
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { DtsActor, DtsConnection, DtsFieldType, DtsMode, DtsPlan } from '../shared/dts.js';
import { compatibleDtsFields, dtsHash, dtsReject } from './dts-policy.js';

type Row = Record<string, unknown>;
type Sql = { query: (text: string, args?: (string|number|boolean|null)[]) => Promise<Row[]> };
const quote = (kind: string, name: string) => kind === 'mysql' ? '`' + name + '`' : '"' + name + '"';
const qualified = (c: DtsConnection) => c.kind === 'mysql' ? quote(c.kind, c.collection) : 'public.' + quote(c.kind, c.collection);
function sqlUri(c: DtsConnection, uri: string): URL {
  let url: URL; try { url = new URL(uri); } catch { return dtsReject('connection_unavailable', '已有 SQL 连接配置无效，请核对服务配置', 503); }
  if (!(c.kind === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:']).includes(url.protocol) || !url.hostname || url.search || url.hash) {
    dtsReject('connection_unavailable', 'SQL 连接类型或参数尚未通过验证，请使用项目已管理的标准连接', 409);
  }
  url.pathname = '/' + c.database; return url;
}
export async function withDtsSql<T>(c: DtsConnection, uri: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const u = sqlUri(c, uri), config = { host: u.hostname, port: Number(u.port) || (c.kind === 'mysql' ? 3306 : 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: c.database };
  if (c.kind === 'mysql') {
    const db = await mysql.createConnection({ ...config, connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, timezone: 'Z', multipleStatements: false });
    try { await db.query("SET SESSION MAX_EXECUTION_TIME=10000, time_zone='+00:00'");
      return await fn({ query: async (text, args) => (await db.execute({ sql: text, timeout: 10000 }, args))[0] as Row[] });
    } finally { await db.end(); }
  }
  const db = new pg.Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000,
    types: { getTypeParser: () => (value:string) => value } });
  try { await db.connect(); await db.query("SET TIME ZONE 'UTC'"); return await fn({ query: async (text, args) => (await db.query(text, args)).rows as Row[] }); }
  finally { await db.end(); }
}
async function sqlMeta(db: Sql, c: DtsConnection, uri: string, fields: Record<string, DtsFieldType>, mode: DtsMode, target=false) {
  const my = c.kind === 'mysql';
  const [server] = await db.query(my ? 'SELECT @@server_uuid AS identity, VERSION() AS version, DATABASE() AS db, @@sql_mode AS sql_mode' : 'SELECT system_identifier::text AS identity FROM pg_control_system()');
  const [version] = my ? [server] : await db.query('SELECT current_setting(\'server_version_num\') AS version, current_database() AS db');
  if (my && !/STRICT_(?:TRANS_TABLES|ALL_TABLES)/.test(String(server.sql_mode))) dtsReject('sql_mode_not_verified','MySQL 必须启用严格写入模式，避免字段被静默截断',409);
  const major = my ? Number(String(version.version).split('.')[0]) : Math.floor(Number(version.version) / 10000);
  if (!(my ? major === 8 : major === 16)) dtsReject('server_version_not_verified', '该 SQL 服务版本尚未完成实际传输验证，已阻止写入', 409);
  const columns = await db.query(my
    ? 'SELECT COLUMN_NAME AS name,DATA_TYPE AS type,IS_NULLABLE AS nullable,EXTRA AS extra,COLUMN_DEFAULT AS default_value,COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION'
    : 'SELECT column_name AS name,data_type AS type,is_nullable AS nullable,is_generated AS extra,column_default AS default_value FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1 ORDER BY ordinal_position', my ? [c.database, c.collection] : [c.collection]);
  if (!columns.length) dtsReject('namespace_missing', '目标表尚未建立，请先按目标版本初始化结构', 409);
  const indexes = await db.query(my
    ? 'SELECT INDEX_NAME AS name,COLUMN_NAME AS field,NON_UNIQUE AS non_unique,SEQ_IN_INDEX AS position FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX'
    : 'SELECT i.indexrelid::regclass::text AS name,i.indisprimary::text AS primary, i.indisunique::text AS unique,pg_get_indexdef(i.indexrelid) AS definition,(SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con WHERE con.conindid=i.indexrelid AND con.contype=\'p\') AS primary_definition FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=\'public\' AND t.relname=$1 ORDER BY i.indexrelid', my ? [c.database, c.collection] : [c.collection]);
  const primary = my ? indexes.filter(i => i.name === 'PRIMARY') : indexes.filter(i => i.primary === 'true');
  if (my ? primary.length !== 1 || primary[0]?.field !== '_id' : primary.length !== 1 || !/PRIMARY KEY \(_id\)$/.test(String(primary[0]?.primary_definition))) {
    dtsReject('identity_type_not_verified', 'SQL 表必须使用单一文本 _id 主键，复合与其他主键尚未开放', 409);
  }
  if (my && !String(columns.find(c=>c.name==='_id')?.collation).endsWith('_bin')) dtsReject('identity_collation_not_verified', 'MySQL 主键必须使用区分大小写的二进制排序规则，避免账号身份合并', 409);
  if (mode === 'account-authority' && my && indexes.some(i => i.name !== 'PRIMARY' && Number(i.non_unique) === 0)) {
    dtsReject('ambiguous_unique_key', '目标表存在额外唯一索引，可能使账号校准命中其他账号，已阻止写入', 409);
  }
  const triggers = await db.query(my ? 'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?'
    : 'SELECT trigger_name AS name FROM information_schema.triggers WHERE event_object_schema=\'public\' AND event_object_table=$1', my ? [c.database,c.collection] : [c.collection]);
  if (triggers.length) dtsReject('unverified_trigger', '选定表包含触发器，尚未核实写入影响，请先缩小或调整同步范围', 409);
  if(target){
    const foreign=await db.query(my
      ? 'SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE (TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL) OR (REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?)'
      : 'SELECT con.oid::text AS id FROM pg_constraint con JOIN pg_class t ON (t.oid=con.conrelid OR t.oid=con.confrelid) JOIN pg_namespace n ON n.oid=t.relnamespace WHERE con.contype=\'f\' AND n.nspname=\'public\' AND t.relname=$1',my?[c.database,c.collection,c.database,c.collection]:[c.collection]);
    if(foreign.length)dtsReject('foreign_key_not_verified','目标表参与外键关系，尚未核实级联与关联数据影响，已阻止写入',409);
  }
  const allowed: Record<DtsFieldType, string[]> = { string:['varchar','character varying','text','char','character'],boolean:my?['tinyint']:['boolean'],
    int:['int','integer','smallint','mediumint'],bigint:['bigint'],double:['double','double precision','float','real'],timestamp:['datetime','timestamp','timestamp without time zone','timestamp with time zone'] };
  for (const [name,type] of Object.entries(fields)) {
    const col = columns.find(col => col.name === name);
    if (!col || !allowed[type].includes(String(col.type)) || (my ? Boolean(String(col.extra || '').trim()) : col.extra !== 'NEVER')) {
      dtsReject('schema_drift', '实际 SQL 字段类型或生成规则与批准契约不一致，请先对齐结构', 409);
    }
  }
  for (const col of target?columns:[]) if (!Object.hasOwn(fields, String(col.name)) && col.nullable === 'NO' && col.default_value == null && !String(col.extra || '').includes('auto_increment')) {
    dtsReject('required_field_missing', '目标表包含未选中的必填字段，请先补齐字段或目标默认值', 409);
  }
  const identity = String(server.identity) + '/' + c.database + '/' + c.collection;
  return { identity, fingerprint:dtsHash({ identity, major, columns, indexes, connection:c, uriDigest:dtsHash(uri) }) };
}
function normalize(rows: Row[], fields: Record<string,DtsFieldType>): Row[] {
  return rows.map(row => Object.fromEntries(Object.entries(fields).map(([name,type]) => {
    const v = row[name]; if (v == null) return [name,null];
    if (type === 'bigint') { if (!/^-?\d+$/.test(String(v))) dtsReject('schema_drift','SQL 大整数字段不符合登记结构',409); return [name,String(v)]; }
    if (type === 'boolean') { if (![true,false,0,1,'0','1','t','f','true','false'].includes(v as never)) dtsReject('schema_drift','SQL 布尔字段不符合登记结构',409); return [name,[true,1,'1','t','true'].includes(v as never)]; }
    if (type === 'int' || type === 'double') { const n=Number(v); if (!Number.isFinite(n) || (type==='int' && (!Number.isInteger(n)||n < -2147483648||n>2147483647))) dtsReject('schema_drift','SQL 数值超出登记范围',409); return [name,n]; }
    if (type === 'timestamp') { const t=new Date(String(v).replace(' ','T') + (/Z|[+-]\d\d(?::?\d\d)?$/.test(String(v))?'':'Z')); if (!Number.isFinite(t.getTime())) dtsReject('schema_drift','SQL 日期无法无损读取',409); return [name,t.toISOString()]; }
    if (typeof v !== 'string') dtsReject('schema_drift','SQL 文本字段不符合登记结构',409); return [name,v];
  }))).sort((a,b)=>String(a._id).localeCompare(String(b._id),'en'));
}
async function read(db:Sql,c:DtsConnection,fields:Record<string,DtsFieldType>) {
  const lengths=Object.keys(fields).map(f=>`COALESCE(OCTET_LENGTH(CAST(${quote(c.kind,f)} AS ${c.kind==='mysql'?'CHAR':'text'})),0)`).join('+');
  const [budget]=await db.query(`SELECT COUNT(*) AS count,COALESCE(SUM(${lengths}),0) AS bytes FROM (SELECT ${Object.keys(fields).map(f=>quote(c.kind,f)).join(',')} FROM ${qualified(c)} LIMIT 10001) AS cds_dts_size`);
  if(Number(budget.count)>10000||Number(budget.bytes)>8*1024*1024)dtsReject('selection_too_large','SQL 选定数据超出当前批次容量，请缩小范围',409);
  const rows=normalize(await db.query(`SELECT ${Object.keys(fields).map(f=>quote(c.kind,f)).join(',')} FROM ${qualified(c)} LIMIT 10001`),fields);
  if (rows.length>10000 || Buffer.byteLength(JSON.stringify(rows))>8*1024*1024) dtsReject('selection_too_large','本次 SQL 数据超出已验证的一万条或八 MiB 容量，请缩小范围',409);
  for (const row of rows) if (typeof row._id !== 'string'||!/^[A-Za-z0-9_.:@-]{1,200}$/.test(row._id)) dtsReject('identity_type_not_verified','该 SQL 主键无法按登记的文本身份传输',409);
  return rows;
}
export async function prepareDtsSqlPlan(input:{projectId:string;source:DtsConnection;target:DtsConnection;sourceUri:string;targetUri:string;mode:DtsMode;actor:DtsActor;profileOnly?:boolean;planId?:string;freeBytes:()=>Promise<number>}) : Promise<DtsPlan> {
  const {source,target,mode}=input, fields=compatibleDtsFields(source,target,mode,input.profileOnly);
  return withDtsSql(source,input.sourceUri,a=>withDtsSql(target,input.targetUri,async b=>{
    const sm=await sqlMeta(a,source,input.sourceUri,fields,'append-only'), tm=await sqlMeta(b,target,input.targetUri,fields,input.profileOnly?'account-authority':mode,true);
    if(sm.identity===tm.identity)dtsReject('same_dataset','源和目标实际指向同一张表，请选择独立的目标',409);
    const src=await read(a,source,fields),dst=await read(b,target,fields),existing=new Set(dst.map(r=>String(r._id)));
    const selected=mode==='append-only'?src.filter(r=>!existing.has(String(r._id))):src;
    const selectedBytes=Buffer.byteLength(JSON.stringify(src)),targetFreeBytes=await input.freeBytes(),requiredFreeBytes=selectedBytes*4+256*1024*1024;
    if(!Number.isFinite(targetFreeBytes)||targetFreeBytes<requiredFreeBytes)dtsReject('capacity_unavailable','无法核实目标数据卷可用空间或空间不足，已阻止 SQL 写入',409);
    const insertCount=src.filter(r=>!existing.has(String(r._id))).length;
    if(mode==='account-authority'&&insertCount)dtsReject('new_accounts_require_append','目标仍有尚未同步的账号，请先使用只追加缺失项补齐，再校准账号资料',409);
    return {id:input.planId??randomUUID(),projectId:input.projectId,sourceId:source.id,targetId:target.id,mode,profileOnly:input.profileOnly,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),sourceFingerprint:sm.fingerprint,targetFingerprint:tm.fingerprint,fields,sourceCount:src.length,targetCount:dst.length,insertCount,updateCount:mode==='account-authority'?src.length-insertCount:0,skipCount:mode==='append-only'?src.length-insertCount:0,selectedBytes,targetFreeBytes,requiredFreeBytes,keys:selected.map(r=>String(r._id)),selectedDigest:dtsHash(selected),approvedBy:input.actor,sourceContract:source.contract,targetContract:target.contract};
  }));
}
export function buildDtsSqlJob(p:DtsPlan,s:DtsConnection,t:DtsConnection,su:string,tu:string):Record<string,unknown>{
  function endpoint(c:DtsConnection,uri:string){const u=sqlUri(c,uri);return {url:`jdbc:${c.kind==='mysql'?'mysql':'postgresql'}://${u.host}/${c.database}`+(c.kind==='mysql'?'?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true&characterEncoding=UTF-8':'?options=-c%20TimeZone%3DUTC'),driver:c.kind==='mysql'?'com.mysql.cj.jdbc.Driver':'org.postgresql.Driver',username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};}
  const keys=p.keys.map(k=>"'"+k.replaceAll("'","''").replaceAll('\\','\\\\')+"'").join(',');
  return {env:{'job.mode':'BATCH',parallelism:1,'job.retry.times':0},source:[{plugin_name:'Jdbc',...endpoint(s,su),query:`SELECT ${Object.keys(p.fields).map(f=>quote(s.kind,f)).join(',')} FROM ${qualified(s)} WHERE ${quote(s.kind,'_id')} IN (${keys})`,'connection_check_timeout_sec':10}],sink:[{plugin_name:'Jdbc',...endpoint(t,tu),database:t.database,table:t.kind==='mysql'?t.collection:'public.'+t.collection,generate_sink_sql:true,primary_keys:['_id'],enable_upsert:p.mode==='account-authority',schema_save_mode:'ERROR_WHEN_SCHEMA_NOT_EXIST',data_save_mode:'APPEND_DATA',batch_size:100,max_retries:0}]};
}
export async function verifyDtsSqlPlan(p:DtsPlan,s:DtsConnection,t:DtsConnection,su:string,tu:string):Promise<number>{
 return withDtsSql(s,su,a=>withDtsSql(t,tu,async b=>{
   const sm=await sqlMeta(a,s,su,p.fields,'append-only'),tm=await sqlMeta(b,t,tu,p.fields,p.mode,true);
   const selected=new Set(p.keys),src=(await read(a,s,p.fields)).filter(r=>selected.has(String(r._id))),dst=(await read(b,t,p.fields)).filter(r=>selected.has(String(r._id)));
   if(sm.fingerprint!==p.sourceFingerprint||tm.fingerprint!==p.targetFingerprint||dtsHash(src)!==p.selectedDigest||dtsHash(dst)!==p.selectedDigest)dtsReject('verification_mismatch','SQL 源数据、结构或目标结果已变化，本次未通过独立对账，请重新比较',409);
   return dst.length;
 }));
}
