import{afterEach,describe,expect,it,vi}from'vitest';
import fs from'node:fs';
import path from'node:path';
import os from'node:os';
import crypto from'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { AlarmChannel } from '../../src/services/alarm-channel.js';
import { readMapNotifierSettings } from '../../src/services/map-notifier.js';
import { createUptimeRouter } from '../../src/routes/uptime.js';
import{buildCanonicalRequest,HEADER_KEY_ID,HEADER_TIMESTAMP,HEADER_NONCE,HEADER_SIGNATURE}from'../../src/services/map-notifier.js';
import{StateService}from'../../src/services/state.js';
import{resolveCurrentNoticeOutbound}from'../../src/services/notice-ledger.js';
import{MapNotifier}from'../../src/services/map-notifier.js';
import{forwardNoticeToMap}from'../../src/services/notice-outbound-map.js';
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const signing={endpoint:'https://map.example.test/api/dashboard/notifications/events',keyId:'cds-notice-test',username:'cds-service',targetUsername:'inernoro',privateKeyPem:keys.privateKey};const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
describe('existing signed MAP configuration used by capacity notices',()=>{
 it('uses the existing signing configuration instead of silently skipping capacity forwarding',()=>{
  const read=vi.fn(()=>signing);const resolved=resolveCurrentNoticeOutbound({},()=>null,read);
  expect(read).toHaveBeenCalledOnce();expect(resolved?.signing?.keyId).toBe(signing.keyId);
 });
 it('includes an explicit fixed recipient in the existing real signature transport',async()=>{
  let body:any;vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{body=JSON.parse(init.body);return{ok:true,status:200,text:async()=>'{"success":true}'}}));
  const notifier=new MapNotifier(signing);const result=await notifier.send({drill:true,type:'uptime.target.recovered',targetId:'fixture',targetName:'fixture',message:'isolated',consecutiveFailures:0,detectedAt:new Date().toISOString()});
  expect(result.ok).toBe(true);expect(body.targetUsername).toBe('inernoro');expect(body.targetUserId).toBeUndefined();
 });
 it('persists the existing private key encrypted and loads the identical signer after restart',async()=>{
  vi.stubEnv('CDS_SECRET_KEY','a'.repeat(64));const root=fs.mkdtempSync(path.join(os.tmpdir(),'signed-notice-state-'));roots.push(root);const file=path.join(root,'state.json');const state=new StateService(file);state.load();state.setAlarmNotify({endpoint:signing.endpoint,keyId:signing.keyId,username:signing.username,privateKey:keys.privateKey});await state.flush();
  const raw=fs.readFileSync(file,'utf8');expect(raw).not.toContain(keys.privateKey);expect(raw).not.toContain('BEGIN PRIVATE KEY');
  const restarted=new StateService(file);restarted.load();expect(restarted.getAlarmNotify()?.privateKey).toBe(keys.privateKey);
 });
 it('preserves the explicit bearer override and disables all reads with the existing kill switch',()=>{
  const read=vi.fn(()=>signing),fallback=vi.fn(()=>{throw Error('must not decrypt');});
  const dedicated=resolveCurrentNoticeOutbound({CDS_NOTICE_MAP_BASE_URL:'https://map.test',CDS_NOTICE_MAP_TOKEN:'legacy-dedicated'},fallback,read);
  expect(dedicated?.token).toBe('legacy-dedicated');expect(read).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
  expect(resolveCurrentNoticeOutbound({CDS_NOTICE_OUTBOUND_ENABLED:'0'},fallback,read)).toBeNull();expect(read).not.toHaveBeenCalled();
 });
 it('does not fall back to an administrator token when signed configuration cannot be decrypted',()=>{
  const fallback=vi.fn(()=>({baseUrl:'https://old.test',token:'old-administrator'}));
  expect(()=>resolveCurrentNoticeOutbound({},fallback,()=>{throw Error('sealed key unavailable');})).toThrow('sealed key unavailable');
  expect(fallback).not.toHaveBeenCalled();
 });
 it('signs the actual fixed-recipient body with fresh nonces and records the real MAP response ID',async()=>{
  const cfg=resolveCurrentNoticeOutbound({CDS_NOTICE_MAP_TARGET_USER:'must-not-override'},()=>null,()=>signing)!;
  const notice:any={id:'n1',dedupeKey:'capacity.risk:test',source:'system',level:'warning',title:'容量预警',body:'隔离输入',createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),occurrences:1};
  const requests:any[]=[];const send=vi.fn(async(_url:string,init:any)=>{requests.push(init);return{ok:true,status:200,text:async()=>JSON.stringify({success:true,data:{created:true,notification:{id:'actual-map-id'}}})}});
  expect(await forwardNoticeToMap(notice,cfg,send)).toEqual({ok:true,reference:'actual-map-id'});
  expect(await forwardNoticeToMap(notice,cfg,send)).toEqual({ok:true,reference:'actual-map-id'});
  for(const request of requests){const h=request.headers,body=JSON.parse(request.body);expect(body.targetUsername).toBe('inernoro');expect(body.targetUserId).toBeUndefined();expect(h.Authorization).toBeUndefined();expect(h[HEADER_KEY_ID]).toBe(signing.keyId);
   const canonical=buildCanonicalRequest('POST','/api/dashboard/notifications/events',Number(h[HEADER_TIMESTAMP]),h[HEADER_NONCE],signing.username,request.body);
   expect(crypto.verify('sha256',Buffer.from(canonical),{key:keys.publicKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(h[HEADER_SIGNATURE],'base64'))).toBe(true);}
  expect(requests[0].headers[HEADER_NONCE]).not.toBe(requests[1].headers[HEADER_NONCE]);expect(JSON.parse(requests[0].body).dedupKey).toBe(JSON.parse(requests[1].body).dedupKey);
 });
 it.each([{ok:false,status:403,text:async()=>'{"success":false,"error":{"message":"固定目标拒绝"}}'},
  {ok:true,status:200,text:async()=>'<html>proxy</html>'}])('does not confirm delivery on a refusal or an unknown envelope',async(response)=>{
  const cfg=resolveCurrentNoticeOutbound({},()=>null,()=>signing)!;const notice:any={id:'n',dedupeKey:'risk:test',source:'system',level:'warning',title:'隔离',body:'隔离',createdAt:new Date(0).toISOString()};
  expect((await forwardNoticeToMap(notice,cfg,async()=>response)).ok).toBe(false);
 });
 it('keeps monitoring status readable when the stored signer is unreadable without selecting fallback',()=>{
  const env={CDS_MAP_NOTIFY_ENDPOINT:signing.endpoint,CDS_MAP_NOTIFY_KEY_ID:'fallback',CDS_MAP_NOTIFY_USERNAME:'administrator',CDS_MAP_NOTIFY_PRIVATE_KEY:keys.privateKey};
  const read=()=>readMapNotifierSettings(()=>{throw Error('private-decryption-error');},env);
  expect(read()).toEqual({config:null,source:'settings',unavailable:true});
  const channel=new AlarmChannel(()=>Boolean(read().config),'MAP',()=>read().unavailable?['CDS_SECRET_KEY']:[]);
  channel.record({ok:true},'drill',1);
  expect(channel.snapshot()).toMatchObject({status:'unconfigured',missing:['CDS_SECRET_KEY']});
  expect(readMapNotifierSettings(()=>undefined,env)).toMatchObject({source:'env',unavailable:false,config:{keyId:'fallback'}});
 });
 it('keeps the actual monitoring callbacks usable after a stored credential decryption failure',()=>{
  const source=fs.readFileSync(new URL('../../src/index.ts',import.meta.url),'utf8');
  const block=source.match(/const alarmChannel = new AlarmChannel\([\s\S]*?\n  \);/)![0];
  const state={getAlarmNotify:()=>{throw Error('unreadable-key');}};
  const channel=new Function('AlarmChannel','stateService','readMapSettings','missingAlarmEnvKeys','mapNotifierConfigFromEnv',block+';return alarmChannel;')(
   AlarmChannel,state,()=>readMapNotifierSettings(state.getAlarmNotify),()=>[],()=>signing);
  expect(()=>channel.snapshot()).not.toThrow();expect(channel.snapshot().status).toBe('unconfigured');
  expect(channel.snapshot().missing.join(' ')).toContain('CDS_SECRET_KEY');
 });
 it('rejects new plaintext storage and fails closed if an encrypted key cannot be reopened',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'signed-notice-no-seal-'));roots.push(root);const file=path.join(root,'state.json'),state=new StateService(file);state.load();
  vi.stubEnv('CDS_SECRET_KEY','');expect(()=>state.setAlarmNotify({endpoint:signing.endpoint,keyId:signing.keyId,username:signing.username,privateKey:keys.privateKey})).toThrow('密封存储');
  expect(state.getAlarmNotify()).toBeUndefined();vi.stubEnv('CDS_SECRET_KEY','a'.repeat(64));state.setAlarmNotify({endpoint:signing.endpoint,keyId:signing.keyId,username:signing.username,privateKey:keys.privateKey,targetUsername:'inernoro'});await state.flush();
  vi.stubEnv('CDS_SECRET_KEY','b'.repeat(64));expect(()=>state.getAlarmNotify()).toThrow();
 });
 it('does not return success before durable configuration is confirmed and suppresses secret request logging',async()=>{
  let release!:()=>void,entered!:()=>void,replied=false,suppressed=false;let responseHeadersSent=()=>true;
  const durable=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const write=vi.fn(async(_next:unknown)=>{entered();await durable;});
  const app=express();app.use(express.json());app.use((_req,res,next)=>{responseHeadersSent=()=>res.headersSent;res.on('finish',()=>{suppressed=res.locals.cdsSuppressRequestBodyLog===true&&res.locals.cdsSuppressRequestDetails===true;});next();});
  app.use(createUptimeRouter({monitor:{},readAlarmNotify:()=>({configured:true,secretStorage:'encrypted'}),writeAlarmNotify:write} as any));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const response=fetch(`http://127.0.0.1:${(server.address() as any).port}/cds-system/alarm-notify`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:signing.endpoint,keyId:signing.keyId,username:signing.username,targetUsername:'inernoro',privateKey:keys.privateKey})}).then(r=>{replied=true;return r;});
   await started;expect(responseHeadersSent()).toBe(false);expect(replied).toBe(false);release();const result=await response;expect(result.status).toBe(200);expect(await result.text()).not.toContain('BEGIN PRIVATE KEY');expect(suppressed).toBe(true);
   expect(write.mock.calls[0][0]).toMatchObject({username:'cds-service',targetUsername:'inernoro'});
  }finally{release();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 });
});
