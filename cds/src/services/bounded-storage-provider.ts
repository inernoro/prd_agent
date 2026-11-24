import type { IShellExecutor, StorageBinding } from '../types.js';
import { BOUNDED_STORAGE_PROGRAM } from './bounded-storage-program.js';

export type BoundedStorageProof = Readonly<{version:1;device:string;receiptSha256:string;bytes:134217728;inodes:number;uuid:string}>;
export type BoundedStorageRequest = {name:string;birthNonce:string;daemonId:string;binding:StorageBinding;target:string};
export const boundedStorageOptions = (proof: BoundedStorageProof) => ({type:'ext4',device:proof.device,o:'nodev,nosuid,noexec'});

export function validateBoundedStorageProof(proof: unknown): asserts proof is BoundedStorageProof {
  const p = proof as BoundedStorageProof;
  if (!p || Object.keys(p).sort().join(',') !== 'bytes,device,inodes,receiptSha256,uuid,version'
    || p.version !== 1 || !/^\/dev\/loop[0-9]{1,6}$/.test(p.device) || !/^[a-f0-9]{64}$/.test(p.receiptSha256)
    || p.bytes !== 134217728 || !Number.isSafeInteger(p.inodes) || p.inodes < 1 || p.inodes > 8192 || !/^[a-f0-9-]{36}$/.test(p.uuid)) {
    throw new Error('bounded_storage_unconfirmed');
  }
}

/** Uses only an already authorized executor's identity; no escalation or fallback.
 * inspect never formats, attaches, creates a pool, or substitutes another device. */
export async function boundedStorageProvider(shell: IShellExecutor, operation:'create'|'inspect', request:BoundedStorageRequest): Promise<BoundedStorageProof> {
  const program = `import base64;exec(base64.b64decode("${Buffer.from(BOUNDED_STORAGE_PROGRAM).toString('base64')}"))`;
  const result = await shell.exec(`python3 -c '${program}' '${operation}' '${Buffer.from(JSON.stringify(request)).toString('base64')}'`, {
    executionLane: operation === 'create' ? 'operation' : 'observation', timeout:30000,
  });
  // Base64 is decoded below by Python itself; never evaluate command text from a request.
  if (result.exitCode !== 0 || result.stdout.length > 8192) throw new Error('bounded_storage_unconfirmed');
  let proof:unknown;
  try { proof = JSON.parse(result.stdout); } catch { throw new Error('bounded_storage_unconfirmed'); }
  validateBoundedStorageProof(proof);
  return proof;
}
