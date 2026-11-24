import test from 'node:test';
import assert from 'node:assert/strict';
import { appCallerDetailCandidates, callerManagementState } from '../src/lib/appCallerIdentity.ts';
const rows=[{id:'vision',appCallerCode:'same.identity',requestType:'vision'},{id:'chat',appCallerCode:'same.identity',requestType:'chat'},{id:'g',appCallerCode:'G-same.identity',requestType:'chat'}];
test('调用方id权威且不回退；同码不同用途必须精确匹配或交用户选择',()=>{
 assert.deepEqual(appCallerDetailCandidates(rows,'chat','same.identity','vision').map(x=>x.id),['chat']);
 assert.deepEqual(appCallerDetailCandidates(rows,'missing','same.identity','chat'),[]);
 assert.deepEqual(appCallerDetailCandidates(rows,'','same.identity','chat').map(x=>x.id),['chat']);
 assert.deepEqual(appCallerDetailCandidates(rows,'','same.identity','').map(x=>x.id),['vision','chat']);
 assert.deepEqual(appCallerDetailCandidates(rows,'','G-same.identity','chat').map(x=>x.id),['g']);
});
test('自动发现与已配置均允许调用，不能以登记阶段代替管理状态或健康',()=>{
 for(const status of ['discovered','configured','active'])assert.deepEqual(callerManagementState(status),{label:'允许调用',tone:'neutral'});
 assert.equal(callerManagementState('unexpected').label,'状态未知');
 assert.equal(callerManagementState('disabled').label,'已停用');
});
