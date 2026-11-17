import test from 'node:test';
import assert from 'node:assert/strict';
import { beginExchangeWriteSession, bindExchangeWriteScope, clearExchangeWriteSession, finishExchangeWriteSession, markExchangeWriteUncertain, readExchangeWriteSession } from '../src/lib/exchangeWriteSession.ts';

test('未决转接操作跨挂载保留；身份切换后旧回调不能恢复或清除新身份任务',()=>{
 clearExchangeWriteSession();bindExchangeWriteScope('tenant-A/owner');
 const a=beginExchangeWriteSession('tenant-A/owner',{label:'更新通讯密钥',secret:true,targetId:'exchange-A'});
 assert.ok(a);markExchangeWriteUncertain('tenant-A/owner',a);assert.equal(readExchangeWriteSession('tenant-A/owner').phase,'unknown');
 assert.equal(beginExchangeWriteSession('tenant-A/owner',{label:'第二次覆盖',secret:true}),null,'same-scope unresolved task blocks a second intent');
 bindExchangeWriteScope('tenant-B/owner');assert.equal(readExchangeWriteSession('tenant-A/owner'),null);assert.equal(beginExchangeWriteSession('tenant-A/owner',{label:'迟到旧表单',secret:true}),null);
 const b=beginExchangeWriteSession('tenant-B/owner',{label:'编辑映射',secret:false,targetId:'exchange-B'});assert.ok(b);markExchangeWriteUncertain('tenant-A/owner',a);finishExchangeWriteSession('tenant-A/owner',a);assert.equal(readExchangeWriteSession('tenant-B/owner').token,b,'late A cannot mutate B outcome');
 clearExchangeWriteSession();assert.equal(readExchangeWriteSession('tenant-B/owner'),null);assert.equal(beginExchangeWriteSession('tenant-B/owner',{label:'已登出旧表单',secret:true}),null);
});
