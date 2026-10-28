import path from 'node:path';
import { withWritableSourceLayer } from './source-workspace.js';
import type { BranchEntry, BuildProfile, CacheMount, CdsConfig, IShellExecutor, StorageBinding } from '../types.js';
import { profileStoragePlan, stableStorageVolumeName, renderStoragePlan, withRuntimeTmpfs, resolveStorageImage } from './deployment-storage-plan.js';
import { allocateStorageBirths, storageProvisionDigest, type StorageBirth } from './storage-provision.js';
export interface ProfileStorageTarget {
    kind: 'profile';
    projectId: string;
    branchId: string;
    serviceId: string;
}
export interface FreshProfileMount {
    mountKey: string;
    containerPath: string;
    purpose: 'cache' | 'persistent';
}
export interface ProfileStorageBinding {
    version: 1;
    target: ProfileStorageTarget;
    branchIdentity: string;
    declarationDigest: string;
    mounts: CacheMount[];
    names: string[];
    operationId: string;
}
export const profileStorageTargetKey = (t: ProfileStorageTarget) => JSON.stringify([t.kind, t.projectId, t.branchId, t.serviceId]);
export const profileStorageBranchIdentity = (b: Pick<BranchEntry, 'id' | 'projectId' | 'branch' | 'createdAt'>) => storageProvisionDigest([b.id, b.projectId || 'default', b.branch, b.createdAt]);
export const profileStorageDeclarationDigest = (p: BuildProfile) => storageProvisionDigest({ id: p.id, projectId: p.projectId, cacheMounts: p.cacheMounts || [] });
export interface ProfileProvisionStore {
    getProfileStorageDeclaration(t: ProfileStorageTarget): {
        branchIdentity: string;
        declarationDigest: string;
    } | undefined;
    getProfileStorageBinding(t: ProfileStorageTarget): ProfileStorageBinding | undefined;
    getProfileStorageBirths(t: ProfileStorageTarget): StorageBirth[];
    getStorageBirth(name: string): StorageBirth | undefined;
    assertFreshProfileStorageTarget(t: ProfileStorageTarget): void;
    writeStorageBirthDurably(row: StorageBirth, seq: number | undefined, fence: () => void): Promise<void>;
    publishProfileStorageDurably(row: ProfileStorageBinding, fence: () => void): Promise<void>;
}
const locks = new WeakMap<ProfileProvisionStore, Set<string>>();
const key = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(x);
const reject = () => new Error('storage_provision_unconfirmed');
/** Separate control-plane P; never call this from ordinary R/missing-volume handling. */
export class ProfileStorageProvisionService {
    constructor(private readonly store: ProfileProvisionStore, private readonly shell: IShellExecutor, private readonly config: Pick<CdsConfig, 'repoRoot' | 'storageInstanceId'>) { }
    async provisionNewProfile(entry: BranchEntry, profile: BuildProfile, requests: readonly FreshProfileMount[], operationId: string, assertCurrent: () => void): Promise<ProfileStorageBinding> {
        entry = structuredClone(entry);
        profile = structuredClone(profile);
        requests = structuredClone(requests);
        const target: ProfileStorageTarget = { kind: 'profile', projectId: entry.projectId || 'default', branchId: entry.id, serviceId: profile.id };
        const targetKey = profileStorageTargetKey(target), active = locks.get(this.store) || new Set<string>();
        locks.set(this.store, active);
        if (active.has(targetKey))
            throw reject();
        active.add(targetKey);
        const instance = this.config.storageInstanceId, repoRoot = this.config.repoRoot, deadline = Date.now() + 90000;
        const original = { branchIdentity: profileStorageBranchIdentity(entry), declarationDigest: profileStorageDeclarationDigest(profile) };
        const fence = () => { assertCurrent(); this.store.assertFreshProfileStorageTarget(target); const actual = this.store.getProfileStorageDeclaration(target); if (Date.now() >= deadline || this.config.storageInstanceId !== instance || this.config.repoRoot !== repoRoot || !actual || actual.branchIdentity !== original.branchIdentity || actual.declarationDigest !== original.declarationDigest || this.store.getProfileStorageBinding(target))
            throw reject(); };
        try {
            fence();
            if (!instance || !key(instance) || ![target.projectId, target.branchId, target.serviceId].every(key) || profile.projectId !== target.projectId || !operationId || operationId.length > 128 || !requests.length || requests.length > 8 || this.store.getProfileStorageBirths(target).length)
                throw reject();
            const raw = profile.cacheMounts || [], keys = new Set<string>(), targets = new Set(raw.map(m => m.containerPath));
            // Only explicit fresh destinations are added. An existing physical mount is never rewritten.
            const fresh = requests.map(m => { if (!key(m.mountKey) || keys.has(m.mountKey) || !['cache', 'persistent'].includes(m.purpose) || !path.posix.isAbsolute(m.containerPath) || path.posix.normalize(m.containerPath) !== m.containerPath || targets.has(m.containerPath))
                throw reject(); keys.add(m.mountKey); targets.add(m.containerPath); const storage: StorageBinding = { version: 1, instanceId: instance, projectId: target.projectId, scope: 'branch-private', branchId: target.branchId, serviceId: target.serviceId, mountKey: m.mountKey, purpose: m.purpose }; return { kind: 'volume' as const, hostPath: stableStorageVolumeName(storage), containerPath: m.containerPath, storage }; });
            const record: ProfileStorageBinding = { version: 1, target, ...original, mounts: [...raw, ...fresh], names: fresh.map(m => m.hostPath), operationId };
            // Reuse runtime's exact source-workspace rules BEFORE any intent, native read or allocation.
            const plan = withWritableSourceLayer(withRuntimeTmpfs(profileStoragePlan(entry, { ...profile, cacheMounts: record.mounts }, this.config)));
            renderStoragePlan(plan);
            if (fresh.some(m => this.store.getStorageBirth(m.hostPath)))
                throw reject();
            // Match runtime's complete actual image plan before recording any
            // birth: an omitted Docker VOLUME must leave the target retryable.
            const preparedShell = { exec: async (command, options) => {
                fence(); const result = await this.shell.exec(command, { ...options, timeout: Math.min(30000, deadline - Date.now()), beforeStart: fence }); fence(); return result;
            } } as IShellExecutor;
            await resolveStorageImage(preparedShell, profile.dockerImage, plan, true);
            await allocateStorageBirths({ store: this.store, shell: this.shell, plan, newNames: record.names, target, serviceDigest: storageProvisionDigest(record), operationId, deadline, assertCurrent: fence, publish: () => this.store.publishProfileStorageDurably(record, () => { assertCurrent(); if (Date.now() >= deadline)
                    throw reject(); }) });
            return structuredClone(record);
        }
        finally {
            active.delete(targetKey);
        }
    }
}
