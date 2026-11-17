import { describe,it,expect,vi } from 'vitest';
import { dtsManagedFreeBytes } from '../../src/services/dts-capacity.js';
import type { StateService } from '../../src/services/state.js';
import type { IShellExecutor } from '../../src/types.js';
import type { DtsConnection } from '../../src/shared/dts.js';
const c={projectId:'p',kind:'mysql',infraId:'mysql',uriEnv:'CDS_MYSQL_URL'} as DtsConnection;
const state={getCustomEnv:()=>({}),getCdsEnvVars:()=>({CDS_MYSQL_URL:'mysql://private'}),getInfraServicesForProject:()=>[{id:'mysql',projectId:'p',name:'SQL',dockerImage:'mysql:8',containerName:'p-mysql',status:'running'}]} as unknown as StateService;
describe('DTS actual target volume admission',()=>{
 it('reads the bound target volume using the observation lane',async()=>{
  const exec=vi.fn(async()=>({exitCode:0,stdout:'Filesystem 1024-blocks Used Available Capacity Mounted-on\n/dev/vda 9000 1000 8000 11% /var/lib/mysql\n',stderr:''}));
  expect(await dtsManagedFreeBytes(state,{exec} as IShellExecutor,c)).toBe(8000*1024);
  expect(exec.mock.calls[0]).toEqual(["docker exec 'p-mysql' df -Pk '/var/lib/mysql'",{timeout:10000,executionLane:'observation'}]);
 });
 it('does not infer storage from a manually supplied external endpoint',async()=>{
  const exec=vi.fn();await expect(dtsManagedFreeBytes(state,{exec} as IShellExecutor,{...c,infraId:undefined})).rejects.toThrow('缺少可核实');expect(exec).not.toHaveBeenCalled();
 });
 it('refuses unknown volume capacity even if the service is running',async()=>{
  const exec=vi.fn(async()=>({exitCode:1,stdout:'',stderr:'permission denied'}));await expect(dtsManagedFreeBytes(state,{exec} as IShellExecutor,c)).rejects.toThrow('无法读取');
 });
 it('cannot use another project service as capacity evidence',async()=>{
  const exec=vi.fn();await expect(dtsManagedFreeBytes(state,{exec} as IShellExecutor,{...c,projectId:'foreign'})).rejects.toThrow('发生变化');expect(exec).not.toHaveBeenCalled();
 });
});
