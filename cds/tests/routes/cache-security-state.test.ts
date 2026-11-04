import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {createCacheRouter} from '../../src/routes/cache.js';
import {MockShellExecutor} from '../../src/services/shell-executor.js';
import type {StateService} from '../../src/services/state.js';
it('never discovers, exports, imports or purges the durable database-pass ledger as cache',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'cds-cache-security-')),dir=path.join(base,'database-passes');fs.mkdirSync(dir);
  const ledger='[{"id":"prepared-pass","status":"prepared"}]';fs.writeFileSync(path.join(dir,'passes.json'),ledger);
  const shell=new MockShellExecutor();shell.addResponsePattern(/.*/,()=>({stdout:'0',stderr:'',exitCode:0}));
  const state={getCacheBase:()=>base,getBuildProfiles:()=>[{id:'bad-mount',cacheMounts:[{hostPath:dir,containerPath:'/cache'}]}],projectSlug:'qa'} as unknown as StateService;
  const app=express();app.use('/api',createCacheRouter({stateService:state,shell}));const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address()as any).port}/api/cache`;
  try{
    const status=await(await fetch(url+'/status')).json();expect(status.caches).toEqual([]);expect(status.orphans).toEqual([]);
    for(const [route,method]of [['purge','POST'],['export','GET'],['import','POST']])expect((await fetch(url+'/'+route+'?name=database-passes',{method})).status).toBe(409);
    expect(fs.readFileSync(path.join(dir,'passes.json'),'utf8')).toBe(ledger);expect(shell.commands).toEqual([]);
    fs.mkdirSync(path.join(base,'pnpm'));expect((await fetch(url+'/purge?name=pnpm',{method:'POST'})).status).toBe(200);
    expect(shell.commands.some(cmd=>cmd.includes('database-passes'))).toBe(false);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(base,{recursive:true,force:true});}
});
