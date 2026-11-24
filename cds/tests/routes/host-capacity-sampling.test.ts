import express from 'express';
import { once } from 'node:events';
import type http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostCapacitySamplingRouter } from '../../src/routes/host-capacity-sampling.js';
const servers:http.Server[]=[];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
async function setup(identity:unknown){const service={getStatus:vi.fn(()=>({enabled:false})),setEnabled:vi.fn(async(_enabled:boolean)=>{}),requestSample:vi.fn()};const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,identity);next();});app.use(createHostCapacitySamplingRouter(service as any));const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');return{service,url:`http://127.0.0.1:${(server.address() as any).port}/host-capacity/sampling`};}
it('rejects machine/project/SSO/nonowner identities for every sampling operation',async()=>{
 for(const identity of [{},{cdsUser:{isSystemOwner:true}},{cdsProjectKey:{projectId:'p'}},{cdsSession:{},cdsUser:{isSystemOwner:false}},{cdsSession:{},cdsUser:{isSystemOwner:true,authProvider:'sso'}}]){
  const {service,url}=await setup(identity);for(const method of ['GET','PUT','POST']){const r=await fetch(url+(method==='POST'?'/run':''),{method,headers:{'content-type':'application/json'},...(method==='PUT'?{body:'{"enabled":true}'}:{})});expect(r.status).toBe(403);}expect(service.setEnabled).not.toHaveBeenCalled();expect(service.requestSample).not.toHaveBeenCalled();
 }
});
it('allows an owner to persist a boolean only; GET never starts collection and arbitrary paths/commands are rejected',async()=>{
 const {service,url}=await setup({_cdsBasicHumanAuth:true,cdsUser:{isSystemOwner:true}});
 expect((await fetch(url)).status).toBe(200);expect(service.requestSample).not.toHaveBeenCalled();
 expect((await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:'{"enabled":true}'})).status).toBe(200);expect(service.setEnabled).toHaveBeenCalledWith(true);
 expect((await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:'{"enabled":true,"path":"/etc"}'})).status).toBe(400);
 expect((await fetch(url+'/run?command=rm',{method:'POST'})).status).toBe(400);expect(service.requestSample).not.toHaveBeenCalled();
 expect((await fetch(url+'/run',{method:'POST'})).status).toBe(202);expect(service.requestSample).toHaveBeenCalledOnce();
 service.setEnabled.mockRejectedValueOnce(Error('private-path-secret'));const failed=await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:'{"enabled":false}'});expect(failed.status).toBe(409);expect(await failed.text()).not.toContain('private-path-secret');
});
