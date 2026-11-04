import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:undefined as any}));
vi.mock('pg',async original=>{
 const actual=(await original<any>()).default;
 return {default:{...actual,Client:class{
  async connect(){}on(){}async end(){}
  query(query:any){mocks.query=query;queueMicrotask(()=>{
   const connection={};
   for(let i=0;i<1000;i++){
    query.handleRowDescription({fields:[{name:'column'.repeat(200),dataTypeID:25,format:'text',tableID:0,columnID:0,dataTypeSize:-1,dataTypeModifier:-1}]});
    query.handleDataRow({fields:['value-'+i]});query.handleCommandComplete({text:'SELECT 1'},connection);
   }
   query.handleReadyForQuery(connection);
  });}
 }}};
});
import {executeSqlConsole} from '../../src/services/sql-console-executor.js';
beforeEach(()=>vi.stubEnv('CDS_PREVIEW_INSTANCE','0'));afterEach(()=>vi.unstubAllEnvs());
it('streams PostgreSQL results without a second unbounded driver metadata collection',async()=>{
 const result=await executeSqlConsole({runtime:'postgres',port:5432,user:'qa',password:'private',database:'qa',sql:'SELECT 1',readOnly:false,timeoutMs:5000});
 expect(result.truncated).toBe(true);expect(result.rows[0]).toEqual(['value-0']);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256*1024);
 expect(Array.isArray(mocks.query._results)).toBe(false);expect(mocks.query._results.rows).toEqual([]);expect(mocks.query._results.fields).toHaveLength(1);
});
