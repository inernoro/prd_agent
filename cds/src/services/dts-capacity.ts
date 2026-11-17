import type { StateService } from './state.js';
import type { IShellExecutor } from '../types.js';
import type { DtsConnection } from '../shared/dts.js';
import { dtsConnectionEnvironment } from './dts-connections.js';
import { parseDfAvailableBytes } from './infra-backup-schedule.js';
import { dtsReject } from './dts-policy.js';
/** Capacity must come from the actual managed target volume, never a user-entered number. */
export async function dtsManagedFreeBytes(state:StateService,shell:IShellExecutor,c:DtsConnection):Promise<number>{
  dtsConnectionEnvironment(state,c);
  const service=c.infraId && state.getInfraServicesForProject(c.projectId).find(s=>s.id===c.infraId && s.projectId===c.projectId);
  if(!service || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service.containerName))dtsReject('capacity_unavailable','当前目标缺少可核实的数据卷，请先关联项目已管理的数据服务',409);
  const dir=c.kind==='mysql'?'/var/lib/mysql':c.kind==='postgres'?'/var/lib/postgresql/data':c.kind==='redis'?'/data':'/var/lib/rabbitmq';
  const r=await shell.exec(`docker exec '${service.containerName}' df -Pk '${dir}'`,{timeout:10000,executionLane:'observation'});
  const free=r.exitCode===0?parseDfAvailableBytes(r.stdout):null;
  if(free==null)dtsReject('capacity_unavailable','无法读取目标数据卷可用空间，已阻止写入，请核对服务状态',409);
  return free;
}
