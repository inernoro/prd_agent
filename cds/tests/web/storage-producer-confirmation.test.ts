import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {describe,it} from 'vitest';
const legacy=fs.readFileSync(new URL('../../web-legacy/app.js',import.meta.url),'utf8');
const topology=fs.readFileSync(new URL('../../web/src/pages/BranchTopologyPage.tsx',import.meta.url),'utf8');
const react=fs.readFileSync(new URL('../../web/src/pages/ProjectSettingsPage.tsx',import.meta.url),'utf8');
// Executes the real named functions and the real React callback. DOM and HTTP are
// contract fixtures: this does not claim browser/native deployment acceptance.
function extract(source:string,name:string){const ast=ts.createSourceFile('input.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const node=ast.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name?.text===name);if(!node)throw Error('missing '+name);return node.getText(ast);}
function callback(source:string){const ast=ts.createSourceFile('input.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const fn=ast.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name?.text==='InfraResyncDialog');let found:string|undefined;const visit=(node:any)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='onExecute')found=node.initializer.arguments[0].getText(ast);ts.forEachChild(node,visit)};if(!fn)throw Error("missing InfraResyncDialog");visit(fn);if(!found)throw Error("missing onExecute callback");return ts.transpileModule('globalThis.execute='+found,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
function context(accept:boolean){const calls:any[]=[],confirmations:string[]=[],nodes=new Map<string,any>();const node=(id:string)=>{if(!nodes.has(id))nodes.set(id,{value:id==='importConfigTextarea'?JSON.stringify({infraServices:[{id:'mysql'}]}):'',innerHTML:id==='configModalBody'?'original draft':'',style:{},appendChild(){}});return nodes.get(id)};const ctx:any={console,TextDecoder,API:'/api',CURRENT_PROJECT_ID:'current-project',confirm:(message:string)=>{confirmations.push(message);return accept},document:{querySelectorAll:()=>[{value:'mysql'}],getElementById:node,createElement:()=>({style:{}})},api:async(method:string,url:string,body:any)=>{calls.push({method,url,body:JSON.parse(JSON.stringify(body))});return{results:[{id:'mysql',status:'started'}]}},fetch:async(url:string,opts:any)=>{calls.push({url,body:JSON.parse(opts.body)});return{ok:true,json:async()=>({applied:{added:['mysql']},errors:[]}),body:{getReader:()=>({read:async()=>({done:true})})}}},showToast(){},esc:(x:any)=>x,loadProfiles:async()=>{},loadEnvVars:async()=>{},loadInfraServices:async()=>{},loadRoutingRules:async()=>{},loadBranches:async()=>{},openInfraModal(){}};vm.createContext(ctx);return{ctx,calls,confirmations,node};}

describe('storage producer UI confirmation before any request',()=>{
 for(const name of ['infraQuickstartSelected','importAndInit']){
  it(name+' cancellation makes zero requests and preserves the input draft',async()=>{
   const t=context(false);vm.runInContext(extract(legacy,name),t.ctx);await t.ctx[name]();
   assert.equal(t.calls.length,0);assert.equal(t.node('configModalBody').innerHTML,'original draft');assert.equal(t.confirmations.length,1);
  });
  it(name+' confirmation sends explicit new-only (and quickstart project scope)',async()=>{
   const t=context(true);vm.runInContext(extract(legacy,name),t.ctx);await t.ctx[name]();
   assert.equal(t.calls.length,1);assert.equal(t.calls[0].body.initializeStorage,'new-only');assert.match(t.confirmations[0],/空数据卷/);
   if(name==='infraQuickstartSelected'){
    assert.equal(t.calls[0].body.projectId,'current-project');assert.deepEqual(t.calls[0].body.serviceIds,['mysql']);
   }else assert.deepEqual(t.calls[0].body.config,{infraServices:[{id:'mysql'}]});
  });
 }
 for(const accept of [false,true])it('resync additions '+(accept?'confirmation sends new-only':'cancellation makes zero requests'),async()=>{
  const t=context(accept);Object.assign(t.ctx,{diff:{adds:[{id:'mysql'}],removes:[],updates:[]},confirmTextInput:'',deleteVolumes:false,projectId:'current-project',yamlText:'services: {}',setBusy(){},apiUrl:(x:string)=>x,onToast(){},onOpenChange(){},window:{confirm:t.ctx.confirm}});
  vm.runInContext(callback(react),t.ctx);await t.ctx.execute();
  assert.equal(t.calls.length,accept?1:0);assert.equal(t.confirmations.length,1);
  if(accept){assert.equal(t.calls[0].body.initializeStorage,'new-only');assert.match(t.calls[0].url,/current-project/);}
 });
 it('resync update-only requests no allocation and needs no new-volume confirmation',async()=>{
  const t=context(false);Object.assign(t.ctx,{diff:{adds:[],removes:[],updates:[{id:'existing'}]},confirmTextInput:'',deleteVolumes:false,projectId:'current-project',yamlText:'services: {}',setBusy(){},apiUrl:(x:string)=>x,onToast(){},onOpenChange(){},window:{confirm:t.ctx.confirm}});
  vm.runInContext(callback(react),t.ctx);await t.ctx.execute();
  assert.equal(t.confirmations.length,0);assert.equal(t.calls.length,1);assert.equal(t.calls[0].body.initializeStorage,undefined);
 });
 it('custom stateful submission is refused before publishing or starting unowned storage',async()=>{
  const t=context(true);const values={infraId:'custom',infraName:'Custom',infraImage:'example/custom-db:1',infraPort:'5432',infraVolName:'existing-user-volume',infraVolPath:'/custom-data',infraInjectEnv:''};for(const [k,v] of Object.entries(values))t.node(k).value=v;
  const errors:string[]=[];t.ctx.showToast=(message:string)=>errors.push(message);vm.runInContext(extract(legacy,'saveCustomInfra'),t.ctx);await t.ctx.saveCustomInfra();
  assert.equal(t.calls.length,0);assert.match(errors[0]||'',/存储|目录/);
 });

 for(const accept of [false,true])it('React custom catalog image '+(accept?'confirms explicit allocation':'cancels before metadata'),async()=>{
  const t=context(accept),ast=ts.createSourceFile('input.tsx',topology,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const outer=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='CreateInfraDialog');let submit:any;const visit=(n:any)=>{if(ts.isFunctionDeclaration(n)&&n.name?.text==='submit')submit=n;ts.forEachChild(n,visit)};visit(outer);assert(submit);
  Object.assign(t.ctx,{isCustom:true,id:'new-mongo',name:'new Mongo',image:'mongo:7',port:27017,envText:'',catalogItems:[{id:'mongodb',dockerImage:'mongo:7',hasPersistence:true}],projectId:'current-project',startAfterCreate:false,setError(){},setSubmitting(){},window:{confirm:t.ctx.confirm},parseEnvText:()=>({}),apiRequest:async(url:string,body:any)=>{t.calls.push({url,...body})},onOpenChange(){},onCreated:async()=>{},onToast(){},ApiError:class extends Error{}});
  vm.runInContext(ts.transpileModule('globalThis.submit='+submit.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,t.ctx);await t.ctx.submit({preventDefault(){}});
  assert.equal(t.calls.length,accept?1:0);assert.equal(t.confirmations.length,1);if(accept)assert.equal(t.calls[0].body.initializeStorage,'new-only');
 });

});
