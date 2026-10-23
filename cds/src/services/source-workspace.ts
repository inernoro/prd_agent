import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderStoragePlan, UnsafeDeploymentStorageError, type DeploymentStoragePlan} from './deployment-storage-plan.js';

/** Server-owned staging path. User config/cache host binds remain forbidden. */
export const SOURCE_STAGING_TARGET = '/.__cds_source_ro';
const q=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/')||a==='/'||b==='/';
const deny=(reason:string):never=>{throw new UnsafeDeploymentStorageError('plan',reason);};

/** A source checkout stays RO; only the new container's private layer is writable.
 * Reject overlapping data/cache/tool/tmpfs mounts before any old service is stopped. */
export function withWritableSourceLayer(plan:DeploymentStoragePlan):DeploymentStoragePlan {
  renderStoragePlan(plan);
  const sources=plan.mounts.filter(m=>m.purpose==='source');
  if(!sources.length)return plan;
  if(sources.length!==1)deny('storage-source-workspace-invalid');
  const source=sources[0],workspace=source.workspaceTarget||source.target;
  if(source.kind!=='bind'||!source.readOnly||!path.posix.isAbsolute(workspace)||path.posix.normalize(workspace)!==workspace
    ||/[\x00\r\n,:]/.test(workspace)||overlap(workspace,SOURCE_STAGING_TARGET))deny('storage-source-workspace-invalid');
  for(const mount of plan.mounts){
    if(mount===source)continue;
    if(overlap(mount.target,workspace)||overlap(mount.target,SOURCE_STAGING_TARGET))deny('storage-source-workspace-overlap');
  }
  if(source.workspaceTarget){
    if(source.target!==SOURCE_STAGING_TARGET)deny('storage-source-workspace-invalid');
    return plan;
  }
  const mounts=Object.freeze(plan.mounts.map(m=>m===source?Object.freeze({...m,target:SOURCE_STAGING_TARGET,workspaceTarget:workspace}):m));
  return Object.freeze({version:1,mounts,digest:createHash('sha256').update(JSON.stringify(mounts)).digest('hex')});
}

/** POSIX/BusyBox primitives only. Do not follow an image's workspace symlink into data.
 * Emptying the private layer restores the old source mount's masking of image contents.
 * Every other mount was proven disjoint; this command never removes the RO checkout. */
export function sourceWorkspaceCommand(plan:DeploymentStoragePlan,command:string):string {
  const accepted=withWritableSourceLayer(plan),source=accepted.mounts.find(m=>m.purpose==='source');
  if(!source)return command;
  const target=source.workspaceTarget!;
  const prefixes:string[]=[];let current='';
  for(const part of target.split('/').filter(Boolean)){current+='/'+part;prefixes.push(current);}
  const check=prefixes.map(p=>`if test -L ${q(p)}; then printf '%s\\n' 'storage-source-workspace-symlink' >&2; exit 126; fi`).join('; ');
  return `set -eu; ${check}; mkdir -p -- ${q(target)}; for cds_workspace_item in ${q(target)}/* ${q(target)}/.[!.]* ${q(target)}/..?*; do if test -e "$cds_workspace_item" || test -L "$cds_workspace_item"; then rm -rf -- "$cds_workspace_item"; fi; done; cp -RP -- ${q(source.target+'/.')} ${q(target+'/')}; cd ${q(target)}; exec sh -c ${q(command)}`;
}
