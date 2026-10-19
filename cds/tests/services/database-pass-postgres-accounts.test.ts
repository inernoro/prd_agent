import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('pg',()=>({default:{Client:class{constructor(options:unknown){return mocks.create(options);}}}}));
import { changeDatabasePassAccount } from '../../src/services/database-pass-accounts.js';
const target={runtime:'postgres' as const,port:5432,database:'qa_deleted',adminUser:'admin',adminPassword:'private'};
const account={username:'cdsp_0123456789abcdef0123',password:'temporary'};
const dbError=(code:string)=>Object.assign(new Error('connection failed'),{code});
function harness(failures:Record<string,string>={}, catalog:{schema?:string;table?:string;inheritedView?:boolean}={}){
 const clients:Array<{database:string;connect:ReturnType<typeof vi.fn>;query:ReturnType<typeof vi.fn>;end:ReturnType<typeof vi.fn>}>=[];const log:string[]=[];
 mocks.create.mockImplementation(({database}:{database:string})=>{
  const client={database,connect:vi.fn(async()=>{log.push('connect:'+database);if(failures[database])throw dbError(failures[database]);}),query:vi.fn(async(sql:string)=>{log.push(database+':'+sql);if(sql.startsWith('SELECT oid, nspname'))return {rowCount:1,rows:[{oid:42,nspname:catalog.schema||'public'}]};if(sql.startsWith('SELECT relname'))return {rowCount:1,rows:[{relname:catalog.table||'items'}]};if(sql.includes("c.relkind IN ('v','m')"))return {rowCount:catalog.inheritedView?1:0,rows:catalog.inheritedView?[{}]:[]};if(sql.includes('FROM pg_roles'))return {rowCount:1,rows:[{}]};if(sql.includes('quote_literal'))return {rowCount:1,rows:[{value:"'temporary'"}]};return {rowCount:0,rows:[]};}),end:vi.fn(async()=>{})};clients.push(client);return client;
 });return {clients,log};
}
beforeEach(()=>{vi.stubEnv('CDS_PREVIEW_INSTANCE','0');mocks.create.mockReset();});afterEach(()=>vi.unstubAllEnvs());
it('removes a cluster-wide role through postgres after its target database has been deleted',async()=>{
 const {clients,log}=harness({qa_deleted:'3D000'});await changeDatabasePassAccount(target,account,false);
 expect(clients.map(c=>c.database)).toEqual(['postgres','qa_deleted']);
 expect(log).toContain('postgres:ALTER ROLE "'+account.username+'" NOLOGIN');expect(log).toContain('postgres:DROP ROLE "'+account.username+'"');
 expect(clients.every(c=>c.end.mock.calls.length===1)).toBe(true);
});
it('cleans grants in a surviving target database before dropping the role in the maintenance database',async()=>{
 const {log}=harness();await changeDatabasePassAccount(target,account,false);
 const disable=log.indexOf('postgres:ALTER ROLE "'+account.username+'" NOLOGIN'),grants=log.indexOf('qa_deleted:DROP OWNED BY "'+account.username+'"'),drop=log.indexOf('postgres:DROP ROLE "'+account.username+'"');
 expect(disable).toBeGreaterThan(-1);expect(grants).toBeGreaterThan(disable);expect(drop).toBeGreaterThan(grants);
});
it('uses template1 if postgres was removed, but does not hide target authentication or grant-cleanup failures',async()=>{
 const {clients}=harness({postgres:'3D000',qa_deleted:'3D000'});await changeDatabasePassAccount(target,account,false);expect(clients.map(c=>c.database)).toEqual(['postgres','template1','qa_deleted']);
 const next=harness({qa_deleted:'28P01'});await expect(changeDatabasePassAccount(target,account,false)).rejects.toMatchObject({code:'28P01'});expect(next.log.some(s=>s.includes('DROP ROLE'))).toBe(false);expect(next.clients.every(c=>c.end.mock.calls.length===1)).toBe(true);
});
it('keeps issuance scoped to the selected database',async()=>{
 const {clients,log}=harness();await changeDatabasePassAccount(target,account,true);expect(clients.map(c=>c.database)).toEqual(['qa_deleted']);expect(log.some(s=>s.includes('CREATE ROLE'))).toBe(true);
});

it('grants PostgreSQL base tables individually, excluding ordinary/materialized/foreign views',async()=>{
 const {clients,log}=harness({}, {schema:'odd"schema',table:'odd"table'});await changeDatabasePassAccount(target,account,true);
 expect(clients[0].query).toHaveBeenCalledWith(expect.stringContaining("relkind IN ('r','p')"),[42]);
 expect(log).toContain('qa_deleted:GRANT SELECT ON TABLE "odd""schema"."odd""table" TO "'+account.username+'"');
 expect(log.some(sql=>sql.includes('ALL TABLES'))).toBe(false);
});
it('refuses inherited PUBLIC SELECT on unaudited views and removes the generated role',async()=>{
 const {log}=harness({}, {inheritedView:true});await expect(changeDatabasePassAccount(target,account,true)).rejects.toThrow('未经审查的视图');
 expect(log).toContain('qa_deleted:DROP ROLE "'+account.username+'"');expect(log.some(sql=>sql.includes('GRANT SELECT'))).toBe(false);
});
