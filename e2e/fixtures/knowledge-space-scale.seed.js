(function(){
// 专用本地测试容器，禁止替换为既有业务数据库。
const d = db.getSiblingDB('kb_scale_isolated');
const owner = d.users.findOne({Username:'scale_admin'});
if (!owner) throw Error('isolated admin not initialized');
for (const n of [200,1000,5000]) {
 const storeId=`scale-${n}`;
 d.document_stores.replaceOne({_id:storeId},{_id:storeId,Name:`规模验证 ${n}`,OwnerId:owner._id,IsPublic:false,DocumentCount:n,Tags:[],PinnedEntryIds:[],DefaultSortMode:'default',CreatedAt:new Date('2026-01-01'),UpdatedAt:new Date()}, {upsert:true});
 d.document_entries.deleteMany({StoreId:storeId});
 const entries=[], documents=[];
 for(let i=0;i<n+4;i++) {
   const id=`${storeId}-${String(i).padStart(5,'0')}`, folder=i<4;
   let parent=null;
   if(i>=4 && i<Math.floor(n/2)) parent=`${storeId}-00000`;
   if(i===4) parent=`${storeId}-00001`;
   if(i===5) parent=`${storeId}-00002`; // legacy github_directory, IsFolder=false
   if(i===6) parent=`${storeId}-absent`;
   if(i===7) parent=null;
   if(i===8) parent=null;
   if(i===9) parent=null;
   const raw=`# 规模文档 ${String(i).padStart(5,'0')}\n\n${'正文规模测试资料。'.repeat(400)}\n唯一尾部检索${i}\n`;
   entries.push({_id:id,StoreId:storeId,ParentId:parent,IsFolder:folder&&i!==2,SourceType:i===2?'github_directory':'upload',Title:folder?`目录 ${i}`:`共同关键词 文档 ${String(i).padStart(5,'0')}`,DocumentId:folder?null:id,ContentType:folder?'application/x-folder':'text/markdown',Summary:folder?'':`# 规模文档 ${String(i).padStart(5,'0')}`,ContentIndex:folder||i%2===1?null:raw.slice(0,2000),Metadata:{},Tags:[],CreatedBy:owner._id,CreatedAt:new Date('2026-01-01'),UpdatedAt:new Date('2026-01-01')});
   if(!folder) documents.push({_id:id,Title:`规模文档 ${i}`,RawContent:raw,CharCount:raw.length,TokenEstimate:1000,Sections:[],CreatedAt:new Date('2026-01-01')});
 }
 d.document_entries.insertMany(entries);
 d.documents.deleteMany({_id:{$regex:`^${storeId}-`}});
 d.documents.insertMany(documents);
}
d.document_stores.replaceOne({_id:'scale-denied'},{_id:'scale-denied',Name:'他人私有库',OwnerId:'someone-else',IsPublic:false,Tags:[],PinnedEntryIds:[],CreatedAt:new Date(),UpdatedAt:new Date()}, {upsert:true});
print(JSON.stringify({db:d.getName(),owner:owner._id,counts:[200,1000,5000].map(n=>d.document_entries.countDocuments({StoreId:`scale-${n}`}))}));

})();
