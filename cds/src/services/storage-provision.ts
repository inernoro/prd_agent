import { allocateStorageBirths, type StorageProvisionTarget } from './storage-birth-primitive.js';
export { allocateStorageBirths } from './storage-birth-primitive.js';
export type { StorageProvisionTarget } from './storage-birth-primitive.js';
import { createHash } from 'node:crypto';
import type { CdsConfig, InfraService, IShellExecutor, StorageBinding } from '../types.js';
import { infraStoragePlan, renderStoragePlan, stableStorageVolumeName, resolveStorageImage, inspectStoragePlan, type DeploymentStoragePlan } from './deployment-storage-plan.js';
import type { BoundedStorageProof } from './bounded-storage-provider.js';
export interface StorageBirth {
    version: 1;
    target?: StorageProvisionTarget;
    name: string;
    binding: StorageBinding;
    operationId: string;
    birthNonce: string;
    daemonId: string;
    planDigest: string;
    serviceDigest: string;
    seq: number;
    stage: 'intent' | 'issued' | 'confirmed' | 'published' | 'held';
    createIssued: boolean;
    createdAt: string;
    updatedAt: string;
    observation?: {
        name: string;
        mountpoint: string;
        createdAt: string;
        labels: Record<string, string>;
        bounded?: BoundedStorageProof;
    };
}
export interface StorageProvisionStore {
    getInfraServiceForProjectAndId(projectId: string, id: string): InfraService | undefined;
    getStorageBirth(name: string): StorageBirth | undefined;
    getStorageBirthsForService(projectId: string, serviceId: string): StorageBirth[];
    writeStorageBirthDurably(row: StorageBirth, expectedSeq: number | undefined, assertCurrent: () => void): Promise<void>;
    /** Must publish privately until the confirmed birth and configuration ACK together. */
    publishProvisionedInfraDurably(service: InfraService, names: string[], operationId: string, assertCurrent: () => void): Promise<void>;
}
const locks = new WeakMap<StorageProvisionStore, Set<string>>();
const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, stable(v[k])])) : v;
export const storageProvisionDigest = (v: unknown) => createHash('sha256').update(JSON.stringify(stable(v)) ?? 'undefined').digest('hex');
const digest = storageProvisionDigest;
const safe = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(s);
const reject = () => new Error('storage_provision_unconfirmed');
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
/** Explicit fresh-resource P. Runtime materialization never calls this allocator. */
export class StorageProvisionService {
    constructor(private readonly store: StorageProvisionStore, private readonly shell: IShellExecutor, private readonly config: Pick<CdsConfig, 'repoRoot' | 'storageInstanceId'>) { }
    /** Fixed catalog policy during explicit fresh P, never an existing-volume repair. */
    private async initializeFreshCatalogStorage(service: InfraService, plan: DeploymentStoragePlan, names: string[], operationId: string, deadline: number, assertCurrent: () => void, preparedImage: string): Promise<void> {
        // Finite built-in catalog policy; caller configuration cannot authorize
        // filesystem ownership changes on an existing resource.
        const policy = ({
            'docker.elastic.co/elasticsearch/elasticsearch:8.11.0': {user:'1000:0',alias:'',identity:'1000:0',group:'0',paths:['/usr/share/elasticsearch/data']},
            'mcr.microsoft.com/mssql/server:2022-latest': {user:'mssql',alias:'mssql',identity:'10001:10001',group:'10001',paths:['/var/opt/mssql']},
            'apache/kafka:3.7.0': {user:'appuser',alias:'appuser',identity:'1000:1000',group:'1000',paths:['/etc/kafka/secrets','/var/lib/kafka/data','/mnt/shared/config']},
        } as Record<string,{user:string;alias:string;identity:string;group:string;paths:string[]}>)[service.dockerImage];
        if (!policy) return;
        if (names.length !== policy.paths.length || plan.mounts.length !== names.length || policy.paths.some(target=>!plan.mounts.some(m=>m.target===target))) throw reject();
        const originals = names.map(name=>this.store.getStorageBirth(name));
        if (originals.some(row=>!row || row.stage!=='confirmed' || row.operationId!==operationId || !row.observation)) throw reject();
        const frozen = originals.map(row=>structuredClone(row!));
        const fence = () => { assertCurrent(); if (Date.now() >= deadline || frozen.some(row=>digest(this.store.getStorageBirth(row.name))!==digest(row))) throw reject(); };
        const exec = async (command: string, write = false) => {
            fence(); const result = await this.shell.exec(command, { timeout: Math.min(30000, deadline - Date.now()), executionLane: write ? 'operation' : 'observation', beforeStart: fence }); fence(); return result;
        };
        const proof = Object.fromEntries(frozen.map(row=>[row.name,{birthNonce:row.birthNonce,daemonId:row.daemonId,mountpoint:row.observation!.mountpoint,createdAt:row.observation!.createdAt}]));
        const checkedShell = { exec: (command, options) => exec(command, options?.executionLane !== 'observation') } as IShellExecutor;
        await inspectStoragePlan(checkedShell, plan, false, proof);
        const image = await resolveStorageImage(checkedShell, preparedImage, plan);
        const user = await exec(`docker image inspect ${quote(image)} --format '{{json .Config.User}}'`);
        if (user.exitCode !== 0 || user.stdout.trim() !== JSON.stringify(policy.user)) throw reject();
        const original=frozen[0];
        const name = 'cds-storage-init-' + original.birthNonce;
        // Only this confirmed empty root may receive the catalog's group.
        // No recursive metadata change, image copy-up or business entrypoint.
        const identityCheck=policy.alias ? `test \"$(id -u ${quote(policy.alias)}):$(id -g ${quote(policy.alias)})\" = ${quote(policy.identity)}; ` : '';
        const checks=policy.paths.map(target=>`test -d ${quote(target)}; test ! -L ${quote(target)}; entries=$(find ${quote(target)} -mindepth 1 -maxdepth 1 -print -quit); test -z "$entries"; initial=$(stat -c '%u:%g:%a' ${quote(target)}); test "$initial" = '0:0:755'; `).join('');
        const changes=policy.paths.map(target=>`${policy.group==='0'?'':`chgrp ${policy.group} ${quote(target)}; `}chmod 0770 ${quote(target)}; stat -c '%u:%g:%a' ${quote(target)}`).join('; ');
        const program = `set -eu; ${identityCheck}${checks}${changes}`;
        const labels = { 'cds.storage.init.birth': original.birthNonce, 'cds.storage.init.operation': operationId };
        const made = await exec(['docker create', `--name ${quote(name)}`, ...Object.entries(labels).map(([k, v]) => '--label ' + quote(k + '=' + v)),
            '--network none --read-only --user 0:0 --cap-drop ALL', policy.group==='0'?'':'--cap-add CHOWN', '--security-opt no-new-privileges',
            '--memory 64m --memory-swap 64m --pids-limit 16 --restart no --log-driver json-file --log-opt max-size=1m --log-opt max-file=1',
            '--entrypoint /bin/sh', ...plan.mounts.map(m=>'--mount '+quote(`type=volume,source=${m.source},dst=${m.target},volume-nocopy`)), quote(image), '-ceu', quote(program)].join(' '), true);
        const cid = made.stdout.trim(); if (made.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(cid)) throw reject();
        // Cleanup may outlive the request fence, but can only stop/remove this
        // invocation's exact native helper identity. It never removes a volume.
        const cleanup = async () => {
            const command = (text: string) => this.shell.exec(text, { timeout: 10000, executionLane: 'operation' });
            const absent = (r: {exitCode:number;stdout:string;stderr:string}) => r.exitCode===1 && ['', '[]'].includes(r.stdout.trim())
                && ['Error: No such object: '+cid,'error: no such object: '+cid,'Error response from daemon: No such container: '+cid].includes(r.stderr.trim());
            const owned = async () => {
                const r=await command('docker inspect '+quote(cid));if(absent(r))return null;
                let rows:any;try{if(r.exitCode!==0 || r.stdout.length>262144)throw reject();rows=JSON.parse(r.stdout);}catch{throw reject();}
                const c=Array.isArray(rows)&&rows.length===1?rows[0]:null;
                if(!c || c.Id!==cid || c.Name!=='/'+name || c.Image!==image || Object.entries(labels).some(([k,v])=>c.Config?.Labels?.[k]!==v)
                    || typeof c.State?.Running!=='boolean' || !Number.isSafeInteger(c.State.Pid) || c.State.Pid<0)throw reject();
                return c;
            };
            let c=await owned();if(!c)return;
            if(c.State.Running){await command('docker stop --time 2 '+cid);c=await owned();if(!c)return;}
            if(c.State.Running || c.State.Pid!==0 || !['created','exited'].includes(c.State.Status))throw reject();
            if((await command('docker rm '+cid)).exitCode!==0 || !absent(await command('docker inspect '+quote(cid))))throw reject();
        };
        try {
        const inspect = async (status: 'created' | 'exited') => {
            const result = await exec('docker inspect ' + quote(cid)); let values: any;
            try { if (result.exitCode !== 0 || result.stdout.length > 262144) throw reject(); values = JSON.parse(result.stdout); } catch { throw reject(); }
            if (!Array.isArray(values) || values.length !== 1) throw reject(); const c = values[0], h = c.HostConfig, st = c.State, m = c.Mounts;
            if (c.Id !== cid || c.Name !== '/' + name || c.Image !== image || c.Config?.User !== '0:0'
                || JSON.stringify(c.Config?.Entrypoint) !== JSON.stringify(['/bin/sh']) || JSON.stringify(c.Config?.Cmd) !== JSON.stringify(['-ceu', program])
                || Object.entries(labels).some(([k, v]) => c.Config?.Labels?.[k] !== v)
                || !st || st.Status !== status || st.Running !== false || st.Pid !== 0 || (status === 'exited' && st.ExitCode !== 0)
                || !h || h.Privileged !== false || h.NetworkMode !== 'none' || h.ReadonlyRootfs !== true || h.Memory !== 67108864 || h.MemorySwap !== 67108864 || h.PidsLimit !== 16 || h.RestartPolicy?.Name !== 'no'
                || JSON.stringify(h.CapDrop) !== JSON.stringify(['ALL']) || (policy.group==='0' ? JSON.stringify(h.CapAdd || []) !== '[]' : !['["CHOWN"]','["CAP_CHOWN"]'].includes(JSON.stringify(h.CapAdd))) || JSON.stringify(h.SecurityOpt) !== JSON.stringify(['no-new-privileges'])
                || h.LogConfig?.Type !== 'json-file' || h.LogConfig.Config?.['max-size'] !== '1m' || h.LogConfig.Config?.['max-file'] !== '1'
                || !Array.isArray(m) || m.length !== frozen.length || frozen.some(row=>!m.some((mount:any)=>mount.Type==='volume'&&mount.Name===row.name&&mount.Source===row.observation!.mountpoint&&mount.Destination===plan.mounts.find(x=>x.source===row.name)!.target&&mount.RW===true))) throw reject();
        };
        await inspect('created'); await inspectStoragePlan(checkedShell, plan, false, proof);
        const started = await exec('docker start -a ' + cid, true);
        if (started.exitCode !== 0 || started.stdout.trim() !== policy.paths.map(()=>'0:'+policy.group+':770').join('\n')) throw reject();
        await inspect('exited'); await inspectStoragePlan(checkedShell, plan, false, proof);
        } finally { await cleanup(); }
        await inspectStoragePlan(checkedShell, plan, false, proof); fence();
    }
    async provisionNewInfra(input: InfraService, inputPlan: DeploymentStoragePlan, operationId: string, assertCurrent: () => void): Promise<void> {
        const service = structuredClone(input), plan = structuredClone(inputPlan), target: StorageProvisionTarget = { kind: 'infra', projectId: service.projectId, serviceId: service.id };
        const key = JSON.stringify([target.kind, target.projectId, '', target.serviceId]);
        const active = locks.get(this.store) || new Set<string>();
        locks.set(this.store, active);
        if (active.has(key))
            throw reject();
        active.add(key);
        const originalDigest = digest(service), deadline = Date.now() + 90000, instance = this.config.storageInstanceId, repoRoot = this.config.repoRoot;
        const fence = () => { assertCurrent(); if (Date.now() >= deadline || this.config.storageInstanceId !== instance || this.config.repoRoot !== repoRoot || this.store.getInfraServiceForProjectAndId(service.projectId, service.id) || digest(service) !== originalDigest)
            throw reject(); };
        try {
            renderStoragePlan(plan);
            fence();
            if (!safe(service.projectId) || !safe(service.id) || !safe(operationId) || service.status !== 'stopped' || service.scope !== 'project')
                throw reject();
            const targets = plan.mounts.filter(m => m.kind === 'volume');
            if (!targets.length || targets.length > 8 || targets.some(m => !m.storage || m.storage.projectId !== service.projectId || m.storage.serviceId !== service.id || m.storage.scope !== 'project-shared' || m.storage.branchId || m.source !== stableStorageVolumeName(m.storage)))
                throw reject();
            if (this.store.getStorageBirthsForService(service.projectId, service.id).length || targets.some(m => this.store.getStorageBirth(m.source)) || infraStoragePlan(service, this.config).digest !== plan.digest)
                throw reject();
            // Establish the complete immutable image/mount plan before any
            // birth intent. Download/unknown-image failures can then retry
            // without stranding an allocation or advertising unusable storage.
            const preparedShell = {exec: async (command, options) => {
                fence(); const result=await this.shell.exec(command,{...options,timeout:Math.min(30000,deadline-Date.now()),beforeStart:fence});fence();return result;
            }} as IShellExecutor;
            const preparedImage=await resolveStorageImage(preparedShell,service.dockerImage,plan,true);
            await allocateStorageBirths({ store: this.store, shell: this.shell, plan, newNames: targets.map(m => m.source), target, serviceDigest: originalDigest, operationId, deadline, assertCurrent: fence, publish: async names => {
                await this.initializeFreshCatalogStorage(service, plan, names, operationId, deadline, fence, preparedImage); fence();
                return this.store.publishProvisionedInfraDurably(service, names, operationId, () => { assertCurrent(); if (Date.now() >= deadline) throw reject(); });
            } });
        }
        catch {
            throw reject();
        }
        finally {
            active.delete(key);
        }
    }
}
