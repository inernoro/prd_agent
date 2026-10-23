import { allocateStorageBirths, type StorageProvisionTarget } from './storage-birth-primitive.js';
export { allocateStorageBirths } from './storage-birth-primitive.js';
export type { StorageProvisionTarget } from './storage-birth-primitive.js';
import { createHash } from 'node:crypto';
import type { CdsConfig, InfraService, IShellExecutor, StorageBinding } from '../types.js';
import { infraStoragePlan, renderStoragePlan, stableStorageVolumeName, type DeploymentStoragePlan } from './deployment-storage-plan.js';
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
/** Explicit fresh-resource P. Runtime materialization never calls this allocator. */
export class StorageProvisionService {
    constructor(private readonly store: StorageProvisionStore, private readonly shell: IShellExecutor, private readonly config: Pick<CdsConfig, 'repoRoot' | 'storageInstanceId'>) { }
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
            await allocateStorageBirths({ store: this.store, shell: this.shell, plan, newNames: targets.map(m => m.source), target, serviceDigest: originalDigest, operationId, deadline, assertCurrent: fence, publish: names => this.store.publishProvisionedInfraDurably(service, names, operationId, () => { assertCurrent(); if (Date.now() >= deadline)
                    throw reject(); }) });
        }
        catch {
            throw reject();
        }
        finally {
            active.delete(key);
        }
    }
}
