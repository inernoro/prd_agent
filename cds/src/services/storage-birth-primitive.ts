import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { IShellExecutor } from '../types.js';
import { renderStoragePlan, storageOwnerLabels, stableStorageVolumeName, type DeploymentStoragePlan } from './deployment-storage-plan.js';
import type { StorageBirth } from './storage-provision.js';
export type StorageProvisionTarget = {
    kind: 'infra';
    projectId: string;
    serviceId: string;
} | {
    kind: 'profile';
    projectId: string;
    branchId: string;
    serviceId: string;
};
export interface BirthJournal {
    getStorageBirth(name: string): StorageBirth | undefined;
    writeStorageBirthDurably(row: StorageBirth, seq: number | undefined, fence: () => void): Promise<void>;
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const reject = () => new Error('storage_provision_unconfirmed');
/** One native birth kernel for both wrappers. No scope authorization, lock or freshness is inferred here. */
export async function allocateStorageBirths(o: {
    store: BirthJournal;
    shell: IShellExecutor;
    plan: DeploymentStoragePlan;
    newNames: readonly string[];
    target: StorageProvisionTarget;
    serviceDigest: string;
    operationId: string;
    deadline: number;
    assertCurrent: () => void;
    publish: (names: string[]) => Promise<void>;
}): Promise<void> {
    const { store, shell, serviceDigest, operationId, deadline, assertCurrent, publish } = o;
    const plan = structuredClone(o.plan), names = [...o.newNames], target = structuredClone(o.target), births: StorageBirth[] = [];
    const fence = () => { assertCurrent(); if (Date.now() >= deadline)
        throw reject(); };
    const exec = async (c: string, write = false) => { fence(); const r = await shell.exec(c, { timeout: Math.min(30000, deadline - Date.now()), executionLane: write ? 'operation' : 'observation', beforeStart: fence }); fence(); return r; };
    const daemon = async () => { const r = await exec("docker info --format '{{.ID}}'"); if (r.exitCode !== 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(r.stdout.trim()))
        throw reject(); return r.stdout.trim(); };
    try {
        renderStoragePlan(plan);
        fence();
        const mounts = plan.mounts.filter(m => names.includes(m.source));
        if (!Number.isFinite(deadline) || !Number.isFinite(deadline - Date.now()) || !/^[a-f0-9]{64}$/.test(serviceDigest) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId) || !names.length || names.length > 8 || new Set(names).size !== names.length || mounts.length !== names.length || mounts.some(m => m.kind !== 'volume' || !m.storage || m.source !== stableStorageVolumeName(m.storage) || m.storage.projectId !== target.projectId || m.storage.serviceId !== target.serviceId || (target.kind === 'infra' ? m.storage.scope !== 'project-shared' || m.storage.branchId !== undefined : m.storage.scope !== 'branch-private' || m.storage.branchId !== target.branchId)))
            throw reject();
        const daemonId = await daemon();
        for (const mount of mounts) {
            const now = new Date().toISOString();
            let row: StorageBirth = { version: 1, target, name: mount.source, binding: structuredClone(mount.storage!), operationId: operationId, birthNonce: randomBytes(24).toString('hex'), daemonId, planDigest: plan.digest, serviceDigest: serviceDigest, seq: 1, stage: 'intent', createIssued: false, createdAt: now, updatedAt: now };
            births.push(row);
            await store.writeStorageBirthDurably(row, undefined, fence);
            fence();
            const absent = await exec('docker volume inspect ' + quote(row.name));
            const errors = ['Error response from daemon: get ' + row.name + ': no such volume', 'Error response from daemon: No such volume: ' + row.name, 'Error: No such volume: ' + row.name];
            if (absent.exitCode !== 1 || !['', '[]'].includes(absent.stdout.trim()) || !errors.includes(absent.stderr.trim()))
                throw reject();
            row = { ...row, seq: row.seq + 1, stage: 'issued', createIssued: true, updatedAt: new Date().toISOString() };
            births[births.length - 1] = row;
            await store.writeStorageBirthDurably(row, row.seq - 1, fence);
            if (await daemon() !== daemonId)
                throw reject();
            const labels = { ...storageOwnerLabels(row.binding), 'cds.storage.birth': row.birthNonce };
            const made = await exec('docker volume create --driver local ' + Object.entries(labels).map(([k, v]) => '--label ' + quote(k + '=' + v)).join(' ') + ' ' + quote(row.name), true);
            if (made.exitCode !== 0 || made.stdout.trim() !== row.name)
                throw reject();
            const seen = await exec('docker volume inspect ' + quote(row.name));
            if (seen.exitCode !== 0)
                throw reject();
            let values: any;
            try {
                values = JSON.parse(seen.stdout);
            }
            catch {
                throw reject();
            }
            if (!Array.isArray(values) || values.length !== 1)
                throw reject();
            const v = values[0];
            if (v.Name !== row.name || v.Driver !== 'local' || (v.Options !== null && (!v.Options || typeof v.Options !== 'object' || Array.isArray(v.Options) || Object.keys(v.Options).length)) || typeof v.Mountpoint !== 'string' || !path.posix.isAbsolute(v.Mountpoint) || path.posix.normalize(v.Mountpoint) !== v.Mountpoint || v.Mountpoint.split('/').includes('.deployment-sources') || !v.Mountpoint.endsWith('/' + row.name + '/_data') || !Number.isFinite(Date.parse(v.CreatedAt)) || Object.entries(labels).some(([k, value]) => !Object.hasOwn(v.Labels || {}, k) || v.Labels[k] !== value))
                throw reject();
            if (await daemon() !== daemonId)
                throw reject();
            row = { ...row, seq: row.seq + 1, stage: 'confirmed', updatedAt: new Date().toISOString(), observation: { name: v.Name, mountpoint: v.Mountpoint, createdAt: v.CreatedAt, labels: structuredClone(v.Labels) } };
            births[births.length - 1] = row;
            await store.writeStorageBirthDurably(row, row.seq - 1, fence);
            fence();
        }
        if (await daemon() !== daemonId)
            throw reject();
        await publish(names);
    }
    catch (error) {
        for (const row of births) {
            const current = store.getStorageBirth(row.name);
            if (current?.birthNonce !== row.birthNonce || current.operationId !== operationId || current.stage === 'published')
                continue;
            try {
                await store.writeStorageBirthDurably({ ...current, seq: current.seq + 1, stage: 'held', updatedAt: new Date().toISOString() }, current.seq, assertCurrent);
            }
            catch { }
        }
        throw error;
    }
}
