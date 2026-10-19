import {EventEmitter} from 'node:events';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn()}));vi.mock('mysql2',()=>({default:{createConnection:mocks.create}}));
import {executeSqlConsole} from '../../src/services/sql-console-executor.js';
import {SqlConsoleExecutionError} from '../../src/services/sql-console-results.js';
beforeEach(()=>vi.stubEnv('CDS_PREVIEW_INSTANCE','0'));afterEach(()=>vi.unstubAllEnvs());
function connections(emit:(query:EventEmitter)=>void){
 const control={connect:(cb:(err?:Error)=>void)=>cb(),query:vi.fn(),on:vi.fn(),destroy:vi.fn()};
 const connection={query:()=>{const q=new EventEmitter();queueMicrotask(()=>emit(q));return q;},on:vi.fn(),destroy:vi.fn()};
 mocks.create.mockReset().mockReturnValueOnce(control).mockReturnValueOnce(connection);return {control,connection};
}
const options={runtime:'mysql' as const,port:3306,user:'qa',password:'private',database:'qa',sql:'SELECT 1; UPDATE items SET n=2; SELECT 3; DELETE FROM items WHERE 1=0',readOnly:false,timeoutMs:5000};
it('supports indexed query/DML/query/DML events without treating headers as rows',async()=>{
 connections(q=>{q.emit('fields',[{name:'one'}],0);q.emit('result',['1'],0);q.emit('result',{affectedRows:1,info:'matched 1'},1);q.emit('fields',[{name:'three'}],2);q.emit('result',['3'],2);q.emit('result',{affectedRows:0},3);q.emit('end');});
 const result=await executeSqlConsole(options);expect(result.resultSets?.map(s=>s.rows)).toEqual([[['1']],[['3']]]);expect(result.output).toContain('1 row affected');expect(result.output).toContain('0 row affected');
});
it('retains committed modification records and earlier query rows when a later statement fails',async()=>{
 connections(q=>{q.emit('fields',[{name:'one'}],0);q.emit('result',['1'],0);q.emit('result',{affectedRows:1},1);q.emit('error',new Error('missing table'));});
 const error=await executeSqlConsole(options).catch(e=>e);expect(error).toBeInstanceOf(SqlConsoleExecutionError);expect(error.partialResult.resultSets[0].rows).toEqual([['1']]);expect(error.partialResult.output).toContain('1 row affected');expect(error.message).toContain('missing table');
});

it('also supports actual mysql2 events that omit metadata/header indices',async()=>{
 connections(q=>{q.emit('fields',[{name:'one'}]);q.emit('result',['1'],0);q.emit('fields',undefined);q.emit('result',{affectedRows:1});q.emit('fields',[{name:'three'}]);q.emit('result',['3'],2);q.emit('end');});
 const result=await executeSqlConsole(options);expect(result.resultSets?.map(s=>s.rows)).toEqual([[['1']],[['3']]]);expect(result.output).toContain('1 row affected');
});
