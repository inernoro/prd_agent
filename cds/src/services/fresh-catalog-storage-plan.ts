import type {CdsConfig, InfraService, IShellExecutor} from '../types.js';
import {UnsafeDeploymentStorageError,infraStoragePlan, stableStorageVolumeName, type DeploymentStoragePlan} from './deployment-storage-plan.js';
import {recommendedVolumePathsFromCatalog} from './infra-catalog.js';
import {isExactMissingStorageVolume} from './storage-birth-primitive.js';
const reject = () => new Error('storage_fresh_catalog_unconfirmed');
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export type FreshInfraPlan = {service: InfraService; plan: DeploymentStoragePlan; provision: boolean; legacyNames: string[]};
/** Pure: only callers that already proved logical service/birth freshness may use this.
 * An explicit new-only confirmation creates NEW empty owned storage. It never
 * adopts, remounts, renames, deletes or copies the supplied legacy physical volume.
 */
export function planFreshCatalogInfra(input: InfraService, config: Pick<CdsConfig,'storageInstanceId'|'repoRoot'>, newOnly: boolean): FreshInfraPlan {
  const service=structuredClone(input), volumes=service.volumes === undefined ? [] : service.volumes, legacyNames:string[]=[];
  if(!Array.isArray(volumes))throw reject();
  const annotated=volumes.filter(v=>v.storage!==undefined);
  if(annotated.length){
    if(!newOnly || annotated.length!==volumes.length)throw reject();
    service.scope='project';
    return {service,plan:infraStoragePlan(service,config),provision:true,legacyNames};
  }
  const paths=recommendedVolumePathsFromCatalog(service.dockerImage);
  if(!paths?.length){
    // Stateless image is still subject to actual image-volume preflight before metadata.
    if(volumes.length)throw reject();
    return {service,plan:infraStoragePlan(service,config),provision:false,legacyNames};
  }
  if(!newOnly || !config.storageInstanceId)throw reject();
  const seen=new Set<string>();
  for(const v of volumes){
    if(v.type!==undefined&&v.type!=='volume'||v.readOnly===true||!v.name||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v.name)
      || !paths.includes(v.containerPath)||seen.has(v.containerPath))throw reject();
    seen.add(v.containerPath);legacyNames.push(v.name);
  }
  service.scope='project';
  service.volumes=paths.map((containerPath,index)=>{
    const storage={version:1 as const,instanceId:config.storageInstanceId!,projectId:service.projectId,scope:'project-shared' as const,
      serviceId:service.id,mountKey:index?`data-${index+1}`:'data',purpose:'persistent' as const};
    return {type:'volume' as const,name:stableStorageVolumeName(storage),containerPath,storage};
  });
  return {service,plan:infraStoragePlan(service,config),provision:true,legacyNames:[...new Set(legacyNames)]};
}
/** The WHOLE group is planned before this read-only phase; run it before first P,
 * draft/config save, or runtime stop/start. No state or filesystem writes here.
 */
export async function assertFreshLegacyVolumesAbsent(plans: readonly FreshInfraPlan[], shell: IShellExecutor,
  assertCurrent:()=>void, deadline=Date.now()+90_000): Promise<void> {
  const names=[...new Set(plans.flatMap(p=>p.legacyNames))];if(!names.length)return;
  const fence=()=>{assertCurrent();if(!Number.isFinite(deadline)||Date.now()>=deadline)throw reject();};
  const exec=async(command:string)=>{fence();const result=await shell.exec(command,{timeout:Math.min(30_000,deadline-Date.now()),executionLane:'observation',beforeStart:fence});fence();return result;};
  const daemon=async()=>{const r=await exec("docker info --format '{{.ID}}'");if(r.exitCode!==0||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(r.stdout.trim()))throw reject();return r.stdout.trim();};
  const acceptedDaemon=await daemon();
  for(const name of names){if(!isExactMissingStorageVolume(await exec('docker volume inspect '+quote(name)),name))throw reject();}
  if(await daemon()!==acceptedDaemon)throw reject();
}

/** Configuration-only imports cannot create or adopt durable storage. Reject
 * the complete new-service group before publishing profiles, env or snapshots;
 * explicit new-only import-and-init remains the allocation path. Existing
 * service definitions and their historical runtime are left untouched. */
export function assertConfigOnlyInfraStorage(defs: readonly Pick<InfraService,'id'|'dockerImage'|'volumes'>[], existingIds: ReadonlySet<string>): void {
  for(const def of defs) if(!existingIds.has(def.id) && ((def.volumes?.length || 0)>0 || recommendedVolumePathsFromCatalog(def.dockerImage)?.length))
    throw new UnsafeDeploymentStorageError(def.id,'storage-provision-new-only-required');
}
