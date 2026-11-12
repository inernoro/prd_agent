import { request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir('work',{recursive:true});
await fs.rm('work/api-audit.json',{force:true});
const base=process.env.SCALE_API_URL||'http://localhost:5001';
assert.equal(new URL(base).hostname,'localhost','This harness mutates only the local isolated fixture');
const mongo=code=>execFileSync('docker',['exec','kb-scale-mongo','mongosh','--quiet','--eval',`const d=db.getSiblingDB('kb_scale_isolated');${code}`],{encoding:'utf8'});
mongo(`const u=d.users.findOne({Username:'scale_admin'});u._id='scale-reader';u.Username='scale_reader';d.users.replaceOne({_id:u._id},u,{upsert:true});`);
async function client(username){
 const c=await request.newContext({baseURL:base});
 const login=await c.post('/api/v1/auth/login',{data:{username,password:'ScaleIsolated2026pass',clientType:'admin'}});
 const body=await login.json();assert.equal(body.success,true);
 await c.dispose();
 return request.newContext({baseURL:base,extraHTTPHeaders:{Authorization:`Bearer ${body.data.accessToken}`}});
}
const anonymous=await request.newContext({baseURL:base});
assert.equal((await anonymous.get('/api/document-store/stores/scale-200/navigation')).status(),401);
await anonymous.dispose();
const owner=await client('scale_admin'), reader=await client('scale_reader');
const results=[];
async function nav(c,store,params={}){const r=await c.get(`/api/document-store/stores/${store}/navigation`,{params});assert.equal(r.status(),200,await r.text());const body=await r.json();assert.equal(body.success,true);return body.data;}
async function all(c,store,params={}){
 let cursor,before;const ids=[],pages=[],shareIds=[];const start=performance.now();
 do {const page=await nav(c,store,{...params,...(cursor?{afterId:cursor,before}:{})});
  assert(page.items.every(e=>!e.contentIndex));ids.push(...page.items.map(e=>e.id));shareIds.push(...page.sharedEntryIds);pages.push(page.items.length);before??=page.before;cursor=page.nextCursor;
 }while(cursor);
 assert.equal(ids.length,new Set(ids).size,'duplicate entries across cursor pages');
 return {ids,pages,shareIds,ms:performance.now()-start};
}
for(const n of [200,1000,5000]){
 const store=`scale-${n}`;
 const browse=await all(owner,store);assert.equal(browse.ids.length,n+4);
 assert.deepEqual([...browse.ids].sort(),Array.from({length:n+4},(_,i)=>`${store}-${String(i).padStart(5,'0')}`));
 const search=await all(owner,store,{keyword:'共同关键词',searchContent:true});assert.equal(search.ids.length,n);
 const body=await all(owner,store,{keyword:'唯一尾部检索',searchContent:true});assert.equal(body.ids.length,n);
 const tail=await all(owner,store,{keyword:`唯一尾部检索${n+3}`,searchContent:true});assert(tail.ids.includes(`${store}-${String(n+3).padStart(5,'0')}`));
 const content=await owner.get(`/api/document-store/entries/${store}-00004/content`);assert.equal(content.status(),200);assert((await content.text()).includes('唯一尾部检索4'));
 results.push({n,browse:{count:browse.ids.length,pages:browse.pages,ms:browse.ms},search:{count:search.ids.length,pages:search.pages,ms:search.ms},fullBody:{count:body.ids.length,pages:body.pages,ms:body.ms},tailFound:true});
 for(const path of [`stores/${store}/navigation`,`stores/${store}/navigation?keyword=共同关键词&searchContent=true`,`stores/${store}/entries?all=true&keyword=共同关键词&searchContent=true`,`entries/${store}-00004/content`]) assert.equal((await reader.get('/api/document-store/'+path)).status(),404,path);
}
// 权限撤销必须在后续游标、搜索和打开正文时立即生效。
mongo(`d.document_stores.updateOne({_id:'scale-200'},{$set:{SharedTeamIds:['scale-team']}});d.team_members.replaceOne({_id:'scale-membership'},{_id:'scale-membership',TeamId:'scale-team',UserId:'scale-reader',Role:'member'},{upsert:true});`);
try{
 const first=await nav(reader,'scale-200',{pageSize:10});assert(first.nextCursor);
 mongo(`d.team_members.deleteOne({_id:'scale-membership'});`);
 assert.equal((await reader.get('/api/document-store/stores/scale-200/navigation',{params:{afterId:first.nextCursor,before:first.before}})).status(),404);
 assert.equal((await reader.get('/api/document-store/entries/scale-200-00004/content')).status(),404);
 mongo(`d.document_stores.updateOne({_id:'scale-200'},{$set:{IsPublic:true}});`);
 assert.equal((await nav(reader,'scale-200')).items.length,204);
 assert.equal((await reader.get('/api/document-store/entries/scale-200-00004/content')).status(),200);
 assert([403,404].includes((await reader.put('/api/document-store/entries/scale-200-00004/content',{data:{content:'unauthorized'}})).status()));
}finally{mongo(`d.document_stores.updateOne({_id:'scale-200'},{$set:{IsPublic:false,SharedTeamIds:[]}});d.team_members.deleteOne({_id:'scale-membership'});`);}
// 字面量搜索；附件正文兜底不依赖短索引。
mongo(`d.document_entries.updateOne({_id:'scale-200-00004'},{$set:{Title:'共同关键词 [draft] v1.0 foo('}});d.attachments.replaceOne({_id:'scale-att'}, {_id:'scale-att',AttachmentId:'scale-att',ExtractedText:'x'.repeat(3000)+'附件尾部唯一词'}, {upsert:true});d.document_entries.updateOne({_id:'scale-200-00005'},{$set:{DocumentId:null,AttachmentId:'scale-att',ContentIndex:null}});`);
try{
 assert.equal((await all(owner,'scale-200',{keyword:'[draft]'})).ids.length,1);
 assert.equal((await all(owner,'scale-200',{keyword:'foo('})).ids.length,1);
 assert.deepEqual((await all(owner,'scale-200',{keyword:'附件尾部唯一词',searchContent:true})).ids,['scale-200-00005']);
}finally{mongo(`d.document_entries.updateOne({_id:'scale-200-00004'},{$set:{Title:'共同关键词 文档 00004'}});d.document_entries.updateOne({_id:'scale-200-00005'},{$set:{DocumentId:'scale-200-00005',AttachmentId:null}});d.attachments.deleteOne({_id:'scale-att'});`);}
// 插入/删除不会像 offset 一样把其余记录挤重或跳过。
mongo(`const s=d.document_stores.findOne({_id:'scale-200'});s._id='scale-cursor';d.document_stores.replaceOne({_id:s._id},s,{upsert:true});d.document_entries.deleteMany({StoreId:'scale-cursor'});d.document_entries.insertMany(Array.from({length:20},(_,i)=>({_id:'cursor-'+String(i).padStart(3,'0'),StoreId:'scale-cursor',Title:'游标 '+i,CreatedAt:new Date('2026-01-01')})));`);
try{
 const first=await nav(owner,'scale-cursor',{pageSize:7});
 mongo(`d.document_entries.deleteOne({_id:'cursor-000'});d.document_entries.insertOne({_id:'cursor-new',StoreId:'scale-cursor',Title:'新条目',CreatedAt:new Date()});`);
 const seen=first.items.map(e=>e.id);let cursor=first.nextCursor;
 while(cursor){const p=await nav(owner,'scale-cursor',{pageSize:7,afterId:cursor,before:first.before});seen.push(...p.items.map(e=>e.id));cursor=p.nextCursor;}
 assert.equal(seen.length,20);assert.equal(new Set(seen).size,20);assert(!seen.includes('cursor-new'));
 const fresh=await all(owner,'scale-cursor');assert.equal(fresh.ids.length,20);assert(fresh.ids.includes('cursor-new'));
 mongo(`d.document_entries.updateOne({_id:'cursor-019'},{$set:{CreatedAt:new Date('2030-01-01')}});`);
 assert((await all(owner,'scale-cursor')).ids.includes('cursor-019'),'preserved future source timestamps must remain reachable');
}finally{mongo(`d.document_entries.deleteMany({StoreId:'scale-cursor'});d.document_stores.deleteOne({_id:'scale-cursor'});`);}
console.log(JSON.stringify({verdict:'pass',results,permissions:'private,public-readonly,team-revocation-per-page,content-open',boundaries:'same-createdAt,cursor-insert-delete,literal-regex,attachment-tail,future-source-time'},null,2));
await fs.writeFile('work/api-audit.json',JSON.stringify({verdict:'pass',results,permissions:['private','public-readonly','team-revocation-per-page','content-open'],boundaries:['same-createdAt','cursor-insert-delete','literal-regex','attachment-tail','future-source-time']},null,2));
await owner.dispose();await reader.dispose();
