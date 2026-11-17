/** Enumerate the source declarations covered by native-select and floating-layer policies. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web/src');
const controls=[],floats=[],errors=[];
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name);if(entry.isDirectory()){scan(file);continue;}if(!file.endsWith('.tsx'))continue;
 const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),relative=path.relative(root,file).replaceAll('\\','/');
 const boundStyles=new Set();
 function bindings(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==='useAnchoredPosition')boundStyles.add(node.name.text);ts.forEachChild(node,bindings);}bindings(ast);
 function visit(node){
  if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
   const tag=node.tagName.getText(ast),attrs=new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(a=>[a.name.getText(ast),a.initializer?.getText(ast)??'true'])),line=ast.getLineAndCharacterOfPosition(node.getStart()).line+1;
   if(tag==='select'){
    const listbox=attrs.has('multiple')||attrs.has('size');
    controls.push({file:relative,line,type:listbox?'native-listbox':'native-single'});
    if(!listbox&&/appearance-none/.test(attrs.get('className')||''))errors.push(`${relative}:${line}: single select bypasses the shared arrow`);
   }
   const role=(attrs.get('role')||'').replaceAll('"','').replaceAll("'",'');
   if(['menu','listbox','combobox'].includes(role)||['AnchoredPopover','DropdownMenu','BranchSearchDropdown','ConfirmAction','InstanceSwitcher'].includes(tag)){
    let parent=node.parent,shared=['AnchoredPopover','DropdownMenu','BranchSearchDropdown','ConfirmAction','InstanceSwitcher'].includes(tag);
    while(parent){if(ts.isJsxElement(parent)&&parent.openingElement.tagName.getText(ast)==='AnchoredPopover')shared=true;parent=parent.parent;}
    const style=(attrs.get('style')||'').replace(/^\{|\}$/g,'').trim();
    if(boundStyles.has(style))shared=true;
    const inFlow=relative==='components/AgentAccessMap.tsx';
    const type=role==='combobox'?'search-trigger':inFlow?'in-flow-selection':shared?'shared-floating':'unregistered-floating';
    floats.push({file:relative,line,tag,role:role||undefined,type});
    if(type==='unregistered-floating')errors.push(`${relative}:${line}: ${role} needs shared floating geometry or an explicit in-flow classification`);
   }
  }ts.forEachChild(node,visit);
 }visit(ast);
}}
scan(root);
const summary={nativeControls:controls.length,nativeFiles:new Set(controls.map(x=>x.file)).size,nativeSingles:controls.filter(x=>x.type==='native-single').length,floatingDeclarations:floats.length,unregistered:errors.length};
if(process.argv.includes('--json'))console.log(JSON.stringify({summary,controls,floats,errors},null,2));else console.log(JSON.stringify(summary));
if(errors.length){for(const error of errors)console.error(error);process.exitCode=1;}
