import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceKeyValidity } from '../src/lib/serviceKeyValidity.ts';
const now = Date.parse('2026-11-15T12:00:00Z');
test('过期凭据不能因Enabled仍true而显示有效，恰好截止也已过期', () => {
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:'2026-11-15T11:59:59Z'},now).value,'expired');
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:'2026-11-15T12:00:00Z'},now).value,'expired');
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:'2026-11-15T12:00:01Z'},now).value,'active');
});
test('撤销优先于过期；无期限可有效；无效时间不能报绿；轮换阶段不改变有效性', () => {
  assert.equal(serviceKeyValidity({enabled:false,expiresAt:'2026-11-14T12:00:00Z'},now).value,'revoked');
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:null},now).value,'active');
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:'bad-date'},now).value,'unknown');
  assert.equal(serviceKeyValidity({enabled:true,expiresAt:'2026-11-14T12:00:00Z',rotationState:'awaiting-client-cutover'},now).value,'expired');
});
